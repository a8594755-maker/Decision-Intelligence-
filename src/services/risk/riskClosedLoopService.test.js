/**
 * Unit tests for riskClosedLoopService — pure function tests, no external deps.
 */

import { describe, it, expect } from 'vitest';
import {
  analyzeRiskForReplan,
  deriveReplanParams,
  estimateReplanBenefit,
  buildRiskReplanRecommendationCard,
  evaluateRiskReplanRecommendation,
} from './riskClosedLoopService.js';

const HIGH_RISK_SCORES = [
  { material_code: 'SKU-001', plant_id: 'P1', risk_score: 85, p_stockout: 0.72, impact_usd: 15000 },
  { material_code: 'SKU-002', plant_id: 'P1', risk_score: 65, p_stockout: 0.45, impact_usd: 8000 },
];

const LOW_RISK_SCORES = [
  { material_code: 'SKU-003', plant_id: 'P1', risk_score: 30, p_stockout: 0.10, impact_usd: 2000 },
  { material_code: 'SKU-004', plant_id: 'P2', risk_score: 25, p_stockout: 0.08, impact_usd: 1500 },
];

const MANY_HIGH_RISK = [
  { material_code: 'A', risk_score: 70, p_stockout: 0.5, impact_usd: 5000 },
  { material_code: 'B', risk_score: 72, p_stockout: 0.5, impact_usd: 5000 },
  { material_code: 'C', risk_score: 68, p_stockout: 0.4, impact_usd: 4000 },
  { material_code: 'D', risk_score: 75, p_stockout: 0.6, impact_usd: 6000 },
];

describe('analyzeRiskForReplan', () => {
  it('should trigger replan when high-risk SKUs exceed threshold', () => {
    const result = analyzeRiskForReplan(HIGH_RISK_SCORES);
    expect(result.shouldReplan).toBe(true);
    expect(result.highRiskSkus).toHaveLength(2);
    expect(result.criticalRiskSkus).toHaveLength(1); // SKU-001 > 80
    expect(result.maxScore).toBe(85);
  });

  it('should NOT trigger replan for low-risk SKUs', () => {
    const result = analyzeRiskForReplan(LOW_RISK_SCORES);
    expect(result.shouldReplan).toBe(false);
    expect(result.highRiskSkus).toHaveLength(0);
  });

  it('should NOT trigger replan for empty array', () => {
    expect(analyzeRiskForReplan([]).shouldReplan).toBe(false);
  });

  it('should NOT trigger replan for undefined/null', () => {
    expect(analyzeRiskForReplan(undefined).shouldReplan).toBe(false);
    expect(analyzeRiskForReplan(null).shouldReplan).toBe(false);
  });

  it('should support camelCase risk_score field name', () => {
    const rows = [{ materialCode: 'X', riskScore: 90 }];
    const result = analyzeRiskForReplan(rows);
    expect(result.shouldReplan).toBe(true);
    expect(result.maxScore).toBe(90);
  });
});

describe('deriveReplanParams', () => {
  it('should select max protection for critical SKUs (score > 80)', () => {
    const analysis = analyzeRiskForReplan(HIGH_RISK_SCORES);
    const params = deriveReplanParams(analysis);
    expect(params.safety_stock_alpha).toBe(1.2);
    expect(params.stockout_penalty_multiplier).toBe(1.6);
    expect(params.reason).toContain('80');
  });

  it('should select medium protection for >2 high-risk (non-critical) SKUs', () => {
    const analysis = analyzeRiskForReplan(MANY_HIGH_RISK);
    const params = deriveReplanParams(analysis);
    expect(params.safety_stock_alpha).toBe(1.0);
    expect(params.stockout_penalty_multiplier).toBe(1.4);
  });

  it('should select light protection for 1-2 high-risk SKUs', () => {
    const rows = [{ material_code: 'X', risk_score: 65 }];
    const analysis = analyzeRiskForReplan(rows);
    const params = deriveReplanParams(analysis);
    expect(params.safety_stock_alpha).toBe(0.8);
    expect(params.stockout_penalty_multiplier).toBe(1.2);
  });
});

