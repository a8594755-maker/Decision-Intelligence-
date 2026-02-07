/**
 * Milestone 5: Cost Forecast Unit Tests
 * Gate-C2: Verify cost engine calculations
 */

import { describe, it, expect } from 'vitest';
import {
  calculateExpediteCost,
  calculateSubstitutionCost,
  calculateDisruptionCost,
  calculateCostsForKey,
  calculateCostsBatch,
  validateCostRules,
  findCheapestAction,
  computeCostKPIs,
  createDefaultRuleSet,
  DEFAULT_RULES,
  COST_WARN_KEYS,
  COST_STOP_KEYS
} from './costForecast';

// ============================================================
// Test 1: Expedite Cost Calculation
// ============================================================
describe('calculateExpediteCost', () => {
  it('should return 0 when shortageQty is 0', () => {
    const result = calculateExpediteCost(0, DEFAULT_RULES.expedite);
    expect(result.cost).toBe(0);
    expect(result.breakdown.quantity).toBe(0);
  });

  it('should calculate linear cost correctly', () => {
    const result = calculateExpediteCost(100, { unit_cost_per_qty: 5.0, max_qty_per_action: 1000 });
    expect(result.cost).toBe(500); // 100 * 5
    expect(result.breakdown.quantity).toBe(100);
    expect(result.breakdown.unit_cost).toBe(5.0);
  });

  it('should cap at max_qty_per_action', () => {
    const result = calculateExpediteCost(1500, { unit_cost_per_qty: 10.0, max_qty_per_action: 1000 });
    expect(result.cost).toBe(10000); // 1000 * 10 (capped)
    expect(result.breakdown.quantity).toBe(1000);
    expect(result.breakdown.max_qty_applied).toBe(true);
    expect(result.breakdown.capped_qty).toBe(1000);
  });

  it('should handle negative shortage as 0', () => {
    const result = calculateExpediteCost(-50, DEFAULT_RULES.expedite);
    expect(result.cost).toBe(0);
    expect(result.breakdown.quantity).toBe(0);
  });

  it('should use default rules when not provided', () => {
    const result = calculateExpediteCost(200);
    expect(result.cost).toBe(1000); // 200 * 5 (default)
  });
});

// ============================================================
// Test 2: Substitution Cost Calculation
// ============================================================
describe('calculateSubstitutionCost', () => {
  it('should return fixed cost only when shortageQty is 0', () => {
    const result = calculateSubstitutionCost(0, { fixed_cost: 5000, var_cost_per_qty: 2.5 });
    expect(result.cost).toBe(5000); // Just fixed cost
    expect(result.breakdown.fixed_cost).toBe(5000);
    expect(result.breakdown.variable_cost).toBe(0);
  });

  it('should calculate fixed + variable cost correctly', () => {
    const result = calculateSubstitutionCost(100, { 
      fixed_cost: 5000, 
      var_cost_per_qty: 2.5,
      setup_days: 7 
    });
    expect(result.cost).toBe(5250); // 5000 + (100 * 2.5)
    expect(result.breakdown.fixed_cost).toBe(5000);
    expect(result.breakdown.variable_cost).toBe(250);
    expect(result.breakdown.quantity).toBe(100);
  });

  it('should use default rules when not provided', () => {
    const result = calculateSubstitutionCost(1000);
    expect(result.cost).toBe(7500); // 5000 + (1000 * 2.5)
    expect(result.breakdown.setup_days).toBe(7);
  });

  it('should handle large quantities', () => {
    const result = calculateSubstitutionCost(10000, { fixed_cost: 5000, var_cost_per_qty: 2.5 });
    expect(result.cost).toBe(30000); // 5000 + (10000 * 2.5)
  });
});

