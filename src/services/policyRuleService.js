/**
 * policyRuleService.js — No-Code Governance Policy Rule Engine
 *
 * Provides CRUD + evaluation for user-configurable governance rules.
 * Rules are stored in the `governance_rules` Supabase table with
 * hardcoded fallback for offline/demo usage.
 *
 * Rule types:
 *   - approval_threshold: Cost/quantity thresholds requiring approval
 *   - autonomy_gate:      Minimum autonomy level for specific actions
 *   - review_required:    Force human review for specific capability classes
 *   - rate_limit:         Max tasks per time window
 *   - data_access:        Field-level data access restrictions
 *   - time_window:        Only allow actions within specific hours/days
 *
 * @module services/policyRuleService
 */

import { supabase } from './supabaseClient';
import { CAPABILITY_CLASS, CAPABILITY_POLICIES } from './capabilityModelService.js';

// ── Rule Types ───────────────────────────────────────────────────────────────

export const RULE_TYPES = Object.freeze({
  APPROVAL_THRESHOLD: 'approval_threshold',
  AUTONOMY_GATE:      'autonomy_gate',
  REVIEW_REQUIRED:    'review_required',
  RATE_LIMIT:         'rate_limit',
  DATA_ACCESS:        'data_access',
  TIME_WINDOW:        'time_window',
});

// ── Rule Schema ──────────────────────────────────────────────────────────────

/**
 * @typedef {Object} GovernanceRule
 * @property {string}  id
 * @property {string}  name - Human-readable rule name
 * @property {string}  description
 * @property {string}  rule_type - RULE_TYPES value
 * @property {string}  [capability_class] - Scope to specific capability class
 * @property {string}  [worker_template_id] - Scope to specific worker template
 * @property {Object}  conditions - Rule conditions
 * @property {Object}  actions - What happens when rule triggers
 * @property {number}  priority - Lower number = higher priority (evaluated first)
 * @property {boolean} is_active
 * @property {string}  created_by
 * @property {string}  created_at
 */

// ── Default Rules (hardcoded fallback) ───────────────────────────────────────

const DEFAULT_RULES = [
  {
    id: 'default_writeback_approval',
    name: 'Writeback Requires Approval',
    description: 'All ERP writeback operations require human approval',
    rule_type: RULE_TYPES.APPROVAL_THRESHOLD,
    capability_class: CAPABILITY_CLASS.INTEGRATION,
    worker_template_id: null,
    conditions: { action_type: 'writeback' },
    actions: { require_approval: true, reason: 'ERP writeback requires human approval' },
    priority: 10,
    is_active: true,
    _source: 'default',
  },
  {
    id: 'default_high_cost_approval',
    name: 'High Cost Delta Approval',
    description: 'Actions with cost impact > $10,000 require approval',
    rule_type: RULE_TYPES.APPROVAL_THRESHOLD,
    capability_class: null,
    worker_template_id: null,
    conditions: { cost_delta_gt: 10000 },
    actions: { require_approval: true, reason: 'Cost impact exceeds $10,000 threshold' },
    priority: 20,
    is_active: true,
    _source: 'default',
  },
  {
    id: 'default_planning_review',
    name: 'Planning Review Required',
    description: 'Planning outputs require review at A1-A2 autonomy',
    rule_type: RULE_TYPES.REVIEW_REQUIRED,
    capability_class: CAPABILITY_CLASS.PLANNING,
    worker_template_id: null,
    conditions: { autonomy_below: 'A3' },
    actions: { require_review: true, reason: 'Planning output review required below A3' },
    priority: 30,
    is_active: true,
    _source: 'default',
  },
  {
    id: 'default_integration_autonomy',
    name: 'Integration Minimum Autonomy',
    description: 'Integration actions require at least A2 autonomy',
    rule_type: RULE_TYPES.AUTONOMY_GATE,
    capability_class: CAPABILITY_CLASS.INTEGRATION,
    worker_template_id: null,
    conditions: { min_autonomy: 'A2' },
    actions: { block: true, reason: 'Integration requires A2+ autonomy' },
    priority: 5,
    is_active: true,
    _source: 'default',
  },
];

// ── CRUD Operations ──────────────────────────────────────────────────────────

/**
 * Create a new governance rule.
 */
export async function createRule({
  name,
  description = '',
  ruleType,
  capabilityClass = null,
  workerTemplateId = null,
  conditions = {},
  actions = {},
  priority = 50,
  createdBy = null,
}) {
  const row = {
    name,
    description,
    rule_type: ruleType,
    capability_class: capabilityClass,
    worker_template_id: workerTemplateId,
    conditions,
    actions,
    priority,
    is_active: true,
    created_by: createdBy,
    created_at: new Date().toISOString(),
  };

  try {
    const { data, error } = await supabase
      .from('governance_rules')
      .insert(row)
      .select()
      .single();
    if (error) throw error;
    return { ok: true, rule: data };
  } catch {
    return { ok: true, rule: { id: `rule_${Date.now().toString(36)}`, ...row }, _source: 'memory' };
  }
}

