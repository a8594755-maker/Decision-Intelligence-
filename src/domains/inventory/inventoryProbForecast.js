/**
 * Milestone 4-B: Probabilistic Inventory Forecast (Monte Carlo)
 * 
 * Pure functions for Monte Carlo simulation of inventory projections.
 * 
 * Core capabilities:
 * - Lognormal sampling from p10/p50/p90 demand distributions
 * - Two-point mixture sampling for PO arrival buckets
 * - Monte Carlo trials with configurable count and seed
 * - Quantile extraction for summary and series outputs
 * - BOM multiplier map for FG demand propagation to components
 */

// ============================================================
// Constants
// ============================================================

// Z-score for 10th and 90th percentiles (standard normal)
const Z_P10 = -1.281551565545;
const Z_P90 = 1.281551565545;
const Z_P90_ABS = 1.281551565545;

// Default fallback CV when only p50 is available
const DEFAULT_CV = 0.2;

// Maximum trials/buckets/keys safeguard
const MAX_KEYS_FOR_SERIES = 1000;
const MAX_TRIALS = 10000;

// ============================================================
// Random Number Generator (seeded for reproducibility)
// ============================================================

/**
 * Simple seeded RNG (Mulberry32) for reproducible Monte Carlo
 * @param {number} seed - Seed value
 * @returns {Function} - Random number generator (0-1)
 */
