import * as aiEmployeeService from '../aiEmployeeService.js';
import { approvePlan, approveReview, retryTask } from './orchestrator.js';
import { callLLM } from '../aiEmployeeLLMService.js';
import { buildDeliverablePreview } from './deliverableProfile.js';
import { maybeCreateOutputProfileProposalFromReview } from './styleLearning/reviewProposalService.js';

function isOrchestratorTask(task) {
  return Boolean(task?.plan_snapshot?.steps?.length);
}

async function importLegacyLoopActions() {
  return import('../agentLoopService.js');
}

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

export async function runTask(task, userId) {
  if (!task?.id) {
    throw new Error('Task is required.');
  }
  if (!userId) {
    throw new Error('userId is required.');
  }

  if (isOrchestratorTask(task)) {
    if (task.status === 'waiting_approval') {
      await approvePlan(task.id, userId);
      return { nextStatus: 'queued' };
    }

    if (task.status === 'failed') {
      await retryTask(task.id, userId);
      return { nextStatus: 'queued' };
    }

    throw new Error(`Task status "${task.status}" cannot be run from the task board.`);
  }

  const { executeTaskWithLoop } = await import('../aiEmployeeExecutor.js');
  await executeTaskWithLoop(task, userId);
  return { nextStatus: 'in_progress' };
}

export async function resolveReviewDecision(task, {
  userId,
  decision,
  comment = null,
  review = null,
  run = null,
} = {}) {
  if (!task?.id) {
    throw new Error('Task is required.');
  }
  if (!userId) {
    throw new Error('userId is required.');
  }

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

  if (task.status === 'review_hold') {
    if (decision === 'approved') {
      await approveReview(task.id, userId, {
        feedback: comment || null,
        revision,
        llmFn: reviewLlmFn,
      });

      outputProfileProposal = await maybeCreateOutputProfileProposalFromReview({
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

    const nextStatus = decision === 'needs_revision' ? 'failed' : 'blocked';
    const employeeStatus = decision === 'needs_revision' ? 'idle' : 'blocked';

    await aiEmployeeService.updateTaskStatus(task.id, nextStatus);
    if (empId) {
      await aiEmployeeService.updateEmployeeStatus(empId, employeeStatus);
    }

    outputProfileProposal = await maybeCreateOutputProfileProposalFromReview({
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

  const holdStep = task.loop_state?.steps?.find((step) => step.status === 'review_hold');

  if (holdStep) {
    const { approveStepAndContinue, reviseStepAndRetry } = await importLegacyLoopActions();

    if (decision === 'approved') {
      await approveStepAndContinue(task.id, holdStep.name);
      if (empId) {
        await aiEmployeeService.updateEmployeeStatus(empId, 'working');
      }

      outputProfileProposal = await maybeCreateOutputProfileProposalFromReview({
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

      return {
        previousStatus: 'waiting_review',
        nextStatus: 'in_progress',
        employeeStatus: 'working',
        message: outputProfileProposal
          ? 'Review approved and execution resumed. House-style proposal queued for approval.'
          : 'Review approved and execution resumed.',
        toastType: 'success',
        outputProfileProposal,
      };
    }

    if (decision === 'needs_revision') {
      await reviseStepAndRetry(task.id, holdStep.name);
      if (empId) {
        await aiEmployeeService.updateEmployeeStatus(empId, 'working');
      }

      outputProfileProposal = await maybeCreateOutputProfileProposalFromReview({
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

      return {
        previousStatus: 'waiting_review',
        nextStatus: 'in_progress',
        employeeStatus: 'working',
        message: outputProfileProposal
          ? 'Revision requested — task sent back to Aiden. House-style proposal queued for approval.'
          : 'Revision requested — task sent back to Aiden.',
        toastType: 'warning',
        outputProfileProposal,
      };
    }

    await aiEmployeeService.updateTaskStatus(task.id, 'blocked');
    if (empId) {
      await aiEmployeeService.updateEmployeeStatus(empId, 'blocked');
    }

    outputProfileProposal = await maybeCreateOutputProfileProposalFromReview({
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

    return {
      previousStatus: 'waiting_review',
      nextStatus: 'blocked',
      employeeStatus: 'blocked',
      message: outputProfileProposal
        ? 'Task rejected. House-style proposal queued for approval.'
        : 'Task rejected.',
      toastType: 'error',
      outputProfileProposal,
    };
  }

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

  await aiEmployeeService.updateTaskStatus(task.id, nextStatus);
  if (empId) {
    await aiEmployeeService.updateEmployeeStatus(empId, employeeStatus);
  }

  outputProfileProposal = await maybeCreateOutputProfileProposalFromReview({
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

  return {
    previousStatus: task.status || 'waiting_review',
    nextStatus,
    employeeStatus,
    message: outputProfileProposal
      ? `${decision === 'approved'
        ? 'Task approved and marked done.'
        : decision === 'needs_revision'
          ? 'Revision requested — task sent back to Aiden.'
          : 'Task rejected.'} House-style proposal queued for approval.`
      : decision === 'approved'
        ? 'Task approved and marked done.'
        : decision === 'needs_revision'
          ? 'Revision requested — task sent back to Aiden.'
          : 'Task rejected.',
    toastType: decision === 'approved' ? 'success' : decision === 'needs_revision' ? 'warning' : 'error',
    outputProfileProposal,
  };
}

export default {
  runTask,
  resolveReviewDecision,
};
