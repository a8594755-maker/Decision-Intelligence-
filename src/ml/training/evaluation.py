"""
PR-B: Evaluation Module
───────────────────────
Time-series safe evaluation with walk-forward and holdout support.
Computes metrics consistent with /backtest contract: mape, bias, coverage_10_90.
"""
from dataclasses import dataclass, field
from typing import Dict, List, Optional

import numpy as np


@dataclass
class EvalMetrics:
    """Metrics bag produced by evaluation."""

    mape: float = 999.0
    bias: float = 0.0
    mae: float = 0.0
    rmse: float = 0.0
    coverage_10_90: Optional[float] = None  # None if quantiles unavailable
    pinball_10: Optional[float] = None
    pinball_90: Optional[float] = None
    n_eval_points: int = 0
    eval_mode: str = "holdout"  # "holdout" | "walk_forward"

    def to_dict(self) -> Dict:
        d = {
            "mape": round(self.mape, 4),
            "bias": round(self.bias, 4),
            "mae": round(self.mae, 4),
            "rmse": round(self.rmse, 4),
            "n_eval_points": self.n_eval_points,
            "eval_mode": self.eval_mode,
        }
        if self.coverage_10_90 is not None:
            d["coverage_10_90"] = round(self.coverage_10_90, 4)
        if self.pinball_10 is not None:
            d["pinball_10"] = round(self.pinball_10, 4)
        if self.pinball_90 is not None:
            d["pinball_90"] = round(self.pinball_90, 4)
        return d

    @property
    def grade(self) -> str:
        if self.mape < 10:
            return "A+"
        elif self.mape < 20:
            return "A"
        elif self.mape < 50:
            return "B"
        return "F"


def compute_metrics(
    actual: np.ndarray,
    predicted: np.ndarray,
    lower_10: Optional[np.ndarray] = None,
    upper_90: Optional[np.ndarray] = None,
    eval_mode: str = "holdout",
) -> EvalMetrics:
    """
    Compute evaluation metrics.

    Args:
        actual: Ground truth values.
        predicted: Point predictions (p50).
        lower_10: p10 quantile predictions (optional).
        upper_90: p90 quantile predictions (optional).
        eval_mode: "holdout" or "walk_forward".

    Returns:
        EvalMetrics with all computed fields.
    """
    actual = np.asarray(actual, dtype=float)
    predicted = np.asarray(predicted, dtype=float)
    n = len(actual)

    if n == 0:
        return EvalMetrics(eval_mode=eval_mode)

    # --- MAPE (exclude zero actuals) ---
    mask = actual != 0
    if mask.any():
        mape = float(np.mean(np.abs((actual[mask] - predicted[mask]) / actual[mask])) * 100)
    else:
        mape = 999.0

    # --- Bias (mean error, positive = over-forecast) ---
    errors = predicted - actual
    bias = float(np.mean(errors))

    # --- MAE ---
    mae = float(np.mean(np.abs(errors)))

    # --- RMSE ---
    rmse = float(np.sqrt(np.mean(errors ** 2)))

    # --- Coverage & pinball (if quantiles available) ---
    coverage = None
    pinball_10 = None
    pinball_90 = None

    if lower_10 is not None and upper_90 is not None:
        lower_10 = np.asarray(lower_10, dtype=float)
        upper_90 = np.asarray(upper_90, dtype=float)

        in_interval = (actual >= lower_10) & (actual <= upper_90)
        coverage = float(np.mean(in_interval) * 100)

        # Pinball loss for p10 (alpha=0.1)
        diff_10 = actual - lower_10
        pinball_10 = float(np.mean(
            np.where(diff_10 >= 0, 0.1 * diff_10, -0.9 * diff_10)
        ))

        # Pinball loss for p90 (alpha=0.9)
        diff_90 = actual - upper_90
        pinball_90 = float(np.mean(
            np.where(diff_90 >= 0, 0.9 * diff_90, -0.1 * diff_90)
        ))

    return EvalMetrics(
        mape=mape,
        bias=bias,
        mae=mae,
        rmse=rmse,
        coverage_10_90=coverage,
        pinball_10=pinball_10,
        pinball_90=pinball_90,
        n_eval_points=n,
        eval_mode=eval_mode,
    )


def walk_forward_evaluate(
    train_values: List[float],
    val_values: List[float],
    predict_fn,
    horizon: int,
    step: int = 1,
) -> EvalMetrics:
    """
    Walk-forward evaluation.

    At each step:
      1. Use train_values[: origin] as history
      2. Call predict_fn(history, horizon) -> predictions
      3. Compare predictions vs next `horizon` actual values
      4. Advance origin by `step`

    Args:
        train_values: Initial training data.
        val_values: Validation data to walk through.
        predict_fn: Callable(history: List[float], horizon: int) -> List[float]
        horizon: Forecast horizon per window.
        step: Number of days to advance between windows.

    Returns:
        EvalMetrics aggregated over all windows.
    """
    all_actual = []
    all_predicted = []

    history = list(train_values)
    val = list(val_values)

    origin = 0
    while origin + horizon <= len(val):
        predictions = predict_fn(history + val[:origin], horizon)
        actual_window = val[origin : origin + horizon]

        # Trim to same length
        min_len = min(len(predictions), len(actual_window))
        all_actual.extend(actual_window[:min_len])
        all_predicted.extend(predictions[:min_len])

        origin += step

    if not all_actual:
        return EvalMetrics(eval_mode="walk_forward")

    return compute_metrics(
        np.array(all_actual),
        np.array(all_predicted),
        eval_mode="walk_forward",
    )
