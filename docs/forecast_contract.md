---
owner: forecast-platform
status: active
contract_version: "1.0"
last_reviewed: 2026-02-21
---

# Forecast API Contract (v1.0)

## Versioning

| Field | Value |
|-------|-------|
| `forecast_contract_version` | `"1.0"` |
| Compatibility rule | 1.x changes are **additive only** (no field removals or type changes) |
| Enforcement | Pydantic models in `src/ml/api/forecast_contract.py` |

---

## ForecastPoint Schema

Each point in the `points[]` array follows this schema:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `date` | string | yes | ISO date `YYYY-MM-DD` (may be empty for inline-history scenarios) |
| `p10` | float \| null | no | 10th percentile: demand will be **above** this 90% of the time |
| `p50` | float | yes | 50th percentile (median demand forecast) |
| `p90` | float \| null | no | 90th percentile: demand will be **below** this 90% of the time |
| `forecast` | float | auto | Alias for `p50` (backward compatibility) |
| `lower` | float \| null | auto | Alias for `p10` (backward compatibility) |
| `upper` | float \| null | auto | Alias for `p90` (backward compatibility) |

### Invariants

- `p10 <= p50 <= p90` (when all present)
- All quantile values `>= 0` (demand cannot be negative)
- `forecast === p50`, `lower === p10`, `upper === p90` (aliases always populated)

### Quantile Semantics

| Quantile | Meaning | Use Case |
|----------|---------|----------|
| `p10` | 10th percentile of demand distribution | Downside scenario for inventory reduction |
| `p50` | Median (central estimate) | Primary demand signal for planning |
| `p90` | 90th percentile of demand distribution | Safety stock calculation, risk-aware planning |

Time bucket: each point corresponds to one **calendar day** (`freq="D"`).

---

## `/demand-forecast` Response

### Request

```json
{
  "materialCode": "SKU-A",
  "horizonDays": 7,
  "modelType": null,
  "includeComparison": true,
  "history": [50, 55, 48, 52, 60, 45, 53, ...]
}
```

### Response (v1.0)

```json
{
  "forecast_contract_version": "1.0",
  "materialCode": "SKU-A",
  "horizon": 7,
  "points": [
    {"date": "2026-02-22", "p10": 42.3, "p50": 51.0, "p90": 59.7, "forecast": 51.0, "lower": 42.3, "upper": 59.7},
    {"date": "2026-02-23", "p10": 41.8, "p50": 52.0, "p90": 62.2, "forecast": 52.0, "lower": 41.8, "upper": 62.2}
  ],
  "series_meta": {
    "model": "LIGHTGBM",
    "model_version": "lightgbm-v2.0-recursive",
    "risk_score": 25.0,
    "inference_mode": "recursive_real_model"
  },
  "forecast": {
    "model": "LIGHTGBM",
    "median": 51.5,
    "confidence_interval": [42.0, 61.0],
    "risk_score": 25.0,
    "model_version": "lightgbm-v2.0-recursive",
    "predictions": [51.0, 52.0, ...],
    "p10": [42.3, 41.8, ...],
    "p50": [51.0, 52.0, ...],
    "p90": [59.7, 62.2, ...]
  },
  "metadata": {
    "training_data_points": 90,
    "forecast_horizon": 7,
    "inference_mode": "recursive_real_model",
    "uncertainty": {
      "uncertainty_method": "quantile_regression",
      "calibration_scope_used": "none",
      "calibration_passed": true,
      "monotonicity_fixes_applied": 0
    }
  },
  "cached": false,
  "comparison": {
    "secondary_model": "PROPHET",
    "secondary_prediction": 50.0,
    "deviation_pct": 3.0,
    "agreement_level": "high"
  },
  "consensus_warning": null
}
```

### Required Fields (always present)

| Field | Since |
|-------|-------|
| `forecast_contract_version` | v1.0 |
| `materialCode` | v1.0 |
| `horizon` | v1.0 |
| `points` | v1.0 (may be empty for cached/error responses) |
| `series_meta` | v1.0 |
| `forecast` | pre-v1.0 (legacy, preserved) |
| `cached` | pre-v1.0 (legacy, preserved) |

---

## `/backtest` Response

### Response (v1.0)

```json
{
  "forecast_contract_version": "1.0",
  "sku": "SKU-A",
  "metrics": {
    "mape": 12.5,
    "bias": -1.2,
    "coverage_10_90": null,
    "pinball_loss_p10": null,
    "pinball_loss_p50": null,
    "pinball_loss_p90": null
  },
  "diagnostics": {
    "train_points": 83,
    "test_days": 7,
    "consensus_level": "high",
    "mape_variance": 5.0
  },
  "calibration_scope": "none",
  "results": [
    {
      "model": "lightgbm",
      "success": true,
      "mape": 12.5,
      "bias": -1.2,
      "grade": "A (Industrial Grade)",
      "forecast": [50.0, 52.0, ...],
      "actual": [51.0, 53.0, ...]
    }
  ],
  "best_model": {
    "name": "lightgbm",
    "mape": 12.5,
    "grade": "A"
  },
  "consensus": {
    "level": "high",
    "mape_variance": 5.0,
    "models_tested": 3
  },
  "reliability": "trusted",
  "recommendation": "AI forecast is production-ready",
  "accuracy_score": 87.5
}
```

### Backtest Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `mape` | float | Mean Absolute Percentage Error (lower is better) |
| `bias` | float | Mean signed error (positive = over-forecast) |
| `coverage_10_90` | float \| null | Fraction of actuals within [p10, p90] band |
| `pinball_loss_p10` | float \| null | Quantile loss at the 10th percentile |
| `pinball_loss_p50` | float \| null | Quantile loss at the 50th percentile |
| `pinball_loss_p90` | float \| null | Quantile loss at the 90th percentile |

---

## Model-Specific Quantile Methods

| Model | Method | Notes |
|-------|--------|-------|
| Prophet (real) | Posterior intervals at `interval_width=0.80` | Native Bayesian uncertainty |
| Prophet (fallback) | `1.645sigma` CI scaled to p10/p90 | Gaussian approximation |
| LightGBM (real) | Residual std scaled to p10/p90 | Gaussian approximation |
| LightGBM (fallback) | Rolling std scaled to p10/p90 | Gaussian approximation |
| Chronos | `np.percentile(samples, 10/90)` over 10 Monte Carlo draws | True empirical quantiles |

---

## Dataset Builder (Training Support)

The `dataset_builder.py` module provides `build_timeseries_dataset()` for reproducible walk-forward CV splits:

```python
from ml.demand_forecasting.dataset_builder import build_timeseries_dataset

bundle = build_timeseries_dataset(
    series,                # SalesSeries instance
    n_folds=3,            # Number of walk-forward splits
    val_days=7,           # Validation window per fold
    min_train_rows=30,    # Minimum training set size
    warmup_rows=30,       # Rows discarded for lag warmup
)

# Access splits
for split in bundle.splits:
    model.fit(split.X_train, split.y_train)
    preds = model.predict(split.X_val)

# Feature spec for skew detection
bundle.feature_spec.assert_compatible(other_spec)
```

---

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-02-21 | Initial contract: canonical p10/p50/p90, versioned envelope, dataset builder |
