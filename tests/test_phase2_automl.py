"""
Tests for Phase 2: AutoML Enhancement deliverables.

Covers:
  2.1 XGBoostStrategy
  2.2 ETSStrategy
  2.3 Prophet HPO (search space + run_hpo_prophet + run_hpo_xgboost)
  2.4 Leaderboard composite score
  2.5 Gate enforcement in promote_to_prod()
  2.6 Default candidates expansion
"""
import json
import os
import sys
import tempfile

import numpy as np
import pandas as pd
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
if SRC not in sys.path:
    sys.path.insert(0, SRC)

from ml.demand_forecasting.data_contract import SalesSeries
from ml.training.dataset_builder import build_dataset
from ml.training.evaluation import EvalMetrics
from ml.training.strategies import (
    STRATEGY_REGISTRY,
    ETSStrategy,
    LightGBMStrategy,
    TrainedModel,
    XGBoostStrategy,
    get_strategy,
)


def _make_series(days=120, seed=42):
    """Create a reproducible synthetic sales series."""
    rng = np.random.default_rng(seed)
    dates = pd.date_range(start="2025-01-01", periods=days, freq="D")
    trend = np.arange(days) * 0.1
    seasonal = 5 * np.sin(2 * np.pi * np.arange(days) / 7)
    noise = rng.normal(0, 3, days)
    sales = np.maximum(50 + trend + seasonal + noise, 0)
    return SalesSeries(dates=dates.tolist(), values=sales.tolist(), sku="PHASE2-TEST")


@pytest.fixture
def bundle():
    series = _make_series(days=120)
    return build_dataset(series, horizon=7, val_ratio=0.15)


# ── 2.1 & 2.2: Strategy Registry ────────────────────────────────────────


class TestStrategyRegistry:
    def test_registry_has_5_entries(self):
        """STRATEGY_REGISTRY should have all 5 model types."""
        assert len(STRATEGY_REGISTRY) == 5
        expected = {"lightgbm", "prophet", "xgboost", "ets", "chronos"}
        assert set(STRATEGY_REGISTRY.keys()) == expected

    def test_get_strategy_xgboost(self):
        strategy = get_strategy("xgboost")
        assert isinstance(strategy, XGBoostStrategy)
        assert strategy.name == "xgboost"

    def test_get_strategy_ets(self):
        strategy = get_strategy("ets")
        assert isinstance(strategy, ETSStrategy)
        assert strategy.name == "ets"

    def test_get_strategy_case_insensitive(self):
        assert get_strategy("XGBoost").name == "xgboost"
        assert get_strategy("ETS").name == "ets"


# ── 2.1: XGBoostStrategy ────────────────────────────────────────────────


class TestXGBoostStrategy:
    def test_fit_returns_trained_model(self, bundle):
        strategy = XGBoostStrategy()
        result = strategy.fit(bundle, {"seed": 42})

        assert isinstance(result, TrainedModel)
        assert result.model_name == "xgboost"
        assert result.val_metrics.mape < 999
        assert result.train_metrics.mape < 999
        assert "max_depth" in result.config
        assert "learning_rate" in result.config

    def test_fit_feature_importance(self, bundle):
        strategy = XGBoostStrategy()
        result = strategy.fit(bundle, {"seed": 42})

        assert "feature_importance" in result.extra
        assert len(result.extra["feature_importance"]) > 0

    def test_predict_returns_array(self, bundle):
        strategy = XGBoostStrategy()
        result = strategy.fit(bundle, {"seed": 42})

        history = list(bundle.train_series.values)
        preds = strategy.predict(result.model_obj, history, horizon=7)
        assert isinstance(preds, np.ndarray)
        assert len(preds) == 7
        assert all(p >= 0 for p in preds)

    def test_custom_hyperparams(self, bundle):
        strategy = XGBoostStrategy()
        result = strategy.fit(bundle, {
            "seed": 42,
            "max_depth": 4,
            "learning_rate": 0.1,
        })
        assert result.config["max_depth"] == 4
        assert result.config["learning_rate"] == 0.1


# ── 2.2: ETSStrategy ────────────────────────────────────────────────────


