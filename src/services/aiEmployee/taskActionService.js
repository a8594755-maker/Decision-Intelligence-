import { approvePlan, approveReview, retryTask } from './orchestrator.js';
import { TASK_STATES } from './taskStateMachine.js';
import { EMPLOYEE_STATES, EMPLOYEE_STATE_TO_DB } from './employeeStateMachine.js';
import { callLLM } from '../ai-infra/aiEmployeeLLMService.js';
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
 * All tasks go through the orchestrator.
 */
export async function runTask(task, userId) {
  if (!task?.id) throw new Error('Task is required.');
  if (!userId) throw new Error('userId is required.');

  if (task.status === TASK_STATES.WAITING_APPROVAL) {
    await approvePlan(task.id, userId);
    return { nextStatus: TASK_STATES.QUEUED };
  }

  if (task.status === TASK_STATES.FAILED) {
    await retryTask(task.id, userId);
    return { nextStatus: TASK_STATES.QUEUED };
  }

  throw new Error(`Task status "${task.status}" cannot be run from the task board.`);
}

/**
 * Resolve a manager review decision.
 * All review tasks go through the orchestrator.
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

  if (task.status !== TASK_STATES.REVIEW_HOLD) {
    throw new Error(`Task status "${task.status}" is not reviewable.`);
  }

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

  if (decision === 'approved') {
    await approveReview(task.id, userId, {
      feedback: comment || null,
      revision,
      llmFn: reviewLlmFn,
    });

    outputProfileProposal = await _tryCreateProposal(task, review, run, decision, comment, userId);

    return {
      previousStatus: TASK_STATES.REVIEW_HOLD,
      nextStatus: TASK_STATES.IN_PROGRESS,
      employeeStatus: EMPLOYEE_STATE_TO_DB[EMPLOYEE_STATES.BUSY],
      message: outputProfileProposal
        ? 'Review approved and execution resumed. House-style proposal queued for approval.'
        : 'Review approved and execution resumed.',
      toastType: 'success',
      outputProfileProposal,
    };
  }

  // needs_revision or rejected — route through orchestrator for consistent state transitions
  await approveReview(task.id, userId, {
    feedback: comment || null,
    decision,
    revision,
    llmFn: reviewLlmFn,
  });

  outputProfileProposal = await _tryCreateProposal(task, review, run, decision, comment, userId);

  return {
    previousStatus: TASK_STATES.REVIEW_HOLD,
    nextStatus: TASK_STATES.FAILED,
    employeeStatus: EMPLOYEE_STATE_TO_DB[EMPLOYEE_STATES.IDLE],
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
