"""
PR-E Tests: Drift Monitoring
===============================
Deterministic tests with seeded synthetic data:
  - Known shifted distributions produce drift_flags
  - Stable distributions do not
  - PSI computation is stable
  - Residual drift detection works
  - DriftReportStore persistence
"""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import pytest
import numpy as np

from ml.monitoring.drift_monitor import (
    DriftConfig,
    DriftReport,
    DriftReportStore,
    compute_data_drift,
    compute_psi,
    compute_residual_drift,
    compute_zscore_shift,
    run_drift_analysis,
)


# ── Fixtures ──

@pytest.fixture
def rng():
    """Deterministic random generator."""
    return np.random.RandomState(42)


@pytest.fixture
def stable_baseline():
    """Normal distribution: mean=100, std=10."""
    return np.random.RandomState(10).normal(100, 10, 500).tolist()


@pytest.fixture
def stable_recent():
    """Same distribution as baseline (no drift), different seed."""
    return np.random.RandomState(20).normal(100, 10, 200).tolist()


@pytest.fixture
def shifted_recent():
    """Shifted distribution: mean=140, std=15 (clear drift)."""
    return np.random.RandomState(30).normal(140, 15, 200).tolist()


@pytest.fixture
def drift_store(tmp_path):
    return DriftReportStore(root=str(tmp_path / "drift"))


# ── PSI Tests ──

class TestPSI:
    def test_identical_distributions_low_psi(self):
        rng1 = np.random.RandomState(100)
        rng2 = np.random.RandomState(200)
        baseline = rng1.normal(100, 10, 1000)
        recent = rng2.normal(100, 10, 500)
        psi = compute_psi(baseline, recent)
        assert psi < 0.15  # no significant drift

    def test_shifted_distributions_high_psi(self, rng):
        baseline = rng.normal(100, 10, 500)
        recent = rng.normal(150, 10, 200)
        psi = compute_psi(baseline, recent)
        assert psi > 0.2  # significant drift

    def test_psi_is_non_negative(self, rng):
        baseline = rng.normal(100, 10, 100)
        recent = rng.normal(100, 10, 50)
        psi = compute_psi(baseline, recent)
        assert psi >= 0.0

    def test_psi_deterministic(self, rng):
        baseline = rng.normal(100, 10, 200)
        rng2 = np.random.RandomState(99)
        recent = rng2.normal(100, 10, 100)
        psi1 = compute_psi(baseline, recent)
        psi2 = compute_psi(baseline, recent)
        assert psi1 == psi2


class TestZscoreShift:
    def test_no_shift(self, rng):
        baseline = rng.normal(100, 10, 200)
        recent = rng.normal(100, 10, 50)
        z = compute_zscore_shift(baseline, recent)
        assert z < 2.0

    def test_large_shift(self, rng):
        baseline = rng.normal(100, 10, 200)
        recent = rng.normal(150, 10, 50)
        z = compute_zscore_shift(baseline, recent)
        assert z > 2.0

    def test_zero_std_baseline(self):
        baseline = np.array([100.0] * 50)
        recent = np.array([110.0] * 20)
        z = compute_zscore_shift(baseline, recent)
        assert z == 0.0


# ── Data Drift Tests ──

class TestDataDrift:
    def test_stable_no_flags(self, stable_baseline, stable_recent):
        result = compute_data_drift(stable_baseline, stable_recent)
        assert "data_drift_high" not in result["flags"]
        assert result["data_drift_score"] < 0.5

    def test_shifted_has_flags(self, stable_baseline, shifted_recent):
        result = compute_data_drift(stable_baseline, shifted_recent)
        assert "data_drift_high" in result["flags"] or "mean_shift_high" in result["flags"]
        assert result["data_drift_score"] > 0.3

    def test_short_sequences_no_crash(self):
        result = compute_data_drift([1.0], [2.0])
        assert result["data_drift_score"] == 0.0

    def test_custom_config(self, stable_baseline, stable_recent):
        strict_config = DriftConfig(psi_threshold=0.01, zscore_shift_threshold=0.1)
        result = compute_data_drift(stable_baseline, stable_recent, strict_config)
        # With very strict thresholds, even minor noise triggers flags
        assert result["data_drift_score"] > 0


# ── Residual Drift Tests ──

