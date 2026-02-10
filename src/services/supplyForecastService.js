/**
 * Milestone 4: Supply Forecast Service (WP3)
 * 
 * Service for running supply forecast pipeline and writing to database.
 * Includes: run orchestration, DB writes, and integration with forecast_runs.
 */

import { executeSupplyForecast } from '../domains/supply/supplyForecastEngine.js';

/**
 * Run Supply Forecast pipeline
 * 
 * @param {Object} params - Run parameters
 * @param {Object} services - Supabase services object
 * @returns {Object} - Run result with statistics
 */
export async function runSupplyForecast(params, services) {
  const {
    userId,
    plantId = null,
    timeBuckets,
    historyWindowDays = 90,
    modelVersion = 'supply_v1',
    scenarioName = 'supply_forecast'
  } = params;
  
  const {
    forecastRunsService,
    supplyForecastService
  } = services;
  
  const startTime = Date.now();
  let stepTimings = {};
  
  try {
    // Step 1: Create forecast run record
    const runStart = Date.now();
    const runRecord = await forecastRunsService.createRun(userId, {
      scenarioName,
      parameters: {
        kind: 'supply_forecast',
        model_version: modelVersion,
        history_window_days: historyWindowDays,
        time_buckets: timeBuckets,
        plant_id: plantId
      },
      kind: 'supply_forecast'
    });
    const forecastRunId = runRecord.id;
    stepTimings.createRunMs = Date.now() - runStart;
    
    // Step 2: Fetch inputs (PO lines, receipts, suppliers)
    const fetchStart = Date.now();
    const { poLines, receipts, suppliers } = await supplyForecastService.fetchInputs(
      userId, 
      plantId,
      { 
        historyWindowDays,
        // Only fetch open POs (open_qty > 0 and not cancelled)
        status: 'open'
      }
    );
    stepTimings.fetchMs = Date.now() - fetchStart;
    
    if (poLines.length === 0) {
      throw new Error('No open PO lines found for the specified criteria');
    }
    
    // Step 3: Execute supply forecast engine
    const computeStart = Date.now();
    const forecastResult = executeSupplyForecast(
      { receipts, poLines, timeBuckets },
      {
        modelVersion,
        fallbackLeadTimeDays: 14,
        historyWindowDays,
        today: new Date(),
        minSampleSize: 3
      }
    );
    stepTimings.computeMs = Date.now() - computeStart;
    
    if (!forecastResult.success) {
      throw new Error(forecastResult.error || 'Forecast engine failed');
    }
    
    // Step 4: Write results to database
    const insertStart = Date.now();
    const insertResult = await supplyForecastService.saveForecastResults(
      userId,
      forecastRunId,
      forecastResult,
      modelVersion
    );
    stepTimings.insertMs = Date.now() - insertStart;
    
    const totalDuration = Date.now() - startTime;
    
    return {
      success: true,
      forecastRunId,
      statistics: {
        supplierStatsCount: insertResult.supplierStatsCount,
        poForecastsCount: insertResult.poForecastsCount,
        inboundBucketsCount: insertResult.inboundBucketsCount,
        traceCount: insertResult.traceCount,
        totalDurationMs: totalDuration,
        stepTimings
      },
      runRecord: {
        ...runRecord,
        parameters: {
          kind: 'supply_forecast',
          model_version: modelVersion,
          history_window_days: historyWindowDays,
          time_buckets: timeBuckets,
          plant_id: plantId
        }
      }
    };
    
  } catch (error) {
    return {
      success: false,
      forecastRunId: null,
      error: error.message,
      stack: error.stack,
      statistics: {
        totalDurationMs: Date.now() - startTime,
        stepTimings
      }
    };
  }
}

/**
 * Supply Forecast Service object for DB operations
 */
