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
 * Get employee by manager user ID.
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
// IDs match DB migration (worker_templates table) and capabilityModelService.
const WORKER_TEMPLATES = {
  data_analyst: {
    id: 'data_analyst',
    name: 'Data Analyst',
    role: 'data_analyst',
    icon: 'bar-chart',
    description: 'Digital worker for data analysis. Runs forecasts, plans, risk assessments, and business reports on demand.',
    capabilities: ['forecast', 'plan', 'risk', 'report', 'excel', 'opencloud'],
    defaultTemplates: ['full_report', 'forecast_then_plan', 'risk_aware_plan'],
    permissions: DEFAULT_PERMISSIONS,
  },
  supply_chain_analyst: {
    id: 'supply_chain_analyst',
    name: 'Supply Chain Analyst',
    role: 'supply_chain_analyst',
    icon: 'file-text',
    description: 'Digital worker for supply chain analysis. Specializes in planning, procurement analysis, and operational reports.',
    capabilities: ['forecast', 'plan', 'risk', 'report', 'excel', 'opencloud'],
    defaultTemplates: ['full_report', 'mbr_with_excel', 'risk_aware_plan'],
    permissions: { ...DEFAULT_PERMISSIONS },
  },
  procurement_specialist: {
    id: 'procurement_specialist',
    name: 'Procurement Specialist',
    role: 'procurement_specialist',
    icon: 'shopping-cart',
    description: 'Digital worker for procurement. Handles negotiation support, supplier analysis, and procurement workflows.',
    capabilities: ['forecast', 'plan', 'risk', 'report'],
    defaultTemplates: ['full_report', 'risk_aware_plan'],
    permissions: { ...DEFAULT_PERMISSIONS },
  },
  operations_coordinator: {
    id: 'operations_coordinator',
    name: 'Operations Coordinator',
    role: 'operations_coordinator',
    icon: 'shield-check',
    description: 'Digital worker for operations. Monitors data quality, validates integrity, and coordinates cross-system workflows.',
    capabilities: ['data_quality', 'report', 'opencloud'],
    defaultTemplates: ['full_report'],
    permissions: { ...DEFAULT_PERMISSIONS },
  },
};

/**
 * Get or create a worker for the given user, driven by a worker template.
 * Creates a worker from a template if none exists for this user.
 *
 * @param {string} userId - Manager user ID
 * @param {string} [templateId='data_analyst'] - Template to use for creation
 * @returns {Promise<object>} employee row
 */
export async function getOrCreateWorker(userId, templateId = 'data_analyst') {
  // Try DB-backed template first, fall back to hardcoded
  const dbTemplate = await getWorkerTemplateFromDB(templateId).catch(() => null);
  const template = dbTemplate || WORKER_TEMPLATES[templateId] || WORKER_TEMPLATES.data_analyst;

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
  // Try DB-backed template first, fall back to hardcoded
  const dbTemplate = await getWorkerTemplateFromDB(templateId).catch(() => null);
  const template = dbTemplate || WORKER_TEMPLATES[templateId];
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
 * List all available templates (DB-first, hardcoded fallback).
 * @returns {Promise<Object[]>}
 */
export async function listTemplates() {
  try {
    const dbTemplates = await listTemplatesFromDB();
    if (dbTemplates.length > 0) return dbTemplates;
  } catch { /* DB unavailable — fall through */ }
  return Object.values(WORKER_TEMPLATES).map(t => ({
    id: t.id,
    name: t.name,
    role: t.role,
    icon: t.icon,
    description: t.description,
    capabilities: t.capabilities,
  }));
}

// ── DB-backed template lookup ──

/**
 * Fetch a single worker template from the `worker_templates` DB table.
 * Falls back to the hardcoded WORKER_TEMPLATES constant on failure.
 *
 * @param {string} templateId
 * @returns {Promise<object>} Template in the same shape as WORKER_TEMPLATES entries
 */
export async function getWorkerTemplateFromDB(templateId) {
  try {
    const { data, error } = await supabase
      .from('worker_templates')
      .select('*')
      .eq('id', templateId)
      .eq('is_active', true)
      .maybeSingle();

    if (error || !data) {
      return WORKER_TEMPLATES[templateId] || null;
    }

    return _dbTemplateToLocal(data);
  } catch {
    // DB unavailable — fall back to hardcoded
    return WORKER_TEMPLATES[templateId] || null;
  }
}

/**
 * List all active worker templates from the DB.
 * Falls back to Object.values(WORKER_TEMPLATES) on failure.
 * DB templates take precedence over hardcoded ones (merged by id).
 *
 * @returns {Promise<object[]>} Array of template objects
 */
export async function listTemplatesFromDB() {
  try {
    const { data, error } = await supabase
      .from('worker_templates')
      .select('*')
      .eq('is_active', true)
      .order('created_at', { ascending: true });

    if (error || !data || data.length === 0) {
      return Object.values(WORKER_TEMPLATES);
    }

    // Merge: DB templates take precedence, hardcoded ones fill gaps
    const merged = new Map();
    for (const tmpl of Object.values(WORKER_TEMPLATES)) {
      merged.set(tmpl.id, tmpl);
    }
    for (const row of data) {
      merged.set(row.id, _dbTemplateToLocal(row));
    }

    return Array.from(merged.values());
  } catch {
    return Object.values(WORKER_TEMPLATES);
  }
}

/**
 * Convert a DB worker_templates row to the local template shape.
 * @param {object} row - DB row from worker_templates
 * @returns {object} Template in WORKER_TEMPLATES shape
 */
function _dbTemplateToLocal(row) {
  return {
    id: row.id,
    name: row.name,
    role: row.id, // DB templates use id as role
    icon: 'bar-chart', // default icon; DB doesn't store icons yet
    description: row.description || '',
    capabilities: row.allowed_capabilities || [],
    allowed_capabilities: row.allowed_capabilities || [],
    defaultTemplates: [],
    permissions: DEFAULT_PERMISSIONS,
    default_autonomy: row.default_autonomy || 'A1',
    max_autonomy: row.max_autonomy || 'A4',
    _source: 'db',
  };
}

/** Expose template catalog for UI. */
export { WORKER_TEMPLATES };
