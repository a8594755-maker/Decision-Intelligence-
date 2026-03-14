// @product: ai-employee
//
// agentLoopService.js
// ─────────────────────────────────────────────────────────────────────────────
// Core agent loop engine for multi-step task execution.
//
// Pull-based tick model: each call to `tickAgentLoop` advances exactly one
// step, persists progress to loop_state, and returns. This avoids long-running
// promises that break on navigation/refresh.
//
// Flow:
//   initAgentLoop  → sets template + loop_state on the task
//   tickAgentLoop  → advances one step (or pauses at review checkpoint)
//   runAgentLoop   → ticks in a loop until done or paused
//   approveStepAndContinue  → unblocks a review_hold step
//   reviseStepAndRetry      → resets a step for re-execution
// ─────────────────────────────────────────────────────────────────────────────

import * as aiEmployeeService from './aiEmployeeService';
import { executeTask } from './aiEmployeeExecutor';
import { resolveTemplate, initLoopState } from './agentLoopTemplates';
import { recall, summarizeMemories } from './aiEmployeeMemoryService';
import { checkBudget, BudgetExceededError } from './taskBudgetService';
import { reviewStepOutput, shouldReview, MAX_REVISION_ROUNDS } from './aiReviewerService';
import { isDynamicTemplate, getDynamicTemplateFromTask, initDynamicLoopState } from './dynamicTemplateBuilder';
import { analyzeStepFailure, getAlternativeModel } from './selfHealingService';
import { eventBus, EVENT_NAMES } from './eventBus';
import { computeBackoff } from './stepStateMachine';

// ── Constants ────────────────────────────────────────────────────────────────

export const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;

// ML API base for SSE publishing
const ML_API_URL = import.meta.env?.VITE_ML_API_URL || 'http://localhost:8000';

/**
 * Publish a step event to the SSE channel (best-effort, non-blocking).
 * This allows the SSE endpoint to relay events to other subscribers.
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

export const STEP_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  BLOCKED: 'blocked',
  REVIEW_HOLD: 'review_hold',
  SKIPPED: 'skipped',
};

const TERMINAL = new Set([STEP_STATUS.SUCCEEDED, STEP_STATUS.BLOCKED, STEP_STATUS.SKIPPED]);

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function backoffMs(retryCount) {
  return computeBackoff(retryCount, { baseMs: BACKOFF_BASE_MS, maxMs: 30000, jitterFactor: 0.3 });
}

/**
 * Find the next step that should execute.
 * Priority: first step that is 'pending', or first 'failed' with retries remaining.
 * If a 'review_hold' step is encountered before any actionable step, returns it.
 */
function findNextStep(steps) {
  for (const step of steps) {
    if (step.status === STEP_STATUS.REVIEW_HOLD) return step;
    if (step.status === STEP_STATUS.PENDING) return step;
    if (step.status === STEP_STATUS.FAILED && step.retry_count < MAX_RETRIES) return step;
    if (step.status === STEP_STATUS.RUNNING) return step; // stale running (browser closed)
    if (TERMINAL.has(step.status)) continue;
    // Unknown status — treat as blocked
    break;
  }
  return null;
}

/**
 * Build input_context for a specific step, chaining artifacts from prior steps.
 */
function buildStepInputContext(taskInputContext, stepDef, loopState) {
  const base = { ...taskInputContext };
  base.workflow_type = stepDef.workflow_type;

  // Chain artifacts from completed prior steps
  const priorArtifacts = {};
  for (const prev of loopState.steps) {
    if (prev.index >= stepDef.index) break;
    if (prev.status === STEP_STATUS.SUCCEEDED && prev.artifact_refs?.length > 0) {
      priorArtifacts[prev.name] = prev.artifact_refs;
    }
  }
  base._prior_step_artifacts = priorArtifacts;

  // If risk_aware_plan template and we have risk step completed, enable risk mode for plan
  if (stepDef.workflow_type === 'plan' && priorArtifacts.risk) {
    base.riskMode = 'on';
  }

  // Pass AI review revision instructions (Phase 4)
  if (stepDef._revision_instructions?.length) {
    base._revision_instructions = stepDef._revision_instructions;
  }

  // Pass tool hint and tool_id for dynamic/registered/builtin tool steps
  if (stepDef.tool_hint) base._tool_hint = stepDef.tool_hint;
  if (stepDef.tool_id) base._tool_id = stepDef.tool_id;
  if (stepDef.builtin_tool_id) base._builtin_tool_id = stepDef.builtin_tool_id;

  // Self-healing context (from previous failure analysis)
  if (stepDef._healing_strategy) base._healing_strategy = stepDef._healing_strategy;
  if (stepDef._model_override) base._model_override = stepDef._model_override;
  if (stepDef._simplified_hint) base._simplified_hint = stepDef._simplified_hint;

  return base;
}

