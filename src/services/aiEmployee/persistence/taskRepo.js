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

/**
 * List tasks across ALL employees belonging to a user.
 * Replaces aiEmployeeService.listTasksByUser().
 */
export async function listTasksByUser(userId, { status, limit = 100 } = {}) {
  // Step 1: resolve all employee IDs for this user
  const { data: emps, error: empErr } = await supabase
    .from('ai_employees')
    .select('id')
    .eq('manager_user_id', userId);
  if (empErr) throw new Error(`[TaskRepo] listTasksByUser employee lookup failed: ${empErr.message}`);

  const empIds = (emps || []).map((e) => e.id);
  if (empIds.length === 0) return [];

  // Step 2: fetch tasks for those employees
  let query = supabase
    .from('ai_employee_tasks')
    .select('*')
    .in('employee_id', empIds)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) throw new Error(`[TaskRepo] listTasksByUser failed: ${error.message}`);
  return data || [];
}

/**
 * List tasks in review status for any employee managed by userId.
 * Joins runs (steps) for the review UI.
 * Replaces aiEmployeeService.listPendingReviews().
 */
export async function listPendingReviews(userId) {
  // Step 1: resolve all employee IDs for this user
  const { data: emps, error: empErr } = await supabase
    .from('ai_employees')
    .select('id')
    .eq('manager_user_id', userId);
  if (empErr) throw new Error(`[TaskRepo] listPendingReviews employee lookup failed: ${empErr.message}`);

  const empIds = (emps || []).map((e) => e.id);
  if (empIds.length === 0) return [];

  // Step 2: fetch waiting_review / review_hold tasks with step runs joined
  const { data, error } = await supabase
    .from('ai_employee_tasks')
    .select(`
      *,
      ai_employee_runs!ai_employee_runs_task_id_fkey(id, status, summary, artifact_refs, ended_at, started_at, step_index, step_name, retry_count, error_message)
    `)
    .in('status', ['waiting_review', 'review_hold'])
    .in('employee_id', empIds)
    .order('updated_at', { ascending: false });

  if (error) throw new Error(`[TaskRepo] listPendingReviews failed: ${error.message}`);
  return data || [];
}

/**
 * Update task's input_context (e.g. to attach a dataset after creation).
 * Uses optimistic concurrency.
 */
export async function updateTaskInputContext(taskId, inputContext, expectedVersion) {
  const { data, error } = await supabase
    .from('ai_employee_tasks')
    .update({
      input_context: inputContext,
      version: expectedVersion + 1,
    })
    .eq('id', taskId)
    .eq('version', expectedVersion)
    .select()
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      throw new Error(`[TaskRepo] Concurrent modification on task ${taskId}. Expected version ${expectedVersion}.`);
    }
    throw new Error(`[TaskRepo] updateTaskInputContext failed: ${error.message}`);
  }
  return data;
}

/**
 * List tasks filtered by multiple statuses for an employee.
 */
export async function listTasksByStatus(employeeId, statuses, { limit = 50 } = {}) {
  const { data, error } = await supabase
    .from('ai_employee_tasks')
    .select('*')
    .eq('employee_id', employeeId)
    .in('status', statuses)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`[TaskRepo] listTasksByStatus failed: ${error.message}`);
  return data || [];
}
