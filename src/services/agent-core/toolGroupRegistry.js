/**
 * toolGroupRegistry.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Tool Group Registry: maps named groups to sets of tool IDs.
 *
 * Instead of exposing all 63+ builtin tools to the LLM on every turn,
 * the planner selects 1-2 groups per turn. This keeps the callable tool
 * set ≤ 12 per turn, which dramatically improves tool selection accuracy.
 *
 * Usage:
 *   const toolIds = resolveToolGroups(['analysis_core', 'planning_core']);
 *   const tools = getToolDefinitions({ toolIds });
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Group Definitions ────────────────────────────────────────────────────────

export const TOOL_GROUPS = Object.freeze({
  analysis_core: Object.freeze([
    'query_sap_data',
    'list_sap_tables',
    'run_python_analysis',
    'generate_chart',
    'generate_analysis_workbook',
  ]),

  planning_core: Object.freeze([
    'run_forecast',
    'run_plan',
    'run_risk_analysis',
    'run_risk_aware_plan',
    'run_risk_adjustments',
    'run_scenario',
    'run_batch_scenarios',
  ]),

  negotiation: Object.freeze([
    'run_negotiation',
  ]),

  simulation: Object.freeze([
    'run_digital_twin_simulation',
    'run_digital_twin_comparison',
    'run_digital_twin_optimization',
    'run_stress_test',
  ]),

  cost_revenue: Object.freeze([
    'run_cost_analysis',
    'run_cost_forecast',
    'run_revenue_forecast',
  ]),

  data_prep: Object.freeze([
    'run_eda',
    'run_data_cleaning',
    'run_dataset_join',
    'list_available_tables',
  ]),

  advanced_analytics: Object.freeze([
    'run_regression',
    'run_anomaly_detection',
    'run_feature_importance',
    'run_ml_forecast',
    'run_backtest',
  ]),

  inventory: Object.freeze([
    'run_inventory_projection',
    'run_sku_analysis',
    'run_bom_explosion',
    'run_stockout_causal_graph',
  ]),
});

export const VALID_GROUP_NAMES = Object.freeze(Object.keys(TOOL_GROUPS));

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Resolve 1+ group names into a deduplicated list of tool IDs.
 *
 * @param {string[]} groupNames - e.g. ['analysis_core', 'planning_core']
 * @returns {string[]} deduplicated tool IDs
 */
export function resolveToolGroups(groupNames) {
  if (!Array.isArray(groupNames) || groupNames.length === 0) {
    // Default: analysis_core only (safest fallback)
    return [...TOOL_GROUPS.analysis_core];
  }

  const ids = new Set();
  for (const name of groupNames) {
    const group = TOOL_GROUPS[name];
    if (group) {
      for (const id of group) ids.add(id);
    } else {
      console.warn(`[toolGroupRegistry] Unknown group "${name}", skipping`);
    }
  }

  return [...ids];
}

/**
 * Get the group name(s) that contain a given tool ID.
 *
 * @param {string} toolId
 * @returns {string[]} group names containing this tool
 */
export function getGroupsForTool(toolId) {
  return VALID_GROUP_NAMES.filter(name => TOOL_GROUPS[name].includes(toolId));
}

/**
 * Get the maximum number of tools that would be exposed for the given groups.
 *
 * @param {string[]} groupNames
 * @returns {number}
 */
export function getToolCount(groupNames) {
  return resolveToolGroups(groupNames).length;
}

export default {
  TOOL_GROUPS,
  VALID_GROUP_NAMES,
  resolveToolGroups,
  getGroupsForTool,
  getToolCount,
};
