// @product: ai-employee
//
// agentLoopTemplates.js
// ─────────────────────────────────────────────────────────────────────────────
// Deterministic task decomposition templates for the agent loop.
// No LLM needed — each template is a predefined recipe of ordered steps.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} StepDef
 * @property {string}  name            - Unique step name within this template
 * @property {string}  workflow_type   - DI engine type: 'forecast' | 'plan' | 'risk' | 'synthesize'
 * @property {boolean} requires_review - If true, loop pauses at review_hold after this step
 */

/**
 * @typedef {object} Template
 * @property {string}    id          - Template identifier
 * @property {string}    label       - Human-readable name
 * @property {string}    description - Brief description
 * @property {StepDef[]} steps       - Ordered step definitions
 */

// ─────────────────────────────────────────────────────────────────────────────

/** @type {Record<string, Template>} */
export const AGENT_LOOP_TEMPLATES = {
  // ── Composite templates ──────────────────────────────────────────────────

  full_report: {
    id: 'full_report',
    label: 'Full Supply Chain Report',
    description: 'Forecast + Plan + Risk + Synthesis',
    steps: [
      { name: 'forecast',   workflow_type: 'forecast',   requires_review: false },
      { name: 'plan',       workflow_type: 'plan',       requires_review: false },
      { name: 'risk',       workflow_type: 'risk',       requires_review: false },
      { name: 'synthesize', workflow_type: 'synthesize',  requires_review: true },
    ],
  },

  forecast_then_plan: {
    id: 'forecast_then_plan',
    label: 'Forecast + Plan',
    description: 'Run forecast, then build a replenishment plan',
    steps: [
      { name: 'forecast', workflow_type: 'forecast', requires_review: false },
      { name: 'plan',     workflow_type: 'plan',     requires_review: true },
    ],
  },

  risk_aware_plan: {
    id: 'risk_aware_plan',
    label: 'Risk-Aware Plan',
    description: 'Forecast + Risk analysis, then risk-adjusted plan',
    steps: [
      { name: 'forecast', workflow_type: 'forecast', requires_review: false },
      { name: 'risk',     workflow_type: 'risk',     requires_review: false },
      { name: 'plan',     workflow_type: 'plan',     requires_review: true },
    ],
  },

  // ── Single-step wrappers (backward compat) ──────────────────────────────

  forecast: {
    id: 'forecast',
    label: 'Demand Forecast',
    description: 'Run a demand forecast',
    steps: [{ name: 'forecast', workflow_type: 'forecast', requires_review: true }],
  },

  plan: {
    id: 'plan',
    label: 'Replenishment Plan',
    description: 'Run a replenishment plan',
    steps: [{ name: 'plan', workflow_type: 'plan', requires_review: true }],
  },

  risk: {
    id: 'risk',
    label: 'Risk Analysis',
    description: 'Run a risk analysis',
    steps: [{ name: 'risk', workflow_type: 'risk', requires_review: true }],
  },
};

/**
 * All template entries suitable for UI selectors.
 * Composite templates first, then single-step wrappers.
 */
export const TEMPLATE_OPTIONS = [
  { value: 'full_report',        label: 'Full Supply Chain Report', composite: true },
  { value: 'forecast_then_plan', label: 'Forecast + Plan',         composite: true },
  { value: 'risk_aware_plan',    label: 'Risk-Aware Plan',         composite: true },
  { value: 'forecast',           label: 'Demand Forecast',         composite: false },
  { value: 'plan',               label: 'Replenishment Plan',      composite: false },
  { value: 'risk',               label: 'Risk Analysis',           composite: false },
];

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a template by its ID or by a legacy workflow_type.
 * Returns null if not found.
 *
 * @param {string} idOrWorkflowType
 * @returns {Template|null}
 */
export function resolveTemplate(idOrWorkflowType) {
  return AGENT_LOOP_TEMPLATES[idOrWorkflowType] || null;
}

/**
 * Build initial loop_state from a template.
 *
 * @param {Template} template
 * @returns {object} Initial loop_state
 */
export function initLoopState(template) {
  if (!template?.steps?.length) throw new Error('Template must have at least one step');
  return {
    template_id: template.id,
    steps: template.steps.map((s, i) => ({
      index: i,
      name: s.name,
      workflow_type: s.workflow_type,
      requires_review: s.requires_review,
      status: 'pending',
      run_id: null,
      artifact_refs: [],
      retry_count: 0,
      error: null,
      started_at: null,
      finished_at: null,
    })),
    current_step_index: 0,
    started_at: null,
    finished_at: null,
  };
}

export default { AGENT_LOOP_TEMPLATES, TEMPLATE_OPTIONS, resolveTemplate, initLoopState };
