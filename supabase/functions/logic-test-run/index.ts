// ============================================
// Logic Test Run Edge Function
// Phase 2: Sandbox testing and diff generation
// ============================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { explodeBOM } from '../bom-explosion/bomCalculator.ts';
import { fetchLogicVersionById, type LogicConfig } from '../bom-explosion/logicConfig.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

interface TestRunRequest {
  testRunId: string;
}

interface DiffResult {
  total_demand_delta_pct: number;
  top_changes: Array<{
    component_key: string;
    baseline_demand: number;
    draft_demand: number;
    delta: number;
    delta_pct: number;
  }>;
  new_components: string[];
  removed_components: string[];
}

Deno.serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const authHeader = req.headers.get('authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body: TestRunRequest = await req.json();
    const { testRunId } = body;

    if (!testRunId) {
      return new Response(JSON.stringify({ error: 'Missing testRunId' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fetch test run details
    const { data: testRun, error: testRunError } = await supabase
      .from('logic_test_runs')
      .select('*')
      .eq('id', testRunId)
      .single();

    if (testRunError || !testRun) {
      return new Response(JSON.stringify({ error: 'Test run not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Verify ownership
    if (testRun.user_id !== user.id) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Update status to running
    await supabase
      .from('logic_test_runs')
      .update({ status: 'running', started_at: new Date().toISOString(), progress: 10 })
      .eq('id', testRunId);

    // Fetch draft version config
    const { data: draftVersion } = await supabase
      .from('logic_versions')
      .select('*')
      .eq('id', testRun.logic_version_id)
      .single();

    if (!draftVersion) {
      throw new Error('Draft version not found');
    }

    const draftConfig = draftVersion.config_json as LogicConfig;

    // Fetch baseline version config (if exists)
    let baselineConfig: LogicConfig | null = null;
    if (testRun.baseline_logic_version_id) {
      const { data: baselineVersion } = await supabase
        .from('logic_versions')
        .select('*')
        .eq('id', testRun.baseline_logic_version_id)
        .single();
      
      if (baselineVersion) {
        baselineConfig = baselineVersion.config_json as LogicConfig;
      }
    }

    const { plantId, timeBuckets, maxFgCount } = testRun.request_params;

    // Fetch demand data
    await supabase
      .from('logic_test_runs')
      .update({ progress: 20 })
      .eq('id', testRunId);

    let demandQuery = supabase
      .from('demand_fg')
      .select('*')
      .eq('user_id', user.id);

    if (plantId) {
      demandQuery = demandQuery.eq('plant_id', plantId);
    }
    if (timeBuckets && timeBuckets.length > 0) {
      demandQuery = demandQuery.in('time_bucket', timeBuckets);
    }

    const { data: demandRows, error: demandError } = await demandQuery;

    if (demandError) {
      throw new Error(`Failed to fetch demand: ${demandError.message}`);
    }

    // Apply max FG limit for sampling
    let fgDemands = demandRows || [];
    if (maxFgCount && fgDemands.length > maxFgCount) {
      // Take top N by demand quantity + some random sampling
      const sorted = [...fgDemands].sort((a, b) => b.demand_qty - a.demand_qty);
      const topN = Math.floor(maxFgCount * 0.8);
      const randomN = maxFgCount - topN;
      const topItems = sorted.slice(0, topN);
      const remaining = sorted.slice(topN);
      const randomItems = remaining.sort(() => Math.random() - 0.5).slice(0, randomN);
      fgDemands = [...topItems, ...randomItems];
    }

    // Fetch BOM edges
    await supabase
      .from('logic_test_runs')
      .update({ progress: 30 })
      .eq('id', testRunId);

    let edgesQuery = supabase
      .from('bom_edges')
      .select('*')
      .eq('user_id', user.id);

    if (plantId) {
      edgesQuery = edgesQuery.or(`plant_id.eq.${plantId},plant_id.is.null`);
    }

    const { data: edgesRows, error: edgesError } = await edgesQuery;

    if (edgesError) {
      throw new Error(`Failed to fetch BOM edges: ${edgesError.message}`);
    }

    const bomEdges = edgesRows || [];

    // Run baseline explosion (if baseline exists)
    let baselineResult = null;
    if (baselineConfig) {
      await supabase
        .from('logic_test_runs')
        .update({ progress: 40 })
        .eq('id', testRunId);

      baselineResult = explodeBOM(
        fgDemands.map(r => ({
          id: r.id,
          material_code: r.material_code,
          plant_id: r.plant_id,
          time_bucket: r.time_bucket,
          demand_qty: r.demand_qty,
          source_type: r.source_type,
          source_id: r.source_id,
        })),
        bomEdges.map(r => ({
          id: r.id,
          parent_material: r.parent_material,
          child_material: r.child_material,
          plant_id: r.plant_id,
          qty_per: r.qty_per,
          scrap_rate: r.scrap_rate,
          yield_rate: r.yield_rate,
          valid_from: r.valid_from,
          valid_to: r.valid_to,
          priority: r.priority,
          created_at: r.created_at,
        })),
        {
          maxDepth: baselineConfig.limits.MAX_BOM_DEPTH,
          logicConfig: baselineConfig,
        }
      );
    }

    // Run draft explosion
    await supabase
      .from('logic_test_runs')
      .update({ progress: 60 })
      .eq('id', testRunId);

    const draftResult = explodeBOM(
      fgDemands.map(r => ({
        id: r.id,
        material_code: r.material_code,
        plant_id: r.plant_id,
        time_bucket: r.time_bucket,
        demand_qty: r.demand_qty,
        source_type: r.source_type,
        source_id: r.source_id,
      })),
      bomEdges.map(r => ({
        id: r.id,
        parent_material: r.parent_material,
        child_material: r.child_material,
        plant_id: r.plant_id,
        qty_per: r.qty_per,
        scrap_rate: r.scrap_rate,
        yield_rate: r.yield_rate,
        valid_from: r.valid_from,
        valid_to: r.valid_to,
        priority: r.priority,
        created_at: r.created_at,
      })),
      {
        maxDepth: draftConfig.limits.MAX_BOM_DEPTH,
        logicConfig: draftConfig,
      }
    );

    // Generate diff report
    await supabase
      .from('logic_test_runs')
      .update({ progress: 80 })
      .eq('id', testRunId);

    const diffReport = generateDiffReport(baselineResult, draftResult);

    // Update test run with results
    await supabase
      .from('logic_test_runs')
      .update({
        status: 'completed',
        progress: 100,
        completed_at: new Date().toISOString(),
        summary: {
          fg_demands_count: fgDemands.length,
          bom_edges_count: bomEdges.length,
          component_demand_count: draftResult.componentDemandRows.length,
          trace_count: draftResult.traceRows.length,
          errors_count: draftResult.errors.length,
          duration_seconds: Math.floor((Date.now() - new Date(testRun.started_at).getTime()) / 1000),
        },
        diff_report: diffReport,
      })
      .eq('id', testRunId);

    return new Response(
      JSON.stringify({
        success: true,
        testRunId,
        summary: {
          fg_demands_count: fgDemands.length,
          component_demand_count: draftResult.componentDemandRows.length,
          trace_count: draftResult.traceRows.length,
          errors_count: draftResult.errors.length,
        },
        diffReport,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );

  } catch (error) {
    console.error('Logic test run error:', error);

    // Update test run as failed
    const testRunId = (await req.json()).testRunId;
    if (testRunId) {
      await supabase
        .from('logic_test_runs')
        .update({
          status: 'failed',
          error_message: error instanceof Error ? error.message : String(error),
          completed_at: new Date().toISOString(),
        })
        .eq('id', testRunId);
    }

    return new Response(
      JSON.stringify({
        error: 'Test run failed',
        details: error instanceof Error ? error.message : String(error),
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});

/**
 * Generate diff report between baseline and draft results
 */
function generateDiffReport(
  baseline: { componentDemandRows: any[]; traceRows: any[] } | null,
  draft: { componentDemandRows: any[]; traceRows: any[] }
): DiffResult {
  // Build demand maps
  const baselineMap = new Map();
  const draftMap = new Map();

  if (baseline) {
    for (const row of baseline.componentDemandRows) {
      const key = `${row.material_code}|${row.plant_id}|${row.time_bucket}`;
      baselineMap.set(key, row.demand_qty);
    }
  }

  for (const row of draft.componentDemandRows) {
    const key = `${row.material_code}|${row.plant_id}|${row.time_bucket}`;
    draftMap.set(key, row.demand_qty);
  }

  // Calculate changes
  const allKeys = new Set([...baselineMap.keys(), ...draftMap.keys()]);
  const changes: Array<{
    component_key: string;
    baseline_demand: number;
    draft_demand: number;
    delta: number;
    delta_pct: number;
  }> = [];

  let totalBaseline = 0;
  let totalDraft = 0;

  for (const key of allKeys) {
    const baselineQty = baselineMap.get(key) || 0;
    const draftQty = draftMap.get(key) || 0;
    const delta = draftQty - baselineQty;
    const deltaPct = baselineQty > 0 ? (delta / baselineQty) * 100 : (draftQty > 0 ? 100 : 0);

    totalBaseline += baselineQty;
    totalDraft += draftQty;

    changes.push({
      component_key: key,
      baseline_demand: baselineQty,
      draft_demand: draftQty,
      delta,
      delta_pct: deltaPct,
    });
  }

  // Sort by absolute delta
  changes.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  // Identify new/removed components
  const newComponents: string[] = [];
  const removedComponents: string[] = [];

  for (const key of allKeys) {
    const hasBaseline = baselineMap.has(key);
    const hasDraft = draftMap.has(key);

    if (!hasBaseline && hasDraft) {
      newComponents.push(key);
    } else if (hasBaseline && !hasDraft) {
      removedComponents.push(key);
    }
  }

  // Calculate total delta percentage
  const totalDeltaPct = totalBaseline > 0 
    ? ((totalDraft - totalBaseline) / totalBaseline) * 100 
    : (totalDraft > 0 ? 100 : 0);

  return {
    total_demand_delta_pct: parseFloat(totalDeltaPct.toFixed(2)),
    top_changes: changes.slice(0, 50), // Top 50 changes
    new_components: newComponents.slice(0, 20),
    removed_components: removedComponents.slice(0, 20),
  };
}
