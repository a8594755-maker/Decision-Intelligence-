/**
 * Milestone 5: Cost Forecast MVP v1
 * Decision Cost / What-if 成本引擎
 * 
 * Pure functions for calculating decision costs (expedite, substitution, disruption)
 * 
 * Core capabilities:
 * - Linear cost rules (unit cost, fixed cost, variable cost)
 * - Expected cost calculation based on shortage and P(stockout)
 * - Versioned rules for reproducibility
 * - Deterministic output (same input → same output)
 */

// ============================================================
// Constants
// ============================================================

// Performance guards
export const COST_WARN_KEYS = 2000;
export const COST_STOP_KEYS = 10000;
export const COST_TOP_N = 500; // Degraded mode: only show top N keys

// Engine version
export const COST_ENGINE_VERSION = '1.0.0';

// Default rule values (MVP linear pricing)
export const DEFAULT_RULES = {
  expedite: {
    unit_cost_per_qty: 5.0,      // $5 per unit to expedite
    max_qty_per_action: 1000     // Max qty per expedite action
  },
  substitution: {
    fixed_cost: 5000,            // $5K fixed qualification cost
    var_cost_per_qty: 2.5,       // $2.5 per unit variable cost
    setup_days: 7                // Setup lead time
  },
  disruption: {
    cost_if_stockout: 50000,     // $50K if stockout occurs
    cost_per_bucket: 10000,      // $10K per bucket of stockout
    min_p_stockout: 0.1          // Min P(stockout) to count
  }
};

// ============================================================
// Type Definitions (JSDoc for documentation)
// ============================================================

/**
 * @typedef {Object} CostInput
 * @property {string} key - Material|Plant key
 * @property {string} materialCode
 * @property {string} plantId
 * @property {number} shortageQty - Deterministic or prob-derived shortage
 * @property {number} [pStockout] - Probability of stockout (0-1)
 * @property {number} [expectedMinAvailable] - Expected minimum inventory
 * @property {string} [stockoutBucketP50] - Median stockout bucket
 * @property {string} [stockoutBucketP90] - P90 stockout bucket
 * @property {number} [bucketsAtRisk] - Number of buckets at risk
 */

/**
 * @typedef {Object} CostRules
 * @property {Object} expedite
 * @property {number} expedite.unit_cost_per_qty
 * @property {number} expedite.max_qty_per_qty
 * @property {Object} substitution
 * @property {number} substitution.fixed_cost
 * @property {number} substitution.var_cost_per_qty
 * @property {number} substitution.setup_days
 * @property {Object} disruption
 * @property {number} disruption.cost_if_stockout
 * @property {number} disruption.cost_per_bucket
 * @property {number} disruption.min_p_stockout
 */

/**
 * @typedef {Object} CostResult
 * @property {string} key
 * @property {string} materialCode
 * @property {string} plantId
 * @property {string} actionType - 'expedite' | 'substitution' | 'disruption'
 * @property {number} expectedCost
 * @property {Object} breakdown
 * @property {Object} inputs
 */

// ============================================================
// Core Cost Calculation Functions
// ============================================================

/**
 * Calculate expedite cost
 * Formula: shortageQty × unit_cost_per_qty (capped at max_qty)
 * 
 * @param {number} shortageQty - Quantity needing expedite
 * @param {Object} rules - Expedite rules
 * @returns {Object} - {cost, breakdown}
 */
export function calculateExpediteCost(shortageQty, rules = {}) {
  const unitCost = rules.unit_cost_per_qty ?? DEFAULT_RULES.expedite.unit_cost_per_qty;
  const maxQty = rules.max_qty_per_action ?? DEFAULT_RULES.expedite.max_qty_per_action;
  
  // Cap the quantity at max
  const actualQty = Math.min(Math.max(0, shortageQty), maxQty);
  const cost = actualQty * unitCost;
  
  return {
    cost: Math.round(cost * 100) / 100, // Round to 2 decimals
    breakdown: {
      base_cost: cost,
      quantity: actualQty,
      unit_cost: unitCost,
      max_qty_applied: shortageQty > maxQty,
      capped_qty: shortageQty > maxQty ? maxQty : null,
      formula: 'shortageQty × unit_cost_per_qty (capped)'
    }
  };
}

/**
 * Calculate substitution cost
 * Formula: fixed_cost + shortageQty × var_cost_per_qty
 * 
 * @param {number} shortageQty - Quantity needing substitution
 * @param {Object} rules - Substitution rules
 * @returns {Object} - {cost, breakdown}
 */
