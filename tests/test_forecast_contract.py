"""Forecast contract v1.0 validation tests."""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

import pytest
from ml.api.forecast_contract import (
    FORECAST_API_CONTRACT_VERSION,
    ForecastPoint,
    ForecastResponse,
    ForecastSeriesMeta,
    BacktestMetrics,
    BacktestDiagnostics,
    BacktestResponse,
    BacktestResultRow,
    finalize_forecast_response,
    finalize_backtest_response,
)


# ---------------------------------------------------------------------------
# ForecastPoint
# ---------------------------------------------------------------------------

class TestForecastPoint:
    def test_p10_p50_p90_ordering(self):
        pt = ForecastPoint(date="2026-01-01", p10=5.0, p50=10.0, p90=15.0)
        assert pt.p10 <= pt.p50 <= pt.p90

    def test_aliases_populated_from_canonical(self):
        pt = ForecastPoint(date="2026-01-01", p10=5.0, p50=10.0, p90=15.0)
        assert pt.forecast == pt.p50
        assert pt.lower == pt.p10
        assert pt.upper == pt.p90

    def test_p50_only_minimal(self):
        pt = ForecastPoint(date="2026-01-01", p50=10.0)
        assert pt.p50 == 10.0
        assert pt.forecast == 10.0
        assert pt.p10 is None
        assert pt.p90 is None
        assert pt.lower is None
        assert pt.upper is None

    def test_extra_fields_allowed(self):
        pt = ForecastPoint(date="2026-01-01", p50=10.0, custom_flag=True)
        assert pt.custom_flag is True

    def test_aliases_not_overwritten_if_explicit(self):
        pt = ForecastPoint(
            date="2026-01-01", p50=10.0, p10=5.0, p90=15.0,
            forecast=99.0, lower=1.0, upper=99.0,
        )
        # Explicit values preserved (model_validator only fills None)
        assert pt.forecast == 99.0
        assert pt.lower == 1.0
        assert pt.upper == 99.0


# ---------------------------------------------------------------------------
# ForecastResponse
# ---------------------------------------------------------------------------

class TestForecastResponse:
    def test_version_field_present(self):
        resp = ForecastResponse(
            materialCode="SKU-A",
            horizon=7,
            series_meta=ForecastSeriesMeta(model="lightgbm"),
        )
        assert resp.forecast_contract_version == "1.0"

    def test_bad_version_raises(self):
        with pytest.raises(ValueError, match="Unsupported"):
            ForecastResponse(
                forecast_contract_version="2.0",
                materialCode="X",
                horizon=7,
            )

    def test_points_always_list(self):
        resp = ForecastResponse(materialCode="X", horizon=7)
        assert isinstance(resp.points, list)
        assert len(resp.points) == 0

    def test_legacy_fields_have_defaults(self):
        resp = ForecastResponse(materialCode="X", horizon=7)
        assert resp.forecast == {}
        assert resp.metadata == {}
        assert resp.cached is False
        assert resp.comparison is None
        assert resp.consensus_warning is None


# ---------------------------------------------------------------------------
# BacktestResponse
# ---------------------------------------------------------------------------

class TestBacktestResponse:
    def test_version_present(self):
        resp = BacktestResponse(sku="X")
        assert resp.forecast_contract_version == FORECAST_API_CONTRACT_VERSION

    def test_calibration_scope_default(self):
        resp = BacktestResponse(sku="X")
        assert resp.calibration_scope == "none"

    def test_metrics_structured(self):
        resp = BacktestResponse(
            sku="X",
            metrics=BacktestMetrics(mape=12.5, bias=-1.2),
        )
        assert resp.metrics.mape == 12.5
        assert resp.metrics.bias == -1.2
        assert resp.metrics.coverage_10_90 is None

    def test_diagnostics_structured(self):
        resp = BacktestResponse(
            sku="X",
            diagnostics=BacktestDiagnostics(train_points=60, test_days=7, consensus_level="high"),
        )
        assert resp.diagnostics.train_points == 60
        assert resp.diagnostics.test_days == 7


# ---------------------------------------------------------------------------
# finalize_forecast_response
# ---------------------------------------------------------------------------

