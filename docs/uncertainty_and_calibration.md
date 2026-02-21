# Uncertainty Quantification & Calibration Quality Gates (PR-C)

## Overview

PR-C adds probabilistic uncertainty quantification to the demand forecasting pipeline. Every forecast response now includes **p10/p50/p90** quantiles with calibration quality gates that ensure quantile reliability before promotion to production.

## Architecture

```
                         ┌──────────────────────┐
  Backtest Residuals ──▶ │   Quantile Engine    │ ──▶ p10/p50/p90
  (actual - predicted)   │  (residual-conformal) │
                         └──────────────────────┘
                                   │
                         ┌─────────▼──────────┐
                         │ Calibration Metrics │ ──▶ coverage, pinball, bias
                         └─────────┬──────────┘
                                   │
                         ┌─────────▼──────────┐
                         │   Quality Gates     │ ──▶ pass/fail + reasons
                         └────────────────────┘
```

## How Quantiles Are Produced

### Model-Agnostic Baseline: Conformal Residual-Based Intervals

The primary method uses **conformal prediction** via backtest residuals:

1. During backtest, compute residuals: `residual = actual - predicted`
2. Pool residuals (globally or per-series)
3. Compute empirical quantiles of the residual distribution:
   - `q10_offset = quantile(residuals, 0.10)` (typically negative)
   - `q90_offset = quantile(residuals, 0.90)` (typically positive)
4. At inference time:
   - `p50 = point_forecast`
   - `p10 = point_forecast + q10_offset`
   - `p90 = point_forecast + q90_offset`

### Residual Pool Scopes

| Scope | Description | When Used |
|-------|-------------|-----------|
| `global` | Single pool of all residuals across all series | Default; always available |
| `per_series` | Separate pool per SKU/series | When ≥15 samples per series |
| `hybrid_per_series` | Per-series if enough samples, else global fallback | Best of both worlds |
| `none` | No calibration data available | Heuristic ±10% fallback |

The minimum sample threshold for per-series pools is configurable (default: 15).

### Per-Model Quantile Capability

| Model | Native Quantiles | Fallback |
|-------|-----------------|----------|
| **LightGBM** | CI from residual std (±1.645σ) | Quantile Engine |
| **Prophet** | Native `yhat_lower`/`yhat_upper` | Quantile Engine |
| **Chronos** | Monte Carlo sampling (10/90 percentiles) | Quantile Engine |

The Quantile Engine serves as the universal fallback ensuring consistent p10/p50/p90 across all models.

### Guarantees

- **Monotonicity**: `p10 ≤ p50 ≤ p90` enforced at every time step (violations auto-corrected)
- **Non-negativity**: Demand quantiles clamped to ≥ 0 (configurable)
- **Determinism**: Same input always produces same output (no random sampling)

## Calibration Metrics

Computed during backtest over the held-out test set:

| Metric | Formula | Interpretation |
|--------|---------|---------------|
| `coverage_10_90` | fraction of actuals in [p10, p90] | Target ~0.80; higher = wider intervals |
| `pinball_loss_p10` | `τ * max(y-q, 0) + (1-τ) * max(q-y, 0)`, τ=0.10 | Lower is better |
| `pinball_loss_p50` | Same with τ=0.50 | Equivalent to 0.5 × MAE |
| `pinball_loss_p90` | Same with τ=0.90 | Lower is better |
| `pinball_loss_mean` | Average of p10/p50/p90 losses | Summary metric |
| `bias` | `mean(p50 - actual)` | Positive = overestimate |
| `interval_width_10_90` | `mean(p90 - p10)` | Narrower = more informative |

## Quality Gates

### Default Thresholds

| Gate | Threshold | Effect |
|------|-----------|--------|
| `coverage_10_90` | [0.70, 0.90] band | Fail if < 0.70; warn if > 0.90 |
| `bias` | \|bias\| < 50.0 | Fail if exceeded |
| `pinball_loss_mean` | < 100.0 | Fail if exceeded |
| `interval_width_ratio` | < 3.0 × mean(\|actuals\|) | Warning only |

### Gate Evaluation Logic