export function calculateSubstitutionCost(shortageQty, rules = {}) {
  const fixedCost = rules.fixed_cost ?? DEFAULT_RULES.substitution.fixed_cost;
  const varCostPerQty = rules.var_cost_per_qty ?? DEFAULT_RULES.substitution.var_cost_per_qty;
  const setupDays = rules.setup_days ?? DEFAULT_RULES.substitution.setup_days;
  
  const variableCost = shortageQty * varCostPerQty;
  const cost = fixedCost + variableCost;
  
  return {
    cost: Math.round(cost * 100) / 100,
    breakdown: {
      base_cost: cost,
      fixed_cost: fixedCost,
      variable_cost: variableCost,
      quantity: shortageQty,
      var_cost_per_qty: varCostPerQty,
      setup_days: setupDays,
      formula: 'fixed_cost + shortageQty × var_cost_per_qty'
    }
  };
}

/**
 * Calculate disruption cost
 * Formula: pStockout × cost_if_stockout (+ buckets_at_risk × cost_per_bucket if available)
 * 
 * @param {number} pStockout - Probability of stockout (0-1)
 * @param {Object} rules - Disruption rules
 * @param {number} [bucketsAtRisk] - Optional: number of buckets at risk
 * @returns {Object} - {cost, breakdown}
 */
export function calculateDisruptionCost(pStockout, rules = {}, bucketsAtRisk = 0) {
  const costIfStockout = rules.cost_if_stockout ?? DEFAULT_RULES.disruption.cost_if_stockout;
  const costPerBucket = rules.cost_per_bucket ?? DEFAULT_RULES.disruption.cost_per_bucket;
  const minPStockout = rules.min_p_stockout ?? DEFAULT_RULES.disruption.min_p_stockout;
  
  // Only apply cost if P(stockout) >= minimum threshold
  const effectivePStockout = pStockout >= minPStockout ? pStockout : 0;
  
  // Base disruption cost
  const stockoutCost = effectivePStockout * costIfStockout;
  
  // Additional cost per bucket at risk
  const bucketCost = bucketsAtRisk > 0 ? bucketsAtRisk * costPerBucket : 0;
  
  const cost = stockoutCost + bucketCost;
  
  return {
    cost: Math.round(cost * 100) / 100,
    breakdown: {
      base_cost: cost,
      p_stockout_applied: effectivePStockout,
      p_stockout_input: pStockout,
      min_p_stockout_threshold: minPStockout,
      cost_if_stockout: costIfStockout,
      stockout_cost: stockoutCost,
      buckets_at_risk: bucketsAtRisk,
      cost_per_bucket: costPerBucket,
      bucket_cost: bucketCost,
      threshold_applied: pStockout < minPStockout,
      formula: 'pStockout × cost_if_stockout + bucketsAtRisk × cost_per_bucket'
    }
  };
}

// ============================================================
// Main Cost Calculation Entry Point
// ============================================================

/**
 * Calculate all 3 action costs for a single key
 * 
 * @param {CostInput} input - Input data for the key
 * @param {CostRules} rules - Cost rules configuration
 * @returns {CostResult[]} - Array of 3 cost results
 */
export function calculateCostsForKey(input, rules = DEFAULT_RULES) {
  const { key, materialCode, plantId, shortageQty = 0, pStockout = 0, bucketsAtRisk = 0 } = input;
  
  const results = [];
  
  // Expedite
  const expedite = calculateExpediteCost(shortageQty, rules.expedite);
  results.push({
    key,
    materialCode,
    plantId,
    actionType: 'expedite',
    expectedCost: expedite.cost,
    breakdown: expedite.breakdown,
    inputs: {
      shortageQty,
      pStockout,
      bucketsAtRisk,
      ...input
    }
  });
  
  // Substitution
  const substitution = calculateSubstitutionCost(shortageQty, rules.substitution);
  results.push({
    key,
    materialCode,
    plantId,
    actionType: 'substitution',
    expectedCost: substitution.cost,
    breakdown: substitution.breakdown,
    inputs: {
      shortageQty,
      pStockout,
      bucketsAtRisk,
      ...input
    }
  });
  
  // Disruption
  const disruption = calculateDisruptionCost(pStockout, rules.disruption, bucketsAtRisk);
  results.push({
    key,
    materialCode,
    plantId,
    actionType: 'disruption',
    expectedCost: disruption.cost,
    breakdown: disruption.breakdown,
    inputs: {
      shortageQty,
      pStockout,
      bucketsAtRisk,
      ...input
    }
  });
  
  return results;
}

