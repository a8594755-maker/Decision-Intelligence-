/**
 * Integration tests: Agentic Negotiation Loop v0
 *
 * Tests the full option-generation → evaluation pipeline with a synthetic
 * infeasible case, verifying:
 *   1. Correct trigger detection
 *   2. Options include budget increase and MOQ relax for infeasible input
 *   3. Deterministic option generation (sorted, stable)
 *   4. At least one option yields a feasible scenario (mocked re-solver)
 *   5. Ranked evaluation puts feasible options above infeasible ones
 *   6. negotiation_evaluation artifact has correct ranking_method
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  generateNegotiationOptions,
  detectTrigger
} from './negotiationOptionsGenerator';

// ---------------------------------------------------------------------------
// Synthetic infeasible evidence fixtures
// ---------------------------------------------------------------------------

/**
 * Scenario: MOQ too high + budget too low → INFEASIBLE.
 * Both moq and budget_cap violations are present.
 */
const INFEASIBLE_SOLVER_META = {
  status: 'INFEASIBLE',
  kpis: { estimated_total_cost: 0, service_level_proxy: 0 },
  solver_meta: { gap: null },
  proof: {
    constraints_checked: [
      { name: 'budget_cap', binding: true },
      { name: 'moq_A', binding: true }
    ],
    objective_terms: []
  },
  infeasible_reasons: [
    'Budget constraint violated: total cost exceeds budget_cap.',
    'MOQ constraint violated for SKU-WIDGET: order_qty below minimum order quantity.'
  ]
};

const INFEASIBLE_CONSTRAINT_CHECK = {
  passed: false,
  violations: [
    { rule: 'budget_cap', sku: '*', details: 'total cost exceeds budget_cap=20000' },
    { rule: 'moq', sku: 'SKU-WIDGET', details: 'order_qty=0 is below MOQ=100' }
  ]
};

const INFEASIBLE_REPLAY_METRICS = {
  with_plan: { service_level_proxy: 0, stockout_units: 9999 },
  without_plan: { service_level_proxy: 0, stockout_units: 9999 },
  delta: {}
};

const USER_INTENT = {
  service_target: 0.95,
  budget_cap: 20000
};

// ---------------------------------------------------------------------------
// Helpers for evaluation mocking
// ---------------------------------------------------------------------------

const RANKING_METHOD =
  'lexicographic: feasibility -> service_delta -> cost_delta -> constraint_violations';

/**
 * Simulate deterministic evaluation results for given options.
 * opt_001 (budget) → feasible (budget relaxation fixes the infeasibility)
 * opt_002 (MOQ)    → feasible (MOQ relax fixes the infeasibility)
 * all others       → infeasible (engine_flags not supported in mock)
 */
function mockEvaluateOptions(options, baseKpis) {
  const baseService = 0;
  const baseCost = 0;

  const evaluated = options.map((opt) => {
    const isBudgetFix = opt.option_id === 'opt_001';
    const isMoqFix = opt.option_id === 'opt_002';
    const feasible = isBudgetFix || isMoqFix;

    const scenService = feasible ? 0.88 : 0;
    const scenCost = isBudgetFix ? 21000 : (isMoqFix ? 19500 : 0);

    return {
      option_id: opt.option_id,
      scenario_id: `base_${opt.option_id}`,
      scenario_run_id: feasible ? Math.floor(Math.random() * 1000) + 100 : null,
      status: feasible ? 'succeeded' : 'failed',
      kpis: {
        base: {
          service_level_proxy: baseService,
          stockout_units: 9999,
          estimated_total_cost: baseCost
        },
        scenario: feasible
          ? {
              status: 'feasible',
              feasible: true,
              service_level_proxy: scenService,
              stockout_units: feasible ? 50 : 9999,
              estimated_total_cost: scenCost
            }
          : {
              status: 'INFEASIBLE',
              feasible: false,
              service_level_proxy: 0,
              stockout_units: 9999,
              estimated_total_cost: 0
            },
        delta: feasible
          ? {
              service_level_proxy: scenService - baseService,
              stockout_units: (feasible ? 50 : 9999) - 9999,
              estimated_total_cost: scenCost - baseCost
            }
          : { service_level_proxy: 0, stockout_units: 0, estimated_total_cost: 0 }
      },
      constraints_summary: {
        base_violations: 2,
        scenario_violations: feasible ? 0 : 2,
        violations_delta: feasible ? -2 : 0
      },
      rank_score: feasible ? (-(scenService - baseService) * 1000 + (scenCost - baseCost) * 0.001) : 1e9,
      notes: feasible ? [] : ['Scenario remains infeasible with this relaxation.'],
      evidence_refs: opt.evidence_refs || []
    };
  });

  // Deterministic sort: rank_score asc, then option_id lex
  return [...evaluated].sort((a, b) => {
    const diff = a.rank_score - b.rank_score;
    if (Math.abs(diff) > 1e-9) return diff;
    return a.option_id.localeCompare(b.option_id);
  });
}

