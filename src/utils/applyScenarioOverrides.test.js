/**
 * Unit Tests: applyScenarioOverrides.js
 *
 * Tests:
 * 1. risk_mode='on': boosts stockout_penalty × 1.5
 * 2. stockout_penalty_multiplier: applies multiplier after risk_mode boost
 * 3. holding_cost_multiplier: scales holding_cost
 * 4. safety_stock_alpha: p50_eff = p50 + alpha × max(0, p90 - p50)
 * 5. expedite_mode='on': reduces lead_time_days (min 1)
 * 6. expedite_cost_per_unit: added to objective when > 0
 * 7. budget_cap + service_target: echoed in effectiveParams
 * 8. Null overrides are no-ops
 * 9. No payload mutation when overrides are empty
 * 10. effectiveParams contains only actually-applied keys
 */

import { describe, it, expect } from 'vitest';
import { applyScenarioOverridesToPayload } from './applyScenarioOverrides';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePayload(overrides = {}) {
  return {
    objective: {
      stockout_penalty: 1.0,
      holding_cost: 0.5,
      ...overrides.objective
    },
    demand_forecast: {
      series: overrides.series ?? [
        { sku: 'A', period: 1, p50: 100, p90: 130 },
        { sku: 'B', period: 1, p50: 200, p90: 240 }
      ]
    },
    inventory: overrides.inventory ?? [
      { sku: 'A', plant_id: 'P1', lead_time_days: 7 },
      { sku: 'B', plant_id: 'P1', lead_time_days: 10 }
    ]
  };
}

// ── risk_mode ─────────────────────────────────────────────────────────────────

describe('applyScenarioOverridesToPayload: risk_mode', () => {
  it("boosts stockout_penalty × 1.5 when risk_mode='on' in overrides", () => {
    const payload = makePayload();
    const { effectiveParams } = applyScenarioOverridesToPayload(
      payload,
      { risk_mode: 'on' },
      {}
    );
    expect(payload.objective.stockout_penalty).toBeCloseTo(1.5, 5);
    expect(effectiveParams.risk_mode_base_stockout_penalty).toBeCloseTo(1.5, 5);
  });

  it("boosts stockout_penalty × 1.5 when risk_mode='on' in engine_flags", () => {
    const payload = makePayload();
    applyScenarioOverridesToPayload(payload, {}, { risk_mode: 'on' });
    expect(payload.objective.stockout_penalty).toBeCloseTo(1.5, 5);
  });

  it("does not boost when risk_mode is 'off'", () => {
    const payload = makePayload();
    applyScenarioOverridesToPayload(payload, { risk_mode: 'off' }, {});
    expect(payload.objective.stockout_penalty).toBe(1.0);
  });

  it('does not boost when risk_mode is absent', () => {
    const payload = makePayload();
    applyScenarioOverridesToPayload(payload, {}, {});
    expect(payload.objective.stockout_penalty).toBe(1.0);
  });
});

// ── stockout_penalty_multiplier ───────────────────────────────────────────────

describe('applyScenarioOverridesToPayload: stockout_penalty_multiplier', () => {
  it('applies multiplier to current stockout_penalty', () => {
    const payload = makePayload();
    const { effectiveParams } = applyScenarioOverridesToPayload(
      payload,
      { stockout_penalty_multiplier: 3 },
      {}
    );
    expect(payload.objective.stockout_penalty).toBeCloseTo(3.0, 5);
    expect(effectiveParams.stockout_penalty_final).toBeCloseTo(3.0, 5);
  });

  it('applies multiplier on top of risk_mode boost (compound effect)', () => {
    const payload = makePayload();
    // risk_mode: 1.0 × 1.5 = 1.5, then × 2 = 3.0
    applyScenarioOverridesToPayload(
      payload,
      { risk_mode: 'on', stockout_penalty_multiplier: 2 },
      {}
    );
    expect(payload.objective.stockout_penalty).toBeCloseTo(3.0, 5);
  });

  it('ignores zero or negative multipliers', () => {
    const payload = makePayload();
    applyScenarioOverridesToPayload(payload, { stockout_penalty_multiplier: 0 }, {});
    expect(payload.objective.stockout_penalty).toBe(1.0);

    const payload2 = makePayload();
    applyScenarioOverridesToPayload(payload2, { stockout_penalty_multiplier: -1 }, {});
    expect(payload2.objective.stockout_penalty).toBe(1.0);
  });

  it('ignores null stockout_penalty_multiplier', () => {
    const payload = makePayload();
    applyScenarioOverridesToPayload(payload, { stockout_penalty_multiplier: null }, {});
    expect(payload.objective.stockout_penalty).toBe(1.0);
  });
});

