import { describe, it, expect } from 'vitest';
import {
  createDecisionTask,
  updateDecisionTask,
  buildDecisionBundle,
  buildPlanDecisionBundle,
  buildScenarioDecisionBundle,
  TASK_TYPES,
  TASK_STATUS,
} from './decisionTaskService';

describe('createDecisionTask', () => {
  it('creates a task with generated ID', () => {
    const task = createDecisionTask({
      type: TASK_TYPES.RUN_PLAN,
      label: 'Generate Plan',
    });
    expect(task.task_id).toMatch(/^task_/);
    expect(task.type).toBe('run_plan');
    expect(task.label).toBe('Generate Plan');
    expect(task.status).toBe('pending');
    expect(task.linked_run_ids).toEqual([]);
    expect(task.output_artifacts).toEqual([]);
  });

  it('accepts custom inputs and dependencies', () => {
    const task = createDecisionTask({
      type: TASK_TYPES.RUN_SCENARIO,
      label: 'Test',
      inputs: { budget_cap: 50000 },
      dependencies: ['task_1'],
    });
    expect(task.inputs).toEqual({ budget_cap: 50000 });
    expect(task.dependencies).toEqual(['task_1']);
  });
});

describe('updateDecisionTask', () => {
  it('patches status and preserves immutability', () => {
    const task = createDecisionTask({ type: TASK_TYPES.RUN_PLAN, label: 'Test' });
    const updated = updateDecisionTask(task, { status: TASK_STATUS.COMPLETED, linked_run_ids: [42] });
    expect(updated.status).toBe('completed');
    expect(updated.linked_run_ids).toEqual([42]);
    expect(updated.updated_at).toBeTruthy();
    // Original task unchanged (immutable update)
    expect(task.status).toBe('pending');
    expect(task.linked_run_ids).toEqual([]);
  });
});

describe('buildDecisionBundle', () => {
  it('builds a complete bundle', () => {
    const bundle = buildDecisionBundle({
      summary: 'Plan looks good.',
      recommendation: { text: 'Submit for approval.', action_type: 'request_approval', confidence: 0.8 },
      drivers: [{ label: 'Service Level', value: '95%', direction: 'positive' }],
      kpi_impact: { service_level_delta: 0.03 },
      evidence_refs: [{ artifact_type: 'solver_meta', run_id: 1, label: 'Solver' }],
      next_actions: [{ action_id: 'request_approval', label: 'Submit', priority: 1 }],
    });
    expect(bundle.version).toBe('v1');
    expect(bundle.summary).toBe('Plan looks good.');
    expect(bundle.recommendation.action_type).toBe('request_approval');
    expect(bundle.drivers).toHaveLength(1);
    expect(bundle.evidence_refs).toHaveLength(1);
    expect(bundle.next_actions).toHaveLength(1);
    expect(bundle.generated_at).toBeTruthy();
  });

  it('defaults to empty arrays', () => {
    const bundle = buildDecisionBundle({ summary: 'Test' });
    expect(bundle.drivers).toEqual([]);
    expect(bundle.evidence_refs).toEqual([]);
    expect(bundle.blockers).toEqual([]);
    expect(bundle.next_actions).toEqual([]);
    expect(bundle.recommendation).toBeNull();
  });
});

describe('buildPlanDecisionBundle', () => {
  it('builds bundle for optimal plan', () => {
    const bundle = buildPlanDecisionBundle({
      solverResult: {
        status: 'optimal',
        kpis: { estimated_total_cost: 50000, estimated_service_level: 0.96 },
        proof: { constraints_checked: [], objective_terms: [] },
      },
      sessionCtx: { previous_plan: { kpis: { estimated_total_cost: 55000, estimated_service_level: 0.92 } } },
      evidence: [{ artifact_type: 'solver_meta', run_id: 1, label: 'Solver' }],
      nextActions: [{ action_id: 'run_what_if', label: 'What-If' }],
    });
    expect(bundle.summary).toContain('96.0%');
    expect(bundle.summary).toContain('$50,000');
    expect(bundle.recommendation.action_type).toBe('run_what_if');
    expect(bundle.drivers.length).toBeGreaterThan(0);
    expect(bundle.kpi_impact.service_level_delta).toBeCloseTo(0.04);
    expect(bundle.kpi_impact.cost_delta).toBe(-5000);
    expect(bundle.blockers).toHaveLength(0);
  });

  it('builds bundle for infeasible plan with blockers', () => {
    const bundle = buildPlanDecisionBundle({
      solverResult: {
        status: 'infeasible',
        kpis: {},
        infeasible_reasons: ['Budget too low', 'Service target too high'],
      },
      sessionCtx: {},
      evidence: [],
      nextActions: [],
    });
    expect(bundle.summary).toContain('infeasible');
    expect(bundle.recommendation.action_type).toBe('start_negotiation');
    expect(bundle.blockers).toHaveLength(1);
    expect(bundle.blockers[0].blocker_id).toBe('infeasible_plan');
  });
});

describe('buildScenarioDecisionBundle', () => {
  it('builds bundle from scenario comparison', () => {
    const bundle = buildScenarioDecisionBundle({
      comparison: {
        overrides: { service_target: 0.98 },
        kpis: {
          base: { service_level_proxy: 0.92 },
          scenario: { service_level_proxy: 0.98 },
          delta: { service_level_proxy: 0.06, stockout_units: -50, estimated_total_cost: 5000 },
        },
      },
      evidence: [{ artifact_type: 'scenario_comparison', run_id: 1, label: 'Compare' }],
      nextActions: [],
    });
    expect(bundle.summary).toContain('service_target=0.98');
    expect(bundle.drivers.length).toBeGreaterThan(0);
    expect(bundle.drivers[0].direction).toBe('positive'); // SL improving
    expect(bundle.kpi_impact.service_level_proxy).toBeCloseTo(0.06);
  });
});
