/**
 * Milestone 4-B: Probabilistic Inventory Forecast Service
 * 
 * Service layer for running Monte Carlo simulations and persisting results.
 * 
 * APIs:
 * - runInventoryProbForecast(userId, bomRunId, options) - Run MC and save results
 * - getInventoryProbSummaryByRun(userId, bomRunId) - Fetch summary for a run
 * - getInventoryProbSeriesByRun(userId, bomRunId, key) - Fetch series for a key
 * - deleteInventoryProbResults(userId, bomRunId) - Clean up old results
 */

import { supabase } from './supabaseClient';
import { logEvent, EVENT_TYPES, ENTITY_TYPES } from './auditService';
import {
  executeInventoryProbForecast,
  buildBomMultiplierMap,
  validateInputs
} from '../domains/inventory/inventoryProbForecast';

// ============================================================
// Constants
// ============================================================

const DEFAULT_TRIALS = 200;
const MAX_TRIALS_LIMIT = 10000;
const MAX_KEYS_FOR_SERIES = 1000;
const DEFAULT_SEED = 12345;

// Step 4 (P1): Safeguards and thresholds
const DEGRADED_MODE_THRESHOLD = {
  trials: 5000,      // Above this, use degraded mode
  keys: 500,         // Above this, limit series storage
  buckets: 52        // Above this, warn about performance
};

const VERSION = {
  mc: '1.0.0',       // Monte Carlo engine version
  arrival: '2point-mixture-v1',  // Arrival sampling version
  demand: 'lognormal-triangular-fallback-v1'  // Demand distribution version
};

// ============================================================
// Main Run Function
// ============================================================

/**
 * Run probabilistic inventory forecast for a BOM explosion run
 * 
 * @param {string} userId - User ID
 * @param {string} bomRunId - BOM explosion forecast run ID
 * @param {Object} options - Run options
 * @param {number} options.trials - Number of MC trials (default: 200)
 * @param {number} options.seed - RNG seed (default: 12345)
 * @param {string} options.inboundSource - 'raw_po' | 'supply_forecast' (optional, overrides BOM run)
 * @param {string} options.demandSource - 'uploaded' | 'demand_forecast' (optional, overrides BOM run)
 * @returns {Object} - Run result with mode, performance metrics, and KPIs
 */