// ── holding_cost_multiplier ───────────────────────────────────────────────────

describe('applyScenarioOverridesToPayload: holding_cost_multiplier', () => {
  it('scales holding_cost by multiplier', () => {
    const payload = makePayload();
    const { effectiveParams } = applyScenarioOverridesToPayload(
      payload,
      { holding_cost_multiplier: 2 },
      {}
    );
    expect(payload.objective.holding_cost).toBeCloseTo(1.0, 5);
    expect(effectiveParams.holding_cost_final).toBeCloseTo(1.0, 5);
  });

  it('allows zero multiplier (zero holding cost)', () => {
    const payload = makePayload();
    applyScenarioOverridesToPayload(payload, { holding_cost_multiplier: 0 }, {});
    expect(payload.objective.holding_cost).toBe(0);
  });

  it('ignores null holding_cost_multiplier', () => {
    const payload = makePayload();
    applyScenarioOverridesToPayload(payload, { holding_cost_multiplier: null }, {});
    expect(payload.objective.holding_cost).toBe(0.5);
  });
});

// ── safety_stock_alpha ────────────────────────────────────────────────────────

describe('applyScenarioOverridesToPayload: safety_stock_alpha', () => {
  it('applies p50_eff = p50 + alpha * max(0, p90 - p50)', () => {
    const payload = makePayload();
    // Series: [{p50:100, p90:130}, {p50:200, p90:240}]
    // alpha=1.0: p50_eff_A = 100 + 1.0 * max(0, 130-100) = 130
    //            p50_eff_B = 200 + 1.0 * max(0, 240-200) = 240
    const { effectiveParams } = applyScenarioOverridesToPayload(
      payload,
      { safety_stock_alpha: 1.0 },
      {}
    );

    expect(payload.demand_forecast.series[0].p50).toBeCloseTo(130, 4);
    expect(payload.demand_forecast.series[1].p50).toBeCloseTo(240, 4);
    expect(effectiveParams.safety_stock_alpha).toBe(1.0);
  });

  it('alpha=0 leaves p50 unchanged', () => {
    const payload = makePayload();
    applyScenarioOverridesToPayload(payload, { safety_stock_alpha: 0 }, {});
    expect(payload.demand_forecast.series[0].p50).toBe(100);
    expect(payload.demand_forecast.series[1].p50).toBe(200);
  });

  it('alpha=0.5 applies partial uplift', () => {
    const payload = makePayload();
    // p50_eff_A = 100 + 0.5 * 30 = 115
    applyScenarioOverridesToPayload(payload, { safety_stock_alpha: 0.5 }, {});
    expect(payload.demand_forecast.series[0].p50).toBeCloseTo(115, 4);
  });

  it('uses p50 as fallback when p90 is absent', () => {
    const payload = makePayload({
      series: [{ sku: 'C', period: 1, p50: 100 }] // no p90
    });
    applyScenarioOverridesToPayload(payload, { safety_stock_alpha: 1.5 }, {});
    // max(0, p50 - p50) = 0, so p50_eff = p50
    expect(payload.demand_forecast.series[0].p50).toBeCloseTo(100, 4);
  });

  it('does not decrease p50 (uplift is always >= 0)', () => {
    const payload = makePayload({
      series: [{ sku: 'D', period: 1, p50: 100, p90: 80 }] // p90 < p50
    });
    applyScenarioOverridesToPayload(payload, { safety_stock_alpha: 1.0 }, {});
    // max(0, 80-100) = 0 => p50_eff = 100
    expect(payload.demand_forecast.series[0].p50).toBeCloseTo(100, 4);
  });

  it('ignores null safety_stock_alpha', () => {
    const payload = makePayload();
    applyScenarioOverridesToPayload(payload, { safety_stock_alpha: null }, {});
    expect(payload.demand_forecast.series[0].p50).toBe(100);
  });
});