class TestResidualDrift:
    def test_no_residual_drift_stable_forecasts(self, rng):
        actuals = rng.normal(100, 10, 50).tolist()
        # Predictions close to actuals
        preds = [a + rng.normal(0, 2) for a in actuals]

        result = compute_residual_drift(
            actuals[:25], preds[:25],  # baseline
            actuals[25:], preds[25:],  # recent (same quality)
        )
        assert "residual_drift_high" not in result["flags"]

    def test_residual_drift_when_predictions_degrade(self, rng):
        actuals = rng.normal(100, 10, 50).tolist()
        good_preds = [a + rng.normal(0, 2) for a in actuals[:25]]
        bad_preds = [a + rng.normal(30, 10) for a in actuals[25:]]  # biased

        result = compute_residual_drift(
            actuals[:25], good_preds,
            actuals[25:], bad_preds,
        )
        assert "residual_drift_high" in result["flags"] or "bias_shift_high" in result["flags"]

    def test_coverage_drift_detected(self):
        rng = np.random.RandomState(55)
        actuals = rng.normal(100, 10, 50).tolist()
        preds = [a + rng.normal(0, 2) for a in actuals]

        # Good coverage baseline (wide intervals — all actuals inside)
        b_p10 = [a - 30 for a in actuals[:25]]
        b_p90 = [a + 30 for a in actuals[:25]]

        # Bad coverage recent (impossibly narrow — actuals outside)
        r_p10 = [a + 5 for a in actuals[25:]]   # p10 > actual
        r_p90 = [a + 6 for a in actuals[25:]]   # p90 > actual

        result = compute_residual_drift(
            actuals[:25], preds[:25],
            actuals[25:], preds[25:],
            baseline_p10=b_p10, baseline_p90=b_p90,
            recent_p10=r_p10, recent_p90=r_p90,
        )
        assert "coverage_bad" in result["flags"]

    def test_short_sequences_no_crash(self):
        result = compute_residual_drift([1.0], [1.0], [2.0], [2.0])
        assert result["residual_drift_score"] == 0.0


# ── Full Drift Analysis Tests ──

class TestRunDriftAnalysis:
    def test_full_analysis_stable(self, stable_baseline, stable_recent, rng):
        report = run_drift_analysis(
            series_id="SKU-001",
            baseline_values=stable_baseline,
            recent_values=stable_recent,
        )
        assert report.series_id == "SKU-001"
        assert report.report_id.startswith("drift_")
        assert "data_drift_high" not in report.drift_flags

    def test_full_analysis_with_residuals(self, rng):
        baseline_vals = rng.normal(100, 10, 60).tolist()
        recent_vals = rng.normal(130, 15, 20).tolist()
        b_act = rng.normal(100, 10, 30).tolist()
        b_pred = [a + rng.normal(0, 2) for a in b_act]
        r_act = rng.normal(130, 15, 10).tolist()
        r_pred = [a + rng.normal(20, 5) for a in r_act]  # degraded

        report = run_drift_analysis(
            series_id="SKU-002",
            baseline_values=baseline_vals,
            recent_values=recent_vals,
            baseline_actuals=b_act,
            baseline_predictions=b_pred,
            recent_actuals=r_act,
            recent_predictions=r_pred,
        )
        assert report.data_drift_score > 0
        assert report.residual_drift_score > 0
        assert report.drift_score > 0


# ── DriftReportStore Tests ──

class TestDriftReportStore:
    def test_save_and_load(self, drift_store, stable_baseline, stable_recent):
        report = run_drift_analysis(
            "SKU-001", stable_baseline, stable_recent
        )
        drift_store.save(report)

        loaded = drift_store.load(report.report_id)
        assert loaded is not None
        assert loaded.series_id == "SKU-001"
        assert loaded.report_id == report.report_id

    def test_list_reports(self, drift_store, stable_baseline, stable_recent):
        r1 = run_drift_analysis("SKU-001", stable_baseline, stable_recent)
        r2 = run_drift_analysis("SKU-002", stable_baseline, stable_recent)
        drift_store.save(r1)
        drift_store.save(r2)

        all_reports = drift_store.list_reports()
        assert len(all_reports) == 2

    def test_list_reports_filter_by_series(self, drift_store, stable_baseline, stable_recent):
        r1 = run_drift_analysis("SKU-001", stable_baseline, stable_recent)
        r2 = run_drift_analysis("SKU-002", stable_baseline, stable_recent)
        drift_store.save(r1)
        drift_store.save(r2)

        filtered = drift_store.list_reports(series_id="SKU-001")
        assert len(filtered) == 1
        assert filtered[0].series_id == "SKU-001"

    def test_get_latest(self, drift_store, stable_baseline, stable_recent):
        r1 = run_drift_analysis("SKU-001", stable_baseline, stable_recent)
        drift_store.save(r1)
        r2 = run_drift_analysis("SKU-001", stable_baseline, stable_recent)
        drift_store.save(r2)

        latest = drift_store.get_latest("SKU-001")
        assert latest is not None

    def test_load_nonexistent_returns_none(self, drift_store):
        assert drift_store.load("nonexistent_id") is None
