/**
 * Scenario Comparison Builder
 *
 * Produces a `scenario_comparison` artifact from base and scenario plan artifacts.
 *
 * Artifact type: 'scenario_comparison'
 * Schema:
 * {
 *   base_run_id: number,
 *   scenario_run_id: number,
 *   overrides: object,
 *   kpis: { base, scenario, delta },
 *   top_changes: [{ sku, plant_id, field, base, scenario, delta, reason_refs }],
 *   notes: string[]
 * }
 */

const TOP_CHANGES_LIMIT = 20;

const safeNum = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const delta = (scenario, base) => {
  if (scenario === null || base === null) return null;
  return Number((scenario - base).toFixed(6));
};

const pctDelta = (scenario, base) => {
  if (!Number.isFinite(scenario) || !Number.isFinite(base) || base === 0) return null;
  return Number(((scenario - base) / Math.abs(base)).toFixed(6));
};

/**
 * Extract KPI summary from plan artifacts for one run.
 * @param {object} replayMetrics - replay_metrics artifact payload
 * @param {object} solverMeta   - solver_meta artifact payload
 */
function extractRunKpis(replayMetrics, solverMeta) {
  const withPlan = replayMetrics?.with_plan || {};
  return {
    service_level_proxy: safeNum(withPlan.service_level_proxy),
    stockout_units: safeNum(withPlan.stockout_units),
    holding_units: safeNum(withPlan.holding_units),
    estimated_total_cost: safeNum(solverMeta?.kpis?.estimated_total_cost)
  };
}

/**
 * Build a row-keyed index: { 'sku|plant_id|order_date': { order_qty, ... } }
 */
function indexPlanRows(rows = []) {
  const index = new Map();
  rows.forEach((row) => {
    const key = `${row.sku || ''}|${row.plant_id || ''}|${row.order_date || ''}`;
    if (!index.has(key)) {
      index.set(key, { sku: row.sku, plant_id: row.plant_id || null, order_date: row.order_date, order_qty: 0 });
    }
    // Sum quantities if duplicates exist (shouldn't, but be safe)
    index.get(key).order_qty += Number(row.order_qty || 0);
  });
  return index;
}

/**
 * Compute top changes sorted by |delta| descending.
 * Considers SKU-level aggregate order_qty differences.
 */
function computeTopChanges(basePlanRows = [], scenarioPlanRows = []) {
  // Aggregate by sku+plant_id (ignore order_date for cross-run comparison)
  const aggregateBySkuPlant = (rows) => {
    const map = new Map();
    rows.forEach((row) => {
      const key = `${row.sku || ''}|${row.plant_id || ''}`;
      if (!map.has(key)) {
        map.set(key, { sku: row.sku || '', plant_id: row.plant_id || null, order_qty: 0, order_count: 0 });
      }
      const entry = map.get(key);
      entry.order_qty += Number(row.order_qty || 0);
      entry.order_count += 1;
    });
    return map;
  };

  const baseMap = aggregateBySkuPlant(basePlanRows);
  const scenarioMap = aggregateBySkuPlant(scenarioPlanRows);

  // Union of all SKU-plant keys
  const allKeys = new Set([...baseMap.keys(), ...scenarioMap.keys()]);
  const changes = [];

  allKeys.forEach((key) => {
    const baseEntry = baseMap.get(key) || null;
    const scenarioEntry = scenarioMap.get(key) || null;

    const baseQty = baseEntry?.order_qty ?? 0;
    const scenarioQty = scenarioEntry?.order_qty ?? 0;
    const qtyDelta = scenarioQty - baseQty;

    if (Math.abs(qtyDelta) < 0.001) return; // Skip negligible changes

    const sku = (baseEntry || scenarioEntry).sku;
    const plant_id = (baseEntry || scenarioEntry).plant_id;

    changes.push({
      sku,
      plant_id,
      field: 'order_qty',
      base: baseQty,
      scenario: scenarioQty,
      delta: Number(qtyDelta.toFixed(4)),
      pct_delta: pctDelta(scenarioQty, baseQty),
      reason_refs: []
    });
  });

  // Sort by absolute delta descending, then by sku
  changes.sort((a, b) => {
    const absDiff = Math.abs(b.delta) - Math.abs(a.delta);
    if (Math.abs(absDiff) > 0.001) return absDiff;
    return (a.sku || '').localeCompare(b.sku || '');
  });

  return changes.slice(0, TOP_CHANGES_LIMIT);
}

/**
 * Build human-readable notes based on overrides and KPI deltas.
 */
