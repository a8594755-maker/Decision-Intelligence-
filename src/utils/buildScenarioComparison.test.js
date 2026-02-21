/**
 * Unit Tests: buildScenarioComparison.js
 *
 * Tests:
 * 1. extractRunKpis: extracts fields from replay_metrics + solver_meta
 * 2. computeTopChanges: aggregation, sorting by |delta|, limit, negligible skip
 * 3. buildScenarioComparison: schema shape, delta computation, notes generation
 */

import { describe, it, expect } from 'vitest';
import {
  buildScenarioComparison,
  computeTopChanges,
  extractRunKpis,
  buildNotes
} from './buildScenarioComparison';

// ── extractRunKpis ────────────────────────────────────────────────────────────

describe('extractRunKpis', () => {
  it('extracts fields from replay_metrics.with_plan', () => {
    const replayMetrics = {
      with_plan: {
        service_level_proxy: 0.92,
        stockout_units: 50,
        holding_units: 200
      }
    };
    const solverMeta = { kpis: { estimated_total_cost: 15000 } };
    const result = extractRunKpis(replayMetrics, solverMeta);

    expect(result.service_level_proxy).toBe(0.92);
    expect(result.stockout_units).toBe(50);
    expect(result.holding_units).toBe(200);
    expect(result.estimated_total_cost).toBe(15000);
  });

  it('returns null for missing fields', () => {
    const result = extractRunKpis({}, {});
    expect(result.service_level_proxy).toBeNull();
    expect(result.stockout_units).toBeNull();
    expect(result.holding_units).toBeNull();
    expect(result.estimated_total_cost).toBeNull();
  });

  it('returns null for null inputs', () => {
    const result = extractRunKpis(null, null);
    expect(result.service_level_proxy).toBeNull();
    expect(result.estimated_total_cost).toBeNull();
  });

  it('converts numeric strings to numbers', () => {
    const replayMetrics = {
      with_plan: { service_level_proxy: '0.88', stockout_units: '100', holding_units: '300' }
    };
    const solverMeta = { kpis: { estimated_total_cost: '9999' } };
    const result = extractRunKpis(replayMetrics, solverMeta);
    expect(result.service_level_proxy).toBe(0.88);
    expect(result.stockout_units).toBe(100);
    expect(result.estimated_total_cost).toBe(9999);
  });
});

// ── computeTopChanges ─────────────────────────────────────────────────────────

