"""Dataset builder tests: determinism, walk-forward correctness, skew prevention."""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

import pytest
import numpy as np
import pandas as pd
from ml.demand_forecasting.data_contract import SalesSeries
from ml.demand_forecasting.dataset_builder import (
    DATASET_BUILDER_VERSION,
    DatasetBundle,
    FeatureSpec,
    build_timeseries_dataset,
    validate_feature_spec,
)
from ml.demand_forecasting.feature_engineer import FEATURE_COLUMNS, FeatureEngineer


@pytest.fixture
def sample_series():
    np.random.seed(42)
    n = 90
    dates = pd.date_range("2025-01-01", periods=n, freq="D")
    values = (
        50 + 5 * np.sin(np.arange(n) * 2 * np.pi / 7) + np.random.normal(0, 3, n)
    ).clip(0).tolist()
    return SalesSeries(dates=dates.tolist(), values=values, sku="TEST-SKU")


@pytest.fixture
def short_series():
    dates = pd.date_range("2025-01-01", periods=20, freq="D")
    return SalesSeries(dates=dates.tolist(), values=[10.0] * 20, sku="SHORT")


# ---------------------------------------------------------------------------
# DatasetBundle creation
# ---------------------------------------------------------------------------

class TestBuildDataset:
    def test_returns_dataset_bundle(self, sample_series):
        bundle = build_timeseries_dataset(sample_series)
        assert isinstance(bundle, DatasetBundle)
        assert bundle.n_folds >= 1
        assert bundle.dataset_fingerprint
        assert bundle.builder_version == DATASET_BUILDER_VERSION

    def test_feature_columns_match(self, sample_series):
        bundle = build_timeseries_dataset(sample_series)
        for split in bundle.splits:
            assert list(split.X_train.columns) == list(FEATURE_COLUMNS)
            assert list(split.X_val.columns) == list(FEATURE_COLUMNS)

    def test_no_nan_in_splits(self, sample_series):
        bundle = build_timeseries_dataset(sample_series)
        for split in bundle.splits:
            assert not split.X_train.isna().any().any(), "NaN in X_train"
            assert not split.X_val.isna().any().any(), "NaN in X_val"
            assert not split.y_train.isna().any(), "NaN in y_train"
            assert not split.y_val.isna().any(), "NaN in y_val"

    def test_primary_split_is_last(self, sample_series):
        bundle = build_timeseries_dataset(sample_series, n_folds=2, val_days=7)
        assert bundle.primary_split is bundle.splits[-1]

    def test_meta_dict_serializable(self, sample_series):
        bundle = build_timeseries_dataset(sample_series, n_folds=2, val_days=7)
        meta = bundle.to_meta_dict()
        assert meta["builder_version"] == DATASET_BUILDER_VERSION
        assert meta["n_folds"] == bundle.n_folds
        assert "feature_spec" in meta
        assert "splits" in meta

    def test_feature_spec_in_bundle(self, sample_series):
        bundle = build_timeseries_dataset(sample_series)
        spec = bundle.feature_spec
        assert spec.feature_version
        assert spec.columns_hash
        assert len(spec.feature_columns) == spec.num_features

    def test_quality_report_populated(self, sample_series):
        bundle = build_timeseries_dataset(sample_series, clean=True)
        assert bundle.quality_report is not None
        assert "original_count" in bundle.quality_report

    def test_clean_false_skips_validation(self, sample_series):
        bundle = build_timeseries_dataset(sample_series, clean=False)
        assert bundle.quality_report is None


# ---------------------------------------------------------------------------
# Walk-forward leakage prevention
# ---------------------------------------------------------------------------

class TestWalkForwardLeakage:
    def test_val_dates_strictly_after_train(self, sample_series):
        bundle = build_timeseries_dataset(sample_series, n_folds=3, val_days=7)
        for split in bundle.splits:
            assert split.train_dates[-1] < split.val_dates[0], (
                f"Fold {split.fold_index}: train end {split.train_dates[-1]} "
                f">= val start {split.val_dates[0]}"
            )

    def test_folds_expand_monotonically(self, sample_series):
        bundle = build_timeseries_dataset(sample_series, n_folds=3, val_days=7)
        if bundle.n_folds >= 2:
            for i in range(1, bundle.n_folds):
                assert bundle.splits[i].train_size >= bundle.splits[i - 1].train_size

    def test_val_sets_non_overlapping(self, sample_series):
        bundle = build_timeseries_dataset(sample_series, n_folds=3, val_days=7)
        if bundle.n_folds >= 2:
            for i in range(1, bundle.n_folds):
                prev_val_end = bundle.splits[i - 1].val_dates[-1]
                curr_val_start = bundle.splits[i].val_dates[0]
                assert prev_val_end < curr_val_start

    def test_val_size_equals_val_days(self, sample_series):
        bundle = build_timeseries_dataset(sample_series, n_folds=2, val_days=7)
        for split in bundle.splits:
            assert split.val_size == 7


# ---------------------------------------------------------------------------
# Determinism
# ---------------------------------------------------------------------------

