/**
 * approvalWorkflowService.js
 *
 * Enhanced approval workflow with deadline tracking, batch operations,
 * proactive reminders, and audit trail integration.
 *
 * Wraps the existing planGovernanceService with deadline and batch capabilities.
 */

import {
  requestPlanApproval,
  approvePlanApproval,
  rejectPlanApproval,
} from './planGovernanceService';

// ── Configuration ────────────────────────────────────────────────────────────

export const APPROVAL_CONFIG = {
  default_deadline_hours: 24,
  reminder_intervals_hours: [4, 1],   // remind at 4h and 1h before deadline
  batch_approval_max: 10,
};

// ── Enhanced Approval Request ────────────────────────────────────────────────

/**
 * Request approval with a deadline.
 *
 * @param {Object} params
 * @param {number} params.runId
 * @param {string} params.userId
 * @param {string} params.conversationId
 * @param {number} [params.deadlineHours] - hours until deadline (default: 24)
 * @param {string} [params.narrative] - summary text for the approval
 * @param {Object} [params.kpiSnapshot] - plan KPIs at time of request
 * @returns {Object} EnhancedApproval
 */
export async function requestApprovalWithDeadline({
  runId,
  userId,
  conversationId,
  deadlineHours = APPROVAL_CONFIG.default_deadline_hours,
  narrative = '',
  kpiSnapshot = {},
}) {
  // Call existing governance service
  const baseApproval = await requestPlanApproval({
    run_id: runId,
    user_id: userId,
  });

  const requestedAt = new Date();
  const deadline = new Date(requestedAt.getTime() + deadlineHours * 60 * 60 * 1000);

  return {
    approval_id: baseApproval?.approval_id || `approval_${runId}_${Date.now()}`,
    run_id: runId,
    status: 'PENDING',
    requested_at: requestedAt.toISOString(),
    deadline: deadline.toISOString(),
    deadline_hours_remaining: deadlineHours,
    requested_by: userId,
    decided_by: null,
    decided_at: null,
    note: '',
    narrative_summary: narrative,
    kpi_snapshot: kpiSnapshot,
    conversation_id: conversationId,
  };
}

// ── Deadline Status ──────────────────────────────────────────────────────────

/**
 * Get the deadline status for an approval.
 *
 * @param {Object} approval - { deadline, status }
 * @returns {Object} { hours_remaining, minutes_remaining, is_urgent, is_critical, is_expired }
 */
export function getApprovalDeadlineStatus(approval) {
  if (!approval?.deadline) {
    return { hours_remaining: null, minutes_remaining: null, is_urgent: false, is_critical: false, is_expired: false };
  }

  if (approval.status !== 'PENDING') {
    return { hours_remaining: null, minutes_remaining: null, is_urgent: false, is_critical: false, is_expired: false };
  }

  const now = Date.now();
  const deadlineMs = new Date(approval.deadline).getTime();
  const remainingMs = deadlineMs - now;

  const hoursRemaining = remainingMs / (1000 * 60 * 60);
  const minutesRemaining = remainingMs / (1000 * 60);

  return {
    hours_remaining: Math.max(0, Math.round(hoursRemaining * 10) / 10),
    minutes_remaining: Math.max(0, Math.round(minutesRemaining)),
    is_urgent: hoursRemaining <= 4 && hoursRemaining > 1,
    is_critical: hoursRemaining <= 1 && hoursRemaining > 0,
    is_expired: remainingMs <= 0,
  };
}

// ── Batch Operations ─────────────────────────────────────────────────────────

/**
 * Batch approve multiple approvals.
 *
 * @param {Object} params
 * @param {Array<string>} params.approvalIds
 * @param {string} params.userId
 * @param {string} [params.note]
 * @returns {Promise<Array<Object>>} results for each approval
 */
export async function batchApprove({ approvalIds, userId, note = '' }) {
  const results = [];
  const batch = approvalIds.slice(0, APPROVAL_CONFIG.batch_approval_max);

  for (const approvalId of batch) {
    try {
      const result = await approvePlanApproval({
        approval_id: approvalId,
        user_id: userId,
        note,
      });
      results.push({ approval_id: approvalId, status: 'APPROVED', result });
    } catch (error) {
      results.push({ approval_id: approvalId, status: 'ERROR', error: error?.message });
    }
  }

  return results;
}

