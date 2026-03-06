"""Guardrail tests for API request/result normalization in ml.api.main."""

import os
import sys

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

try:
    import ml.api.main as main_module
    from ml.api.main import PlanningItemInput, app

    _APP_AVAILABLE = True
except Exception:
    _APP_AVAILABLE = False

pytestmark = pytest.mark.skipif(not _APP_AVAILABLE, reason="FastAPI app not importable")


@pytest.fixture
def client():
    return TestClient(app)


def test_planning_item_syncs_demand_to_demand_series():
    item = PlanningItemInput(
        sku="SKU-1",
        demand=[{"date": "2026-01-01", "p50": 10.0}],
    )
    assert len(item.demand) == 1
    assert len(item.demand_series) == 1
    assert item.demand_series[0].p50 == 10.0


def test_planning_item_syncs_demand_series_to_demand():
    item = PlanningItemInput(
        sku="SKU-2",
        demand_series=[{"date": "2026-01-02", "p50": 12.0}],
    )
    assert len(item.demand_series) == 1
    assert len(item.demand) == 1
    assert item.demand[0].p50 == 12.0


def test_demand_forecast_handles_empty_forecast_chain(client, monkeypatch):
    monkeypatch.setattr(main_module.forecaster_factory, "predict_with_prod_pointer", lambda *a, **k: None)
    monkeypatch.setattr(main_module.forecaster_factory, "predict_with_champion", lambda *a, **k: None)
    monkeypatch.setattr(main_module.forecaster_factory, "predict_with_fallback", lambda *a, **k: None)

    resp = client.post(
        "/demand-forecast",
        json={
            "materialCode": "SKU-GUARD-1",
            "horizonDays": 7,
            "history": [10, 11, 12, 13, 14, 15, 16],
            "includeComparison": False,
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "error" in body
    assert "returned no result" in body["error"].lower()


def test_sanitize_numpy_replaces_non_finite_numbers():
    payload = {
        "nan_value": float("nan"),
        "pos_inf": float("inf"),
        "neg_inf": float("-inf"),
        "numpy_nan": np.float64("nan"),
        "arr": np.array([1.0, np.nan, np.inf]),
        "nested": [{"x": np.float32("-inf")}],
    }

    cleaned = main_module.sanitize_numpy(payload)

    assert cleaned["nan_value"] is None
    assert cleaned["pos_inf"] is None
    assert cleaned["neg_inf"] is None
    assert cleaned["numpy_nan"] is None
    assert cleaned["arr"] == [1.0, None, None]
    assert cleaned["nested"][0]["x"] is None


def test_run_simulation_sanitizes_non_finite_values(client, monkeypatch):
    class _FakeResult:
        def to_dict(self):
            return {
                "scenario": "normal",
                "seed": 42,
                "duration_days": 2,
                "kpis": {
                    "fill_rate_pct": float("nan"),
                    "total_cost": 1234.0,
                    "avg_inventory": 50.0,
                    "inventory_turns": 1.0,
                    "stockout_days": 0,
                },
            }

    class _FakeOrchestrator:
        def __init__(self, *args, **kwargs):
            pass

        def run(self):
            return _FakeResult()

        def get_daily_log_df(self):
            return pd.DataFrame([{"day": 0, "date": "2026-01-01", "forecast": float("nan")}])

    monkeypatch.setattr(main_module, "SimulationOrchestrator", _FakeOrchestrator)

    resp = client.post("/run-simulation", json={"scenario": "normal", "seed": 42})

    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    assert body["kpis"]["fill_rate_pct"] is None
    assert body["timeline_sample"][0]["forecast"] is None


def _assert_no_non_finite_numbers(value):
    if isinstance(value, float):
        assert np.isfinite(value), f"Found non-finite float in API response: {value}"
        return
    if isinstance(value, dict):
        for child in value.values():
            _assert_no_non_finite_numbers(child)
        return
    if isinstance(value, list):
        for child in value:
            _assert_no_non_finite_numbers(child)


def test_run_simulation_real_response_is_json_safe(client):
    resp = client.post(
        "/run-simulation",
        json={
            "scenario": "normal",
            "seed": 42,
            "duration_days": 14,
            "use_forecaster": False,
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    if body.get("timeline_sample"):
        assert body["timeline_sample"][0]["forecast"] is None
    _assert_no_non_finite_numbers(body)
