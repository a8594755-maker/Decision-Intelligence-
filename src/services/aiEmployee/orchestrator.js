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
import { stepTransition, STEP_STATES, STEP_EVENTS, isStepTerminal, isStepWaitingInput } from './stepStateMachine.js';
import { employeeTransition, EMPLOYEE_STATES, EMPLOYEE_EVENTS } from './employeeStateMachine.js';

import * as taskRepo from './persistence/taskRepo.js';
import * as stepRepo from './persistence/stepRepo.js';
import * as employeeRepo from './persistence/employeeRepo.js';
import { appendWorklog } from './persistence/worklogRepo.js';

import { getExecutor } from './executors/executorRegistry.js';
import { resolveContext, detectMissingContext } from './lazyContextService.js';
import { analyzeStepFailure, getAlternativeModel } from '../selfHealingService.js';
import { eventBus, EVENT_NAMES } from '../eventBus.js';
import { composeOutputProfileContext } from './styleLearning/outputProfileService.js';
import { extractFromSingleRevision } from './styleLearning/feedbackStyleExtractor.js';
import { checkBudget } from '../taskBudgetService.js';
import { recall, summarizeMemories } from '../aiEmployeeMemoryService.js';
import { reviewStepOutput, shouldReview } from '../aiReviewerService.js';
import { getLatestMetrics, recordReviewOutcome } from './styleLearning/trustMetricsService.js';
import { resolveCapabilityClass, getCapabilityPolicyFromDB } from '../capabilityModelService.js';
import { annotateStepsWithPhases, getPipelineProgress, classifyStepPhase, PIPELINE_PHASES } from './decisionPipelineService.js';
import { WORKLOG_EVENTS, buildWorklogEntry } from './worklogTaxonomy.js';
import { buildDecisionBrief } from '../artifacts/decisionArtifactBuilder.js';
import { buildEvidencePack } from '../artifacts/evidencePackBuilder.js';
import { buildWritebackPayload } from '../artifacts/writebackPayloadBuilder.js';
import { enforceApprovalGate } from '../approvalGateService.js';
import { recordTaskValue } from '../roi/valueTrackingService.js';
import { buildFullAuditTrail } from '../hardening/auditTrailService.js';
import { isRalphLoopEnabled, runRalphLoop } from './ralphLoopAdapter.js';
import { evaluateRules } from '../policyRuleService.js';
import { canExecuteTool } from '../toolPermissionGuard.js';

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

// ── Capability Policy Helpers ─────────────────────────────────────────────────

/**
 * Fetch a capability policy — delegates to capabilityModelService.getCapabilityPolicyFromDB().
 * DB-first, hardcoded fallback.
 */
async function _getCapabilityPolicy(capabilityClass, capabilityId = null) {
  return getCapabilityPolicyFromDB(capabilityClass, capabilityId);
}

/**
 * Check if inputData contains sensitive data markers.
 * @param {object} inputData
 * @returns {boolean}
 */
function _hasSensitiveData(inputData) {
  const sensitiveMarkers = ['unit_cost', 'unit_margin', 'salary', 'ssn', 'credit_card'];
  const str = JSON.stringify(inputData || {}).toLowerCase();
  return sensitiveMarkers.some(m => str.includes(m));
}

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
      // Capability check failure should not block auto-approve
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

  eventBus.emit(EVENT_NAMES.TASK_STARTED, { taskId, userId });

  // Start the tick loop
  _runTickLoop(taskId);
}

/**
 * Cancel a task.
 */
