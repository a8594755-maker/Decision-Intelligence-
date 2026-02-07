/**
 * Milestone 7.1 WP1: Risk Score Service
 * 
 * Orchestrates:
 * 1. Load probabilistic forecast data (P(stockout))
 * 2. Load revenue data ($ impact)
 * 3. Calculate risk scores using riskScore.js engine
 * 4. Save results to risk_score_results table
 * 5. Log audit events
 */

import { supabase } from './supabaseClient';
import { logEvent, EVENT_TYPES, ENTITY_TYPES } from './auditService';
import { 
  calculateRiskScoreBatch, 
  normalizeRiskKey,
  RISK_SCORE_VERSION,
  RISK_SCORE_ALGORITHM
} from '../domains/risk/riskScore';

const SERVICE_VERSION = '1.0.0';

// ============================================================
// Main Orchestration
// ============================================================

/**
 * Run risk score calculation for a forecast run
 * 
 * @param {string} userId - User ID
 * @param {string} forecastRunId - Forecast run ID (can be BOM run or revenue run)
 * @param {Object} options - Calculation options
 * @returns {Object} Result with scores and metrics
 */
export async function runRiskScoreCalculation(userId, forecastRunId, options = {}) {
  const startMs = Date.now();
  const { riskRows = [], currentBucket = null, maxKeys = 1000 } = options;
  
  try {
    // Step 1: Get run info to determine type
    const { data: runData, error: runError } = await supabase
      .from('forecast_runs')
      .select('id, kind, parameters, created_at')
      .eq('id', forecastRunId)
      .eq('created_by', userId)
      .single();
    
    if (runError || !runData) {
      return { success: false, error: 'Forecast run not found' };
    }
    
    // Step 2: Find the actual BOM run to use
    let bomRunId = forecastRunId;
    if (runData.kind === 'revenue_forecast') {
      // If it's a revenue run, use its source BOM run
      bomRunId = runData.parameters?.source_bom_run_id || forecastRunId;
    }
    
    console.log(`📊 Risk Score: Using BOM run ${bomRunId}`);
    
    // Step 3: Load probabilistic forecast data (P(stockout))
    const probDataResult = await loadProbDataForRun(userId, bomRunId);
    if (!probDataResult.success) {
      console.warn('No probabilistic data found, using deterministic fallback');
    }
    
    // Step 4: Load revenue data ($ impact)
    const revenueDataResult = await loadRevenueDataForRun(userId, forecastRunId);
    if (!revenueDataResult.success) {
      console.warn('No revenue data found, impact will be 0');
    }
    
    // Step 5: Merge data and calculate scores
    const mergedInputs = mergeRiskInputs(
      probDataResult.data || {},
      revenueDataResult.data || {},
      riskRows,
      currentBucket
    );
    
    if (mergedInputs.length === 0) {
      return { 
        success: false, 
        error: 'No data available for risk scoring',
        mode: 'none'
      };
    }
    
    // Step 6: Calculate risk scores using engine
    const calcResult = calculateRiskScoreBatch(mergedInputs, {
      currentBucket,
      maxKeys
    });
    
    if (!calcResult.success) {
      return { 
        success: false, 
        error: calcResult.error,
        mode: 'failed'
      };
    }
    
    // Step 7: Save results to database
    const saveResult = await saveRiskScoreResults(
      userId, 
      forecastRunId, 
      calcResult.results
    );
    
    if (!saveResult.success) {
      return { 
        success: false, 
        error: saveResult.error,
        mode: 'failed'
      };
    }
    
    // Step 8: Log audit event (M7.3 WP3)
    const totalMs = Date.now() - startMs;
    await logEvent(userId, {
      eventType: EVENT_TYPES.RISK_SCORE_CALCULATED,
      correlationId: forecastRunId,
      entityType: ENTITY_TYPES.BOM_RUN,
      entityId: forecastRunId,
      bomRunId: forecastRunId,
      payload: {
        entity: { type: ENTITY_TYPES.BOM_RUN, id: forecastRunId },
        inputs: {
          mode: probDataResult.data && Object.keys(probDataResult.data).length > 0 ? 'probabilistic' : 'deterministic',
          prob_keys: Object.keys(probDataResult.data || {}).length,
          revenue_keys: Object.keys(revenueDataResult.data || {}).length,
          merged_keys: mergedInputs.length,
          urgency_rules_version: '1.0.0'
        },
        outputs: {
          row_counts: { scores: calcResult.results.length },
          kpis: calcResult.kpis,
          top_key: calcResult.results.length > 0 
            ? `${calcResult.results[0].materialCode}|${calcResult.results[0].plantId}` 
            : null
        },
        perf: {
          fetchMs: probDataResult.loadMs + revenueDataResult.loadMs,
          computeMs: calcResult.metrics.computeMs,
          saveMs: saveResult.saveMs,
          totalMs
        }
      }
    });
    
    return {
      success: true,
      forecastRunId,
      mode: 'completed',
      kpis: calcResult.kpis,
      topRisks: calcResult.results.slice(0, 10),
      metrics: {
        totalMs,
        probLoadMs: probDataResult.loadMs,
        revenueLoadMs: revenueDataResult.loadMs,
        computeMs: calcResult.metrics.computeMs,
        saveMs: saveResult.saveMs
      }
    };
    
  } catch (error) {
    console.error('Risk score calculation failed:', error);
    return { 
      success: false, 
      error: error.message,
      mode: 'failed'
    };
  }
}

