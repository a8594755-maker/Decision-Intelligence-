import { describe, it, expect } from 'vitest';
import {
  buildDecisionNarrative,
  buildDecisionNarrativeFromPlanResult,
  NARRATIVE_VERSION
} from './buildDecisionNarrative';

const OPTIMAL_PROOF = {
  objective_terms: [
    { name: 'holding_cost', value: 1200.0, note: 'Total holding cost' },
    { name: 'stockout_cost', value: 300.0, note: 'Penalty for unmet demand' },
    { name: 'procurement_cost', value: 8500.0, note: 'Total order cost' }
  ],
  constraints_checked: [
    {
      name: 'budget_cap',
      passed: true,
      binding: false,
      violations: 0,
      details: 'Total spend: $9700 vs cap: $15000'
    },
    {
      name: 'moq',
      passed: true,
      binding: false,
      violations: 0,
      details: 'All MOQ satisfied'
    },
    {
      name: 'pack_size_multiple',
      passed: true,
      binding: false,
      violations: 0,
      details: 'All pack sizes correct'
    },
    { name: 'order_qty_non_negative', passed: true, binding: false, violations: 0 }
  ]
};

const BINDING_PROOF = {
  objective_terms: [
    { name: 'holding_cost', value: 1800.0 },
    { name: 'procurement_cost', value: 14900.0 },
    { name: 'stockout_cost', value: 6500.0 }
  ],
  constraints_checked: [
    {
      name: 'budget_cap',
      passed: false,
      binding: true,
      violations: 3,
      details: 'Total spend $14900 exceeds cap $14000'
    },
    { name: 'moq', passed: false, binding: true, violations: 2, details: 'SKU-A below MOQ=100' },
    { name: 'pack_size_multiple', passed: true, binding: false, violations: 0 }
  ]
};

const BINDING_PROOF_WITH_SLACK = {
  objective_terms: [
    { name: 'holding_cost', value: 1800.0, business_label: 'Inventory holding' },
    { name: 'procurement_cost', value: 14900.0, business_label: 'Procurement volume' },
    { name: 'stockout_cost', value: 6500.0, business_label: 'Shortage exposure' }
  ],
  constraints_checked: [
    {
      name: 'budget_cap',
      passed: true,
      binding: true,
      violations: 0,
      details: 'Total spend 9700 vs cap 10000.',
      slack: 300.0,
      slack_unit: 'USD',
      shadow_price_approx: 8.0,
      shadow_price_unit: 'USD saved / USD relaxed',
      natural_language: 'Budget cap is nearly exhausted (remaining: 300.0 USD).'
    },
    {
      name: 'moq',
      passed: true,
      binding: true,
      violations: 0,
      details: 'Rows violating MOQ: 0.',
      slack: 0.0,
      slack_unit: 'units',
      natural_language: 'MOQ violations on 0 rows.'
    },
    { name: 'pack_size_multiple', passed: true, binding: false, violations: 0 }
  ]
};

const SAMPLE_EXPLAIN_SUMMARY = {
  headline: 'Projected shortage of 1500 units, primary constraint is budget_cap',
  top_binding_constraint: 'budget_cap',
  key_relaxation: {
    constraint: 'budget_cap',
    relax_by: 10000,
    relax_unit: 'USD',
    estimated_saving: 80000,
    saving_unit: 'USD',
    nl_text: 'Relaxing budget cap by USD 10,000 could reduce shortage penalty by up to 80,000 USD.'
  },
  confidence: 'high'
};

const INFEASIBLE_PROOF = {
  objective_terms: [],
  constraints_checked: [
    { name: 'budget_cap', passed: false, binding: true, violations: 5 },
    { name: 'capacity', passed: false, binding: true, violations: 3 }
  ],
  infeasibility_analysis: {
    categories: ['budget', 'capacity'],
    top_offending_tags: ['CAP_PROD[2026-03-01]', 'BUDGET[global]'],
    suggestions: ['Increase budget cap by 10%.', 'Reduce production capacity constraints.']
  }
};

