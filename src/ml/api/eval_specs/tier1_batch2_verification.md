# Tier 1 Batch 2 Verification Results

## run_risk_score — 6/7 pass, 1 warning

| # | Check | Result | Evidence |
|---|-------|--------|----------|
| R1 | Score bounded 0-100? | ⚠️ **No** — unbounded dollar-risk units | riskScore.js:185 `score = p × impact × urgency`. Floored at 0, no ceiling. Thresholds: >10K=high, >1K=medium |
| R2 | Zero demand | ✅ Returns 0, no NaN | riskScore.js:178-179 defaults to 0 |
| R3 | Missing forecast | ✅ Clear error | riskScoreService.js:48-49, 81-86 |
| R4 | P(shortage) | ✅ From DB prob_summary or binary fallback | riskScoreService.js:210, 339 |
| R5 | Impact monetization | ✅ margin_at_risk + penalty_at_risk | riskScoreService.js:281 |
| R6 | Urgency | ✅ Time-to-stockout: W+0=1.5, W+1=1.2, W+2+=1.0, none=0.5 | riskScore.js:22-26 |
| R7 | Aggregation | ✅ Per material_code + plant_id | riskScore.js:339-341 |

## run_plan — 6/7 pass, 1 note

| # | Check | Result | Evidence |
|---|-------|--------|----------|
| P1 | Negative order qty? | ✅ Double-guarded max(0,...) | optimizationApiClient.js:601, chatPlanningService.js:1799 |
| P2 | When to order? | ✅ order_date = arrival - lead_time | optimizationApiClient.js:653-654 |
| P3 | Safety stock formula | ⚠️ Not classical Z×σ×√LT. Uses P90-P50 spread × alpha(1.0) | optimizationApiClient.js:552-558 |
| P4 | EOQ? | ✅ Order-up-to-safety-stock heuristic + lot sizing | optimizationApiClient.js:600-601 |
| P5 | Demand field | ✅ p50 for demand, p90 for safety stock only | optimizationApiClient.js:596 |
| P6 | Plan horizon | ✅ min(specified, forecast span), fallback 30d, min 7d | chatPlanningService.js:335-347 |
| P7 | Missing data | ✅ Defaults: on_hand=0, lead_time=7d, safety_stock=0 or 1×avg demand | optimizationApiClient.js:536-540 |

## run_inventory_projection — 5/7 pass, 2 cannot verify

| # | Check | Result | Evidence |
|---|-------|--------|----------|
| I1 | Negative inventory | ✅ Yes, models stockouts | inventoryProjection.js:66 `end = begin + inbound - demand` |
| I2 | Stockout date | ✅ First bucket where available < 0 | inventoryProjection.js:79 |
| I3 | Coverage days | ⚠️ Not computed in these files | — |
| I4 | Demand source | ✅ component_demand table; p50 for supply inbound | service:82, 94 |
| I5 | Per-warehouse | ✅ Per material+plant key | inventoryProjection.js:9 |
| I6 | Reorder point | ⚠️ Safety stock as proxy, no explicit ROP | inventoryProjection.js:67 |
| I7 | Initial inventory | ✅ inventory_snapshots, defaults 0 | service:84 |

## run_bom_explosion — 7/8 pass, 1 bug

| # | Check | Result | Evidence |
|---|-------|--------|----------|
| B1 | Max depth | ✅ 50 levels, configurable | bomCalculator.js:22, 475 |
| B2 | Qty multiplication | ✅ Compound: parent × qty_per × (1+scrap) / yield | bomCalculator.js:234 |
| B3 | Shared components | ✅ Summed via Map | bomCalculator.js:509-510 |
| B4 | Circular reference | ✅ Path-based cycle detection | bomCalculator.js:486-495 |
| B5 | Missing BOM | ✅ Leaf node (intermediate) / error+skip (FG) | bomCalculator.js:498, 692 |
| B6 | Demand source | ⚠️ Uses demand_qty as-is; quantile depends on upstream | service:51-52 |
| B7 | Output structure | ✅ Flat rows + trace for lineage | bomCalculator.js:730-744 |
| B8 | UOM conversion | ❌ **Not implemented** — hardcoded 'pcs' | bomCalculator.js:741 |

## Bugs Found

### B8: BOM UOM Conversion Missing
**Location:** `src/domains/forecast/bomCalculator.js:741`
All output rows hardcode `uom: 'pcs'`. No unit conversion logic exists. If BOM edges mix kg/pcs/liters, quantities are summed without conversion.
**Impact:** Incorrect component demand if materials use different UOM.
**Fix:** Add UOM column to bom_edges, implement conversion table lookup before quantity accumulation.

## Warnings

### R1: Risk Score Unbounded
Score is `p_stockout × impact_usd × urgency_weight` — can be millions for high-value items. This is by design (dollar-risk units), but UI/reporting that expects 0-100 will break.

### P3: Non-Standard Safety Stock
Uses P90-P50 forecast spread × alpha instead of classical formula. Valid approach for demand-driven planning, but differs from textbook MRP.
