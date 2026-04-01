/**
 * checkpointService.js — Workflow state checkpointing for time-travel, resume, and replay.
 *
 * Creates frozen snapshots of task+step state after each step completes.
 * Enables:
 *   - Time-travel debugging: view state at any completed step
 *   - Resume from checkpoint: restart from a specific point after crash
 *   - Replay with overrides: re-execute from checkpoint with modified inputs
 *
 * Storage: Supabase `ai_employee_checkpoints` table with in-memory cache.
 */

import { supabase } from '../infra/supabaseClient';
import * as taskRepo from './persistence/taskRepo.js';
import * as stepRepo from './persistence/stepRepo.js';
import { stepTransition, STEP_EVENTS, STEP_STATES } from './stepStateMachine.js';

const TABLE = 'ai_employee_checkpoints';

// In-memory cache for fast access during execution (keyed by taskId)
const _cache = new Map();

// ── Create Checkpoint ────────────────────────────────────────────────────────

/**
 * Create a checkpoint snapshot after a step completes.
 *
 * @param {string} taskId
 * @param {number} stepIndex - The step that just completed
 * @param {object} [extra] - Additional context to include in snapshot
 * @returns {Promise<object>} The created checkpoint
 */
export async function createCheckpoint(taskId, stepIndex, extra = {}) {
  const [task, steps] = await Promise.all([
    taskRepo.getTask(taskId),
    stepRepo.getSteps(taskId),
  ]);

  const completedStep = steps.find(s => s.step_index === stepIndex);

  // Build prior artifacts map
  const priorArtifacts = {};
  for (const s of steps) {
    if (s.status === 'succeeded' && s.artifact_refs?.length) {
      priorArtifacts[s.step_name] = s.artifact_refs;
    }
  }

  const stateSnapshot = {
    step_states: steps.map(s => ({
      step_index: s.step_index,
      step_name: s.step_name,
      status: s.status,
      tool_type: s.tool_type,
      retry_count: s.retry_count || 0,
      artifact_refs: s.artifact_refs || [],
      error_message: s.error_message || null,
      started_at: s.started_at,
      ended_at: s.ended_at,
      _revision_instructions: s._revision_instructions || null,
      _model_override: s._model_override || null,
    })),
    prior_artifacts: priorArtifacts,
    context: {
      input_context: task.input_context,
      plan_snapshot: task.plan_snapshot,
      llmConfig: task.input_context?.llmConfig || task.plan_snapshot?.llmConfig || {},
      completedStepCount: steps.filter(s => s.status === 'succeeded').length,
      totalStepCount: steps.length,
      ...extra,
    },
  };

  const checkpoint = {
    id: crypto.randomUUID(),
    task_id: taskId,
    step_index: stepIndex,
    step_name: completedStep?.step_name || `step_${stepIndex}`,
    task_status: task.status,
    task_version: task.version,
    state_snapshot: stateSnapshot,
    created_at: new Date().toISOString(),
  };

  // Persist to DB
  try {
    await supabase.from(TABLE).insert(checkpoint);
  } catch (err) {
    console.warn(`[Checkpoint] DB write failed for task ${taskId} step ${stepIndex}: ${err.message}`);
    // Continue with in-memory only
  }

  // Update in-memory cache
  if (!_cache.has(taskId)) _cache.set(taskId, []);
  _cache.get(taskId).push(checkpoint);

  return checkpoint;
}

// ── Read Checkpoints ─────────────────────────────────────────────────────────

/**
 * List all checkpoints for a task, ordered by step_index.
 *
 * @param {string} taskId
 * @returns {Promise<Array<object>>}
 */
export async function getCheckpoints(taskId) {
  // Try cache first
  if (_cache.has(taskId)) {
    return _cache.get(taskId).sort((a, b) => a.step_index - b.step_index);
  }

  try {
    const { data } = await supabase
      .from(TABLE)
      .select('*')
      .eq('task_id', taskId)
      .order('step_index', { ascending: true });
    if (data?.length) {
      _cache.set(taskId, data);
      return data;
    }
  } catch {
    // DB unavailable
  }

  return [];
}

/**
 * Get a specific checkpoint by ID.
 *
 * @param {string} checkpointId
 * @returns {Promise<object|null>}
 */
export async function getCheckpoint(checkpointId) {
  // Search cache first
  for (const [, checkpoints] of _cache) {
    const found = checkpoints.find(c => c.id === checkpointId);
    if (found) return found;
  }

  try {
    const { data } = await supabase
      .from(TABLE)
      .select('*')
      .eq('id', checkpointId)
      .maybeSingle();
    return data || null;
  } catch {
    return null;
  }
}

