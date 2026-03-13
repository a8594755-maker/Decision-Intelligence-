import { describe, it, expect } from 'vitest';
import {
  AGENT_ROLES,
  createWarRoomSession,
  addFinding,
  addRecommendation,
  runPlannerAgent,
  runRiskAgent,
  runNegotiationAgent,
  runApprovalAgent,
  runWarRoom,
} from './warRoomOrchestrator';

describe('createWarRoomSession', () => {
  it('creates a session with all fields', () => {
    const session = createWarRoomSession({ trigger: 'infeasible', planRunId: 42, userId: 'u1' });
    expect(session.session_id).toMatch(/^wr_/);
    expect(session.trigger).toBe('infeasible');
    expect(session.plan_run_id).toBe(42);
    expect(session.status).toBe('active');
    expect(session.findings).toEqual([]);
    expect(session.recommendations).toEqual([]);
  });
});

describe('addFinding / addRecommendation', () => {
  it('adds finding with auto-generated ID', () => {
    const session = createWarRoomSession({ trigger: 'test', planRunId: 1, userId: 'u1' });
    const finding = addFinding(session, {
      agent: AGENT_ROLES.PLANNER,
      severity: 'critical',
      title: 'Test',
      detail: 'Detail',
    });
    expect(finding.id).toBe('finding_1');
    expect(session.findings).toHaveLength(1);
  });

  it('adds recommendation', () => {
    const session = createWarRoomSession({ trigger: 'test', planRunId: 1, userId: 'u1' });
    const rec = addRecommendation(session, {
      agent: AGENT_ROLES.RISK_ANALYST,
      action_type: 'run_risk_plan',
      label: 'Replan',
      rationale: 'Risk too high',
      confidence: 0.9,
    });
    expect(rec.status).toBe('proposed');
    expect(session.recommendations).toHaveLength(1);
  });
});

describe('runPlannerAgent', () => {
  it('detects infeasible plan', () => {
    const result = runPlannerAgent({
      solverResult: { status: 'infeasible', infeasible_reasons: ['Budget too low'] },
    });
    expect(result.findings.some(f => f.severity === 'critical' && f.title.includes('Infeasible'))).toBe(true);
    expect(result.recommendations.some(r => r.action_type === 'start_negotiation')).toBe(true);
  });

  it('detects low service level', () => {
    const result = runPlannerAgent({
      solverResult: { status: 'optimal', kpis: { estimated_service_level: 0.75 } },
    });
    expect(result.findings.some(f => f.severity === 'critical' && f.title.includes('Service Level'))).toBe(true);
  });

  it('detects constraint violations', () => {
    const result = runPlannerAgent({
      solverResult: { status: 'optimal', kpis: {} },
      constraintCheck: { violations: [{ message: 'budget exceeded' }] },
    });
    expect(result.findings.some(f => f.title.includes('Violation'))).toBe(true);
  });

  it('detects stockout risk', () => {
    const result = runPlannerAgent({
      solverResult: { status: 'optimal', kpis: { stockout_units: 200 } },
    });
    expect(result.findings.some(f => f.title.includes('Stockout'))).toBe(true);
  });

  it('returns empty for healthy plan', () => {
    const result = runPlannerAgent({
      solverResult: { status: 'optimal', kpis: { estimated_service_level: 0.97, stockout_units: 0 } },
    });
    expect(result.findings).toHaveLength(0);
    expect(result.recommendations).toHaveLength(0);
  });
});

describe('runRiskAgent', () => {
  it('detects critical risk items', () => {
    const result = runRiskAgent({
      riskScores: [
        { entity_id: 'MAT-001', material_code: 'MAT-001', risk_score: 130, metrics: {} },
      ],
    });
    expect(result.findings.some(f => f.severity === 'critical')).toBe(true);
    expect(result.recommendations.some(r => r.action_type === 'run_risk_plan')).toBe(true);
  });

  it('detects high risk items (not critical)', () => {
    const result = runRiskAgent({
      riskScores: [
        { entity_id: 'MAT-002', material_code: 'MAT-002', risk_score: 90, metrics: {} },
      ],
    });
    expect(result.findings.some(f => f.severity === 'warning')).toBe(true);
    expect(result.recommendations).toHaveLength(0); // only critical triggers replan rec
  });

  it('handles empty risk scores', () => {
    const result = runRiskAgent({ riskScores: [] });
    expect(result.findings).toHaveLength(0);
  });
});

