/**
 * Milestone 7.1 WP1: Risk Score Engine (Pure Functions)
 * 
 * Score Formula: score = p_stockout * impact_usd * urgency_weight
 * 
 * Urgency Weights:
 * - W+0 (current week): 1.5
 * - W+1 (next week): 1.2
 * - W+2+ (later): 1.0
 * - No stockout risk: 0.5
 */

// ============================================================
// Constants
// ============================================================

export const RISK_SCORE_VERSION = '1.0.0';
export const RISK_SCORE_ALGORITHM = 'mvp_v1';

// Urgency weights based on stockout timing
export const URGENCY_WEIGHTS = {
  currentWeek: 1.5,    // W+0
  nextWeek: 1.2,       // W+1
  later: 1.0,          // W+2+
  noRisk: 0.5          // No stockout predicted
};

// ============================================================
// Type Definitions
// ============================================================

/**
 * @typedef {Object} RiskScoreInput
 * @property {string} materialCode - Material code
 * @property {string} plantId - Plant ID
 * @property {number} pStockout - Probability of stockout (0-1)
 * @property {number} impactUsd - Dollar impact from margin_at_risk (or 0)
 * @property {string} [earliestStockoutBucket] - When stockout occurs (e.g., '2026-W06')
 * @property {string} [currentBucket] - Current time bucket for urgency calc
 */

/**
 * @typedef {Object} RiskScoreResult
 * @property {string} materialCode - Material code
 * @property {string} plantId - Plant ID
 * @property {number} pStockout - Input P(stockout)
 * @property {number} impactUsd - Input $ impact
 * @property {string} [earliestStockoutBucket] - Stockout timing
 * @property {number} urgencyWeight - Calculated urgency multiplier
 * @property {number} score - Final risk score
 * @property {Object} breakdown - Full calculation breakdown
 */

// ============================================================
// Core Calculation Functions
// ============================================================

/**
 * Calculate urgency weight based on stockout bucket
 * 
 * Logic:
 * - If no stockout (null/undefined): 0.5
 * - If stockout in current week (same as currentBucket): 1.5
 * - If stockout in next week: 1.2
 * - If stockout in W+2 or later: 1.0
 * 
 * @param {string} [earliestStockoutBucket] - When stockout occurs
 * @param {string} [currentBucket] - Current time bucket (default: infer from stockout)
 * @returns {number} urgency weight
 */
export function calculateUrgencyWeight(earliestStockoutBucket, currentBucket = null) {
  // No stockout risk
  if (!earliestStockoutBucket) {
    return URGENCY_WEIGHTS.noRisk;
  }
  
  // If no current bucket provided, assume stockout is in future
  if (!currentBucket) {
    // Default to "next week" urgency if we don't know current time
    return URGENCY_WEIGHTS.nextWeek;
  }
  
  // Parse buckets (format: YYYY-WNN or similar)
  const current = parseBucket(currentBucket);
  const stockout = parseBucket(earliestStockoutBucket);
  
  if (!current || !stockout) {
    return URGENCY_WEIGHTS.later;
  }
  
  // Calculate week difference
  const weekDiff = bucketWeekDifference(current, stockout);
  
  if (weekDiff <= 0) {
    // Current week or past
    return URGENCY_WEIGHTS.currentWeek;
  } else if (weekDiff === 1) {
    // Next week
    return URGENCY_WEIGHTS.nextWeek;
  } else {
    // W+2 or later
    return URGENCY_WEIGHTS.later;
  }
}

/**
 * Parse time bucket string to comparable object
 * Supports formats like: 2026-W06, 2026-W6, 2026-06, etc.
 * 
 * @param {string} bucket - Time bucket string
 * @returns {Object|null} { year, week } or null if invalid
 */
