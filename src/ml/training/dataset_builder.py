"""
PR-B: Dataset Builder
─────────────────────
Builds reproducible train/val/test bundles from SalesSeries + FeatureEngineer.
Produces a DatasetBundle with fingerprints for provenance tracking.
"""
import hashlib
import json
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

from ml.demand_forecasting.data_contract import SalesSeries
from ml.demand_forecasting.data_validation import validate_and_clean_series
from ml.demand_forecasting.feature_engineer import (
    FEATURE_COLUMNS,
    FEATURE_VERSION,
    FeatureEngineer,
)


@dataclass
class DatasetBundle:
    """Immutable training dataset with provenance."""

    series_id: str
    frequency: str
    horizon: int

    # DataFrames with features
    train_df: pd.DataFrame
    val_df: pd.DataFrame
    test_df: Optional[pd.DataFrame]

    # Feature-only matrices (ready for model)
    X_train: pd.DataFrame
    y_train: pd.Series
    X_val: pd.DataFrame
    y_val: pd.Series
    X_test: Optional[pd.DataFrame] = None
    y_test: Optional[pd.Series] = None

    # Raw series for Prophet / Chronos (date+value)
    train_series: Optional[SalesSeries] = None
    val_series: Optional[SalesSeries] = None
    test_series: Optional[SalesSeries] = None

    # Provenance
    feature_columns: List[str] = field(default_factory=lambda: list(FEATURE_COLUMNS))
    feature_version: str = FEATURE_VERSION
    fingerprint: str = ""
    config: Dict = field(default_factory=dict)

    def summary(self) -> Dict:
        return {
            "series_id": self.series_id,
            "frequency": self.frequency,
            "horizon": self.horizon,
            "train_rows": len(self.X_train),
            "val_rows": len(self.X_val),
            "test_rows": len(self.X_test) if self.X_test is not None else 0,
            "feature_version": self.feature_version,
            "feature_count": len(self.feature_columns),
            "fingerprint": self.fingerprint,
        }


def _compute_fingerprint(series: SalesSeries, horizon: int, val_days: int,
                         test_days: int, seed: int) -> str:
    raw = (
        f"{series.sku}|{series.n}|{series.start_date}|{series.last_date}"
        f"|{sum(series.values):.6f}|h={horizon}|v={val_days}|t={test_days}"
        f"|seed={seed}|fv={FEATURE_VERSION}"
    )
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def build_dataset(
    series: SalesSeries,
    horizon: int = 30,
    val_days: int = 0,
    test_days: int = 0,
    val_ratio: float = 0.15,
    warmup_rows: int = 30,
    seed: int = 42,
    clean: bool = True,
) -> DatasetBundle:
    """
    Build a reproducible DatasetBundle from a SalesSeries.

    Split strategy (time-series safe — no leakage):
      1. If test_days > 0: last test_days become test set
      2. If val_days > 0: next-to-last val_days become val set
         Else: val_ratio of remaining data (from end) becomes val set
      3. Everything before val is train

    The first `warmup_rows` of training data are used for lag feature
    warm-up and excluded from X_train/y_train.
    """
    if clean:
        series, _ = validate_and_clean_series(series)

    total = series.n
    if total < warmup_rows + 10:
        raise ValueError(
            f"Series too short ({total} points) for warmup={warmup_rows}"
        )

    fe = FeatureEngineer()
    full_df = fe.create_features(series.to_dataframe())

    # --- chronological split indices ---
    test_start = total
    if test_days > 0:
        test_start = total - test_days

    remaining = test_start
    if val_days > 0:
        val_start = remaining - val_days
    else:
        val_start = int(remaining * (1 - val_ratio))

    if val_start < warmup_rows + 5:
        raise ValueError(
            f"Not enough data for training after splits "
            f"(val_start={val_start}, warmup={warmup_rows})"
        )

    # --- slice DataFrames ---
    train_df = full_df.iloc[:val_start].copy()
    val_df = full_df.iloc[val_start:test_start].copy()
    test_df = full_df.iloc[test_start:].copy() if test_days > 0 else None

    # --- extract X, y (skip warmup for train) ---
    effective_warmup = min(warmup_rows, len(train_df) // 2)
    train_usable = train_df.iloc[effective_warmup:]

    X_train = train_usable[FEATURE_COLUMNS].reset_index(drop=True)
    y_train = train_usable["sales"].reset_index(drop=True)

    X_val = val_df[FEATURE_COLUMNS].reset_index(drop=True)
    y_val = val_df["sales"].reset_index(drop=True)

    X_test, y_test = None, None
    if test_df is not None and len(test_df) > 0:
        X_test = test_df[FEATURE_COLUMNS].reset_index(drop=True)
        y_test = test_df["sales"].reset_index(drop=True)

    # --- raw sub-series for Prophet/Chronos ---
    train_series = SalesSeries(
        dates=series.dates[:val_start],
        values=series.values[:val_start],
        sku=series.sku,
    )
    val_series = SalesSeries(
        dates=series.dates[val_start:test_start],
        values=series.values[val_start:test_start],
        sku=series.sku,
    )
    test_series = None
    if test_days > 0:
        test_series = SalesSeries(
            dates=series.dates[test_start:],
            values=series.values[test_start:],
            sku=series.sku,
        )

    fp = _compute_fingerprint(series, horizon, len(val_df),
                              test_days, seed)

    config = {
        "horizon": horizon,
        "val_days": val_days if val_days > 0 else f"ratio={val_ratio}",
        "test_days": test_days,
        "warmup_rows": warmup_rows,
        "seed": seed,
        "total_points": total,
    }

    return DatasetBundle(
        series_id=series.sku,
        frequency=series.frequency,
        horizon=horizon,
        train_df=train_df,
        val_df=val_df,
        test_df=test_df,
        X_train=X_train,
        y_train=y_train,
        X_val=X_val,
        y_val=y_val,
        X_test=X_test,
        y_test=y_test,
        train_series=train_series,
        val_series=val_series,
        test_series=test_series,
        feature_columns=list(FEATURE_COLUMNS),
        feature_version=FEATURE_VERSION,
        fingerprint=fp,
        config=config,
    )