// ============================================================
// Data Loading Functions
// ============================================================

/**
 * Load probabilistic forecast data for a run
 * Returns map: key -> { pStockout, earliestStockoutBucket }
 */
async function loadProbDataForRun(userId, runId) {
  const startMs = Date.now();
  
  try {
    // Try to load from inventory_forecast_prob_summary
    const { data, error } = await supabase
      .from('inventory_forecast_prob_summary')
      .select('material_code, plant_id, p_stockout, stockout_bucket_p50')
      .eq('user_id', userId)
      .eq('forecast_run_id', runId);
    
    if (error) {
      // Table might not exist, try deterministic fallback
      return { 
        success: false, 
        error: error.message,
        data: {},
        loadMs: Date.now() - startMs
      };
    }
    
    // Convert to map
    const probMap = {};
    for (const row of (data || [])) {
      const key = normalizeRiskKey(row.material_code, row.plant_id);
      probMap[key] = {
        pStockout: row.p_stockout || 0,
        earliestStockoutBucket: row.stockout_bucket_p50
      };
    }
    
    return {
      success: true,
      data: probMap,
      loadMs: Date.now() - startMs
    };
    
  } catch (error) {
    return { 
      success: false, 
      error: error.message,
      data: {},
      loadMs: Date.now() - startMs
    };
  }
}

/**
 * Load revenue data for a run
 * Returns map: key -> { impactUsd }
 */
async function loadRevenueDataForRun(userId, runId) {
  const startMs = Date.now();
  
  try {
    // First, find the revenue run for this BOM run
    const { data: revenueRunData, error: runError } = await supabase
      .from('forecast_runs')
      .select('id')
      .eq('created_by', userId)
      .eq('kind', 'revenue_forecast')
      .or(`id.eq.${runId},parameters->>source_bom_run_id.eq.${runId}`)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    
    let revenueRunId = runId;
    if (revenueRunData) {
      revenueRunId = revenueRunData.id;
    }
    
    // Load margin at risk results
    const { data, error } = await supabase
      .from('margin_at_risk_results')
      .select('fg_material_code, plant_id, expected_margin_at_risk, expected_penalty_at_risk')
      .eq('user_id', userId)
      .eq('forecast_run_id', revenueRunId);
    
    if (error) {
      return { 
        success: false, 
        error: error.message,
        data: {},
        loadMs: Date.now() - startMs
      };
    }
    
    // Aggregate by key (sum all buckets)
    const revenueMap = {};
    for (const row of (data || [])) {
      const key = normalizeRiskKey(row.fg_material_code, row.plant_id);
      if (!revenueMap[key]) {
        revenueMap[key] = {
          impactUsd: 0,
          penaltyUsd: 0
        };
      }
      revenueMap[key].impactUsd += (row.expected_margin_at_risk || 0);
      revenueMap[key].penaltyUsd += (row.expected_penalty_at_risk || 0);
    }
    
    return {
      success: true,
      data: revenueMap,
      loadMs: Date.now() - startMs
    };
    
  } catch (error) {
    return { 
      success: false, 
      error: error.message,
      data: {},
      loadMs: Date.now() - startMs
    };
  }
}

