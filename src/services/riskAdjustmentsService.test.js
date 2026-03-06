/**
 * Unit tests for riskAdjustmentsService.js
 *
 * Test cases:
 *   T1 – Low risk: no adjustments produced (rules array is empty)
 *   T2 – High p90_delay_days: lead time extended deterministically
 *   T3 – High overdue_ratio: lead time extended even with low p90_delay
 *   T4 – High risk_score: stockout penalty multiplier applied
 *   T5 – Multiple impacted SKUs: demand_uplift_alpha raised from default
 *   T6 – Determinism: identical inputs produce byte-identical JSON
 *   T7 – applyRiskAdjustmentsToInventory: lead_time_days correctly patched
 *   T8 – applyRiskAdjustmentsToObjective: penalty correctly multiplied
 *   T9 – applyDemandUplift: alpha=0 is a no-op; alpha>0 blends p90
 *   T10 – buildPlanComparison: key_changes sorted by |delta| desc
 */

import { describe, it, expect } from 'vitest';
import {
  computeRiskAdjustments,
  applyRiskAdjustmentsToInventory,
  applyRiskAdjustmentsToObjective,
  applyRiskAdjustmentsToSafetyStockPenalty,
  applyDemandUplift,
  buildPlanComparison,
  RISK_ADJ_CONFIG
} from './riskAdjustmentsService';

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const LOW_RISK_ENTITY = {
  entity_type: 'supplier_material',
  entity_id: 'MAT-001',
  material_code: 'MAT-001',
  plant_id: 'PLANT-A',
  risk_score: 10,
  metrics: {
    p90_delay_days: 1.0,
    overdue_ratio: 0.05,
    on_time_rate: 0.95,
    avg_delay_days: 0.5
  }
};

const HIGH_P90_ENTITY = {
  entity_type: 'supplier_material',
  entity_id: 'MAT-002',
  material_code: 'MAT-002',
  plant_id: 'PLANT-A',
  risk_score: 30,
  metrics: {
    p90_delay_days: 12.7,   // > threshold (5)
    overdue_ratio: 0.10,    // <= threshold (0.20)
    on_time_rate: 0.75,
    avg_delay_days: 7.0
  }
};

const HIGH_OVERDUE_ENTITY = {
  entity_type: 'supplier_material',
  entity_id: 'MAT-003',
  material_code: 'MAT-003',
  plant_id: 'PLANT-B',
  risk_score: 25,
  metrics: {
    p90_delay_days: 2.0,    // <= threshold (5)
    overdue_ratio: 0.45,    // > threshold (0.20)
    on_time_rate: 0.60,
    avg_delay_days: 3.5
  }
};

const HIGH_RISK_SCORE_ENTITY = {
  entity_type: 'supplier_material',
  entity_id: 'MAT-004',
  material_code: 'MAT-004',
  plant_id: 'PLANT-A',
  risk_score: 200,          // >> high_risk_score_threshold (60)
  metrics: {
    p90_delay_days: 2.0,
    overdue_ratio: 0.10,
    on_time_rate: 0.70,
    avg_delay_days: 2.5
  }
};

const CRITICAL_RISK_ENTITY = {
  entity_type: 'supplier_material',
  entity_id: 'MAT-005',
  material_code: 'MAT-005',
  plant_id: 'PLANT-A',
  risk_score: 150,          // > critical_risk_score_threshold (120), triggers dual source
  metrics: {
    p90_delay_days: 8.0,    // > lead_time_p90_delay_threshold (5)
    overdue_ratio: 0.30,
    on_time_rate: 0.55,
    avg_delay_days: 5.0
  }
};

const EXPEDITE_RISK_ENTITY = {
  entity_type: 'supplier_material',
  entity_id: 'MAT-006',
  material_code: 'MAT-006',
  plant_id: 'PLANT-B',
  risk_score: 110,          // > expedite_risk_score_threshold (100) but < 120
  metrics: {
    p90_delay_days: 9.5,    // > lead_time_p90_delay_threshold (5), triggers expedite
    overdue_ratio: 0.25,
    on_time_rate: 0.65,
    avg_delay_days: 6.0
  }
};

const HIGH_RISK_LOW_DELAY_ENTITY = {
  entity_type: 'supplier_material',
  entity_id: 'MAT-007',
  material_code: 'MAT-007',
  plant_id: 'PLANT-A',
  risk_score: 130,          // > expedite threshold but p90 delay is low
  metrics: {
    p90_delay_days: 3.0,    // <= lead_time_p90_delay_threshold (5), NO expedite
    overdue_ratio: 0.10,
    on_time_rate: 0.80,
    avg_delay_days: 1.5
  }
};