// ============================================================
// Test 3: Disruption Cost Calculation
// ============================================================
describe('calculateDisruptionCost', () => {
  it('should return 0 when pStockout is 0', () => {
    const result = calculateDisruptionCost(0, DEFAULT_RULES.disruption);
    expect(result.cost).toBe(0);
    expect(result.breakdown.p_stockout_applied).toBe(0);
  });

  it('should return 0 when pStockout is below min threshold', () => {
    const result = calculateDisruptionCost(0.05, { cost_if_stockout: 50000, min_p_stockout: 0.1 });
    expect(result.cost).toBe(0); // Below 0.1 threshold
    expect(result.breakdown.threshold_applied).toBe(true);
    expect(result.breakdown.p_stockout_applied).toBe(0);
  });

  it('should calculate expected disruption cost correctly', () => {
    const result = calculateDisruptionCost(0.5, { cost_if_stockout: 50000, min_p_stockout: 0.1 });
    expect(result.cost).toBe(25000); // 0.5 * 50000
    expect(result.breakdown.p_stockout_applied).toBe(0.5);
    expect(result.breakdown.stockout_cost).toBe(25000);
  });

  it('should include bucket cost when bucketsAtRisk provided', () => {
    const result = calculateDisruptionCost(
      0.3, 
      { cost_if_stockout: 50000, cost_per_bucket: 10000, min_p_stockout: 0.1 },
      3
    );
    expect(result.cost).toBe(45000); // (0.3 * 50000) + (3 * 10000)
    expect(result.breakdown.stockout_cost).toBe(15000);
    expect(result.breakdown.bucket_cost).toBe(30000);
    expect(result.breakdown.buckets_at_risk).toBe(3);
  });

  it('should return full cost when pStockout is 1', () => {
    const result = calculateDisruptionCost(1.0, DEFAULT_RULES.disruption);
    expect(result.cost).toBe(50000);
    expect(result.breakdown.p_stockout_applied).toBe(1.0);
  });

  it('should use default rules when not provided', () => {
    const result = calculateDisruptionCost(0.2);
    expect(result.cost).toBe(10000); // 0.2 * 50000
  });
});

// ============================================================
// Test 4: calculateCostsForKey - All 3 actions
// ============================================================
describe('calculateCostsForKey', () => {
  it('should return all 3 action results', () => {
    const input = {
      key: 'COMP-001|PLANT-01',
      materialCode: 'COMP-001',
      plantId: 'PLANT-01',
      shortageQty: 100,
      pStockout: 0.3,
      bucketsAtRisk: 2
    };

    const results = calculateCostsForKey(input, DEFAULT_RULES);

    expect(results).toHaveLength(3);
    expect(results.map(r => r.actionType)).toContain('expedite');
    expect(results.map(r => r.actionType)).toContain('substitution');
    expect(results.map(r => r.actionType)).toContain('disruption');
  });

  it('should include correct key info in all results', () => {
    const input = {
      key: 'COMP-002|PLANT-02',
      materialCode: 'COMP-002',
      plantId: 'PLANT-02',
      shortageQty: 50,
      pStockout: 0.2
    };

    const results = calculateCostsForKey(input, DEFAULT_RULES);

    results.forEach(r => {
      expect(r.key).toBe('COMP-002|PLANT-02');
      expect(r.materialCode).toBe('COMP-002');
      expect(r.plantId).toBe('PLANT-02');
    });
  });

  it('should include inputs in all results', () => {
    const input = {
      key: 'COMP-003|PLANT-01',
      materialCode: 'COMP-003',
      plantId: 'PLANT-01',
      shortageQty: 200,
      pStockout: 0.4,
      bucketsAtRisk: 1,
      expectedMinAvailable: -50
    };

    const results = calculateCostsForKey(input, DEFAULT_RULES);

    results.forEach(r => {
      expect(r.inputs.shortageQty).toBe(200);
      expect(r.inputs.pStockout).toBe(0.4);
      expect(r.inputs.bucketsAtRisk).toBe(1);
      expect(r.inputs.expectedMinAvailable).toBe(-50);
    });
  });

  it('should calculate correct costs with defaults', () => {
    const input = {
      key: 'COMP-004|PLANT-01',
      materialCode: 'COMP-004',
      plantId: 'PLANT-01',
      shortageQty: 100,
      pStockout: 0.2
    };

    const results = calculateCostsForKey(input, DEFAULT_RULES);
    
    const expedite = results.find(r => r.actionType === 'expedite');
    const substitution = results.find(r => r.actionType === 'substitution');
    const disruption = results.find(r => r.actionType === 'disruption');

    expect(expedite.expectedCost).toBe(500);     // 100 * 5
    expect(substitution.expectedCost).toBe(5250);  // 5000 + (100 * 2.5)
    expect(disruption.expectedCost).toBe(10000); // 0.2 * 50000
  });
});

