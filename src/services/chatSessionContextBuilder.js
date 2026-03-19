/**
 * chatSessionContextBuilder.js
 *
 * Builds a rich, snapshot-in-time context object that is injected into every
 * Chat turn so the AI (and downstream services) know:
 *
 *   • Which page / view the user is currently on
 *   • Which entities (supplier, material, plant, SKU) are selected
 *   • What the active baseline plan and forecast are
 *   • Whether a scenario / what-if is in progress
 *   • Current workflow stage and unresolved blockers
 *   • Active risk filters & alert state
 *   • Negotiation state
 *   • User role (for governance-aware replies)
 *
 * The output (`chat_session_context`) is a pure-data snapshot — no React, no
 * side-effects. It is designed to be cheap to build on every keystroke/submit.
 */

// ── Route → view mapping ────────────────────────────────────────────────────

const ROUTE_VIEW_MAP = {
  '/':                     'home',
  '/chat':                 'decision_support',
  '/decision-support':     'decision_support',
  '/risk':                 'risk_center',
  '/risk-dashboard':       'risk_center',
  '/digital-twin':         'digital_twin',
  '/synthetic-erp':        'synthetic_erp',
  '/topology':             'topology',
  '/plan-studio':          'plan_studio',
  '/negotiation':          'negotiation',
  '/settings':             'settings',
};

function resolveView(pathname) {
  if (!pathname) return 'unknown';
  const normalized = pathname.replace(/\/+$/, '') || '/';
  return ROUTE_VIEW_MAP[normalized] || 'unknown';
}

// ── Readiness checks ─────────────────────────────────────────────────────────

function assessWorkflowReadiness(sessionCtx) {
  const missing = [];
  if (!sessionCtx?.dataset?.profile_id) missing.push('dataset');
  if (!sessionCtx?.dataset?.contract_confirmed) missing.push('contract_confirmation');
  return {
    ready: missing.length === 0,
    missing,
  };
}

function resolveWorkflowStage(sessionCtx) {
  if (!sessionCtx) return 'no_session';
  if (!sessionCtx.dataset?.profile_id) return 'awaiting_dataset';
  if (!sessionCtx.dataset?.contract_confirmed) return 'awaiting_contract';
  if (!sessionCtx.forecast?.run_id) return 'ready_for_forecast';
  if (!sessionCtx.plan?.run_id) return 'ready_for_plan';
  if (sessionCtx.plan?.solver_status === 'infeasible') return 'plan_infeasible';
  if (sessionCtx.negotiation?.round > 0 && !sessionCtx.negotiation?.applied_option_id) return 'negotiation_active';
  const pendingCount = (sessionCtx.pending_approvals || []).filter(a => a.status === 'PENDING').length;
  if (pendingCount > 0) return 'awaiting_approval';
  return 'plan_complete';
}

// ── Selection state helpers ──────────────────────────────────────────────────

function extractSelectionFromCanvasState(canvasState) {
  if (!canvasState) return null;
  const selection = {};

  if (canvasState.selectedNodeId) selection.topology_node = canvasState.selectedNodeId;
  if (canvasState.selectedTab) selection.active_tab = canvasState.selectedTab;
  if (canvasState.selectedSku) selection.sku = canvasState.selectedSku;
  if (canvasState.selectedPlant) selection.plant_id = canvasState.selectedPlant;
  if (canvasState.chartDateRange) selection.date_range = canvasState.chartDateRange;
  if (canvasState.riskFilters) selection.risk_filters = canvasState.riskFilters;

  return Object.keys(selection).length > 0 ? selection : null;
}

// ── Main builder ─────────────────────────────────────────────────────────────

/**
 * Build a full chat_session_context snapshot.
 *
 * @param {Object} params
 * @param {string}  params.pathname          - Current route pathname (from useLocation)
 * @param {Object}  params.sessionCtx        - From useSessionContext().context
 * @param {Object}  [params.canvasState]     - Current canvas/chart selection state
 * @param {Object}  [params.activeDataset]   - Active dataset context { dataset_profile_id, ... }
 * @param {number}  [params.baselineRunId]   - Resolved baseline plan run_id
 * @param {Object}  [params.scenarioState]   - Active scenario state (overrides, status, comparison)
 * @param {string}  [params.userRole]        - User role for governance: 'planner' | 'approver' | 'admin' | 'viewer'
 * @param {Object}  [params.riskFilters]     - Active risk dashboard filter state
 * @param {Array}   [params.recentIntents]   - Last N intents from session history
 * @returns {Object} chat_session_context
 */
