"""
P0-2.1: Unit tests for feature_engineer.py
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

import pytest
import pandas as pd
import numpy as np
from ml.demand_forecasting.feature_engineer import (
    FeatureEngineer, FEATURE_COLUMNS, FEATURE_VERSION, COLUMNS_HASH
)


@pytest.fixture
def fe():
    return FeatureEngineer()


@pytest.fixture
def sample_df():
    """60 天日頻銷量 DataFrame"""
    np.random.seed(42)
    dates = pd.date_range('2025-01-01', periods=60, freq='D')
    sales = 50 + 5 * np.sin(np.arange(60) * 2 * np.pi / 7) + np.random.normal(0, 3, 60)
    return pd.DataFrame({'date': dates, 'sales': sales.round(1)})


class TestCreateFeatures:
    def test_output_contains_feature_columns(self, fe, sample_df):
        result = fe.create_features(sample_df)
        for col in FEATURE_COLUMNS:
            assert col in result.columns, f"Missing feature column: {col}"

    def test_no_nan_in_features(self, fe, sample_df):
        result = fe.create_features(sample_df)
        for col in FEATURE_COLUMNS:
            assert not result[col].isna().any(), f"NaN found in {col}"

    def test_no_inf_in_features(self, fe, sample_df):
        result = fe.create_features(sample_df)
        for col in FEATURE_COLUMNS:
            vals = result[col].values
            assert np.all(np.isfinite(vals)), f"Inf found in {col}"

    def test_date_sorted(self, fe, sample_df):
        # Shuffle input
        shuffled = sample_df.sample(frac=1, random_state=99)
        result = fe.create_features(shuffled)
        dates = result['date'].values
        assert all(dates[i] <= dates[i+1] for i in range(len(dates)-1))

    def test_calendar_features_range(self, fe, sample_df):
        result = fe.create_features(sample_df)
        assert result['day_of_week'].between(0, 6).all()
        assert result['day_of_month'].between(1, 31).all()
        assert result['month'].between(1, 12).all()
        assert result['week_of_year'].between(1, 53).all()

    def test_cyclical_encoding_range(self, fe, sample_df):
        result = fe.create_features(sample_df)
        for col in ['month_sin', 'month_cos', 'dow_sin', 'dow_cos']:
            assert result[col].between(-1, 1).all(), f"{col} out of [-1, 1]"


class TestCreateTrainingData:
    def test_output_shape(self, fe, sample_df):
        X, y = fe.create_training_data(sample_df, min_rows=30)
        assert len(X) == len(y)
        assert len(X) > 0
        assert list(X.columns) == FEATURE_COLUMNS

    def test_warmup_rows_discarded(self, fe, sample_df):
        X1, _ = fe.create_training_data(sample_df, min_rows=10)
        X2, _ = fe.create_training_data(sample_df, min_rows=20)
        assert len(X1) > len(X2)

    def test_no_nan_after_warmup(self, fe, sample_df):
        X, y = fe.create_training_data(sample_df, min_rows=30)
        assert not X.isna().any().any()
        assert not y.isna().any()


class TestBuildNextDayFeatures:
    def test_single_row_output(self, fe):
        history = [50.0 + i * 0.5 for i in range(60)]
        next_date = pd.Timestamp('2025-03-02')
        X = fe.build_next_day_features(history, next_date)
        assert X.shape == (1, len(FEATURE_COLUMNS))
        assert list(X.columns) == FEATURE_COLUMNS

    def test_no_nan(self, fe):
        history = [50.0] * 60
        X = fe.build_next_day_features(history, pd.Timestamp('2025-04-15'))
        assert not X.isna().any().any()

    def test_lag_values_correct(self, fe):
        """手算驗證 lag 值"""
        history = list(range(1, 31))  # [1, 2, ..., 30]
        X = fe.build_next_day_features(history, pd.Timestamp('2025-02-01'))
        assert X['lag_1'].values[0] == 30   # last value
        assert X['lag_7'].values[0] == 24   # 30 - 7 + 1 = 24th value
        assert X['lag_14'].values[0] == 17  # 30 - 14 + 1 = 17th value
        assert X['lag_30'].values[0] == 1   # first value

    def test_rolling_mean_correct(self, fe):
        """手算驗證 rolling mean"""
        history = [10.0] * 30
        X = fe.build_next_day_features(history, pd.Timestamp('2025-02-01'))
        assert X['rolling_mean_7'].values[0] == pytest.approx(10.0)
        assert X['rolling_mean_14'].values[0] == pytest.approx(10.0)
        assert X['rolling_mean_30'].values[0] == pytest.approx(10.0)

    def test_short_history_no_crash(self, fe):
        """短歷史不應崩潰"""
        history = [10.0, 20.0, 30.0]
        X = fe.build_next_day_features(history, pd.Timestamp('2025-01-04'))
        assert X.shape == (1, len(FEATURE_COLUMNS))
        assert not X.isna().any().any()

    def test_calendar_matches_date(self, fe):
        """日曆特徵必須對應 next_date"""
        date = pd.Timestamp('2025-06-15')  # Sunday = 6
        history = [50.0] * 60
        X = fe.build_next_day_features(history, date)
        assert X['day_of_month'].values[0] == 15
        assert X['month'].values[0] == 6
        assert X['day_of_week'].values[0] == date.dayofweek


class TestAssertFeatureSchema:
    def test_valid_schema_passes(self, fe, sample_df):
        X, _ = fe.create_training_data(sample_df, min_rows=30)
        # Should not raise
        FeatureEngineer.assert_feature_schema(X)

    def test_missing_column_raises(self, fe, sample_df):
        X, _ = fe.create_training_data(sample_df, min_rows=30)
        X_bad = X.drop(columns=['lag_1'])
        with pytest.raises(ValueError, match="missing columns"):
            FeatureEngineer.assert_feature_schema(X_bad)

    def test_extra_column_raises(self, fe, sample_df):
        X, _ = fe.create_training_data(sample_df, min_rows=30)
        X_bad = X.copy()
        X_bad['bogus_column'] = 0
        with pytest.raises(ValueError, match="unexpected columns"):
            FeatureEngineer.assert_feature_schema(X_bad)

    def test_wrong_order_raises(self, fe, sample_df):
        X, _ = fe.create_training_data(sample_df, min_rows=30)
        X_bad = X[list(reversed(FEATURE_COLUMNS))]
        with pytest.raises(ValueError, match="order mismatch"):
            FeatureEngineer.assert_feature_schema(X_bad)

    def test_nan_raises(self):
        data = {col: [1.0] for col in FEATURE_COLUMNS}
        data['lag_1'] = [float('nan')]
        X = pd.DataFrame(data)[FEATURE_COLUMNS]
        with pytest.raises(ValueError, match="NaN"):
            FeatureEngineer.assert_feature_schema(X)

    def test_inf_raises(self):
        data = {col: [1.0] for col in FEATURE_COLUMNS}
        data['ewm_7'] = [float('inf')]
        X = pd.DataFrame(data)[FEATURE_COLUMNS]
        with pytest.raises(ValueError, match="Inf"):
            FeatureEngineer.assert_feature_schema(X)


class TestFeatureVersioning:
    def test_version_exists(self, fe):
        assert fe.version == FEATURE_VERSION
        assert fe.columns_hash == COLUMNS_HASH

    def test_get_meta(self, fe):
        meta = fe.get_meta()
        assert meta['feature_version'] == FEATURE_VERSION
        assert meta['columns_hash'] == COLUMNS_HASH
        assert meta['feature_columns'] == FEATURE_COLUMNS
        assert meta['num_features'] == len(FEATURE_COLUMNS)

    def test_hash_changes_with_columns(self):
        """如果 FEATURE_COLUMNS 被篡改，hash 應該不同"""
        import hashlib
        altered = FEATURE_COLUMNS.copy()
        altered.append('fake_feature')
        altered_hash = hashlib.md5("|".join(altered).encode()).hexdigest()[:12]
        assert altered_hash != COLUMNS_HASH
