"""
Optuna-based Hyperparameter Optimization for LightGBM, XGBoost, and Prophet.
─────────────────────────────────────────────────────────────────────────────
Provides reusable HPO logic consumed by strategies in strategies.py
and the legacy /train-model endpoint.

Two CV modes (LightGBM/XGBoost):
  - "timeseries_cv": sklearn TimeSeriesSplit on training data only
    (holdout val set stays clean for final evaluation)
  - "holdout": uses existing bundle.X_val/y_val split directly

Prophet HPO always uses holdout mode (refit per trial).
"""
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import numpy as np

from .dataset_builder import DatasetBundle
from .evaluation import compute_metrics

logger = logging.getLogger(__name__)

# ── Default LightGBM search space ──────────────────────────────────────
# Matches the 8 hyperparameters tuned in the legacy /train-model endpoint.
DEFAULT_LGBM_SEARCH_SPACE: Dict[str, Dict[str, Any]] = {
    "learning_rate": {"type": "float", "low": 0.01, "high": 0.3, "log": True},
    "num_leaves": {"type": "int", "low": 15, "high": 127},
    "feature_fraction": {"type": "float", "low": 0.5, "high": 1.0},
    "bagging_fraction": {"type": "float", "low": 0.5, "high": 1.0},
    "bagging_freq": {"type": "int", "low": 1, "high": 10},
    "min_child_samples": {"type": "int", "low": 5, "high": 50},
    "reg_alpha": {"type": "float", "low": 1e-8, "high": 10.0, "log": True},
    "reg_lambda": {"type": "float", "low": 1e-8, "high": 10.0, "log": True},
}

# ── Default XGBoost search space ──────────────────────────────────────
DEFAULT_XGBOOST_SEARCH_SPACE: Dict[str, Dict[str, Any]] = {
    "learning_rate": {"type": "float", "low": 0.01, "high": 0.3, "log": True},
    "max_depth": {"type": "int", "low": 3, "high": 10},
    "subsample": {"type": "float", "low": 0.5, "high": 1.0},
    "colsample_bytree": {"type": "float", "low": 0.5, "high": 1.0},
    "min_child_weight": {"type": "int", "low": 1, "high": 20},
    "reg_alpha": {"type": "float", "low": 1e-8, "high": 10.0, "log": True},
    "reg_lambda": {"type": "float", "low": 1e-8, "high": 10.0, "log": True},
}

# ── Default Prophet search space ──────────────────────────────────────
DEFAULT_PROPHET_SEARCH_SPACE: Dict[str, Dict[str, Any]] = {
    "changepoint_prior_scale": {"type": "float", "low": 0.001, "high": 0.5, "log": True},
    "seasonality_prior_scale": {"type": "float", "low": 0.01, "high": 50.0, "log": True},
    "seasonality_mode": {"type": "categorical", "choices": ["additive", "multiplicative"]},
}


@dataclass
class HPOConfig:
    """Configuration for an Optuna HPO run."""

    enabled: bool = False
    n_trials: int = 30
    timeout_seconds: Optional[int] = None
    metric: str = "mape"
    direction: str = "minimize"

    # Cross-validation
    cv_n_splits: int = 3
    cv_mode: str = "timeseries_cv"  # "timeseries_cv" | "holdout"

    # Search space (empty → use DEFAULT_LGBM_SEARCH_SPACE)
    search_space: Dict[str, Any] = field(default_factory=dict)

    # Optuna sampler / pruner
    sampler: str = "tpe"  # "tpe" | "random" | "cmaes"
    pruner: str = "median"  # "median" | "hyperband" | "none"

    seed: int = 42

    def to_dict(self) -> Dict:
        return {
            "enabled": self.enabled,
            "n_trials": self.n_trials,
            "timeout_seconds": self.timeout_seconds,
            "metric": self.metric,
            "cv_n_splits": self.cv_n_splits,
            "cv_mode": self.cv_mode,
            "sampler": self.sampler,
            "seed": self.seed,
        }


