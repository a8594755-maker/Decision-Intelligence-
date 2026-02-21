# Closed-Loop Forecast-to-Planning Re-Parameterization (PR-D)

## Overview

When a new forecast is produced, the closed-loop system automatically evaluates whether planning parameters should be re-derived. If trigger conditions are met, it computes a parameter patch and can optionally re-run the planning solver. Every evaluation is persisted for auditability.

**Pipeline**: Forecast Run -> Evaluate Triggers -> Derive Params -> (dry_run | auto_run) -> Persist Audit

## Architecture

```
Forecast Completion (Workflow A, optimize step)
    |
    v
isClosedLoopEnabled(settings)? --[no]--> return (base plan only)
    |
    [yes]
    v
evaluateTriggers(context)
    |
    +-- T-COVER: coverage_10_90 outside [0.70, 0.95]
    +-- T-UNCERT: uncertainty width changed > 20%
    +-- T-P50:    aggregate p50 shifted > 15%
    +-- T-RISK:   risk_score > 60
    |
    v
should_trigger? --[no]--> return NO_TRIGGER (audit persisted)
    |
    [yes, not in cooldown]
    v
derivePlanningParams(forecast, calibration, risk)
    |
    +-- R-CL1: Select safety_stock_alpha (0.5 / 0.8 / 1.0)
    +-- R-CL2: Adjust stockout_penalty if uncertainty widened
    +-- R-CL3: Add lead_time_buffer for high-risk suppliers
    +-- R-CL4: Compute per-SKU safety_stock
    |
    v
mode? --[dry_run]--> persist patch + audit, return TRIGGERED_DRY_RUN
      --[auto_run]--> apply patch, call runPlanFromDatasetProfile, return RERUN_COMPLETED
      --[manual_approve]--> persist patch, return TRIGGERED_DRY_RUN (requires_approval: true)
```

## Trigger Rules

| Rule | Type | Fires when | Default threshold |
|------|------|-----------|-------------------|
| T-COVER | `coverage_outside_band` | `coverage_10_90` < 0.70 or > 0.95 | lower: 0.70, upper: 0.95 |
| T-UNCERT | `uncertainty_widens` | \|delta(sum(p90-p10))\| / prev > 20% | 0.20 |
| T-P50 | `p50_shift` | \|delta(sum(p50))\| / prev > 15% | 0.15 |
| T-RISK | `risk_severity_crossed` | Any risk_score > 60 | 60 |

Each trigger is evaluated independently. The result is the union of all fired triggers.

## Parameterization Policies

### R-CL1: Safety Stock Alpha Selection

| Condition | Alpha | Rationale |
|-----------|-------|-----------|
| `calibration_passed=true` AND `coverage_10_90` in [0.70, 0.95] | 0.5 | Good quantile calibration |
| `calibration_passed=false` OR metadata absent | 0.8 | Conservative default |
| `coverage_10_90` > 0.95 | 1.0 | Abnormally wide intervals |

Formula: `safety_stock[sku] = avg(p50) + alpha * max(0, avg(p90) - avg(p50))`

### R-CL2: Stockout Penalty Adjustment

When uncertainty width increases beyond threshold vs previous forecast:
```
effective_penalty = base_penalty * (1 + uncertainty_uplift)
                  = 10.0 * (1 + 0.3) = 13.0
```

### R-CL3: Lead Time Buffer

When any supplier has `risk_score > 60`:
```
lead_time_buffer[sku|plant] = lead_time_buffer_high_risk_days (default: 3 days)
```

## Safety Guardrails

### Feature Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `VITE_DI_CLOSED_LOOP` | env var | `false` | Global enable/disable |
| `settings.closed_loop` | settings | `'off'` | Per-run enable: `'on'` or `'off'` |
| `settings.plan.closed_loop_mode` | settings | `'dry_run'` | Mode: `dry_run`, `auto_run`, `manual_approve` |
| `settings.plan.closed_loop_config` | settings | `{}` | Override any CLOSED_LOOP_CONFIG threshold |

### Cooldown & Deduplication

- **Dedupe key**: `{dataset_id}|{trigger_types}|{iso_week}|{forecast_run_id}`
- **Default cooldown**: 30 minutes per dataset
- **Max cooldown**: 24 hours
- Same forecast_run_id cannot trigger twice

### Error Isolation

Errors in the closed-loop pipeline **never** affect the base plan. The runner wraps everything in a try/catch. On error, the base plan result is returned unchanged, and the error is logged and persisted.

## API Endpoints (Python)

### POST /closed-loop/evaluate

Stateless trigger evaluation + param derivation. No side effects.