// ── expedite_mode ─────────────────────────────────────────────────────────────

describe('applyScenarioOverridesToPayload: expedite_mode', () => {
  it("reduces lead_time_days by lead_time_buffer_days when expedite_mode='on'", () => {
    const payload = makePayload();
    const { effectiveParams } = applyScenarioOverridesToPayload(
      payload,
      { expedite_mode: 'on', lead_time_buffer_days: 3 },
      {}
    );
    expect(payload.inventory[0].lead_time_days).toBe(4); // 7 - 3 = 4
    expect(payload.inventory[1].lead_time_days).toBe(7); // 10 - 3 = 7
    expect(effectiveParams.expedite_lead_time_buffer_days).toBe(3);
  });

  it('uses default buffer of 3 days when lead_time_buffer_days not specified', () => {
    const payload = makePayload();
    applyScenarioOverridesToPayload(payload, { expedite_mode: 'on' }, {});
    expect(payload.inventory[0].lead_time_days).toBe(4); // 7 - 3
  });

  it('enforces minimum lead_time_days of 1', () => {
    const payload = makePayload({
      inventory: [{ sku: 'A', plant_id: 'P1', lead_time_days: 2 }]
    });
    applyScenarioOverridesToPayload(
      payload,
      { expedite_mode: 'on', lead_time_buffer_days: 5 },
      {}
    );
    expect(payload.inventory[0].lead_time_days).toBe(1); // max(1, 2-5)
  });

  it("does not reduce lead_time when expedite_mode='off'", () => {
    const payload = makePayload();
    applyScenarioOverridesToPayload(payload, { expedite_mode: 'off' }, {});
    expect(payload.inventory[0].lead_time_days).toBe(7);
  });

  it('adds expedite_cost_per_unit to objective when > 0', () => {
    const payload = makePayload();
    const { effectiveParams } = applyScenarioOverridesToPayload(
      payload,
      { expedite_mode: 'on', expedite_cost_per_unit: 12.5 },
      {}
    );
    expect(payload.objective.expedite_cost_per_unit).toBe(12.5);
    expect(effectiveParams.expedite_cost_per_unit).toBe(12.5);
  });

  it('does not add expedite_cost_per_unit when cost is 0', () => {
    const payload = makePayload();
    applyScenarioOverridesToPayload(
      payload,
      { expedite_mode: 'on', expedite_cost_per_unit: 0 },
      {}
    );
    expect(payload.objective.expedite_cost_per_unit).toBeUndefined();
  });
});

// ── budget_cap + service_target (echo only) ───────────────────────────────────

