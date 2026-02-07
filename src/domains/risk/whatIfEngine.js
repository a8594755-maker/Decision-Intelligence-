/**
 * Milestone 7.2 WP2: What-if Engine (MVP)
 * 
 * Expedite Action v1:
 * - Shift inbound arrivals earlier by N buckets
 * - Recalculate projection (deterministic or probabilistic)
 * - Compute before/after KPIs and ROI
 */

const ENGINE_VERSION = '1.0.0';

// ============================================================
// Types
// ============================================================

/**
 * @typedef {Object} WhatIfAction
 * @property {string} type - 'expedite' | 'substitute' | 'do_nothing'
 * @property {number} byBuckets - Number of buckets to expedite (for expedite type)
 * @property {string} scope - 'single_key' | 'top_n'
 */

/**
 * @typedef {Object} InboundLine
 * @property {string} poNumber
 * @property {string} bucket - Arrival bucket
 * @property {number} qty
 */

/**
 * @typedef {Object} WhatIfInput
 * @property {string} materialCode
 * @property {string} plantId
 * @property {number} onHand
 * @property {number} safetyStock
 * @property {InboundLine[]} inboundLines - Current inbound schedule
 * @property {number} gapQty - Current shortage
 * @property {string} nextStockoutBucket
 */

/**
 * @typedef {Object} WhatIfResult
 * @property {boolean} success
 * @property {Object} before
 * @property {Object} after
 * @property {Object} delta
 * @property {number} roi
 * @property {Object} action
 */

// ============================================================
// Expedite Action
// ============================================================

/**
 * Apply expedite action to inbound lines
 * Shifts each inbound line earlier by N buckets
 * 
 * @param {InboundLine[]} inboundLines - Original inbound schedule
 * @param {number} byBuckets - Number of buckets to shift earlier
 * @returns {InboundLine[]} Expedited inbound schedule
 */
export function applyExpediteAction(inboundLines, byBuckets) {
  if (!Array.isArray(inboundLines) || inboundLines.length === 0) {
    return [];
  }
  
  return inboundLines.map(line => {
    const originalBucket = line.bucket;
    const expeditedBucket = shiftBucketEarlier(originalBucket, byBuckets);
    
    return {
      ...line,
      originalBucket,      // Keep for reference
      bucket: expeditedBucket,
      expedited: expeditedBucket !== originalBucket
    };
  });
}

/**
 * Shift a bucket string earlier by N buckets
 * Supports formats: 2026-W06, 2026-06, etc.
 * 
 * @param {string} bucket - Original bucket
 * @param {number} byBuckets - Number of buckets to shift
 * @returns {string} Shifted bucket
 */
function shiftBucketEarlier(bucket, byBuckets) {
  if (!bucket || typeof bucket !== 'string') {
    return bucket;
  }
  
  // Parse week-based bucket: 2026-W06
  const weekMatch = bucket.match(/^(\d{4})-W(\d{1,2})$/i);
  if (weekMatch) {
    const year = parseInt(weekMatch[1], 10);
    const week = parseInt(weekMatch[2], 10);
    
    // Calculate new week
    let newWeek = week - byBuckets;
    let newYear = year;
    
    // Handle year wrap
    while (newWeek <= 0) {
      newYear--;
      newWeek += 52;
    }
    
    return `${newYear}-W${String(newWeek).padStart(2, '0')}`;
  }
  
  // Parse month-based bucket: 2026-06
  const monthMatch = bucket.match(/^(\d{4})-(\d{2})$/);
  if (monthMatch) {
    const year = parseInt(monthMatch[1], 10);
    const month = parseInt(monthMatch[2], 10);
    
    // Assume it's a month if > 12
    if (month > 12) {
      // It's actually a week, treat as week
      let newWeek = month - byBuckets;
      let newYear = year;
      while (newWeek <= 0) {
        newYear--;
        newWeek += 52;
      }
      return `${newYear}-W${String(newWeek).padStart(2, '0')}`;
    }
    
    // It's a month
    let newMonth = month - byBuckets;
    let newYear = year;
    while (newMonth <= 0) {
      newYear--;
      newMonth += 12;
    }
    return `${newYear}-${String(newMonth).padStart(2, '0')}`;
  }
  
  // Unknown format, return as-is
  return bucket;
}

/**
 * Calculate stockout probability after expedite
 * MVP: Deterministic logic - if expedite covers the gap, P(stockout) decreases
 * 
 * @param {WhatIfInput} input - Current state
 * @param {InboundLine[]} expeditedInbound - Expedited inbound schedule
 * @returns {number} New P(stockout) 0-1
 */