function buildNotes(overrides = {}, kpis = {}) {
  const notes = [];
  const d = kpis.delta || {};

  // Override context notes
  if (overrides.budget_cap !== null && overrides.budget_cap !== undefined) {
    notes.push(`Budget cap applied: ${overrides.budget_cap}`);
  }
  if (overrides.service_target !== null && overrides.service_target !== undefined) {
    notes.push(`Service target set to ${(overrides.service_target * 100).toFixed(1)}%`);
  }
  if (overrides.stockout_penalty_multiplier !== null && overrides.stockout_penalty_multiplier !== undefined) {
    notes.push(`Stockout penalty scaled ×${overrides.stockout_penalty_multiplier}`);
  }
  if (overrides.safety_stock_alpha !== null && overrides.safety_stock_alpha !== undefined) {
    notes.push(`Safety-stock alpha (p90 uplift): ${overrides.safety_stock_alpha}`);
  }
  if (overrides.expedite_mode === 'on') {
    const buffer = overrides.lead_time_buffer_days ?? 3;
    notes.push(`Expedite mode ON: lead-time reduced by ${buffer} day(s)`);
    if (overrides.expedite_cost_per_unit) {
      notes.push(`Expedite cost per unit: ${overrides.expedite_cost_per_unit}`);
    }
  }
  if (overrides.risk_mode === 'on') {
    notes.push('Risk mode ON: stockout penalty boosted before applying multiplier overrides');
  }

  // KPI outcome notes
  if (Number.isFinite(d.service_level_proxy)) {
    const sign = d.service_level_proxy >= 0 ? '+' : '';
    notes.push(`Service level delta: ${sign}${(d.service_level_proxy * 100).toFixed(2)} pp`);
  }
  if (Number.isFinite(d.stockout_units)) {
    const sign = d.stockout_units >= 0 ? '+' : '';
    notes.push(`Stockout units delta: ${sign}${d.stockout_units.toFixed(0)}`);
  }
  if (Number.isFinite(d.estimated_total_cost)) {
    const sign = d.estimated_total_cost >= 0 ? '+' : '';
    notes.push(`Estimated cost delta: ${sign}${d.estimated_total_cost.toFixed(2)}`);
  }

  return notes;
}

/**
 * Build a scenario_comparison artifact.
 *
 * @param {object} params
 * @param {number} params.baseRunId
 * @param {number} params.scenarioRunId
 * @param {object} params.overrides
 * @param {object} params.baseReplayMetrics  - replay_metrics artifact from base run
 * @param {object} params.baseSolverMeta     - solver_meta artifact from base run
 * @param {object} params.basePlanTable      - plan_table artifact from base run
 * @param {object} params.scenarioReplayMetrics
 * @param {object} params.scenarioSolverMeta
 * @param {object} params.scenarioPlanTable
 */
export function buildScenarioComparison({
  baseRunId,
  scenarioRunId,
  overrides = {},
  baseReplayMetrics,
  baseSolverMeta,
  basePlanTable,
  scenarioReplayMetrics,
  scenarioSolverMeta,
  scenarioPlanTable
}) {
  const baseKpis = extractRunKpis(baseReplayMetrics, baseSolverMeta);
  const scenarioKpis = extractRunKpis(scenarioReplayMetrics, scenarioSolverMeta);

  const deltaKpis = {
    service_level_proxy: delta(scenarioKpis.service_level_proxy, baseKpis.service_level_proxy),
    stockout_units: delta(scenarioKpis.stockout_units, baseKpis.stockout_units),
    holding_units: delta(scenarioKpis.holding_units, baseKpis.holding_units),
    estimated_total_cost: delta(scenarioKpis.estimated_total_cost, baseKpis.estimated_total_cost)
  };

  const basePlanRows = Array.isArray(basePlanTable?.rows) ? basePlanTable.rows : [];
  const scenarioPlanRows = Array.isArray(scenarioPlanTable?.rows) ? scenarioPlanTable.rows : [];
  const topChanges = computeTopChanges(basePlanRows, scenarioPlanRows);

  const kpis = {
    base: baseKpis,
    scenario: scenarioKpis,
    delta: deltaKpis
  };

  const notes = buildNotes(overrides, kpis);

  return {
    base_run_id: Number(baseRunId),
    scenario_run_id: Number(scenarioRunId),
    overrides,
    kpis,
    top_changes: topChanges,
    notes
  };
}

export { computeTopChanges, extractRunKpis, buildNotes };

export default {
  buildScenarioComparison,
  computeTopChanges,
  extractRunKpis,
  buildNotes
};
