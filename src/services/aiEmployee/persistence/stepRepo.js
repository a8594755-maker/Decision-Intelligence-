/**
 * stepRepo.js — Supabase CRUD for agent loop steps (ai_employee_runs with step_index).
 *
 * Steps are stored as rows in ai_employee_runs with step_index != null.
 * Each step is one run row tied to the task.
 */

import { supabase } from '../../supabaseClient.js';

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
  const { data, error } = await supabase
    .from('ai_employee_runs')
    .update(updates)
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
