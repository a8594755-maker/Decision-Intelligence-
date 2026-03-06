"""
PR-B: AutoML Orchestrator
─────────────────────────
Runs multiple candidate models, produces a leaderboard, selects a champion,
and supports rollback.

Selection policy (deterministic):
  1. Primary metric: validation MAPE (lower is better)
  2. Tie-breaker 1: lower absolute bias
  3. Tie-breaker 2: model complexity order (lightgbm < prophet < chronos)
  4. Tie-breaker 3: alphabetical model name (stable fallback)
"""
import json
import logging
import os
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, List, Optional

from ml.demand_forecasting.data_contract import SalesSeries

from .artifact_manager import ArtifactManager
from .dataset_builder import build_dataset
from .runner import TrainingRunConfig, TrainingRunResult, train_one_series

logger = logging.getLogger(__name__)

# Model complexity order for tie-breaking (lower = simpler = preferred)
MODEL_COMPLEXITY = {"lightgbm": 1, "xgboost": 2, "ets": 3, "prophet": 4, "chronos": 5}

DEFAULT_CHAMPION_DIR = os.path.join(
    os.path.dirname(__file__), "..", "..", "..", "artifacts", "forecast", "_champions"
)


@dataclass
class LeaderboardEntry:
    """Single entry in the leaderboard."""

    rank: int
    model_name: str
    val_mape: float
    val_bias: float
    train_mape: float
    artifact_dir: str
    run_id: str
    dataset_fingerprint: str
    elapsed_seconds: float
    coverage_10_90: Optional[float] = None
    composite_score: float = 999.0
    is_champion: bool = False

    def to_dict(self) -> Dict:
        d = {
            "rank": self.rank,
            "model_name": self.model_name,
            "val_mape": round(self.val_mape, 4),
            "val_bias": round(self.val_bias, 4),
            "train_mape": round(self.train_mape, 4),
            "composite_score": round(self.composite_score, 4),
            "artifact_dir": self.artifact_dir,
            "run_id": self.run_id,
            "dataset_fingerprint": self.dataset_fingerprint,
            "elapsed_seconds": round(self.elapsed_seconds, 3),
            "is_champion": self.is_champion,
        }
        if self.coverage_10_90 is not None:
            d["coverage_10_90"] = round(self.coverage_10_90, 4)
        return d


@dataclass
class OrchestratorResult:
    """Result from an orchestrator run."""

    run_id: str
    series_id: str
    leaderboard: List[LeaderboardEntry]
    champion: Optional[LeaderboardEntry]
    errors: List[Dict]
    elapsed_seconds: float
    timestamp: str = ""

    def __post_init__(self):
        if not self.timestamp:
            self.timestamp = datetime.now().isoformat()

    def to_dict(self) -> Dict:
        return {
            "run_id": self.run_id,
            "series_id": self.series_id,
            "leaderboard": [e.to_dict() for e in self.leaderboard],
            "champion": self.champion.to_dict() if self.champion else None,
            "errors": self.errors,
            "elapsed_seconds": round(self.elapsed_seconds, 3),
            "timestamp": self.timestamp,
        }


def _composite_score(mape: float, bias: float, coverage: Optional[float]) -> float:
    """
    Weighted composite score for champion selection.

    Formula: 0.5*mape + 0.3*|bias| + 0.2*(100 - coverage_10_90)
    Lower is better. If coverage is unavailable, uses 50% (neutral penalty).
    """
    cov = coverage if coverage is not None else 50.0
    return 0.5 * mape + 0.3 * abs(bias) + 0.2 * (100.0 - cov)


def _sort_key(result: TrainingRunResult):
    """Deterministic sort key: composite_score → complexity → name."""
    mape = result.val_metrics.mape if result.val_metrics else 999.0
    bias = abs(result.val_metrics.bias) if result.val_metrics else 999.0
    coverage = result.val_metrics.coverage_10_90 if result.val_metrics else None
    composite = _composite_score(mape, bias, coverage)
    complexity = MODEL_COMPLEXITY.get(result.model_name, 99)
    return (composite, complexity, result.model_name)


