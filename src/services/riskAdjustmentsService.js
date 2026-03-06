/**
 * Risk Adjustments Service v0
 *
 * Deterministic transformation: Workflow B risk_scores → solver parameter adjustments.
 * Given the same inputs, this function always produces identical JSON (no randomness).
 *
 * Artifact produced: risk_adjustments (artifact_type: 'risk_adjustments')
 */

// ─── Config constants ─────────────────────────────────────────────────────────
// Default thresholds for risk adjustment. Can be overridden at runtime via
// `applyRiskConfigOverrides()` to load tenant-specific or database-driven config.

const RISK_ADJ_DEFAULTS = {
  // Rule R1: Lead time extension
  lead_time_p90_delay_threshold: 5.0,    // days; if p90_delay_days > this, extend lead time
  overdue_ratio_threshold: 0.20,          // fraction; if overdue_ratio > this, extend lead time

  // Rule R2: Stockout penalty multiplier
  stockout_penalty_beta: 0.5,             // multiplier factor: penalty *= (1 + beta * norm_risk)
  high_risk_score_threshold: 60,          // raw risk_score above this triggers penalty uplift

  // Rule R3: Demand effective alpha (p90-p50 blending)
  safety_stock_alpha: 0.5,               // default fraction of (p90-p50) added for safety
  demand_uplift_alpha: 0.0,              // fraction of (p90-p50) added to demand (off by default)

  // High-demand-uplift alpha when supplier risk is high
  high_risk_demand_uplift_alpha: 0.3,

  // Rule R3: Safety stock violation penalty multiplier
  ss_penalty_beta: 0.8,                    // multiplier factor: ss_penalty *= (1 + beta * norm_risk)

  // Rule R4: Dual sourcing preference
  critical_risk_score_threshold: 120,      // risk_score above this triggers dual-source preference
  dual_source_min_split_fraction: 0.2,     // each supplier must receive >= 20% of total orders

  // Rule R5: Expedite mode
  expedite_risk_score_threshold: 100,      // risk_score above this (AND p90 delay > threshold) triggers expedite
  expedite_lead_time_reduction_days: 3,    // days to reduce lead time via expediting
  expedite_cost_multiplier: 1.25           // 25% unit-cost premium for expedited orders
};

export let RISK_ADJ_CONFIG = { ...RISK_ADJ_DEFAULTS };

/**
 * Apply runtime overrides to the risk adjustment config.
 * Merges partial overrides with defaults; ignores unknown keys.
 * @param {Partial<typeof RISK_ADJ_DEFAULTS>} overrides
 */
export function applyRiskConfigOverrides(overrides = {}) {
  const merged = { ...RISK_ADJ_DEFAULTS };
  for (const key of Object.keys(RISK_ADJ_DEFAULTS)) {
    if (overrides[key] !== undefined && typeof overrides[key] === 'number') {
      merged[key] = overrides[key];
    }
  }
  RISK_ADJ_CONFIG = merged;
  return RISK_ADJ_CONFIG;
}

/**
 * Reset config back to hardcoded defaults.
 */
