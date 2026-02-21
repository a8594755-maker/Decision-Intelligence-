# DI Artifact Output Contract v1

## Version
- Contract version: `v1`
- Runtime validator: `src/contracts/diArtifactContractV1.js`
- Entry point: `validateArtifactOrThrow({ artifact_type, payload })`

## Scope
This contract freezes Workflow A artifact payload shapes for stable storage, replay, verification, and backward-compatible loading.

Unknown `artifact_type` values are intentionally pass-through (not validated) to avoid blocking unrelated artifacts.

## Forecast Artifacts

### `forecast_series`
Purpose: persisted forecast groups and point-level outputs.

| Field | Type | Required | Notes |
|---|---|---|---|
| `groups` | array | yes | Each group requires identifier + plant + points |
| `groups[].sku` or `groups[].material_code` | string | yes (either) | At least one identifier must exist |
| `groups[].plant_id` | string | yes | Plant scope |
| `groups[].points` | array | yes | Time series points |
| `groups[].points[].time_bucket` or `groups[].points[].date` | string | yes (either) | Time key |
| `groups[].points[].forecast` | number or null | yes | Forecast value (history points may be null) |
| extra fields | any | optional | Allowed |

Example:
```json
{
  "groups": [
    {
      "material_code": "SKU-1",
      "plant_id": "P1",
      "points": [
        { "time_bucket": "2026-01-01", "actual": 10, "forecast": null },
        { "time_bucket": "2026-01-08", "actual": null, "forecast": 12.3 }
      ]
    }
  ]
}
```

### `metrics`
Purpose: forecast quality + processing metrics.

| Field | Type | Required |
|---|---|---|
| `metric_name` | string | yes |
| `mape` | number or null | yes |
| `mae` | number or null | yes |
| `selected_model_global` | string | yes |
| `model_usage` | object | yes |
| `groups_processed` | number | yes |
| `rows_used` | number | yes |
| `dropped_rows` | number | yes |
| `horizon_periods` | number | yes |
| `granularity` | string | yes |

Example:
```json
{
  "metric_name": "mape",
  "mape": 4.2,
  "mae": 2.1,
  "selected_model_global": "naive_last",
  "model_usage": { "naive_last": 25 },
  "groups_processed": 25,
  "rows_used": 1220,
  "dropped_rows": 17,
  "horizon_periods": 8,
  "granularity": "weekly"
}
```

### `report_json` (forecast)
Purpose: forecast report payload.

| Field | Type | Required | Notes |
|---|---|---|---|
| payload root | object | yes | Forecast report object |
| extra fields | any | optional | e.g., `dataset_profile_id`, `workflow`, `stage`, `evidence` |

Example:
```json
{
  "dataset_profile_id": 101,
  "workflow": "workflow_A_replenishment",
  "stage": "forecast",
  "evidence": { "groups_processed": 25 }
}
```

### `forecast_csv`
Purpose: downloadable forecast CSV artifact.

| Field | Type | Required |
|---|---|---|
| payload root | string | yes |

Example:
```text
material_code,plant_id,time_bucket,actual,forecast
SKU-1,P1,2026-01-01,,12.3
```

## Planning Artifacts

### `solver_meta`
Purpose: solver status, KPIs, infeasibility details, and proof.

| Field | Type | Required |
|---|---|---|
| `status` | string | yes |
| `kpis` | object | yes |
| `solver_meta` | object | yes |
| `infeasible_reasons` | array | yes |
| `proof` | object | yes |
| `proof.objective_terms` | array | yes |
| `proof.constraints_checked` | array | yes |

Example:
```json
{
  "status": "optimal",
  "kpis": { "estimated_total_cost": 1234.5 },
  "solver_meta": { "solver": "heuristic" },
  "infeasible_reasons": [],
  "proof": { "objective_terms": [], "constraints_checked": [] }
}
```

### `constraint_check`
Purpose: deterministic hard-gate validation output.

| Field | Type | Required | Notes |
|---|---|---|---|
| `passed` | boolean | yes | Hard-pass indicator |
| `violations` | array | yes | Violation list |
| `violations[].rule` | string | yes | Rule id |
| `violations[].details` | string | yes | Human-readable reason |
| `violations[].sku` | string or null | optional | SKU-scoped context |

Example:
```json
{
  "passed": false,
  "violations": [
    { "rule": "moq", "sku": "SKU-1", "details": "order_qty=7 is below MOQ=10." }
  ]
}
```

### `plan_table`
Purpose: normalized replenishment plan rows.

