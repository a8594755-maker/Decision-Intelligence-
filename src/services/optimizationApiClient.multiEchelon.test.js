import { describe, it, expect } from 'vitest';
import optimizationApiClient from './optimizationApiClient';

function buildPayload({
  demand = 10,
  componentOnHand = 0,
  componentLeadTimeDays = 0,
  moq = null,
  pack = null,
  horizonDays = 3
} = {}) {
  const constraints = {
    moq: [],
    pack_size: [],
    max_order_qty: [],
    budget_cap: null
  };

  if (Number.isFinite(moq) && moq > 0) constraints.moq.push({ sku: 'C1', min_qty: moq });
  if (Number.isFinite(pack) && pack > 0) constraints.pack_size.push({ sku: 'C1', pack_qty: pack });

  return {
    dataset_profile_id: 1,
    planning_horizon_days: horizonDays,
    demand_forecast: {
      granularity: 'daily',
      series: [
        { sku: 'FG1', plant_id: 'P1', date: '2026-01-01', p50: demand }
      ]
    },
    inventory: [
      { sku: 'FG1', plant_id: 'P1', as_of_date: '2025-12-31', on_hand: 0, safety_stock: 0, lead_time_days: 0 },
      {
        sku: 'C1',
        plant_id: 'P1',
        as_of_date: '2025-12-31',
        on_hand: componentOnHand,
        safety_stock: 0,
        lead_time_days: componentLeadTimeDays
      }
    ],
    open_pos: [],
    constraints,
    objective: { stockout_penalty: 1, holding_cost: 0 },
    multi_echelon: {
      mode: 'bom_v0',
      max_bom_depth: 10,
      bom_explosion_used: true,
      bom_explosion_reused: false,
      lot_sizing_mode: 'moq_pack',
      fg_to_components_scope: { sku_allowlist: [], plant_allowlist: [] },
      mapping_rules: { trim: true, case: 'upper' }
    },
    bom_usage: [
      { fg_sku: 'FG1', component_sku: 'C1', plant_id: 'P1', usage_qty: 2, level: 1 }
    ]
  };
}

describe('optimizationApiClient multi-echelon local fallback', () => {
  it('has no bottleneck when components are sufficient', async () => {
    const result = await optimizationApiClient.createReplenishmentPlan(
      buildPayload({ demand: 10, componentOnHand: 30 }),
      { forceLocal: true }
    );

    expect(result.solver_meta.multi_echelon_mode).toBe('bom_v0');
    expect(result.bottlenecks.total_rows).toBe(0);
  });

  it('applies MOQ/pack to component plan and can overbuy', async () => {
    const result = await optimizationApiClient.createReplenishmentPlan(
      buildPayload({ demand: 6, componentOnHand: 0, moq: 10, pack: 8, horizonDays: 5 }),
      { forceLocal: true }
    );

    expect(Array.isArray(result.component_plan)).toBe(true);
    expect(result.component_plan.length).toBeGreaterThan(0);

    const first = result.component_plan[0];
    expect(first.component_sku).toBe('C1');
    expect(first.order_qty).toBeGreaterThanOrEqual(10);
    expect(first.order_qty % 8).toBe(0);
  });

  it('reports bottleneck when component lead time is too long', async () => {
    const result = await optimizationApiClient.createReplenishmentPlan(
      buildPayload({ demand: 10, componentOnHand: 0, componentLeadTimeDays: 5, horizonDays: 2 }),
      { forceLocal: true }
    );

    expect(result.bottlenecks.total_rows).toBeGreaterThan(0);
    expect(result.bottlenecks.rows[0].component_sku).toBe('C1');
  });

  it('is deterministic for repeated runs', async () => {
    const payload = buildPayload({ demand: 8, componentOnHand: 0, componentLeadTimeDays: 1, horizonDays: 4 });

    const run1 = await optimizationApiClient.createReplenishmentPlan(payload, { forceLocal: true });
    const run2 = await optimizationApiClient.createReplenishmentPlan(payload, { forceLocal: true });

    expect(run1).toEqual(run2);
  });
});
