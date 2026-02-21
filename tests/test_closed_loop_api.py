"""
Tests for Closed-Loop Forecast → Planning API endpoints (PR-D).

Test cases:
  T-CL-API1 – POST /closed-loop/evaluate with stable forecast → NO_TRIGGER
  T-CL-API2 – POST /closed-loop/evaluate with low coverage → TRIGGERED_DRY_RUN + correct param_patch
  T-CL-API3 – POST /closed-loop/evaluate with uncertainty widened → trigger fires
  T-CL-API4 – POST /closed-loop/evaluate with high risk → trigger fires
  T-CL-API5 – POST /closed-loop/run with dry_run mode → TRIGGERED_DRY_RUN
  T-CL-API6 – POST /closed-loop/evaluate with no forecast → NO_TRIGGER
  T-CL-API7 – Param derivation alpha selection: calibrated vs uncalibrated
"""
import pytest
from fastapi.testclient import TestClient

# Attempt to import the app; skip if dependencies are missing
try:
    from ml.api.main import app
    _APP_AVAILABLE = True
except Exception:
    _APP_AVAILABLE = False

pytestmark = pytest.mark.skipif(not _APP_AVAILABLE, reason="FastAPI app not importable")

STABLE_SERIES = [
    {"sku": "SKU-A", "plant_id": "P1", "date": "2026-01-01", "p10": 5, "p50": 10, "p90": 15},
    {"sku": "SKU-A", "plant_id": "P1", "date": "2026-01-02", "p10": 6, "p50": 12, "p90": 18},
]

WIDENED_SERIES = [
    {"sku": "SKU-A", "plant_id": "P1", "date": "2026-01-01", "p10": 2, "p50": 10, "p90": 24},
    {"sku": "SKU-A", "plant_id": "P1", "date": "2026-01-02", "p10": 3, "p50": 12, "p90": 27},
]

GOOD_CALIBRATION = {"calibration_passed": True, "coverage_10_90": 0.85}
LOW_CALIBRATION = {"calibration_passed": False, "coverage_10_90": 0.55}

HIGH_RISK = [
    {"entity_type": "supplier_material", "material_code": "SKU-A", "plant_id": "P1",
     "risk_score": 80, "metrics": {"p90_delay_days": 8}},
]


@pytest.fixture
def client():
    return TestClient(app)


class TestClosedLoopEvaluate:
    def test_stable_forecast_no_trigger(self, client):
        resp = client.post("/closed-loop/evaluate", json={
            "dataset_id": 1,
            "forecast_run_id": 100,
            "forecast_series": STABLE_SERIES,
            "calibration_meta": GOOD_CALIBRATION,
            "previous_forecast_series": STABLE_SERIES,
        })
        assert resp.status_code == 200
        body = resp.json()
        assert body["closed_loop_status"] == "NO_TRIGGER"
        assert body["trigger_decision"]["should_trigger"] is False
        assert body["param_patch"] is None

    def test_low_coverage_triggers(self, client):
        resp = client.post("/closed-loop/evaluate", json={
            "dataset_id": 1,
            "forecast_run_id": 100,
            "forecast_series": STABLE_SERIES,
            "calibration_meta": LOW_CALIBRATION,
        })
        assert resp.status_code == 200
        body = resp.json()
        assert body["closed_loop_status"] == "TRIGGERED_DRY_RUN"
        assert body["trigger_decision"]["should_trigger"] is True
        reasons = body["trigger_decision"]["reasons"]
        assert any(r["trigger_type"] == "coverage_outside_band" for r in reasons)
        # Param patch should use uncalibrated alpha
        assert body["param_patch"]["patch"]["safety_stock_alpha"] == 0.8

    def test_uncertainty_widens_triggers(self, client):
        resp = client.post("/closed-loop/evaluate", json={
            "dataset_id": 1,
            "forecast_run_id": 100,
            "forecast_series": WIDENED_SERIES,
            "calibration_meta": GOOD_CALIBRATION,
            "previous_forecast_series": STABLE_SERIES,
        })
        assert resp.status_code == 200
        body = resp.json()
        assert body["closed_loop_status"] == "TRIGGERED_DRY_RUN"
        reasons = body["trigger_decision"]["reasons"]
        assert any(r["trigger_type"] == "uncertainty_widens" for r in reasons)

    def test_high_risk_triggers(self, client):
        resp = client.post("/closed-loop/evaluate", json={
            "dataset_id": 1,
            "forecast_run_id": 100,
            "forecast_series": STABLE_SERIES,
            "calibration_meta": GOOD_CALIBRATION,
            "risk_scores": HIGH_RISK,
        })
        assert resp.status_code == 200
        body = resp.json()
        assert body["closed_loop_status"] == "TRIGGERED_DRY_RUN"
        reasons = body["trigger_decision"]["reasons"]
        assert any(r["trigger_type"] == "risk_severity_crossed" for r in reasons)
        # Should have lead time buffer in patch
        assert "SKU-A|P1" in body["param_patch"]["patch"]["lead_time_buffer_by_key"]

    def test_no_series_no_trigger(self, client):
        resp = client.post("/closed-loop/evaluate", json={
            "dataset_id": 1,
            "forecast_run_id": 100,
        })
        assert resp.status_code == 200
        body = resp.json()
        assert body["closed_loop_status"] == "NO_TRIGGER"

    def test_alpha_calibrated_vs_uncalibrated(self, client):
        # Calibrated
        resp1 = client.post("/closed-loop/evaluate", json={
            "dataset_id": 1,
            "forecast_run_id": 100,
            "forecast_series": STABLE_SERIES,
            "calibration_meta": LOW_CALIBRATION,
        })
        body1 = resp1.json()
        assert body1["param_patch"]["derived_values"]["effective_alpha"] == 0.8

        # Widened triggers use wide_uncertainty alpha when coverage > upper
        resp2 = client.post("/closed-loop/evaluate", json={
            "dataset_id": 1,
            "forecast_run_id": 100,
            "forecast_series": STABLE_SERIES,
            "calibration_meta": {"calibration_passed": True, "coverage_10_90": 0.97},
        })
        body2 = resp2.json()
        assert body2["param_patch"]["derived_values"]["effective_alpha"] == 1.0


class TestClosedLoopRun:
    def test_dry_run_with_trigger(self, client):
        resp = client.post("/closed-loop/run", json={
            "user_id": "u1",
            "dataset_profile_id": 1,
            "forecast_run_id": 100,
            "forecast_series": STABLE_SERIES,
            "calibration_meta": LOW_CALIBRATION,
            "mode": "dry_run",
        })
        assert resp.status_code == 200
        body = resp.json()
        assert body["closed_loop_status"] == "TRIGGERED_DRY_RUN"
        assert body["planning_run_id"] is None
        assert body["mode"] == "dry_run"

    def test_no_trigger_returns_no_trigger(self, client):
        resp = client.post("/closed-loop/run", json={
            "user_id": "u1",
            "dataset_profile_id": 1,
            "forecast_run_id": 100,
            "forecast_series": STABLE_SERIES,
            "calibration_meta": GOOD_CALIBRATION,
            "previous_forecast_series": STABLE_SERIES,
        })
        assert resp.status_code == 200
        body = resp.json()
        assert body["closed_loop_status"] == "NO_TRIGGER"
