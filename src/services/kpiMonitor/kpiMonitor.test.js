/**
 * Tests for Phase 4 KPI Continuous Monitoring:
 *   - metricEvaluators.js — 4 core evaluators + threshold checking
 *   - kpiMonitorService.js — evaluateRule integration
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateInventoryDaysOnHand,
  evaluateOpenPoAging,
  evaluateSupplierOnTimeRate,
  evaluateForecastAccuracy,
  checkThreshold,
  getEvaluator,
  listMetricTypes,
  METRIC_TYPES,
} from './metricEvaluators.js';

// ── Inventory Days on Hand ──────────────────────────────────────────────────

describe('evaluateInventoryDaysOnHand', () => {
  it('calculates DOH from stock and demand', () => {
    const rows = [
      { material_code: 'A', current_stock: 1000, avg_daily_demand: 50 },
      { material_code: 'B', current_stock: 500, avg_daily_demand: 25 },
    ];
    const result = evaluateInventoryDaysOnHand(rows);
    expect(result.value).toBe(20); // 1500 / 75
    expect(result.detail.total_stock).toBe(1500);
    expect(result.detail.items_evaluated).toBe(2);
  });

  it('returns Infinity when demand is zero', () => {
    const rows = [{ current_stock: 100, avg_daily_demand: 0 }];
    const result = evaluateInventoryDaysOnHand(rows);
    expect(result.value).toBe(Infinity);
  });

  it('returns null for empty data', () => {
    const result = evaluateInventoryDaysOnHand([]);
    expect(result.value).toBeNull();
  });

  it('filters by material_code', () => {
    const rows = [
      { material_code: 'A', current_stock: 1000, avg_daily_demand: 50 },
      { material_code: 'B', current_stock: 500, avg_daily_demand: 25 },
    ];
    const result = evaluateInventoryDaysOnHand(rows, { material_code: 'A' });
    expect(result.value).toBe(20); // 1000 / 50
    expect(result.detail.items_evaluated).toBe(1);
  });

  it('supports stock_qty alias', () => {
    const rows = [{ stock_qty: 300, daily_demand: 10 }];
    const result = evaluateInventoryDaysOnHand(rows);
    expect(result.value).toBe(30);
  });
});

// ── Open PO Aging ───────────────────────────────────────────────────────────

describe('evaluateOpenPoAging', () => {
  it('calculates average aging for open POs', () => {
    const now = new Date();
    const tenDaysAgo = new Date(now - 10 * 86400000).toISOString();
    const twentyDaysAgo = new Date(now - 20 * 86400000).toISOString();

    const rows = [
      { po_date: tenDaysAgo, status: 'open' },
      { po_date: twentyDaysAgo, status: 'open' },
      { po_date: tenDaysAgo, status: 'closed' }, // excluded
    ];
    const result = evaluateOpenPoAging(rows);
    expect(result.value).toBeCloseTo(15, 0);
    expect(result.detail.open_pos).toBe(2);
  });

  it('returns 0 for no open POs', () => {
    const rows = [{ po_date: new Date().toISOString(), status: 'closed' }];
    const result = evaluateOpenPoAging(rows);
    expect(result.value).toBe(0);
    expect(result.detail.open_pos).toBe(0);
  });

  it('includes pending POs', () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 86400000).toISOString();
    const rows = [{ po_date: fiveDaysAgo, status: 'pending' }];
    const result = evaluateOpenPoAging(rows);
    expect(result.value).toBeCloseTo(5, 0);
    expect(result.detail.open_pos).toBe(1);
  });
});

// ── Supplier On-Time Rate ───────────────────────────────────────────────────

describe('evaluateSupplierOnTimeRate', () => {
  it('calculates rate from on_time boolean', () => {
    const rows = [
      { supplier_id: 'S1', on_time: true },
      { supplier_id: 'S1', on_time: true },
      { supplier_id: 'S1', on_time: false },
      { supplier_id: 'S1', on_time: true },
    ];
    const result = evaluateSupplierOnTimeRate(rows);
    expect(result.value).toBe(0.75);
    expect(result.detail.on_time_count).toBe(3);
    expect(result.detail.late_count).toBe(1);
  });

  it('calculates from dates', () => {
    const rows = [
      { promised_date: '2026-03-10', actual_date: '2026-03-09' }, // on time
      { promised_date: '2026-03-10', actual_date: '2026-03-10' }, // on time (same day)
      { promised_date: '2026-03-10', actual_date: '2026-03-12' }, // late
    ];
    const result = evaluateSupplierOnTimeRate(rows);
    expect(result.value).toBeCloseTo(0.667, 2);
  });

  it('returns null for empty data', () => {
    const result = evaluateSupplierOnTimeRate([]);
    expect(result.value).toBeNull();
  });

  it('filters by supplier_id', () => {
    const rows = [
      { supplier_id: 'S1', on_time: true },
      { supplier_id: 'S2', on_time: false },
    ];
    const result = evaluateSupplierOnTimeRate(rows, { supplier_id: 'S1' });
    expect(result.value).toBe(1);
  });
});

// ── Forecast Accuracy ───────────────────────────────────────────────────────

describe('evaluateForecastAccuracy', () => {
  it('calculates accuracy as 1 - MAPE', () => {
    const rows = [
      { forecast: 100, actual: 100 }, // 0% error
      { forecast: 110, actual: 100 }, // 10% error
      { forecast: 90, actual: 100 },  // 10% error
    ];
    const result = evaluateForecastAccuracy(rows);
    // MAPE = (0 + 0.1 + 0.1) / 3 = 0.0667
    expect(result.value).toBeCloseTo(0.933, 2);
    expect(result.detail.mape).toBeCloseTo(0.067, 2);
  });

  it('excludes rows with actual = 0', () => {
    const rows = [
      { forecast: 100, actual: 100 },
      { forecast: 50, actual: 0 }, // excluded
    ];
    const result = evaluateForecastAccuracy(rows);
    expect(result.value).toBe(1); // perfect for the one valid row
    expect(result.detail.data_points).toBe(1);
  });

  it('returns null for empty data', () => {
    const result = evaluateForecastAccuracy([]);
    expect(result.value).toBeNull();
  });

  it('supports predicted alias', () => {
    const rows = [{ predicted: 110, actual: 100 }];
    const result = evaluateForecastAccuracy(rows);
    expect(result.value).toBeCloseTo(0.9, 1);
  });

  it('clamps accuracy at 0 for very bad forecasts', () => {
    const rows = [{ forecast: 500, actual: 100 }]; // 400% error → MAPE = 4
    const result = evaluateForecastAccuracy(rows);
    expect(result.value).toBe(0);
  });
});

// ── Threshold Checking ──────────────────────────────────────────────────────

describe('checkThreshold', () => {
  it('detects below threshold', () => {
    expect(checkThreshold(5, 'below', 10).breached).toBe(true);
    expect(checkThreshold(15, 'below', 10).breached).toBe(false);
    expect(checkThreshold(10, 'below', 10).breached).toBe(false); // equal = not breached
  });

  it('detects above threshold', () => {
    expect(checkThreshold(15, 'above', 10).breached).toBe(true);
    expect(checkThreshold(5, 'above', 10).breached).toBe(false);
  });

  it('detects drift (>20%)', () => {
    expect(checkThreshold(130, 'drift', 100).breached).toBe(true);  // 30% drift
    expect(checkThreshold(115, 'drift', 100).breached).toBe(false); // 15% drift
  });

  it('detects outside_range', () => {
    expect(checkThreshold(5, 'outside_range', 10, 20).breached).toBe(true);
    expect(checkThreshold(25, 'outside_range', 10, 20).breached).toBe(true);
    expect(checkThreshold(15, 'outside_range', 10, 20).breached).toBe(false);
  });

  it('handles null value', () => {
    expect(checkThreshold(null, 'below', 10).breached).toBe(false);
  });

  it('handles missing upper bound for outside_range', () => {
    expect(checkThreshold(5, 'outside_range', 10).breached).toBe(false);
  });

  it('handles unknown threshold type', () => {
    expect(checkThreshold(5, 'unknown', 10).breached).toBe(false);
  });
});

// ── Evaluator Registry ──────────────────────────────────────────────────────

describe('evaluator registry', () => {
  it('returns evaluator for all known types', () => {
    expect(getEvaluator(METRIC_TYPES.INVENTORY_DAYS_ON_HAND)).toBe(evaluateInventoryDaysOnHand);
    expect(getEvaluator(METRIC_TYPES.OPEN_PO_AGING)).toBe(evaluateOpenPoAging);
    expect(getEvaluator(METRIC_TYPES.SUPPLIER_ON_TIME_RATE)).toBe(evaluateSupplierOnTimeRate);
    expect(getEvaluator(METRIC_TYPES.FORECAST_ACCURACY)).toBe(evaluateForecastAccuracy);
  });

  it('returns null for unknown type', () => {
    expect(getEvaluator('nonexistent')).toBeNull();
  });

  it('lists all metric types', () => {
    const types = listMetricTypes();
    expect(types).toContain('inventory_days_on_hand');
    expect(types).toContain('open_po_aging_days');
    expect(types).toContain('supplier_on_time_rate');
    expect(types).toContain('forecast_accuracy');
  });
});

// ── Entity Filter ───────────────────────────────────────────────────────────

describe('entity filter', () => {
  it('filters by array values', () => {
    const rows = [
      { material_code: 'A', current_stock: 100, avg_daily_demand: 10 },
      { material_code: 'B', current_stock: 200, avg_daily_demand: 20 },
      { material_code: 'C', current_stock: 300, avg_daily_demand: 30 },
    ];
    const result = evaluateInventoryDaysOnHand(rows, { material_code: ['A', 'B'] });
    expect(result.detail.items_evaluated).toBe(2);
  });

  it('filters by multiple fields', () => {
    const rows = [
      { material_code: 'A', plant_id: 'P1', current_stock: 100, avg_daily_demand: 10 },
      { material_code: 'A', plant_id: 'P2', current_stock: 200, avg_daily_demand: 20 },
    ];
    const result = evaluateInventoryDaysOnHand(rows, { material_code: 'A', plant_id: 'P1' });
    expect(result.detail.items_evaluated).toBe(1);
  });
});