@dataclass
class HPOResult:
    """Output from an Optuna HPO study."""

    best_params: Dict[str, Any]
    best_score: float
    n_trials_completed: int
    n_trials_pruned: int
    trial_history: List[Dict]
    elapsed_seconds: float
    search_space_used: Dict
    cv_mode: str

    def to_dict(self) -> Dict:
        return {
            "best_params": {
                k: round(v, 6) if isinstance(v, float) else v
                for k, v in self.best_params.items()
            },
            "best_score": round(self.best_score, 4),
            "n_trials_completed": self.n_trials_completed,
            "n_trials_pruned": self.n_trials_pruned,
            "elapsed_seconds": round(self.elapsed_seconds, 2),
            "cv_mode": self.cv_mode,
            "trial_history": self.trial_history[:10],
        }


# ── Internal helpers ───────────────────────────────────────────────────

def _suggest_params(trial, search_space: Dict[str, Dict]) -> Dict[str, Any]:
    """Translate a declarative search-space dict into Optuna suggest calls."""
    params: Dict[str, Any] = {}
    for name, spec in search_space.items():
        ptype = spec["type"]
        if ptype == "float":
            params[name] = trial.suggest_float(
                name, spec["low"], spec["high"], log=spec.get("log", False),
            )
        elif ptype == "int":
            params[name] = trial.suggest_int(
                name, spec["low"], spec["high"], log=spec.get("log", False),
            )
        elif ptype == "categorical":
            params[name] = trial.suggest_categorical(name, spec["choices"])
    return params


def _create_sampler(sampler_name: str, seed: int):
    import optuna

    if sampler_name == "random":
        return optuna.samplers.RandomSampler(seed=seed)
    if sampler_name == "cmaes":
        return optuna.samplers.CmaEsSampler(seed=seed)
    return optuna.samplers.TPESampler(seed=seed)


def _create_pruner(pruner_name: str):
    import optuna

    if pruner_name == "hyperband":
        return optuna.pruners.HyperbandPruner()
    if pruner_name == "none":
        return optuna.pruners.NopPruner()
    return optuna.pruners.MedianPruner()


# ── Public API ─────────────────────────────────────────────────────────

def run_hpo(bundle: DatasetBundle, hpo_config: HPOConfig) -> HPOResult:
    """
    Run Optuna HPO for LightGBM.

    Args:
        bundle: DatasetBundle with X_train, y_train, X_val, y_val.
        hpo_config: HPOConfig controlling trials, CV, search space, etc.

    Returns:
        HPOResult with best_params and condensed trial history.
    """
    import optuna
    import lightgbm as lgb

    optuna.logging.set_verbosity(optuna.logging.WARNING)

    t0 = time.time()
    search_space = hpo_config.search_space or DEFAULT_LGBM_SEARCH_SPACE
    feature_names = list(bundle.feature_columns)

    # ── Prepare CV folds (time-series safe) ──
    cv_folds = None
    X_all, y_all = None, None

    if hpo_config.cv_mode == "timeseries_cv":
        from sklearn.model_selection import TimeSeriesSplit

        tscv = TimeSeriesSplit(n_splits=hpo_config.cv_n_splits)
        X_all = bundle.X_train.values
        y_all = bundle.y_train.values
        cv_folds = list(tscv.split(X_all))

    def objective(trial):
        suggested = _suggest_params(trial, search_space)
        params = {
            "boosting_type": "gbdt",
            "objective": "regression",
            "metric": "mape",
            "verbose": -1,
            "feature_pre_filter": False,
            "deterministic": True,
            "force_row_wise": True,
            "seed": hpo_config.seed,
            **suggested,
        }

        if cv_folds is not None:
            # TimeSeriesSplit CV on training data only
            fold_scores = []
            for fold_idx, (train_idx, val_idx) in enumerate(cv_folds):
                X_tr, y_tr = X_all[train_idx], y_all[train_idx]
                X_va, y_va = X_all[val_idx], y_all[val_idx]

                ds_tr = lgb.Dataset(X_tr, label=y_tr, feature_name=feature_names)
                ds_va = lgb.Dataset(X_va, label=y_va, reference=ds_tr)

                model = lgb.train(
                    params, ds_tr,
                    valid_sets=[ds_va], valid_names=["cv_val"],
                    num_boost_round=500,
                    callbacks=[lgb.early_stopping(30), lgb.log_evaluation(0)],
                )

                preds = model.predict(X_va)
                metrics = compute_metrics(y_va, preds, eval_mode="cv")
                fold_scores.append(metrics.mape)

                # Report intermediate result for pruning
                trial.report(np.mean(fold_scores), fold_idx)
                if trial.should_prune():
                    raise optuna.TrialPruned()

            return float(np.mean(fold_scores))

        else:
            # Holdout mode: use bundle's existing val split
            ds_tr = lgb.Dataset(
                bundle.X_train, label=bundle.y_train,
                feature_name=feature_names,
            )
            ds_va = lgb.Dataset(
                bundle.X_val, label=bundle.y_val,
                reference=ds_tr,
            )
            model = lgb.train(
                params, ds_tr,
                valid_sets=[ds_va], valid_names=["val"],
                num_boost_round=500,
                callbacks=[lgb.early_stopping(30), lgb.log_evaluation(0)],
            )
            preds = model.predict(bundle.X_val.values)
            metrics = compute_metrics(
                bundle.y_val.values, preds, eval_mode="holdout",
            )
            return metrics.mape

    # ── Run study ──
    sampler = _create_sampler(hpo_config.sampler, hpo_config.seed)
    pruner = _create_pruner(hpo_config.pruner)

    study = optuna.create_study(
        direction=hpo_config.direction,
        sampler=sampler,
        pruner=pruner,
    )
    study.optimize(
        objective,
        n_trials=hpo_config.n_trials,
        timeout=hpo_config.timeout_seconds,
        show_progress_bar=False,
    )

    elapsed = time.time() - t0

    # ── Build trial history (completed only, sorted by score) ──
    trial_history = []
    for t in study.trials:
        if t.state.name == "COMPLETE":
            trial_history.append({
                "number": t.number,
                "value": round(t.value, 4) if t.value is not None else None,
                "params": {
                    k: round(v, 6) if isinstance(v, float) else v
                    for k, v in t.params.items()
                },
            })
    trial_history.sort(key=lambda x: x.get("value") or 999)

    n_pruned = sum(1 for t in study.trials if t.state.name == "PRUNED")

    return HPOResult(
        best_params=study.best_params,
        best_score=study.best_value,
        n_trials_completed=len(study.trials) - n_pruned,
        n_trials_pruned=n_pruned,
        trial_history=trial_history,
        elapsed_seconds=elapsed,
        search_space_used=search_space,
        cv_mode=hpo_config.cv_mode,
    )


