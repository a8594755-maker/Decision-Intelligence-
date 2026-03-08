/**
 * Regression: Artifact Contract Validation
 *
 * Validates all registered artifact types against their schema.
 * Ensures that valid payloads pass and invalid payloads fail
 * with descriptive error messages.
 */
import { describe, it, expect } from 'vitest';

import { validateArtifactOrThrow, ARTIFACT_CONTRACT_VERSION } from '../../contracts/diArtifactContractV1';
import { buildDataQualityReport } from '../../utils/dataQualityReport';

// ── Valid payload fixtures ─────────────────────────────────────────────────

const VALID_PAYLOADS = {
  forecast_series: {
    groups: [
      {
        material_code: 'SKU-001',
        plant_id: 'P1',
        points: [
          { time_bucket: '2025-W01', forecast: 100 },
          { time_bucket: '2025-W02', forecast: 120 },
        ],
      },
    ],
  },

  metrics: {
    metric_name: 'mape',
    mape: 12.5,
    mae: 8.3,
    selected_model_global: 'moving_average',
    model_usage: { moving_average: 10, exponential_smoothing: 5 },
    groups_processed: 15,
    rows_used: 100,
    dropped_rows: 2,
    horizon_periods: 12,
    granularity: 'weekly',
  },

  solver_meta: {
    status: 'feasible',
    kpis: { estimated_service_level: 0.95, estimated_total_cost: 5000 },
    solver_meta: { solver: 'heuristic', solve_time_ms: 42, objective_value: 5000, gap: 0 },
    infeasible_reasons: [],
    proof: { objective_terms: [{ name: 'cost', value: 5000 }], constraints_checked: [] },
  },

  plan_table: {
    total_rows: 2,
    rows: [
      { sku: 'SKU-001', plant_id: 'P1', order_date: '2025-01-05', arrival_date: '2025-01-12', order_qty: 100 },
      { sku: 'SKU-002', plant_id: null, order_date: '2025-01-05', arrival_date: '2025-01-14', order_qty: 50 },
    ],
    truncated: false,
  },

  constraint_check: {
    passed: true,
    violations: [],
  },

  replay_metrics: {
    with_plan: { service_level_proxy: 0.95, stockout_units: 5, holding_units: 100 },
    without_plan: { service_level_proxy: 0.80, stockout_units: 50, holding_units: 20 },
    delta: { service_level_proxy: 0.15, stockout_units: -45, holding_units: 80 },
  },

  inventory_projection: {
    total_rows: 1,
    rows: [
      { sku: 'SKU-001', plant_id: 'P1', date: '2025-01-05', with_plan: 200, without_plan: 100, demand: 80, stockout_units: 0 },
    ],
    truncated: false,
  },

  evidence_pack: {
    generated_at: '2025-01-01T00:00:00Z',
    run_id: 'run-1',
    dataset_profile_id: 'dp-1',
    solver_status: 'feasible',
    refs: {},
    evidence: {},
  },

  scenario_comparison: {
    base_run_id: 1,
    scenario_run_id: 2,
    overrides: { demand_multiplier: 1.2 },
    kpis: {
      base: { service_level: 0.95 },
      scenario: { service_level: 0.88 },
      delta: { service_level: -0.07 },
    },
    top_changes: [],
    notes: [],
  },

  data_quality_report: {
    coverage_level: 'partial',
    available_datasets: ['demand_fg', 'inventory_snapshots'],
    missing_datasets: ['po_open_lines'],
    fallbacks_used: [],
    dataset_fallbacks: [],
  },

  decision_narrative: {
    version: '1',
    generated_at: '2025-01-01T00:00:00Z',
    solver_status: 'feasible',
    summary_text: 'Plan completed successfully.',
    situation: { text: 'Current state', evidence_refs: [] },
    driver: { text: 'Main driver', category: 'shortage', evidence_refs: [] },
    recommendation: { text: 'Take action', action_type: 'expedite', evidence_refs: [] },
    constraint_binding_summary: [],
    all_evidence_refs: [],
  },

  bottlenecks: {
    generated_at: '2025-01-01T00:00:00Z',
    total_rows: 1,
    rows: [
      {
        component_sku: 'COMP-001',
        plant_id: 'P1',
        missing_qty: 50,
        periods_impacted: ['2025-W03'],
        affected_fg_skus: ['SKU-001'],
        evidence_refs: [],
      },
    ],
  },
};

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Artifact Contract Regression', () => {
  it('contract version is v1', () => {
    expect(ARTIFACT_CONTRACT_VERSION).toBe('v1');
  });

  describe('valid payloads pass validation', () => {
    for (const [type, payload] of Object.entries(VALID_PAYLOADS)) {
      it(`${type} passes validation`, () => {
        expect(() => {
          validateArtifactOrThrow({ artifact_type: type, payload });
        }).not.toThrow();
      });
    }
  });

  describe('invalid payloads fail with descriptive errors', () => {
    it('plan_table with missing rows throws', () => {
      expect(() => {
        validateArtifactOrThrow({
          artifact_type: 'plan_table',
          payload: { total_rows: 1, truncated: false },
        });
      }).toThrow(/missing required field/i);
    });

    it('solver_meta with missing status throws', () => {
      expect(() => {
        validateArtifactOrThrow({
          artifact_type: 'solver_meta',
          payload: { kpis: {}, solver_meta: {}, infeasible_reasons: [], proof: { objective_terms: [], constraints_checked: [] } },
        });
      }).toThrow(/missing required field/i);
    });

    it('forecast_series with non-array groups throws', () => {
      expect(() => {
        validateArtifactOrThrow({
          artifact_type: 'forecast_series',
          payload: { groups: 'not-an-array' },
        });
      }).toThrow(/expected array/i);
    });

    it('data_quality_report with missing coverage_level throws', () => {
      expect(() => {
        validateArtifactOrThrow({
          artifact_type: 'data_quality_report',
          payload: { available_datasets: [], missing_datasets: [], fallbacks_used: [], dataset_fallbacks: [] },
        });
      }).toThrow(/missing required field/i);
    });

    it('constraint_check with non-boolean passed throws', () => {
      expect(() => {
        validateArtifactOrThrow({
          artifact_type: 'constraint_check',
          payload: { passed: 'yes', violations: [] },
        });
      }).toThrow(/expected boolean/i);
    });
  });

  describe('unknown artifact types pass through', () => {
    it('unknown type does not throw', () => {
      const payload = { foo: 'bar' };
      const result = validateArtifactOrThrow({ artifact_type: 'unknown_future_type', payload });
      expect(result).toBe(payload);
    });
  });

  describe('error shape', () => {
    it('validation error has correct properties', () => {
      try {
        validateArtifactOrThrow({
          artifact_type: 'plan_table',
          payload: {},
        });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.name).toBe('ArtifactContractValidationError');
        expect(err.artifact_type).toBe('plan_table');
        expect(err.contract_version).toBe('v1');
        expect(Array.isArray(err.issues)).toBe(true);
        expect(err.issues.length).toBeGreaterThan(0);
      }
    });
  });

  describe('buildDataQualityReport contract compliance', () => {
    it('minimal report passes contract', () => {
      const report = buildDataQualityReport({
        availableDatasets: [],
        missingDatasets: ['demand_fg'],
      });
      expect(() => {
        validateArtifactOrThrow({ artifact_type: 'data_quality_report', payload: report });
      }).not.toThrow();
    });

    it('full report with capabilities passes contract', () => {
      const report = buildDataQualityReport({
        availableDatasets: ['demand_fg', 'inventory_snapshots'],
        missingDatasets: ['po_open_lines'],
        capabilities: {
          basic_plan: { available: true, level: 'partial' },
          profit_at_risk: { available: false, level: 'unavailable' },
        },
        rowStats: { total: 100, clean: 80, with_fallback: 20, dropped: 0 },
      });
      expect(() => {
        validateArtifactOrThrow({ artifact_type: 'data_quality_report', payload: report });
      }).not.toThrow();
    });
  });
});
