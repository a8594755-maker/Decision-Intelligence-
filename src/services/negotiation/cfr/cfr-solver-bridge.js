/**
 * CFR → Solver Parameter Bridge
 *
 * Translates CFR game-theory strategy (supplier type probability distribution)
 * into concrete solver parameter adjustments. This bridges the gap between
 * "what the game theory says about the supplier" and "how the planning solver
 * should behave given that insight."
 *
 * Key insight:
 *   - P(DESPERATE) high → buyer has leverage → lower safety stock (save cost)
 *   - P(AGGRESSIVE) high → supplier will hardball → raise safety stock + flag dual-source
 *   - Otherwise → no adjustment (baseline parameters)
 *
 * All adjustments are multiplicative/additive to avoid coupling with absolute values.
 */

import { SUPPLIER_TYPES } from './negotiation-types.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const BRIDGE_CONFIG = Object.freeze({
  /** Minimum P(DESPERATE) to trigger cost-saving adjustments */
  DESPERATE_THRESHOLD: 0.40,
  /** Minimum P(AGGRESSIVE) to trigger defensive adjustments */
  AGGRESSIVE_THRESHOLD: 0.50,

  /** Safety stock alpha multiplier when supplier is desperate (reduce) */
  DESPERATE_ALPHA_MULTIPLIER: 0.70,
  /** Safety stock alpha multiplier when supplier is aggressive (increase) */
  AGGRESSIVE_ALPHA_MULTIPLIER: 1.30,

  /** Stockout penalty multiplier when supplier is aggressive */
  AGGRESSIVE_PENALTY_MULTIPLIER: 1.20,

  /** Position bucket thresholds for scaling adjustments */
  STRONG_BUCKET_MIN: 3,  // STRONG or VERY_STRONG → amplify desperate savings
  WEAK_BUCKET_MAX: 1,    // WEAK or VERY_WEAK → amplify aggressive defense
});

// ---------------------------------------------------------------------------
// Core bridge function
// ---------------------------------------------------------------------------

/**
 * Derive solver parameter adjustments from CFR strategy output.
 *
 * @param {Object} params
 * @param {Object} params.cfrActionProbs - { accept: number, reject: number, counter: number }
 * @param {Object} params.supplierTypePriors - { AGGRESSIVE: number, COOPERATIVE: number, DESPERATE: number }
 * @param {number} params.positionBucket - 0–4 (VERY_WEAK → VERY_STRONG)
 * @param {Object} [params.config] - optional config overrides
 * @returns {{
 *   safety_stock_alpha_multiplier: number,
 *   stockout_penalty_multiplier: number,
 *   dual_source_flag: boolean,
 *   adjustment_reason: string,
 *   supplier_assessment: string,
 *   confidence: number
 * }}
 */
export function deriveSolverParamsFromStrategy({
  cfrActionProbs = {},
  supplierTypePriors = {},
  positionBucket = 2,
  config = {},
} = {}) {
  const cfg = { ...BRIDGE_CONFIG, ...config };

  const pDesperate = Number(supplierTypePriors[SUPPLIER_TYPES.DESPERATE]) || 0;
  const pAggressive = Number(supplierTypePriors[SUPPLIER_TYPES.AGGRESSIVE]) || 0;
  const pCooperative = Number(supplierTypePriors[SUPPLIER_TYPES.COOPERATIVE]) || 0;
  const bucket = Number.isFinite(positionBucket) ? positionBucket : 2;

  // Default: no adjustment
  let alphaMultiplier = 1.0;
  let penaltyMultiplier = 1.0;
  let dualSourceFlag = false;
  let reason = 'no_adjustment';
  let assessment = 'cooperative';
  let confidence = 0;

  // Case 1: Supplier likely DESPERATE → reduce safety stock (cost saving)
  if (pDesperate >= cfg.DESPERATE_THRESHOLD && pDesperate > pAggressive) {
    alphaMultiplier = cfg.DESPERATE_ALPHA_MULTIPLIER;
    reason = `supplier_desperate (P=${pDesperate.toFixed(2)})`;
    assessment = 'desperate';
    confidence = pDesperate;

    // Amplify savings if buyer has strong position
    if (bucket >= cfg.STRONG_BUCKET_MIN) {
      const extraReduction = (bucket - cfg.STRONG_BUCKET_MIN + 1) * 0.05;
      alphaMultiplier = Math.max(0.50, alphaMultiplier - extraReduction);
      reason += `, strong_position (bucket=${bucket})`;
    }
  }

  // Case 2: Supplier likely AGGRESSIVE → raise safety stock + flag dual-source
  else if (pAggressive >= cfg.AGGRESSIVE_THRESHOLD && pAggressive > pDesperate) {
    alphaMultiplier = cfg.AGGRESSIVE_ALPHA_MULTIPLIER;
    penaltyMultiplier = cfg.AGGRESSIVE_PENALTY_MULTIPLIER;
    dualSourceFlag = true;
    reason = `supplier_aggressive (P=${pAggressive.toFixed(2)})`;
    assessment = 'aggressive';
    confidence = pAggressive;

    // Amplify defense if buyer has weak position
    if (bucket <= cfg.WEAK_BUCKET_MAX) {
      const extraIncrease = (cfg.WEAK_BUCKET_MAX - bucket + 1) * 0.05;
      alphaMultiplier = Math.min(1.60, alphaMultiplier + extraIncrease);
      reason += `, weak_position (bucket=${bucket})`;
    }
  }

  // Case 3: Cooperative or mixed → no adjustment
  else {
    confidence = pCooperative;
    reason = 'supplier_cooperative_or_mixed';
    assessment = pCooperative > 0.5 ? 'cooperative' : 'mixed';
  }

  // Use CFR action probabilities as secondary confidence signal
  const acceptProb = Number(cfrActionProbs?.accept) || 0;
  if (acceptProb > 0.7 && assessment === 'desperate') {
    // High accept prob confirms desperate assessment
    confidence = Math.min(1.0, confidence + 0.1);
  }

  return {
    safety_stock_alpha_multiplier: round4(alphaMultiplier),
    stockout_penalty_multiplier: round4(penaltyMultiplier),
    dual_source_flag: dualSourceFlag,
    adjustment_reason: reason,
    supplier_assessment: assessment,
    confidence: round4(confidence),
  };
}

