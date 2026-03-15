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
 *   8. Budget checking per step
 *   9. Memory recall for context enrichment
 *  10. AI review loop for quality gating
 *  11. SSE publishing for real-time UI
 *  12. Worklog writing for audit trail
 *  13. Self-healing with model escalation
 */

import { taskTransition, TASK_STATES, TASK_EVENTS, isTaskTerminal } from './taskStateMachine.js';
import { stepTransition, STEP_STATES, STEP_EVENTS, isStepTerminal, isStepFailed, isStepWaitingInput } from './stepStateMachine.js';
import { employeeTransition, EMPLOYEE_STATES, EMPLOYEE_EVENTS } from './employeeStateMachine.js';

import * as taskRepo from './persistence/taskRepo.js';
import * as stepRepo from './persistence/stepRepo.js';
import * as employeeRepo from './persistence/employeeRepo.js';
import { appendWorklog } from './persistence/worklogRepo.js';

import { getExecutor } from './executors/executorRegistry.js';
import { chooseHealingStrategy, analyzeStepFailure, getAlternativeModel } from '../selfHealingService.js';
import { eventBus, EVENT_NAMES } from '../eventBus.js';
import { composeOutputProfileContext } from './styleLearning/outputProfileService.js';
import { extractFromSingleRevision } from './styleLearning/feedbackStyleExtractor.js';
import { checkBudget } from '../taskBudgetService.js';
import { recall, summarizeMemories } from '../aiEmployeeMemoryService.js';
import { reviewStepOutput, shouldReview } from '../aiReviewerService.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const TICK_DELAY_MS = 500; // Delay between steps to avoid overloading

// ML API base for SSE publishing
const ML_API_URL = typeof import.meta !== 'undefined' && import.meta.env?.VITE_ML_API_URL
  ? import.meta.env.VITE_ML_API_URL
  : 'http://localhost:8000';

// ── SSE Publishing ────────────────────────────────────────────────────────────

/**
 * Publish a step event to the SSE channel (best-effort, non-blocking).
 * Ported from agentLoopService.js.
 */