// ============================================================
// Test 5: Batch Processing with Performance Guards
// ============================================================
describe('calculateCostsBatch', () => {
  it('should process multiple keys', () => {
    const inputs = [
      { key: 'A|01', materialCode: 'A', plantId: '01', shortageQty: 100, pStockout: 0.2 },
      { key: 'B|01', materialCode: 'B', plantId: '01', shortageQty: 50, pStockout: 0.1 },
      { key: 'C|01', materialCode: 'C', plantId: '01', shortageQty: 200, pStockout: 0.3 }
    ];

    const result = calculateCostsBatch(inputs, DEFAULT_RULES);

    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(9); // 3 keys × 3 actions
    expect(result.metrics.totalKeys).toBe(3);
    expect(result.metrics.keysProcessed).toBe(3);
    expect(result.degraded).toBe(false);
  });

  it('should return STOP error when keys exceed COST_STOP_KEYS', () => {
    const inputs = Array(COST_STOP_KEYS + 1).fill({
      key: 'A|01', materialCode: 'A', plantId: '01', shortageQty: 100, pStockout: 0.2
    });

    const result = calculateCostsBatch(inputs, DEFAULT_RULES);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Too many keys');
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toContain('STOP');
  });

  it('should enter degraded mode when keys exceed COST_WARN_KEYS', () => {
    const inputs = Array(COST_WARN_KEYS + 100).fill({
      key: 'A|01', materialCode: 'A', plantId: '01', shortageQty: 100, pStockout: 0.2
    });

    const result = calculateCostsBatch(inputs, DEFAULT_RULES, { 
      warnKeys: COST_WARN_KEYS,
      stopKeys: COST_STOP_KEYS,
      topN: 500
    });

    expect(result.success).toBe(true);
    expect(result.metrics.degraded).toBe(true);
    expect(result.metrics.degradedReason).toContain('WARN');
    expect(result.metrics.keysProcessed).toBe(500); // Limited to topN
  });

  it('should handle empty inputs', () => {
    const result = calculateCostsBatch([]);
    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(0);
    expect(result.metrics.totalKeys).toBe(0);
  });
});

// ============================================================
// Test 6: Rule Validation
// ============================================================
describe('validateCostRules', () => {
  it('should validate complete rules', () => {
    const rules = {
      expedite: { unit_cost_per_qty: 5.0, max_qty_per_action: 1000 },
      substitution: { fixed_cost: 5000, var_cost_per_qty: 2.5, setup_days: 7 },
      disruption: { cost_if_stockout: 50000, cost_per_bucket: 10000, min_p_stockout: 0.1 }
    };

    const result = validateCostRules(rules);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should return warnings for missing sections', () => {
    const result = validateCostRules({});
    expect(result.valid).toBe(true); // Still valid (will use defaults)
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings[0]).toContain('expedite');
    expect(result.warnings[1]).toContain('substitution');
    expect(result.warnings[2]).toContain('disruption');
  });

  it('should return errors for invalid types', () => {
    const rules = {
      expedite: { unit_cost_per_qty: 'invalid', max_qty_per_action: 'invalid' }
    };

    const result = validateCostRules(rules);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
  });
});

// ============================================================
// Test 7: findCheapestAction
// ============================================================
describe('findCheapestAction', () => {
  it('should identify cheapest action correctly', () => {
    const results = [
      { actionType: 'expedite', expectedCost: 500 },
      { actionType: 'substitution', expectedCost: 5250 },
      { actionType: 'disruption', expectedCost: 10000 }
    ];

    const cheapest = findCheapestAction(results);
    expect(cheapest.cheapestAction).toBe('expedite');
    expect(cheapest.cheapestCost).toBe(500);
    expect(cheapest.savingsVsExpedite).toBe(0);
  });

  it('should calculate savings correctly when substitution is cheapest', () => {
    const results = [
      { actionType: 'expedite', expectedCost: 5000 },
      { actionType: 'substitution', expectedCost: 1000 },
      { actionType: 'disruption', expectedCost: 8000 }
    ];

    const cheapest = findCheapestAction(results);
    expect(cheapest.cheapestAction).toBe('substitution');
    expect(cheapest.cheapestCost).toBe(1000);
    expect(cheapest.savingsVsExpedite).toBe(4000); // 5000 - 1000
    expect(cheapest.allCosts).toEqual({
      expedite: 5000,
      substitution: 1000,
      disruption: 8000
    });
  });
});