// ---------------------------------------------------------------------------
// Apply adjustments to solver parameters
// ---------------------------------------------------------------------------

/**
 * Apply CFR-derived adjustments to concrete solver parameters.
 *
 * @param {Object} baseParams - original solver parameters
 * @param {number} baseParams.safety_stock_alpha - e.g. 0.5
 * @param {number} baseParams.stockout_penalty_base - e.g. 10.0
 * @param {Object} adjustment - from deriveSolverParamsFromStrategy()
 * @returns {{ safety_stock_alpha: number, stockout_penalty_base: number, dual_source_flag: boolean, cfr_adjusted: boolean }}
 */
export function applyCfrAdjustments(baseParams = {}, adjustment = {}) {
  const alpha = Number(baseParams.safety_stock_alpha) || 0.5;
  const penalty = Number(baseParams.stockout_penalty_base) || 10.0;

  const alphaMultiplier = Number(adjustment.safety_stock_alpha_multiplier) || 1.0;
  const penaltyMultiplier = Number(adjustment.stockout_penalty_multiplier) || 1.0;

  return {
    safety_stock_alpha: round4(alpha * alphaMultiplier),
    stockout_penalty_base: round4(penalty * penaltyMultiplier),
    dual_source_flag: Boolean(adjustment.dual_source_flag),
    cfr_adjusted: alphaMultiplier !== 1.0 || penaltyMultiplier !== 1.0,
  };
}

// ---------------------------------------------------------------------------
// Build audit artifact payload
// ---------------------------------------------------------------------------

/**
 * Build the cfr_param_adjustment artifact payload for audit trail.
 *
 * @param {Object} params
 * @param {Object} params.adjustment - from deriveSolverParamsFromStrategy()
 * @param {Object} params.baseParams - original solver parameters
 * @param {Object} params.adjustedParams - from applyCfrAdjustments()
 * @param {Object} params.cfrEnrichment - from orchestrator step 3.5
 * @param {number} params.planRunId
 * @returns {Object} artifact payload
 */
export function buildAdjustmentArtifact({
  adjustment,
  baseParams,
  adjustedParams,
  cfrEnrichment,
  planRunId,
} = {}) {
  return {
    version: 'v0',
    generated_at: new Date().toISOString(),
    plan_run_id: planRunId,
    scenario_id: cfrEnrichment?.scenario_id || null,
    buyer_bucket: cfrEnrichment?.buyer_bucket ?? null,
    cfr_source: cfrEnrichment?.source || null,
    supplier_assessment: adjustment?.supplier_assessment || 'unknown',
    confidence: adjustment?.confidence ?? 0,
    adjustment_reason: adjustment?.adjustment_reason || 'none',
    base_params: {
      safety_stock_alpha: baseParams?.safety_stock_alpha ?? null,
      stockout_penalty_base: baseParams?.stockout_penalty_base ?? null,
    },
    adjusted_params: {
      safety_stock_alpha: adjustedParams?.safety_stock_alpha ?? null,
      stockout_penalty_base: adjustedParams?.stockout_penalty_base ?? null,
      dual_source_flag: adjustedParams?.dual_source_flag ?? false,
    },
    multipliers: {
      safety_stock_alpha_multiplier: adjustment?.safety_stock_alpha_multiplier ?? 1.0,
      stockout_penalty_multiplier: adjustment?.stockout_penalty_multiplier ?? 1.0,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

export default {
  deriveSolverParamsFromStrategy,
  applyCfrAdjustments,
  buildAdjustmentArtifact,
  BRIDGE_CONFIG,
};
