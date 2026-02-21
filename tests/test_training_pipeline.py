"""
PR-B: Training Pipeline Tests
──────────────────────────────
Deterministic, fast, CI-friendly tests for the training pipeline.
All tests use tiny synthetic data and fixed seeds.
Target: complete suite under 60 seconds.
"""
import json
import os
import sys
import tempfile

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))


from ml.demand_forecasting.data_contract import SalesSeries
from ml.demand_forecasting.feature_engineer import FEATURE_COLUMNS, FeatureEngineer
from ml.training.artifact_manager import ArtifactManager
from ml.training.dataset_builder import DatasetBundle, build_dataset
from ml.training.evaluation import EvalMetrics, compute_metrics, walk_forward_evaluate
from ml.training.orchestrator import (
    load_champion,
    rollback_champion,
    run_orchestrator,
    set_champion,
)
from ml.training.runner import TrainingRunConfig, TrainingRunResult, train_one_series


# ── Fixtures ─────────────────────────────────────────────

def _make_synthetic_series(days=120, seed=42, sku="TEST-SKU"):
    np.random.seed(seed)
    dates = pd.date_range(start="2025-01-01", periods=days, freq="D")
    base = 50
    trend = np.arange(days) * 0.1
    weekly = 5 * np.sin(2 * np.pi * np.arange(days) / 7)
    noise = np.random.normal(0, 3, days)
    sales = np.maximum(base + trend + weekly + noise, 0).round(1)
    return SalesSeries(dates=dates.tolist(), values=sales.tolist(), sku=sku)


@pytest.fixture
def synthetic_series():
    return _make_synthetic_series()


@pytest.fixture
def tmp_artifact_root(tmp_path):
    return str(tmp_path / "artifacts")


@pytest.fixture
def tmp_champion_dir(tmp_path):
    return str(tmp_path / "champions")


# ══════════════════════════════════════════════════════════
# 7.1 Unit Tests: Artifact Writing
# ══════════════════════════════════════════════════════════


class TestArtifactManager:
    """Verifies artifact files exist and include expected keys."""

    def test_save_and_load_model(self, tmp_artifact_root):
        """LightGBM model can be saved and re-loaded from artifacts."""
        import lightgbm as lgb

        # Train a tiny model
        np.random.seed(42)
        X = pd.DataFrame(np.random.randn(50, 5), columns=[f"f{i}" for i in range(5)])
        y = pd.Series(np.random.randn(50) + 50)
        ds = lgb.Dataset(X, label=y)
        model = lgb.train({"verbose": -1, "num_leaves": 4}, ds, num_boost_round=5)

        am = ArtifactManager(root=tmp_artifact_root)
        artifact_dir = am.save_run(
            run_id="test_run",
            series_id="SKU-A",
            model_name="lightgbm",
            model_obj=model,
            config={"seed": 42, "num_leaves": 4},
            metrics={"val": {"mape": 5.0}},
            feature_spec={"columns": ["f0", "f1", "f2", "f3", "f4"]},
            dataset_fingerprint="abc123",
        )

        # Verify required files exist
        expected_files = [
            "model.pkl",
            "feature_spec.json",
            "metrics.json",
            "config.json",
            "dataset_fingerprint.txt",
            "code_provenance.json",
        ]
        for fname in expected_files:
            fpath = os.path.join(artifact_dir, fname)
            assert os.path.exists(fpath), f"Missing artifact file: {fname}"
            assert os.path.getsize(fpath) > 0, f"Empty artifact file: {fname}"

        # Verify JSON content has expected keys
        with open(os.path.join(artifact_dir, "metrics.json")) as f:
            metrics = json.load(f)
        assert "val" in metrics
        assert metrics["val"]["mape"] == 5.0

        with open(os.path.join(artifact_dir, "config.json")) as f:
            config = json.load(f)
        assert config["seed"] == 42

        with open(os.path.join(artifact_dir, "code_provenance.json")) as f:
            provenance = json.load(f)
        assert "git_sha" in provenance
        assert "timestamp" in provenance
        assert "python_version" in provenance

        with open(os.path.join(artifact_dir, "dataset_fingerprint.txt")) as f:
            fp = f.read().strip()
        assert fp == "abc123"

        # Verify model can be loaded back
        loaded_model = am.load_model(artifact_dir, "lightgbm")
        preds = loaded_model.predict(X)
        assert len(preds) == 50

    def test_load_metadata(self, tmp_artifact_root):
        """Metadata loading returns all expected sections."""
        am = ArtifactManager(root=tmp_artifact_root)

        # Manually write files
        run_dir = am.run_dir("r1", "SKU-X", "lightgbm")
        os.makedirs(run_dir, exist_ok=True)

        for fname, content in [
            ("metrics.json", {"val": {"mape": 10}}),
            ("config.json", {"seed": 42}),
            ("feature_spec.json", {"columns": ["a", "b"]}),
            ("code_provenance.json", {"git_sha": "abc"}),
        ]:
            with open(os.path.join(run_dir, fname), "w") as f:
                json.dump(content, f)

        with open(os.path.join(run_dir, "dataset_fingerprint.txt"), "w") as f:
            f.write("fp123")

        meta = am.load_metadata(run_dir)
        assert "metrics" in meta
        assert "config" in meta
        assert "feature_spec" in meta
        assert "code_provenance" in meta
        assert meta["dataset_fingerprint"] == "fp123"