/**
 * Merge probabilistic and revenue data into risk score inputs
 * Uses riskRows for deterministic fallback when probabilistic data is not available
 */
function mergeRiskInputs(probMap, revenueMap, riskRows, currentBucket) {
  const inputs = [];
  const allKeys = new Set([
    ...Object.keys(probMap),
    ...Object.keys(revenueMap)
  ]);
  
  // If no keys from prob/revenue, use riskRows
  if (allKeys.size === 0 && riskRows.length > 0) {
    for (const row of riskRows) {
      const key = normalizeRiskKey(row.item, row.plantId);
      allKeys.add(key);
    }
  }
  
  for (const key of allKeys) {
    const prob = probMap[key];
    const rev = revenueMap[key] || { impactUsd: 0, penaltyUsd: 0 };
    
    // Deterministic fallback: use riskRows data
    let pStockout = 0;
    let earliestStockoutBucket = null;
    
    if (prob) {
      // Use probabilistic data
      pStockout = prob.pStockout;
      earliestStockoutBucket = prob.earliestStockoutBucket;
    } else {
      // Deterministic fallback: find matching risk row
      const riskRow = riskRows.find(r => 
        normalizeRiskKey(r.item, r.plantId) === key
      );
      if (riskRow) {
        // If gap > 0, P(stockout) = 1.0 (high risk), else 0.0
        pStockout = riskRow.gapQty > 0 ? 1.0 : 0.0;
        earliestStockoutBucket = riskRow.nextStockoutBucket || riskRow.stockoutBucket;
      }
    }
    
    const { materialCode, plantId } = parseRiskKey(key);
    
    inputs.push({
      materialCode,
      plantId,
      pStockout,
      impactUsd: rev.impactUsd + rev.penaltyUsd,
      earliestStockoutBucket,
      currentBucket
    });
  }
  
  return inputs;
}

/**
 * Parse normalized key back to components
 */
function parseRiskKey(key) {
  const parts = key.split('|');
  return {
    materialCode: parts[0] || '',
    plantId: parts[1] || ''
  };
}

// ============================================================
// Save Results
// ============================================================

/**
 * Save risk score results to database
 */