// ─── T1: Low risk → no adjustments ───────────────────────────────────────────

describe('computeRiskAdjustments', () => {
  it('T1: produces no rules and no adjustments for low-risk entities', () => {
    const result = computeRiskAdjustments({ riskScores: [LOW_RISK_ENTITY] });

    expect(result.version).toBe('v0');
    expect(result.mode).toBe('risk_aware');
    expect(result.rules).toHaveLength(0);
    expect(Object.keys(result.adjusted_params.lead_time_days)).toHaveLength(0);
    expect(Object.keys(result.adjusted_params.stockout_penalty_multiplier)).toHaveLength(0);
    expect(result.summary.num_impacted_skus).toBe(0);
    // demand_uplift_alpha stays at default (0.0) when no impacted SKUs
    expect(result.adjusted_params.demand_uplift_alpha).toBe(RISK_ADJ_CONFIG.demand_uplift_alpha);
  });

  // ─── T2: High p90_delay_days → lead time extended ──────────────────────────

  it('T2: extends lead time by ceil(p90_delay_days) when p90 threshold exceeded', () => {
    const result = computeRiskAdjustments({ riskScores: [HIGH_P90_ENTITY] });

    const key = 'MAT-002|PLANT-A';
    expect(result.adjusted_params.lead_time_days[key]).toBe(Math.ceil(12.7));  // 13

    const r1Rules = result.rules.filter((r) => r.rule_id === 'R1_lead_time_p90_delay');
    expect(r1Rules.length).toBeGreaterThan(0);
    expect(r1Rules[0].applies_to.sku).toBe('MAT-002');
    expect(r1Rules[0].params_delta.lead_time_days_added).toBe(13);
    expect(result.summary.num_impacted_skus).toBe(1);
  });

  // ─── T3: High overdue_ratio (but low p90) → lead time still extended ───────

  it('T3: extends lead time via overdue_ratio trigger even when p90_delay_days is low', () => {
    const result = computeRiskAdjustments({ riskScores: [HIGH_OVERDUE_ENTITY] });

    const key = 'MAT-003|PLANT-B';
    // p90_delay_days=2.0, so delta = ceil(2.0) = 2
    expect(result.adjusted_params.lead_time_days[key]).toBe(2);

    const r1Rules = result.rules.filter((r) => r.rule_id === 'R1_lead_time_p90_delay');
    expect(r1Rules.length).toBeGreaterThan(0);
    expect(r1Rules[0].evidence_refs.some((e) => e.includes('overdue_ratio'))).toBe(true);
  });

  // ─── T4: High risk_score → penalty multiplier applied ──────────────────────

  it('T4: applies stockout penalty multiplier for high risk_score entities', () => {
    const result = computeRiskAdjustments({ riskScores: [HIGH_RISK_SCORE_ENTITY] });

    const key = 'MAT-004|PLANT-A';
    const multiplier = result.adjusted_params.stockout_penalty_multiplier[key];
    expect(multiplier).toBeGreaterThan(1.0);
    expect(multiplier).toBeLessThanOrEqual(1 + RISK_ADJ_CONFIG.stockout_penalty_beta);

    const r2Rules = result.rules.filter((r) => r.rule_id === 'R2_stockout_penalty_uplift');
    expect(r2Rules.length).toBeGreaterThan(0);
  });

  // ─── T5: Multiple impacted SKUs → demand_uplift_alpha raised ─────────────

  it('T5: raises demand_uplift_alpha when impacted SKUs exist', () => {
    const result = computeRiskAdjustments({ riskScores: [HIGH_P90_ENTITY, HIGH_RISK_SCORE_ENTITY] });
    expect(result.summary.num_impacted_skus).toBeGreaterThan(0);
    expect(result.adjusted_params.demand_uplift_alpha).toBe(RISK_ADJ_CONFIG.high_risk_demand_uplift_alpha);
  });

  // ─── T6: Determinism ────────────────────────────────────────────────────────

  it('T6: identical inputs produce identical output (deterministic)', () => {
    const input = {
      riskScores: [HIGH_P90_ENTITY, HIGH_OVERDUE_ENTITY, HIGH_RISK_SCORE_ENTITY, LOW_RISK_ENTITY]
    };

    const result1 = computeRiskAdjustments(input);
    const result2 = computeRiskAdjustments(input);

    // Strip generated_at (timestamp) before comparing — everything else must match.
    const strip = (obj) => {
      const clone = JSON.parse(JSON.stringify(obj));
      delete clone.generated_at;
      return clone;
    };

    expect(strip(result1)).toEqual(strip(result2));
  });

  // ─── T6b: configOverrides are respected ─────────────────────────────────────

  it('T6b: config overrides change thresholds deterministically', () => {
    // Set lead_time_p90_delay_threshold to 0 → every entity triggers R1
    const resultDefault = computeRiskAdjustments({ riskScores: [LOW_RISK_ENTITY] });
    const resultLowThresh = computeRiskAdjustments({
      riskScores: [LOW_RISK_ENTITY],
      configOverrides: { lead_time_p90_delay_threshold: 0 }
    });

    expect(resultDefault.rules).toHaveLength(0);
    // LOW_RISK_ENTITY.p90_delay_days=1.0 > 0 → should fire
    expect(resultLowThresh.rules.filter((r) => r.rule_id === 'R1_lead_time_p90_delay')).toHaveLength(1);
  });
});

