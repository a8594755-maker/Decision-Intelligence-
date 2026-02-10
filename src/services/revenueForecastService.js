/**
 * Milestone 6: Revenue/Price/Margin at Risk Service
 * WP3: Service Orchestration with lineage tracking
 * 
 * Handles:
 * - Creating revenue forecast runs with full lineage
 * - Reading revenue terms, demand, and risk inputs
 * - Running margin at risk engine and saving results
 * - Performance tracking and observability
 */

import { supabase } from './supabaseClient';
import {
  calculateMarginAtRiskBatch,
  computeMarginAtRiskKPIs,
  validateRevenueTerm,
  REVENUE_ENGINE_VERSION,
  REVENUE_WARN_KEYS,
  REVENUE_STOP_KEYS
} from '../domains/inventory/revenueForecast';

// ============================================================
// Constants
// ============================================================

const SERVICE_VERSION = '1.0.0';

// ============================================================
// Main Entry: Run Revenue Forecast
// ============================================================

/**
 * Run a complete revenue/margin at risk forecast
 * 
 * @param {string} userId - User ID
 * @param {string} sourceBomRunId - Source BOM forecast run ID
 * @param {Object} options - Run options
 * @returns {Object} - Run result with KPIs and performance metrics
 */
export async function runRevenueForecast(userId, sourceBomRunId, options = {}) {
  const startTime = Date.now();
  
  const {
    plantId = null,
    timeBuckets = null,
    demandSource = 'uploaded', // 'uploaded' | 'demand_forecast'
    demandForecastRunId = null,
    riskInputMode = 'deterministic', // 'deterministic' | 'probabilistic'
    topN = 200,
    dryRun = false
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
      .eq('id', sourceBomRunId)
      .single();

    if (runError || !sourceRun) {
      return { 
        success: false, 
        error: `Source BOM run not found: ${runError?.message || 'Unknown'}`,
        mode: 'failed'
      };
    }

    // 3. Load revenue terms
    const revenueTermsLoadStart = Date.now();
    const revenueTermsMap = await loadRevenueTerms(userId, plantId);
    const revenueTermsLoadMs = Date.now() - revenueTermsLoadStart;

    if (Object.keys(revenueTermsMap).length === 0) {
      return { 
        success: false, 
        error: 'No revenue terms found. Please upload revenue terms first.',
        mode: 'failed',
        degradedReason: 'no_revenue_terms'
      };
    }

    // 4. Create forecast_runs entry with full lineage
    const { data: revenueRun, error: createError } = await supabase
      .from('forecast_runs')
      .insert({
        user_id: userId,
        kind: 'revenue_forecast',
        status: 'running',
        parameters: {
          // Bloodline - full traceability
          source_bom_run_id: sourceBomRunId,
          demand_source: demandSource,
          demand_forecast_run_id: demandSource === 'demand_forecast' ? demandForecastRunId : null,
          risk_input_mode: riskInputMode,
          plant_id: plantId,
          time_buckets: timeBuckets,
          top_n: topN,
          engine_version: REVENUE_ENGINE_VERSION,
          service_version: SERVICE_VERSION,
          revenue_warn_keys: REVENUE_WARN_KEYS,
          revenue_stop_keys: REVENUE_STOP_KEYS
        },
        triggered_by: 'user',
        started_at: new Date().toISOString()
      })
      .select()
      .single();

    if (createError) {
      return { success: false, error: createError.message, mode: 'failed' };
    }

    // 5. Fetch input data (demand + risk)
    const fetchStart = Date.now();
    const inputs = await fetchRevenueInputs(userId, sourceBomRunId, {
      demandSource,
      demandForecastRunId,
      riskInputMode,
      plantId,
      timeBuckets,
      revenueTermsMap
    });
    const fetchMs = Date.now() - fetchStart;

    if (!inputs.success) {
      await supabase
        .from('forecast_runs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: inputs.error
        })
        .eq('id', revenueRun.id);

      return { success: false, error: inputs.error, mode: 'failed' };
    }

    // Guard: no matching FG keys (revenue terms don't match demand)
    if (inputs.data.length === 0) {
      await supabase
        .from('forecast_runs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: 'No matching FG keys found between demand and revenue terms'
        })
        .eq('id', revenueRun.id);

      return { 
        success: false, 
        error: 'No matching FG keys between demand and revenue terms',
        mode: 'failed',
        degradedReason: 'no_matching_keys'
      };
    }

    // 6. Run margin at risk calculations
    const computeStart = Date.now();
    const calcResult = calculateMarginAtRiskBatch(
      inputs.data,
      revenueTermsMap,
      riskInputMode,
      { warnKeys: REVENUE_WARN_KEYS, stopKeys: REVENUE_STOP_KEYS, topN }
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
        .eq('id', revenueRun.id);

      return { 
        success: false, 
        error: calcResult.error,
        mode: calcResult.degraded ? 'degraded' : 'failed',
        degradedReason: calcResult.degradedReason
      };
    }

    // Dry run: don't save, just return
    if (dryRun) {
      return {
        success: true,
        mode: calcResult.degraded ? 'degraded' : 'success',
        dryRun: true,
        wouldSave: calcResult.results.length,
        kpis: calcResult.kpis,
        metrics: {
          revenueTermsLoadMs,
          fetchMs,
          computeMs,
          totalMs: Date.now() - startTime
        }
      };
    }

    // 7. Save results to database
    const saveStart = Date.now();
    const saveResult = await saveMarginAtRiskResults(
      userId, 
      revenueRun.id, 
      sourceBomRunId,
      calcResult.results, 
      riskInputMode
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
        .eq('id', revenueRun.id);

      return { success: false, error: saveResult.error, mode: 'failed' };
    }

    // 8. Compute KPIs
    const kpis = computeMarginAtRiskKPIs(calcResult.results);

    // 9. Update run as completed
    const duration = Date.now() - startTime;
    await supabase
      .from('forecast_runs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        result_summary: {
          fg_keys: kpis.overall.totalKeys,
          rows: calcResult.results.length,
          total_margin_at_risk: kpis.overall.totalMarginAtRisk,
          total_penalty_at_risk: kpis.overall.totalPenaltyAtRisk,
          total_at_risk: kpis.overall.totalAtRisk,
          top_fg: kpis.topFg,
          by_plant: kpis.byPlant,
          degraded: calcResult.degraded,
          degraded_reason: calcResult.degradedReason
        }
      })
      .eq('id', revenueRun.id);

    return {
      success: true,
      mode: calcResult.degraded ? 'degraded' : 'success',
      revenueRunId: revenueRun.id,
      kpis,
      metrics: {
        durationMs: duration,
        revenueTermsLoadMs,
        fetchMs,
        computeMs,
        saveMs,
        totalFgKeys: inputs.data.length,
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
// Helper: Load Revenue Terms
// ============================================================

async function loadRevenueTerms(userId, plantId = null) {
  try {
    let query = supabase
      .from('revenue_terms')
      .select('*')
      .eq('user_id', userId);
    
    if (plantId) {
      query = query.eq('plant_id', plantId);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error loading revenue terms:', error);
      return {};
    }

    // Build map of 'FG|Plant' -> term
    const termsMap = {};
    for (const term of (data || [])) {
      const key = `${term.fg_material_code}|${term.plant_id}`;
      termsMap[key] = {
        fgMaterialCode: term.fg_material_code,
        plantId: term.plant_id,
        marginPerUnit: parseFloat(term.margin_per_unit) || 0,
        pricePerUnit: term.price_per_unit ? parseFloat(term.price_per_unit) : null,
        cogsPerUnit: term.cogs_per_unit ? parseFloat(term.cogs_per_unit) : null,
        currency: term.currency || 'USD',
        penaltyType: term.penalty_type || 'none',
        penaltyValue: term.penalty_value ? parseFloat(term.penalty_value) : 0,
        id: term.id
      };
    }

    return termsMap;
  } catch (error) {
    console.error('Error loading revenue terms:', error);
    return {};
  }
}

// ============================================================
// Helper: Fetch Revenue Inputs (Demand + Risk)
// ============================================================

async function fetchRevenueInputs(userId, sourceBomRunId, options) {
  const {
    demandSource,
    demandForecastRunId,
    riskInputMode,
    plantId,
    timeBuckets,
    revenueTermsMap
  } = options;

  try {
    let demandRows = [];
    let riskRows = [];

    // 1. Fetch demand data
    if (demandSource === 'demand_forecast' && demandForecastRunId) {
      // From demand_forecast table
      const { data, error } = await supabase
        .from('demand_forecast')
        .select('*')
        .eq('forecast_run_id', demandForecastRunId)
        .eq('user_id', userId);

      if (!error && data) {
        demandRows = data.map(row => ({
          fgMaterialCode: row.material_code,
          plantId: row.plant_id,
          timeBucket: row.time_bucket,
          demandQty: row.p50 || row.forecast_qty || 0 // Use P50 as expected demand
        }));
      }
    } else {
      // From demand_fg table (uploaded)
      const { data, error } = await supabase
        .from('demand_fg')
        .select('*')
        .eq('user_id', userId);

      if (!error && data) {
        demandRows = data.map(row => ({
          fgMaterialCode: row.material_code,
          plantId: row.plant_id,
          timeBucket: row.time_bucket,
          demandQty: row.demand_qty || 0
        }));
      }
    }

    // Filter by plant if specified
    if (plantId) {
      demandRows = demandRows.filter(r => r.plantId === plantId);
    }

    // Filter by time buckets if specified
    if (timeBuckets && timeBuckets.length > 0) {
      demandRows = demandRows.filter(r => timeBuckets.includes(r.timeBucket));
    }

    // 2. Fetch risk data (shortage/p_stockout)
    if (riskInputMode === 'probabilistic') {
      // Try probabilistic summary
      const { data, error } = await supabase
        .from('inventory_forecast_prob_summary')
        .select('*')
        .eq('forecast_run_id', sourceBomRunId)
        .eq('user_id', userId);

      if (!error && data) {
        riskRows = data.map(row => ({
          materialCode: row.material_code,
          plantId: row.plant_id,
          pStockout: row.p_stockout || 0,
          expectedShortageQty: row.expected_shortage_qty || 0
        }));
      }
    } else {
      // Deterministic: try to get shortage from inventory projection
      // For MVP, we'll estimate shortage from component_demand vs inbound
      // Simplified: use component_demand as proxy for shortage risk
      const { data, error } = await supabase
        .from('component_demand')
        .select('*')
        .eq('forecast_run_id', sourceBomRunId)
        .eq('user_id', userId);

      if (!error && data) {
        // Aggregate shortage by material|plant
        const byKey = {};
        for (const row of data) {
          const key = `${row.material_code}|${row.plant_id}`;
          if (!byKey[key]) {
            byKey[key] = {
              materialCode: row.material_code,
              plantId: row.plant_id,
              totalDemand: 0
            };
          }
          byKey[key].totalDemand += row.demand_qty || 0;
        }
        riskRows = Object.values(byKey).map(r => ({
          ...r,
          shortageQty: r.totalDemand // Use demand as shortage proxy
        }));
      }
    }

    // 3. Merge demand with risk data
    // For MVP: we need to map FG demand to risk data
    // Since we don't have FG-level shortage yet, we'll use the demand with estimated risk
    const merged = [];
    
    for (const demand of demandRows) {
      const fgKey = `${demand.fgMaterialCode}|${demand.plantId}`;
      
      // Only include if we have revenue terms for this FG
      if (!revenueTermsMap[fgKey]) {
        continue;
      }

      // Find matching risk row (if any)
      const riskRow = riskRows.find(r => 
        r.materialCode === demand.fgMaterialCode && r.plantId === demand.plantId
      );

      merged.push({
        fgMaterialCode: demand.fgMaterialCode,
        plantId: demand.plantId,
        timeBucket: demand.timeBucket,
        demandQty: demand.demandQty,
        // Demo fallback: if no shortage data, use 30% of demand as impacted
        shortageQty: riskRow?.shortageQty || Math.floor(demand.demandQty * 0.3),
        pStockout: riskRow?.pStockout || 0.3, // Demo: 30% stockout probability
        expectedShortageQty: riskRow?.expectedShortageQty || Math.floor(demand.demandQty * 0.3)
      });
    }

    if (merged.length === 0) {
      return { success: false, error: 'No matching demand+revenue+risk data found' };
    }

    return { success: true, data: merged };

  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ============================================================
// Helper: Save Margin at Risk Results
// ============================================================

async function saveMarginAtRiskResults(userId, revenueRunId, sourceBomRunId, results, riskInputMode) {
  try {
    // Prepare payloads
    const payloads = results.map(result => ({
      user_id: userId,
      forecast_run_id: revenueRunId,
      source_bom_run_id: sourceBomRunId,
      risk_input_mode: riskInputMode,
      fg_material_code: result.fgMaterialCode,
      plant_id: result.plantId,
      time_bucket: result.timeBucket,
      demand_qty: result.demandQty,
      impacted_qty: result.impactedQty,
      shortage_qty: result.inputs?.shortageQty || 0,
      p_stockout: result.inputs?.pStockout || null,
      margin_per_unit: result.marginPerUnit,
      price_per_unit: result.pricePerUnit || null,
      penalty_type: result.penaltyType || 'none',
      penalty_value: result.penaltyValue || 0,
      expected_margin_at_risk: result.expectedMarginAtRisk,
      expected_penalty_at_risk: result.expectedPenaltyAtRisk,
      inputs: {
        ...result.inputs,
        demand_qty: result.demandQty,
        impacted_qty_calculation: result.impactedQty,
        margin_per_unit: result.marginPerUnit
      }
    }));

    // Batch insert in chunks of 1000
    const chunkSize = 1000;
    for (let i = 0; i < payloads.length; i += chunkSize) {
      const chunk = payloads.slice(i, i + chunkSize);
      
      const { error } = await supabase
        .from('margin_at_risk_results')
        .upsert(chunk, {
          onConflict: ['user_id', 'forecast_run_id', 'fg_material_code', 'plant_id', 'time_bucket'],
          ignoreDuplicates: false
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
 * Get margin at risk results for a run
 */
export async function getMarginAtRiskResults(userId, revenueRunId, options = {}) {
  const { limit = 1000, offset = 0, plantId = null, timeBucket = null } = options;

  try {
    let query = supabase
      .from('margin_at_risk_results')
      .select('*')
      .eq('user_id', userId)
      .eq('forecast_run_id', revenueRunId)
      .order('expected_margin_at_risk', { ascending: false })
      .range(offset, offset + limit - 1);

    if (plantId) {
      query = query.eq('plant_id', plantId);
    }

    if (timeBucket) {
      query = query.eq('time_bucket', timeBucket);
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
 * Get revenue terms for user
 */
export async function getRevenueTerms(userId, options = {}) {
  const { plantId = null, fgMaterialCode = null } = options;

  try {
    let query = supabase
      .from('revenue_terms')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (plantId) {
      query = query.eq('plant_id', plantId);
    }

    if (fgMaterialCode) {
      query = query.eq('fg_material_code', fgMaterialCode);
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
 * Save revenue term
 */
export async function saveRevenueTerm(userId, termData) {
  try {
    const { id, ...data } = termData;
    
    const payload = {
      user_id: userId,
      ...data,
      updated_at: new Date().toISOString()
    };

    let result;
    if (id) {
      // Update
      result = await supabase
        .from('revenue_terms')
        .update(payload)
        .eq('id', id)
        .eq('user_id', userId)
        .select()
        .single();
    } else {
      // Insert
      result = await supabase
        .from('revenue_terms')
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

/**
 * Delete revenue term
 */
export async function deleteRevenueTerm(userId, termId) {
  try {
    const { error } = await supabase
      .from('revenue_terms')
      .delete()
      .eq('id', termId)
      .eq('user_id', userId);

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true };

  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ============================================================
// Risk Dashboard Integration Functions (Gate-R5)
// ============================================================

/**
 * Get latest revenue run for a BOM run (for Risk Dashboard)
 */
export async function getLatestRevenueRunForBomRun(userId, bomRunId) {
  try {
    // Fetch all revenue runs for this user, then filter by source_bom_run_id
    const { data, error } = await supabase
      .from('forecast_runs')
      .select('id, created_at, parameters, result_summary, status')
      .eq('user_id', userId)
      .eq('kind', 'revenue_forecast')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      return { success: false, error: error.message };
    }

    // Filter for matching source_bom_run_id in parameters
    const matchingRun = (data || []).find(run => 
      run.parameters?.source_bom_run_id === bomRunId
    );

    if (!matchingRun) {
      return { success: false, error: 'No revenue run found for this BOM run', notFound: true };
    }

    return { success: true, data: matchingRun };

  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Get revenue summary aggregated by FG|Plant key (for Risk Table)
 */
export async function getRevenueSummaryByRun(userId, revenueRunId) {
  try {
    const { data, error } = await supabase
      .from('margin_at_risk_results')
      .select('fg_material_code, plant_id, expected_margin_at_risk, expected_penalty_at_risk')
      .eq('user_id', userId)
      .eq('forecast_run_id', revenueRunId);

    if (error) {
      return { success: false, error: error.message };
    }

    // Aggregate by FG|Plant key
    const summaryByKey = {};
    for (const row of (data || [])) {
      const key = `${row.fg_material_code}|${row.plant_id}`;
      if (!summaryByKey[key]) {
        summaryByKey[key] = {
          fgMaterialCode: row.fg_material_code,
          plantId: row.plant_id,
          marginAtRisk: 0,
          penaltyAtRisk: 0,
          totalAtRisk: 0
        };
      }
      summaryByKey[key].marginAtRisk += (row.expected_margin_at_risk || 0);
      summaryByKey[key].penaltyAtRisk += (row.expected_penalty_at_risk || 0);
      summaryByKey[key].totalAtRisk += (row.expected_margin_at_risk || 0) + (row.expected_penalty_at_risk || 0);
    }

    return { success: true, data: summaryByKey };

  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Get revenue series by bucket for a specific FG|Plant (for DetailsPanel)
 */
export async function getRevenueSeriesForKey(userId, revenueRunId, fgMaterialCode, plantId) {
  try {
    const { data, error } = await supabase
      .from('margin_at_risk_results')
      .select('*')
      .eq('user_id', userId)
      .eq('forecast_run_id', revenueRunId)
      .eq('fg_material_code', fgMaterialCode)
      .eq('plant_id', plantId)
      .order('time_bucket', { ascending: true });

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, data: data || [] };

  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ============================================================
// Export for testing
// ============================================================

export { REVENUE_ENGINE_VERSION, SERVICE_VERSION };