const GOOD_REPLAY_METRICS = {
  with_plan: { service_level_proxy: 0.95, stockout_units: 42, holding_units: 380 },
  without_plan: { service_level_proxy: 0.72, stockout_units: 1200, holding_units: 100 },
  delta: { service_level_proxy: 0.23, stockout_units: -1158 }
};

const POOR_REPLAY_METRICS = {
  with_plan: { service_level_proxy: 0.78, stockout_units: 850, holding_units: 120 },
  without_plan: { service_level_proxy: 0.62, stockout_units: 2100, holding_units: 50 }
};

const SAMPLE_SOLVER_KPIS = { estimated_total_cost: 10000 };

const NEGOTIATION_OPTIONS = {
  trigger: 'kpi_shortfall',
  options: [
    {
      option_id: 'opt_004',
      title: 'Enable expedite mode',
      why: ['Lead time risk high.'],
      evidence_refs: ['replay_metrics.stockout']
    },
    {
      option_id: 'opt_005',
      title: 'Increase safety stock 1.2x',
      why: ['Service below 90%.'],
      evidence_refs: ['replay_metrics.service_level']
    }
  ]
};

describe('buildDecisionNarrative: OPTIMAL', () => {
  it('returns expected version', () => {
    const result = buildDecisionNarrative();
    expect(result.version).toBe(NARRATIVE_VERSION);
  });

  it('situation includes service level and delta', () => {
    const result = buildDecisionNarrative({
      solverStatus: 'OPTIMAL',
      solverKpis: SAMPLE_SOLVER_KPIS,
      proof: OPTIMAL_PROOF,
      replayMetrics: GOOD_REPLAY_METRICS
    });

    expect(result.situation.text).toContain('95.0%');
    expect(result.situation.text).toContain('+23.0%');
    expect(result.situation.evidence_refs).toContain('replay_metrics.with_plan.service_level_proxy');
  });

  it('driver uses cost driver when there are no binding constraints', () => {
    const result = buildDecisionNarrative({
      solverStatus: 'OPTIMAL',
      solverKpis: SAMPLE_SOLVER_KPIS,
      proof: OPTIMAL_PROOF,
      replayMetrics: GOOD_REPLAY_METRICS
    });

    expect(result.driver.category).toBe('cost_driver');
    expect(result.driver.text).toContain('procurement_cost');
  });

  it('recommendation is approve_plan when service level is good', () => {
    const result = buildDecisionNarrative({
      solverStatus: 'OPTIMAL',
      solverKpis: SAMPLE_SOLVER_KPIS,
      proof: OPTIMAL_PROOF,
      replayMetrics: GOOD_REPLAY_METRICS
    });

    expect(result.recommendation.action_type).toBe('approve_plan');
  });

  it('requires_approval is false for healthy plans', () => {
    const result = buildDecisionNarrative({
      solverStatus: 'OPTIMAL',
      solverKpis: SAMPLE_SOLVER_KPIS,
      proof: OPTIMAL_PROOF,
      replayMetrics: GOOD_REPLAY_METRICS
    });

    expect(result.requires_approval).toBe(false);
  });
});

describe('buildDecisionNarrative: INFEASIBLE', () => {
  it('returns infeasibility situation and driver', () => {
    const result = buildDecisionNarrative({
      solverStatus: 'INFEASIBLE',
      proof: INFEASIBLE_PROOF,
      infeasibleReasons: ['Budget constraint violated.', 'Capacity constraint violated.'],
      infeasibleReasonDetails: [
        {
          category: 'capacity',
          top_offending_tags: ['CAP_PROD[2026-03-01]'],
          suggested_actions: ['Increase capacity.']
        }
      ],
      replayMetrics: { with_plan: {}, without_plan: {} }
    });

    expect(result.situation.text.toLowerCase()).toContain('feasible');
    expect(result.driver.category).toBe('infeasibility');
    expect(result.driver.text).toContain('capacity');
  });

  it('requires_approval is true when INFEASIBLE', () => {
    const result = buildDecisionNarrative({
      solverStatus: 'INFEASIBLE',
      proof: INFEASIBLE_PROOF,
      infeasibleReasons: ['Budget violated.'],
      replayMetrics: {}
    });

    expect(result.requires_approval).toBe(true);
  });

  it('recommendation points to negotiation option when available', () => {
    const result = buildDecisionNarrative({
      solverStatus: 'INFEASIBLE',
      proof: INFEASIBLE_PROOF,
      negotiationOptions: NEGOTIATION_OPTIONS,
      replayMetrics: {}
    });

    expect(result.recommendation.action_type).toBe('relax_constraint');
  });
});

