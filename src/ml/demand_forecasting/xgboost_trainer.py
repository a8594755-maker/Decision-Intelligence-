import pandas as pd
try:
    import xgboost as xgb
except ImportError:
    xgb = None
try:
    from sklearn.model_selection import train_test_split
except ImportError:
    train_test_split = None
try:
    from .feature_engineer import FeatureEngineer
except ImportError:
    FeatureEngineer = None
from .erp_connector import ERPConnector
try:
    import joblib
except ImportError:
    joblib = None
import json
import os


class XGBoostTrainer:
    """
    XGBoost model trainer for structured-feature demand forecasting.
    Mirrors LightGBMTrainer interface for drop-in compatibility.
    """
    def __init__(self, config_path="config/xgboost_config.json"):
        self.config = self._load_config(config_path)
        self.feature_engineer = FeatureEngineer() if FeatureEngineer else None

    def _load_config(self, path):
        try:
            with open(path) as f:
                return json.load(f)
        except FileNotFoundError:
            return {
                "objective": "reg:squarederror",
                "eval_metric": "mape",
                "max_depth": 6,
                "learning_rate": 0.05,
                "subsample": 0.8,
                "colsample_bytree": 0.9,
                "n_estimators": 1000,
            }

    def train(self, sku, erp_connector):
        if xgb is None:
            raise ImportError("xgboost is not installed. Install with: pip install xgboost")

        sales_data = erp_connector.fetch_sales_data(sku)
        df = pd.DataFrame(sales_data)

        df = self.feature_engineer.create_features(df)

        X = df.drop(['sales', 'date'], axis=1)
        y = df['sales']

        X_train, X_val, y_train, y_val = train_test_split(
            X, y, test_size=0.2, random_state=42
        )

        n_estimators = self.config.pop("n_estimators", 1000)
        model = xgb.XGBRegressor(
            **self.config,
            n_estimators=n_estimators,
            early_stopping_rounds=50,
        )
        model.fit(
            X_train, y_train,
            eval_set=[(X_val, y_val)],
            verbose=False,
        )
        return model

    def save_model(self, model, sku, version="1.0"):
        model_dir = f"models/xgboost/{sku}"
        os.makedirs(model_dir, exist_ok=True)
        model_path = f"{model_dir}/v{version}.pkl"
        joblib.dump(model, model_path)
        return model_path
