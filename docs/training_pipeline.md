# Training Pipeline (PR-B Phase 2)

## Overview

The training pipeline provides a reproducible, deterministic workflow for training
demand forecasting models, evaluating them with time-series safe validation, and
selecting a champion model via AutoML orchestration.

## Architecture

```
src/ml/training/
  __init__.py
  train.py              # CLI entrypoint
  __main__.py           # python -m src.ml.training
  dataset_builder.py    # Build reproducible train/val/test bundles
  strategies.py         # Model training strategies (LightGBM, Prophet, Chronos)
  evaluation.py         # Metrics computation (MAPE, bias, coverage, pinball)
  runner.py             # train_one_series() / train_many_series()
  artifact_manager.py   # Artifact persistence with provenance
  orchestrator.py       # AutoML: leaderboard + champion selection + rollback
```

## Running Training

### CLI

```bash
# Train a single LightGBM model on synthetic data
python -m src.ml.training.train --series-id SKU-A --horizon 30 --model lightgbm

# Train on CSV data
python -m src.ml.training.train --series-id SKU-A --csv data/sales.csv --model lightgbm

# Run AutoML orchestrator (trains multiple models, selects champion)
python -m src.ml.training.train --series-id SKU-A --automl --candidates lightgbm,prophet

# Set champion manually
python -m src.ml.training.train --set-champion --series-id SKU-A \
  --artifact-path artifacts/forecast/run_xxx/SKU-A/lightgbm

# Rollback champion to previous version
python -m src.ml.training.train --rollback --series-id SKU-A --steps 1
```

### Python API

```python
from ml.demand_forecasting.data_contract import SalesSeries
from ml.training.runner import TrainingRunConfig, train_one_series
from ml.training.orchestrator import run_orchestrator

# Build series from your data
series = SalesSeries(dates=dates_list, values=values_list, sku="SKU-A")

# Single model training
config = TrainingRunConfig(
    series_id="SKU-A",
    horizon=30,
    model_name="lightgbm",
    seed=42,
)
result = train_one_series(series, config)
print(result.val_metrics.mape)  # Validation MAPE

# AutoML orchestrator
orch_result = run_orchestrator(
    series=series,
    candidate_models=["lightgbm", "prophet"],
    horizon=30,
    seed=42,
)
print(orch_result.champion.model_name)  # Best model
```

## Artifact Layout

Every training run produces a complete artifact directory:

```
artifacts/forecast/<run_id>/<series_id>/<model_name>/
  model.pkl | model.json          # Serialized model
  feature_spec.json               # Feature columns, version, hash
  metrics.json                    # Train/val metrics (MAPE, bias, etc.)
  config.json                     # Hyperparameters + run settings + seed
  dataset_fingerprint.txt         # Reproducibility hash
  code_provenance.json            # git SHA, timestamp, library versions
```

### feature_spec.json

```json
{
  "feature_version": "fe_v3",
  "columns_hash": "a1b2c3d4e5f6",
  "feature_columns": ["day_of_week", "day_of_month", ...],
  "num_features": 20
}
```

### metrics.json

```json
{
  "train": {"mape": 3.21, "bias": 0.15, "mae": 2.1, "rmse": 2.8, "n_eval_points": 70},
  "val":   {"mape": 5.71, "bias": -1.72, "mae": 3.5, "rmse": 4.2, "n_eval_points": 18}
}
```

### code_provenance.json

```json
{
  "git_sha": "c01a0c8abc12",
  "timestamp": "2026-02-21T10:30:00",
  "python_version": "3.14.2",
  "library_versions": {
    "numpy": "2.4.2",
    "lightgbm": "4.6.0",
    "scikit-learn": "1.7.0"
  }
}
```

## Evaluation

Metrics computed for every training run:

| Metric | Description | Required |
|--------|-------------|----------|
| `mape` | Mean Absolute Percentage Error (%) | Yes |
| `bias` | Mean error (positive = over-forecast) | Yes |
| `mae` | Mean Absolute Error | Yes |
| `rmse` | Root Mean Squared Error | Yes |
| `coverage_10_90` | % of actuals within p10-p90 interval | If quantiles available |
| `pinball_10` | Pinball loss at p10 | If quantiles available |
| `pinball_90` | Pinball loss at p90 | If quantiles available |

