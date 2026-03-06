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

        # --- HPO: find best hyperparams if enabled ---
        hpo_report = None
        hpo_best_params: Dict = {}

        if config.get("hpo_enabled", False):
            try:
                from .hpo import HPOConfig, run_hpo

                hpo_cfg = HPOConfig(
                    enabled=True,
                    n_trials=config.get("hpo_n_trials", 30),
                    timeout_seconds=config.get("hpo_timeout_seconds"),
                    cv_n_splits=config.get("hpo_cv_splits", 3),
                    cv_mode=config.get("hpo_cv_mode", "timeseries_cv"),
                    search_space=config.get("hpo_search_space", {}),
                    sampler=config.get("hpo_sampler", "tpe"),
                    pruner=config.get("hpo_pruner", "median"),
                    seed=seed,
                )

                hpo_result = run_hpo(bundle, hpo_cfg)
                hpo_best_params = hpo_result.best_params
                hpo_report = hpo_result.to_dict()
                logger.info(
                    "HPO completed: best_score=%.4f trials=%d/%d in %.1fs",
                    hpo_result.best_score,
                    hpo_result.n_trials_completed,
                    hpo_result.n_trials_completed + hpo_result.n_trials_pruned,
                    hpo_result.elapsed_seconds,
                )
            except ImportError:
                logger.warning("Optuna not installed, skipping HPO")
                hpo_report = {"skipped": True, "reason": "optuna not installed"}
            except Exception as e:
                logger.error("HPO failed, falling back to defaults: %s", e)
                hpo_report = {"skipped": True, "reason": str(e)}

        # --- Build final params (HPO best → defaults; explicit config wins) ---
        defaults = {
            "num_leaves": 31,
            "learning_rate": 0.05,
            "feature_fraction": 0.9,
            "bagging_fraction": 0.8,
            "bagging_freq": 5,
        }
        # Apply HPO best params as new defaults
        for k, v in hpo_best_params.items():
            defaults[k] = v

        params = {
            "boosting_type": "gbdt",
            "objective": "regression",
            "metric": "mape",
            "verbose": -1,
            "seed": seed,
            "deterministic": True,
            "force_row_wise": True,
        }
        for k, v in defaults.items():
            params[k] = config.get(k, v)

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

        extra = {
            "feature_importance": dict(
                zip(
                    FEATURE_COLUMNS,
                    [int(x) for x in model.feature_importance(importance_type="gain")],
                )
            ),
        }
        if hpo_report:
            extra["hpo_report"] = hpo_report

        return TrainedModel(
            model_name=self.name,
            model_obj=model,
            config={**params, "num_boost_round": num_boost_round,
                    "best_iteration": model.best_iteration},
            train_metrics=train_metrics,
            val_metrics=val_metrics,
            feature_spec=feature_spec,
            extra=extra,
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

        seed = config.get("seed", 42)
        train_series = bundle.train_series
        if train_series is None:
            raise ValueError("ProphetStrategy requires train_series in bundle")

        prophet_df = train_series.to_prophet_df()

        # --- HPO: find best hyperparams if enabled ---
        hpo_report = None
        hpo_best_params: Dict = {}

        if config.get("hpo_enabled", False):
            try:
                from .hpo import HPOConfig, run_hpo_prophet

                hpo_cfg = HPOConfig(
                    enabled=True,
                    n_trials=config.get("hpo_n_trials", 15),
                    timeout_seconds=config.get("hpo_timeout_seconds", 300),
                    cv_mode="holdout",
                    search_space=config.get("hpo_search_space", {}),
                    sampler=config.get("hpo_sampler", "tpe"),
                    seed=seed,
                )

                hpo_result = run_hpo_prophet(bundle, hpo_cfg)
                hpo_best_params = hpo_result.best_params
                hpo_report = hpo_result.to_dict()
                logger.info(
                    "Prophet HPO completed: best_score=%.4f trials=%d in %.1fs",
                    hpo_result.best_score,
                    hpo_result.n_trials_completed,
                    hpo_result.elapsed_seconds,
                )
            except ImportError:
                logger.warning("Optuna not installed, skipping Prophet HPO")
                hpo_report = {"skipped": True, "reason": "optuna not installed"}
            except Exception as e:
                logger.error("Prophet HPO failed, falling back to defaults: %s", e)
                hpo_report = {"skipped": True, "reason": str(e)}

        # --- Build final params (HPO best → defaults; explicit config wins) ---
        defaults = {
            "changepoint_prior_scale": 0.05,
            "seasonality_prior_scale": 10.0,
        }
        for k, v in hpo_best_params.items():
            if k != "seasonality_mode":
                defaults[k] = v

        prophet_config = {
            "yearly_seasonality": config.get("yearly_seasonality", True),
            "weekly_seasonality": config.get("weekly_seasonality", True),
            "daily_seasonality": config.get("daily_seasonality", False),
        }
        for k, v in defaults.items():
            prophet_config[k] = config.get(k, v)

        seasonality_mode = hpo_best_params.get(
            "seasonality_mode",
            config.get("seasonality_mode", "additive"),
        )

        m = Prophet(
            yearly_seasonality=prophet_config["yearly_seasonality"],
            weekly_seasonality=prophet_config["weekly_seasonality"],
            daily_seasonality=prophet_config["daily_seasonality"],
            changepoint_prior_scale=prophet_config["changepoint_prior_scale"],
            seasonality_prior_scale=prophet_config["seasonality_prior_scale"],
            seasonality_mode=seasonality_mode,
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

        extra = {}
        if hpo_report:
            extra["hpo_report"] = hpo_report

        return TrainedModel(
            model_name=self.name,
            model_obj=m,
            config={**prophet_config, "seasonality_mode": seasonality_mode},
            train_metrics=train_metrics,
            val_metrics=val_metrics,
            feature_spec=feature_spec,
            extra=extra,
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


class XGBoostStrategy(TrainingStrategy):
    """XGBoost training strategy with recursive forecasting."""

    name = "xgboost"

    def fit(self, bundle: DatasetBundle, config: Dict) -> TrainedModel:
        try:
            import xgboost as xgb
        except ImportError:
            raise ImportError(
                "xgboost is not installed. Install with: pip install xgboost"
            )

        seed = config.get("seed", 42)

        # --- HPO: find best hyperparams if enabled ---
        hpo_report = None
        hpo_best_params: Dict = {}

        if config.get("hpo_enabled", False):
            try:
                from .hpo import HPOConfig, run_hpo_xgboost

                hpo_cfg = HPOConfig(
                    enabled=True,
                    n_trials=config.get("hpo_n_trials", 30),
                    timeout_seconds=config.get("hpo_timeout_seconds"),
                    cv_n_splits=config.get("hpo_cv_splits", 3),
                    cv_mode=config.get("hpo_cv_mode", "timeseries_cv"),
                    search_space=config.get("hpo_search_space", {}),
                    sampler=config.get("hpo_sampler", "tpe"),
                    pruner=config.get("hpo_pruner", "median"),
                    seed=seed,
                )

                hpo_result = run_hpo_xgboost(bundle, hpo_cfg)
                hpo_best_params = hpo_result.best_params
                hpo_report = hpo_result.to_dict()
                logger.info(
                    "XGBoost HPO completed: best_score=%.4f trials=%d in %.1fs",
                    hpo_result.best_score,
                    hpo_result.n_trials_completed,
                    hpo_result.elapsed_seconds,
                )
            except ImportError:
                logger.warning("Optuna not installed, skipping HPO")
                hpo_report = {"skipped": True, "reason": "optuna not installed"}
            except Exception as e:
                logger.error("HPO failed, falling back to defaults: %s", e)
                hpo_report = {"skipped": True, "reason": str(e)}

        defaults = {
            "max_depth": 6,
            "learning_rate": 0.05,
            "subsample": 0.8,
            "colsample_bytree": 0.9,
            "reg_alpha": 0.0,
            "reg_lambda": 1.0,
            "min_child_weight": 1,
        }
        for k, v in hpo_best_params.items():
            defaults[k] = v

        xgb_params = {}
        for k, v in defaults.items():
            xgb_params[k] = config.get(k, v)

        n_estimators = config.get("n_estimators", 1000)
        early_stopping = config.get("early_stopping", 50)

        model = xgb.XGBRegressor(
            objective="reg:squarederror",
            eval_metric="mape",
            n_estimators=n_estimators,
            early_stopping_rounds=early_stopping,
            random_state=seed,
            verbosity=0,
            **xgb_params,
        )
        model.fit(
            bundle.X_train, bundle.y_train,
            eval_set=[(bundle.X_val, bundle.y_val)],
            verbose=False,
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
            "model_feature_names": list(bundle.feature_columns),
        }

        extra = {
            "feature_importance": dict(
                zip(
                    bundle.feature_columns,
                    [float(x) for x in model.feature_importances_],
                )
            ),
        }
        if hpo_report:
            extra["hpo_report"] = hpo_report

        return TrainedModel(
            model_name=self.name,
            model_obj=model,
            config={**xgb_params, "n_estimators": n_estimators,
                    "best_iteration": model.best_iteration},
            train_metrics=train_metrics,
            val_metrics=val_metrics,
            feature_spec=feature_spec,
            extra=extra,
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

        predictions = []
        for _ in range(horizon):
            X_next = fe.build_next_day_features(current_history, next_date)
            X_next = X_next[FEATURE_COLUMNS]
            pred = float(model_obj.predict(X_next)[0])
            pred = max(0, pred)
            predictions.append(pred)
            current_history.append(pred)
            next_date += pd.Timedelta(days=1)

        return np.array(predictions)


class ETSStrategy(TrainingStrategy):
    """Exponential Smoothing (ETS) strategy via statsmodels."""

    name = "ets"

    def fit(self, bundle: DatasetBundle, config: Dict) -> TrainedModel:
        try:
            from statsmodels.tsa.holtwinters import ExponentialSmoothing
        except ImportError:
            raise ImportError(
                "statsmodels is not installed. Install with: pip install statsmodels"
            )

        train_series = bundle.train_series
        if train_series is None:
            raise ValueError("ETSStrategy requires train_series in bundle")

        values = np.array(train_series.values, dtype=float)
        n = len(values)
        sp = config.get("seasonal_periods", 7)
        trend = config.get("trend", "add")
        seasonal = config.get("seasonal", "add")

        if n < sp * 2:
            model = ExponentialSmoothing(
                values, trend=trend, seasonal=None,
            ).fit(optimized=True)
        else:
            model = ExponentialSmoothing(
                values, trend=trend, seasonal=seasonal,
                seasonal_periods=sp,
            ).fit(optimized=True)

        # --- train metrics (in-sample fitted values) ---
        fitted = model.fittedvalues
        fitted = np.maximum(fitted, 0)
        train_metrics = compute_metrics(
            values, fitted, eval_mode="train"
        )

        # --- val metrics ---
        val_series = bundle.val_series
        if val_series and val_series.n > 0:
            y_pred_val = model.forecast(val_series.n)
            y_pred_val = np.maximum(y_pred_val, 0)
            val_metrics = compute_metrics(
                np.array(val_series.values), y_pred_val, eval_mode="holdout"
            )
        else:
            val_metrics = EvalMetrics(eval_mode="holdout")

        fe = FeatureEngineer()
        feature_spec = {
            **fe.get_meta(),
            "type": "ets",
            "no_features": True,
            "ets_components": {
                "trend": trend,
                "seasonal": seasonal if n >= sp * 2 else None,
                "seasonal_periods": sp,
            },
        }

        return TrainedModel(
            model_name=self.name,
            model_obj=model,
            config={
                "trend": trend,
                "seasonal": seasonal if n >= sp * 2 else None,
                "seasonal_periods": sp,
            },
            train_metrics=train_metrics,
            val_metrics=val_metrics,
            feature_spec=feature_spec,
        )

    def predict(self, model_obj: Any, history: List[float],
                horizon: int, dates: Optional[List] = None) -> np.ndarray:
        preds = model_obj.forecast(horizon)
        return np.maximum(np.asarray(preds, dtype=float), 0)


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
    "xgboost": XGBoostStrategy(),
    "ets": ETSStrategy(),
    "chronos": ChronosStrategy(),
}


def get_strategy(name: str) -> TrainingStrategy:
    name_lower = name.lower()
    if name_lower not in STRATEGY_REGISTRY:
        raise ValueError(
            f"Unknown strategy '{name}'. Available: {list(STRATEGY_REGISTRY)}"
        )
    return STRATEGY_REGISTRY[name_lower]
