/**
 * orchestrator.js — The single owner of all task/step/employee state transitions.
 *
 * ★ This is the ONLY module that mutates task state in the database. ★
 *
 * Responsibilities:
 *   1. Accept plans from Planner → create task + steps in DB
 *   2. On approval → queue and start tick loop
 *   3. tick() → run next pending step via Executor → handle result
 *   4. Chain artifacts between steps
 *   5. Handle errors via selfHealingService → retry or fail
 *   6. Emit events via eventBus for UI updates
 *   7. Manage employee state transitions
 */

import { taskTransition, TASK_STATES, TASK_EVENTS, isTaskTerminal } from './taskStateMachine.js';
import { stepTransition, STEP_STATES, STEP_EVENTS, isStepTerminal, isStepFailed } from './stepStateMachine.js';
import { employeeTransition, EMPLOYEE_STATES, EMPLOYEE_EVENTS } from './employeeStateMachine.js';

import * as taskRepo from './persistence/taskRepo.js';
import * as stepRepo from './persistence/stepRepo.js';
import * as employeeRepo from './persistence/employeeRepo.js';

import { getExecutor } from './executors/executorRegistry.js';
import { classifyError, chooseHealingStrategy } from '../selfHealingService.js';
import { eventBus, EVENT_NAMES } from '../eventBus.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const TICK_DELAY_MS = 500; // Delay between steps to avoid overloading

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Submit a task plan. Creates task in draft_plan → transitions to waiting_approval.
 *
 * @param {object} plan
 * @param {string} plan.title
 * @param {string} plan.description
 * @param {Array<{name, tool_hint, tool_type, builtin_tool_id?}>} plan.steps
 * @param {object} plan.inputData - { sheets, datasetProfileRow, userId }
 * @param {object} plan.llmConfig - { provider, model, temperature, max_tokens }
 * @param {string} employeeId
 * @param {string} userId
 * @returns {Promise<{taskId: string, task: object}>}
 */
export async function submitPlan(plan, employeeId, userId) {
  // 1. Create task in draft_plan
  const task = await taskRepo.createTask({
    employeeId,
    title: plan.title,
    description: plan.description,
    assignedByUserId: userId,
    inputContext: {
      inputData: plan.inputData,
      llmConfig: plan.llmConfig,
    },
    planSnapshot: {
      steps: plan.steps,
      llmConfig: plan.llmConfig,
      submittedAt: new Date().toISOString(),
    },
  });

  // 2. Create step rows
  await stepRepo.createSteps(task.id, employeeId, plan.steps);

  // 3. Transition to waiting_approval
  const nextStatus = taskTransition(TASK_STATES.DRAFT_PLAN, TASK_EVENTS.PLAN_READY);
  const updated = await taskRepo.updateTaskStatus(task.id, nextStatus, task.version);

  eventBus.emit(EVENT_NAMES.TASK_CREATED, { taskId: task.id, title: plan.title, steps: plan.steps });

  return { taskId: task.id, task: updated };
}

/**
 * Approve a plan and start execution.
 * @param {string} taskId
 * @param {string} userId
 * @returns {Promise<void>}
 */
export async function approvePlan(taskId, userId) {
  const task = await taskRepo.getTask(taskId);

  // Transition: waiting_approval → queued
  const queuedStatus = taskTransition(task.status, TASK_EVENTS.APPROVE);
  const queued = await taskRepo.updateTaskStatus(taskId, queuedStatus, task.version);

  // Transition: queued → in_progress
  const activeStatus = taskTransition(queuedStatus, TASK_EVENTS.START);
  const active = await taskRepo.updateTaskStatus(taskId, activeStatus, queued.version);

  // Update employee state: idle → busy
  const employee = await employeeRepo.getEmployee(active.employee_id);
  try {
    const empState = employeeTransition(employee._logicalState, EMPLOYEE_EVENTS.TASK_STARTED);
    await employeeRepo.updateEmployeeStatus(active.employee_id, empState);
  } catch {
    // Employee may already be busy from another task — don't block
  }

  eventBus.emit(EVENT_NAMES.TASK_STARTED, { taskId, userId });

  // Start the tick loop
  _runTickLoop(taskId);
}