describe('estimateReplanBenefit', () => {
  it('should return numeric estimates', () => {
    const benefit = estimateReplanBenefit(HIGH_RISK_SCORES, { safety_stock_alpha: 1.2 });
    expect(typeof benefit.estimated_stockout_reduction_pct).toBe('number');
    expect(typeof benefit.estimated_net_benefit_usd).toBe('number');
    expect(typeof benefit.estimated_holding_cost_increase_usd).toBe('number');
    expect(typeof benefit.estimated_stockout_avoidance_usd).toBe('number');
  });

  it('should handle empty input gracefully', () => {
    const benefit = estimateReplanBenefit([], {});
    expect(benefit.estimated_stockout_reduction_pct).toBeGreaterThanOrEqual(0);
  });
});

describe('buildRiskReplanRecommendationCard', () => {
  it('should produce a valid card payload', () => {
    const analysis = analyzeRiskForReplan(HIGH_RISK_SCORES);
    const replanParams = deriveReplanParams(analysis);
    const benefit = estimateReplanBenefit(analysis.highRiskSkus, replanParams);

    const card = buildRiskReplanRecommendationCard({
      riskRunId: 'run-001',
      planRunId: 'plan-001',
      datasetProfileId: 'profile-001',
      analysis,
      replanParams,
      benefit,
    });

    expect(card.type).toBe('risk_replan_recommendation_card');
    expect(card.payload.trigger.high_risk_sku_count).toBe(2);
    expect(card.payload.trigger.max_risk_score).toBeCloseTo(85, 0);
    expect(card.payload.decision_options).toHaveLength(3);
    expect(card.payload.status).toBe('pending');
    expect(card.payload.recommended_params.safety_stock_alpha).toBe(1.2);

    // Decision options structure
    const approveOpt = card.payload.decision_options.find(o => o.id === 'approve_replan');
    expect(approveOpt.action).toBe('replan_with_risk_params');
    expect(approveOpt.params.risk_mode).toBe('on');
  });

  it('should limit high_risk_skus to top 5', () => {
    const manyRows = Array.from({ length: 10 }, (_, i) => ({
      material_code: `SKU-${i}`,
      risk_score: 90 - i,
      p_stockout: 0.5,
      impact_usd: 1000,
    }));
    const analysis = analyzeRiskForReplan(manyRows);
    const card = buildRiskReplanRecommendationCard({
      riskRunId: 'r', planRunId: 'p', datasetProfileId: 'd',
      analysis,
      replanParams: deriveReplanParams(analysis),
      benefit: estimateReplanBenefit(analysis.highRiskSkus, deriveReplanParams(analysis)),
    });

    expect(card.payload.trigger.high_risk_skus.length).toBeLessThanOrEqual(5);
  });
});

describe('evaluateRiskReplanRecommendation', () => {
  it('should produce recommendation for high-risk scores', () => {
    const result = evaluateRiskReplanRecommendation({
      userId: 'user-001',
      datasetProfileId: 'profile-001',
      riskRunId: 'run-001',
      riskScores: HIGH_RISK_SCORES,
    });

    expect(result.shouldReplan).toBe(true);
    expect(result.recommendationCard).not.toBeNull();
    expect(result.recommendationCard.type).toBe('risk_replan_recommendation_card');
    expect(result.recommendationCard.payload.trigger.high_risk_sku_count).toBe(2);
    expect(result.recommendationCard.payload.decision_options).toHaveLength(3);
    expect(result.recommendationCard.payload.status).toBe('pending');
  });

  it('should NOT produce recommendation for low-risk scores', () => {
    const result = evaluateRiskReplanRecommendation({
      userId: 'user-001',
      datasetProfileId: 'profile-001',
      riskRunId: 'run-001',
      riskScores: LOW_RISK_SCORES,
    });

    expect(result.shouldReplan).toBe(false);
    expect(result.recommendationCard).toBeNull();
  });

  it('should accept planRunId for card payload', () => {
    const result = evaluateRiskReplanRecommendation({
      userId: 'user-001',
      datasetProfileId: 'profile-001',
      riskRunId: 'run-001',
      riskScores: HIGH_RISK_SCORES,
      planRunId: 'plan-999',
    });

    expect(result.recommendationCard.payload.trigger.base_plan_run_id).toBe('plan-999');
  });

  it('should include benefit estimates in the result', () => {
    const result = evaluateRiskReplanRecommendation({
      userId: 'u', datasetProfileId: 'p', riskRunId: 'r',
      riskScores: HIGH_RISK_SCORES,
    });

    expect(result.benefit).toBeDefined();
    expect(typeof result.benefit.estimated_net_benefit_usd).toBe('number');
  });
});