def _build_study_result(study, search_space, cv_mode, elapsed) -> HPOResult:
    """Shared helper to build HPOResult from an Optuna study."""
    trial_history = []
    for t in study.trials:
        if t.state.name == "COMPLETE":
            trial_history.append({
                "number": t.number,
                "value": round(t.value, 4) if t.value is not None else None,
                "params": {
                    k: round(v, 6) if isinstance(v, float) else v
                    for k, v in t.params.items()
                },
            })
    trial_history.sort(key=lambda x: x.get("value") or 999)

    n_pruned = sum(1 for t in study.trials if t.state.name == "PRUNED")

    return HPOResult(
        best_params=study.best_params,
        best_score=study.best_value,
        n_trials_completed=len(study.trials) - n_pruned,
        n_trials_pruned=n_pruned,
        trial_history=trial_history,
        elapsed_seconds=elapsed,
        search_space_used=search_space,
        cv_mode=cv_mode,
    )


def run_hpo_xgboost(bundle: DatasetBundle, hpo_config: HPOConfig) -> HPOResult:
    """
    Run Optuna HPO for XGBoost.

    Same CV modes as LightGBM: "timeseries_cv" or "holdout".
    """
    import optuna

    try:
        import xgboost as xgb
    except ImportError:
        raise ImportError("xgboost is required for XGBoost HPO")

    optuna.logging.set_verbosity(optuna.logging.WARNING)

    t0 = time.time()
    search_space = hpo_config.search_space or DEFAULT_XGBOOST_SEARCH_SPACE

    cv_folds = None
    X_all, y_all = None, None

    if hpo_config.cv_mode == "timeseries_cv":
        from sklearn.model_selection import TimeSeriesSplit

        tscv = TimeSeriesSplit(n_splits=hpo_config.cv_n_splits)
        X_all = bundle.X_train.values
        y_all = bundle.y_train.values
        cv_folds = list(tscv.split(X_all))

    def objective(trial):
        suggested = _suggest_params(trial, search_space)

        if cv_folds is not None:
            fold_scores = []
            for fold_idx, (train_idx, val_idx) in enumerate(cv_folds):
                X_tr, y_tr = X_all[train_idx], y_all[train_idx]
                X_va, y_va = X_all[val_idx], y_all[val_idx]

                model = xgb.XGBRegressor(
                    objective="reg:squarederror",
                    eval_metric="mape",
                    n_estimators=500,
                    early_stopping_rounds=30,
                    random_state=hpo_config.seed,
                    verbosity=0,
                    **suggested,
                )
                model.fit(X_tr, y_tr, eval_set=[(X_va, y_va)], verbose=False)
                preds = model.predict(X_va)
                metrics = compute_metrics(y_va, preds, eval_mode="cv")
                fold_scores.append(metrics.mape)

                trial.report(np.mean(fold_scores), fold_idx)
                if trial.should_prune():
                    raise optuna.TrialPruned()

            return float(np.mean(fold_scores))
        else:
            model = xgb.XGBRegressor(
                objective="reg:squarederror",
                eval_metric="mape",
                n_estimators=500,
                early_stopping_rounds=30,
                random_state=hpo_config.seed,
                verbosity=0,
                **suggested,
            )
            model.fit(
                bundle.X_train, bundle.y_train,
                eval_set=[(bundle.X_val, bundle.y_val)],
                verbose=False,
            )
            preds = model.predict(bundle.X_val.values)
            metrics = compute_metrics(bundle.y_val.values, preds, eval_mode="holdout")
            return metrics.mape

    sampler = _create_sampler(hpo_config.sampler, hpo_config.seed)
    pruner = _create_pruner(hpo_config.pruner)

    study = optuna.create_study(
        direction=hpo_config.direction,
        sampler=sampler,
        pruner=pruner,
    )
    study.optimize(
        objective,
        n_trials=hpo_config.n_trials,
        timeout=hpo_config.timeout_seconds,
        show_progress_bar=False,
    )

    elapsed = time.time() - t0
    return _build_study_result(study, search_space, hpo_config.cv_mode, elapsed)


