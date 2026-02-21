"""
PR-B: Training Runner
─────────────────────
Core entry point: train_one_series() and train_many_series().
Orchestrates: dataset build → strategy.fit → artifact save → return result.
"""
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from ml.demand_forecasting.data_contract import SalesSeries
from ml.demand_forecasting.feature_engineer import FeatureEngineer

from .artifact_manager import ArtifactManager
from .dataset_builder import DatasetBundle, build_dataset
from .evaluation import EvalMetrics
from .strategies import TrainedModel, get_strategy

logger = logging.getLogger(__name__)


@dataclass
class TrainingRunConfig:
    """Configuration for a single training run."""

    series_id: str = ""
    horizon: int = 30
    frequency: str = "D"
    model_name: str = "lightgbm"
    hyperparams: Dict = field(default_factory=dict)
    val_days: int = 0
    test_days: int = 0
    val_ratio: float = 0.15
    warmup_rows: int = 30
    seed: int = 42
    run_id: str = ""
    artifact_root: str = ""

    def __post_init__(self):
        if not self.run_id:
            self.run_id = f"run_{uuid.uuid4().hex[:8]}"

    def to_dict(self) -> Dict:
        return {
            "series_id": self.series_id,
            "horizon": self.horizon,
            "frequency": self.frequency,
            "model_name": self.model_name,
            "hyperparams": self.hyperparams,
            "val_days": self.val_days,
            "test_days": self.test_days,
            "val_ratio": self.val_ratio,
            "warmup_rows": self.warmup_rows,
            "seed": self.seed,
            "run_id": self.run_id,
        }


@dataclass
class TrainingRunResult:
    """Result of a single model training run."""

    run_id: str
    series_id: str
    model_name: str
    status: str  # "success" | "error"
    val_metrics: Optional[EvalMetrics] = None
    train_metrics: Optional[EvalMetrics] = None
    artifact_dir: str = ""
    dataset_fingerprint: str = ""
    elapsed_seconds: float = 0.0
    error: str = ""
    config: Dict = field(default_factory=dict)

    def to_dict(self) -> Dict:
        d = {
            "run_id": self.run_id,
            "series_id": self.series_id,
            "model_name": self.model_name,
            "status": self.status,
            "artifact_dir": self.artifact_dir,
            "dataset_fingerprint": self.dataset_fingerprint,
            "elapsed_seconds": round(self.elapsed_seconds, 3),
            "config": self.config,
        }
        if self.val_metrics:
            d["val_metrics"] = self.val_metrics.to_dict()
        if self.train_metrics:
            d["train_metrics"] = self.train_metrics.to_dict()
        if self.error:
            d["error"] = self.error
        return d


def train_one_series(
    series: SalesSeries,
    config: TrainingRunConfig,
) -> TrainingRunResult:
    """
    Train a single model on a single series.

    Steps:
      1. Build dataset (with time-series safe split)
      2. Run strategy.fit()
      3. Save artifacts
      4. Return result with metrics

    Args:
        series: Input time series.
        config: Training configuration.

    Returns:
        TrainingRunResult with metrics and artifact path.
    """
    t0 = time.time()

    try:
        # 1. Build dataset
        bundle = build_dataset(
            series,
            horizon=config.horizon,
            val_days=config.val_days,
            test_days=config.test_days,
            val_ratio=config.val_ratio,
            warmup_rows=config.warmup_rows,
            seed=config.seed,
        )

        # 2. Train
        strategy = get_strategy(config.model_name)
        trained: TrainedModel = strategy.fit(
            bundle, {**config.hyperparams, "seed": config.seed}
        )

        # 3. Validate feature spec (prevent train/serve skew)
        fe = FeatureEngineer()
        if trained.feature_spec.get("feature_columns"):
            FeatureEngineer.assert_feature_schema(
                bundle.X_val, trained.feature_spec["feature_columns"]
            )

        # 4. Save artifacts
        am = ArtifactManager(root=config.artifact_root or None)
        metrics_data = {
            "train": trained.train_metrics.to_dict(),
            "val": trained.val_metrics.to_dict(),
        }

        artifact_config = {
            **config.to_dict(),
            "model_config": trained.config,
        }

        artifact_dir = am.save_run(
            run_id=config.run_id,
            series_id=config.series_id or series.sku,
            model_name=config.model_name,
            model_obj=trained.model_obj,
            config=artifact_config,
            metrics=metrics_data,
            feature_spec=trained.feature_spec,
            dataset_fingerprint=bundle.fingerprint,
            extra_files=trained.extra if trained.extra else None,
        )

        elapsed = time.time() - t0

        return TrainingRunResult(
            run_id=config.run_id,
            series_id=config.series_id or series.sku,
            model_name=config.model_name,
            status="success",
            val_metrics=trained.val_metrics,
            train_metrics=trained.train_metrics,
            artifact_dir=artifact_dir,
            dataset_fingerprint=bundle.fingerprint,
            elapsed_seconds=elapsed,
            config=artifact_config,
        )

    except Exception as e:
        elapsed = time.time() - t0
        logger.error(f"Training failed for {config.model_name}: {e}")
        return TrainingRunResult(
            run_id=config.run_id,
            series_id=config.series_id or series.sku,
            model_name=config.model_name,
            status="error",
            elapsed_seconds=elapsed,
            error=str(e),
            config=config.to_dict(),
        )


def train_many_series(
    series_list: List[SalesSeries],
    config: TrainingRunConfig,
) -> List[TrainingRunResult]:
    """
    Train the same model on multiple series.

    Args:
        series_list: List of input series.
        config: Base training configuration (series_id will be overridden).

    Returns:
        List of TrainingRunResult, one per series.
    """
    results = []
    for series in series_list:
        cfg = TrainingRunConfig(
            series_id=series.sku,
            horizon=config.horizon,
            frequency=config.frequency,
            model_name=config.model_name,
            hyperparams=config.hyperparams,
            val_days=config.val_days,
            test_days=config.test_days,
            val_ratio=config.val_ratio,
            warmup_rows=config.warmup_rows,
            seed=config.seed,
            run_id=config.run_id,
            artifact_root=config.artifact_root,
        )
        results.append(train_one_series(series, cfg))
    return results
