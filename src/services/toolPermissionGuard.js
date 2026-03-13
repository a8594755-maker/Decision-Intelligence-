// @product: ai-employee
//
// toolPermissionGuard.js
// ─────────────────────────────────────────────────────────────────────────────
// Enforces tool/workflow permissions for AI employees.
//
// Each workflow_type maps to a required permission key in the employee's
// `permissions` JSONB. If the permission is missing or false, the guard
// throws a PermissionDeniedError before any execution begins.
//
// Extensible: add new entries to PERMISSION_REGISTRY as new workflow types
// or tools are introduced.
// ─────────────────────────────────────────────────────────────────────────────

// ── Permission Registry ──────────────────────────────────────────────────────
// Maps workflow_type → required permission key(s) on ai_employees.permissions

export const PERMISSION_REGISTRY = {
  forecast:        ['can_run_forecast'],
  plan:            ['can_run_plan'],
  risk:            ['can_run_risk'],
  synthesize:      [],                     // no special permission needed — it's a passive aggregation
  dynamic_tool:    ['can_run_dynamic_tool'],
  registered_tool: ['can_run_registered_tool'],
  report:          ['can_generate_report'],
  export:          ['can_export'],
  builtin_tool:    ['can_run_builtin_tool'],
};

// ── Error ────────────────────────────────────────────────────────────────────

export class PermissionDeniedError extends Error {
  /**
   * @param {string} employeeName
   * @param {string} workflowType
   * @param {string[]} missingPermissions
   */
  constructor(employeeName, workflowType, missingPermissions) {
    const msg = `Permission denied: "${employeeName}" lacks ${missingPermissions.join(', ')} for workflow "${workflowType}"`;
    super(msg);
    this.name = 'PermissionDeniedError';
    this.employeeName = employeeName;
    this.workflowType = workflowType;
    this.missingPermissions = missingPermissions;
  }
}

// ── Guard ────────────────────────────────────────────────────────────────────

/**
 * Check if an employee has permission to execute a given workflow_type.
 *
 * @param {object} employee - Row from ai_employees (must include .permissions and .name)
 * @param {string} workflowType - The workflow_type being dispatched
 * @throws {PermissionDeniedError} If any required permission is missing or false
 * @returns {true} On success
 */
export function checkPermission(employee, workflowType) {
  const required = PERMISSION_REGISTRY[workflowType];

  // Unknown workflow types are allowed to pass through (fail at executor dispatch instead)
  if (!required || required.length === 0) return true;

  const perms = employee?.permissions || {};
  const missing = required.filter((key) => !perms[key]);

  if (missing.length > 0) {
    throw new PermissionDeniedError(
      employee?.name || 'Unknown',
      workflowType,
      missing
    );
  }

  return true;
}

/**
 * Non-throwing version. Returns { allowed, missing } instead of throwing.
 *
 * @param {object} employee
 * @param {string} workflowType
 * @returns {{ allowed: boolean, missing: string[] }}
 */
export function canExecute(employee, workflowType) {
  const required = PERMISSION_REGISTRY[workflowType];
  if (!required || required.length === 0) return { allowed: true, missing: [] };

  const perms = employee?.permissions || {};
  const missing = required.filter((key) => !perms[key]);

  return { allowed: missing.length === 0, missing };
}

export default { PERMISSION_REGISTRY, PermissionDeniedError, checkPermission, canExecute };