// ============================================================
// Batch Processing
// ============================================================

/**
 * Calculate costs for multiple keys with performance guards
 * 
 * @param {CostInput[]} inputs - Array of inputs
 * @param {CostRules} rules - Cost rules
 * @param {Object} options - Processing options
 * @returns {Object} - {results, metrics, degraded}
 */
export function calculateCostsBatch(inputs, rules = DEFAULT_RULES, options = {}) {
  const startTime = Date.now();
  
  const {
    warnKeys = COST_WARN_KEYS,
    stopKeys = COST_STOP_KEYS,
    topN = COST_TOP_N
  } = options;
  
  const totalKeys = inputs.length;
  
  // Check performance guards
  let degraded = false;
  let degradedReason = null;
  
  if (totalKeys > stopKeys) {
    return {
      success: false,
      error: `Too many keys (${totalKeys}). Max allowed: ${stopKeys}.`,
      degraded: true,
      degradedReason: `STOP: keys ${totalKeys} > ${stopKeys}`,
      results: []
    };
  }
  
  if (totalKeys > warnKeys) {
    degraded = true;
    degradedReason = `WARN: keys ${totalKeys} > ${warnKeys}`;
  }
  
  // Process keys (limit to topN in degraded mode)
  const keysToProcess = degraded ? inputs.slice(0, topN) : inputs;
  
  const allResults = [];
  for (const input of keysToProcess) {
    const keyResults = calculateCostsForKey(input, rules);
    allResults.push(...keyResults);
  }
  
  const computeMs = Date.now() - startTime;
  
  return {
    success: true,
    results: allResults,
    degraded,
    degradedReason,
    metrics: {
      totalKeys,
      keysProcessed: keysToProcess.length,
      totalResults: allResults.length,
      computeMs,
      actionsPerKey: 3,
      degraded,
      degradedReason
    }
  };
}

// ============================================================
// Rule Validation and Helpers
// ============================================================

/**
 * Validate cost rules structure
 * 
 * @param {Object} rules - Rules to validate
 * @returns {Object} - {valid, errors, warnings}
 */