export function parseBucket(bucket) {
  if (!bucket || typeof bucket !== 'string') {
    return null;
  }
  
  // Try to match patterns like "2026-W06" or "2026-W6"
  const match = bucket.match(/^(\d{4})-W?(\d{1,2})$/i);
  if (match) {
    return {
      year: parseInt(match[1], 10),
      week: parseInt(match[2], 10)
    };
  }
  
  // Try simple year-week format like "2026-06"
  const simpleMatch = bucket.match(/^(\d{4})-(\d{2})$/);
  if (simpleMatch) {
    const week = parseInt(simpleMatch[2], 10);
    // Assume it's a week if <= 53, otherwise might be month
    if (week <= 53) {
      return {
        year: parseInt(simpleMatch[1], 10),
        week: week
      };
    }
  }
  
  return null;
}

/**
 * Calculate week difference between two buckets
 * 
 * @param {Object} current - { year, week }
 * @param {Object} stockout - { year, week }
 * @returns {number} week difference (positive = future)
 */
export function bucketWeekDifference(current, stockout) {
  const currentTotalWeeks = current.year * 52 + current.week;
  const stockoutTotalWeeks = stockout.year * 52 + stockout.week;
  return stockoutTotalWeeks - currentTotalWeeks;
}

/**
 * Calculate risk score for a single key
 * 
 * Formula: score = p_stockout * impact_usd * urgency_weight
 * 
 * @param {RiskScoreInput} input - Risk score inputs
 * @returns {RiskScoreResult} calculated risk score
 */
export function calculateRiskScore(input) {
  const {
    materialCode,
    plantId,
    pStockout = 0,
    impactUsd = 0,
    earliestStockoutBucket = null,
    currentBucket = null
  } = input;
  
  // Validate inputs
  const validPStockout = Math.max(0, Math.min(1, pStockout || 0));
  const validImpactUsd = Math.max(0, impactUsd || 0);
  
  // Calculate urgency weight
  const urgencyWeight = calculateUrgencyWeight(earliestStockoutBucket, currentBucket);
  
  // Calculate final score
  const score = validPStockout * validImpactUsd * urgencyWeight;
  
  // Build breakdown for transparency
  const breakdown = {
    p_stockout: validPStockout,
    p_stockout_source: validPStockout > 0 ? 'probabilistic' : 'fallback',
    impact_usd: validImpactUsd,
    impact_source: validImpactUsd > 0 ? 'margin_at_risk' : 'no_revenue_data',
    earliest_stockout_bucket: earliestStockoutBucket,
    current_bucket: currentBucket,
    urgency_weight: urgencyWeight,
    urgency_calculation: getUrgencyExplanation(urgencyWeight, earliestStockoutBucket, currentBucket),
    formula: `${validPStockout} * ${validImpactUsd} * ${urgencyWeight} = ${score.toFixed(2)}`,
    version: RISK_SCORE_VERSION,
    algorithm: RISK_SCORE_ALGORITHM
  };
  
  return {
    materialCode,
    plantId,
    pStockout: validPStockout,
    impactUsd: validImpactUsd,
    earliestStockoutBucket,
    urgencyWeight,
    score: Math.round(score * 100) / 100, // Round to 2 decimals
    breakdown
  };
}

/**
 * Get human-readable explanation of urgency calculation
 * 
 * @param {number} weight - Calculated urgency weight
 * @param {string} [stockoutBucket] - Stockout bucket
 * @param {string} [currentBucket] - Current bucket
 * @returns {string} explanation
 */
function getUrgencyExplanation(weight, stockoutBucket, currentBucket) {
  if (weight === URGENCY_WEIGHTS.noRisk) {
    return 'No stockout predicted (weight=0.5)';
  }
  if (weight === URGENCY_WEIGHTS.currentWeek) {
    return `Stockout in current week ${stockoutBucket || ''} (weight=1.5)`;
  }
  if (weight === URGENCY_WEIGHTS.nextWeek) {
    return `Stockout in next week ${stockoutBucket || ''} vs current ${currentBucket || ''} (weight=1.2)`;
  }
  return `Stockout in W+2+ ${stockoutBucket || ''} (weight=1.0)`;
}

// ============================================================
// Batch Processing
// ============================================================

/**
 * Calculate risk scores for multiple keys
 * 
 * @param {Array<RiskScoreInput>} inputs - Array of risk score inputs
 * @param {Object} options - Calculation options
 * @returns {Object} batch results with KPIs
 */
