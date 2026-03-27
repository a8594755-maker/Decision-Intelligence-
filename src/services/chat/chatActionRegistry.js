/**
 * chatActionRegistry.js
 *
 * Central registry of all executable actions that the Chat copilot can offer
 * as "next step" buttons. Each action has:
 *
 *   • id           — stable identifier
 *   • label        — display text
 *   • icon         — Lucide icon name
 *   • category     — grouping: 'planning' | 'analysis' | 'governance' | 'risk' | 'simulation'
 *   • guard        — (chatContext) => boolean — returns true if action is available
 *   • mapToIntent  — returns the intent + entities that routeIntent() understands
 *
 * This keeps all action definitions in one place so that both the
 * DecisionBundleCard and ChatActionBar can render them consistently.
 */

// ── Action definitions ───────────────────────────────────────────────────────

const ACTIONS = [
  // ── Planning ──
  {
    id: 'upload_dataset',
    label: 'Upload Dataset',
    icon: 'Upload',
    category: 'planning',
    guard: () => true,
    mapToIntent: () => null, // UI-only: opens file picker
  },
  {
    id: 'confirm_contract',
    label: 'Confirm Data Contract',
    icon: 'FileCheck',
    category: 'planning',
    guard: (ctx) => ctx?.dataset && !ctx.dataset.contract_confirmed,
    mapToIntent: () => null, // UI-only: scrolls to contract card
  },
  {
    id: 'run_forecast',
    label: 'Run Forecast',
    icon: 'TrendingUp',
    category: 'planning',
    guard: (ctx) => ctx?.dataset?.contract_confirmed && !ctx.forecast?.run_id,
    mapToIntent: (ctx) => ({
      intent: 'RUN_FORECAST',
      entities: { dataset_profile_id: ctx?.dataset?.profile_id },
    }),
  },
  {
    id: 'run_plan',
    label: 'Generate Plan',
    icon: 'Calculator',
    category: 'planning',
    guard: (ctx) => Boolean(ctx?.forecast?.run_id),
    mapToIntent: (ctx) => ({
      intent: 'RUN_PLAN',
      entities: { dataset_profile_id: ctx?.dataset?.profile_id },
    }),
  },
  {
    id: 'run_risk_plan',
    label: 'Risk-Aware Replan',
    icon: 'ShieldAlert',
    category: 'planning',
    guard: (ctx) => Boolean(ctx?.baseline?.run_id) && ctx?.baseline?.risk_mode !== 'on',
    mapToIntent: (ctx) => ({
      intent: 'RUN_PLAN',
      entities: {
        dataset_profile_id: ctx?.dataset?.profile_id,
        risk_mode: 'on',
      },
    }),
  },
  {
    id: 'run_workflow_a',
    label: 'Run Full Workflow',
    icon: 'Workflow',
    category: 'planning',
    guard: (ctx) => Boolean(ctx?.dataset?.contract_confirmed),
    mapToIntent: (ctx) => ({
      intent: 'RUN_WORKFLOW_A',
      entities: { dataset_profile_id: ctx?.dataset?.profile_id },
    }),
  },
  {
    id: 'run_workflow_b',
    label: 'Run Risk Workflow',
    icon: 'AlertTriangle',
    category: 'risk',
    guard: (ctx) => Boolean(ctx?.dataset?.contract_confirmed),
    mapToIntent: (ctx) => ({
      intent: 'RUN_WORKFLOW_B',
      entities: { dataset_profile_id: ctx?.dataset?.profile_id },
    }),
  },

  // ── Analysis / Scenario ──
  {
    id: 'run_what_if',
    label: 'What-If Analysis',
    icon: 'FlaskConical',
    category: 'analysis',
    guard: (ctx) => Boolean(ctx?.baseline?.run_id),
    mapToIntent: () => ({
      intent: 'WHAT_IF',
      entities: {},
    }),
  },
  {
    id: 'compare_plans',
    label: 'Compare Plans',
    icon: 'GitCompare',
    category: 'analysis',
    guard: (ctx) => Boolean(ctx?.previous_plan?.run_id),
    mapToIntent: () => ({
      intent: 'COMPARE_PLANS',
      entities: {},
    }),
  },
  {
    id: 'compare_scenarios',
    label: 'Compare Scenarios',
    icon: 'Layers',
    category: 'analysis',
    guard: (ctx) => Boolean(ctx?.scenario?.scenario_run_id),
    mapToIntent: () => null, // Opens scenario matrix view
  },

  // ── Data Analysis ──
  {
    id: 'run_data_analysis',
    label: 'Data Analysis',
    icon: 'BarChart3',
    category: 'analysis',
    guard: () => true, // Always available — uses built-in Olist data
    mapToIntent: () => ({
      intent: 'QUERY_DATA',
      entities: { freeform_query: 'run comprehensive data analysis' },
    }),
  },

  // ── Simulation ──
  {
    id: 'run_simulation',
    label: 'Run Simulation',
    icon: 'Dices',
    category: 'simulation',
    guard: () => true,
    mapToIntent: () => ({
      intent: 'RUN_DIGITAL_TWIN',
      entities: { simulation_scenario: 'normal' },
    }),
  },

  // ── Risk ──
  {
    id: 'deep_dive_risk',
    label: 'Deep-Dive Risk',
    icon: 'SearchCheck',
    category: 'risk',
    guard: (ctx) => ctx?.view === 'risk_center' || Boolean(ctx?.risk?.active_alerts),
    mapToIntent: () => null, // Handled by risk drilldown UI
  },
  {
    id: 'assess_risk_delta',
    label: 'Assess Risk Impact',
    icon: 'ActivitySquare',
    category: 'risk',
    guard: (ctx) => ctx?.risk?.supplier_event_count > 0,
    mapToIntent: () => null,
  },

  // ── Governance ──
  {
    id: 'start_negotiation',
    label: 'Start Negotiation',
    icon: 'Handshake',
    category: 'governance',
    guard: (ctx) => ctx?.baseline?.solver_status === 'infeasible' ||
                     (ctx?.workflow?.stage === 'plan_infeasible'),
    mapToIntent: () => null, // Handled by negotiation orchestrator
  },
  {
    id: 'review_negotiation',
    label: 'Review Negotiation Options',
    icon: 'ListChecks',
    category: 'governance',
    guard: (ctx) => Boolean(ctx?.negotiation?.round > 0),
    mapToIntent: () => null,
  },
  {
    id: 'request_approval',
    label: 'Submit for Approval',
    icon: 'CheckSquare',
    category: 'governance',
    guard: (ctx) => Boolean(ctx?.baseline?.run_id) &&
                     ctx?.baseline?.solver_status !== 'infeasible',
    mapToIntent: () => ({ intent: 'APPROVE', entities: {} }),
  },
  {
    id: 'review_approval',
    label: 'Review Pending Approvals',
    icon: 'ClipboardCheck',
    category: 'governance',
    guard: (ctx) => (ctx?.pending_approvals?.length || 0) > 0,
    mapToIntent: () => null,
  },
  {
    id: 'build_evidence_pack',
    label: 'Build Evidence Pack',
    icon: 'Archive',
    category: 'governance',
    guard: (ctx) => Boolean(ctx?.baseline?.run_id),
    mapToIntent: () => null,
  },
];