class TestFeatureSpecConsistency:
    """Feature spec consistency: training checks feature_spec matches inference."""

    def test_feature_columns_match_training_output(self, synthetic_series,
                                                   tmp_artifact_root):
        """Trained model's feature spec matches FEATURE_COLUMNS constant."""
        config = TrainingRunConfig(
            series_id="TEST-SKU",
            horizon=7,
            model_name="lightgbm",
            seed=42,
            run_id="spec_test",
            artifact_root=tmp_artifact_root,
        )
        result = train_one_series(synthetic_series, config)
        assert result.status == "success"

        # Load feature spec from artifact
        am = ArtifactManager(root=tmp_artifact_root)
        meta = am.load_metadata(result.artifact_dir)
        saved_columns = meta["feature_spec"]["feature_columns"]

        assert saved_columns == list(FEATURE_COLUMNS), (
            f"Feature spec mismatch: saved {saved_columns[:3]}... vs expected {list(FEATURE_COLUMNS)[:3]}..."
        )

    def test_feature_schema_validation_catches_mismatch(self):
        """FeatureEngineer.assert_feature_schema raises on column mismatch."""
        X_good = pd.DataFrame(
            np.zeros((1, len(FEATURE_COLUMNS))), columns=FEATURE_COLUMNS
        )
        # Should not raise
        FeatureEngineer.assert_feature_schema(X_good)

        # Missing column
        X_bad = X_good.drop(columns=["lag_1"])
        with pytest.raises(ValueError, match="missing columns"):
            FeatureEngineer.assert_feature_schema(X_bad)


# ══════════════════════════════════════════════════════════
# 7.2 Smoke Training Tests (tiny synthetic data)
# ══════════════════════════════════════════════════════════


class TestSmokeTraining:
    """Train models on tiny data. Assert completion, artifacts, metrics."""

    def test_lightgbm_train_completes(self, synthetic_series, tmp_artifact_root):
        """LightGBM training completes within time budget."""
        import time

        config = TrainingRunConfig(
            series_id="TEST-SKU",
            horizon=7,
            model_name="lightgbm",
            seed=42,
            run_id="smoke_lgbm",
            artifact_root=tmp_artifact_root,
        )

        t0 = time.time()
        result = train_one_series(synthetic_series, config)
        elapsed = time.time() - t0

        assert result.status == "success", f"Training failed: {result.error}"
        assert elapsed < 30, f"Training too slow: {elapsed:.1f}s"
        assert os.path.isdir(result.artifact_dir)

    def test_lightgbm_metrics_present(self, synthetic_series, tmp_artifact_root):
        """Metrics JSON has required fields."""
        config = TrainingRunConfig(
            series_id="TEST-SKU", horizon=7, model_name="lightgbm",
            seed=42, run_id="smoke_metrics", artifact_root=tmp_artifact_root,
        )
        result = train_one_series(synthetic_series, config)
        assert result.status == "success"

        # Check val_metrics
        assert result.val_metrics is not None
        assert result.val_metrics.mape < 999
        assert isinstance(result.val_metrics.bias, float)
        assert result.val_metrics.n_eval_points > 0

        # Check artifact metrics.json
        metrics_path = os.path.join(result.artifact_dir, "metrics.json")
        with open(metrics_path) as f:
            metrics = json.load(f)
        assert "val" in metrics
        assert "mape" in metrics["val"]
        assert "bias" in metrics["val"]

    def test_chronos_train_completes(self, synthetic_series, tmp_artifact_root):
        """Chronos (zero-shot) strategy completes and produces artifacts."""
        config = TrainingRunConfig(
            series_id="TEST-SKU", horizon=7, model_name="chronos",
            seed=42, run_id="smoke_chronos", artifact_root=tmp_artifact_root,
        )
        result = train_one_series(synthetic_series, config)
        assert result.status == "success", f"Chronos failed: {result.error}"
        assert os.path.isdir(result.artifact_dir)
        assert result.val_metrics is not None

    def test_deterministic_fingerprint(self, tmp_artifact_root):
        """Same data + config produces same dataset fingerprint."""
        s1 = _make_synthetic_series(days=100, seed=42, sku="DET-SKU")
        s2 = _make_synthetic_series(days=100, seed=42, sku="DET-SKU")

        config1 = TrainingRunConfig(
            series_id="DET-SKU", horizon=7, model_name="lightgbm",
            seed=42, run_id="det_run1", artifact_root=tmp_artifact_root,
        )
        config2 = TrainingRunConfig(
            series_id="DET-SKU", horizon=7, model_name="lightgbm",
            seed=42, run_id="det_run2", artifact_root=tmp_artifact_root,
        )

        r1 = train_one_series(s1, config1)
        r2 = train_one_series(s2, config2)

        assert r1.status == "success"
        assert r2.status == "success"
        assert r1.dataset_fingerprint == r2.dataset_fingerprint, (
            f"Fingerprints differ: {r1.dataset_fingerprint} vs {r2.dataset_fingerprint}"
        )


