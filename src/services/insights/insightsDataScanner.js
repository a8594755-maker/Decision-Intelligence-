/**
 * insightsDataScanner.js — LLM-Driven Health Check for Insights Pipeline
 *
 * Step 2 of the pipeline: Quick health check.
 * LLM reads the schema and writes diagnostic SQL queries.
 * DuckDB executes them (validates SQL — rejects bad column names).
 * Deterministic tools analyze results (computeStats, threshold checks).
 *
 * Zero hardcoded SQL. Schema-agnostic. Adapts to any data structure.
 */

import { executeQuery, probeTables, buildEnrichedSchemaPrompt } from '../sap-erp/sapDataQueryService';
import { computeStats } from '../forecast/anomalyDetectionService';
import { invokeAiProxy } from '../ai-infra/aiProxyService';
import { getAgentToolMode } from '../agent-core/chatAgentLoop';

// ── LLM call helper (reuses same pattern as insightsHubAgent) ───────────────

async function callHealthCheckLLM(messages, { model, provider } = {}) {
  const toolMode = getAgentToolMode(provider);
  const result = await invokeAiProxy(toolMode, {
    messages,
    model,
    temperature: 0.2,
    maxOutputTokens: 2048,
  });
  const msg = result?.choices?.[0]?.message || null;
  if (msg && (!msg.content || msg.content.length === 0) && msg.reasoning_content) {
    msg.content = msg.reasoning_content;
  }
  return msg?.content || '';
}

// ── Health Check Prompt ─────────────────────────────────────────────────────

const HEALTH_CHECK_PROMPT = `You are a data health check agent. Given a database schema, write 5-8 diagnostic SQL queries that a data analyst would run FIRST to understand the health of this business.

## Focus Areas
- Key metrics: totals, averages, rates (total revenue, avg order value, on-time delivery rate)
- Trend detection: aggregate by month/period, detect if latest period differs from historical
- Concentration: top-N share analysis (top sellers, top categories by revenue)
- Data quality: null rates, date ranges, row counts

## DuckDB SQL Rules
- Timestamps are ISO strings → use ::TIMESTAMP. NO FROM_UNIXTIME. NO TO_CHAR. Use STRFTIME.
- DATE_TRUNC('month', col::TIMESTAMP), STRFTIME(col::TIMESTAMP, '%Y-%m')
- Date diff: DATEDIFF('day', start::TIMESTAMP, end::TIMESTAMP). NO julianday().
- ALWAYS use table aliases on ALL columns in JOINs
- Window functions CANNOT be in GROUP BY — use subquery/CTE
- Do NOT end SQL with semicolons

## Output Format
Return ONLY a JSON array:
[
  {
    "id": "revenue_trend",
    "title": "Monthly Revenue Trend",
    "sql": "SELECT STRFTIME(o.order_purchase_timestamp::TIMESTAMP, '%Y-%m') AS month, ROUND(SUM(oi.price), 2) AS revenue FROM orders o JOIN order_items oi ON o.order_id = oi.order_id WHERE o.order_status NOT IN ('canceled', 'unavailable') GROUP BY month ORDER BY month",
    "metric_type": "trend"
  }
]

metric_type must be one of: "trend", "rate", "concentration", "count", "average"

## Rules
- ONLY query tables listed as having data
- Skip empty tables entirely
- Each SQL must be a complete, executable SELECT
- Keep queries simple — this is a quick scan, not deep analysis`;

// ── Deterministic Analysis ──────────────────────────────────────────────────

function analyzeTrend(rows, valueKey) {
  if (!rows?.length || rows.length < 3) return null;
  const values = rows.map(r => {
    const v = r[valueKey] ?? r.value ?? r.revenue ?? r.count ?? r.total;
    return typeof v === 'number' ? v : parseFloat(v);
  }).filter(v => !isNaN(v));
  if (values.length < 3) return null;

  const stats = computeStats(values);
  if (!stats || stats.std === 0) return null;

  const latest = values[values.length - 1];
  const z = (latest - stats.mean) / stats.std;
  const severity = Math.abs(z) > 3 ? 'critical' : Math.abs(z) > 2 ? 'high' : Math.abs(z) > 1.5 ? 'medium' : 'low';

  return { z_score: Math.round(z * 100) / 100, mean: Math.round(stats.mean * 100) / 100, latest, severity, data_points: values.length };
}