export function resetRiskConfig() {
  RISK_ADJ_CONFIG = { ...RISK_ADJ_DEFAULTS };
  return RISK_ADJ_CONFIG;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const toNumber = (value, fallback = NaN) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeText = (value) => String(value || '').trim();

/**
 * Build a lookup key from material_code + plant_id, matching the sku|plant format
 * used throughout planning services.
 */
const toSkuKey = (materialCode, plantId) =>
  `${normalizeText(materialCode)}|${normalizeText(plantId)}`;

/**
 * Sort object keys deterministically (for stable JSON serialization).
 */
const sortedObject = (obj) => {
  if (!obj || typeof obj !== 'object') return obj;
  return Object.fromEntries(
    Object.entries(obj).sort(([a], [b]) => a.localeCompare(b))
  );
};

// ─── Core transformation ──────────────────────────────────────────────────────

/**
 * computeRiskAdjustments
 *
 * @param {Object} params
 * @param {Array}  params.riskScores   - Workflow B risk_scores rows
 * @param {Object} params.baseParams   - Base solver params (lead_time_days per sku, objective, etc.)
 * @param {Object} params.configOverrides - Optional overrides for RISK_ADJ_CONFIG constants
 *
 * @returns {Object} risk_adjustments artifact payload
 */
export function computeRiskAdjustments({
  riskScores = [],
  baseParams = {},
  configOverrides = {}
} = {}) {
  const config = { ...RISK_ADJ_CONFIG, ...configOverrides };
  const generatedAt = new Date().toISOString();

  const rows = Array.isArray(riskScores) ? riskScores : [];

  // Collect per-key adjustments
  const leadTimeDeltaByKey = {};          // key → additional days (integer)
  const penaltyMultiplierByKey = {};      // key → multiplier (>= 1.0)
  const ssPenaltyMultiplierByKey = {};    // key → SS violation penalty multiplier (>= 1.0)
  const dualSourceKeys = [];              // keys needing dual-source enforcement
  const expediteKeys = [];                // keys needing expedite mode
  const rules = [];

  // Sort rows deterministically so rule ordering is stable
  const sortedRows = [...rows].sort((a, b) => {
    const ka = toSkuKey(a.material_code || a.entity_id, a.plant_id);
    const kb = toSkuKey(b.material_code || b.entity_id, b.plant_id);
    return ka.localeCompare(kb);
  });

  sortedRows.forEach((entity) => {
    const materialCode = normalizeText(entity.material_code || entity.entity_id);
    const plantId = normalizeText(entity.plant_id);
    const key = toSkuKey(materialCode, plantId);

    const metrics = entity.metrics || {};
    const p90DelayDays = toNumber(metrics.p90_delay_days, 0);
    const overdueRatio = toNumber(metrics.overdue_ratio, 0);
    const riskScore = toNumber(entity.risk_score, 0);

    // ── Rule R1: Effective lead time extension ───────────────────────────────
    const triggerP90 = p90DelayDays > config.lead_time_p90_delay_threshold;
    const triggerOverdue = overdueRatio > config.overdue_ratio_threshold;

    if (triggerP90 || triggerOverdue) {
      const leadTimeDelta = Math.ceil(p90DelayDays);  // conservative round-up
      leadTimeDeltaByKey[key] = Math.max(leadTimeDeltaByKey[key] || 0, leadTimeDelta);

      const evidenceRefs = [];
      if (triggerP90) evidenceRefs.push(`p90_delay_days=${p90DelayDays.toFixed(2)}`);
      if (triggerOverdue) evidenceRefs.push(`overdue_ratio=${overdueRatio.toFixed(4)}`);

      rules.push({
        rule_id: 'R1_lead_time_p90_delay',
        description: 'Extend effective lead time by ceil(p90_delay_days) when supply delay risk is high.',
        applies_to: { sku: materialCode, plant_id: plantId || null },
        params_delta: { lead_time_days_added: leadTimeDelta },
        evidence_refs: evidenceRefs
      });
    }

    // ── Rule R2: Stockout penalty multiplier ─────────────────────────────────
    if (riskScore > config.high_risk_score_threshold) {
      // Normalize risk score to [0, 1] range using a simple sigmoid-like cap at 3x threshold
      const normalizedRisk = Math.min(1.0, riskScore / (config.high_risk_score_threshold * 3));
      const multiplier = 1 + config.stockout_penalty_beta * normalizedRisk;
      const existing = penaltyMultiplierByKey[key] || 1.0;
      penaltyMultiplierByKey[key] = Math.max(existing, Number(multiplier.toFixed(6)));

      rules.push({
        rule_id: 'R2_stockout_penalty_uplift',
        description: 'Increase stockout penalty multiplier for high-risk SKU/supplier combinations.',
        applies_to: { sku: materialCode, plant_id: plantId || null },
        params_delta: { stockout_penalty_multiplier: penaltyMultiplierByKey[key] },
        evidence_refs: [`risk_score=${riskScore.toFixed(2)}`, `threshold=${config.high_risk_score_threshold}`]
      });
    }

    // ── Rule R3: Safety stock violation penalty multiplier ─────────────────
    if (riskScore > config.high_risk_score_threshold) {
      const normalizedRisk = Math.min(1.0, riskScore / (config.high_risk_score_threshold * 3));
      const ssMultiplier = 1 + (config.ss_penalty_beta || 0.8) * normalizedRisk;
      const existingSS = ssPenaltyMultiplierByKey[key] || 1.0;
      ssPenaltyMultiplierByKey[key] = Math.max(existingSS, Number(ssMultiplier.toFixed(6)));

      rules.push({
        rule_id: 'R3_safety_stock_penalty_uplift',
        description: 'Increase safety stock violation penalty for high-risk SKU/supplier.',
        applies_to: { sku: materialCode, plant_id: plantId || null },
        params_delta: { safety_stock_penalty_multiplier: ssPenaltyMultiplierByKey[key] },
        evidence_refs: [`risk_score=${riskScore.toFixed(2)}`, `threshold=${config.high_risk_score_threshold}`]
      });
    }

    // ── Rule R4: Dual sourcing preference ─────────────────────────────────
    if (riskScore > (config.critical_risk_score_threshold || 120)) {
      dualSourceKeys.push(key);

      rules.push({
        rule_id: 'R4_dual_source_preference',
        description: 'Prefer dual sourcing for critically high-risk SKU/supplier.',
        applies_to: { sku: materialCode, plant_id: plantId || null },
        params_delta: { dual_source: true },
        evidence_refs: [
          `risk_score=${riskScore.toFixed(2)}`,
          `threshold=${config.critical_risk_score_threshold || 120}`
        ]
      });
    }

    // ── Rule R5: Expedite mode ────────────────────────────────────────────
    const triggerExpedite = riskScore > (config.expedite_risk_score_threshold || 100)
      && p90DelayDays > config.lead_time_p90_delay_threshold;

    if (triggerExpedite) {
      expediteKeys.push(key);

      rules.push({
        rule_id: 'R5_expedite_mode',
        description: 'Enable expedite: reduce lead time with cost premium for high-risk delayed SKU.',
        applies_to: { sku: materialCode, plant_id: plantId || null },
        params_delta: {
          expedite: true,
          lead_time_reduction_days: config.expedite_lead_time_reduction_days || 3,
          cost_multiplier: config.expedite_cost_multiplier || 1.25
        },
        evidence_refs: [
          `risk_score=${riskScore.toFixed(2)}`,
          `p90_delay_days=${p90DelayDays.toFixed(2)}`
        ]
      });
    }
  });

  // Count impacted SKUs
  const impactedKeys = new Set([
    ...Object.keys(leadTimeDeltaByKey),
    ...Object.keys(penaltyMultiplierByKey),
    ...Object.keys(ssPenaltyMultiplierByKey),
    ...dualSourceKeys,
    ...expediteKeys
  ]);
  const numImpactedSkus = impactedKeys.size;

  // Top risks: up to 5 highest risk_score entities
  const topRisks = sortedRows
    .filter((e) => toNumber(e.risk_score, 0) > 0)
    .sort((a, b) => toNumber(b.risk_score, 0) - toNumber(a.risk_score, 0))
    .slice(0, 5)
    .map((e) => ({
      sku: normalizeText(e.material_code || e.entity_id),
      plant_id: normalizeText(e.plant_id) || null,
      risk_score: toNumber(e.risk_score, 0),
      p90_delay_days: toNumber((e.metrics || {}).p90_delay_days, null),
      overdue_ratio: toNumber((e.metrics || {}).overdue_ratio, null)
    }));

  // Demand uplift alpha: elevate if any impacted SKUs exist
  const effectiveDemandUpliftAlpha = numImpactedSkus > 0
    ? config.high_risk_demand_uplift_alpha
    : config.demand_uplift_alpha;

  return {
    version: 'v0',
    mode: 'risk_aware',
    generated_at: generatedAt,
    config: {
      lead_time_p90_delay_threshold: config.lead_time_p90_delay_threshold,
      overdue_ratio_threshold: config.overdue_ratio_threshold,
      stockout_penalty_beta: config.stockout_penalty_beta,
      safety_stock_alpha: config.safety_stock_alpha,
      demand_uplift_alpha: effectiveDemandUpliftAlpha
    },
    rules,
    adjusted_params: {
      lead_time_days: sortedObject(leadTimeDeltaByKey),      // key → delta days to ADD
      stockout_penalty_multiplier: sortedObject(penaltyMultiplierByKey),  // key → multiplier
      safety_stock_penalty_multiplier: sortedObject(ssPenaltyMultiplierByKey), // key → SS penalty multiplier
      safety_stock_alpha: config.safety_stock_alpha,
      demand_uplift_alpha: effectiveDemandUpliftAlpha,
      dual_source_keys: [...new Set(dualSourceKeys)].sort(),
      dual_source_min_split_fraction: config.dual_source_min_split_fraction,
      expedite_keys: [...new Set(expediteKeys)].sort(),
      expedite_lead_time_reduction_days: config.expedite_lead_time_reduction_days,
      expedite_cost_multiplier: config.expedite_cost_multiplier
    },
    summary: {
      num_impacted_skus: numImpactedSkus,
      top_risks: topRisks
    }
  };
}

/**
 * applyRiskAdjustmentsToInventory
 *
 * Apply lead-time deltas from risk_adjustments to inventory rows,
 * producing new rows with effective_lead_time_days filled in.
 *
 * @param {Array}  inventoryRows      - Base inventory rows
 * @param {Object} adjustedParams     - risk_adjustments.adjusted_params
 * @returns {Array} adjusted inventory rows (original rows are not mutated)
 */
export function applyRiskAdjustmentsToInventory(inventoryRows = [], adjustedParams = {}) {
  const leadTimeDeltaByKey = adjustedParams.lead_time_days || {};

  return inventoryRows.map((row) => {
    const key = toSkuKey(row.sku, row.plant_id);
    const delta = toNumber(leadTimeDeltaByKey[key], 0);

    if (delta === 0) return row;

    const baseLead = toNumber(row.lead_time_days, 0);
    return {
      ...row,
      lead_time_days: baseLead + delta,
      lead_time_days_base: baseLead,
      lead_time_days_risk_delta: delta
    };
  });
}

/**
 * applyRiskAdjustmentsToObjective
 *
 * Apply per-SKU penalty multipliers to produce an effective objective config.
 * Since the heuristic solver uses a single global stockout_penalty, we take
 * the maximum multiplier across all impacted SKUs as the effective global value.
 *
 * @param {Object} objective        - Base objective config
 * @param {Object} adjustedParams   - risk_adjustments.adjusted_params
 * @returns {Object} effective objective with updated stockout_penalty
 */
export function applyRiskAdjustmentsToObjective(objective = {}, adjustedParams = {}) {
  const multiplierByKey = adjustedParams.stockout_penalty_multiplier || {};
  const multipliers = Object.values(multiplierByKey).map((v) => toNumber(v, 1.0));
  const maxMultiplier = multipliers.length > 0 ? Math.max(...multipliers) : 1.0;

  const basePenalty = toNumber(objective.stockout_penalty, 1);
  const effectivePenalty = Number((basePenalty * maxMultiplier).toFixed(6));

  return {
    ...objective,
    stockout_penalty: effectivePenalty,
    stockout_penalty_base: basePenalty,
    stockout_penalty_multiplier_applied: Number(maxMultiplier.toFixed(6))
  };
}

/**
 * applyRiskAdjustmentsToSafetyStockPenalty
 *
 * Apply per-SKU safety stock penalty multipliers to the objective.
 * Since the MILP solver also reads per-SKU multipliers via risk_signals,
 * this sets the global safety_stock_violation_penalty using the max multiplier
 * as a conservative fallback for the heuristic solver path.
 *
 * @param {Object} objective        - Base objective config
 * @param {Object} adjustedParams   - risk_adjustments.adjusted_params
 * @returns {Object} effective objective with updated safety_stock_violation_penalty
 */
export function applyRiskAdjustmentsToSafetyStockPenalty(objective = {}, adjustedParams = {}) {
  const multiplierByKey = adjustedParams.safety_stock_penalty_multiplier || {};
  const multipliers = Object.values(multiplierByKey).map((v) => toNumber(v, 1.0));
  const maxMultiplier = multipliers.length > 0 ? Math.max(...multipliers) : 1.0;

  const basePenalty = toNumber(objective.safety_stock_violation_penalty, 10.0);
  const effectivePenalty = Number((basePenalty * maxMultiplier).toFixed(6));

  return {
    ...objective,
    safety_stock_violation_penalty: effectivePenalty,
    safety_stock_violation_penalty_base: basePenalty,
    safety_stock_penalty_multiplier_applied: Number(maxMultiplier.toFixed(6))
  };
}

/**
 * applyDemandUplift
 *
 * Blend p50 and p90 demand using demand_uplift_alpha:
 *   demand_eff[t] = p50[t] + alpha * max(0, p90[t] - p50[t])
 *
 * @param {Array}  forecastSeries    - Base demand series [{sku, plant_id, date, p50, p90}]
 * @param {number} alpha             - Uplift fraction [0, 1]
 * @returns {Array} adjusted demand series (original series is not mutated)
 */
export function applyDemandUplift(forecastSeries = [], alpha = 0) {
  if (!alpha || alpha <= 0) return forecastSeries;

  return forecastSeries.map((point) => {
    const p50 = toNumber(point.p50, 0);
    const p90 = point.p90 !== null && point.p90 !== undefined ? toNumber(point.p90, p50) : p50;
    const uplift = Math.max(0, alpha * (p90 - p50));
    const effectiveP50 = p50 + uplift;

    if (uplift === 0) return point;

    return {
      ...point,
      p50: Number(effectiveP50.toFixed(6)),
      p50_base: p50,
      p50_uplift: Number(uplift.toFixed(6))
    };
  });
}

/**
 * buildPlanComparison
 *
 * Compare base plan vs risk-aware plan KPIs and produce a structured diff.
 *
 * @param {Object} params
 * @param {number|string} params.baseRunId
 * @param {number|string} params.riskRunId
 * @param {Object} params.baseReplayMetrics    - replay_metrics from base plan
 * @param {Object} params.riskReplayMetrics    - replay_metrics from risk-aware plan
 * @param {Object} params.baseKpis             - solver_result.kpis from base plan
 * @param {Object} params.riskKpis             - solver_result.kpis from risk-aware plan
 * @param {Array}  params.basePlanRows         - normalized plan rows from base
 * @param {Array}  params.riskPlanRows         - normalized plan rows from risk-aware
 * @param {Object} params.riskAdjustments      - the risk_adjustments artifact
 *
 * @returns {Object} plan_comparison artifact payload
 */
export function buildPlanComparison({
  baseRunId,
  riskRunId,
  baseReplayMetrics = {},
  riskReplayMetrics = {},
  baseKpis = {},
  riskKpis = {},
  basePlanRows = [],
  riskPlanRows = [],
  riskAdjustments = {}
} = {}) {
  const safeNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

  const baseMetrics = {
    service_level: safeNum(baseReplayMetrics?.with_plan?.service_level_proxy),
    stockout_units: safeNum(baseReplayMetrics?.with_plan?.stockout_units),
    holding_units: safeNum(baseReplayMetrics?.with_plan?.holding_units),
    estimated_total_cost: safeNum(baseKpis?.estimated_total_cost),
    total_plan_rows: basePlanRows.length
  };

  const riskMetrics = {
    service_level: safeNum(riskReplayMetrics?.with_plan?.service_level_proxy),
    stockout_units: safeNum(riskReplayMetrics?.with_plan?.stockout_units),
    holding_units: safeNum(riskReplayMetrics?.with_plan?.holding_units),
    estimated_total_cost: safeNum(riskKpis?.estimated_total_cost),
    total_plan_rows: riskPlanRows.length
  };

  const delta = {};
  Object.keys(baseMetrics).forEach((k) => {
    const b = baseMetrics[k];
    const r = riskMetrics[k];
    delta[k] = (b !== null && r !== null) ? Number((r - b).toFixed(6)) : null;
  });

  // Key changes: per-SKU order quantity diffs for impacted SKUs
  const baseQtyBySku = new Map();
  basePlanRows.forEach((row) => {
    const key = `${row.sku}|${row.plant_id || ''}`;
    baseQtyBySku.set(key, (baseQtyBySku.get(key) || 0) + toNumber(row.order_qty, 0));
  });

  const riskQtyBySku = new Map();
  riskPlanRows.forEach((row) => {
    const key = `${row.sku}|${row.plant_id || ''}`;
    riskQtyBySku.set(key, (riskQtyBySku.get(key) || 0) + toNumber(row.order_qty, 0));
  });

  const allKeys = new Set([...baseQtyBySku.keys(), ...riskQtyBySku.keys()]);
  const keyChanges = [];

  Array.from(allKeys).sort().forEach((key) => {
    const baseQty = baseQtyBySku.get(key) || 0;
    const riskQty = riskQtyBySku.get(key) || 0;
    const diff = Number((riskQty - baseQty).toFixed(6));
    if (Math.abs(diff) < 1e-9) return;  // no change

    const [sku, plantId] = key.split('|');

    // Find which rules fired for this SKU
    const adjustments = riskAdjustments?.rules || [];
    const evidenceRefs = adjustments
      .filter((r) => r.applies_to?.sku === sku)
      .map((r) => `${r.rule_id}: ${r.evidence_refs.join(', ')}`);

    keyChanges.push({
      sku,
      plant_id: plantId || null,
      metric: 'total_order_qty',
      base_value: Number(baseQty.toFixed(6)),
      risk_value: Number(riskQty.toFixed(6)),
      delta: diff,
      reason_refs: evidenceRefs
    });
  });

  // Sort by absolute delta descending
  keyChanges.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return {
    version: 'v0',
    generated_at: new Date().toISOString(),
    base_run_id: baseRunId || null,
    risk_run_id: riskRunId || null,
    kpis: {
      base: baseMetrics,
      risk: riskMetrics,
      delta
    },
    key_changes: keyChanges.slice(0, 50)
  };
}

export default {
  RISK_ADJ_CONFIG,
  computeRiskAdjustments,
  applyRiskAdjustmentsToInventory,
  applyRiskAdjustmentsToObjective,
  applyRiskAdjustmentsToSafetyStockPenalty,
  applyDemandUplift,
  buildPlanComparison
};
