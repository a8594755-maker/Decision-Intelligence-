/**
 * stepRepo.js — Supabase CRUD for agent loop steps (ai_employee_runs with step_index).
 *
 * Steps are stored as rows in ai_employee_runs with step_index != null.
 * Each step is one run row tied to the task.
 */

import { supabase } from '../../supabaseClient.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  const rows = steps.map((step, index) => ({
    task_id: taskId,
    employee_id: employeeId,
    step_index: index,
    step_name: step.name,
    status: 'pending',
    retry_count: 0,
    max_retries: step.max_retries ?? 3,
  }));

  const { data, error } = await supabase
    .from('ai_employee_runs')
    .insert(rows)
    .select();

  if (error) throw new Error(`[StepRepo] createSteps failed: ${error.message}`);
  return data;
}

/**
 * Update a step's status and optionally its result data.
 */
export async function updateStep(stepId, updates) {
  const patch = {
    ...updates,
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
export async function getSteps(taskId) {
  const { data, error } = await supabase
    .from('ai_employee_runs')
    .select('*')
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
  const { data, error } = await supabase
    .from('ai_employee_runs')
    .select('*')
    .eq('task_id', taskId)
    .in('status', ['pending', 'retrying'])
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
  return updateStep(stepId, {
    status: 'retrying',
    retry_count: currentRetryCount + 1,
  });
}

/**
 * Mark a step as succeeded with artifacts.
 */
export async function markStepSucceeded(stepId, { summary, artifactRefs = [] } = {}) {
  return updateStep(stepId, {
    status: 'succeeded',
    summary,
    artifact_refs: artifactRefs,
    ended_at: new Date().toISOString(),
  });
}

/**
 * Mark a step as failed with error message.
 */
export async function markStepFailed(stepId, errorMessage) {
  return updateStep(stepId, {
    status: 'failed',
    error_message: errorMessage,
    ended_at: new Date().toISOString(),
  });
}