function analyzeRate(rows) {
  if (!rows?.length) return null;
  const r = rows[0];
  // Try to find a rate/percentage value
  const rateKeys = Object.keys(r).filter(k => /rate|pct|percent|ratio|share/i.test(k));
  const countKeys = Object.keys(r);

  let value = null;
  if (rateKeys.length > 0) {
    value = parseFloat(r[rateKeys[0]]);
  } else if (r.on_time != null && r.total != null) {
    value = (r.on_time / r.total) * 100;
  } else if (r.late_count != null && r.total_delivered != null) {
    value = ((r.total_delivered - r.late_count) / r.total_delivered) * 100;
  }

  if (value == null || isNaN(value)) return null;
  const severity = value < 60 ? 'critical' : value < 75 ? 'high' : value < 85 ? 'medium' : 'low';
  return { value: Math.round(value * 100) / 100, severity };
}

function analyzeConcentration(rows) {
  if (!rows?.length || rows.length < 2) return null;
  // Find the numeric value column
  const numKeys = Object.keys(rows[0]).filter(k => {
    const v = rows[0][k];
    return typeof v === 'number' && v > 0;
  });
  if (!numKeys.length) return null;

  const valueKey = numKeys.find(k => /revenue|total|sum|value|amount/i.test(k)) || numKeys[0];
  const total = rows.reduce((s, r) => s + (parseFloat(r[valueKey]) || 0), 0);
  if (total <= 0) return null;

  const top3 = rows.slice(0, 3).reduce((s, r) => s + (parseFloat(r[valueKey]) || 0), 0);
  const share = Math.round((top3 / total) * 100);
  const severity = share >= 80 ? 'critical' : share >= 65 ? 'high' : share >= 50 ? 'medium' : 'low';

  return { top3_share: share, total_entities: rows.length, severity };
}

function analyzeCountOrAverage(rows) {
  if (!rows?.length) return null;
  const r = rows[0];
  const numKeys = Object.keys(r).filter(k => typeof r[k] === 'number' || !isNaN(parseFloat(r[k])));
  if (!numKeys.length) return null;

  const summary = {};
  for (const k of numKeys) {
    summary[k] = typeof r[k] === 'number' ? r[k] : parseFloat(r[k]);
  }
  return { ...summary, severity: 'low' };
}

function analyzeResult(diagnostic, rows) {
  switch (diagnostic.metric_type) {
    case 'trend': {
      // Find the value column (not the period/month column)
      const valueKey = Object.keys(rows[0] || {}).find(k => {
        const v = rows[0][k];
        return typeof v === 'number' && !/month|date|period|year/i.test(k);
      }) || 'value';
      return analyzeTrend(rows, valueKey);
    }
    case 'rate':
      return analyzeRate(rows);
    case 'concentration':
      return analyzeConcentration(rows);
    case 'count':
    case 'average':
      return analyzeCountOrAverage(rows);
    default:
      return analyzeCountOrAverage(rows);
  }
}

// ── Table name auto-correction ──────────────────────────────────────────────

const TABLE_FIXES = {
  order_payments: 'payments', order_reviews: 'reviews',
  olist_orders: 'orders', olist_customers: 'customers', olist_order_items: 'order_items',
  olist_products: 'products', olist_sellers: 'sellers', olist_payments: 'payments',
  olist_reviews: 'reviews', product_category_name_translation: 'category_translation',
};
const TABLE_FIX_RE = new RegExp(`\\b(${Object.keys(TABLE_FIXES).join('|')})\\b`, 'gi');

function fixTableNames(sql) {
  return sql.replace(TABLE_FIX_RE, (m) => TABLE_FIXES[m.toLowerCase()] || m);
}

// ── Main Entry ──────────────────────────────────────────────────────────────

/**
 * Run a LLM-driven health check on available data.
 *
 * 1. Probe tables → know what data exists
 * 2. LLM writes diagnostic SQL based on schema
 * 3. DuckDB executes (validates SQL)
 * 4. Deterministic analysis on results
 *
 * @param {object} params
 * @param {string} [params.model] - LLM model for SQL generation
 * @param {string} [params.provider] - LLM provider
 * @returns {Promise<HealthCheckResult>}
 */