describe('buildDecisionNarrative: binding constraints', () => {
  it('reports budget_cap as primary binding constraint', () => {
    const result = buildDecisionNarrative({
      solverStatus: 'FEASIBLE',
      solverKpis: SAMPLE_SOLVER_KPIS,
      proof: BINDING_PROOF,
      replayMetrics: GOOD_REPLAY_METRICS
    });

    expect(result.driver.category).toBe('binding_constraint');
    expect(result.driver.binding_constraint).toBe('budget_cap');
  });

  it('sorts constraint_binding_summary by priority', () => {
    const result = buildDecisionNarrative({
      solverStatus: 'FEASIBLE',
      proof: BINDING_PROOF,
      replayMetrics: GOOD_REPLAY_METRICS
    });

    const names = result.constraint_binding_summary.map((c) => c.name);
    expect(names.indexOf('budget_cap')).toBeLessThan(names.indexOf('moq'));
  });

  it('produces marginal_impact for binding budget_cap', () => {
    const result = buildDecisionNarrative({
      solverStatus: 'FEASIBLE',
      solverKpis: SAMPLE_SOLVER_KPIS,
      proof: BINDING_PROOF,
      replayMetrics: GOOD_REPLAY_METRICS
    });

    const budgetSummary = result.constraint_binding_summary.find((c) => c.name === 'budget_cap');
    expect(budgetSummary.binding).toBe(true);
    expect(budgetSummary.marginal_impact).not.toBeNull();
    expect(typeof budgetSummary.marginal_impact.description).toBe('string');
  });
});

describe('buildDecisionNarrative: poor service level', () => {
  it('recommends improve_service_level when SL < 90%', () => {
    const result = buildDecisionNarrative({
      solverStatus: 'FEASIBLE',
      proof: OPTIMAL_PROOF,
      replayMetrics: POOR_REPLAY_METRICS
    });

    expect(result.recommendation.action_type).toBe('improve_service_level');
  });

  it('requires approval when SL < 80%', () => {
    const result = buildDecisionNarrative({
      solverStatus: 'FEASIBLE',
      proof: OPTIMAL_PROOF,
      replayMetrics: {
        with_plan: { service_level_proxy: 0.65, stockout_units: 1500 },
        without_plan: { service_level_proxy: 0.40 }
      }
    });

    expect(result.requires_approval).toBe(true);
  });
});

describe('buildDecisionNarrative: trade_offs', () => {
  it('maps negotiation_options into trade_offs (max 4)', () => {
    const result = buildDecisionNarrative({
      solverStatus: 'FEASIBLE',
      proof: OPTIMAL_PROOF,
      replayMetrics: POOR_REPLAY_METRICS,
      negotiationOptions: NEGOTIATION_OPTIONS
    });

    expect(result.trade_offs.length).toBe(2);
    expect(result.trade_offs[0].option_id).toBe('opt_004');
    expect(typeof result.trade_offs[0].title).toBe('string');
  });
});

describe('buildDecisionNarrative: evidence refs', () => {
  it('all evidence refs are non-empty strings', () => {
    const result = buildDecisionNarrative({
      solverStatus: 'OPTIMAL',
      proof: OPTIMAL_PROOF,
      replayMetrics: GOOD_REPLAY_METRICS
    });

    result.all_evidence_refs.forEach((ref) => {
      expect(typeof ref).toBe('string');
      expect(ref.length).toBeGreaterThan(0);
    });
  });
});