export function createSeededRng(seed) {
  let s = seed || Math.floor(Math.random() * 0x100000000);
  
  return function() {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Standard normal random variate (Box-Muller)
 * @param {Function} rng - Random number generator (0-1)
 * @returns {number} - Standard normal variate
 */
export function randn(rng) {
  const u1 = rng();
  const u2 = rng();
  const mag = Math.sqrt(-2 * Math.log(u1));
  const z0 = mag * Math.cos(2 * Math.PI * u2);
  return z0;
}

// ============================================================
// Distribution Sampling Functions
// ============================================================

/**
 * Compute lognormal parameters (mu, sigma) from p10/p50/p90
 * Returns null if inputs are invalid
 */
export function lognormalParamsFromP10P50P90(p10, p50, p90) {
  // Guards
  if (!(p10 > 0 && p50 > 0 && p90 > 0)) return null;
  if (!(p90 >= p50 && p50 >= p10)) return null;
  
  const mu = Math.log(p50); // median
  const sigma = (Math.log(p90) - Math.log(p10)) / (2 * Z_P90_ABS);
  
  if (!(sigma > 0)) return null;
  
  return { mu, sigma };
}

/**
 * Sample from lognormal distribution
 */
export function sampleLognormal(mu, sigma, rng) {
  return Math.exp(mu + sigma * randn(rng));
}

/**
 * Sample from triangular distribution (fallback when p10/p90 unavailable)
 * @param {number} low - Low value
 * @param {number} mode - Mode (most likely)
 * @param {number} high - High value
 */
export function sampleTriangular(low, mode, high, rng) {
  const u = rng();
  const c = (mode - low) / (high - low);
  
  if (u <= c) {
    return low + Math.sqrt(u * (high - low) * (mode - low));
  } else {
    return high - Math.sqrt((1 - u) * (high - low) * (high - mode));
  }
}

/**
 * Sample demand with fallback strategies
 * - If p10/p50/p90 available: use lognormal
 * - If only p50 available: use triangular with +/- 20%
 * - Otherwise: return p50 (deterministic)
 */
export function sampleDemand(demandDist, rng) {
  const { p10, p50, p90 } = demandDist;
  
  // Deterministic case: all quantiles are equal
  if (p10 !== undefined && p50 !== undefined && p90 !== undefined) {
    if (p10 === p50 && p50 === p90) {
      return p50;
    }
  }
  
  // Lognormal if all three available and different
  if (p10 !== undefined && p50 !== undefined && p90 !== undefined) {
    const params = lognormalParamsFromP10P50P90(p10, p50, p90);
    if (params) {
      return sampleLognormal(params.mu, params.sigma, rng);
    }
  }
  
  // Triangular fallback with +/- 20%
  if (p50 !== undefined && p50 > 0) {
    const low = p50 * 0.8;
    const high = p50 * 1.2;
    return sampleTriangular(low, p50, high, rng);
  }
  
  // Deterministic fallback
  return p50 || 0;
}

/**
 * Sample PO arrival bucket using two-point mixture
 * P(arrive at p50Bucket) = 1 - delayProb
 * P(arrive at p90Bucket) = delayProb
 */
export function sampleArrivalBucket(poForecast, rng) {
  const { arrivalP50Bucket, arrivalP90Bucket, delayProb = 0 } = poForecast;
  
  // If no delay probability or buckets are same, return p50
  if (!delayProb || delayProb <= 0 || arrivalP50Bucket === arrivalP90Bucket) {
    return arrivalP50Bucket;
  }
  
  const u = rng();
  return (u < (1 - delayProb)) ? arrivalP50Bucket : arrivalP90Bucket;
}

// ============================================================
// BOM Multiplier Map (FG Demand Propagation)
// ============================================================

/**
 * Build BOM multiplier map: FG -> array of {materialCode, plantId, multiplier}
 * 
 * This creates a lookup table for efficient demand propagation without
 * traversing the BOM DAG for every trial.
 * 
 * @param {Array} bomEdges - Array of {parent_code, component_code, plant_id, qty_per}
 * @returns {Map} - Map<fgMaterial, Array<{materialCode, plantId, multiplier}>>
 */
export function buildBomMultiplierMap(bomEdges) {
  const adjacency = new Map(); // parent -> [{child, qty_per}]
  const allMaterials = new Set();
  
  // Build adjacency list
  for (const edge of bomEdges) {
    const parent = edge.parent_code;
    const child = edge.component_code;
    const plantId = edge.plant_id;
    const qtyPer = parseFloat(edge.qty_per) || 1;
    
    if (!adjacency.has(parent)) {
      adjacency.set(parent, []);
    }
    adjacency.get(parent).push({ child, plantId, qtyPer });
    
    allMaterials.add(parent);
    allMaterials.add(child);
  }
  
  // Find root nodes (FGs) - materials that are parents but never children
  const childrenSet = new Set();
  for (const [, children] of adjacency) {
    for (const { child } of children) {
      childrenSet.add(child);
    }
  }
  
  const rootMaterials = [];
  for (const material of allMaterials) {
    if (!childrenSet.has(material) && adjacency.has(material)) {
      rootMaterials.push(material);
    }
  }
  
  // DFS to build multiplier map for each root
  const multiplierMap = new Map();
  
  for (const root of rootMaterials) {
    const componentMap = new Map(); // key -> accumulated multiplier
    const stack = [[root, 1, null]]; // [material, multiplier, plantId]
    const visited = new Set();
    
    while (stack.length > 0) {
      const [material, multiplier, parentPlantId] = stack.pop();
      
      // Add to component map (skip the root itself for FG components)
      if (material !== root) {
        const key = `${material}|${parentPlantId || 'PLANT-01'}`;
        const existing = componentMap.get(key) || 0;
        componentMap.set(key, existing + multiplier);
      }
      
      // Traverse children
      const children = adjacency.get(material);
      if (children) {
        for (const { child, plantId, qtyPer } of children) {
          // Cycle detection
          const edgeKey = `${material}->${child}`;
          if (!visited.has(edgeKey)) {
            visited.add(edgeKey);
            const childMultiplier = multiplier * qtyPer;
            const childPlantId = plantId || parentPlantId || 'PLANT-01';
            stack.push([child, childMultiplier, childPlantId]);
          }
        }
      }
    }
    
    // Convert map to array
    const components = [];
    for (const [key, mult] of componentMap) {
      const [materialCode, plantId] = key.split('|');
      components.push({ materialCode, plantId, multiplier: mult });
    }
    
    multiplierMap.set(root, components);
  }
  
  return multiplierMap;
}

/**
 * Propagate FG demand to component demand using multiplier map
 * 
 * @param {Map} fgDemandByBucket - Map<fgMaterial, Map<bucket, demandDist>>
 * @param {Map} multiplierMap - From buildBomMultiplierMap
 * @param {Function} rng - Random number generator
 * @returns {Map} - Map<key, Map<bucket, sampledDemand>>
 */
export function propagateDemandToComponents(fgDemandByBucket, multiplierMap, rng) {
  const componentDemand = new Map(); // key -> Map<bucket, demand>
  
  for (const [fgMaterial, bucketDemandMap] of fgDemandByBucket) {
    const components = multiplierMap.get(fgMaterial);
    if (!components) continue;
    
    for (const [bucket, demandDist] of bucketDemandMap) {
      // Sample FG demand once per bucket
      const sampledFgDemand = sampleDemand(demandDist, rng);
      
      // Distribute to components
      for (const { materialCode, plantId, multiplier } of components) {
        const key = `${materialCode}|${plantId}`;
        const componentQty = sampledFgDemand * multiplier;
        
        if (!componentDemand.has(key)) {
          componentDemand.set(key, new Map());
        }
        const bucketMap = componentDemand.get(key);
        const existing = bucketMap.get(bucket) || 0;
        bucketMap.set(bucket, existing + componentQty);
      }
    }
  }
  
  return componentDemand;
}

// ============================================================
// Monte Carlo Simulation Core
// ============================================================

/**
 * Run a single trial of inventory projection
 * 
 * @param {Object} params
 * @param {Map} startingInventory - Map<key, {onHand}>
 * @param {Map} demandByKeyBucket - Map<key, Map<bucket, demandDist>>
 * @param {Array} poForecasts - Array of PO forecasts with arrival buckets
 * @param {Array} timeBuckets - Array of bucket strings
 * @param {Function} rng - Random number generator
 * @returns {Object} - Trial result with endInventory, stockoutInfo
 */
export function runSingleTrial({
  startingInventory,
  demandByKeyBucket,
  poForecasts,
  timeBuckets,
  rng
}) {
  // Deep copy starting inventory
  const currentInventory = new Map();
  for (const [key, inv] of startingInventory) {
    currentInventory.set(key, { onHand: inv.onHand || 0 });
  }
  
  // Aggregate inbound by key+bucket from PO forecasts
  const inboundByKeyBucket = new Map(); // key -> Map<bucket, qty>
  
  for (const po of poForecasts) {
    const key = `${po.materialCode}|${po.plantId}`;
    const arrivalBucket = sampleArrivalBucket(po, rng);
    const qty = po.openQty || 0;
    
    if (!inboundByKeyBucket.has(key)) {
      inboundByKeyBucket.set(key, new Map());
    }
    const bucketMap = inboundByKeyBucket.get(key);
    const existing = bucketMap.get(arrivalBucket) || 0;
    bucketMap.set(arrivalBucket, existing + qty);
  }
  
  // Track per-bucket inventory and stockout info
  const bucketResults = []; // Array of {bucket, endOnHand, shortage}
  let stockoutBucket = null;
  let minAvailable = Infinity;
  let totalShortage = 0;
  
  for (const bucket of timeBuckets) {
    // Get inbound for this bucket
    const inboundMap = inboundByKeyBucket;
    let inboundQty = 0;
    for (const [_key, bucketMap] of inboundMap) {
      if (bucketMap.has(bucket)) {
        inboundQty += bucketMap.get(bucket);
      }
    }
    
    // Get demand for this bucket (sum across all keys)
    let demandQty = 0;
    for (const [_key, bucketDemandMap] of demandByKeyBucket) {
      if (bucketDemandMap.has(bucket)) {
        const dist = bucketDemandMap.get(bucket);
        demandQty += sampleDemand(dist, rng);
      }
    }
    
    // Update inventory for all keys (simplified: aggregate view)
    // In real implementation, this would be per-key
    let totalOnHand = 0;
    for (const [, inv] of currentInventory) {
      totalOnHand += inv.onHand;
    }
    
    const newOnHand = totalOnHand + inboundQty - demandQty;
    const available = newOnHand; // Simplified, could subtract safety stock
    
    // Track min available
    if (available < minAvailable) {
      minAvailable = available;
    }
    
    // Check stockout
    const shortage = available < 0 ? -available : 0;
    if (shortage > 0) {
      totalShortage += shortage;
      if (stockoutBucket === null) {
        stockoutBucket = bucket;
      }
    }
    
    bucketResults.push({
      bucket,
      endOnHand: newOnHand,
      available,
      shortage
    });
    
    // Update inventory for next bucket
    for (const [, inv] of currentInventory) {
      inv.onHand = Math.max(0, newOnHand); // Simplified
    }
  }
  
  return {
    bucketResults,
    stockoutBucket,
    minAvailable: minAvailable === Infinity ? 0 : minAvailable,
    totalShortage
  };
}

/**
 * Run Monte Carlo simulation for a single key
 * 
 * @param {Object} params
 * @param {string} key - material|plant key
 * @param {Object} startingInv - {onHand, safetyStock}
 * @param {Map} demandByBucket - Map<bucket, demandDist>
 * @param {Array} poForecastsForKey - PO forecasts for this key
 * @param {Array} timeBuckets - Array of bucket strings
 * @param {number} trials - Number of Monte Carlo trials
 * @param {number} seed - RNG seed
 * @returns {Object} - Summary metrics and series quantiles
 */
export function runMonteCarloForKey({
  key,
  startingInv,
  demandByBucket,
  poForecastsForKey,
  timeBuckets,
  trials = 200,
  seed = 12345
}) {
  // Validate trials
  const actualTrials = Math.min(trials, MAX_TRIALS);
  
  // Create RNG
  const rng = createSeededRng(seed);
  
  // Run trials
  const trialResults = [];
  
  for (let i = 0; i < actualTrials; i++) {
    const result = runSingleTrial({
      startingInventory: new Map([[key, startingInv]]),
      demandByKeyBucket: new Map([[key, demandByBucket]]),
      poForecasts: poForecastsForKey,
      timeBuckets,
      rng
    });
    trialResults.push(result);
  }
  
  // Compute summary metrics
  const stockoutCount = trialResults.filter(t => t.stockoutBucket !== null).length;
  const pStockout = stockoutCount / actualTrials;
  
  // Stockout bucket quantiles (convert buckets to indices)
  const stockoutBuckets = trialResults
    .filter(t => t.stockoutBucket !== null)
    .map(t => t.stockoutBucket);
  
  let stockoutBucketP50 = null;
  let stockoutBucketP90 = null;
  
  if (stockoutBuckets.length > 0) {
    const bucketIndices = stockoutBuckets.map(b => timeBuckets.indexOf(b)).filter(i => i >= 0);
    bucketIndices.sort((a, b) => a - b);
    
    const p50Index = Math.floor(bucketIndices.length * 0.5);
    const p90Index = Math.min(Math.floor(bucketIndices.length * 0.9), bucketIndices.length - 1);
    
    stockoutBucketP50 = timeBuckets[bucketIndices[p50Index]];
    stockoutBucketP90 = timeBuckets[bucketIndices[p90Index]];
  }
  
  // Expected shortage
  const expectedShortage = trialResults.reduce((sum, t) => sum + t.totalShortage, 0) / actualTrials;
  
  // Expected min available
  const expectedMinAvailable = trialResults.reduce((sum, t) => sum + t.minAvailable, 0) / actualTrials;
  
  // Compute series quantiles per bucket
  const series = [];
  for (const bucket of timeBuckets) {
    const bucketIndex = timeBuckets.indexOf(bucket);
    const endOnHandValues = trialResults.map(t => t.bucketResults[bucketIndex]?.endOnHand || 0);
    endOnHandValues.sort((a, b) => a - b);
    
    const invP10 = endOnHandValues[Math.floor(endOnHandValues.length * 0.1)];
    const invP50 = endOnHandValues[Math.floor(endOnHandValues.length * 0.5)];
    const invP90 = endOnHandValues[Math.min(Math.floor(endOnHandValues.length * 0.9), endOnHandValues.length - 1)];
    
    // Per-bucket stockout probability
    const bucketStockoutCount = trialResults.filter(t => (t.bucketResults[bucketIndex]?.shortage || 0) > 0).length;
    const pStockoutBucket = bucketStockoutCount / actualTrials;
    
    series.push({
      bucket,
      invP10,
      invP50,
      invP90,
      pStockoutBucket
    });
  }
  
  return {
    key,
    trials: actualTrials,
    seed,
    summary: {
      pStockout,
      stockoutBucketP50,
      stockoutBucketP90,
      expectedShortageQty: expectedShortage,
      expectedMinAvailable: expectedMinAvailable
    },
    series
  };
}

/**
 * Main execution: Run probabilistic inventory forecast for multiple keys
 * 
 * @param {Object} inputs
 * @param {Array} inputs.timeBuckets - Array of bucket strings
 * @param {Map} inputs.startingInventory - Map<key, {onHand, safetyStock}>
 * @param {Map} inputs.demandByKeyBucket - Map<key, Map<bucket, demandDist>>
 * @param {Array} inputs.poForecasts - Array of PO forecasts
 * @param {Object} options - {trials, seed, maxKeysForSeries}
 * @returns {Object} - Complete forecast result with summaries and series
 */
export function executeInventoryProbForecast(inputs, options = {}) {
  const startTime = Date.now();
  const { timeBuckets, startingInventory, demandByKeyBucket, poForecasts } = inputs;
  
  const {
    trials = 200,
    seed = 12345,
    maxKeysForSeries = MAX_KEYS_FOR_SERIES
  } = options;
  
  try {
    const keyResults = [];
    const keys = Array.from(startingInventory.keys());
    
    // Limit keys for series if needed
    const keysForSeries = keys.slice(0, maxKeysForSeries);
    const isDegraded = keys.length > maxKeysForSeries;
    
    for (const key of keys) {
      const startingInv = startingInventory.get(key);
      const demandForKey = demandByKeyBucket.get(key) || new Map();
      
      // Filter PO forecasts for this key
      const poForecastsForKey = poForecasts.filter(po => 
        `${po.materialCode}|${po.plantId}` === key
      );
      
      const result = runMonteCarloForKey({
        key,
        startingInv,
        demandByBucket: demandForKey,
        poForecastsForKey,
        timeBuckets,
        trials,
        seed
      });
      
      keyResults.push(result);
    }
    
    const duration = Date.now() - startTime;
    
    return {
      success: true,
      keys: keyResults.map(r => ({
        key: r.key,
        trials: r.trials,
        summary: r.summary,
        // Only include series for limited keys to save memory/DB
        series: keysForSeries.includes(r.key) ? r.series : null
      })),
      metrics: {
        totalKeys: keys.length,
        keysWithSeries: keysForSeries.length,
        degraded: isDegraded,
        durationMs: duration,
        trials,
        seed
      }
    };
    
  } catch (error) {
    return {
      success: false,
      error: error.message,
      stack: error.stack
    };
  }
}

// ============================================================
// Utilities
// ============================================================

/**
 * Compute quantiles from an array of values
 */
export function computeQuantiles(values, quantiles = [0.1, 0.5, 0.9]) {
  const sorted = [...values].sort((a, b) => a - b);
  const result = {};
  
  for (const q of quantiles) {
    const index = Math.floor(sorted.length * q);
    const safeIndex = Math.min(index, sorted.length - 1);
    result[`p${Math.round(q * 100)}`] = sorted[safeIndex];
  }
  
  return result;
}

/**
 * Validate probabilistic forecast inputs
 */
export function validateInputs(inputs) {
  const errors = [];
  
  if (!inputs.timeBuckets || inputs.timeBuckets.length === 0) {
    errors.push('timeBuckets is required');
  }
  
  if (!inputs.startingInventory || inputs.startingInventory.size === 0) {
    errors.push('startingInventory is required');
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}
