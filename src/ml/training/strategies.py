"""
PR-B: Training Strategies
─────────────────────────
Each strategy implements fit/predict/serialize/load for one model type.
All strategies consume DatasetBundle and produce artifacts via ArtifactManager.
"""
import json
import logging
import os
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

from ml.demand_forecasting.feature_engineer import (
    FEATURE_COLUMNS,
    FeatureEngineer,
)

from .dataset_builder import DatasetBundle
from .evaluation import EvalMetrics, compute_metrics

logger = logging.getLogger(__name__)


@dataclass
class TrainedModel:
    """Container for a trained model + metadata."""

    model_name: str
    model_obj: Any
    config: Dict
    train_metrics: EvalMetrics
    val_metrics: EvalMetrics
    feature_spec: Dict = field(default_factory=dict)
    extra: Dict = field(default_factory=dict)


class TrainingStrategy(ABC):
    """Base class for model training strategies."""

    name: str = "base"

    @abstractmethod
    def fit(self, bundle: DatasetBundle, config: Dict) -> TrainedModel:
        """Train model on bundle, return TrainedModel."""

    @abstractmethod
    def predict(self, model_obj: Any, history: List[float],
                horizon: int, dates: Optional[List] = None) -> np.ndarray:
        """Generate point predictions from a trained model."""

    def predict_quantiles(
        self, model_obj: Any, history: List[float],
        horizon: int, dates: Optional[List] = None,
    ) -> Dict[str, np.ndarray]:
        """
        Generate quantile predictions. Default: None (not supported).
        Strategies that support quantiles override this.
        Returns dict with keys 'p10', 'p50', 'p90'.
        """
        p50 = self.predict(model_obj, history, horizon, dates)
        return {"p50": p50}


class LightGBMStrategy(TrainingStrategy):
    """LightGBM training strategy with recursive forecasting."""

    name = "lightgbm"

    def fit(self, bundle: DatasetBundle, config: Dict) -> TrainedModel:
        import lightgbm as lgb

        seed = config.get("seed", 42)
        params = {
            "boosting_type": "gbdt",
            "objective": "regression",
            "metric": "mape",
            "num_leaves": config.get("num_leaves", 31),
            "learning_rate": config.get("learning_rate", 0.05),
            "feature_fraction": config.get("feature_fraction", 0.9),
            "bagging_fraction": config.get("bagging_fraction", 0.8),
            "bagging_freq": config.get("bagging_freq", 5),
            "verbose": -1,
            "seed": seed,
            "deterministic": True,
            "force_row_wise": True,
        }

        train_data = lgb.Dataset(
            bundle.X_train, label=bundle.y_train,
            feature_name=list(bundle.feature_columns),
        )
        val_data = lgb.Dataset(
            bundle.X_val, label=bundle.y_val,
            reference=train_data,
        )

        num_boost_round = config.get("num_boost_round", 500)
        early_stopping = config.get("early_stopping", 30)

        model = lgb.train(
            params,
            train_data,
            valid_sets=[val_data],
            valid_names=["valid"],
            num_boost_round=num_boost_round,
            callbacks=[
                lgb.early_stopping(early_stopping),
                lgb.log_evaluation(0),
            ],
        )

        # --- compute metrics ---
        y_pred_train = model.predict(bundle.X_train)
        train_metrics = compute_metrics(
            bundle.y_train.values, y_pred_train, eval_mode="train"
        )

        y_pred_val = model.predict(bundle.X_val)
        val_metrics = compute_metrics(
            bundle.y_val.values, y_pred_val, eval_mode="holdout"
        )

        fe = FeatureEngineer()
        feature_spec = {
            **fe.get_meta(),
            "model_feature_names": model.feature_name(),
        }

        return TrainedModel(
            model_name=self.name,
            model_obj=model,
            config={**params, "num_boost_round": num_boost_round,
                    "best_iteration": model.best_iteration},
            train_metrics=train_metrics,
            val_metrics=val_metrics,
            feature_spec=feature_spec,
            extra={
                "feature_importance": dict(
                    zip(
                        FEATURE_COLUMNS,
                        [int(x) for x in model.feature_importance(importance_type="gain")],
                    )
                ),
            },
        )

    def predict(self, model_obj: Any, history: List[float],
                horizon: int, dates: Optional[List] = None) -> np.ndarray:
        """Recursive forecasting: re-feed predictions as history."""
        fe = FeatureEngineer()
        current_history = list(history)

        if dates and len(dates) > 0:
            next_date = pd.Timestamp(dates[-1]) + pd.Timedelta(days=1)
        else:
            next_date = pd.Timestamp.now().normalize() + pd.Timedelta(days=1)

        try:
            model_features = model_obj.feature_name()
        except Exception:
            model_features = FEATURE_COLUMNS

        predictions = []
        for _ in range(horizon):
            X_next = fe.build_next_day_features(current_history, next_date)
            X_next = X_next[model_features]
            pred = float(model_obj.predict(X_next)[0])
            pred = max(0, pred)
            predictions.append(pred)
            current_history.append(pred)
            next_date += pd.Timedelta(days=1)

        return np.array(predictions)


