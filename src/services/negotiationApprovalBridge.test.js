import { describe, it, expect, vi } from 'vitest';

vi.mock('./decisionTaskService', () => ({
  buildDecisionBundle: vi.fn(({ summary, recommendation, drivers, kpi_impact, evidence_refs, blockers, next_actions }) => ({
    version: 'v1',
    summary,
    recommendation,
    drivers: drivers || [],
    kpi_impact: kpi_impact || {},
    evidence_refs: evidence_refs || [],
    blockers: blockers || [],
    next_actions: next_actions || [],
    generated_at: new Date().toISOString(),
  })),
}));

vi.mock('./evidenceAssembler', () => ({
  assembleNegotiationEvidence: vi.fn(() => [
    { artifact_type: 'negotiation_evaluation', run_id: 100, label: 'Eval' },
  ]),
  mergeEvidenceRefs: vi.fn((...arrays) => arrays.flat().filter(Boolean)),
}));

import { buildNegotiationApprovalRequest, checkApprovalRequired } from './negotiationApprovalBridge';

describe('buildNegotiationApprovalRequest', () => {
  it('builds complete approval request', () => {
    const result = buildNegotiationApprovalRequest({
      selectedOption: { option_id: 'opt_001', title: 'Budget +10%', overrides: { budget_cap: 55000 } },
      evaluationResult: {
        ranked_options: [
          { option_id: 'opt_001', title: 'Budget +10%', solver_status: 'optimal', composite_score: 0.85 },
          { option_id: 'opt_002', title: 'Relax MOQ', solver_status: 'optimal' },
        ],
      },
      negotiationReport: { recommended_option_id: 'opt_001', summary: 'Test' },
      baseKpis: { estimated_total_cost: 50000, estimated_service_level: 0.92 },
      optionKpis: { estimated_total_cost: 55000, estimated_service_level: 0.96 },
      planRunId: 100,
      userId: 'u1',
    });

    expect(result.approvalPayload.option_id).toBe('opt_001');
    expect(result.approvalPayload.option_title).toBe('Budget +10%');
    expect(result.approvalPayload.evaluation_rank).toBe(1);
    expect(result.approvalPayload.requires_replan).toBe(true);
    expect(result.approvalPayload.kpi_impact.drivers.length).toBeGreaterThan(0);

    expect(result.decisionBundle).toBeTruthy();
    expect(result.decisionBundle.summary).toContain('Budget +10%');

    expect(result.messages.length).toBeGreaterThanOrEqual(3);
    expect(result.messages.some(m => m.type === 'decision_bundle_card')).toBe(true);
    expect(result.messages.some(m => m.type === 'negotiation_approval_card')).toBe(true);
  });

  it('identifies KPI improvements and degradations', () => {
    const result = buildNegotiationApprovalRequest({
      selectedOption: { option_id: 'opt_001', title: 'Test' },
      evaluationResult: { ranked_options: [{ option_id: 'opt_001' }] },
      negotiationReport: {},
      baseKpis: { cost: 100, service_level: 0.90, stockout_units: 50 },
      optionKpis: { cost: 120, service_level: 0.95, stockout_units: 30 },
      planRunId: 100,
      userId: 'u1',
    });

    const impact = result.approvalPayload.kpi_impact;
    // service_level improved (higher is better), stockout improved (lower is better)
    expect(impact.improved.length).toBe(2); // SL up, stockout down
    expect(impact.degraded.length).toBe(1); // cost up
  });

  it('includes CFR confidence when available', () => {
    const result = buildNegotiationApprovalRequest({
      selectedOption: { option_id: 'opt_001', title: 'Test' },
      evaluationResult: { ranked_options: [{ option_id: 'opt_001' }] },
      negotiationReport: {},
      baseKpis: {},
      optionKpis: {},
      planRunId: 100,
      userId: 'u1',
      cfrEnrichment: { cfr_action_probs: { opt_001: 0.42 } },
    });

    expect(result.approvalPayload.cfr_confidence).toBeCloseTo(0.42);
  });
});

describe('checkApprovalRequired', () => {
  it('requires approval for budget changes', () => {
    const result = checkApprovalRequired({
      kpiImpact: { degraded: [] },
      option: { overrides: { budget_cap: 55000 } },
    });
    expect(result.needsApproval).toBe(true);
    expect(result.reason).toContain('Budget');
  });

  it('requires approval for KPI degradation', () => {
    const result = checkApprovalRequired({
      kpiImpact: { degraded: [{ key: 'cost', label: 'cost' }] },
      option: { overrides: {} },
    });
    expect(result.needsApproval).toBe(true);
    expect(result.reason).toContain('degrade');
  });

  it('does not require approval when all KPIs improve', () => {
    const result = checkApprovalRequired({
      kpiImpact: { degraded: [] },
      option: { overrides: { moq_relaxation: 0.8 } },
    });
    expect(result.needsApproval).toBe(false);
    expect(result.reason).toContain('Auto-approval');
  });
});
