// ============================================
// ETL Scheduler Edge Function
// ============================================
// Purpose: Automated daily sync of SAP data via Deno.cron
// Calls all 5 sync Edge Functions on a schedule
// ============================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Schedule: UTC 02:00 daily (configurable via env)
const CRON_SCHEDULE = Deno.env.get('ETL_CRON_SCHEDULE') || '0 2 * * *';

// Sync functions to call, in dependency order
const SYNC_FUNCTIONS = [
  'sync-materials-from-sap',
  'sync-bom-from-sap',
  'sync-inventory-from-sap',
  'sync-demand-fg-from-sap',
  'sync-po-open-lines-from-sap',
] as const;

interface SyncResult {
  function_name: string;
  status: 'success' | 'error';
  duration_ms: number;
  detail?: string;
}

async function invokeSyncFunction(functionName: string): Promise<SyncResult> {
  const start = Date.now();
  try {
    const url = `${SUPABASE_URL}/functions/v1/${functionName}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    const body = await response.json().catch(() => ({}));
    const duration_ms = Date.now() - start;

    if (!response.ok) {
      return {
        function_name: functionName,
        status: 'error',
        duration_ms,
        detail: `HTTP ${response.status}: ${JSON.stringify(body).slice(0, 200)}`,
      };
    }

    return {
      function_name: functionName,
      status: 'success',
      duration_ms,
      detail: body.stats ? `fetched=${body.stats.fetched}, upserted=${body.stats.upserted}` : 'ok',
    };
  } catch (err) {
    return {
      function_name: functionName,
      status: 'error',
      duration_ms: Date.now() - start,
      detail: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

async function runFullSync(): Promise<SyncResult[]> {
  console.log(`[ETL-SCHEDULER] Starting full SAP sync at ${new Date().toISOString()}`);
  const results: SyncResult[] = [];

  for (const fn of SYNC_FUNCTIONS) {
    console.log(`[ETL-SCHEDULER] Invoking ${fn}...`);
    const result = await invokeSyncFunction(fn);
    results.push(result);
    console.log(`[ETL-SCHEDULER] ${fn}: ${result.status} (${result.duration_ms}ms) ${result.detail || ''}`);

    // If a dependency fails, continue but log warning
    if (result.status === 'error') {
      console.warn(`[ETL-SCHEDULER] ${fn} failed, continuing with remaining functions`);
    }
  }

  // Log sync run to Supabase for audit trail
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    await supabase.from('etl_sync_log').insert({
      sync_type: 'scheduled',
      results: JSON.stringify(results),
      total_duration_ms: results.reduce((sum, r) => sum + r.duration_ms, 0),
      success_count: results.filter(r => r.status === 'success').length,
      error_count: results.filter(r => r.status === 'error').length,
      triggered_at: new Date().toISOString(),
    });
  } catch (logErr) {
    // Logging failure is non-fatal
    console.warn('[ETL-SCHEDULER] Failed to log sync run:', logErr);
  }

  return results;
}

// Register cron job
Deno.cron('etl-sap-daily-sync', CRON_SCHEDULE, async () => {
  await runFullSync();
});

// Also expose HTTP handler for manual trigger
Deno.serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const results = await runFullSync();
  const allOk = results.every(r => r.status === 'success');

  return new Response(
    JSON.stringify({
      success: allOk,
      message: allOk ? 'All sync functions completed successfully' : 'Some sync functions failed',
      results,
      total_duration_ms: results.reduce((sum, r) => sum + r.duration_ms, 0),
    }),
    {
      status: allOk ? 200 : 207,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    },
  );
});