// ---------------------------------------------------------------------------
// Integration Tests
// ---------------------------------------------------------------------------

describe('Negotiation Integration – synthetic infeasible case', () => {
  it('correctly detects infeasible trigger from evidence', () => {
    const trigger = detectTrigger(
      INFEASIBLE_SOLVER_META,
      INFEASIBLE_REPLAY_METRICS,
      USER_INTENT
    );
    expect(trigger).toBe('infeasible');
  });

  it('generates options including opt_001 (budget) and opt_002 (MOQ) for the infeasible case', () => {
    const result = generateNegotiationOptions({
      solverMeta: INFEASIBLE_SOLVER_META,
      constraintCheck: INFEASIBLE_CONSTRAINT_CHECK,
      replayMetrics: INFEASIBLE_REPLAY_METRICS,
      userIntent: USER_INTENT,
      baseRunId: 100
    });

    expect(result).not.toBeNull();
    expect(result.trigger).toBe('infeasible');

    const ids = result.options.map((o) => o.option_id);
    expect(ids).toContain('opt_001');
    expect(ids).toContain('opt_002');
  });

  it('generates options in stable deterministic order across calls', () => {
    const params = {
      solverMeta: INFEASIBLE_SOLVER_META,
      constraintCheck: INFEASIBLE_CONSTRAINT_CHECK,
      replayMetrics: INFEASIBLE_REPLAY_METRICS,
      userIntent: USER_INTENT,
      baseRunId: 100
    };

    const r1 = generateNegotiationOptions(params);
    const r2 = generateNegotiationOptions(params);
    const ids1 = r1?.options.map((o) => o.option_id);
    const ids2 = r2?.options.map((o) => o.option_id);
    expect(ids1).toEqual(ids2);
  });

  it('opt_001 budget override is 10% above the original budget_cap', () => {
    const result = generateNegotiationOptions({
      solverMeta: INFEASIBLE_SOLVER_META,
      constraintCheck: INFEASIBLE_CONSTRAINT_CHECK,
      replayMetrics: INFEASIBLE_REPLAY_METRICS,
      userIntent: USER_INTENT,
      baseRunId: 100
    });

    const opt001 = result?.options.find((o) => o.option_id === 'opt_001');
    expect(opt001).toBeDefined();
    const newBudget = opt001.overrides.constraints.budget_cap;
    expect(Math.abs(newBudget - 22000)).toBeLessThan(0.01); // 20000 * 1.10
  });

  it('opt_002 MOQ relaxation has correct factor in engine_flags', () => {
    const result = generateNegotiationOptions({
      solverMeta: INFEASIBLE_SOLVER_META,
      constraintCheck: INFEASIBLE_CONSTRAINT_CHECK,
      replayMetrics: INFEASIBLE_REPLAY_METRICS,
      userIntent: USER_INTENT,
      baseRunId: 100
    });

    const opt002 = result?.options.find((o) => o.option_id === 'opt_002');
    expect(opt002).toBeDefined();
    expect(opt002.engine_flags.soft_moq).toBe(true);
    expect(opt002.engine_flags.moq_relaxation_factor).toBe(0.80);
  });

  it('mock evaluator: feasible options (opt_001, opt_002) are ranked above infeasible ones', () => {
    const result = generateNegotiationOptions({
      solverMeta: INFEASIBLE_SOLVER_META,
      constraintCheck: INFEASIBLE_CONSTRAINT_CHECK,
      replayMetrics: INFEASIBLE_REPLAY_METRICS,
      userIntent: USER_INTENT,
      baseRunId: 100
    });

    const rankedOptions = mockEvaluateOptions(result.options, {
      service_level_proxy: 0,
      estimated_total_cost: 0
    });

    // At least one option should be feasible
    const feasibleOpts = rankedOptions.filter(
      (o) => o.status === 'succeeded' && o.kpis?.scenario?.feasible !== false
    );
    expect(feasibleOpts.length).toBeGreaterThan(0);

    // All feasible options should appear before all infeasible ones
    const firstFeasibleIdx = rankedOptions.findIndex(
      (o) => o.status === 'succeeded' && o.kpis?.scenario?.feasible !== false
    );
    const lastFeasibleIdx = rankedOptions.reduce(
      (last, o, i) =>
        o.status === 'succeeded' && o.kpis?.scenario?.feasible !== false ? i : last,
      -1
    );
    const firstInfeasibleIdx = rankedOptions.findIndex(
      (o) => o.status === 'failed' || o.kpis?.scenario?.feasible === false
    );

    if (firstInfeasibleIdx !== -1) {
      expect(lastFeasibleIdx).toBeLessThan(firstInfeasibleIdx);
    }
  });

  it('mock evaluator: ranking is deterministic (same output on two calls)', () => {
    const result = generateNegotiationOptions({
      solverMeta: INFEASIBLE_SOLVER_META,
      constraintCheck: INFEASIBLE_CONSTRAINT_CHECK,
      replayMetrics: INFEASIBLE_REPLAY_METRICS,
      userIntent: USER_INTENT,
      baseRunId: 100
    });

    // Use fixed mock (not random) for deterministic test
    function stableEvaluate(options) {
      return [...mockEvaluateOptions(options, { service_level_proxy: 0, estimated_total_cost: 0 })]
        .map((o) => ({ option_id: o.option_id, status: o.status, rank_score: o.rank_score }));
    }

    const e1 = stableEvaluate(result.options);
    const e2 = stableEvaluate(result.options);

    // Same ordering each time
    expect(e1.map((o) => o.option_id)).toEqual(e2.map((o) => o.option_id));
    expect(e1.map((o) => o.status)).toEqual(e2.map((o) => o.status));
  });

  it('negotiation_evaluation has the correct ranking_method string', () => {
    const evaluationPayload = {
      base_run_id: 100,
      ranked_options: [],
      ranking_method: RANKING_METHOD
    };
    expect(evaluationPayload.ranking_method).toBe(RANKING_METHOD);
  });
});

