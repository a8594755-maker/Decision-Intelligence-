/**
 * Milestone 6: Revenue/Price/Margin at Risk Engine (MVP v1)
 * WP2: Pure Functions for Margin at Risk Calculation
 * 
 * Core formula: expected_margin_at_risk = impacted_qty * margin_per_unit
 * expected_penalty_at_risk based on penalty_type and penalty_value
 */

// ============================================================
// Constants
// ============================================================

export const REVENUE_ENGINE_VERSION = '1.0.0';

// Guardrails - same pattern as costForecast.js
export const REVENUE_WARN_KEYS = 500;
export const REVENUE_STOP_KEYS = 5000;

// ============================================================
// Type Definitions (JSDoc for clarity)
// ============================================================

/**
 * @typedef {Object} RevenueTerm
 * @property {string} fgMaterialCode - FG material code
 * @property {string} plantId - Plant ID
 * @property {number} marginPerUnit - Unit margin (required)
 * @property {number} [pricePerUnit] - Price per unit (optional)
 * @property {string} [penaltyType] - 'none', 'per_unit', 'percent_of_revenue'
 * @property {number} [penaltyValue] - Penalty value
 * @property {string} currency - Currency (default 'USD')
 */

/**
 * @typedef {Object} RiskInput
 * @property {string} fgMaterialCode - FG material code
 * @property {string} plantId - Plant ID
 * @property {string} timeBucket - Time bucket
 * @property {number} demandQty - FG demand quantity
 * @property {number} [shortageQty] - Shortage quantity (deterministic)
 * @property {number} [pStockout] - Probability of stockout 0-1
 * @property {number} [expectedShortageQty] - Expected shortage (probabilistic)
 */

/**
 * @typedef {Object} MarginAtRiskResult
 * @property {string} fgMaterialCode - FG material code
 * @property {string} plantId - Plant ID
 * @property {string} timeBucket - Time bucket
 * @property {number} demandQty - Demand quantity
 * @property {number} impactedQty - Impacted quantity by risk
 * @property {number} marginPerUnit - Unit margin
 * @property {number} expectedMarginAtRisk - Expected margin at risk
 * @property {number} expectedPenaltyAtRisk - Expected penalty at risk
 * @property {string} riskInputMode - 'deterministic' or 'probabilistic'
 */

// ============================================================
// Core Calculation Functions
// ============================================================

/**
 * Calculate impacted quantity based on risk input mode
 * 
 * Deterministic: impacted_qty = min(demand_qty, shortage_qty)
 * Probabilistic (simple): impacted_qty = min(demand_qty, p_stockout * demand_qty)
 * Probabilistic (with expected): impacted_qty = min(demand_qty, expected_shortage_qty)
 * 
 * @param {RiskInput} input - Risk input data
 * @param {string} mode - 'deterministic' or 'probabilistic'
 * @returns {number} impacted quantity
 */
export function calculateImpactedQty(input, mode) {
  const demandQty = input.demandQty || 0;
  
  if (mode === 'deterministic') {
    // Deterministic: impacted = min(demand, shortage)
    const shortageQty = input.shortageQty || 0;
    return Math.min(demandQty, shortageQty);
  }
  
  // Probabilistic mode
  if (input.expectedShortageQty !== undefined && input.expectedShortageQty !== null) {
    // Best case: we have expected shortage from Monte Carlo
    return Math.min(demandQty, Math.max(0, input.expectedShortageQty));
  }
  
  if (input.pStockout !== undefined && input.pStockout !== null) {
    // Approximation: p_stockout * demand_qty
    return Math.min(demandQty, input.pStockout * demandQty);
  }
  
  // Fallback: no risk data means 0 impact
  return 0;
}

/**
 * Calculate expected penalty at risk
 * 
 * @param {number} impactedQty - Impacted quantity
 * @param {number} [pricePerUnit] - Price per unit
 * @param {string} [penaltyType] - 'none', 'per_unit', 'percent_of_revenue'
 * @param {number} [penaltyValue] - Penalty value
 * @returns {number} expected penalty at risk
 */
export function calculatePenaltyAtRisk(impactedQty, pricePerUnit = 0, penaltyType = 'none', penaltyValue = 0) {
  if (penaltyType === 'none' || !penaltyType || impactedQty <= 0) {
    return 0;
  }
  
  if (penaltyType === 'per_unit') {
    // per_unit: impacted_qty * penalty_value ($/unit)
    return impactedQty * (penaltyValue || 0);
  }
  
  if (penaltyType === 'percent_of_revenue') {
    // percent_of_revenue: impacted_qty * price_per_unit * penalty_value (%)
    const revenue = impactedQty * (pricePerUnit || 0);
    return revenue * (penaltyValue || 0);
  }
  
  return 0;
}

