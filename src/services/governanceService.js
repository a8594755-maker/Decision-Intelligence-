/**
 * governanceService.js — Unified Review & Governance Layer
 *
 * Consolidates all approval, review, and escalation flows into a single
 * governance framework. Replaces the scattered review logic across:
 *   - planGovernanceService (plan approval via ML API)
 *   - approvalWorkflowService (enhanced approvals with deadlines)
 *   - aiReviewerService (AI quality scoring)
 *   - orchestrator task state (step-level approval)
 *
 * Governance item types:
 *   - plan_approval    → Full plan commit
 *   - step_approval    → Individual step review
 *   - output_approval  → Output quality gate
 *   - revision_request → Manager requests changes
 *   - risk_replan      → Risk-driven replan
 *   - closed_loop      → Closed-loop automation
 *   - model_promotion  → ML model promotion
 *
 * Each item follows: PENDING → APPROVED | REJECTED | ESCALATED | EXPIRED
 */

import { supabase } from './supabaseClient';

// ── Constants ───────────────────────────────────────────────────────────────

export const GOVERNANCE_TYPES = {
  PLAN_APPROVAL:    'plan_approval',
  STEP_APPROVAL:    'step_approval',
  OUTPUT_APPROVAL:  'output_approval',
  REVISION_REQUEST: 'revision_request',
  RISK_REPLAN:      'risk_replan',
  CLOSED_LOOP:      'closed_loop',
  MODEL_PROMOTION:  'model_promotion',
};

export const GOVERNANCE_STATUS = {
  PENDING:   'pending',
  APPROVED:  'approved',
  REJECTED:  'rejected',
  ESCALATED: 'escalated',
  EXPIRED:   'expired',
};

export const ESCALATION_REASONS = {
  SLA_BREACH:       'sla_breach',
  HIGH_RISK:        'high_risk',
  BUDGET_EXCEEDED:  'budget_exceeded',
  POLICY_VIOLATION: 'policy_violation',
  MANUAL:           'manual',
};

// ── Approval Policies ────────────────────────────────────────────────────────

/**
 * Default approval policies by type.
 * Can be overridden per-user or per-organization.
 */
export const DEFAULT_POLICIES = {
  plan_approval: {
    auto_approve_threshold: null,       // always require human
    deadline_hours: 24,
    requires_review_score: false,
    min_review_score: null,
    escalation_hours: 12,
    escalation_to: 'manager',
  },
  step_approval: {
    auto_approve_threshold: 85,         // auto-approve if AI review score >= 85
    deadline_hours: 8,
    requires_review_score: true,
    min_review_score: 65,
    escalation_hours: 4,
    escalation_to: 'manager',
  },
  output_approval: {
    auto_approve_threshold: 90,
    deadline_hours: 4,
    requires_review_score: true,
    min_review_score: 70,
    escalation_hours: 2,
    escalation_to: 'manager',
  },
  revision_request: {
    auto_approve_threshold: null,
    deadline_hours: 48,
    requires_review_score: false,
    min_review_score: null,
    escalation_hours: 24,
    escalation_to: 'manager',
  },
  risk_replan: {
    auto_approve_threshold: null,
    deadline_hours: 8,
    requires_review_score: false,
    min_review_score: null,
    escalation_hours: 2,
    escalation_to: 'manager',
  },
  closed_loop: {
    auto_approve_threshold: null,
    deadline_hours: 4,
    requires_review_score: false,
    min_review_score: null,
    escalation_hours: 1,
    escalation_to: 'manager',
  },
  model_promotion: {
    auto_approve_threshold: null,
    deadline_hours: 72,
    requires_review_score: false,
    min_review_score: null,
    escalation_hours: 48,
    escalation_to: 'admin',
  },
};

// ── In-Memory Store (fallback) ──────────────────────────────────────────────

let _governanceItems = [];

// ── Core Operations ─────────────────────────────────────────────────────────

/**
 * Create a governance review item.
 *
 * @param {Object} params
 * @param {string} params.type          - GOVERNANCE_TYPES value
 * @param {string} params.userId        - Requesting user
 * @param {string} params.title         - Human-readable title
 * @param {string} [params.description] - Detailed description
 * @param {Object} [params.payload]     - Type-specific data (run_id, kpis, etc.)
 * @param {string} [params.urgency]     - 'low'|'normal'|'high'|'critical'
 * @param {string} [params.taskId]      - Related task ID
 * @param {string} [params.stepId]      - Related step ID
 * @param {number} [params.reviewScore] - AI review score (0-100)
 * @returns {Promise<Object>} Created governance item
 */
