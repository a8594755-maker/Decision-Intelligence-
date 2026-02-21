"""
PR-C: Deterministic tests for Probabilistic Uncertainty & Calibration Quality Gates.

Tests:
  A: QuantileEngine produces monotonic p10/p50/p90 and non-negative bounds.
  B: Coverage computation correctness (known toy example).
  C: Quality gates decision is deterministic and matches thresholds.
  D: Calibration metrics computation (pinball, bias, interval width).
  E: Backtest with calibration produces calibration_report and quantile metrics.
  F: Inference quantile generation with and without calibration.
  G: QuantileEngine persistence (save/load round-trip).
"""
import sys
import os
import json
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

import pytest
import numpy as np

from ml.uncertainty.quantile_engine import QuantileEngine, QuantileEngineConfig
from ml.uncertainty.calibration_metrics import (
    compute_coverage,
    compute_pinball_loss,
    compute_bias,
    compute_interval_width,
    compute_calibration_metrics,
)
from ml.uncertainty.quality_gates import (
    QualityGateConfig,
    evaluate_candidate,
    select_best_candidate,
)


# ══════════════════════════════════════
# Test A: Quantile Engine Monotonicity & Bounds
# ══════════════════════════════════════

class TestQuantileEngineMonotonicity:
    """QuantileEngine must produce p10 <= p50 <= p90, non-negative."""

    def test_monotonic_with_global_residuals(self):
        np.random.seed(42)
        residuals = list(np.random.normal(0, 10, size=100))
        engine = QuantileEngine()
        engine.fit(residuals_global=residuals)

        point_forecasts = [100.0, 110.0, 90.0, 50.0, 200.0]
        result = engine.predict_quantiles(point_forecasts)

        for i in range(len(point_forecasts)):
            assert result.p10[i] <= result.p50[i], f"p10 > p50 at index {i}"
            assert result.p50[i] <= result.p90[i], f"p50 > p90 at index {i}"

    def test_monotonic_with_per_series_residuals(self):
        np.random.seed(42)
        engine = QuantileEngine()
        engine.fit(
            residuals_global=list(np.random.normal(0, 5, 50)),
            residuals_per_series={"SKU-A": list(np.random.normal(-2, 8, 20))},
        )

        result = engine.predict_quantiles([100, 50, 200], series_id="SKU-A")
        for i in range(3):
            assert result.p10[i] <= result.p50[i]
            assert result.p50[i] <= result.p90[i]

    def test_non_negative_bounds(self):
        # Large negative residuals should still produce non-negative forecasts
        residuals = [-50.0] * 30  # All residuals very negative
        engine = QuantileEngine()
        engine.fit(residuals_global=residuals)

        result = engine.predict_quantiles([10.0, 5.0, 1.0])
        for i in range(3):
            assert result.p10[i] >= 0, f"p10[{i}] = {result.p10[i]} < 0"
            assert result.p50[i] >= 0, f"p50[{i}] = {result.p50[i]} < 0"
            assert result.p90[i] >= 0, f"p90[{i}] = {result.p90[i]} < 0"

    def test_unfitted_engine_returns_heuristic(self):
        engine = QuantileEngine()
        result = engine.predict_quantiles([100.0, 200.0, 300.0])

        assert result.uncertainty_method == "heuristic_fallback"
        assert result.calibration_scope == "none"
        for i in range(3):
            assert result.p10[i] <= result.p50[i] <= result.p90[i]

    def test_monotonicity_fixes_counted(self):
        # Craft residuals where q10 > 0 (unusual, would violate monotonicity
        # only if q10_offset > 0, which happens with biased residuals)
        residuals = [5.0, 10.0, 15.0, 20.0] * 5  # All positive
        engine = QuantileEngine()
        engine.fit(residuals_global=residuals)

        result = engine.predict_quantiles([100.0])
        # With all positive residuals, q10 offset > 0, q90 offset > 0
        # p10 = 100 + q10(residuals) > 100 = p50 → monotonicity fix needed
        # Actually p50 = point_forecast, and q10_offset and q90_offset are both positive
        # so p10 > p50 is possible only if q10_offset > 0 (which it is here)
        # The engine should fix this.
        assert result.p10[0] <= result.p50[0]
        assert result.p50[0] <= result.p90[0]

    def test_deterministic_output(self):
        """Same input must produce same output every time."""
        np.random.seed(42)
        residuals = list(np.random.normal(0, 10, size=50))
        point_forecasts = [100.0, 150.0, 200.0]

        results = []
        for _ in range(10):
            engine = QuantileEngine()
            engine.fit(residuals_global=residuals)
            r = engine.predict_quantiles(point_forecasts)
            results.append((r.p10, r.p50, r.p90))

        for i in range(1, 10):
            assert results[i] == results[0], f"Run {i} differs from run 0"


