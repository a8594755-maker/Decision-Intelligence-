/**
 * stepRepo.js — Supabase CRUD for agent loop steps (ai_employee_runs with step_index).
 *
 * Steps are stored as rows in ai_employee_runs with step_index != null.
 * Each step is one run row tied to the task.
 *
 * When VITE_DI_MOCK_MODE=true, all functions delegate to in-memory mock.
 */

import { supabase } from '../../supabaseClient.js';
import { STEP_STATES } from '../stepStateMachine.js';

const _MOCK = import.meta.env?.VITE_DI_MOCK_MODE === 'true';
const _m = _MOCK ? await import('../mock/mockStepRepo.js') : null;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Known DB columns for ai_employee_runs — prevents Supabase errors from unknown fields
const KNOWN_COLUMNS = new Set([
  'status', 'di_run_id', 'artifact_refs', 'summary', 'error_message',
  'started_at', 'ended_at', 'step_index', 'step_name',
  'retry_count', 'max_retries', '_revision_instructions',
]);

function extractArtifactId(candidate) {
  if (!candidate) return null;

  if (typeof candidate === 'string') {
    return UUID_PATTERN.test(candidate) ? candidate : null;
  }

  if (typeof candidate !== 'object') return null;

  const directId = candidate.artifact_id || candidate.id || null;
  if (typeof directId === 'string' && UUID_PATTERN.test(directId)) {
    return directId;
  }

  const nestedRef = candidate.output_ref || candidate.input_ref || candidate.ref || null;
  if (nestedRef && typeof nestedRef === 'object') {
    const nestedId = nestedRef.artifact_id || nestedRef.id || null;
    if (typeof nestedId === 'string' && UUID_PATTERN.test(nestedId)) {
      return nestedId;
    }
  }

  return null;
}

export function normalizeArtifactRefsForStorage(artifactRefs) {
  const input = Array.isArray(artifactRefs)
    ? artifactRefs
    : artifactRefs && typeof artifactRefs === 'object'
    ? Object.values(artifactRefs).flat()
    : [];

  return Array.from(
    new Set(
      input
        .map(extractArtifactId)
        .filter(Boolean)
    )
  );
}

/**
 * Create step rows for a task (one ai_employee_runs row per step).
 * @param {string} taskId
 * @param {string} employeeId
 * @param {Array<{name: string, tool_hint: string}>} steps
 * @returns {Promise<object[]>} created step rows
 */
export async function createSteps(taskId, employeeId, steps) {
  if (_m) return _m.createSteps(taskId, employeeId, steps);
  const rows = steps.map((step, index) => ({
    task_id: taskId,
    employee_id: employeeId,
    step_index: index,
    step_name: step.name,
    status: STEP_STATES.PENDING,
    retry_count: 0,
    max_retries: step.max_retries ?? 3,
  }));

  const { data, error } = await supabase
    .from('ai_employee_runs')
    .insert(rows)
    .select();

  if (error) throw new Error(`[StepRepo] createSteps failed: ${error.message}`);
  if (!data || data.length === 0) {
    throw new Error(`[StepRepo] createSteps: INSERT returned 0 rows (expected ${rows.length}). Possible RLS policy blocking the insert.`);
  }
  if (data.length !== rows.length) {
    console.warn(`[StepRepo] createSteps: expected ${rows.length} rows but got ${data.length}. Some inserts may have been blocked by RLS.`);
  }
  return data;
}

/**
 * Update a step's status and optionally its result data.
 */
export async function updateStep(stepId, updates) {
  if (_m) return _m.updateStep(stepId, updates);
  // Strip unknown columns to prevent Supabase schema-cache errors
  const filtered = {};
  for (const [key, value] of Object.entries(updates || {})) {
    if (KNOWN_COLUMNS.has(key)) filtered[key] = value;
  }

  const patch = {
    ...filtered,
    ...(Object.prototype.hasOwnProperty.call(updates || {}, 'artifact_refs')
      ? { artifact_refs: normalizeArtifactRefsForStorage(updates.artifact_refs) }
      : {}),
  };

  const { data, error } = await supabase
    .from('ai_employee_runs')
    .update(patch)
    .eq('id', stepId)
    .select()
    .single();

  if (error) throw new Error(`[StepRepo] updateStep failed: ${error.message}`);
  return data;
}

/**
 * Get all steps for a task, ordered by step_index.
 */
const STEP_POLL_COLUMNS = 'id, task_id, step_index, step_name, tool_type, status, retry_count, error_message, created_at, updated_at';

export async function getSteps(taskId, { lite = false } = {}) {
  if (_m) return _m.getSteps(taskId, { lite });
  const { data, error } = await supabase
    .from('ai_employee_runs')
    .select(lite ? STEP_POLL_COLUMNS : '*')
    .eq('task_id', taskId)
    .not('step_index', 'is', null)
    .order('step_index', { ascending: true });

  if (error) throw new Error(`[StepRepo] getSteps failed: ${error.message}`);
  return data || [];
}

/**
 * Get the next pending step for a task.
 * @returns {Promise<object|null>} next step or null if all done/failed
 */
export async function getNextPendingStep(taskId) {
  if (_m) return _m.getNextPendingStep(taskId);
  const { data, error } = await supabase
    .from('ai_employee_runs')
    .select('*')
    .eq('task_id', taskId)
    .in('status', [STEP_STATES.PENDING, STEP_STATES.RETRYING])
    .not('step_index', 'is', null)
    .order('step_index', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`[StepRepo] getNextPendingStep failed: ${error.message}`);
  return data;
}

/**
 * Increment retry count and set status to 'retrying'.
 */
export async function markStepRetrying(stepId, currentRetryCount) {
  if (_m) return _m.markStepRetrying(stepId, currentRetryCount);
  return updateStep(stepId, {
    status: STEP_STATES.RETRYING,
    retry_count: currentRetryCount + 1,
  });
}

/**
 * Mark a step as succeeded with artifacts.
 */
export async function markStepSucceeded(stepId, { summary, artifactRefs = [] } = {}) {
  if (_m) return _m.markStepSucceeded(stepId, { summary, artifactRefs });
  return updateStep(stepId, {
    status: STEP_STATES.SUCCEEDED,
    summary,
    artifact_refs: artifactRefs,
    ended_at: new Date().toISOString(),
  });
}

/**
 * Mark a step as failed with error message.
 */
export async function markStepFailed(stepId, errorMessage) {
  if (_m) return _m.markStepFailed(stepId, errorMessage);
  return updateStep(stepId, {
    status: STEP_STATES.FAILED,
    error_message: errorMessage,
    ended_at: new Date().toISOString(),
  });
}
