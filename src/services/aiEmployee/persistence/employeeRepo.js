/**
 * employeeRepo.js — Supabase CRUD for ai_employees.
 *
 * Manages employee status. Maps logical states to DB values
 * via EMPLOYEE_STATE_TO_DB for backward compatibility.
 *
 * When VITE_DI_MOCK_MODE=true, all functions delegate to in-memory mock.
 */

import { supabase } from '../../infra/supabaseClient.js';
import { EMPLOYEE_STATES, EMPLOYEE_STATE_TO_DB, DB_TO_EMPLOYEE_STATE } from '../employeeStateMachine.js';

const _MOCK = import.meta.env?.VITE_DI_MOCK_MODE === 'true';
const _m = _MOCK ? await import('../mock/mockEmployeeRepo.js') : null;

/**
 * Update employee status using logical state names.
 * @param {string} employeeId
 * @param {string} logicalState - one of EMPLOYEE_STATES values
 */
export async function updateEmployeeStatus(employeeId, logicalState) {
  if (_m) return _m.updateEmployeeStatus(employeeId, logicalState);
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
  if (_m) return _m.getEmployee(employeeId);
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
  if (_m) return _m.getEmployeeByManager(userId);
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
export async function listEmployeesByManager(userId, { includeArchived = false } = {}) {
  if (_m) return _m.listEmployeesByManager(userId, { includeArchived });
  let query = supabase
    .from('ai_employees')
    .select('*')
    .eq('manager_user_id', userId)
    .order('created_at', { ascending: true });

  if (!includeArchived) {
    query = query.is('archived_at', null);
  }

  const { data, error } = await query;

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
    capabilities: ['forecast', 'plan', 'risk', 'report', 'excel'],
    defaultTemplates: ['full_report', 'forecast_then_plan', 'risk_aware_plan'],
    permissions: DEFAULT_PERMISSIONS,
  },
  supply_chain_analyst: {
    id: 'supply_chain_analyst',
    name: 'Supply Chain Analyst',
    role: 'supply_chain_analyst',
    icon: 'file-text',
    description: 'Digital worker for supply chain analysis. Specializes in planning, procurement analysis, and operational reports.',
    capabilities: ['forecast', 'plan', 'risk', 'report', 'excel'],
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
    capabilities: ['data_quality', 'report'],
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
  if (_m) return _m.getOrCreateWorker(userId, templateId);
  // Try DB-backed template first, fall back to hardcoded
  const dbTemplate = await getWorkerTemplateFromDB(templateId).catch(() => null);
  const template = dbTemplate || WORKER_TEMPLATES[templateId] || WORKER_TEMPLATES.data_analyst;

  // Try to find an existing worker with matching role for this user
  // Also check for legacy role in case migration hasn't been applied yet
  const LEGACY_ROLE = 'supply_chain_reporting_employee';
  const rolesToCheck = template.role === LEGACY_ROLE
    ? [LEGACY_ROLE]
    : [template.role, LEGACY_ROLE];

  const { data: rows, error: selErr } = await supabase
    .from('ai_employees')
    .select('*')
    .eq('manager_user_id', userId)
    .in('role', rolesToCheck)
    .is('archived_at', null)
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
  const insertPayload = {
    name: template.name,
    role: template.role,
    status: EMPLOYEE_STATE_TO_DB[EMPLOYEE_STATES.IDLE],
    manager_user_id: userId,
    description: template.description,
    permissions: template.permissions,
  };

  let { data: created, error: insErr } = await supabase
    .from('ai_employees')
    .insert(insertPayload)
    .select()
    .single();

  // Fallback: if role CHECK constraint rejects the new role (migration not yet applied),
  // retry with the legacy role that the original migration allows.
  if (insErr && insErr.message?.includes('ai_employees_role_check')) {
    ({ data: created, error: insErr } = await supabase
      .from('ai_employees')
      .insert({ ...insertPayload, role: LEGACY_ROLE })
      .select()
      .single());
  }

  if (insErr) throw new Error(`[EmployeeRepo] getOrCreateWorker insert failed: ${insErr.message}`);
  created._logicalState = DB_TO_EMPLOYEE_STATE[created.status] || created.status;
  return created;
}

/**
 * Get KPIs for an employee from the ai_employee_kpis view.
 * Replaces aiEmployeeService.getKpis().
 */
export async function getKpis(employeeId) {
  if (_m) return _m.getKpis(employeeId);
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
  if (_m) return _m.createWorkerFromTemplate(userId, templateId, overrides);
  // Try DB-backed template first, fall back to hardcoded
  const dbTemplate = await getWorkerTemplateFromDB(templateId).catch(() => null);
  const template = dbTemplate || WORKER_TEMPLATES[templateId];
  if (!template) {
    throw new Error(`[EmployeeRepo] Unknown worker template: '${templateId}'. Known: ${Object.keys(WORKER_TEMPLATES).join(', ')}`);
  }

  const payload = {
    name: overrides.name || template.name,
    role: template.role,
    status: EMPLOYEE_STATE_TO_DB[EMPLOYEE_STATES.IDLE],
    manager_user_id: userId,
    description: overrides.description || template.description,
    permissions: template.permissions,
  };

  let { data: created, error } = await supabase
    .from('ai_employees')
    .insert(payload)
    .select()
    .single();

  // Fallback to legacy role if CHECK constraint rejects the new role
  if (error && error.message?.includes('ai_employees_role_check')) {
    ({ data: created, error } = await supabase
      .from('ai_employees')
      .insert({ ...payload, role: 'supply_chain_reporting_employee' })
      .select()
      .single());
  }

  if (error) throw new Error(`[EmployeeRepo] createWorkerFromTemplate failed: ${error.message}`);
  created._logicalState = DB_TO_EMPLOYEE_STATE[created.status] || created.status;
  return created;
}

/**
 * Clone an existing worker into a new worker with a custom name.
 * The clone inherits template, permissions, and description from the source.
 * Enforces manager scope — only the source worker's manager can clone.
 *
 * @param {string} sourceEmployeeId - ID of the worker to clone
 * @param {string} userId - Manager user ID (must own the source worker)
 * @param {Object} [overrides] - Override cloned fields
 * @param {string} [overrides.name] - Custom name for the clone
 * @param {string} [overrides.description] - Custom description
 * @returns {Promise<object>} Newly created employee row
 */
export async function cloneWorker(sourceEmployeeId, userId, overrides = {}) {
  if (_m) return _m.cloneWorker(sourceEmployeeId, userId, overrides);
  // Fetch source worker with manager scope check
  const source = await getEmployee(sourceEmployeeId);
  if (source.manager_user_id !== userId) {
    throw new Error(`[EmployeeRepo] cloneWorker denied: user '${userId}' is not the manager of worker '${sourceEmployeeId}'`);
  }

  const payload = {
    name: overrides.name || `${source.name} (copy)`,
    role: source.role,
    status: EMPLOYEE_STATE_TO_DB[EMPLOYEE_STATES.IDLE],
    manager_user_id: userId,
    description: overrides.description || source.description,
    permissions: { ...(source.permissions || {}) },
  };

  const { data: created, error } = await supabase
    .from('ai_employees')
    .insert(payload)
    .select()
    .single();

  if (error) throw new Error(`[EmployeeRepo] cloneWorker failed: ${error.message}`);
  created._logicalState = DB_TO_EMPLOYEE_STATE[created.status] || created.status;
  return created;
}

/**
 * Archive a worker (soft-delete). Record stays for audit trail.
 * Enforces manager scope — only the worker's manager can archive.
 *
 * @param {string} employeeId
 * @param {string} [userId] - Manager user ID. If provided, enforces ownership.
 */
export async function archiveWorker(employeeId, userId) {
  if (_m) return _m.archiveWorker(employeeId, userId);
  if (userId) {
    const emp = await getEmployee(employeeId);
    if (emp.manager_user_id !== userId) {
      throw new Error(`[EmployeeRepo] archiveWorker denied: user '${userId}' is not the manager of worker '${employeeId}'`);
    }
  }
  const { error } = await supabase
    .from('ai_employees')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', employeeId);
  if (error) throw new Error(`[EmployeeRepo] archiveWorker failed: ${error.message}`);
}

/** @deprecated Use archiveWorker for audit-safe removal. */
export const deleteWorker = archiveWorker;

/**
 * Update a worker's name or description.
 * Enforces manager scope — only the worker's manager can update.
 *
 * @param {string} employeeId
 * @param {Object} updates - { name?, description?, permissions? }
 * @param {string} [userId] - Manager user ID. If provided, enforces ownership.
 */
export async function updateWorker(employeeId, updates, userId) {
  if (_m) return _m.updateWorker(employeeId, updates, userId);
  if (userId) {
    const emp = await getEmployee(employeeId);
    if (emp.manager_user_id !== userId) {
      throw new Error(`[EmployeeRepo] updateWorker denied: user '${userId}' is not the manager of worker '${employeeId}'`);
    }
  }

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
  if (_m) return _m.listTemplates();
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
  if (_m) return null;
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
  if (_m) return [];
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