// ============================================================
// Test 8: computeCostKPIs
// ============================================================
describe('computeCostKPIs', () => {
  it('should calculate KPIs correctly', () => {
    const results = [
      // Key 1
      { key: 'A|01', actionType: 'expedite', expectedCost: 500 },
      { key: 'A|01', actionType: 'substitution', expectedCost: 5250 },
      { key: 'A|01', actionType: 'disruption', expectedCost: 10000 },
      // Key 2
      { key: 'B|01', actionType: 'expedite', expectedCost: 1000 },
      { key: 'B|01', actionType: 'substitution', expectedCost: 5500 },
      { key: 'B|01', actionType: 'disruption', expectedCost: 15000 }
    ];

    const kpis = computeCostKPIs(results);

    expect(kpis.expedite.count).toBe(2);
    expect(kpis.expedite.totalCost).toBe(1500); // 500 + 1000
    expect(kpis.expedite.avgCost).toBe(750);

    expect(kpis.substitution.count).toBe(2);
    expect(kpis.substitution.totalCost).toBe(10750); // 5250 + 5500

    expect(kpis.disruption.count).toBe(2);
    expect(kpis.disruption.totalCost).toBe(25000); // 10000 + 15000

    expect(kpis.overall.totalKeys).toBe(2);
    expect(kpis.overall.totalCost).toBe(37250); // 1500 + 10750 + 25000
    expect(kpis.overall.avgCostPerKey).toBe(18625); // 37250 / 2
  });

  it('should handle zero costs', () => {
    const results = [
      { key: 'A|01', actionType: 'expedite', expectedCost: 0 },
      { key: 'A|01', actionType: 'substitution', expectedCost: 0 },
      { key: 'A|01', actionType: 'disruption', expectedCost: 0 }
    ];

    const kpis = computeCostKPIs(results);
    expect(kpis.expedite.totalCost).toBe(0);
    expect(kpis.overall.totalCost).toBe(0);
  });
});

// ============================================================
// Test 9: createDefaultRuleSet
// ============================================================
describe('createDefaultRuleSet', () => {
  it('should create default rule set', () => {
    const ruleSet = createDefaultRuleSet('v1.0.0-test');
    
    expect(ruleSet.rule_set_version).toBe('v1.0.0-test');
    expect(ruleSet.currency).toBe('USD');
    expect(ruleSet.rules.expedite.unit_cost_per_qty).toBe(5.0);
    expect(ruleSet.rules.substitution.fixed_cost).toBe(5000);
    expect(ruleSet.rules.disruption.cost_if_stockout).toBe(50000);
  });

  it('should allow overrides', () => {
    const ruleSet = createDefaultRuleSet('v2.0.0', {
      currency: 'EUR',
      expediteUnitCost: 10.0,
      subFixedCost: 10000
    });
    
    expect(ruleSet.currency).toBe('EUR');
    expect(ruleSet.rules.expedite.unit_cost_per_qty).toBe(10.0);
    expect(ruleSet.rules.substitution.fixed_cost).toBe(10000);
    // Non-overridden values use defaults
    expect(ruleSet.rules.disruption.cost_if_stockout).toBe(50000);
  });
});

// ============================================================
// Test 10: Deterministic Output (Reproducibility)
// ============================================================
describe('Deterministic output', () => {
  it('should produce same output for same input', () => {
    const input = {
      key: 'TEST|01',
      materialCode: 'TEST',
      plantId: '01',
      shortageQty: 100,
      pStockout: 0.3,
      bucketsAtRisk: 2
    };

    const result1 = calculateCostsForKey(input, DEFAULT_RULES);
    const result2 = calculateCostsForKey(input, DEFAULT_RULES);

    // All costs should match
    expect(result1[0].expectedCost).toBe(result2[0].expectedCost);
    expect(result1[1].expectedCost).toBe(result2[1].expectedCost);
    expect(result1[2].expectedCost).toBe(result2[2].expectedCost);
  });
});
