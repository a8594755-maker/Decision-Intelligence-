"""
PR-E Deliverable 5: Retrain Trigger Engine
===========================================
Rule-based evaluation of whether a model should be retrained.

Rules (minimum viable set):
  1. Coverage outside acceptable band for N consecutive windows
  2. MAPE degraded by >= X% vs baseline/prod model
  3. Residual drift score above threshold
  4. Data drift score above threshold

Operational guards:
  - Cooldown window per series/group (default 24h)
  - Dedupe key: (series_id, trigger_type, window_end)
  - Feature flag: ENABLE_AUTO_RETRAIN (default: false)
  - Max frequency: at most 1 retrain per cooldown period per series
"""
import json
import logging
import os
import tempfile
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

ENABLE_AUTO_RETRAIN = os.getenv("ENABLE_AUTO_RETRAIN", "false").lower() == "true"

DEFAULT_TRIGGER_STORE = os.path.join(
    os.path.dirname(__file__), "..", "..", "..", "registry_store", "retrain_triggers"
)


@dataclass
class RetainTriggerConfig:
    """Configurable thresholds for retrain triggers."""

    # Rule 1: Coverage
    coverage_min: float = 0.65
    coverage_max: float = 0.95
    coverage_consecutive_windows: int = 2

    # Rule 2: MAPE degradation
    mape_degradation_pct: float = 15.0

    # Rule 3: Residual drift
    residual_drift_threshold: float = 0.6

    # Rule 4: Data drift
    data_drift_threshold: float = 0.6

    # Operational guards
    cooldown_hours: float = 24.0
    max_retrain_per_day: int = 3

    # Feature flag (can also be set via env)
    auto_retrain_enabled: bool = False

    def to_dict(self) -> Dict:
        return asdict(self)


@dataclass
class RetainTriggerResult:
    """Result of retrain trigger evaluation."""

    should_retrain: bool = False
    reasons: List[str] = field(default_factory=list)
    severity: str = "none"  # "none", "low", "medium", "high"
    cooldown_remaining_seconds: float = 0.0
    blocked_by_cooldown: bool = False
    blocked_by_dedupe: bool = False
    auto_retrain_enabled: bool = False
    trigger_types: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict:
        return asdict(self)


@dataclass
class RetainTriggerContext:
    """Input context for retrain trigger evaluation."""

    series_id: str = ""

    # From drift report
    data_drift_score: float = 0.0
    residual_drift_score: float = 0.0
    drift_flags: List[str] = field(default_factory=list)

    # Recent backtest metrics
    recent_mape: Optional[float] = None
    baseline_mape: Optional[float] = None
    recent_coverage: Optional[float] = None
    recent_bias: Optional[float] = None

    # Historical coverage windows (list of coverage values for consecutive windows)
    coverage_history: List[float] = field(default_factory=list)

    # Timing
    last_trained_at: Optional[str] = None
    last_promoted_at: Optional[str] = None

    # Data availability
    n_data_points: int = 0
    missingness_ratio: float = 0.0

    # Window identifier for dedupe
    window_end: str = ""


