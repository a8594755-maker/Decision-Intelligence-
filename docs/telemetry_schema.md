---
owner: platform-lead
status: active
last_reviewed: 2026-02-21
schema_version: "1"
---

# Telemetry Schema Spec (PR4-B Implementation Target)

## Scope

This spec defines the structured terminal telemetry event that all domains must emit:

- `solver`
- `forecast`
- `closed_loop`

Contract name:

- `event_name`: `di.job.terminal`
- `event_version`: `1`

One terminal event is required per terminal run attempt.

## Event Contract

## Required Fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `event_id` | string (UUID) | yes | Unique event identifier for idempotent ingestion. |
| `event_name` | string | yes | Constant: `di.job.terminal`. |
| `event_version` | integer | yes | Constant: `1`. |
| `emitted_at` | string (ISO-8601 UTC) | yes | Event emit timestamp. |
| `env` | enum(`dev`,`staging`,`prod`) | yes | Runtime environment. |
| `git_sha` | string | yes | Deploy commit SHA (`unknown` allowed only in dev). |
| `domain` | enum(`solver`,`forecast`,`closed_loop`) | yes | Execution domain. |
| `run_id` | string or integer | yes | Run identifier from run store. |
| `job_id` | string or null | yes | Async job identifier; null for sync paths. |
| `engine` | string | yes | Primary execution engine (`cp_sat`, `heuristic`, `lightgbm`, `prophet`, etc.). |
| `status` | enum(`SUCCESS`,`INFEASIBLE`,`TIMEOUT`,`ERROR`,`CANCELLED`) | yes | Canonical terminal status. |
| `termination_reason` | string | yes | Stable reason code within status family. |
| `solve_time_ms` | integer (`>=0`) | yes | Compute runtime in milliseconds. |
| `queue_wait_ms` | integer (`>=0`) | yes | Queue wait in milliseconds (`0` for sync). |
| `objective_value` | number or null | yes | Objective value if produced; else null. |
| `infeasible_reason_summary` | object or null | yes | Sanitized infeasibility summary; null unless status is `INFEASIBLE`. |
| `created_at` | string (ISO-8601 UTC) | yes | Job/run creation timestamp. |
| `started_at` | string (ISO-8601 UTC) | yes | Execution start timestamp. |
| `finished_at` | string (ISO-8601 UTC) | yes | Execution end timestamp. |
| `dataset_id` | string or integer or null | yes | Dataset identifier (raw; internal sink only). |
| `dataset_id_hash` | string or null | yes | Hashed dataset identifier for low-trust sinks. |
| `series_id` | string or null | yes | Series identifier for forecast/retrain scoped runs. |
| `series_id_hash` | string or null | yes | Hashed series identifier for low-trust sinks. |

## Optional but Recommended Fields

| Field | Type | Description |
| --- | --- | --- |
| `workflow` | string | Workflow name (for example `workflow_A_replenishment`). |
| `attempt` | integer | Retry attempt number (1-based). |
| `time_limit_seconds` | number | Configured solver/step timeout budget. |
| `flag_snapshot` | object | Evaluated feature flags at execution time. |
| `error_code` | string or null | Structured error code for `ERROR`/`TIMEOUT` families. |
| `termination_reason_raw` | string or null | Original unnormalized reason when mapped to canonical reason. |
| `workload_class` | enum(`small`,`medium`,`large`,`unknown`) | SLO bucket classification. |

## Canonical Status Mapping

| Source status | Canonical `status` |
| --- | --- |
| Planning `OPTIMAL`, `FEASIBLE`; forecast success; closed-loop success states | `SUCCESS` |
| Planning `INFEASIBLE` | `INFEASIBLE` |
| Planning `TIMEOUT`, step timeout events | `TIMEOUT` |
| Planning `ERROR`, failed lifecycle, uncaught exceptions | `ERROR` |
| Job lifecycle `canceled/cancelled` or explicit cancel path | `CANCELLED` |

Unknown source statuses must map to `ERROR`.

## Termination Reason Vocabulary

Allowed reason codes by status family:

