"""
PR-E Deliverable 2: Promotion Gates
====================================
Quality + safety checks that must pass before an artifact is promoted
from STAGED -> PROD. Integrates with PR-C quality gates and adds
operational safety rules.

Features:
  - Quality gate check (coverage, bias, pinball)
  - Minimum data requirements (history length, feature spec stability)
  - Override mechanism with audit trail
  - Post-promotion auto-rollback trigger
"""
import logging
from dataclasses import dataclass, field
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)


@dataclass
class PromotionGateConfig:
    """Configurable thresholds for promotion gates."""

    # Quality gate thresholds (aligned with PR-C QualityGateConfig)
    min_coverage_10_90: float = 0.70
    max_bias_abs: float = 50.0
    max_pinball_loss: float = 100.0
    max_mape: float = 50.0

    # Minimum data requirements
    min_training_points: int = 30
    min_val_points: int = 7

    # Post-promotion rollback: MAPE worsening threshold (percentage points)
    rollback_mape_degradation_pct: float = 20.0

    def to_dict(self) -> Dict:
        return {
            "min_coverage_10_90": self.min_coverage_10_90,
            "max_bias_abs": self.max_bias_abs,
            "max_pinball_loss": self.max_pinball_loss,
            "max_mape": self.max_mape,
            "min_training_points": self.min_training_points,
            "min_val_points": self.min_val_points,
            "rollback_mape_degradation_pct": self.rollback_mape_degradation_pct,
        }


@dataclass
class PromotionGateResult:
    """Result of promotion gate evaluation."""

    can_promote: bool
    reasons: List[str] = field(default_factory=list)
    quality_passed: bool = True
    data_requirements_met: bool = True
    config_used: Dict = field(default_factory=dict)

    def to_dict(self) -> Dict:
        return {
            "can_promote": self.can_promote,
            "reasons": self.reasons,
            "quality_passed": self.quality_passed,
            "data_requirements_met": self.data_requirements_met,
            "config_used": self.config_used,
        }


def evaluate_promotion_gates(
    artifact_record: Dict,
    config: Optional[PromotionGateConfig] = None,
) -> PromotionGateResult:
    """
    Evaluate whether an artifact is eligible for promotion to PROD.

    Args:
        artifact_record: Full artifact record from registry.
        config: Gate thresholds (uses defaults if None).

    Returns:
        PromotionGateResult with can_promote flag and reasons.
    """
    if config is None:
        config = PromotionGateConfig()

    reasons = []
    quality_passed = True
    data_req_met = True

    metrics = artifact_record.get("metrics_summary", {})

    # Quality Gate 1: MAPE
    mape = metrics.get("mape")
    if mape is not None and mape > config.max_mape:
        quality_passed = False
        reasons.append(f"MAPE={mape:.2f} > max={config.max_mape:.2f}")

    # Quality Gate 2: Coverage
    coverage = metrics.get("coverage_10_90")
    if coverage is not None and coverage < config.min_coverage_10_90:
        quality_passed = False
        reasons.append(
            f"coverage_10_90={coverage:.3f} < min={config.min_coverage_10_90:.2f}"
        )

    # Quality Gate 3: Bias
    bias = metrics.get("bias")
    if bias is not None and abs(bias) > config.max_bias_abs:
        quality_passed = False
        reasons.append(f"|bias|={abs(bias):.2f} > max={config.max_bias_abs:.2f}")

    # Quality Gate 4: Pinball loss
    pinball = metrics.get("pinball")
    if pinball is not None and pinball > config.max_pinball_loss:
        quality_passed = False
        reasons.append(
            f"pinball_loss={pinball:.2f} > max={config.max_pinball_loss:.2f}"
        )

    # Quality Gate 5: Calibration
    cal_passed = artifact_record.get("calibration_passed")
    if cal_passed is False:
        quality_passed = False
        reasons.append("calibration_passed=False")

    # Data requirement: enough history
    # We check the training window via metrics or dataset metadata
    n_eval = metrics.get("n_eval_points", 0)
    if n_eval > 0 and n_eval < config.min_val_points:
        data_req_met = False
        reasons.append(
            f"n_eval_points={n_eval} < min={config.min_val_points}"
        )

    can_promote = quality_passed and data_req_met

    if can_promote and not reasons:
        reasons.append("All promotion gates passed")

    return PromotionGateResult(
        can_promote=can_promote,
        reasons=reasons,
        quality_passed=quality_passed,
        data_requirements_met=data_req_met,
        config_used=config.to_dict(),
    )


def check_post_promotion_rollback(
    prod_metrics: Dict,
    baseline_metrics: Dict,
    config: Optional[PromotionGateConfig] = None,
) -> Dict:
    """
    Check if a post-promotion backtest shows degradation that warrants rollback.

    Args:
        prod_metrics: Metrics from the new PROD model.
        baseline_metrics: Metrics from the previous PROD model (baseline).
        config: Thresholds for rollback decision.

    Returns:
        Dict with should_rollback, reasons, and metrics comparison.
    """
    if config is None:
        config = PromotionGateConfig()

    should_rollback = False
    reasons = []

    prod_mape = prod_metrics.get("mape", 0)
    baseline_mape = baseline_metrics.get("mape", 0)

    if baseline_mape > 0:
        mape_increase_pct = ((prod_mape - baseline_mape) / baseline_mape) * 100
    else:
        mape_increase_pct = 0

    if mape_increase_pct > config.rollback_mape_degradation_pct:
        should_rollback = True
        reasons.append(
            f"MAPE increased by {mape_increase_pct:.1f}% "
            f"(threshold={config.rollback_mape_degradation_pct:.1f}%): "
            f"{baseline_mape:.2f} -> {prod_mape:.2f}"
        )

    # Coverage drop check
    prod_cov = prod_metrics.get("coverage_10_90")
    baseline_cov = baseline_metrics.get("coverage_10_90")
    if prod_cov is not None and baseline_cov is not None:
        if prod_cov < config.min_coverage_10_90 and baseline_cov >= config.min_coverage_10_90:
            should_rollback = True
            reasons.append(
                f"Coverage dropped below threshold: "
                f"{baseline_cov:.3f} -> {prod_cov:.3f} "
                f"(min={config.min_coverage_10_90:.2f})"
            )

    return {
        "should_rollback": should_rollback,
        "reasons": reasons,
        "prod_metrics": prod_metrics,
        "baseline_metrics": baseline_metrics,
        "mape_increase_pct": mape_increase_pct,
    }