export async function createGovernanceItem({
  type,
  userId,
  title,
  description = '',
  payload = {},
  urgency = 'normal',
  taskId = null,
  stepId = null,
  reviewScore = null,
}) {
  const policy = DEFAULT_POLICIES[type] || DEFAULT_POLICIES.plan_approval;

  // Check auto-approve
  if (policy.auto_approve_threshold != null && reviewScore != null && reviewScore >= policy.auto_approve_threshold) {
    const item = buildItem({ type, userId, title, description, payload, urgency, taskId, stepId, reviewScore, policy });
    item.status = GOVERNANCE_STATUS.APPROVED;
    item.review_comment = `Auto-approved: review score ${reviewScore} >= threshold ${policy.auto_approve_threshold}`;
    item.reviewed_at = new Date().toISOString();
    await persistItem(item);
    return item;
  }

  // Check min review score gate
  if (policy.requires_review_score && policy.min_review_score != null && reviewScore != null && reviewScore < policy.min_review_score) {
    const item = buildItem({ type, userId, title, description, payload, urgency, taskId, stepId, reviewScore, policy });
    item.status = GOVERNANCE_STATUS.REJECTED;
    item.review_comment = `Auto-rejected: review score ${reviewScore} < minimum ${policy.min_review_score}`;
    item.reviewed_at = new Date().toISOString();
    await persistItem(item);
    return item;
  }

  const item = buildItem({ type, userId, title, description, payload, urgency, taskId, stepId, reviewScore, policy });
  await persistItem(item);
  return item;
}

