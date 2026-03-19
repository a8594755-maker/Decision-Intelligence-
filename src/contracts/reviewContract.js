/**
 * reviewContract.js — Review & Approval Contract (v2)
 *
 * Defines the schema for manager review decisions on decision artifacts.
 * Used at the review_gate step of the orchestrator pipeline.
 *
 * The review targets decision_brief + writeback_payload artifacts,
 * NOT chat messages or free-text answers.
 *
 * @module contracts/reviewContract
 */

// ── Review Decisions ────────────────────────────────────────────────────────

export const REVIEW_DECISIONS = {
  APPROVED:            'approved',
  REJECTED:            'rejected',
  REVISION_REQUESTED:  'revision_requested',
  ESCALATED:           'escalated',
  DEFERRED:            'deferred',
};

// ── Publish Permissions ─────────────────────────────────────────────────────

/**
 * @typedef {Object} PublishPermission
 * @property {boolean} export         - Allow spreadsheet/CSV export
 * @property {boolean} writeback      - Allow ERP writeback
 * @property {boolean} notify         - Allow external notifications (email, etc.)
 * @property {string[]} [allowed_targets] - Specific targets permitted (e.g., ['sap_mm'])
 */

// ── Approval Policy ─────────────────────────────────────────────────────────

/**
 * @typedef {Object} ApprovalPolicy
 * @property {string}   policy_id            - Unique policy identifier
 * @property {string}   worker_template_id   - Which worker template this applies to
 * @property {Object[]} rules                - Array of approval rules
 * @property {string}   rules[].action_type  - Action type (e.g., 'writeback', 'export', 'notify')
 * @property {boolean}  rules[].requires_approval - Whether approval is required
 * @property {Object}   [rules[].thresholds] - Conditions that force escalation
 * @property {number}   [rules[].thresholds.cost_delta_abs] - If |cost_delta| > N, escalate
 * @property {string}   [rules[].thresholds.risk_level]     - If risk >= level, escalate
 * @property {number}   [rules[].thresholds.affected_records_count] - If records > N, escalate
 * @property {string[]} [rules[].auto_approve_at] - Autonomy levels that can auto-approve (e.g., ['A3','A4'])
 */

// ── Review Resolution ───────────────────────────────────────────────────────

const REVIEW_RESOLUTION_REQUIRED = ['decision', 'reviewer_id', 'task_id'];

/**
 * Validate a review resolution payload.
 *
 * @param {Object} resolution
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateReviewResolution(resolution) {
  const errors = [];

  if (!resolution || typeof resolution !== 'object') {
    return { valid: false, errors: ['Review resolution must be a non-null object'] };
  }

  for (const field of REVIEW_RESOLUTION_REQUIRED) {
    if (!resolution[field]) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  if (resolution.decision && !Object.values(REVIEW_DECISIONS).includes(resolution.decision)) {
    errors.push(`Unknown review decision: ${resolution.decision}`);
  }

  if (resolution.approved_actions && !Array.isArray(resolution.approved_actions)) {
    errors.push('approved_actions must be an array');
  }

  if (resolution.rejected_actions && !Array.isArray(resolution.rejected_actions)) {
    errors.push('rejected_actions must be an array');
  }

  if (resolution.publish_permission) {
    const pp = resolution.publish_permission;
    if (typeof pp !== 'object') {
      errors.push('publish_permission must be an object');
    } else {
      if (pp.export !== undefined && typeof pp.export !== 'boolean') {
        errors.push('publish_permission.export must be boolean');
      }
      if (pp.writeback !== undefined && typeof pp.writeback !== 'boolean') {
        errors.push('publish_permission.writeback must be boolean');
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a review resolution with defaults.
 *
 * @param {Object} params
 * @returns {Object} Review Resolution
 */
export function createReviewResolution({
  decision,
  reviewer_id,
  task_id,
  review_notes = '',
  approved_actions = [],
  rejected_actions = [],
  publish_permission = { export: false, writeback: false, notify: false },
  revision_instructions = null,
  escalation_target = null,
}) {
  return {
    id: `rev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    decision,
    reviewer_id,
    task_id,
    review_notes,
    approved_actions,
    rejected_actions,
    publish_permission,
    revision_instructions,
    escalation_target,
    resolved_at: new Date().toISOString(),
  };
}

// ── Approval Policy Factory ─────────────────────────────────────────────────

/**
 * Create an approval policy for a worker template.
 *
 * @param {Object} params
 * @returns {Object} Approval Policy
 */
export function createApprovalPolicy({
  worker_template_id,
  rules = [],
}) {
  return {
    policy_id: `ap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    worker_template_id,
    rules: rules.length > 0 ? rules : getDefaultApprovalRules(),
    created_at: new Date().toISOString(),
  };
}

/**
 * Default approval rules — v1 conservative: everything requires approval.
 */
function getDefaultApprovalRules() {
  return [
    {
      action_type: 'writeback',
      requires_approval: true,
      thresholds: { cost_delta_abs: 0, risk_level: 'low' },
      auto_approve_at: [],  // v1: no auto-approve for writeback
    },
    {
      action_type: 'export',
      requires_approval: false,  // Exports are safe
      thresholds: {},
      auto_approve_at: ['A2', 'A3', 'A4'],
    },
    {
      action_type: 'notify',
      requires_approval: true,
      thresholds: {},
      auto_approve_at: ['A3', 'A4'],
    },
  ];
}

// ── Gate check ──────────────────────────────────────────────────────────────

/**
 * Check whether a specific action requires approval under a given policy.
 *
 * @param {Object} policy - ApprovalPolicy
 * @param {string} actionType - 'writeback' | 'export' | 'notify'
 * @param {Object} context - { cost_delta, risk_level, affected_records_count, autonomy_level }
 * @returns {{ requires_approval: boolean, reason: string }}
 */
export function checkApprovalGate(policy, actionType, context = {}) {
  if (!policy?.rules) {
    return { requires_approval: true, reason: 'No policy found — default to require approval' };
  }

  const rule = policy.rules.find(r => r.action_type === actionType);

  if (!rule) {
    return { requires_approval: true, reason: `No rule for action_type=${actionType} — default to require approval` };
  }

  // Threshold escalation checks always take precedence over auto-approval.
  if (rule.thresholds) {
    const t = rule.thresholds;
    if (t.cost_delta_abs !== undefined && Math.abs(context.cost_delta || 0) > t.cost_delta_abs) {
      return { requires_approval: true, reason: `Cost delta ${context.cost_delta} exceeds threshold ${t.cost_delta_abs}` };
    }
    const riskOrder = ['low', 'medium', 'high', 'critical'];
    if (t.risk_level && riskOrder.indexOf(context.risk_level) >= riskOrder.indexOf(t.risk_level)) {
      return { requires_approval: true, reason: `Risk level ${context.risk_level} >= threshold ${t.risk_level}` };
    }
    if (t.affected_records_count !== undefined && (context.affected_records_count || 0) > t.affected_records_count) {
      return { requires_approval: true, reason: `Affected records ${context.affected_records_count} exceeds threshold ${t.affected_records_count}` };
    }
  }

  // Auto-approve check
  if (rule.auto_approve_at?.includes(context.autonomy_level)) {
    return { requires_approval: false, reason: `Auto-approved at autonomy level ${context.autonomy_level}` };
  }

  if (!rule.requires_approval) {
    return { requires_approval: false, reason: `Policy allows ${actionType} without approval` };
  }

  return { requires_approval: true, reason: `Default: ${actionType} requires approval` };
}
