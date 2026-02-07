/**
 * Milestone 5: Cost Forecast Service
 * WP3: Service Orchestration with lineage tracking
 * 
 * Handles:
 * - Creating cost forecast runs with full lineage
 * - Reading prob or deterministic inputs
 * - Running cost engine and saving results
 * - Performance tracking and observability
 */

import { supabase } from './supabaseClient';
import {
  calculateCostsBatch,
  computeCostKPIs,
  validateCostRules,
  DEFAULT_RULES,
  COST_ENGINE_VERSION,
  COST_WARN_KEYS,
  COST_STOP_KEYS
} from '../domains/inventory/costForecast';

// ============================================================
// Constants
// ============================================================

const SERVICE_VERSION = '1.0.0';

// ============================================================
// Main Entry: Run Cost Forecast
// ============================================================

/**
 * Run a complete cost forecast
 * 
 * @param {string} userId - User ID
 * @param {string} sourceRunId - Source forecast run ID (BOM run or inventory run)
 * @param {Object} options - Run options
 * @returns {Object} - Run result with KPIs and performance metrics
 */
export async function runCostForecast(userId, sourceRunId, options = {}) {
  const startTime = Date.now();
  
  const {
    ruleSetId = null,
    ruleSetVersion = 'v1.0.0-default',
    useProbInputs = true, // Prefer prob summary over deterministic
    forceDeterministic = false
  } = options;

  try {
    // 1. Validate user session
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || user.id !== userId) {
      return { success: false, error: 'Unauthorized', mode: 'failed' };
    }

    // 2. Get source run details for lineage
    const { data: sourceRun, error: runError } = await supabase
      .from('forecast_runs')
      .select('*')
      .eq('id', sourceRunId)
      .single();

    if (runError || !sourceRun) {
      return { 
        success: false, 
        error: `Source run not found: ${runError?.message || 'Unknown'}`,
        mode: 'failed'
      };
    }

    // 3. Get or load rules
    const ruleSet = await loadRuleSet(userId, ruleSetId, ruleSetVersion);
    if (!ruleSet) {
      return { success: false, error: 'Rule set not found', mode: 'failed' };
    }

    // Validate rules
    const validation = validateCostRules(ruleSet.rules);
    if (!validation.valid) {
      return { 
        success: false, 
        error: `Invalid rules: ${validation.errors.join(', ')}`,
        mode: 'failed'
      };
    }

    // 4. Create forecast_runs entry with full lineage
    const { data: costRun, error: createError } = await supabase
      .from('forecast_runs')
      .insert({
        created_by: userId,
        kind: 'cost_forecast',
        status: 'running',
        parameters: {
          // Bloodline - full traceability
          source_bom_run_id: sourceRun.parameters?.source_bom_run_id || sourceRunId,
          source_inventory_run_id: sourceRunId,
          input_inbound_source: sourceRun.parameters?.input_inbound_source || 'unknown',
          input_supply_forecast_run_id: sourceRun.parameters?.input_supply_forecast_run_id || null,
          input_demand_source: sourceRun.parameters?.input_demand_source || 'unknown',
          input_demand_forecast_run_id: sourceRun.parameters?.input_demand_forecast_run_id || null,
          input_inventory_prob_run_id: useProbInputs ? sourceRunId : null,
          rule_set_id: ruleSet.id,
          rule_set_version: ruleSet.rule_set_version,
          use_prob_inputs: useProbInputs,
          force_deterministic: forceDeterministic,
          engine_version: COST_ENGINE_VERSION,
          service_version: SERVICE_VERSION,
          cost_warn_keys: COST_WARN_KEYS,
          cost_stop_keys: COST_STOP_KEYS
        },
        triggered_by: 'user',
        started_at: new Date().toISOString()
      })
      .select()
      .single();

    if (createError) {
      return { success: false, error: createError.message, mode: 'failed' };
    }

    // 5. Fetch input data (prob preferred, deterministic fallback)
    const fetchStart = Date.now();
    const inputs = await fetchCostInputs(userId, sourceRunId, { useProbInputs, forceDeterministic });
    const fetchMs = Date.now() - fetchStart;

    if (!inputs.success) {
      // Update run as failed
      await supabase
        .from('forecast_runs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: inputs.error
        })
        .eq('id', costRun.id);

      return { success: false, error: inputs.error, mode: 'failed' };
    }

    // 6. Run cost calculations
    const computeStart = Date.now();
    const calcResult = calculateCostsBatch(
      inputs.data,
      ruleSet.rules,
      { warnKeys: COST_WARN_KEYS, stopKeys: COST_STOP_KEYS, topN: 500 }
    );
    const computeMs = Date.now() - computeStart;

    if (!calcResult.success) {
      await supabase
        .from('forecast_runs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: calcResult.error
        })
        .eq('id', costRun.id);

      return { 
        success: false, 
        error: calcResult.error,
        mode: calcResult.degraded ? 'degraded' : 'failed'
      };
    }

    // 7. Save results to database
    const saveStart = Date.now();
    const saveResult = await saveCostResults(
      userId, 
      costRun.id, 
      calcResult.results, 
      ruleSet.rule_set_version
    );
    const saveMs = Date.now() - saveStart;

    if (!saveResult.success) {
      await supabase
        .from('forecast_runs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: saveResult.error
        })
        .eq('id', costRun.id);

      return { success: false, error: saveResult.error, mode: 'failed' };
    }

    // 8. Compute KPIs
    const kpis = computeCostKPIs(calcResult.results);

    // 9. Update run as completed
    const duration = Date.now() - startTime;
    await supabase
      .from('forecast_runs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        result_summary: {
          keys: kpis.overall.totalKeys,
          actions: calcResult.results.length,
          total_expected_cost: kpis.overall.totalCost,
          by_action: {
            expedite: kpis.expedite.totalCost,
            substitution: kpis.substitution.totalCost,
            disruption: kpis.disruption.totalCost
          },
          degraded: calcResult.degraded,
          degraded_reason: calcResult.degradedReason
        }
      })
      .eq('id', costRun.id);

    return {
      success: true,
      mode: calcResult.degraded ? 'degraded' : 'success',
      costRunId: costRun.id,
      kpis,
      metrics: {
        durationMs: duration,
        fetchMs,
        computeMs,
        saveMs,
        totalKeys: inputs.data.length,
        resultsSaved: calcResult.results.length,
        degraded: calcResult.degraded,
        degradedReason: calcResult.degradedReason
      }
    };

  } catch (error) {
    return {
      success: false,
      error: error.message,
      mode: 'failed'
    };
  }
}

