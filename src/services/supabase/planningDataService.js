import { sendAgentLog } from '../../utils/sendAgentLog';
import { supabase } from './core.js';

export const bomEdgesService = {
  async batchInsert(userId, bomEdges, batchId = null) {
    if (!bomEdges || bomEdges.length === 0) {
      return { success: true, count: 0 };
    }

    console.info('[ingest] table=bom_edges, rows=', bomEdges.length, ', batchId type=', typeof batchId, ', batchId value=', JSON.stringify(batchId).slice(0, 200));
    sendAgentLog({
      location: 'supabase/planningDataService.js:bomEdgesService.batchInsert',
      message: '[ingest] LOG1 table/uploadType/rows/batchId',
      data: {
        tableName: 'bom_edges',
        uploadType: 'bom_edge',
        rows: bomEdges.length,
        batchIdType: typeof batchId,
        batchIdPreview: JSON.stringify(batchId).slice(0, 200),
      },
      sessionId: 'debug-session',
      hypothesisId: 'A',
    });

    const payload = bomEdges.map((edge) => ({
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
      notes: edge.notes || null,
    }));

    const sample = payload[0];
    const uuidFieldTypes = {};
    if (sample) {
      console.info('[ingest] sample keys=', Object.keys(sample));
      const uuidFields = ['user_id', 'batch_id', 'batchId', 'sheet_run_id', 'sheetRunId', 'ingest_key', 'ingestKey'];
      uuidFields.forEach((field) => {
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
    sendAgentLog({
      location: 'supabase/planningDataService.js:bomEdgesService.batchInsert',
      message: '[ingest] LOG2 sample keys + uuid field types',
      data: { sampleKeys: sample ? Object.keys(sample) : null, uuidFieldTypes },
      sessionId: 'debug-session',
      hypothesisId: 'B',
    });

    console.info('[ingest] payload is array:', Array.isArray(payload), ', length=', payload.length);
    console.info('[ingest] payload preview (first 800 chars):', JSON.stringify(payload).slice(0, 800));
    sendAgentLog({
      location: 'supabase/planningDataService.js:bomEdgesService.batchInsert',
      message: '[ingest] LOG3 request body top-level',
      data: {
        bodyIsArray: Array.isArray(payload),
        bodyLength: payload.length,
        bodyTopLevelKeys: Array.isArray(payload) ? null : Object.keys(payload),
        bodyPreview: JSON.stringify(payload).slice(0, 800),
      },
      sessionId: 'debug-session',
      hypothesisId: 'C',
    });

    const { data, error } = await supabase
      .from('bom_edges')
      .insert(payload)
      .select();

    if (error) throw error;
    return { success: true, count: data.length, data };
  },

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

  async fetchBomEdges(userId, plantId = null, _timeBuckets = []) {
    let query = supabase
      .from('bom_edges')
      .select('*')
      .eq('user_id', userId)
      .order('parent_material', { ascending: true });

    if (plantId) {
      query = query.or(`plant_id.eq.${plantId},plant_id.is.null`);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },
};

export const demandFgService = {
  async batchInsert(userId, demands, batchId = null) {
    if (!demands || demands.length === 0) {
      return { success: true, count: 0 };
    }

    const payload = demands.map((demand) => ({
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
      notes: demand.notes || null,
    }));

    const { data, error } = await supabase
      .from('demand_fg')
      .insert(payload)
      .select();

    if (error) throw error;
    return { success: true, count: data.length, data };
  },

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

  async fetchDemandFg(userId, plantId = null, timeBuckets = []) {
    let query = supabase
      .from('demand_fg')
      .select('*')
      .eq('user_id', userId)
      .order('time_bucket', { ascending: true });

    if (plantId) {
      query = query.eq('plant_id', plantId);
    }
    if (timeBuckets && timeBuckets.length > 0) {
      query = query.in('time_bucket', timeBuckets);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },
};

export const demandForecastService = {
  async batchInsert(userId, forecasts) {
    if (!forecasts || forecasts.length === 0) {
      return { success: true, count: 0 };
    }

    const payload = forecasts.map((forecast) => ({
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
      metrics: forecast.metrics || {},
    }));

    const { data, error } = await supabase
      .from('demand_forecast')
      .insert(payload)
      .select();

    if (error) throw error;
    return { success: true, count: data.length, data };
  },

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

  async getMaterialsByRun(userId, forecastRunId) {
    const { data, error } = await supabase
      .from('demand_forecast')
      .select('material_code')
      .eq('user_id', userId)
      .eq('forecast_run_id', forecastRunId);

    if (error) throw error;
    return [...new Set((data || []).map((demand) => demand.material_code))];
  },

  async getHistoricalDemandFg(userId, plantId, materialCode, endTimeBucket, windowBuckets) {
    let query = supabase
      .from('demand_fg')
      .select('time_bucket, demand_qty, material_code, plant_id')
      .eq('user_id', userId)
      .order('time_bucket', { ascending: false })
      .limit(windowBuckets);

    if (materialCode) {
      query = query.eq('material_code', materialCode);
    }
    if (plantId) {
      query = query.eq('plant_id', plantId);
    }
    if (endTimeBucket) {
      query = query.lte('time_bucket', endTimeBucket);
    }

    const { data, error } = await query;
    if (error) throw error;
    return (data || []).reverse();
  },

  async deleteForecastsByRun(userId, forecastRunId) {
    const { error } = await supabase
      .from('demand_forecast')
      .delete()
      .eq('user_id', userId)
      .eq('forecast_run_id', forecastRunId);

    if (error) throw error;
    return { success: true };
  },
};

export const forecastRunsService = {
  async createRun(userId, options = {}) {
    const {
      scenarioName = 'baseline',
      parameters = {},
      kind = 'bom_explosion',
    } = options;
    const { data, error } = await supabase
      .from('forecast_runs')
      .insert({
        user_id: userId,
        scenario_name: scenarioName,
        parameters,
        kind,
        status: 'pending',
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
    const { data, error } = await supabase
      .from('forecast_runs')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  },
};

export const componentDemandService = {
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

  async upsertComponentDemand(rows) {
    if (!rows || rows.length === 0) {
      return { success: true, count: 0 };
    }

    try {
      const payload = rows.map((row, index) => {
        if (!row.user_id || !row.material_code || !row.plant_id || !row.time_bucket) {
          throw new Error(`Row ${index}: Missing required fields (user_id, material_code, plant_id, or time_bucket)`);
        }
        if (row.demand_qty === undefined || row.demand_qty === null) {
          throw new Error(`Row ${index}: Missing demand_qty`);
        }

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
          notes: row.notes || null,
        };

        if (row.id) {
          record.id = row.id;
        }

        return record;
      });

      const { data, error } = await supabase
        .from('component_demand')
        .upsert(payload, {
          onConflict: 'user_id,forecast_run_id,material_code,plant_id,time_bucket',
          ignoreDuplicates: false,
        })
        .select();

      if (error) {
        console.warn('Upsert failed, attempting fallback strategy:', {
          error: error.message,
          code: error.code,
          hint: error.hint,
        });

        const userId = rows[0].user_id;
        const forecastRunId = rows[0].forecast_run_id ?? null;
        const materialCodes = [...new Set(rows.map((row) => row.material_code))];
        const plantIds = [...new Set(rows.map((row) => row.plant_id))];
        const timeBuckets = [...new Set(rows.map((row) => row.time_bucket))];

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
          console.error('Query existing records failed:', {
            message: queryError.message,
            code: queryError.code,
            details: queryError.details,
          });
          throw new Error(`Query failed: ${queryError.message}`);
        }

        if (existingData && existingData.length > 0) {
          const existingIds = existingData.map((record) => record.id);
          const { error: deleteError } = await supabase
            .from('component_demand')
            .delete()
            .in('id', existingIds);

          if (deleteError) {
            console.error('Delete existing records failed:', {
              message: deleteError.message,
              code: deleteError.code,
              details: deleteError.details,
              deletedIds: existingIds.slice(0, 5),
            });
            throw new Error(`Delete failed: ${deleteError.message}`);
          }
        }

        const { data: insertData, error: insertError } = await supabase
          .from('component_demand')
          .insert(payload)
          .select();

        if (insertError) {
          console.error('Insert new records failed:', {
            message: insertError.message,
            code: insertError.code,
            details: insertError.details,
            hint: insertError.hint,
            sample_payload: payload.slice(0, 2),
          });
          throw new Error(`Insert failed: ${insertError.message} (code: ${insertError.code})`);
        }

        return { success: true, count: insertData.length, data: insertData };
      }

      return { success: true, count: data.length, data };
    } catch (error) {
      if (error.message.includes('Missing required fields') || error.message.includes('Missing demand_qty')) {
        throw error;
      }

      const enhancedError = new Error(`upsertComponentDemand error: ${error.message}`);
      enhancedError.originalError = error;
      enhancedError.rowCount = rows.length;
      throw enhancedError;
    }
  },

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

  async deleteComponentOutputsByBatch(batchId) {
    if (!batchId) {
      return { success: true, componentDemandCount: 0, traceCount: 0 };
    }

    const { data: traceData, error: traceError } = await supabase
      .from('component_demand_trace')
      .delete()
      .eq('batch_id', batchId)
      .select();

    if (traceError) throw traceError;

    const { data: demandData, error: demandError } = await supabase
      .from('component_demand')
      .delete()
      .eq('batch_id', batchId)
      .select();

    if (demandError) throw demandError;

    return {
      success: true,
      componentDemandCount: demandData?.length || 0,
      traceCount: traceData?.length || 0,
    };
  },

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

  async getComponentDemandsByBatch(userId, batchId, options = {}) {
    const { filters = {}, limit = 100, offset = 0 } = options;

    let query = supabase
      .from('component_demand')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .eq('batch_id', batchId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

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
      count: count || 0,
    };
  },
};

export const componentDemandTraceService = {
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
      query = query.eq('component_demand.material_code', componentMaterial);
    }
    if (timeBucket) {
      query = query.eq('component_demand.time_bucket', timeBucket);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  async insertComponentDemandTrace(rows) {
    if (!rows || rows.length === 0) {
      return { success: true, count: 0 };
    }

    try {
      const payload = rows.map((row, index) => {
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
          trace_meta: row.trace_meta || {},
        };
      });

      const { data, error } = await supabase
        .from('component_demand_trace')
        .insert(payload)
        .select();

      if (error) {
        console.error('insertComponentDemandTrace failed:', {
          message: error.message,
          code: error.code,
          details: error.details,
          hint: error.hint,
          sample_payload: payload.slice(0, 2),
        });
        throw new Error(`Database insert failed: ${error.message} (code: ${error.code})`);
      }

      return { success: true, count: data.length, data };
    } catch (error) {
      if (error.message.includes('Missing required fields')) {
        throw error;
      }

      const enhancedError = new Error(`insertComponentDemandTrace error: ${error.message}`);
      enhancedError.originalError = error;
      enhancedError.rowCount = rows.length;
      throw enhancedError;
    }
  },

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

  async getTracesByBatch(userId, batchId, options = {}) {
    const { filters = {}, limit = 100, offset = 0 } = options;

    let query = supabase
      .from('component_demand_trace')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .eq('batch_id', batchId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (filters.bom_level) {
      query = query.eq('bom_level', parseInt(filters.bom_level));
    }
    if (filters.fg_material_code) {
      query = query.ilike('trace_meta->>fg_material_code', `%${filters.fg_material_code}%`);
    }
    if (filters.component_material_code) {
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
      count: count || 0,
    };
  },
};