async function _publishSSE(taskId, eventPayload) {
  try {
    await fetch(`${ML_API_URL}/sse/agent/${taskId}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(eventPayload),
    });
  } catch { /* SSE publish is best-effort */ }
}

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
 * @param {string} [plan.priority]
 * @param {object} [plan.taskMeta]
 * @param {string} employeeId
 * @param {string} userId
 * @returns {Promise<{taskId: string, task: object}>}
 */
export async function submitPlan(plan, employeeId, userId) {
  const taskMeta = plan.taskMeta || {};

  // 1. Create task in draft_plan
  const task = await taskRepo.createTask({
    employeeId,
    title: plan.title,
    description: plan.description,
    priority: plan.priority || 'medium',
    sourceType: taskMeta.source_type || 'question_to_task',
    assignedByUserId: userId,
    dueAt: taskMeta.due_at || null,
    inputContext: {
      inputData: plan.inputData,
      llmConfig: plan.llmConfig,
      ...taskMeta,
    },
    planSnapshot: {
      steps: plan.steps,
      llmConfig: plan.llmConfig,
      submittedAt: new Date().toISOString(),
      ...taskMeta,
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
  const active = await taskRepo.updateTaskStatus(taskId, activeStatus, queued.version);

  try {
    const employee = await employeeRepo.getEmployee(active.employee_id);
    const empState = employeeTransition(employee._logicalState, EMPLOYEE_EVENTS.TASK_STARTED);
    await employeeRepo.updateEmployeeStatus(active.employee_id, empState);
  } catch {
    // Best-effort only — task execution should still resume.
  }

  _runTickLoop(taskId);
}

/**
 * Approve a review hold and continue execution.
 * @param {string} taskId
 * @param {string} userId
 * @param {object} [opts]
 * @param {string} [opts.feedback] - manager feedback text
 * @param {object} [opts.revision] - { original, revised } for style learning
 * @param {Function} [opts.llmFn] - for feedback extraction
 */
export async function approveReview(taskId, userId, opts = {}) {
  const task = await taskRepo.getTask(taskId);
  const nextStatus = taskTransition(task.status, TASK_EVENTS.REVIEW_APPROVED);
  const active = await taskRepo.updateTaskStatus(taskId, nextStatus, task.version);

  try {
    const employee = await employeeRepo.getEmployee(active.employee_id);
    const empState = employeeTransition(employee._logicalState, EMPLOYEE_EVENTS.REVIEW_RESOLVED);
    await employeeRepo.updateEmployeeStatus(active.employee_id, empState);
  } catch {
    // Best-effort only — task execution should still resume.
  }

  // Learn from manager feedback (best-effort, non-blocking)
  if (opts.feedback && opts.llmFn) {
    extractFromSingleRevision(active.employee_id, taskId, {
      original: opts.revision?.original,
      revised: opts.revision?.revised,
      feedback: opts.feedback,
      workflowType: task.input_context?.workflow_type,
    }, opts.llmFn).catch(err =>
      console.warn('[Orchestrator] Style learning from feedback failed (non-blocking):', err.message)
    );
  }

  // Continue tick loop
  _runTickLoop(taskId);
}

/**
 * Provide input to a blocked step (e.g. attach a dataset) and resume execution.
 * @param {string} taskId
 * @param {object} input - { datasetProfileId, datasetProfileRow }
 * @param {string} userId
 */
export async function provideStepInput(taskId, input, userId) {
  const task = await taskRepo.getTask(taskId);

  // Find the waiting_input step
  const steps = await stepRepo.getSteps(taskId);
  const waitingStep = steps.find(s => s.status === STEP_STATES.WAITING_INPUT);
  if (!waitingStep) {
    throw new Error(`[Orchestrator] No step in waiting_input state for task ${taskId}`);
  }

  // Transition step: waiting_input → pending
  const pendingStatus = stepTransition(waitingStep.status, STEP_EVENTS.INPUT_RECEIVED);
  await stepRepo.updateStep(waitingStep.id, {
    status: pendingStatus,
    error_message: null,
  });

  // Attach the provided input to task's input_context
  const updatedInputContext = {
    ...(task.input_context || {}),
    inputData: {
      ...(task.input_context?.inputData || {}),
      ...input,
    },
    dataset_profile_id: input.datasetProfileId || task.input_context?.dataset_profile_id,
  };

  // Update task input_context and unblock
  await taskRepo.updateTaskInputContext(taskId, updatedInputContext, task.version);

  // Unblock the task if it was blocked
  if (task.status === TASK_STATES.BLOCKED) {
    const freshTask = await taskRepo.getTask(taskId);
    const activeStatus = taskTransition(freshTask.status, TASK_EVENTS.UNBLOCK);
    await taskRepo.updateTaskStatus(taskId, activeStatus, freshTask.version);
  }

  eventBus.emit(EVENT_NAMES.TASK_STARTED, { taskId, userId, reason: 'input_provided' });

  // Resume tick loop
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

  // Check for any step in waiting_input — if so, pause the tick loop
  const allStepsForCheck = await stepRepo.getSteps(taskId);
  const waitingInputStep = allStepsForCheck.find(s => isStepWaitingInput(s.status));
  if (waitingInputStep) {
    console.log(`[Orchestrator] Step ${waitingInputStep.step_index} "${waitingInputStep.step_name}" is waiting for input — pausing tick loop`);
    return { done: true, waiting_input: true };
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

  // ── Dataset gate: pause step if it requires data but none attached ──
  const hasDataset = Boolean(
    task.input_context?.inputData?.datasetProfileId ||
    task.input_context?.dataset_profile_id
  );
  if (stepDef.requires_dataset && !hasDataset) {
    const waitingStatus = stepTransition(step.status, STEP_EVENTS.NEED_INPUT);
    await stepRepo.updateStep(step.id, {
      status: waitingStatus,
      error_message: 'Waiting for dataset — attach a data source to continue.',
    });

    // Block the task so the tick loop pauses
    const blockedStatus = taskTransition(task.status, TASK_EVENTS.BLOCK);
    await taskRepo.updateTaskStatus(task.id, blockedStatus, task.version);

    const blockPayload = {
      taskId: task.id, stepIndex: step.step_index, stepName: step.step_name,
      reason: 'waiting_input', message: 'Step requires a dataset. Attach one to continue.',
    };
    eventBus.emit(EVENT_NAMES.AGENT_STEP_BLOCKED, blockPayload);
    _publishSSE(task.id, { event_type: 'step_blocked', ...blockPayload });

    return { ok: false, waiting_input: true, error: 'Step requires dataset input.' };
  }

  // ── Budget gate (ported from agentLoopService) ──
  try {
    const budgetResult = await checkBudget(task.id);
    if (!budgetResult.allowed) {
      await stepRepo.updateStep(step.id, {
        status: 'failed',
        error_message: `Budget exceeded: ${budgetResult.reason}`,
        ended_at: new Date().toISOString(),
      });
      return { ok: false, error: `Budget exceeded: ${budgetResult.reason}` };
    }
  } catch { /* budget check is best-effort — proceed if service unavailable */ }

  // Transition step: pending/retrying → running
  const runningStatus = stepTransition(step.status, STEP_EVENTS.START);
  await stepRepo.updateStep(step.id, { status: runningStatus, started_at: new Date().toISOString() });

  const startPayload = {
    taskId: task.id,
    stepIndex: step.step_index,
    stepName: step.step_name,
    timestamp: Date.now() / 1000,
  };
  eventBus.emit(EVENT_NAMES.AGENT_STEP_STARTED, startPayload);
  _publishSSE(task.id, { event_type: 'step_started', ...startPayload });

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

  // Resolve learned company output profile (best-effort, non-blocking)
  let styleContext = null;
  let outputProfile = null;
  try {
    const resolved = await composeOutputProfileContext({
      employeeId: task.employee_id,
      inputContext: task.input_context || {},
      step: {
        ...stepDef,
        name: step.step_name,
      },
      mode: 'minimal',
    });
    if (resolved.styleContext) styleContext = resolved.styleContext;
    if (resolved.outputProfile) outputProfile = resolved.outputProfile;
  } catch { /* learned output profile is optional — never block execution */ }

  // ── Memory recall (ported from agentLoopService) ──
  let memoryContext = null;
  try {
    const memories = await recall(task.employee_id, {
      workflowType: stepDef.tool_type || step.step_name,
      datasetFingerprint: task.input_context?.dataset_fingerprint || null,
      limit: 5,
    });
    if (memories?.length > 0) {
      memoryContext = summarizeMemories(memories);
    }
  } catch { /* memory recall is best-effort */ }

  // Build step input
  const inputData = {
    ...(task.input_context?.inputData || {}),
    title: task.title,
    description: task.description,
    taskMeta: {
      id: task.id,
      title: task.title,
      workflowType: task.input_context?.workflow_type || null,
      deliverableLabel: task.input_context?.deliverable_label || null,
      deliverableType: task.input_context?.deliverable_type || null,
      docType: task.input_context?.doc_type || outputProfile?.docType || null,
      audience: task.input_context?.deliverable_audience || outputProfile?.audience || null,
      outputProfile,
    },
    priorArtifacts,
    priorStepResults,
    _memory_context: memoryContext,
  };

  const stepInput = {
    step: {
      name: step.step_name,
      tool_hint: stepDef.tool_hint || step.step_name,
      builtin_tool_id: stepDef.builtin_tool_id,
      tool_type: stepDef.tool_type || 'python_tool',
      input_args: stepDef.input_args || {},
      report_format: stepDef.report_format,
      opencloud_action: stepDef.opencloud_action,
      opencloud_config: stepDef.opencloud_config,
      review_checkpoint: stepDef.review_checkpoint,
      ai_review: stepDef.ai_review,
      // Self-healing context from prior retries
      _revision_instructions: step._revision_instructions || stepDef._revision_instructions,
      _model_override: step._model_override || stepDef._model_override,
      _simplified_hint: step._simplified_hint || stepDef._simplified_hint,
    },
    inputData,
    llmConfig: planSnapshot.llmConfig || task.input_context?.llmConfig || {},
    taskId: task.id,
    stepIndex: step.step_index,
    styleContext,
    outputProfile,
  };

  // Get executor and run
  let executor;
  try {
    executor = getExecutor(stepInput.step.tool_type);
  } catch (err) {
    await _handleStepFailure(task, step, err.message, stepDef);
    return { ok: false, error: err.message };
  }

  try {
    const result = await executor(stepInput);

    if (result.ok) {
      // ── AI Review gate (ported from agentLoopService) ──
      if (stepDef.ai_review && shouldReview(stepDef.tool_type || step.step_name)) {
        try {
          const review = await reviewStepOutput({
            taskId: task.id,
            stepName: step.step_name,
            workflowType: stepDef.tool_type || step.step_name,
            output: result,
          });

          if (!review.passed && (step.retry_count || 0) < MAX_RETRIES) {
            // Revision needed — reset step for retry with AI feedback
            await stepRepo.updateStep(step.id, {
              status: 'retrying',
              retry_count: (step.retry_count || 0) + 1,
              error_message: `AI review: ${review.score}/${review.threshold} — revision needed`,
              _revision_instructions: review.suggestions || [],
            });

            const revisionPayload = {
              taskId: task.id,
              stepIndex: step.step_index,
              stepName: step.step_name,
              status: 'revision_needed',
              review_score: review.score,
              review_threshold: review.threshold,
              suggestions: review.suggestions,
            };
            eventBus.emit(EVENT_NAMES.AGENT_STEP_REVISION, revisionPayload);
            _publishSSE(task.id, { event_type: 'step_revision', ...revisionPayload });

            return { ok: false, error: `AI review revision needed (${review.score}/${review.threshold})` };
          }
          // Review passed or max revisions reached — proceed to success
        } catch (reviewErr) {
          console.warn('[Orchestrator] AI review failed (non-blocking):', reviewErr.message);
          // If review service fails, proceed with the result
        }
      }

      await _handleStepSuccess(task, step, result, stepDef);
      return result;
    } else {
      await _handleStepFailure(task, step, result.error || 'Executor returned ok=false', stepDef);
      return result;
    }
  } catch (err) {
    await _handleStepFailure(task, step, err.message, stepDef);
    return { ok: false, error: err.message };
  }
}

async function _handleStepSuccess(task, step, result, stepDef) {
  // Transition step → succeeded
  await stepRepo.markStepSucceeded(step.id, {
    summary: result.logs?.join('\n') || '',
    artifactRefs: result.artifacts || [],
  });

  const completedPayload = {
    taskId: task.id,
    stepIndex: step.step_index,
    stepName: step.step_name,
    artifacts: result.artifacts,
    timestamp: Date.now() / 1000,
  };
  eventBus.emit(EVENT_NAMES.AGENT_STEP_COMPLETED, completedPayload);
  _publishSSE(task.id, { event_type: 'step_completed', ...completedPayload });

  // Write step progress worklog (best-effort)
  try {
    await appendWorklog(task.employee_id, task.id, step.id, 'step_progress', {
      step_name: step.step_name,
      step_index: step.step_index,
      status: 'succeeded',
      artifacts_count: (result.artifacts || []).length,
    });
  } catch { /* worklog is best-effort */ }

  // Check if this step requires review
  if (stepDef.review_checkpoint) {
    const nextTaskStatus = taskTransition(task.status, TASK_EVENTS.REVIEW_NEEDED);
    await taskRepo.updateTaskStatus(task.id, nextTaskStatus, task.version);

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

async function _handleStepFailure(task, step, errorMessage, stepDef = {}) {
  // ── Enhanced self-healing (ported from agentLoopService) ──
  const healing = analyzeStepFailure(
    new Error(errorMessage),
    { ...step, workflow_type: stepDef.tool_type },
    (step.retry_count || 0) + 1,
  );

  if (healing.healingStrategy === 'block_immediately') {
    // Non-recoverable — fail step and task
    await stepRepo.markStepFailed(step.id, errorMessage);
    const nextTaskStatus = taskTransition(task.status, TASK_EVENTS.FAIL);
    await taskRepo.updateTaskStatus(task.id, nextTaskStatus, task.version);
    await _resetEmployee(task.employee_id);

    const failPayload = {
      taskId: task.id, stepIndex: step.step_index, stepName: step.step_name,
      error: errorMessage, healing,
    };
    eventBus.emit(EVENT_NAMES.AGENT_STEP_FAILED, failPayload);
    eventBus.emit(EVENT_NAMES.TASK_FAILED, { taskId: task.id, error: errorMessage });
    _publishSSE(task.id, { event_type: 'step_failed', ...failPayload });
    _writeFailureWorklog(task, step, errorMessage, healing);
    return;
  }

  // Can we retry?
  const retryCount = (step.retry_count || 0) + 1;
  if (retryCount <= MAX_RETRIES && healing.healingStrategy !== 'skip_with_fallback') {
    // Build healing context for the retry
    const healingUpdates = {
      status: 'retrying',
      retry_count: retryCount,
    };

    // Strategy: revise_prompt — append error context
    if (healing.healingStrategy === 'revise_prompt') {
      const existing = step._revision_instructions || [];
      healingUpdates._revision_instructions = [
        ...existing,
        `Previous error: ${errorMessage}`,
        ...(healing.modifications?.promptSuffix ? [healing.modifications.promptSuffix] : []),
      ];
    }

    // Strategy: escalate_model — find an alternative provider/model
    if (healing.healingStrategy === 'escalate_model') {
      try {
        const alt = await getAlternativeModel(
          step._last_provider || 'unknown',
          step._last_model || 'unknown',
          stepDef.tool_type || step.step_name,
        );
        if (alt) healingUpdates._model_override = alt;
      } catch { /* best-effort */ }
    }

    // Strategy: simplify_task — reduce scope
    if (healing.healingStrategy === 'simplify_task' && healing.modifications?.simplifiedHint) {
      healingUpdates._simplified_hint = healing.modifications.simplifiedHint;
    }

    await stepRepo.updateStep(step.id, healingUpdates);

    const failPayload = {
      taskId: task.id, stepIndex: step.step_index, stepName: step.step_name,
      error: errorMessage, healing, willRetry: true, retryCount,
    };
    eventBus.emit(EVENT_NAMES.AGENT_STEP_FAILED, failPayload);
    _publishSSE(task.id, { event_type: 'step_failed', ...failPayload });
    _writeFailureWorklog(task, step, errorMessage, healing);

    console.info(`[Orchestrator] Self-healing: ${healing.healingStrategy} (${healing.reasoning})`);
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

    const skipPayload = {
      taskId: task.id, stepIndex: step.step_index, stepName: step.step_name,
      error: errorMessage, healing, skipped: true,
    };
    eventBus.emit(EVENT_NAMES.AGENT_STEP_FAILED, skipPayload);
    _publishSSE(task.id, { event_type: 'step_failed', ...skipPayload });
    _writeFailureWorklog(task, step, errorMessage, healing);
    return;
  }

  // Final failure
  await stepRepo.markStepFailed(step.id, errorMessage);
  const nextTaskStatus = taskTransition(task.status, TASK_EVENTS.FAIL);
  await taskRepo.updateTaskStatus(task.id, nextTaskStatus, task.version);
  await _resetEmployee(task.employee_id);

  const failPayload = {
    taskId: task.id, stepIndex: step.step_index, stepName: step.step_name,
    error: errorMessage, healing,
  };
  eventBus.emit(EVENT_NAMES.AGENT_STEP_FAILED, failPayload);
  eventBus.emit(EVENT_NAMES.TASK_FAILED, { taskId: task.id, error: errorMessage });
  _publishSSE(task.id, { event_type: 'step_failed', ...failPayload });
  _writeFailureWorklog(task, step, errorMessage, healing);
}

// ── Internal: Worklog Helpers ─────────────────────────────────────────────────

function _writeFailureWorklog(task, step, errorMessage, healing) {
  appendWorklog(task.employee_id, task.id, step.id, 'step_progress', {
    step_name: step.step_name,
    step_index: step.step_index,
    status: 'failed',
    error: errorMessage,
    retry_count: (step.retry_count || 0) + 1,
    healing_strategy: healing?.healingStrategy || null,
  }).catch(() => { /* best-effort */ });
}

// ── Internal: Task Completion ─────────────────────────────────────────────────

async function _completeTask(task) {
  const nextStatus = taskTransition(task.status, TASK_EVENTS.ALL_STEPS_DONE);
  await taskRepo.updateTaskStatus(task.id, nextStatus, task.version);
  await _resetEmployee(task.employee_id);

  const donePayload = { taskId: task.id, timestamp: Date.now() / 1000 };
  eventBus.emit(EVENT_NAMES.AGENT_LOOP_DONE, donePayload);
  eventBus.emit(EVENT_NAMES.TASK_COMPLETED, donePayload);
  _publishSSE(task.id, { event_type: 'loop_done', ...donePayload });

  // Write completion worklog
  appendWorklog(task.employee_id, task.id, null, 'task_update', {
    status: 'done',
    title: task.title,
  }).catch(() => { /* best-effort */ });
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
