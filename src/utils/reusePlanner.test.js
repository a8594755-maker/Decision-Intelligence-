import { describe, it, expect } from 'vitest';
import { buildReusePlan } from './reusePlanner';

describe('reusePlanner', () => {
  it('auto-applies exact fingerprint template when coverage is complete', () => {
    const datasetProfile = {
      fingerprint: 'dsfp_exact',
      profile_json: {
        global: { workflow_guess: { label: 'A' } },
        sheets: [
          {
            sheet_name: 'Demand',
            original_headers: ['Material', 'Plant', 'Week', 'Demand Qty'],
            normalized_headers: ['material', 'plant', 'week', 'demand_qty'],
            grain_guess: { granularity: 'week', keys: ['material_code', 'plant_id'] }
          }
        ]
      },
      contract_json: { datasets: [] }
    };

    const contractTemplates = [
      {
        id: 11,
        user_id: 'user-1',
        workflow: 'workflow_A_replenishment',
        fingerprint: 'dsfp_exact',
        quality_score: 0.9,
        contract_json: {
          datasets: [
            {
              sheet_name: 'Demand',
              upload_type: 'demand_fg',
              mapping: {
                material_code: 'Material',
                plant_id: 'Plant',
                week_bucket: 'Week',
                demand_qty: 'Demand Qty'
              }
            }
          ]
        }
      }
    ];

    const settingsTemplates = [
      {
        id: 22,
        user_id: 'user-1',
        workflow: 'workflow_A_replenishment',
        fingerprint: 'dsfp_exact',
        quality_score: 0.8,
        settings_json: { forecast: { horizon_periods: 8 } }
      }
    ];

    const result = buildReusePlan({
      dataset_profile: datasetProfile,
      contract_templates: contractTemplates,
      settings_templates: settingsTemplates,
      similarity_index_rows: []
    });

    expect(result.mode).toBe('auto_apply');
    expect(result.contract_template_id).toBe(11);
    expect(result.settings_template_id).toBe(22);
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });
});