// ============================================================
// Helper: Load Rule Set
// ============================================================

async function loadRuleSet(userId, ruleSetId, ruleSetVersion) {
  try {
    // If ruleSetId provided, use it
    if (ruleSetId) {
      const { data, error } = await supabase
        .from('cost_rule_sets')
        .select('*')
        .eq('id', ruleSetId)
        .eq('user_id', userId)
        .single();

      if (!error && data) return data;
    }

    // Otherwise try to find by version
    const { data, error } = await supabase
      .from('cost_rule_sets')
      .select('*')
      .eq('user_id', userId)
      .eq('rule_set_version', ruleSetVersion)
      .single();

    if (!error && data) return data;

    // If not found and version is default, create it
    if (ruleSetVersion === 'v1.0.0-default') {
      const { data: newRuleSet, error: createError } = await supabase
        .from('cost_rule_sets')
        .insert({
          user_id: userId,
          rule_set_version: 'v1.0.0-default',
          currency: 'USD',
          rules: DEFAULT_RULES,
          description: 'Auto-created default cost rules'
        })
        .select()
        .single();

      if (!createError) return newRuleSet;
    }

    return null;
  } catch (error) {
    console.error('Error loading rule set:', error);
    return null;
  }
}

// ============================================================
// Helper: Fetch Cost Inputs
// ============================================================

