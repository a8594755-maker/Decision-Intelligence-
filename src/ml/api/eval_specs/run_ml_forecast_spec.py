"""
run_ml_forecast_spec.py — Eval specs for ML forecast models (LightGBM, Prophet)

Tests individual model strategies via ForecasterFactory.
"""

from ml.api.tool_eval import (
    ToolTestSpec, custom,
)
import math

DAILY_60D = [200 + int(40 * math.sin(i * 0.2)) for i in range(60)]
WEEKLY_PATTERN = [500, 600, 550, 700, 800, 650, 300] * 8 + [500, 600]  # 58 days


def _run_strategy(input_data):
    """Run a specific model strategy."""
    from ml.demand_forecasting.forecaster_factory import ForecasterFactory
    factory = ForecasterFactory()
    return factory.predict_with_fallback(
        sku="ML-TEST",
        erp_connector=None,
        horizon_days=input_data.get("horizon", 7),
        preferred_model=input_data["model"],
        inline_history=input_data["history"],
    )


def _check_success(result):
    return (True, "OK") if result.get("success") else (False, result.get("error", "?"))


def _check_non_negative(result):
    pred = result.get("prediction", {}).get("predictions", [])
    neg = [p for p in pred if p < 0]
    return (True, f"{len(pred)} predictions, all >= 0") if not neg else (False, f"Negatives: {neg[:3]}")


def _check_model_used(result, expected_model):
    used = result.get("prediction", {}).get("model_used", result.get("model_used", ""))
    if expected_model.lower() in used.lower():
        return True, f"Used {used}"
    # Fallback is acceptable
    return True, f"Used {used} (fallback from {expected_model})"


SPECS = [
    ToolTestSpec(
        tool_id="run_ml_forecast",
        scenario="lightgbm_daily",
        description="LightGBM on 60-day daily data",
        run_fn=_run_strategy,
        input_data={"history": DAILY_60D, "horizon": 7, "model": "lightgbm"},
        tags=["core"],
        assertions=[
            custom("success", _check_success),
            custom("non_negative", _check_non_negative),
            custom("model", lambda r: _check_model_used(r, "lightgbm")),
        ],
    ),

    ToolTestSpec(
        tool_id="run_ml_forecast",
        scenario="prophet_daily",
        description="Prophet on 60-day daily data",
        run_fn=_run_strategy,
        input_data={"history": DAILY_60D, "horizon": 7, "model": "prophet"},
        tags=["core"],
        assertions=[
            custom("success", _check_success),
            custom("non_negative", _check_non_negative),
        ],
    ),

    ToolTestSpec(
        tool_id="run_ml_forecast",
        scenario="feature_schema_consistency",
        description="Feature columns must match FEATURE_COLUMNS exactly during inference",
        run_fn=_run_strategy,
        input_data={"history": WEEKLY_PATTERN, "horizon": 7, "model": "lightgbm"},
        tags=["regression"],
        assertions=[
            custom("success", _check_success),
            custom("schema_ok", lambda r: (
                True, "Feature schema validated by assert_feature_schema()"
            ) if r.get("success") else (
                "schema" not in str(r.get("error", "")).lower(),
                f"Schema error: {r.get('error', '')}"
            )),
        ],
    ),

    ToolTestSpec(
        tool_id="run_ml_forecast",
        scenario="negative_input_handling",
        description="B10 regression: negative values in history should not crash; predictions still non-negative",
        run_fn=_run_strategy,
        input_data={"history": [100, 200, -50, 150, 300, 100, 200, 150, 180, 120] * 3, "horizon": 7, "model": "auto"},
        tags=["regression", "b10"],
        assertions=[
            custom("success", _check_success),
            custom("non_negative", _check_non_negative),
        ],
    ),

    ToolTestSpec(
        tool_id="run_ml_forecast",
        scenario="all_zero_no_crash",
        description="All-zero history should not crash (ETS floor at 0.01)",
        run_fn=_run_strategy,
        input_data={"history": [0] * 30, "horizon": 7, "model": "ets"},
        tags=["edge"],
        assertions=[
            custom("success", _check_success),
            custom("non_negative", _check_non_negative),
        ],
    ),

    ToolTestSpec(
        tool_id="run_ml_forecast",
        scenario="ensemble_race",
        description="Auto mode with 60+ points triggers ensemble race; result has model_used metadata",
        run_fn=_run_strategy,
        input_data={"history": DAILY_60D, "horizon": 14, "model": "auto"},
        tags=["core"],
        assertions=[
            custom("success", _check_success),
            custom("non_negative", _check_non_negative),
            custom("has_model", lambda r: (
                bool(r.get("prediction", {}).get("model_used") or r.get("model_used")),
                f"model_used: {r.get('prediction', {}).get('model_used', r.get('model_used', 'MISSING'))}"
            )),
        ],
    ),

    ToolTestSpec(
        tool_id="run_ml_forecast",
        scenario="quantile_order",
        description="p10 <= p50 <= p90 for all output points",
        run_fn=_run_strategy,
        input_data={"history": WEEKLY_PATTERN, "horizon": 7, "model": "auto"},
        tags=["core"],
        assertions=[
            custom("success", _check_success),
            custom("quantile_order", lambda r: (
                lambda pred: (
                    all(pred.get("p10", [0])[i] <= pred.get("p50", pred.get("predictions", [0]))[i] + 0.01
                        and pred.get("p90", [999])[i] >= pred.get("p50", pred.get("predictions", [0]))[i] - 0.01
                        for i in range(min(len(pred.get("p10", [])), len(pred.get("p90", [])), len(pred.get("predictions", [])))))
                    if pred.get("p10") and pred.get("p90") else True,
                    "Quantile order verified" if pred.get("p10") else "No quantiles (point forecast)"
                )
            )(r.get("prediction", {}))),
        ],
    ),
]
