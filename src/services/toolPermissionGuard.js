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
  python_tool:     ['can_run_python_tool'],
  python_report:   ['can_generate_report'],
  excel_ops:       ['can_drive_excel'],
  // OpenCloud EU integration
  opencloud_sync:       ['can_sync_opencloud'],
  opencloud_import:     ['can_import_opencloud'],
  opencloud_search:     ['can_search_opencloud'],
  opencloud_distribute: ['can_distribute_opencloud'],
  opencloud_watch:      ['can_watch_opencloud'],
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

// ── Tool Tier Restrictions ──────────────────────────────────────────────────
// Worker templates can restrict which tool tiers (tier_a, tier_b, tier_c)
// their workers are allowed to execute. This prevents low-privilege templates
// from accessing expensive or high-risk tools.

/**
 * Default tier allowances by template role.
 * Templates not listed here default to all tiers allowed.
 */
export const TEMPLATE_TIER_RESTRICTIONS = {
  operations_coordinator: ['tier_a', 'tier_b'],          // no tier_c (expensive)
  procurement_specialist: ['tier_a', 'tier_b', 'tier_c'],
  data_analyst:           ['tier_a', 'tier_b', 'tier_c'],
  supply_chain_analyst:   ['tier_a', 'tier_b', 'tier_c'],
};

/**
 * Check if a worker's template allows a specific tool tier.
 *
 * @param {object} employee - Row from ai_employees (must include .role)
 * @param {string} toolTier - The tool's tier (tier_a | tier_b | tier_c)
 * @param {object} [templateOverride] - Optional: DB-loaded template with allowed_tiers
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function checkToolTier(employee, toolTier, templateOverride) {
  if (!toolTier) return { allowed: true };

  // Check DB-loaded template override first
  if (templateOverride?.allowed_tiers) {
    const allowed = templateOverride.allowed_tiers.includes(toolTier);
    if (!allowed) {
      return {
        allowed: false,
        reason: `Template "${templateOverride.name || employee.role}" does not allow ${toolTier} tools`,
      };
    }
    return { allowed: true };
  }

  // Fall back to hardcoded restrictions
  const role = employee?.role;
  const allowedTiers = TEMPLATE_TIER_RESTRICTIONS[role];
  if (!allowedTiers) return { allowed: true }; // unknown role = all tiers allowed

  if (!allowedTiers.includes(toolTier)) {
    return {
      allowed: false,
      reason: `Worker role "${role}" is restricted from ${toolTier} tools (allowed: ${allowedTiers.join(', ')})`,
    };
  }

  return { allowed: true };
}

/**
 * Combined permission + tier check for a builtin tool.
 *
 * @param {object} employee
 * @param {string} workflowType
 * @param {string} [toolTier]
 * @param {object} [templateOverride]
 * @returns {{ allowed: boolean, missing: string[], tierBlocked: boolean, reason?: string }}
 */
export function canExecuteTool(employee, workflowType, toolTier, templateOverride) {
  const permCheck = canExecute(employee, workflowType);
  if (!permCheck.allowed) {
    return { ...permCheck, tierBlocked: false };
  }

  const tierCheck = checkToolTier(employee, toolTier, templateOverride);
  if (!tierCheck.allowed) {
    return { allowed: false, missing: [], tierBlocked: true, reason: tierCheck.reason };
  }

  return { allowed: true, missing: [], tierBlocked: false };
}

export default { PERMISSION_REGISTRY, TEMPLATE_TIER_RESTRICTIONS, PermissionDeniedError, checkPermission, canExecute, checkToolTier, canExecuteTool };