/**
 * List all rules, optionally filtered.
 */
export async function listRules({ capabilityClass, workerTemplateId, ruleType, activeOnly = true } = {}) {
  try {
    let query = supabase
      .from('governance_rules')
      .select('*')
      .order('priority', { ascending: true });

    if (activeOnly) query = query.eq('is_active', true);
    if (capabilityClass) query = query.eq('capability_class', capabilityClass);
    if (workerTemplateId) query = query.eq('worker_template_id', workerTemplateId);
    if (ruleType) query = query.eq('rule_type', ruleType);

    const { data, error } = await query;
    if (error) throw error;

    // Merge with defaults (DB rules override defaults by ID)
    const merged = new Map();
    for (const rule of DEFAULT_RULES) {
      if (activeOnly && !rule.is_active) continue;
      if (capabilityClass && rule.capability_class && rule.capability_class !== capabilityClass) continue;
      if (ruleType && rule.rule_type !== ruleType) continue;
      merged.set(rule.id, rule);
    }
    for (const rule of (data || [])) {
      merged.set(rule.id, rule);
    }

    return Array.from(merged.values()).sort((a, b) => (a.priority || 50) - (b.priority || 50));
  } catch {
    return DEFAULT_RULES.filter(r => {
      if (activeOnly && !r.is_active) return false;
      if (capabilityClass && r.capability_class && r.capability_class !== capabilityClass) return false;
      if (ruleType && r.rule_type !== ruleType) return false;
      return true;
    });
  }
}

/**
 * Get a single rule by ID.
 */
export async function getRule(ruleId) {
  const defaultRule = DEFAULT_RULES.find(r => r.id === ruleId);
  try {
    const { data, error } = await supabase
      .from('governance_rules')
      .select('*')
      .eq('id', ruleId)
      .single();
    if (error) throw error;
    return data;
  } catch {
    return defaultRule || null;
  }
}

/**
 * Update a governance rule.
 */
export async function updateRule(ruleId, updates) {
  const allowed = {};
  if (updates.name != null) allowed.name = updates.name;
  if (updates.description != null) allowed.description = updates.description;
  if (updates.conditions != null) allowed.conditions = updates.conditions;
  if (updates.actions != null) allowed.actions = updates.actions;
  if (updates.priority != null) allowed.priority = updates.priority;
  if (updates.is_active != null) allowed.is_active = updates.is_active;
  if (updates.capability_class !== undefined) allowed.capability_class = updates.capability_class;
  if (updates.worker_template_id !== undefined) allowed.worker_template_id = updates.worker_template_id;

  try {
    const { data, error } = await supabase
      .from('governance_rules')
      .update(allowed)
      .eq('id', ruleId)
      .select()
      .single();
    if (error) throw error;
    return { ok: true, rule: data };
  } catch {
    return { ok: false, error: 'Failed to update rule' };
  }
}

/**
 * Delete a governance rule.
 */
export async function deleteRule(ruleId) {
  try {
    const { error } = await supabase
      .from('governance_rules')
      .delete()
      .eq('id', ruleId);
    if (error) throw error;
    return true;
  } catch {
    return false;
  }
}

// ── Rule Evaluation Engine ───────────────────────────────────────────────────

const AUTONOMY_RANK = { A0: 0, A1: 1, A2: 2, A3: 3, A4: 4 };

/**
 * Evaluate all matching rules against a given context.
 *
 * @param {Object} context
 * @param {string} context.capability_class
 * @param {string} [context.worker_template_id]
 * @param {string} [context.autonomy_level]
 * @param {string} [context.action_type]
 * @param {number} [context.cost_delta]
 * @param {number} [context.quantity]
 * @returns {Promise<{ allowed: boolean, require_approval: boolean, require_review: boolean, triggered_rules: Object[], reasons: string[] }>}
 */
export async function evaluateRules(context) {
  const rules = await listRules({
    capabilityClass: context.capability_class,
    activeOnly: true,
  });

  const triggered = [];
  const reasons = [];
  let requireApproval = false;
  let requireReview = false;
  let blocked = false;

  for (const rule of rules) {
    // Check scope: worker template must match if specified
    if (rule.worker_template_id && rule.worker_template_id !== context.worker_template_id) {
      continue;
    }

    const match = evaluateSingleRule(rule, context);
    if (match.triggered) {
      triggered.push({ rule_id: rule.id, rule_name: rule.name, ...match });

      if (rule.actions.require_approval) requireApproval = true;
      if (rule.actions.require_review) requireReview = true;
      if (rule.actions.block) blocked = true;
      if (rule.actions.reason) reasons.push(rule.actions.reason);
    }
  }

  return {
    allowed: !blocked,
    require_approval: requireApproval,
    require_review: requireReview,
    triggered_rules: triggered,
    reasons,
  };
}

