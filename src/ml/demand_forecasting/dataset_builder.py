"""Dataset builder for demand forecasting — walk-forward splits + feature spec.

Wraps the existing FeatureEngineer + SalesSeries into a reproducible dataset
pipeline that produces DatasetBundle objects with walk-forward CV splits,
feature spec fingerprinting, and train/serve skew guards.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

from .data_contract import SalesSeries, DataQualityReport
from .data_validation import validate_and_clean_series
from .feature_engineer import (
    COLUMNS_HASH,
    FEATURE_COLUMNS,
    FEATURE_VERSION,
    FeatureEngineer,
)

DATASET_BUILDER_VERSION = "dsb_v1"


# ---------------------------------------------------------------------------
# Feature spec — immutable description for train/serve skew detection
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class FeatureSpec:
    """Immutable description of the feature schema."""

    feature_version: str
    columns_hash: str
    feature_columns: tuple  # frozen: use tuple instead of list
    num_features: int

    @classmethod
    def from_feature_engineer(cls, fe: FeatureEngineer) -> FeatureSpec:
        meta = fe.get_meta()
        return cls(
            feature_version=meta["feature_version"],
            columns_hash=meta["columns_hash"],
            feature_columns=tuple(meta["feature_columns"]),
            num_features=meta["num_features"],
        )

    def assert_compatible(self, other: FeatureSpec) -> None:
        """Raise ValueError if two specs are incompatible."""
        if self.columns_hash != other.columns_hash:
            raise ValueError(
                f"Feature spec mismatch: columns_hash={self.columns_hash} vs {other.columns_hash}"
            )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "feature_version": self.feature_version,
            "columns_hash": self.columns_hash,
            "feature_columns": list(self.feature_columns),
            "num_features": self.num_features,
        }


# ---------------------------------------------------------------------------
# Dataset split + bundle
# ---------------------------------------------------------------------------

@dataclass
class DatasetSplit:
    """A single train/val split within a walk-forward CV."""

    fold_index: int
    X_train: pd.DataFrame
    y_train: pd.Series
    X_val: pd.DataFrame
    y_val: pd.Series
    train_dates: List[pd.Timestamp]
    val_dates: List[pd.Timestamp]

    @property
    def train_size(self) -> int:
        return len(self.X_train)

    @property
    def val_size(self) -> int:
        return len(self.X_val)


@dataclass
class DatasetBundle:
    """Complete dataset package for training / evaluation."""

    splits: List[DatasetSplit]
    feature_spec: FeatureSpec
    dataset_fingerprint: str
    builder_version: str = DATASET_BUILDER_VERSION
    series_summary: Dict[str, Any] = field(default_factory=dict)
    quality_report: Optional[Dict[str, Any]] = None

    @property
    def n_folds(self) -> int:
        return len(self.splits)

    @property
    def primary_split(self) -> DatasetSplit:
        """Last split (most recent val set) — used for single-split workflows."""
        return self.splits[-1]

    def to_meta_dict(self) -> Dict[str, Any]:
        return {
            "builder_version": self.builder_version,
            "dataset_fingerprint": self.dataset_fingerprint,
            "n_folds": self.n_folds,
            "feature_spec": self.feature_spec.to_dict(),
            "series_summary": self.series_summary,
            "splits": [
                {
                    "fold": s.fold_index,
                    "train_size": s.train_size,
                    "val_size": s.val_size,
                    "train_start": str(s.train_dates[0].date()) if s.train_dates else None,
                    "train_end": str(s.train_dates[-1].date()) if s.train_dates else None,
                    "val_start": str(s.val_dates[0].date()) if s.val_dates else None,
                    "val_end": str(s.val_dates[-1].date()) if s.val_dates else None,
                }
                for s in self.splits
            ],
        }


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def build_timeseries_dataset(
    series: SalesSeries,
    *,
    n_folds: int = 3,
    val_days: int = 7,
    min_train_rows: int = 30,
    warmup_rows: int = 30,
    clean: bool = True,
    fill_strategy: str = "zero",
) -> DatasetBundle:
    """Build a DatasetBundle with walk-forward cross-validation splits.

    Walk-forward strategy (expanding window):
      Fold 0: train=[0..T-2*val], val=[T-2*val..T-val]
      Fold 1: train=[0..T-val],   val=[T-val..T]

    No future leakage: val set always comes strictly after train set.
    Feature engineering uses only backward-looking operations (lags, rolling).
    """
    # 1. Optional data cleaning
    quality_dict = None
    if clean:
        series, quality_report = validate_and_clean_series(
            series, fill_strategy=fill_strategy
        )
        quality_dict = quality_report.to_dict()

    # 2. Feature engineering via existing FeatureEngineer
    fe = FeatureEngineer()
    featured_df = fe.create_features(series.to_dataframe())

    # 3. Discard warmup rows (lag fill period)
    effective_warmup = min(warmup_rows, len(featured_df) // 2)
    featured_df = featured_df.iloc[effective_warmup:].reset_index(drop=True)

    total = len(featured_df)
    if total < min_train_rows + val_days:
        raise ValueError(
            f"Insufficient data after warmup: {total} rows, "
            f"need >= {min_train_rows} train + {val_days} val"
        )

    # 4. Compute actual number of folds
    max_possible_folds = (total - min_train_rows) // val_days
    actual_folds = min(n_folds, max(1, max_possible_folds))

    # 5. Build walk-forward splits
    X_full = featured_df[list(FEATURE_COLUMNS)]
    y_full = featured_df["sales"]
    dates_full = featured_df["date"]

    splits: List[DatasetSplit] = []
    for fold_idx in range(actual_folds):
        # val_end is always total for the last fold, shifts back for earlier folds
        val_end = total - (actual_folds - 1 - fold_idx) * val_days
        val_start = val_end - val_days
        train_end = val_start

        if train_end < min_train_rows:
            continue

        X_train = X_full.iloc[:train_end].reset_index(drop=True)
        y_train = y_full.iloc[:train_end].reset_index(drop=True)
        X_val = X_full.iloc[val_start:val_end].reset_index(drop=True)
        y_val = y_full.iloc[val_start:val_end].reset_index(drop=True)
        train_dates = dates_full.iloc[:train_end].tolist()
        val_dates = dates_full.iloc[val_start:val_end].tolist()

        # Schema validation on both splits
        FeatureEngineer.assert_feature_schema(X_train)
        FeatureEngineer.assert_feature_schema(X_val)

        splits.append(
            DatasetSplit(
                fold_index=fold_idx,
                X_train=X_train,
                y_train=y_train,
                X_val=X_val,
                y_val=y_val,
                train_dates=train_dates,
                val_dates=val_dates,
            )
        )

    if not splits:
        raise ValueError("Could not create any valid walk-forward splits")

    # 6. Build fingerprint
    feature_spec = FeatureSpec.from_feature_engineer(fe)
    fingerprint = _compute_fingerprint(series, feature_spec, n_folds, val_days)

    return DatasetBundle(
        splits=splits,
        feature_spec=feature_spec,
        dataset_fingerprint=fingerprint,
        series_summary=series.summary(),
        quality_report=quality_dict,
    )


def validate_feature_spec(spec: FeatureSpec, X: pd.DataFrame) -> None:
    """Train/serve skew safety check.

    Verifies that a feature DataFrame matches the expected spec.
    Delegates to FeatureEngineer.assert_feature_schema() for column checks.
    """
    expected_cols = list(spec.feature_columns)
    FeatureEngineer.assert_feature_schema(X, expected_columns=expected_cols)
    if len(X.columns) != spec.num_features:
        raise ValueError(
            f"Feature count mismatch: expected {spec.num_features}, got {len(X.columns)}"
        )


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _compute_fingerprint(
    series: SalesSeries,
    spec: FeatureSpec,
    n_folds: int,
    val_days: int,
) -> str:
    raw = (
        f"{series.fingerprint()}|"
        f"{spec.columns_hash}|"
        f"{spec.feature_version}|"
        f"{DATASET_BUILDER_VERSION}|"
        f"folds={n_folds}|val={val_days}"
    )
    return hashlib.md5(raw.encode()).hexdigest()[:16]