def run_hpo_prophet(bundle: DatasetBundle, hpo_config: HPOConfig) -> HPOResult:
    """
    Run Optuna HPO for Prophet.

    Always uses holdout mode: refit Prophet per trial, evaluate on val_series.
    """
    import optuna

    optuna.logging.set_verbosity(optuna.logging.WARNING)

    t0 = time.time()
    search_space = hpo_config.search_space or DEFAULT_PROPHET_SEARCH_SPACE

    train_series = bundle.train_series
    val_series = bundle.val_series
    if train_series is None or val_series is None or val_series.n == 0:
        raise ValueError("Prophet HPO requires train_series and val_series in bundle")

    prophet_df = train_series.to_prophet_df()
    val_actual = np.array(val_series.values)

    def objective(trial):
        from prophet import Prophet

        suggested = _suggest_params(trial, search_space)

        seasonality_mode = suggested.pop("seasonality_mode", "additive")

        m = Prophet(
            changepoint_prior_scale=suggested.get("changepoint_prior_scale", 0.05),
            seasonality_prior_scale=suggested.get("seasonality_prior_scale", 10.0),
            seasonality_mode=seasonality_mode,
            yearly_seasonality=True,
            weekly_seasonality=True,
            daily_seasonality=False,
        )
        m.fit(prophet_df)

        future = m.make_future_dataframe(periods=val_series.n)
        forecast = m.predict(future)
        y_pred = forecast.tail(val_series.n)["yhat"].values
        y_pred = np.maximum(y_pred, 0)

        metrics = compute_metrics(val_actual, y_pred, eval_mode="holdout")
        return metrics.mape

    sampler = _create_sampler(hpo_config.sampler, hpo_config.seed)
    pruner = _create_pruner("none")  # No intermediate results for Prophet

    study = optuna.create_study(
        direction=hpo_config.direction,
        sampler=sampler,
        pruner=pruner,
    )
    study.optimize(
        objective,
        n_trials=hpo_config.n_trials,
        timeout=hpo_config.timeout_seconds,
        show_progress_bar=False,
    )

    elapsed = time.time() - t0
    return _build_study_result(study, search_space, "holdout", elapsed)