export function buildChatSessionContext({
  pathname,
  sessionCtx,
  canvasState,
  activeDataset: _activeDataset,
  baselineRunId,
  scenarioState,
  userRole,
  riskFilters,
  recentIntents,
} = {}) {
  const view = resolveView(pathname);
  const workflowStage = resolveWorkflowStage(sessionCtx);
  const readiness = assessWorkflowReadiness(sessionCtx);
  const selection = extractSelectionFromCanvasState(canvasState);

  return {
    // ── Location / view ──
    route: pathname || '/',
    view,

    // ── Selected entities ──
    selection,

    // ── Dataset ──
    dataset: sessionCtx?.dataset?.profile_id ? {
      profile_id: sessionCtx.dataset.profile_id,
      profile_summary: sessionCtx.dataset.profile_summary || null,
      contract_confirmed: Boolean(sessionCtx.dataset.contract_confirmed),
    } : null,

    // ── Active baseline plan ──
    baseline: sessionCtx?.plan?.run_id ? {
      run_id: baselineRunId || sessionCtx.plan.run_id,
      solver_status: sessionCtx.plan.solver_status,
      kpis: sessionCtx.plan.kpis || {},
      risk_mode: sessionCtx.plan.risk_mode || null,
      created_at: sessionCtx.plan.created_at || null,
    } : null,

    // ── Previous plan (for comparison) ──
    previous_plan: sessionCtx?.previous_plan?.run_id ? {
      run_id: sessionCtx.previous_plan.run_id,
      kpis: sessionCtx.previous_plan.kpis || {},
    } : null,

    // ── Forecast ──
    forecast: sessionCtx?.forecast?.run_id ? {
      run_id: sessionCtx.forecast.run_id,
      key_metrics: sessionCtx.forecast.key_metrics || {},
      model_used: sessionCtx.forecast.model_used || null,
    } : null,

    // ── Scenario / What-If ──
    scenario: scenarioState ? {
      status: scenarioState.status || null,
      overrides: scenarioState.overrides || {},
      base_run_id: scenarioState.base_run_id || null,
      scenario_run_id: scenarioState.scenario_run_id || null,
    } : null,

    // ── Workflow stage ──
    workflow: {
      stage: workflowStage,
      readiness,
      active_overrides: sessionCtx?.overrides || {},
    },

    // ── Negotiation ──
    negotiation: sessionCtx?.negotiation?.round > 0 ? {
      round: sessionCtx.negotiation.round,
      trigger: sessionCtx.negotiation.trigger,
      applied_option_id: sessionCtx.negotiation.applied_option_id || null,
      has_evaluation: Boolean(sessionCtx.negotiation.evaluation),
    } : null,

    // ── Approvals ──
    pending_approvals: (sessionCtx?.pending_approvals || [])
      .filter(a => a.status === 'PENDING')
      .map(a => ({ approval_id: a.approval_id, run_id: a.run_id })),

    // ── Risk / alerts ──
    risk: {
      filters: riskFilters || null,
      active_alerts: sessionCtx?.active_alerts?.alert_ids?.length || 0,
      dismissed_alerts: sessionCtx?.active_alerts?.dismissed_ids?.length || 0,
      supplier_event_count: sessionCtx?.supplier_events?.event_count || 0,
      last_risk_delta: sessionCtx?.supplier_events?.last_risk_delta || null,
    },

    // ── User context ──
    user_role: userRole || 'planner',

    // ── Recent intents (for multi-turn awareness) ──
    recent_intents: (recentIntents || sessionCtx?.intent_history || [])
      .slice(-5)
      .map(h => ({ intent: h.intent, timestamp: h.timestamp })),

    // ── Metadata ──
    built_at: new Date().toISOString(),
  };
}

/**
 * Build a compact text summary of the chat context for LLM prompt injection.
 * Keeps token count low while providing maximum signal.
 *
 * @param {Object} ctx - Output of buildChatSessionContext()
 * @returns {string}
 */
export function buildContextSummaryForPrompt(ctx) {
  if (!ctx) return 'No chat context available.';

  const lines = [];

  lines.push(`View: ${ctx.view} (${ctx.route})`);

  if (ctx.selection) {
    const parts = Object.entries(ctx.selection)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(', ');
    lines.push(`Selection: ${parts}`);
  }

  if (ctx.dataset) {
    lines.push(`Dataset: profile_id=${ctx.dataset.profile_id}${ctx.dataset.contract_confirmed ? ' (confirmed)' : ' (unconfirmed)'}`);
  } else {
    lines.push('Dataset: none');
  }

  if (ctx.forecast) {
    const m = ctx.forecast.key_metrics || {};
    lines.push(`Forecast: run_id=${ctx.forecast.run_id}, MAPE=${m.mape ?? '?'}, model=${ctx.forecast.model_used ?? '?'}`);
  }

  if (ctx.baseline) {
    const k = ctx.baseline.kpis || {};
    lines.push(`Baseline Plan: run_id=${ctx.baseline.run_id}, status=${ctx.baseline.solver_status ?? '?'}, cost=$${k.estimated_total_cost ?? '?'}, SL=${k.estimated_service_level ?? '?'}, risk_mode=${ctx.baseline.risk_mode ?? 'off'}`);
  }

  if (ctx.previous_plan) {
    lines.push(`Previous Plan: run_id=${ctx.previous_plan.run_id} (can compare)`);
  }

  if (ctx.scenario) {
    lines.push(`Active Scenario: status=${ctx.scenario.status}, overrides=${JSON.stringify(ctx.scenario.overrides)}`);
  }

  lines.push(`Workflow: stage=${ctx.workflow.stage}, ready=${ctx.workflow.readiness.ready}${ctx.workflow.readiness.missing.length ? ', missing=[' + ctx.workflow.readiness.missing.join(',') + ']' : ''}`);

  if (ctx.negotiation) {
    lines.push(`Negotiation: round=${ctx.negotiation.round}, trigger=${ctx.negotiation.trigger}, applied=${ctx.negotiation.applied_option_id ?? 'none'}`);
  }

  if (ctx.pending_approvals.length > 0) {
    lines.push(`Pending Approvals: ${ctx.pending_approvals.length}`);
  }

  if (ctx.risk.active_alerts > 0 || ctx.risk.supplier_event_count > 0) {
    lines.push(`Risk: ${ctx.risk.active_alerts} active alerts, ${ctx.risk.supplier_event_count} supplier events`);
  }

  lines.push(`Role: ${ctx.user_role}`);

  return lines.join('\n');
}

