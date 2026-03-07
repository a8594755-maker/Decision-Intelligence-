/**
 * BOM Explosion Service
 * BOM explosion service - Explode FG demand into Component demand
 * 
 * This file is the Service layer, responsible for:
 * - Calling Edge Function for time-consuming calculations
 * - Polling job status
 * - Providing fallback local calculation
 * 
 * Edge Function endpoint: /functions/v1/bom-explosion
 */

// Feature flag: use Edge Function (true) or local calculation (false)
const USE_EDGE_FUNCTION = true;

// Import Domain layer functions (for fallback)
import {
  explodeBOM as domainExplodeBOM,
  getAggregationKey
} from '../domains/forecast/bomCalculator.js';

import { supabase } from './supabaseClient';

/**
 * Execute BOM Explosion via Edge Function
 * Two-phase flow: 1) Start job 2) Poll status
 * 
 * @param {Object} options - Options
 * @param {string} options.plantId - Plant filter
 * @param {string[]} options.timeBuckets - Time bucket filter
 * @param {string} options.demandSource - 'demand_fg' | 'demand_forecast'
 * @param {string} options.demandForecastRunId - Demand forecast run ID (if demandSource = demand_forecast)
 * @param {string} options.inboundSource - Inbound source
 * @param {string} options.supplyForecastRunId - Supply forecast run ID
 * @param {string} options.scenarioName - Scenario name
 * @param {Object} options.metadata - Additional metadata
 * @returns {Promise<Object>} {success, batchId, forecastRunId, status, message}
 */
export async function executeBomExplosion(options = {}) {
  // If Edge Function disabled, use legacy local calculation
  if (!USE_EDGE_FUNCTION) {
    return _executeBomExplosionLegacyPlaceholder(options);
  }

  try {
    // Step 1: Call Edge Function to start job
    const { data, error } = await supabase.functions.invoke('bom-explosion', {
      body: {
        plantId: options.metadata?.plant_id,
        timeBuckets: options.metadata?.time_buckets,
        demandSource: options.demandSource || 'demand_fg',
        demandForecastRunId: options.inputDemandForecastRunId,
        inboundSource: options.inboundSource,
        supplyForecastRunId: options.inputSupplyForecastRunId,
        scenarioName: options.scenarioName || 'baseline',
        metadata: options.metadata || {},
        forceNewRun: options.forceNewRun || false
      }
    });

    if (error) {
      console.error('Edge Function invocation failed:', error);
      // Try to extract detailed error information
      let errorDetails = error.message;
      if (error.context && error.context.response) {
        try {
          const responseData = await error.context.response.json();
          errorDetails = JSON.stringify(responseData, null, 2);
        } catch (_e) {
          // If not JSON, use original message
        }
      }
      throw new Error(`Edge Function call failed: ${errorDetails}`);
    }

    // Return job info immediately, frontend needs to start polling
    return {
      success: true,
      batchId: data.batchId,
      forecastRunId: data.forecastRunId,
      status: data.status,
      message: data.message,
      // Mark this as Edge Function mode, frontend needs to poll
      requiresPolling: true
    };

  } catch (error) {
    console.error('BOM Explosion Edge Function start failed:', error);
    
    // If Edge Function fails, can optionally fallback to local calculation
    // return _executeBomExplosionLegacyPlaceholder(options);
    
    throw error;
  }
}

/**
 * Poll BOM Explosion calculation status
 * 
 * @param {string} batchId - Batch ID
 * @param {Object} callbacks - Callback functions
 * @param {Function} callbacks.onProgress - Progress update callback (status, metadata)
 * @param {Function} callbacks.onComplete - Completion callback (result)
 * @param {Function} callbacks.onError - Error callback (error)
 * @param {number} maxAttempts - Max polling attempts (default 60 = 2 minutes)
 * @param {number} intervalMs - Polling interval (default 2000ms)
 * @returns {Promise<Object>} Final result
 */
