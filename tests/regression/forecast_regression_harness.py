"""Shared harness for deterministic forecast regression fixtures."""
from __future__ import annotations

import copy
import json
import math
import sys
import types
from pathlib import Path
from typing import Any, Dict, List

from ml.api.forecast_contract import (
    BacktestResponse,
    ForecastResponse,
    finalize_backtest_response,
    finalize_forecast_response,
)

# Keep regression harness lightweight and deterministic: stub optional torch/chronos imports.
_torch_stub = types.ModuleType("torch")


class _TorchTensor:  # pragma: no cover - tiny compatibility shim
    pass


class _TorchCuda:  # pragma: no cover - tiny compatibility shim
    @staticmethod
    def is_available() -> bool:
        return False


def _torch_device(*_args, **_kwargs) -> str:  # pragma: no cover - tiny compatibility shim
    return "cpu"


_torch_stub.Tensor = _TorchTensor
_torch_stub.cuda = _TorchCuda()
_torch_stub.device = _torch_device
sys.modules["torch"] = _torch_stub
sys.modules.setdefault("chronos", None)

from ml.demand_forecasting.forecaster_factory import ForecasterFactory, ModelType


FIXTURE_DIR = Path(__file__).resolve().parents[1] / "fixtures" / "forecast"
FIXTURE_FILES = [
    "steady_weekly_small.json",
    "upward_trend_small.json",
]


def load_fixture(file_name: str) -> Dict[str, Any]:
    with (FIXTURE_DIR / file_name).open("r", encoding="utf-8") as handle:
        return json.load(handle)


def load_fixtures() -> List[Dict[str, Any]]:
    return [load_fixture(name) for name in FIXTURE_FILES]


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def _assert_bounds(value: Any, bounds: Dict[str, Any], label: str) -> None:
    if not bounds:
        return
    number = _to_float(value, float("nan"))
    assert math.isfinite(number), f"{label} is not finite: {value}"
    if "min" in bounds:
        assert number + 1e-9 >= float(bounds["min"]), f"{label} below min: {number} < {bounds['min']}"
    if "max" in bounds:
        assert number <= float(bounds["max"]) + 1e-9, f"{label} above max: {number} > {bounds['max']}"


