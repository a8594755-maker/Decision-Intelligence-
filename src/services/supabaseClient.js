import { supabase } from './supabase/core.js';
import { sendAgentLog } from '../utils/sendAgentLog';
export {
  SUPABASE_JSON_HEADERS,
  RPC_JSON_OPTIONS,
  isSupabaseConfigured,
  markTableUnavailable,
  supabase,
} from './supabase/core.js';
export { userFilesService } from './supabase/storageService.js';
export { suppliersService, materialsService } from './supabase/masterDataService.js';
export { goodsReceiptsService, priceHistoryService } from './supabase/transactionsService.js';
export {
  conversationsService,
  authService,
  uploadMappingsService,
} from './supabase/appDataService.js';

// Legacy facade: preserve the existing import path while moving the client
// bootstrap and foundational data services into domain-focused modules.

/**
 * BOM Edges Operations
 */
export const bomEdgesService = {
  // Batch insert BOM edges
  async batchInsert(userId, bomEdges, batchId = null) {
    if (!bomEdges || bomEdges.length === 0) {
      return { success: true, count: 0 };
    }

    // ✅ LOG 1: Print table / rows count / batchId type
    console.info("[ingest] table=bom_edges, rows=", bomEdges.length, ", batchId type=", typeof batchId, ", batchId value=", JSON.stringify(batchId).slice(0, 200));
    sendAgentLog({location:'supabaseClient.js:bomEdgesService.batchInsert',message:'[ingest] LOG1 table/uploadType/rows/batchId',data:{tableName:'bom_edges',uploadType:'bom_edge',rows:bomEdges.length,batchIdType:typeof batchId,batchIdPreview:JSON.stringify(batchId).slice(0,200)},sessionId:'debug-session',hypothesisId:'A'});

    const payload = bomEdges.map(edge => ({
      user_id: userId,
      batch_id: batchId,
      parent_material: edge.parent_material,
      child_material: edge.child_material,
      qty_per: edge.qty_per,
      uom: edge.uom || 'pcs',
      plant_id: edge.plant_id || null,
      bom_version: edge.bom_version || null,
      valid_from: edge.valid_from || null,
      valid_to: edge.valid_to || null,
      scrap_rate: edge.scrap_rate || null,
      yield_rate: edge.yield_rate || null,
      alt_group: edge.alt_group || null,
      priority: edge.priority || null,
      mix_ratio: edge.mix_ratio || null,
      ecn_number: edge.ecn_number || null,
      ecn_effective_date: edge.ecn_effective_date || null,
      routing_id: edge.routing_id || null,
      notes: edge.notes || null
    }));

    // ✅ LOG 2: Print first row keys + uuid field value types
    const sample = payload[0];
    const uuidFieldTypes = {};
    if (sample) {
      console.info("[ingest] sample keys=", Object.keys(sample));
      const uuidFields = ['user_id', 'batch_id', 'batchId', 'sheet_run_id', 'sheetRunId', 'ingest_key', 'ingestKey'];
      uuidFields.forEach(field => {
        if (Object.prototype.hasOwnProperty.call(sample, field)) {
          const value = sample[field];
          const valueType = typeof value;
          const valuePreview = JSON.stringify(value).slice(0, 200);
          console.info(`[ingest] ${field}: type=${valueType}, value=${valuePreview}`);
          uuidFieldTypes[field] = { type: valueType, preview: valuePreview };
          if (valueType === 'object' && value !== null) {
            console.error(`❌ [ingest] CRITICAL: ${field} is object, not uuid string! This will cause uuid cast error!`);
          }
        }
      });
    }
    sendAgentLog({location:'supabaseClient.js:bomEdgesService.batchInsert',message:'[ingest] LOG2 sample keys + uuid field types',data:{sampleKeys:sample?Object.keys(sample):null,uuidFieldTypes},sessionId:'debug-session',hypothesisId:'B'});

    // ✅ LOG 3: Print request body top-level structure
    console.info("[ingest] payload is array:", Array.isArray(payload), ", length=", payload.length);
    console.info("[ingest] payload preview (first 800 chars):", JSON.stringify(payload).slice(0, 800));
    sendAgentLog({location:'supabaseClient.js:bomEdgesService.batchInsert',message:'[ingest] LOG3 request body top-level',data:{bodyIsArray:Array.isArray(payload),bodyLength:payload.length,bodyTopLevelKeys:Array.isArray(payload)?null:Object.keys(payload),bodyPreview:JSON.stringify(payload).slice(0,800)},sessionId:'debug-session',hypothesisId:'C'});

    const { data, error } = await supabase
      .from('bom_edges')
      .insert(payload)
      .select();

    if (error) throw error;
    return { success: true, count: data.length, data };
  },

  // Get BOM edges
  async getBomEdges(userId, options = {}) {
    const { parentMaterial, childMaterial, plantId, limit = 100, offset = 0 } = options;

    let query = supabase
      .from('bom_edges')
      .select('*')
      .eq('user_id', userId)
      .order('parent_material', { ascending: true })
      .range(offset, offset + limit - 1);

    if (parentMaterial) {
      query = query.eq('parent_material', parentMaterial);
    }

    if (childMaterial) {
      query = query.eq('child_material', childMaterial);
    }

    if (plantId) {
      query = query.eq('plant_id', plantId);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  // Get BOM edges (for BOM Explosion calculation)
  // Supports filtering by plantId and timeBuckets (considering validity)
  async fetchBomEdges(userId, plantId = null, _timeBuckets = []) {
    let query = supabase
      .from('bom_edges')
      .select('*')
      .eq('user_id', userId)
      .order('parent_material', { ascending: true });

    // Plant filter: match plant_id or NULL (universal BOM)
    if (plantId) {
      query = query.or(`plant_id.eq.${plantId},plant_id.is.null`);
    }

    // Validity filter: if timeBuckets provided, need to check valid_from/valid_to
    // Note: only basic conditions filtered here, actual validity check done in calculation logic
    // Because time_bucket needs to be converted to date before comparison

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }
};

/**
 * Demand FG Operations
 */
export const demandFgService = {
  // Batch insert FG demands
  async batchInsert(userId, demands, batchId = null) {
    if (!demands || demands.length === 0) {
      return { success: true, count: 0 };
    }

    const payload = demands.map(demand => ({
      user_id: userId,
      batch_id: batchId,
      material_code: demand.material_code,
      plant_id: demand.plant_id,
      time_bucket: demand.time_bucket,
      week_bucket: demand.week_bucket || null,
      date: demand.date || null,
      demand_qty: demand.demand_qty,
      uom: demand.uom || 'pcs',
      source_type: demand.source_type || null,
      source_id: demand.source_id || null,
      customer_id: demand.customer_id || null,
      project_id: demand.project_id || null,
      priority: demand.priority || null,
      status: demand.status || 'confirmed',
      notes: demand.notes || null
    }));

    const { data, error } = await supabase
      .from('demand_fg')
      .insert(payload)
      .select();

    if (error) throw error;
    return { success: true, count: data.length, data };
  },

  // Get FG demands
  async getDemands(userId, options = {}) {
    const { materialCode, plantId, startTimeBucket, endTimeBucket, limit = 100, offset = 0 } = options;

    let query = supabase
      .from('demand_fg')
      .select('*')
      .eq('user_id', userId)
      .order('time_bucket', { ascending: true })
      .range(offset, offset + limit - 1);

    if (materialCode) {
      query = query.eq('material_code', materialCode);
    }

    if (plantId) {
      query = query.eq('plant_id', plantId);
    }

    if (startTimeBucket) {
      query = query.gte('time_bucket', startTimeBucket);
    }

    if (endTimeBucket) {
      query = query.lte('time_bucket', endTimeBucket);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  // Get FG demands (for BOM Explosion calculation)
  // Supports filtering by plantId and timeBuckets
  async fetchDemandFg(userId, plantId = null, timeBuckets = []) {
    let query = supabase
      .from('demand_fg')
      .select('*')
      .eq('user_id', userId)
      .order('time_bucket', { ascending: true });

    // Plant filter
    if (plantId) {
      query = query.eq('plant_id', plantId);
    }

    // Time bucket filter: if timeBuckets array provided, only get demands for these buckets
    if (timeBuckets && timeBuckets.length > 0) {
      query = query.in('time_bucket', timeBuckets);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }
};

/**
 * Demand Forecast Service - Store forecast results with P10/P50/P90 confidence intervals
 */
export const demandForecastService = {
  // Batch insert demand forecast results
  async batchInsert(userId, forecasts) {
    if (!forecasts || forecasts.length === 0) {
      return { success: true, count: 0 };
    }

    const payload = forecasts.map(forecast => ({
      user_id: userId,
      forecast_run_id: forecast.forecast_run_id,
      material_code: forecast.material_code,
      plant_id: forecast.plant_id,
      time_bucket: forecast.time_bucket,
      p10: forecast.p10 ?? null,
      p50: forecast.p50,
      p90: forecast.p90 ?? null,
      model_version: forecast.model_version,
      train_window_buckets: forecast.train_window_buckets ?? null,
      metrics: forecast.metrics || {}
    }));

    const { data, error } = await supabase
      .from('demand_forecast')
      .insert(payload)
      .select();

    if (error) throw error;
    return { success: true, count: data.length, data };
  },

  // Get demand forecasts by run ID
  async getForecastsByRun(userId, forecastRunId, options = {}) {
    const { materialCode, plantId, limit = 1000, offset = 0 } = options;

    let query = supabase
      .from('demand_forecast')
      .select('*')
      .eq('user_id', userId)
      .eq('forecast_run_id', forecastRunId)
      .order('material_code', { ascending: true })
      .order('time_bucket', { ascending: true })
      .range(offset, offset + limit - 1);

    if (materialCode) {
      query = query.eq('material_code', materialCode);
    }

    if (plantId) {
      query = query.eq('plant_id', plantId);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  // Get unique material codes for a forecast run
  async getMaterialsByRun(userId, forecastRunId) {
    const { data, error } = await supabase
      .from('demand_forecast')
      .select('material_code')
      .eq('user_id', userId)
      .eq('forecast_run_id', forecastRunId);

    if (error) throw error;
    return [...new Set((data || []).map(d => d.material_code))];
  },

  // Get historical demand_fg data for training the forecast model
  async getHistoricalDemandFg(userId, plantId, materialCode, endTimeBucket, windowBuckets) {
    // Get historical data up to endTimeBucket, limited to windowBuckets
    let query = supabase
      .from('demand_fg')
      .select('time_bucket, demand_qty, material_code, plant_id')
      .eq('user_id', userId)
      .order('time_bucket', { ascending: false })
      .limit(windowBuckets);

    // Only filter by material_code if explicitly provided
    if (materialCode) {
      query = query.eq('material_code', materialCode);
    }

    if (plantId) {
      query = query.eq('plant_id', plantId);
    }

    // Filter to get only buckets before or equal to endTimeBucket
    if (endTimeBucket) {
      query = query.lte('time_bucket', endTimeBucket);
    }

    const { data, error } = await query;
    if (error) throw error;
    
    // Return in ascending order (oldest first)
    return (data || []).reverse();
  },

  // Delete forecasts by run ID (for cleanup/re-runs)
  async deleteForecastsByRun(userId, forecastRunId) {
    const { error } = await supabase
      .from('demand_forecast')
      .delete()
      .eq('user_id', userId)
      .eq('forecast_run_id', forecastRunId);

    if (error) throw error;
    return { success: true };
  }
};

/**
 * Forecast Runs - One record per BOM Explosion run, for traceability
 */
export const forecastRunsService = {
  async createRun(userId, options = {}) {
    const {
      scenarioName = 'baseline',
      parameters = {},
      kind = 'bom_explosion'
    } = options;
    const { data, error } = await supabase
      .from('forecast_runs')
      .insert({
        user_id: userId,
        scenario_name: scenarioName,
        parameters: parameters,
        kind: kind,
        status: 'pending'
      })
      .select('id, created_at, scenario_name')
      .single();
    if (error) throw error;
    return data;
  },

  async getRun(runId) {
    const { data, error } = await supabase
      .from('forecast_runs')
      .select('*')
      .eq('id', runId)
      .single();
    if (error) throw error;
    return data;
  },

  async updateRun(runId, updates) {
    const { data, error } = await supabase
      .from('forecast_runs')
      .update(updates)
      .eq('id', runId)
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  async listRuns(userId, options = {}) {
    const { limit = 50 } = options;
    let query = supabase
      .from('forecast_runs')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }
};

/**
 * Component Demand Operations
 */
export const componentDemandService = {
  // Get Component demands
  async getComponentDemands(userId, options = {}) {
    const { materialCode, plantId, timeBucket, limit = 100, offset = 0 } = options;

    let query = supabase
      .from('component_demand')
      .select('*')
      .eq('user_id', userId)
      .order('time_bucket', { ascending: true })
      .range(offset, offset + limit - 1);

    if (materialCode) {
      query = query.eq('material_code', materialCode);
    }

    if (plantId) {
      query = query.eq('plant_id', plantId);
    }

    if (timeBucket) {
      query = query.eq('time_bucket', timeBucket);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  // Batch Upsert Component demands (for BOM Explosion calculation results)
  // Uses material_code + plant_id + time_bucket + user_id as unique key for upsert
  // Note: if recalculating same batch, should call deleteComponentOutputsByBatch first to clear old data
  async upsertComponentDemand(rows) {
    if (!rows || rows.length === 0) {
      return { success: true, count: 0 };
    }

    try {
      // Prepare upsert data - only include fields that exist in DB schema
      const payload = rows.map((row, index) => {
        // Validate required fields
        if (!row.user_id || !row.material_code || !row.plant_id || !row.time_bucket) {
          throw new Error(`Row ${index}: Missing required fields (user_id, material_code, plant_id, or time_bucket)`);
        }
        if (row.demand_qty === undefined || row.demand_qty === null) {
          throw new Error(`Row ${index}: Missing demand_qty`);
        }

        // Build payload - with forecast_run_id (versioned)
        const record = {
          user_id: row.user_id,
          batch_id: row.batch_id || null,
          forecast_run_id: row.forecast_run_id ?? null,
          material_code: row.material_code,
          plant_id: row.plant_id,
          time_bucket: row.time_bucket,
          demand_qty: row.demand_qty,
          uom: row.uom || 'pcs',
          source_fg_material: null,
          source_fg_demand_id: null,
          bom_level: null,
          notes: row.notes || null
        };

        if (row.id) {
          record.id = row.id;
        }

        return record;
      });

      // Unique constraint: (user_id, forecast_run_id, material_code, plant_id, time_bucket)
      const { data, error } = await supabase
        .from('component_demand')
        .upsert(payload, {
          onConflict: 'user_id,forecast_run_id,material_code,plant_id,time_bucket',
          ignoreDuplicates: false
        })
        .select();

      if (error) {
        console.warn('Upsert failed, attempting fallback strategy:', {
          error: error.message,
          code: error.code,
          hint: error.hint
        });

        // Fallback: delete then insert (by user_id + forecast_run_id + dimensions)
        const userId = rows[0].user_id;
        const forecastRunId = rows[0].forecast_run_id ?? null;
        const materialCodes = [...new Set(rows.map(r => r.material_code))];
        const plantIds = [...new Set(rows.map(r => r.plant_id))];
        const timeBuckets = [...new Set(rows.map(r => r.time_bucket))];

        let existingQuery = supabase
          .from('component_demand')
          .select('id')
          .eq('user_id', userId)
          .in('material_code', materialCodes)
          .in('plant_id', plantIds)
          .in('time_bucket', timeBuckets);
        if (forecastRunId) {
          existingQuery = existingQuery.eq('forecast_run_id', forecastRunId);
        } else {
          existingQuery = existingQuery.is('forecast_run_id', null);
        }
        const { data: existingData, error: queryError } = await existingQuery;

        if (queryError) {
          const errorDetails = {
            message: queryError.message,
            code: queryError.code,
            details: queryError.details
          };
          console.error('Query existing records failed:', errorDetails);
          throw new Error(`Query failed: ${queryError.message}`);
        }

        // If existing records found, delete first
        if (existingData && existingData.length > 0) {
          const existingIds = existingData.map(r => r.id);
          const { error: deleteError } = await supabase
            .from('component_demand')
            .delete()
            .in('id', existingIds);

          if (deleteError) {
            const errorDetails = {
              message: deleteError.message,
              code: deleteError.code,
              details: deleteError.details,
              deletedIds: existingIds.slice(0, 5)
            };
            console.error('Delete existing records failed:', errorDetails);
            throw new Error(`Delete failed: ${deleteError.message}`);
          }
        }

        // Insert new records
        const { data: insertData, error: insertError } = await supabase
          .from('component_demand')
          .insert(payload)
          .select();

        if (insertError) {
          const errorDetails = {
            message: insertError.message,
            code: insertError.code,
            details: insertError.details,
            hint: insertError.hint,
            sample_payload: payload.slice(0, 2)
          };
          console.error('Insert new records failed:', errorDetails);
          throw new Error(`Insert failed: ${insertError.message} (code: ${insertError.code})`);
        }

        return { success: true, count: insertData.length, data: insertData };
      }

      return { success: true, count: data.length, data };
    } catch (error) {
      // Catch and re-throw with clearer error
      if (error.message.includes('Missing required fields') || error.message.includes('Missing demand_qty')) {
        throw error; // Directly throw validation error
      }
      
      const enhancedError = new Error(
        `upsertComponentDemand error: ${error.message}`
      );
      enhancedError.originalError = error;
      enhancedError.rowCount = rows.length;
      throw enhancedError;
    }
  },

  // Delete Component demands by batch_id
  async deleteByBatch(batchId) {
    if (!batchId) {
      return { success: true, count: 0 };
    }

    const { data, error } = await supabase
      .from('component_demand')
      .delete()
      .eq('batch_id', batchId)
      .select();

    if (error) throw error;
    return { success: true, count: data?.length || 0 };
  },

  // Delete Component outputs (including component_demand and component_demand_trace)
  // Used to clear old data when recalculating a batch
  async deleteComponentOutputsByBatch(batchId) {
    if (!batchId) {
      return { success: true, componentDemandCount: 0, traceCount: 0 };
    }

    // Delete trace records first (due to foreign key relationship)
    const { data: traceData, error: traceError } = await supabase
      .from('component_demand_trace')
      .delete()
      .eq('batch_id', batchId)
      .select();

    if (traceError) throw traceError;

    // Then delete Component demands
    const { data: demandData, error: demandError } = await supabase
      .from('component_demand')
      .delete()
      .eq('batch_id', batchId)
      .select();

    if (demandError) throw demandError;

    return {
      success: true,
      componentDemandCount: demandData?.length || 0,
      traceCount: traceData?.length || 0
    };
  },

  /**
   * Get component_demand for a specific forecast run (for Risk / Inventory Projection)
   * @param {string} userId
   * @param {string} forecastRunId
   * @param {{ timeBuckets?: string[], plantId?: string }} [options]
   */
  async getComponentDemandsByForecastRun(userId, forecastRunId, options = {}) {
    if (!userId || !forecastRunId) return [];
    let query = supabase
      .from('component_demand')
      .select('material_code, plant_id, time_bucket, demand_qty')
      .eq('user_id', userId)
      .eq('forecast_run_id', forecastRunId)
      .order('time_bucket', { ascending: true });
    const { timeBuckets, plantId } = options;
    if (plantId) query = query.eq('plant_id', plantId);
    if (Array.isArray(timeBuckets) && timeBuckets.length > 0) {
      query = query.in('time_bucket', timeBuckets);
    }
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  // Get Component demands by batch_id (with filtering and pagination)
  async getComponentDemandsByBatch(userId, batchId, options = {}) {
    const { filters = {}, limit = 100, offset = 0 } = options;

    let query = supabase
      .from('component_demand')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .eq('batch_id', batchId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    // Apply filters
    if (filters.material_code) {
      query = query.ilike('material_code', `%${filters.material_code}%`);
    }
    if (filters.plant_id) {
      query = query.ilike('plant_id', `%${filters.plant_id}%`);
    }
    if (filters.time_bucket) {
      query = query.ilike('time_bucket', `%${filters.time_bucket}%`);
    }

    const { data, error, count } = await query;
    
    if (error) throw error;
    
    return {
      data: data || [],
      count: count || 0
    };
  }
};

/**
 * Component Demand Trace Operations
 */
export const componentDemandTraceService = {
  // Get trace information
  async getTrace(userId, componentMaterial, timeBucket) {
    let query = supabase
      .from('component_demand_trace')
      .select(`
        *,
        component_demand:component_demand_id(*),
        fg_demand:fg_demand_id(*),
        bom_edge:bom_edge_id(*)
      `)
      .eq('user_id', userId);

    if (componentMaterial) {
      // Need to query through component_demand table relationship
      query = query.eq('component_demand.material_code', componentMaterial);
    }

    if (timeBucket) {
      // Need to query through component_demand table relationship
      query = query.eq('component_demand.time_bucket', timeBucket);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  // Batch insert Component demand trace records
  // Note: per user requirements, trace uses fg_material_code/component_material_code/path_json
  // But schema uses fg_demand_id/component_demand_id/bom_edge_id
  // Implemented per schema here, but can add extra fields (if schema supports)
  async insertComponentDemandTrace(rows) {
    if (!rows || rows.length === 0) {
      return { success: true, count: 0 };
    }

    try {
      // Prepare insert data - only include fields that exist in DB schema
      const payload = rows.map((row, index) => {
        // Validate required fields
        if (!row.user_id || !row.component_demand_id || !row.fg_demand_id) {
          throw new Error(`Row ${index}: Missing required fields (user_id, component_demand_id, or fg_demand_id)`);
        }

        return {
          user_id: row.user_id,
          batch_id: row.batch_id || null,
          forecast_run_id: row.forecast_run_id ?? null,
          component_demand_id: row.component_demand_id,
          fg_demand_id: row.fg_demand_id,
          bom_edge_id: row.bom_edge_id || null,
          qty_multiplier: row.qty_multiplier || null,
          bom_level: row.bom_level || null,
          trace_meta: row.trace_meta || {}
        };
      });

      const { data, error } = await supabase
        .from('component_demand_trace')
        .insert(payload)
        .select();

      if (error) {
        // Detailed error message
        const errorDetails = {
          message: error.message,
          code: error.code,
          details: error.details,
          hint: error.hint,
          sample_payload: payload.slice(0, 2) // Show first 2 payload samples
        };
        console.error('insertComponentDemandTrace failed:', errorDetails);
        throw new Error(`Database insert failed: ${error.message} (code: ${error.code})`);
      }

      return { success: true, count: data.length, data };
    } catch (error) {
      // Catch and re-throw with clearer error
      if (error.message.includes('Missing required fields')) {
        throw error; // Directly throw validation error
      }
      
      const enhancedError = new Error(
        `insertComponentDemandTrace error: ${error.message}`
      );
      enhancedError.originalError = error;
      enhancedError.rowCount = rows.length;
      throw enhancedError;
    }
  },

  // Delete trace records by batch_id
  async deleteByBatch(batchId) {
    if (!batchId) {
      return { success: true, count: 0 };
    }

    const { data, error } = await supabase
      .from('component_demand_trace')
      .delete()
      .eq('batch_id', batchId)
      .select();

    if (error) throw error;
    return { success: true, count: data?.length || 0 };
  },

  // Get trace records by batch_id (with filtering and pagination)
  async getTracesByBatch(userId, batchId, options = {}) {
    const { filters = {}, limit = 100, offset = 0 } = options;

    let query = supabase
      .from('component_demand_trace')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .eq('batch_id', batchId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    // Apply filters (using trace_meta JSONB column)
    if (filters.bom_level) {
      query = query.eq('bom_level', parseInt(filters.bom_level));
    }
    if (filters.fg_material_code) {
      // Filter by trace_meta->>'fg_material_code'
      query = query.ilike('trace_meta->>fg_material_code', `%${filters.fg_material_code}%`);
    }
    if (filters.component_material_code) {
      // Filter by trace_meta->>'component_material_code'
      query = query.ilike('trace_meta->>component_material_code', `%${filters.component_material_code}%`);
    }
    if (filters.component_demand_id) {
      query = query.eq('component_demand_id', filters.component_demand_id);
    }
    if (filters.fg_demand_id) {
      query = query.eq('fg_demand_id', filters.fg_demand_id);
    }

    const { data, error, count } = await query;
    
    if (error) throw error;
    
    return {
      data: data || [],
      count: count || 0
    };
  }
};

/**
 * PO Open Lines Operations
 * Manage purchase order open line items
 */
export const poOpenLinesService = {
  /**
   * Batch insert PO Open Lines
   * @param {string} userId - User ID
   * @param {Array} rows - PO Open Lines data array
   * @param {string} batchId - Batch ID (optional)
   * @returns {Promise<Object>} { success, count, data }
   */
  async batchInsert(userId, rows, batchId = null) {
    if (!rows || rows.length === 0) {
      return { success: true, count: 0 };
    }

    const payload = rows.map(row => ({
      user_id: userId,
      batch_id: batchId,
      po_number: row.po_number,
      po_line: row.po_line,
      material_code: row.material_code,
      plant_id: row.plant_id,
      time_bucket: row.time_bucket,
      open_qty: row.open_qty,
      uom: row.uom || 'pcs',
      supplier_id: row.supplier_id || null,
      status: row.status || 'open',
      notes: row.notes || null
    }));

    // Use upsert to avoid duplicates (based on UNIQUE constraint)
    const { data, error } = await supabase
      .from('po_open_lines')
      .upsert(payload, {
        onConflict: 'user_id,po_number,po_line,time_bucket',
        ignoreDuplicates: false
      })
      .select();

    if (error) throw error;
    return { success: true, count: data.length, data };
  },

  /**
   * Query PO Open Lines by conditions
   * @param {string} userId - User ID
   * @param {Object} options - Query options
   * @param {string} options.plantId - Plant ID (null = all plants)
   * @param {Array<string>} options.timeBuckets - Time bucket array (null = all time)
   * @param {string} options.materialCode - Material code (optional)
   * @param {string} options.poNumber - PO number (optional)
   * @param {string} options.supplierId - Supplier ID (optional)
   * @param {string} options.status - Status (optional)
   * @param {number} options.limit - Row limit (default 1000)
   * @param {number} options.offset - Offset (default 0)
   * @returns {Promise<Array>} PO Open Lines data array
   */
  async fetchByFilters(userId, options = {}) {
    const { 
      plantId = null, 
      timeBuckets = null, 
      materialCode = null,
      poNumber = null,
      supplierId = null,
      status = null,
      limit = 1000, 
      offset = 0 
    } = options;

    let query = supabase
      .from('po_open_lines')
      .select('*')
      .eq('user_id', userId)
      .order('time_bucket', { ascending: true })
      .range(offset, offset + limit - 1);

    // Plant filter (null = all plants)
    if (plantId) {
      query = query.eq('plant_id', plantId);
    }

    // Time bucket filter (null = all time)
    if (timeBuckets && timeBuckets.length > 0) {
      query = query.in('time_bucket', timeBuckets);
    }

    // Material code filter
    if (materialCode) {
      query = query.eq('material_code', materialCode);
    }

    // PO number filter
    if (poNumber) {
      query = query.eq('po_number', poNumber);
    }

    // Supplier filter
    if (supplierId) {
      query = query.eq('supplier_id', supplierId);
    }

    // Status filter
    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  /**
   * Delete PO Open Lines by batch ID (supports undo)
   * @param {string} batchId - Batch ID
   * @returns {Promise<Object>} { success, count }
   */
  async deleteByBatch(batchId) {
    if (!batchId) {
      return { success: true, count: 0 };
    }

    const { data, error } = await supabase
      .from('po_open_lines')
      .delete()
      .eq('batch_id', batchId)
      .select();

    if (error) throw error;
    return { success: true, count: data?.length || 0 };
  },

  /**
   * Get inbound data for specified time_buckets (for Inventory Projection)
   * @param {string} userId - User ID
   * @param {string[]} timeBuckets - Time bucket array
   * @param {string|null} plantId - Plant ID (null = all plants)
   * @returns {Promise<Array<{ material_code: string, plant_id: string, time_bucket: string, open_qty: number }>>}
   */
  async getInboundByBuckets(userId, timeBuckets, plantId = null) {
    if (!userId || !Array.isArray(timeBuckets) || timeBuckets.length === 0) {
      return [];
    }

    const pickInboundQty = row => {
      const qty = Number(
        row.open_qty ??
        row.qty_open ??
        row.inbound_qty ??
        row.order_qty ??
        row.qty ??
        row.quantity ??
        0
      );
      return Number.isFinite(qty) ? qty : 0;
    };

    let query = supabase
      .from('po_open_lines')
      .select('*')
      .eq('user_id', userId)
      .in('time_bucket', timeBuckets)
      .order('time_bucket', { ascending: true });

    if (plantId) {
      query = query.eq('plant_id', plantId);
    }

    const { data, error } = await query;
    if (error) throw error;
    return (data || []).map(row => ({
      material_code: row.material_code ?? row.item ?? null,
      plant_id: row.plant_id ?? row.factory ?? null,
      time_bucket: row.time_bucket ?? row.timeBucket ?? row.bucket ?? null,
      open_qty: pickInboundQty(row)
    }));
  },

  /**
   * Get PO Open Lines (general query method)
   * @param {string} userId - User ID
   * @param {Object} options - Query options
   * @returns {Promise<Array>} PO Open Lines data array
   */
  async getPoOpenLines(userId, options = {}) {
    const { 
      plantId, 
      materialCode, 
      startTimeBucket, 
      endTimeBucket, 
      limit = 100, 
      offset = 0 
    } = options;

    let query = supabase
      .from('po_open_lines')
      .select('*')
      .eq('user_id', userId)
      .order('time_bucket', { ascending: true })
      .range(offset, offset + limit - 1);

    if (plantId) {
      query = query.eq('plant_id', plantId);
    }

    if (materialCode) {
      query = query.eq('material_code', materialCode);
    }

    if (startTimeBucket) {
      query = query.gte('time_bucket', startTimeBucket);
    }

    if (endTimeBucket) {
      query = query.lte('time_bucket', endTimeBucket);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }
};

/**
 * Inventory Snapshots Operations
 * Manage inventory snapshot data
 */
export const inventorySnapshotsService = {
  /**
   * Batch insert Inventory Snapshots
   * @param {string} userId - User ID
   * @param {Array} rows - Inventory Snapshots data array
   * @param {string} batchId - Batch ID (optional)
   * @returns {Promise<Object>} { success, count, data }
   */
  async batchInsert(userId, rows, batchId = null) {
    if (!rows || rows.length === 0) {
      return { success: true, count: 0 };
    }

    const payload = rows.map(row => ({
      user_id: userId,
      batch_id: batchId,
      material_code: row.material_code,
      plant_id: row.plant_id,
      snapshot_date: row.snapshot_date,
      onhand_qty: row.onhand_qty,
      allocated_qty: row.allocated_qty !== null && row.allocated_qty !== undefined ? row.allocated_qty : 0,
      safety_stock: row.safety_stock !== null && row.safety_stock !== undefined ? row.safety_stock : 0,
      uom: row.uom || 'pcs',
      notes: row.notes || null
    }));

    // Use upsert to avoid duplicates (based on UNIQUE constraint)
    const { data, error } = await supabase
      .from('inventory_snapshots')
      .upsert(payload, {
        onConflict: 'user_id,material_code,plant_id,snapshot_date',
        ignoreDuplicates: false
      })
      .select();

    if (error) throw error;
    return { success: true, count: data.length, data };
  },

  /**
   * Query Inventory Snapshots by conditions
   * @param {string} userId - User ID
   * @param {Object} options - Query options
   * @param {string} options.plantId - Plant ID (null = all plants)
   * @param {string} options.materialCode - Material code (optional)
   * @param {string} options.snapshotDate - Snapshot date (optional)
   * @param {string} options.startDate - Start date (optional)
   * @param {string} options.endDate - End date (optional)
   * @param {number} options.limit - Row limit (default 1000)
   * @param {number} options.offset - Offset (default 0)
   * @returns {Promise<Array>} Inventory Snapshots data array
   */
  async fetchByFilters(userId, options = {}) {
    const { 
      plantId = null, 
      materialCode = null,
      snapshotDate = null,
      startDate = null,
      endDate = null,
      limit = 1000, 
      offset = 0 
    } = options;

    let query = supabase
      .from('inventory_snapshots')
      .select('*')
      .eq('user_id', userId)
      .order('snapshot_date', { ascending: false })
      .range(offset, offset + limit - 1);

    // Plant filter (null = all plants)
    if (plantId) {
      query = query.eq('plant_id', plantId);
    }

    // Material code filter
    if (materialCode) {
      query = query.eq('material_code', materialCode);
    }

    // Specific date filter
    if (snapshotDate) {
      query = query.eq('snapshot_date', snapshotDate);
    }

    // Date range filter
    if (startDate) {
      query = query.gte('snapshot_date', startDate);
    }

    if (endDate) {
      query = query.lte('snapshot_date', endDate);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  /**
   * Get latest inventory snapshot per material+plant (for Inventory Projection / Risk)
   * @param {string} userId
   * @param {string|null} plantId
   * @param {{ limit?: number }} [opts]
   * @returns {Promise<Array<{ material_code: string, plant_id: string, on_hand_qty: number, safety_stock: number, snapshot_date?: string, created_at?: string }>>}
   */
  async getLatestInventorySnapshots(userId, plantId = null, opts = {}) {
    if (!userId) return [];
    const limit = opts.limit ?? 10000;
    let query = supabase
      .from('inventory_snapshots')
      .select('*')
      .eq('user_id', userId)
      .order('snapshot_date', { ascending: false })
      .limit(limit);
    if (plantId) query = query.eq('plant_id', plantId);
    const { data, error } = await query;
    if (error) throw error;
    const rows = (data || []).map(r => ({
      ...r,
      on_hand_qty: r.on_hand_qty ?? r.onhand_qty ?? 0
    }));
    const byKey = new Map();
    for (const r of rows) {
      const key = `${(r.material_code || '').trim().toUpperCase()}|${(r.plant_id || '').trim().toUpperCase()}`;
      if (!byKey.has(key)) byKey.set(key, { ...r });
    }
    return Array.from(byKey.values());
  },

  /**
   * Delete Inventory Snapshots by batch ID (supports undo)
   * @param {string} batchId - Batch ID
   * @returns {Promise<Object>} { success, count }
   */
  async deleteByBatch(batchId) {
    if (!batchId) {
      return { success: true, count: 0 };
    }

    const { data, error } = await supabase
      .from('inventory_snapshots')
      .delete()
      .eq('batch_id', batchId)
      .select();

    if (error) throw error;
    return { success: true, count: data?.length || 0 };
  },

  /**
   * Get latest inventory snapshot
   * @param {string} userId - User ID
   * @param {string} materialCode - Material code
   * @param {string} plantId - Plant ID
   * @returns {Promise<Object|null>} Latest inventory snapshot or null
   */
  async getLatestSnapshot(userId, materialCode, plantId) {
    const { data, error } = await supabase
      .from('inventory_snapshots')
      .select('*')
      .eq('user_id', userId)
      .eq('material_code', materialCode)
      .eq('plant_id', plantId)
      .order('snapshot_date', { ascending: false })
      .limit(1)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null; // Not found
      throw error;
    }
    return data;
  },

  /**
   * Get Inventory Snapshots (general query method)
   * @param {string} userId - User ID
   * @param {Object} options - Query options
   * @returns {Promise<Array>} Inventory Snapshots data array
   */
  async getInventorySnapshots(userId, options = {}) {
    const { 
      plantId, 
      materialCode, 
      snapshotDate,
      limit = 100, 
      offset = 0 
    } = options;

    let query = supabase
      .from('inventory_snapshots')
      .select('*')
      .eq('user_id', userId)
      .order('snapshot_date', { ascending: false })
      .range(offset, offset + limit - 1);

    if (plantId) {
      query = query.eq('plant_id', plantId);
    }

    if (materialCode) {
      query = query.eq('material_code', materialCode);
    }

    if (snapshotDate) {
      query = query.eq('snapshot_date', snapshotDate);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }
};

/**
 * FG Financials Operations
 * Manage finished goods financial data (pricing and profit)
 */
export const fgFinancialsService = {
  /**
   * Batch insert FG Financials
   * @param {string} userId - User ID
   * @param {Array} rows - FG Financials data array
   * @param {string} batchId - Batch ID (optional)
   * @returns {Promise<Object>} { success, count, data }
   */
  async batchInsert(userId, rows, batchId = null) {
    if (!rows || rows.length === 0) {
      return { success: true, count: 0 };
    }

    const payload = rows.map(row => ({
      user_id: userId,
      batch_id: batchId,
      material_code: row.material_code,
      unit_margin: row.unit_margin,
      plant_id: row.plant_id || null, // null = global pricing
      unit_price: row.unit_price !== null && row.unit_price !== undefined ? row.unit_price : null,
      currency: row.currency || 'USD',
      valid_from: row.valid_from || null,
      valid_to: row.valid_to || null,
      notes: row.notes || null
    }));

    // Note: fg_financials uses UNIQUE INDEX with COALESCE
    // Cannot directly use onConflict with column names
    // Use query-then-decide insert/update strategy instead
    try {
      const { data, error } = await supabase
        .from('fg_financials')
        .insert(payload)
        .select();

      if (error) {
        // If unique violation, try upsert (requires DB support)
        if (error.code === '23505') { // Unique violation
          // Fallback: process upsert row by row
          const results = [];
          for (const row of payload) {
            const { data: upsertData, error: upsertError } = await supabase
              .from('fg_financials')
              .upsert(row, {
                ignoreDuplicates: false
              })
              .select();
            
            if (upsertError) throw upsertError;
            results.push(...(upsertData || []));
          }
          return { success: true, count: results.length, data: results };
        }
        throw error;
      }

      return { success: true, count: data.length, data };
    } catch (error) {
      console.error('batchInsert fg_financials error:', error);
      throw error;
    }
  },

  /**
   * Query FG Financials by conditions
   * Special handling: prioritize querying specified plant_id data, fallback to global (plant_id is null) if not found
   * @param {string} userId - User ID
   * @param {Object} options - Query options
   * @param {string} options.plantId - Plant ID (null = all plants, or used for fallback logic)
   * @param {string} options.materialCode - Material code (optional)
   * @param {string} options.currency - Currency (optional)
   * @param {string} options.validDate - Valid date (for checking valid_from/valid_to, optional)
   * @param {boolean} options.usePlantFallback - Whether to use plant fallback logic (default true)
   * @param {number} options.limit - Row limit (default 1000)
   * @param {number} options.offset - Offset (default 0)
   * @returns {Promise<Array>} FG Financials data array
   */
  async fetchByFilters(userId, options = {}) {
    const { 
      plantId = null, 
      materialCode = null,
      currency = null,
      validDate = null,
      usePlantFallback = true,
      limit = 1000, 
      offset = 0 
    } = options;

    // If plantId specified and fallback logic enabled
    if (plantId && usePlantFallback) {
      // First query data for specified plant_id
      let plantQuery = supabase
        .from('fg_financials')
        .select('*')
        .eq('user_id', userId)
        .eq('plant_id', plantId)
        .order('material_code', { ascending: true })
        .range(offset, offset + limit - 1);

      if (materialCode) {
        plantQuery = plantQuery.eq('material_code', materialCode);
      }

      if (currency) {
        plantQuery = plantQuery.eq('currency', currency);
      }

      // Valid date check
      if (validDate) {
        plantQuery = plantQuery
          .or(`valid_from.is.null,valid_from.lte.${validDate}`)
          .or(`valid_to.is.null,valid_to.gte.${validDate}`);
      }

      const { data: plantData, error: plantError } = await plantQuery;
      if (plantError) throw plantError;

      // If data found, return directly
      if (plantData && plantData.length > 0) {
        return plantData;
      }

      // Not found, fallback to global (plant_id is null)
      let globalQuery = supabase
        .from('fg_financials')
        .select('*')
        .eq('user_id', userId)
        .is('plant_id', null)
        .order('material_code', { ascending: true })
        .range(offset, offset + limit - 1);

      if (materialCode) {
        globalQuery = globalQuery.eq('material_code', materialCode);
      }

      if (currency) {
        globalQuery = globalQuery.eq('currency', currency);
      }

      if (validDate) {
        globalQuery = globalQuery
          .or(`valid_from.is.null,valid_from.lte.${validDate}`)
          .or(`valid_to.is.null,valid_to.gte.${validDate}`);
      }

      const { data: globalData, error: globalError } = await globalQuery;
      if (globalError) throw globalError;

      return globalData || [];
    }

    // General query (without fallback)
    let query = supabase
      .from('fg_financials')
      .select('*')
      .eq('user_id', userId)
      .order('material_code', { ascending: true })
      .range(offset, offset + limit - 1);

    // Plant filter (null = all plants)
    if (plantId) {
      query = query.eq('plant_id', plantId);
    } else if (plantId === null && !usePlantFallback) {
      // Explicitly query global pricing
      query = query.is('plant_id', null);
    }

    // Material code filter
    if (materialCode) {
      query = query.eq('material_code', materialCode);
    }

    // Currency filter
    if (currency) {
      query = query.eq('currency', currency);
    }

    // Valid date check
    if (validDate) {
      query = query
        .or(`valid_from.is.null,valid_from.lte.${validDate}`)
        .or(`valid_to.is.null,valid_to.gte.${validDate}`);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  /**
   * Delete FG Financials by batch ID (supports undo)
   * @param {string} batchId - Batch ID
   * @returns {Promise<Object>} { success, count }
   */
  async deleteByBatch(batchId) {
    if (!batchId) {
      return { success: true, count: 0 };
    }

    const { data, error } = await supabase
      .from('fg_financials')
      .delete()
      .eq('batch_id', batchId)
      .select();

    if (error) throw error;
    return { success: true, count: data?.length || 0 };
  },

  /**
   * Get financial data for a specific finished good (with plant fallback)
   * @param {string} userId - User ID
   * @param {string} materialCode - Material code
   * @param {string} plantId - Plant ID (optional)
   * @param {string} currency - Currency (default USD)
   * @returns {Promise<Object|null>} FG Financial data or null
   */
  async getFgFinancial(userId, materialCode, plantId = null, currency = 'USD') {
    // First query data for specified plant_id
    if (plantId) {
      const { data: plantData, error: plantError } = await supabase
        .from('fg_financials')
        .select('*')
        .eq('user_id', userId)
        .eq('material_code', materialCode)
        .eq('plant_id', plantId)
        .eq('currency', currency)
        .order('valid_from', { ascending: false, nullsFirst: false })
        .limit(1)
        .single();

      if (!plantError && plantData) {
        return plantData;
      }
    }

    // Fallback to global (plant_id is null)
    const { data, error } = await supabase
      .from('fg_financials')
      .select('*')
      .eq('user_id', userId)
      .eq('material_code', materialCode)
      .is('plant_id', null)
      .eq('currency', currency)
      .order('valid_from', { ascending: false, nullsFirst: false })
      .limit(1)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null; // Not found
      throw error;
    }
    return data;
  },

  /**
   * Get FG Financials (general query method)
   * @param {string} userId - User ID
   * @param {Object} options - Query options
   * @returns {Promise<Array>} FG Financials data array
   */
  async getFgFinancials(userId, options = {}) {
    const { 
      plantId, 
      materialCode, 
      currency,
      limit = 100, 
      offset = 0 
    } = options;

    let query = supabase
      .from('fg_financials')
      .select('*')
      .eq('user_id', userId)
      .order('material_code', { ascending: true })
      .range(offset, offset + limit - 1);

    if (plantId !== undefined) {
      if (plantId === null) {
        query = query.is('plant_id', null);
      } else {
        query = query.eq('plant_id', plantId);
      }
    }

    if (materialCode) {
      query = query.eq('material_code', materialCode);
    }

    if (currency) {
      query = query.eq('currency', currency);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }
};

/**
 * Import Batches Operations
 * Manage import history and batch undo functionality
 */
export { importBatchesService } from './importHistoryService';