/**
 * Check if the entire loop is done (all steps in terminal state or review_hold).
 */
function isLoopDone(steps) {
  return steps.every((s) =>
    TERMINAL.has(s.status) || s.status === STEP_STATUS.REVIEW_HOLD
  );
}

function isLoopFullyComplete(steps) {
  return steps.every((s) => s.status === STEP_STATUS.SUCCEEDED || s.status === STEP_STATUS.SKIPPED);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialize an agent loop for a task.
 * Resolves template from task.template_id or task.input_context.workflow_type,
 * sets loop_state on the task.
 *
 * @param {string} taskId
 * @param {string} userId
 * @returns {Promise<object>} Updated task with loop_state
 */
export async function initAgentLoop(taskId, userId) {
  console.log('[initAgentLoop] Getting task:', taskId);
  const task = await aiEmployeeService.getTask(taskId);
  console.log('[initAgentLoop] Got task:', !!task, 'template_id:', task?.template_id, 'ic_template_id:', task?.input_context?.template_id);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  // Already initialized
  if (task.loop_state?.steps?.length > 0) return task;

  const templateId = task.template_id || task.input_context?.template_id || task.input_context?.workflow_type;
  console.log('[initAgentLoop] templateId:', templateId, 'isDynamic:', isDynamicTemplate(templateId));

  // Dynamic templates are stored in input_context, not the static registry
  let template;
  let loopState;
  if (isDynamicTemplate(templateId)) {
    template = getDynamicTemplateFromTask(task);
    if (!template) throw new Error(`Dynamic template not found in task input_context: ${templateId}`);
    loopState = initDynamicLoopState(template);
  } else {
    template = resolveTemplate(templateId);
    if (!template) throw new Error(`Unknown template: ${templateId}`);
    loopState = initLoopState(template);
  }
  loopState.started_at = new Date().toISOString();
  console.log('[initAgentLoop] loopState steps:', loopState.steps?.length, 'Saving...');

  await aiEmployeeService.updateTaskLoopState(taskId, loopState);
  console.log('[initAgentLoop] Saved. Refreshing task...');

  // Return refreshed task
  const refreshed = await aiEmployeeService.getTask(taskId);
  console.log('[initAgentLoop] Done. Has loop_state:', !!refreshed?.loop_state);
  return refreshed;
}

/**
 * Advance the agent loop by one step.
 *
 * @param {string} taskId
 * @param {string} userId
 * @returns {Promise<{ done: boolean, step_event: object|null, task: object }>}
 */
export async function tickAgentLoop(taskId, userId) {
  const task = await aiEmployeeService.getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  const loopState = task.loop_state;
  if (!loopState?.steps?.length) {
    throw new Error('Task has no loop_state — call initAgentLoop first');
  }

  const steps = loopState.steps;

  // ── Find next actionable step ───────────────────────────────────────────
  const nextStep = findNextStep(steps);

  // All done?
  if (!nextStep) {
    const allComplete = isLoopFullyComplete(steps);
    if (allComplete) {
      loopState.finished_at = new Date().toISOString();
      await aiEmployeeService.updateTaskLoopState(taskId, loopState);
      await aiEmployeeService.updateTaskStatus(taskId, 'waiting_review');
      await aiEmployeeService.updateEmployeeStatus(task.employee_id, 'waiting_review');
    } else {
      // Some steps blocked — mark task blocked
      await aiEmployeeService.updateTaskStatus(taskId, 'blocked');
      await aiEmployeeService.updateEmployeeStatus(task.employee_id, 'blocked');
    }
    return { done: true, step_event: null, task: await aiEmployeeService.getTask(taskId) };
  }

  // ── Review hold — loop pauses ───────────────────────────────────────────
  if (nextStep.status === STEP_STATUS.REVIEW_HOLD) {
    return {
      done: false,
      step_event: { step_name: nextStep.name, status: 'review_hold', summary: `Step "${nextStep.name}" awaiting review.` },
      task,
    };
  }

  // ── Already running (stale) — treat as failed and retry ─────────────────
  if (nextStep.status === STEP_STATUS.RUNNING) {
    nextStep.status = STEP_STATUS.FAILED;
    nextStep.error = 'Step was running but interrupted (browser closed or timeout).';
    nextStep.retry_count += 1;
    nextStep.finished_at = new Date().toISOString();
    await aiEmployeeService.updateTaskLoopState(taskId, loopState);
    // If retries exceeded, mark blocked
    if (nextStep.retry_count >= MAX_RETRIES) {
      nextStep.status = STEP_STATUS.BLOCKED;
      await aiEmployeeService.updateTaskLoopState(taskId, loopState);
      return {
        done: isLoopDone(steps),
        step_event: { step_name: nextStep.name, status: 'blocked', error: nextStep.error },
        task: await aiEmployeeService.getTask(taskId),
      };
    }
    // Fall through to retry
  }

  // ── Execute the step ────────────────────────────────────────────────────

  // Budget gate: block step if task budget is exhausted
  try {
    const budgetResult = await checkBudget(taskId);
    if (!budgetResult.allowed) {
      nextStep.status = STEP_STATUS.BLOCKED;
      nextStep.error = `Budget exceeded: ${budgetResult.reason}`;
      nextStep.finished_at = new Date().toISOString();
      await aiEmployeeService.updateTaskLoopState(taskId, loopState);
      return {
        done: isLoopDone(steps),
        step_event: { step_name: nextStep.name, status: 'blocked', error: nextStep.error },
        task: await aiEmployeeService.getTask(taskId),
      };
    }
  } catch { /* budget check is best-effort — proceed if service unavailable */ }

  // Backoff if retrying
  if (nextStep.retry_count > 0) {
    await sleep(backoffMs(nextStep.retry_count - 1));
  }

  // Mark running
  nextStep.status = STEP_STATUS.RUNNING;
  nextStep.started_at = new Date().toISOString();
  nextStep.error = null;
  await aiEmployeeService.updateTaskLoopState(taskId, loopState);

  // Emit step_started event
  const startPayload = { step_name: nextStep.name, step_index: nextStep.index, status: 'running', timestamp: Date.now() / 1000 };
  eventBus.emit(EVENT_NAMES.AGENT_STEP_STARTED, startPayload);
  _publishSSE(taskId, { event_type: 'step_started', ...startPayload });

  // Ensure task + employee are in_progress
  await aiEmployeeService.updateTaskStatus(taskId, 'in_progress');
  await aiEmployeeService.updateEmployeeStatus(task.employee_id, 'working');

  // Build synthetic task for the single-step executor
  const stepInputContext = buildStepInputContext(task.input_context || {}, nextStep, loopState);

  // Inject memory context from prior runs (best-effort)
  try {
    const memories = await recall(task.employee_id, {
      workflowType: nextStep.workflow_type,
      datasetFingerprint: task.input_context?.dataset_fingerprint || null,
      limit: 5,
    });
    if (memories?.length > 0) {
      stepInputContext._memory_context = summarizeMemories(memories);
    }
  } catch { /* memory recall is best-effort */ }

  const syntheticTask = {
    ...task,
    input_context: stepInputContext,
    // Override so createRun gets step metadata
    _step_index: nextStep.index,
    _step_name: nextStep.name,
  };

  try {
    const result = await executeTask(syntheticTask, userId);

    // ── AI Review gate (Phase 4) ─────────────────────────────────────────
    // If the step has ai_review enabled, score the output before marking succeeded.
    // On failure: store revision instructions, reset to PENDING, increment retry.
    if (nextStep.ai_review && shouldReview(nextStep.workflow_type)) {
      try {
        const priorReviews = nextStep._revision_log || [];
        const review = await reviewStepOutput({
          taskId,
          stepName: nextStep.name,
          workflowType: nextStep.workflow_type,
          output: result?.run || result?.result || result,
          priorReviews,
        });

        // Track review in step's revision log
        if (!nextStep._revision_log) nextStep._revision_log = [];
        nextStep._revision_log.push(review);

        if (!review.passed && nextStep.retry_count < MAX_RETRIES) {
          // Revision needed — send back
          nextStep.status = STEP_STATUS.PENDING;
          nextStep._revision_instructions = review.suggestions || [];
          nextStep.retry_count += 1;
          nextStep.error = `AI review: ${review.score}/${review.threshold} — revision needed`;
          nextStep.finished_at = new Date().toISOString();
          await aiEmployeeService.updateTaskLoopState(taskId, loopState);

          // Build enriched revision event with code details
          const revisionEvent = {
            step_name: nextStep.name,
            status: 'revision_needed',
            review_score: review.score,
            review_threshold: review.threshold,
            review_passed: false,
            suggestions: review.suggestions,
          };
          // Include code from result if available
          const revPt = result?.python_tool;
          if (revPt?.code) {
            revisionEvent.code = revPt.code;
            revisionEvent.code_language = 'python';
            if (revPt.artifacts) revisionEvent.artifacts = revPt.artifacts;
          }
          // Emit revision event via EventBus + SSE
          eventBus.emit(EVENT_NAMES.AGENT_STEP_REVISION, revisionEvent);
          _publishSSE(taskId, { event_type: 'step_revision', ...revisionEvent });

          return {
            done: false,
            step_event: revisionEvent,
            task: await aiEmployeeService.getTask(taskId),
          };
        }
      } catch (reviewErr) {
        console.warn('[agentLoopService] AI review failed, proceeding anyway:', reviewErr?.message);
      }
    }

    // Step succeeded
    nextStep.status = nextStep.requires_review ? STEP_STATUS.REVIEW_HOLD : STEP_STATUS.SUCCEEDED;
    nextStep.run_id = result.run?.id || null;
    nextStep.artifact_refs = result.run?.artifact_refs || [];
    nextStep.finished_at = new Date().toISOString();
    nextStep.error = null;

    await aiEmployeeService.updateTaskLoopState(taskId, loopState);

    // Write step_progress worklog
    try {
      await aiEmployeeService.appendWorklog(
        task.employee_id, taskId, nextStep.run_id, 'step_progress',
        {
          step_name: nextStep.name,
          step_index: nextStep.index,
          status: nextStep.status,
          summary: result.run?.summary || `Step "${nextStep.name}" completed.`,
          artifacts_generated: nextStep.artifact_refs.length,
        }
      );
    } catch { /* worklog is best-effort */ }

    // If review_hold, set task to waiting_review
    if (nextStep.status === STEP_STATUS.REVIEW_HOLD) {
      await aiEmployeeService.updateTaskStatus(taskId, 'waiting_review');
      await aiEmployeeService.updateEmployeeStatus(task.employee_id, 'waiting_review');
    }

    const updatedTask = await aiEmployeeService.getTask(taskId);

    // ── Build enriched step_event with execution details for dashboard ────
    const stepEvent = {
      step_name: nextStep.name,
      status: nextStep.status,
      summary: result.run?.summary || `Step "${nextStep.name}" completed.`,
      artifacts: nextStep.artifact_refs || [],
    };

    // Enrich with python_tool details (generated code, stdout, stderr, API call info)
    const pt = result?.python_tool;
    if (pt) {
      if (pt.code) stepEvent.code = pt.code;
      stepEvent.code_language = 'python';
      if (pt.stdout) stepEvent.stdout = pt.stdout;
      if (pt.stderr) stepEvent.stderr = pt.stderr;
      if (pt.artifacts) stepEvent.artifacts = pt.artifacts;
      stepEvent.api_call = {
        method: 'POST',
        url: '/execute-tool',
        provider: pt.llm_provider || pt.metadata?.provider || '—',
        model: pt.llm_model || pt.metadata?.model || '—',
        duration_ms: pt.execution_ms || null,
        status: 200,
      };
    }

    // Enrich with python_report details
    const pr = result?.python_report;
    if (pr) {
      if (pr.code) stepEvent.code = pr.code;
      stepEvent.code_language = 'python';
      if (pr.artifacts) stepEvent.artifacts = pr.artifacts;
      stepEvent.api_call = {
        method: 'POST',
        url: '/generate-report',
        duration_ms: pr.execution_ms || null,
        status: 200,
      };
    }

    // Enrich with dynamic_tool details
    const dt = result?.dynamic_tool;
    if (dt) {
      if (dt.code) stepEvent.code = dt.code;
      stepEvent.code_language = dt.language || 'javascript';
      if (dt.stdout) stepEvent.stdout = dt.stdout;
      if (dt.stderr) stepEvent.stderr = dt.stderr;
    }

    // Emit step_completed event via EventBus + SSE
    eventBus.emit(EVENT_NAMES.AGENT_STEP_COMPLETED, stepEvent);
    _publishSSE(taskId, { event_type: 'step_completed', ...stepEvent, loop_state: loopState });

    const isDone = isLoopFullyComplete(loopState.steps) && nextStep.status !== STEP_STATUS.REVIEW_HOLD;
    if (isDone) {
      eventBus.emit(EVENT_NAMES.AGENT_LOOP_DONE, { taskId });
      _publishSSE(taskId, { event_type: 'loop_done', timestamp: Date.now() / 1000 });
    }

    return {
      done: isDone,
      step_event: stepEvent,
      task: updatedTask,
    };

  } catch (err) {
    // Step failed — apply intelligent self-healing
    const errorMsg = err?.message || String(err);
    nextStep.error = errorMsg;
    nextStep.retry_count += 1;
    nextStep.finished_at = new Date().toISOString();

    // Analyze failure and choose healing strategy
    const healing = analyzeStepFailure(err, nextStep, nextStep.retry_count);

    if (nextStep.retry_count >= MAX_RETRIES || healing.healingStrategy === 'block_immediately') {
      nextStep.status = STEP_STATUS.BLOCKED;
      nextStep._healing_strategy = healing;
    } else {
      nextStep.status = STEP_STATUS.PENDING; // allow retry with modified approach
      nextStep._healing_strategy = healing;

      // Strategy: revise_prompt — append error context to revision instructions
      if (healing.healingStrategy === 'revise_prompt') {
        nextStep._revision_instructions = [
          ...(nextStep._revision_instructions || []),
          `Previous error: ${errorMsg}`,
          ...(healing.modifications.promptSuffix ? [healing.modifications.promptSuffix] : []),
        ];
      }

      // Strategy: escalate_model — find an alternative provider/model
      if (healing.healingStrategy === 'escalate_model') {
        try {
          const alt = await getAlternativeModel(
            nextStep._last_provider || 'unknown',
            nextStep._last_model || 'unknown',
            nextStep.workflow_type
          );
          if (alt) {
            nextStep._model_override = alt;
          }
        } catch { /* best-effort */ }
      }

      // Strategy: simplify_task — reduce scope
      if (healing.healingStrategy === 'simplify_task' && healing.modifications.simplifiedHint) {
        nextStep._simplified_hint = healing.modifications.simplifiedHint;
      }

      console.info(`[agentLoopService] Self-healing: ${healing.healingStrategy} (${healing.reasoning})`);
    }

    await aiEmployeeService.updateTaskLoopState(taskId, loopState);

    // Write escalation worklog
    try {
      await aiEmployeeService.appendWorklog(
        task.employee_id, taskId, null, 'step_progress',
        {
          step_name: nextStep.name,
          step_index: nextStep.index,
          status: nextStep.status,
          error: nextStep.error,
          retry_count: nextStep.retry_count,
          healing_strategy: nextStep._healing_strategy?.healingStrategy || null,
        }
      );
    } catch { /* best-effort */ }

    const failEvent = {
      step_name: nextStep.name,
      status: nextStep.status,
      error: nextStep.error,
      retry_count: nextStep.retry_count,
      healing_strategy: nextStep._healing_strategy?.healingStrategy || null,
      healing_reasoning: nextStep._healing_strategy?.reasoning || null,
    };

    // Emit step_failed event via EventBus + SSE
    eventBus.emit(EVENT_NAMES.AGENT_STEP_FAILED, failEvent);
    _publishSSE(taskId, { event_type: 'step_failed', ...failEvent, loop_state: loopState });

    return {
      done: isLoopDone(loopState.steps),
      step_event: failEvent,
      task: await aiEmployeeService.getTask(taskId),
    };
  }
}

/**
 * Resume after a review checkpoint is approved.
 * Marks the step as succeeded and allows tick to continue.
 *
 * @param {string} taskId
 * @param {string} stepName
 * @returns {Promise<object>} Updated loop_state
 */
export async function approveStepAndContinue(taskId, stepName) {
  const task = await aiEmployeeService.getTask(taskId);
  if (!task?.loop_state) throw new Error('No loop_state on task');

  const step = task.loop_state.steps.find((s) => s.name === stepName);
  if (!step) throw new Error(`Step not found: ${stepName}`);
  if (step.status !== STEP_STATUS.REVIEW_HOLD) {
    throw new Error(`Step "${stepName}" is not in review_hold (current: ${step.status})`);
  }

  step.status = STEP_STATUS.SUCCEEDED;
  step.finished_at = new Date().toISOString();

  await aiEmployeeService.updateTaskLoopState(taskId, task.loop_state);
  // Move task back to in_progress so next tick can continue
  await aiEmployeeService.updateTaskStatus(taskId, 'in_progress');

  return task.loop_state;
}

/**
 * Resume after a review requests revision.
 * Resets the step to pending so it will re-execute on next tick.
 *
 * @param {string} taskId
 * @param {string} stepName
 * @returns {Promise<object>} Updated loop_state
 */
export async function reviseStepAndRetry(taskId, stepName) {
  const task = await aiEmployeeService.getTask(taskId);
  if (!task?.loop_state) throw new Error('No loop_state on task');

  const step = task.loop_state.steps.find((s) => s.name === stepName);
  if (!step) throw new Error(`Step not found: ${stepName}`);

  step.status = STEP_STATUS.PENDING;
  step.error = null;
  step.run_id = null;
  step.artifact_refs = [];
  step.started_at = null;
  step.finished_at = null;
  // Keep retry_count as-is to track total attempts

  await aiEmployeeService.updateTaskLoopState(taskId, task.loop_state);
  await aiEmployeeService.updateTaskStatus(taskId, 'in_progress');

  return task.loop_state;
}

/**
 * Run the full agent loop to completion (or first pause point).
 * Calls tickAgentLoop in a loop. Suitable for background execution.
 *
 * @param {string} taskId
 * @param {string} userId
 * @param {object} [opts]
 * @param {function} [opts.onStepComplete] - Callback after each step: (step_event) => void
 * @param {AbortSignal} [opts.signal] - For cancellation
 * @returns {Promise<{ task: object, completed_steps: string[], halted_at: string|null }>}
 */
export async function runAgentLoop(taskId, userId, opts = {}) {
  const { onStepComplete, signal } = opts;
  const completedSteps = [];
  let haltedAt = null;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (signal?.aborted) {
      haltedAt = 'aborted';
      break;
    }

    const { done, step_event, task } = await tickAgentLoop(taskId, userId);

    if (step_event) {
      if (step_event.status === STEP_STATUS.SUCCEEDED || step_event.status === STEP_STATUS.REVIEW_HOLD) {
        completedSteps.push(step_event.step_name);
      }
      if (onStepComplete) {
        // Attach task reference so dashboard can read updated loop_state
        try { onStepComplete({ ...step_event, task }); } catch { /* ignore callback errors */ }
      }
    }

    if (done) break;

    // Pause on review hold
    if (step_event?.status === STEP_STATUS.REVIEW_HOLD) {
      haltedAt = step_event.step_name;
      break;
    }

    // Pause on blocked (will retry on next tick if retries remain)
    if (step_event?.status === STEP_STATUS.BLOCKED) {
      haltedAt = step_event.step_name;
      break;
    }
  }

  const finalTask = await aiEmployeeService.getTask(taskId);
  return { task: finalTask, completed_steps: completedSteps, halted_at: haltedAt };
}

export default {
  initAgentLoop,
  tickAgentLoop,
  runAgentLoop,
  approveStepAndContinue,
  reviseStepAndRetry,
  STEP_STATUS,
  MAX_RETRIES,
};