export async function cancelTask(taskId, _userId) {
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

  _runTickLoop(taskId);
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
  const nextStatus = taskTransition(task.status, TASK_EVENTS.REVIEW_APPROVED);
  const active = await taskRepo.updateTaskStatus(taskId, nextStatus, task.version);

  try {
    const employee = await employeeRepo.getEmployee(active.employee_id);
    const empState = employeeTransition(employee._logicalState, EMPLOYEE_EVENTS.REVIEW_RESOLVED);
    await employeeRepo.updateEmployeeStatus(active.employee_id, empState);
  } catch {
    // Best-effort only — task execution should still resume.
  }

  const { feedback, decision } = opts;

  // ── Feed review outcome into style/trust learning (best-effort) ──
  try {
    // Extract style rules from revision feedback (requires feedback text)
    if (feedback && decision !== 'approve') {
      await extractFromSingleRevision(active.employee_id, taskId, {
        original: opts.revision?.original,
        revised: opts.revision?.revised,
        feedback,
        workflowType: task.input_context?.workflow_type,
      }, opts.llmFn || null);
    }
    // Record outcome for trust metrics (regardless of decision)
    await recordReviewOutcome(active.employee_id, {
      taskId,
      decision: decision || 'approve',
      hasFeedback: Boolean(feedback),
      hasRevision: decision === 'needs_revision',
    });
  } catch (learnErr) {
    console.warn('[Orchestrator] Style/trust learning failed (non-blocking):', learnErr.message);
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
  // ── Ralph Loop mode: autonomous LLM-driven execution ──
  // Activates if globally enabled OR if the task was submitted with ralph_loop: true
  const task0 = await taskRepo.getTask(taskId);
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

  // ── Dataset gate: skip or warn if step requires data but none attached ──
  // Steps with `data_optional: true` or without `requires_dataset` proceed freely.
  // Steps with `requires_dataset` but no data: try lazy context first, only block
  // if the step truly cannot run without data (i.e. executor reports dependency error).
  const hasDataset = Boolean(
    task.input_context?.inputData?.datasetProfileId ||
    task.input_context?.dataset_profile_id
  );
  if (stepDef.requires_dataset && !hasDataset && !stepDef.data_optional) {
    // Attempt lazy dataset acquisition before blocking
    let lazyDatasetResolved = false;
    if (stepDef.context_hints?.dataset) {
      try {
        const resolved = await resolveContext(
          { source: stepDef.context_hints.dataset.source, params: stepDef.context_hints.dataset.params || {} },
          { taskId: task.id, employeeId: task.employee_id, inputData: task.input_context?.inputData || {} }
        );
        if (resolved.ok && resolved.data) {
          // Patch inputData with lazily resolved dataset
          if (!task.input_context.inputData) task.input_context.inputData = {};
          task.input_context.inputData.datasetProfileId = resolved.data.datasetProfileId || resolved.data.id;
          lazyDatasetResolved = true;
          await appendWorklog(task.employee_id, task.id, step.id, 'step_progress', {
            action: 'lazy_dataset_acquired',
            detail: `Resolved dataset via lazy context for step "${step.step_name}"`,
          });
        }
      } catch (lazyErr) {
        console.warn(`[Orchestrator] Lazy dataset resolution failed for step "${step.step_name}":`, lazyErr.message);
      }
    }

    // If lazy context didn't resolve dataset, let the step try anyway — the executor
    // will report a data dependency error if the tool truly cannot proceed.
    if (!lazyDatasetResolved) {
      console.warn(`[Orchestrator] Step "${step.step_name}" requires dataset but none attached — proceeding optimistically. Executor will block if data is truly needed.`);
    }
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

  // ── Capability policy gate ──
  try {
    const capClass = resolveCapabilityClass({
      tool_type: stepDef.tool_type || 'python_tool',
      builtin_tool_id: stepDef.builtin_tool_id,
    });
    const policy = await _getCapabilityPolicy(capClass, stepDef.builtin_tool_id);

    if (policy) {
      const stepAutonomy = await _getAutonomyLevel(task.employee_id);

      // Check approval requirement: hold step if policy requires approval
      // and worker autonomy is below the auto-approve threshold
      if (policy.approval_required && !_autonomyAtLeast(stepAutonomy, policy.auto_approve_at || 'A3') && !step._capability_approved) {
        const holdMsg = `Capability "${capClass}" requires approval (worker autonomy ${stepAutonomy} < auto-approve threshold ${policy.auto_approve_at})`;
        const holdPayload = {
          taskId: task.id, stepIndex: step.step_index, stepName: step.step_name,
          reason: 'capability_policy_hold', message: holdMsg,
        };

        await stepRepo.updateStep(step.id, {
          status: 'review_hold',
          error_message: holdMsg,
        });

        // Transition task to review state so tick loop pauses
        try {
          const nextTaskStatus = taskTransition(task.status, TASK_EVENTS.REVIEW_NEEDED);
          await taskRepo.updateTaskStatus(task.id, nextTaskStatus, task.version);
        } catch { /* task may already be in review */ }

        eventBus.emit(EVENT_NAMES.AGENT_STEP_BLOCKED, holdPayload);
        _publishSSE(task.id, { event_type: 'step_blocked', ...holdPayload });

        return { ok: false, review_hold: true, error: holdMsg };
      }

      // Check sensitive data access: block if policy disallows and data has sensitive markers
      if (policy.sensitive_data_allowed === false) {
        const inputDataForCheck = task.input_context?.inputData || {};
        if (_hasSensitiveData(inputDataForCheck)) {
          const sensitiveMsg = `Capability "${capClass}" does not allow sensitive data access. Remove sensitive fields or use a capability with sensitive_data_allowed=true.`;
          await stepRepo.updateStep(step.id, {
            status: 'failed',
            error_message: sensitiveMsg,
            ended_at: new Date().toISOString(),
          });
          return { ok: false, error: sensitiveMsg };
        }
      }
    }
  } catch (capErr) {
    // Capability policy check is best-effort — log and proceed
    console.warn('[Orchestrator] Capability policy check failed (non-blocking):', capErr.message);
  }

  // ── Tool permission + tier gate ──
  try {
    const employee = await employeeRepo.getEmployee(task.employee_id);
    const toolType = stepDef.tool_type || 'builtin_tool';
    const toolTier = stepDef.tier || null;
    const tierCheck = canExecuteTool(employee, toolType, toolTier);

    if (!tierCheck.allowed) {
      const reason = tierCheck.tierBlocked
        ? `Tool tier restricted: ${tierCheck.reason}`
        : `Permission denied: missing ${tierCheck.missing.join(', ')}`;
      await stepRepo.updateStep(step.id, {
        status: 'failed',
        error_message: reason,
        ended_at: new Date().toISOString(),
      });
      await appendWorklog(task.employee_id, task.id, step.id, 'step_progress', {
        event: 'permission_denied', reason, tool_type: toolType, tool_tier: toolTier,
      });
      return { ok: false, error: reason };
    }
  } catch (permErr) {
    // Permission check is best-effort — log and proceed
    console.warn('[Orchestrator] Permission/tier check failed (non-blocking):', permErr.message);
  }

  // ── User-configurable governance rules gate ──
  try {
    const capClass = resolveCapabilityClass({
      tool_type: stepDef.tool_type || 'python_tool',
      builtin_tool_id: stepDef.builtin_tool_id,
    });
    const autonomyLevel = await _getAutonomyLevel(task.employee_id);
    const ruleResult = await evaluateRules({
      capability_class: capClass,
      worker_template_id: task.input_context?.worker_template_id || null,
      autonomy_level: autonomyLevel,
      action_type: stepDef.tool_type || 'builtin_tool',
      cost_delta: task.input_context?.estimated_cost || 0,
    });

    if (!ruleResult.allowed) {
      const blockMsg = `Blocked by governance rule: ${ruleResult.reasons.join('; ')}`;
      await stepRepo.updateStep(step.id, {
        status: 'failed',
        error_message: blockMsg,
        ended_at: new Date().toISOString(),
      });
      await appendWorklog(task.employee_id, task.id, step.id, 'step_progress', {
        event: 'governance_blocked', reasons: ruleResult.reasons, triggered_rules: ruleResult.triggered_rules,
      });
      return { ok: false, error: blockMsg };
    }

    if (ruleResult.require_approval && !step._governance_approved) {
      const holdMsg = `Governance rule requires approval: ${ruleResult.reasons.join('; ')}`;
      await stepRepo.updateStep(step.id, { status: 'review_hold', error_message: holdMsg });
      try {
        const nextTaskStatus = taskTransition(task.status, TASK_EVENTS.REVIEW_NEEDED);
        await taskRepo.updateTaskStatus(task.id, nextTaskStatus, task.version);
      } catch { /* may already be in review */ }

      eventBus.emit(EVENT_NAMES.AGENT_STEP_BLOCKED, {
        taskId: task.id, stepIndex: step.step_index, stepName: step.step_name,
        reason: 'governance_rule_hold', message: holdMsg,
      });
      return { ok: false, review_hold: true, error: holdMsg };
    }

    if (ruleResult.require_review) {
      step._governance_require_review = true;
    }
  } catch (ruleErr) {
    // Governance rules are best-effort — log and proceed
    console.warn('[Orchestrator] Governance rule evaluation failed (non-blocking):', ruleErr.message);
  }

  // ── Approval gate: block publish-phase steps until approved ──
  try {
    const stepPhase = classifyStepPhase(stepDef);
    if (stepPhase === PIPELINE_PHASES.PUBLISH) {
      const actionType = _inferActionType(stepDef);
      const autonomyLevel = await _getAutonomyLevel(task.employee_id);
      const gate = enforceApprovalGate({
        taskId: task.id,
        actionType,
        workerTemplateId: task.input_context?.worker_template_id,
        autonomyLevel,
      });

      if (!gate.allowed) {
        // Transition task to awaiting_approval
        try {
          const awaitingStatus = taskTransition(task.status, TASK_EVENTS.REVIEW_NEEDED);
          await taskRepo.updateTaskStatus(task.id, awaitingStatus, task.version);
        } catch { /* may already be in awaiting_approval */ }

        _publishSSE(task.id, {
          event_type: 'approval_required',
          step_name: step.step_name,
          action_type: actionType,
          reason: gate.reason,
        });

        return { ok: false, error: `Approval required: ${gate.reason}`, needs_approval: true };
      }
    }
  } catch (gateErr) {
    console.warn('[Orchestrator] Approval gate check failed (non-blocking):', gateErr.message);
  }

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

  // ── Worklog: step started (audit trail completeness) ──
  try {
    await appendWorklog(task.employee_id, task.id, null, 'step_progress', {
      event: 'step_started', step_name: step.step_name, step_index: step.step_index,
      tool_type: stepDef.tool_type || 'unknown',
    });
  } catch { /* worklog is best-effort */ }

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
      mode: 'full',  // Use full mode for richer style context that affects execution
      deliverableType: task.input_context?.deliverable_type || stepDef.tool_type,
      audience: task.input_context?.deliverable_audience || null,
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

  // ── Lazy context acquisition: resolve missing data on-demand ──
  if (stepDef.required_context?.length > 0) {
    const missing = detectMissingContext({ inputData }, stepDef.required_context);
    for (const key of missing) {
      const contextHint = stepDef.context_hints?.[key];
      if (contextHint) {
        try {
          const resolved = await resolveContext(
            { source: contextHint.source, params: contextHint.params || {} },
            { taskId: task.id, employeeId: task.employee_id, inputData }
          );
          if (resolved.ok) {
            inputData[key] = resolved.data;
            await appendWorklog(task.employee_id, task.id, step.id, 'step_progress', {
              action: 'lazy_context_acquired',
              detail: `Resolved "${key}" from ${contextHint.source}`,
            });
          }
        } catch (err) {
          console.warn(`[Orchestrator] Lazy context "${key}" failed:`, err.message);
        }
      }
    }
  }

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
      // A4 (Trusted) workers skip AI review entirely
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

  // Build decision artifacts (best-effort)
  try {
    const allSteps = await stepRepo.getSteps(task.id);
    const priorArtifacts = {};
    const priorStepResults = [];
    for (const s of allSteps) {
      if (s.status === 'succeeded') {
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

// ── Approval gate helper ──────────────────────────────────────────────────────

function _inferActionType(stepDef) {
  const name = (stepDef.name || stepDef.step_name || '').toLowerCase();
  const toolType = (stepDef.tool_type || stepDef.builtin_tool_id || '').toLowerCase();
  const combined = `${name} ${toolType}`;

  if (combined.includes('writeback') || combined.includes('erp') || combined.includes('sap')) return 'writeback';
  if (combined.includes('notify') || combined.includes('email') || combined.includes('send') || combined.includes('slack')) return 'notify';
  return 'export'; // default for publish-phase steps
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
