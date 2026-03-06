"""
Phase 3 – Deliverable 3.5: Closed-Loop Trigger History Store
─────────────────────────────────────────────────────────────
Persists trigger events, parameter patches, and outcomes for
closed-loop remediation audit and analysis.

Storage: filesystem JSON (same pattern as model_registry.py).

Usage:
    from ml.monitoring.closed_loop_store import ClosedLoopTriggerStore

    store = ClosedLoopTriggerStore()
    event_id = store.record_trigger(series_id, trigger_decision, param_patch)
    store.record_outcome(event_id, outcome)
    history = store.get_history(series_id)
"""
import json
import logging
import os
import tempfile
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

DEFAULT_STORE_ROOT = os.path.join(
    os.path.dirname(__file__), "..", "..", "..", "artifacts", "closed_loop"
)


def _atomic_write_json(path: str, data: Any):
    """Write JSON atomically: write to temp file, then os.replace."""
    dir_name = os.path.dirname(path)
    os.makedirs(dir_name, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=dir_name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False, default=str)
        os.replace(tmp_path, path)
    except Exception:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise


def _read_json(path: str, default=None):
    if not os.path.exists(path):
        return default if default is not None else []
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


class ClosedLoopTriggerStore:
    """
    Filesystem-backed store for closed-loop trigger events.

    Each event records:
      - Which triggers fired and why
      - What parameter patch was derived
      - Whether execution happened (dry_run vs auto_run)
      - Outcome metrics (if available)
    """

    def __init__(self, root: str = None):
        self.root = os.path.abspath(root or DEFAULT_STORE_ROOT)
        os.makedirs(self.root, exist_ok=True)

    @property
    def _events_path(self) -> str:
        return os.path.join(self.root, "trigger_events.json")

    @property
    def _outcomes_path(self) -> str:
        return os.path.join(self.root, "trigger_outcomes.json")

    @property
    def _stats_path(self) -> str:
        return os.path.join(self.root, "trigger_stats.json")

    def record_trigger(
        self,
        series_id: str,
        trigger_decision: Dict,
        param_patch: Dict,
        mode: str = "dry_run",
        forecast_run_id: Optional[str] = None,
        user_id: Optional[str] = None,
    ) -> str:
        """
        Record a closed-loop trigger event.

        Args:
            series_id: The affected series/dataset identifier.
            trigger_decision: Output from _cl_evaluate_triggers().
            param_patch: Output from _cl_derive_params().
            mode: "dry_run" or "auto_run".
            forecast_run_id: Associated forecast run.
            user_id: Who initiated.

        Returns:
            event_id: Unique identifier for this event.
        """
        event_id = f"cl_{uuid.uuid4().hex[:12]}"
        now = datetime.now(timezone.utc).isoformat()

        event = {
            "event_id": event_id,
            "series_id": series_id,
            "timestamp": now,
            "mode": mode,
            "forecast_run_id": forecast_run_id,
            "user_id": user_id,
            "trigger_decision": {
                "should_trigger": trigger_decision.get("should_trigger", False),
                "reasons": trigger_decision.get("reasons", []),
            },
            "param_patch": _safe_serialize(param_patch),
            "outcome": None,
        }

        events = _read_json(self._events_path, [])
        events.append(event)

        # Keep last 1000 events per store
        if len(events) > 1000:
            events = events[-1000:]

        _atomic_write_json(self._events_path, events)
        self._update_stats(series_id, trigger_decision)

        logger.info(
            "Recorded closed-loop trigger %s for series=%s trigger=%s mode=%s",
            event_id, series_id,
            trigger_decision.get("should_trigger", False), mode,
        )
        return event_id

    def record_outcome(
        self,
        event_id: str,
        outcome: Dict,
    ) -> bool:
        """
        Record the outcome of a triggered closed-loop event.

        Args:
            event_id: The event to update.
            outcome: Outcome metrics (e.g., post-replan MAPE, cost delta).

        Returns:
            True if event was found and updated.
        """
        events = _read_json(self._events_path, [])
        for event in events:
            if event.get("event_id") == event_id:
                event["outcome"] = _safe_serialize(outcome)
                event["outcome_recorded_at"] = datetime.now(timezone.utc).isoformat()
                _atomic_write_json(self._events_path, events)
                return True
        return False

    def get_history(
        self,
        series_id: Optional[str] = None,
        limit: int = 50,
        triggered_only: bool = False,
    ) -> List[Dict]:
        """
        Get trigger event history.

        Args:
            series_id: Filter by series (None for all).
            limit: Max events to return.
            triggered_only: Only return events where should_trigger=True.

        Returns:
            List of event dicts, most recent first.
        """
        events = _read_json(self._events_path, [])

        if series_id:
            events = [e for e in events if e.get("series_id") == series_id]

        if triggered_only:
            events = [
                e for e in events
                if e.get("trigger_decision", {}).get("should_trigger", False)
            ]

        return list(reversed(events[-limit:]))

    def get_stats(self, series_id: Optional[str] = None) -> Dict:
        """Get aggregate trigger statistics."""
        stats = _read_json(self._stats_path, {})
        if series_id:
            return stats.get(series_id, {
                "total_evaluations": 0,
                "total_triggered": 0,
                "trigger_rate": 0.0,
                "trigger_reasons": {},
            })
        return stats

    def _update_stats(self, series_id: str, trigger_decision: Dict):
        """Update running statistics for a series."""
        stats = _read_json(self._stats_path, {})

        if series_id not in stats:
            stats[series_id] = {
                "total_evaluations": 0,
                "total_triggered": 0,
                "trigger_rate": 0.0,
                "trigger_reasons": {},
                "last_evaluation": None,
            }

        s = stats[series_id]
        s["total_evaluations"] += 1
        s["last_evaluation"] = datetime.now(timezone.utc).isoformat()

        if trigger_decision.get("should_trigger", False):
            s["total_triggered"] += 1
            for reason in trigger_decision.get("reasons", []):
                # Extract trigger type (e.g., "T-COVER" from reason string)
                trigger_type = reason.split(":")[0].strip() if ":" in reason else reason[:20]
                s["trigger_reasons"][trigger_type] = s["trigger_reasons"].get(trigger_type, 0) + 1

        s["trigger_rate"] = round(s["total_triggered"] / s["total_evaluations"], 4)
        stats[series_id] = s

        _atomic_write_json(self._stats_path, stats)


def _safe_serialize(obj: Any) -> Any:
    """Ensure obj is JSON-serializable."""
    if obj is None:
        return None
    try:
        json.dumps(obj, default=str)
        return obj
    except (TypeError, ValueError):
        return str(obj)