class TestFinalizeForecastResponse:
    def test_legacy_predictions_converted_to_points(self):
        raw = {
            "forecast": {
                "model": "LIGHTGBM",
                "median": 50.0,
                "predictions": [48.0, 50.0, 52.0],
                "confidence_interval": [[40.0, 56.0], [42.0, 58.0], [44.0, 60.0]],
                "risk_score": 25.0,
                "model_version": "v2",
            },
            "cached": False,
            "metadata": {},
        }
        result = finalize_forecast_response(raw, material_code="SKU-A", horizon=3)

        assert result["forecast_contract_version"] == "1.0"
        assert result["materialCode"] == "SKU-A"
        assert result["horizon"] == 3
        assert len(result["points"]) == 3

        for pt in result["points"]:
            assert "p10" in pt
            assert "p50" in pt
            assert "p90" in pt
            if pt["p10"] is not None and pt["p90"] is not None:
                assert pt["p10"] <= pt["p50"] <= pt["p90"]

    def test_legacy_fields_preserved(self):
        raw = {
            "materialCode": "X",
            "forecast": {"model": "PROPHET", "median": 50.0, "predictions": [50.0]},
            "cached": True,
            "metadata": {"foo": "bar"},
        }
        result = finalize_forecast_response(raw, material_code="X", horizon=1)
        assert result["cached"] is True
        assert result["forecast"]["model"] == "PROPHET"
        assert result["metadata"]["foo"] == "bar"

    def test_explicit_p10_p50_p90_used(self):
        raw = {
            "_prediction_data": {
                "predictions": [100.0, 110.0],
                "p10": [80.0, 85.0],
                "p50": [100.0, 110.0],
                "p90": [120.0, 135.0],
                "confidence_interval": [[70.0, 130.0], [75.0, 145.0]],
            },
            "forecast": {"model": "LIGHTGBM"},
        }
        result = finalize_forecast_response(raw, material_code="A", horizon=2)
        assert result["points"][0]["p10"] == 80.0
        assert result["points"][0]["p50"] == 100.0
        assert result["points"][0]["p90"] == 120.0
        assert result["points"][1]["p10"] == 85.0

    def test_inverted_quantiles_clamped(self):
        raw = {
            "_prediction_data": {
                "p10": [60.0],
                "p50": [50.0],  # p10 > p50 — should clamp p10
                "p90": [40.0],  # p90 < p50 — should clamp p90
            },
            "forecast": {},
        }
        result = finalize_forecast_response(raw, material_code="A", horizon=1)
        pt = result["points"][0]
        assert pt["p10"] <= pt["p50"]
        assert pt["p90"] >= pt["p50"]

    def test_series_meta_extracted(self):
        raw = {
            "forecast": {
                "model": "CHRONOS",
                "model_version": "chronos-t5",
                "risk_score": 42.0,
                "predictions": [10.0],
            },
            "metadata": {"inference_mode": "zero_shot"},
        }
        result = finalize_forecast_response(raw, material_code="A", horizon=1)
        assert result["series_meta"]["model"] == "CHRONOS"
        assert result["series_meta"]["model_version"] == "chronos-t5"
        assert result["series_meta"]["risk_score"] == 42.0
        assert result["series_meta"]["inference_mode"] == "zero_shot"

    def test_empty_payload_returns_valid_envelope(self):
        result = finalize_forecast_response({}, material_code="EMPTY", horizon=0)
        assert result["forecast_contract_version"] == "1.0"
        assert result["materialCode"] == "EMPTY"
        assert result["points"] == []

    def test_internal_prediction_data_key_removed(self):
        raw = {
            "_prediction_data": {"p50": [10.0], "predictions": [10.0]},
            "forecast": {},
        }
        result = finalize_forecast_response(raw, material_code="A", horizon=1)
        assert "_prediction_data" not in result


# ---------------------------------------------------------------------------
# finalize_backtest_response
# ---------------------------------------------------------------------------

class TestFinalizeBacktestResponse:
    def test_version_injected(self):
        raw = {
            "sku": "SKU-A",
            "test_days": 7,
            "train_points": 60,
            "results": [],
            "best_model": {"name": "lightgbm", "mape": 12.0, "grade": "A"},
            "consensus": {"level": "high", "mape_variance": 5.0, "models_tested": 3},
            "reliability": "trusted",
            "recommendation": "ok",
            "accuracy_score": 88,
        }
        result = finalize_backtest_response(raw)
        assert result["forecast_contract_version"] == "1.0"

    def test_metrics_structured_from_best_model(self):
        raw = {
            "sku": "X",
            "best_model": {"name": "lgb", "mape": 15.0},
            "results": [],
        }
        result = finalize_backtest_response(raw)
        assert result["metrics"]["mape"] == 15.0

    def test_diagnostics_structured_from_flat_fields(self):
        raw = {
            "sku": "X",
            "train_points": 80,
            "test_days": 7,
            "consensus": {"level": "medium", "mape_variance": 120.0},
            "results": [],
        }
        result = finalize_backtest_response(raw)
        assert result["diagnostics"]["train_points"] == 80
        assert result["diagnostics"]["test_days"] == 7
        assert result["diagnostics"]["consensus_level"] == "medium"

    def test_calibration_scope_defaults_to_none(self):
        result = finalize_backtest_response({"sku": "X", "results": []})
        assert result["calibration_scope"] == "none"

    def test_existing_fields_preserved(self):
        raw = {
            "sku": "X",
            "results": [{"model": "prophet", "success": True, "mape": 10.0}],
            "reliability": "trusted",
            "recommendation": "use it",
            "accuracy_score": 90,
        }
        result = finalize_backtest_response(raw)
        assert result["reliability"] == "trusted"
        assert result["recommendation"] == "use it"
        assert result["accuracy_score"] == 90
        assert len(result["results"]) == 1