| Field | Type | Required |
|---|---|---|
| `total_rows` | number | yes |
| `rows` | array | yes |
| `truncated` | boolean | yes |
| `rows[].sku` | string | yes |
| `rows[].plant_id` | string or null | yes |
| `rows[].order_date` | string | yes |
| `rows[].arrival_date` | string | yes |
| `rows[].order_qty` | number | yes |

Example:
```json
{
  "total_rows": 1,
  "rows": [
    {
      "sku": "SKU-1",
      "plant_id": "P1",
      "order_date": "2026-01-01",
      "arrival_date": "2026-01-03",
      "order_qty": 120
    }
  ],
  "truncated": false
}
```

### `replay_metrics`
Purpose: with/without plan replay metrics + deltas.

| Field | Type | Required | Notes |
|---|---|---|---|
| `with_plan` | object | yes | Replay metrics with plan |
| `without_plan` | object | yes | Replay metrics baseline |
| `delta` | object | yes | with - without |
| `service_level_proxy` / `stockout_units` / `holding_units` | number | conditional | If present in any of the objects, must be numeric |

Example:
```json
{
  "with_plan": { "service_level_proxy": 0.97, "stockout_units": 8, "holding_units": 22 },
  "without_plan": { "service_level_proxy": 0.9, "stockout_units": 19, "holding_units": 35 },
  "delta": { "service_level_proxy": 0.07, "stockout_units": -11, "holding_units": -13 }
}
```

### `inventory_projection`
Purpose: projected inventory trajectory for chart/replay evidence.

| Field | Type | Required | Notes |
|---|---|---|---|
| `total_rows` | number | yes | Row count before truncation |
| `rows` | array | yes | Projection rows |
| `truncated` | boolean | yes | Truncation marker |
| `rows[].sku` | string | yes | SKU |
| `rows[].plant_id` | string or null | yes | Plant |
| `rows[].date` | string | yes | Date key |
| `rows[].with_plan` | number | yes | Inventory with plan |
| `rows[].without_plan` | number | yes | Inventory baseline |
| `rows[].demand` | number | yes | Demand |
| `rows[].stockout_units` | number | yes | Stockout |
| `rows[].inbound_plan` | number | optional | Optional numeric if present |
| `rows[].inbound_open_pos` | number | optional | Optional numeric if present |

Example:
```json
{
  "total_rows": 1,
  "rows": [
    {
      "sku": "SKU-1",
      "plant_id": "P1",
      "date": "2026-01-01",
      "with_plan": 50,
      "without_plan": 35,
      "demand": 10,
      "stockout_units": 0,
      "inbound_plan": 12,
      "inbound_open_pos": 3
    }
  ],
  "truncated": false
}
```

### `evidence_pack`
Purpose: traceable audit package links and evidence context.

| Field | Type | Required |
|---|---|---|
| `generated_at` | string | yes |
| `run_id` | number or string | yes |
| `dataset_profile_id` | number or string | yes |
| `solver_status` | string | yes |
| `refs` | object | yes |
| `evidence` | object | yes |

Example:
```json
{
  "generated_at": "2026-01-01T00:00:00.000Z",
  "run_id": 77,
  "dataset_profile_id": 88,
  "solver_status": "optimal",
  "refs": { "plan_table": { "artifact_id": 1 } },
  "evidence": { "constraint_check": { "passed": true } }
}
```

### `report_json` (plan)
Purpose: structured plan summary/report.

| Field | Type | Required | Notes |
|---|---|---|---|
| `summary` | string | yes |
| `key_results` | array | yes |
| `exceptions` | array | yes |
| `recommended_actions` | array | yes |
| array element type | string | expected | Arrays are primarily string items |

Example:
```json
{
  "summary": "Plan solved and verified.",
  "key_results": ["Service level proxy improved by +7 pp."],
  "exceptions": [],
  "recommended_actions": ["Proceed to planner review and approval."]
}
```

### `plan_csv`
Purpose: downloadable plan CSV artifact.

| Field | Type | Required |
|---|---|---|
| payload root | string | yes |

Example:
```text
sku,plant_id,order_date,arrival_date,order_qty
SKU-1,P1,2026-01-01,2026-01-03,120
```

## Backward Compatibility Strategy

1. `csv` split into explicit types:
- forecast runs now persist `forecast_csv`
- planning runs now persist `plan_csv`

2. Legacy run loading remains supported:
- Workflow A loaders first try `forecast_csv` / `plan_csv`
- If not found, they fallback to legacy `csv`

3. Runtime enforcement toggle:
- Env flag: `VITE_DI_STRICT_ARTIFACT_CONTRACT`
- Default: `true`
- `true`: validation failure throws and fails fast
- `false`: logs warning and continues storing artifact

4. Unknown artifact types:
- pass-through, no validation, preserving compatibility for non-V1 artifacts.
