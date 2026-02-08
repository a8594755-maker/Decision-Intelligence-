// ============================================
// BOM Explosion Edge Function - Main Handler
// ============================================

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import type {
  BomExplosionRequest,
  BomExplosionResponse,
  BomExplosionResult,
  FGDemand,
  BOMEdge,
  ComponentDemand,
  ComponentDemandTrace,
  ForecastRun,
  ImportBatch,
} from './types.ts';
import { LIMITS, PROGRESS_STAGES, DEFAULTS } from './types.ts';
import { generateUUID, batchInsert, validateRequest, buildDemandIdMap, getAggregationKey, generateJobKey } from './utils.ts';
import { explodeBOM } from './bomCalculator.ts';
import {
  fetchPublishedLogic,
  fetchLogicVersionById,
  type LogicConfig,
  type LogicVersionInfo,
  validateConfig,
  getHeartbeatThresholdMs,
  getDemandChunkSize,
  getTraceChunkSize,
} from './logicConfig.ts';

// Initialize Supabase client
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

/**
 * Main request handler
 */
Deno.serve(async (req) => {
  // CORS headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Only accept POST requests
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get authorization header
    const authHeader = req.headers.get('authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Create Supabase client
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    // Verify JWT and get user
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized', details: authError?.message }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const userId = user.id;

    // Parse request body
    const body: BomExplosionRequest = await req.json();

    // Validate request
    const validation = validateRequest(body);
    if (!validation.valid) {
      return new Response(JSON.stringify({ error: validation.error }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Logic Control Center: Fetch configuration
    let logicVersionInfo: LogicVersionInfo | null = null;
    let logicConfig: LogicConfig | null = null;

    // If explicit version specified (for sandbox/draft testing)
    if (body.logicVersionId) {
      logicVersionInfo = await fetchLogicVersionById(supabase, body.logicVersionId);
      if (!logicVersionInfo) {
        return new Response(JSON.stringify({ error: 'Invalid logic version ID' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      logicConfig = logicVersionInfo.config;
    } else {
      // Fetch published config for scope
      const scopeLevel = body.plantId ? 'PLANT' : 'GLOBAL';
      logicVersionInfo = await fetchPublishedLogic(supabase, 'bom_explosion', scopeLevel, body.plantId);
      if (logicVersionInfo) {
        logicConfig = logicVersionInfo.config;
      }
    }

    // Validate the configuration
    if (logicConfig) {
      const configValidation = validateConfig(logicConfig);
      if (!configValidation.valid) {
        return new Response(JSON.stringify({ 
          error: 'Invalid logic configuration', 
          details: configValidation.errors 
        }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // v1: Generate job key for idempotency
    const jobKey = generateJobKey(userId, {
      plantId: body.plantId,
      timeBuckets: body.timeBuckets,
      demandForecastRunId: body.demandForecastRunId,
      supplyForecastRunId: body.supplyForecastRunId,
      scenarioName: body.scenarioName,
    });

    // v1: ACL checks - verify plant permission and run ownership
    if (body.plantId) {
      const { data: plantAcl, error: plantError } = await supabase
        .from('user_plant_acl')
        .select('plant_id')
        .eq('user_id', userId)
        .eq('plant_id', body.plantId)
        .single();
      
      // Fallback: check if user has access to any plants including this one
      if (plantError || !plantAcl) {
        const { data: userProfile } = await supabase
          .from('user_profiles')
          .select('accessible_plants')
          .eq('user_id', userId)
          .single();
        
        const accessiblePlants = userProfile?.accessible_plants || [];
        if (!accessiblePlants.includes(body.plantId) && !accessiblePlants.includes('*')) {
          return new Response(JSON.stringify({ error: 'Unauthorized plant access' }), {
            status: 403,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }
    }

    // v1: Verify demand forecast run ownership
    if (body.demandForecastRunId) {
      const { data: runCheck, error: runError } = await supabase
        .from('forecast_runs')
        .select('id')
        .eq('id', body.demandForecastRunId)
        .eq('user_id', userId)
        .single();
      
      if (runError || !runCheck) {
        return new Response(JSON.stringify({ error: 'Invalid or unauthorized demand forecast run' }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // v1: Cleanup zombie jobs (2 minute threshold)
    const zombieThreshold = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const { data: zombies } = await supabase
      .from('import_batches')
      .select('id, metadata')
      .eq('user_id', userId)
      .eq('job_key', jobKey)
      .eq('status', 'running')
      .lt('heartbeat_at', zombieThreshold);

    if (zombies && zombies.length > 0) {
      console.log(`Cleaning up ${zombies.length} zombie jobs`);
      const zombieIds = zombies.map((z: { id: string }) => z.id);
      
      // Mark zombies as failed
      await supabase
        .from('import_batches')
        .update({
          status: 'failed',
          error_message: 'Zombie job detected: no heartbeat for 2+ minutes',
          failed_at: new Date().toISOString(),
        })
        .in('id', zombieIds);
      
      // Also update associated forecast_runs
      const zombieRunIds = zombies
        .map((z: { metadata?: { forecast_run_id?: string } }) => z.metadata?.forecast_run_id)
        .filter(Boolean);
      
      if (zombieRunIds.length > 0) {
        await supabase
          .from('forecast_runs')
          .update({
            status: 'failed',
            failed_at: new Date().toISOString(),
          })
          .in('id', zombieRunIds);
      }
    }

    // v1: Check for existing running/pending job with same key
    const { data: existingJobs } = await supabase
      .from('import_batches')
      .select('id, status, progress, metadata, result_summary, completed_at')
      .eq('user_id', userId)
      .eq('job_key', jobKey)
      .in('status', ['running', 'pending'])
      .order('created_at', { ascending: false })
      .limit(1);

    if (existingJobs && existingJobs.length > 0) {
      const existing = existingJobs[0];
      return new Response(JSON.stringify({
        error: 'A job with the same parameters is already running',
        existingBatchId: existing.id,
        status: existing.status,
        progress: existing.progress,
      }), {
        status: 429,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // v1: Check for completed job (reuse if not forceNewRun)
    if (!body.forceNewRun) {
      const { data: completedJobs } = await supabase
        .from('import_batches')
        .select('id, progress, metadata, result_summary, completed_at')
        .eq('user_id', userId)
        .eq('job_key', jobKey)
        .eq('status', 'completed')
        .order('completed_at', { ascending: false })
        .limit(1);

      if (completedJobs && completedJobs.length > 0) {
        const completed = completedJobs[0];
        const response: BomExplosionResponse = {
          success: true,
          batchId: completed.id,
          forecastRunId: completed.metadata?.forecast_run_id || '',
          jobKey,
          status: 'reused',
          progress: 100,
          message: 'Reusing completed job result',
          reusedFromBatchId: completed.id,
          completedAt: completed.completed_at,
          resultSummary: completed.result_summary || {
            componentDemandCount: 0,
            traceCount: 0,
            errorsCount: 0,
          },
        };

        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // v1: Create new job with initial progress 5%
    const forecastRunId = generateUUID();
    const batchId = generateUUID();
    const now = new Date().toISOString();
    
    const runInsert: ForecastRun = {
      id: forecastRunId,
      user_id: userId,
      status: 'running',
      job_key: jobKey,
      scenario_name: body.scenarioName || 'baseline',
      parameters: {
        plant_id: body.plantId,
        time_buckets: body.timeBuckets,
        demand_source: body.demandSource,
        demand_forecast_run_id: body.demandForecastRunId,
        inbound_source: body.inboundSource,
        supply_forecast_run_id: body.supplyForecastRunId,
        kind: 'bom_explosion',
      },
      metadata: body.metadata || {},
      heartbeat_at: now,
      started_at: now,
      // Logic Control Center: 记录使用的配置版本
      logic_version_id: logicVersionInfo?.version_id || null,
    };

    const { error: runError } = await supabase.from('forecast_runs').insert(runInsert);
    if (runError) {
      throw new Error(`Failed to create forecast_run: ${runError.message}`);
    }

    const batchInsert: ImportBatch = {
      id: batchId,
      user_id: userId,
      status: 'running',
      job_key: jobKey,
      job_type: 'bom_explosion',
      upload_type: 'bom_explosion',
      filename: `BOM Explosion - ${body.plantId || 'All Plants'} - ${now}`,
      progress: PROGRESS_STAGES.VALIDATED,
      heartbeat_at: now,
      started_at: now,
      // Logic Control Center: 记录使用的配置版本
      logic_version_id: logicVersionInfo?.version_id || null,
      metadata: {
        ...body.metadata,
        forecast_run_id: forecastRunId,
        job_key: jobKey,
        started_at: now,
      },
    };

    const { error: batchError } = await supabase.from('import_batches').insert(batchInsert);
    if (batchError) {
      throw new Error(`Failed to create import_batch: ${batchError.message}`);
    }

    // Return immediate response (job started)
    const response: BomExplosionResponse = {
      success: true,
      batchId,
      forecastRunId,
      jobKey,
      status: 'running',
      progress: PROGRESS_STAGES.VALIDATED,
      message: 'BOM explosion calculation started',
    };

    // Start async processing with logic config
    processBomExplosion(supabase, userId, batchId, forecastRunId, body, jobKey, logicConfig);

    return new Response(JSON.stringify(response), {
      status: 202, // Accepted
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Edge function error:', error);
    return new Response(JSON.stringify({
      error: 'Internal server error',
      details: error instanceof Error ? error.message : String(error),
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

/**
 * v1: Update job progress and result summary
 */
async function updateProgress(
  supabase: SupabaseClient,
  batchId: string,
  progress: number,
  resultSummary: Record<string, any>
): Promise<void> {
  const now = new Date().toISOString();
  await supabase.from('import_batches')
    .update({
      progress,
      heartbeat_at: now,
      result_summary: supabase.rpc('jsonb_merge', {
        base: supabase.from('import_batches').select('result_summary').eq('id', batchId).single(),
        merge: resultSummary,
      }),
    })
    .eq('id', batchId);
}

/**
 * Async processing of BOM explosion
 */
async function processBomExplosion(
  supabase: SupabaseClient,
  userId: string,
  batchId: string,
  forecastRunId: string,
  request: BomExplosionRequest,
  jobKey: string,
  logicConfig: LogicConfig | null
): Promise<void> {
  const errors: Array<{ type: string; message: string; details?: any }> = [];
  
  // Use logic config or fall back to defaults
  const limits = logicConfig?.limits || LIMITS;
  const heartbeatIntervalMs = logicConfig ? getHeartbeatThresholdMs(logicConfig) / 4 : DEFAULTS.HEARTBEAT_INTERVAL_SECONDS * 1000;
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  const startHeartbeat = () => {
    heartbeatInterval = setInterval(async () => {
      const now = new Date().toISOString();
      await supabase.from('import_batches')
        .update({ heartbeat_at: now })
        .eq('id', batchId);
      await supabase.from('forecast_runs')
        .update({ heartbeat_at: now })
        .eq('id', forecastRunId);
    }, heartbeatIntervalMs);
  };
  
  const stopHeartbeat = () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  };

  try {
    // v1: Start heartbeat
    startHeartbeat();
    
    // 1. Fetch demand_fg data
    await updateProgress(supabase, batchId, PROGRESS_STAGES.FETCHED_DEMAND, {});
    let demandFgQuery = supabase
      .from('demand_fg')
      .select('*')
      .eq('user_id', userId);

    if (request.plantId) {
      demandFgQuery = demandFgQuery.eq('plant_id', request.plantId);
    }

    if (request.timeBuckets && request.timeBuckets.length > 0) {
      demandFgQuery = demandFgQuery.in('time_bucket', request.timeBuckets);
    }

    const { data: demandFgRows, error: demandError } = await demandFgQuery;

    if (demandError) {
      throw new Error(`Failed to fetch demand_fg: ${demandError.message}`);
    }

    const fgDemands: FGDemand[] = (demandFgRows || []).map(row => ({
      id: row.id,
      material_code: row.material_code,
      plant_id: row.plant_id,
      time_bucket: row.time_bucket,
      demand_qty: row.demand_qty,
      source_type: row.source_type,
      source_id: row.source_id,
    }));

    // Check limits using config
    if (fgDemands.length > limits.MAX_FG_DEMAND_ROWS) {
      stopHeartbeat();
      throw new Error(`FG demand rows exceed limit: ${fgDemands.length} > ${limits.MAX_FG_DEMAND_ROWS}`);
    }

    // v1: Update progress after fetching demand
    await updateProgress(supabase, batchId, PROGRESS_STAGES.BUILT_INDEX, {
      fg_demands_count: fgDemands.length,
    });

    // 2. Fetch bom_edges data
    let bomEdgesQuery = supabase
      .from('bom_edges')
      .select('*')
      .eq('user_id', userId);

    if (request.plantId) {
      // Filter by plant_id OR null (generic BOM)
      bomEdgesQuery = bomEdgesQuery.or(`plant_id.eq.${request.plantId},plant_id.is.null`);
    }

    const { data: bomEdgesRows, error: edgesError } = await bomEdgesQuery;

    if (edgesError) {
      throw new Error(`Failed to fetch bom_edges: ${edgesError.message}`);
    }

    const bomEdges: BOMEdge[] = (bomEdgesRows || []).map(row => ({
      id: row.id,
      parent_material: row.parent_material,
      child_material: row.child_material,
      plant_id: row.plant_id,
      qty_per: row.qty_per,
      scrap_rate: row.scrap_rate,
      yield_rate: row.yield_rate,
      valid_from: row.valid_from,
      valid_to: row.valid_to,
      priority: row.priority,
      created_at: row.created_at,
    }));

    if (bomEdges.length > limits.MAX_BOM_EDGES_ROWS) {
      stopHeartbeat();
      throw new Error(`BOM edges exceed limit: ${bomEdges.length} > ${limits.MAX_BOM_EDGES_ROWS}`);
    }

    // 3. Clean old results (idempotency)
    const { error: deleteTraceError } = await supabase
      .from('component_demand_trace')
      .delete()
      .eq('forecast_run_id', forecastRunId)
      .eq('user_id', userId);

    if (deleteTraceError) {
      throw new Error(`Failed to delete old trace records: ${deleteTraceError.message}`);
    }

    const { error: deleteDemandError } = await supabase
      .from('component_demand')
      .delete()
      .eq('forecast_run_id', forecastRunId)
      .eq('user_id', userId);

    if (deleteDemandError) {
      throw new Error(`Failed to delete old demand records: ${deleteDemandError.message}`);
    }

    // v1: Update progress before explosion
    await updateProgress(supabase, batchId, PROGRESS_STAGES.EXPLODED, {
      bom_edges_count: bomEdges.length,
    });

    // 4. Execute BOM explosion calculation with config
    const result = explodeBOM(fgDemands, bomEdges, {
      maxDepth: limits.MAX_BOM_DEPTH,
      logicConfig: logicConfig || undefined,
    });

    // Check trace limit using config
    if (result.traceRows.length > limits.MAX_TRACE_ROWS_PER_RUN) {
      stopHeartbeat();
      throw new Error(`Trace rows explosion detected: ${result.traceRows.length} > ${limits.MAX_TRACE_ROWS_PER_RUN}`);
    }

    // v1: Update progress after explosion
    await updateProgress(supabase, batchId, PROGRESS_STAGES.AGGREGATED, {
      component_demand_count: result.componentDemandRows.length,
      trace_count: result.traceRows.length,
    });

    // 5. Pre-generate UUIDs and prepare component_demand rows
    const componentDemandRows: ComponentDemand[] = result.componentDemandRows.map(row => ({
      id: generateUUID(),
      user_id: userId,
      batch_id: batchId,
      forecast_run_id: forecastRunId,
      material_code: row.material_code,
      plant_id: row.plant_id,
      time_bucket: row.time_bucket,
      demand_qty: row.demand_qty,
      uom: 'pcs',
      notes: null,
    }));

    // Build lookup map for trace
    const demandIdMap = buildDemandIdMap(componentDemandRows);

    // 6. Batch insert component_demand with config-based chunk size
    const demandChunkSize = logicConfig ? getDemandChunkSize(logicConfig) : LIMITS.INSERT_CHUNK_SIZE_DEMAND;
    if (componentDemandRows.length > 0) {
      const insertResult = await batchInsert(
        async (chunk) => {
          const { error } = await supabase.from('component_demand').insert(chunk);
          return { error: error || null };
        },
        componentDemandRows,
        demandChunkSize
      );

      if (!insertResult.success) {
        throw new Error(`Failed to insert component_demand: ${insertResult.error?.message}`);
      }
    }

    // 7. Prepare and insert component_demand_trace with config-based chunk size
    const traceChunkSize = logicConfig ? getTraceChunkSize(logicConfig) : LIMITS.INSERT_CHUNK_SIZE_TRACE;
    const traceRows: ComponentDemandTrace[] = result.traceRows.map(trace => {
      const key = getAggregationKey(trace.plant_id, trace.time_bucket, trace.component_material_code);
      const componentDemandId = demandIdMap.get(key);

      if (!componentDemandId) {
        errors.push({
          type: 'MAPPING_ERROR',
          message: `Could not find component_demand_id for ${trace.component_material_code}`,
          details: { key, trace },
        });
      }

      return {
        id: generateUUID(),
        user_id: userId,
        batch_id: batchId,
        forecast_run_id: forecastRunId,
        component_demand_id: componentDemandId || '00000000-0000-0000-0000-000000000000',
        fg_demand_id: trace.fg_demand_id,
        bom_edge_id: trace.bom_edge_id,
        qty_multiplier: trace.qty_multiplier,
        bom_level: trace.bom_level,
        trace_meta: {
          path: trace.path,
          fg_material_code: trace.fg_material_code,
          component_material_code: trace.component_material_code,
          plant_id: trace.plant_id,
          time_bucket: trace.time_bucket,
          fg_qty: trace.fg_qty,
          component_qty: trace.component_qty,
          source_type: trace.source_type,
          source_id: trace.source_id,
          source_fg_demand_id: trace.fg_demand_id,
        },
      };
    });

    // Filter out traces with missing component_demand_id
    const validTraceRows = traceRows.filter(t => t.component_demand_id !== '00000000-0000-0000-0000-000000000000');

    // v1: Update progress before final persistence
    await updateProgress(supabase, batchId, PROGRESS_STAGES.PERSISTED, {
      component_demand_inserted: componentDemandRows.length,
      trace_inserted: validTraceRows.length,
    });

    if (validTraceRows.length > 0) {
      const insertResult = await batchInsert(
        async (chunk) => {
          const { error } = await supabase.from('component_demand_trace').insert(chunk);
          return { error: error || null };
        },
        validTraceRows,
        traceChunkSize
      );

      if (!insertResult.success) {
        throw new Error(`Failed to insert component_demand_trace: ${insertResult.error?.message}`);
      }
    }

    // 8. Update batch status to completed
    stopHeartbeat();
    const now = new Date().toISOString();
    const resultSummary = {
      fg_demands_count: fgDemands.length,
      bom_edges_count: bomEdges.length,
      component_demand_count: componentDemandRows.length,
      component_demand_trace_count: validTraceRows.length,
      errors_count: result.errors.length + errors.length,
      errors: [...result.errors, ...errors],
    };
    
    const { error: updateBatchError } = await supabase
      .from('import_batches')
      .update({
        status: 'completed',
        completed_at: now,
        progress: PROGRESS_STAGES.COMPLETED,
        result_summary: resultSummary,
        metadata: {
          ...request.metadata,
          forecast_run_id: forecastRunId,
          started_at: request.metadata?.started_at || now,
          completed_at: now,
          ...resultSummary,
        },
      })
      .eq('id', batchId);

    if (updateBatchError) {
      throw new Error(`Failed to update batch status: ${updateBatchError.message}`);
    }

    // 9. Update forecast_run status
    const { error: updateRunError } = await supabase
      .from('forecast_runs')
      .update({
        status: 'completed',
        metadata: {
          component_demand_count: componentDemandRows.length,
          component_demand_trace_count: validTraceRows.length,
          errors_count: result.errors.length + errors.length,
          completed_at: new Date().toISOString(),
        },
      })
      .eq('id', forecastRunId);

    if (updateRunError) {
      throw new Error(`Failed to update forecast_run status: ${updateRunError.message}`);
    }

    console.log(`BOM Explosion completed: batchId=${batchId}, forecastRunId=${forecastRunId}, demands=${componentDemandRows.length}, traces=${validTraceRows.length}`);

  } catch (error) {
    console.error('BOM Explosion processing error:', error);

    // Update batch status to failed
    const errorMessage = error instanceof Error ? error.message : String(error);

    await supabase
      .from('import_batches')
      .update({
        status: 'failed',
        error_message: errorMessage,
        metadata: {
          ...request.metadata,
          forecast_run_id: forecastRunId,
          failed_at: new Date().toISOString(),
          error: errorMessage,
        },
      })
      .eq('id', batchId);

    // Update forecast_run status to failed
    await supabase
      .from('forecast_runs')
      .update({
        status: 'failed',
        metadata: {
          error: errorMessage,
          failed_at: new Date().toISOString(),
        },
      })
      .eq('id', forecastRunId);
  }
}
