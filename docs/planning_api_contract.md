# Planning API Contract v1.0

This is the stable Phase 1 planning contract used by both engines:
- `cp_sat` (OR-Tools)
- `heuristic` (deterministic fallback)

The response schema is engine-parity stable. Values can differ; response keys cannot.

## Compatibility Rules
- Contract version: `contract_version: "1.0"`
- Backward compatibility: additive changes only
- Legacy alias kept: `plan` mirrors `plan_lines`
- Status enum is fixed:
  - `OPTIMAL`
  - `FEASIBLE`
  - `INFEASIBLE`
  - `TIMEOUT`
  - `ERROR`

## Request Schema (v1.0)

Required root fields:
- `planning_horizon_days` (int > 0)
- one of:
  - `demand_forecast.series[]`, or
  - `items[].demand[] | items[].series[] | items[].demand_forecast.series[]`

Optional root fields:
- `contract_version` (string, defaults to `"1.0"`)
- `dataset_profile_id`
- `inventory[]`
- `open_pos[]`
- `constraints`
- `shared_constraints`
- `objective`
- `solver` or `settings.solver`
- `items[]`
- `diagnose_mode`
- `multi_echelon`
- `bom_usage[]`

`constraints` (optional):
- `moq[]`, `pack_size[]`, `max_order_qty[]`
- `budget_cap`
- `unit_costs[]`
- `inventory_capacity_per_period`
- `production_capacity_per_period`

`shared_constraints` (optional, additive):
- `budget_cap`
- `budget_mode` (`auto|quantity|spend`)
- `production_capacity_per_period`
- `inventory_capacity_per_period`
- `priority_weights` (`{sku: weight}`)

`solver` (optional, additive):
- `time_limit_seconds`
- `seed`
- `workers`
- `deterministic_mode`
- `force_timeout`

`multi_echelon` (optional):
- `mode` (`off|bom_v0`)
- `lot_sizing_mode`
- `max_bom_depth`
- capacity fields
- mapping/config extensions

## Response Schema (v1.0)

Always present:
- `contract_version`
- `status`
- `plan_lines[]`
- `plan[]` (legacy alias)
- `kpis`
- `solver_meta`
- `infeasible_reasons[]`
- `infeasible_reason_details[]`
- `diagnostics`
- `proof`
- `component_plan[]`
- `component_inventory_projection`
- `bottlenecks`

Additive fields:
- `shared_kpis`
- `proof.constraint_tags[]`
- `proof.infeasibility_analysis`
- `proof.relaxation_analysis[]`
- `proof.diagnose_mode`

### `solver_meta` Required Keys
- `engine`
- `status`
- `termination_reason`
- `solve_time_ms`
- `time_limit`
- `seed`
- `workers`

Common additional keys:
- `solver`
- `cp_status_name`
- `objective_value`
- `best_bound`
- `gap`
- deterministic flags (`deterministic_mode`, `time_limit_hit`, etc.)

### `proof` Required Keys
- `objective_terms[]`
- `constraints_checked[]`
- `constraint_tags[]`
- `infeasibility_analysis`
- `relaxation_analysis[]`
- `diagnose_mode`

## Status Taxonomy
- `OPTIMAL`: feasible and proven optimal
- `FEASIBLE`: feasible incumbent returned, not proven optimal, and no timeout semantics applied
- `INFEASIBLE`: model infeasible under active hard constraints
- `TIMEOUT`: solver terminated by time/cancel/forced-timeout policy
  - feasible incumbent exists: best-feasible plan returned
  - no feasible incumbent: empty plan, terminal reason indicates no-feasible timeout
- `ERROR`: runtime/system failure

## Units and Integer Scaling
- Time bucket: day (`YYYY-MM-DD`)
- Demand/supply quantities: unit quantities
- Currency/cost: numeric cost units from request coefficients
- CP-SAT internal quantity scaling:
  - quantities are integerized with fixed scale (`SCALE`, code-level constant)
  - objective also uses a fixed coefficient scale (`OBJ_SCALE`)
  - response values are unscaled back to real units
- Capacity fields are interpreted per period and support:
  - scalar
  - date-indexed list
  - date-keyed map

