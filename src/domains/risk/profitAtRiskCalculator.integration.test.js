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
});