async function fetchCostInputs(userId, sourceRunId, options) {
  const { useProbInputs, forceDeterministic } = options;

  try {
    let inputs = [];

    // Try probabilistic summary first (if not forced deterministic)
    if (useProbInputs && !forceDeterministic) {
      const { data: probData, error: probError } = await supabase
        .from('inventory_forecast_prob_summary')
        .select('*')
        .eq('forecast_run_id', sourceRunId)
        .eq('user_id', userId);

      if (!probError && probData && probData.length > 0) {
        inputs = probData.map(row => ({
          key: `${row.material_code}|${row.plant_id}`,
          materialCode: row.material_code,
          plantId: row.plant_id,
          shortageQty: row.expected_shortage_qty || 0,
          pStockout: row.p_stockout || 0,
          stockoutBucketP50: row.stockout_bucket_p50,
          stockoutBucketP90: row.stockout_bucket_p90,
          expectedMinAvailable: row.expected_min_available,
          source: 'probabilistic'
        }));
      }
    }

    // Fallback to deterministic summary using component_demand
    if (inputs.length === 0) {
      // Get component_demand data for this run (deterministic projection results)
      const { data: compData, error: compError } = await supabase
        .from('component_demand')
        .select('*')
        .eq('forecast_run_id', sourceRunId)
        .eq('user_id', userId);

      if (!compError && compData && compData.length > 0) {
        // Aggregate by material|plant key
        const byKey = {};
        for (const row of compData) {
          const key = `${row.material_code}|${row.plant_id}`;
          if (!byKey[key]) {
            byKey[key] = {
              material_code: row.material_code,
              plant_id: row.plant_id,
              total_demand: 0
            };
          }
          byKey[key].total_demand += row.demand_qty || 0;
        }
        
        inputs = Object.values(byKey).map(row => ({
          key: `${row.material_code}|${row.plant_id}`,
          materialCode: row.material_code,
          plantId: row.plant_id,
          shortageQty: row.total_demand, // Use demand as proxy for shortage
          pStockout: 0.5, // Default probability
          stockoutBucketP50: null,
          source: 'component_demand'
        }));
      }
    }

    // Fallback to inventory_snapshots (latest inventory per material|plant)
    if (inputs.length === 0) {
      const { data: snapData, error: snapError } = await supabase
        .from('inventory_snapshots')
        .select('*')
        .eq('user_id', userId)
        .order('snapshot_date', { ascending: false })
        .limit(1000);

      if (!snapError && snapData && snapData.length > 0) {
        // Get latest snapshot per key
        const byKey = {};
        for (const row of snapData) {
          const key = `${row.material_code}|${row.plant_id}`;
          if (!byKey[key]) {
            byKey[key] = row;
          }
        }
        
        inputs = Object.values(byKey).map(row => {
          const onHand = row.onhand_qty ?? row.on_hand_qty ?? 0;
          return {
            key: `${row.material_code}|${row.plant_id}`,
            materialCode: row.material_code,
            plantId: row.plant_id,
            shortageQty: onHand < 0 ? Math.abs(onHand) : 0,
            pStockout: onHand < 0 ? 1.0 : 0,
            expectedMinAvailable: onHand,
            source: 'snapshot'
          };
        });
      }
    }

    if (inputs.length === 0) {
      return { success: false, error: 'No input data found for source run' };
    }

    return { success: true, data: inputs, source: inputs[0]?.source };

  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ============================================================
// Helper: Save Cost Results
// ============================================================

async function saveCostResults(userId, costRunId, results, ruleSetVersion) {
  try {
    // Prepare payloads
    const payloads = results.map(result => ({
      user_id: userId,
      forecast_run_id: costRunId,
      material_code: result.materialCode,
      plant_id: result.plantId,
      action_type: result.actionType,
      expected_cost: result.expectedCost,
      cost_breakdown: result.breakdown,
      inputs: result.inputs,
      rule_set_version: ruleSetVersion,
      engine_version: COST_ENGINE_VERSION
    }));

    // Batch insert in chunks of 1000
    const chunkSize = 1000;
    for (let i = 0; i < payloads.length; i += chunkSize) {
      const chunk = payloads.slice(i, i + chunkSize);
      
      const { error } = await supabase
        .from('cost_forecast_results')
        .upsert(chunk, {
          onConflict: ['user_id', 'forecast_run_id', 'material_code', 'plant_id', 'action_type'],
          ignoreDuplicates: false // Update on conflict
        });

      if (error) {
        return { success: false, error: error.message };
      }
    }

    return { success: true, count: payloads.length };

  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ============================================================
// Query Functions
// ============================================================

/**
 * Get cost results for a run
 */
export async function getCostResults(userId, costRunId, options = {}) {
  const { limit = 1000, offset = 0, actionType = null } = options;

  try {
    let query = supabase
      .from('cost_forecast_results')
      .select('*')
      .eq('user_id', userId)
      .eq('forecast_run_id', costRunId)
      .order('expected_cost', { ascending: false })
      .range(offset, offset + limit - 1);

    if (actionType) {
      query = query.eq('action_type', actionType);
    }

    const { data, error } = await query;

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, data };

  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Get cost results grouped by key (for display)
 */
export async function getCostResultsByKey(userId, costRunId) {
  try {
    const { data, error } = await supabase
      .from('cost_forecast_results')
      .select('*')
      .eq('user_id', userId)
      .eq('forecast_run_id', costRunId);

    if (error) {
      return { success: false, error: error.message };
    }

    // Group by key
    const grouped = {};
    for (const row of data) {
      const key = `${row.material_code}|${row.plant_id}`;
      if (!grouped[key]) {
        grouped[key] = {
          key,
          material_code: row.material_code,
          plant_id: row.plant_id,
          costs: {}
        };
      }
      grouped[key].costs[row.action_type] = {
        expected_cost: row.expected_cost,
        breakdown: row.cost_breakdown,
        inputs: row.inputs
      };
    }

    // Convert to array and compute totals
    const result = Object.values(grouped).map(item => {
      const expedite = item.costs.expedite?.expected_cost || 0;
      const substitution = item.costs.substitution?.expected_cost || 0;
      const disruption = item.costs.disruption?.expected_cost || 0;
      
      return {
        ...item,
        expedite_cost: expedite,
        substitution_cost: substitution,
        disruption_cost: disruption,
        total_cost: expedite + substitution + disruption,
        cheapest_action: expedite <= substitution && expedite <= disruption ? 'expedite' :
                         substitution <= expedite && substitution <= disruption ? 'substitution' : 'disruption'
      };
    });

    return { success: true, data: result };

  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Get cost rule sets for user
 */
export async function getCostRuleSets(userId) {
  try {
    const { data, error } = await supabase
      .from('cost_rule_sets')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, data };

  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Create or update a rule set
 */
export async function saveRuleSet(userId, ruleSetData) {
  try {
    const { id, ...data } = ruleSetData;
    
    const payload = {
      user_id: userId,
      ...data,
      updated_at: new Date().toISOString()
    };

    let result;
    if (id) {
      // Update
      result = await supabase
        .from('cost_rule_sets')
        .update(payload)
        .eq('id', id)
        .eq('user_id', userId)
        .select()
        .single();
    } else {
      // Insert
      result = await supabase
        .from('cost_rule_sets')
        .insert(payload)
        .select()
        .single();
    }

    if (result.error) {
      return { success: false, error: result.error.message };
    }

    return { success: true, data: result.data };

  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ============================================================
// Export for testing
// ============================================================
export { COST_ENGINE_VERSION, SERVICE_VERSION };
