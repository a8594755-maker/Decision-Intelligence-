"""
P0-2.1: Unit tests for data_contract.py
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

import pytest
import pandas as pd
import numpy as np
from ml.demand_forecasting.data_contract import SalesSeries, DataQualityReport


class TestSalesSeriesCreation:
    def test_basic_creation(self):
        dates = pd.date_range('2025-01-01', periods=10, freq='D')
        values = [float(i) for i in range(10)]
        s = SalesSeries(dates=dates.tolist(), values=values, sku='TEST-001')
        assert s.n == 10
        assert s.sku == 'TEST-001'

    def test_length_mismatch_raises(self):
        with pytest.raises(ValueError, match="same length"):
            SalesSeries(dates=[pd.Timestamp('2025-01-01')], values=[1.0, 2.0])

    def test_empty_series(self):
        s = SalesSeries(dates=[], values=[])
        assert s.n == 0
        with pytest.raises(ValueError):
            _ = s.last_date


class TestSalesSeriesDates:
    def setup_method(self):
        self.dates = pd.date_range('2025-03-01', periods=30, freq='D')
        self.values = [50.0 + i for i in range(30)]
        self.series = SalesSeries(dates=self.dates.tolist(), values=self.values, sku='SKU-A')

    def test_last_date(self):
        assert self.series.last_date == pd.Timestamp('2025-03-30')

    def test_next_date(self):
        """P0-1.1 核心驗收：next_date = 歷史最後日 + 1"""
        assert self.series.next_date == pd.Timestamp('2025-03-31')

    def test_start_date(self):
        assert self.series.start_date == pd.Timestamp('2025-03-01')

    def test_date_range_str(self):
        assert '2025-03-01' in self.series.date_range_str
        assert '2025-03-30' in self.series.date_range_str


class TestSalesSeriesFromInlineHistory:
    def test_with_base_date(self):
        s = SalesSeries.from_inline_history([10, 20, 30], base_date='2025-06-01')
        assert s.start_date == pd.Timestamp('2025-06-01')
        assert s.last_date == pd.Timestamp('2025-06-03')
        assert s.next_date == pd.Timestamp('2025-06-04')

    def test_with_last_date(self):
        s = SalesSeries.from_inline_history([10, 20, 30], last_date='2025-06-10')
        assert s.last_date == pd.Timestamp('2025-06-10')
        assert s.next_date == pd.Timestamp('2025-06-11')
        assert s.n == 3

    def test_fallback_no_dates(self):
        """若都不提供，fallback 到今天（可能不正確但不崩）"""
        s = SalesSeries.from_inline_history([10, 20, 30])
        assert s.n == 3
        assert s.last_date == pd.Timestamp.now().normalize()


class TestSalesSeriesSplit:
    def test_split(self):
        dates = pd.date_range('2025-01-01', periods=100, freq='D')
        values = list(range(100))
        s = SalesSeries(dates=dates.tolist(), values=[float(v) for v in values])
        train, test = s.split(test_days=7)
        assert train.n == 93
        assert test.n == 7
        assert train.last_date + pd.Timedelta(days=1) == test.start_date

    def test_split_too_large_raises(self):
        s = SalesSeries.from_inline_history([1, 2, 3], base_date='2025-01-01')
        with pytest.raises(ValueError):
            s.split(test_days=5)


class TestSalesSeriesAppendPrediction:
    def test_append(self):
        s = SalesSeries.from_inline_history([10, 20, 30], base_date='2025-01-01')
        assert s.n == 3
        s.append_prediction(40.0)
        assert s.n == 4
        assert s.values[-1] == 40.0
        assert s.last_date == pd.Timestamp('2025-01-04')


class TestSalesSeriesConversion:
    def test_to_dataframe(self):
        s = SalesSeries.from_inline_history([10, 20], base_date='2025-01-01')
        df = s.to_dataframe()
        assert list(df.columns) == ['date', 'sales']
        assert len(df) == 2

    def test_to_prophet_df(self):
        s = SalesSeries.from_inline_history([10, 20], base_date='2025-01-01')
        df = s.to_prophet_df()
        assert list(df.columns) == ['ds', 'y']

    def test_from_dataframe(self):
        df = pd.DataFrame({
            'date': pd.date_range('2025-05-01', periods=5),
            'sales': [1, 2, 3, 4, 5]
        })
        s = SalesSeries.from_dataframe(df, sku='DF-TEST')
        assert s.n == 5
        assert s.sku == 'DF-TEST'


class TestSalesSeriesSummary:
    def test_summary(self):
        s = SalesSeries.from_inline_history([10, 20, 30, 40, 50], base_date='2025-01-01')
        summary = s.summary()
        assert summary['n'] == 5
        assert summary['mean'] == 30.0
        assert summary['min'] == 10.0
        assert summary['max'] == 50.0

    def test_fingerprint_deterministic(self):
        s1 = SalesSeries.from_inline_history([10, 20, 30], base_date='2025-01-01', sku='X')
        s2 = SalesSeries.from_inline_history([10, 20, 30], base_date='2025-01-01', sku='X')
        assert s1.fingerprint() == s2.fingerprint()

    def test_fingerprint_differs(self):
        s1 = SalesSeries.from_inline_history([10, 20, 30], base_date='2025-01-01', sku='X')
        s2 = SalesSeries.from_inline_history([10, 20, 31], base_date='2025-01-01', sku='X')
        assert s1.fingerprint() != s2.fingerprint()


class TestDataQualityReport:
    def test_defaults(self):
        r = DataQualityReport()
        assert r.is_clean
        assert r.missing_rate == 0.0

    def test_with_warnings(self):
        r = DataQualityReport(
            original_count=100, cleaned_count=110,
            missing_dates_filled=10, warnings=["test warning"]
        )
        assert not r.is_clean
        assert r.missing_rate == pytest.approx(10 / 110, abs=0.001)
        d = r.to_dict()
        assert d['missing_dates_filled'] == 10