# ══════════════════════════════════════
# Test B: Coverage Computation
# ══════════════════════════════════════

class TestCoverageComputation:
    def test_perfect_coverage(self):
        actuals = [10.0, 20.0, 30.0, 40.0, 50.0]
        p10 = [5.0, 15.0, 25.0, 35.0, 45.0]
        p90 = [15.0, 25.0, 35.0, 45.0, 55.0]
        assert compute_coverage(actuals, p10, p90) == 1.0

    def test_zero_coverage(self):
        actuals = [100.0, 200.0, 300.0]
        p10 = [0.0, 0.0, 0.0]
        p90 = [10.0, 10.0, 10.0]
        assert compute_coverage(actuals, p10, p90) == 0.0

    def test_partial_coverage(self):
        actuals = [10.0, 100.0, 30.0, 200.0]
        p10 = [5.0, 5.0, 25.0, 5.0]
        p90 = [15.0, 15.0, 35.0, 15.0]
        # Covered: index 0, 2. Not covered: index 1, 3.
        assert compute_coverage(actuals, p10, p90) == pytest.approx(0.5)

    def test_edge_coverage(self):
        """Actuals exactly on the boundary should be counted as covered."""
        actuals = [10.0, 20.0]
        p10 = [10.0, 15.0]
        p90 = [15.0, 20.0]
        assert compute_coverage(actuals, p10, p90) == 1.0

    def test_empty_inputs(self):
        assert compute_coverage([], [], []) == 0.0


# ══════════════════════════════════════
# Test C: Quality Gates Deterministic
# ══════════════════════════════════════

class TestQualityGates:
    def test_passing_candidate(self):
        metrics = {
            "coverage_10_90": 0.82,
            "pinball_loss_mean": 5.0,
            "bias": 2.0,
            "interval_width_10_90": 20.0,
        }
        result = evaluate_candidate(metrics, actuals_mean=100.0)
        assert result.passed is True
        assert result.degraded is False

    def test_low_coverage_fails(self):
        metrics = {
            "coverage_10_90": 0.50,
            "pinball_loss_mean": 5.0,
            "bias": 2.0,
        }
        result = evaluate_candidate(metrics)
        assert result.passed is False
        assert any("coverage" in r for r in result.reasons)

    def test_high_bias_fails(self):
        config = QualityGateConfig(bias_abs_max=10.0)
        metrics = {
            "coverage_10_90": 0.80,
            "pinball_loss_mean": 5.0,
            "bias": 25.0,
        }
        result = evaluate_candidate(metrics, config=config)
        assert result.passed is False
        assert any("bias" in r for r in result.reasons)

    def test_high_pinball_fails(self):
        config = QualityGateConfig(pinball_loss_max=10.0)
        metrics = {
            "coverage_10_90": 0.80,
            "pinball_loss_mean": 50.0,
            "bias": 2.0,
        }
        result = evaluate_candidate(metrics, config=config)
        assert result.passed is False
        assert any("pinball" in r for r in result.reasons)

    def test_missing_metrics_does_not_crash(self):
        metrics = {}
        result = evaluate_candidate(metrics)
        assert isinstance(result.passed, bool)
        assert isinstance(result.reasons, list)

    def test_deterministic_decision(self):
        """Same metrics must produce same gate result every time."""
        metrics = {
            "coverage_10_90": 0.75,
            "pinball_loss_mean": 8.0,
            "bias": 3.0,
        }
        results = [evaluate_candidate(metrics) for _ in range(10)]
        for r in results:
            assert r.passed == results[0].passed
            assert r.reasons == results[0].reasons

    def test_custom_config(self):
        config = QualityGateConfig(
            coverage_min=0.60,
            coverage_max=0.95,
            bias_abs_max=100.0,
            pinball_loss_max=200.0,
        )
        metrics = {
            "coverage_10_90": 0.65,
            "pinball_loss_mean": 150.0,
            "bias": 80.0,
        }
        result = evaluate_candidate(metrics, config=config)
        assert result.passed is True


# ══════════════════════════════════════
# Test D: Calibration Metrics
# ══════════════════════════════════════

