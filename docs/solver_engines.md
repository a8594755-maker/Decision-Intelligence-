# Solver Engines

## Overview

Planning solve dispatch is centralized in `src/ml/api/solver_engines.py`.

- Stable adapter interface: `ISolverEngine.solve(planning_contract) -> planning_result`
- Registry keys:
  - `ortools` -> OR-Tools CP-SAT adapter
  - `heuristic` -> deterministic heuristic adapter
  - `commercial_stub` -> placeholder adapter for commercial solvers
- All adapters are normalized to planning contract v1.0 via `finalize_planning_response`.

## Engine Switching

### 1) Set default engine (environment variable)

```bash
export DI_SOLVER_ENGINE=heuristic
# or
export DI_SOLVER_ENGINE=ortools
```

### 2) Optional per-request override (feature-flag gated)

Request payload can set:

- `engine_flags.solver_engine` (requested engine key)
- `engine_flags.enable_solver_engine_override` (must be `true`)

Global feature flag must also be enabled:

```bash
export DI_SOLVER_ENGINE_OVERRIDE_ENABLED=true
```

If either flag is off, request-level override is ignored and env default is used.

## Safety Rules

### Environment-aware allowlist

Allowlist is enforced before execution.

- Default allowlist:
  - `prod`: `heuristic`, `ortools`
  - `staging|test|dev`: `heuristic`, `ortools`, `commercial_stub`
- Global override:
  - `DI_SOLVER_ENGINE_ALLOWLIST=heuristic,ortools`
- Environment override:
  - `DI_SOLVER_ENGINE_ALLOWLIST_PROD=heuristic,ortools`
  - `DI_SOLVER_ENGINE_ALLOWLIST_TEST=heuristic,commercial_stub`

### Commercial engine protection in production

Commercial engines are disabled by default in `prod`.

- Enable explicitly only when intended:

```bash
export DI_ENABLE_COMMERCIAL_SOLVERS=true
```

Without this flag, `commercial_*` engines are removed from prod allowlist.

## Status, Meta, and Errors

Adapters standardize:

- Status mapping to contract enum (`OPTIMAL|FEASIBLE|INFEASIBLE|TIMEOUT|ERROR`)
- Stable `solver_meta` required fields (`engine`, `status`, `termination_reason`, `solve_time_ms`, `time_limit`, `seed`, `workers`)
- Error taxonomy (`SolverErrorCode`), surfaced in `solver_meta.error_code`

Selection diagnostics are included in `solver_meta`:

- `engine_key`
- `engine_selected`
- `engine_requested`
- `engine_source`
- `engine_environment`
- `engine_allowlist`
- `engine_selection_notes`

## Extension Guide (Gurobi / CPLEX)

1. Create a new adapter class in `src/ml/api/solver_engines.py` implementing `ISolverEngine`.
2. Convert raw solver output to planning contract payload.
3. Return via `_normalize_engine_payload(...)` so schema stays stable.
4. Register adapter in `ENGINE_REGISTRY`, for example:
   - `"gurobi": GurobiEngine()`
   - `"cplex": CplexEngine()`
5. Add to non-prod allowlist first (staging/test/dev), validate parity tests, then explicitly allow in prod if needed.
6. Keep commercial adapters disabled in prod until licensing/runtime checks are complete.
