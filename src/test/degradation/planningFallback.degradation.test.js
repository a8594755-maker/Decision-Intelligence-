/**
 * Degradation Tests: capabilityMatrix + fallbackPolicies
 *
 * Validates that the capability evaluation engine correctly determines
 * what the platform CAN do given partial data, and that the fallback
 * audit tracker records every assumption applied during a planning run.
 */
import { describe, it, expect } from 'vitest';
import { evaluateCapabilities } from '../../config/capabilityMatrix';
import { createFallbackAudit, getDegradationMessage } from '../../config/fallbackPolicies';

// ── capabilityMatrix tests ────────────────────────────────────────────────

describe('capabilityMatrix – degradation scenarios', () => {
  it('marks basic_plan as available with demand_fg + inventory_snapshots', () => {
    const datasets = [
      { type: 'demand_fg', fields: ['material_code', 'plant_id', 'demand_qty', 'week_bucket'] },
      { type: 'inventory_snapshots', fields: ['material_code', 'plant_id', 'onhand_qty', 'snapshot_date'] },
    ];

    const caps = evaluateCapabilities(datasets);

    expect(caps.basic_plan.available).toBe(true);
    expect(['full', 'partial']).toContain(caps.basic_plan.level);
    expect(caps.basic_plan.missingDatasets).toHaveLength(0);
  });

  it('marks profit_at_risk as unavailable without fg_financials', () => {
    const datasets = [
      { type: 'demand_fg', fields: ['material_code', 'plant_id', 'demand_qty', 'week_bucket'] },
      { type: 'inventory_snapshots', fields: ['material_code', 'plant_id', 'onhand_qty', 'snapshot_date'] },
    ];

    const caps = evaluateCapabilities(datasets);

    expect(caps.profit_at_risk.available).toBe(false);
    expect(caps.profit_at_risk.level).toBe('unavailable');
    expect(caps.profit_at_risk.missingDatasets).toContain('fg_financials');
  });

  it('reports no unavailable capabilities when all datasets are present', () => {
    const datasets = [
      { type: 'demand_fg', fields: ['material_code', 'plant_id', 'demand_qty', 'week_bucket'] },
      { type: 'inventory_snapshots', fields: ['material_code', 'plant_id', 'onhand_qty', 'snapshot_date'] },
      { type: 'fg_financials', fields: ['material_code', 'unit_margin'] },
      { type: 'po_open_lines', fields: ['material_code', 'open_qty', 'week_bucket'] },
      { type: 'bom_edge', fields: ['parent_material', 'child_material', 'qty_per'] },
      { type: 'goods_receipt', fields: ['supplier_name', 'material_code', 'actual_delivery_date', 'received_qty'] },
    ];

    const caps = evaluateCapabilities(datasets);

    // Every capability should be available
    for (const [_key, cap] of Object.entries(caps)) {
      expect(cap.available).toBe(true);
      expect(cap.level).not.toBe('unavailable');
    }
  });
});

// ── fallbackPolicies tests ────────────────────────────────────────────────

describe('fallbackPolicies – degradation scenarios', () => {
  it('tracks field-level fallback when lead_time_days is missing', () => {
    const audit = createFallbackAudit();

    // Simulate applying fallback for a row with missing lead_time_days
    const result = audit.apply('lead_time_days', null);

    expect(result.isFallback).toBe(true);
    expect(result.value).toBe(7); // global default
    expect(result.source).toBe('global_default');

    const trail = audit.getAudit();
    expect(trail.summary.totalFieldFallbacks).toBe(1);
    expect(trail.summary.fallbackFields).toContain('lead_time_days');
  });

  it('tracks dataset-level fallback for missing financials', () => {
    const audit = createFallbackAudit();

    audit.addDatasetFallback('financials');

    const trail = audit.getAudit();
    expect(trail.summary.totalDatasetFallbacks).toBe(1);
    expect(trail.datasetFallbacks).toHaveLength(1);
    expect(trail.datasetFallbacks[0].dataset).toBe('financials');
    expect(trail.datasetFallbacks[0].degradesCapability).toBe('profit_at_risk');
    expect(trail.datasetFallbacks[0].message).toBeTruthy();
  });

  it('aggregates multiple fallback applications correctly', () => {
    const audit = createFallbackAudit();

    // Apply field-level fallbacks for several rows
    audit.apply('lead_time_days', null);
    audit.apply('lead_time_days', null);
    audit.apply('safety_stock', null);

    // Apply dataset-level fallbacks
    audit.addDatasetFallback('open_pos');
    audit.addDatasetFallback('financials');

    const trail = audit.getAudit();

    // Field fallbacks: 2 lead_time_days + 1 safety_stock = 3 total
    expect(trail.summary.totalFieldFallbacks).toBe(3);
    expect(trail.summary.fallbackFields).toContain('lead_time_days');
    expect(trail.summary.fallbackFields).toContain('safety_stock');

    // Field fallback aggregation: two entries (one per unique field)
    expect(trail.fieldFallbacks).toHaveLength(2);
    const ltFb = trail.fieldFallbacks.find(f => f.field === 'lead_time_days');
    expect(ltFb.count).toBe(2);

    // Dataset fallbacks
    expect(trail.summary.totalDatasetFallbacks).toBe(2);
    expect(trail.summary.degradedCapabilities).toContain('inbound_aware_plan');
    expect(trail.summary.degradedCapabilities).toContain('profit_at_risk');
  });

  it('getDegradationMessage returns the correct message for known datasets', () => {
    expect(getDegradationMessage('financials')).toBeTruthy();
    expect(getDegradationMessage('open_pos')).toBeTruthy();
    expect(getDegradationMessage('bom_edge')).toBeTruthy();
    expect(getDegradationMessage('nonexistent_dataset')).toBeNull();
  });

  it('does not apply fallback when value is already present', () => {
    const audit = createFallbackAudit();

    const result = audit.apply('lead_time_days', 14);

    expect(result.isFallback).toBe(false);
    expect(result.value).toBe(14);
    expect(result.source).toBe('mapped_field');

    const trail = audit.getAudit();
    expect(trail.summary.totalFieldFallbacks).toBe(0);
  });
});