describe('applyScenarioOverridesToPayload: budget_cap + service_target', () => {
  it('echoes budget_cap in effectiveParams', () => {
    const payload = makePayload();
    const { effectiveParams } = applyScenarioOverridesToPayload(
      payload,
      { budget_cap: 50000 },
      {}
    );
    expect(effectiveParams.budget_cap).toBe(50000);
  });

  it('echoes service_target as service_level_target in effectiveParams', () => {
    const payload = makePayload();
    const { effectiveParams } = applyScenarioOverridesToPayload(
      payload,
      { service_target: 0.95 },
      {}
    );
    expect(effectiveParams.service_level_target).toBe(0.95);
  });

  it('ignores null budget_cap', () => {
    const payload = makePayload();
    const { effectiveParams } = applyScenarioOverridesToPayload(
      payload,
      { budget_cap: null },
      {}
    );
    expect(effectiveParams.budget_cap).toBeUndefined();
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('applyScenarioOverridesToPayload: edge cases', () => {
  it('returns empty effectiveParams for empty overrides', () => {
    const payload = makePayload();
    const original = JSON.stringify(payload);
    const { effectiveParams } = applyScenarioOverridesToPayload(payload, {}, {});
    expect(Object.keys(effectiveParams)).toHaveLength(0);
    // Only the idempotency marker is added; no data fields are mutated
    const { _scenario_overrides_applied, ...rest } = payload;
    expect(JSON.stringify(rest)).toBe(original);
    expect(_scenario_overrides_applied).toBe(true);
  });

  it('handles null payload gracefully', () => {
    const { payload, effectiveParams } = applyScenarioOverridesToPayload(
      null,
      { risk_mode: 'on' },
      {}
    );
    expect(payload).toBeNull();
    expect(effectiveParams).toEqual({});
  });

  it('handles null overrides gracefully', () => {
    const payload = makePayload();
    const { effectiveParams } = applyScenarioOverridesToPayload(payload, null, {});
    expect(effectiveParams).toEqual({});
  });

  it('does not add keys to effectiveParams for unapplied overrides', () => {
    const payload = makePayload();
    const { effectiveParams } = applyScenarioOverridesToPayload(
      payload,
      { stockout_penalty_multiplier: null, safety_stock_alpha: null },
      {}
    );
    expect(effectiveParams).not.toHaveProperty('stockout_penalty_final');
    expect(effectiveParams).not.toHaveProperty('safety_stock_alpha');
  });

  it('idempotency guard prevents double-application of overrides', () => {
    const payload = makePayload();
    const overrides = { stockout_penalty_multiplier: 2 };

    // First call applies overrides
    const first = applyScenarioOverridesToPayload(payload, overrides, {});
    const penaltyAfterFirst = payload.objective.stockout_penalty;
    expect(first.effectiveParams).toHaveProperty('stockout_penalty_final');
    expect(payload._scenario_overrides_applied).toBe(true);

    // Second call is a no-op — penalty must not double again
    const second = applyScenarioOverridesToPayload(payload, overrides, {});
    expect(payload.objective.stockout_penalty).toBe(penaltyAfterFirst);
    expect(second.effectiveParams).toEqual({});
  });

  it('all overrides applied together produce correct compound result', () => {
    // Synthetic integration: risk_mode + multiplier + alpha + expedite
    const payload = {
      objective: { stockout_penalty: 1.0, holding_cost: 0.5 },
      demand_forecast: { series: [{ sku: 'X', period: 1, p50: 100, p90: 150 }] },
      inventory: [{ sku: 'X', plant_id: 'P1', lead_time_days: 8 }]
    };

    const { effectiveParams } = applyScenarioOverridesToPayload(
      payload,
      {
        risk_mode: 'on',                 // 1.0 × 1.5 = 1.5
        stockout_penalty_multiplier: 2,  // 1.5 × 2 = 3.0
        holding_cost_multiplier: 0.8,    // 0.5 × 0.8 = 0.4
        safety_stock_alpha: 1.0,         // p50_eff = 100 + 1.0×(150-100) = 150
        expedite_mode: 'on',
        lead_time_buffer_days: 2,        // 8 - 2 = 6
        expedite_cost_per_unit: 5,
        budget_cap: 10000,
        service_target: 0.9
      },
      {}
    );

    expect(payload.objective.stockout_penalty).toBeCloseTo(3.0, 5);
    expect(payload.objective.holding_cost).toBeCloseTo(0.4, 5);
    expect(payload.demand_forecast.series[0].p50).toBeCloseTo(150, 4);
    expect(payload.inventory[0].lead_time_days).toBe(6);
    expect(payload.objective.expedite_cost_per_unit).toBe(5);
    expect(effectiveParams.budget_cap).toBe(10000);
    expect(effectiveParams.service_level_target).toBe(0.9);
  });
});
