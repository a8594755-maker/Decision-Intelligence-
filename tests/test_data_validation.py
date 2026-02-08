"""
P0-2.1: Unit tests for data_validation.py
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

import pytest
import pandas as pd
import numpy as np
from ml.demand_forecasting.data_contract import SalesSeries
from ml.demand_forecasting.data_validation import validate_and_clean_series, quick_validate


class TestValidateCleanSeries:
    def _make_series(self, dates, values, sku='TEST'):
        return SalesSeries(dates=[pd.Timestamp(d) for d in dates], values=values, sku=sku)

    def test_clean_data_passes_through(self):
        dates = pd.date_range('2025-01-01', periods=30, freq='D')
        values = [50.0 + i for i in range(30)]
        s = SalesSeries(dates=dates.tolist(), values=values)
        cleaned, report = validate_and_clean_series(s)
        assert cleaned.n == 30
        assert report.is_clean
        assert report.missing_dates_filled == 0

    def test_fills_missing_dates_with_zero(self):
        """缺日補 0"""
        dates = [pd.Timestamp('2025-01-01'), pd.Timestamp('2025-01-03'), pd.Timestamp('2025-01-05')]
        values = [10.0, 30.0, 50.0]
        s = self._make_series(dates, values)
        cleaned, report = validate_and_clean_series(s, fill_strategy='zero')
        assert cleaned.n == 5  # 1,2,3,4,5
        assert report.missing_dates_filled == 2
        # 補的日期值為 0
        assert cleaned.values[1] == 0.0  # Jan 2
        assert cleaned.values[3] == 0.0  # Jan 4

    def test_fills_missing_dates_with_ffill(self):
        """缺日前向填充"""
        dates = [pd.Timestamp('2025-01-01'), pd.Timestamp('2025-01-03')]
        values = [10.0, 30.0]
        s = self._make_series(dates, values)
        cleaned, report = validate_and_clean_series(
            s, fill_strategy='ffill', reject_non_daily=False, min_points=2
        )
        assert cleaned.n == 3
        assert cleaned.values[1] == 10.0  # ffill from Jan 1

    def test_clips_negative_values(self):
        dates = pd.date_range('2025-01-01', periods=5, freq='D')
        values = [10.0, -5.0, 20.0, -3.0, 15.0]
        s = SalesSeries(dates=dates.tolist(), values=values)
        cleaned, report = validate_and_clean_series(s)
        assert report.negative_values_clipped == 2
        assert all(v >= 0 for v in cleaned.values)

    def test_handles_nan_values(self):
        dates = pd.date_range('2025-01-01', periods=5, freq='D')
        values = [10.0, float('nan'), 20.0, float('nan'), 15.0]
        s = SalesSeries(dates=dates.tolist(), values=values)
        cleaned, report = validate_and_clean_series(s, fill_strategy='zero')
        assert not any(np.isnan(v) for v in cleaned.values)

    def test_handles_inf_values(self):
        dates = pd.date_range('2025-01-01', periods=5, freq='D')
        values = [10.0, float('inf'), 20.0, float('-inf'), 15.0]
        s = SalesSeries(dates=dates.tolist(), values=values)
        cleaned, report = validate_and_clean_series(s, fill_strategy='zero')
        assert all(np.isfinite(v) for v in cleaned.values)

    def test_detects_constant_series(self):
        dates = pd.date_range('2025-01-01', periods=10, freq='D')
        values = [42.0] * 10
        s = SalesSeries(dates=dates.tolist(), values=values)
        _, report = validate_and_clean_series(s)
        assert report.is_constant

    def test_deduplicates_dates(self):
        dates = [pd.Timestamp('2025-01-01'), pd.Timestamp('2025-01-01'), pd.Timestamp('2025-01-02')]
        values = [10.0, 5.0, 20.0]
        s = self._make_series(dates, values)
        cleaned, report = validate_and_clean_series(s)
        assert report.duplicate_dates_merged == 1
        assert cleaned.values[0] == 15.0  # sum of duplicates

    def test_too_few_points(self):
        s = SalesSeries.from_inline_history([1.0, 2.0], base_date='2025-01-01')
        _, report = validate_and_clean_series(s, min_points=3)
        assert not report.is_clean
        assert 'not enough' in report.warnings[0].lower() or '不足' in report.warnings[0]

    def test_high_missing_rate_warning(self):
        """>30% 缺失率應產生警告"""
        # 10 dates, but only provide 3 — reject_non_daily=False to allow gap filling
        dates = [pd.Timestamp('2025-01-01'), pd.Timestamp('2025-01-05'), pd.Timestamp('2025-01-10')]
        values = [10.0, 20.0, 30.0]
        s = self._make_series(dates, values)
        _, report = validate_and_clean_series(s, fill_strategy='zero', reject_non_daily=False)
        assert report.missing_dates_filled > 0
        # 7 missing out of 10 = 70% > 30%
        has_warning = any('30%' in w or '品質' in w for w in report.warnings)
        assert has_warning


class TestQuickValidate:
    def test_normal_data(self):
        result = quick_validate([10, 20, 30, 40, 50])
        assert result['n'] == 5
        assert not result['has_nan']
        assert not result['has_inf']
        assert not result['has_negative']
        assert not result['is_constant']

    def test_with_nan(self):
        result = quick_validate([10, float('nan'), 30])
        assert result['has_nan']

    def test_with_negative(self):
        result = quick_validate([10, -5, 30])
        assert result['has_negative']

    def test_constant(self):
        result = quick_validate([42, 42, 42])
        assert result['is_constant']

    def test_zero_rate(self):
        result = quick_validate([0, 0, 10, 20, 0])
        assert result['zero_rate'] == 0.6