**Request:**
```json
{
  "dataset_id": 123,
  "forecast_run_id": 456,
  "forecast_series": [{"sku": "A", "plant_id": "P1", "date": "2026-01-01", "p10": 5, "p50": 10, "p90": 15}],
  "calibration_meta": {"calibration_passed": false, "coverage_10_90": 0.55},
  "previous_forecast_series": [...],
  "risk_scores": [{"material_code": "A", "plant_id": "P1", "risk_score": 80}],
  "config_overrides": {}
}
```

**Response:**
```json
{
  "closed_loop_status": "TRIGGERED_DRY_RUN",
  "trigger_decision": {
    "should_trigger": true,
    "reasons": [{"trigger_type": "coverage_outside_band", "severity": "high", ...}],
    "evaluated_at": "2026-02-21T10:00:00.000Z"
  },
  "param_patch": {
    "version": "v0",
    "patch": {
      "safety_stock_by_key": {"A|P1": 14.0},
      "objective": {"stockout_penalty": 10.0, "stockout_penalty_base": 10.0},
      "lead_time_buffer_by_key": {},
      "safety_stock_alpha": 0.8
    },
    "explanation": ["R-CL1: calibration failed; alpha=0.8"],
    "derived_values": {...}
  },
  "explanation": ["R-CL1: calibration failed; alpha=0.8"],
  "planning_run_id": null
}
```

### POST /closed-loop/run

Same as evaluate, but accepts `mode` parameter. Currently returns `TRIGGERED_DRY_RUN` for both modes (server-side auto_run delegated to JS).

## Audit Trail Format

Each closed-loop evaluation produces a `ClosedLoopRun` record:

```json
{
  "id": "cl_run_abc123",
  "dataset_id": 123,
  "forecast_run_id": 456,
  "created_at": "2026-02-21T10:00:00.000Z",
  "status": "TRIGGERED_DRY_RUN",
  "mode": "dry_run",
  "trigger_facts": {
    "calibration_meta": {"calibration_passed": false, "coverage_10_90": 0.55},
    "forecast_metrics": {"mape": 0.12},
    "risk_summary": null
  },
  "trigger_decision": {
    "should_trigger": true,
    "reasons": [...]
  },
  "param_patch": { "patch": {...}, "explanation": [...] },
  "planning_run_id": null,
  "cooldown_key": "123|coverage_outside_band|2026-W08|456",
  "finished_at": "2026-02-21T10:00:01.000Z"
}
```

Artifacts are also persisted via `saveJsonArtifact`:
- `closed_loop_audit` — full audit record
- `closed_loop_param_patch` — the derived parameter patch

## Configuration Reference

All thresholds are defined in `src/services/closed_loop/closedLoopConfig.js`:

```js
CLOSED_LOOP_CONFIG = {
  coverage_lower_band: 0.70,
  coverage_upper_band: 0.95,
  uncertainty_width_change_pct: 0.20,
  p50_shift_pct: 0.15,
  risk_severity_trigger: 60,
  safety_stock_alpha_calibrated: 0.5,
  safety_stock_alpha_uncalibrated: 0.8,
  safety_stock_alpha_wide_uncertainty: 1.0,
  stockout_penalty_base: 10.0,
  stockout_penalty_uncertainty_uplift: 0.3,
  lead_time_buffer_high_risk_days: 3,
  default_cooldown_ms: 1800000,    // 30 min
  max_cooldown_ms: 86400000,       // 24 hr
  default_mode: 'dry_run'
}
```

Override any threshold via `settings.plan.closed_loop_config` or `configOverrides` parameter.

## Debugging

1. Check if closed loop is enabled: look for `closed_loop` in workflow settings
2. Inspect trigger decision: read `closed_loop_audit` artifact for the run
3. Check cooldown: `closedLoopStore.getRunsByDataset(datasetId)` shows recent runs with cooldown keys
4. Verify param patch: `closed_loop_param_patch` artifact contains the exact patch applied
5. Check workflow output: `output_ref.closed_loop.status` in the optimize step shows the evaluation result

## File Layout

```
src/services/closed_loop/
  closedLoopConfig.js       -- Config constants, status enum, trigger types
  forecastToPlanParams.js   -- Pure function: forecast → param patch
  triggerEngine.js          -- Trigger evaluation + cooldown manager
  closedLoopStore.js        -- In-memory audit persistence
  closedLoopRunner.js       -- Pipeline orchestrator
  index.js                  -- Barrel export
  *.test.js                 -- Vitest tests for each module

src/ml/api/main.py          -- Python API endpoints (additive)
tests/test_closed_loop_api.py -- pytest for Python endpoints
docs/closed_loop_forecast_to_plan.md -- This document
```
