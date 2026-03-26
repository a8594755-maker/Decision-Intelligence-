/**
 * taskRepo.js — Supabase CRUD for ai_employee_tasks.
 *
 * NO localStorage fallback. If Supabase fails, error propagates.
 * Uses optimistic concurrency via `version` column.
 *
 * When VITE_DI_MOCK_MODE=true, all functions delegate to in-memory mock.
 */

import { supabase } from '../../infra/supabaseClient.js';
import { TASK_STATES } from '../taskStateMachine.js';

const _MOCK = import.meta.env?.VITE_DI_MOCK_MODE === 'true';
const _m = _MOCK ? await import('../mock/mockTaskRepo.js') : null;

/**
 * Create a new task in draft_plan state.
 * @returns {Promise<object>} created task row
 */
export async function createTask({
  employeeId, title, description, priority = 'medium',
  sourceType = 'question_to_task', assignedByUserId,
  inputContext = {}, planSnapshot = null, dueAt = null,
}) {
  if (_m) return _m.createTask({ employeeId, title, description, priority, sourceType, assignedByUserId, inputContext, planSnapshot, dueAt });
  const { data, error } = await supabase
    .from('ai_employee_tasks')
    .insert({
      employee_id: employeeId,
      title,
      description,
      priority,
      status: TASK_STATES.DRAFT_PLAN,
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
  if (_m) return _m.updateTaskStatus(taskId, newStatus, expectedVersion, extraFields);
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
const TASK_POLL_COLUMNS = 'id, status, loop_state, plan_snapshot, employee_id, title, priority, created_at, updated_at, template_id, input_context, due_at';

export async function getTask(taskId, { lite = false } = {}) {
  if (_m) return _m.getTask(taskId, { lite });
  const { data, error } = await supabase
    .from('ai_employee_tasks')
    .select(lite ? TASK_POLL_COLUMNS : '*')
    .eq('id', taskId)
    .single();

  if (error) throw new Error(`[TaskRepo] getTask failed: ${error.message}`);
  return data;
}

/**
 * Save the approved plan snapshot.
 */
export async function savePlanSnapshot(taskId, planSnapshot, expectedVersion) {
  if (_m) return _m.savePlanSnapshot(taskId, planSnapshot, expectedVersion);
  return updateTaskStatus(taskId, TASK_STATES.WAITING_APPROVAL, expectedVersion, {
    plan_snapshot: planSnapshot,
  });
}

/**
 * Update the latest_run_id forward reference.
 */
export async function setLatestRunId(taskId, runId) {
  if (_m) return _m.setLatestRunId(taskId, runId);
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
  if (_m) return _m.listTasks(employeeId, { status, limit });
  let query = supabase
    .from('ai_employee_tasks')
    .select('*')
    .eq('employee_id', employeeId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) {
    if (error.name === 'AbortError' || /abort/i.test(error.message)) return [];
    throw new Error(`[TaskRepo] listTasks failed: ${error.message}`);
  }
  return data || [];
}

/**
 * List tasks across ALL employees belonging to a user.
 * Replaces aiEmployeeService.listTasksByUser().
 */
export async function listTasksByUser(userId, { status, limit = 100 } = {}) {
  if (_m) return _m.listTasksByUser(userId, { status, limit });
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
  if (_m) return _m.listPendingReviews(userId);
  // Step 1: resolve all employee IDs for this user
  const { data: emps, error: empErr } = await supabase
    .from('ai_employees')
    .select('id')
    .eq('manager_user_id', userId);
  if (empErr) throw new Error(`[TaskRepo] listPendingReviews employee lookup failed: ${empErr.message}`);

  const empIds = (emps || []).map((e) => e.id);
  if (empIds.length === 0) return [];

  // Step 2: fetch review_hold tasks with step runs joined
  const { data, error } = await supabase
    .from('ai_employee_tasks')
    .select(`
      *,
      ai_employee_runs!ai_employee_runs_task_id_fkey(id, status, summary, artifact_refs, ended_at, started_at, step_index, step_name, retry_count, error_message)
    `)
    .eq('status', TASK_STATES.REVIEW_HOLD)
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
  if (_m) return _m.updateTaskInputContext(taskId, inputContext, expectedVersion);
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
 * Reassign a task to a different worker (manual assignment by manager).
 * Only tasks in draft_plan or waiting_approval can be reassigned.
 *
 * @param {string} taskId
 * @param {string} newEmployeeId - Target worker ID
 * @param {string} userId - Manager user ID (must own BOTH source and target workers)
 * @param {number} expectedVersion - Optimistic concurrency version
 * @returns {Promise<object>} Updated task row
 */
export async function reassignTask(taskId, newEmployeeId, userId, expectedVersion) {
  if (_m) return _m.reassignTask(taskId, newEmployeeId, userId, expectedVersion);
  // Verify manager owns the target worker
  const { data: targetEmp, error: empErr } = await supabase
    .from('ai_employees')
    .select('id, manager_user_id')
    .eq('id', newEmployeeId)
    .single();

  if (empErr || !targetEmp) {
    throw new Error(`[TaskRepo] reassignTask: target worker '${newEmployeeId}' not found`);
  }
  if (targetEmp.manager_user_id !== userId) {
    throw new Error(`[TaskRepo] reassignTask denied: user '${userId}' is not the manager of target worker '${newEmployeeId}'`);
  }

  // Only reassign tasks that haven't started execution
  const reassignableStatuses = [TASK_STATES.DRAFT_PLAN, TASK_STATES.WAITING_APPROVAL];
  const { data, error } = await supabase
    .from('ai_employee_tasks')
    .update({
      employee_id: newEmployeeId,
      version: expectedVersion + 1,
    })
    .eq('id', taskId)
    .eq('version', expectedVersion)
    .in('status', reassignableStatuses)
    .select()
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      throw new Error(`[TaskRepo] reassignTask: task '${taskId}' not found, version mismatch, or task is not in a reassignable state (${reassignableStatuses.join(', ')})`);
    }
    throw new Error(`[TaskRepo] reassignTask failed: ${error.message}`);
  }
  return data;
}

// ── Worker Claim API (server-side task execution) ─────────────────────────────

const STALE_HEARTBEAT_MS = 60_000; // 60s — if heartbeat older than this, task is reclaimable

/**
 * Find tasks that are ready for a worker to claim:
 * - status is 'queued' or 'in_progress'
 * - no worker_id set, OR worker heartbeat is stale (crashed worker)
 */
export async function findUnclaimedTasks({ limit = 10 } = {}) {
  if (_m) return [];
  const staleThreshold = new Date(Date.now() - STALE_HEARTBEAT_MS).toISOString();

  // Unclaimed tasks
  const { data: unclaimed, error: err1 } = await supabase
    .from('ai_employee_tasks')
    .select('id, status, version, worker_id, worker_heartbeat_at')
    .in('status', [TASK_STATES.QUEUED, TASK_STATES.IN_PROGRESS])
    .is('worker_id', null)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (err1) throw new Error(`[TaskRepo] findUnclaimedTasks failed: ${err1.message}`);

  // Stale-heartbeat tasks (worker crashed)
  const { data: stale, error: err2 } = await supabase
    .from('ai_employee_tasks')
    .select('id, status, version, worker_id, worker_heartbeat_at')
    .eq('status', TASK_STATES.IN_PROGRESS)
    .not('worker_id', 'is', null)
    .lt('worker_heartbeat_at', staleThreshold)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (err2) throw new Error(`[TaskRepo] findUnclaimedTasks (stale) failed: ${err2.message}`);

  return [...(unclaimed || []), ...(stale || [])];
}

/**
 * Claim a task for a worker using optimistic concurrency.
 * @param {string} taskId
 * @param {string} workerId - unique worker instance ID
 * @param {number} expectedVersion
 * @returns {Promise<object|null>} updated row, or null if claim failed (race)
 */
export async function claimTask(taskId, workerId, expectedVersion) {
  if (_m) return null;
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('ai_employee_tasks')
    .update({
      worker_id: workerId,
      worker_claimed_at: now,
      worker_heartbeat_at: now,
      version: expectedVersion + 1,
    })
    .eq('id', taskId)
    .eq('version', expectedVersion)
    .select()
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null; // lost the race
    throw new Error(`[TaskRepo] claimTask failed: ${error.message}`);
  }
  return data;
}

/**
 * Release a worker claim (on completion or failure).
 */
export async function releaseTask(taskId) {
  if (_m) return;
  const { error } = await supabase
    .from('ai_employee_tasks')
    .update({
      worker_id: null,
      worker_claimed_at: null,
      worker_heartbeat_at: null,
    })
    .eq('id', taskId);

  if (error) console.warn(`[TaskRepo] releaseTask failed: ${error.message}`);
}

/**
 * Update worker heartbeat timestamp (called periodically during execution).
 */
export async function updateWorkerHeartbeat(taskId) {
  if (_m) return;
  const { error } = await supabase
    .from('ai_employee_tasks')
    .update({ worker_heartbeat_at: new Date().toISOString() })
    .eq('id', taskId);

  if (error) console.warn(`[TaskRepo] updateWorkerHeartbeat failed: ${error.message}`);
}

/**
 * List tasks filtered by multiple statuses for an employee.
 */
export async function listTasksByStatus(employeeId, statuses, { limit = 50 } = {}) {
  if (_m) return _m.listTasksByStatus(employeeId, statuses, { limit });
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
