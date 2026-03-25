/**
 * capabilityPolicyGate.js — Enforces capability-level policies.
 *
 * Two sub-checks:
 *   A) Approval requirement: if the policy requires approval and the worker
 *      autonomy is below auto-approve threshold, hold the step.
 *   B) Sensitive data: if the policy forbids sensitive data and the input
 *      contains sensitive markers, skip the step.
 *
 * Best-effort: if the policy service is unavailable, the step proceeds.
 */

import { stepTransition, STEP_EVENTS } from '../stepStateMachine.js';
import { taskTransition, TASK_EVENTS } from '../taskStateMachine.js';
import * as stepRepo from '../persistence/stepRepo.js';
import * as taskRepo from '../persistence/taskRepo.js';
import { resolveCapabilityClass, getCapabilityPolicyFromDB } from '../../ai-infra/capabilityModelService.js';
import { getLatestMetrics } from '../styleLearning/trustMetricsService.js';
import { eventBus, EVENT_NAMES } from '../../governance/eventBus.js';

// ── Helpers (shared with orchestrator, now local) ──

const AUTONOMY_RANK = { A0: 0, A1: 1, A2: 2, A3: 3, A4: 4 };

async function getAutonomyLevel(employeeId) {
  try {
    const metrics = await getLatestMetrics(employeeId);
    return metrics?.autonomy_level || 'A1';
  } catch {
    return 'A1';
  }
}

function autonomyAtLeast(level, threshold) {
  return (AUTONOMY_RANK[level] || 0) >= (AUTONOMY_RANK[threshold] || 0);
}

const SENSITIVE_MARKERS = ['unit_cost', 'unit_margin', 'salary', 'ssn', 'credit_card'];

function hasSensitiveData(inputData) {
  const str = JSON.stringify(inputData || {}).toLowerCase();
  return SENSITIVE_MARKERS.some(m => str.includes(m));
}

/**
 * @param {import('./stepPipeline.js').StepContext} ctx
 */
export async function capabilityPolicyGate(ctx) {
  const { task, step, stepDef } = ctx;

  const capClass = resolveCapabilityClass({
    tool_type: stepDef.tool_type || 'python_tool',
    builtin_tool_id: stepDef.builtin_tool_id,
  });
  const policy = await getCapabilityPolicyFromDB(capClass, stepDef.builtin_tool_id);

  if (!policy) return { pass: true };

  const stepAutonomy = await getAutonomyLevel(task.employee_id);

  // Sub-check A: Approval requirement
  const planApproved = Boolean(task.input_context?._plan_approved_by);
  if (
    policy.approval_required &&
    !autonomyAtLeast(stepAutonomy, policy.auto_approve_at || 'A3') &&
    !step._capability_approved &&
    !planApproved
  ) {
    const holdMsg = `Capability "${capClass}" requires approval (worker autonomy ${stepAutonomy} < auto-approve threshold ${policy.auto_approve_at})`;

    const holdStatus = stepTransition(step.status, STEP_EVENTS.HOLD);
    await stepRepo.updateStep(step.id, { status: holdStatus, error_message: holdMsg });

    try {
      const nextTaskStatus = taskTransition(task.status, TASK_EVENTS.REVIEW_NEEDED);
      await taskRepo.updateTaskStatus(task.id, nextTaskStatus, task.version);
      task.version += 1;
    } catch { /* task may already be in review */ }

    const holdPayload = {
      taskId: task.id, stepIndex: step.step_index, stepName: step.step_name,
      reason: 'capability_policy_hold', message: holdMsg,
    };
    eventBus.emit(EVENT_NAMES.AGENT_STEP_BLOCKED, holdPayload);

    return { pass: false, action: 'review_hold', error: holdMsg };
  }

  // Sub-check B: Sensitive data
  if (policy.sensitive_data_allowed === false) {
    const inputDataForCheck = task.input_context?.inputData || {};
    if (hasSensitiveData(inputDataForCheck)) {
      const sensitiveMsg = `Capability "${capClass}" does not allow sensitive data access. Remove sensitive fields or use a capability with sensitive_data_allowed=true.`;
      const gateStatus = stepTransition(step.status, STEP_EVENTS.SKIP);
      await stepRepo.updateStep(step.id, {
        status: gateStatus,
        error_message: sensitiveMsg,
        ended_at: new Date().toISOString(),
      });
      return { pass: false, action: 'skipped', error: sensitiveMsg };
    }
  }

  return { pass: true };
}
