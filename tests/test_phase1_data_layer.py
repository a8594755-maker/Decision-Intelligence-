"""
Phase 1 – Data Layer & Contract Hardening Tests
================================================
Tests for: P1.1 (dataset_schema), P1.2 (field_mapper), P1.3/P1.5 (API integration).
"""
import pytest
from typing import Dict, List


# ──────────────────────────────────────────────────────────────────────────────
# P1.1 – Dataset Schema Validator
# ──────────────────────────────────────────────────────────────────────────────


class TestDemandForecastPayload:
    """Validate /demand-forecast inbound payload schema."""

    def test_valid_minimal_payload(self):
        from ml.demand_forecasting.dataset_schema import validate_forecast_payload
        errors = validate_forecast_payload({"materialCode": "SKU-001", "horizonDays": 30})
        assert errors == []

    def test_valid_with_history(self):
        from ml.demand_forecasting.dataset_schema import validate_forecast_payload
        errors = validate_forecast_payload({
            "materialCode": "SKU-001",
            "horizonDays": 14,
            "history": [10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0],
        })
        assert errors == []

    def test_missing_material_code(self):
        from ml.demand_forecasting.dataset_schema import validate_forecast_payload
        errors = validate_forecast_payload({"horizonDays": 30})
        assert len(errors) > 0
        assert any("materialCode" in e.get("field", "") for e in errors)

    def test_empty_material_code(self):
        from ml.demand_forecasting.dataset_schema import validate_forecast_payload
        errors = validate_forecast_payload({"materialCode": "", "horizonDays": 30})
        assert len(errors) > 0

    def test_invalid_horizon(self):
        from ml.demand_forecasting.dataset_schema import validate_forecast_payload
        errors = validate_forecast_payload({"materialCode": "SKU-001", "horizonDays": 0})
        assert len(errors) > 0

    def test_history_too_short(self):
        from ml.demand_forecasting.dataset_schema import validate_forecast_payload
        errors = validate_forecast_payload({
            "materialCode": "SKU-001",
            "history": [1.0, 2.0, 3.0],  # need >= 7
        })
        assert len(errors) > 0

    def test_history_with_nan(self):
        import math
        from ml.demand_forecasting.dataset_schema import validate_forecast_payload
        errors = validate_forecast_payload({
            "materialCode": "SKU-001",
            "history": [1.0, 2.0, math.nan, 4.0, 5.0, 6.0, 7.0],
        })
        assert len(errors) > 0

    def test_invalid_model_type(self):
        from ml.demand_forecasting.dataset_schema import validate_forecast_payload
        errors = validate_forecast_payload({
            "materialCode": "SKU-001",
            "modelType": "nonexistent",
        })
        assert len(errors) > 0

    def test_valid_model_types(self):
        from ml.demand_forecasting.dataset_schema import validate_forecast_payload
        for mt in ["prophet", "lightgbm", "chronos", "xgboost", "ets", "auto"]:
            errors = validate_forecast_payload({
                "materialCode": "SKU-001",
                "modelType": mt,
            })
            assert errors == [], f"Model type {mt} should be valid"


class TestTrainModelPayload:
    """Validate /train-model inbound payload schema."""

    def test_valid_minimal(self):
        from ml.demand_forecasting.dataset_schema import validate_train_payload
        errors = validate_train_payload({"modelType": "lightgbm"})
        assert errors == []

    def test_valid_with_history(self):
        from ml.demand_forecasting.dataset_schema import validate_train_payload
        errors = validate_train_payload({
            "modelType": "lightgbm",
            "history": list(range(60)),
        })
        assert errors == []

    def test_history_too_short(self):
        from ml.demand_forecasting.dataset_schema import validate_train_payload
        errors = validate_train_payload({
            "modelType": "lightgbm",
            "history": list(range(10)),  # need >= 30
        })
        assert len(errors) > 0

    def test_invalid_model_type(self):
        from ml.demand_forecasting.dataset_schema import validate_train_payload
        errors = validate_train_payload({"modelType": "invalid"})
        assert len(errors) > 0

    def test_invalid_date_format(self):
        from ml.demand_forecasting.dataset_schema import validate_train_payload
        errors = validate_train_payload({
            "modelType": "lightgbm",
            "historyStartDate": "03/01/2024",
        })
        assert len(errors) > 0

    def test_valid_date_format(self):
        from ml.demand_forecasting.dataset_schema import validate_train_payload
        errors = validate_train_payload({
            "modelType": "lightgbm",
            "historyStartDate": "2024-03-01",
        })
        assert errors == []


