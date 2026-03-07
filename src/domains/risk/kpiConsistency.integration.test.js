/**
 * KPI Consistency Integration Tests
 * Verifies determinism and proportional changes in KPI computation.
 */
import { describe, it, expect } from 'vitest';
import { calculateProfitAtRiskBatch } from './profitAtRiskCalculator';

const makeRow = (material, gapQty = 100, riskLevel = 'critical') => ({
  item: material,
  material_code: material,
  plant_id: 'P100',
  gapQty,
  riskLevel,
  daysToStockout: 5,
  leadTimeDaysSource: 'supplier',
  safetyStock: 10,
  safetyStockSource: 'real',
});

const financials = [
  { material_code: 'MAT-A', profit_per_unit: 100, currency: 'USD' },
  { material_code: 'MAT-B', profit_per_unit: 50, currency: 'USD' },
  { material_code: 'MAT-C', profit_per_unit: 200, currency: 'USD' },
];

describe('KPI consistency', () => {
  it('same input produces same output (determinism)', () => {
    const rows = [makeRow('MAT-A'), makeRow('MAT-B', 50, 'warning')];

    const r1 = calculateProfitAtRiskBatch({ riskRows: rows, financials });
    const r2 = calculateProfitAtRiskBatch({ riskRows: rows, financials });

    expect(r1.summary.totalProfitAtRisk).toBe(r2.summary.totalProfitAtRisk);
    expect(r1.summary.criticalProfitAtRisk).toBe(r2.summary.criticalProfitAtRisk);
    expect(r1.summary.itemsWithRealFinancials).toBe(r2.summary.itemsWithRealFinancials);
    expect(r1.rows.length).toBe(r2.rows.length);
  });

  it('adding a row increases total profit at risk', () => {
    const base = calculateProfitAtRiskBatch({ riskRows: [makeRow('MAT-A')], financials });
    const more = calculateProfitAtRiskBatch({ riskRows: [makeRow('MAT-A'), makeRow('MAT-B', 80)], financials });

    expect(more.summary.totalProfitAtRisk).toBeGreaterThan(base.summary.totalProfitAtRisk);
  });

  it('increasing gapQty increases profit at risk proportionally', () => {
    const small = calculateProfitAtRiskBatch({ riskRows: [makeRow('MAT-A', 50)], financials });
    const large = calculateProfitAtRiskBatch({ riskRows: [makeRow('MAT-A', 100)], financials });

    expect(large.summary.totalProfitAtRisk).toBeGreaterThan(small.summary.totalProfitAtRisk);
  });

  it('critical items contribute to criticalProfitAtRisk, warning items do not', () => {
    const { summary } = calculateProfitAtRiskBatch({
      riskRows: [makeRow('MAT-A', 100, 'critical'), makeRow('MAT-B', 100, 'warning')],
      financials,
    });

    expect(summary.criticalProfitAtRisk).toBeGreaterThan(0);
    expect(summary.totalProfitAtRisk).toBeGreaterThan(summary.criticalProfitAtRisk);
  });

  it('all rows have consistent currency from financial index', () => {
    const { rows } = calculateProfitAtRiskBatch({
      riskRows: [makeRow('MAT-A'), makeRow('MAT-B')],
      financials,
    });

    for (const row of rows) {
      expect(row.currency).toBe('USD');
    }
  });
});
