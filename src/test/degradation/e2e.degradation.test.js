/**
 * Degradation Tests: End-to-End Pipeline
 *
 * Wires together multiple modules to verify that dirty headers flow
 * through normalization, validation, capability evaluation, fallback
 * audit, and risk calculation — producing correct quality signals at
 * every stage.
 */
import { describe, it, expect } from 'vitest';
import { normalizeHeader, buildHeaderIndex } from '../../utils/headerNormalize';
import { validateAndCleanRows } from '../../utils/dataValidation';
import { evaluateCapabilities } from '../../config/capabilityMatrix';
import { createFallbackAudit } from '../../config/fallbackPolicies';
import {
  calculateProfitAtRiskBatch,
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

describe('e2e degradation – dirty headers through full pipeline', () => {
  it('dirty headers -> clean mapping -> validation -> capability eval -> risk calc', () => {
    // ── Stage 1: normalize BOM-corrupted headers ─────────────────────────
    const dirtyHeaders = [
      '\uFEFFmaterial_code',        // BOM prefix
      'Plant\u00A0ID',              // NBSP
      'snapshot_date',              // underscore separator
      'onhand_qty',
    ];

    const normalized = dirtyHeaders.map(h => normalizeHeader(h));

    // BOM and invisible chars must be stripped; underscores become spaces
    expect(normalized[0]).toBe('material code');
    expect(normalized[1]).toBe('plant id');
    expect(normalized[2]).toBe('snapshot date');
    expect(normalized[3]).toBe('onhand qty');

    // ── Stage 2: buildHeaderIndex, verify all normalize uniquely ─────────
    const { index, duplicates, stats } = buildHeaderIndex(dirtyHeaders);

    expect(stats.unique).toBe(4);
    expect(duplicates).toHaveLength(0);
    // Each normalized key maps back to the original dirty header
    expect(index.get('material code')).toBe('\uFEFFmaterial_code');

    // ── Stage 3: validateAndCleanRows with inventory_snapshots data ──────
    const inventoryRows = [
      {
        material_code: 'MAT-001',
        plant_id: 'P100',
        snapshot_date: '2026-01-15',
        onhand_qty: 500,
      },
      {
        material_code: 'MAT-002',
        plant_id: 'P200',
        snapshot_date: '2026-01-15',
        onhand_qty: 0,
      },
      {
        material_code: '',           // invalid — missing required field
        plant_id: 'P300',
        snapshot_date: '2026-01-15',
        onhand_qty: 100,
      },
    ];

    const valResult = validateAndCleanRows(inventoryRows, 'inventory_snapshots');

    expect(valResult.validRows.length).toBe(2);
    expect(valResult.errorRows.length).toBe(1);
    expect(valResult.stats.successRate).toBeGreaterThan(0);

    // ── Stage 4: evaluateCapabilities with partial data ──────────────────
    // Only demand_fg + inventory_snapshots present (no PO, no financials)
    const datasets = [
      { type: 'demand_fg', fields: ['material_code', 'plant_id', 'demand_qty', 'week_bucket'] },
      { type: 'inventory_snapshots', fields: ['material_code', 'plant_id', 'onhand_qty', 'snapshot_date'] },
    ];

    const caps = evaluateCapabilities(datasets);

    expect(caps.basic_plan.available).toBe(true);
    expect(caps.profit_at_risk.available).toBe(false);
    expect(caps.inbound_aware_plan.available).toBe(false);

    // ── Stage 5: createFallbackAudit, apply fallbacks ────────────────────
    const audit = createFallbackAudit();

    // Record missing datasets
    audit.addDatasetFallback('financials');
    audit.addDatasetFallback('open_pos');

    // Apply field-level fallback for lead_time_days (row has null)
    const fbResult = audit.apply('lead_time_days', null);
    expect(fbResult.isFallback).toBe(true);
    expect(fbResult.value).toBe(7);

    const trail = audit.getAudit();
    expect(trail.summary.totalDatasetFallbacks).toBe(2);
    expect(trail.summary.degradedCapabilities).toContain('profit_at_risk');
    expect(trail.summary.degradedCapabilities).toContain('inbound_aware_plan');

    // ── Stage 6: calculateProfitAtRiskBatch with empty financials ────────
    const riskRows = [
      makeRiskRow('MAT-001', { leadTimeDaysSource: 'fallback', safetyStock: 0, safetyStockSource: 'fallback' }),
      makeRiskRow('MAT-002', { leadTimeDaysSource: 'fallback', safetyStock: 0, safetyStockSource: 'fallback' }),
    ];

    const { rows, summary } = calculateProfitAtRiskBatch({
      riskRows,
      financials: [],        // no financials available
      useFallback: true,
    });

    // All items should be ASSUMPTION (no real financials)
    rows.forEach(row => {
      expect(row.profitAtRiskReason).toBe('ASSUMPTION');
      expect(row.dataQualityLevel).toBe('estimated');
    });

    expect(summary.itemsWithRealFinancials).toBe(0);
    expect(summary.itemsWithAssumption).toBe(2);
    expect(summary.totalProfitAtRisk).toBeGreaterThan(0);
  });

  it('full data path produces verified quality level', () => {
    // All data sources present and real: supplier lead time, real safety
    // stock, real financials.
    const financials = [
      { material_code: 'MAT-A', profit_per_unit: 50, currency: 'USD' },
      { material_code: 'MAT-B', profit_per_unit: 30, currency: 'USD' },
    ];

    const riskRows = [
      makeRiskRow('MAT-A', {
        leadTimeDaysSource: 'supplier',
        leadTimeDaysUsed: 14,
        safetyStock: 20,
        safetyStockSource: 'real',
        daysToStockout: 3,
      }),
      makeRiskRow('MAT-B', {
        leadTimeDaysSource: 'supplier',
        leadTimeDaysUsed: 7,
        safetyStock: 15,
        safetyStockSource: 'real',
        daysToStockout: 10,
      }),
    ];

    const { rows, summary } = calculateProfitAtRiskBatch({
      riskRows,
      financials,
      useFallback: true,
    });

    // Every row should be REAL financials → verified quality
    rows.forEach(row => {
      expect(row.profitAtRiskReason).toBe('REAL');
      expect(row.dataQualityLevel).toBe('verified');
      expect(row.confidence_score).toBeGreaterThan(0.8);
    });

    expect(summary.itemsWithRealFinancials).toBe(2);
    expect(summary.itemsWithAssumption).toBe(0);
    expect(summary.totalProfitAtRisk).toBe(
      rows.reduce((sum, r) => sum + r.profitAtRisk, 0)
    );
  });
});