/**
 * Determine the next-best-action suggestions based on current context.
 *
 * @param {Object} ctx - Output of buildChatSessionContext()
 * @returns {Array<Object>} Array of { action_id, label, description, priority }
 */
export function suggestNextActions(ctx) {
  if (!ctx) return [];

  const actions = [];
  const stage = ctx.workflow.stage;

  switch (stage) {
    case 'awaiting_dataset':
      actions.push({
        action_id: 'upload_dataset',
        label: 'Upload Dataset',
        description: 'Upload a CSV or XLSX file to start planning.',
        priority: 1,
      });
      break;

    case 'awaiting_contract':
      actions.push({
        action_id: 'confirm_contract',
        label: 'Confirm Data Contract',
        description: 'Review and confirm the column mapping before proceeding.',
        priority: 1,
      });
      break;

    case 'ready_for_forecast':
      actions.push({
        action_id: 'run_forecast',
        label: 'Run Forecast',
        description: 'Generate demand forecast from the uploaded dataset.',
        priority: 1,
      });
      actions.push({
        action_id: 'run_workflow_a',
        label: 'Run Full Workflow',
        description: 'Execute end-to-end planning workflow (forecast → plan → verify → report).',
        priority: 2,
      });
      break;

    case 'ready_for_plan':
      actions.push({
        action_id: 'run_plan',
        label: 'Generate Plan',
        description: 'Generate replenishment plan from the forecast.',
        priority: 1,
      });
      break;

    case 'plan_infeasible':
      actions.push({
        action_id: 'start_negotiation',
        label: 'Start Negotiation',
        description: 'Explore trade-off options to resolve infeasibility.',
        priority: 1,
      });
      actions.push({
        action_id: 'run_what_if',
        label: 'Run What-If Scenario',
        description: 'Adjust parameters and re-run to find feasible solution.',
        priority: 2,
      });
      break;

    case 'negotiation_active':
      actions.push({
        action_id: 'review_negotiation',
        label: 'Review Options',
        description: 'Compare negotiation options and select one to apply.',
        priority: 1,
      });
      break;

    case 'awaiting_approval':
      actions.push({
        action_id: 'review_approval',
        label: 'Review Pending Approvals',
        description: `${ctx.pending_approvals.length} plan(s) awaiting approval.`,
        priority: 1,
      });
      break;

    case 'plan_complete':
      actions.push({
        action_id: 'run_what_if',
        label: 'What-If Analysis',
        description: 'Explore alternative scenarios against the current plan.',
        priority: 1,
      });
      actions.push({
        action_id: 'compare_plans',
        label: 'Compare Plans',
        description: 'Compare current plan with a previous run.',
        priority: 2,
      });
      if (ctx.baseline?.risk_mode !== 'on') {
        actions.push({
          action_id: 'run_risk_plan',
          label: 'Risk-Aware Replan',
          description: 'Generate a risk-adjusted version of the plan.',
          priority: 3,
        });
      }
      actions.push({
        action_id: 'request_approval',
        label: 'Submit for Approval',
        description: 'Send the plan for governance review.',
        priority: 4,
      });
      actions.push({
        action_id: 'build_evidence_pack',
        label: 'Build Evidence Pack',
        description: 'Compile full evidence bundle for audit trail.',
        priority: 5,
      });
      break;
  }

  // Contextual add-ons based on view
  if (ctx.view === 'risk_center' && ctx.selection) {
    actions.push({
      action_id: 'deep_dive_risk',
      label: 'Deep-Dive Risk',
      description: 'Drill into the selected risk entity with causal analysis.',
      priority: 0,
    });
  }

  if (ctx.view === 'digital_twin') {
    actions.push({
      action_id: 'run_simulation',
      label: 'Run Simulation',
      description: 'Execute digital twin simulation with current parameters.',
      priority: 0,
    });
  }

  if (ctx.risk.supplier_event_count > 0 && ctx.risk.last_risk_delta) {
    actions.push({
      action_id: 'assess_risk_delta',
      label: 'Assess Risk Impact',
      description: `${ctx.risk.supplier_event_count} new supplier events detected — assess impact.`,
      priority: 0,
    });
  }

  return actions.sort((a, b) => a.priority - b.priority);
}

export default {
  buildChatSessionContext,
  buildContextSummaryForPrompt,
  suggestNextActions,
};
