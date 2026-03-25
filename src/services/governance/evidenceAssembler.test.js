import { describe, it, expect } from 'vitest';
import {
  createEvidenceRef,
  assemblePlanEvidence,
  assembleForecastEvidence,
  assembleScenarioEvidence,
  assembleNegotiationEvidence,
  assembleRiskEvidence,
  mergeEvidenceRefs,
  buildEvidenceSummaryText,
} from './evidenceAssembler';

describe('createEvidenceRef', () => {
  it('creates a ref with all fields', () => {
    const ref = createEvidenceRef({
      artifact_type: 'solver_meta',
      run_id: 42,
      label: 'Test',
      summary: 'A test ref',
      path: 'proof.constraints',
    });
    expect(ref.artifact_type).toBe('solver_meta');
    expect(ref.run_id).toBe(42);
    expect(ref.label).toBe('Test');
    expect(ref.summary).toBe('A test ref');
    expect(ref.path).toBe('proof.constraints');
  });

  it('defaults missing fields', () => {
    const ref = createEvidenceRef({ artifact_type: 'plan_table' });
    expect(ref.run_id).toBeNull();
    expect(ref.label).toBe('plan_table');
    expect(ref.summary).toBe('');
    expect(ref.path).toBeNull();
  });
});

describe('assemblePlanEvidence', () => {
  it('assembles refs from solver result', () => {
    const refs = assemblePlanEvidence({
      runId: 100,
      solverResult: {
        status: 'optimal',
        kpis: { estimated_total_cost: 50000 },
        proof: { constraints_checked: ['a', 'b'], objective_terms: ['c'] },
      },
      replayMetrics: { delta: { service_level_proxy: 0.03, stockout_units: -10 } },
      constraintCheck: { passed: true, violations: [] },
      hasTopology: true,
      isRiskAware: true,
    });

    expect(refs.length).toBeGreaterThanOrEqual(6);
    expect(refs.some(r => r.artifact_type === 'solver_meta')).toBe(true);
    expect(refs.some(r => r.artifact_type === 'plan_table')).toBe(true);
    expect(refs.some(r => r.artifact_type === 'inventory_projection')).toBe(true);
    expect(refs.some(r => r.artifact_type === 'replay_metrics')).toBe(true);
    expect(refs.some(r => r.artifact_type === 'constraint_check')).toBe(true);
    expect(refs.some(r => r.artifact_type === 'topology_graph')).toBe(true);
    expect(refs.some(r => r.artifact_type === 'risk_adjustments')).toBe(true);
  });

  it('handles minimal inputs', () => {
    const refs = assemblePlanEvidence({ runId: 1, solverResult: null });
    expect(refs.some(r => r.artifact_type === 'plan_table')).toBe(true);
    expect(refs.some(r => r.artifact_type === 'inventory_projection')).toBe(true);
  });
});

describe('assembleForecastEvidence', () => {
  it('creates forecast refs', () => {
    const refs = assembleForecastEvidence({
      runId: 50,
      metrics: { mape: 12.5, groups_processed: 10, horizon_periods: 6, selected_model_global: 'ets' },
    });
    expect(refs).toHaveLength(2);
    expect(refs[0].artifact_type).toBe('forecast_series');
    expect(refs[1].artifact_type).toBe('metrics');
    expect(refs[1].summary).toContain('12.50%');
  });
});

describe('assembleScenarioEvidence', () => {
  it('creates scenario comparison refs', () => {
    const refs = assembleScenarioEvidence({
      comparison: {
        base_run_id: 100,
        scenario_run_id: 101,
        overrides: { budget_cap: 50000 },
      },
    });
    expect(refs).toHaveLength(3);
    expect(refs[0].artifact_type).toBe('scenario_comparison');
    expect(refs[1].label).toBe('Base Plan');
    expect(refs[2].label).toBe('Scenario Plan');
  });

  it('returns empty for null comparison', () => {
    expect(assembleScenarioEvidence({ comparison: null })).toEqual([]);
  });
});

describe('assembleNegotiationEvidence', () => {
  it('assembles from evaluation and report', () => {
    const refs = assembleNegotiationEvidence({
      evaluation: { base_run_id: 100, ranked_options: [{}, {}], ranking_method: 'composite' },
      report: { base_run_id: 100, summary: 'Test summary', evidence_refs: [{ label: 'inner', artifact_type: 'plan_table' }] },
    });
    expect(refs.length).toBeGreaterThanOrEqual(3);
    expect(refs.some(r => r.artifact_type === 'negotiation_evaluation')).toBe(true);
    expect(refs.some(r => r.artifact_type === 'negotiation_report')).toBe(true);
    expect(refs.some(r => r.label === 'inner')).toBe(true);
  });
});

describe('assembleRiskEvidence', () => {
  it('assembles risk delta refs', () => {
    const refs = assembleRiskEvidence({
      riskDelta: { total_deltas: 5 },
      proactiveAlerts: { alerts: [{ severity: 'critical' }, { severity: 'warning' }] },
      runId: 200,
    });
    expect(refs).toHaveLength(2);
    expect(refs[0].summary).toContain('5 risk score changes');
    expect(refs[1].summary).toContain('2 alert(s), 1 critical');
  });
});

describe('mergeEvidenceRefs', () => {
  it('deduplicates by artifact_type + run_id + path', () => {
    const a = [
      createEvidenceRef({ artifact_type: 'solver_meta', run_id: 1, label: 'A' }),
      createEvidenceRef({ artifact_type: 'plan_table', run_id: 1, label: 'B' }),
    ];
    const b = [
      createEvidenceRef({ artifact_type: 'solver_meta', run_id: 1, label: 'A-dup' }),
      createEvidenceRef({ artifact_type: 'solver_meta', run_id: 2, label: 'C' }),
    ];
    const merged = mergeEvidenceRefs(a, b);
    expect(merged).toHaveLength(3);
    expect(merged[0].label).toBe('A'); // keeps first
  });

  it('handles empty/null arrays', () => {
    expect(mergeEvidenceRefs([], null, undefined)).toEqual([]);
  });
});

describe('buildEvidenceSummaryText', () => {
  it('returns fallback for empty refs', () => {
    expect(buildEvidenceSummaryText([])).toBe('No supporting evidence available.');
    expect(buildEvidenceSummaryText(null)).toBe('No supporting evidence available.');
  });

  it('groups refs by category', () => {
    const refs = [
      createEvidenceRef({ artifact_type: 'solver_meta', label: 'Solver' }),
      createEvidenceRef({ artifact_type: 'plan_table', label: 'Plan' }),
      createEvidenceRef({ artifact_type: 'forecast_series', label: 'Forecast' }),
    ];
    const text = buildEvidenceSummaryText(refs);
    expect(text).toContain('Planning');
    expect(text).toContain('Forecast');
  });
});