# ══════════════════════════════════════════════════════════
# 7.3 Orchestrator Tests
# ══════════════════════════════════════════════════════════


class TestOrchestrator:
    """Orchestrator: leaderboard, champion selection, rollback."""

    def test_leaderboard_produced(self, synthetic_series, tmp_artifact_root,
                                  tmp_champion_dir):
        """Orchestrator produces a leaderboard with correct entries."""
        result = run_orchestrator(
            series=synthetic_series,
            candidate_models=["lightgbm", "chronos"],
            horizon=7, seed=42, run_id="orch_test",
            artifact_root=tmp_artifact_root,
            champion_dir=tmp_champion_dir,
        )

        assert len(result.leaderboard) == 2
        assert result.leaderboard[0].rank == 1
        assert result.leaderboard[1].rank == 2
        assert result.leaderboard[0].is_champion is True
        assert result.leaderboard[1].is_champion is False

        # Leaderboard file exists
        lb_path = os.path.join(tmp_artifact_root, "orch_test", "leaderboard.json")
        assert os.path.exists(lb_path)

    def test_champion_selection_deterministic(self, synthetic_series,
                                              tmp_artifact_root, tmp_champion_dir):
        """Champion selection is deterministic across runs."""
        results = []
        for i in range(2):
            r = run_orchestrator(
                series=synthetic_series,
                candidate_models=["lightgbm", "chronos"],
                horizon=7, seed=42, run_id=f"det_orch_{i}",
                artifact_root=tmp_artifact_root,
                champion_dir=tmp_champion_dir,
            )
            results.append(r)

        assert results[0].champion.model_name == results[1].champion.model_name
        assert abs(results[0].champion.val_mape - results[1].champion.val_mape) < 0.01

    def test_rollback_changes_champion(self, synthetic_series, tmp_artifact_root,
                                       tmp_champion_dir):
        """Rollback restores previous champion predictably."""
        # Run 1: lightgbm wins
        run_orchestrator(
            series=synthetic_series,
            candidate_models=["lightgbm", "chronos"],
            horizon=7, seed=42, run_id="roll_r1",
            artifact_root=tmp_artifact_root,
            champion_dir=tmp_champion_dir,
        )
        c1 = load_champion("TEST-SKU", tmp_champion_dir)
        assert c1["model_name"] == "lightgbm"

        # Run 2: only chronos → chronos becomes champion
        run_orchestrator(
            series=synthetic_series,
            candidate_models=["chronos"],
            horizon=7, seed=42, run_id="roll_r2",
            artifact_root=tmp_artifact_root,
            champion_dir=tmp_champion_dir,
        )
        c2 = load_champion("TEST-SKU", tmp_champion_dir)
        assert c2["model_name"] == "chronos"

        # Rollback: should restore lightgbm
        restored = rollback_champion("TEST-SKU", steps=1,
                                     champion_dir=tmp_champion_dir)
        assert restored["model_name"] == "lightgbm"
        assert restored.get("restored_via_rollback") is True

        # Verify champion file reflects rollback
        current = load_champion("TEST-SKU", tmp_champion_dir)
        assert current["model_name"] == "lightgbm"


# ══════════════════════════════════════════════════════════
# 7.4 Inference Integration Tests
# ══════════════════════════════════════════════════════════