/**
 * Cancel a task.
 */
export async function cancelTask(taskId, userId) {
  const task = await taskRepo.getTask(taskId);
  const nextStatus = taskTransition(task.status, TASK_EVENTS.CANCEL);
  await taskRepo.updateTaskStatus(taskId, nextStatus, task.version);

  // Reset employee to idle
  try {
    const empState = employeeTransition(EMPLOYEE_STATES.BUSY, EMPLOYEE_EVENTS.TASK_DONE);
    await employeeRepo.updateEmployeeStatus(task.employee_id, empState);
  } catch { /* ignore */ }

  eventBus.emit(EVENT_NAMES.TASK_FAILED, { taskId, reason: 'cancelled' });
}

/**
 * Retry a failed task (re-queue it).
 */
export async function retryTask(taskId, userId) {
  const task = await taskRepo.getTask(taskId);
  const nextStatus = taskTransition(task.status, TASK_EVENTS.RETRY);
  const queued = await taskRepo.updateTaskStatus(taskId, nextStatus, task.version);

  // Re-start execution
  const activeStatus = taskTransition(nextStatus, TASK_EVENTS.START);
  await taskRepo.updateTaskStatus(taskId, activeStatus, queued.version);

  _runTickLoop(taskId);
}

/**
 * Approve a review hold and continue execution.
 */
export async function approveReview(taskId, userId) {
  const task = await taskRepo.getTask(taskId);
  const nextStatus = taskTransition(task.status, TASK_EVENTS.REVIEW_APPROVED);
  await taskRepo.updateTaskStatus(taskId, nextStatus, task.version);

  // Continue tick loop
  _runTickLoop(taskId);
}

/**
 * Execute a single tick — find next pending step, run it, handle result.
 * @returns {Promise<{done: boolean, stepResult?: object}>}
 */
export async function tick(taskId) {
  const task = await taskRepo.getTask(taskId);

  if (isTaskTerminal(task.status)) {
    return { done: true };
  }

  // Find next step to execute
  const step = await stepRepo.getNextPendingStep(taskId);
  if (!step) {
    // All steps done — transition task to done
    console.log(`[Orchestrator] All steps complete for task ${taskId} — finishing`);
    await _completeTask(task);
    return { done: true };
  }

  // Execute the step
  console.log(`[Orchestrator] Tick: executing step ${step.step_index} "${step.step_name}" (status=${step.status})`);
  const result = await _executeStep(task, step);
  console.log(`[Orchestrator] Step ${step.step_index} "${step.step_name}" result: ok=${result.ok}${result.error ? ', error=' + (result.error || '').slice(0, 150) : ''}`);
  return { done: false, stepResult: result };
}

// ── Internal: Tick Loop ───────────────────────────────────────────────────────

async function _runTickLoop(taskId) {
  let running = true;
  while (running) {
    try {
      const { done } = await tick(taskId);
      if (done) {
        running = false;
      } else {
        // Small delay between steps
        await new Promise(r => setTimeout(r, TICK_DELAY_MS));
      }
    } catch (err) {
      console.error(`[Orchestrator] Tick loop error for task ${taskId}:`, err);

      // Try to fail the task gracefully
      try {
        const task = await taskRepo.getTask(taskId);
        if (!isTaskTerminal(task.status)) {
          const nextStatus = taskTransition(task.status, TASK_EVENTS.FAIL);
          await taskRepo.updateTaskStatus(taskId, nextStatus, task.version);
          await _resetEmployee(task.employee_id);
          eventBus.emit(EVENT_NAMES.TASK_FAILED, { taskId, error: err.message });
        }
      } catch { /* last resort */ }
      running = false;
    }
  }
}