// ─── T7: applyRiskAdjustmentsToInventory ────────────────────────────────────

describe('applyRiskAdjustmentsToInventory', () => {
  it('T7: adds lead_time delta to matching inventory rows only', () => {
    const adjustedParams = {
      lead_time_days: { 'MAT-002|PLANT-A': 13 },
      stockout_penalty_multiplier: {},
      safety_stock_alpha: 0.5,
      demand_uplift_alpha: 0
    };

    const inventory = [
      { sku: 'MAT-002', plant_id: 'PLANT-A', lead_time_days: 7, on_hand: 100, safety_stock: 10 },
      { sku: 'MAT-001', plant_id: 'PLANT-A', lead_time_days: 5, on_hand: 200, safety_stock: 20 }
    ];

    const result = applyRiskAdjustmentsToInventory(inventory, adjustedParams);

    // MAT-002 should be extended by 13
    const mat002 = result.find((r) => r.sku === 'MAT-002');
    expect(mat002.lead_time_days).toBe(20);           // 7 + 13
    expect(mat002.lead_time_days_base).toBe(7);
    expect(mat002.lead_time_days_risk_delta).toBe(13);

    // MAT-001 should be unchanged
    const mat001 = result.find((r) => r.sku === 'MAT-001');
    expect(mat001.lead_time_days).toBe(5);
    expect(mat001.lead_time_days_base).toBeUndefined();  // no delta applied

    // Original array is not mutated
    expect(inventory[0].lead_time_days).toBe(7);
  });
});

// ─── T8: applyRiskAdjustmentsToObjective ────────────────────────────────────

describe('applyRiskAdjustmentsToObjective', () => {
  it('T8: multiplies stockout_penalty by max multiplier across all impacted SKUs', () => {
    const adjustedParams = {
      lead_time_days: {},
      stockout_penalty_multiplier: {
        'MAT-004|PLANT-A': 1.4,
        'MAT-003|PLANT-B': 1.2
      },
      safety_stock_alpha: 0.5,
      demand_uplift_alpha: 0
    };

    const objective = { optimize_for: 'balanced', stockout_penalty: 5, holding_cost: 1 };
    const result = applyRiskAdjustmentsToObjective(objective, adjustedParams);

    // max multiplier is 1.4
    expect(result.stockout_penalty).toBeCloseTo(5 * 1.4, 5);
    expect(result.stockout_penalty_base).toBe(5);
    expect(result.stockout_penalty_multiplier_applied).toBeCloseTo(1.4, 5);
    // Other fields preserved
    expect(result.holding_cost).toBe(1);
    expect(result.optimize_for).toBe('balanced');
  });

  it('T8b: no multipliers → objective unchanged', () => {
    const result = applyRiskAdjustmentsToObjective(
      { stockout_penalty: 3, holding_cost: 0 },
      { stockout_penalty_multiplier: {} }
    );
    expect(result.stockout_penalty).toBeCloseTo(3, 5);
    expect(result.stockout_penalty_multiplier_applied).toBeCloseTo(1.0, 5);
  });
});

// ─── T9: applyDemandUplift ───────────────────────────────────────────────────

