/**
 * decisionTaskService.js
 *
 * Provides structured objects for the "decision copilot" reply pattern:
 *
 *   decision_task   — represents a single executable task in the decision pipeline
 *   decision_bundle — the complete reply packet: summary + recommendation + evidence + next actions
 *
 * These are pure data factories — no React, no side-effects.
 */

// ── decision_task ────────────────────────────────────────────────────────────

/**
 * Task types mapped to the platform capabilities they invoke.
 */
export const TASK_TYPES = {
  RUN_FORECAST:        'run_forecast',
  RUN_PLAN:            'run_plan',
  RUN_RISK_PLAN:       'run_risk_plan',
  RUN_WORKFLOW_A:      'run_workflow_a',
  RUN_WORKFLOW_B:      'run_workflow_b',
  RUN_SCENARIO:        'run_scenario',
  RUN_SIMULATION:      'run_simulation',
  COMPARE_PLANS:       'compare_plans',
  COMPARE_SCENARIOS:   'compare_scenarios',
  START_NEGOTIATION:   'start_negotiation',
  REQUEST_APPROVAL:    'request_approval',
  BUILD_EVIDENCE:      'build_evidence',
  CAUSAL_ANALYSIS:     'causal_analysis',
  RISK_DEEP_DIVE:      'risk_deep_dive',
};

const TASK_STATUS = { PENDING: 'pending', RUNNING: 'running', COMPLETED: 'completed', FAILED: 'failed', BLOCKED: 'blocked' };

/**
 * Create a decision_task object.
 *
 * @param {Object} params
 * @param {string}  params.type           - One of TASK_TYPES
 * @param {string}  params.label          - Human label (e.g. "Generate risk-aware plan")
 * @param {Object}  [params.inputs]       - Required inputs for execution
 * @param {Array}   [params.dependencies] - Task IDs this depends on
 * @param {string}  [params.status]       - Initial status
 * @returns {Object} decision_task
 */