def _successful_results(backtest_result: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [row for row in (backtest_result.get("results") or []) if bool(row.get("success"))]


def _force_deterministic_fallback(factory: ForecasterFactory) -> None:
    # Force deterministic statistical fallback so fixture expectations are stable across environments.
    for model_type in (ModelType.LIGHTGBM, ModelType.PROPHET):
        strategy = factory.get_strategy(model_type)
        if hasattr(strategy, "_model"):
            setattr(strategy, "_model", None)


def run_backtest_fixture(fixture: Dict[str, Any]) -> Dict[str, Any]:
    request = fixture.get("request") or {}
    factory = ForecasterFactory()
    _force_deterministic_fallback(factory)

    result = factory.backtest_with_calibration(
        sku=str(request.get("sku") or fixture.get("id") or "fixture-sku"),
        full_history=[_to_float(v, 0.0) for v in (request.get("series") or [])],
        test_days=int(request.get("test_days") or 7),
        models=[str(model).lower() for model in (request.get("models") or ["lightgbm", "prophet"])],
    )
    assert "error" not in result, f"forecast regression fixture failed: {result.get('error')}"
    return result


def assert_backtest_contract_schema(backtest_result: Dict[str, Any], fixture: Dict[str, Any]) -> Dict[str, Any]:
    request = fixture.get("request") or {}
    contract_payload = finalize_backtest_response(copy.deepcopy(backtest_result))
    parsed = BacktestResponse.model_validate(contract_payload)

    assert parsed.forecast_contract_version.startswith("1."), "backtest contract version must be 1.x"
    assert parsed.sku == str(request.get("sku") or fixture.get("id") or "")
    assert parsed.diagnostics.test_days == int(request.get("test_days") or 7)
    assert parsed.best_model.get("name"), "best_model.name missing"
    assert isinstance(parsed.results, list) and len(parsed.results) > 0, "backtest results missing"

    return contract_payload


def assert_inference_contract_schema(backtest_result: Dict[str, Any], fixture: Dict[str, Any]) -> Dict[str, Any]:
    request = fixture.get("request") or {}
    successful = _successful_results(backtest_result)
    assert successful, "at least one successful model result is required"

    best = min(successful, key=lambda row: _to_float(row.get("mape"), float("inf")))
    p50 = [_to_float(v, 0.0) for v in (best.get("p50") or best.get("forecast") or [])]
    p10 = [_to_float(v, 0.0) for v in (best.get("p10") or p50)]
    p90 = [_to_float(v, 0.0) for v in (best.get("p90") or p50)]

    n = min(len(p10), len(p50), len(p90))
    p10 = p10[:n]
    p50 = p50[:n]
    p90 = p90[:n]
    ci = [[p10[idx], p90[idx]] for idx in range(n)]

    payload = {
        "cached": False,
        "forecast": {
            "model": str(best.get("model") or "").upper(),
            "model_version": "regression-fixture",
            "predictions": p50,
            "confidence_interval": ci,
            "p10": p10,
            "p50": p50,
            "p90": p90,
            "risk_score": 50.0,
        },
        "metadata": {
            "inference_mode": "regression_fixture",
        },
        "_prediction_data": {
            "predictions": p50,
            "p10": p10,
            "p50": p50,
            "p90": p90,
            "confidence_interval": ci,
        },
    }
    contract_payload = finalize_forecast_response(
        payload,
        material_code=str(request.get("sku") or fixture.get("id") or ""),
        horizon=n,
    )
    parsed = ForecastResponse.model_validate(contract_payload)

    assert parsed.forecast_contract_version.startswith("1."), "forecast contract version must be 1.x"
    assert parsed.materialCode == str(request.get("sku") or fixture.get("id") or "")
    assert parsed.horizon == n
    assert len(parsed.points) == n

    return contract_payload


def assert_forecast_invariants(backtest_result: Dict[str, Any]) -> None:
    reliability = str(backtest_result.get("reliability") or "").strip().lower()
    assert reliability in {"trusted", "caution", "unreliable"}, f"unexpected reliability taxonomy: {reliability}"

    successful = _successful_results(backtest_result)
    assert successful, "at least one successful backtest result is required"

    accuracy_score = _to_float(backtest_result.get("accuracy_score"), float("nan"))
    assert math.isfinite(accuracy_score), "accuracy_score must be finite"
    assert 0.0 <= accuracy_score <= 100.0, f"accuracy_score out of range: {accuracy_score}"

    for row in successful:
        p10 = [_to_float(v, 0.0) for v in (row.get("p10") or [])]
        p50 = [_to_float(v, 0.0) for v in (row.get("p50") or [])]
        p90 = [_to_float(v, 0.0) for v in (row.get("p90") or [])]
        n = min(len(p10), len(p50), len(p90))
        assert n > 0, f"missing quantiles for model {row.get('model')}"

        for idx in range(n):
            assert p10[idx] <= p50[idx] <= p90[idx], (
                f"quantile monotonicity violation for model={row.get('model')} at idx={idx}: "
                f"p10={p10[idx]}, p50={p50[idx]}, p90={p90[idx]}"
            )

        metrics = row.get("calibration_metrics") or {}
        coverage = metrics.get("coverage_10_90")
        if coverage is not None:
            assert 0.0 <= float(coverage) <= 1.0, f"coverage out of range: {coverage}"

        for key in (
            "pinball_loss_p10",
            "pinball_loss_p50",
            "pinball_loss_p90",
            "pinball_loss_mean",
            "interval_width_10_90",
        ):
            value = metrics.get(key)
            if value is not None:
                assert float(value) >= -1e-9, f"{key} must be non-negative, got {value}"

        gate_result = row.get("gate_result") or {}
        assert isinstance(gate_result.get("passed"), bool), f"gate_result.passed missing for {row.get('model')}"


def assert_fixture_expectations(backtest_result: Dict[str, Any], fixture: Dict[str, Any]) -> None:
    exp = fixture.get("expectations") or {}
    successful = _successful_results(backtest_result)
    assert len(successful) >= int(exp.get("successful_models_min") or 1), (
        f"insufficient successful models: {len(successful)}"
    )

    best = min(successful, key=lambda row: _to_float(row.get("mape"), float("inf")))
    _assert_bounds(best.get("mape"), exp.get("best_model_mape") or {}, "best_model_mape")
    _assert_bounds(backtest_result.get("accuracy_score"), exp.get("accuracy_score") or {}, "accuracy_score")

    reliability_any = exp.get("reliability_any") or []
    if reliability_any:
        actual_rel = str(backtest_result.get("reliability") or "")
        assert actual_rel in set(reliability_any), f"reliability {actual_rel} not in expected {reliability_any}"

    metrics = best.get("calibration_metrics") or {}
    _assert_bounds(metrics.get("coverage_10_90"), exp.get("coverage_10_90") or {}, "coverage_10_90")
    _assert_bounds(metrics.get("pinball_loss_mean"), exp.get("pinball_loss_mean") or {}, "pinball_loss_mean")

    bias_bounds = exp.get("bias_abs") or {}
    if bias_bounds:
        abs_bias = abs(_to_float(metrics.get("bias"), 0.0))
        _assert_bounds(abs_bias, bias_bounds, "abs_bias")


def assert_runtime_budget(
    fixture: Dict[str, Any],
    *,
    elapsed_seconds: float,
) -> None:
    exp = fixture.get("expectations") or {}
    max_seconds = _to_float(exp.get("runtime_seconds_max"), 3.0)
    assert elapsed_seconds <= max_seconds, (
        f"forecast fixture runtime budget exceeded: {elapsed_seconds:.3f}s > {max_seconds:.3f}s"
    )


def canonicalize_for_determinism(backtest_result: Dict[str, Any]) -> Dict[str, Any]:
    normalized: Dict[str, Any] = {
        "sku": str(backtest_result.get("sku") or ""),
        "reliability": str(backtest_result.get("reliability") or ""),
        "accuracy_score": round(_to_float(backtest_result.get("accuracy_score"), 0.0), 6),
        "best_model": {
            "name": str((backtest_result.get("best_model") or {}).get("name") or ""),
            "mape": round(_to_float((backtest_result.get("best_model") or {}).get("mape"), 0.0), 6),
            "gate_passed": bool((backtest_result.get("best_model") or {}).get("gate_passed", False)),
        },
        "consensus": {
            "level": str((backtest_result.get("consensus") or {}).get("level") or ""),
            "mape_variance": round(_to_float((backtest_result.get("consensus") or {}).get("mape_variance"), 0.0), 6),
        },
        "results": [],
    }

    for row in sorted(_successful_results(backtest_result), key=lambda item: str(item.get("model") or "")):
        metrics = row.get("calibration_metrics") or {}
        normalized["results"].append(
            {
                "model": str(row.get("model") or ""),
                "mape": round(_to_float(row.get("mape"), 0.0), 6),
                "coverage_10_90": round(_to_float(metrics.get("coverage_10_90"), 0.0), 6),
                "pinball_loss_mean": round(_to_float(metrics.get("pinball_loss_mean"), 0.0), 6),
                "bias": round(_to_float(metrics.get("bias"), 0.0), 6),
                "p10": [round(_to_float(v, 0.0), 6) for v in (row.get("p10") or [])],
                "p50": [round(_to_float(v, 0.0), 6) for v in (row.get("p50") or [])],
                "p90": [round(_to_float(v, 0.0), 6) for v in (row.get("p90") or [])],
            }
        )

    return normalized