/**
 * Calculate margin at risk for a single FG|Plant|Bucket
 * 
 * @param {RiskInput} riskInput - Risk input data
 * @param {RevenueTerm} revenueTerm - Revenue terms for this FG
 * @param {string} riskInputMode - 'deterministic' or 'probabilistic'
 * @returns {Object} calculation result with breakdown
 */
export function calculateMarginAtRiskForKey(riskInput, revenueTerm, riskInputMode) {
  // Guard: must have margin per unit
  const marginPerUnit = revenueTerm?.marginPerUnit;
  if (typeof marginPerUnit !== 'number' || isNaN(marginPerUnit)) {
    return {
      error: `Missing or invalid margin_per_unit for ${riskInput.fgMaterialCode}|${riskInput.plantId}`,
      inputs: { riskInput, revenueTerm }
    };
  }
  
  // Calculate impacted quantity
  const impactedQty = calculateImpactedQty(riskInput, riskInputMode);
  
  // Calculate expected margin at risk
  const expectedMarginAtRisk = impactedQty * marginPerUnit;
  
  // Calculate expected penalty at risk
  const expectedPenaltyAtRisk = calculatePenaltyAtRisk(
    impactedQty,
    revenueTerm.pricePerUnit,
    revenueTerm.penaltyType,
    revenueTerm.penaltyValue
  );
  
  return {
    fgMaterialCode: riskInput.fgMaterialCode,
    plantId: riskInput.plantId,
    timeBucket: riskInput.timeBucket,
    demandQty: riskInput.demandQty || 0,
    impactedQty,
    marginPerUnit,
    pricePerUnit: revenueTerm.pricePerUnit || 0,
    penaltyType: revenueTerm.penaltyType || 'none',
    penaltyValue: revenueTerm.penaltyValue || 0,
    expectedMarginAtRisk,
    expectedPenaltyAtRisk,
    expectedTotalAtRisk: expectedMarginAtRisk + expectedPenaltyAtRisk,
    riskInputMode,
    // Inputs for traceability
    inputs: {
      shortageQty: riskInput.shortageQty,
      pStockout: riskInput.pStockout,
      expectedShortageQty: riskInput.expectedShortageQty
    }
  };
}

/**
 * Batch calculate margin at risk for multiple keys
 * 
 * @param {Array<RiskInput>} riskInputs - Array of risk inputs
 * @param {Object<string, RevenueTerm>} revenueTermsMap - Map of 'FG|Plant' -> RevenueTerm
 * @param {string} riskInputMode - 'deterministic' or 'probabilistic'
 * @param {Object} options - Calculation options
 * @returns {Object} batch results with KPIs
 */
export function calculateMarginAtRiskBatch(riskInputs, revenueTermsMap, riskInputMode, options = {}) {
  const startTime = Date.now();
  
  const {
    warnKeys = REVENUE_WARN_KEYS,
    stopKeys = REVENUE_STOP_KEYS,
    topN = 500
  } = options;
  
  // Guard: no inputs
  if (!Array.isArray(riskInputs) || riskInputs.length === 0) {
    return {
      success: false,
      error: 'No risk inputs provided',
      results: [],
      kpis: null,
      degraded: false
    };
  }
  
  // Guard: no revenue terms
  if (!revenueTermsMap || Object.keys(revenueTermsMap).length === 0) {
    return {
      success: false,
      error: 'No revenue terms available',
      results: [],
      kpis: null,
      degraded: false,
      degradedReason: 'no_revenue_terms'
    };
  }
  
  // Performance guard: too many keys
  const totalKeys = riskInputs.length;
  let degraded = false;
  let degradedReason = null;
  let keysToProcess = riskInputs;
  
  if (totalKeys > stopKeys) {
    return {
      success: false,
      error: `Too many keys (${totalKeys} > ${stopKeys})`,
      results: [],
      kpis: null,
      degraded: true,
      degradedReason: 'keys_limit_exceeded'
    };
  }
  
  if (totalKeys > warnKeys) {
    degraded = true;
    degradedReason = `keys_limit_warning:${totalKeys}`;
    // Still process, but flag as degraded
  }
  
  // Limit to topN if specified
  if (topN && totalKeys > topN) {
    keysToProcess = riskInputs.slice(0, topN);
    degraded = true;
    degradedReason = `top_n_applied:${topN}`;
  }
  
  // Calculate for each key
  const results = [];
  const errors = [];
  let totalMarginAtRisk = 0;
  let totalPenaltyAtRisk = 0;
  let topFg = { fgMaterialCode: null, plantId: null, marginAtRisk: 0 };
  
  for (const riskInput of keysToProcess) {
    const key = `${riskInput.fgMaterialCode}|${riskInput.plantId}`;
    const revenueTerm = revenueTermsMap[key];
    
    if (!revenueTerm) {
      errors.push(`No revenue term for ${key}`);
      continue;
    }
    
    const result = calculateMarginAtRiskForKey(riskInput, revenueTerm, riskInputMode);
    
    if (result.error) {
      errors.push(result.error);
      continue;
    }
    
    results.push(result);
    totalMarginAtRisk += result.expectedMarginAtRisk;
    totalPenaltyAtRisk += result.expectedPenaltyAtRisk;
    
    // Track top FG
    if (result.expectedMarginAtRisk > topFg.marginAtRisk) {
      topFg = {
        fgMaterialCode: result.fgMaterialCode,
        plantId: result.plantId,
        marginAtRisk: result.expectedMarginAtRisk
      };
    }
  }
  
  const computeMs = Date.now() - startTime;
  
  return {
    success: true,
    results,
    degraded,
    degradedReason,
    kpis: {
      totalKeys: results.length,
      totalMarginAtRisk,
      totalPenaltyAtRisk,
      totalAtRisk: totalMarginAtRisk + totalPenaltyAtRisk,
      topFg,
      errors: errors.length
    },
    metrics: {
      computeMs,
      inputKeys: totalKeys,
      processedKeys: keysToProcess.length
    }
  };
}