describe('runNegotiationAgent', () => {
  it('summarizes evaluated options', () => {
    const result = runNegotiationAgent({
      evaluationResult: {
        ranked_options: [
          { option_id: 'opt_001', title: 'Budget +10%', solver_status: 'optimal' },
          { option_id: 'opt_002', title: 'Relax MOQ', solver_status: 'infeasible' },
        ],
      },
      report: { recommended_option_id: 'opt_001' },
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].title).toContain('2 Options');
    expect(result.recommendations.some(r => r.action_type === 'apply_negotiation_option')).toBe(true);
  });

  it('returns empty for no negotiation data', () => {
    const result = runNegotiationAgent({});
    expect(result.findings).toHaveLength(0);
  });
});

describe('runApprovalAgent', () => {
  it('requires approval for critical findings', () => {
    const session = createWarRoomSession({ trigger: 'test', planRunId: 1, userId: 'u1' });
    addFinding(session, { agent: 'planner', severity: 'critical', title: 'Problem', detail: '' });

    const result = runApprovalAgent({ session, solverResult: { status: 'optimal' } });
    expect(result.recommendations.some(r => r.action_type === 'request_approval')).toBe(true);
  });

  it('detects pending approvals', () => {
    const session = createWarRoomSession({ trigger: 'test', planRunId: 1, userId: 'u1' });
    const result = runApprovalAgent({
      session,
      solverResult: { status: 'optimal' },
      previousApprovals: [{ approval_id: 'a1', status: 'PENDING' }],
    });
    expect(result.findings.some(f => f.title.includes('Pending'))).toBe(true);
  });

  it('does not require approval for healthy session', () => {
    const session = createWarRoomSession({ trigger: 'test', planRunId: 1, userId: 'u1' });
    const result = runApprovalAgent({ session, solverResult: { status: 'optimal' } });
    expect(result.findings.some(f => f.title === 'No Approval Required')).toBe(true);
  });
});

describe('runWarRoom', () => {
  it('runs full war room session', () => {
    const { session, messages } = runWarRoom({
      userId: 'u1',
      planRunId: 100,
      trigger: 'infeasible',
      solverResult: { status: 'infeasible', kpis: {}, infeasible_reasons: ['Budget'] },
    });

    expect(session.status).toBe('completed');
    expect(session.agents_activated).toContain(AGENT_ROLES.PLANNER);
    expect(session.agents_activated).toContain(AGENT_ROLES.APPROVAL_OFFICER);
    expect(session.findings.length).toBeGreaterThan(0);
    expect(messages.length).toBeGreaterThan(0);

    // Should have a war_room_card message
    const warRoomCard = messages.find(m => m.type === 'war_room_card');
    expect(warRoomCard).toBeTruthy();
    expect(warRoomCard.payload.overall_status).toBe('critical');
  });

  it('activates risk agent when risk data provided', () => {
    const { session } = runWarRoom({
      userId: 'u1',
      planRunId: 100,
      trigger: 'risk_critical',
      solverResult: { status: 'optimal', kpis: {} },
      riskScores: [{ entity_id: 'X', material_code: 'X', risk_score: 150, metrics: {} }],
    });

    expect(session.agents_activated).toContain(AGENT_ROLES.RISK_ANALYST);
    expect(session.findings.some(f => f.agent === AGENT_ROLES.RISK_ANALYST)).toBe(true);
  });

  it('activates negotiation agent when evaluation provided', () => {
    const { session } = runWarRoom({
      userId: 'u1',
      planRunId: 100,
      trigger: 'kpi_shortfall',
      solverResult: { status: 'optimal', kpis: {} },
      evaluationResult: {
        ranked_options: [{ option_id: 'opt_001', title: 'Test', solver_status: 'optimal' }],
      },
    });

    expect(session.agents_activated).toContain(AGENT_ROLES.NEGOTIATOR);
  });

  it('returns healthy status for good plan', () => {
    const { session } = runWarRoom({
      userId: 'u1',
      planRunId: 100,
      trigger: 'user_request',
      solverResult: { status: 'optimal', kpis: { estimated_service_level: 0.97 } },
    });

    const card = session.messages.find(m => m.type === 'war_room_card');
    expect(card.payload.overall_status).toBe('healthy');
  });
});