export function calculateRiskScoreBatch(inputs, options = {}) {
  const startTime = Date.now();
  
  const {
    currentBucket = null,
    maxKeys = 1000
  } = options;
  
  // Guard: no inputs
  if (!Array.isArray(inputs) || inputs.length === 0) {
    return {
      success: false,
      error: 'No inputs provided',
      results: [],
      kpis: null
    };
  }
  
  // Guard: too many keys
  if (inputs.length > maxKeys) {
    return {
      success: false,
      error: `Too many keys (${inputs.length} > ${maxKeys})`,
      results: [],
      kpis: null
    };
  }
  
  // Calculate for each key
  const results = [];
  let totalScore = 0;
  let maxScore = 0;
  let topKey = null;
  
  for (const input of inputs) {
    // Add current bucket if not provided
    const inputWithBucket = {
      ...input,
      currentBucket: input.currentBucket || currentBucket
    };
    
    const result = calculateRiskScore(inputWithBucket);
    results.push(result);
    
    totalScore += result.score;
    
    if (result.score > maxScore) {
      maxScore = result.score;
      topKey = {
        materialCode: result.materialCode,
        plantId: result.plantId,
        score: result.score
      };
    }
  }
  
  // Sort by score descending
  results.sort((a, b) => b.score - a.score);
  
  const computeMs = Date.now() - startTime;
  
  return {
    success: true,
    results,
    kpis: {
      totalKeys: results.length,
      totalScore: Math.round(totalScore * 100) / 100,
      avgScore: Math.round((totalScore / results.length) * 100) / 100,
      maxScore: Math.round(maxScore * 100) / 100,
      topKey,
      highRiskCount: results.filter(r => r.score > 10000).length,
      mediumRiskCount: results.filter(r => r.score > 1000 && r.score <= 10000).length,
      lowRiskCount: results.filter(r => r.score <= 1000).length
    },
    metrics: {
      computeMs,
      inputKeys: inputs.length,
      version: RISK_SCORE_VERSION
    }
  };
}

// ============================================================
// Utilities
// ============================================================

import axios from 'axios';

const ML_API_ENDPOINT = import.meta.env.VITE_ML_API_ENDPOINT || 'http://localhost:8000';

async function getDemandPrediction(materialCode) {
  try {
    const response = await axios.post(`${ML_API_ENDPOINT}/demand-forecast`, {
      materialCode,
      horizonDays: 30
    });
    return {
      dailyDemand: response.data.predictedDemand,
      fluctuation: (response.data.confidenceInterval[1] - response.data.confidenceInterval[0]) / response.data.predictedDemand
    };
  } catch (error) {
    console.error("ML API error", error);
    return getLegacyDemand(materialCode);
  }
}

// Legacy demand calculation (fallback)
function getLegacyDemand(materialCode) {
  // Existing implementation
}

/**
 * Normalize key for consistent lookup
 * 
 * @param {string} materialCode - Material code
 * @param {string} plantId - Plant ID
 * @returns {string} normalized key "material|plant"
 */
export function normalizeRiskKey(materialCode, plantId) {
  return `${materialCode}|${plantId}`;
}

/**
 * Parse normalized key back to components
 * 
 * @param {string} key - Normalized key "material|plant"
 * @returns {Object} { materialCode, plantId }
 */
export function parseRiskKey(key) {
  const parts = key.split('|');
  return {
    materialCode: parts[0] || '',
    plantId: parts[1] || ''
  };
}

/**
 * Validate risk score inputs
 * 
 * @param {RiskScoreInput} input - Input to validate
 * @returns {Object} { valid: boolean, errors: string[] }
 */
export function validateRiskScoreInput(input) {
  const errors = [];
  
  if (!input.materialCode) {
    errors.push('Missing material_code');
  }
  
  if (!input.plantId) {
    errors.push('Missing plant_id');
  }
  
  if (typeof input.pStockout !== 'number' || input.pStockout < 0 || input.pStockout > 1) {
    errors.push('p_stockout must be between 0 and 1');
  }
  
  if (typeof input.impactUsd !== 'number' || input.impactUsd < 0) {
    errors.push('impact_usd must be non-negative');
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}