### Time-Series Safe Validation

All splits are strictly chronological (no leakage):

```
|--- warmup ---|-------- train --------|--- val ---|--- test (optional) ---|
                                        ^
                                  cutoff date
```

- Training data always ends before validation window starts
- Walk-forward evaluation optionally available via `walk_forward_evaluate()`

## Champion Selection

### Selection Policy (deterministic)

1. **Primary metric**: Validation MAPE (lower is better)
2. **Tie-breaker 1**: Lower absolute bias
3. **Tie-breaker 2**: Model complexity (lightgbm < prophet < chronos)
4. **Tie-breaker 3**: Alphabetical model name (stable fallback)

### Champion Files

```
artifacts/forecast/_champions/<series_id>/
  champion.json          # Current champion pointer
  champion_history.json  # Previous champions (for rollback)
```

### champion.json

```json
{
  "model_name": "lightgbm",
  "val_mape": 5.71,
  "artifact_dir": "artifacts/forecast/run_xxx/SKU-A/lightgbm",
  "run_id": "automl_abc123",
  "dataset_fingerprint": "9b93652bf91096da",
  "selected_at": "2026-02-21T10:30:00"
}
```

### Rollback

```bash
# Rollback 1 step
python -m src.ml.training.train --rollback --series-id SKU-A --steps 1

# Manually promote a specific artifact
python -m src.ml.training.train --set-champion --series-id SKU-A \
  --artifact-path artifacts/forecast/run_xxx/SKU-A/lightgbm
```

Via Python:

```python
from ml.training.orchestrator import rollback_champion, set_champion

rollback_champion("SKU-A", steps=1)
set_champion("SKU-A", artifact_dir="artifacts/forecast/run_xxx/SKU-A/lightgbm")
```

## Inference Integration

When a champion artifact exists for a series:

1. `/demand-forecast` tries `predict_with_champion()` first
2. If champion found: loads model, predicts, returns metadata with `model_used=champion`
3. If no champion: falls back to existing `predict_with_fallback()` behavior

Response metadata (additive fields when champion is used):

```json
{
  "metadata": {
    "inference_mode": "champion_artifact",
    "model_used": "champion",
    "artifact_run_id": "automl_abc123",
    "dataset_fingerprint": "9b93652bf91096da",
    "champion_selected_at": "2026-02-21T10:30:00"
  }
}
```

## Model Strategies

### LightGBM

- Uses FeatureEngineer (fe_v3) for 20 time-series features
- Recursive forecasting for multi-step predictions
- Deterministic with `seed` + `deterministic=True`

### Prophet

- Native Prophet training with yearly + weekly seasonality
- Quantile support via Prophet's built-in uncertainty intervals
- Serialized as JSON via `model_to_json()`

### Chronos

- Zero-shot strategy (no training needed)
- Included in orchestrator for completeness
- Uses statistical simulation for deterministic evaluation

## Testing

```bash
# Run all training pipeline tests
pytest tests/test_training_pipeline.py -v

# Run specific test class
pytest tests/test_training_pipeline.py::TestOrchestrator -v
```

Test categories:
- **TestArtifactManager**: Artifact writing, required files, key validation
- **TestFeatureSpecConsistency**: Feature spec matches between training and inference
- **TestSmokeTraining**: End-to-end training on tiny synthetic data
- **TestOrchestrator**: Leaderboard, champion selection, rollback
- **TestInferenceIntegration**: Champion loading vs fallback
- **TestEvaluation**: Metrics computation (MAPE, bias, coverage)
- **TestDatasetBuilder**: No-leakage splits, fingerprint determinism

## Determinism

- All runs use fixed `seed` parameter
- Dataset fingerprints are deterministic (same data + config = same hash)
- LightGBM uses `deterministic=True` + `force_row_wise=True`
- Chronos evaluation uses no random noise in training mode
- Seeds are recorded in `config.json` for every run
