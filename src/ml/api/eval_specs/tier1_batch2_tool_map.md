# Tier 1 Batch 2 — Tool Map

## 1. run_risk_score

| Field | Value |
|-------|-------|
| Module | `./risk/riskScoreService` |
| Method | `runRiskScoreCalculation` |
| Type | JS service |
| depends_on | `['run_forecast']` |

### Input
- `userId`, `forecastRunId`, `options.currentBucket`, `options.maxKeys` (1000)
- DB: `inventory_forecast_prob_summary` (p_stockout, stockout_bucket)
- DB: `margin_at_risk_results` (margin + penalty)

### Output
- `{ success, kpis: { totalScore, avgScore, highRiskCount, ... }, topRisks[], metrics }`
- Persisted to `risk_score_results` table

### Formula
`score = p_stockout × impact_usd × urgency_weight`
- p_stockout: [0,1] from DB or binary fallback
- impact_usd: margin_at_risk + penalty_at_risk
- urgency: W+0=1.5, W+1=1.2, W+2+=1.0, none=0.5
- Tiers: >10K=high, >1K=medium, ≤1K=low

### Key Thresholds
| Value | Purpose |
|-------|---------|
| 1.5/1.2/1.0/0.5 | Urgency weights |
| 10000/1000 | High/medium tier boundaries |
| $10 | DEFAULT_PROFIT_PER_UNIT fallback |
| 1000 | maxKeys cap |

---

## 2. run_plan

| Field | Value |
|-------|-------|
| Module | `./planning/chatPlanningService` |
| Method | `runPlanFromDatasetProfile` |
| Type | JS service |
| depends_on | `['run_forecast']` |

### Input
- `datasetProfileRow` (with forecast artifacts, inventory snapshots, PO data)
- Settings: `riskMode`, `planningHorizonDays`, `constraintsOverride`, `objectiveOverride`

### Output
- `{ plan[], kpis, solver_meta, constraint_check, replay_metrics, inventory_projection }`
- Plan rows: `{ sku, plant_id, order_date, arrival_date, order_qty }`

### Algorithm (Local Heuristic)
```
Per SKU per period:
  projected = on_hand + inbound - demand(p50)
  if projected < safety_stock:
    order = max(0, safety_stock - projected)
    apply: MOQ floor, pack_size roundup, max_order_qty cap
  order_date = arrival_date - lead_time_days
```

### Safety Stock Derivation (priority cascade)
1. Closed-loop override (from previous plan feedback)
2. P90-derived: `avgP50 + alpha × max(0, avgP90 - avgP50)`, alpha=1.0
3. Base from inventory data
4. Fallback: 1× avg period demand

### Key Thresholds
| Value | Purpose |
|-------|---------|
| 7 days | DEFAULT_LEAD_TIME |
| 0 | DEFAULT_SAFETY_STOCK |
| 30 days | Fallback planning horizon |
| 7 days | Min planning horizon |
| 1.0 | safety_stock_alpha |
| 25000ms | Solver timeout |

---

## 3. run_inventory_projection

| Field | Value |
|-------|-------|
| Module | `./forecast/inventoryProjectionService` |
| Method | `loadInventoryProjection` |
| Type | JS service |
| depends_on | `['run_forecast']` |

### Input
- `forecastRunId`, `timeBuckets[]`, `plantId`, `options.inboundSource`
- DB: `component_demand` (demand by material/plant/bucket)
- DB: `po_open_lines` or `supply_forecast` (inbound)
- DB: `inventory_snapshots` (on_hand, safety_stock)

### Output
- `{ summaryRows[], cache, kpis: { atRiskItems, earliestStockoutBucket, totalShortageQty } }`
- Per-bucket series: `{ bucket, begin, inbound, demand, end, available, shortageFlag }`

### Formula
```
end = begin + inbound - demand
available = end - safetyStock
shortageFlag = available < 0
stockoutBucket = first bucket where shortageFlag
```

### Key Thresholds
| Value | Purpose |
|-------|---------|
| 30000 | FORECAST_WARN_ROWS |
| 100000 | FORECAST_STOP_ROWS |
| 500 | FORECAST_TOP_N |

---

## 4. run_bom_explosion

| Field | Value |
|-------|-------|
| Module | `./planning/bomExplosionService` |
| Method | `executeBomExplosion` |
| Type | JS service |
| depends_on | `['run_forecast']` |

### Input
- `fgDemands[]`: `{ material_code, plant_id, time_bucket, demand_qty }`
- `bomEdges[]`: `{ parent_material, child_material, qty_per, scrap_rate, yield_rate }`
- DB: `demand_fg`, `bom_edges`

### Output
- `componentDemandRows[]`: flat, `{ material_code, plant_id, time_bucket, demand_qty, uom:'pcs' }`
- `traceRows[]`: `{ fg_material_code, component_material_code, path[], bom_level, qty_multiplier }`
- `errors[]`: cycle detection, missing BOM, max depth

### Algorithm
```
Recursive BOM explosion per FG demand:
  component_qty = parent_qty × qty_per × (1 + scrap_rate) / yield_rate
  Shared components summed via Map(material|plant|bucket → total_qty)
  Cycle detection via path tracking
  Max depth: 50 (configurable)
```

### Key Thresholds
| Value | Purpose |
|-------|---------|
| 50 | MAX_BOM_DEPTH |
| 0 / 1 | DEFAULT_SCRAP_RATE / DEFAULT_YIELD_RATE |
| 0.99 / 0.01 | MAX_SCRAP / MIN_YIELD |
| 4 | QUANTITY_DECIMALS |
| 'pcs' | DEFAULT_UOM (hardcoded, no conversion) |
| 60 × 2000ms | Polling timeout (Edge Function mode) |