export const supplyForecastService = {
  
  /**
   * Fetch input data for supply forecast
   * 
   * @param {string} userId - User ID
   * @param {string} plantId - Plant filter (optional)
   * @param {Object} options - Fetch options
   * @returns {Object} - { poLines, receipts, suppliers }
   */
  async fetchInputs(userId, plantId, options = {}) {
    // Fetch open PO lines
    let poQuery = supabase
      .from('po_open_lines')
      .select('id, po_number, po_line, supplier_id, material_code, plant_id, open_qty, time_bucket, status')
      .eq('user_id', userId)
      .gt('open_qty', 0)
      .not('status', 'eq', 'cancelled');
    
    if (plantId) {
      poQuery = poQuery.eq('plant_id', plantId);
    }
    
    const { data: poLines, error: poError } = await poQuery;
    
    if (poError) {
      console.error('Error fetching PO lines:', poError);
      throw new Error(`Failed to fetch PO lines: ${poError.message}`);
    }
    
    // Fetch receipts (completed/delivered POs for supplier stats)
    // Note: Using same po_open_lines table but with status filter for now
    let receiptQuery = supabase
      .from('po_open_lines')
      .select('po_number, supplier_id, plant_id, time_bucket, open_qty')
      .eq('user_id', userId)
      .eq('status', 'completed');
    
    if (plantId) {
      receiptQuery = receiptQuery.eq('plant_id', plantId);
    }
    
    const { data: receipts, error: receiptError } = await receiptQuery;
    
    if (receiptError) {
      console.error('Error fetching receipts:', receiptError);
      // Don't throw - we can still run with fallback
    }
    
    // Fetch supplier master data (for fallback lead times)
    let supplierQuery = supabase
      .from('suppliers')
      .select('supplier_code, plant_id, lead_time_days, on_time_rate')
      .eq('user_id', userId);
    
    if (plantId) {
      supplierQuery = supplierQuery.eq('plant_id', plantId);
    }
    
    const { data: suppliers, error: supplierError } = await supplierQuery;
    
    if (supplierError) {
      console.error('Error fetching suppliers:', supplierError);
    }
    
    return {
      poLines: (poLines || []).map(po => ({
        po_line_id: po.id, // Use the row id as po_line_id
        po_id: po.po_number,
        supplier_id: po.supplier_id,
        material_code: po.material_code,
        plant_id: po.plant_id,
        open_qty: parseFloat(po.open_qty) || 0,
        promised_date: null, // Not available in current schema
        order_date: null, // Not available in current schema
        time_bucket: po.time_bucket
      })),
      receipts: (receipts || []).map(r => ({
        po_id: r.po_number,
        supplier_id: r.supplier_id,
        plant_id: r.plant_id,
        order_date: null, // Not available
        promised_date: null, // Not available
        receipt_date: r.time_bucket, // Use time_bucket as proxy
        qty: parseFloat(r.open_qty) || 0,
        order_qty: parseFloat(r.open_qty) || 0
      })),
      suppliers: (suppliers || []).map(s => ({
        supplier_id: s.supplier_code, // Map supplier_code to supplier_id
        plant_id: s.plant_id,
        lead_time_days: s.lead_time_days,
        on_time_rate: s.on_time_rate
      }))
    };
  },
  
  /**
   * Save forecast results to database
   * 
   * @param {string} userId - User ID
   * @param {string} forecastRunId - Forecast run ID
   * @param {Object} forecastResult - Result from executeSupplyForecast
   * @param {string} modelVersion - Model version
   * @returns {Object} - Insert counts
   */
  async saveForecastResults(userId, forecastRunId, forecastResult, modelVersion) {
    const { supplierStats, poForecasts, inboundByBucket, traces } = forecastResult;
    
    // Insert supplier stats
    let supplierStatsCount = 0;
    if (supplierStats && supplierStats.length > 0) {
      const statsPayload = supplierStats.map(stats => ({
        user_id: userId,
        forecast_run_id: forecastRunId,
        supplier_id: stats.supplier_id,
        plant_id: stats.plant_id,
        sample_size: stats.sample_size,
        lead_time_p50_days: stats.lead_time_p50_days,
        lead_time_p90_days: stats.lead_time_p90_days,
        on_time_rate: stats.on_time_rate,
        short_ship_rate: stats.short_ship_rate,
        model_version: modelVersion,
        metrics: stats.metrics
      }));
      
      const { error } = await supabase
        .from('supplier_supply_stats')
        .insert(statsPayload);
      
      if (error) {
        console.error('Error inserting supplier stats:', error);
        throw new Error(`Failed to save supplier stats: ${error.message}`);
      }
      supplierStatsCount = statsPayload.length;
    }
    
    // Insert PO forecasts
    let poForecastsCount = 0;
    if (poForecasts && poForecasts.length > 0) {
      const poPayload = poForecasts.map(po => ({
        user_id: userId,
        forecast_run_id: forecastRunId,
        po_line_id: po.po_line_id,
        po_id: po.po_id,
        supplier_id: po.supplier_id,
        material_code: po.material_code,
        plant_id: po.plant_id,
        open_qty: po.open_qty,
        promised_date: po.promised_date,
        arrival_p50_bucket: po.arrival_p50_bucket,
        arrival_p90_bucket: po.arrival_p90_bucket,
        delay_prob: po.delay_prob,
        short_ship_prob: po.short_ship_prob,
        model_version: modelVersion,
        metrics: po.metrics
      }));
      
      // Batch insert in chunks
      const chunkSize = 500;
      for (let i = 0; i < poPayload.length; i += chunkSize) {
        const chunk = poPayload.slice(i, i + chunkSize);
        const { error } = await supabase
          .from('supply_forecast_po')
          .insert(chunk);
        
        if (error) {
          console.error(`Error inserting PO forecasts chunk ${i}:`, error);
          throw new Error(`Failed to save PO forecasts: ${error.message}`);
        }
      }
      poForecastsCount = poPayload.length;
    }
    
    // Insert inbound by bucket
    let inboundBucketsCount = 0;
    const inboundIdMap = {}; // For trace linking
    
    if (inboundByBucket && inboundByBucket.length > 0) {
      const inboundPayload = inboundByBucket.map(inbound => ({
        user_id: userId,
        forecast_run_id: forecastRunId,
        material_code: inbound.material_code,
        plant_id: inbound.plant_id,
        time_bucket: inbound.time_bucket,
        p50_qty: inbound.p50_qty,
        p90_qty: inbound.p90_qty,
        model_version: modelVersion,
        metrics: {
          avg_delay_prob: inbound.avg_delay_prob,
          supplier_count: inbound.supplier_count,
          po_line_count: inbound.po_line_count
        }
      }));
      
      // Need to get IDs back for trace linking
      for (const payload of inboundPayload) {
        const { data, error } = await supabase
          .from('supply_forecast_inbound')
          .insert(payload)
          .select('id, material_code, plant_id, time_bucket')
          .single();
        
        if (error) {
          console.error('Error inserting inbound:', error);
          continue;
        }
        
        inboundIdMap[`${payload.material_code}|${payload.plant_id}|${payload.time_bucket}`] = data.id;
        inboundBucketsCount++;
      }
    }
    
    // Insert trace records
    let traceCount = 0;
    if (traces && traces.length > 0) {
      const tracePayload = traces.map(trace => {
        const inboundKey = `${trace.material_code}|${trace.plant_id}|${trace.time_bucket}`;
        const inboundId = inboundIdMap[inboundKey];
        
        if (!inboundId) return null;
        
        return {
          user_id: userId,
          forecast_run_id: forecastRunId,
          supply_forecast_inbound_id: inboundId,
          po_line_id: trace.po_line_id,
          contrib_qty: trace.contrib_qty,
          arrival_p50_bucket: trace.arrival_p50_bucket,
          arrival_p90_bucket: trace.arrival_p90_bucket,
          delay_prob: trace.delay_prob,
          trace_meta: {
            ...trace.trace_meta,
            supplier_id: trace.supplier_id,
            supplier_stats: trace.supplier_stats
          }
        };
      }).filter(Boolean);
      
      // Batch insert traces
      const chunkSize = 500;
      for (let i = 0; i < tracePayload.length; i += chunkSize) {
        const chunk = tracePayload.slice(i, i + chunkSize);
        const { error } = await supabase
          .from('supply_forecast_inbound_trace')
          .insert(chunk);
        
        if (error) {
          console.error(`Error inserting traces chunk ${i}:`, error);
          // Don't throw - trace is non-critical
        } else {
          traceCount += chunk.length;
        }
      }
    }
    
    return {
      supplierStatsCount,
      poForecastsCount,
      inboundBucketsCount,
      traceCount
    };
  },
  
  /**
   * List supply forecast runs
   * 
   * @param {string} userId - User ID
   * @param {Object} options - Query options
   * @returns {Promise<Array>} - List of forecast runs
   */
  async listRuns(userId, options = {}) {
    const { limit = 50 } = options;
    
    // Note: forecast_runs uses 'user_id' (table was recreated)
    let query = supabase
      .from('forecast_runs')
      .select('id, scenario_name, parameters, created_at, kind')
      .eq('user_id', userId)
      .eq('parameters->>kind', 'supply_forecast')
      .order('created_at', { ascending: false })
      .limit(limit);
    
    const { data, error } = await query;
    
    if (error) {
      console.error('Error listing supply forecast runs:', error);
      throw error;
    }
    
    return data || [];
  },
  
  /**
   * Get inbound forecast for a run
   */
  async getInboundByRun(userId, forecastRunId, options = {}) {
    const { materialCode, plantId } = options;
    
    let query = supabase
      .from('supply_forecast_inbound')
      .select('*')
      .eq('user_id', userId)
      .eq('forecast_run_id', forecastRunId);
    
    if (materialCode) {
      query = query.eq('material_code', materialCode);
    }
    if (plantId) {
      query = query.eq('plant_id', plantId);
    }
    
    const { data, error } = await query;
    
    if (error) {
      console.error('Error fetching inbound forecast:', error);
      throw error;
    }
    
    return data || [];
  },
  
  /**
   * Get trace for an inbound forecast
   */
  async getTraceForInbound(userId, inboundId, options = {}) {
    const { limit = 50 } = options;
    
    const { data, error } = await supabase
      .from('supply_forecast_inbound_trace')
      .select('*')
      .eq('user_id', userId)
      .eq('supply_forecast_inbound_id', inboundId)
      .limit(limit);
    
    if (error) {
      console.error('Error fetching trace:', error);
      throw error;
    }
    
    return data || [];
  },
  
  /**
   * Get supplier stats for a run
   */
  async getSupplierStatsByRun(userId, forecastRunId) {
    const { data, error } = await supabase
      .from('supplier_supply_stats')
      .select('*')
      .eq('user_id', userId)
      .eq('forecast_run_id', forecastRunId);
    
    if (error) {
      console.error('Error fetching supplier stats:', error);
      throw error;
    }
    
    return data || [];
  }
};

// Import supabase client
import { supabase } from './supabaseClient.js';

export default {
  runSupplyForecast,
  supplyForecastService
};
