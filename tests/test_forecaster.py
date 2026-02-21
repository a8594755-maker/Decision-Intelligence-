"""
P0-2.1: Unit tests for forecaster_factory.py
Focus: deterministic fallback, SalesSeries date alignment, MAPE calculation
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

import pytest
import numpy as np
from ml.demand_forecasting.forecaster_factory import ForecasterFactory, ModelType


@pytest.fixture
def factory():
    return ForecasterFactory()


class TestDeterministicFallback:
    """P0-1.5 驗收：同一輸入連打 10 次結果必須一致"""

    def test_lightgbm_fallback_deterministic(self, factory):
        history = [50 + i * 0.5 for i in range(60)]
        results = []
        for _ in range(10):
            strategy = factory.get_strategy(ModelType.LIGHTGBM)
            # Force fallback by using a fresh strategy without model
            r = strategy._predict_fallback(history, horizon_days=7, n=len(history))
            results.append(r['prediction']['predictions'])

        # All 10 runs must be identical
        for i in range(1, 10):
            assert results[i] == results[0], f"Run {i} differs from run 0"

    def test_prophet_fallback_deterministic(self, factory):
        history = [50 + i * 0.5 for i in range(60)]
        results = []
        for _ in range(10):
            strategy = factory.get_strategy(ModelType.PROPHET)
            r = strategy._predict_fallback(history, horizon_days=7, n=len(history))
            results.append(r['prediction']['predictions'])

        for i in range(1, 10):
            assert results[i] == results[0], f"Run {i} differs from run 0"

    def test_fallback_metadata_indicates_deterministic(self, factory):
        history = [50.0] * 30
        strategy = factory.get_strategy(ModelType.LIGHTGBM)
        r = strategy._predict_fallback(history, 7, len(history))
        assert 'deterministic' in r['metadata']['inference_mode']


class TestMAPECalculation:
    def test_basic_mape(self, factory):
        actual = [100, 200, 300]
        forecast = [110, 220, 330]
        mape = factory._calculate_mape(actual, forecast)
        expected = np.mean([10/100, 20/200, 30/300]) * 100
        assert mape == pytest.approx(expected, abs=0.01)

    def test_zero_actual_excluded(self, factory):
        """actual=0 的值應被排除，不應除以零"""
        actual = [100, 0, 200]
        forecast = [110, 50, 220]
        mape = factory._calculate_mape(actual, forecast)
        # Only uses indices 0 and 2
        expected = np.mean([10/100, 20/200]) * 100
        assert mape == pytest.approx(expected, abs=0.01)

    def test_all_zeros_returns_999(self, factory):
        actual = [0, 0, 0]
        forecast = [10, 20, 30]
        mape = factory._calculate_mape(actual, forecast)
        assert mape == 999.0

    def test_perfect_prediction(self, factory):
        actual = [100, 200, 300]
        forecast = [100, 200, 300]
        mape = factory._calculate_mape(actual, forecast)
        assert mape == pytest.approx(0.0, abs=0.001)


class TestGradeMAPE:
    def test_grades(self, factory):
        assert "A+" in factory._grade_mape(5)
        assert "A " in factory._grade_mape(15) or "A" in factory._grade_mape(15)
        assert "B" in factory._grade_mape(35)
        assert "F" in factory._grade_mape(60)


class TestRecommendModel:
    def test_very_limited_data_uses_chronos(self, factory):
        model = factory.recommend_model('X', inline_history=[10, 20])
        assert model == ModelType.CHRONOS

    def test_abundant_data_uses_lightgbm(self, factory):
        history = [50 + np.random.normal(0, 5) for _ in range(400)]
        model = factory.recommend_model('X', inline_history=history)
        assert model in (ModelType.LIGHTGBM, ModelType.PROPHET)

    def test_user_preference_respected(self, factory):
        model = factory.recommend_model('X', user_preference='prophet', inline_history=[10]*100)
        assert model == ModelType.PROPHET


class TestPredictWithFallback:
    def test_returns_success(self, factory):
        history = [50 + i for i in range(60)]
        result = factory.predict_with_fallback(
            sku='TEST', inline_history=history, horizon_days=7
        )
        assert result['success']
        assert 'prediction' in result

    def test_fallback_used_when_primary_fails(self, factory):
        """If primary model fails, should fallback to another"""
        # Very short history — Chronos can handle but LightGBM can't
        history = [10, 20, 30, 40, 50]
        result = factory.predict_with_fallback(
            sku='TEST', inline_history=history, horizon_days=3,
            preferred_model='lightgbm'
        )
        # Should still succeed via fallback
        assert result['success']


class TestBacktest:
    def test_basic_backtest(self, factory):
        np.random.seed(42)
        history = [50 + 5 * np.sin(2 * np.pi * i / 7) + np.random.normal(0, 3)
                   for i in range(90)]
        result = factory.backtest(
            sku='BT-TEST',
            full_history=history,
            test_days=7,
            models=['lightgbm']
        )
        assert 'results' in result
        assert result['best_model']['name'] == 'lightgbm'
        assert 'mape' in result['best_model']

    def test_insufficient_data(self, factory):
        result = factory.backtest('X', [1, 2, 3], test_days=7)
        assert 'error' in result


class TestQuantileOutput:
    """PR-A: Verify prediction dicts contain p10/p50/p90 arrays."""

    def _assert_quantiles(self, pred: dict, horizon: int):
        for key in ("p10", "p50", "p90"):
            assert key in pred, f"Missing '{key}' in prediction dict"
            assert len(pred[key]) == horizon, f"len({key})={len(pred[key])}, expected {horizon}"
        for i in range(horizon):
            assert pred["p10"][i] <= pred["p50"][i], f"p10[{i}] > p50[{i}]"
            assert pred["p50"][i] <= pred["p90"][i], f"p50[{i}] > p90[{i}]"
            assert pred["p10"][i] >= 0, f"p10[{i}] < 0"

    def test_lightgbm_fallback_has_quantiles(self, factory):
        history = [50 + i * 0.5 for i in range(60)]
        strategy = factory.get_strategy(ModelType.LIGHTGBM)
        r = strategy._predict_fallback(history, 7, len(history))
        self._assert_quantiles(r["prediction"], 7)

    def test_prophet_fallback_has_quantiles(self, factory):
        history = [50 + i * 0.5 for i in range(60)]
        strategy = factory.get_strategy(ModelType.PROPHET)
        r = strategy._predict_fallback(history, 7, len(history))
        self._assert_quantiles(r["prediction"], 7)

    def test_chronos_has_quantiles(self, factory):
        np.random.seed(42)
        history = [50 + np.random.normal(0, 5) for _ in range(60)]
        strategy = factory.get_strategy(ModelType.CHRONOS)
        r = strategy.predict(sku="TEST", inline_history=history, horizon_days=7)
        assert r["success"]
        self._assert_quantiles(r["prediction"], 7)

    def test_p50_matches_predictions(self, factory):
        history = [50 + i * 0.5 for i in range(60)]
        strategy = factory.get_strategy(ModelType.LIGHTGBM)
        r = strategy._predict_fallback(history, 7, len(history))
        pred = r["prediction"]
        for i in range(7):
            assert pred["p50"][i] == pytest.approx(pred["predictions"][i], abs=0.001)

    def test_quantiles_present_in_predict_with_fallback(self, factory):
        history = [50 + i for i in range(60)]
        result = factory.predict_with_fallback(
            sku="TEST", inline_history=history, horizon_days=7
        )
        assert result["success"]
        pred = result["prediction"]
        self._assert_quantiles(pred, 7)