def evaluate_retrain_trigger(
    context: RetainTriggerContext,
    config: Optional[RetainTriggerConfig] = None,
    trigger_history: Optional[List[Dict]] = None,
) -> RetainTriggerResult:
    """
    Evaluate whether a model should be retrained.

    Args:
        context: Current state for the series/group.
        config: Trigger thresholds.
        trigger_history: Previous trigger events for cooldown/dedupe.

    Returns:
        RetainTriggerResult with decision, reasons, and severity.
    """
    if config is None:
        config = RetainTriggerConfig()

    result = RetainTriggerResult(
        auto_retrain_enabled=config.auto_retrain_enabled or ENABLE_AUTO_RETRAIN,
    )

    reasons = []
    trigger_types = []
    severity_scores = []

    # Rule 1: Coverage outside acceptable band for N consecutive windows
    if context.coverage_history:
        n_bad = 0
        for cov in reversed(context.coverage_history):
            if cov < config.coverage_min or cov > config.coverage_max:
                n_bad += 1
            else:
                break

        if n_bad >= config.coverage_consecutive_windows:
            reasons.append(
                f"Coverage outside [{config.coverage_min:.2f}, {config.coverage_max:.2f}] "
                f"for {n_bad} consecutive windows"
            )
            trigger_types.append("coverage_degradation")
            severity_scores.append(0.7 if n_bad >= 3 else 0.5)

    # Rule 2: MAPE degradation
    if context.recent_mape is not None and context.baseline_mape is not None:
        if context.baseline_mape > 0:
            degradation_pct = (
                (context.recent_mape - context.baseline_mape) / context.baseline_mape
            ) * 100
        else:
            degradation_pct = 0.0

        if degradation_pct > config.mape_degradation_pct:
            reasons.append(
                f"MAPE degraded by {degradation_pct:.1f}% "
                f"(threshold={config.mape_degradation_pct:.1f}%): "
                f"{context.baseline_mape:.2f} -> {context.recent_mape:.2f}"
            )
            trigger_types.append("mape_degradation")
            severity_scores.append(min(1.0, degradation_pct / 100))

    # Rule 3: Residual drift score above threshold
    if context.residual_drift_score > config.residual_drift_threshold:
        reasons.append(
            f"Residual drift score={context.residual_drift_score:.3f} "
            f"> threshold={config.residual_drift_threshold:.2f}"
        )
        trigger_types.append("residual_drift")
        severity_scores.append(context.residual_drift_score)

    # Rule 4: Data drift score above threshold
    if context.data_drift_score > config.data_drift_threshold:
        reasons.append(
            f"Data drift score={context.data_drift_score:.3f} "
            f"> threshold={config.data_drift_threshold:.2f}"
        )
        trigger_types.append("data_drift")
        severity_scores.append(context.data_drift_score)

    # Determine severity
    if severity_scores:
        max_severity = max(severity_scores)
        if max_severity >= 0.7:
            severity = "high"
        elif max_severity >= 0.4:
            severity = "medium"
        else:
            severity = "low"
    else:
        severity = "none"

    should_retrain = len(reasons) > 0

    # Cooldown check
    cooldown_remaining = 0.0
    blocked_by_cooldown = False

    if should_retrain and context.last_trained_at:
        try:
            last_trained = datetime.fromisoformat(
                context.last_trained_at.replace("Z", "+00:00")
            )
            if last_trained.tzinfo is None:
                last_trained = last_trained.replace(tzinfo=timezone.utc)
            else:
                last_trained = last_trained.astimezone(timezone.utc)
            cooldown_end = last_trained + timedelta(hours=config.cooldown_hours)
            now = datetime.now(timezone.utc)
            if now < cooldown_end:
                cooldown_remaining = (cooldown_end - now).total_seconds()
                blocked_by_cooldown = True
                should_retrain = False
        except (ValueError, TypeError):
            pass

    # Dedupe check
    blocked_by_dedupe = False
    if should_retrain and trigger_history and context.window_end:
        for prev in trigger_history:
            if (
                prev.get("series_id") == context.series_id
                and prev.get("window_end") == context.window_end
                and set(prev.get("trigger_types", [])) & set(trigger_types)
            ):
                blocked_by_dedupe = True
                should_retrain = False
                break

    result.should_retrain = should_retrain
    result.reasons = reasons
    result.severity = severity
    result.cooldown_remaining_seconds = cooldown_remaining
    result.blocked_by_cooldown = blocked_by_cooldown
    result.blocked_by_dedupe = blocked_by_dedupe
    result.trigger_types = trigger_types

    return result


class RetainTriggerStore:
    """Persist retrain trigger events to filesystem."""

    def __init__(self, root: str = None):
        self.root = os.path.abspath(root or DEFAULT_TRIGGER_STORE)
        os.makedirs(self.root, exist_ok=True)

    def record_trigger(
        self,
        series_id: str,
        result: RetainTriggerResult,
        window_end: str = "",
    ) -> str:
        """Record a trigger event. Returns event ID."""
        import uuid as _uuid
        event_id = f"trig_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}_{_uuid.uuid4().hex[:6]}_{series_id}"
        event = {
            "event_id": event_id,
            "series_id": series_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "window_end": window_end,
            **result.to_dict(),
        }

        path = os.path.join(self.root, f"{event_id}.json")
        dir_name = os.path.dirname(path)
        os.makedirs(dir_name, exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(dir=dir_name, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(event, f, indent=2, ensure_ascii=False)
            os.replace(tmp_path, path)
        except Exception:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
            raise

        logger.info("Recorded trigger event %s for series %s", event_id, series_id)
        return event_id

    def get_history(
        self,
        series_id: Optional[str] = None,
        limit: int = 50,
    ) -> List[Dict]:
        """Get trigger event history, most recent first."""
        if not os.path.isdir(self.root):
            return []

        events = []
        for fname in sorted(os.listdir(self.root), reverse=True):
            if not fname.endswith(".json"):
                continue
            path = os.path.join(self.root, fname)
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if series_id and data.get("series_id") != series_id:
                continue
            events.append(data)
            if len(events) >= limit:
                break

        return events
