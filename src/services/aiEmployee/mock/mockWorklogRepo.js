/**
 * mockWorklogRepo.js — In-memory mock for worklogRepo.js.
 * Used when VITE_DI_MOCK_MODE=true.
 */

const worklogs = [];

export async function appendWorklog(employeeId, taskId, runId, logType, content) {
  const entry = {
    id: crypto.randomUUID(),
    employee_id: employeeId,
    task_id: taskId,
    run_id: runId,
    log_type: logType,
    content,
    created_at: new Date().toISOString(),
  };
  worklogs.push(entry);
  return entry;
}

export async function listWorklogs(employeeId, { limit = 50, taskId, userId } = {}) {
  let result = [...worklogs];
  if (taskId) result = result.filter(w => w.task_id === taskId);
  else if (employeeId) result = result.filter(w => w.employee_id === employeeId);
  return result
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit);
}
