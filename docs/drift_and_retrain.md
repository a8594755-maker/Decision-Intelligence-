# Drift Monitoring & Retrain Triggers (PR-E)

## Overview

This system monitors model health through two drift signals and triggers retraining when degradation is detected.

## Drift Metrics

### A) Data Drift (Input Distribution Shift)

Compares a recent window of input values against a baseline window.

| Metric | Threshold | Interpretation |
|--------|-----------|----------------|
| **PSI** (Population Stability Index) | > 0.2 | Significant distribution shift |
| **Z-score shift** (mean shift) | > 2.0 | Mean has shifted significantly |
| **Std ratio** | informational | Volatility change |

**PSI Interpretation:**
- PSI < 0.1: No significant shift
- PSI 0.1-0.2: Moderate shift (monitor)
- PSI > 0.2: Significant shift (investigate/retrain)

### B) Residual Drift (Forecast Error Shift)

Compares forecast errors between baseline and recent windows.

| Metric | Threshold | Interpretation |
|--------|-----------|----------------|
| **MAPE increase** | > 10 points | Forecast accuracy degrading |
| **Bias shift** | > 2.0 std | Systematic error changed |
| **Coverage drop** | > 0.15 | Prediction intervals no longer calibrated |
| **Residual mean shift** | informational | Error distribution changed |
| **Residual std ratio** | informational | Error volatility changed |

### Drift Flags

The system produces these flags in `DriftReport.drift_flags`:

| Flag | Trigger |
|------|---------|
| `data_drift_high` | PSI > threshold |
| `mean_shift_high` | Z-score > threshold |
| `residual_drift_high` | MAPE increased significantly |
| `bias_shift_high` | Bias shifted beyond threshold |
| `coverage_bad` | Coverage dropped beyond threshold |

### Drift Scores

- `data_drift_score`: 0-1 combined score from PSI and z-score
- `residual_drift_score`: 0-1 combined score from MAPE, bias, and coverage
- `drift_score`: 0-1 combined overall (50% data + 50% residual)

## Retrain Trigger Rules

### Rule 1: Coverage Degradation
**Trigger**: `coverage_10_90` outside acceptable band `[0.65, 0.95]` for 2+ consecutive windows.

**Rationale**: If prediction intervals are consistently miscalibrated, the underlying model needs retraining.

### Rule 2: MAPE Degradation
**Trigger**: MAPE increased by >= 15% vs baseline/prod model.

**Rationale**: Point forecast accuracy has significantly worsened.

### Rule 3: Residual Drift
**Trigger**: `residual_drift_score > 0.6`.

**Rationale**: The forecast error pattern has changed (new bias, wider errors, etc.).

### Rule 4: Data Drift
**Trigger**: `data_drift_score > 0.6`.

**Rationale**: The input data distribution has shifted (new demand patterns).

### Severity Classification

| Severity | Max trigger score | Action |
|----------|------------------|--------|
| `high` | >= 0.7 | Immediate retrain recommended |
| `medium` | >= 0.4 | Monitor closely, schedule retrain |
| `low` | < 0.4 | Informational, no action needed |
| `none` | no triggers | Healthy |

## Operational Guards

### Cooldown
- Default: 24 hours per series
- A series cannot be retrained more than once within the cooldown window
- Remaining cooldown is reported in `cooldown_remaining_seconds`

### Dedupe
- Dedupe key: `(series_id, trigger_type, window_end)`
- If the same trigger was already fired for the same window, it's suppressed
- Prevents duplicate retrains from repeated evaluations

### Feature Flag: Auto-Retrain
- `ENABLE_AUTO_RETRAIN=false` (default)
- When enabled, a scheduler can automatically trigger retrains
- Manual retrain is always available regardless of this flag

## Operational Playbook

### When Drift Triggers

```
1. Check /ml/drift/reports?series_id=SKU-001
   → Review drift_flags and drift_score

2. If data_drift_high:
   → Check if upstream data source changed
   → Verify feature pipeline is working correctly
   → Retrain if data change is legitimate

3. If residual_drift_high:
   → Run backtest to confirm degradation
   → Check if recent actuals are anomalous
   → Retrain with updated data window

4. If coverage_bad:
   → Check calibration quality
   → May need to retrain or recalibrate quantile engine
```

### How to Respond to Retrain Trigger

```bash
# 1. Evaluate the trigger
curl -X POST /ml/retrain/evaluate \
  -d '{
    "series_id": "SKU-001",
    "data_drift_score": 0.8,
    "residual_drift_score": 0.5,
    "recent_mape": 25.0,
    "baseline_mape": 12.0
  }'

# 2. If should_retrain=true, run retrain
curl -X POST /ml/retrain/run \
  -d '{"series_id": "SKU-001", "model_name": "lightgbm", "reason": "MAPE degradation"}'

# 3. Register the new artifact
curl -X POST /ml/registry/register \
  -d '{"artifact_path": "/path/to/new/model", "series_id": "SKU-001", ...}'

# 4. Promote (after validation)
curl -X POST /ml/registry/promote \
  -d '{"series_id": "SKU-001", "artifact_id": "art_xxx", "note": "Retrained after drift"}'
```

### When to Rollback

```bash
# If post-promotion backtest shows degradation:
curl -X POST /ml/registry/rollback \
  -d '{"series_id": "SKU-001", "steps": 1}'
```

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/ml/drift/analyze` | POST | Run drift analysis (data + residual) |
| `/ml/drift/reports` | GET | List drift reports |
| `/ml/retrain/evaluate` | POST | Evaluate retrain triggers |
| `/ml/retrain/run` | POST | Kick off a retrain job |

## Configuration

All thresholds are configurable via `DriftConfig` and `RetainTriggerConfig` dataclasses. Defaults are:

```python
# Drift thresholds
psi_threshold = 0.2
zscore_shift_threshold = 2.0
mape_increase_threshold = 10.0
bias_shift_threshold = 2.0
coverage_drop_threshold = 0.15

# Trigger thresholds
coverage_min = 0.65
coverage_max = 0.95
coverage_consecutive_windows = 2
mape_degradation_pct = 15.0
residual_drift_threshold = 0.6
data_drift_threshold = 0.6
cooldown_hours = 24.0
```

## Phase 4 Guardrails

- `POST /ml/retrain/run` now emits immutable audit events for every attempt.
- Additive response fields:
  - `guardrails`
  - `audit_event_id`
  - `guardrails_overridden_by_force`
- Cooldown/dedupe blocking at run-time is feature-flagged via:
  - `ENABLE_PROD_ACTION_GUARDRAILS=false` (default)

## Persistence

- **Drift reports**: Stored as JSON in `registry_store/drift_reports/`
- **Trigger events**: Stored as JSON in `registry_store/retrain_triggers/`
- **Promotion events**: Stored in `registry_store/promotion_log.json`
- All writes are atomic (temp file + rename) for crash safety
