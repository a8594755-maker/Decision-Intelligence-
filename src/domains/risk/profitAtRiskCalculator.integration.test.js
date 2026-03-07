/**
 * Integration tests for profitAtRiskCalculator
 * Verifies the full batch calculation pipeline including data quality levels.
 */
import { describe, it, expect } from 'vitest';
import { calculateProfitAtRiskBatch } from './profitAtRiskCalculator';

// Row uses `item` (not material_code) — that's what calculateProfitAtRiskForRow looks up
const makeRow = (overrides = {}) => ({
  item: 'MAT-001',
  material_code: 'MAT-001',
  plant_id: 'P100',
  gapQty: 100,
  riskLevel: 'critical',
  daysToStockout: 5,
  leadTimeDaysSource: 'supplier',
  safetyStock: 10,
  safetyStockSource: 'real',
  ...overrides,
});

// Financial data needs `profit_per_unit` for buildFinancialIndex to accept it
const makeFinancials = (extras = []) => [
  { material_code: 'MAT-001', profit_per_unit: 50, currency: 'USD' },
  ...extras,
];

describe('calculateProfitAtRiskBatch integration', () => {
  it('calculates profit at risk with real financials', () => {
    const { rows, summary } = calculateProfitAtRiskBatch({
      riskRows: [makeRow()], financials: makeFinancials(),
    });

    expect(summary.totalProfitAtRisk).toBeGreaterThan(0);
    expect(typeof summary.itemsWithRealFinancials).toBe('number');
    expect(summary.itemsWithRealFinancials).toBeGreaterThanOrEqual(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].profitAtRisk).toBeGreaterThan(0);
    expect(rows[0].profitAtRiskReason).toBe('REAL');
  });

  it('uses fallback assumption when no financial data matches', () => {
    const { summary } = calculateProfitAtRiskBatch({
      riskRows: [makeRow({ item: 'MAT-UNKNOWN', material_code: 'MAT-UNKNOWN' })],
      financials: makeFinancials(),
    });

    expect(summary.itemsWithAssumption).toBe(1);
  });

  it('handles empty rows gracefully', () => {
    const { rows, summary } = calculateProfitAtRiskBatch({
      riskRows: [], financials: makeFinancials(),
    });

    expect(summary.totalProfitAtRisk).toBe(0);
    expect(summary.criticalProfitAtRisk).toBe(0);
    expect(rows).toHaveLength(0);
  });

  it('separates critical vs non-critical profit at risk', () => {
    const { summary } = calculateProfitAtRiskBatch({
      riskRows: [
        makeRow({ riskLevel: 'critical', gapQty: 100 }),
        makeRow({ item: 'MAT-002', material_code: 'MAT-002', riskLevel: 'warning', gapQty: 50 }),
      ],
      financials: makeFinancials([{ material_code: 'MAT-002', profit_per_unit: 30, currency: 'USD' }]),
    });

    expect(summary.criticalProfitAtRisk).toBeGreaterThan(0);
    expect(summary.totalProfitAtRisk).toBeGreaterThan(summary.criticalProfitAtRisk);
  });

  it('computes dataQualityLevel correctly', () => {
    // Real financial match + real lead time + real safety stock → verified
    const r1 = calculateProfitAtRiskBatch({
      riskRows: [makeRow({ leadTimeDaysSource: 'supplier', safetyStockSource: 'real' })],
      financials: makeFinancials(),
    });
    expect(r1.rows[0].dataQualityLevel).toBe('verified');

    // One fallback (lead time) → partial
    const r2 = calculateProfitAtRiskBatch({
      riskRows: [makeRow({ leadTimeDaysSource: 'fallback', safetyStockSource: 'real' })],
      financials: makeFinancials(),
    });
    expect(r2.rows[0].dataQualityLevel).toBe('partial');

    // No financial data with useFallback=false → missing
    const r4 = calculateProfitAtRiskBatch({
      riskRows: [makeRow({ item: 'NO_FIN', material_code: 'NO_FIN', gapQty: 0 })],
      financials: [],
      useFallback: false,
    });
    expect(r4.rows[0].dataQualityLevel).toBe('missing');
  });

  it('.length fix: itemsWithRealFinancials returns a number, not undefined', () => {
    const { summary } = calculateProfitAtRiskBatch({
      riskRows: [makeRow(), makeRow({ item: 'MAT-002', material_code: 'MAT-002' })],
      financials: makeFinancials([{ material_code: 'MAT-002', profit_per_unit: 25, currency: 'EUR' }]),
    });

    // This was the bug: .size returned undefined, .length returns a number
    expect(typeof summary.itemsWithRealFinancials).toBe('number');
    expect(summary.itemsWithRealFinancials).toBeGreaterThanOrEqual(1);
  });

  // ─── Explainability Tests ─────────────────────────────────────────────

  it('assumptions have impact field for fallback rows', () => {
    const { rows } = calculateProfitAtRiskBatch({
      riskRows: [makeRow({
        item: 'MAT-NOFIN', material_code: 'MAT-NOFIN',
        leadTimeDaysSource: 'fallback', safetyStockSource: 'fallback',
        daysToStockout: undefined, // no demand data
      })],
      financials: [],
    });

    const row = rows[0];
    // All 4 assumptions should be default
    expect(row.assumptions.every(a => a.isDefault)).toBe(true);
    // profitPerUnit impact should show estimated value
    const profitAssumption = row.assumptions.find(a => a.field === 'profitPerUnit');
    expect(profitAssumption.impact).toBeTruthy();
    expect(profitAssumption.impact.severity).toBe('high');
    expect(profitAssumption.impact.estimatedWithRealData).toBeGreaterThan(profitAssumption.impact.currentValue);
    expect(profitAssumption.impact.sensitivityNote).toContain('$');
    // demand missing → high severity
    const demandAssumption = row.assumptions.find(a => a.field === 'demandCoverage');
    expect(demandAssumption.source).toBe('missing');
    expect(demandAssumption.impact.severity).toBe('high');
    expect(demandAssumption.impact.sensitivityNote).toContain('demand');
  });

  it('assumptions have null impact for real-data rows', () => {
    const { rows } = calculateProfitAtRiskBatch({
      riskRows: [makeRow()], financials: makeFinancials(),
    });
    const row = rows[0];
    const profitAssumption = row.assumptions.find(a => a.field === 'profitPerUnit');
    expect(profitAssumption.impact).toBeNull();
    expect(profitAssumption.isDefault).toBe(false);
  });

  it('confidence_score varies meaningfully across data quality scenarios', () => {
    // All real data
    const best = calculateProfitAtRiskBatch({
      riskRows: [makeRow()], financials: makeFinancials(),
    }).rows[0].confidence_score;

    // All fallback
    const worst = calculateProfitAtRiskBatch({
      riskRows: [makeRow({
        item: 'MAT-X', material_code: 'MAT-X',
        leadTimeDaysSource: 'fallback', safetyStockSource: 'fallback',
        daysToStockout: undefined,
      })],
      financials: [],
    }).rows[0].confidence_score;

    // Mixed: real financials, fallback lead time
    const mixed = calculateProfitAtRiskBatch({
      riskRows: [makeRow({ leadTimeDaysSource: 'fallback', safetyStockSource: 'fallback' })],
      financials: makeFinancials(),
    }).rows[0].confidence_score;

    // Scores should be distinct and well-separated
    expect(best).toBe(1); // all real → 1.0
    expect(worst).toBeLessThan(0.35); // all missing/fallback → very low
    expect(mixed).toBeGreaterThan(worst);
    expect(mixed).toBeLessThan(best);
    // The gap between best and worst should be wide
    expect(best - worst).toBeGreaterThanOrEqual(0.7);
  });

  it('what_if_hints differentiate missing vs fallback urgency', () => {
    const { rows } = calculateProfitAtRiskBatch({
      riskRows: [makeRow({
        item: 'MAT-NOFIN', material_code: 'MAT-NOFIN',
        daysToStockout: undefined,
      })],
      financials: [],
    });

    const hints = rows[0].computationTrace.what_if_hints;
    // Should have hints for profitPerUnit (fallback), leadTime, safetyStock, demandCoverage (missing)
    expect(hints.length).toBeGreaterThanOrEqual(2);

    // profitPerUnit is ASSUMPTION (not missing, because useFallback=true)
    const profitHint = hints.find(h => h.field === 'profitPerUnit');
    expect(profitHint).toBeTruthy();
    expect(profitHint.estimatedImpact).toBeTruthy();

    // demandCoverage is MISSING → critical urgency
    const demandHint = hints.find(h => h.field === 'demandCoverage');
    expect(demandHint).toBeTruthy();
    expect(demandHint.urgency).toBe('critical');
    expect(demandHint.action).toContain('CRITICAL');
  });

  it('computationTrace includes all steps even with partial data', () => {
    const { rows } = calculateProfitAtRiskBatch({
      riskRows: [makeRow({ daysToStockout: undefined })],
      financials: makeFinancials(),
    });

    const trace = rows[0].computationTrace;
    // Without demand data, should have 4 steps (no Inventory Risk step)
    expect(trace.steps.length).toBe(4);
    expect(trace.steps.map(s => s.label)).toEqual([
      'Inventory Lookup', 'Supply Coverage', 'Gap Calculation', 'Profit at Risk'
    ]);
    // With demand data
    const { rows: rows2 } = calculateProfitAtRiskBatch({
      riskRows: [makeRow()], financials: makeFinancials(),
    });
    expect(rows2[0].computationTrace.steps.length).toBe(5);
    expect(rows2[0].computationTrace.steps[4].label).toBe('Inventory Risk');
  });
});