/**
 * Evaluate a single rule against context.
 */
function evaluateSingleRule(rule, context) {
  const cond = rule.conditions || {};

  switch (rule.rule_type) {
    case RULE_TYPES.APPROVAL_THRESHOLD: {
      if (cond.action_type && cond.action_type !== context.action_type) {
        return { triggered: false };
      }
      if (cond.cost_delta_gt != null && (context.cost_delta || 0) <= cond.cost_delta_gt) {
        return { triggered: false };
      }
      if (cond.quantity_gt != null && (context.quantity || 0) <= cond.quantity_gt) {
        return { triggered: false };
      }
      // If action_type matches or threshold exceeded → triggered
      return { triggered: true, reason: rule.actions.reason || 'Threshold exceeded' };
    }

    case RULE_TYPES.AUTONOMY_GATE: {
      const current = AUTONOMY_RANK[context.autonomy_level] || 0;
      const required = AUTONOMY_RANK[cond.min_autonomy] || 0;
      if (current < required) {
        return { triggered: true, reason: rule.actions.reason || `Requires ${cond.min_autonomy}+ autonomy` };
      }
      return { triggered: false };
    }

    case RULE_TYPES.REVIEW_REQUIRED: {
      if (cond.autonomy_below) {
        const current = AUTONOMY_RANK[context.autonomy_level] || 0;
        const threshold = AUTONOMY_RANK[cond.autonomy_below] || 0;
        if (current < threshold) {
          return { triggered: true, reason: rule.actions.reason || 'Review required' };
        }
        return { triggered: false };
      }
      return { triggered: true, reason: rule.actions.reason || 'Review required' };
    }

    case RULE_TYPES.RATE_LIMIT: {
      // Rate limiting is handled externally; this rule type is for configuration only
      return { triggered: false };
    }

    case RULE_TYPES.DATA_ACCESS: {
      if (cond.restricted_fields && context.fields) {
        const restricted = context.fields.filter(f => cond.restricted_fields.includes(f));
        if (restricted.length > 0) {
          return { triggered: true, reason: `Restricted fields: ${restricted.join(', ')}` };
        }
      }
      return { triggered: false };
    }

    case RULE_TYPES.TIME_WINDOW: {
      const now = new Date();
      const hour = now.getHours();
      const day = now.getDay(); // 0=Sun, 6=Sat
      if (cond.allowed_hours) {
        const [start, end] = cond.allowed_hours;
        if (hour < start || hour >= end) {
          return { triggered: true, reason: `Outside allowed hours (${start}:00-${end}:00)` };
        }
      }
      if (cond.allowed_days && !cond.allowed_days.includes(day)) {
        return { triggered: true, reason: 'Outside allowed days' };
      }
      return { triggered: false };
    }

    default:
      return { triggered: false };
  }
}

// ── Rule Templates (for UI quick-create) ─────────────────────────────────────

export const RULE_TEMPLATES = [
  {
    id: 'tpl_cost_threshold',
    name: 'Cost Threshold Approval',
    description: 'Require approval when cost impact exceeds a threshold',
    rule_type: RULE_TYPES.APPROVAL_THRESHOLD,
    conditions: { cost_delta_gt: 5000 },
    actions: { require_approval: true, reason: 'Cost threshold exceeded' },
  },
  {
    id: 'tpl_writeback_approval',
    name: 'Writeback Approval',
    description: 'Require approval for all ERP writeback operations',
    rule_type: RULE_TYPES.APPROVAL_THRESHOLD,
    conditions: { action_type: 'writeback' },
    actions: { require_approval: true, reason: 'Writeback requires approval' },
    capability_class: CAPABILITY_CLASS.INTEGRATION,
  },
  {
    id: 'tpl_review_below_a3',
    name: 'Review Below A3',
    description: 'Require human review for workers below A3 autonomy',
    rule_type: RULE_TYPES.REVIEW_REQUIRED,
    conditions: { autonomy_below: 'A3' },
    actions: { require_review: true, reason: 'Review required below A3' },
  },
  {
    id: 'tpl_business_hours',
    name: 'Business Hours Only',
    description: 'Block integration actions outside business hours',
    rule_type: RULE_TYPES.TIME_WINDOW,
    conditions: { allowed_hours: [8, 18], allowed_days: [1, 2, 3, 4, 5] },
    actions: { block: true, reason: 'Outside business hours (Mon-Fri 8-18)' },
    capability_class: CAPABILITY_CLASS.INTEGRATION,
  },
  {
    id: 'tpl_autonomy_gate',
    name: 'Minimum Autonomy',
    description: 'Require minimum autonomy level for a capability',
    rule_type: RULE_TYPES.AUTONOMY_GATE,
    conditions: { min_autonomy: 'A2' },
    actions: { block: true, reason: 'Insufficient autonomy level' },
  },
];
