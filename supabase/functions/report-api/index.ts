// ============================================================
// Report Data API — Supabase Edge Function
// @product: ai-employee
//
// Serves structured report data as JSON for consumption by:
//   - Excel Add-in (Office.js taskpane)
//   - Power BI (Web data source / Power Query M)
//   - Any external BI/reporting tool
//
// Endpoints (via POST body `action`):
//   list_reports     → list available task reports
//   get_report       → full report data for a task
//   get_monthly      → aggregated monthly report
//   get_kpis         → KPI dashboard data
//   get_forecast     → forecast time series
//   get_plan         → replenishment plan table
//   get_risk         → risk analysis data
//   get_review       → AI review scores & revision log
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const FRONTEND_ORIGIN = (Deno.env.get('FRONTEND_ORIGIN') || '').trim();

const ALLOWED_ORIGINS = new Set(
  [
    FRONTEND_ORIGIN,
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:3000', // Excel Add-in dev server
    'https://localhost:3000',
    'null', // Office Add-in sandbox origin
  ].filter(Boolean),
);

const buildCorsHeaders = (origin?: string | null): Record<string, string> => {
  const o = String(origin || '').trim();
  const allowed =
    ALLOWED_ORIGINS.has(o) ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o) ||
    /^https?:\/\/[\w-]+\.supabase\.co$/.test(o) ||
    /^https?:\/\/[\w-]+\.officejs\.com$/.test(o) ||
    /^https?:\/\/[\w-]+\.officeapps\.live\.com$/.test(o) ||
    o === 'null'; // Office Add-in sandbox
  return {
    'Access-Control-Allow-Origin': allowed ? o : (FRONTEND_ORIGIN || '*'),
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Max-Age': '86400',
  };
};

const json = (data: unknown, status = 200, cors?: Record<string, string>) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...(cors || buildCorsHeaders()), 'Content-Type': 'application/json' },
  });

// ── Auth helper ─────────────────────────────────────────────────────────────

async function authenticateUser(req: Request): Promise<{ userId: string } | Response> {
  const authHeader = req.headers.get('authorization');
  if (!authHeader) return json({ error: 'Missing authorization' }, 401);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return json({ error: 'Unauthorized' }, 401);
  return { userId: user.id };
}

function getServiceClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ── Data fetchers ───────────────────────────────────────────────────────────