export function createDecisionTask({
  type,
  label,
  inputs = {},
  dependencies = [],
  status = TASK_STATUS.PENDING,
}) {
  return {
    task_id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type,
    label,
    inputs,
    dependencies,
    status,
    linked_run_ids: [],
    output_artifacts: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

/**
 * Update a task's status and optionally link run IDs / artifacts.
 *
 * @param {Object} task
 * @param {Object} patch - { status?, linked_run_ids?, output_artifacts? }
 * @returns {Object} Updated task (new reference)
 */
export function updateDecisionTask(task, patch) {
  return {
    ...task,
    ...patch,
    updated_at: new Date().toISOString(),
  };
}

// ── decision_bundle ──────────────────────────────────────────────────────────

/**
 * Build a decision_bundle — the structured reply that Chat sends back to the user.
 *
 * Structure:
 *   summary           — 1-2 sentence conclusion
 *   recommendation     — what the system recommends doing next
 *   drivers            — top factors driving the recommendation
 *   kpi_impact         — quantified KPI changes
 *   evidence_refs      — list of artifact references supporting the recommendation
 *   blockers           — unresolved issues preventing next step
 *   next_actions       — ordered list of suggested next actions (from chatActionRegistry)
 *
 * @param {Object} params
 * @param {string}  params.summary
 * @param {Object}  [params.recommendation]  - { text, action_type, confidence }
 * @param {Array}   [params.drivers]         - [{ label, value, direction }]
 * @param {Object}  [params.kpi_impact]      - { service_level, cost, stockout, ... }
 * @param {Array}   [params.evidence_refs]   - [{ artifact_type, run_id, label, path }]
 * @param {Array}   [params.blockers]        - [{ blocker_id, description, resolution_hint }]
 * @param {Array}   [params.next_actions]    - [{ action_id, label, description, priority }]
 * @param {Object}  [params.context_snapshot] - The chat_session_context at time of generation
 * @returns {Object} decision_bundle
 */
export function buildDecisionBundle({
  summary,
  recommendation,
  drivers = [],
  kpi_impact = {},
  evidence_refs = [],
  blockers = [],
  next_actions = [],
  context_snapshot = null,
}) {
  return {
    version: 'v1',
    generated_at: new Date().toISOString(),
    summary: summary || '',
    recommendation: recommendation || null,
    drivers,
    kpi_impact,
    evidence_refs,
    blockers,
    next_actions,
    context_snapshot: context_snapshot ? {
      view: context_snapshot.view,
      workflow_stage: context_snapshot.workflow?.stage,
      baseline_run_id: context_snapshot.baseline?.run_id || null,
    } : null,
  };
}

/**
 * Build a decision_bundle from a completed plan run and its artifacts.
 *
 * @param {Object} params
 * @param {Object} params.solverResult   - From chatPlanningService
 * @param {Object} params.sessionCtx     - Session context
 * @param {Array}  params.evidence       - Assembled evidence refs
 * @param {Array}  params.nextActions    - From suggestNextActions()
 * @returns {Object} decision_bundle
 */
export function buildPlanDecisionBundle({ solverResult, sessionCtx, evidence, nextActions }) {
  const kpis = solverResult?.kpis || {};
  const status = solverResult?.status || 'unknown';
  const prevKpis = sessionCtx?.previous_plan?.kpis || {};

  const drivers = [];
  if (status === 'infeasible') {
    drivers.push({
      label: 'Plan Infeasibility',
      value: (solverResult?.infeasible_reasons || []).join('; ') || 'Constraints too tight',
      direction: 'negative',
    });
  }
  if (kpis.estimated_service_level != null) {
    drivers.push({
      label: 'Service Level',
      value: `${(kpis.estimated_service_level * 100).toFixed(1)}%`,
      direction: kpis.estimated_service_level >= 0.95 ? 'positive' : 'neutral',
    });
  }
  if (kpis.estimated_total_cost != null) {
    drivers.push({
      label: 'Estimated Cost',
      value: `$${Number(kpis.estimated_total_cost).toLocaleString()}`,
      direction: 'neutral',
    });
  }

  const kpiImpact = {};
  if (prevKpis.estimated_service_level != null && kpis.estimated_service_level != null) {
    kpiImpact.service_level_delta = kpis.estimated_service_level - prevKpis.estimated_service_level;
  }
  if (prevKpis.estimated_total_cost != null && kpis.estimated_total_cost != null) {
    kpiImpact.cost_delta = kpis.estimated_total_cost - prevKpis.estimated_total_cost;
  }
  if (prevKpis.estimated_stockout_units != null && kpis.estimated_stockout_units != null) {
    kpiImpact.stockout_delta = kpis.estimated_stockout_units - prevKpis.estimated_stockout_units;
  }

  const blockers = [];
  if (status === 'infeasible') {
    blockers.push({
      blocker_id: 'infeasible_plan',
      description: 'Current constraints produce an infeasible plan.',
      resolution_hint: 'Consider relaxing budget or service level, or run negotiation.',
    });
  }

  let summary;
  if (status === 'optimal' || status === 'feasible') {
    summary = `Plan generated successfully with ${(kpis.estimated_service_level * 100).toFixed(1)}% service level and $${Number(kpis.estimated_total_cost).toLocaleString()} estimated cost.`;
  } else if (status === 'infeasible') {
    summary = `Plan is infeasible under current constraints. ${(solverResult?.infeasible_reasons || []).slice(0, 2).join('. ')}.`;
  } else {
    summary = `Plan completed with status: ${status}.`;
  }

  let recommendation = null;
  if (status === 'infeasible') {
    recommendation = {
      text: 'Start negotiation to explore feasible trade-off options.',
      action_type: 'start_negotiation',
      confidence: 0.9,
    };
  } else if (status === 'optimal' || status === 'feasible') {
    recommendation = {
      text: 'Plan looks good. Run a what-if scenario to stress-test, or submit for approval.',
      action_type: 'run_what_if',
      confidence: 0.7,
    };
  }

  return buildDecisionBundle({
    summary,
    recommendation,
    drivers,
    kpi_impact: kpiImpact,
    evidence_refs: evidence || [],
    blockers,
    next_actions: nextActions || [],
  });
}

/**
 * Build a decision_bundle from a scenario comparison result.
 *
 * @param {Object} params
 * @param {Object} params.comparison  - scenario_comparison artifact payload
 * @param {Array}  params.evidence    - Evidence refs
 * @param {Array}  params.nextActions - Suggested next actions
 * @returns {Object} decision_bundle
 */
export function buildScenarioDecisionBundle({ comparison, evidence, nextActions }) {
  const kpis = comparison?.kpis || {};
  const delta = kpis.delta || {};
  const overrides = comparison?.overrides || {};

  const overrideDesc = Object.entries(overrides)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');

  const drivers = [];
  if (delta.service_level_proxy != null) {
    drivers.push({
      label: 'Service Level Change',
      value: `${delta.service_level_proxy > 0 ? '+' : ''}${(delta.service_level_proxy * 100).toFixed(2)} pp`,
      direction: delta.service_level_proxy >= 0 ? 'positive' : 'negative',
    });
  }
  if (delta.stockout_units != null) {
    drivers.push({
      label: 'Stockout Change',
      value: `${delta.stockout_units > 0 ? '+' : ''}${delta.stockout_units} units`,
      direction: delta.stockout_units <= 0 ? 'positive' : 'negative',
    });
  }
  if (delta.estimated_total_cost != null) {
    drivers.push({
      label: 'Cost Change',
      value: `${delta.estimated_total_cost > 0 ? '+' : ''}$${Number(delta.estimated_total_cost).toLocaleString()}`,
      direction: delta.estimated_total_cost <= 0 ? 'positive' : 'negative',
    });
  }

  const summary = `Scenario with ${overrideDesc || 'adjusted parameters'} ` +
    `shows ${delta.service_level_proxy != null ?
      `service level ${delta.service_level_proxy >= 0 ? 'improving' : 'declining'} by ${Math.abs(delta.service_level_proxy * 100).toFixed(2)} pp` :
      'mixed KPI impact'
    }.`;

  return buildDecisionBundle({
    summary,
    recommendation: {
      text: 'Review the trade-offs and decide whether to adopt this scenario or explore alternatives.',
      action_type: 'compare_scenarios',
      confidence: 0.6,
    },
    drivers,
    kpi_impact: delta,
    evidence_refs: evidence || [],
    next_actions: nextActions || [],
  });
}

export { TASK_STATUS };

export default {
  TASK_TYPES,
  TASK_STATUS,
  createDecisionTask,
  updateDecisionTask,
  buildDecisionBundle,
  buildPlanDecisionBundle,
  buildScenarioDecisionBundle,
};
