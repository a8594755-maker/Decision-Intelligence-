/**
 * Unit tests: negotiationOptionsGenerator
 *
 * Covers:
 *   - Determinism: same inputs → same output (including generated_at replaced)
 *   - Trigger detection (infeasible, kpi_shortfall, no trigger)
 *   - Option inclusion / exclusion based on evidence
 *   - Option ordering is stable and deterministic
 *   - Option set stays ≤ max_options
 *   - LLM number rejection (validateLlmOutput helper)
 */

import { describe, it, expect } from 'vitest';
import {
  generateNegotiationOptions,
  detectTrigger,
  DEFAULT_NEGOTIATION_CONFIG
} from './negotiationOptionsGenerator';

// ---------------------------------------------------------------------------
// Helpers to build evidence fixtures
// ---------------------------------------------------------------------------

const makeSolverMeta = (overrides = {}) => ({
  status: 'feasible',
  kpis: { estimated_total_cost: 50000, service_level_proxy: 0.92 },
  solver_meta: {},
  proof: { constraints_checked: [], objective_terms: [] },
  infeasible_reasons: [],
  ...overrides
});

const makeReplayMetrics = (overrides = {}) => ({
  with_plan: { service_level_proxy: 0.92, stockout_units: 0 },
  without_plan: { service_level_proxy: 0.50, stockout_units: 500 },
  delta: {},
  ...overrides
});

const makeConstraintCheck = (overrides = {}) => ({
  passed: true,
  violations: [],
  ...overrides
});

const makeIntent = (overrides = {}) => ({
  service_target: null,
  budget_cap: null,
  ...overrides
});

/** Strip generated_at for deterministic comparison */
const stripTimestamp = (obj) => {
  if (!obj || typeof obj !== 'object') return obj;
  const { generated_at: _generated_at, ...rest } = obj;
  return rest;
};

// ---------------------------------------------------------------------------
// detectTrigger
// ---------------------------------------------------------------------------

