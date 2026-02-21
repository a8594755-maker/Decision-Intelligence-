/**
 * riskClosedLoopService.js
 *
 * Bridge layer: Workflow B (risk_scores) → Closed-Loop Recommendation → Solver Re-plan
 *
 * Purpose:
 *   1. After Workflow B completes, evaluate whether Workflow A re-plan is needed
 *   2. Produce a "risk replan recommendation card" for the chat thread
 *   3. After user approval, re-run solver with adjusted safety_stock params
 *
 * Design:
 *   - Does NOT modify Workflow B logic
 *   - Does NOT directly trigger auto replan (requires user approval)
 *   - All decision logic lives in pure functions for easy testing
 */

// ── Trigger thresholds ───────────────────────────────────────────────────────

const RISK_REPLAN_CONFIG = {
  high_risk_score_threshold: 60,
  min_high_risk_skus: 1,
  critical_risk_score_threshold: 80,
  cooldown_ms: 30 * 60 * 1000, // 30 minutes
};

// ── Pure Functions ───────────────────────────────────────────────────────────

/**
 * Analyse risk_scores and decide whether a re-plan is warranted.
 *
 * @param {Array}  riskScores - Workflow B risk_scores rows
 * @param {Object} config     - Trigger threshold overrides
 * @returns {{ shouldReplan: boolean, highRiskSkus: Array, criticalRiskSkus: Array, maxScore: number }}
 */
export function analyzeRiskForReplan(riskScores = [], config = RISK_REPLAN_CONFIG) {
  const rows = Array.isArray(riskScores) ? riskScores : [];

  const highRiskSkus = rows.filter(
    (r) => Number(r.risk_score ?? r.riskScore ?? 0) > config.high_risk_score_threshold
  );
  const criticalRiskSkus = rows.filter(
    (r) => Number(r.risk_score ?? r.riskScore ?? 0) > config.critical_risk_score_threshold
  );
  const maxScore = rows.reduce(
    (max, r) => Math.max(max, Number(r.risk_score ?? r.riskScore ?? 0)),
    0
  );

  const shouldReplan = highRiskSkus.length >= config.min_high_risk_skus;

  return { shouldReplan, highRiskSkus, criticalRiskSkus, maxScore };
}

/**
 * Derive recommended safety_stock parameters from the risk analysis.
 *
 * @param {{ highRiskSkus, criticalRiskSkus, maxScore }} analysis
 * @returns {{ safety_stock_alpha: number, stockout_penalty_multiplier: number, reason: string }}
 */
export function deriveReplanParams(analysis) {
  const { highRiskSkus, criticalRiskSkus, maxScore } = analysis;

  let safety_stock_alpha = 0.8;
  let stockout_penalty_multiplier = 1.3;
  let reason = '';

  if (criticalRiskSkus.length > 0) {
    safety_stock_alpha = 1.2;
    stockout_penalty_multiplier = 1.6;
    reason = `${criticalRiskSkus.length} SKU(s) with risk score above ${RISK_REPLAN_CONFIG.critical_risk_score_threshold} (max ${maxScore.toFixed(0)}). Recommend significantly increasing safety stock.`;
  } else if (highRiskSkus.length > 2) {
    safety_stock_alpha = 1.0;
    stockout_penalty_multiplier = 1.4;
    reason = `${highRiskSkus.length} SKU(s) with risk score above ${RISK_REPLAN_CONFIG.high_risk_score_threshold} (max ${maxScore.toFixed(0)}). Recommend increasing safety stock.`;
  } else {
    safety_stock_alpha = 0.8;
    stockout_penalty_multiplier = 1.2;
    reason = `${highRiskSkus.length} SKU(s) with risk score above ${RISK_REPLAN_CONFIG.high_risk_score_threshold} (max ${maxScore.toFixed(0)}). Recommend moderate safety stock adjustment.`;
  }

  return { safety_stock_alpha, stockout_penalty_multiplier, reason };
}

/**
 * Rough benefit estimate for the recommendation card display.
 *
 * @param {Array}  highRiskSkus
 * @param {Object} params - { safety_stock_alpha, stockout_penalty_multiplier }
 * @returns {{ estimated_stockout_reduction_pct, estimated_holding_cost_increase_usd, estimated_stockout_avoidance_usd, estimated_net_benefit_usd }}
 */