export async function pollBomExplosionStatus(
  batchId,
  callbacks = {},
  maxAttempts = 60,
  intervalMs = 2000
) {
  const { onProgress, onComplete, onError } = callbacks;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const { data, error } = await supabase
        .from('import_batches')
        .select('status, metadata, error_message')
        .eq('id', batchId)
        .single();

      if (error) {
        throw new Error(`Failed to query batch status: ${error.message}`);
      }

      if (!data) {
        throw new Error(`Batch not found: ${batchId}`);
      }

      // Call progress callback
      if (onProgress) {
        onProgress(data.status, data.metadata);
      }

      // Handle based on status
      switch (data.status) {
        case 'completed': {
          const result = {
            success: true,
            batchId,
            forecastRunId: data.metadata?.forecast_run_id,
            componentDemandCount: data.metadata?.component_demand_count || 0,
            traceCount: data.metadata?.component_demand_trace_count || 0,
            errors: data.metadata?.errors || [],
            metadata: data.metadata
          };
          
          if (onComplete) {
            onComplete(result);
          }
          
          return result;
        }

        case 'failed': {
          const errorMsg = data.error_message || data.metadata?.error || 'Calculation failed';
          const error = new Error(errorMsg);
          
          if (onError) {
            onError(error);
          }
          
          return {
            success: false,
            batchId,
            error: errorMsg,
            metadata: data.metadata
          };
        }

        case 'running':
        case 'pending':
          // Continue polling
          break;

        default:
          throw new Error(`Unknown batch status: ${data.status}`);
      }

      // Wait then retry
      await new Promise(resolve => setTimeout(resolve, intervalMs));

    } catch (error) {
      console.error(`Polling failed (attempt ${attempt + 1}/${maxAttempts}):`, error);
      
      if (attempt === maxAttempts - 1) {
        const timeoutError = new Error(`Polling timeout: ${error.message}`);
        if (onError) {
          onError(timeoutError);
        }
        throw timeoutError;
      }
      
      // Brief wait then retry
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }

  const timeoutError = new Error(`Polling timeout: reached max attempts ${maxAttempts}`);
  if (onError) {
    onError(timeoutError);
  }
  throw timeoutError;
}

/**
 * Legacy: Local BOM Explosion execution (kept as fallback)
 * @deprecated Please use executeBomExplosion + Edge Function
 */
async function _executeBomExplosionLegacyPlaceholder(_options = {}) {
  // This is the original local calculation logic, kept but not directly used
  // Can extract legacy params from options and call when needed
  console.warn('Using legacy local calculation mode');
  throw new Error('Legacy mode not implemented in this refactor');
}

/**
 * Execute BOM Explosion calculation
 * 
 * This function is a wrapper for Domain layer explodeBOM, maintaining backward compatibility
 * 
 * @deprecated Recommend using Domain layer explodeBOM function directly
 * @param {Array} demandFgRows - FG demand array
 * @param {Array} bomEdgesRows - BOM edges array
 * @param {Object} options - Options
 * @returns {Object} {componentDemandRows, traceRows, errors}
 */
export function calculateBomExplosion(demandFgRows, bomEdgesRows, options = {}) {
  // Directly call Domain layer function
  return domainExplodeBOM(demandFgRows, bomEdgesRows, options);
}

/**
 * Execute BOM Explosion and write to database
 * 
 * This function is responsible for:
 * 1. Creating batch record
 * 2. Calling Domain layer calculation
 * 3. Writing to database
 * 4. Updating batch status
 * 
 * @param {string} userId - User ID
 * @param {string} batchId - Batch ID (optional, auto-created if not provided)
 * @param {Array} demandFgRows - FG demand array
 * @param {Array} bomEdgesRows - BOM edges array
 * @param {Object} options - Options
 * @param {string} options.filename - Filename (for logging)
 * @param {Object} options.metadata - Additional metadata
 * @returns {Promise<Object>} {success, componentDemandCount, traceCount, errors, batchId}
 */
