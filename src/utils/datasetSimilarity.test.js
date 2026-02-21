import { describe, it, expect } from 'vitest';
import { buildSignature, similarity } from './datasetSimilarity';

describe('datasetSimilarity', () => {
  it('builds stable signatures from profile + contract', () => {
    const profile = {
      global: { workflow_guess: { label: 'A' } },
      sheets: [
        {
          sheet_name: 'Demand',
          original_headers: ['Material', 'Plant', 'Week', 'Demand Qty'],
          grain_guess: { granularity: 'week', keys: ['material_code', 'plant_id'] }
        }
      ]
    };
    const contract = {
      datasets: [{ sheet_name: 'Demand', upload_type: 'demand_fg' }]
    };

    const signatureA = buildSignature(profile, contract);
    const signatureB = buildSignature(profile, contract);

    expect(signatureA).toEqual(signatureB);
    expect(signatureA.upload_types).toEqual(['demand_fg']);
  });

  it('returns high similarity for close signatures', () => {
    const sigA = {
      workflow_label: 'a',
      sheet_count: 1,
      canonical_headers: ['material', 'plant', 'week', 'demand_qty'],
      upload_types: ['demand_fg'],
      granularities: ['week'],
      key_fields: ['material_code', 'plant_id'],
      dominant_granularity: 'week'
    };
    const sigB = {
      workflow_label: 'a',
      sheet_count: 1,
      canonical_headers: ['material', 'plant', 'week', 'demand_qty', 'note'],
      upload_types: ['demand_fg'],
      granularities: ['week'],
      key_fields: ['material_code'],
      dominant_granularity: 'week'
    };

    const result = similarity(sigA, sigB);
    expect(result.score).toBeGreaterThan(0.75);
    expect(Array.isArray(result.reasons)).toBe(true);
  });
});