async function saveRiskScoreResults(userId, forecastRunId, results) {
  const startMs = Date.now();
  
  try {
    // Delete existing results for this run (replace mode)
    await supabase
      .from('risk_score_results')
      .delete()
      .eq('user_id', userId)
      .eq('forecast_run_id', forecastRunId);
    
    // Prepare payloads
    const payloads = results.map(r => ({
      user_id: userId,
      forecast_run_id: forecastRunId,
      material_code: r.materialCode,
      plant_id: r.plantId,
      p_stockout: r.pStockout,
      impact_usd: r.impactUsd,
      earliest_stockout_bucket: r.earliestStockoutBucket,
      urgency_weight: r.urgencyWeight,
      score: r.score,
      breakdown_json: r.breakdown,
      version: RISK_SCORE_VERSION,
      score_algorithm: RISK_SCORE_ALGORITHM,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }));
    
    // Batch insert
    const batchSize = 100;
    for (let i = 0; i < payloads.length; i += batchSize) {
      const chunk = payloads.slice(i, i + batchSize);
      const { error } = await supabase
        .from('risk_score_results')
        .upsert(chunk, {
          onConflict: ['user_id', 'forecast_run_id', 'material_code', 'plant_id'],
          ignoreDuplicates: false
        });
      
      if (error) {
        throw error;
      }
    }
    
    return {
      success: true,
      count: payloads.length,
      saveMs: Date.now() - startMs
    };
    
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

// ============================================================
// Query Functions
// ============================================================

/**
 * Get risk scores for a run (for Risk Table display)
 */
export async function getRiskScoresForRun(userId, forecastRunId, options = {}) {
  const { limit = 100, offset = 0 } = options;
  
  try {
    const { data, error } = await supabase
      .from('risk_score_results')
      .select('*')
      .eq('user_id', userId)
      .eq('forecast_run_id', forecastRunId)
      .order('score', { ascending: false })
      .range(offset, offset + limit - 1);
    
    if (error) {
      return { success: false, error: error.message };
    }
    
    // Convert to map by key for easy lookup
    const scoreMap = {};
    for (const row of (data || [])) {
      const key = normalizeRiskKey(row.material_code, row.plant_id);
      scoreMap[key] = {
        score: row.score,
        pStockout: row.p_stockout,
        impactUsd: row.impact_usd,
        urgencyWeight: row.urgency_weight,
        earliestStockoutBucket: row.earliest_stockout_bucket,
        breakdown: row.breakdown_json
      };
    }
    
    return {
      success: true,
      data: scoreMap,
      count: data?.length || 0
    };
    
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Get single key risk score (for DetailsPanel)
 */
export async function getRiskScoreForKey(userId, forecastRunId, materialCode, plantId) {
  try {
    const { data, error } = await supabase
      .from('risk_score_results')
      .select('*')
      .eq('user_id', userId)
      .eq('forecast_run_id', forecastRunId)
      .eq('material_code', materialCode)
      .eq('plant_id', plantId)
      .single();
    
    if (error) {
      if (error.code === 'PGRST116') {
        return { success: false, notFound: true };
      }
      return { success: false, error: error.message };
    }
    
    return {
      success: true,
      data: {
        score: data.score,
        pStockout: data.p_stockout,
        impactUsd: data.impact_usd,
        urgencyWeight: data.urgency_weight,
        earliestStockoutBucket: data.earliest_stockout_bucket,
        breakdown: data.breakdown_json
      }
    };
    
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ============================================================
// Audit Functions
// ============================================================

/**
 * Log audit event
 */
async function logAuditEvent(userId, forecastRunId, eventType, entityKey, payload) {
  try {
    const { error } = await supabase
      .from('audit_events')
      .insert({
        user_id: userId,
        forecast_run_id: forecastRunId,
        event_type: eventType,
        entity_key: entityKey,
        payload_json: payload,
        created_at: new Date().toISOString()
      });
    
    if (error) {
      console.warn('Failed to log audit event:', error);
    }
  } catch (err) {
    console.warn('Audit logging error:', err);
  }
}

/**
 * Get audit events for a run
 */
export async function getAuditEventsForRun(userId, forecastRunId, options = {}) {
  const { limit = 50, offset = 0, eventType = null } = options;
  
  try {
    let query = supabase
      .from('audit_events')
      .select('*')
      .eq('user_id', userId)
      .eq('forecast_run_id', forecastRunId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    
    if (eventType) {
      query = query.eq('event_type', eventType);
    }
    
    const { data, error } = await query;
    
    if (error) {
      return { success: false, error: error.message };
    }
    
    return {
      success: true,
      data: data || []
    };
    
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ============================================================
// Exports
// ============================================================

export {
  SERVICE_VERSION,
  RISK_SCORE_VERSION,
  RISK_SCORE_ALGORITHM
};