export async function runHealthCheck({ model, provider } = {}) {
  const start = Date.now();

  // Step 1: Probe tables
  let probeResult;
  try {
    probeResult = await probeTables();
  } catch (err) {
    console.warn('[healthCheck] probeTables failed:', err?.message);
    return emptyResult(start);
  }

  const tablesWithData = [];
  const tablesEmpty = [];
  for (const t of (probeResult.tables || [])) {
    if (t.loaded && !t.error && !t.is_empty) {
      tablesWithData.push(t.table_name);
    } else {
      tablesEmpty.push(t.table_name);
    }
  }

  if (tablesWithData.length === 0) {
    return emptyResult(start, { tablesEmpty });
  }

  // Step 2: LLM writes diagnostic SQL
  const schema = buildEnrichedSchemaPrompt();
  let diagnosticSpecs = [];
  try {
    const userMsg = `Schema:\n${schema}\n\nTables with data: ${tablesWithData.join(', ')}\nEmpty tables (skip): ${tablesEmpty.join(', ') || 'none'}\n\nWrite 5-8 diagnostic queries.`;
    const response = await callHealthCheckLLM(
      [{ role: 'system', content: HEALTH_CHECK_PROMPT }, { role: 'user', content: userMsg }],
      { model, provider },
    );
    diagnosticSpecs = parseJsonArray(response);
  } catch (err) {
    console.warn('[healthCheck] LLM call failed:', err?.message);
    return emptyResult(start, { tablesWithData, tablesEmpty });
  }

  if (!diagnosticSpecs.length) {
    console.warn('[healthCheck] LLM returned no diagnostics');
    return emptyResult(start, { tablesWithData, tablesEmpty });
  }

  // Step 3: Execute SQL + deterministic analysis
  const diagnostics = [];
  for (const spec of diagnosticSpecs) {
    if (!spec?.sql || !spec?.id) continue;

    try {
      const sql = fixTableNames(spec.sql.replace(/;\s*$/, ''));
      const { rows, error } = await executeQuery({ sql });
      if (error || !rows?.length) {
        console.info(`[healthCheck] ${spec.id}: ${error || 'no rows'}`);
        continue;
      }

      const analysis = analyzeResult(spec, rows);
      if (!analysis) continue;

      diagnostics.push({
        id: spec.id,
        title: spec.title || spec.id,
        metric_type: spec.metric_type || 'count',
        sql,
        raw_result: rows.slice(0, 20), // cap sample for UI
        row_count: rows.length,
        analysis,
      });
    } catch (err) {
      console.info(`[healthCheck] ${spec.id} failed: ${err?.message}`);
      // Skip — don't crash
    }
  }

  // Sort by severity
  const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };
  diagnostics.sort((a, b) =>
    (SEVERITY_RANK[b.analysis?.severity] || 0) - (SEVERITY_RANK[a.analysis?.severity] || 0)
  );

  return {
    diagnostics,
    schema_summary: {
      tables_with_data: tablesWithData,
      tables_empty: tablesEmpty,
      total_tables: tablesWithData.length + tablesEmpty.length,
    },
    timestamp: new Date().toISOString(),
    duration_ms: Date.now() - start,
    fingerprint: hashDiagnostics(diagnostics),
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function emptyResult(start, { tablesWithData = [], tablesEmpty = [] } = {}) {
  return {
    diagnostics: [],
    schema_summary: { tables_with_data: tablesWithData, tables_empty: tablesEmpty, total_tables: tablesWithData.length + tablesEmpty.length },
    timestamp: new Date().toISOString(),
    duration_ms: Date.now() - start,
    fingerprint: 'hc-empty',
  };
}

function parseJsonArray(text) {
  if (!text) return [];
  // Direct parse
  try { const d = JSON.parse(text); if (Array.isArray(d)) return d; } catch { /* */ }
  // Extract from code fence
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fence) { try { const d = JSON.parse(fence[1].trim()); if (Array.isArray(d)) return d; } catch { /* */ } }
  // Extract array from mixed text
  const match = text.match(/\[[\s\S]*\]/);
  if (match) { try { const d = JSON.parse(match[0]); if (Array.isArray(d)) return d; } catch { /* */ } }
  return [];
}

export function hashDiagnostics(diagnostics) {
  if (!diagnostics?.length) return 'hc-empty';
  const key = diagnostics.map(d => `${d.id}:${d.analysis?.severity || 'low'}:${JSON.stringify(d.analysis?.z_score ?? d.analysis?.value ?? d.analysis?.top3_share ?? '')}`).sort().join('|');
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  return `hc-${hash}`;
}

export default { runHealthCheck, hashDiagnostics };
