/**
 * Degradation Tests: profitAtRiskCalculator
 *
 * Validates that profit-at-risk calculations handle mixed financial
 * coverage, fallback modes, and field-name variants gracefully,
 * producing correct dataQualityLevel and deterministic results.
 */
import { describe, it, expect } from 'vitest';
import {
  calculateProfitAtRiskBatch,
  calculateProfitAtRiskForRow,
  buildFinancialIndex,
} from '../../domains/risk/profitAtRiskCalculator';

/** Helper: build a risk row with sensible defaults */
const makeRiskRow = (item, overrides = {}) => ({
  item,
  material_code: item,
  plant_id: 'P100',
  gapQty: 100,
  riskLevel: 'critical',
  daysToStockout: 5,
  leadTimeDaysSource: 'supplier',
  safetyStock: 10,
  safetyStockSource: 'real',
  ...overrides,
});

describe('profitAtRiskCalculator – degradation scenarios', () => {
  // ── 1. Mixed financial coverage ─────────────────────────────────────────
  it('items with financials get REAL, others get ASSUMPTION', () => {
    const financials = [
      { material_code: 'MAT-A', profit_per_unit: 25, currency: 'USD' },
    ];

    const riskRows = [
      makeRiskRow('MAT-A'),  // has financials
      makeRiskRow('MAT-B'),  // no financials
    ];

    const { rows } = calculateProfitAtRiskBatch({ riskRows, financials, useFallback: true });

    const matA = rows.find(r => r.item === 'MAT-A');
    const matB = rows.find(r => r.item === 'MAT-B');

    expect(matA.profitAtRiskReason).toBe('REAL');
    expect(matA.profitPerUnit).toBe(25);

    expect(matB.profitAtRiskReason).toBe('ASSUMPTION');
    expect(matB.profitPerUnit).toBe(10); // DEFAULT_PROFIT_PER_UNIT
  });

  // ── 2. dataQualityLevel reflects combined fallback count ────────────────
  it('reports verified quality when all data is real', () => {
    const financials = [
      { material_code: 'MAT-A', profit_per_unit: 25 },
    ];

    const row = makeRiskRow('MAT-A', {
      leadTimeDaysSource: 'supplier',
      safetyStock: 10,
      safetyStockSource: 'real',
    });

    const result = calculateProfitAtRiskForRow(row, buildFinancialIndex(financials), true);

    // profitAtRiskReason=REAL, leadTime=supplier, safetyStock=real → fallbackCount=0
    expect(result.dataQualityLevel).toBe('verified');
  });

  it('reports partial quality with one fallback field', () => {
    // No financials → ASSUMPTION (fallbackCount=1), but leadTime=supplier & safetyStock=real
    const row = makeRiskRow('MAT-X', {
      leadTimeDaysSource: 'supplier',
      safetyStock: 10,
      safetyStockSource: 'real',
    });

    const result = calculateProfitAtRiskForRow(row, {}, true);

    expect(result.profitAtRiskReason).toBe('ASSUMPTION');
    expect(result.dataQualityLevel).toBe('partial');
  });

  it('reports estimated quality with multiple fallback fields', () => {
    // No financials → ASSUMPTION, leadTime=fallback, safetyStock=0/not-real
    const row = makeRiskRow('MAT-Y', {
      leadTimeDaysSource: 'fallback',
      safetyStock: 0,
      safetyStockSource: 'fallback',
    });

    const result = calculateProfitAtRiskForRow(row, {}, true);

    expect(result.profitAtRiskReason).toBe('ASSUMPTION');
    expect(result.dataQualityLevel).toBe('estimated');
  });

  // ── 3. useFallback=false → MISSING for unmatched items ──────────────────
  it('returns MISSING and profitAtRisk=0 when useFallback is false', () => {
    const row = makeRiskRow('MAT-UNKNOWN');

    const result = calculateProfitAtRiskForRow(row, {}, false);

    expect(result.profitAtRiskReason).toBe('MISSING');
    expect(result.profitAtRisk).toBe(0);
    expect(result.profitPerUnit).toBe(0);
  });

  // ── 4. buildFinancialIndex handles multiple field name variants ─────────
  it('reads profit_per_unit, margin_per_unit, and gross_margin field names', () => {
    const financials = [
      { material_code: 'A', profit_per_unit: 10 },
      { material_code: 'B', margin_per_unit: 20 },
      { material_code: 'C', gross_margin: 30 },
    ];

    const index = buildFinancialIndex(financials);

    expect(index['A']).toBeDefined();
    expect(index['A'].profitPerUnit).toBe(10);
    expect(index['A'].source).toBe('REAL');

    expect(index['B']).toBeDefined();
    expect(index['B'].profitPerUnit).toBe(20);

    expect(index['C']).toBeDefined();
    expect(index['C'].profitPerUnit).toBe(30);
  });

  // ── 5. Batch determinism ───────────────────────────────────────────────
  it('produces identical results across repeated calculations', () => {
    const financials = [
      { material_code: 'MAT-A', profit_per_unit: 25 },
    ];

    const riskRows = [
      makeRiskRow('MAT-A'),
      makeRiskRow('MAT-B'),
      makeRiskRow('MAT-C', { gapQty: 50, riskLevel: 'warning' }),
    ];

    const run1 = calculateProfitAtRiskBatch({ riskRows, financials, useFallback: true });
    const run2 = calculateProfitAtRiskBatch({ riskRows, financials, useFallback: true });

    // Summary totals must be identical
    expect(run1.summary.totalProfitAtRisk).toBe(run2.summary.totalProfitAtRisk);
    expect(run1.summary.itemsWithAssumption).toBe(run2.summary.itemsWithAssumption);
    expect(run1.summary.itemsWithRealFinancials).toBe(run2.summary.itemsWithRealFinancials);

    // Each row must match
    for (let i = 0; i < run1.rows.length; i++) {
      expect(run1.rows[i].profitAtRisk).toBe(run2.rows[i].profitAtRisk);
      expect(run1.rows[i].profitAtRiskReason).toBe(run2.rows[i].profitAtRiskReason);
      expect(run1.rows[i].dataQualityLevel).toBe(run2.rows[i].dataQualityLevel);
      expect(run1.rows[i].confidence_score).toBe(run2.rows[i].confidence_score);
    }
  });
});