class TestDeterminism:
    def test_same_input_same_fingerprint(self, sample_series):
        b1 = build_timeseries_dataset(sample_series, n_folds=2, val_days=7)
        b2 = build_timeseries_dataset(sample_series, n_folds=2, val_days=7)
        assert b1.dataset_fingerprint == b2.dataset_fingerprint

    def test_same_input_same_splits(self, sample_series):
        b1 = build_timeseries_dataset(sample_series, n_folds=2, val_days=7)
        b2 = build_timeseries_dataset(sample_series, n_folds=2, val_days=7)
        for s1, s2 in zip(b1.splits, b2.splits):
            pd.testing.assert_frame_equal(s1.X_train, s2.X_train)
            pd.testing.assert_series_equal(s1.y_train, s2.y_train)
            pd.testing.assert_frame_equal(s1.X_val, s2.X_val)
            pd.testing.assert_series_equal(s1.y_val, s2.y_val)


# ---------------------------------------------------------------------------
# Fingerprint sensitivity
# ---------------------------------------------------------------------------

class TestFingerprintChanges:
    def test_different_val_days_different_fingerprint(self, sample_series):
        b1 = build_timeseries_dataset(sample_series, n_folds=2, val_days=7)
        b2 = build_timeseries_dataset(sample_series, n_folds=2, val_days=14)
        assert b1.dataset_fingerprint != b2.dataset_fingerprint

    def test_different_folds_different_fingerprint(self, sample_series):
        b1 = build_timeseries_dataset(sample_series, n_folds=1, val_days=7)
        b2 = build_timeseries_dataset(sample_series, n_folds=2, val_days=7)
        assert b1.dataset_fingerprint != b2.dataset_fingerprint

    def test_different_data_different_fingerprint(self):
        np.random.seed(42)
        dates = pd.date_range("2025-01-01", periods=90, freq="D")
        s1 = SalesSeries(dates=dates.tolist(), values=[50.0] * 90, sku="A")
        s2 = SalesSeries(dates=dates.tolist(), values=[60.0] * 90, sku="A")
        b1 = build_timeseries_dataset(s1, n_folds=1, val_days=7)
        b2 = build_timeseries_dataset(s2, n_folds=1, val_days=7)
        assert b1.dataset_fingerprint != b2.dataset_fingerprint


# ---------------------------------------------------------------------------
# FeatureSpec
# ---------------------------------------------------------------------------

class TestFeatureSpec:
    def test_compatible_specs_pass(self):
        fe = FeatureEngineer()
        s1 = FeatureSpec.from_feature_engineer(fe)
        s2 = FeatureSpec.from_feature_engineer(fe)
        s1.assert_compatible(s2)  # should not raise

    def test_incompatible_hash_raises(self):
        s1 = FeatureSpec("v3", "abc123", ("a", "b"), 2)
        s2 = FeatureSpec("v3", "xyz789", ("a", "c"), 2)
        with pytest.raises(ValueError, match="mismatch"):
            s1.assert_compatible(s2)

    def test_to_dict_round_trip(self):
        fe = FeatureEngineer()
        spec = FeatureSpec.from_feature_engineer(fe)
        d = spec.to_dict()
        assert d["feature_version"] == spec.feature_version
        assert d["columns_hash"] == spec.columns_hash
        assert d["feature_columns"] == list(spec.feature_columns)
        assert d["num_features"] == spec.num_features

    def test_frozen_immutable(self):
        fe = FeatureEngineer()
        spec = FeatureSpec.from_feature_engineer(fe)
        with pytest.raises(AttributeError):
            spec.feature_version = "changed"


# ---------------------------------------------------------------------------
# validate_feature_spec
# ---------------------------------------------------------------------------

class TestValidateFeatureSpec:
    def test_valid_dataframe_passes(self, sample_series):
        bundle = build_timeseries_dataset(sample_series, n_folds=1, val_days=7)
        split = bundle.primary_split
        validate_feature_spec(bundle.feature_spec, split.X_train)  # should not raise

    def test_wrong_columns_raises(self):
        fe = FeatureEngineer()
        spec = FeatureSpec.from_feature_engineer(fe)
        bad_df = pd.DataFrame({"wrong_col": [1, 2, 3]})
        with pytest.raises(ValueError):
            validate_feature_spec(spec, bad_df)


# ---------------------------------------------------------------------------
# Insufficient data
# ---------------------------------------------------------------------------

class TestInsufficientData:
    def test_short_series_raises(self, short_series):
        with pytest.raises(ValueError, match="Insufficient"):
            build_timeseries_dataset(short_series, min_train_rows=30, val_days=7)

    def test_borderline_series_single_fold(self):
        """A series with exactly enough data should produce 1 fold."""
        np.random.seed(42)
        n = 68  # 30 warmup + 30 min_train + 7 val + 1 buffer
        dates = pd.date_range("2025-01-01", periods=n, freq="D")
        series = SalesSeries(
            dates=dates.tolist(),
            values=(50 + np.random.normal(0, 2, n)).clip(0).tolist(),
            sku="BORDER",
        )
        bundle = build_timeseries_dataset(
            series, n_folds=3, val_days=7, min_train_rows=30, warmup_rows=30
        )
        assert bundle.n_folds >= 1
