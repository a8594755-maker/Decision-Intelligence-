/**
 * queries.js — Unified read-only query facade for the AI Employee subsystem.
 *
 * Aggregates read methods from all persistence repos into a single namespace.
 * UI pages should import from here instead of aiEmployeeService.js.
 *
 * Design decisions:
 * - No localStorage fallback (Supabase is required).
 * - Errors propagate to the caller.
 * - Artifact enrichment lives here (shared by TasksPage and ReviewPage).
 */

import * as taskRepo from './persistence/taskRepo.js';
import * as stepRepo from './persistence/stepRepo.js';
import * as employeeRepo from './persistence/employeeRepo.js';
import * as worklogRepo from './persistence/worklogRepo.js';
import * as reviewRepo from './persistence/reviewRepo.js';
import { diRunsService } from '../diRunsService.js';
import { loadArtifact } from '../../utils/artifactStore.js';

// ── Re-export worker template catalog ──
export { WORKER_TEMPLATES } from './persistence/employeeRepo.js';

// ── Employee queries ──

export const getOrCreateWorker = employeeRepo.getOrCreateWorker;
export const getEmployee = employeeRepo.getEmployee;
export const listEmployeesByManager = employeeRepo.listEmployeesByManager;
export const getKpis = employeeRepo.getKpis;
export const createWorkerFromTemplate = employeeRepo.createWorkerFromTemplate;
export const deleteWorker = employeeRepo.deleteWorker;
export const updateWorker = employeeRepo.updateWorker;
export const listTemplates = employeeRepo.listTemplates;

// ── Task queries ──

export const getTask = taskRepo.getTask;
export const listTasks = taskRepo.listTasks;
export const listTasksByUser = taskRepo.listTasksByUser;
export const listTasksByStatus = taskRepo.listTasksByStatus;

/**
 * List pending reviews with enriched artifact data.
 * Joins runs, enriches artifact refs, and synthesizes loop_state for legacy compat.
 */
export async function listPendingReviews(userId) {
  const raw = await taskRepo.listPendingReviews(userId);
  return Promise.all(raw.map(async (item) => {
    const runs = await enrichRunsWithArtifacts(item.ai_employee_runs || []);
    return {
      ...item,
      ai_employee_runs: runs,
      loop_state: synthesizeLoopStateFromRuns(item.loop_state, runs),
    };
  }));
}

/**
 * Get a task with its step rows joined.
 * Returns a task object with an `ai_employee_runs` array (step rows sorted by step_index).
 * Also synthesizes loop_state for backward compatibility with old UI code.
 */
export async function getTaskWithSteps(taskId) {
  const [task, steps] = await Promise.all([
    taskRepo.getTask(taskId),
    stepRepo.getSteps(taskId),
  ]);
  if (!task) return null;

  return {
    ...task,
    ai_employee_runs: steps,
    loop_state: synthesizeLoopStateFromRuns(task.loop_state, steps),
  };
}

// ── Step queries ──

export const getSteps = stepRepo.getSteps;

// ── Worklog queries ──

export const listWorklogs = worklogRepo.listWorklogs;
export const appendWorklog = worklogRepo.appendWorklog;

// ── Review queries ──

export const createReview = reviewRepo.createReview;
export const listReviewsForTask = reviewRepo.listReviewsForTask;

// ── Artifact enrichment utilities ──

/**
 * Enrich a single artifact ref (UUID string or object) with full data.
 */
async function enrichRunArtifactRef(ref) {
  if (!ref) return null;

  if (typeof ref === 'string') {
    const artifact = await diRunsService.getArtifactById(ref).catch(() => null);
    const data = artifact
      ? await loadArtifact({ artifact_id: ref, ...(artifact.artifact_json || {}) }).catch(() => artifact.artifact_json ?? null)
      : null;

    return {
      artifact_id: ref,
      type: artifact?.artifact_type || 'artifact_ref',
      artifact_type: artifact?.artifact_type || 'artifact_ref',
      label: artifact?.artifact_type || `Artifact ${ref.slice(0, 8)}`,
      data,
    };
  }

  if (typeof ref !== 'object') return null;

  const artifactId = ref.artifact_id || ref.id || ref.output_ref?.artifact_id || ref.input_ref?.artifact_id || null;
  if (!artifactId) {
    return { ...ref, data: ref.data ?? ref.payload ?? null };
  }

  const artifact = await diRunsService.getArtifactById(artifactId).catch(() => null);
  const data = await loadArtifact(ref).catch(() => artifact?.artifact_json ?? ref.data ?? ref.payload ?? null);

  return {
    ...ref,
    artifact_id: artifactId,
    type: ref.type || ref.artifact_type || artifact?.artifact_type || 'artifact_ref',
    artifact_type: ref.artifact_type || ref.type || artifact?.artifact_type || 'artifact_ref',
    label: ref.label || ref.artifact_type || ref.type || artifact?.artifact_type || `Artifact ${String(artifactId).slice(0, 8)}`,
    data,
  };
}

/**
 * Enrich runs (step rows) with full artifact data.
 */
export async function enrichRunsWithArtifacts(runs = []) {
  return Promise.all((runs || []).map(async (run) => ({
    ...run,
    artifact_refs: (await Promise.all(
      (Array.isArray(run?.artifact_refs) ? run.artifact_refs : []).map(enrichRunArtifactRef),
    )).filter(Boolean),
  })));
}

/**
 * Synthesize a loop_state shape from step runs for backward compatibility.
 * New tasks store steps as separate ai_employee_runs rows; this recreates
 * the old loop_state.steps[] shape that some UI code still reads.
 */
function synthesizeLoopStateFromRuns(existingLoopState, runs = []) {
  if (existingLoopState?.steps?.length) return existingLoopState;

  const stepRuns = (runs || [])
    .filter((run) => run?.step_index != null)
    .sort((a, b) => (a.step_index ?? 0) - (b.step_index ?? 0));

  if (stepRuns.length === 0) return existingLoopState || null;

  return {
    steps: stepRuns.map((run) => ({
      index: run.step_index,
      name: run.step_name || `step_${run.step_index}`,
      workflow_type: run.tool_type || null,
      status: run.status || 'pending',
      artifact_refs: run.artifact_refs || [],
      retry_count: run.retry_count || 0,
      error: run.error_message || null,
      summary: run.summary || null,
      started_at: run.started_at || null,
      finished_at: run.ended_at || null,
    })),
  };
}