def run_orchestrator(
    series: SalesSeries,
    candidate_models: List[str] = None,
    hyperparam_grid: Optional[Dict[str, List[Dict]]] = None,
    horizon: int = 30,
    val_days: int = 0,
    val_ratio: float = 0.15,
    warmup_rows: int = 30,
    seed: int = 42,
    run_id: str = "",
    artifact_root: str = "",
    champion_dir: str = "",
    # HPO settings (opt-in)
    hpo_enabled: bool = False,
    hpo_n_trials: int = 30,
    hpo_timeout_seconds: Optional[int] = None,
    hpo_cv_splits: int = 3,
    hpo_cv_mode: str = "timeseries_cv",
    hpo_search_space: Optional[Dict] = None,
) -> OrchestratorResult:
    """
    Run the AutoML orchestrator.

    Steps:
      1. Train all candidate models (optionally with hyperparam grid)
      2. Rank by selection policy
      3. Produce leaderboard
      4. Select champion
      5. Write champion.json + champion_history.json

    Args:
        series: Input time series.
        candidate_models: List of model names to try. Default: ["lightgbm", "prophet"].
        hyperparam_grid: Optional {model_name: [config_dict, ...]} for grid search.
        horizon: Forecast horizon.
        val_days: Fixed validation days (0 = use val_ratio).
        val_ratio: Validation ratio if val_days == 0.
        warmup_rows: Feature warmup rows.
        seed: Random seed.
        run_id: Identifier for this run.
        artifact_root: Root directory for artifacts.
        champion_dir: Directory for champion pointers.

    Returns:
        OrchestratorResult with leaderboard and champion.
    """
    t0 = time.time()

    if not run_id:
        run_id = f"automl_{uuid.uuid4().hex[:8]}"

    if candidate_models is None:
        candidate_models = ["lightgbm", "prophet", "xgboost"]

    if hyperparam_grid is None:
        hyperparam_grid = {}

    all_results: List[TrainingRunResult] = []
    errors: List[Dict] = []

    for model_name in candidate_models:
        configs_for_model = hyperparam_grid.get(model_name, [{}])
        if not configs_for_model:
            configs_for_model = [{}]

        for i, hp in enumerate(configs_for_model):
            variant_id = f"{run_id}_{model_name}"
            if len(configs_for_model) > 1:
                variant_id += f"_hp{i}"

            cfg = TrainingRunConfig(
                series_id=series.sku,
                horizon=horizon,
                model_name=model_name,
                hyperparams=hp,
                val_days=val_days,
                val_ratio=val_ratio,
                warmup_rows=warmup_rows,
                seed=seed,
                run_id=variant_id,
                artifact_root=artifact_root,
                hpo_enabled=hpo_enabled,
                hpo_n_trials=hpo_n_trials,
                hpo_timeout_seconds=hpo_timeout_seconds,
                hpo_cv_splits=hpo_cv_splits,
                hpo_cv_mode=hpo_cv_mode,
                hpo_search_space=hpo_search_space or {},
            )

            result = train_one_series(series, cfg)

            if result.status == "success":
                all_results.append(result)
            else:
                errors.append({
                    "model_name": model_name,
                    "error": result.error,
                    "run_id": variant_id,
                })

    # --- Sort by selection policy ---
    all_results.sort(key=_sort_key)

    # --- Build leaderboard ---
    leaderboard = []
    for rank, r in enumerate(all_results, 1):
        mape = r.val_metrics.mape if r.val_metrics else 999.0
        bias = r.val_metrics.bias if r.val_metrics else 0.0
        coverage = r.val_metrics.coverage_10_90 if r.val_metrics else None
        entry = LeaderboardEntry(
            rank=rank,
            model_name=r.model_name,
            val_mape=mape,
            val_bias=bias,
            train_mape=r.train_metrics.mape if r.train_metrics else 999.0,
            artifact_dir=r.artifact_dir,
            run_id=r.run_id,
            dataset_fingerprint=r.dataset_fingerprint,
            elapsed_seconds=r.elapsed_seconds,
            coverage_10_90=coverage,
            composite_score=_composite_score(mape, bias, coverage),
            is_champion=(rank == 1),
        )
        leaderboard.append(entry)

    champion = leaderboard[0] if leaderboard else None

    # --- Persist leaderboard + champion ---
    _persist_leaderboard(
        run_id, series.sku, leaderboard, artifact_root or None,
    )
    if champion:
        _persist_champion(
            series.sku, champion, champion_dir or None,
        )

    elapsed = time.time() - t0

    return OrchestratorResult(
        run_id=run_id,
        series_id=series.sku,
        leaderboard=leaderboard,
        champion=champion,
        errors=errors,
        elapsed_seconds=elapsed,
    )


