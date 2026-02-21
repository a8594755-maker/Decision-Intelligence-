---
owner: planning-platform
status: active
last_reviewed: 2026-02-21
---

# Phase 1 Runbook

Operational runbook for Phase 1 planning (contract v1.0).

## 1) Run API Locally

```bash
./venv312/bin/uvicorn src.ml.api.main:app --host 127.0.0.1 --port 8000 --reload
```

## 2) Sample Planning Run (Sync)

```bash
curl -sS http://127.0.0.1:8000/replenishment-plan \
  -H 'Content-Type: application/json' \
  -d '{
    "contract_version": "1.0",
    "dataset_profile_id": 1,
    "planning_horizon_days": 3,
    "demand_forecast": {"granularity":"daily","series":[
      {"sku":"SKU-A","plant_id":"P1","date":"2026-01-01","p50":10},
      {"sku":"SKU-A","plant_id":"P1","date":"2026-01-02","p50":10},
      {"sku":"SKU-A","plant_id":"P1","date":"2026-01-03","p50":10}
    ]},
    "inventory": [{"sku":"SKU-A","plant_id":"P1","as_of_date":"2025-12-31","on_hand":5,"safety_stock":2,"lead_time_days":0}],
    "open_pos": [],
    "constraints": {"moq":[],"pack_size":[],"max_order_qty":[],"budget_cap":null,"unit_costs":[]},
    "shared_constraints": {"production_capacity_per_period": 30, "inventory_capacity_per_period": 40},
    "objective": {"optimize_for":"balanced","stockout_penalty":10,"holding_cost":0.1,"service_level_target":null},
    "solver": {"deterministic_mode": true, "seed": 0, "workers": 1, "time_limit_seconds": 5},
    "multi_echelon": {"mode":"off"},
    "bom_usage": []
  }' | jq
```

## 3) Async Runs

Submit async:

```bash
curl -sS http://127.0.0.1:8000/replenishment-plan \
  -H 'Content-Type: application/json' \
  -d '{
    "async": true,
    "user_id": "00000000-0000-0000-0000-000000000001",
    "dataset_profile_id": 1,
    "dataset_fingerprint": "profile:1",
    "planning_horizon_days": 7,
    "demand_forecast": {"granularity":"daily","series":[{"sku":"SKU-A","date":"2026-01-01","p50":5}]}
  }' | jq
```

Lifecycle:
- `QUEUED -> RUNNING -> SUCCEEDED | FAILED | CANCELLED`

Planning status is independent from job lifecycle:
- `SUCCEEDED` job may contain plan `OPTIMAL | FEASIBLE | INFEASIBLE | TIMEOUT`
- `FAILED` reserved for system/runtime errors

Event stream names (canonical):
- `started`
- `validation_complete`
- `model_built`
- `solving_started`
- `solving_finished`
- `persisted`
- `completed`

Legacy aliases still emitted for compatibility:
- `job_started`, `result_persisted`, `job_completed`

## 4) Switch Engine

```bash
export DI_SOLVER_ENGINE=heuristic
export DI_SOLVER_ENGINE=ortools
```

Multi-echelon:
- request-level: `"multi_echelon": {"mode":"bom_v0"}`
- fallback env when request does not set mode: `DI_MULTI_ECHELON=true`

## 5) Deterministic Test Commands

Curated planning + forecast regression gate (PR4-D):

```bash
./venv312/bin/python -m pytest -q tests/regression
```

Equivalent npm shortcut:

```bash
npm run test:regression
```

Contract/capacity/timeout/async coverage:

```bash
./venv312/bin/python -m pytest -q \
  tests/test_planning_api_contract.py \
  tests/test_planning_contract_parity.py \
  tests/test_planning_capacity_and_diagnostics.py \
  tests/test_planning_determinism_timeout.py \
  tests/test_async_run_layer.py
```

Full planning verification slice:

```bash
./venv312/bin/python -m pytest -q \
  tests/test_replenishment_solver.py \
  tests/test_multi_echelon_solver.py \
  tests/test_planning_api_contract.py \
  tests/test_planning_capacity_and_diagnostics.py \
  tests/test_planning_contract_parity.py \
  tests/test_planning_determinism_timeout.py \
  tests/test_planning_engine_parity.py \
  tests/test_planning_regression_suite.py \
  tests/test_async_run_layer.py
```

## 6) Fixture Inventory

Planning regression fixtures:
- `tests/fixtures/planning/feasible_basic_single.json`
- `tests/fixtures/planning/feasible_tight_capacity.json`
- `tests/fixtures/planning/infeasible_capacity.json`
- `tests/fixtures/planning/timeout_hard_case.json`
- `tests/fixtures/planning/multi_echelon_bom_basic.json`

Forecast regression fixtures:
- `tests/fixtures/forecast/steady_weekly_small.json`
- `tests/fixtures/forecast/upward_trend_small.json`

Contract/capacity deterministic fixtures:
- `tests/fixtures/planning/feasible_single.json`
- `tests/fixtures/planning/tight_capacity_single.json`
- `tests/fixtures/planning/infeasible_capacity_single.json`
- `tests/fixtures/planning/timeout_single.json`
- `tests/fixtures/planning/multi_sku_shared_capacity.json`
- `tests/fixtures/planning/multi_echelon_bom_shortage.json`

## 7) Status and Debugging

Primary interpretation sources:
- `status`
- `solver_meta`
- `infeasible_reasons`
- `proof.constraints_checked`
- `proof.constraint_tags`
- `diagnostics`

When `INFEASIBLE`:
- inspect `infeasible_reason_details[*].top_offending_tags`
- check capacity tags `CAP_INV[...]`, `CAP_PROD[...]`
- run with `diagnose_mode=true` and inspect `diagnostics.relaxation_analysis`

When `TIMEOUT`:
- check `solver_meta.termination_reason`
- if feasible incumbent exists, expect non-empty `plan_lines`
- for deterministic CI coverage, use `solver.force_timeout=true` fixtures

When async `CANCELLED`:
- expected final lifecycle is `CANCELLED`
- persisted planning payload should be cleaned up / absent

## 8) CI Budget

Target runtime for curated planning + forecast regression suite:
- roughly `2-3 minutes` in CI

Deterministic defaults:
- `seed=0`
- `workers=1`
- bounded `time_limit_seconds`
- `PYTHONHASHSEED=0`
- single-threaded numeric env (`OMP_NUM_THREADS=1`, `MKL_NUM_THREADS=1`, `OPENBLAS_NUM_THREADS=1`)

## 9) Phase 1 DoD Checklist

- Contract v1.0 documented and enforced
- Cross-engine schema parity validated
- Capacity constraints enforced with tag evidence
- Infeasible diagnostics actionable and structured
- Timeout semantics deterministic and tested
- Async lifecycle and cancel behavior tested
- Regression fixtures source-controlled and referenced