export function calculateExpeditedStockoutProbability(input, expeditedInbound) {
  const { onHand, safetyStock, gapQty } = input;
  
  // Net available after safety stock
  const netAvailable = onHand - safetyStock;
  
  // Calculate total expedited inbound arriving before/at stockout bucket
  const expeditedQty = expeditedInbound
    .filter(line => line.expedited)
    .reduce((sum, line) => sum + (line.qty || 0), 0);
  
  // Simple deterministic model:
  // If we expedite enough to cover the gap, P(stockout) reduces
  // Formula: P_after = max(0, P_before * (1 - expeditedQty / max(gap, 1)))
  
  if (gapQty <= 0) {
    return 0; // No gap, no risk
  }
  
  if (expeditedQty >= gapQty) {
    return 0; // Expedite covers gap
  }
  
  // Partial coverage: reduce probability proportionally
  const coverageRatio = expeditedQty / gapQty;
  const originalPStockout = 1.0; // Assume 100% if there's a gap
  const newPStockout = originalPStockout * (1 - coverageRatio);
  
  return Math.max(0, Math.min(1, newPStockout));
}

// ============================================================
// What-if Calculation
// ============================================================

/**
 * Run what-if scenario calculation
 * MVP: Expedite action only
 * 
 * @param {WhatIfInput} input - Baseline state
 * @param {WhatIfAction} action - Action to apply
 * @returns {WhatIfResult} Before/after comparison
 */
export function runWhatIfScenario(input, action) {
  const startMs = Date.now();
  
  // Validate
  if (!input || !action) {
    return {
      success: false,
      error: 'Missing input or action',
      before: null,
      after: null,
      delta: null,
      roi: 0
    };
  }
  
  // Calculate BEFORE state
  const before = calculateBeforeState(input);
  
  // Apply action
  let after;
  switch (action.type) {
    case 'expedite':
      after = calculateExpediteAfter(input, action);
      break;
    case 'do_nothing':
      after = { ...before }; // No change
      break;
    default:
      return {
        success: false,
        error: `Unsupported action type: ${action.type}`,
        before,
        after: null,
        delta: null,
        roi: 0
      };
  }
  
  // Calculate deltas
  const delta = {
    pStockout: after.pStockout - before.pStockout,
    score: after.score - before.score,
    impactUsd: after.impactUsd - before.impactUsd,
    costUsd: after.costUsd - before.costUsd
  };
  
  // Calculate ROI
  // ROI = (Benefit - Cost) / Cost
  // Benefit = reduction in impact (negative delta_impact means benefit)
  const benefit = -delta.impactUsd; // Negative impact change = positive benefit
  const cost = delta.costUsd;
  const roi = cost > 0 ? (benefit - cost) / cost : 0;
  
  const computeMs = Date.now() - startMs;
  
  return {
    success: true,
    before,
    after,
    delta,
    roi: Math.round(roi * 100) / 100, // Round to 2 decimals
    action: {
      ...action,
      version: ENGINE_VERSION,
      computeMs
    }
  };
}

/**
 * Calculate BEFORE state (baseline)
 */
function calculateBeforeState(input) {
  const { pStockout = 1.0, impactUsd = 0, costUsd = 0 } = input;
  
  // Score = P(stockout) * impact * urgency
  // For simplicity, assume urgency = 1.0 for baseline
  const score = pStockout * impactUsd * 1.0;
  
  return {
    pStockout,
    score: Math.round(score * 100) / 100,
    impactUsd,
    costUsd
  };
}

/**
 * Calculate AFTER state for expedite action
 */
function calculateExpediteAfter(input, action) {
  const { byBuckets = 1 } = action;
  const { inboundLines = [], impactUsd = 0 } = input;
  
  // Apply expedite to inbound
  const expeditedInbound = applyExpediteAction(inboundLines, byBuckets);
  
  // Calculate new P(stockout)
  const newPStockout = calculateExpeditedStockoutProbability(input, expeditedInbound);
  
  // Calculate new impact (reduced by expedite coverage)
  const coverageRatio = 1 - newPStockout; // 0-1
  const newImpactUsd = impactUsd * (1 - coverageRatio * 0.5); // 50% reduction max
  
  // Calculate expedite cost (simplified: $100 per bucket per PO line)
  const expeditedCount = expeditedInbound.filter(l => l.expedited).length;
  const expediteCost = expeditedCount * byBuckets * 100; // $100 per PO per bucket
  
  // New score
  const newScore = newPStockout * newImpactUsd * 1.0;
  
  return {
    pStockout: Math.round(newPStockout * 100) / 100,
    score: Math.round(newScore * 100) / 100,
    impactUsd: Math.round(newImpactUsd * 100) / 100,
    costUsd: expediteCost,
    expeditedInbound
  };
}

// ============================================================
// Utilities
// ============================================================

/**
 * Normalize key for consistent lookup
 */
export function normalizeWhatIfKey(materialCode, plantId) {
  return `${materialCode}|${plantId}`;
}

/**
 * Batch process what-if for multiple keys
 */
export function runWhatIfBatch(inputs, action, options = {}) {
  const { maxKeys = 100 } = options;
  const results = [];
  
  for (const input of inputs.slice(0, maxKeys)) {
    const result = runWhatIfScenario(input, action);
    if (result.success) {
      results.push({
        key: normalizeWhatIfKey(input.materialCode, input.plantId),
        ...result
      });
    }
  }
  
  return {
    success: true,
    count: results.length,
    results,
    action,
    version: ENGINE_VERSION
  };
}

export { ENGINE_VERSION };
