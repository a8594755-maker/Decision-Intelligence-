"""
run_forecast_spec.py — Eval specs for the demand forecast pipeline (Python backend)

Tests the POST /demand-forecast endpoint via ForecasterFactory.
Does NOT test the JS-side chatForecastService (that requires integration tests).
"""

from ml.api.tool_eval import (
    ToolTestSpec, close, exists, count, custom, in_range, truthy,
)
import math

# ── Golden test data ──

DAILY_SALES_90D = [
    100 + int(20 * math.sin(i * 0.3)) + (i % 7 == 0) * 30  # weekly spike
    for i in range(90)
]

MONTHLY_SALES_12M = [
    50000, 55000, 48000, 62000, 70000, 65000,
    72000, 68000, 58000, 52000, 54000, 60000,
]

ALL_ZEROS = [0] * 30
SHORT_HISTORY = [100, 120, 90, 110, 130]  # only 5 points
SPIKE_DATA = [100] * 29 + [10000]  # normal then extreme spike


def _run_forecast(input_data):
    """Helper: call ForecasterFactory.predict_with_fallback directly."""
    from ml.demand_forecasting.forecaster_factory import ForecasterFactory
    factory = ForecasterFactory()
    history = input_data.get("history", [])
    horizon = input_data.get("horizon", 7)
    model = input_data.get("model", "auto")

    result = factory.predict_with_fallback(
        sku="TEST-001",
        erp_connector=None,
        horizon_days=horizon,
        preferred_model=model,
        inline_history=history,
    )
    return result


def _check_predictions_non_negative(result):
    """All predictions must be >= 0."""
    pred = result.get("prediction", {}).get("predictions", [])
    if not pred:
        return False, "No predictions found"
    negatives = [p for p in pred if p < 0]
    if negatives:
        return False, f"Found {len(negatives)} negative predictions: {negatives[:5]}"
    return True, f"All {len(pred)} predictions >= 0"


def _check_quantile_order(result):
    """p10 <= p50 <= p90 for every forecast point."""
    pred = result.get("prediction", {})
    p10 = pred.get("lower_bound") or pred.get("p10", [])
    p50 = pred.get("predictions", [])
    p90 = pred.get("upper_bound") or pred.get("p90", [])
    if not p50:
        return False, "No predictions"
    if not p10 or not p90:
        return True, "Quantiles not present (ok for point forecast)"
    violations = []
    for i in range(min(len(p10), len(p50), len(p90))):
        if p10[i] > p50[i] + 0.01:
            violations.append(f"day {i}: p10={p10[i]:.1f} > p50={p50[i]:.1f}")
        if p90[i] < p50[i] - 0.01:
            violations.append(f"day {i}: p90={p90[i]:.1f} < p50={p50[i]:.1f}")
    if violations:
        return False, f"{len(violations)} quantile violations: {violations[:3]}"
    return True, f"Quantile order verified for {len(p50)} points"


def _check_success(result):
    if result.get("success"):
        return True, "Prediction succeeded"
    return False, f"Prediction failed: {result.get('error', 'unknown')}"


def _check_horizon_length(result, expected_horizon):
    pred = result.get("prediction", {}).get("predictions", [])
    if len(pred) == expected_horizon:
        return True, f"Got {expected_horizon} predictions"
    return False, f"Expected {expected_horizon} predictions, got {len(pred)}"


SPECS = [
    ToolTestSpec(
        tool_id="run_forecast",
        scenario="happy_path_daily_90d",
        description="Normal daily data, 90 days history, 7 day horizon → success + non-negative + quantile order",
        run_fn=_run_forecast,
        input_data={"history": DAILY_SALES_90D, "horizon": 7, "model": "auto"},
        tags=["core", "fast"],
        assertions=[
            custom("success", _check_success),
            custom("non_negative", _check_predictions_non_negative),
            custom("quantile_order", _check_quantile_order),
            custom("horizon_7", lambda r: _check_horizon_length(r, 7)),
        ],
    ),

    ToolTestSpec(
        tool_id="run_forecast",
        scenario="monthly_12m",
        description="Monthly data, 12 months history, 3 month horizon",
        run_fn=_run_forecast,
        input_data={"history": MONTHLY_SALES_12M, "horizon": 3, "model": "auto"},
        tags=["core"],
        assertions=[
            custom("success", _check_success),
            custom("non_negative", _check_predictions_non_negative),
            custom("horizon_3", lambda r: _check_horizon_length(r, 3)),
        ],
    ),

    ToolTestSpec(
        tool_id="run_forecast",
        scenario="all_zeros",
        description="All-zero history should not crash, predictions should be 0 or near-zero",
        run_fn=_run_forecast,
        input_data={"history": ALL_ZEROS, "horizon": 7, "model": "auto"},
        tags=["edge", "regression"],
        assertions=[
            custom("success", _check_success),
            custom("non_negative", _check_predictions_non_negative),
            custom("near_zero", lambda r: (
                all(p <= 10 for p in r.get("prediction", {}).get("predictions", [])),
                f"Predictions: {r.get('prediction', {}).get('predictions', [])[:5]}"
            ) if r.get("success") else (True, "Skipped (model failed)")),
        ],
    ),

    ToolTestSpec(
        tool_id="run_forecast",
        scenario="spike_outlier",
        description="29 days of 100 + 1 day of 10000 — spike should not propagate to all predictions",
        run_fn=_run_forecast,
        input_data={"history": SPIKE_DATA, "horizon": 7, "model": "auto"},
        tags=["edge"],
        assertions=[
            custom("success", _check_success),
            custom("non_negative", _check_predictions_non_negative),
            custom("no_extreme_propagation", lambda r: (
                all(p < 20000 for p in r.get("prediction", {}).get("predictions", [])),
                f"Predictions: {r.get('prediction', {}).get('predictions', [])[:5]}"
            ) if r.get("success") else (True, "Skipped")),
        ],
    ),

    ToolTestSpec(
        tool_id="run_forecast",
        scenario="fallback_chain",
        description="Request specific model (lightgbm) — should succeed or gracefully fallback",
        run_fn=_run_forecast,
        input_data={"history": DAILY_SALES_90D, "horizon": 14, "model": "lightgbm"},
        tags=["core"],
        assertions=[
            custom("success", _check_success),
            custom("non_negative", _check_predictions_non_negative),
            custom("quantile_order", _check_quantile_order),
            custom("horizon_14", lambda r: _check_horizon_length(r, 14)),
        ],
    ),
]