// ============================================================
// KPI Computation
// ============================================================

/**
 * Compute KPIs from margin at risk results
 * 
 * @param {Array<Object>} results - Array of margin at risk results
 * @returns {Object} KPIs summary
 */
export function computeMarginAtRiskKPIs(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return {
      overall: {
        totalKeys: 0,
        totalMarginAtRisk: 0,
        totalPenaltyAtRisk: 0,
        totalAtRisk: 0
      },
      topFg: null,
      byPlant: {},
      byTimeBucket: {}
    };
  }
  
  let totalMarginAtRisk = 0;
  let totalPenaltyAtRisk = 0;
  let topFg = { fgMaterialCode: null, plantId: null, marginAtRisk: 0, totalAtRisk: 0 };
  const byPlant = {};
  const byTimeBucket = {};
  
  for (const r of results) {
    totalMarginAtRisk += r.expectedMarginAtRisk || 0;
    totalPenaltyAtRisk += r.expectedPenaltyAtRisk || 0;
    
    const totalAtRisk = (r.expectedMarginAtRisk || 0) + (r.expectedPenaltyAtRisk || 0);
    
    // Top FG
    if (totalAtRisk > topFg.totalAtRisk) {
      topFg = {
        fgMaterialCode: r.fgMaterialCode,
        plantId: r.plantId,
        marginAtRisk: r.expectedMarginAtRisk,
        penaltyAtRisk: r.expectedPenaltyAtRisk,
        totalAtRisk
      };
    }
    
    // By plant
    if (!byPlant[r.plantId]) {
      byPlant[r.plantId] = { margin: 0, penalty: 0, keys: 0 };
    }
    byPlant[r.plantId].margin += r.expectedMarginAtRisk || 0;
    byPlant[r.plantId].penalty += r.expectedPenaltyAtRisk || 0;
    byPlant[r.plantId].keys++;
    
    // By time bucket
    if (!byTimeBucket[r.timeBucket]) {
      byTimeBucket[r.timeBucket] = { margin: 0, penalty: 0, keys: 0 };
    }
    byTimeBucket[r.timeBucket].margin += r.expectedMarginAtRisk || 0;
    byTimeBucket[r.timeBucket].penalty += r.expectedPenaltyAtRisk || 0;
    byTimeBucket[r.timeBucket].keys++;
  }
  
  return {
    overall: {
      totalKeys: results.length,
      totalMarginAtRisk,
      totalPenaltyAtRisk,
      totalAtRisk: totalMarginAtRisk + totalPenaltyAtRisk
    },
    topFg,
    byPlant,
    byTimeBucket
  };
}

// ============================================================
// Validation Functions
// ============================================================

/**
 * Validate revenue term
 * 
 * @param {RevenueTerm} term - Revenue term to validate
 * @returns {Object} validation result
 */
export function validateRevenueTerm(term) {
  const errors = [];
  
  if (!term.fgMaterialCode) {
    errors.push('Missing fg_material_code');
  }
  
  if (!term.plantId) {
    errors.push('Missing plant_id');
  }
  
  if (typeof term.marginPerUnit !== 'number' || isNaN(term.marginPerUnit)) {
    errors.push('Missing or invalid margin_per_unit');
  }
  
  if (term.marginPerUnit < 0) {
    errors.push('margin_per_unit cannot be negative');
  }
  
  if (term.penaltyType && !['none', 'per_unit', 'percent_of_revenue'].includes(term.penaltyType)) {
    errors.push('Invalid penalty_type');
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}
