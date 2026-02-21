import { describe, expect, it } from 'vitest';
import { getRequiredMappingStatus } from './requiredMappingStatus';

describe('requiredMappingStatus', () => {
  it('returns full coverage when all required fields are mapped to existing columns', () => {
    const columns = ['material_code', 'plant_id', 'demand_qty', 'week_bucket'];
    const mapping = {
      material_code: 'material_code',
      plant_id: 'plant_id',
      demand_qty: 'demand_qty',
      week_bucket: 'week_bucket'
    };

    const status = getRequiredMappingStatus({
      uploadType: 'demand_fg',
      columns,
      columnMapping: mapping
    });

    expect(status.coverage).toBe(1);
    expect(status.isComplete).toBe(true);
    expect(status.missingRequired).toEqual([]);
  });

  it('returns zero coverage when mapping is empty', () => {
    const status = getRequiredMappingStatus({
      uploadType: 'demand_fg',
      columns: ['material_code', 'plant_id', 'demand_qty'],
      columnMapping: {}
    });

    expect(status.coverage).toBe(0);
    expect(status.isComplete).toBe(false);
    expect(status.missingRequired).toEqual(['material_code', 'plant_id', 'demand_qty']);
  });

  it('normalizes target->source mappings and validates source-column namespace', () => {
    const status = getRequiredMappingStatus({
      uploadType: 'inventory_snapshots',
      columns: ['Material Code', 'Plant ID', 'Snapshot Date', 'Onhand Qty'],
      columnMapping: {
        material_code: 'material code',
        plant_id: 'plant id',
        snapshot_date: 'snapshot date',
        onhand_qty: 'onhand qty'
      }
    });

    expect(status.coverage).toBe(1);
    expect(status.isComplete).toBe(true);
    expect(status.missingRequired).toEqual([]);
  });
});
