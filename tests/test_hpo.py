"""
Tests for the Optuna HPO module (src/ml/training/hpo.py).
"""
import json
import os
import sys
import time

import numpy as np
import pandas as pd
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
if SRC not in sys.path:
    sys.path.insert(0, SRC)

from ml.demand_forecasting.data_contract import SalesSeries
from ml.training.dataset_builder import build_dataset
from ml.training.hpo import DEFAULT_LGBM_SEARCH_SPACE, HPOConfig, HPOResult, run_hpo


def _make_series(days=120, seed=42):
    """Create a reproducible synthetic sales series."""
    rng = np.random.default_rng(seed)
    dates = pd.date_range(start="2025-01-01", periods=days, freq="D")
    trend = np.arange(days) * 0.1
    seasonal = 5 * np.sin(2 * np.pi * np.arange(days) / 7)
    noise = rng.normal(0, 3, days)
    sales = np.maximum(50 + trend + seasonal + noise, 0)
    return SalesSeries(dates=dates.tolist(), values=sales.tolist(), sku="HPO-TEST")


@pytest.fixture
def bundle():
    series = _make_series(days=120)
    return build_dataset(series, horizon=7, val_ratio=0.15)


# ── HPOConfig tests ────────────────────────────────────────────────────


class TestHPOConfig:
    def test_defaults(self):
        cfg = HPOConfig()
        assert cfg.enabled is False
        assert cfg.n_trials == 30
        assert cfg.cv_mode == "timeseries_cv"
        assert cfg.cv_n_splits == 3
        assert cfg.sampler == "tpe"
        assert cfg.pruner == "median"
        assert cfg.seed == 42

    def test_to_dict_roundtrip(self):
        cfg = HPOConfig(enabled=True, n_trials=10, cv_mode="holdout")
        d = cfg.to_dict()
        assert d["enabled"] is True
        assert d["n_trials"] == 10
        assert d["cv_mode"] == "holdout"
        # Must be JSON-serializable
        json.dumps(d)


# ── HPOResult tests ────────────────────────────────────────────────────


class TestHPOResult:
    def test_to_dict_json_safe(self):
        result = HPOResult(
            best_params={"learning_rate": 0.0523456789, "num_leaves": 31},
            best_score=12.3456,
            n_trials_completed=5,
            n_trials_pruned=2,
            trial_history=[
                {"number": 0, "value": 15.0, "params": {"learning_rate": 0.1}},
                {"number": 1, "value": 12.3, "params": {"learning_rate": 0.05}},
            ],
            elapsed_seconds=3.14159,
            search_space_used=DEFAULT_LGBM_SEARCH_SPACE,
            cv_mode="holdout",
        )
        d = result.to_dict()
        serialized = json.dumps(d)
        assert serialized  # no exception
        assert d["best_score"] == 12.3456
        assert d["n_trials_completed"] == 5
        assert d["n_trials_pruned"] == 2

    def test_trial_history_capped_at_10(self):
        history = [{"number": i, "value": float(i), "params": {}} for i in range(20)]
        result = HPOResult(
            best_params={}, best_score=0, n_trials_completed=20,
            n_trials_pruned=0, trial_history=history, elapsed_seconds=1.0,
            search_space_used={}, cv_mode="holdout",
        )
        assert len(result.to_dict()["trial_history"]) == 10


# ── run_hpo tests ──────────────────────────────────────────────────────