describe('computeTopChanges', () => {
  it('returns empty array when both inputs are empty', () => {
    expect(computeTopChanges([], [])).toEqual([]);
  });

  it('produces correct delta for a single SKU change', () => {
    const base = [{ sku: 'SKU-A', plant_id: 'P1', order_date: '2024-01-01', order_qty: 100 }];
    const scenario = [{ sku: 'SKU-A', plant_id: 'P1', order_date: '2024-01-01', order_qty: 150 }];

    const changes = computeTopChanges(base, scenario);
    expect(changes).toHaveLength(1);
    expect(changes[0].sku).toBe('SKU-A');
    expect(changes[0].base).toBe(100);
    expect(changes[0].scenario).toBe(150);
    expect(changes[0].delta).toBe(50);
    expect(changes[0].field).toBe('order_qty');
  });

  it('skips negligible changes (|delta| < 0.001)', () => {
    const base = [{ sku: 'SKU-B', plant_id: 'P1', order_date: '2024-01-01', order_qty: 100 }];
    const scenario = [{ sku: 'SKU-B', plant_id: 'P1', order_date: '2024-01-01', order_qty: 100.0005 }];
    const changes = computeTopChanges(base, scenario);
    expect(changes).toHaveLength(0);
  });

  it('sorts results by |delta| descending', () => {
    const base = [
      { sku: 'SKU-A', plant_id: 'P1', order_date: '2024-01-01', order_qty: 100 },
      { sku: 'SKU-B', plant_id: 'P1', order_date: '2024-01-01', order_qty: 50 },
      { sku: 'SKU-C', plant_id: 'P1', order_date: '2024-01-01', order_qty: 200 }
    ];
    const scenario = [
      { sku: 'SKU-A', plant_id: 'P1', order_date: '2024-01-01', order_qty: 110 },  // delta = +10
      { sku: 'SKU-B', plant_id: 'P1', order_date: '2024-01-01', order_qty: 20 },   // delta = -30
      { sku: 'SKU-C', plant_id: 'P1', order_date: '2024-01-01', order_qty: 220 }   // delta = +20
    ];
    const changes = computeTopChanges(base, scenario);
    expect(changes[0].sku).toBe('SKU-B'); // |delta| = 30 (largest)
    expect(changes[1].sku).toBe('SKU-C'); // |delta| = 20
    expect(changes[2].sku).toBe('SKU-A'); // |delta| = 10
  });

  it('handles SKUs present in scenario but not in base (new orders)', () => {
    const base = [];
    const scenario = [{ sku: 'SKU-NEW', plant_id: 'P1', order_date: '2024-01-01', order_qty: 75 }];
    const changes = computeTopChanges(base, scenario);
    expect(changes).toHaveLength(1);
    expect(changes[0].base).toBe(0);
    expect(changes[0].scenario).toBe(75);
    expect(changes[0].delta).toBe(75);
  });

  it('handles SKUs present in base but not in scenario (eliminated orders)', () => {
    const base = [{ sku: 'SKU-GONE', plant_id: 'P1', order_date: '2024-01-01', order_qty: 60 }];
    const scenario = [];
    const changes = computeTopChanges(base, scenario);
    expect(changes).toHaveLength(1);
    expect(changes[0].base).toBe(60);
    expect(changes[0].scenario).toBe(0);
    expect(changes[0].delta).toBe(-60);
  });

  it('aggregates multiple dates for the same sku+plant_id', () => {
    const base = [
      { sku: 'SKU-A', plant_id: 'P1', order_date: '2024-01-01', order_qty: 50 },
      { sku: 'SKU-A', plant_id: 'P1', order_date: '2024-01-08', order_qty: 50 }
    ];
    const scenario = [
      { sku: 'SKU-A', plant_id: 'P1', order_date: '2024-01-01', order_qty: 60 },
      { sku: 'SKU-A', plant_id: 'P1', order_date: '2024-01-08', order_qty: 70 }
    ];
    const changes = computeTopChanges(base, scenario);
    expect(changes).toHaveLength(1);
    expect(changes[0].base).toBe(100);    // 50+50
    expect(changes[0].scenario).toBe(130); // 60+70
    expect(changes[0].delta).toBe(30);
  });

  it('limits output to 20 changes', () => {
    const base = Array.from({ length: 30 }, (_, i) => ({
      sku: `SKU-${i}`, plant_id: 'P1', order_date: '2024-01-01', order_qty: 100
    }));
    const scenario = Array.from({ length: 30 }, (_, i) => ({
      sku: `SKU-${i}`, plant_id: 'P1', order_date: '2024-01-01', order_qty: 100 + (i + 1) * 5
    }));
    const changes = computeTopChanges(base, scenario);
    expect(changes.length).toBeLessThanOrEqual(20);
  });

  it('includes pct_delta when base is non-zero', () => {
    const base = [{ sku: 'SKU-A', plant_id: 'P1', order_date: '2024-01-01', order_qty: 100 }];
    const scenario = [{ sku: 'SKU-A', plant_id: 'P1', order_date: '2024-01-01', order_qty: 150 }];
    const changes = computeTopChanges(base, scenario);
    expect(changes[0].pct_delta).toBeCloseTo(0.5, 5);
  });
});

// ── buildNotes ────────────────────────────────────────────────────────────────