/**
 * Batch reject multiple approvals.
 *
 * @param {Object} params
 * @param {Array<string>} params.approvalIds
 * @param {string} params.userId
 * @param {string} [params.note]
 * @returns {Promise<Array<Object>>} results for each approval
 */
export async function batchReject({ approvalIds, userId, note = '' }) {
  const results = [];
  const batch = approvalIds.slice(0, APPROVAL_CONFIG.batch_approval_max);

  for (const approvalId of batch) {
    try {
      const result = await rejectPlanApproval({
        approval_id: approvalId,
        user_id: userId,
        note,
      });
      results.push({ approval_id: approvalId, status: 'REJECTED', result });
    } catch (error) {
      results.push({ approval_id: approvalId, status: 'ERROR', error: error?.message });
    }
  }

  return results;
}

// ── Reminder Scheduling ──────────────────────────────────────────────────────

/**
 * Schedule approval deadline reminders.
 * Returns a cancel function to clear all timers.
 *
 * @param {Object} params
 * @param {string} params.approvalId
 * @param {string} params.deadline - ISO string
 * @param {string} params.runId
 * @param {string} params.narrativeSummary
 * @param {Function} params.onReminder - (reminderPayload) => void
 * @returns {Function} cancel - call to clear all scheduled reminders
 */
export function scheduleApprovalReminders({ approvalId, deadline, runId, narrativeSummary, onReminder }) {
  const deadlineMs = new Date(deadline).getTime();
  const timerIds = [];

  for (const hoursBeforeDeadline of APPROVAL_CONFIG.reminder_intervals_hours) {
    const reminderTime = deadlineMs - hoursBeforeDeadline * 60 * 60 * 1000;
    const delay = reminderTime - Date.now();

    if (delay > 0) {
      const timerId = setTimeout(() => {
        onReminder({
          type: 'approval_reminder_card',
          approval_id: approvalId,
          run_id: runId,
          hours_remaining: hoursBeforeDeadline,
          deadline,
          narrative_summary: narrativeSummary,
          is_critical: hoursBeforeDeadline <= 1,
        });
      }, delay);

      timerIds.push(timerId);
    }
  }

  // Return cancel function
  return () => {
    timerIds.forEach(clearTimeout);
  };
}

// ── Card Payload Builders ────────────────────────────────────────────────────

/**
 * Build the payload for EnhancedPlanApprovalCard.
 *
 * @param {Object} params
 * @param {Object} params.approval - EnhancedApproval object
 * @param {Object} [params.planSummary] - plan summary text
 * @param {Array} [params.allPendingApprovals] - all pending approvals (for batch context)
 * @param {Array} [params.auditTrail] - recent audit events
 * @returns {Object} card payload
 */
export function buildEnhancedApprovalCardPayload({
  approval,
  planSummary = '',
  allPendingApprovals = [],
  auditTrail = [],
}) {
  const deadlineStatus = getApprovalDeadlineStatus(approval);
  const pendingOthers = allPendingApprovals.filter(
    (a) => a.approval_id !== approval.approval_id && a.status === 'PENDING'
  );

  return {
    requires_approval: true,
    run_id: approval.run_id,
    approval,
    summary_text: planSummary || approval.narrative_summary,
    deadline: approval.deadline,
    deadline_hours_remaining: deadlineStatus.hours_remaining,
    is_urgent: deadlineStatus.is_urgent,
    is_critical: deadlineStatus.is_critical,
    is_expired: deadlineStatus.is_expired,
    batch_context: pendingOthers.length > 0
      ? {
          total_pending: pendingOthers.length + 1,
          approval_ids: [approval.approval_id, ...pendingOthers.map((a) => a.approval_id)],
          run_ids: [approval.run_id, ...pendingOthers.map((a) => a.run_id)],
        }
      : null,
    audit_trail: auditTrail.slice(0, 10),
  };
}

// ── Closed-Loop Approval Integration ─────────────────────────────────────────

/**
 * Request approval for a closed-loop rerun.
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} params.conversationId
 * @param {Object} params.closedLoopRun      - run record from closedLoopStore
 * @param {Object} params.paramPatch         - proposed parameter changes
 * @param {string} params.triggerType        - what triggered the rerun
 * @param {number} [params.estimatedBenefit] - estimated net benefit USD
 * @returns {Object} EnhancedApproval with closed-loop context
 */