class TestETSStrategy:
    def test_fit_returns_trained_model(self, bundle):
        strategy = ETSStrategy()
        result = strategy.fit(bundle, {"seed": 42})

        assert isinstance(result, TrainedModel)
        assert result.model_name == "ets"
        assert result.val_metrics.mape < 999
        assert result.train_metrics.mape < 999

    def test_predict_returns_array(self, bundle):
        strategy = ETSStrategy()
        result = strategy.fit(bundle, {"seed": 42})

        history = list(bundle.train_series.values)
        preds = strategy.predict(result.model_obj, history, horizon=7)
        assert isinstance(preds, np.ndarray)
        assert len(preds) == 7
        assert all(p >= 0 for p in preds)

    def test_seasonal_config(self, bundle):
        strategy = ETSStrategy()
        result = strategy.fit(bundle, {
            "seed": 42,
            "seasonal_periods": 7,
            "trend": "add",
            "seasonal": "add",
        })
        assert result.config["seasonal_periods"] == 7
        assert result.config["trend"] == "add"

    def test_short_series_no_seasonal(self):
        """Series shorter than 2*seasonal_periods should use non-seasonal ETS."""
        series = _make_series(days=50, seed=99)
        b = build_dataset(series, horizon=7, val_ratio=0.15)
        strategy = ETSStrategy()
        result = strategy.fit(b, {"seasonal_periods": 30})

        assert result.model_name == "ets"
        assert result.val_metrics.mape < 999

    def test_feature_spec_marks_no_features(self, bundle):
        strategy = ETSStrategy()
        result = strategy.fit(bundle, {"seed": 42})
        assert result.feature_spec.get("no_features") is True


# ── 2.3: HPO Search Spaces + run_hpo_xgboost ────────────────────────────


class TestHPOSearchSpaces:
    def test_xgboost_search_space_exists(self):
        from ml.training.hpo import DEFAULT_XGBOOST_SEARCH_SPACE
        assert "learning_rate" in DEFAULT_XGBOOST_SEARCH_SPACE
        assert "max_depth" in DEFAULT_XGBOOST_SEARCH_SPACE
        assert "subsample" in DEFAULT_XGBOOST_SEARCH_SPACE
        assert "colsample_bytree" in DEFAULT_XGBOOST_SEARCH_SPACE
        assert len(DEFAULT_XGBOOST_SEARCH_SPACE) == 7

    def test_prophet_search_space_exists(self):
        from ml.training.hpo import DEFAULT_PROPHET_SEARCH_SPACE
        assert "changepoint_prior_scale" in DEFAULT_PROPHET_SEARCH_SPACE
        assert "seasonality_prior_scale" in DEFAULT_PROPHET_SEARCH_SPACE
        assert "seasonality_mode" in DEFAULT_PROPHET_SEARCH_SPACE
        assert DEFAULT_PROPHET_SEARCH_SPACE["seasonality_mode"]["type"] == "categorical"

    def test_run_hpo_xgboost(self, bundle):
        from ml.training.hpo import HPOConfig, HPOResult, run_hpo_xgboost

        cfg = HPOConfig(enabled=True, n_trials=3, cv_mode="holdout", seed=42)
        result = run_hpo_xgboost(bundle, cfg)

        assert isinstance(result, HPOResult)
        assert result.best_score < 999
        assert result.n_trials_completed == 3
        assert "learning_rate" in result.best_params or "max_depth" in result.best_params

    def test_xgboost_strategy_with_hpo(self, bundle):
        strategy = XGBoostStrategy()
        result = strategy.fit(bundle, {
            "seed": 42,
            "hpo_enabled": True,
            "hpo_n_trials": 3,
            "hpo_cv_mode": "holdout",
        })

        assert result.extra.get("hpo_report") is not None
        report = result.extra["hpo_report"]
        assert "best_params" in report
        assert "best_score" in report
        assert result.val_metrics.mape < 999


# ── 2.4: Leaderboard Composite Score ────────────────────────────────────


