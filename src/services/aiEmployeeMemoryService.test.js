// @product: ai-employee
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  extractOutcomeKpis,
  extractInputParams,
  summarizeMemories,
} from './aiEmployeeMemoryService';

// ── extractOutcomeKpis ──────────────────────────────────────────────────────

describe('extractOutcomeKpis', () => {
  it('returns empty object for null result', () => {
    expect(extractOutcomeKpis('forecast', null)).toEqual({});
  });

  it('extracts forecast KPIs', () => {
    const result = {
      metrics: { mape: 12.3, mae: 5.6, p90_coverage: 0.91, groups_processed: 4, selected_model_global: 'ets' },
    };
    const kpis = extractOutcomeKpis('forecast', result);
    expect(kpis.mape).toBe(12.3);
    expect(kpis.mae).toBe(5.6);
    expect(kpis.p90_coverage).toBe(0.91);
    expect(kpis.selected_model).toBe('ets');
  });

  it('handles forecast with no metrics', () => {
    expect(extractOutcomeKpis('forecast', {})).toEqual({});
  });

  it('extracts plan KPIs', () => {
    const result = {
      solver_result: {
        status: 'optimal',
        kpis: { estimated_service_level: 0.95, estimated_total_cost: 10000, estimated_stockout_units: 5 },
        solver_meta: { num_variables: 42, solve_time_seconds: 1.2 },
      },
    };
    const kpis = extractOutcomeKpis('plan', result);
    expect(kpis.service_level).toBe(0.95);
    expect(kpis.total_cost).toBe(10000);
    expect(kpis.items_planned).toBe(42);
    expect(kpis.solver_status).toBe('optimal');
    expect(kpis.solve_time_s).toBe(1.2);
  });

  it('extracts risk KPIs', () => {
    const result = {
      risk_scores: [
        { risk_score: 0.9 },
        { risk_score: 0.75 },
        { risk_score: 0.3 },
        { risk_score: 0.5 },
      ],
    };
    const kpis = extractOutcomeKpis('risk', result);
    expect(kpis.total_assessed).toBe(4);
    expect(kpis.high_risk_count).toBe(2);
    expect(kpis.medium_risk_count).toBe(1);
    expect(kpis.avg_risk_score).toBeCloseTo(0.61, 1);
  });

  it('extracts synthesize KPIs', () => {
    const result = {
      synthesis: { sources: ['forecast', 'plan'], total_artifacts: 5 },
    };
    const kpis = extractOutcomeKpis('synthesize', result);
    expect(kpis.sources).toBe(2);
    expect(kpis.total_artifacts).toBe(5);
  });

  it('returns empty for unknown workflow type', () => {
    expect(extractOutcomeKpis('unknown', { data: 1 })).toEqual({});
  });
});

// ── extractInputParams ──────────────────────────────────────────────────────

describe('extractInputParams', () => {
  it('returns empty object for null', () => {
    expect(extractInputParams(null)).toEqual({});
  });

  it('extracts relevant params only', () => {
    const ctx = {
      riskMode: 'on',
      horizonPeriods: 12,
      scenario_overrides: { lead_time: 5 },
      template_id: 'full_report',
      settings: { plan: { risk_mode: 'on' } },
      // These should NOT be in output:
      workflow_type: 'plan',
      dataset_profile_id: 'abc',
      _prior_step_artifacts: { forecast: ['ref1'] },
    };
    const params = extractInputParams(ctx);
    expect(params.riskMode).toBe('on');
    expect(params.horizonPeriods).toBe(12);
    expect(params.has_scenario_overrides).toBe(true);
    expect(params.template_id).toBe('full_report');
    expect(params.plan_risk_mode).toBe('on');
    // Internal fields stripped
    expect(params.workflow_type).toBeUndefined();
    expect(params.dataset_profile_id).toBeUndefined();
    expect(params._prior_step_artifacts).toBeUndefined();
  });

  it('omits falsy params', () => {
    const params = extractInputParams({ workflow_type: 'forecast' });
    expect(Object.keys(params)).toHaveLength(0);
  });
});

// ── summarizeMemories ───────────────────────────────────────────────────────

describe('summarizeMemories', () => {
  it('returns no prior experience for empty array', () => {
    expect(summarizeMemories([])).toEqual({ has_prior_experience: false });
    expect(summarizeMemories(null)).toEqual({ has_prior_experience: false });
  });

  it('computes success rate', () => {
    const memories = [
      { success: true, execution_time_ms: 2000, outcome_kpis: { mape: 10 } },
      { success: true, execution_time_ms: 3000 },
      { success: false, error_message: 'Dataset profile not found: xyz' },
    ];
    const summary = summarizeMemories(memories);
    expect(summary.has_prior_experience).toBe(true);
    expect(summary.total_prior_runs).toBe(3);
    expect(summary.success_rate).toBe(67);
  });

  it('computes approval rate from reviewed memories', () => {
    const memories = [
      { success: true, manager_decision: 'approved' },
      { success: true, manager_decision: 'approved' },
      { success: true, manager_decision: 'needs_revision', manager_feedback: 'Too aggressive' },
    ];
    const summary = summarizeMemories(memories);
    expect(summary.approval_rate).toBe(67);
    expect(summary.recent_feedback).toEqual(['Too aggressive']);
  });

  it('computes avg execution time from successes only', () => {
    const memories = [
      { success: true, execution_time_ms: 1000 },
      { success: true, execution_time_ms: 3000 },
      { success: false, execution_time_ms: 5000, error_message: 'fail' },
    ];
    const summary = summarizeMemories(memories);
    expect(summary.avg_execution_time_ms).toBe(2000);
  });

  it('recommends risk mode based on majority', () => {
    const memories = [
      { success: true, input_params: { riskMode: 'on' } },
      { success: true, input_params: { riskMode: 'on' } },
      { success: true, input_params: { riskMode: 'off' } },
    ];
    const summary = summarizeMemories(memories);
    expect(summary.recommended_risk_mode).toBe('on');
  });

  it('extracts common error patterns', () => {
    const memories = [
      { success: false, error_message: 'Network timeout on request' },
      { success: false, error_message: 'Network timeout on request' },
      { success: false, error_message: 'Dataset profile not found' },
    ];
    const summary = summarizeMemories(memories);
    expect(summary.common_error_patterns.length).toBeGreaterThan(0);
    expect(summary.common_error_patterns[0].count).toBe(2);
    expect(summary.common_error_patterns[0].pattern).toContain('Network timeout');
  });

  it('returns last_successful_kpis from most recent success', () => {
    const memories = [
      { success: true, outcome_kpis: { mape: 8.5 } },
      { success: true, outcome_kpis: { mape: 12.0 } },
    ];
    const summary = summarizeMemories(memories);
    expect(summary.last_successful_kpis).toEqual({ mape: 8.5 });
  });
});