```python
from ml.uncertainty.quality_gates import evaluate_candidate, QualityGateConfig

metrics = {
    "coverage_10_90": 0.82,
    "pinball_loss_mean": 5.0,
    "bias": 2.0,
    "interval_width_10_90": 20.0,
}

result = evaluate_candidate(metrics)
# result.passed → True/False
# result.reasons → ["coverage_10_90=0.82 within band"]
# result.thresholds → {"coverage_min": 0.70, ...}
```

### Custom Thresholds

```python
config = QualityGateConfig(
    coverage_min=0.60,
    coverage_max=0.95,
    bias_abs_max=100.0,
    pinball_loss_max=200.0,
)
result = evaluate_candidate(metrics, config=config)
```

### Champion Selection Integration

When multiple candidates are evaluated:
- **If any pass gates**: select the one with lowest `pinball_loss_mean`
- **If ALL fail**: select the one with best `coverage_10_90` and mark as **DEGRADED**

A DEGRADED champion still provides quantiles but the API metadata will reflect that calibration did not pass.

## Calibration Artifacts

After each training/backtest run, a `calibration_report.json` is generated:

```json
{
  "residual_pool": "hybrid_per_series",
  "sample_counts": {"SKU-A": 30, "SKU-B": 20},
  "quantiles_used": {
    "global_q10": -12.5,
    "global_q90": 15.3,
    "per_series_q10": {"SKU-A": -10.2},
    "per_series_q90": {"SKU-A": 14.8}
  },
  "achieved_coverage_10_90": 0.82,
  "pinball_losses": {"p10": 3.2, "p50": 5.1, "p90": 4.0},
  "monotonicity_fixes_total": 0,
  "config": {
    "quantile_low": 0.10,
    "quantile_high": 0.90,
    "min_series_samples": 15,
    "enforce_non_negative": true
  }
}
```

The Quantile Engine calibration can also be persisted and loaded for inference:

```python
engine.save("path/to/calibration.json")
engine.load("path/to/calibration.json")
```

## API Response Metadata (Non-Breaking Additions)

### `/demand-forecast` Response

New fields in `forecast`:
- `p10`: array of 10th percentile values per horizon step
- `p50`: array of 50th percentile (median) values
- `p90`: array of 90th percentile values

New fields in `metadata.uncertainty`:
- `uncertainty_method`: `"residual_conformal"` | `"heuristic_fallback"` | `"none"`
- `calibration_scope_used`: `"none"` | `"global"` | `"per_series"` | `"hybrid_per_series"`
- `calibration_passed`: boolean
- `monotonicity_fixes_applied`: integer count

### `/backtest` Response

Each model result now includes:
- `p10`, `p50`, `p90`: quantile arrays
- `residuals`: array of (actual - predicted) values
- `calibration_metrics`: coverage, pinball losses, bias, interval width
- `gate_result`: pass/fail with reasons and thresholds
- `calibration_scope`, `uncertainty_method`, `monotonicity_fixes`

Top-level additions:
- `calibration_report`: artifact-ready calibration data
- `global_residuals_count`: total pooled residuals
- `best_model.gate_passed`: whether best model passed quality gates

## Interpreting Results

### Coverage (coverage_10_90)

- **0.80** (target): ~80% of actuals fall within [p10, p90] — well-calibrated
- **< 0.70**: Intervals too narrow — under-estimating uncertainty
- **> 0.90**: Intervals too wide — over-estimating uncertainty (less useful)

### Pinball Loss

Lower is better. Compares favorably against a naive baseline (last value or seasonal naive). Used for ranking competing models.

### Bias

- **~0**: Unbiased forecasts
- **Large positive**: Systematic overestimation → safety stock bloat
- **Large negative**: Systematic underestimation → stockout risk

## Files

| File | Purpose |
|------|---------|
| `src/ml/uncertainty/__init__.py` | Module exports |
| `src/ml/uncertainty/quantile_engine.py` | Conformal quantile generation + persistence |
| `src/ml/uncertainty/calibration_metrics.py` | Coverage, pinball, bias, interval width |
| `src/ml/uncertainty/quality_gates.py` | Pass/fail evaluation + candidate selection |
| `tests/test_uncertainty.py` | 37 deterministic tests (runs in ~5s) |