export async function runInventoryProbForecast(userId, bomRunId, options = {}) {
  const startTime = Date.now();
  
  try {
    // 1. Fetch BOM run and its parameters (bloodline)
    const { data: bomRun, error: runError } = await supabase
      .from('forecast_runs')
      .select('id, scenario_name, parameters, user_id')
      .eq('id', bomRunId)
      .eq('user_id', userId)
      .single();
    
    if (runError || !bomRun) {
      throw new Error(`BOM run not found: ${runError?.message || 'Unknown error'}`);
    }
    
    // Validate this is a BOM explosion run
    const kind = bomRun.parameters?.kind || bomRun.parameters?.type;
    if (kind !== 'bom_explosion' && kind !== 'component_demand') {
      console.warn(`Warning: Run ${bomRunId} may not be a BOM explosion run (kind=${kind})`);
    }
    
    // Extract input sources from parameters (bloodline)
    const params = bomRun.parameters || {};
    const timeBuckets = bomRun.time_buckets || params.time_buckets || [];
    
    // Input sources (use options override if provided, otherwise from run parameters)
    const inputDemandSource = options.demandSource || params.input_demand_source || 'uploaded';
    const inputDemandForecastRunId = params.input_demand_forecast_run_id || null;
    
    const inputInboundSource = options.inboundSource || params.input_inbound_source || 'raw_po';
    const inputSupplyForecastRunId = params.input_supply_forecast_run_id || null;
    
    // 2. Fetch starting inventory from snapshots
    const startingInventory = await fetchStartingInventory(userId, bomRunId, timeBuckets);
    
    // 3. Fetch demand based on source
    const demandByKeyBucket = await fetchDemandDistribution(
      userId, 
      bomRunId, 
      inputDemandSource, 
      inputDemandForecastRunId,
      timeBuckets
    );
    
    // 4. Fetch inbound PO forecasts based on source
    const poForecasts = await fetchInboundPoForecasts(
      userId,
      inputInboundSource,
      inputSupplyForecastRunId,
      bomRunId
    );
    
    // 5. Run Monte Carlo simulation
    const actualTrials = Math.min(options.trials || DEFAULT_TRIALS, MAX_TRIALS_LIMIT);
    const seed = options.seed || DEFAULT_SEED;
    
    // Step 4 (P1): Check degraded mode thresholds
    const totalKeys = startingInventory.size > 0 ? startingInventory.size : demandByKeyBucket.size;
    const isDegraded = actualTrials > DEGRADED_MODE_THRESHOLD.trials || 
                       totalKeys > DEGRADED_MODE_THRESHOLD.keys ||
                       timeBuckets.length > DEGRADED_MODE_THRESHOLD.buckets;
    
    if (isDegraded) {
      console.warn(`[Step 4] Degraded mode triggered: trials=${actualTrials}, keys=${totalKeys}, buckets=${timeBuckets.length}`);
    }
    
    // Step 4 (P1): Observability - track compute time
    const computeStart = Date.now();
    
    const mcInputs = {
      timeBuckets,
      startingInventory,
      demandByKeyBucket,
      poForecasts
    };
    
    const validation = validateInputs(mcInputs);
    if (!validation.valid) {
      return {
        mode: 'failed',
        reason: `Invalid inputs: ${validation.errors.join(', ')}`,
        perf: { durationMs: Date.now() - startTime, fetchMs: null, computeMs: null },
        kpis: null
      };
    }
    
    const mcResult = executeInventoryProbForecast(mcInputs, {
      trials: actualTrials,
      seed,
      maxKeysForSeries: isDegraded ? Math.min(MAX_KEYS_FOR_SERIES, 100) : MAX_KEYS_FOR_SERIES
    });
    
    const computeMs = Date.now() - computeStart;
    
    if (!mcResult.success) {
      return {
        mode: 'failed',
        reason: mcResult.error,
        perf: { durationMs: Date.now() - startTime, fetchMs: null, computeMs },
        kpis: null
      };
    }
    
    // Step 4 (P1): Observability - track save time
    const saveStart = Date.now();
    
    // 6. Save results to database with version info
    await saveProbForecastResults(userId, bomRunId, mcResult, {
      inputDemandSource,
      inputDemandForecastRunId,
      inputInboundSource,
      inputSupplyForecastRunId,
      trials: actualTrials,
      seed,
      isDegraded,
      version: VERSION
    });
    
    const saveMs = Date.now() - saveStart;
    const duration = Date.now() - startTime;
    
    // M7.3 WP3: Log audit event after successful save
    const fetchMs = duration - computeMs - saveMs;
    const summaries = mcResult.keys.map(k => k.summary);
    const avgPStockout = summaries.reduce((sum, s) => sum + (s.pStockout || 0), 0) / summaries.length;
    const keysAtRisk = summaries.filter(s => s.pStockout > 0.5).length;
    const topKey = summaries.length > 0 
      ? summaries.sort((a, b) => (b.pStockout || 0) - (a.pStockout || 0))[0]
      : null;
    
    await logEvent(userId, {
      eventType: EVENT_TYPES.INVENTORY_PROB_RAN,
      correlationId: bomRunId,
      entityType: ENTITY_TYPES.BOM_RUN,
      entityId: bomRunId,
      bomRunId: bomRunId,
      payload: {
        entity: { type: ENTITY_TYPES.BOM_RUN, id: bomRunId },
        inputs: {
          demand_source: inputDemandSource,
          demand_forecast_run_id: inputDemandForecastRunId,
          inbound_source: inputInboundSource,
          supply_forecast_run_id: inputSupplyForecastRunId,
          trials: actualTrials,
          seed: seed
        },
        outputs: {
          row_counts: {
            summary: mcResult.keys.length,
            series: mcResult.metrics.keysWithSeries
          },
          kpis: {
            maxPStockout: Math.max(...summaries.map(s => s.pStockout || 0)),
            avgPStockout,
            keysAtRisk
          },
          top_key: topKey ? topKey.key : null
        },
        perf: { fetchMs, computeMs, saveMs }
      }
    });
    
    // Use already computed KPIs for return
    
    return {
      mode: (isDegraded || mcResult.metrics.degraded) ? 'degraded' : 'success',
      reason: isDegraded 
        ? `Large workload: ${actualTrials} trials / ${totalKeys} keys / ${timeBuckets.length} buckets. Series limited.`
        : mcResult.metrics.degraded 
          ? `Series limited to top ${MAX_KEYS_FOR_SERIES} keys` 
          : null,
      perf: {
        durationMs: duration,
        fetchMs: duration - computeMs - saveMs,  // Approximate
        computeMs: computeMs,
        saveMs: saveMs,
        keysProcessed: mcResult.metrics.totalKeys,
        keysWithSeries: mcResult.metrics.keysWithSeries,
        trials: mcResult.metrics.trials,
        degraded: isDegraded
      },
      kpis: {
        avgPStockout,
        keysAtRisk,
        totalKeys: mcResult.metrics.totalKeys
      },
      version: VERSION
    };
    
  } catch (error) {
    console.error('Error running probabilistic inventory forecast:', error);
    return {
      mode: 'failed',
      reason: error.message,
      perf: { durationMs: Date.now() - startTime },
      kpis: null
    };
  }
}