// ── Registry API ─────────────────────────────────────────────────────────────

import { isActionEnabled } from '../../config/featureGateService';

const _actionMap = new Map(ACTIONS.map(a => [a.id, a]));

/**
 * Get an action definition by ID.
 * @param {string} actionId
 * @returns {Object|null}
 */
export function getAction(actionId) {
  return _actionMap.get(actionId) || null;
}

/**
 * Get all actions available in the current context.
 * @param {Object} chatContext - From buildChatSessionContext()
 * @returns {Array<Object>}
 */
export function getAvailableActions(chatContext) {
  return ACTIONS.filter(action => {
    try {
      if (!isActionEnabled(action.id)) return false;
      return action.guard(chatContext);
    } catch {
      return false;
    }
  });
}

/**
 * Get actions for a specific category.
 * @param {string} category
 * @param {Object} chatContext
 * @returns {Array<Object>}
 */
export function getActionsByCategory(category, chatContext) {
  return getAvailableActions(chatContext).filter(a => a.category === category);
}

/**
 * Map a next_action suggestion to the intent+entities needed by routeIntent().
 * Returns null if the action is UI-only (no intent mapping).
 *
 * @param {string} actionId
 * @param {Object} chatContext
 * @returns {Object|null} { intent, entities } or null
 */
export function resolveActionToIntent(actionId, chatContext) {
  const action = getAction(actionId);
  if (!action?.mapToIntent) return null;
  return action.mapToIntent(chatContext);
}

export { ACTIONS };

export default {
  getAction,
  getAvailableActions,
  getActionsByCategory,
  resolveActionToIntent,
  ACTIONS,
};
