import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_CONTRACT_VERSION,
  validateArtifactOrThrow
} from './diArtifactContractV1';

const minimumValidCases = [
  {
    label: 'forecast_series',
    artifact_type: 'forecast_series',
    payload: {
      groups: [
        {
          material_code: 'SKU-1',
          plant_id: 'P1',
          points: [
            {
              time_bucket: '2026-01-01',
              forecast: 12
            }
          ]
        }
      ]
    }
  },
  {
    label: 'metrics',
    artifact_type: 'metrics',
    payload: {
      metric_name: 'mape',
      mape: 4.2,
      mae: 2.1,
      selected_model_global: 'naive_last',
      model_usage: { naive_last: 4 },
      groups_processed: 4,
      rows_used: 120,
      dropped_rows: 2,
      horizon_periods: 8,
      granularity: 'weekly'
    }
  },
  {
    label: 'report_json (forecast)',
    artifact_type: 'report_json',
    payload: {
      dataset_profile_id: 101,
      workflow: 'workflow_A_replenishment',
      stage: 'forecast',
      evidence: { groups_processed: 2 }
    }
  },
  {
    label: 'report_json (plan)',
    artifact_type: 'report_json',
    payload: {
      summary: 'Plan solved successfully.',
      key_results: ['Service level improved.'],
      exceptions: [],
      recommended_actions: ['Proceed to review.']
    }
  },
  {
    label: 'forecast_csv',
    artifact_type: 'forecast_csv',
    payload: 'material_code,plant_id,time_bucket,actual,forecast\nSKU-1,P1,2026-01-01,,12'
  },
  {
    label: 'solver_meta',
    artifact_type: 'solver_meta',
    payload: {
      status: 'optimal',
      kpis: { estimated_total_cost: 123.45 },
      solver_meta: { solver: 'heuristic' },
      infeasible_reasons: [],
      proof: {
        objective_terms: [],
        constraints_checked: []
      }
    }
  },
  {
    label: 'constraint_check',
    artifact_type: 'constraint_check',
    payload: {
      passed: true,
      violations: []
    }
  },
  {
    label: 'plan_table',
    artifact_type: 'plan_table',
    payload: {
      total_rows: 1,
      rows: [
        {
          sku: 'SKU-1',
          plant_id: 'P1',
          order_date: '2026-01-01',
          arrival_date: '2026-01-03',
          order_qty: 120
        }
      ],
      truncated: false
    }
  },
  {
    label: 'replay_metrics',
    artifact_type: 'replay_metrics',
    payload: {
      with_plan: {
        service_level_proxy: 0.97,
        stockout_units: 8,
        holding_units: 22
      },
      without_plan: {
        service_level_proxy: 0.9,
        stockout_units: 19,
        holding_units: 35
      },
      delta: {
        service_level_proxy: 0.07,
        stockout_units: -11,
        holding_units: -13
      }
    }
  },
  {
    label: 'inventory_projection',
    artifact_type: 'inventory_projection',
    payload: {
      total_rows: 1,
      rows: [
        {
          sku: 'SKU-1',
          plant_id: 'P1',
          date: '2026-01-01',
          with_plan: 50,
          without_plan: 35,
          demand: 10,
          stockout_units: 0,
          inbound_plan: 12,
          inbound_open_pos: 3
        }
      ],
      truncated: false
    }
  },
  {
    label: 'evidence_pack',
    artifact_type: 'evidence_pack',
    payload: {
      generated_at: '2026-01-01T00:00:00.000Z',
      run_id: 77,
      dataset_profile_id: 88,
      solver_status: 'optimal',
      refs: {},
      evidence: {}
    }
  },
  {
    label: 'plan_csv',
    artifact_type: 'plan_csv',
    payload: 'sku,plant_id,order_date,arrival_date,order_qty\nSKU-1,P1,2026-01-01,2026-01-03,120'
  }
];

describe('diArtifactContractV1', () => {
  it('exports contract version v1', () => {
    expect(ARTIFACT_CONTRACT_VERSION).toBe('v1');
  });

  it.each(minimumValidCases)('accepts minimum valid payload: $label', ({ artifact_type, payload }) => {
    expect(validateArtifactOrThrow({ artifact_type, payload })).toEqual(payload);
  });

  it('allows unknown artifact types as pass-through', () => {
    const payload = { anything: true };
    expect(validateArtifactOrThrow({ artifact_type: 'unknown_new_type', payload })).toBe(payload);
  });

  it('throws actionable error for missing required fields', () => {
    const badPayload = {
      total_rows: 1,
      rows: [
        {
          plant_id: 'P1',
          order_date: '2026-01-01',
          arrival_date: '2026-01-03',
          order_qty: 1
        }
      ],
      truncated: false
    };

    expect(() => validateArtifactOrThrow({ artifact_type: 'plan_table', payload: badPayload })).toThrowError(/artifact_type="plan_table"/i);
    expect(() => validateArtifactOrThrow({ artifact_type: 'plan_table', payload: badPayload })).toThrowError(/payload\.rows\[0\]\.sku/i);
  });

  it('throws type error when required fields have wrong type', () => {
    const badPayload = {
      total_rows: 1,
      rows: 'not-an-array',
      truncated: false
    };

    expect(() => validateArtifactOrThrow({ artifact_type: 'plan_table', payload: badPayload })).toThrowError(/artifact_type="plan_table"/i);
    expect(() => validateArtifactOrThrow({ artifact_type: 'plan_table', payload: badPayload })).toThrowError(/payload\.rows/i);
    expect(() => validateArtifactOrThrow({ artifact_type: 'plan_table', payload: badPayload })).toThrowError(/expected array/i);
  });

  it('enforces plan report fields when report_json is used for planning output', () => {
    const badPlanReport = {
      summary: 'missing required arrays'
    };

    expect(() => validateArtifactOrThrow({ artifact_type: 'report_json', payload: badPlanReport })).toThrowError(/report_json/i);
    expect(() => validateArtifactOrThrow({ artifact_type: 'report_json', payload: badPlanReport })).toThrowError(/payload\.key_results/i);
  });
});