describe('buildNotes', () => {
  it('generates budget_cap note when present', () => {
    const notes = buildNotes({ budget_cap: 10000 }, {});
    expect(notes.some((n) => n.includes('10000'))).toBe(true);
  });

  it('generates service_target note with percentage', () => {
    const notes = buildNotes({ service_target: 0.95 }, {});
    expect(notes.some((n) => n.includes('95.0%'))).toBe(true);
  });

  it('generates expedite_mode note with buffer days', () => {
    const notes = buildNotes({ expedite_mode: 'on', lead_time_buffer_days: 5 }, {});
    expect(notes.some((n) => n.includes('5 day'))).toBe(true);
  });

  it('generates risk_mode note', () => {
    const notes = buildNotes({ risk_mode: 'on' }, {});
    expect(notes.some((n) => n.toLowerCase().includes('risk mode'))).toBe(true);
  });

  it('generates service level delta note', () => {
    const kpis = { delta: { service_level_proxy: 0.05 } };
    const notes = buildNotes({}, kpis);
    expect(notes.some((n) => n.includes('+5.00 pp'))).toBe(true);
  });

  it('generates stockout units delta note', () => {
    const kpis = { delta: { stockout_units: -20 } };
    const notes = buildNotes({}, kpis);
    expect(notes.some((n) => n.includes('-20'))).toBe(true);
  });

  it('returns empty array for empty inputs', () => {
    expect(buildNotes({}, {})).toEqual([]);
  });
});

// ── buildScenarioComparison ───────────────────────────────────────────────────

