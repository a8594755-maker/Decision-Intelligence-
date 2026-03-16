/**
 * Regression: Plan Summary / Data Quality Rendering Consistency
 *
 * Tests that utility functions used by PlanSummaryCard, DataQualityCard,
 * and capability unlock ranker produce consistent output across various
 * data shapes and edge cases.
 */
import { describe, it, expect } from 'vitest';

import { evaluateCapabilities } from '../../config/capabilityMatrix';
import { buildDataQualityReport } from '../../utils/dataQualityReport';
import { rankCapabilityUnlocks, getTopUnlockHint } from '../../utils/capabilityUnlockRanker';
import { runWhatIfScenario, applyExpediteAction, normalizeWhatIfKey, runWhatIfBatch } from '../../domains/risk/whatIfEngine';

// ── Capability Unlock Ranker ──────────────────────────────────────────────

describe('Capability Unlock Ranker', () => {
  it('ranks missing datasets by unlock value', () => {
    const caps = evaluateCapabilities([
      { type: 'demand_fg', fields: ['material_code', 'plant_id', 'demand_qty', 'time_bucket'] },
      { type: 'inventory_snapshots', fields: ['material_code', 'plant_id', 'onhand_qty', 'snapshot_date'] },
    ]);

    const ranked = rankCapabilityUnlocks(caps);
    expect(ranked.length).toBeGreaterThan(0);

    // Each recommendation has required fields
    for (const rec of ranked) {
      expect(rec).toHaveProperty('dataset');
      expect(rec).toHaveProperty('label');
      expect(rec).toHaveProperty('unlocks');
      expect(rec).toHaveProperty('hint');
      expect(rec).toHaveProperty('priority_score');
      expect(typeof rec.priority_score).toBe('number');
    }

    // Sorted by priority_score descending
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].priority_score).toBeGreaterThanOrEqual(ranked[i].priority_score);
    }
  });

  it('returns empty array when all capabilities are full', () => {
    const caps = evaluateCapabilities([
      { type: 'demand_fg', fields: ['material_code', 'plant_id', 'demand_qty', 'time_bucket'] },
      { type: 'inventory_snapshots', fields: ['material_code', 'plant_id', 'onhand_qty', 'snapshot_date'] },
      { type: 'po_open_lines', fields: ['material_code', 'open_qty', 'time_bucket'] },
      { type: 'fg_financials', fields: ['material_code', 'unit_margin'] },
      { type: 'bom_edge', fields: ['parent_material', 'child_material', 'qty_per'] },
      { type: 'goods_receipt', fields: ['supplier_name', 'material_code', 'actual_delivery_date', 'received_qty'] },
      { type: 'supplier_master', fields: ['supplier_id'] },
    ]);

    const ranked = rankCapabilityUnlocks(caps);
    expect(ranked).toHaveLength(0);
  });

  it('getTopUnlockHint returns string for partial data', () => {
    const caps = evaluateCapabilities([
      { type: 'demand_fg', fields: ['material_code', 'plant_id', 'demand_qty', 'time_bucket'] },
      { type: 'inventory_snapshots', fields: ['material_code', 'plant_id', 'onhand_qty', 'snapshot_date'] },
    ]);

    const hint = getTopUnlockHint(caps);
    expect(typeof hint).toBe('string');
    expect(hint.length).toBeGreaterThan(0);
    expect(hint).toContain('Upload');
  });

  it('getTopUnlockHint returns null when all data present', () => {
    const caps = evaluateCapabilities([
      { type: 'demand_fg', fields: ['material_code', 'plant_id', 'demand_qty', 'time_bucket'] },
      { type: 'inventory_snapshots', fields: ['material_code', 'plant_id', 'onhand_qty', 'snapshot_date'] },
      { type: 'po_open_lines', fields: ['material_code', 'open_qty', 'time_bucket'] },
      { type: 'fg_financials', fields: ['material_code', 'unit_margin'] },
      { type: 'bom_edge', fields: ['parent_material', 'child_material', 'qty_per'] },
      { type: 'goods_receipt', fields: ['supplier_name', 'material_code', 'actual_delivery_date', 'received_qty'] },
      { type: 'supplier_master', fields: ['supplier_id'] },
    ]);

    const hint = getTopUnlockHint(caps);
    expect(hint).toBeNull();
  });
});

// ── What-If Engine Scenarios ──────────────────────────────────────────────

