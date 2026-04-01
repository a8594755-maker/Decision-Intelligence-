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
import { stepTransition, STEP_STATES, STEP_EVENTS, isStepTerminal, isStepWaitingInput, isStepOnHold } from './stepStateMachine.js';
import { employeeTransition, EMPLOYEE_STATES, EMPLOYEE_EVENTS } from './employeeStateMachine.js';

import * as taskRepo from './persistence/taskRepo.js';
import * as stepRepo from './persistence/stepRepo.js';
import * as employeeRepo from './persistence/employeeRepo.js';
import { appendWorklog } from './persistence/worklogRepo.js';

import { getExecutor } from './executors/executorRegistry.js';
import { analyzeStepFailure, getAlternativeModel } from '../governance/selfHealingService.js';
import { eventBus, EVENT_NAMES } from '../governance/eventBus.js';
import { extractFromSingleRevision } from './styleLearning/feedbackStyleExtractor.js';
import { reviewStepOutput, shouldReview } from '../ai-infra/aiReviewerService.js';
import { getLatestMetrics, recordReviewOutcome } from './styleLearning/trustMetricsService.js';
import { resolveCapabilityClass } from '../ai-infra/capabilityModelService.js';
import { annotateStepsWithPhases, getPipelineProgress } from './decisionPipelineService.js';
import { WORKLOG_EVENTS, buildWorklogEntry } from './worklogTaxonomy.js';
import { buildDecisionBrief } from '../artifacts/decisionArtifactBuilder.js';
import { buildEvidencePack } from '../artifacts/evidencePackBuilder.js';
import { buildWritebackPayload } from '../artifacts/writebackPayloadBuilder.js';
import { recordTaskValue } from '../roi/valueTrackingService.js';
import { buildFullAuditTrail } from '../hardening/auditTrailService.js';
import { isRalphLoopEnabled, runRalphLoop } from './ralphLoopAdapter.js';
import { isClaudeSdkEnabled, runClaudeSdkLoop } from './claudeSdkAdapter.js';
import { createCheckpoint } from './checkpointService.js';

// ── Gate Pipeline ────────────────────────────────────────────────────────────
import { runGatePipeline, buildStepContext } from './gates/stepPipeline.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const TICK_DELAY_MS = 500; // Delay between steps to avoid overloading

// ── Autonomy Level Helpers ────────────────────────────────────────────────────

const AUTONOMY_RANK = { A0: 0, A1: 1, A2: 2, A3: 3, A4: 4 };

/**
 * Get the effective autonomy level for a worker.
 * Falls back to 'A1' if metrics unavailable.
 */
async function _getAutonomyLevel(employeeId) {
  try {
    const metrics = await getLatestMetrics(employeeId);
    return metrics?.autonomy_level || 'A1';
  } catch {
    return 'A1';
  }
}

function _autonomyAtLeast(level, threshold) {
  return (AUTONOMY_RANK[level] || 0) >= (AUTONOMY_RANK[threshold] || 0);
}

// ── Capability Policy Helpers (used in submitPlan auto-approve) ──────────────

/**
 * Fetch a capability policy — used only for auto-approve check in submitPlan.
 * Gate-level checks are now in gates/capabilityPolicyGate.js.
 */
async function _getCapabilityPolicy(capabilityClass, capabilityId = null) {
  const { getCapabilityPolicyFromDB } = await import('../ai-infra/capabilityModelService.js');
  return getCapabilityPolicyFromDB(capabilityClass, capabilityId);
}

// ML API base for SSE publishing
const ML_API_URL = typeof import.meta !== 'undefined' && import.meta.env?.VITE_ML_API_URL
  ? import.meta.env.VITE_ML_API_URL
  : 'http://localhost:8000';

// ── Server Execution Mode ────────────────────────────────────────────────────
// When enabled, the browser does NOT run _runTickLoop() locally.
// Instead, a Node.js worker process picks up queued tasks from the DB.
const _SERVER_EXEC = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_DI_SERVER_EXECUTION === 'true')
  || (typeof process !== 'undefined' && process.env?.VITE_DI_SERVER_EXECUTION === 'true');

export function isServerExecutionMode() { return _SERVER_EXEC; }

// When running inside the Node.js worker, this flag is set by the worker entry.
let _isWorkerProcess = false;
export function __setWorkerProcess(val) { _isWorkerProcess = !!val; }

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
// Map intake source types to DB-allowed values.
// DB constraint currently allows: manual, scheduled, question_to_task, chat_decomposed.
// Migration 20260409 will extend this, but until applied we must map safely.
const SOURCE_TYPE_DB_MAP = {
  manual: 'manual',
  scheduled: 'scheduled',
  question_to_task: 'question_to_task',
  chat_decomposed: 'chat_decomposed',
  // New intake sources → map to closest DB-safe value
  chat: 'question_to_task',
  schedule: 'scheduled',
  proactive_alert: 'manual',
  closed_loop: 'scheduled',
  email: 'manual',
  meeting_transcript: 'manual',
  api: 'manual',
};

