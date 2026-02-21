---
owner: platform-lead
status: active
last_reviewed: 2026-02-21
---

# Feature Flags and Environment Policy (Phase 4)

## Scope

This spec defines:

- environment separation rules (`dev`, `staging`, `prod`)
- feature flag governance for Phase 4 automation
- default flag values
- cooldown and dedupe requirements for auto actions

This policy applies to solver, forecast, and closed-loop workflows.

## Environment Separation Policy

## Required Isolation

| Layer | `dev` | `staging` | `prod` |
| --- | --- | --- | --- |
| Supabase project / DB | Dedicated dev project | Dedicated staging project | Dedicated prod project |
| ML API deployment | Local or dev worker pool | Staging worker pool | Production worker pool |
| Artifact storage | `artifacts/dev/...` | `artifacts/staging/...` | `artifacts/prod/...` |
| Telemetry sink | Dev dataset/table | Staging dataset/table | Prod dataset/table |
| Feature flag source | Dev config | Staging config | Prod config |

Non-negotiable rules:

- No shared database schema between environments.
- No write path from `dev` or `staging` to `prod` DB, queues, or artifact buckets.
- Credentials are environment-specific; no prod secrets in lower environments.
- Production data copied to lower environments must be sanitized first.

## Deployment Promotion

Allowed path:

1. `dev` validation
2. `staging` soak + SLO gate
3. `prod` rollout

Required checks before prod:

- telemetry contract tests pass
- staging SLO gate passes (`docs/phase4_dod_and_slos.md`)
- explicit feature-flag decision per flag

## Feature Flag Registry

## Canonical Flag Keys

All automation flags are server-side booleans:

- `DI_FF_AUTO_RERUN`
- `DI_FF_AUTO_RETRAIN`
- `DI_FF_AUTO_ROLLBACK`
- `DI_FF_COMMERCIAL_SOLVER`

Compatibility aliases (read-only fallback during migration):

- `ENABLE_AUTO_RETRAIN` -> `DI_FF_AUTO_RETRAIN`
- existing local closed-loop toggle (`VITE_DI_CLOSED_LOOP`) may be honored in `dev` only, but must not control `prod`.

## Defaults by Environment

All four flags default to `false` in every environment, including production.

| Flag | `dev` default | `staging` default | `prod` default |
| --- | --- | --- | --- |
| `DI_FF_AUTO_RERUN` | `false` | `false` | `false` |
| `DI_FF_AUTO_RETRAIN` | `false` | `false` | `false` |
| `DI_FF_AUTO_ROLLBACK` | `false` | `false` | `false` |
| `DI_FF_COMMERCIAL_SOLVER` | `false` | `false` | `false` |

Production enablement requirements:

- explicit approval ticket
- owner + on-call signoff
- expiry/review date on the toggle
- rollback plan documented before enablement

## Flag Semantics

| Flag | Behavior when `true` | Behavior when `false` |
| --- | --- | --- |
| `DI_FF_AUTO_RERUN` | Closed-loop trigger can auto-submit planning rerun. | Closed-loop stays evaluation-only (`dry_run`/manual). |
| `DI_FF_AUTO_RETRAIN` | Drift triggers may schedule retrain jobs automatically. | Retrain remains manual-only. |
| `DI_FF_AUTO_ROLLBACK` | Post-promotion degradation can trigger automatic rollback. | Rollback remains manual-only. |
| `DI_FF_COMMERCIAL_SOLVER` | Commercial/paid solver engine path is eligible. | Only open-source/default solver engines allowed. |

## Evaluation Precedence

Flag evaluation order must be:

1. emergency kill switch (force `false`)
2. runtime flag value from environment configuration
3. code default (`false`)

Request payloads can narrow behavior but cannot elevate a disabled production flag.

## Cooldown and Dedupe Expectations

Auto-action flags must implement both dedupe keys and cooldown windows.

| Flag | Dedupe key | Cooldown | Expected behavior |
| --- | --- | --- | --- |
| `DI_FF_AUTO_RERUN` | `(dataset_id, trigger_type, iso_week, forecast_run_id)` | default 30 minutes, max 24 hours | Prevent repeated reruns for same trigger context. |
| `DI_FF_AUTO_RETRAIN` | `(series_id, trigger_type, window_end)` | 24 hours | At most one auto-retrain per series/trigger window per day. |
| `DI_FF_AUTO_ROLLBACK` | `(series_id, degraded_artifact_id, baseline_artifact_id, window_end)` | 24 hours | Prevent rollback thrashing on repeated degradation checks. |
| `DI_FF_COMMERCIAL_SOLVER` | `(run_id, job_id, solver_request_hash)` | no time cooldown; strict idempotency required | Prevent duplicate paid solver submissions for same run. |

Implementation requirements:

- Dedupe key uniqueness must be enforced in persistent storage (not memory only).
- Cooldown suppression events must be telemetry-visible (reason + expiry timestamp).
- Duplicate suppression must be deterministic across worker restarts.

## Audit and Safety Requirements

- Every flag change must record `who`, `when`, `why`, and `ticket`.
- Every automatic action triggered by a flag must log `flag_snapshot` in telemetry.
- Incident response runbook must include a one-step kill-switch for each flag.

## Config Skeleton (Reference)

```json
{
  "env": "staging",
  "version": 1,
  "flags": {
    "DI_FF_AUTO_RERUN": false,
    "DI_FF_AUTO_RETRAIN": false,
    "DI_FF_AUTO_ROLLBACK": false,
    "DI_FF_COMMERCIAL_SOLVER": false
  },
  "updated_at": "2026-02-21T00:00:00Z",
  "updated_by": "platform-owner"
}
```