export function estimateReplanBenefit(highRiskSkus = [], params = {}) {
  const count = highRiskSkus.length;
  const avgImpactUsd =
    highRiskSkus.reduce(
      (sum, r) => sum + Number(r.impact_usd ?? r.impactUsd ?? 0),
      0
    ) / Math.max(count, 1);

  const stockoutReductionPct = Math.min(
    ((params.safety_stock_alpha ?? 0.8) - 0.5) * 30, // 0.5→0%, 1.2→21%
    35
  );

  const holdingCostIncrease = count * avgImpactUsd * 0.05;
  const stockoutAvoidance = count * avgImpactUsd * (stockoutReductionPct / 100);
  const netBenefitUsd = stockoutAvoidance - holdingCostIncrease;

  return {
    estimated_stockout_reduction_pct: Math.round(stockoutReductionPct * 10) / 10,
    estimated_holding_cost_increase_usd: Math.round(holdingCostIncrease),
    estimated_stockout_avoidance_usd: Math.round(stockoutAvoidance),
    estimated_net_benefit_usd: Math.round(netBenefitUsd),
  };
}

/**
 * Build the full recommendation card payload.
 *
 * @returns {{ type: string, payload: Object }}
 */
export function buildRiskReplanRecommendationCard({
  riskRunId,
  planRunId,
  datasetProfileId,
  analysis,
  replanParams,
  benefit,
}) {
  const { highRiskSkus, criticalRiskSkus, maxScore } = analysis;
  const { safety_stock_alpha, stockout_penalty_multiplier, reason } = replanParams;

  return {
    type: 'risk_replan_recommendation_card',
    payload: {
      trigger: {
        source_risk_run_id: riskRunId,
        base_plan_run_id: planRunId,
        dataset_profile_id: datasetProfileId,
        high_risk_sku_count: highRiskSkus.length,
        critical_risk_sku_count: criticalRiskSkus.length,
        max_risk_score: Math.round(maxScore * 10) / 10,
        high_risk_skus: highRiskSkus.slice(0, 5).map((r) => ({
          sku: r.material_code ?? r.materialCode ?? r.sku ?? 'unknown',
          plant_id: r.plant_id ?? r.plantId ?? null,
          risk_score: Math.round(Number(r.risk_score ?? r.riskScore ?? 0) * 10) / 10,
          p_stockout: Math.round(Number(r.p_stockout ?? r.pStockout ?? 0) * 100) / 100,
          impact_usd: Math.round(Number(r.impact_usd ?? r.impactUsd ?? 0)),
        })),
      },
      recommended_params: {
        safety_stock_alpha,
        stockout_penalty_multiplier,
        reason,
      },
      benefit,
      decision_options: [
        {
          id: 'approve_replan',
          label: 'Approve Re-plan',
          description: `Re-run solver with safety_stock_alpha=${safety_stock_alpha}`,
          action: 'replan_with_risk_params',
          params: { safety_stock_alpha, stockout_penalty_multiplier, risk_mode: 'on' },
          variant: 'primary',
        },
        {
          id: 'approve_conservative',
          label: 'Conservative Re-plan',
          description: 'Re-run solver with maximum protection (safety_stock_alpha=1.5)',
          action: 'replan_with_risk_params',
          params: { safety_stock_alpha: 1.5, stockout_penalty_multiplier: 2.0, risk_mode: 'on' },
          variant: 'warning',
        },
        {
          id: 'dismiss',
          label: 'Dismiss',
          description: 'Keep current plan, ignore risk recommendation',
          action: 'dismiss_risk_replan',
          params: {},
          variant: 'secondary',
        },
      ],
      status: 'pending',
      generated_at: new Date().toISOString(),
    },
  };
}

/**
 * Main entry point — call after Workflow B completes.
 *
 * Evaluates whether a re-plan is warranted and returns the recommendation card
 * payload if so. Does NOT trigger re-plan directly (UI user approval required).
 *
 * @param {Object} params
 * @returns {{ shouldReplan: boolean, recommendationCard: Object|null, analysis, replanParams, benefit }}
 */
export function evaluateRiskReplanRecommendation({
  userId,
  datasetProfileId,
  riskRunId,
  riskScores = [],
  planRunId = null,
  config = RISK_REPLAN_CONFIG,
}) {
  const analysis = analyzeRiskForReplan(riskScores, config);

  if (!analysis.shouldReplan) {
    return { shouldReplan: false, recommendationCard: null, analysis };
  }

  const replanParams = deriveReplanParams(analysis);
  const benefit = estimateReplanBenefit(analysis.highRiskSkus, replanParams);

  const recommendationCard = buildRiskReplanRecommendationCard({
    riskRunId,
    planRunId,
    datasetProfileId,
    analysis,
    replanParams,
    benefit,
  });

  return { shouldReplan: true, recommendationCard, analysis, replanParams, benefit };
}