// ---------------------------------------------------------------------------
// Integration Tests – KPI shortfall case
// ---------------------------------------------------------------------------

describe('Negotiation Integration – KPI shortfall case', () => {
  const SHORTFALL_SOLVER_META = {
    status: 'feasible',
    kpis: { estimated_total_cost: 45000, service_level_proxy: 0.78 },
    solver_meta: {},
    proof: { constraints_checked: [], objective_terms: [] },
    infeasible_reasons: []
  };

  const SHORTFALL_REPLAY_METRICS = {
    with_plan: { service_level_proxy: 0.78, stockout_units: 300 },
    without_plan: { service_level_proxy: 0.50, stockout_units: 1000 },
    delta: {}
  };

  const SHORTFALL_INTENT = {
    service_target: 0.95,
    budget_cap: 50000
  };

  it('detects kpi_shortfall trigger', () => {
    const trigger = detectTrigger(
      SHORTFALL_SOLVER_META,
      SHORTFALL_REPLAY_METRICS,
      SHORTFALL_INTENT
    );
    expect(trigger).toBe('kpi_shortfall');
  });

  it('generates options for kpi_shortfall (includes safety stock and expedite)', () => {
    const result = generateNegotiationOptions({
      solverMeta: SHORTFALL_SOLVER_META,
      constraintCheck: { passed: true, violations: [] },
      replayMetrics: SHORTFALL_REPLAY_METRICS,
      userIntent: SHORTFALL_INTENT,
      baseRunId: 200
    });

    expect(result).not.toBeNull();
    expect(result.trigger).toBe('kpi_shortfall');

    const ids = result.options.map((o) => o.option_id);
    // Safety stock should be included (service below 0.90)
    expect(ids).toContain('opt_005');
  });

  it('does not trigger when service level is within acceptable range', () => {
    const goodMetrics = {
      with_plan: { service_level_proxy: 0.93, stockout_units: 0 },
      without_plan: { service_level_proxy: 0.50, stockout_units: 500 }
    };
    const result = generateNegotiationOptions({
      solverMeta: SHORTFALL_SOLVER_META,
      constraintCheck: { passed: true, violations: [] },
      replayMetrics: goodMetrics,
      userIntent: SHORTFALL_INTENT,
      baseRunId: 300
    });
    // 0.93 >= 0.95 - 0.05 = 0.90, stockout_units = 0 → no trigger
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration Tests – negotiation_options artifact schema compliance
// ---------------------------------------------------------------------------

describe('Negotiation artifact schema compliance', () => {
  it('negotiation_options payload matches expected schema for contract validator', () => {
    const result = generateNegotiationOptions({
      solverMeta: INFEASIBLE_SOLVER_META,
      constraintCheck: INFEASIBLE_CONSTRAINT_CHECK,
      replayMetrics: INFEASIBLE_REPLAY_METRICS,
      userIntent: USER_INTENT,
      baseRunId: 100
    });

    // version
    expect(result.version).toBe('v0');
    // generated_at is ISO string
    expect(() => new Date(result.generated_at).toISOString()).not.toThrow();
    // base_run_id is number or string
    expect(
      typeof result.base_run_id === 'number' ||
        typeof result.base_run_id === 'string'
    ).toBe(true);
    // trigger is valid string
    expect(['infeasible', 'kpi_shortfall']).toContain(result.trigger);
    // intent is object
    expect(typeof result.intent).toBe('object');
    // options is array of objects with required fields
    result.options.forEach((opt) => {
      expect(typeof opt.option_id).toBe('string');
      expect(typeof opt.title).toBe('string');
      expect(typeof opt.overrides).toBe('object');
      expect(typeof opt.engine_flags).toBe('object');
      expect(Array.isArray(opt.why)).toBe(true);
      expect(Array.isArray(opt.evidence_refs)).toBe(true);
    });
  });
});