## Constraint Tag Conventions
Stable tags used in `proof`:
- `CAP_INV[YYYY-MM-DD]`
- `CAP_PROD[YYYY-MM-DD]`
- `BUDGET_GLOBAL`
- `MOQ[...]`
- `PACK[...]`
- `MAXQ[...]`
- `BALANCE_INV[...]`
- `SERVICE_LEVEL_GLOBAL`
- `BOM_LINK[...]`
- `COMP_FEAS[...]`

`constraints_checked[*]` includes coarse `tag` plus optional expanded `tags[]`.

## Example: Single-Echelon Request

```json
{
  "contract_version": "1.0",
  "planning_horizon_days": 3,
  "demand_forecast": {
    "granularity": "daily",
    "series": [
      {"sku": "SKU-A", "plant_id": "P1", "date": "2026-03-01", "p50": 8},
      {"sku": "SKU-A", "plant_id": "P1", "date": "2026-03-02", "p50": 8},
      {"sku": "SKU-A", "plant_id": "P1", "date": "2026-03-03", "p50": 8}
    ]
  },
  "inventory": [
    {"sku": "SKU-A", "plant_id": "P1", "as_of_date": "2026-02-28", "on_hand": 4, "safety_stock": 1, "lead_time_days": 0}
  ],
  "shared_constraints": {
    "production_capacity_per_period": 20,
    "inventory_capacity_per_period": 30
  },
  "solver": {
    "time_limit_seconds": 3,
    "seed": 0,
    "workers": 1,
    "deterministic_mode": true
  }
}
```

## Example: Multi-Echelon Request

```json
{
  "contract_version": "1.0",
  "planning_horizon_days": 14,
  "demand_forecast": {
    "granularity": "daily",
    "series": [
      {"sku": "FG-1", "plant_id": "P1", "date": "2026-05-01", "p50": 10},
      {"sku": "FG-1", "plant_id": "P1", "date": "2026-05-08", "p50": 10}
    ]
  },
  "inventory": [
    {"sku": "FG-1", "plant_id": "P1", "as_of_date": "2026-04-30", "on_hand": 0, "safety_stock": 0, "lead_time_days": 0},
    {"sku": "RM-1", "plant_id": "P1", "as_of_date": "2026-04-30", "on_hand": 0, "safety_stock": 0, "lead_time_days": 30}
  ],
  "multi_echelon": {
    "mode": "bom_v0",
    "lot_sizing_mode": "moq_pack",
    "max_bom_depth": 10
  },
  "bom_usage": [
    {"fg_sku": "FG-1", "component_sku": "RM-1", "plant_id": "P1", "usage_qty": 2, "level": 1, "path_count": 1}
  ],
  "diagnose_mode": true
}
```

## Example: Minimal Response Shape

```json
{
  "contract_version": "1.0",
  "status": "INFEASIBLE",
  "plan_lines": [],
  "plan": [],
  "kpis": {
    "estimated_service_level": null,
    "estimated_stockout_units": null,
    "estimated_holding_units": null,
    "estimated_total_cost": null
  },
  "solver_meta": {
    "engine": "cp_sat",
    "status": "INFEASIBLE",
    "termination_reason": "INFEASIBLE",
    "solve_time_ms": 23,
    "time_limit": 3.0,
    "seed": 0,
    "workers": 1
  },
  "infeasible_reasons": ["Infeasible category 'capacity'."],
  "infeasible_reason_details": [
    {
      "category": "capacity",
      "top_offending_tags": ["CAP_PROD[2026-03-01]"],
      "suggested_actions": ["Increase shared production/inventory capacity in constrained periods."]
    }
  ],
  "diagnostics": {
    "mode": "progressive_relaxation",
    "relaxation_analysis": [
      {"relaxed_tags": ["CAP_PROD"], "feasible_after_relaxation": true, "delta_cost_proxy": 123.4}
    ]
  },
  "proof": {
    "objective_terms": [],
    "constraints_checked": [],
    "constraint_tags": [],
    "infeasibility_analysis": {"categories": ["capacity"], "top_offending_tags": ["CAP_PROD"], "suggestions": []},
    "relaxation_analysis": [],
    "diagnose_mode": true
  }
}
```
