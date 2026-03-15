import * as aiEmployeeService from '../aiEmployeeService.js';
import { approvePlan, approveReview, retryTask } from './orchestrator.js';

function isOrchestratorTask(task) {
  return Boolean(task?.plan_snapshot?.steps?.length);
}

async function importLegacyLoopActions() {
  return import('../agentLoopService.js');
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
} = {}) {
  if (!task?.id) {
    throw new Error('Task is required.');
  }
  if (!userId) {
    throw new Error('userId is required.');
  }

  const empId = task.employee_id || task.ai_employees?.id || null;

  if (task.status === 'review_hold') {
    if (decision === 'approved') {
      await approveReview(task.id, userId, { feedback: comment || null });
      return {
        previousStatus: 'review_hold',
        nextStatus: 'in_progress',
        employeeStatus: 'working',
        message: 'Review approved and execution resumed.',
        toastType: 'success',
      };
    }

    const nextStatus = decision === 'needs_revision' ? 'failed' : 'blocked';
    const employeeStatus = decision === 'needs_revision' ? 'idle' : 'blocked';

    await aiEmployeeService.updateTaskStatus(task.id, nextStatus);
    if (empId) {
      await aiEmployeeService.updateEmployeeStatus(empId, employeeStatus);
    }

    return {
      previousStatus: 'review_hold',
      nextStatus,
      employeeStatus,
      message: decision === 'needs_revision'
        ? 'Revision requested. Task marked failed and can be retried from the Task Board.'
        : 'Task rejected.',
      toastType: decision === 'needs_revision' ? 'warning' : 'error',
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
      return {
        previousStatus: 'waiting_review',
        nextStatus: 'in_progress',
        employeeStatus: 'working',
        message: 'Review approved and execution resumed.',
        toastType: 'success',
      };
    }

    if (decision === 'needs_revision') {
      await reviseStepAndRetry(task.id, holdStep.name);
      if (empId) {
        await aiEmployeeService.updateEmployeeStatus(empId, 'working');
      }
      return {
        previousStatus: 'waiting_review',
        nextStatus: 'in_progress',
        employeeStatus: 'working',
        message: 'Revision requested — task sent back to Aiden.',
        toastType: 'warning',
      };
    }

    await aiEmployeeService.updateTaskStatus(task.id, 'blocked');
    if (empId) {
      await aiEmployeeService.updateEmployeeStatus(empId, 'blocked');
    }

    return {
      previousStatus: 'waiting_review',
      nextStatus: 'blocked',
      employeeStatus: 'blocked',
      message: 'Task rejected.',
      toastType: 'error',
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

  return {
    previousStatus: task.status || 'waiting_review',
    nextStatus,
    employeeStatus,
    message: decision === 'approved'
      ? 'Task approved and marked done.'
      : decision === 'needs_revision'
        ? 'Revision requested — task sent back to Aiden.'
        : 'Task rejected.',
    toastType: decision === 'approved' ? 'success' : decision === 'needs_revision' ? 'warning' : 'error',
  };
}

export default {
  runTask,
  resolveReviewDecision,
};