class TestInferenceIntegration:
    """Champion loading in inference vs fallback path."""

    def test_champion_inference_loads(self, synthetic_series, tmp_artifact_root,
                                      tmp_champion_dir):
        """With champion present, predict_with_champion returns predictions."""
        from ml.demand_forecasting.forecaster_factory import ForecasterFactory

        # Train and select champion
        run_orchestrator(
            series=synthetic_series,
            candidate_models=["lightgbm"],
            horizon=7, seed=42, run_id="inf_test",
            artifact_root=tmp_artifact_root,
            champion_dir=tmp_champion_dir,
        )

        factory = ForecasterFactory()
        result = factory.predict_with_champion(
            sku="TEST-SKU",
            inline_history=synthetic_series.values[-60:],
            horizon_days=7,
            champion_dir=tmp_champion_dir,
        )

        assert result is not None, "Champion prediction should not be None"
        assert result["success"] is True
        assert len(result["prediction"]["predictions"]) == 7
        assert result["metadata"]["inference_mode"] == "champion_artifact"
        assert result["metadata"]["model_used"] == "champion"
        assert result["metadata"]["artifact_run_id"] != ""

    def test_no_champion_returns_none(self, tmp_champion_dir):
        """Without champion artifact, predict_with_champion returns None."""
        from ml.demand_forecasting.forecaster_factory import ForecasterFactory

        factory = ForecasterFactory()
        result = factory.predict_with_champion(
            sku="NONEXISTENT-SKU",
            inline_history=[50.0] * 30,
            horizon_days=7,
            champion_dir=tmp_champion_dir,
        )

        assert result is None, "Should return None when no champion exists"

    def test_fallback_still_works(self, synthetic_series):
        """Without champion, predict_with_fallback works as before."""
        from ml.demand_forecasting.forecaster_factory import ForecasterFactory

        factory = ForecasterFactory()
        result = factory.predict_with_fallback(
            sku="TEST-SKU",
            erp_connector=None,
            horizon_days=7,
            inline_history=synthetic_series.values[-60:],
        )

        assert result["success"] is True
        assert len(result["prediction"]["predictions"]) == 7


# ══════════════════════════════════════════════════════════
# Evaluation Module Tests
# ══════════════════════════════════════════════════════════


class TestEvaluation:
    """Evaluation metrics computation."""

    def test_mape_correct(self):
        actual = np.array([100, 200, 300])
        predicted = np.array([110, 190, 330])
        metrics = compute_metrics(actual, predicted)
        # MAPE = mean(|10/100|, |10/200|, |30/300|) * 100 = mean(0.1, 0.05, 0.1) * 100 = 8.33
        assert abs(metrics.mape - 8.33) < 0.1

    def test_bias_correct(self):
        actual = np.array([100, 200, 300])
        predicted = np.array([110, 210, 310])
        metrics = compute_metrics(actual, predicted)
        assert abs(metrics.bias - 10.0) < 0.01

    def test_coverage(self):
        actual = np.array([100, 200, 300])
        lower = np.array([90, 150, 250])
        upper = np.array([110, 250, 350])
        metrics = compute_metrics(actual, predicted=np.array([100, 200, 300]),
                                  lower_10=lower, upper_90=upper)
        assert metrics.coverage_10_90 == 100.0  # All in interval

    def test_coverage_partial(self):
        actual = np.array([100, 200, 400])
        lower = np.array([90, 150, 250])
        upper = np.array([110, 250, 350])
        metrics = compute_metrics(actual, predicted=np.array([100, 200, 300]),
                                  lower_10=lower, upper_90=upper)
        # 2 out of 3 covered
        assert abs(metrics.coverage_10_90 - 66.67) < 1

    def test_zero_actuals_handled(self):
        actual = np.array([0, 0, 0])
        predicted = np.array([10, 20, 30])
        metrics = compute_metrics(actual, predicted)
        assert metrics.mape == 999.0  # Division by zero protection

    def test_grade(self):
        m = EvalMetrics(mape=5)
        assert m.grade == "A+"
        m.mape = 15
        assert m.grade == "A"
        m.mape = 30
        assert m.grade == "B"
        m.mape = 60
        assert m.grade == "F"


class TestDatasetBuilder:
    """Dataset building tests."""

    def test_no_leakage(self, synthetic_series):
        """Training data ends before validation starts (no leakage)."""
        bundle = build_dataset(synthetic_series, horizon=7, val_ratio=0.15)

        train_last_date = bundle.train_df["date"].max()
        val_first_date = bundle.val_df["date"].min()

        assert train_last_date < val_first_date, (
            f"Leakage: train ends {train_last_date}, val starts {val_first_date}"
        )

    def test_fingerprint_deterministic(self, synthetic_series):
        """Same input produces same fingerprint."""
        b1 = build_dataset(synthetic_series, horizon=7, seed=42)
        b2 = build_dataset(synthetic_series, horizon=7, seed=42)
        assert b1.fingerprint == b2.fingerprint

    def test_feature_columns_match(self, synthetic_series):
        """Bundle feature columns match FEATURE_COLUMNS."""
        bundle = build_dataset(synthetic_series, horizon=7)
        assert list(bundle.X_train.columns) == list(FEATURE_COLUMNS)
        assert list(bundle.X_val.columns) == list(FEATURE_COLUMNS)
