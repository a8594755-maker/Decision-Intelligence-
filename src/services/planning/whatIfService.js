/**
 * Milestone 7.2 WP2: What-if Service (MVP)
 * 
 * Orchestrates what-if scenario runs:
 * 1. Create what_if_runs record
 * 2. Load baseline data (prob, revenue, cost, risk score)
 * 3. Run what-if engine (expedite action)
 * 4. Save results to what_if_results
 * 5. Log audit event
 */

import { supabase } from '../infra/supabaseClient';
import { logEvent, EVENT_TYPES, ENTITY_TYPES } from '../governance/auditService';
import { runWhatIfScenario, normalizeWhatIfKey, ENGINE_VERSION } from '../../domains/risk/whatIfEngine';

const SERVICE_VERSION = '1.0.0';

// ============================================================
// Main Orchestration
// ============================================================

/**
 * Run what-if scenario for a key
 * MVP: Expedite action only, single key scope
 * 
 * @param {string} userId - User ID
 * @param {string} bomRunId - BOM run ID
 * @param {Object} keyContext - Key data { materialCode, plantId, ... }
 * @param {Object} action - { type: 'expedite', byBuckets: 1 }
 * @returns {Object} What-if run result with before/after
 */
export async function runWhatIf(userId, bomRunId, keyContext, action) {
  const startMs = Date.now();
  
  try {
    // Step 1: Create what_if_runs record
    const whatIfRunId = await createWhatIfRun(userId, bomRunId, action);
    if (!whatIfRunId) {
      return { success: false, error: 'Failed to create what-if run' };
    }
    
    console.log(`🔮 What-if run created: ${whatIfRunId}`);
    
    // Step 2: Load baseline data for the key
    const baseline = await loadBaselineData(userId, bomRunId, keyContext);
    
    // Step 3: Run what-if engine
    const whatIfInput = {
      materialCode: keyContext.materialCode,
      plantId: keyContext.plantId,
      onHand: keyContext.onHand || 0,
      safetyStock: keyContext.safetyStock || 0,
      inboundLines: keyContext.inboundLines || [],
      gapQty: keyContext.gapQty || 0,
      nextStockoutBucket: keyContext.nextStockoutBucket,
      pStockout: baseline.pStockout,
      impactUsd: baseline.impactUsd,
      costUsd: baseline.costUsd
    };
    
    const engineResult = runWhatIfScenario(whatIfInput, action);
    
    if (!engineResult.success) {
      return { success: false, error: engineResult.error };
    }
    
    // Step 4: Save results to what_if_results
    const saveResult = await saveWhatIfResults(
      userId,
      whatIfRunId,
      keyContext.materialCode,
      keyContext.plantId,
      engineResult,
      action
    );
    
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }
    
    // Step 5: Log audit event (M7.3 WP3)
    const totalMs = Date.now() - startMs;
    await logEvent(userId, {
      eventType: EVENT_TYPES.WHAT_IF_EXECUTED,
      correlationId: whatIfRunId,
      entityType: ENTITY_TYPES.WHAT_IF_RUN,
      entityId: whatIfRunId,
      bomRunId: bomRunId,
      key: `${keyContext.materialCode}|${keyContext.plantId}`,
      payload: {
        entity: { type: ENTITY_TYPES.WHAT_IF_RUN, id: whatIfRunId },
        inputs: {
          action: {
            type: action.type,
            byBuckets: action.byBuckets,
            scope: action.scope || 'single_key'
          }
        },
        outputs: {
          before: {
            p_stockout: engineResult.before.pStockout,
            score: engineResult.before.score,
            impact_usd: engineResult.before.impactUsd,
            cost_usd: engineResult.before.costUsd
          },
          after: {
            p_stockout: engineResult.after.pStockout,
            score: engineResult.after.score,
            impact_usd: engineResult.after.impactUsd,
            cost_usd: engineResult.after.costUsd
          },
          roi: engineResult.roi,
          cost: engineResult.delta?.costUsd || 0,
          benefit: engineResult.delta?.impactUsd || 0
        },
        perf: {
          totalMs,
          engineMs: engineResult.action?.computeMs || 0
        }
      }
    });
    
    return {
      success: true,
      whatIfRunId,
      materialCode: keyContext.materialCode,
      plantId: keyContext.plantId,
      action,
      before: engineResult.before,
      after: engineResult.after,
      delta: engineResult.delta,
      roi: engineResult.roi,
      metrics: {
        totalMs,
        engineMs: engineResult.action?.computeMs || 0
      }
    };
    
  } catch (error) {
    console.error('What-if service failed:', error);
    return { success: false, error: error.message };
  }
}

// ============================================================
// Database Operations
// ============================================================

