"""
PR-C Deliverable 3: Backtest Quantile Evaluation Metrics
────────────────────────────────────────────────────────
Computes calibration quality metrics for probabilistic forecasts:
  - coverage_10_90: fraction of actuals within [p10, p90]
  - pinball_loss (per quantile and aggregated)
  - bias: mean(p50 - actual)
  - interval_width_10_90: mean width of prediction interval
"""
from typing import Dict, List, Optional

import numpy as np


def compute_coverage(
    actuals: List[float],
    p10: List[float],
    p90: List[float],
) -> float:
    """
    Fraction of actuals that fall within [p10, p90].

    Args:
        actuals: Observed values.
        p10: 10th percentile predictions.
        p90: 90th percentile predictions.

    Returns:
        Coverage ratio in [0, 1].
    """
    if not actuals:
        return 0.0
    a = np.array(actuals, dtype=np.float64)
    lo = np.array(p10, dtype=np.float64)
    hi = np.array(p90, dtype=np.float64)
    n = min(len(a), len(lo), len(hi))
    if n == 0:
        return 0.0
    covered = np.sum((a[:n] >= lo[:n]) & (a[:n] <= hi[:n]))
    return float(covered / n)


def compute_pinball_loss(
    actuals: List[float],
    quantile_preds: List[float],
    tau: float,
) -> float:
    """
    Pinball (quantile) loss for a single quantile level.

    L_tau(y, q) = tau * max(y - q, 0) + (1 - tau) * max(q - y, 0)

    Args:
        actuals: Observed values.
        quantile_preds: Predicted quantile values.
        tau: Quantile level (e.g. 0.10, 0.50, 0.90).

    Returns:
        Mean pinball loss (lower is better).
    """
    if not actuals:
        return 0.0
    a = np.array(actuals, dtype=np.float64)
    q = np.array(quantile_preds, dtype=np.float64)
    n = min(len(a), len(q))
    if n == 0:
        return 0.0
    diff = a[:n] - q[:n]
    loss = np.where(diff >= 0, tau * diff, (tau - 1) * diff)
    return float(np.mean(loss))


def compute_bias(
    actuals: List[float],
    p50: List[float],
) -> float:
    """
    Forecast bias: mean(p50 - actual).

    Positive bias = forecasts tend to overestimate.
    Negative bias = forecasts tend to underestimate.

    Args:
        actuals: Observed values.
        p50: Median (p50) predictions.

    Returns:
        Mean bias.
    """
    if not actuals:
        return 0.0
    a = np.array(actuals, dtype=np.float64)
    p = np.array(p50, dtype=np.float64)
    n = min(len(a), len(p))
    if n == 0:
        return 0.0
    return float(np.mean(p[:n] - a[:n]))


def compute_interval_width(
    p10: List[float],
    p90: List[float],
) -> float:
    """
    Mean width of the [p10, p90] prediction interval.

    Args:
        p10: 10th percentile predictions.
        p90: 90th percentile predictions.

    Returns:
        Mean interval width.
    """
    if not p10 or not p90:
        return 0.0
    lo = np.array(p10, dtype=np.float64)
    hi = np.array(p90, dtype=np.float64)
    n = min(len(lo), len(hi))
    if n == 0:
        return 0.0
    return float(np.mean(hi[:n] - lo[:n]))


def compute_calibration_metrics(
    actuals: List[float],
    p10: List[float],
    p50: List[float],
    p90: List[float],
) -> Dict[str, Optional[float]]:
    """
    Compute all calibration metrics in one call.

    Returns:
        Dict with keys:
          - coverage_10_90
          - pinball_loss_p10
          - pinball_loss_p50
          - pinball_loss_p90
          - pinball_loss_mean (average of p10/p50/p90 losses)
          - bias
          - interval_width_10_90
    """
    if not actuals or not p50:
        return {
            "coverage_10_90": None,
            "pinball_loss_p10": None,
            "pinball_loss_p50": None,
            "pinball_loss_p90": None,
            "pinball_loss_mean": None,
            "bias": None,
            "interval_width_10_90": None,
        }

    cov = compute_coverage(actuals, p10, p90)
    pl10 = compute_pinball_loss(actuals, p10, 0.10)
    pl50 = compute_pinball_loss(actuals, p50, 0.50)
    pl90 = compute_pinball_loss(actuals, p90, 0.90)
    pl_mean = (pl10 + pl50 + pl90) / 3.0
    bias = compute_bias(actuals, p50)
    width = compute_interval_width(p10, p90)

    return {
        "coverage_10_90": cov,
        "pinball_loss_p10": pl10,
        "pinball_loss_p50": pl50,
        "pinball_loss_p90": pl90,
        "pinball_loss_mean": pl_mean,
        "bias": bias,
        "interval_width_10_90": width,
    }