class TestCalibrationMetrics:
    def test_pinball_loss_p50_equals_half_mae(self):
        """For tau=0.5, pinball loss = 0.5 * MAE."""
        actuals = [100.0, 200.0, 300.0]
        preds = [110.0, 190.0, 310.0]
        pl50 = compute_pinball_loss(actuals, preds, 0.50)
        mae = np.mean(np.abs(np.array(actuals) - np.array(preds)))
        assert pl50 == pytest.approx(mae * 0.5, abs=0.01)

    def test_pinball_loss_asymmetry(self):
        """Pinball loss penalizes more when actual > pred for high tau."""
        actuals = [100.0]
        pred_low = [80.0]  # Under-predict
        pred_high = [120.0]  # Over-predict

        pl90_low = compute_pinball_loss(actuals, pred_low, 0.90)
        pl90_high = compute_pinball_loss(actuals, pred_high, 0.90)
        # For tau=0.9, under-predicting (actual > pred) has higher penalty
        assert pl90_low > pl90_high

    def test_bias_positive_means_overestimate(self):
        actuals = [100.0, 100.0, 100.0]
        p50 = [120.0, 130.0, 110.0]
        bias = compute_bias(actuals, p50)
        assert bias > 0  # Overestimate

    def test_bias_negative_means_underestimate(self):
        actuals = [100.0, 100.0, 100.0]
        p50 = [80.0, 90.0, 70.0]
        bias = compute_bias(actuals, p50)
        assert bias < 0  # Underestimate

    def test_interval_width(self):
        p10 = [10.0, 20.0, 30.0]
        p90 = [20.0, 40.0, 50.0]
        width = compute_interval_width(p10, p90)
        # Widths: 10, 20, 20 → mean = 16.67
        assert width == pytest.approx(50.0 / 3.0, abs=0.01)

    def test_compute_all_metrics(self):
        actuals = [100.0, 200.0, 150.0]
        p10 = [80.0, 180.0, 130.0]
        p50 = [100.0, 200.0, 150.0]
        p90 = [120.0, 220.0, 170.0]

        metrics = compute_calibration_metrics(actuals, p10, p50, p90)
        assert metrics["coverage_10_90"] == 1.0
        assert metrics["bias"] == pytest.approx(0.0, abs=0.01)
        assert metrics["pinball_loss_p50"] == pytest.approx(0.0, abs=0.01)
        assert metrics["interval_width_10_90"] == pytest.approx(40.0, abs=0.01)

    def test_empty_inputs_return_none(self):
        metrics = compute_calibration_metrics([], [], [], [])
        assert metrics["coverage_10_90"] is None
        assert metrics["bias"] is None


# ══════════════════════════════════════
# Test E: Backtest with Calibration (Integration)
# ══════════════════════════════════════

class TestBacktestWithCalibration:
    @pytest.fixture
    def factory(self):
        from ml.demand_forecasting.forecaster_factory import ForecasterFactory
        return ForecasterFactory()

    def test_backtest_includes_calibration_report(self, factory):
        np.random.seed(42)
        history = [50 + 5 * np.sin(2 * np.pi * i / 7) + np.random.normal(0, 3)
                   for i in range(90)]
        result = factory.backtest_with_calibration(
            sku="BT-CAL-TEST",
            full_history=history,
            test_days=7,
            models=["lightgbm"],
        )
        assert "calibration_report" in result
        assert "residual_pool" in result["calibration_report"]
        assert result["global_residuals_count"] > 0

    def test_backtest_model_results_have_quantile_metrics(self, factory):
        np.random.seed(42)
        history = [50 + np.random.normal(0, 5) for _ in range(60)]
        result = factory.backtest_with_calibration(
            sku="BT-QUANTILE",
            full_history=history,
            test_days=7,
            models=["lightgbm"],
        )
        assert "error" not in result
        model_result = result["results"][0]
        assert model_result["success"]
        assert "p10" in model_result
        assert "p50" in model_result
        assert "p90" in model_result
        assert "calibration_metrics" in model_result
        assert "gate_result" in model_result

        # Check quantile arrays have correct length
        assert len(model_result["p10"]) == 7
        assert len(model_result["p50"]) == 7
        assert len(model_result["p90"]) == 7

    def test_backtest_gate_result_structure(self, factory):
        np.random.seed(42)
        history = [100 + np.random.normal(0, 10) for _ in range(60)]
        result = factory.backtest_with_calibration(
            sku="BT-GATE",
            full_history=history,
            test_days=7,
            models=["lightgbm"],
        )
        model_result = result["results"][0]
        gate = model_result["gate_result"]
        assert "passed" in gate
        assert "reasons" in gate
        assert "thresholds" in gate

    def test_best_model_includes_gate_passed(self, factory):
        np.random.seed(42)
        history = [50 + i * 0.1 for i in range(60)]
        result = factory.backtest_with_calibration(
            sku="BT-BEST",
            full_history=history,
            test_days=7,
            models=["lightgbm"],
        )
        assert "gate_passed" in result["best_model"]


# ══════════════════════════════════════
# Test F: Inference Quantile Generation
# ══════════════════════════════════════

