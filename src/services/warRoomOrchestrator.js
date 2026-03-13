/**
 * warRoomOrchestrator.js
 *
 * Multi-Agent War Room — coordinates specialized "agents" (planner, risk,
 * negotiation, approval) in a shared decision session.
 *
 * Each agent is a stateless function that:
 *   - Reads shared session state
 *   - Produces structured outputs (findings, recommendations, actions)
 *   - Does NOT call other agents directly (orchestrator handles sequencing)
 *
 * War Room Session Flow:
 *   1. Planner agent: run plan, detect issues
 *   2. Risk agent: evaluate risk exposure, suggest mitigations
 *   3. Negotiation agent: if needed, generate/evaluate options
 *   4. Approval agent: package decision with evidence for sign-off
 *
 * The orchestrator returns a flat array of chat messages representing
 * the full war room conversation.
 */

// ── Agent roles ─────────────────────────────────────────────────────────────

export const AGENT_ROLES = {
  PLANNER: 'planner',
  RISK_ANALYST: 'risk_analyst',
  NEGOTIATOR: 'negotiator',
  APPROVAL_OFFICER: 'approval_officer',
  COORDINATOR: 'coordinator',
};

const AGENT_LABELS = {
  [AGENT_ROLES.PLANNER]: 'Planning Agent',
  [AGENT_ROLES.RISK_ANALYST]: 'Risk Analyst',
  [AGENT_ROLES.NEGOTIATOR]: 'Negotiation Agent',
  [AGENT_ROLES.APPROVAL_OFFICER]: 'Approval Officer',
  [AGENT_ROLES.COORDINATOR]: 'War Room Coordinator',
};

// ── War Room Session ────────────────────────────────────────────────────────

/**
 * Create a new war room session.
 */
