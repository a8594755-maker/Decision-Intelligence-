---
owner: platform-lead
status: active
last_reviewed: 2026-02-21
---

# Phase 4 Definition of Done and SLO/SLI

## Scope

This document defines measurable Phase 4 completion criteria for three execution domains:

- `solver` (planning optimize)
- `forecast` (forecast generation jobs)
- `closed_loop` (trigger evaluation plus optional rerun submission)

SLO evaluation windows:

- `prod`: rolling 28-day window
- `staging`: rolling 7-day window (release gate signal)
- `dev`: no hard SLO; telemetry only

Unless otherwise noted, SLO denominators exclude `CANCELLED` runs.

## Workload Class for Primary Latency SLO

Primary latency targets are set on `small` fixtures:

- `solver.small`: <= 50 SKUs, horizon <= 14 days, <= 5,000 BOM edges.
- `forecast.small`: <= 500 series, horizon <= 30 days.
- `closed_loop.small`: <= 500 series; if rerun is triggered, the rerun payload must satisfy `solver.small`.

## SLI Definitions

All SLIs are computed from terminal telemetry events (`di.job.terminal`, version `1`) grouped by `env` and `domain`.

| SLI | Definition |
| --- | --- |
| `solve_time_ms_p50/p95/p99` | Percentiles of `solve_time_ms` from terminal events. |
| `timeout_rate` | `count(status=TIMEOUT) / count(status in {SUCCESS, INFEASIBLE, TIMEOUT, ERROR})` |
| `infeasible_rate` | `count(status=INFEASIBLE) / count(status in {SUCCESS, INFEASIBLE, TIMEOUT, ERROR})` |
| `success_rate` | `count(status=SUCCESS) / count(status in {SUCCESS, INFEASIBLE, TIMEOUT, ERROR})` |
| `queue_latency_p50/p95/p99` | Percentiles of `queue_wait_ms`, where `queue_wait_ms = started_at - created_at` (ms). |

Measurement notes:

- `solve_time_ms`:
  - `solver`: use `solver_meta.solve_time_ms` when present, else optimize step duration.
  - `forecast`: use forecast step execution duration.
  - `closed_loop`: use closed-loop orchestration runtime (created to finished).
- For synchronous execution, set `queue_wait_ms=0`.
- `CANCELLED` is tracked separately and excluded from SLO burn.

## SLO Targets

### Production Targets (`prod`, small fixtures)

| Domain | `solve_time_ms` target | `timeout_rate` | `infeasible_rate` | `success_rate` | `queue_latency` |
| --- | --- | --- | --- | --- | --- |
| `solver` | p50 <= 2,000; p95 <= 10,000; p99 <= 30,000 | < 1.0% | <= 12.0% | >= 87.0% | p95 <= 5,000; p99 <= 20,000 |
| `forecast` | p50 <= 800; p95 <= 4,000; p99 <= 10,000 | < 0.5% | = 0.0% expected | >= 98.5% | p95 <= 5,000; p99 <= 20,000 |
| `closed_loop` (evaluate-only: no rerun) | p50 <= 500; p95 <= 2,000; p99 <= 5,000 | < 0.5% | 0.0% expected | >= 99.0% | p95 <= 5,000; p99 <= 20,000 |
| `closed_loop` (rerun path) | p50 <= 3,000; p95 <= 20,000; p99 <= 45,000 | < 1.0% | <= 12.0% | >= 87.0% | p95 <= 5,000; p99 <= 20,000 |

### Staging Release Gate

Before promotion to production, staging must satisfy the same targets for:

- at least 500 terminal runs per domain, or
- 7 consecutive days of traffic (whichever comes first).

## Error Taxonomy

Canonical status values for telemetry and SLO:

| Status | Meaning | Typical source mapping | SLO denominator |
| --- | --- | --- | --- |
| `SUCCESS` | Job produced a valid, consumable output. | Planning `OPTIMAL/FEASIBLE`; forecast completed; closed-loop `NO_TRIGGER/TRIGGERED_DRY_RUN/RERUN_COMPLETED`. | Yes |
| `INFEASIBLE` | Execution completed but hard constraints cannot be satisfied. | Planning `INFEASIBLE`. | Yes |
| `TIMEOUT` | Time budget exceeded before normal completion. | `TIMEOUT`, `FORCED_TIMEOUT`, `STEP_TIMEOUT`, `TIME_LIMIT_*`. | Yes |
| `ERROR` | Runtime/system/data-contract failure. | Planning `ERROR`, worker/job `FAILED`, unhandled exceptions. | Yes |
| `CANCELLED` | User/system cancellation before terminal completion. | Job status `canceled/cancelled`, termination reason `CANCELLED`. | No (tracked separately) |

Unknown raw status handling:

- Map to `ERROR`.
- Preserve original value in debug metadata (`raw_status`).

## Phase 4 Done Checklist

Phase 4 is done only when all items below are true:

- [ ] Telemetry schema in `docs/telemetry_schema.md` is implemented for `solver`, `forecast`, and `closed_loop`.
- [ ] >= 99.0% of terminal runs emit one terminal telemetry event within 60 seconds of completion.
- [ ] `status` is in canonical enum for >= 99.9% of terminal events.
- [ ] `solve_time_ms` is populated for >= 95.0% of terminal events.
- [ ] `queue_wait_ms` is populated (or set to 0 for sync paths) for >= 95.0% of terminal events.
- [ ] Dashboards exist for p50/p95/p99 solve time, timeout rate, infeasible rate, success rate, queue latency per domain/environment.
- [ ] Alerts exist for SLO burn: warning at 50% 7-day burn, critical at 100% burn.
- [ ] Production defaults for auto actions are OFF per `docs/feature_flags.md`.
- [ ] Cooldown and dedupe controls are implemented and tested for auto-rerun, auto-retrain, and auto-rollback.
- [ ] Staging gate passes with defined sample size/window and production meets SLOs for 2 consecutive weekly reviews.

## References

- `docs/feature_flags.md`
- `docs/telemetry_schema.md`
- `docs/planning_api_contract.md`
- `docs/phase1_runbook.md`