export async function executeBomExplosionLegacy(userId, batchId, demandFgRows, bomEdgesRows, options = {}) {
  const { componentDemandService, componentDemandTraceService, forecastRunsService } = await import('./supabaseClient');
  const { importBatchesService } = await import('./importHistoryService');

  const filename = options.filename || 'BOM Explosion Calculation';
  const metadata = options.metadata || {};

  // Collect input batch_ids (for forecast_runs traceability)
  const demandBatchIds = [...new Set((demandFgRows || []).map(r => r.batch_id).filter(Boolean))];
  const bomBatchIds = [...new Set((bomEdgesRows || []).map(r => r.batch_id).filter(Boolean))];
  const _inputBatchIds = [...demandBatchIds, ...bomBatchIds];

  // Step 1: Create forecast_run (versioned: one run per execution)
  let forecastRunId = null;
  try {
    const runRow = await forecastRunsService.createRun(userId, {
      scenarioName: options.scenarioName || 'baseline',
      parameters: {
        time_buckets: metadata.time_buckets,
        plant_id: metadata.plant_id,
        // Run-level traceability for P0-2
        demand_source: options.demandSource || 'uploaded',
        input_demand_forecast_run_id: options.inputDemandForecastRunId || null,
        ...(options.parameters || {})
      },
      kind: 'bom_explosion'
    });
    forecastRunId = runRow.id;
    console.log('Created forecast_run:', forecastRunId);
  } catch (error) {
    console.error('Failed to create forecast_run (continuing without run_id):', error);
  }

  // Step 2: If batchId not provided, create new import_batch record
  let actualBatchId = batchId;
  let batchRecord = null;

  if (!actualBatchId) {
    try {
      batchRecord = await importBatchesService.createBatch(userId, {
        uploadType: 'bom_explosion',
        filename: filename,
        targetTable: 'bom_explosion',
        totalRows: demandFgRows.length,
        metadata: {
          ...metadata,
          fg_demands_count: demandFgRows.length,
          bom_edges_count: bomEdgesRows.length,
          started_at: new Date().toISOString(),
          forecast_run_id: forecastRunId
        }
      });
      actualBatchId = batchRecord.id;
      console.log('Created batch record:', actualBatchId);
    } catch (error) {
      console.error('Failed to create batch record:', error);
    }
  }

  // Step 3: Execute calculation (call Domain layer)
  const result = calculateBomExplosion(demandFgRows, bomEdgesRows, {
    ...options,
    userId,
    batchId: actualBatchId
  });
  
  if (result.errors.length > 0) {
    console.warn('BOM Explosion calculation had errors:', result.errors);
  }

  // Step 4: Write component_demand (with forecast_run_id)
  let componentDemandCount = 0;
  let componentDemandIdMap = new Map();
  const rowsWithRunId = (result.componentDemandRows || []).map(r => ({
    ...r,
    batch_id: actualBatchId,
    forecast_run_id: forecastRunId
  }));

  if (rowsWithRunId.length > 0) {
    try {
      const insertResult = await componentDemandService.upsertComponentDemand(rowsWithRunId);
      componentDemandCount = insertResult.count || rowsWithRunId.length;
      
      // Build material_code + plant_id + time_bucket -> id mapping
      if (insertResult.data && insertResult.data.length > 0) {
        for (const cd of insertResult.data) {
          const key = getAggregationKey(cd.plant_id, cd.time_bucket, cd.material_code);
          componentDemandIdMap.set(key, cd.id);
        }
      } else {
        // If no data returned, need to query
        const componentDemands = await componentDemandService.getComponentDemands(userId, {
          limit: 10000
        });
        for (const cd of componentDemands) {
          const key = getAggregationKey(cd.plant_id, cd.time_bucket, cd.material_code);
          componentDemandIdMap.set(key, cd.id);
        }
      }
    } catch (error) {
      console.error('Failed to write component_demand:', error);
      result.errors.push({
        type: 'DATABASE_ERROR',
        message: 'Failed to write component_demand',
        error: error.message
      });
    }
  }
  
  // Step 5: Write component_demand_trace (with forecast_run_id)
  let traceCount = 0;
  if (result.traceRows.length > 0 && componentDemandIdMap.size > 0) {
    try {
      const tracePayload = [];
      const missingMappings = [];

      for (const trace of result.traceRows) {
        const key = getAggregationKey(trace.plant_id, trace.time_bucket, trace.component_material_code);
        const componentDemandId = componentDemandIdMap.get(key);

        if (componentDemandId) {
          const pathArray = trace.path || [];

          tracePayload.push({
            user_id: userId,
            batch_id: actualBatchId,
            forecast_run_id: forecastRunId,
            component_demand_id: componentDemandId,
            fg_demand_id: trace.fg_demand_id || null,
            bom_edge_id: trace.bom_edge_id || null,
            qty_multiplier: trace.qty_multiplier || (trace.component_qty / trace.fg_qty),
            bom_level: trace.bom_level || null,
            // Additional trace info stored in trace_meta (JSONB)
            trace_meta: {
              path: pathArray, // JSON array
              fg_material_code: trace.fg_material_code || null,
              component_material_code: trace.component_material_code || null,
              plant_id: trace.plant_id || null,
              time_bucket: trace.time_bucket || null,
              fg_qty: trace.fg_qty || null,
              component_qty: trace.component_qty || null,
              source_type: trace.source_type || null,
              source_id: trace.source_id || null,
              source_fg_demand_id: trace.fg_demand_id || null // P0-3: explicit traceability
            }
          });
        } else {
          missingMappings.push({
            component_material_code: trace.component_material_code,
            plant_id: trace.plant_id,
            time_bucket: trace.time_bucket,
            aggregation_key: key
          });
        }
      }
      
      // Log warnings for missing mappings
      if (missingMappings.length > 0) {
        const errorMsg = `Missing ${missingMappings.length} component_demand_id mappings`;
        console.error(errorMsg, {
          sample: missingMappings.slice(0, 5),
          total: missingMappings.length
        });
        result.errors.push({
          type: 'MAPPING_ERROR',
          message: errorMsg,
          details: {
            count: missingMappings.length,
            sample: missingMappings.slice(0, 5)
          }
        });
      }
      
      if (tracePayload.length > 0) {
        const insertResult = await componentDemandTraceService.insertComponentDemandTrace(tracePayload);
        traceCount = insertResult.count || tracePayload.length;
      }
    } catch (error) {
      const errorDetails = {
        message: error.message,
        stack: error.stack,
        name: error.name
      };
      console.error('Failed to write component_demand_trace:', errorDetails);
      result.errors.push({
        type: 'DATABASE_ERROR',
        message: 'Failed to write component_demand_trace',
        error: errorDetails
      });
    }
  }
  
  // Step 6: Update batch status to completed
  if (actualBatchId && batchRecord) {
    try {
      await importBatchesService.updateBatch(actualBatchId, {
        status: 'completed',
        successRows: componentDemandCount,
        errorRows: result.errors.length,
        metadata: {
          ...metadata,
          fg_demands_count: demandFgRows.length,
          bom_edges_count: bomEdgesRows.length,
          component_demand_count: componentDemandCount,
          component_demand_trace_count: traceCount,
          errors_count: result.errors.length,
          completed_at: new Date().toISOString()
        }
      });
      console.log('Updated batch status to completed');
    } catch (error) {
      console.error('Failed to update batch status:', error);
    }
  }
  
  return {
    success: result.errors.length === 0,
    componentDemandCount,
    traceCount,
    errors: result.errors,
    batchId: actualBatchId,
    forecastRunId
  };
}
