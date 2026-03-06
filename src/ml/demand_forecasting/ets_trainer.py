import pandas as pd
import numpy as np
try:
    from statsmodels.tsa.holtwinters import ExponentialSmoothing
except ImportError:
    ExponentialSmoothing = None
from .erp_connector import ERPConnector
try:
    import joblib
except ImportError:
    joblib = None
import os


class ETSTrainer:
    """
    Exponential Smoothing (ETS) trainer for classical time-series forecasting.
    Supports additive/multiplicative trend and seasonality via statsmodels.
    """
    def __init__(self, seasonal_periods=7):
        self.seasonal_periods = seasonal_periods

    def train(self, sku, erp_connector, seasonal_periods=None):
        if ExponentialSmoothing is None:
            raise ImportError(
                "statsmodels is not installed. Install with: pip install statsmodels"
            )

        sales_data = erp_connector.fetch_sales_data(sku)
        df = pd.DataFrame(sales_data)
        df['date'] = pd.to_datetime(df['date'])
        df = df.sort_values('date').reset_index(drop=True)

        values = df['sales'].values.astype(float)
        n = len(values)
        sp = seasonal_periods or self.seasonal_periods

        if n < sp * 2:
            # Not enough data for seasonal model — fit simple ETS
            model = ExponentialSmoothing(
                values,
                trend='add',
                seasonal=None,
            ).fit(optimized=True)
        else:
            model = ExponentialSmoothing(
                values,
                trend='add',
                seasonal='add',
                seasonal_periods=sp,
            ).fit(optimized=True)

        return model

    def save_model(self, model, sku, version="1.0"):
        model_dir = f"models/ets/{sku}"
        os.makedirs(model_dir, exist_ok=True)
        model_path = f"{model_dir}/v{version}.pkl"
        joblib.dump(model, model_path)
        return model_path