export function createWarRoomSession({ trigger, planRunId, userId, context = {} }) {
  return {
    session_id: `wr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    created_at: new Date().toISOString(),
    trigger,
    plan_run_id: planRunId,
    user_id: userId,
    context,
    status: 'active',
    agents_activated: [],
    findings: [],
    recommendations: [],
    actions_taken: [],
    messages: [],
  };
}

/**
 * Add an agent finding to the session.
 */
export function addFinding(session, { agent, severity, title, detail, evidence = [], suggested_action = null }) {
  const finding = {
    id: `finding_${session.findings.length + 1}`,
    agent,
    severity, // 'critical' | 'warning' | 'info'
    title,
    detail,
    evidence,
    suggested_action,
    timestamp: new Date().toISOString(),
  };
  session.findings.push(finding);
  return finding;
}

/**
 * Add a recommendation to the session.
 */
export function addRecommendation(session, { agent, action_type, label, rationale, confidence, requires_approval = false }) {
  const rec = {
    id: `rec_${session.recommendations.length + 1}`,
    agent,
    action_type,
    label,
    rationale,
    confidence,
    requires_approval,
    status: 'proposed',
    timestamp: new Date().toISOString(),
  };
  session.recommendations.push(rec);
  return rec;
}

// ── Agent functions ─────────────────────────────────────────────────────────

/**
 * Planner agent: analyzes plan result, identifies issues.
 */
export function runPlannerAgent({ solverResult, constraintCheck, replayMetrics }) {
  const findings = [];
  const recommendations = [];

  const status = solverResult?.status || 'unknown';
  const kpis = solverResult?.kpis || {};

  // Check solver status
  if (status === 'infeasible' || status === 'INFEASIBLE') {
    findings.push({
      agent: AGENT_ROLES.PLANNER,
      severity: 'critical',
      title: 'Plan Infeasible',
      detail: `Solver returned INFEASIBLE. ${(solverResult?.infeasible_reasons || []).join('; ') || 'Check constraints.'}`,
      suggested_action: 'start_negotiation',
    });
    recommendations.push({
      agent: AGENT_ROLES.PLANNER,
      action_type: 'start_negotiation',
      label: 'Start Negotiation',
      rationale: 'Plan is infeasible under current constraints. Negotiation can explore relaxations.',
      confidence: 0.95,
      requires_approval: false,
    });
  }

  // Check service level
  const sl = kpis.estimated_service_level ?? kpis.service_level_proxy;
  if (sl != null && sl < 0.90) {
    findings.push({
      agent: AGENT_ROLES.PLANNER,
      severity: sl < 0.80 ? 'critical' : 'warning',
      title: 'Service Level Below Target',
      detail: `Service level at ${(sl * 100).toFixed(1)}%, below 90% threshold.`,
      suggested_action: 'run_what_if',
    });
  }

  // Check constraint violations
  const violations = constraintCheck?.violations || [];
  if (violations.length > 0) {
    findings.push({
      agent: AGENT_ROLES.PLANNER,
      severity: 'warning',
      title: `${violations.length} Constraint Violation(s)`,
      detail: violations.map(v => v.message || v.constraint || String(v)).join('; '),
      suggested_action: 'review_constraints',
    });
  }

  // Check stockouts
  const stockouts = kpis.stockout_units ?? replayMetrics?.total_stockout_units;
  if (stockouts != null && stockouts > 0) {
    findings.push({
      agent: AGENT_ROLES.PLANNER,
      severity: stockouts > 100 ? 'critical' : 'warning',
      title: 'Stockout Risk',
      detail: `${stockouts} units at risk of stockout.`,
      suggested_action: 'run_risk_plan',
    });
  }

  return { findings, recommendations };
}

/**
 * Risk analyst agent: evaluates risk exposure and suggests mitigations.
 */
export function runRiskAgent({ riskScores = [], riskAdjustments = null, proactiveAlerts = null }) {
  const findings = [];
  const recommendations = [];

  // High-risk entities
  const highRisk = riskScores.filter(r => (r.risk_score || 0) > 80);
  const criticalRisk = riskScores.filter(r => (r.risk_score || 0) > 120);

  if (criticalRisk.length > 0) {
    findings.push({
      agent: AGENT_ROLES.RISK_ANALYST,
      severity: 'critical',
      title: `${criticalRisk.length} Critical Risk Item(s)`,
      detail: criticalRisk.slice(0, 3).map(r =>
        `${r.material_code || r.entity_id} (score: ${r.risk_score})`
      ).join(', '),
      suggested_action: 'run_risk_plan',
    });
    recommendations.push({
      agent: AGENT_ROLES.RISK_ANALYST,
      action_type: 'run_risk_plan',
      label: 'Run Risk-Aware Replan',
      rationale: `${criticalRisk.length} items exceed critical risk threshold (120). Risk-aware planning adjusts lead times, safety stock, and penalties.`,
      confidence: 0.9,
      requires_approval: false,
    });
  } else if (highRisk.length > 0) {
    findings.push({
      agent: AGENT_ROLES.RISK_ANALYST,
      severity: 'warning',
      title: `${highRisk.length} High-Risk Item(s)`,
      detail: highRisk.slice(0, 3).map(r =>
        `${r.material_code || r.entity_id} (score: ${r.risk_score})`
      ).join(', '),
      suggested_action: 'run_risk_plan',
    });
  }

  // Proactive alerts
  const alerts = proactiveAlerts?.alerts || [];
  const criticalAlerts = alerts.filter(a => a.severity === 'critical');
  if (criticalAlerts.length > 0) {
    findings.push({
      agent: AGENT_ROLES.RISK_ANALYST,
      severity: 'critical',
      title: `${criticalAlerts.length} Critical Alert(s)`,
      detail: criticalAlerts.slice(0, 2).map(a => a.message || a.title || 'Critical alert').join('; '),
    });
  }

  // Risk adjustments summary
  if (riskAdjustments?.summary) {
    const adjusted = riskAdjustments.adjusted_params || {};
    const rulesApplied = (riskAdjustments.rules || []).filter(r => r.applied);
    if (rulesApplied.length > 0) {
      findings.push({
        agent: AGENT_ROLES.RISK_ANALYST,
        severity: 'info',
        title: `${rulesApplied.length} Risk Rule(s) Active`,
        detail: rulesApplied.map(r => r.rule_id || r.name).join(', '),
      });
    }
  }

  return { findings, recommendations };
}

/**
 * Negotiation agent: summarizes negotiation state and options.
 */
export function runNegotiationAgent({ negotiationState = null, evaluationResult = null, report = null }) {
  const findings = [];
  const recommendations = [];

  if (!negotiationState && !evaluationResult) {
    return { findings, recommendations };
  }

  const options = evaluationResult?.ranked_options || [];
  const feasibleOptions = options.filter(o => o.solver_status !== 'infeasible' && o.solver_status !== 'INFEASIBLE');
  const recommended = report?.recommended_option_id || (feasibleOptions[0]?.option_id);

  if (options.length > 0) {
    findings.push({
      agent: AGENT_ROLES.NEGOTIATOR,
      severity: 'info',
      title: `${options.length} Options Evaluated, ${feasibleOptions.length} Feasible`,
      detail: feasibleOptions.length > 0
        ? `Top option: ${feasibleOptions[0]?.title || feasibleOptions[0]?.option_id}. ${report?.summary || ''}`
        : 'No feasible options found. Consider adjusting constraints further.',
    });
  }

  if (recommended && feasibleOptions.length > 0) {
    const recOption = feasibleOptions.find(o => o.option_id === recommended) || feasibleOptions[0];
    recommendations.push({
      agent: AGENT_ROLES.NEGOTIATOR,
      action_type: 'apply_negotiation_option',
      label: `Apply "${recOption.title || recOption.option_id}"`,
      rationale: report?.recommendation_rationale || 'Best feasible option based on evaluation ranking.',
      confidence: recOption.composite_score || 0.7,
      requires_approval: true,
    });
  }

  return { findings, recommendations };
}

/**
 * Approval agent: determines if approval is needed and packages the request.
 */
export function runApprovalAgent({ session, solverResult, previousApprovals = [] }) {
  const findings = [];
  const recommendations = [];

  const criticalFindings = session.findings.filter(f => f.severity === 'critical');
  const hasNegotiationRecs = session.recommendations.some(r => r.requires_approval);
  const solverStatus = solverResult?.status || 'unknown';
  const pendingApprovals = previousApprovals.filter(a => a.status === 'PENDING');

  // Determine if approval is needed
  const needsApproval = criticalFindings.length > 0 || hasNegotiationRecs || solverStatus === 'infeasible';

  if (pendingApprovals.length > 0) {
    findings.push({
      agent: AGENT_ROLES.APPROVAL_OFFICER,
      severity: 'warning',
      title: `${pendingApprovals.length} Pending Approval(s)`,
      detail: 'Previous approvals are still pending. Resolve before submitting new requests.',
    });
  }

  if (needsApproval) {
    const approvalReason = criticalFindings.length > 0
      ? `${criticalFindings.length} critical finding(s) require human review.`
      : hasNegotiationRecs
        ? 'Negotiation outcome requires approval before constraint changes.'
        : 'Plan status requires manual sign-off.';

    recommendations.push({
      agent: AGENT_ROLES.APPROVAL_OFFICER,
      action_type: 'request_approval',
      label: 'Request Human Approval',
      rationale: approvalReason,
      confidence: 0.95,
      requires_approval: false, // meta: this IS the approval action
    });

    findings.push({
      agent: AGENT_ROLES.APPROVAL_OFFICER,
      severity: 'info',
      title: 'Approval Required',
      detail: approvalReason,
    });
  } else {
    findings.push({
      agent: AGENT_ROLES.APPROVAL_OFFICER,
      severity: 'info',
      title: 'No Approval Required',
      detail: 'Plan meets all thresholds. Can proceed without manual approval.',
    });
  }

  return { findings, recommendations };
}

// ── Main orchestration ──────────────────────────────────────────────────────

/**
 * Run a full war room session.
 *
 * @param {object} params
 * @param {string}  params.userId
 * @param {number}  params.planRunId
 * @param {string}  params.trigger          - What triggered the war room ('infeasible', 'risk_critical', 'kpi_shortfall', 'user_request')
 * @param {object}  params.solverResult     - Plan solver output
 * @param {object}  [params.constraintCheck]
 * @param {object}  [params.replayMetrics]
 * @param {Array}   [params.riskScores]
 * @param {object}  [params.riskAdjustments]
 * @param {object}  [params.proactiveAlerts]
 * @param {object}  [params.negotiationState]
 * @param {object}  [params.evaluationResult]
 * @param {object}  [params.negotiationReport]
 * @param {Array}   [params.previousApprovals]
 * @returns {object} { session, messages }
 */
export function runWarRoom({
  userId,
  planRunId,
  trigger,
  solverResult,
  constraintCheck,
  replayMetrics,
  riskScores = [],
  riskAdjustments = null,
  proactiveAlerts = null,
  negotiationState = null,
  evaluationResult = null,
  negotiationReport = null,
  previousApprovals = [],
}) {
  const session = createWarRoomSession({ trigger, planRunId, userId });
  const messages = [];

  // Opening message
  messages.push(buildAgentMessage(AGENT_ROLES.COORDINATOR, `War Room activated for plan #${planRunId} (trigger: ${trigger}).`));

  // 1. Planner agent
  session.agents_activated.push(AGENT_ROLES.PLANNER);
  const plannerResult = runPlannerAgent({ solverResult, constraintCheck, replayMetrics });
  plannerResult.findings.forEach(f => addFinding(session, f));
  plannerResult.recommendations.forEach(r => addRecommendation(session, r));

  if (plannerResult.findings.length > 0) {
    messages.push(buildAgentMessage(
      AGENT_ROLES.PLANNER,
      plannerResult.findings.map(f => `[${f.severity.toUpperCase()}] ${f.title}: ${f.detail}`).join('\n')
    ));
  } else {
    messages.push(buildAgentMessage(AGENT_ROLES.PLANNER, 'Plan looks healthy. No issues detected.'));
  }

  // 2. Risk agent
  if (riskScores.length > 0 || proactiveAlerts || riskAdjustments) {
    session.agents_activated.push(AGENT_ROLES.RISK_ANALYST);
    const riskResult = runRiskAgent({ riskScores, riskAdjustments, proactiveAlerts });
    riskResult.findings.forEach(f => addFinding(session, f));
    riskResult.recommendations.forEach(r => addRecommendation(session, r));

    if (riskResult.findings.length > 0) {
      messages.push(buildAgentMessage(
        AGENT_ROLES.RISK_ANALYST,
        riskResult.findings.map(f => `[${f.severity.toUpperCase()}] ${f.title}: ${f.detail}`).join('\n')
      ));
    }
  }

  // 3. Negotiation agent (if negotiation data available)
  if (negotiationState || evaluationResult) {
    session.agents_activated.push(AGENT_ROLES.NEGOTIATOR);
    const negResult = runNegotiationAgent({
      negotiationState,
      evaluationResult,
      report: negotiationReport,
    });
    negResult.findings.forEach(f => addFinding(session, f));
    negResult.recommendations.forEach(r => addRecommendation(session, r));

    if (negResult.findings.length > 0) {
      messages.push(buildAgentMessage(
        AGENT_ROLES.NEGOTIATOR,
        negResult.findings.map(f => `[${f.severity.toUpperCase()}] ${f.title}: ${f.detail}`).join('\n')
      ));
    }
  }

  // 4. Approval agent
  session.agents_activated.push(AGENT_ROLES.APPROVAL_OFFICER);
  const approvalResult = runApprovalAgent({ session, solverResult, previousApprovals });
  approvalResult.findings.forEach(f => addFinding(session, f));
  approvalResult.recommendations.forEach(r => addRecommendation(session, r));

  messages.push(buildAgentMessage(
    AGENT_ROLES.APPROVAL_OFFICER,
    approvalResult.findings.map(f => `[${f.severity.toUpperCase()}] ${f.title}: ${f.detail}`).join('\n')
  ));

  // 5. Build war room summary card
  const summaryCard = buildWarRoomSummaryCard(session);
  messages.push({
    role: 'ai',
    type: 'war_room_card',
    payload: summaryCard,
    timestamp: new Date().toISOString(),
  });

  session.messages = messages;
  session.status = 'completed';

  return { session, messages };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildAgentMessage(agentRole, content) {
  return {
    role: 'ai',
    content: `**[${AGENT_LABELS[agentRole] || agentRole}]** ${content}`,
    agent_role: agentRole,
    timestamp: new Date().toISOString(),
  };
}

function buildWarRoomSummaryCard(session) {
  const criticalCount = session.findings.filter(f => f.severity === 'critical').length;
  const warningCount = session.findings.filter(f => f.severity === 'warning').length;
  const infoCount = session.findings.filter(f => f.severity === 'info').length;

  return {
    session_id: session.session_id,
    trigger: session.trigger,
    plan_run_id: session.plan_run_id,
    agents_activated: session.agents_activated,
    findings_summary: {
      critical: criticalCount,
      warning: warningCount,
      info: infoCount,
      total: session.findings.length,
    },
    findings: session.findings,
    recommendations: session.recommendations,
    overall_status: criticalCount > 0 ? 'critical' : warningCount > 0 ? 'needs_attention' : 'healthy',
    created_at: session.created_at,
  };
}

export default {
  AGENT_ROLES,
  AGENT_LABELS,
  createWarRoomSession,
  addFinding,
  addRecommendation,
  runPlannerAgent,
  runRiskAgent,
  runNegotiationAgent,
  runApprovalAgent,
  runWarRoom,
};