describe('buildDecisionNarrative: determinism', () => {
  it('same input yields same output when generatedAt fixed', () => {
    const args = {
      solverStatus: 'FEASIBLE',
      solverKpis: SAMPLE_SOLVER_KPIS,
      proof: BINDING_PROOF,
      replayMetrics: GOOD_REPLAY_METRICS,
      generatedAt: '2026-02-21T00:00:00.000Z'
    };

    const r1 = buildDecisionNarrative(args);
    const r2 = buildDecisionNarrative(args);

    expect(r1.situation.text).toBe(r2.situation.text);
    expect(r1.driver.text).toBe(r2.driver.text);
    expect(r1.recommendation.action_type).toBe(r2.recommendation.action_type);
    expect(r1.constraint_binding_summary).toEqual(r2.constraint_binding_summary);
  });
});

describe('buildDecisionNarrative: requires_approval', () => {
  it('INFEASIBLE => true', () => {
    expect(buildDecisionNarrative({ solverStatus: 'INFEASIBLE', proof: {} }).requires_approval).toBe(true);
  });

  it('SL < 80% => true', () => {
    const result = buildDecisionNarrative({
      solverStatus: 'FEASIBLE',
      proof: OPTIMAL_PROOF,
      replayMetrics: { with_plan: { service_level_proxy: 0.75 }, without_plan: {} }
    });
    expect(result.requires_approval).toBe(true);
  });

  it('SL >= 95% => false', () => {
    const result = buildDecisionNarrative({
      solverStatus: 'OPTIMAL',
      proof: OPTIMAL_PROOF,
      replayMetrics: GOOD_REPLAY_METRICS
    });
    expect(result.requires_approval).toBe(false);
  });
});

describe('buildDecisionNarrative: summary_text', () => {
  it('summary_text concatenates situation + driver + recommendation', () => {
    const result = buildDecisionNarrative({
      solverStatus: 'OPTIMAL',
      proof: OPTIMAL_PROOF,
      replayMetrics: GOOD_REPLAY_METRICS
    });

    expect(result.summary_text).toContain(result.situation.text);
    expect(result.summary_text).toContain(result.driver.text);
    expect(result.summary_text).toContain(result.recommendation.text);
  });
});

describe('buildDecisionNarrativeFromPlanResult', () => {
  it('extracts fields from planResult shape', () => {
    const narrative = buildDecisionNarrativeFromPlanResult({
      run: { id: 321 },
      solver_result: {
        status: 'FEASIBLE',
        kpis: SAMPLE_SOLVER_KPIS,
        proof: BINDING_PROOF,
        infeasible_reasons: []
      },
      replay_metrics: GOOD_REPLAY_METRICS,
      risk_adjustments: { triggered: true }
    });

    expect(narrative.run_id).toBe(321);
    expect(narrative.solver_status).toBe('FEASIBLE');
    expect(Array.isArray(narrative.constraint_binding_summary)).toBe(true);
  });

  it('passes explain_summary from solver_result', () => {
    const narrative = buildDecisionNarrativeFromPlanResult({
      run: { id: 999 },
      solver_result: {
        status: 'OPTIMAL',
        kpis: SAMPLE_SOLVER_KPIS,
        proof: BINDING_PROOF_WITH_SLACK,
        infeasible_reasons: [],
        explain_summary: SAMPLE_EXPLAIN_SUMMARY
      },
      replay_metrics: GOOD_REPLAY_METRICS
    });

    expect(narrative.explain_summary).not.toBeNull();
    expect(narrative.explain_summary.top_binding_constraint).toBe('budget_cap');
    expect(narrative.explain_summary.confidence).toBe('high');
  });
});

