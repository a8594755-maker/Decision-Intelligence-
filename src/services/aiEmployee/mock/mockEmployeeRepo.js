/**
 * mockEmployeeRepo.js — In-memory mock for employeeRepo.js.
 * Used when VITE_DI_MOCK_MODE=true. Provides a hardcoded worker.
 */

import { EMPLOYEE_STATES, EMPLOYEE_STATE_TO_DB, DB_TO_EMPLOYEE_STATE } from '../employeeStateMachine.js';

const DEFAULT_PERMISSIONS = {
  can_run_forecast: true, can_run_plan: true, can_run_risk: true,
  can_run_builtin_tool: true, can_run_dynamic_tool: true,
  can_run_registered_tool: true, can_generate_report: true,
  can_export: true, can_write_worklog: true, can_submit_review: true,
  can_run_python_tool: true, can_drive_excel: true,
};

const employees = new Map();

function makeWorker(id, userId, overrides = {}) {
  const ts = new Date().toISOString();
  return {
    id,
    name: overrides.name || 'Dev Analyst',
    role: overrides.role || 'data_analyst',
    status: 'idle',
    manager_user_id: userId,
    description: overrides.description || 'Mock worker for local development',
    permissions: { ...DEFAULT_PERMISSIONS },
    autonomy_level: 'A2',
    archived_at: null,
    created_at: ts,
    updated_at: ts,
    _logicalState: EMPLOYEE_STATES.IDLE,
    ...overrides,
  };
}

export async function updateEmployeeStatus(employeeId, logicalState) {
  const dbStatus = EMPLOYEE_STATE_TO_DB[logicalState];
  if (!dbStatus) throw new Error(`[MockEmployeeRepo] Unknown logical state: '${logicalState}'`);
  const emp = employees.get(employeeId);
  if (emp) {
    emp.status = dbStatus;
    emp._logicalState = logicalState;
  }
}

export async function getEmployee(employeeId) {
  const emp = employees.get(employeeId);
  if (!emp) throw new Error(`[MockEmployeeRepo] employee '${employeeId}' not found`);
  return { ...emp, _logicalState: DB_TO_EMPLOYEE_STATE[emp.status] || emp.status };
}

export async function getEmployeeByManager(userId) {
  for (const emp of employees.values()) {
    if (emp.manager_user_id === userId) {
      return { ...emp, _logicalState: DB_TO_EMPLOYEE_STATE[emp.status] || emp.status };
    }
  }
  return null;
}

export async function listEmployeesByManager(userId, { includeArchived = false } = {}) {
  let result = [...employees.values()].filter(e => e.manager_user_id === userId);
  if (!includeArchived) result = result.filter(e => !e.archived_at);
  // Auto-create a default worker if none exist
  if (result.length === 0) {
    const w = makeWorker('mock-worker-001', userId);
    employees.set(w.id, w);
    result = [w];
    console.info('[MockEmployeeRepo] Auto-created default worker:', w.id);
  }
  return result.map(e => ({
    ...e,
    _logicalState: DB_TO_EMPLOYEE_STATE[e.status] || e.status,
  }));
}

export async function getOrCreateWorker(userId, templateId = 'data_analyst') {
  // Check if one already exists
  for (const emp of employees.values()) {
    if (emp.manager_user_id === userId) {
      return { ...emp, _logicalState: DB_TO_EMPLOYEE_STATE[emp.status] || emp.status };
    }
  }
  const id = 'mock-worker-001';
  const w = makeWorker(id, userId);
  employees.set(id, w);
  console.info('[MockEmployeeRepo] Created worker:', id);
  return { ...w };
}

export async function createWorkerFromTemplate(userId, templateId, overrides = {}) {
  const id = crypto.randomUUID();
  const w = makeWorker(id, userId, overrides);
  employees.set(id, w);
  return { ...w };
}

export async function cloneWorker(sourceEmployeeId, userId, overrides = {}) {
  const source = await getEmployee(sourceEmployeeId);
  const id = crypto.randomUUID();
  const w = makeWorker(id, userId, { ...source, ...overrides, name: overrides.name || `${source.name} (copy)` });
  employees.set(id, w);
  return { ...w };
}

export async function archiveWorker(employeeId, userId) {
  const emp = employees.get(employeeId);
  if (emp) emp.archived_at = new Date().toISOString();
}

export const deleteWorker = archiveWorker;

export async function updateWorker(employeeId, updates, userId) {
  const emp = employees.get(employeeId);
  if (!emp) throw new Error(`[MockEmployeeRepo] employee '${employeeId}' not found`);
  if (updates.name) emp.name = updates.name;
  if (updates.description) emp.description = updates.description;
  if (updates.permissions) emp.permissions = updates.permissions;
  emp.updated_at = new Date().toISOString();
  return { ...emp, _logicalState: DB_TO_EMPLOYEE_STATE[emp.status] || emp.status };
}

export async function getKpis(employeeId) { return null; }

export async function listTemplates() {
  return [
    { id: 'data_analyst', name: 'Data Analyst', role: 'data_analyst', icon: 'bar-chart', description: 'Data analysis worker', capabilities: ['forecast', 'plan', 'risk', 'report'] },
    { id: 'supply_chain_analyst', name: 'Supply Chain Analyst', role: 'supply_chain_analyst', icon: 'file-text', description: 'Supply chain analysis worker', capabilities: ['forecast', 'plan', 'risk', 'report'] },
  ];
}

export async function getWorkerTemplateFromDB(templateId) { return null; }
export async function listTemplatesFromDB() { return []; }

export { DEFAULT_PERMISSIONS as WORKER_TEMPLATES };
