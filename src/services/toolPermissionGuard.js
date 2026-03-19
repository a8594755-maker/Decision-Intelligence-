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

// ── Capability-Level Enforcement (DB-First) ─────────────────────────────────
// Extends permission + tier checks with capability class policy from DB.
// This is the authoritative guard for the platform — combines all three layers:
//   1. Permission JSONB (can_run_*)
//   2. Tool tier restrictions (tier_a/b/c)
//   3. Capability class policy (autonomy level, allowed_capabilities from DB)

import { resolveCapabilityClass, getCapabilityPolicyFromDB } from './capabilityModelService.js';
import { getWorkerTemplateFromDB } from './aiEmployee/persistence/employeeRepo.js';

/**
 * Full capability-aware permission check (async, DB-first).
 * Checks permission JSONB + tool tier + capability class policy + autonomy level.
 *
 * @param {object} employee - Row from ai_employees (must include .role, .permissions, .name)
 * @param {string} workflowType - The workflow_type being dispatched
 * @param {object} [stepInfo] - Step context for capability resolution
 * @param {string} [stepInfo.builtin_tool_id] - Builtin tool ID
 * @param {string} [stepInfo.tool_type] - Executor type
 * @param {string} [stepInfo.toolTier] - Tool tier
 * @param {string} [autonomyLevel='A1'] - Worker's current autonomy level
 * @returns {Promise<{ allowed: boolean, missing: string[], tierBlocked: boolean, capabilityBlocked: boolean, reason?: string }>}
 */
export async function checkCapabilityPolicy(employee, workflowType, stepInfo = {}, autonomyLevel = 'A1') {
  // Layer 1: Permission JSONB check
  const permCheck = canExecute(employee, workflowType);
  if (!permCheck.allowed) {
    return { ...permCheck, tierBlocked: false, capabilityBlocked: false };
  }

  // Layer 2: Tool tier check (try DB template first)
  let dbTemplate = null;
  try {
    dbTemplate = await getWorkerTemplateFromDB(employee.role);
  } catch { /* best-effort */ }

  const tierCheck = checkToolTier(employee, stepInfo.toolTier, dbTemplate);
  if (!tierCheck.allowed) {
    return { allowed: false, missing: [], tierBlocked: true, capabilityBlocked: false, reason: tierCheck.reason };
  }

  // Layer 3: Capability class policy from DB
  const capClass = resolveCapabilityClass({
    tool_type: stepInfo.tool_type || workflowType,
    builtin_tool_id: stepInfo.builtin_tool_id,
  });

  // Check if worker's template allows this capability class
  const templateCaps = dbTemplate?.allowed_capabilities || [];
  if (templateCaps.length > 0 && !templateCaps.includes(capClass)) {
    return {
      allowed: false,
      missing: [],
      tierBlocked: false,
      capabilityBlocked: true,
      reason: `Worker template '${employee.role}' does not allow capability class '${capClass}' (allowed: ${templateCaps.join(', ')})`,
    };
  }

  // Check autonomy level against policy minimum
  try {
    const policy = await getCapabilityPolicyFromDB(capClass, stepInfo.builtin_tool_id);
    if (policy?.min_autonomy_level) {
      const levels = ['A0', 'A1', 'A2', 'A3', 'A4'];
      const currentIdx = levels.indexOf(autonomyLevel);
      const minIdx = levels.indexOf(policy.min_autonomy_level);
      if (currentIdx >= 0 && minIdx >= 0 && currentIdx < minIdx) {
        return {
          allowed: false,
          missing: [],
          tierBlocked: false,
          capabilityBlocked: true,
          reason: `Autonomy level ${autonomyLevel} below minimum ${policy.min_autonomy_level} for capability '${capClass}'`,
        };
      }
    }
  } catch { /* DB unavailable — allow (policy enforcement is best-effort over hardcoded) */ }

  return { allowed: true, missing: [], tierBlocked: false, capabilityBlocked: false };
}

export default { PERMISSION_REGISTRY, TEMPLATE_TIER_RESTRICTIONS, PermissionDeniedError, checkPermission, canExecute, checkToolTier, canExecuteTool, checkCapabilityPolicy };