class TestDemandPointPayload:
    """Validate demand point schema with quantile ordering."""

    def test_valid_point(self):
        from ml.demand_forecasting.dataset_schema import validate_demand_points
        errors = validate_demand_points([{
            "sku": "A", "date": "2024-01-01", "p50": 100, "p10": 80, "p90": 120,
        }])
        assert errors == []

    def test_quantile_order_violation(self):
        from ml.demand_forecasting.dataset_schema import validate_demand_points
        errors = validate_demand_points([{
            "sku": "A", "date": "2024-01-01", "p50": 100, "p10": 150, "p90": 120,
        }])
        assert len(errors) > 0

    def test_p90_less_than_p50(self):
        from ml.demand_forecasting.dataset_schema import validate_demand_points
        errors = validate_demand_points([{
            "sku": "A", "date": "2024-01-01", "p50": 100, "p90": 50,
        }])
        assert len(errors) > 0

    def test_multiple_points(self):
        from ml.demand_forecasting.dataset_schema import validate_demand_points
        errors = validate_demand_points([
            {"sku": "A", "date": "2024-01-01", "p50": 100},
            {"sku": "", "date": "2024-01-02", "p50": 50},  # invalid: empty sku
        ])
        assert len(errors) > 0
        assert any(e.get("index") == 1 for e in errors)


# ──────────────────────────────────────────────────────────────────────────────
# P1.2 – Field Mapper
# ──────────────────────────────────────────────────────────────────────────────


class TestFieldMapper:
    """Server-side ERP field name → canonical name mapping."""

    def test_map_known_synonym(self):
        from ml.demand_forecasting.field_mapper import map_header
        assert map_header("quantity") == "qty"
        assert map_header("order_qty") == "qty"
        assert map_header("sales") == "qty"

    def test_map_date_synonyms(self):
        from ml.demand_forecasting.field_mapper import map_header
        assert map_header("order_date") == "date"
        assert map_header("timestamp") == "date"

    def test_map_unknown_returns_none(self):
        from ml.demand_forecasting.field_mapper import map_header
        assert map_header("weird_column") is None

    def test_map_headers_batch(self):
        from ml.demand_forecasting.field_mapper import map_headers_batch
        result = map_headers_batch(["order_date", "qty", "sku", "unknown"])
        assert result == {
            "order_date": "date",
            "qty": "qty",
            "sku": "material_code",
            "unknown": None,
        }

    def test_normalize_dataframe_columns(self):
        import pandas as pd
        from ml.demand_forecasting.field_mapper import normalize_dataframe_columns
        df = pd.DataFrame({"Order Date": [1], "Quantity": [10], "SKU": ["A"]})
        df_out, report = normalize_dataframe_columns(df)
        assert "date" in list(df_out.columns)
        assert "qty" in list(df_out.columns)
        assert "material_code" in list(df_out.columns)
        assert len(report["unmapped"]) == 0

    def test_sku_synonyms(self):
        from ml.demand_forecasting.field_mapper import map_header
        assert map_header("sku") == "material_code"
        assert map_header("product_id") == "material_code"
        assert map_header("item_code") == "material_code"

    def test_case_insensitive(self):
        from ml.demand_forecasting.field_mapper import map_header
        assert map_header("QTY") == "qty"
        assert map_header("ORDER_DATE") == "date"
        assert map_header("Unit Price") == "unit_cost"


# ──────────────────────────────────────────────────────────────────────────────
# P1.4 – Dataset Fingerprint Enrichment (verification)
# ──────────────────────────────────────────────────────────────────────────────


class TestDatasetFingerprint:
    """Verify fingerprint includes feature version + columns hash."""

    def test_fingerprint_includes_columns_hash(self):
        from ml.demand_forecasting.feature_engineer import COLUMNS_HASH, FEATURE_VERSION
        assert COLUMNS_HASH is not None
        assert len(COLUMNS_HASH) == 12
        assert FEATURE_VERSION == "fe_v3"

    def test_compute_fingerprint_deterministic(self):
        from ml.demand_forecasting.dataset_builder import _compute_fingerprint, FeatureSpec
        from ml.demand_forecasting.data_contract import SalesSeries

        series = SalesSeries(
            sku="TEST-SKU",
            dates=[f"2024-01-{d:02d}" for d in range(1, 31)],
            values=[float(i) for i in range(30)],
        )
        spec = FeatureSpec(
            feature_version="fe_v3",
            columns_hash="abc123def456",
            feature_columns=("a", "b", "c"),
            num_features=3,
        )
        fp1 = _compute_fingerprint(series, spec, n_folds=1, val_days=7)
        fp2 = _compute_fingerprint(series, spec, n_folds=1, val_days=7)
        assert fp1 == fp2
        assert len(fp1) == 16

    def test_fingerprint_changes_with_columns_hash(self):
        from ml.demand_forecasting.dataset_builder import _compute_fingerprint, FeatureSpec
        from ml.demand_forecasting.data_contract import SalesSeries

        series = SalesSeries(
            sku="TEST-SKU",
            dates=[f"2024-01-{d:02d}" for d in range(1, 31)],
            values=[float(i) for i in range(30)],
        )
        spec_a = FeatureSpec("fe_v3", "hash_aaa", ("a",), 1)
        spec_b = FeatureSpec("fe_v3", "hash_bbb", ("b",), 1)
        fp_a = _compute_fingerprint(series, spec_a, 1, 7)
        fp_b = _compute_fingerprint(series, spec_b, 1, 7)
        assert fp_a != fp_b