class ProphetStrategy(TrainingStrategy):
    """Prophet training strategy."""

    name = "prophet"

    def fit(self, bundle: DatasetBundle, config: Dict) -> TrainedModel:
        from prophet import Prophet
        from prophet.serialize import model_to_json

        train_series = bundle.train_series
        if train_series is None:
            raise ValueError("ProphetStrategy requires train_series in bundle")

        prophet_df = train_series.to_prophet_df()

        m = Prophet(
            yearly_seasonality=config.get("yearly_seasonality", True),
            weekly_seasonality=config.get("weekly_seasonality", True),
            daily_seasonality=config.get("daily_seasonality", False),
            changepoint_prior_scale=config.get("changepoint_prior_scale", 0.05),
            seasonality_prior_scale=config.get("seasonality_prior_scale", 10.0),
        )
        m.fit(prophet_df)

        # --- train metrics ---
        train_forecast = m.predict(prophet_df)
        y_pred_train = train_forecast["yhat"].values
        y_pred_train = np.maximum(y_pred_train, 0)
        train_metrics = compute_metrics(
            np.array(train_series.values), y_pred_train, eval_mode="train"
        )

        # --- val metrics ---
        val_series = bundle.val_series
        if val_series and val_series.n > 0:
            future = m.make_future_dataframe(periods=val_series.n)
            val_forecast = m.predict(future)
            y_pred_val = val_forecast.tail(val_series.n)["yhat"].values
            y_pred_val = np.maximum(y_pred_val, 0)

            lower_10 = val_forecast.tail(val_series.n)["yhat_lower"].values
            upper_90 = val_forecast.tail(val_series.n)["yhat_upper"].values

            val_metrics = compute_metrics(
                np.array(val_series.values), y_pred_val,
                lower_10=lower_10, upper_90=upper_90,
                eval_mode="holdout",
            )
        else:
            val_metrics = EvalMetrics(eval_mode="holdout")

        fe = FeatureEngineer()
        feature_spec = {
            **fe.get_meta(),
            "prophet_components": ["trend", "yearly", "weekly"],
        }

        return TrainedModel(
            model_name=self.name,
            model_obj=m,
            config={
                "yearly_seasonality": config.get("yearly_seasonality", True),
                "weekly_seasonality": config.get("weekly_seasonality", True),
                "daily_seasonality": config.get("daily_seasonality", False),
                "changepoint_prior_scale": config.get("changepoint_prior_scale", 0.05),
                "seasonality_prior_scale": config.get("seasonality_prior_scale", 10.0),
            },
            train_metrics=train_metrics,
            val_metrics=val_metrics,
            feature_spec=feature_spec,
        )

    def predict(self, model_obj: Any, history: List[float],
                horizon: int, dates: Optional[List] = None) -> np.ndarray:
        future = model_obj.make_future_dataframe(periods=horizon)
        forecast = model_obj.predict(future)
        y_pred = forecast.tail(horizon)["yhat"].values
        return np.maximum(y_pred, 0)

    def predict_quantiles(
        self, model_obj: Any, history: List[float],
        horizon: int, dates: Optional[List] = None,
    ) -> Dict[str, np.ndarray]:
        future = model_obj.make_future_dataframe(periods=horizon)
        forecast = model_obj.predict(future)
        tail = forecast.tail(horizon)
        return {
            "p10": np.maximum(tail["yhat_lower"].values, 0),
            "p50": np.maximum(tail["yhat"].values, 0),
            "p90": np.maximum(tail["yhat_upper"].values, 0),
        }


class ChronosStrategy(TrainingStrategy):
    """
    Chronos strategy — zero-shot, no fitting needed.
    Included for completeness in the orchestrator; fit() is a no-op.
    """

    name = "chronos"

    def fit(self, bundle: DatasetBundle, config: Dict) -> TrainedModel:
        """
        Chronos is zero-shot. 'fit' just evaluates on val set.
        The model_obj is the raw train series values (used for predict).
        """
        train_series = bundle.train_series
        if train_series is None:
            raise ValueError("ChronosStrategy requires train_series in bundle")

        # Evaluate on val set using statistical simulation
        val_series = bundle.val_series
        train_values = train_series.values
        val_metrics = EvalMetrics(eval_mode="holdout")

        if val_series and val_series.n > 0:
            preds = self.predict(
                train_values, train_values, val_series.n,
            )
            val_metrics = compute_metrics(
                np.array(val_series.values), preds, eval_mode="holdout",
            )

        return TrainedModel(
            model_name=self.name,
            model_obj={"train_values": train_values,
                        "model_type": "chronos-zero-shot"},
            config=config,
            train_metrics=EvalMetrics(eval_mode="train"),
            val_metrics=val_metrics,
            feature_spec={"type": "chronos-zero-shot", "no_features": True},
        )

    def predict(self, model_obj: Any, history: List[float],
                horizon: int, dates: Optional[List] = None) -> np.ndarray:
        """Statistical simulation (matches ChronosStrategy in forecaster_factory)."""
        arr = np.array(history)
        n = len(arr)
        mean_val = float(np.mean(arr))
        std_val = float(np.std(arr)) if n > 1 else mean_val * 0.2

        if n >= 5:
            recent_momentum = (arr[-1] - arr[-min(5, n)]) / min(5, n)
        else:
            recent_momentum = 0

        # Deterministic mode for training evaluation (no random noise)
        predictions = [
            max(0, mean_val + recent_momentum * (i + 1))
            for i in range(horizon)
        ]
        return np.array(predictions)


# --- Strategy registry ---
STRATEGY_REGISTRY: Dict[str, TrainingStrategy] = {
    "lightgbm": LightGBMStrategy(),
    "prophet": ProphetStrategy(),
    "chronos": ChronosStrategy(),
}


def get_strategy(name: str) -> TrainingStrategy:
    name_lower = name.lower()
    if name_lower not in STRATEGY_REGISTRY:
        raise ValueError(
            f"Unknown strategy '{name}'. Available: {list(STRATEGY_REGISTRY)}"
        )
    return STRATEGY_REGISTRY[name_lower]