def _persist_leaderboard(
    run_id: str, series_id: str, leaderboard: List[LeaderboardEntry],
    artifact_root: Optional[str],
):
    """Write leaderboard.json to the run directory."""
    root = artifact_root or os.path.join(
        os.path.dirname(__file__), "..", "..", "..", "artifacts", "forecast"
    )
    root = os.path.abspath(root)
    lb_dir = os.path.join(root, run_id)
    os.makedirs(lb_dir, exist_ok=True)

    lb_path = os.path.join(lb_dir, "leaderboard.json")
    data = {
        "run_id": run_id,
        "series_id": series_id,
        "timestamp": datetime.now().isoformat(),
        "entries": [e.to_dict() for e in leaderboard],
    }
    with open(lb_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def _persist_champion(
    series_id: str, champion: LeaderboardEntry,
    champion_dir: Optional[str],
):
    """Write champion.json and update champion_history.json."""
    cdir = os.path.abspath(champion_dir or DEFAULT_CHAMPION_DIR)
    safe_series = series_id.replace("/", "_").replace("\\", "_")
    series_champion_dir = os.path.join(cdir, safe_series)
    os.makedirs(series_champion_dir, exist_ok=True)

    champion_path = os.path.join(series_champion_dir, "champion.json")
    history_path = os.path.join(series_champion_dir, "champion_history.json")

    champion_data = {
        **champion.to_dict(),
        "series_id": series_id,
        "selected_at": datetime.now().isoformat(),
    }

    # Update history
    history = []
    if os.path.exists(history_path):
        with open(history_path, "r", encoding="utf-8") as f:
            history = json.load(f)

    # Push current champion to history (if exists and different)
    if os.path.exists(champion_path):
        with open(champion_path, "r", encoding="utf-8") as f:
            old_champion = json.load(f)
        old_champion["superseded_at"] = datetime.now().isoformat()
        history.append(old_champion)

    # Write new champion
    with open(champion_path, "w", encoding="utf-8") as f:
        json.dump(champion_data, f, indent=2, ensure_ascii=False)

    # Write history
    with open(history_path, "w", encoding="utf-8") as f:
        json.dump(history, f, indent=2, ensure_ascii=False)


def set_champion(series_id: str, artifact_dir: str,
                 champion_dir: str = "") -> Dict:
    """
    Manually set a champion for a series.

    Args:
        series_id: The series identifier.
        artifact_dir: Path to the artifact directory to promote.
        champion_dir: Champion directory override.

    Returns:
        The new champion data dict.
    """
    am = ArtifactManager()
    meta = am.load_metadata(artifact_dir)

    metrics = meta.get("metrics", {}).get("val", {})

    champion = LeaderboardEntry(
        rank=0,
        model_name=os.path.basename(artifact_dir),
        val_mape=metrics.get("mape", 999.0),
        val_bias=metrics.get("bias", 0.0),
        train_mape=meta.get("metrics", {}).get("train", {}).get("mape", 999.0),
        artifact_dir=artifact_dir,
        run_id=meta.get("config", {}).get("run_id", "manual"),
        dataset_fingerprint=meta.get("dataset_fingerprint", ""),
        elapsed_seconds=0,
        is_champion=True,
    )

    _persist_champion(series_id, champion, champion_dir or None)

    return champion.to_dict()


def rollback_champion(series_id: str, steps: int = 1,
                      champion_dir: str = "") -> Dict:
    """
    Rollback champion to a previous version.

    Args:
        series_id: The series identifier.
        steps: How many versions to go back.
        champion_dir: Champion directory override.

    Returns:
        The restored champion data dict.
    """
    cdir = os.path.abspath(champion_dir or DEFAULT_CHAMPION_DIR)
    safe_series = series_id.replace("/", "_").replace("\\", "_")
    series_champion_dir = os.path.join(cdir, safe_series)

    history_path = os.path.join(series_champion_dir, "champion_history.json")
    champion_path = os.path.join(series_champion_dir, "champion.json")

    if not os.path.exists(history_path):
        raise FileNotFoundError(f"No champion history for series '{series_id}'")

    with open(history_path, "r", encoding="utf-8") as f:
        history = json.load(f)

    if len(history) < steps:
        raise ValueError(
            f"Cannot rollback {steps} steps — only {len(history)} entries in history"
        )

    # Pop the last `steps` entries, the last one becomes new champion
    restored = history[-steps]
    remaining_history = history[:-steps]

    # Current champion goes to history
    if os.path.exists(champion_path):
        with open(champion_path, "r", encoding="utf-8") as f:
            current = json.load(f)
        current["superseded_at"] = datetime.now().isoformat()
        current["rollback_reason"] = f"rollback_{steps}_steps"
        remaining_history.append(current)

    # Write restored as champion
    restored["selected_at"] = datetime.now().isoformat()
    restored["restored_via_rollback"] = True
    with open(champion_path, "w", encoding="utf-8") as f:
        json.dump(restored, f, indent=2, ensure_ascii=False)

    # Write updated history
    with open(history_path, "w", encoding="utf-8") as f:
        json.dump(remaining_history, f, indent=2, ensure_ascii=False)

    return restored


def load_champion(series_id: str, champion_dir: str = "") -> Optional[Dict]:
    """
    Load the current champion for a series.

    Returns None if no champion exists.
    """
    cdir = os.path.abspath(champion_dir or DEFAULT_CHAMPION_DIR)
    safe_series = series_id.replace("/", "_").replace("\\", "_")
    champion_path = os.path.join(cdir, safe_series, "champion.json")

    if not os.path.exists(champion_path):
        return None

    with open(champion_path, "r", encoding="utf-8") as f:
        return json.load(f)
