"""
PR-C Deliverable 5: Quality Gates (Accept/Reject Logic)
───────────────────────────────────────────────────────
Deterministic pass/fail criteria for probabilistic forecast candidates.

Evaluates:
  - coverage_10_90: must be within acceptable band
  - bias: absolute value below threshold
  - pinball_loss: must be below a maximum threshold

Returns structured {pass, reasons, thresholds} for each evaluation.
"""
import logging
from dataclasses import dataclass, field
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)


@dataclass
class QualityGateConfig:
    """Configurable thresholds for quality gates."""

    # Coverage band: fraction of actuals within [p10, p90]
    coverage_min: float = 0.70
    coverage_max: float = 0.90
    coverage_target: float = 0.80

    # Bias: |mean(p50 - actual)| must be below this
    bias_abs_max: float = 50.0

    # Pinball loss: aggregated mean must be below this
    pinball_loss_max: float = 100.0

    # Interval width: if > this multiple of mean(|actuals|), flag as too wide
    interval_width_ratio_max: Optional[float] = 3.0


@dataclass
class GateResult:
    """Result of quality gate evaluation."""
    passed: bool
    reasons: List[str]
    thresholds: Dict[str, float]
    metrics_evaluated: Dict[str, Optional[float]]
    degraded: bool = False

    def to_dict(self) -> dict:
        return {
            "passed": self.passed,
            "reasons": self.reasons,
            "thresholds": self.thresholds,
            "metrics_evaluated": self.metrics_evaluated,
            "degraded": self.degraded,
        }


def evaluate_candidate(
    metrics: Dict[str, Optional[float]],
    config: Optional[QualityGateConfig] = None,
    actuals_mean: Optional[float] = None,
) -> GateResult:
    """
    Evaluate a forecast candidate against quality gates.

    Args:
        metrics: Dict containing calibration metrics:
            - coverage_10_90: float or None
            - pinball_loss_mean: float or None
            - bias: float or None
            - interval_width_10_90: float or None
        config: Quality gate thresholds (uses defaults if None).
        actuals_mean: Mean of actual values (for interval width ratio check).

    Returns:
        GateResult with pass/fail, reasons, and thresholds.
    """
    if config is None:
        config = QualityGateConfig()

    reasons = []
    passed = True

    cov = metrics.get("coverage_10_90")
    bias = metrics.get("bias")
    pinball = metrics.get("pinball_loss_mean")
    width = metrics.get("interval_width_10_90")

    thresholds = {
        "coverage_min": config.coverage_min,
        "coverage_max": config.coverage_max,
        "coverage_target": config.coverage_target,
        "bias_abs_max": config.bias_abs_max,
        "pinball_loss_max": config.pinball_loss_max,
    }
    if config.interval_width_ratio_max is not None:
        thresholds["interval_width_ratio_max"] = config.interval_width_ratio_max

    # Gate 1: Coverage
    if cov is not None:
        if cov < config.coverage_min:
            passed = False
            reasons.append(
                f"coverage_10_90={cov:.3f} < min={config.coverage_min:.2f}"
            )
        elif cov > config.coverage_max:
            # Over-coverage means intervals are too wide — warn but don't fail
            reasons.append(
                f"coverage_10_90={cov:.3f} > max={config.coverage_max:.2f} (intervals may be too wide)"
            )
    else:
        reasons.append("coverage_10_90 is missing — cannot evaluate coverage gate")

    # Gate 2: Bias
    if bias is not None:
        if abs(bias) > config.bias_abs_max:
            passed = False
            reasons.append(
                f"|bias|={abs(bias):.2f} > max={config.bias_abs_max:.2f}"
            )
    else:
        reasons.append("bias is missing — cannot evaluate bias gate")

    # Gate 3: Pinball loss
    if pinball is not None:
        if pinball > config.pinball_loss_max:
            passed = False
            reasons.append(
                f"pinball_loss_mean={pinball:.2f} > max={config.pinball_loss_max:.2f}"
            )

    # Gate 4: Interval width (optional guardrail)
    if (
        width is not None
        and actuals_mean is not None
        and actuals_mean > 0
        and config.interval_width_ratio_max is not None
    ):
        ratio = width / actuals_mean
        if ratio > config.interval_width_ratio_max:
            reasons.append(
                f"interval_width_ratio={ratio:.2f} > max={config.interval_width_ratio_max:.2f} (intervals exploding)"
            )

    return GateResult(
        passed=passed,
        reasons=reasons,
        thresholds=thresholds,
        metrics_evaluated={
            "coverage_10_90": cov,
            "bias": bias,
            "pinball_loss_mean": pinball,
            "interval_width_10_90": width,
        },
    )


def select_best_candidate(
    candidates: List[Dict],
) -> Dict:
    """
    Select the best candidate from a list, respecting quality gates.

    Each candidate dict must have:
      - "model": str
      - "gate_result": GateResult (or dict with "passed")
      - "metrics": dict with calibration metrics

    Rules:
      - If any candidates pass gates, pick the one with lowest pinball_loss_mean.
      - If ALL fail, pick the one with best coverage and mark as DEGRADED.

    Returns:
        Best candidate dict with "degraded" flag.
    """
    if not candidates:
        return {"model": "none", "degraded": True, "reason": "no candidates"}

    passing = [
        c for c in candidates
        if (c.get("gate_result", {}).get("passed", False)
            if isinstance(c.get("gate_result"), dict)
            else getattr(c.get("gate_result"), "passed", False))
    ]

    if passing:
        # Pick lowest pinball loss among passing candidates
        best = min(
            passing,
            key=lambda c: (c.get("metrics", {}).get("pinball_loss_mean") or float("inf")),
        )
        best["degraded"] = False
        return best

    # All failed — pick best coverage, mark degraded
    best = max(
        candidates,
        key=lambda c: (c.get("metrics", {}).get("coverage_10_90") or 0.0),
    )
    best["degraded"] = True
    logger.warning(
        "All candidates failed quality gates — selecting best-coverage candidate as DEGRADED: %s",
        best.get("model"),
    )
    return best
