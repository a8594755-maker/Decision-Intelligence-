import { describe, expect, it } from 'vitest';
import {
  buildExactMatchSourceToTargetMapping,
  mergeAuthoritativeMapping
} from './deterministicMapping';

describe('deterministicMapping', () => {
  it('builds deterministic exact-match mapping for clean demand headers', () => {
    const columns = [
      'material_code',
      'plant_id',
      'demand_qty',
      'week_bucket',
      'date',
      'source_type'
    ];

    const mapping = buildExactMatchSourceToTargetMapping({
      uploadType: 'demand_fg',
      columns
    });

    expect(mapping.material_code).toBe('material_code');
    expect(mapping.plant_id).toBe('plant_id');
    expect(mapping.demand_qty).toBe('demand_qty');
  });

  it('keeps exact-match targets authoritative when merged with fallback mapping', () => {
    const columns = ['material_code', 'plant_id', 'demand_qty', 'date'];
    const authoritative = {
      material_code: 'material_code',
      plant_id: 'plant_id',
      demand_qty: 'demand_qty'
    };
    const fallback = {
      date: 'date',
      material_code: 'plant_id'
    };

    const merged = mergeAuthoritativeMapping({
      authoritativeMapping: authoritative,
      fallbackMapping: fallback,
      uploadType: 'demand_fg',
      columns
    });

    expect(merged.material_code).toBe('material_code');
    expect(merged.plant_id).toBe('plant_id');
    expect(merged.demand_qty).toBe('demand_qty');
    expect(merged.date).toBe('date');
  });
});
