/**
 * employeeRepo.js — Supabase CRUD for ai_employees.
 *
 * Manages employee status. Maps logical states to DB values
 * via EMPLOYEE_STATE_TO_DB for backward compatibility.
 */

import { supabase } from '../../supabaseClient.js';
import { EMPLOYEE_STATE_TO_DB, DB_TO_EMPLOYEE_STATE } from '../employeeStateMachine.js';

/**
 * Update employee status using logical state names.
 * @param {string} employeeId
 * @param {string} logicalState - one of EMPLOYEE_STATES values
 */
export async function updateEmployeeStatus(employeeId, logicalState) {
  const dbStatus = EMPLOYEE_STATE_TO_DB[logicalState];
  if (!dbStatus) {
    throw new Error(`[EmployeeRepo] Unknown logical state: '${logicalState}'`);
  }

  const { error } = await supabase
    .from('ai_employees')
    .update({ status: dbStatus })
    .eq('id', employeeId);

  if (error) throw new Error(`[EmployeeRepo] updateStatus failed: ${error.message}`);
}

/**
 * Get employee by ID, returns with logical state.
 */
export async function getEmployee(employeeId) {
  const { data, error } = await supabase
    .from('ai_employees')
    .select('*')
    .eq('id', employeeId)
    .single();

  if (error) throw new Error(`[EmployeeRepo] getEmployee failed: ${error.message}`);

  // Attach logical state
  data._logicalState = DB_TO_EMPLOYEE_STATE[data.status] || data.status;
  return data;
}

/**
 * Get employee by manager user ID (for Aiden lookup).
 */
export async function getEmployeeByManager(userId) {
  const { data, error } = await supabase
    .from('ai_employees')
    .select('*')
    .eq('manager_user_id', userId)
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`[EmployeeRepo] getEmployeeByManager failed: ${error.message}`);
  if (data) data._logicalState = DB_TO_EMPLOYEE_STATE[data.status] || data.status;
  return data;
}

/**
 * List all employees for a manager user.
 */
export async function listEmployeesByManager(userId) {
  const { data, error } = await supabase
    .from('ai_employees')
    .select('*')
    .eq('manager_user_id', userId)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`[EmployeeRepo] listEmployeesByManager failed: ${error.message}`);
  return (data || []).map((emp) => ({
    ...emp,
    _logicalState: DB_TO_EMPLOYEE_STATE[emp.status] || emp.status,
  }));
}

// ── Default permissions for all worker types ──
const DEFAULT_PERMISSIONS = {
  can_run_forecast: true, can_run_plan: true, can_run_risk: true,
  can_run_builtin_tool: true, can_run_dynamic_tool: true,
  can_run_registered_tool: true, can_generate_report: true,
  can_export: true, can_write_worklog: true, can_submit_review: true,
  can_run_python_tool: true,
  can_sync_opencloud: true, can_import_opencloud: true,
  can_search_opencloud: true, can_distribute_opencloud: true, can_watch_opencloud: true,
  can_drive_excel: true,
};

// ── Built-in worker templates ──
const WORKER_TEMPLATES = {
  analytics_worker: {
    id: 'analytics_worker',
    name: 'Aiden',
    role: 'analytics_worker',
    icon: 'bar-chart',
    description: 'AI analytics worker. Runs forecasts, replenishment plans, risk assessments, and business reports on demand.',
    capabilities: ['forecast', 'plan', 'risk', 'report', 'excel', 'opencloud'],
    defaultTemplates: ['full_report', 'forecast_then_plan', 'risk_aware_plan'],
    permissions: DEFAULT_PERMISSIONS,
  },
  report_writer: {
    id: 'report_writer',
    name: 'Riley',
    role: 'report_writer',
    icon: 'file-text',
    description: 'AI report writer. Specializes in data-driven reports, dashboards, and presentations.',
    capabilities: ['report', 'excel', 'opencloud'],
    defaultTemplates: ['full_report', 'mbr_with_excel'],
    permissions: { ...DEFAULT_PERMISSIONS },
  },
  data_quality_analyst: {
    id: 'data_quality_analyst',
    name: 'Dana',
    role: 'data_quality_analyst',
    icon: 'shield-check',
    description: 'AI data quality analyst. Validates data integrity, detects anomalies, and produces data quality reports.',
    capabilities: ['data_quality', 'report'],
    defaultTemplates: ['forecast'],
    permissions: { ...DEFAULT_PERMISSIONS },
  },
};

/**
 * Get or create a worker for the given user, driven by a worker template.
 * Replaces the hardcoded getOrCreateAiden().
 *
 * @param {string} userId - Manager user ID
 * @param {string} [templateId='analytics_worker'] - Template to use for creation
 * @returns {Promise<object>} employee row
 */