/**
 * Create what_if_runs record
 */
async function createWhatIfRun(userId, bomRunId, action) {
  try {
    const { data, error } = await supabase
      .from('what_if_runs')
      .insert({
        user_id: userId,
        forecast_run_id: bomRunId,
        material_code: null, // Set later for single key
        plant_id: null,
        action_type: action.type,
        params_json: action,
        before_json: {},
        after_json: {},
        created_at: new Date().toISOString()
      })
      .select('id')
      .single();
    
    if (error) {
      console.error('Failed to create what_if_runs:', error);
      return null;
    }
    
    return data.id;
  } catch (err) {
    console.error('Create what-if run error:', err);
    return null;
  }
}

/**
 * Save what-if results to what_if_results table
 */
async function saveWhatIfResults(userId, whatIfRunId, materialCode, plantId, engineResult, action) {
  try {
    const { before, after } = engineResult;
    
    const { error } = await supabase
      .from('what_if_results')
      .upsert({
        user_id: userId,
        what_if_run_id: whatIfRunId,
        material_code: materialCode,
        plant_id: plantId,
        before_p_stockout: before.pStockout,
        before_score: before.score,
        before_impact_usd: before.impactUsd,
        before_cost_usd: before.costUsd,
        after_p_stockout: after.pStockout,
        after_score: after.score,
        after_impact_usd: after.impactUsd,
        after_cost_usd: after.costUsd,
        action_json: action,
        version: SERVICE_VERSION,
        perf: { engineMs: engineResult.action?.computeMs },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }, {
        onConflict: ['user_id', 'what_if_run_id', 'material_code', 'plant_id']
      });
    
    if (error) {
      console.error('Failed to save what_if_results:', error);
      return { success: false, error: error.message };
    }
    
    return { success: true };
  } catch (err) {
    console.error('Save what-if results error:', err);
    return { success: false, error: err.message };
  }
}

// ============================================================
// Data Loading
// ============================================================

/**
 * Load baseline data for a key
 */
async function loadBaselineData(userId, bomRunId, keyContext) {
  const { materialCode, plantId } = keyContext;
  const _key = normalizeWhatIfKey(materialCode, plantId);

  let baseline = {
    pStockout: 1.0,  // Default: high risk if no data
    impactUsd: 0,
    costUsd: 0
  };
  
  try {
    // Try to load risk score (has P(stockout) and impact)
    const { data: scoreData, error: scoreError } = await supabase
      .from('risk_score_results')
      .select('p_stockout, impact_usd')
      .eq('user_id', userId)
      .eq('forecast_run_id', bomRunId)
      .eq('material_code', materialCode)
      .eq('plant_id', plantId)
      .single();
    
    if (!scoreError && scoreData) {
      baseline.pStockout = scoreData.p_stockout;
      baseline.impactUsd = scoreData.impact_usd;
    }
    
    // Try to load cost data
    const { data: costRows, error: costError } = await supabase
      .from('cost_forecast_results')
      .select('expected_cost')
      .eq('user_id', userId)
      .eq('forecast_run_id', bomRunId)
      .eq('material_code', materialCode)
      .eq('plant_id', plantId);
    
    if (!costError && costRows?.length) {
      baseline.costUsd = costRows.reduce((sum, r) => sum + (parseFloat(r.expected_cost) || 0), 0);
    }
    
    return baseline;
  } catch (error) {
    console.warn('Baseline data load failed, using defaults:', error);
    return baseline;
  }
}

// ============================================================
// Query Functions
// ============================================================

/**
 * Get what-if results for a run
 */
export async function getWhatIfResults(userId, whatIfRunId) {
  try {
    const { data, error } = await supabase
      .from('what_if_results')
      .select('*')
      .eq('user_id', userId)
      .eq('what_if_run_id', whatIfRunId)
      .order('created_at', { ascending: false });
    
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

/**
 * Get what-if runs for a BOM run
 */
export async function getWhatIfRuns(userId, bomRunId) {
  try {
    const { data, error } = await supabase
      .from('what_if_runs')
      .select('*')
      .eq('user_id', userId)
      .eq('forecast_run_id', bomRunId)
      .order('created_at', { ascending: false });
    
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
// Audit
// ============================================================

/**
 * Log audit event
 */
async function _logAuditEvent(userId, forecastRunId, eventType, entityKey, payload) {
  try {
    await supabase
      .from('audit_events')
      .insert({
        user_id: userId,
        forecast_run_id: forecastRunId,
        event_type: eventType,
        entity_key: entityKey,
        payload_json: payload,
        created_at: new Date().toISOString()
      });
  } catch (err) {
    console.warn('Audit logging error:', err);
  }
}

export { SERVICE_VERSION, ENGINE_VERSION };