/**
 * Get the most recent checkpoint for a task.
 *
 * @param {string} taskId
 * @returns {Promise<object|null>}
 */
export async function getLatestCheckpoint(taskId) {
  const checkpoints = await getCheckpoints(taskId);
  return checkpoints.length > 0 ? checkpoints[checkpoints.length - 1] : null;
}

// ── Resume from Checkpoint ───────────────────────────────────────────────────

/**
 * Resume task execution from a specific checkpoint.
 * Resets steps after the checkpoint back to pending, preserving completed steps.
 *
 * @param {string} taskId
 * @param {string} checkpointId
 * @returns {Promise<{ resetSteps: number, resumeFromIndex: number }>}
 */
export async function resumeFromCheckpoint(taskId, checkpointId) {
  const checkpoint = await getCheckpoint(checkpointId);
  if (!checkpoint) throw new Error(`Checkpoint not found: ${checkpointId}`);
  if (checkpoint.task_id !== taskId) throw new Error('Checkpoint does not belong to this task');

  const steps = await stepRepo.getSteps(taskId);
  let resetCount = 0;

  // Reset all steps AFTER the checkpoint back to pending
  for (const step of steps) {
    if (step.step_index > checkpoint.step_index) {
      await stepRepo.updateStep(step.id, {
        status: STEP_STATES.PENDING,
        error_message: null,
        retry_count: 0,
        started_at: null,
        ended_at: null,
        _revision_instructions: null,
        _model_override: null,
      });
      resetCount++;
    }
  }

  // Restore task status to in_progress if it was terminal
  const task = await taskRepo.getTask(taskId);
  if (['done', 'failed', 'cancelled'].includes(task.status)) {
    await taskRepo.updateTaskStatus(taskId, 'in_progress', task.version);
  }

  return {
    resetSteps: resetCount,
    resumeFromIndex: checkpoint.step_index + 1,
  };
}

// ── Replay from Checkpoint ───────────────────────────────────────────────────

/**
 * Create a new task that replays from a checkpoint with optional input overrides.
 * The new task starts from the checkpoint's step_index + 1 with modified context.
 *
 * @param {string} taskId - Original task
 * @param {string} checkpointId
 * @param {object} [overrides] - Override input_context fields
 * @returns {Promise<{ newTaskId: string, startFromStep: number }>}
 */
export async function replayFromCheckpoint(taskId, checkpointId, overrides = {}) {
  const checkpoint = await getCheckpoint(checkpointId);
  if (!checkpoint) throw new Error(`Checkpoint not found: ${checkpointId}`);

  const originalTask = await taskRepo.getTask(taskId);

  // Merge overrides into input context
  const newInputContext = {
    ...checkpoint.state_snapshot.context.input_context,
    ...overrides,
    _replayed_from: { taskId, checkpointId, stepIndex: checkpoint.step_index },
  };

  // Create a new task with the same plan but modified context
  const newTask = await taskRepo.createTask({
    employee_id: originalTask.employee_id,
    title: `[Replay] ${originalTask.title}`,
    description: `Replay from checkpoint at step ${checkpoint.step_index} (${checkpoint.step_name})`,
    priority: originalTask.priority,
    source_type: 'manual',
    assigned_by_user_id: originalTask.assigned_by_user_id,
    input_context: newInputContext,
    plan_snapshot: checkpoint.state_snapshot.context.plan_snapshot,
  });

  return {
    newTaskId: newTask.id,
    startFromStep: checkpoint.step_index + 1,
  };
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

/**
 * Prune old checkpoints, keeping only the most recent N.
 *
 * @param {string} taskId
 * @param {number} [keepLast=5]
 * @returns {Promise<number>} Number of checkpoints deleted
 */
export async function pruneCheckpoints(taskId, keepLast = 5) {
  const checkpoints = await getCheckpoints(taskId);
  if (checkpoints.length <= keepLast) return 0;

  const toDelete = checkpoints.slice(0, checkpoints.length - keepLast);
  const ids = toDelete.map(c => c.id);

  try {
    await supabase.from(TABLE).delete().in('id', ids);
  } catch (err) {
    console.warn(`[Checkpoint] Prune failed: ${err.message}`);
    return 0;
  }

  // Update cache
  if (_cache.has(taskId)) {
    _cache.set(taskId, checkpoints.slice(-keepLast));
  }

  return ids.length;
}

/**
 * Clear the in-memory cache for a task.
 * @param {string} taskId
 */
export function clearCache(taskId) {
  _cache.delete(taskId);
}