// ── Internal: Step Execution ──────────────────────────────────────────────────

async function _executeStep(task, step) {
  const planSnapshot = task.plan_snapshot || {};
  const planSteps = planSnapshot.steps || [];
  const stepDef = planSteps[step.step_index] || {};

  // Transition step: pending/retrying → running
  const runningStatus = stepTransition(step.status, STEP_EVENTS.START);
  await stepRepo.updateStep(step.id, { status: runningStatus, started_at: new Date().toISOString() });

  eventBus.emit(EVENT_NAMES.AGENT_STEP_STARTED, {
    taskId: task.id,
    stepIndex: step.step_index,
    stepName: step.step_name,
  });

  // Gather prior artifacts from completed steps — keyed by step name for /execute-tool
  const allSteps = await stepRepo.getSteps(task.id);
  const priorArtifacts = {};
  const priorStepResults = [];
  for (const s of allSteps) {
    if (s.step_index < step.step_index && s.status === 'succeeded') {
      const arts = s.artifact_refs || [];
      priorArtifacts[s.step_name] = arts;
      priorStepResults.push({ step_name: s.step_name, status: s.status, artifacts: arts });
    }
  }

  // Build step input
  const inputData = {
    ...(task.input_context?.inputData || {}),
    priorArtifacts,
    priorStepResults,
  };

  const stepInput = {
    step: {
      name: step.step_name,
      tool_hint: stepDef.tool_hint || step.step_name,
      builtin_tool_id: stepDef.builtin_tool_id,
      tool_type: stepDef.tool_type || 'python_tool',
      report_format: stepDef.report_format,
      opencloud_action: stepDef.opencloud_action,
      opencloud_config: stepDef.opencloud_config,
      review_checkpoint: stepDef.review_checkpoint,
    },
    inputData,
    llmConfig: planSnapshot.llmConfig || task.input_context?.llmConfig || {},
    taskId: task.id,
    stepIndex: step.step_index,
  };

  // Get executor and run
  let executor;
  try {
    executor = getExecutor(stepInput.step.tool_type);
  } catch (err) {
    await _handleStepFailure(task, step, err.message);
    return { ok: false, error: err.message };
  }

  try {
    const result = await executor(stepInput);

    if (result.ok) {
      await _handleStepSuccess(task, step, result, stepDef);
      return result;
    } else {
      await _handleStepFailure(task, step, result.error || 'Executor returned ok=false');
      return result;
    }
  } catch (err) {
    await _handleStepFailure(task, step, err.message);
    return { ok: false, error: err.message };
  }
}

async function _handleStepSuccess(task, step, result, stepDef) {
  // Transition step → succeeded
  await stepRepo.markStepSucceeded(step.id, {
    summary: result.logs?.join('\n') || '',
    artifactRefs: result.artifacts || [],
  });

  eventBus.emit(EVENT_NAMES.AGENT_STEP_COMPLETED, {
    taskId: task.id,
    stepIndex: step.step_index,
    stepName: step.step_name,
    artifacts: result.artifacts,
  });

  // Check if this step requires review
  if (stepDef.review_checkpoint) {
    const nextTaskStatus = taskTransition(task.status, TASK_EVENTS.REVIEW_NEEDED);
    const updated = await taskRepo.updateTaskStatus(task.id, nextTaskStatus, task.version);

    const employee = await employeeRepo.getEmployee(task.employee_id);
    try {
      const empState = employeeTransition(employee._logicalState, EMPLOYEE_EVENTS.REVIEW_NEEDED);
      await employeeRepo.updateEmployeeStatus(task.employee_id, empState);
    } catch { /* ignore */ }

    eventBus.emit(EVENT_NAMES.REVIEW_REQUESTED, {
      taskId: task.id,
      stepIndex: step.step_index,
    });
  }
}