async function listReports(userId: string, params: Record<string, unknown>) {
  const sb = getServiceClient();
  const limit = Math.min(Number(params.limit) || 50, 200);
  const offset = Number(params.offset) || 0;

  const { data, error } = await sb
    .from('ai_employee_tasks')
    .select('id, title, status, workflow_type, created_at, updated_at, source_type')
    .eq('user_id', userId)
    .in('status', ['succeeded', 'review_passed'])
    .order('updated_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return { reports: data || [], total: data?.length || 0, limit, offset };
}

async function getFullReport(userId: string, params: Record<string, unknown>) {
  const taskId = String(params.task_id || '');
  if (!taskId) throw new Error('task_id is required');

  const sb = getServiceClient();

  // Fetch task
  const { data: task, error: taskErr } = await sb
    .from('ai_employee_tasks')
    .select('*')
    .eq('id', taskId)
    .eq('user_id', userId)
    .single();
  if (taskErr || !task) throw new Error('Task not found');

  // Fetch runs
  const { data: runs } = await sb
    .from('ai_employee_runs')
    .select('*')
    .eq('task_id', taskId)
    .order('created_at', { ascending: false })
    .limit(5);

  // Fetch artifacts from latest run
  const latestRunId = runs?.[0]?.id;
  let artifacts: Record<string, unknown>[] = [];
  if (latestRunId) {
    const { data: arts } = await sb
      .from('di_artifacts')
      .select('*')
      .eq('run_id', latestRunId)
      .order('created_at');
    artifacts = arts || [];
  }

  // Fetch review results
  const { data: reviews } = await sb
    .from('ai_review_results')
    .select('*')
    .eq('task_id', taskId)
    .order('revision_round');

  // Fetch agent loop steps
  const { data: steps } = await sb
    .from('agent_loop_steps')
    .select('*')
    .eq('task_id', taskId)
    .order('step_index');

  // Structure output for Excel/PowerBI consumption
  return {
    task: {
      id: task.id,
      title: task.title,
      status: task.status,
      workflow_type: task.workflow_type,
      created_at: task.created_at,
      updated_at: task.updated_at,
      source_type: task.source_type,
    },
    steps: (steps || []).map((s: Record<string, unknown>) => ({
      name: s.step_name,
      status: s.status,
      workflow_type: s.workflow_type,
      started_at: s.started_at,
      finished_at: s.finished_at,
      retry_count: s.retry_count,
    })),
    artifacts: categorizeArtifacts(artifacts),
    reviews: (reviews || []).map((r: Record<string, unknown>) => ({
      step_name: r.step_name,
      round: r.revision_round,
      score: r.score,
      passed: r.passed,
      threshold: r.threshold,
      feedback: r.feedback,
      categories: r.categories,
      suggestions: r.suggestions,
      reviewer_model: r.reviewer_model,
    })),
    kpis: extractKPIs(artifacts),
  };
}

async function getMonthlyReport(userId: string, params: Record<string, unknown>) {
  const month = Number(params.month) || new Date().getMonth() + 1;
  const year = Number(params.year) || new Date().getFullYear();

  const startDate = new Date(year, month - 1, 1).toISOString();
  const endDate = new Date(year, month, 0, 23, 59, 59).toISOString();

  const sb = getServiceClient();

  // Get all completed tasks for the month
  const { data: tasks } = await sb
    .from('ai_employee_tasks')
    .select('id, title, status, workflow_type, created_at, updated_at')
    .eq('user_id', userId)
    .gte('created_at', startDate)
    .lte('created_at', endDate)
    .in('status', ['succeeded', 'review_passed'])
    .order('created_at');

  // Get review scores for the month
  const taskIds = (tasks || []).map((t: Record<string, unknown>) => t.id);
  let reviews: Record<string, unknown>[] = [];
  if (taskIds.length > 0) {
    const { data } = await sb
      .from('ai_review_results')
      .select('task_id, step_name, score, passed, revision_round')
      .in('task_id', taskIds);
    reviews = data || [];
  }

  // Get cost summary
  let costRuns: Record<string, unknown>[] = [];
  if (taskIds.length > 0) {
    const { data } = await sb
      .from('task_model_runs')
      .select('task_id, estimated_cost, capability_tier, model_name')
      .in('task_id', taskIds);
    costRuns = data || [];
  }

  const totalCost = costRuns.reduce((sum, r) => sum + (Number((r as Record<string, unknown>).estimated_cost) || 0), 0);
  const avgScore = reviews.length > 0
    ? reviews.reduce((sum, r) => sum + (Number((r as Record<string, unknown>).score) || 0), 0) / reviews.length
    : 0;

  return {
    period: { year, month, start: startDate, end: endDate },
    summary: {
      total_tasks: tasks?.length || 0,
      total_cost: Math.round(totalCost * 10000) / 10000,
      avg_review_score: Math.round(avgScore * 10) / 10,
      pass_rate: reviews.length > 0
        ? Math.round(reviews.filter((r) => (r as Record<string, unknown>).passed).length / reviews.length * 100)
        : 0,
    },
    tasks: tasks || [],
    reviews,
    cost_breakdown: aggregateCosts(costRuns),
  };
}

async function getKPIs(userId: string, params: Record<string, unknown>) {
  const taskId = String(params.task_id || '');
  if (!taskId) throw new Error('task_id is required');

  const sb = getServiceClient();
  const { data: artifacts } = await sb
    .from('di_artifacts')
    .select('artifact_type, payload')
    .eq('task_id', taskId)
    .in('artifact_type', ['metrics', 'solver_meta', 'risk_solver_meta', 'constraint_check']);

  return { kpis: extractKPIs(artifacts || []) };
}

async function getForecast(userId: string, params: Record<string, unknown>) {
  const taskId = String(params.task_id || '');
  if (!taskId) throw new Error('task_id is required');

  const sb = getServiceClient();
  const { data } = await sb
    .from('di_artifacts')
    .select('payload, created_at')
    .eq('task_id', taskId)
    .in('artifact_type', ['forecast_series', 'forecast_csv'])
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  return { forecast: data?.payload || null };
}

async function getPlan(userId: string, params: Record<string, unknown>) {
  const taskId = String(params.task_id || '');
  if (!taskId) throw new Error('task_id is required');

  const sb = getServiceClient();
  const { data } = await sb
    .from('di_artifacts')
    .select('payload, created_at')
    .eq('task_id', taskId)
    .in('artifact_type', ['plan_table', 'risk_plan_table', 'plan_csv'])
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  return { plan: data?.payload || null };
}

async function getRisk(userId: string, params: Record<string, unknown>) {
  const taskId = String(params.task_id || '');
  if (!taskId) throw new Error('task_id is required');

  const sb = getServiceClient();
  const { data } = await sb
    .from('di_artifacts')
    .select('payload, created_at')
    .eq('task_id', taskId)
    .in('artifact_type', ['risk_adjustments', 'risk_solver_meta'])
    .order('created_at', { ascending: false });

  return { risk: (data || []).map((d: Record<string, unknown>) => d.payload) };
}

async function getReviewData(userId: string, params: Record<string, unknown>) {
  const taskId = String(params.task_id || '');
  if (!taskId) throw new Error('task_id is required');

  const sb = getServiceClient();
  const { data } = await sb
    .from('ai_review_results')
    .select('*')
    .eq('task_id', taskId)
    .order('step_name, revision_round');

  return { reviews: data || [] };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function categorizeArtifacts(artifacts: Record<string, unknown>[]) {
  const categories: Record<string, unknown[]> = {
    forecast: [],
    plan: [],
    risk: [],
    metrics: [],
    report: [],
    other: [],
  };

  for (const art of artifacts) {
    const type = String(art.artifact_type || '');
    if (type.includes('forecast')) categories.forecast.push(art.payload);
    else if (type.includes('plan')) categories.plan.push(art.payload);
    else if (type.includes('risk')) categories.risk.push(art.payload);
    else if (type.includes('metric') || type.includes('solver')) categories.metrics.push(art.payload);
    else if (type.includes('report')) categories.report.push(art.payload);
    else categories.other.push({ type, payload: art.payload });
  }

  return categories;
}

function extractKPIs(artifacts: Record<string, unknown>[]) {
  const kpis: Record<string, unknown> = {};

  for (const art of artifacts) {
    const payload = (art.payload || art) as Record<string, unknown>;
    const type = String(art.artifact_type || '');

    if (type === 'metrics' || type === 'solver_meta') {
      Object.assign(kpis, flattenForKPI(payload));
    }
  }

  return kpis;
}

function flattenForKPI(obj: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      Object.assign(result, flattenForKPI(val as Record<string, unknown>, fullKey));
    } else {
      result[fullKey] = val;
    }
  }
  return result;
}