describe('buildDecisionNarrative: solver-provided slack and shadow_price', () => {
  it('driver text includes slack and shadow_price when provided by solver', () => {
    const result = buildDecisionNarrative({
      solverStatus: 'FEASIBLE',
      solverKpis: SAMPLE_SOLVER_KPIS,
      proof: BINDING_PROOF_WITH_SLACK,
      replayMetrics: GOOD_REPLAY_METRICS
    });

    expect(result.driver.category).toBe('binding_constraint');
    expect(result.driver.binding_constraint).toBe('budget_cap');
    expect(result.driver.slack).toBe(300.0);
    expect(result.driver.shadow_price).toBe(8.0);
    expect(result.driver.text).toContain('300');
    expect(result.driver.text).toContain('$8');
  });

  it('constraint_binding_summary propagates slack and natural_language from solver', () => {
    const result = buildDecisionNarrative({
      solverStatus: 'FEASIBLE',
      solverKpis: SAMPLE_SOLVER_KPIS,
      proof: BINDING_PROOF_WITH_SLACK,
      replayMetrics: GOOD_REPLAY_METRICS
    });

    const budgetSummary = result.constraint_binding_summary.find((c) => c.name === 'budget_cap');
    expect(budgetSummary.slack).toBe(300.0);
    expect(budgetSummary.slack_unit).toBe('USD');
    expect(budgetSummary.shadow_price_approx).toBe(8.0);
    expect(budgetSummary.natural_language).toContain('Budget cap');
  });
});

describe('buildDecisionNarrative: explain_summary trade_offs', () => {
  it('inserts key_relaxation as first trade-off', () => {
    const result = buildDecisionNarrative({
      solverStatus: 'FEASIBLE',
      solverKpis: SAMPLE_SOLVER_KPIS,
      proof: BINDING_PROOF_WITH_SLACK,
      replayMetrics: GOOD_REPLAY_METRICS,
      explainSummary: SAMPLE_EXPLAIN_SUMMARY
    });

    expect(result.trade_offs.length).toBeGreaterThanOrEqual(1);
    const first = result.trade_offs[0];
    expect(first.constraint).toBe('budget_cap');
    expect(first.nl_text).toContain('Relaxing budget cap');
    expect(first.roi_text).toBe('8.0x');
    expect(first.evidence_refs).toContain('explain_summary.key_relaxation');
  });

  it('includes explain_summary in output when provided', () => {
    const result = buildDecisionNarrative({
      solverStatus: 'FEASIBLE',
      proof: BINDING_PROOF_WITH_SLACK,
      replayMetrics: GOOD_REPLAY_METRICS,
      explainSummary: SAMPLE_EXPLAIN_SUMMARY
    });

    expect(result.explain_summary).toEqual(SAMPLE_EXPLAIN_SUMMARY);
  });

  it('explain_summary is null when not provided', () => {
    const result = buildDecisionNarrative({
      solverStatus: 'FEASIBLE',
      proof: BINDING_PROOF,
      replayMetrics: GOOD_REPLAY_METRICS
    });

    expect(result.explain_summary).toBeNull();
  });

  it('combines explain_summary relaxation with negotiation options', () => {
    const result = buildDecisionNarrative({
      solverStatus: 'FEASIBLE',
      proof: BINDING_PROOF_WITH_SLACK,
      replayMetrics: POOR_REPLAY_METRICS,
      negotiationOptions: NEGOTIATION_OPTIONS,
      explainSummary: SAMPLE_EXPLAIN_SUMMARY
    });

    expect(result.trade_offs.length).toBe(3);
    expect(result.trade_offs[0].constraint).toBe('budget_cap');
    expect(result.trade_offs[1].option_id).toBe('opt_004');
    expect(result.trade_offs[2].option_id).toBe('opt_005');
  });
});

describe('buildDecisionNarrative: business_label on objective terms', () => {
  it('driver uses business_label when available', () => {
    const proofWithLabels = {
      objective_terms: [
        { name: 'procurement_cost', value: 14900.0, business_label: 'Procurement volume' },
        { name: 'stockout_cost', value: 6500.0, business_label: 'Shortage exposure' }
      ],
      constraints_checked: []
    };
    const result = buildDecisionNarrative({
      solverStatus: 'OPTIMAL',
      proof: proofWithLabels,
      replayMetrics: GOOD_REPLAY_METRICS
    });

    expect(result.driver.category).toBe('cost_driver');
    expect(result.driver.text).toContain('Procurement volume');
  });
});
