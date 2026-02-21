# Model Registry & Promotion Gates (PR-E)

## Overview

The model lifecycle registry tracks model artifacts through four states:

```
CANDIDATE  ->  STAGED  ->  PROD  ->  DEPRECATED
```

Each transition is recorded with full provenance (who, when, why) and can be audited via the promotion log.

## Architecture

### Storage: Filesystem JSON (Option B)

We chose filesystem-based JSON storage with atomic writes for the following reasons:
- Consistent with existing `ModelRegistry` (`demand_forecasting/model_registry.py`) and `ArtifactManager` (`training/artifact_manager.py`)
- No external database dependency required; works offline and in CI
- Atomic writes via `write-to-temp + os.replace` prevent data corruption
- Simple to inspect, debug, and backup

### File Layout

```
registry_store/
  artifacts.json        # {artifact_id: ArtifactRecord}
  prod_pointers.json    # {series_id: artifact_id}
  promotion_log.json    # [PromotionEvent, ...]
  drift_reports/        # DriftReport JSON files
  retrain_triggers/     # RetainTrigger event JSON files
```

## Artifact Record

Each registered artifact contains:

| Field | Type | Description |
|-------|------|-------------|
| `artifact_id` | string | Stable UUID-based identifier (e.g., `art_a1b2c3d4e5f6`) |
| `series_id` | string | Series or SKU identifier |
| `model_name` | string | Model type (e.g., `lightgbm`, `prophet`) |
| `artifact_path` | string | Path to model artifact directory |
| `dataset_fingerprint` | string | From training pipeline |
| `feature_spec_hash` | string | Feature spec version/hash |
| `training_window_start` | string | Training data start date |
| `training_window_end` | string | Training data end date |
| `metrics_summary` | object | `{mape, coverage_10_90, pinball, bias}` |
| `calibration_passed` | bool | Whether PR-C quality gates passed |
| `calibration_scope_used` | string | e.g., `per_series`, `global` |
| `created_at` | string | ISO timestamp |
| `git_sha` | string | Git commit hash at registration time |
| `lifecycle_state` | enum | `CANDIDATE \| STAGED \| PROD \| DEPRECATED` |
| `promotion_history` | array | List of promotion events |

## Lifecycle States

### CANDIDATE
- Default state after `register_artifact()`
- Model has been trained and artifacts saved, but not yet reviewed

### STAGED
- Set via `set_stage(series_id, artifact_id)`
- Indicates the model is under review / testing before production

### PROD
- Set via `promote_to_prod(series_id, artifact_id)`
- The inference pipeline loads this artifact for the given series
- Only one PROD artifact per series at any time

### DEPRECATED
- Automatically set when a PROD artifact is superseded by a new promotion
- Also set when a rollback occurs

## Promotion Gates

Before promotion to PROD, the system checks:

1. **MAPE Gate**: `mape <= 50.0` (configurable)
2. **Coverage Gate**: `coverage_10_90 >= 0.70` (configurable)
3. **Bias Gate**: `|bias| <= 50.0` (configurable)
4. **Pinball Gate**: `pinball_loss <= 100.0` (configurable)
5. **Calibration Gate**: `calibration_passed == True`
6. **Data Requirements**: `n_eval_points >= 7` (configurable)

### Override

Set `override=true` with a `note` explaining the reason to bypass gates. The override is recorded in the promotion history for audit.

## How to Promote / Rollback

### Promote via API

```bash
# 1. Register artifact
curl -X POST /ml/registry/register \
  -d '{"artifact_path": "/path/to/model", "series_id": "SKU-001", "model_name": "lightgbm", ...}'

# 2. Stage it
curl -X POST /ml/registry/stage \
  -d '{"series_id": "SKU-001", "artifact_id": "art_xxx", "note": "Staging for review"}'

# 3. Promote to PROD
curl -X POST /ml/registry/promote \
  -d '{"series_id": "SKU-001", "artifact_id": "art_xxx", "approved_by": "alice", "note": "Passed manual review"}'
```

### Rollback via API

```bash
# Rollback to previous PROD artifact
curl -X POST /ml/registry/rollback \
  -d '{"series_id": "SKU-001", "steps": 1}'
```

### Check Current PROD

```bash
curl /ml/registry/prod?series_id=SKU-001
```

## Inference Integration

The inference pipeline uses this priority order:

1. **PROD pointer** (from lifecycle registry) - if a PROD artifact exists for the series
2. **Champion artifact** (from PR-B AutoML) - if a champion was selected
3. **Fallback** (`recommend_model` / `predict_with_fallback`) - statistical heuristics

Forecast responses include additive metadata:

```json
{
  "metadata": {
    "registry_state": {
      "source": "prod",
      "artifact_id": "art_a1b2c3d4e5f6",
      "promoted_at": "2025-06-01T12:00:00Z"
    },
    "model_version_id": "art_a1b2c3d4e5f6",
    "promotion_note": "Passed manual review"
  }
}
```

## Post-Promotion Auto-Rollback

Behind the promotion gate configuration:

- If post-promotion backtest MAPE degrades by > 20% vs baseline, the system recommends rollback
- Call `check_post_promotion_rollback()` with prod and baseline metrics
- The actual rollback is triggered via the API (manual or automated based on feature flag)

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/ml/registry/register` | POST | Register a new artifact |
| `/ml/registry/stage` | POST | Stage an artifact |
| `/ml/registry/promote` | POST | Promote to PROD (with gate checks) |
| `/ml/registry/rollback` | POST | Rollback to previous PROD |
| `/ml/registry/prod` | GET | Get current PROD pointer(s) |
| `/ml/registry/artifacts` | GET | List artifacts with filters |
| `/ml/registry/promotion-log` | GET | Get promotion event history |

## Phase 4 Guardrails (Enterprise Hardening)

### Feature Flag (default OFF)

- `ENABLE_PROD_ACTION_GUARDRAILS=false` by default.
- When enabled, production-impacting actions (`promote`, `rollback`, `retrain_run`) enforce cooldown + dedupe checks.
- This is a behavior-changing gate and is therefore explicitly feature-flagged.

### Additive Response Fields

Guarded endpoints add (without removing existing fields):

- `guardrails`: decision payload (`enabled`, `allowed`, cooldown/dedupe details)
- `audit_event_id`: immutable event ID written for this action attempt

### Immutable Action Audit

Every production-impacting action attempt writes an immutable append-only event in:

```
registry_store/prod_action_audit/
```

Each event includes:

- `event_id`, `timestamp`, `action`, `result_status`, `effect_applied`
- guardrail decision snapshot
- `event_hash` and `prev_event_hash` (hash-chain linkage)