export async function getOrCreateWorker(userId, templateId = 'analytics_worker') {
  const template = WORKER_TEMPLATES[templateId] || WORKER_TEMPLATES.analytics_worker;

  // Try to find an existing worker with matching role for this user
  const { data: rows, error: selErr } = await supabase
    .from('ai_employees')
    .select('*')
    .eq('manager_user_id', userId)
    .eq('role', template.role)
    .order('created_at', { ascending: true })
    .limit(1);

  if (selErr) throw new Error(`[EmployeeRepo] getOrCreateWorker lookup failed: ${selErr.message}`);

  const existing = rows?.[0] ?? null;
  if (existing) {
    // Migrate permissions if any are missing
    const currentPerms = existing.permissions || {};
    const missingKeys = Object.keys(template.permissions).filter((k) => !currentPerms[k]);
    if (missingKeys.length > 0) {
      const updatedPerms = { ...currentPerms, ...template.permissions };
      await supabase.from('ai_employees').update({ permissions: updatedPerms }).eq('id', existing.id).catch(() => {});
      existing.permissions = updatedPerms;
    }
    existing._logicalState = DB_TO_EMPLOYEE_STATE[existing.status] || existing.status;
    return existing;
  }

  // Create new worker from template
  const { data: created, error: insErr } = await supabase
    .from('ai_employees')
    .insert({
      name: template.name,
      role: template.role,
      status: 'idle',
      manager_user_id: userId,
      description: template.description,
      permissions: template.permissions,
    })
    .select()
    .single();

  if (insErr) throw new Error(`[EmployeeRepo] getOrCreateWorker insert failed: ${insErr.message}`);
  created._logicalState = DB_TO_EMPLOYEE_STATE[created.status] || created.status;
  return created;
}

/**
 * Get KPIs for an employee from the ai_employee_kpis view.
 * Replaces aiEmployeeService.getKpis().
 */
export async function getKpis(employeeId) {
  const { data, error } = await supabase
    .from('ai_employee_kpis')
    .select('*')
    .eq('employee_id', employeeId)
    .maybeSingle();

  if (error) throw new Error(`[EmployeeRepo] getKpis failed: ${error.message}`);
  return data;
}

/**
 * Create a new worker from a template (explicit creation, not get-or-create).
 * Allows multiple workers of the same template type with custom names.
 *
 * @param {string} userId - Manager user ID
 * @param {string} templateId - Template to use
 * @param {Object} [overrides] - Override template defaults
 * @param {string} [overrides.name] - Custom worker name
 * @param {string} [overrides.description] - Custom description
 * @returns {Promise<object>} Created employee row
 */
export async function createWorkerFromTemplate(userId, templateId, overrides = {}) {
  const template = WORKER_TEMPLATES[templateId];
  if (!template) {
    throw new Error(`[EmployeeRepo] Unknown worker template: '${templateId}'. Known: ${Object.keys(WORKER_TEMPLATES).join(', ')}`);
  }

  const { data: created, error } = await supabase
    .from('ai_employees')
    .insert({
      name: overrides.name || template.name,
      role: template.role,
      status: 'idle',
      manager_user_id: userId,
      description: overrides.description || template.description,
      permissions: template.permissions,
    })
    .select()
    .single();

  if (error) throw new Error(`[EmployeeRepo] createWorkerFromTemplate failed: ${error.message}`);
  created._logicalState = DB_TO_EMPLOYEE_STATE[created.status] || created.status;
  return created;
}

/**
 * Delete a worker (soft or hard).
 * @param {string} employeeId
 */
export async function deleteWorker(employeeId) {
  const { error } = await supabase
    .from('ai_employees')
    .delete()
    .eq('id', employeeId);
  if (error) throw new Error(`[EmployeeRepo] deleteWorker failed: ${error.message}`);
}

/**
 * Update a worker's name or description.
 */
export async function updateWorker(employeeId, updates) {
  const allowed = {};
  if (updates.name) allowed.name = updates.name;
  if (updates.description) allowed.description = updates.description;
  if (updates.permissions) allowed.permissions = updates.permissions;

  const { data, error } = await supabase
    .from('ai_employees')
    .update(allowed)
    .eq('id', employeeId)
    .select()
    .single();

  if (error) throw new Error(`[EmployeeRepo] updateWorker failed: ${error.message}`);
  data._logicalState = DB_TO_EMPLOYEE_STATE[data.status] || data.status;
  return data;
}

/**
 * List all available templates.
 */
export function listTemplates() {
  return Object.values(WORKER_TEMPLATES).map(t => ({
    id: t.id,
    name: t.name,
    role: t.role,
    icon: t.icon,
    description: t.description,
    capabilities: t.capabilities,
  }));
}

/** Expose template catalog for UI. */
export { WORKER_TEMPLATES };