class TestInferenceQuantileGeneration:
    @pytest.fixture
    def factory(self):
        from ml.demand_forecasting.forecaster_factory import ForecasterFactory
        return ForecasterFactory()

    def test_generate_without_calibration(self, factory):
        result = factory.generate_quantiles_for_inference(
            point_forecasts=[100.0, 110.0, 120.0],
        )
        assert result.uncertainty_method == "heuristic_fallback"
        assert len(result.p10) == 3
        assert len(result.p50) == 3
        assert len(result.p90) == 3
        for i in range(3):
            assert result.p10[i] <= result.p50[i] <= result.p90[i]

    def test_generate_with_residuals(self, factory):
        np.random.seed(42)
        residuals = list(np.random.normal(0, 10, 50))
        result = factory.generate_quantiles_for_inference(
            point_forecasts=[100.0, 110.0, 120.0],
            backtest_residuals=residuals,
        )
        assert result.uncertainty_method == "residual_conformal"
        assert result.calibration_scope == "global"
        for i in range(3):
            assert result.p10[i] <= result.p50[i] <= result.p90[i]

    def test_generate_with_saved_calibration(self, factory):
        np.random.seed(42)
        residuals = list(np.random.normal(0, 10, 50))
        engine = QuantileEngine()
        engine.fit(residuals_global=residuals)

        with tempfile.NamedTemporaryFile(suffix=".json", delete=False, mode="w") as f:
            cal_path = f.name
        try:
            engine.save(cal_path)
            result = factory.generate_quantiles_for_inference(
                point_forecasts=[100.0, 110.0, 120.0],
                calibration_path=cal_path,
            )
            assert result.uncertainty_method == "residual_conformal"
            assert result.calibration_scope == "global"
        finally:
            os.unlink(cal_path)


# ══════════════════════════════════════
# Test G: QuantileEngine Persistence
# ══════════════════════════════════════

class TestQuantileEnginePersistence:
    def test_save_load_roundtrip(self):
        np.random.seed(42)
        engine = QuantileEngine()
        engine.fit(
            residuals_global=list(np.random.normal(0, 10, 50)),
            residuals_per_series={
                "SKU-A": list(np.random.normal(-2, 8, 20)),
                "SKU-B": list(np.random.normal(3, 5, 20)),
            },
        )

        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
            path = f.name
        try:
            engine.save(path)

            loaded = QuantileEngine()
            loaded.load(path)

            assert loaded.is_fitted
            assert loaded.calibration_scope == engine.calibration_scope

            # Same quantile results
            pf = [100.0, 200.0, 300.0]
            r1 = engine.predict_quantiles(pf, series_id="SKU-A")
            r2 = loaded.predict_quantiles(pf, series_id="SKU-A")
            assert r1.p10 == pytest.approx(r2.p10, abs=0.01)
            assert r1.p50 == pytest.approx(r2.p50, abs=0.01)
            assert r1.p90 == pytest.approx(r2.p90, abs=0.01)
        finally:
            os.unlink(path)

    def test_calibration_report_structure(self):
        np.random.seed(42)
        engine = QuantileEngine()
        engine.fit(residuals_global=list(np.random.normal(0, 10, 50)))

        report = engine.get_calibration_report()
        assert "residual_pool" in report
        assert "sample_counts" in report
        assert "quantiles_used" in report
        assert "config" in report
        assert report["residual_pool"] == "global"


# ══════════════════════════════════════
# Test H: Select Best Candidate
# ══════════════════════════════════════

class TestSelectBestCandidate:
    def test_selects_passing_with_lowest_pinball(self):
        candidates = [
            {
                "model": "A",
                "gate_result": {"passed": True},
                "metrics": {"pinball_loss_mean": 10.0, "coverage_10_90": 0.80},
            },
            {
                "model": "B",
                "gate_result": {"passed": True},
                "metrics": {"pinball_loss_mean": 5.0, "coverage_10_90": 0.82},
            },
        ]
        best = select_best_candidate(candidates)
        assert best["model"] == "B"
        assert best["degraded"] is False

    def test_all_fail_selects_best_coverage_degraded(self):
        candidates = [
            {
                "model": "A",
                "gate_result": {"passed": False},
                "metrics": {"pinball_loss_mean": 10.0, "coverage_10_90": 0.50},
            },
            {
                "model": "B",
                "gate_result": {"passed": False},
                "metrics": {"pinball_loss_mean": 5.0, "coverage_10_90": 0.60},
            },
        ]
        best = select_best_candidate(candidates)
        assert best["model"] == "B"
        assert best["degraded"] is True

    def test_empty_candidates(self):
        best = select_best_candidate([])
        assert best["degraded"] is True