function buildItem({ type, userId, title, description, payload, urgency, taskId, stepId, reviewScore, policy }) {
  const now = new Date();
  return {
    id: `gov_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    type,
    user_id: userId,
    title,
    description,
    payload,
    urgency,
    task_id: taskId,
    step_id: stepId,
    review_score: reviewScore,
    status: GOVERNANCE_STATUS.PENDING,
    reviewer_id: null,
    review_comment: null,
    reviewed_at: null,
    escalation_reason: null,
    expires_at: new Date(now.getTime() + (policy.deadline_hours * 3600000)).toISOString(),
    escalation_at: new Date(now.getTime() + (policy.escalation_hours * 3600000)).toISOString(),
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
}

// ── Decision Operations ─────────────────────────────────────────────────────

/**
 * Approve a governance item.
 */
export async function approveItem(itemId, reviewerId, comment = '') {
  return updateDecision(itemId, GOVERNANCE_STATUS.APPROVED, reviewerId, comment);
}

/**
 * Reject a governance item.
 */
export async function rejectItem(itemId, reviewerId, comment = '') {
  return updateDecision(itemId, GOVERNANCE_STATUS.REJECTED, reviewerId, comment);
}

/**
 * Escalate a governance item.
 */
export async function escalateItem(itemId, reason, comment = '') {
  const patch = {
    status: GOVERNANCE_STATUS.ESCALATED,
    escalation_reason: reason,
    review_comment: comment,
    updated_at: new Date().toISOString(),
  };
  return patchItem(itemId, patch);
}

/**
 * Request revision (creates a new revision_request item linked to the original).
 */
export async function requestRevision(itemId, reviewerId, feedback) {
  const original = await getItem(itemId);
  if (!original) return null;

  // Reject the original
  await rejectItem(itemId, reviewerId, `Revision requested: ${feedback}`);

  // Create a revision request
  return createGovernanceItem({
    type: GOVERNANCE_TYPES.REVISION_REQUEST,
    userId: original.user_id,
    title: `[Revision] ${original.title}`,
    description: feedback,
    payload: {
      ...original.payload,
      original_item_id: itemId,
      revision_feedback: feedback,
    },
    urgency: original.urgency,
    taskId: original.task_id,
    stepId: original.step_id,
  });
}

async function updateDecision(itemId, status, reviewerId, comment) {
  // Guard: only allow decision on items that are still pending.
  // Prevents race condition where two managers approve concurrently.
  try {
    const { data: current } = await supabase
      .from('di_approval_requests')
      .select('status')
      .eq('id', itemId)
      .single();
    if (current && current.status !== GOVERNANCE_STATUS.PENDING && current.status !== 'pending') {
      throw new Error(`Item ${itemId} is already ${current.status}. Cannot change to ${status}.`);
    }
  } catch (checkErr) {
    // If the check itself fails (e.g. item not found or DB down), throw clearly
    if (checkErr.message?.includes('already')) throw checkErr;
    // For DB errors during check, fall through to allow in-memory fallback
  }

  const patch = {
    status,
    reviewer_id: reviewerId,
    review_comment: comment,
    reviewed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  return patchItem(itemId, patch);
}

// ── Query Operations ────────────────────────────────────────────────────────

/**
 * List pending governance items for a user.
 */
export async function listPending(userId, { type, limit = 50 } = {}) {
  try {
    let query = supabase
      .from('di_approval_requests')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (type) query = query.eq('type', type);

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  } catch {
    return _governanceItems.filter(
      (i) => i.user_id === userId && i.status === GOVERNANCE_STATUS.PENDING && (!type || i.type === type)
    ).slice(0, limit);
  }
}

/**
 * Get a single governance item.
 */
export async function getItem(itemId) {
  try {
    const { data, error } = await supabase
      .from('di_approval_requests')
      .select('*')
      .eq('id', itemId)
      .maybeSingle();
    if (error) throw error;
    return data;
  } catch {
    return _governanceItems.find((i) => i.id === itemId) || null;
  }
}

/**
 * List all governance items for a task.
 */
export async function listByTask(taskId, { limit = 20 } = {}) {
  try {
    const { data, error } = await supabase
      .from('di_approval_requests')
      .select('*')
      .contains('payload', { task_id: taskId })
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  } catch {
    return _governanceItems.filter((i) => i.task_id === taskId).slice(0, limit);
  }
}

/**
 * Get governance statistics for a user.
 */
export async function getGovernanceStats(userId) {
  try {
    const { data, error } = await supabase
      .from('di_approval_requests')
      .select('status, type')
      .eq('user_id', userId);
    if (error) throw error;

    const items = data || [];
    return {
      total: items.length,
      pending: items.filter((i) => i.status === 'pending').length,
      approved: items.filter((i) => i.status === 'approved').length,
      rejected: items.filter((i) => i.status === 'rejected').length,
      escalated: items.filter((i) => i.status === 'escalated').length,
      expired: items.filter((i) => i.status === 'expired').length,
      by_type: Object.fromEntries(
        Object.values(GOVERNANCE_TYPES).map((t) => [t, items.filter((i) => i.type === t).length])
      ),
    };
  } catch {
    return { total: 0, pending: 0, approved: 0, rejected: 0, escalated: 0, expired: 0, by_type: {} };
  }
}

// ── SLA / Escalation Check ──────────────────────────────────────────────────

/**
 * Check and auto-escalate items that have breached their SLA.
 * Should be called periodically (e.g., every 5 minutes).
 */
export async function checkEscalations(userId) {
  const pending = await listPending(userId);
  const now = Date.now();
  const escalated = [];

  for (const item of pending) {
    if (item.escalation_at && new Date(item.escalation_at).getTime() <= now) {
      await escalateItem(item.id, ESCALATION_REASONS.SLA_BREACH, 'Auto-escalated due to SLA breach');
      escalated.push(item.id);
    } else if (item.expires_at && new Date(item.expires_at).getTime() <= now) {
      await patchItem(item.id, {
        status: GOVERNANCE_STATUS.EXPIRED,
        review_comment: 'Auto-expired: deadline reached',
        updated_at: new Date().toISOString(),
      });
    }
  }

  return { escalated_count: escalated.length, escalated_ids: escalated };
}

// ── Persistence ─────────────────────────────────────────────────────────────

async function persistItem(item) {
  try {
    const { error } = await supabase
      .from('di_approval_requests')
      .upsert({
        id: item.id,
        user_id: item.user_id,
        type: item.type,
        title: item.title,
        description: item.description,
        payload: item.payload,
        urgency: item.urgency,
        status: item.status,
        reviewer_id: item.reviewer_id,
        review_comment: item.review_comment,
        reviewed_at: item.reviewed_at,
        expires_at: item.expires_at,
        metadata: {
          task_id: item.task_id,
          step_id: item.step_id,
          review_score: item.review_score,
          escalation_reason: item.escalation_reason,
          escalation_at: item.escalation_at,
        },
        created_at: item.created_at,
        updated_at: item.updated_at,
      });
    if (error) throw error;
  } catch {
    // Fallback: in-memory
    const idx = _governanceItems.findIndex((i) => i.id === item.id);
    if (idx >= 0) _governanceItems[idx] = item;
    else _governanceItems.push(item);
  }
}

async function patchItem(itemId, patch) {
  try {
    const { data, error } = await supabase
      .from('di_approval_requests')
      .update({ ...patch, metadata: patch.escalation_reason ? { escalation_reason: patch.escalation_reason } : undefined })
      .eq('id', itemId)
      .select('*')
      .single();
    if (error) throw error;
    return data;
  } catch {
    const idx = _governanceItems.findIndex((i) => i.id === itemId);
    if (idx >= 0) {
      Object.assign(_governanceItems[idx], patch);
      return _governanceItems[idx];
    }
    return null;
  }
}