describe('applyDemandUplift', () => {
  it('T9a: alpha=0 is a pure no-op (returns same values)', () => {
    const series = [
      { sku: 'A', plant_id: 'P1', date: '2026-01-01', p50: 100, p90: 150 }
    ];
    const result = applyDemandUplift(series, 0);
    expect(result[0].p50).toBe(100);
    expect(result[0].p50_uplift).toBeUndefined();
  });

  it('T9b: alpha=0.5 blends p50 and p90 correctly', () => {
    const series = [
      { sku: 'A', plant_id: 'P1', date: '2026-01-01', p50: 100, p90: 160 }
    ];
    // uplift = 0.5 * max(0, 160 - 100) = 30 → effective p50 = 130
    const result = applyDemandUplift(series, 0.5);
    expect(result[0].p50).toBeCloseTo(130, 5);
    expect(result[0].p50_base).toBe(100);
    expect(result[0].p50_uplift).toBeCloseTo(30, 5);
  });

  it('T9c: when p90 is null, no uplift is applied', () => {
    const series = [
      { sku: 'A', plant_id: 'P1', date: '2026-01-01', p50: 100, p90: null }
    ];
    const result = applyDemandUplift(series, 0.5);
    expect(result[0].p50).toBe(100);
  });

  it('T9d: when p90 < p50, uplift is zero (no negative uplift)', () => {
    const series = [
      { sku: 'A', plant_id: 'P1', date: '2026-01-01', p50: 120, p90: 80 }
    ];
    const result = applyDemandUplift(series, 0.5);
    // max(0, 80 - 120) = 0, so no uplift
    expect(result[0].p50).toBe(120);
  });
});

// ─── T10: buildPlanComparison ────────────────────────────────────────────────

describe('buildPlanComparison', () => {
  it('T10: sorts key_changes by absolute delta descending', () => {
    const basePlanRows = [
      { sku: 'SKU-A', plant_id: 'P1', arrival_date: '2026-01-01', order_qty: 100 },
      { sku: 'SKU-B', plant_id: 'P1', arrival_date: '2026-01-01', order_qty: 50 }
    ];
    const riskPlanRows = [
      { sku: 'SKU-A', plant_id: 'P1', arrival_date: '2026-01-01', order_qty: 180 },  // +80
      { sku: 'SKU-B', plant_id: 'P1', arrival_date: '2026-01-01', order_qty: 20 }    // -30
    ];

    const comparison = buildPlanComparison({
      baseRunId: 1,
      riskRunId: 1,
      baseReplayMetrics: {
        with_plan: { service_level_proxy: 0.90, stockout_units: 100, holding_units: 500 }
      },
      riskReplayMetrics: {
        with_plan: { service_level_proxy: 0.95, stockout_units: 50, holding_units: 700 }
      },
      baseKpis: { estimated_total_cost: 1000 },
      riskKpis: { estimated_total_cost: 1200 },
      basePlanRows,
      riskPlanRows,
      riskAdjustments: { rules: [] }
    });

    expect(comparison.version).toBe('v0');
    expect(comparison.kpis.base.service_level).toBeCloseTo(0.90, 5);
    expect(comparison.kpis.risk.service_level).toBeCloseTo(0.95, 5);
    expect(comparison.kpis.delta.service_level).toBeCloseTo(0.05, 5);

    // key_changes: SKU-A delta=80, SKU-B delta=-30 → sorted by |delta| desc
    expect(comparison.key_changes).toHaveLength(2);
    expect(comparison.key_changes[0].sku).toBe('SKU-A');
    expect(comparison.key_changes[0].delta).toBeCloseTo(80, 5);
    expect(comparison.key_changes[1].sku).toBe('SKU-B');
    expect(comparison.key_changes[1].delta).toBeCloseTo(-30, 5);
  });

  it('T10b: skus with zero delta are excluded from key_changes', () => {
    const plan = [{ sku: 'SKU-X', plant_id: 'P1', arrival_date: '2026-01-01', order_qty: 100 }];
    const comparison = buildPlanComparison({
      basePlanRows: plan,
      riskPlanRows: plan,   // identical → no delta
      riskAdjustments: { rules: [] }
    });
    expect(comparison.key_changes).toHaveLength(0);
  });
});

// ─── T11: R3 → safety stock penalty multiplier ────────────────────────────