describe('buildScenarioComparison', () => {
  const makeReplayMetrics = (serviceLvl, stockout, holding) => ({
    with_plan: {
      service_level_proxy: serviceLvl,
      stockout_units: stockout,
      holding_units: holding
    }
  });

  const makeSolverMeta = (cost) => ({
    kpis: { estimated_total_cost: cost }
  });

  const makePlanTable = (rows) => ({ rows });

  it('returns the correct schema shape', () => {
    const result = buildScenarioComparison({
      baseRunId: 1,
      scenarioRunId: 2,
      overrides: {},
      baseReplayMetrics: makeReplayMetrics(0.9, 100, 500),
      baseSolverMeta: makeSolverMeta(20000),
      basePlanTable: makePlanTable([]),
      scenarioReplayMetrics: makeReplayMetrics(0.92, 80, 520),
      scenarioSolverMeta: makeSolverMeta(21000),
      scenarioPlanTable: makePlanTable([])
    });

    expect(result).toHaveProperty('base_run_id', 1);
    expect(result).toHaveProperty('scenario_run_id', 2);
    expect(result).toHaveProperty('overrides');
    expect(result).toHaveProperty('kpis.base');
    expect(result).toHaveProperty('kpis.scenario');
    expect(result).toHaveProperty('kpis.delta');
    expect(result).toHaveProperty('top_changes');
    expect(result).toHaveProperty('notes');
    expect(Array.isArray(result.top_changes)).toBe(true);
    expect(Array.isArray(result.notes)).toBe(true);
  });

  it('computes KPI deltas correctly', () => {
    const result = buildScenarioComparison({
      baseRunId: 1,
      scenarioRunId: 2,
      overrides: {},
      baseReplayMetrics: makeReplayMetrics(0.90, 100, 500),
      baseSolverMeta: makeSolverMeta(20000),
      basePlanTable: makePlanTable([]),
      scenarioReplayMetrics: makeReplayMetrics(0.95, 60, 550),
      scenarioSolverMeta: makeSolverMeta(22000),
      scenarioPlanTable: makePlanTable([])
    });

    expect(result.kpis.delta.service_level_proxy).toBeCloseTo(0.05, 5);
    expect(result.kpis.delta.stockout_units).toBeCloseTo(-40, 5);
    expect(result.kpis.delta.holding_units).toBeCloseTo(50, 5);
    expect(result.kpis.delta.estimated_total_cost).toBeCloseTo(2000, 5);
  });

  it('populates top_changes from plan table rows', () => {
    const baseRows = [
      { sku: 'SKU-X', plant_id: 'P1', order_date: '2024-01-01', order_qty: 100 },
      { sku: 'SKU-Y', plant_id: 'P1', order_date: '2024-01-01', order_qty: 200 }
    ];
    const scenarioRows = [
      { sku: 'SKU-X', plant_id: 'P1', order_date: '2024-01-01', order_qty: 130 },
      { sku: 'SKU-Y', plant_id: 'P1', order_date: '2024-01-01', order_qty: 180 }
    ];

    const result = buildScenarioComparison({
      baseRunId: 1,
      scenarioRunId: 2,
      overrides: {},
      baseReplayMetrics: makeReplayMetrics(0.9, 100, 500),
      baseSolverMeta: makeSolverMeta(20000),
      basePlanTable: makePlanTable(baseRows),
      scenarioReplayMetrics: makeReplayMetrics(0.92, 80, 520),
      scenarioSolverMeta: makeSolverMeta(21000),
      scenarioPlanTable: makePlanTable(scenarioRows)
    });

    expect(result.top_changes).toHaveLength(2);
    // SKU-Y has delta -20 (larger |delta|), SKU-X has delta +30
    const skuX = result.top_changes.find((c) => c.sku === 'SKU-X');
    const skuY = result.top_changes.find((c) => c.sku === 'SKU-Y');
    expect(skuX.delta).toBe(30);
    expect(skuY.delta).toBe(-20);
    // sorted by |delta|: SKU-X (30) first, then SKU-Y (20)
    expect(result.top_changes[0].sku).toBe('SKU-X');
  });

  it('generates notes that include override context', () => {
    const result = buildScenarioComparison({
      baseRunId: 1,
      scenarioRunId: 2,
      overrides: { budget_cap: 5000, risk_mode: 'on' },
      baseReplayMetrics: makeReplayMetrics(0.9, 100, 500),
      baseSolverMeta: makeSolverMeta(20000),
      basePlanTable: makePlanTable([]),
      scenarioReplayMetrics: makeReplayMetrics(0.92, 80, 520),
      scenarioSolverMeta: makeSolverMeta(21000),
      scenarioPlanTable: makePlanTable([])
    });

    expect(result.notes.some((n) => n.includes('5000'))).toBe(true);
    expect(result.notes.some((n) => n.toLowerCase().includes('risk mode'))).toBe(true);
  });

  it('handles missing artifacts gracefully (null inputs)', () => {
    const result = buildScenarioComparison({
      baseRunId: 10,
      scenarioRunId: 20,
      overrides: {},
      baseReplayMetrics: null,
      baseSolverMeta: null,
      basePlanTable: null,
      scenarioReplayMetrics: null,
      scenarioSolverMeta: null,
      scenarioPlanTable: null
    });

    expect(result.kpis.base.service_level_proxy).toBeNull();
    expect(result.kpis.delta.stockout_units).toBeNull();
    expect(result.top_changes).toEqual([]);
  });

  it('is deterministic for the same inputs (idempotent)', () => {
    const params = {
      baseRunId: 1,
      scenarioRunId: 2,
      overrides: { safety_stock_alpha: 0.5 },
      baseReplayMetrics: makeReplayMetrics(0.9, 100, 500),
      baseSolverMeta: makeSolverMeta(20000),
      basePlanTable: makePlanTable([{ sku: 'A', plant_id: 'P1', order_date: '2024-01-01', order_qty: 50 }]),
      scenarioReplayMetrics: makeReplayMetrics(0.92, 80, 520),
      scenarioSolverMeta: makeSolverMeta(21000),
      scenarioPlanTable: makePlanTable([{ sku: 'A', plant_id: 'P1', order_date: '2024-01-01', order_qty: 70 }])
    };

    const result1 = buildScenarioComparison(params);
    const result2 = buildScenarioComparison(params);

    expect(JSON.stringify(result1)).toBe(JSON.stringify(result2));
  });
});
