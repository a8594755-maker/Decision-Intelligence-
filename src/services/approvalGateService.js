/**
 * approvalGateService.js — Enforces review_gate before publish/writeback
 *
 * Responsibilities:
 *   1. Before any publish step, check if the task has an approved review resolution
 *   2. Enforce approval policy (from reviewContract.js) per action type
 *   3. Guard writeback_payload — never allow unapproved mutations in v1
 *   4. Autonomy-gated auto-approve for low-risk actions
 *
 * Design principle: orchestrator calls `enforceApprovalGate()` before publish steps.
 * If gate fails, task transitions to AWAITING_APPROVAL and tick loop pauses.
 *
 * @module services/approvalGateService
 */

import {
  REVIEW_DECISIONS,
  checkApprovalGate,
  createApprovalPolicy,
  createReviewResolution,
  validateReviewResolution,
} from '../contracts/reviewContract.js';

// ── In-memory approval store (v1: Supabase later) ─────────────────────────

const _resolutionStore = new Map();  // taskId → ReviewResolution
const _policyStore = new Map();       // workerTemplateId → ApprovalPolicy

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Enforce the approval gate for a publish-phase step.
 *
 * Returns { allowed, reason, resolution? }
 *   - allowed=true → proceed with publish
 *   - allowed=false → task should transition to AWAITING_APPROVAL
 *
 * @param {Object} params
 * @param {string} params.taskId
 * @param {string} params.actionType - 'export' | 'writeback' | 'notify'
 * @param {Object} params.writebackPayload - The writeback_payload artifact (if writeback)
 * @param {Object} params.decisionBrief - The decision_brief artifact
 * @param {string} [params.workerTemplateId] - Worker template for policy lookup
 * @param {string} [params.autonomyLevel] - Current autonomy level (A0-A4)
 * @returns {{ allowed: boolean, reason: string, resolution?: Object }}
 */
export function enforceApprovalGate({
  taskId,
  actionType,
  writebackPayload = null,
  decisionBrief = null,
  workerTemplateId = null,
  autonomyLevel = 'A1',
}) {
  // 1. Check if we already have an approved resolution for this task
  const resolution = _resolutionStore.get(taskId);
  if (resolution) {
    if (resolution.decision === REVIEW_DECISIONS.APPROVED) {
      // Check if this specific action type was approved via publish_permission
      const perm = resolution.publish_permission || {};
      if (actionType === 'writeback' && !perm.writeback) {
        return { allowed: false, reason: 'Writeback not permitted in approval resolution' };
      }
      if (actionType === 'export' && perm.export === false) {
        return { allowed: false, reason: 'Export not permitted in approval resolution' };
      }
      if (actionType === 'notify' && perm.notify === false) {
        return { allowed: false, reason: 'Notification not permitted in approval resolution' };
      }
      return { allowed: true, reason: `Approved by ${resolution.reviewer_id}`, resolution };
    }

    if (resolution.decision === REVIEW_DECISIONS.REJECTED) {
      return { allowed: false, reason: `Rejected: ${resolution.review_notes || 'No reason given'}` };
    }

    if (resolution.decision === REVIEW_DECISIONS.REVISION_REQUESTED) {
      return { allowed: false, reason: `Revision requested: ${resolution.revision_instructions || 'See notes'}` };
    }

    if (resolution.decision === REVIEW_DECISIONS.DEFERRED) {
      return { allowed: false, reason: 'Review deferred — cannot publish until approved' };
    }
  }

  // 2. No resolution yet — check policy for auto-approve eligibility
  const policy = _policyStore.get(workerTemplateId) || createApprovalPolicy({ worker_template_id: workerTemplateId });

  const context = {
    autonomy_level: autonomyLevel,
    cost_delta: decisionBrief?.business_impact?.cost_delta || decisionBrief?.business_impact?.total_cost || 0,
    risk_level: _highestRiskLevel(decisionBrief?.risk_flags),
    affected_records_count: writebackPayload?.affected_records?.length || 0,
  };

  const gateResult = checkApprovalGate(policy, actionType, context);

  if (!gateResult.requires_approval) {
    // Auto-approve — create implicit resolution
    const autoResolution = createReviewResolution({
      decision: REVIEW_DECISIONS.APPROVED,
      reviewer_id: `auto:${autonomyLevel}`,
      task_id: taskId,
      review_notes: `Auto-approved: ${gateResult.reason}`,
      publish_permission: { export: true, writeback: actionType === 'writeback', notify: actionType === 'notify' },
    });
    _resolutionStore.set(taskId, autoResolution);
    return { allowed: true, reason: gateResult.reason, resolution: autoResolution };
  }

  // 3. Approval required — return not allowed
  return { allowed: false, reason: gateResult.reason };
}

/**
 * Submit a review resolution for a task.
 *
 * @param {string} taskId
 * @param {Object} resolution - Review resolution object
 * @returns {{ ok: boolean, errors?: string[] }}
 */
export function submitResolution(taskId, resolution) {
  const validation = validateReviewResolution(resolution);
  if (!validation.valid) {
    return { ok: false, errors: validation.errors };
  }
  _resolutionStore.set(taskId, resolution);
  return { ok: true };
}

/**
 * Get the current resolution for a task.
 */
export function getResolution(taskId) {
  return _resolutionStore.get(taskId) || null;
}

/**
 * Register an approval policy for a worker template.
 */
export function registerPolicy(workerTemplateId, policy) {
  _policyStore.set(workerTemplateId, policy);
}

/**
 * Get the approval policy for a worker template.
 */
export function getPolicy(workerTemplateId) {
  return _policyStore.get(workerTemplateId) || createApprovalPolicy({ worker_template_id: workerTemplateId });
}

/**
 * Clear resolution for a task (e.g., after revision).
 */
export function clearResolution(taskId) {
  _resolutionStore.delete(taskId);
}

/**
 * Check if a writeback_payload has a valid idempotency key.
 */
export function validateIdempotencyKey(payload) {
  if (!payload?.idempotency_key) {
    return { valid: false, reason: 'Missing idempotency_key' };
  }
  if (typeof payload.idempotency_key !== 'string' || payload.idempotency_key.length < 8) {
    return { valid: false, reason: 'Invalid idempotency_key format' };
  }
  return { valid: true };
}

// ── Internal helpers ────────────────────────────────────────────────────────

function _highestRiskLevel(riskFlags) {
  if (!Array.isArray(riskFlags) || riskFlags.length === 0) return 'low';
  const order = ['low', 'medium', 'high', 'critical'];
  let highest = 0;
  for (const flag of riskFlags) {
    const idx = order.indexOf(flag.level);
    if (idx > highest) highest = idx;
  }
  return order[highest];
}

// ── Reset (for testing) ─────────────────────────────────────────────────────

export function _resetForTesting() {
  _resolutionStore.clear();
  _policyStore.clear();
}