- `SUCCESS`: `OPTIMAL`, `FEASIBLE`, `COMPLETED`, `NO_TRIGGER`, `TRIGGERED_DRY_RUN`, `RERUN_COMPLETED`
- `INFEASIBLE`: `INFEASIBLE`, `PRECHECK_FAILURE`, `NO_FEASIBLE_SOLUTION`
- `TIMEOUT`: `FORCED_TIMEOUT`, `TIME_LIMIT_FEASIBLE`, `TIME_LIMIT_NO_FEASIBLE`, `STEP_TIMEOUT`
- `ERROR`: `PLANNING_ERROR`, `SOLVER_RUNTIME_ERROR`, `VALIDATION_ERROR`, `UPSTREAM_ERROR`, `UNEXPECTED_ERROR`
- `CANCELLED`: `CANCELLED`, `USER_CANCELLED`, `WORKER_CANCELLED`

If raw reason is outside vocabulary:

- set `termination_reason="OTHER"`
- place original value in `termination_reason_raw`

## Field Derivation Rules

- `queue_wait_ms = max(0, started_at - created_at)` in milliseconds.
- `solve_time_ms`:
  - `solver`: `solver_meta.solve_time_ms` if available; fallback to optimize step duration.
  - `forecast`: forecast step runtime duration.
  - `closed_loop`: closed-loop run runtime (created to finished).
- `objective_value`:
  - set from solver objective for solver/closed-loop rerun outputs
  - null for forecast or evaluate-only closed-loop paths

## Infeasible Summary Format (Safe, Non-PII)

`infeasible_reason_summary` must be structured and sanitized:

```json
{
  "categories": ["capacity", "budget"],
  "top_constraint_tags": ["CAP_PROD", "BUDGET_GLOBAL"],
  "reason_count": 4,
  "summary_text": "Capacity and budget constraints prevent feasibility."
}
```

Safety requirements:

- No raw SKU names, supplier names, or user-entered text.
- `summary_text` max length: 240 chars.
- Use only taxonomy tags/categories from controlled vocabularies.

## Privacy and Hashing Rules

- For trusted internal telemetry storage, raw `dataset_id` and `series_id` may be retained.
- For exported/shared telemetry, raw IDs must be null and hashed fields must be present.
- Hash algorithm: `sha256("<env>:<salt>:<id>")`.
- Salt source: `DI_TELEMETRY_HASH_SALT` (environment-specific secret).

## Example Event

```json
{
  "event_id": "8f8d9c54-4c96-4b48-9d8b-2ce4a7d9a8f2",
  "event_name": "di.job.terminal",
  "event_version": 1,
  "emitted_at": "2026-02-21T06:00:00Z",
  "env": "staging",
  "git_sha": "a1b2c3d4",
  "domain": "solver",
  "workflow": "workflow_A_replenishment",
  "run_id": 1042,
  "job_id": "36a5bf70-cb8a-4d12-8d3b-87e590c99093",
  "engine": "cp_sat",
  "status": "TIMEOUT",
  "termination_reason": "TIME_LIMIT_FEASIBLE",
  "solve_time_ms": 9134,
  "queue_wait_ms": 640,
  "objective_value": 12450.25,
  "infeasible_reason_summary": null,
  "created_at": "2026-02-21T05:59:48Z",
  "started_at": "2026-02-21T05:59:49Z",
  "finished_at": "2026-02-21T05:59:58Z",
  "dataset_id": 17,
  "dataset_id_hash": "ed6f0b4d3f31c2d6a8742e7f97f6f2c4dd08d41fe4f1db84a95a5ad9e7c9f0ff",
  "series_id": null,
  "series_id_hash": null,
  "attempt": 1,
  "time_limit_seconds": 10,
  "flag_snapshot": {
    "DI_FF_AUTO_RERUN": false,
    "DI_FF_AUTO_RETRAIN": false,
    "DI_FF_AUTO_ROLLBACK": false,
    "DI_FF_COMMERCIAL_SOLVER": false
  },
  "error_code": null,
  "termination_reason_raw": null,
  "workload_class": "small"
}
```

## PR4-B Implementation Requirements

- Emit this terminal event for every terminal run attempt across all three domains.
- Use at-least-once emission with idempotent ingestion keyed by `event_id`.
- Validate payload shape in automated tests (schema/contract tests).
- Add status-mapping tests to ensure only canonical statuses are emitted.
- Backfill `queue_wait_ms` and `solve_time_ms` where currently missing.