export async function requestClosedLoopApproval({
  userId,
  conversationId,
  closedLoopRun,
  paramPatch,
  triggerType,
  estimatedBenefit = 0,
}) {
  const narrative = `Closed-loop trigger: ${triggerType}. Proposed parameter changes: ${JSON.stringify(paramPatch)}. Estimated net benefit: $${estimatedBenefit.toLocaleString()}.`;

  const approval = await requestApprovalWithDeadline({
    runId: closedLoopRun?.planning_run_id || closedLoopRun?.id || 0,
    userId,
    conversationId,
    deadlineHours: estimatedBenefit > 10000 ? 4 : APPROVAL_CONFIG.default_deadline_hours,
    narrative,
    kpiSnapshot: {
      trigger_type: triggerType,
      param_patch: paramPatch,
      estimated_benefit_usd: estimatedBenefit,
      closed_loop_run_id: closedLoopRun?.id,
    },
  });

  return {
    ...approval,
    approval_type: 'closed_loop',
    closed_loop_run_id: closedLoopRun?.id,
    trigger_type: triggerType,
    param_patch: paramPatch,
    estimated_benefit_usd: estimatedBenefit,
  };
}

/**
 * Request approval for a risk-driven replan.
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} params.conversationId
 * @param {Object} params.recommendationCard - from riskClosedLoopService
 * @returns {Object} EnhancedApproval with risk context
 */
export async function requestRiskReplanApproval({
  userId,
  conversationId,
  recommendationCard,
}) {
  const payload = recommendationCard?.payload || {};
  const trigger = payload.trigger || {};
  const params = payload.recommended_params || {};
  const benefit = payload.benefit || {};

  const narrative = `Risk replan: ${trigger.high_risk_sku_count || 0} high-risk SKU(s), max score ${trigger.max_risk_score || 0}. ${params.reason || ''}`;

  const approval = await requestApprovalWithDeadline({
    runId: trigger.base_plan_run_id || 0,
    userId,
    conversationId,
    deadlineHours: (trigger.critical_risk_sku_count || 0) > 0 ? 2 : 8,
    narrative,
    kpiSnapshot: {
      high_risk_skus: trigger.high_risk_sku_count,
      critical_risk_skus: trigger.critical_risk_sku_count,
      max_risk_score: trigger.max_risk_score,
      safety_stock_alpha: params.safety_stock_alpha,
      estimated_net_benefit: benefit.estimated_net_benefit_usd,
    },
  });

  return {
    ...approval,
    approval_type: 'risk_replan',
    risk_run_id: trigger.source_risk_run_id,
    plan_run_id: trigger.base_plan_run_id,
    recommended_params: params,
    benefit,
  };
}

/**
 * Build a unified approval card payload for any approval type.
 */
export function buildUnifiedApprovalCard(approval) {
  const deadlineStatus = getApprovalDeadlineStatus(approval);

  return {
    type: 'unified_approval_card',
    payload: {
      approval_id: approval.approval_id,
      approval_type: approval.approval_type || 'plan_commit',
      run_id: approval.run_id,
      status: approval.status,
      title: approval.narrative_summary || `Approval for Run #${approval.run_id}`,
      deadline: approval.deadline,
      deadline_status: deadlineStatus,
      kpi_snapshot: approval.kpi_snapshot || {},
      decision_options: [
        {
          id: 'approve',
          label: 'Approve',
          variant: 'primary',
          action: 'approve',
        },
        {
          id: 'reject',
          label: 'Reject',
          variant: 'danger',
          action: 'reject',
        },
        ...(approval.approval_type === 'risk_replan' ? [{
          id: 'approve_conservative',
          label: 'Approve (Conservative)',
          variant: 'warning',
          action: 'approve_conservative',
        }] : []),
      ],
    },
  };
}

export default {
  requestApprovalWithDeadline,
  getApprovalDeadlineStatus,
  batchApprove,
  batchReject,
  scheduleApprovalReminders,
  buildEnhancedApprovalCardPayload,
  requestClosedLoopApproval,
  requestRiskReplanApproval,
  buildUnifiedApprovalCard,
  APPROVAL_CONFIG,
};