describe('computeRiskAdjustments – R3/R4/R5 rules', () => {
  it('T11: R3 fires for high risk_score, produces safety_stock_penalty_multiplier', () => {
    const result = computeRiskAdjustments({ riskScores: [HIGH_RISK_SCORE_ENTITY] });

    const key = 'MAT-004|PLANT-A';
    const ssMultiplier = result.adjusted_params.safety_stock_penalty_multiplier[key];
    expect(ssMultiplier).toBeGreaterThan(1.0);
    // With risk_score=200, threshold=60, beta=0.8: norm_risk = min(1, 200/180) ≈ 1.0
    // multiplier = 1 + 0.8 * 1.0 = 1.8 (capped at norm=1)
    expect(ssMultiplier).toBeLessThanOrEqual(1 + RISK_ADJ_CONFIG.ss_penalty_beta);

    const r3Rules = result.rules.filter((r) => r.rule_id === 'R3_safety_stock_penalty_uplift');
    expect(r3Rules.length).toBeGreaterThan(0);
    expect(r3Rules[0].applies_to.sku).toBe('MAT-004');
  });

  it('T11b: R3 does NOT fire for low risk_score entities', () => {
    const result = computeRiskAdjustments({ riskScores: [LOW_RISK_ENTITY] });
    expect(Object.keys(result.adjusted_params.safety_stock_penalty_multiplier)).toHaveLength(0);
    expect(result.rules.filter((r) => r.rule_id === 'R3_safety_stock_penalty_uplift')).toHaveLength(0);
  });

  // ─── T12: R4 → dual source preference ────────────────────────────────────

  it('T12: R4 fires for critically high risk_score (>120), adds dual_source_keys', () => {
    const result = computeRiskAdjustments({ riskScores: [CRITICAL_RISK_ENTITY] });

    expect(result.adjusted_params.dual_source_keys).toContain('MAT-005|PLANT-A');
    expect(result.adjusted_params.dual_source_min_split_fraction).toBe(RISK_ADJ_CONFIG.dual_source_min_split_fraction);

    const r4Rules = result.rules.filter((r) => r.rule_id === 'R4_dual_source_preference');
    expect(r4Rules.length).toBeGreaterThan(0);
    expect(r4Rules[0].applies_to.sku).toBe('MAT-005');
  });

  it('T12b: R4 does NOT fire for risk_score below critical threshold (120)', () => {
    const result = computeRiskAdjustments({ riskScores: [EXPEDITE_RISK_ENTITY] });
    // risk_score=110 < 120 → no dual source
    expect(result.adjusted_params.dual_source_keys).toHaveLength(0);
    expect(result.rules.filter((r) => r.rule_id === 'R4_dual_source_preference')).toHaveLength(0);
  });

  // ─── T13: R5 → expedite mode ─────────────────────────────────────────────

  it('T13: R5 fires for risk_score > 100 AND p90_delay > threshold', () => {
    const result = computeRiskAdjustments({ riskScores: [EXPEDITE_RISK_ENTITY] });

    expect(result.adjusted_params.expedite_keys).toContain('MAT-006|PLANT-B');
    expect(result.adjusted_params.expedite_lead_time_reduction_days).toBe(RISK_ADJ_CONFIG.expedite_lead_time_reduction_days);
    expect(result.adjusted_params.expedite_cost_multiplier).toBe(RISK_ADJ_CONFIG.expedite_cost_multiplier);

    const r5Rules = result.rules.filter((r) => r.rule_id === 'R5_expedite_mode');
    expect(r5Rules.length).toBeGreaterThan(0);
    expect(r5Rules[0].applies_to.sku).toBe('MAT-006');
    expect(r5Rules[0].params_delta.expedite).toBe(true);
  });

  it('T13b: R5 does NOT fire when p90_delay <= threshold, even if risk_score is high', () => {
    const result = computeRiskAdjustments({ riskScores: [HIGH_RISK_LOW_DELAY_ENTITY] });
    // risk_score=130 > 100 but p90_delay=3.0 <= 5.0 → no expedite
    expect(result.adjusted_params.expedite_keys).toHaveLength(0);
    expect(result.rules.filter((r) => r.rule_id === 'R5_expedite_mode')).toHaveLength(0);
  });

  it('T13c: R5 does NOT fire when risk_score <= threshold, even if p90_delay is high', () => {
    const result = computeRiskAdjustments({ riskScores: [HIGH_P90_ENTITY] });
    // risk_score=30 < 100, p90_delay=12.7 > 5 → no expedite (risk too low)
    expect(result.adjusted_params.expedite_keys).toHaveLength(0);
  });

  // ─── T14: Critical entity fires R1 + R2 + R3 + R4 + R5 all together ────

  it('T14: critical entity (score=150, p90=8.0) triggers all five rules', () => {
    const result = computeRiskAdjustments({ riskScores: [CRITICAL_RISK_ENTITY] });

    const key = 'MAT-005|PLANT-A';
    // R1: p90=8.0 > 5.0 → lead_time_days[key] = ceil(8.0) = 8
    expect(result.adjusted_params.lead_time_days[key]).toBe(8);
    // R2: risk_score=150 > 60 → stockout_penalty_multiplier
    expect(result.adjusted_params.stockout_penalty_multiplier[key]).toBeGreaterThan(1.0);
    // R3: risk_score=150 > 60 → safety_stock_penalty_multiplier
    expect(result.adjusted_params.safety_stock_penalty_multiplier[key]).toBeGreaterThan(1.0);
    // R4: risk_score=150 > 120 → dual_source_keys
    expect(result.adjusted_params.dual_source_keys).toContain(key);
    // R5: risk_score=150 > 100 AND p90=8.0 > 5.0 → expedite_keys
    expect(result.adjusted_params.expedite_keys).toContain(key);

    // All five rule types should be present
    const ruleIds = result.rules.map((r) => r.rule_id);
    expect(ruleIds).toContain('R1_lead_time_p90_delay');
    expect(ruleIds).toContain('R2_stockout_penalty_uplift');
    expect(ruleIds).toContain('R3_safety_stock_penalty_uplift');
    expect(ruleIds).toContain('R4_dual_source_preference');
    expect(ruleIds).toContain('R5_expedite_mode');
  });

  // ─── T15: Determinism with all 5 rules on mixed entities ──────────────

  it('T15: deterministic with all five rules on mixed entities', () => {
    const input = {
      riskScores: [
        LOW_RISK_ENTITY,
        HIGH_P90_ENTITY,
        HIGH_OVERDUE_ENTITY,
        HIGH_RISK_SCORE_ENTITY,
        CRITICAL_RISK_ENTITY,
        EXPEDITE_RISK_ENTITY,
        HIGH_RISK_LOW_DELAY_ENTITY
      ]
    };

    const result1 = computeRiskAdjustments(input);
    const result2 = computeRiskAdjustments(input);

    const strip = (obj) => {
      const clone = JSON.parse(JSON.stringify(obj));
      delete clone.generated_at;
      return clone;
    };

    expect(strip(result1)).toEqual(strip(result2));
  });
});

