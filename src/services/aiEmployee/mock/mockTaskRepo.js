/**
 * mockTaskRepo.js — In-memory mock for taskRepo.js.
 * Used when VITE_DI_MOCK_MODE=true. Zero external dependencies.
 */

import { TASK_STATES } from '../taskStateMachine.js';

const tasks = new Map();

function now() { return new Date().toISOString(); }

export async function createTask({
  employeeId, title, description, priority = 'medium',
  sourceType = 'question_to_task', assignedByUserId,
  inputContext = {}, planSnapshot = null, dueAt = null,
}) {
  const id = crypto.randomUUID();
  const ts = now();
  const task = {
    id,
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
    loop_state: null,
    template_id: inputContext?.template_id || null,
    latest_run_id: null,
    version: 1,
    created_at: ts,
    updated_at: ts,
  };
  tasks.set(id, task);
  console.info('[MockTaskRepo] createTask', id, title);
  return { ...task };
}

export async function updateTaskStatus(taskId, newStatus, expectedVersion, extraFields = {}) {
  const task = tasks.get(taskId);
  if (!task) throw new Error(`[MockTaskRepo] task '${taskId}' not found`);
  if (task.version !== expectedVersion) {
    throw new Error(`[MockTaskRepo] Concurrent modification on task ${taskId}. Expected version ${expectedVersion}, got ${task.version}.`);
  }
  task.status = newStatus;
  task.version = expectedVersion + 1;
  task.updated_at = now();
  Object.assign(task, extraFields);
  return { ...task };
}

export async function getTask(taskId, { lite = false } = {}) {
  const task = tasks.get(taskId);
  if (!task) throw new Error(`[MockTaskRepo] task '${taskId}' not found`);
  return { ...task };
}

export async function savePlanSnapshot(taskId, planSnapshot, expectedVersion) {
  return updateTaskStatus(taskId, TASK_STATES.WAITING_APPROVAL, expectedVersion, {
    plan_snapshot: planSnapshot,
  });
}

export async function setLatestRunId(taskId, runId) {
  const task = tasks.get(taskId);
  if (!task) throw new Error(`[MockTaskRepo] task '${taskId}' not found`);
  task.latest_run_id = runId;
}

export async function listTasks(employeeId, { status, limit = 50 } = {}) {
  let result = [...tasks.values()].filter(t => t.employee_id === employeeId);
  if (status) result = result.filter(t => t.status === status);
  return result
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit)
    .map(t => ({ ...t }));
}

export async function listTasksByUser(userId, { status, limit = 100 } = {}) {
  // In mock mode all tasks belong to the mock user
  let result = [...tasks.values()];
  if (status) result = result.filter(t => t.status === status);
  return result
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit)
    .map(t => ({ ...t }));
}

export async function listPendingReviews(userId) {
  return [...tasks.values()]
    .filter(t => t.status === TASK_STATES.REVIEW_HOLD)
    .map(t => ({ ...t, ai_employee_runs: [] }));
}

export async function updateTaskInputContext(taskId, inputContext, expectedVersion) {
  const task = tasks.get(taskId);
  if (!task) throw new Error(`[MockTaskRepo] task '${taskId}' not found`);
  if (task.version !== expectedVersion) {
    throw new Error(`[MockTaskRepo] Concurrent modification on task ${taskId}.`);
  }
  task.input_context = inputContext;
  task.version = expectedVersion + 1;
  task.updated_at = now();
  return { ...task };
}

export async function reassignTask(taskId, newEmployeeId, userId, expectedVersion) {
  const task = tasks.get(taskId);
  if (!task) throw new Error(`[MockTaskRepo] task '${taskId}' not found`);
  if (task.version !== expectedVersion) {
    throw new Error(`[MockTaskRepo] Concurrent modification on task ${taskId}.`);
  }
  const reassignable = [TASK_STATES.DRAFT_PLAN, TASK_STATES.WAITING_APPROVAL];
  if (!reassignable.includes(task.status)) {
    throw new Error(`[MockTaskRepo] task '${taskId}' not in reassignable state`);
  }
  task.employee_id = newEmployeeId;
  task.version = expectedVersion + 1;
  task.updated_at = now();
  return { ...task };
}

export async function listTasksByStatus(employeeId, statuses, { limit = 50 } = {}) {
  return [...tasks.values()]
    .filter(t => t.employee_id === employeeId && statuses.includes(t.status))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit)
    .map(t => ({ ...t }));
}