describe('What-If Engine Scenarios', () => {
  const baseInput = {
    materialCode: 'SKU-001',
    plantId: 'P1',
    onHand: 100,
    safetyStock: 20,
    inboundLines: [
      { poNumber: 'PO-1', bucket: '2025-W04', qty: 50 },
      { poNumber: 'PO-2', bucket: '2025-W06', qty: 80 },
    ],
    gapQty: 60,
    nextStockoutBucket: '2025-W05',
    pStockout: 0.8,
    impactUsd: 10000,
    costUsd: 0,
  };

  describe('expedite scenario', () => {
    it('reduces stockout probability when gap covered', () => {
      const result = runWhatIfScenario(baseInput, { type: 'expedite', byBuckets: 2 });
      expect(result.success).toBe(true);
      expect(result.after.pStockout).toBeLessThanOrEqual(result.before.pStockout);
      expect(result.delta.pStockout).toBeLessThanOrEqual(0);
    });

    it('calculates positive ROI for beneficial expedite', () => {
      const result = runWhatIfScenario(baseInput, { type: 'expedite', byBuckets: 2 });
      expect(result.success).toBe(true);
      // ROI should be defined
      expect(typeof result.roi).toBe('number');
    });
  });

  describe('exclude_open_po scenario', () => {
    it('increases risk when POs excluded', () => {
      const result = runWhatIfScenario(baseInput, { type: 'exclude_open_po' });
      expect(result.success).toBe(true);
      expect(result.after).toBeDefined();
      expect(result.after.note).toContain('open POs excluded');
    });
  });

  describe('stressed_demand scenario', () => {
    it('increases impact with demand multiplier', () => {
      const result = runWhatIfScenario(baseInput, { type: 'stressed_demand', demandMultiplier: 1.5 });
      expect(result.success).toBe(true);
      expect(result.after.note).toContain('50%');
    });

    it('defaults to 20% stress', () => {
      const result = runWhatIfScenario(baseInput, { type: 'stressed_demand' });
      expect(result.success).toBe(true);
      expect(result.after.note).toContain('20%');
    });
  });

  describe('lead_time_stress scenario', () => {
    it('increases risk with longer lead times', () => {
      const result = runWhatIfScenario(baseInput, { type: 'lead_time_stress', leadTimeDelta: 14 });
      expect(result.success).toBe(true);
      expect(result.after.note).toContain('14 days');
      expect(result.after.delayedInbound).toBeDefined();
    });
  });

  describe('change_safety_stock scenario', () => {
    it('shows impact of increasing safety stock', () => {
      const result = runWhatIfScenario(baseInput, { type: 'change_safety_stock', newSafetyStock: 50 });
      expect(result.success).toBe(true);
      expect(result.after.note).toContain('50');
      expect(result.after.costUsd).toBeGreaterThanOrEqual(0);
    });

    it('shows impact of reducing safety stock', () => {
      const result = runWhatIfScenario(baseInput, { type: 'change_safety_stock', newSafetyStock: 5 });
      expect(result.success).toBe(true);
    });
  });

  describe('do_nothing scenario', () => {
    it('returns no change', () => {
      const result = runWhatIfScenario(baseInput, { type: 'do_nothing' });
      expect(result.success).toBe(true);
      expect(result.delta.pStockout).toBe(0);
      expect(result.delta.impactUsd).toBe(0);
    });
  });

  describe('invalid inputs', () => {
    it('returns failure for null input', () => {
      const result = runWhatIfScenario(null, { type: 'expedite' });
      expect(result.success).toBe(false);
    });

    it('returns failure for unsupported action type', () => {
      const result = runWhatIfScenario(baseInput, { type: 'unknown_action' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unsupported');
    });
  });

  describe('applyExpediteAction', () => {
    it('shifts inbound earlier by N buckets', () => {
      const result = applyExpediteAction(baseInput.inboundLines, 2);
      expect(result).toHaveLength(2);
      expect(result[0].bucket).toBe('2025-W02');
      expect(result[1].bucket).toBe('2025-W04');
      expect(result[0].expedited).toBe(true);
    });

    it('handles empty inbound', () => {
      const result = applyExpediteAction([], 1);
      expect(result).toHaveLength(0);
    });
  });

  describe('normalizeWhatIfKey', () => {
    it('creates pipe-separated key', () => {
      expect(normalizeWhatIfKey('SKU-001', 'P1')).toBe('SKU-001|P1');
    });
  });

  describe('runWhatIfBatch', () => {
    it('processes multiple inputs', () => {
      const inputs = [
        { ...baseInput, materialCode: 'SKU-001' },
        { ...baseInput, materialCode: 'SKU-002', gapQty: 0 },
      ];
      const result = runWhatIfBatch(inputs, { type: 'expedite', byBuckets: 1 });
      expect(result.success).toBe(true);
      expect(result.count).toBe(2);
      expect(result.results).toHaveLength(2);
    });

    it('respects maxKeys limit', () => {
      const inputs = Array.from({ length: 200 }, (_, i) => ({
        ...baseInput, materialCode: `SKU-${i}`,
      }));
      const result = runWhatIfBatch(inputs, { type: 'expedite', byBuckets: 1 }, { maxKeys: 10 });
      expect(result.count).toBeLessThanOrEqual(10);
    });
  });
});

// ── Data Quality Report Edge Cases ────────────────────────────────────────

describe('Data Quality Report Edge Cases', () => {
  it('handles null capabilities gracefully', () => {
    const report = buildDataQualityReport({
      availableDatasets: ['demand_fg'],
      missingDatasets: [],
      capabilities: null,
    });
    expect(report.capabilities).toBeUndefined();
  });

  it('handles empty rowStats', () => {
    const report = buildDataQualityReport({
      availableDatasets: [],
      missingDatasets: [],
      rowStats: null,
    });
    expect(report.row_stats).toBeUndefined();
  });

  it('includes quarantined count in row_stats', () => {
    const report = buildDataQualityReport({
      availableDatasets: ['demand_fg'],
      missingDatasets: [],
      rowStats: { total: 100, clean: 90, with_fallback: 10, dropped: 0 },
      quarantinedCount: 5,
    });
    expect(report.row_stats.quarantined).toBe(5);
  });

  it('coverage level thresholds are correct', () => {
    // 0 missing → full
    expect(buildDataQualityReport({ availableDatasets: [], missingDatasets: [] }).coverage_level).toBe('full');
    // 1 missing → partial
    expect(buildDataQualityReport({ availableDatasets: [], missingDatasets: ['a'] }).coverage_level).toBe('partial');
    // 2 missing → partial
    expect(buildDataQualityReport({ availableDatasets: [], missingDatasets: ['a', 'b'] }).coverage_level).toBe('partial');
    // 3 missing → minimal
    expect(buildDataQualityReport({ availableDatasets: [], missingDatasets: ['a', 'b', 'c'] }).coverage_level).toBe('minimal');
  });
});