function aggregateCosts(runs: Record<string, unknown>[]) {
  const byTier: Record<string, { cost: number; calls: number }> = {};
  const byModel: Record<string, { cost: number; calls: number }> = {};

  for (const run of runs) {
    const r = run as Record<string, unknown>;
    const tier = String(r.capability_tier || 'unknown');
    const model = String(r.model_name || 'unknown');
    const cost = Number(r.estimated_cost) || 0;

    if (!byTier[tier]) byTier[tier] = { cost: 0, calls: 0 };
    byTier[tier].cost += cost;
    byTier[tier].calls += 1;

    if (!byModel[model]) byModel[model] = { cost: 0, calls: 0 };
    byModel[model].cost += cost;
    byModel[model].calls += 1;
  }

  return { by_tier: byTier, by_model: byModel };
}

// ── Action router ───────────────────────────────────────────────────────────

type ActionHandler = (userId: string, params: Record<string, unknown>) => Promise<unknown>;

const ACTIONS: Record<string, ActionHandler> = {
  list_reports: listReports,
  get_report: getFullReport,
  get_monthly: getMonthlyReport,
  get_kpis: getKPIs,
  get_forecast: getForecast,
  get_plan: getPlan,
  get_risk: getRisk,
  get_review: getReviewData,
};

// ── Main handler ────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const cors = buildCorsHeaders(req.headers.get('origin'));

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed. Use POST.' }, 405, cors);
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'Server not configured' }, 500, cors);
  }

  // Auth
  const authResult = await authenticateUser(req);
  if (authResult instanceof Response) {
    Object.entries(cors).forEach(([k, v]) => authResult.headers.set(k, v));
    return authResult;
  }
  const { userId } = authResult;

  // Parse body
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400, cors);
  }

  const action = String(body.action || '');
  const handler = ACTIONS[action];
  if (!handler) {
    return json({
      error: `Unknown action: "${action}"`,
      available_actions: Object.keys(ACTIONS),
    }, 400, cors);
  }

  try {
    const t0 = performance.now();
    const result = await handler(userId, body);
    const elapsed = Math.round(performance.now() - t0);
    console.info(`[report-api] action=${action} user=${userId.slice(0, 8)} ${elapsed}ms`);

    return json({ ok: true, action, data: result }, 200, cors);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[report-api] action=${action} error:`, message);
    return json({ error: message }, 500, cors);
  }
});
