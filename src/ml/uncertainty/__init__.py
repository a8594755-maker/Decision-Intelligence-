"""
PR-C: Probabilistic Uncertainty & Calibration Quality Gates
"""
from .quantile_engine import QuantileEngine
from .calibration_metrics import (
    compute_coverage,
    compute_pinball_loss,
    compute_bias,
    compute_interval_width,
    compute_calibration_metrics,
)
from .quality_gates import QualityGateConfig, evaluate_candidate

__all__ = [
    "QuantileEngine",
    "compute_coverage",
    "compute_pinball_loss",
    "compute_bias",
    "compute_interval_width",
    "compute_calibration_metrics",
    "QualityGateConfig",
    "evaluate_candidate",
]
