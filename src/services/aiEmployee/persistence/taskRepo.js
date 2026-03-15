/**
 * taskRepo.js — Supabase CRUD for ai_employee_tasks.
 *
 * NO localStorage fallback. If Supabase fails, error propagates.
 * Uses optimistic concurrency via `version` column.
 */

import { supabase } from '../../supabaseClient.js';

/**
 * Create a new task in draft_plan state.
 * @returns {Promise<object>} created task row
 */
export async function createTask({
  employeeId, title, description, priority = 'medium',
  sourceType = 'question_to_task', assignedByUserId,
  inputContext = {}, planSnapshot = null, dueAt = null,
}) {
  const { data, error } = await supabase
    .from('ai_employee_tasks')
    .insert({
      employee_id: employeeId,
      title,
      description,
      priority,
      status: 'draft_plan',
      source_type: sourceType,
      assigned_by_user_id: assignedByUserId,
      due_at: dueAt,
      input_context: inputContext,
      plan_snapshot: planSnapshot,
      version: 1,
    })
    .select()
    .single();

  if (error) throw new Error(`[TaskRepo] createTask failed: ${error.message}`);
  return data;
}

/**
 * Update task status with optimistic concurrency.
 * @param {string} taskId
 * @param {string} newStatus
 * @param {number} expectedVersion - must match current version
 * @param {object} [extraFields] - additional columns to update
 * @returns {Promise<object>} updated task row
 * @throws if version mismatch (concurrent modification)
 */
export async function updateTaskStatus(taskId, newStatus, expectedVersion, extraFields = {}) {
  const { data, error } = await supabase
    .from('ai_employee_tasks')
    .update({
      status: newStatus,
      version: expectedVersion + 1,
      ...extraFields,
    })
    .eq('id', taskId)
    .eq('version', expectedVersion)
    .select()
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      throw new Error(`[TaskRepo] Concurrent modification on task ${taskId}. Expected version ${expectedVersion}.`);
    }
    throw new Error(`[TaskRepo] updateTaskStatus failed: ${error.message}`);
  }
  return data;
}

/**
 * Get task by ID.
 */
export async function getTask(taskId) {
  const { data, error } = await supabase
    .from('ai_employee_tasks')
    .select('*')
    .eq('id', taskId)
    .single();

  if (error) throw new Error(`[TaskRepo] getTask failed: ${error.message}`);
  return data;
}

/**
 * Save the approved plan snapshot.
 */
export async function savePlanSnapshot(taskId, planSnapshot, expectedVersion) {
  return updateTaskStatus(taskId, 'waiting_approval', expectedVersion, {
    plan_snapshot: planSnapshot,
  });
}

/**
 * Update the latest_run_id forward reference.
 */
export async function setLatestRunId(taskId, runId) {
  const { error } = await supabase
    .from('ai_employee_tasks')
    .update({ latest_run_id: runId })
    .eq('id', taskId);

  if (error) throw new Error(`[TaskRepo] setLatestRunId failed: ${error.message}`);
}

/**
 * List tasks for an employee, optionally filtered by status.
 */
export async function listTasks(employeeId, { status, limit = 50 } = {}) {
  let query = supabase
    .from('ai_employee_tasks')
    .select('*')
    .eq('employee_id', employeeId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) throw new Error(`[TaskRepo] listTasks failed: ${error.message}`);
  return data || [];
}