// ─── T16: applyRiskAdjustmentsToSafetyStockPenalty ──────────────────────

describe('applyRiskAdjustmentsToSafetyStockPenalty', () => {
  it('T16a: multiplies safety_stock_violation_penalty by max multiplier', () => {
    const adjustedParams = {
      safety_stock_penalty_multiplier: {
        'MAT-004|PLANT-A': 1.6,
        'MAT-005|PLANT-A': 1.3
      }
    };
    const objective = { stockout_penalty: 5, holding_cost: 1 };

    const result = applyRiskAdjustmentsToSafetyStockPenalty(objective, adjustedParams);

    // default base is 10.0, max multiplier is 1.6
    expect(result.safety_stock_violation_penalty).toBeCloseTo(10.0 * 1.6, 5);
    expect(result.safety_stock_violation_penalty_base).toBe(10.0);
    expect(result.safety_stock_penalty_multiplier_applied).toBeCloseTo(1.6, 5);
    // Other fields preserved
    expect(result.stockout_penalty).toBe(5);
    expect(result.holding_cost).toBe(1);
  });

  it('T16b: no multipliers → penalty unchanged', () => {
    const result = applyRiskAdjustmentsToSafetyStockPenalty(
      { safety_stock_violation_penalty: 15.0 },
      { safety_stock_penalty_multiplier: {} }
    );
    expect(result.safety_stock_violation_penalty).toBeCloseTo(15.0, 5);
    expect(result.safety_stock_penalty_multiplier_applied).toBeCloseTo(1.0, 5);
  });

  it('T16c: respects explicit safety_stock_violation_penalty in objective', () => {
    const adjustedParams = {
      safety_stock_penalty_multiplier: { 'MAT-004|PLANT-A': 2.0 }
    };
    const objective = { safety_stock_violation_penalty: 20.0 };

    const result = applyRiskAdjustmentsToSafetyStockPenalty(objective, adjustedParams);
    expect(result.safety_stock_violation_penalty).toBeCloseTo(40.0, 5);
    expect(result.safety_stock_violation_penalty_base).toBe(20.0);
  });
});