export function validateCostRules(rules) {
  const errors = [];
  const warnings = [];
  
  // Check required sections exist
  if (!rules.expedite) {
    warnings.push('Missing expedite rules, will use defaults');
  } else {
    if (typeof rules.expedite.unit_cost_per_qty !== 'number') {
      errors.push('expedite.unit_cost_per_qty must be a number');
    }
    if (typeof rules.expedite.max_qty_per_action !== 'number') {
      errors.push('expedite.max_qty_per_action must be a number');
    }
  }
  
  if (!rules.substitution) {
    warnings.push('Missing substitution rules, will use defaults');
  } else {
    if (typeof rules.substitution.fixed_cost !== 'number') {
      errors.push('substitution.fixed_cost must be a number');
    }
    if (typeof rules.substitution.var_cost_per_qty !== 'number') {
      errors.push('substitution.var_cost_per_qty must be a number');
    }
  }
  
  if (!rules.disruption) {
    warnings.push('Missing disruption rules, will use defaults');
  } else {
    if (typeof rules.disruption.cost_if_stockout !== 'number') {
      errors.push('disruption.cost_if_stockout must be a number');
    }
    if (typeof rules.disruption.min_p_stockout !== 'number') {
      errors.push('disruption.min_p_stockout must be a number');
    }
  }
  
  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Find the cheapest action for a key
 * 
 * @param {CostResult[]} results - All 3 action results for a key
 * @returns {Object} - {cheapestAction, cheapestCost, allCosts}
 */
export function findCheapestAction(results) {
  const sorted = [...results].sort((a, b) => a.expectedCost - b.expectedCost);
  
  return {
    cheapestAction: sorted[0].actionType,
    cheapestCost: sorted[0].expectedCost,
    allCosts: {
      expedite: results.find(r => r.actionType === 'expedite')?.expectedCost ?? 0,
      substitution: results.find(r => r.actionType === 'substitution')?.expectedCost ?? 0,
      disruption: results.find(r => r.actionType === 'disruption')?.expectedCost ?? 0
    },
    savingsVsExpedite: sorted[0].actionType === 'expedite' ? 0 : 
      (results.find(r => r.actionType === 'expedite')?.expectedCost ?? 0) - sorted[0].expectedCost
  };
}

/**
 * Merge cost results with summary data for display
 * 
 * @param {CostResult[]} costResults - Cost calculation results
 * @param {Object[]} summaryData - Prob or deterministic summary data
 * @returns {Object[]} - Merged display rows
 */
export function mergeCostsWithSummary(costResults, summaryData) {
  const costByKey = {};
  
  // Group costs by key
  for (const result of costResults) {
    if (!costByKey[result.key]) {
      costByKey[result.key] = {};
    }
    costByKey[result.key][result.actionType] = result;
  }
  
  // Merge with summary
  return summaryData.map(summary => {
    const key = summary.key || `${summary.material_code}|${summary.plant_id}`;
    const costs = costByKey[key] || {};
    
    const expedite = costs.expedite?.expectedCost ?? 0;
    const substitution = costs.substitution?.expectedCost ?? 0;
    const disruption = costs.disruption?.expectedCost ?? 0;
    
    return {
      ...summary,
      key,
      expediteCost: expedite,
      substitutionCost: substitution,
      disruptionCost: disruption,
      totalCost: expedite + substitution + disruption,
      cheapestAction: expedite <= substitution && expedite <= disruption ? 'expedite' :
                      substitution <= expedite && substitution <= disruption ? 'substitution' : 'disruption'
    };
  });
}

// ============================================================
// Utilities
// ============================================================

/**
 * Compute KPIs from cost results
 * 
 * @param {CostResult[]} results - All cost results
 * @returns {Object} - KPI summary
 */
export function computeCostKPIs(results) {
  const byAction = {
    expedite: results.filter(r => r.actionType === 'expedite'),
    substitution: results.filter(r => r.actionType === 'substitution'),
    disruption: results.filter(r => r.actionType === 'disruption')
  };
  
  const kpis = {};
  
  for (const [action, actionResults] of Object.entries(byAction)) {
    const costs = actionResults.map(r => r.expectedCost);
    const total = costs.reduce((sum, c) => sum + c, 0);
    
    kpis[action] = {
      count: actionResults.length,
      totalCost: Math.round(total * 100) / 100,
      avgCost: Math.round((total / actionResults.length) * 100) / 100 || 0,
      maxCost: Math.max(...costs, 0),
      keysWithCost: actionResults.filter(r => r.expectedCost > 0).length
    };
  }
  
  // Overall
  const allCosts = results.map(r => r.expectedCost);
  const grandTotal = allCosts.reduce((sum, c) => sum + c, 0);
  
  kpis.overall = {
    totalKeys: new Set(results.map(r => r.key)).size,
    totalCost: Math.round(grandTotal * 100) / 100,
    avgCostPerKey: Math.round((grandTotal / (results.length / 3)) * 100) / 100 || 0
  };
  
  return kpis;
}

/**
 * Create default rule set for a user
 * 
 * @param {string} version - Rule set version string
 * @param {Object} overrides - Override default values
 * @returns {Object} - Complete rule set
 */
export function createDefaultRuleSet(version = 'v1.0.0-default', overrides = {}) {
  return {
    rule_set_version: version,
    currency: overrides.currency || 'USD',
    rules: {
      expedite: {
        unit_cost_per_qty: overrides.expediteUnitCost ?? DEFAULT_RULES.expedite.unit_cost_per_qty,
        max_qty_per_action: overrides.expediteMaxQty ?? DEFAULT_RULES.expedite.max_qty_per_action
      },
      substitution: {
        fixed_cost: overrides.subFixedCost ?? DEFAULT_RULES.substitution.fixed_cost,
        var_cost_per_qty: overrides.subVarCost ?? DEFAULT_RULES.substitution.var_cost_per_qty,
        setup_days: overrides.subSetupDays ?? DEFAULT_RULES.substitution.setup_days
      },
      disruption: {
        cost_if_stockout: overrides.disruptionCost ?? DEFAULT_RULES.disruption.cost_if_stockout,
        cost_per_bucket: overrides.disruptionPerBucket ?? DEFAULT_RULES.disruption.cost_per_bucket,
        min_p_stockout: overrides.disruptionMinP ?? DEFAULT_RULES.disruption.min_p_stockout
      }
    },
    description: overrides.description || 'Default MVP cost rules - linear pricing'
  };
}