async function _handleStepFailure(task, step, errorMessage) {
  const healing = chooseHealingStrategy(errorMessage, step, step.retry_count || 0);

  if (healing.healingStrategy === 'block_immediately') {
    // Non-recoverable — fail step and task
    await stepRepo.markStepFailed(step.id, errorMessage);
    const nextTaskStatus = taskTransition(task.status, TASK_EVENTS.FAIL);
    await taskRepo.updateTaskStatus(task.id, nextTaskStatus, task.version);
    await _resetEmployee(task.employee_id);

    eventBus.emit(EVENT_NAMES.AGENT_STEP_FAILED, {
      taskId: task.id, stepIndex: step.step_index, error: errorMessage, healing,
    });
    eventBus.emit(EVENT_NAMES.TASK_FAILED, { taskId: task.id, error: errorMessage });
    return;
  }

  // Can we retry?
  const retryCount = (step.retry_count || 0) + 1;
  if (retryCount <= MAX_RETRIES && healing.healingStrategy !== 'skip_with_fallback') {
    // Mark step as retrying
    await stepRepo.markStepRetrying(step.id, step.retry_count || 0);

    eventBus.emit(EVENT_NAMES.AGENT_STEP_FAILED, {
      taskId: task.id, stepIndex: step.step_index, error: errorMessage,
      healing, willRetry: true, retryCount,
    });
    // The tick loop will pick up this step again (status = 'retrying')
    return;
  }

  // Max retries exceeded or skip_with_fallback
  if (healing.healingStrategy === 'skip_with_fallback') {
    await stepRepo.updateStep(step.id, {
      status: 'skipped',
      error_message: `Skipped after ${retryCount} failures: ${errorMessage}`,
      ended_at: new Date().toISOString(),
    });

    eventBus.emit(EVENT_NAMES.AGENT_STEP_FAILED, {
      taskId: task.id, stepIndex: step.step_index, error: errorMessage,
      healing, skipped: true,
    });
    return;
  }

  // Final failure
  await stepRepo.markStepFailed(step.id, errorMessage);
  const nextTaskStatus = taskTransition(task.status, TASK_EVENTS.FAIL);
  await taskRepo.updateTaskStatus(task.id, nextTaskStatus, task.version);
  await _resetEmployee(task.employee_id);

  eventBus.emit(EVENT_NAMES.AGENT_STEP_FAILED, {
    taskId: task.id, stepIndex: step.step_index, error: errorMessage, healing,
  });
  eventBus.emit(EVENT_NAMES.TASK_FAILED, { taskId: task.id, error: errorMessage });
}

// ── Internal: Task Completion ─────────────────────────────────────────────────

async function _completeTask(task) {
  const nextStatus = taskTransition(task.status, TASK_EVENTS.ALL_STEPS_DONE);
  await taskRepo.updateTaskStatus(task.id, nextStatus, task.version);
  await _resetEmployee(task.employee_id);

  eventBus.emit(EVENT_NAMES.AGENT_LOOP_DONE, { taskId: task.id });
  eventBus.emit(EVENT_NAMES.TASK_COMPLETED, { taskId: task.id });
}

async function _resetEmployee(employeeId) {
  try {
    const emp = await employeeRepo.getEmployee(employeeId);
    const nextState = employeeTransition(emp._logicalState, EMPLOYEE_EVENTS.TASK_DONE);
    await employeeRepo.updateEmployeeStatus(employeeId, nextState);
  } catch {
    // Force reset to idle if transition fails
    await employeeRepo.updateEmployeeStatus(employeeId, EMPLOYEE_STATES.IDLE);
  }
}

// ── Query API (read-only) ─────────────────────────────────────────────────────

export async function getTaskStatus(taskId) {
  const task = await taskRepo.getTask(taskId);
  const steps = await stepRepo.getSteps(taskId);
  return {
    task,
    steps,
    stepsCompleted: steps.filter(s => isStepTerminal(s.status)).length,
    stepsTotal: steps.length,
    isComplete: isTaskTerminal(task.status),
  };
}
