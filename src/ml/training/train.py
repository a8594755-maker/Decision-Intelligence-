"""
PR-B: Training CLI Entrypoint
──────────────────────────────
Usage:
  # Train a single model
  python -m src.ml.training.train \\
    --series-id SKU-A --horizon 30 --model lightgbm --seed 42

  # Run AutoML orchestrator
  python -m src.ml.training.train \\
    --series-id SKU-A --horizon 30 --automl --candidates lightgbm,prophet

  # Set champion manually
  python -m src.ml.training.train \\
    --set-champion --series-id SKU-A --artifact-path artifacts/forecast/run_xxx/SKU-A/lightgbm

  # Rollback champion
  python -m src.ml.training.train \\
    --rollback --series-id SKU-A --steps 1
"""
import argparse
import json
import logging
import os
import sys

import numpy as np
import pandas as pd

# Ensure project root is on sys.path
_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
if _root not in sys.path:
    sys.path.insert(0, _root)

from src.ml.demand_forecasting.data_contract import SalesSeries
from src.ml.training.orchestrator import (
    load_champion,
    rollback_champion,
    run_orchestrator,
    set_champion,
)
from src.ml.training.runner import TrainingRunConfig, train_one_series


def _generate_synthetic_series(
    series_id: str, days: int = 365, seed: int = 42
) -> SalesSeries:
    """Generate a synthetic daily sales series for testing."""
    np.random.seed(seed)
    dates = pd.date_range(start="2025-01-01", periods=days, freq="D")
    base = 50
    trend = np.arange(days) * 0.02
    weekly = 5 * np.sin(2 * np.pi * np.arange(days) / 7)
    monthly = 8 * np.sin(2 * np.pi * np.arange(days) / 30)
    noise = np.random.normal(0, 4, days)
    sales = np.maximum(base + trend + weekly + monthly + noise, 0).round(1)
    return SalesSeries(dates=dates.tolist(), values=sales.tolist(), sku=series_id)


def _load_series_from_csv(path: str, series_id: str) -> SalesSeries:
    """Load a series from a CSV file with 'date' and 'sales' columns."""
    df = pd.read_csv(path)
    df["date"] = pd.to_datetime(df["date"])
    return SalesSeries.from_dataframe(df, sku=series_id)


def main():
    parser = argparse.ArgumentParser(
        description="PR-B Training Pipeline CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    # --- mode flags ---
    parser.add_argument("--automl", action="store_true",
                        help="Run AutoML orchestrator instead of single model")
    parser.add_argument("--set-champion", action="store_true",
                        help="Manually set a champion")
    parser.add_argument("--rollback", action="store_true",
                        help="Rollback champion")

    # --- common args ---
    parser.add_argument("--series-id", type=str, default="SYNTHETIC",
                        help="Series identifier")
    parser.add_argument("--horizon", type=int, default=30)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--artifact-root", type=str, default="")
    parser.add_argument("--champion-dir", type=str, default="")

    # --- data source ---
    parser.add_argument("--csv", type=str, default="",
                        help="Path to CSV with date,sales columns")
    parser.add_argument("--synthetic-days", type=int, default=365,
                        help="Days of synthetic data to generate")

    # --- single model training ---
    parser.add_argument("--model", type=str, default="lightgbm",
                        help="Model to train (lightgbm, prophet, chronos)")
    parser.add_argument("--run-id", type=str, default="")
    parser.add_argument("--val-days", type=int, default=0)
    parser.add_argument("--val-ratio", type=float, default=0.15)

    # --- automl args ---
    parser.add_argument("--candidates", type=str, default="lightgbm,prophet",
                        help="Comma-separated candidate models for AutoML")

    # --- champion management ---
    parser.add_argument("--artifact-path", type=str, default="",
                        help="Artifact path for --set-champion")
    parser.add_argument("--steps", type=int, default=1,
                        help="Rollback steps")

    # --- output ---
    parser.add_argument("--verbose", action="store_true")

    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    # --- Champion management modes ---
    if args.set_champion:
        if not args.artifact_path:
            parser.error("--set-champion requires --artifact-path")
        result = set_champion(
            args.series_id, args.artifact_path, args.champion_dir,
        )
        print(json.dumps(result, indent=2))
        return

    if args.rollback:
        result = rollback_champion(
            args.series_id, args.steps, args.champion_dir,
        )
        print(json.dumps(result, indent=2))
        return

    # --- Load data ---
    if args.csv:
        series = _load_series_from_csv(args.csv, args.series_id)
    else:
        series = _generate_synthetic_series(
            args.series_id, args.synthetic_days, args.seed,
        )

    print(f"Data: {series}")

    # --- AutoML mode ---
    if args.automl:
        candidates = [c.strip() for c in args.candidates.split(",")]
        result = run_orchestrator(
            series=series,
            candidate_models=candidates,
            horizon=args.horizon,
            val_days=args.val_days,
            val_ratio=args.val_ratio,
            seed=args.seed,
            run_id=args.run_id,
            artifact_root=args.artifact_root,
            champion_dir=args.champion_dir,
        )
        print(json.dumps(result.to_dict(), indent=2))
        return

    # --- Single model training ---
    config = TrainingRunConfig(
        series_id=args.series_id,
        horizon=args.horizon,
        model_name=args.model,
        val_days=args.val_days,
        val_ratio=args.val_ratio,
        seed=args.seed,
        run_id=args.run_id,
        artifact_root=args.artifact_root,
    )

    result = train_one_series(series, config)
    print(json.dumps(result.to_dict(), indent=2))


if __name__ == "__main__":
    main()