class TestLeaderboardComposite:
    def test_composite_score_formula(self):
        from ml.training.orchestrator import _composite_score
        # 0.5*10 + 0.3*5 + 0.2*(100-80) = 5 + 1.5 + 4 = 10.5
        score = _composite_score(mape=10.0, bias=5.0, coverage=80.0)
        assert abs(score - 10.5) < 0.01

    def test_composite_score_no_coverage(self):
        from ml.training.orchestrator import _composite_score
        # coverage=None → treated as 50.0 → 0.5*10 + 0.3*5 + 0.2*(100-50) = 5 + 1.5 + 10 = 16.5
        score = _composite_score(mape=10.0, bias=5.0, coverage=None)
        assert abs(score - 16.5) < 0.01

    def test_leaderboard_entry_has_coverage(self):
        from ml.training.orchestrator import LeaderboardEntry
        entry = LeaderboardEntry(
            rank=1, model_name="lightgbm", val_mape=10.0, val_bias=2.0,
            train_mape=8.0, artifact_dir="/tmp", run_id="test",
            dataset_fingerprint="abc", elapsed_seconds=1.0,
            coverage_10_90=85.0, composite_score=10.0,
        )
        d = entry.to_dict()
        assert "coverage_10_90" in d
        assert d["coverage_10_90"] == 85.0
        assert "composite_score" in d

    def test_leaderboard_entry_no_coverage_omitted(self):
        from ml.training.orchestrator import LeaderboardEntry
        entry = LeaderboardEntry(
            rank=1, model_name="lightgbm", val_mape=10.0, val_bias=2.0,
            train_mape=8.0, artifact_dir="/tmp", run_id="test",
            dataset_fingerprint="abc", elapsed_seconds=1.0,
        )
        d = entry.to_dict()
        assert "coverage_10_90" not in d

    def test_model_complexity_includes_new_models(self):
        from ml.training.orchestrator import MODEL_COMPLEXITY
        assert "xgboost" in MODEL_COMPLEXITY
        assert "ets" in MODEL_COMPLEXITY
        assert MODEL_COMPLEXITY["lightgbm"] < MODEL_COMPLEXITY["xgboost"]
        assert MODEL_COMPLEXITY["xgboost"] < MODEL_COMPLEXITY["ets"]


# ── 2.5: Gate Enforcement ────────────────────────────────────────────────


class TestGateEnforcement:
    def test_promote_with_override_bypasses_gates(self):
        from ml.registry.model_registry import ModelLifecycleRegistry

        with tempfile.TemporaryDirectory() as tmpdir:
            reg = ModelLifecycleRegistry(root=tmpdir)
            art_id = reg.register_artifact("/tmp/model", {
                "series_id": "SKU-A",
                "model_name": "lightgbm",
                "metrics_summary": {"mape": 999.0},  # would fail gates
            })
            # override=True should bypass gates
            record = reg.promote_to_prod(
                "SKU-A", art_id, override=True, enforce_gates=True,
            )
            assert record["lifecycle_state"] == "PROD"

    def test_promote_with_enforce_gates_false(self):
        from ml.registry.model_registry import ModelLifecycleRegistry

        with tempfile.TemporaryDirectory() as tmpdir:
            reg = ModelLifecycleRegistry(root=tmpdir)
            art_id = reg.register_artifact("/tmp/model", {
                "series_id": "SKU-B",
                "model_name": "lightgbm",
                "metrics_summary": {"mape": 999.0},
            })
            # enforce_gates=False should skip gate check
            record = reg.promote_to_prod(
                "SKU-B", art_id, enforce_gates=False,
            )
            assert record["lifecycle_state"] == "PROD"


# ── 2.6: Default Candidates ─────────────────────────────────────────────


class TestDefaultCandidates:
    def test_default_includes_xgboost(self):
        """run_orchestrator default candidates should include xgboost."""
        import inspect
        from ml.training.orchestrator import run_orchestrator

        sig = inspect.signature(run_orchestrator)
        # We can't easily get default from the function body,
        # so we verify by checking the orchestrator source
        source = inspect.getsource(run_orchestrator)
        assert '"xgboost"' in source or "'xgboost'" in source