// ============================================================
// Data Fetching Functions
// ============================================================

/**
 * Fetch starting inventory from snapshots (latest per material/plant)
 */
async function fetchStartingInventory(userId, _bomRunId, _timeBuckets) {
  // Get the latest snapshot per material/plant for this user
  // Since inventory_snapshots uses batch_id not forecast_run_id, we get all and take latest
  const { data: snapshots, error } = await supabase
    .from('inventory_snapshots')
    .select('material_code, plant_id, onhand_qty, snapshot_date')
    .eq('user_id', userId)
    .order('snapshot_date', { ascending: false });
  
  if (error) {
    console.error('Error fetching starting inventory:', error);
    throw new Error(`Failed to fetch starting inventory: ${error.message}`);
  }
  
  const inventory = new Map();
  const seenKeys = new Set();
  
  // Take only the latest snapshot per key
  for (const snap of (snapshots || [])) {
    const key = `${snap.material_code}|${snap.plant_id}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      inventory.set(key, {
        onHand: parseFloat(snap.onhand_qty) || 0,
        safetyStock: 0 // Could be added later
      });
    }
  }
  
  return inventory;
}

/**
 * Fetch demand distribution based on source
 */
async function fetchDemandDistribution(userId, bomRunId, demandSource, demandForecastRunId, _timeBuckets) {
  const demandByKeyBucket = new Map();
  
  if (demandSource === 'demand_forecast' && demandForecastRunId) {
    // Fetch from demand forecast + BOM edges for propagation
    const { data: demandForecasts, error: dfError } = await supabase
      .from('demand_forecast')
      .select('material_code, time_bucket, p10, p50, p90')
      .eq('user_id', userId)
      .eq('forecast_run_id', demandForecastRunId);
    
    if (dfError) {
      console.error('Error fetching demand forecast:', dfError);
    }
    
    // Fetch BOM edges for demand propagation
    const { data: bomEdges, error: bomError } = await supabase
      .from('bom_edges')
      .select('parent_code, component_code, plant_id, qty_per')
      .eq('user_id', userId)
      .eq('forecast_run_id', bomRunId);
    
    if (bomError) {
      console.error('Error fetching BOM edges:', bomError);
    }
    
    // Build FG demand map
    const fgDemandByBucket = new Map();
    for (const df of (demandForecasts || [])) {
      if (!fgDemandByBucket.has(df.material_code)) {
        fgDemandByBucket.set(df.material_code, new Map());
      }
      fgDemandByBucket.get(df.material_code).set(df.time_bucket, {
        p10: parseFloat(df.p10) || 0,
        p50: parseFloat(df.p50) || 0,
        p90: parseFloat(df.p90) || 0
      });
    }
    
    // Build multiplier map and propagate
    if (bomEdges && bomEdges.length > 0) {
      const multiplierMap = buildBomMultiplierMap(bomEdges);
      
      // For MVP: Simple aggregation without full Monte Carlo per trial
      // We'll use deterministic p50 for now, with CV for distribution
      for (const [fgMaterial, bucketMap] of fgDemandByBucket) {
        const components = multiplierMap.get(fgMaterial);
        if (!components) continue;
        
        for (const [bucket, dist] of bucketMap) {
          for (const { materialCode, plantId, multiplier } of components) {
            const key = `${materialCode}|${plantId}`;
            
            if (!demandByKeyBucket.has(key)) {
              demandByKeyBucket.set(key, new Map());
            }
            
            const existing = demandByKeyBucket.get(key).get(bucket);
            const componentQty = dist.p50 * multiplier;
            
            // Simple accumulation - for proper distribution we'd need full propagation
            demandByKeyBucket.get(key).set(bucket, {
              p10: (existing?.p10 || 0) + (dist.p10 * multiplier),
              p50: (existing?.p50 || 0) + componentQty,
              p90: (existing?.p90 || 0) + (dist.p90 * multiplier)
            });
          }
        }
      }
    }
    
  } else {
    // Use component_demand (uploaded or deterministic)
    const { data: componentDemands, error } = await supabase
      .from('component_demand')
      .select('material_code, plant_id, time_bucket, demand_qty')
      .eq('user_id', userId)
      .eq('forecast_run_id', bomRunId);
    
    if (error) {
      console.error('Error fetching component demand:', error);
    }
    
    for (const cd of (componentDemands || [])) {
      const key = `${cd.material_code}|${cd.plant_id}`;
      
      if (!demandByKeyBucket.has(key)) {
        demandByKeyBucket.set(key, new Map());
      }
      
      // Use deterministic as p50, add synthetic spread
      const qty = parseFloat(cd.demand_qty) || 0;
      demandByKeyBucket.get(key).set(cd.time_bucket, {
        p10: qty * 0.8,
        p50: qty,
        p90: qty * 1.2
      });
    }
  }
  
  return demandByKeyBucket;
}

/**
 * Fetch inbound PO forecasts based on source
 */
async function fetchInboundPoForecasts(userId, inboundSource, supplyForecastRunId, _bomRunId) {
  const poForecasts = [];
  
  if (inboundSource === 'supply_forecast' && supplyForecastRunId) {
    // Fetch from supply_forecast_po
    const { data: sfPoForecasts, error } = await supabase
      .from('supply_forecast_po')
      .select('po_line_id, po_id, supplier_id, material_code, plant_id, open_qty, arrival_p50_bucket, arrival_p90_bucket, delay_prob')
      .eq('user_id', userId)
      .eq('forecast_run_id', supplyForecastRunId);
    
    if (error) {
      console.error('Error fetching supply forecast PO:', error);
    }
    
    for (const po of (sfPoForecasts || [])) {
      poForecasts.push({
        poLineId: po.po_line_id,
        poId: po.po_id,
        supplierId: po.supplier_id,
        materialCode: po.material_code,
        plantId: po.plant_id,
        openQty: parseFloat(po.open_qty) || 0,
        arrivalP50Bucket: po.arrival_p50_bucket,
        arrivalP90Bucket: po.arrival_p90_bucket,
        delayProb: parseFloat(po.delay_prob) || 0
      });
    }
    
  } else {
    // Use raw PO open lines (deterministic)
    const { data: poLines, error } = await supabase
      .from('po_open_lines')
      .select('id, po_number, supplier_id, material_code, plant_id, open_qty, time_bucket, status')
      .eq('user_id', userId)
      .gt('open_qty', 0)
      .not('status', 'eq', 'cancelled');
    
    if (error) {
      console.error('Error fetching PO open lines:', error);
    }
    
    for (const po of (poLines || [])) {
      poForecasts.push({
        poLineId: po.id,
        poId: po.po_number,
        supplierId: po.supplier_id,
        materialCode: po.material_code,
        plantId: po.plant_id,
        openQty: parseFloat(po.open_qty) || 0,
        arrivalP50Bucket: po.time_bucket,
        arrivalP90Bucket: po.time_bucket, // Same as p50 for deterministic
        delayProb: 0 // No delay probability for raw PO
      });
    }
  }
  
  return poForecasts;
}

// ============================================================
// Save Results
// ============================================================

/**
 * Save probabilistic forecast results to database
 */
async function saveProbForecastResults(userId, bomRunId, mcResult, inputSources) {
  // 1. Delete old results for this run (upsert pattern)
  await deleteInventoryProbResults(userId, bomRunId);
  
  // 2. Build summary payloads with version info
  const summaryPayloads = mcResult.keys.map(keyResult => {
    const [materialCode, plantId] = keyResult.key.split('|');
    return {
      user_id: userId,
      forecast_run_id: bomRunId,
      material_code: materialCode,
      plant_id: plantId,
      trials: keyResult.trials,
      seed: mcResult.metrics.seed,
      p_stockout: keyResult.summary.pStockout,
      stockout_bucket_p50: keyResult.summary.stockoutBucketP50,
      stockout_bucket_p90: keyResult.summary.stockoutBucketP90,
      expected_shortage_qty: keyResult.summary.expectedShortageQty,
      expected_min_available: keyResult.summary.expectedMinAvailable,
      input_demand_source: inputSources.inputDemandSource,
      input_demand_forecast_run_id: inputSources.inputDemandForecastRunId,
      input_inbound_source: inputSources.inputInboundSource,
      input_supply_forecast_run_id: inputSources.inputSupplyForecastRunId,
      // Step 4 (P1): Version tracking
      metrics: {
        degraded: mcResult.metrics.degraded || inputSources.isDegraded,
        hasSeries: !!keyResult.series,
        mcVersion: inputSources.version?.mc,
        arrivalVersion: inputSources.version?.arrival,
        demandVersion: inputSources.version?.demand,
        computeMs: inputSources.computeMs
      }
    };
  });
  
  // 3. Insert summaries in batches
  const batchSize = 500;
  for (let i = 0; i < summaryPayloads.length; i += batchSize) {
    const batch = summaryPayloads.slice(i, i + batchSize);
    const { error } = await supabase
      .from('inventory_forecast_prob_summary')
      .insert(batch);
    
    if (error) {
      console.error(`Error inserting summary batch ${i}:`, error);
      throw new Error(`Failed to save summary: ${error.message}`);
    }
  }
  
  // 4. Build series payloads (only for keys that have series)
  const seriesPayloads = [];
  for (const keyResult of mcResult.keys) {
    if (!keyResult.series) continue;
    
    const [materialCode, plantId] = keyResult.key.split('|');
    
    for (const point of keyResult.series) {
      seriesPayloads.push({
        user_id: userId,
        forecast_run_id: bomRunId,
        material_code: materialCode,
        plant_id: plantId,
        time_bucket: point.bucket,
        inv_p10: point.invP10,
        inv_p50: point.invP50,
        inv_p90: point.invP90,
        p_stockout_bucket: point.pStockoutBucket
      });
    }
  }
  
  // 5. Insert series in batches
  if (seriesPayloads.length > 0) {
    for (let i = 0; i < seriesPayloads.length; i += batchSize) {
      const batch = seriesPayloads.slice(i, i + batchSize);
      const { error } = await supabase
        .from('inventory_forecast_prob_series')
        .insert(batch);
      
      if (error) {
        console.error(`Error inserting series batch ${i}:`, error);
        throw new Error(`Failed to save series: ${error.message}`);
      }
    }
  }
  
  return {
    summaryCount: summaryPayloads.length,
    seriesCount: seriesPayloads.length
  };
}

// ============================================================
// Public API Functions
// ============================================================

/**
 * Get probabilistic forecast summary for a BOM run
 */
export async function getInventoryProbSummaryByRun(userId, bomRunId) {
  const { data, error } = await supabase
    .from('inventory_forecast_prob_summary')
    .select('*')
    .eq('user_id', userId)
    .eq('forecast_run_id', bomRunId)
    .order('p_stockout', { ascending: false });
  
  if (error) {
    console.error('Error fetching prob summary:', error);
    throw error;
  }
  
  return data || [];
}

/**
 * Get probabilistic forecast series for a specific key
 */
export async function getInventoryProbSeriesByRun(userId, bomRunId, materialCode, plantId) {
  const { data, error } = await supabase
    .from('inventory_forecast_prob_series')
    .select('*')
    .eq('user_id', userId)
    .eq('forecast_run_id', bomRunId)
    .eq('material_code', materialCode)
    .eq('plant_id', plantId)
    .order('time_bucket', { ascending: true });
  
  if (error) {
    console.error('Error fetching prob series:', error);
    throw error;
  }
  
  return data || [];
}

/**
 * Get series for all keys (paginated)
 */
export async function getInventoryProbSeriesByRunAll(userId, bomRunId, options = {}) {
  const { limit = 10000, offset = 0 } = options;
  
  const { data, error } = await supabase
    .from('inventory_forecast_prob_series')
    .select('*')
    .eq('user_id', userId)
    .eq('forecast_run_id', bomRunId)
    .order('material_code, plant_id, time_bucket')
    .range(offset, offset + limit - 1);
  
  if (error) {
    console.error('Error fetching prob series:', error);
    throw error;
  }
  
  return data || [];
}

/**
 * Delete probabilistic forecast results for a run
 */
export async function deleteInventoryProbResults(userId, bomRunId) {
  // Delete series first (no FK constraint but cleaner)
  const { error: seriesError } = await supabase
    .from('inventory_forecast_prob_series')
    .delete()
    .eq('user_id', userId)
    .eq('forecast_run_id', bomRunId);
  
  if (seriesError) {
    console.error('Error deleting series:', seriesError);
  }
  
  // Delete summary
  const { error: summaryError } = await supabase
    .from('inventory_forecast_prob_summary')
    .delete()
    .eq('user_id', userId)
    .eq('forecast_run_id', bomRunId);
  
  if (summaryError) {
    console.error('Error deleting summary:', summaryError);
  }
  
  return { success: !seriesError && !summaryError };
}

/**
 * Check if probabilistic results exist for a run
 */
export async function hasProbForecastResults(userId, bomRunId) {
  const { count, error } = await supabase
    .from('inventory_forecast_prob_summary')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('forecast_run_id', bomRunId);
  
  if (error) {
    console.error('Error checking prob results:', error);
    return false;
  }
  
  return count > 0;
}

// ============================================================
// Service Object Export
// ============================================================

export const inventoryProbForecastService = {
  run: runInventoryProbForecast,
  getSummaryByRun: getInventoryProbSummaryByRun,
  getSeriesByRun: getInventoryProbSeriesByRun,
  getSeriesByRunAll: getInventoryProbSeriesByRunAll,
  deleteByRun: deleteInventoryProbResults,
  hasResults: hasProbForecastResults
};