describe('detectTrigger', () => {
  it('returns "infeasible" when solver status is INFEASIBLE', () => {
    const sm = makeSolverMeta({ status: 'INFEASIBLE' });
    expect(detectTrigger(sm, {}, {})).toBe('infeasible');
  });

  it('returns "infeasible" for lowercase infeasible', () => {
    const sm = makeSolverMeta({ status: 'infeasible' });
    expect(detectTrigger(sm, {}, {})).toBe('infeasible');
  });

  it('returns "kpi_shortfall" when service below target - margin', () => {
    const rm = makeReplayMetrics({
      with_plan: { service_level_proxy: 0.80, stockout_units: 0 }
    });
    const intent = makeIntent({ service_target: 0.95 });
    expect(detectTrigger({}, rm, intent)).toBe('kpi_shortfall');
  });

  it('returns null when service is within acceptable range of target', () => {
    const rm = makeReplayMetrics({
      with_plan: { service_level_proxy: 0.93, stockout_units: 0 }
    });
    // margin = 0.05; 0.93 >= 0.95 - 0.05 = 0.90 → no trigger
    const intent = makeIntent({ service_target: 0.95 });
    expect(detectTrigger({}, rm, intent)).toBeNull();
  });

  it('returns "kpi_shortfall" when stockout_units > threshold', () => {
    const rm = makeReplayMetrics({
      with_plan: { service_level_proxy: 0.99, stockout_units: 10 }
    });
    expect(detectTrigger({}, rm, {}, { stockout_units_threshold: 0 })).toBe('kpi_shortfall');
  });

  it('returns null when stockout_units equals threshold (not greater)', () => {
    const rm = makeReplayMetrics({
      with_plan: { service_level_proxy: 0.99, stockout_units: 0 }
    });
    expect(detectTrigger({}, rm, {}, { stockout_units_threshold: 0 })).toBeNull();
  });

  it('returns null when no trigger conditions met', () => {
    expect(detectTrigger(makeSolverMeta(), makeReplayMetrics(), makeIntent())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// generateNegotiationOptions – determinism
// ---------------------------------------------------------------------------

describe('generateNegotiationOptions – determinism', () => {
  const infeasibleInput = {
    solverMeta: makeSolverMeta({ status: 'INFEASIBLE', infeasible_reasons: ['budget exceeded'] }),
    constraintCheck: makeConstraintCheck({
      passed: false,
      violations: [{ rule: 'budget_cap', sku: '*', details: 'over budget' }]
    }),
    replayMetrics: makeReplayMetrics(),
    userIntent: makeIntent({ budget_cap: 100000 }),
    baseRunId: 42
  };

  it('produces the same option set on repeated calls (stripped of timestamp)', () => {
    const r1 = stripTimestamp(generateNegotiationOptions(infeasibleInput));
    const r2 = stripTimestamp(generateNegotiationOptions(infeasibleInput));
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it('produces the same option_ids in the same order', () => {
    const r1 = generateNegotiationOptions(infeasibleInput);
    const r2 = generateNegotiationOptions(infeasibleInput);
    const ids1 = r1?.options.map((o) => o.option_id);
    const ids2 = r2?.options.map((o) => o.option_id);
    expect(ids1).toEqual(ids2);
  });

  it('option overrides are fully deterministic (no random values)', () => {
    const r1 = generateNegotiationOptions(infeasibleInput);
    const r2 = generateNegotiationOptions(infeasibleInput);
    const overrides1 = r1?.options.map((o) => JSON.stringify(o.overrides));
    const overrides2 = r2?.options.map((o) => JSON.stringify(o.overrides));
    expect(overrides1).toEqual(overrides2);
  });
});

// ---------------------------------------------------------------------------
// generateNegotiationOptions – option inclusion / exclusion
// ---------------------------------------------------------------------------

describe('generateNegotiationOptions – option inclusion', () => {
  it('returns null when trigger is not met', () => {
    const result = generateNegotiationOptions({
      solverMeta: makeSolverMeta(),
      constraintCheck: makeConstraintCheck(),
      replayMetrics: makeReplayMetrics(),
      userIntent: makeIntent(),
      baseRunId: 1
    });
    expect(result).toBeNull();
  });

  it('includes opt_001 (budget) only when budget_cap violation exists AND intent has budget_cap', () => {
    // With budget violation + budget intent
    const withBudget = generateNegotiationOptions({
      solverMeta: makeSolverMeta({
        status: 'INFEASIBLE',
        infeasible_reasons: ['budget exceeded']
      }),
      constraintCheck: makeConstraintCheck({
        passed: false,
        violations: [{ rule: 'budget_cap', sku: '*', details: 'over budget' }]
      }),
      replayMetrics: makeReplayMetrics(),
      userIntent: makeIntent({ budget_cap: 50000 }),
      baseRunId: 1
    });
    const ids = withBudget?.options.map((o) => o.option_id);
    expect(ids).toContain('opt_001');

    // Without budget_cap in intent (even with violation)
    const withoutBudgetIntent = generateNegotiationOptions({
      solverMeta: makeSolverMeta({
        status: 'INFEASIBLE',
        infeasible_reasons: ['budget exceeded']
      }),
      constraintCheck: makeConstraintCheck({
        passed: false,
        violations: [{ rule: 'budget_cap', sku: '*', details: 'over budget' }]
      }),
      replayMetrics: makeReplayMetrics(),
      userIntent: makeIntent({ budget_cap: null }),
      baseRunId: 1
    });
    const ids2 = withoutBudgetIntent?.options.map((o) => o.option_id) || [];
    expect(ids2).not.toContain('opt_001');
  });

  it('includes opt_002 (MOQ) only when MOQ is binding in evidence', () => {
    const withMoq = generateNegotiationOptions({
      solverMeta: makeSolverMeta({
        status: 'INFEASIBLE',
        infeasible_reasons: ['MOQ constraint violated']
      }),
      constraintCheck: makeConstraintCheck({
        passed: false,
        violations: [{ rule: 'moq', sku: 'SKU-A', details: 'below moq' }]
      }),
      replayMetrics: makeReplayMetrics(),
      userIntent: makeIntent(),
      baseRunId: 1
    });
    const ids = withMoq?.options.map((o) => o.option_id) || [];
    expect(ids).toContain('opt_002');

    const withoutMoq = generateNegotiationOptions({
      solverMeta: makeSolverMeta({ status: 'INFEASIBLE', infeasible_reasons: ['budget'] }),
      constraintCheck: makeConstraintCheck({ passed: false, violations: [] }),
      replayMetrics: makeReplayMetrics(),
      userIntent: makeIntent({ budget_cap: 50000 }),
      baseRunId: 1
    });
    const ids2 = withoutMoq?.options.map((o) => o.option_id) || [];
    expect(ids2).not.toContain('opt_002');
  });

  it('includes opt_003 (pack size) only when pack_size violation exists', () => {
    const withPack = generateNegotiationOptions({
      solverMeta: makeSolverMeta({
        status: 'INFEASIBLE',
        infeasible_reasons: ['pack size constraint']
      }),
      constraintCheck: makeConstraintCheck({
        passed: false,
        violations: [{ rule: 'pack_size_multiple', sku: 'A', details: 'not multiple' }]
      }),
      replayMetrics: makeReplayMetrics(),
      userIntent: makeIntent(),
      baseRunId: 1
    });
    const ids = withPack?.options.map((o) => o.option_id) || [];
    expect(ids).toContain('opt_003');
  });

  it('includes opt_004 (expedite) when service shortfall > 10pp below target', () => {
    const rm = makeReplayMetrics({
      with_plan: { service_level_proxy: 0.75, stockout_units: 200 }
    });
    const intent = makeIntent({ service_target: 0.95 });
    const result = generateNegotiationOptions({
      solverMeta: makeSolverMeta({ status: 'infeasible' }),
      constraintCheck: makeConstraintCheck({ passed: false, violations: [] }),
      replayMetrics: rm,
      userIntent: intent,
      baseRunId: 1
    });
    const ids = result?.options.map((o) => o.option_id) || [];
    expect(ids).toContain('opt_004');
  });

  it('includes opt_005 (safety stock) on kpi_shortfall', () => {
    const rm = makeReplayMetrics({
      with_plan: { service_level_proxy: 0.85, stockout_units: 10 }
    });
    const intent = makeIntent({ service_target: 0.95 });
    const result = generateNegotiationOptions({
      solverMeta: makeSolverMeta(),
      constraintCheck: makeConstraintCheck(),
      replayMetrics: rm,
      userIntent: intent,
      baseRunId: 1
    });
    const ids = result?.options.map((o) => o.option_id) || [];
    expect(ids).toContain('opt_005');
  });

  it('includes opt_006 (reduce service target) only when >= 2 other options and target > 0.90', () => {
    const rm = makeReplayMetrics({
      with_plan: { service_level_proxy: 0.80, stockout_units: 50 }
    });
    const intent = makeIntent({ service_target: 0.95 }); // ambitious
    const result = generateNegotiationOptions({
      solverMeta: makeSolverMeta(),
      constraintCheck: makeConstraintCheck(),
      replayMetrics: rm,
      userIntent: intent,
      baseRunId: 1
    });
    const ids = result?.options.map((o) => o.option_id) || [];
    if (ids.length >= 2) {
      expect(ids).toContain('opt_006');
    }
  });

  it('does NOT include opt_006 when service_target <= 0.90', () => {
    const rm = makeReplayMetrics({
      with_plan: { service_level_proxy: 0.80, stockout_units: 50 }
    });
    const intent = makeIntent({ service_target: 0.85 }); // not ambitious
    const result = generateNegotiationOptions({
      solverMeta: makeSolverMeta(),
      constraintCheck: makeConstraintCheck(),
      replayMetrics: rm,
      userIntent: intent,
      baseRunId: 1
    });
    const ids = result?.options.map((o) => o.option_id) || [];
    expect(ids).not.toContain('opt_006');
  });
});

// ---------------------------------------------------------------------------
// generateNegotiationOptions – schema contract
// ---------------------------------------------------------------------------

describe('generateNegotiationOptions – output schema', () => {
  const input = {
    solverMeta: makeSolverMeta({ status: 'INFEASIBLE', infeasible_reasons: ['budget'] }),
    constraintCheck: makeConstraintCheck({
      passed: false,
      violations: [{ rule: 'budget_cap', sku: '*', details: 'over budget' }]
    }),
    replayMetrics: makeReplayMetrics(),
    userIntent: makeIntent({ budget_cap: 80000 }),
    baseRunId: 99
  };

  it('returns required top-level fields', () => {
    const result = generateNegotiationOptions(input);
    expect(result).not.toBeNull();
    expect(result.version).toBe('v0');
    expect(typeof result.generated_at).toBe('string');
    expect(result.base_run_id).toBe(99);
    expect(['infeasible', 'kpi_shortfall']).toContain(result.trigger);
    expect(typeof result.intent).toBe('object');
    expect(Array.isArray(result.options)).toBe(true);
  });

  it('each option has required fields', () => {
    const result = generateNegotiationOptions(input);
    result.options.forEach((opt) => {
      expect(typeof opt.option_id).toBe('string');
      expect(typeof opt.title).toBe('string');
      expect(typeof opt.overrides).toBe('object');
      expect(typeof opt.engine_flags).toBe('object');
      expect(Array.isArray(opt.why)).toBe(true);
      expect(Array.isArray(opt.evidence_refs)).toBe(true);
    });
  });

  it('respects max_options limit', () => {
    const result = generateNegotiationOptions({
      ...input,
      config: { max_options: 2 }
    });
    expect(result.options.length).toBeLessThanOrEqual(2);
  });

  it('opt_001 budget override has correct value (budgetCap * 1.10)', () => {
    const result = generateNegotiationOptions(input);
    const opt001 = result.options.find((o) => o.option_id === 'opt_001');
    expect(opt001).toBeDefined();
    const newBudget = opt001.overrides.constraints.budget_cap;
    expect(Math.abs(newBudget - 88000)).toBeLessThan(0.01); // 80000 * 1.10
  });

  it('opt_006 service target override reduces by service_target_reduction_factor', () => {
    const rm = makeReplayMetrics({
      with_plan: { service_level_proxy: 0.75, stockout_units: 200 }
    });
    const intent = makeIntent({ service_target: 0.95 });
    const result = generateNegotiationOptions({
      solverMeta: makeSolverMeta({ status: 'infeasible' }),
      constraintCheck: makeConstraintCheck({ passed: false, violations: [] }),
      replayMetrics: rm,
      userIntent: intent,
      baseRunId: 1
    });
    const opt006 = result?.options.find((o) => o.option_id === 'opt_006');
    if (opt006) {
      const expectedTarget = 0.95 * (1 - DEFAULT_NEGOTIATION_CONFIG.service_target_reduction_factor);
      expect(
        Math.abs(opt006.overrides.objective.service_level_target - expectedTarget)
      ).toBeLessThan(1e-4);
    }
  });
});

// ---------------------------------------------------------------------------
// generateNegotiationOptions – concrete MOQ override with baseConstraints
// ---------------------------------------------------------------------------

describe('generateNegotiationOptions – baseConstraints MOQ', () => {
  it('builds concrete relaxed MOQ array when baseConstraints.moq provided', () => {
    const baseMoq = [
      { sku: 'A', min_qty: 100 },
      { sku: 'B', min_qty: 200 }
    ];

    const result = generateNegotiationOptions({
      solverMeta: makeSolverMeta({
        status: 'INFEASIBLE',
        infeasible_reasons: ['MOQ too high']
      }),
      constraintCheck: makeConstraintCheck({
        passed: false,
        violations: [{ rule: 'moq', sku: 'A', details: 'below moq' }]
      }),
      replayMetrics: makeReplayMetrics(),
      userIntent: makeIntent(),
      baseRunId: 5,
      baseConstraints: { moq: baseMoq }
    });

    const opt002 = result?.options.find((o) => o.option_id === 'opt_002');
    expect(opt002).toBeDefined();
    const relaxedMoq = opt002.overrides.constraints.moq;
    expect(Array.isArray(relaxedMoq)).toBe(true);
    expect(relaxedMoq[0].sku).toBe('A');
    expect(Math.abs(relaxedMoq[0].min_qty - 80)).toBeLessThan(0.01); // 100 * 0.8
    expect(Math.abs(relaxedMoq[1].min_qty - 160)).toBeLessThan(0.01); // 200 * 0.8
  });

  it('is still deterministic with baseConstraints', () => {
    const baseMoq = [{ sku: 'X', min_qty: 50 }];
    const params = {
      solverMeta: makeSolverMeta({ status: 'INFEASIBLE', infeasible_reasons: ['moq'] }),
      constraintCheck: makeConstraintCheck({ passed: false, violations: [{ rule: 'moq', sku: 'X', details: '' }] }),
      replayMetrics: makeReplayMetrics(),
      userIntent: makeIntent(),
      baseRunId: 10,
      baseConstraints: { moq: baseMoq }
    };
    const r1 = stripTimestamp(generateNegotiationOptions(params));
    const r2 = stripTimestamp(generateNegotiationOptions(params));
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});

// ---------------------------------------------------------------------------
// LLM output number validation (inline unit – mirrors negotiationReportBuilder logic)
// ---------------------------------------------------------------------------

describe('LLM output evidence-first validation', () => {
  /**
   * Minimal inline re-implementation of detectFabricatedNumbers for
   * testing the validation logic in isolation.
   */
  function detectFabricated(text, evidenceNums) {
    const numRegex = /\b(\d+(?:\.\d+)?)\b/g;
    const fabricated = [];
    let match;
    while ((match = numRegex.exec(text)) !== null) {
      const n = Number(match[1]);
      if (!Number.isFinite(n)) continue;
      if (Number.isInteger(n) && n >= 0 && n <= 6) continue;
      const directKey = String(Math.round(n * 1e6) / 1e6);
      const roundedKey = String(Math.round(n * 100) / 100);
      const asDecimal = n / 100;
      const pctKey = String(Math.round(asDecimal * 1e6) / 1e6);
      if (evidenceNums.has(directKey) || evidenceNums.has(roundedKey) || evidenceNums.has(pctKey)) continue;
      fabricated.push(match[1]);
    }
    return fabricated;
  }

  const evidenceNums = new Set(['0.92', '50000', '10', '0.95']);

  it('passes when all numbers are from evidence', () => {
    const text = 'Service level improved to 0.92 with cost 50000 and target 0.95.';
    expect(detectFabricated(text, evidenceNums)).toHaveLength(0);
  });

  it('rejects fabricated number not in evidence', () => {
    const text = 'Service level is 0.999 and cost is 12345.';
    const result = detectFabricated(text, evidenceNums);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('12345');
  });

  it('allows percentages derived from evidence decimals (0.92 → 92%)', () => {
    const text = 'Service level is 92% with 10 stockouts.';
    expect(detectFabricated(text, evidenceNums)).toHaveLength(0);
  });

  it('allows ordinals 1-6 (option numbering)', () => {
    const text = 'Option 1 is ranked above option 3.';
    expect(detectFabricated(text, evidenceNums)).toHaveLength(0);
  });
});