class TestRunHPO:
    def test_holdout_mode(self, bundle):
        """HPO in holdout mode completes and returns valid result."""
        cfg = HPOConfig(enabled=True, n_trials=3, cv_mode="holdout", seed=42)
        result = run_hpo(bundle, cfg)

        assert isinstance(result, HPOResult)
        assert result.best_score < 999
        assert result.n_trials_completed == 3
        assert "learning_rate" in result.best_params
        assert "num_leaves" in result.best_params
        assert result.cv_mode == "holdout"
        assert len(result.trial_history) > 0

    def test_timeseries_cv_mode(self, bundle):
        """HPO with TimeSeriesSplit CV completes."""
        cfg = HPOConfig(
            enabled=True, n_trials=3, cv_mode="timeseries_cv",
            cv_n_splits=2, seed=42,
        )
        result = run_hpo(bundle, cfg)

        assert isinstance(result, HPOResult)
        assert result.cv_mode == "timeseries_cv"
        assert result.best_score < 999
        assert result.n_trials_completed > 0

    def test_custom_search_space(self, bundle):
        """HPO with custom search space uses only specified params."""
        custom = {
            "learning_rate": {"type": "float", "low": 0.05, "high": 0.1, "log": False},
            "num_leaves": {"type": "int", "low": 20, "high": 40},
        }
        cfg = HPOConfig(
            enabled=True, n_trials=3, cv_mode="holdout",
            search_space=custom, seed=42,
        )
        result = run_hpo(bundle, cfg)

        assert "learning_rate" in result.best_params
        assert "num_leaves" in result.best_params
        # Params not in custom space should NOT appear
        assert "reg_alpha" not in result.best_params
        assert "min_child_samples" not in result.best_params

    def test_timeout_respected(self, bundle):
        """HPO respects timeout_seconds and stops early."""
        cfg = HPOConfig(
            enabled=True, n_trials=1000,
            timeout_seconds=5, cv_mode="holdout", seed=42,
        )
        t0 = time.time()
        result = run_hpo(bundle, cfg)
        elapsed = time.time() - t0

        # Should stop well before 1000 trials
        assert result.n_trials_completed < 1000
        assert elapsed < 60  # generous upper bound

    def test_result_to_dict_complete(self, bundle):
        """HPOResult.to_dict() contains all expected keys."""
        cfg = HPOConfig(enabled=True, n_trials=3, cv_mode="holdout", seed=42)
        result = run_hpo(bundle, cfg)
        d = result.to_dict()

        assert "best_params" in d
        assert "best_score" in d
        assert "n_trials_completed" in d
        assert "n_trials_pruned" in d
        assert "elapsed_seconds" in d
        assert "cv_mode" in d
        assert "trial_history" in d

    def test_all_default_params_tuned(self, bundle):
        """Default search space tunes all 8 hyperparameters."""
        cfg = HPOConfig(enabled=True, n_trials=3, cv_mode="holdout", seed=42)
        result = run_hpo(bundle, cfg)

        expected_params = {
            "learning_rate", "num_leaves", "feature_fraction",
            "bagging_fraction", "bagging_freq", "min_child_samples",
            "reg_alpha", "reg_lambda",
        }
        assert expected_params == set(result.best_params.keys())


# ── Strategy integration test ──────────────────────────────────────────


class TestStrategyHPOIntegration:
    def test_fit_with_hpo_produces_report(self):
        """LightGBMStrategy.fit() with HPO stores hpo_report in extra."""
        from ml.training.strategies import LightGBMStrategy

        series = _make_series(days=120)
        b = build_dataset(series, horizon=7, val_ratio=0.15)
        strategy = LightGBMStrategy()

        result = strategy.fit(b, {
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

    def test_fit_without_hpo_no_report(self):
        """LightGBMStrategy.fit() without HPO has no hpo_report."""
        from ml.training.strategies import LightGBMStrategy

        series = _make_series(days=120)
        b = build_dataset(series, horizon=7, val_ratio=0.15)
        strategy = LightGBMStrategy()

        result = strategy.fit(b, {"seed": 42})

        assert "hpo_report" not in result.extra
        assert result.val_metrics.mape < 999

    def test_fit_default_unchanged(self):
        """Default behavior (hpo_enabled=False) is identical to baseline."""
        from ml.training.strategies import LightGBMStrategy

        series = _make_series(days=120)
        b = build_dataset(series, horizon=7, val_ratio=0.15)
        strategy = LightGBMStrategy()

        result = strategy.fit(b, {"seed": 42})

        # Should use hardcoded defaults
        assert result.config["num_leaves"] == 31
        assert result.config["learning_rate"] == 0.05
        assert result.config["feature_fraction"] == 0.9
