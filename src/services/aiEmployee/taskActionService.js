import { approvePlan, approveReview, retryTask, cancelTask } from './orchestrator.js';
import * as taskRepo from './persistence/taskRepo.js';
import * as employeeRepo from './persistence/employeeRepo.js';
import { callLLM } from '../aiEmployeeLLMService.js';
import { buildDeliverablePreview } from './deliverableProfile.js';
import { maybeCreateOutputProfileProposalFromReview } from './styleLearning/reviewProposalService.js';

function buildReviewLlmFn(task, runId = null) {
  return async (prompt) => {
    const { text } = await callLLM({
      taskType: 'review',
      prompt,
      systemPrompt: 'Return only the requested content. If JSON is requested, return valid JSON without markdown fences.',
      maxTokens: 2200,
      routingContext: { highRisk: true },
      trackingMeta: {
        taskId: task.id,
        employeeId: task.employee_id || task.ai_employees?.id || null,
        runId,
        agentRole: 'review_learning',
        stepName: 'manager_review',
      },
    });
    return text;
  };
}

/**
 * Run a task from the task board.
 * All tasks now go through the orchestrator.
 */
export async function runTask(task, userId) {
  if (!task?.id) throw new Error('Task is required.');
  if (!userId) throw new Error('userId is required.');

  if (task.status === 'waiting_approval') {
    await approvePlan(task.id, userId);
    return { nextStatus: 'queued' };
  }

  if (task.status === 'failed') {
    await retryTask(task.id, userId);
    return { nextStatus: 'queued' };
  }

  // Legacy tasks in 'todo' status: they don't have plan_snapshot,
  // so they cannot be run through the orchestrator. Show a clear error.
  if (task.status === 'todo' && !task.plan_snapshot?.steps?.length) {
    throw new Error(
      'This task was created with the legacy system and cannot be executed. ' +
      'Please create a new task from the task board.',
    );
  }

  throw new Error(`Task status "${task.status}" cannot be run from the task board.`);
}

/**
 * Resolve a manager review decision.
 * Unified to always go through the orchestrator for review_hold tasks.
 * Falls back to direct DB updates for legacy waiting_review tasks.
 */
export async function resolveReviewDecision(task, {
  userId,
  decision,
  comment = null,
  review = null,
  run = null,
} = {}) {
  if (!task?.id) throw new Error('Task is required.');
  if (!userId) throw new Error('userId is required.');

  const empId = task.employee_id || task.ai_employees?.id || null;
  const reviewLlmFn = comment ? buildReviewLlmFn(task, run?.id || null) : null;
  const deliverable = task ? buildDeliverablePreview(task) : null;
  const revision = deliverable ? {
    original: {
      headline: deliverable.headline,
      summary: deliverable.summary,
      sections: deliverable.sections,
      previewKind: deliverable.previewKind,
    },
  } : undefined;

  let outputProfileProposal = null;

  // ── Path 1: Orchestrator review_hold — the primary path ──
  if (task.status === 'review_hold') {
    if (decision === 'approved') {
      await approveReview(task.id, userId, {
        feedback: comment || null,
        revision,
        llmFn: reviewLlmFn,
      });

      outputProfileProposal = await _tryCreateProposal(task, review, run, decision, comment, userId);

      return {
        previousStatus: 'review_hold',
        nextStatus: 'in_progress',
        employeeStatus: 'working',
        message: outputProfileProposal
          ? 'Review approved and execution resumed. House-style proposal queued for approval.'
          : 'Review approved and execution resumed.',
        toastType: 'success',
        outputProfileProposal,
      };
    }

    // needs_revision or rejected
    const nextStatus = decision === 'needs_revision' ? 'failed' : 'blocked';
    const employeeStatus = decision === 'needs_revision' ? 'idle' : 'blocked';

    // Use taskRepo directly (version-aware update)
    const currentTask = await taskRepo.getTask(task.id);
    await taskRepo.updateTaskStatus(task.id, nextStatus, currentTask.version);
    if (empId) {
      try { await employeeRepo.updateEmployeeStatus(empId, employeeStatus); } catch { /* best-effort */ }
    }

    outputProfileProposal = await _tryCreateProposal(task, review, run, decision, comment, userId);

    return {
      previousStatus: 'review_hold',
      nextStatus,
      employeeStatus,
      message: outputProfileProposal
        ? `${decision === 'needs_revision'
          ? 'Revision requested. Task marked failed and can be retried from the Task Board.'
          : 'Task rejected.'} House-style proposal queued for approval.`
        : decision === 'needs_revision'
          ? 'Revision requested. Task marked failed and can be retried from the Task Board.'
          : 'Task rejected.',
      toastType: decision === 'needs_revision' ? 'warning' : 'error',
      outputProfileProposal,
    };
  }

  // ── Path 2: Legacy waiting_review tasks ──
  // These are old tasks that went through the legacy loop. Handle with direct DB updates.
  const nextStatus = decision === 'approved'
    ? 'done'
    : decision === 'needs_revision'
      ? 'in_progress'
      : 'blocked';
  const employeeStatus = decision === 'approved'
    ? 'idle'
    : decision === 'needs_revision'
      ? 'working'
      : 'blocked';

  const currentTask = await taskRepo.getTask(task.id);
  await taskRepo.updateTaskStatus(task.id, nextStatus, currentTask.version);
  if (empId) {
    try { await employeeRepo.updateEmployeeStatus(empId, employeeStatus); } catch { /* best-effort */ }
  }

  outputProfileProposal = await _tryCreateProposal(task, review, run, decision, comment, userId);

  return {
    previousStatus: task.status || 'waiting_review',
    nextStatus,
    employeeStatus,
    message: outputProfileProposal
      ? `${decision === 'approved'
        ? 'Task approved and marked done.'
        : decision === 'needs_revision'
          ? 'Revision requested — task sent back for retry.'
          : 'Task rejected.'} House-style proposal queued for approval.`
      : decision === 'approved'
        ? 'Task approved and marked done.'
        : decision === 'needs_revision'
          ? 'Revision requested — task sent back for retry.'
          : 'Task rejected.',
    toastType: decision === 'approved' ? 'success' : decision === 'needs_revision' ? 'warning' : 'error',
    outputProfileProposal,
  };
}

// ── Helpers ──

async function _tryCreateProposal(task, review, run, decision, comment, userId) {
  return maybeCreateOutputProfileProposalFromReview({
    task,
    review,
    run,
    decision,
    comment,
    actorUserId: userId,
  }).catch((err) => {
    console.warn('[taskActionService] review proposal creation failed:', err?.message || err);
    return null;
  });
}

export default {
  runTask,
  resolveReviewDecision,
};