export async function submitPlan(plan, employeeId, userId) {
  const taskMeta = plan.taskMeta || {};

  // Normalize source_type to a DB-safe value
  const rawSource = taskMeta.source_type || 'question_to_task';
  const sourceType = SOURCE_TYPE_DB_MAP[rawSource] || 'question_to_task';

  // 1. Create task in draft_plan
  const task = await taskRepo.createTask({
    employeeId,
    title: plan.title,
    description: plan.description,
    priority: plan.priority || 'medium',
    sourceType,
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

  // 2. Annotate steps with pipeline phases + create step rows
  const annotatedSteps = annotateStepsWithPhases(plan.steps);
  await stepRepo.createSteps(task.id, employeeId, annotatedSteps);

  // 3. Transition to waiting_approval
  const nextStatus = taskTransition(TASK_STATES.DRAFT_PLAN, TASK_EVENTS.PLAN_READY);
  const updated = await taskRepo.updateTaskStatus(task.id, nextStatus, task.version);

  eventBus.emit(EVENT_NAMES.TASK_CREATED, { taskId: task.id, title: plan.title, steps: plan.steps });

  // ── Worklog: task created (audit trail completeness) ──
  try {
    await appendWorklog(task.employee_id, task.id, null, 'task_lifecycle', {
      event: 'task_created', title: plan.title, step_count: plan.steps.length,
      source: plan.taskMeta?.source_type || 'question_to_task',
      priority: plan.priority || 'medium',
    });
  } catch { /* worklog is best-effort */ }

  // ── Autonomy gate: auto-approve for A3+ workers ──
  // Also check capability-level policies: if ANY step requires approval per its
  // capability policy and the worker hasn't reached that policy's auto_approve_at,
  // skip auto-approve so the plan goes through manual approval.
  const autonomyLevel = await _getAutonomyLevel(employeeId);
  if (_autonomyAtLeast(autonomyLevel, 'A3')) {
    let capabilityBlocksAutoApprove = false;
    try {
      for (const stepDef of plan.steps || []) {
        const capClass = resolveCapabilityClass({
          tool_type: stepDef.tool_type || 'python_tool',
          builtin_tool_id: stepDef.builtin_tool_id,
        });
        const policy = await _getCapabilityPolicy(capClass, stepDef.builtin_tool_id);
        if (policy?.approval_required && !_autonomyAtLeast(autonomyLevel, policy.auto_approve_at || 'A3')) {
          capabilityBlocksAutoApprove = true;
          break;
        }
      }
    } catch {
      // Fail-safe: if capability check fails, require manual approval
      capabilityBlocksAutoApprove = true;
    }

    if (!capabilityBlocksAutoApprove) {
      try {
        await approvePlan(task.id, userId);
        const autoApproved = await taskRepo.getTask(task.id);
        eventBus.emit(EVENT_NAMES.TASK_STARTED, { taskId: task.id, userId, autoApproved: true, autonomyLevel });
        return { taskId: task.id, task: autoApproved, autoApproved: true, autonomyLevel };
      } catch (err) {
        console.warn('[Orchestrator] Auto-approve failed, falling back to manual:', err.message);
      }
    }
  }

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

  // ── Worklog: plan approved (audit trail / timeline evidence) ──
  try {
    await appendWorklog(active.employee_id, taskId, null, 'task_lifecycle', {
      event: 'plan_approved', approved_by: userId,
      previous_status: task.status, next_status: active.status,
    });
  } catch { /* worklog is best-effort */ }

  eventBus.emit(EVENT_NAMES.TASK_STARTED, { taskId, userId });

  // ── Propagate plan-level approval to all steps ──
  // When the user clicks "Approve & Execute", they are explicitly approving
  // all steps in the plan. Store this flag so the capability gate can skip
  // the per-step approval check (task approve = capability approve).
  try {
    const ctx = active.input_context || {};
    await taskRepo.updateTaskInputContext(taskId, {
      ...ctx,
      _plan_approved_by: userId,
      _plan_approved_at: new Date().toISOString(),
    }, active.version);
  } catch { /* best-effort — capability gate will still work without this */ }

  // Start the tick loop (or let the server worker pick it up)
  if (_SERVER_EXEC && !_isWorkerProcess) {
    _publishSSE(taskId, { event_type: 'task_queued', taskId });
  } else {
    _runTickLoop(taskId);
  }
}

/**
 * Cancel a task.
 */
export async function cancelTask(taskId, _userId) {
  const task = await taskRepo.getTask(taskId);
  const nextStatus = taskTransition(task.status, TASK_EVENTS.CANCEL);
  await taskRepo.updateTaskStatus(taskId, nextStatus, task.version);

  // Reset employee to idle (read actual state instead of assuming BUSY)
  try {
    const employee = await employeeRepo.getEmployee(task.employee_id);
    const empState = employeeTransition(employee._logicalState, EMPLOYEE_EVENTS.TASK_DONE);
    await employeeRepo.updateEmployeeStatus(task.employee_id, empState);
  } catch { /* ignore — employee may already be idle or in an incompatible state */ }

  eventBus.emit(EVENT_NAMES.TASK_FAILED, { taskId, reason: 'cancelled' });
}

/**
 * Retry a failed task (re-queue it).
 */
export async function retryTask(taskId, _userId) {
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

  if (_SERVER_EXEC && !_isWorkerProcess) {
    _publishSSE(taskId, { event_type: 'task_queued', taskId });
  } else {
    _runTickLoop(taskId);
  }
}

/**
 * Approve a review hold and continue execution.
 * @param {string} taskId
 * @param {string} userId
 * @param {object} [opts]
 * @param {string} [opts.feedback] - manager feedback text
 * @param {string} [opts.decision] - review decision ('approve', 'needs_revision', etc.)
 * @param {object} [opts.revision] - { original, revised } for style learning
 * @param {Function} [opts.llmFn] - for feedback extraction
 */
export async function approveReview(taskId, userId, opts = {}) {
  const task = await taskRepo.getTask(taskId);
  const { feedback, decision = 'approve' } = opts;

  // Dispatch the correct task state machine event based on decision
  const taskEvent = (decision === 'needs_revision' || decision === 'rejected')
    ? TASK_EVENTS.REVIEW_REJECTED
    : TASK_EVENTS.REVIEW_APPROVED;
  const nextStatus = taskTransition(task.status, taskEvent);
  const updated = await taskRepo.updateTaskStatus(taskId, nextStatus, task.version);

  // Transition employee state
  try {
    const employee = await employeeRepo.getEmployee(updated.employee_id);
    const empState = employeeTransition(employee._logicalState, EMPLOYEE_EVENTS.REVIEW_RESOLVED);
    await employeeRepo.updateEmployeeStatus(updated.employee_id, empState);
  } catch {
    // Best-effort only — task execution should still resume.
  }

  // ── Worklog: review resolved (audit trail) ──
  try {
    await appendWorklog(updated.employee_id, taskId, null, 'task_lifecycle', {
      event: 'review_resolved', decision, has_feedback: Boolean(feedback),
      previous_status: task.status, next_status: nextStatus,
    });
  } catch { /* worklog is best-effort */ }

  // ── Feed review outcome into style/trust learning (best-effort) ──
  try {
    // Extract style rules from revision feedback (requires feedback text)
    if (feedback && decision !== 'approve') {
      await extractFromSingleRevision(updated.employee_id, taskId, {
        original: opts.revision?.original,
        revised: opts.revision?.revised,
        feedback,
        workflowType: task.input_context?.workflow_type,
      }, opts.llmFn || null);
    }
    // Record outcome for trust metrics (regardless of decision)
    await recordReviewOutcome(updated.employee_id, {
      taskId,
      decision,
      hasFeedback: Boolean(feedback),
      hasRevision: decision === 'needs_revision',
    });
  } catch (learnErr) {
    console.warn('[Orchestrator] Style/trust learning failed (non-blocking):', learnErr.message);
  }

  // Only continue tick loop if the review was approved
  if (taskEvent === TASK_EVENTS.REVIEW_APPROVED) {
    // Transition all review_hold steps back to pending so the tick loop can execute them.
    // Also mark the task as plan-approved so the capability gate won't re-block them.
    try {
      const steps = await stepRepo.getSteps(taskId);
      for (const s of steps) {
        if (isStepOnHold(s.status)) {
          const pendingStatus = stepTransition(s.status, STEP_EVENTS.REVIEW_APPROVED);
          await stepRepo.updateStep(s.id, { status: pendingStatus, error_message: null });
        }
      }
      // Mark plan as approved in input_context so capability gate skips
      const latestTask = await taskRepo.getTask(taskId);
      const ctx = latestTask.input_context || {};
      if (!ctx._plan_approved_by) {
        await taskRepo.updateTaskInputContext(taskId, {
          ...ctx,
          _plan_approved_by: userId,
          _plan_approved_at: new Date().toISOString(),
        }, latestTask.version);
      }
    } catch (err) {
      console.warn('[Orchestrator] Failed to unblock review_hold steps (non-blocking):', err?.message);
    }

    if (_SERVER_EXEC && !_isWorkerProcess) {
      _publishSSE(taskId, { event_type: 'task_queued', taskId });
    } else {
      _runTickLoop(taskId);
    }
  } else {
    // Rejected/needs_revision — emit failure event
    eventBus.emit(EVENT_NAMES.TASK_FAILED, { taskId, reason: decision });
  }
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

  // Resume tick loop (or let the server worker pick it up)
  if (_SERVER_EXEC && !_isWorkerProcess) {
    _publishSSE(taskId, { event_type: 'task_queued', taskId });
  } else {
    _runTickLoop(taskId);
  }
}

/**
 * Skip a step that is in waiting_input state (fail-fast).
 * Use this for non-interactive runs where no UI can provide input.
 * The step is marked as skipped with a fallback note.
 *
 * @param {string} taskId
 * @param {string} userId
 * @returns {Promise<{skipped: boolean, stepName: string}>}
 */
export async function skipWaitingInputStep(taskId, _userId) {
  const steps = await stepRepo.getSteps(taskId);
  const waitingStep = steps.find(s => s.status === STEP_STATES.WAITING_INPUT);
  if (!waitingStep) {
    return { skipped: false, stepName: null };
  }

  const skippedStatus = stepTransition(waitingStep.status, STEP_EVENTS.SKIP);
  await stepRepo.updateStep(waitingStep.id, {
    status: skippedStatus,
    error_message: 'Skipped: no interactive input UI available. Step requires user-provided data.',
  });

  console.warn(`[Orchestrator] Skipped waiting_input step ${waitingStep.step_index} "${waitingStep.step_name}" for task ${taskId}`);

  // Resume tick loop (or let the server worker pick it up)
  if (_SERVER_EXEC && !_isWorkerProcess) {
    _publishSSE(taskId, { event_type: 'task_queued', taskId });
  } else {
    _runTickLoop(taskId);
  }

  return { skipped: true, stepName: waitingStep.step_name };
}

/**
 * Execute a single tick — find next pending step, run it, handle result.
 * @returns {Promise<{done: boolean, stepResult?: object}>}
 */
export async function tick(taskId) {
  const task = await taskRepo.getTask(taskId);
  console.log(`[Orchestrator] tick(${taskId}): task.status=${task.status}, plan_approved=${Boolean(task.input_context?._plan_approved_by)}`);

  if (isTaskTerminal(task.status)) {
    console.log(`[Orchestrator] tick(${taskId}): task is terminal (${task.status}), skipping`);
    return { done: true };
  }

  // Check for any step in waiting_input — if so, pause the tick loop.
  // NOTE: No UI path currently exists for users to provide step input interactively.
  // The ralph-loop-adapter detects this and reports "Waiting for user input".
  // For non-interactive runs (scheduled/proactive), callers should use
  // skipWaitingInputStep() to unblock the pipeline.
  const allStepsForCheck = await stepRepo.getSteps(taskId);
  const waitingInputStep = allStepsForCheck.find(s => isStepWaitingInput(s.status));
  if (waitingInputStep) {
    console.warn(`[Orchestrator] Step ${waitingInputStep.step_index} "${waitingInputStep.step_name}" is waiting for input — pausing tick loop. No interactive input UI available yet.`);
    return { done: true, waiting_input: true, waiting_step_name: waitingInputStep.step_name, waiting_step_index: waitingInputStep.step_index };
  }

  // Find next step to execute
  const step = await stepRepo.getNextPendingStep(taskId);
  if (!step) {
    // No pending steps — check if some are held or still pending (DB mismatch) vs all truly done
    const allSteps = await stepRepo.getSteps(taskId);
    console.log(`[Orchestrator] tick(${taskId}): getNextPendingStep=null, getSteps returned ${allSteps.length} rows: ${allSteps.map(s => `${s.step_name}:${s.status}`).join(', ') || '(empty)'}`);
    const heldSteps = allSteps.filter(s => isStepOnHold(s.status));
    const pendingSteps = allSteps.filter(s => s.status === STEP_STATES.PENDING || s.status === STEP_STATES.RETRYING);

    if (heldSteps.length > 0) {
      // Some/all steps are in review_hold — produce LLM diagnosis summary
      console.log(`[Orchestrator] ${heldSteps.length}/${allSteps.length} steps held for task ${taskId} — generating diagnosis`);
      await _diagnoseAllHeld(task, allSteps, heldSteps);
      return { done: true, all_held: true };
    }

    if (pendingSteps.length > 0) {
      // getNextPendingStep returned null but getSteps shows pending steps — DB query mismatch.
      // Return the first pending step directly instead of falsely completing.
      console.warn(`[Orchestrator] getNextPendingStep returned null but ${pendingSteps.length} steps are still pending — using fallback query`);
      const fallbackStep = pendingSteps[0];
      const result = await _executeStep(task, fallbackStep);
      return { done: false, stepResult: result };
    }

    if (allSteps.length === 0) {
      // No steps in DB at all — may be a timing/RLS issue. Do NOT mark complete.
      console.warn(`[Orchestrator] No step rows found in DB for task ${taskId} — aborting tick (not completing)`);
      return { done: true, error: 'No step rows found in database' };
    }

    // All steps done — transition task to done
    const nonTerminal = allSteps.filter(s => !isStepTerminal(s.status));
    if (nonTerminal.length > 0) {
      console.warn(`[Orchestrator] ${nonTerminal.length} steps not terminal but no pending — statuses: ${nonTerminal.map(s => `${s.step_name}:${s.status}`).join(', ')}`);
      return { done: true, error: 'Steps in unexpected state' };
    }

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

/** @internal — also called by the worker process */
export async function _runTickLoop(taskId) {
  const task0 = await taskRepo.getTask(taskId);

  // ── Claude Agent SDK mode: autonomous tool-calling execution ──
  const perTaskSdk = task0?.input_context?.agent_runtime === 'claude-sdk' || task0?.plan_snapshot?.agent_runtime === 'claude-sdk';
  if (isClaudeSdkEnabled() || perTaskSdk) {
    try {
      const taskTitle = task0.plan_snapshot?.title || task0.title || taskId;
      const result = await runClaudeSdkLoop(taskId, { taskTitle });
      console.log(`[Orchestrator] Claude SDK loop completed: ${result.completionReason} (${result.turns} turns, $${result.totalCostUsd?.toFixed(4)})`);
    } catch (err) {
      console.error(`[Orchestrator] Claude SDK loop error for task ${taskId}:`, err);
      try {
        const task = await taskRepo.getTask(taskId);
        if (!isTaskTerminal(task.status)) {
          const nextStatus = taskTransition(task.status, TASK_EVENTS.FAIL);
          await taskRepo.updateTaskStatus(taskId, nextStatus, task.version);
          await _resetEmployee(task.employee_id);
          eventBus.emit(EVENT_NAMES.TASK_FAILED, { taskId, error: `Claude SDK loop failed: ${err.message}` });
        }
      } catch { /* last resort */ }
    }
    return;
  }

  // ── Ralph Loop mode: autonomous LLM-driven execution ──
  // Activates if globally enabled OR if the task was submitted with ralph_loop: true
  const perTaskRalph = task0?.input_context?.ralph_loop === true || task0?.plan_snapshot?.ralph_loop === true;
  if (isRalphLoopEnabled() || perTaskRalph) {
    try {
      const task = task0;
      const taskTitle = task.plan_snapshot?.title || task.title || taskId;
      const result = await runRalphLoop(taskId, tick, getTaskStatus, { taskTitle });
      console.log(`[Orchestrator] Ralph loop completed: ${result.completionReason} (${result.iterations} iterations, ${result.totalUsage?.totalTokens || 0} tokens)`);
    } catch (err) {
      console.error(`[Orchestrator] Ralph loop error for task ${taskId}:`, err);
      try {
        const task = await taskRepo.getTask(taskId);
        if (!isTaskTerminal(task.status)) {
          const nextStatus = taskTransition(task.status, TASK_EVENTS.FAIL);
          await taskRepo.updateTaskStatus(taskId, nextStatus, task.version);
          await _resetEmployee(task.employee_id);
          eventBus.emit(EVENT_NAMES.TASK_FAILED, { taskId, error: `Ralph loop failed: ${err.message}` });
        }
      } catch { /* last resort */ }
    }
    return;
  }

  // ── Classic mode: synchronous tick loop ──
  let running = true;
  while (running) {
    try {
      // Update heartbeat so other workers know we're alive
      if (_isWorkerProcess) {
        taskRepo.updateWorkerHeartbeat(taskId).catch(() => {});
      }

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

// ── Internal: Step Execution (Pipeline-based) ────────────────────────────────

async function _executeStep(task, step) {
  const ctx = buildStepContext(task, step);

  // ── Run gate pipeline (dataset → budget → capability → permission → governance → approval → context resolvers) ──
  const gateResult = await runGatePipeline(ctx);

  if (!gateResult.passed) {
    // Gate blocked execution — publish SSE notification and return
    const { result, gateName } = gateResult;
    const ssePayload = result.blockPayload || {
      taskId: task.id, stepIndex: step.step_index, stepName: step.step_name,
      reason: gateName, message: result.error,
    };
    _publishSSE(task.id, { event_type: result.action === 'needs_approval' ? 'approval_required' : 'step_blocked', ...ssePayload });

    if (gateResult.degraded.length > 0) {
      console.warn(`[Orchestrator] Degraded gates during blocked step: ${gateResult.degraded.join(', ')}`);
    }

    return { ok: false, error: result.error, [result.action]: true };
  }

  // Log degraded gates (services that were unavailable but didn't block)
  if (gateResult.degraded.length > 0) {
    console.warn(`[Orchestrator] Step "${step.step_name}" running in degraded mode — failed gates: ${gateResult.degraded.join(', ')}`);
  }

  // ── Transition step: pending/retrying → running ──
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

  try {
    await appendWorklog(task.employee_id, task.id, null, 'step_progress', {
      event: 'step_started', step_name: step.step_name, step_index: step.step_index,
      tool_type: ctx.stepDef.tool_type || 'unknown',
      degraded_gates: gateResult.degraded.length > 0 ? gateResult.degraded : undefined,
    });
  } catch { /* worklog is best-effort */ }

  // ── Build step input from enriched context ──
  const { stepDef, planSnapshot, inputData, styleContext, outputProfile, memoryContext, priorArtifacts, priorStepResults } = ctx;

  const fullInputData = {
    ...inputData,
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
      review_checkpoint: stepDef.review_checkpoint,
      ai_review: stepDef.ai_review,
      _revision_instructions: step._revision_instructions || stepDef._revision_instructions,
      _model_override: step._model_override || stepDef._model_override,
      _simplified_hint: step._simplified_hint || stepDef._simplified_hint,
    },
    inputData: fullInputData,
    llmConfig: planSnapshot.llmConfig || task.input_context?.llmConfig || {},
    taskId: task.id,
    stepIndex: step.step_index,
    styleContext,
    outputProfile,
  };

  // ── Execute ──
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
      // ── AI Review gate (post-execution) ──
      const _reviewAutonomy = await _getAutonomyLevel(task.employee_id);
      if (stepDef.ai_review && shouldReview(stepDef.tool_type || step.step_name) && !_autonomyAtLeast(_reviewAutonomy, 'A4')) {
        try {
          const review = await reviewStepOutput({
            taskId: task.id,
            stepName: step.step_name,
            workflowType: stepDef.tool_type || step.step_name,
            output: result,
          });

          if (!review.passed && (step.retry_count || 0) < MAX_RETRIES) {
            const failedStatus = stepTransition(STEP_STATES.RUNNING, STEP_EVENTS.FAIL);
            const retryingStatus = stepTransition(failedStatus, STEP_EVENTS.RETRY);
            await stepRepo.updateStep(step.id, {
              status: retryingStatus,
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
        } catch (reviewErr) {
          console.warn('[Orchestrator] AI review failed (non-blocking):', reviewErr.message);
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
    // Propagate code/stdout for UI transparency (Python tools, etc.)
    code: result.code || null,
    code_language: result.code_language || null,
    stdout: result.stdout || null,
    stderr: result.stderr || null,
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

  // Create checkpoint after successful step (best-effort)
  try {
    await createCheckpoint(task.id, step.step_index);
  } catch { /* checkpoint is best-effort */ }

  // Check if this step requires review
  if (stepDef.review_checkpoint) {
    // ── Autonomy gate: A3+ workers auto-pass review checkpoints ──
    const autonomyLevel = await _getAutonomyLevel(task.employee_id);
    if (_autonomyAtLeast(autonomyLevel, 'A3')) {
      // Auto-approve checkpoint — log but don't pause
      try {
        await appendWorklog(task.employee_id, task.id, step.id, 'step_progress', {
          step_name: step.step_name,
          step_index: step.step_index,
          status: 'review_auto_approved',
          autonomy_level: autonomyLevel,
          note: `Review checkpoint auto-approved (autonomy ${autonomyLevel})`,
        });
      } catch { /* worklog is best-effort */ }

      eventBus.emit(EVENT_NAMES.REVIEW_REQUESTED, {
        taskId: task.id,
        stepIndex: step.step_index,
        autoApproved: true,
        autonomyLevel,
      });
    } else {
      // Standard review pause
      const nextTaskStatus = taskTransition(task.status, TASK_EVENTS.REVIEW_NEEDED);
      await taskRepo.updateTaskStatus(task.id, nextTaskStatus, task.version);
      task.version += 1;

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
    task.version += 1;
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
    // Transition through state machine: running → failed → retrying
    const failedStatus = stepTransition(STEP_STATES.RUNNING, STEP_EVENTS.FAIL);
    const retryingStatus = stepTransition(failedStatus, STEP_EVENTS.RETRY);
    const healingUpdates = {
      status: retryingStatus,
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
    // Transition through state machine: running → failed → skipped
    const failedStatus = stepTransition(STEP_STATES.RUNNING, STEP_EVENTS.FAIL);
    const skippedStatus = stepTransition(failedStatus, STEP_EVENTS.SKIP);
    await stepRepo.updateStep(step.id, {
      status: skippedStatus,
      error_message: `Skipped after ${retryCount} failures: ${errorMessage}`,
      ended_at: new Date().toISOString(),
    });

    // LLM-driven error diagnosis (best-effort, non-blocking)
    const diagnosis = await _diagnoseFailure(step, errorMessage, task);

    const skipPayload = {
      taskId: task.id, stepIndex: step.step_index, stepName: step.step_name,
      error: errorMessage, healing, skipped: true, diagnosis,
    };
    eventBus.emit(EVENT_NAMES.AGENT_STEP_FAILED, skipPayload);
    if (diagnosis) eventBus.emit(EVENT_NAMES.AGENT_STEP_DIAGNOSED, { taskId: task.id, stepIndex: step.step_index, diagnosis });
    _publishSSE(task.id, { event_type: 'step_failed', ...skipPayload });
    _writeFailureWorklog(task, step, errorMessage, healing, diagnosis);
    return;
  }

  // Final failure
  await stepRepo.markStepFailed(step.id, errorMessage);
  const nextTaskStatus = taskTransition(task.status, TASK_EVENTS.FAIL);
  await taskRepo.updateTaskStatus(task.id, nextTaskStatus, task.version);
  task.version += 1;
  await _resetEmployee(task.employee_id);

  // LLM-driven error diagnosis (best-effort, non-blocking)
  const diagnosis = await _diagnoseFailure(step, errorMessage, task);

  const failPayload = {
    taskId: task.id, stepIndex: step.step_index, stepName: step.step_name,
    error: errorMessage, healing, diagnosis,
  };
  eventBus.emit(EVENT_NAMES.AGENT_STEP_FAILED, failPayload);
  eventBus.emit(EVENT_NAMES.TASK_FAILED, { taskId: task.id, error: errorMessage });
  if (diagnosis) eventBus.emit(EVENT_NAMES.AGENT_STEP_DIAGNOSED, { taskId: task.id, stepIndex: step.step_index, diagnosis });
  _publishSSE(task.id, { event_type: 'step_failed', ...failPayload });
  _writeFailureWorklog(task, step, errorMessage, healing, diagnosis);
}

// ── Internal: Worklog Helpers ─────────────────────────────────────────────────

async function _diagnoseFailure(step, errorMessage, task) {
  try {
    const { diagnoseStepFailure } = await import('./errorDiagnosticService.js');
    return await diagnoseStepFailure({
      step,
      errorMessage,
      retryHistory: step._revision_instructions || [],
      taskContext: task.input_context,
    });
  } catch (err) {
    console.warn('[Orchestrator] Error diagnosis failed (non-blocking):', err?.message);
    return null;
  }
}

function _writeFailureWorklog(task, step, errorMessage, healing, diagnosis) {
  appendWorklog(task.employee_id, task.id, step.id, 'step_progress', {
    step_name: step.step_name,
    step_index: step.step_index,
    status: STEP_STATES.FAILED,
    error: errorMessage,
    retry_count: (step.retry_count || 0) + 1,
    healing_strategy: healing?.healingStrategy || null,
    diagnosis: diagnosis || null,
  }).catch(() => { /* best-effort */ });
}

// ── Internal: All-Steps-Held Diagnosis ────────────────────────────────────────

/**
 * When all steps end up in review_hold (no pending steps remain), produce an
 * LLM-driven diagnosis summarising why the task stalled, emit it via SSE so
 * the UI can render a FailureReportCard, and write a worklog entry.
 */
async function _diagnoseAllHeld(task, allSteps, heldSteps) {
  const heldErrors = heldSteps.map(s => ({
    step_name: s.step_name,
    step_index: s.step_index,
    error: s.error_message || 'review_hold (no error message)',
  }));

  // Deduplicate: if every step has the same error, summarise once
  const uniqueErrors = [...new Set(heldErrors.map(e => e.error))];
  const combinedError = uniqueErrors.length === 1
    ? `All ${heldSteps.length} steps blocked: ${uniqueErrors[0]}`
    : heldErrors.map(e => `[${e.step_name}] ${e.error}`).join('\n');

  // LLM diagnosis (best-effort)
  let diagnosis = null;
  try {
    const { diagnoseStepFailure } = await import('./errorDiagnosticService.js');
    diagnosis = await diagnoseStepFailure({
      step: { step_name: '(all steps)', step_index: -1 },
      errorMessage: combinedError,
      retryHistory: [],
      taskContext: task.input_context,
    });
  } catch (err) {
    console.warn('[Orchestrator] All-held diagnosis failed (non-blocking):', err?.message);
  }

  const payload = {
    taskId: task.id,
    event_type: 'all_steps_held',
    held_count: heldSteps.length,
    total_count: allSteps.length,
    errors: heldErrors,
    diagnosis,
    message: combinedError,
  };

  eventBus.emit(EVENT_NAMES.AGENT_STEP_BLOCKED, payload);
  _publishSSE(task.id, payload);

  // Worklog
  try {
    await appendWorklog(task.employee_id, task.id, null, 'task_lifecycle', {
      event: 'all_steps_held',
      held_count: heldSteps.length,
      total_count: allSteps.length,
      diagnosis: diagnosis || null,
      message: combinedError,
    });
  } catch { /* best-effort */ }
}

// ── Internal: Task Completion ─────────────────────────────────────────────────

async function _completeTask(task) {
  // Final verification: ensure all steps are truly terminal before completing
  const verifySteps = await stepRepo.getSteps(task.id);
  const nonTerminal = verifySteps.filter(s => !isStepTerminal(s.status));
  if (nonTerminal.length > 0) {
    console.error(`[Orchestrator] _completeTask BLOCKED: ${nonTerminal.length} steps not terminal — ${nonTerminal.map(s => `${s.step_name}:${s.status}`).join(', ')}`);
    return; // Do NOT mark task as done
  }
  if (verifySteps.length === 0) {
    console.error(`[Orchestrator] _completeTask BLOCKED: no step rows found for task ${task.id}`);
    return; // Do NOT mark task as done with 0 steps
  }
  console.log(`[Orchestrator] _completeTask: verified ${verifySteps.length} steps all terminal, completing task ${task.id}`);

  const nextStatus = taskTransition(task.status, TASK_EVENTS.ALL_STEPS_DONE);
  await taskRepo.updateTaskStatus(task.id, nextStatus, task.version);
  task.version += 1;
  await _resetEmployee(task.employee_id);

  const donePayload = { taskId: task.id, timestamp: Date.now() / 1000 };
  eventBus.emit(EVENT_NAMES.AGENT_LOOP_DONE, donePayload);
  eventBus.emit(EVENT_NAMES.TASK_COMPLETED, donePayload);
  _publishSSE(task.id, { event_type: 'loop_done', ...donePayload });

  // Build decision artifacts (best-effort)
  try {
    const allSteps = await stepRepo.getSteps(task.id);
    const priorArtifacts = {};
    const priorStepResults = [];
    for (const s of allSteps) {
      if (s.status === STEP_STATES.SUCCEEDED) {
        const arts = s.artifact_refs || [];
        priorArtifacts[s.step_name] = arts;
        priorStepResults.push({ step_name: s.step_name, status: s.status, artifacts: arts, started_at: s.started_at });
      }
    }
    const taskMeta = { id: task.id, title: task.title, workflowType: task.input_context?.workflow_type };
    const inputData = task.input_context?.inputData || {};

    const decisionBrief = buildDecisionBrief({ planArtifacts: priorArtifacts, taskMeta });
    const evidencePack = buildEvidencePack({ priorArtifacts, taskMeta, inputData, priorStepResults });
    const writebackPayload = buildWritebackPayload({ planArtifacts: priorArtifacts, taskMeta });

    // Emit decision artifacts for UI rendering
    _publishSSE(task.id, {
      event_type: 'decision_artifacts',
      decision_brief: decisionBrief,
      evidence_pack: evidencePack,
      writeback_payload: writebackPayload,
    });

    // Record ROI value events (best-effort)
    try {
      await recordTaskValue({
        decisionBrief,
        writebackPayload,
        taskMeta,
        workerId: task.employee_id,
      });
    } catch (roiErr) {
      console.warn('[Orchestrator] ROI value tracking failed (non-blocking):', roiErr.message);
    }

    // Build full audit trail (best-effort)
    try {
      const worklogs = await import('./persistence/worklogRepo.js')
        .then(m => m.listWorklogs?.(task.employee_id, { taskId: task.id }))
        .catch(() => []);
      const { entries: auditEntries, completeness: auditCompleteness } = buildFullAuditTrail({
        worklogs: worklogs || [],
        steps: allSteps,
        resolution: null, // populated when review exists
        publishAttempts: [],
        valueEvents: [],
      });
      _publishSSE(task.id, {
        event_type: 'audit_trail',
        audit_entries: auditEntries,
        audit_completeness: auditCompleteness,
      });
    } catch (auditErr) {
      console.warn('[Orchestrator] Audit trail build failed (non-blocking):', auditErr.message);
    }

    // Write completion worklog with pipeline progress
    const pipelineProgress = getPipelineProgress(allSteps);
    await appendWorklog(task.employee_id, task.id, null, 'task_lifecycle',
      buildWorklogEntry(WORKLOG_EVENTS.TASK_COMPLETED, {
        title: task.title,
        pipeline_progress: pipelineProgress,
        completed_phases: pipelineProgress.completedPhases,
        has_decision_brief: true,
        has_evidence_pack: true,
        has_writeback_payload: writebackPayload.intended_mutations.length > 0,
      })
    );
  } catch (err) {
    console.warn('[Orchestrator] Decision artifact generation failed (non-blocking):', err.message);
  }
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

export async function getTaskStatus(taskId, { lite = false } = {}) {
  const task = await taskRepo.getTask(taskId, { lite });
  const steps = await stepRepo.getSteps(taskId, { lite });
  return {
    task,
    steps,
    stepsCompleted: steps.filter(s => isStepTerminal(s.status)).length,
    stepsTotal: steps.length,
    isComplete: isTaskTerminal(task.status),
  };
}
