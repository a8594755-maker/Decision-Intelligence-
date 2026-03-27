// insightsHubAgent.js — v2 Separated Pipeline
// ─────────────────────────────────────────────────────────────────────────────
// Phase 1: PLANNER  — DeepSeek Reasoner plans 4 cards + SQL queries
// Phase 2: DATA WORKERS — 4 parallel workers run SQL, return JSON data
// Phase 3: CHART WORKER — 1 dedicated worker generates all SVG charts
// Phase 4: ASSEMBLER — 1 agent composes final HTML dashboard
// ─────────────────────────────────────────────────────────────────────────────

import { invokeAiProxy, invokeAiProxyAsync } from '../ai-infra/aiProxyService.js';
import { getAgentToolMode } from '../agent-core/chatAgentLoop.js';
import { executeQuery, buildEnrichedSchemaPrompt } from '../sap-erp/sapDataQueryService.js';
// getInsightsChartModelConfig removed — SVG chart generation no longer used

const TODAY = new Date().toISOString().slice(0, 10);

// ── Shared: DuckDB query tool ───────────────────────────────────────────────

const QUERY_TOOL = {
  type: 'function',
  function: {
    name: 'query_data',
    description: 'Run a SQL query (DuckDB). Returns rows.',
    parameters: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'SQL SELECT query' },
        reason: { type: 'string', description: 'What this computes' },
      },
      required: ['sql'],
    },
  },
};

// Auto-correct common wrong table names before SQL hits DuckDB
const TABLE_FIXES = {
  order_payments: 'payments', order_reviews: 'reviews', order_review: 'reviews',
  olist_orders: 'orders', olist_customers: 'customers', olist_order_items: 'order_items',
  olist_products: 'products', olist_sellers: 'sellers', olist_payments: 'payments',
  olist_reviews: 'reviews', product_category_name_translation: 'category_translation',
};
const TABLE_FIX_RE = new RegExp(`\\b(${Object.keys(TABLE_FIXES).join('|')})\\b`, 'gi');

function fixTableNames(sql) {
  return sql.replace(TABLE_FIX_RE, (m) => TABLE_FIXES[m.toLowerCase()] || m);
}

async function execQueryTool(args) {
  if (!args?.sql) return { error: 'Missing sql' };
  if (!/^\s*select/i.test(args.sql)) return { error: 'Only SELECT allowed' };
  const raw = fixTableNames(args.sql).replace(/;\s*$/, ''); // strip trailing semicolons
  const sql = /limit\s+\d/i.test(raw) ? raw : `${raw} LIMIT 50`;
  try {
    const result = await executeQuery({ sql });
    return { rows: (result.rows || []).slice(0, 50), rowCount: result.rows?.length || 0 };
  } catch (err) {
    const msg = err.message || '';
    if (/from_unixtime/i.test(msg))
      return { error: msg, fix: 'Use ::TIMESTAMP cast. Example: DATE_TRUNC(\'month\', col::TIMESTAMP)' };
    if (/to_char|date_format/i.test(msg))
      return { error: msg, fix: 'DuckDB has no TO_CHAR/DATE_FORMAT. Use STRFTIME(col::TIMESTAMP, \'%Y-%m\').' };
    if (/julianday/i.test(msg))
      return { error: msg, fix: 'DuckDB has no julianday(). Use DATEDIFF(\'day\', start::TIMESTAMP, end::TIMESTAMP) for day differences.' };
    if (/must appear in the GROUP BY/i.test(msg)) {
      // Auto-fix attempts for GROUP BY errors
      const hasCase = /CASE\s+WHEN/i.test(args.sql);
      if (hasCase) {
        // Attempt 1: Replace GROUP BY with GROUP BY 1
        const fix1 = args.sql.replace(/GROUP BY\s+(?:CASE[\s\S]*?END|[a-z_.]+\s*(?:,\s*[a-z_.]+)*)/i, 'GROUP BY 1');
        if (fix1 !== args.sql) {
          try {
            const r = await executeQuery({ sql: fix1.replace(/;\s*$/, '') + (!/limit\s+\d/i.test(fix1) ? ' LIMIT 50' : '') });
            return { rows: (r.rows || []).slice(0, 50), rowCount: r.rows?.length || 0, autoFixed: true };
          } catch { /* try next */ }
        }
        // Attempt 2: Wrap in subquery — move raw columns to inner query, CASE to outer
        // This handles: SELECT CASE WHEN col=1 THEN 'A' END, COUNT(*) FROM t GROUP BY 1
        // → SELECT grp, cnt FROM (SELECT col, COUNT(*) as cnt FROM t GROUP BY col) sub
        // Too complex to auto-fix reliably, just give better hint
      }
      return { error: msg, fix: 'DuckDB requires all columns referenced in CASE to be in GROUP BY. Use a subquery: SELECT CASE WHEN col... END as label, COUNT(*) FROM (SELECT col FROM table GROUP BY col) t GROUP BY 1. Or add the raw column to GROUP BY.' };
    }
    if (/table with name.*does not exist/i.test(msg))
      return { error: msg, fix: 'Available tables: customers, orders, order_items, payments, reviews, products, sellers, geolocation, category_translation.' };
    if (/customer_unique_id.*not found/i.test(msg))
      return { error: msg, fix: 'customer_unique_id is in "customers" table. JOIN: orders o JOIN customers c ON o.customer_id=c.customer_id, then c.customer_unique_id.' };
    if (/ambiguous reference/i.test(msg)) {
      const fixedSql = args.sql
        .replace(/\bCOUNT\(DISTINCT order_id\)/gi, 'COUNT(DISTINCT o.order_id)')
        .replace(/(?<![.\w])price(?!\w)/g, 'oi.price')
        .replace(/(?<![.\w])freight_value(?!\w)/g, 'oi.freight_value')
        .replace(/(?<![.\w])payment_value(?!\w)/g, 'p.payment_value')
        .replace(/(?<![.\w])order_purchase_timestamp/g, 'o.order_purchase_timestamp')
        .replace(/(?<![.\w])customer_unique_id/g, 'c.customer_unique_id');
      if (fixedSql !== args.sql) {
        try {
          const r = await executeQuery({ sql: fixedSql });
          return { rows: (r.rows || []).slice(0, 50), rowCount: r.rows?.length || 0, autoFixed: true };
        } catch { /* fall through */ }
      }
      return { error: msg, fix: 'Use table alias: o.order_id, oi.price, c.customer_unique_id, etc.' };
    }
    return { error: msg };
  }
}

// ── Shared: call LLM ────────────────────────────────────────────────────────

async function callLLM(messages, { tools, model, provider, maxTokens = 4096, temperature = 0.3, async: useAsync = false, onPoll } = {}) {
  const toolMode = getAgentToolMode(provider);
  const payload = {
    messages, tools, model,
    toolChoice: tools ? 'auto' : undefined,
    temperature, maxOutputTokens: maxTokens,
  };
  // Use async mode for long-running calls (chart worker, assembler)
  const result = useAsync
    ? await invokeAiProxyAsync(toolMode, payload, { onPoll, maxWaitMs: 360000 })
    : await invokeAiProxy(toolMode, payload);
  const msg = result?.choices?.[0]?.message || null;
  // DeepSeek Reasoner puts output in reasoning_content when content is empty
  if (msg && (!msg.content || msg.content.length === 0) && msg.reasoning_content) {
    msg.content = msg.reasoning_content;
  }
  return msg;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 1: PLANNER (DeepSeek Reasoner)
// ═══════════════════════════════════════════════════════════════════════════════

const MAX_CARDS = 15;

const PLANNER_PROMPT = `You are a DATA ANALYSIS PLANNER. Plan as many analysis cards as needed for a comprehensive dashboard (max ${MAX_CARDS}).

## Date: ${TODAY}

## DuckDB SQL Rules
- Timestamps are ISO strings → use ::TIMESTAMP. NO FROM_UNIXTIME. NO TO_CHAR. Use STRFTIME.
- DATE_TRUNC('month', col::TIMESTAMP), STRFTIME(col::TIMESTAMP, '%Y-%m')
- Date diff: DATEDIFF('day', start::TIMESTAMP, end::TIMESTAMP). NO julianday().
- ALWAYS use table aliases on ALL columns in JOINs (o.order_id, oi.price, c.customer_unique_id)
- Window functions CANNOT be in GROUP BY — use subquery/CTE instead

## Data Rules
- Unique customers: use c.customer_unique_id (JOIN customers c), NOT customer_id
- Percentages: SUM-based (SUM(x)/SUM(total)*100), NOT COUNT-based
- Delivery: actual < estimated = early = good

## Card types
- "kpi": 3-6 key metrics with values
- "chart_bar": bar/column chart data
- "chart_donut": pie/donut chart data
- "chart_line": line/trend chart data
- "table": ranked table with columns
- "mixed": KPIs + chart + insight text

## Output: JSON array ONLY
[
  {
    "id": "exec_summary",
    "title": "Executive Summary",
    "type": "kpi",
    "queries": [
      "SELECT COUNT(DISTINCT o.order_id) as total_orders, ROUND(SUM(oi.price),0) as revenue FROM orders o JOIN order_items oi ON o.order_id=oi.order_id",
      "SELECT COUNT(DISTINCT customer_unique_id) as unique_customers FROM customers"
    ],
    "instructions": "Show total orders, revenue, unique customers, avg order value, avg review score"
  }
]

## Required First Card
1. id="exec_summary", type="kpi" — Overall KPIs (always include this first)

## Then add as many cards as the data supports. Examples:
- type="chart_line" — Time trends (monthly revenue, orders, customer growth)
- type="chart_bar" — Rankings (top categories, top states, top sellers)
- type="chart_donut" — Distributions (payment methods, order status, review scores)
- type="mixed" — Table + insight (customer segments, delivery performance, seller analysis)
- type="kpi" — Standalone KPI card (repeat rate, cancellation rate, etc.)

## Guidelines
- Cover ALL meaningful dimensions: time, geography, category, payment, delivery, reviews, sellers, customers
- Write COMPLETE SQL with table aliases — workers execute them as-is
- Do NOT end SQL with semicolons
- 2-3 queries per card max
- Each card must analyze a DIFFERENT dimension — no duplicates`;

function buildHealthCheckPrompt(healthCheck) {
  const diagnostics = healthCheck?.diagnostics;
  if (!diagnostics?.length) return '';

  const lines = diagnostics.map((d, i) => {
    const a = d.analysis || {};
    const sevTag = `[${(a.severity || 'low').toUpperCase()}]`;
    let detail = '';
    if (a.z_score != null) detail = `Z-score: ${a.z_score}, mean: ${a.mean}, latest: ${a.latest}`;
    else if (a.top3_share != null) detail = `Top-3 share: ${a.top3_share}%`;
    else if (a.value != null) detail = `Value: ${a.value}`;
    else detail = Object.entries(a).filter(([k]) => k !== 'severity').map(([k, v]) => `${k}: ${v}`).join(', ');
    return `${i + 1}. ${sevTag} ${d.title}\n   ${detail}\n   Source: ${d.sql} (${d.row_count} rows)`;
  });

  return `\n## Health Check Results (verified, deterministic)

The system has run diagnostic queries and computed the following:

${lines.join('\n\n')}

RULES:
- Your dashboard MUST include cards that address the HIGH and CRITICAL findings above
- When referencing a finding, you MUST cite the exact computed value
- Do NOT recompute these metrics — use the values above as ground truth
- Investigate ROOT CAUSES, not just restate the numbers
- For each finding, suggest a concrete action the user can take
- You MAY also include general overview cards`;
}

async function planCards({ provider, model, onProgress, signal, healthCheck }) {
  if (signal?.aborted) return [];
  onProgress?.('Planning analysis...');

  const enriched = buildEnrichedSchemaPrompt();
  const healthBlock = buildHealthCheckPrompt(healthCheck);
  const hasFindings = healthCheck?.diagnostics?.some(d => d.analysis?.severity !== 'low');
  const messages = [
    { role: 'system', content: PLANNER_PROMPT },
    { role: 'user', content: `Schema:\n${enriched}${healthBlock}\n\nPlan a comprehensive dashboard. Include as many cards as the data supports (up to ${MAX_CARDS}).${hasFindings ? ' Prioritize cards that investigate the health check findings above.' : ''}` },
  ];

  console.info('[planner] Requesting card plan...');
  const msg = await callLLM(messages, { model, provider, maxTokens: 4096 });
  const text = msg?.content || '';

  // Parse JSON array
  try {
    const cards = JSON.parse(text);
    if (Array.isArray(cards)) { const c = cards.slice(0, MAX_CARDS); console.info(`[planner] ${c.length} cards${cards.length > MAX_CARDS ? ` (capped from ${cards.length})` : ''}`); return c; }
  } catch { /* */ }
  const match = text.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const cards = JSON.parse(match[0]);
      if (Array.isArray(cards)) { const c = cards.slice(0, MAX_CARDS); console.info(`[planner] ${c.length} cards (extracted${cards.length > MAX_CARDS ? `, capped from ${cards.length}` : ''})`); return c; }
    } catch { /* */ }
  }
  console.warn('[planner] Failed to parse');
  return [];
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 2: DATA WORKERS (parallel, return JSON data — NO HTML)
// ═══════════════════════════════════════════════════════════════════════════════

/** Robust JSON parser for worker output — handles code fences, partial JSON, truncation, HTML fallback */
function parseWorkerJSON(text) {
  if (!text) return null;
  // 1. Direct parse
  try { const d = JSON.parse(text); if (d?.metrics) return d; } catch { /* */ }
  // 2. Code fence
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fence) { try { const d = JSON.parse(fence[1].trim()); if (d?.metrics) return d; } catch { /* */ } }
  // 3. Extract JSON with metrics key
  const m = text.match(/\{[\s\S]*?"metrics"\s*:\s*\[[\s\S]*?\][\s\S]*?\}/);
  if (m) { try { const d = JSON.parse(m[0]); if (d?.metrics) return d; } catch { /* */ } }
  // 4. Fix truncated JSON — try closing brackets/braces
  if (text.includes('"metrics"')) {
    for (const suffix of ['"}]}', '"]}', '"}', '"]}}', '"]}}}']) {
      try { const d = JSON.parse(text.trim() + suffix); if (d?.metrics) return d; } catch { /* */ }
    }
    // Try from first { to end, with repairs
    const start = text.indexOf('{');
    if (start >= 0) {
      let chunk = text.slice(start).trim();
      // Count open/close braces and brackets
      const openB = (chunk.match(/\{/g) || []).length;
      const closeB = (chunk.match(/\}/g) || []).length;
      const openA = (chunk.match(/\[/g) || []).length;
      const closeA = (chunk.match(/\]/g) || []).length;
      // Close unterminated string
      if (chunk.endsWith('\\')) chunk = chunk.slice(0, -1);
      if (!chunk.endsWith('"') && !chunk.endsWith('}') && !chunk.endsWith(']')) chunk += '"';
      chunk += ']'.repeat(Math.max(0, openA - closeA));
      chunk += '}'.repeat(Math.max(0, openB - closeB));
      try { const d = JSON.parse(chunk); if (d?.metrics) return d; } catch { /* */ }
    }
  }
  // 5. If worker returned HTML (old format), wrap as a single metric card
  if (text.includes('<div') || text.includes('<table')) {
    return { metrics: [{ label: 'Analysis', value: 'See details below' }], analysis: 'Worker returned HTML format.', chartData: { type: 'none' }, tableData: null, _rawHtml: text };
  }
  return null;
}

const DATA_WORKER_PROMPT = `You are a DATA ANALYST. Run queries and return structured JSON data.

## DuckDB Rules
- ::TIMESTAMP for dates. NO FROM_UNIXTIME/TO_CHAR/DATE_FORMAT. Use STRFTIME.
- ALWAYS use table aliases: o.order_id, oi.price, c.customer_unique_id, p.payment_value, r.review_score, s.seller_id
- customer_unique_id is in "customers" table (needs JOIN)
- Date diff: DATEDIFF('day', start::TIMESTAMP, end::TIMESTAMP). NO julianday().
- Window functions CANNOT be in GROUP BY — use subquery/CTE
- Do NOT end SQL with semicolons — just the query text

## Card-Specific Rules
- Each card must have UNIQUE metrics — do NOT repeat values from other cards
- exec_summary: overall KPIs only (total orders, revenue, customers, AOV, review score)
- trend cards: time-specific metrics (peak month, growth rate, MoM change)
- category/geography cards: top-N rankings, concentration percentages
- payment/customer cards: segment breakdowns, loyalty rates

## Output: JSON ONLY (no HTML, no markdown)
{
  "metrics": [{ "label": "Total Revenue", "value": "R$ 13.6M", "detail": "from 96K delivered orders" }],
  "analysis": "2-3 sentence insight about what the data shows",
  "chartData": {
    "type": "bar|line|donut|none",
    "title": "Chart Title",
    "labels": ["SP", "RJ", "MG"],
    "values": [5202955, 1824093, 1585308],
    "series2Labels": null,
    "series2Values": null
  },
  "tableData": {
    "columns": ["State", "Revenue", "Orders"],
    "rows": [["SP", "R$ 5.2M", "41K"], ["RJ", "R$ 1.8M", "13K"]]
  }
}

If no chart needed, set chartData.type = "none". If no table needed, set tableData = null.`;

async function buildDataCard(spec, { provider, model, signal, schemaHint }) {
  if (signal?.aborted) return null;
  const t0 = Date.now();
  console.info(`[data:${spec.id}] Starting — ${spec.queries?.length || 0} queries`);

  // Run pre-planned queries
  const qr = {};
  for (const sql of (spec.queries || [])) {
    qr[sql.slice(0, 60)] = await execQueryTool({ sql });
  }
  console.info(`[data:${spec.id}] Queries done in ${Date.now() - t0}ms`);

  // Ask LLM to analyze and structure
  const messages = [
    { role: 'system', content: DATA_WORKER_PROMPT },
    { role: 'user', content: `Card: ${spec.title}\nType: ${spec.type}\nInstructions: ${spec.instructions}\n\nSchema:\n${schemaHint}\n\nQuery Results:\n${JSON.stringify(qr, null, 1)}` },
  ];

  for (let i = 0; i < 8; i++) {
    if (signal?.aborted) break;
    const msg = await callLLM(messages, { tools: [QUERY_TOOL], model, provider, maxTokens: 4096 });
    if (!msg) break;

    // Handle tool calls (extra queries)
    if (msg.tool_calls?.length) {
      messages.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls });
      for (const tc of msg.tool_calls) {
        const args = JSON.parse(tc.function?.arguments || '{}');
        console.info(`[data:${spec.id}] Extra query: ${args.reason || args.sql?.slice(0, 40)}`);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(await execQueryTool(args)) });
      }
      continue;
    }

    // Parse JSON output — robust fallback chain
    const text = msg.content || '';
    const parsed = parseWorkerJSON(text);
    if (parsed) {
      console.info(`[data:${spec.id}] Done — ${parsed.metrics?.length || 0} metrics`);
      return { id: spec.id, title: spec.title, type: spec.type, rawQueries: qr, ...parsed };
    }
    // If not parseable and this is last iteration, break
    if (i >= 7) break;
    // Otherwise inject hint and retry
    messages.push({ role: 'assistant', content: text });
    messages.push({ role: 'user', content: 'Your output was not valid JSON. Return ONLY a JSON object with keys: metrics, analysis, chartData, tableData. No HTML, no markdown.' });
    continue;
  }

  console.warn(`[data:${spec.id}] Failed`);
  return { id: spec.id, title: spec.title, type: spec.type, metrics: [], analysis: 'Data collection failed.', chartData: { type: 'none' }, tableData: null };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 3 (LEGACY — SVG chart generation, no longer used)
// Charts are now rendered client-side via ChartRenderer/CanvasRenderer.
// Keeping assembleLayout() which IS still used for narrative + card ordering.
// ═══════════════════════════════════════════════════════════════════════════════

/* REMOVED: SVG chart generation code (~180 lines)
   - SINGLE_CHART_PROMPT, analyzeChartData(), buildSingleChart(), buildCharts()
   - assembleFallback() (HTML generation)
   Charts now rendered by CanvasRenderer → ChartBlock → ChartRenderer (Recharts)
*/

const _LEGACY_SVG_REMOVED = true; // marker for code archaeology

// ── ASSEMBLER (still used — plans card order + narrative) ────────────────────

const ASSEMBLER_PROMPT = `You are a DASHBOARD LAYOUT PLANNER. Given analysis cards, output a JSON layout.

## Output JSON format ONLY:
{
  "narrative": "2-3 sentence executive summary connecting insights across all cards",
  "sections": [
    { "cardId": "exec_summary", "width": "full" },
    { "cardId": "sales_trend", "width": "half" },
    { "cardId": "top_categories", "width": "half" },
    ...
  ]
}

## Rules
- "narrative" summarizes cross-card insights (trends, risks, opportunities)
- "width": "full" for executive summary and key findings, "half" for analysis cards
- Order: executive summary first, then pair related cards side-by-side
- Use the exact cardId values from the input
- Output ONLY JSON. No code fences. No explanation.`;

async function assembleLayout(dataCards, { provider, model, signal }) {
  console.info('[assembler] Planning layout...');

  const cardList = dataCards.map(c => ({ id: c.id, title: c.title, type: c.type, hasChart: c.chartData?.type !== 'none', hasTable: !!c.tableData }));

  const messages = [
    { role: 'system', content: ASSEMBLER_PROMPT },
    { role: 'user', content: `Plan layout for ${cardList.length} cards:\n${JSON.stringify(cardList, null, 1)}` },
  ];

  try {
    const msg = await callLLM(messages, { model, provider, maxTokens: 2048, temperature: 0.2 });
    const text = msg?.content || '';
    // Parse JSON
    let layout;
    try { layout = JSON.parse(text); } catch {
      const m = text.match(/\{[\s\S]*"narrative"[\s\S]*\}/);
      if (m) layout = JSON.parse(m[0]);
    }
    if (layout?.narrative && layout?.sections) {
      console.info(`[assembler] Layout: ${layout.sections.length} sections`);
      return layout;
    }
  } catch (err) {
    console.warn(`[assembler] LLM layout failed: ${err.message}`);
  }

  // Fallback: default layout
  console.info('[assembler] Using default layout');
  return {
    narrative: '',
    sections: dataCards.map((c, i) => ({ cardId: c.id, width: i === 0 ? 'full' : 'half' })),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 5: REVIEWER — cross-check dashboard claims vs ground truth
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Extract flat metric list from data cards for audit comparison.
 */
export function extractDashboardMetrics(dataCards) {
  const metrics = [];
  for (const card of (dataCards || [])) {
    for (const m of (card.metrics || [])) {
      if (m?.label && m?.value != null) {
        metrics.push({ name: m.label, value: String(m.value), unit: m.unit || '', cardId: card.id, cardTitle: card.title });
      }
    }
  }
  return metrics;
}

/**
 * Compare two metric values with tolerance for rounding/unit differences.
 * Returns 'match' | 'mismatch' | 'cannot_compare'.
 */
export function compareMetricValues(dashVal, truthVal, tolerance = 0.05) {
  const parseNum = (v) => {
    if (typeof v === 'number') return v;
    const s = String(v).replace(/[R$,%\s]/g, '').replace(/,/g, '');
    // Handle M/K suffixes
    if (/[\d.]+M$/i.test(s)) return parseFloat(s) * 1e6;
    if (/[\d.]+K$/i.test(s)) return parseFloat(s) * 1e3;
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : NaN;
  };
  const a = parseNum(dashVal);
  const b = parseNum(truthVal);
  if (isNaN(a) || isNaN(b)) return 'cannot_compare';
  if (b === 0) return a === 0 ? 'match' : 'mismatch';
  return Math.abs(a - b) / Math.abs(b) <= tolerance ? 'match' : 'mismatch';
}

const REVIEWER_PROMPT = `You are a DATA AUDITOR. Your job is to cross-check a dashboard's claims against pre-computed ground truth values.

## Rules
- For each metric in the dashboard, check if a corresponding ground truth value exists.
- A dashboard value matches ground truth if the relative difference is < 5% (rounding, unit formatting differences are acceptable).
- Flag actual discrepancies (wrong number, wrong unit, wrong direction).
- Flag claims that have no ground truth backing ("unverified").
- Do NOT invent corrections — if you cannot verify a claim, mark it as "unverified", not "incorrect".

## Output format (strict JSON, no markdown)
{
  "corrections": [{ "metric": "...", "dashboard_value": "...", "ground_truth_value": "...", "fix": "..." }],
  "warnings": [{ "metric": "...", "issue": "..." }],
  "passed": ["metric_name_1", "metric_name_2"]
}

If everything looks correct, return: { "corrections": [], "warnings": [], "passed": ["all_metrics"] }`;

export async function runReviewerAgent(content, { provider = 'kimi', model = 'kimi-k2.5', onProgress, signal } = {}) {
  if (!content || content.length < 100) return null;

  try {
    onProgress?.('Auditing dashboard accuracy...');
    const msg = await callLLM([
      { role: 'system', content: REVIEWER_PROMPT },
      { role: 'user', content },
    ], { provider, model, maxTokens: 2048, temperature: 0.1 });

    if (!msg?.content) return null;

    // Parse reviewer JSON (reuse robust parsing logic)
    const text = msg.content;
    let parsed = null;
    // Direct parse
    try { parsed = JSON.parse(text); } catch { /* */ }
    // Code fence
    if (!parsed) {
      const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
      if (fence) try { parsed = JSON.parse(fence[1].trim()); } catch { /* */ }
    }
    // Regex extract
    if (!parsed) {
      const m = text.match(/\{[\s\S]*?"corrections"\s*:\s*\[[\s\S]*?\][\s\S]*?\}/);
      if (m) try { parsed = JSON.parse(m[0]); } catch { /* */ }
    }

    if (!parsed || !Array.isArray(parsed.corrections)) {
      console.warn('[reviewer] Could not parse reviewer response');
      return null;
    }

    return {
      corrections: parsed.corrections || [],
      warnings: parsed.warnings || [],
      passed: parsed.passed || [],
    };
  } catch (err) {
    console.warn('[reviewer] Audit failed:', err?.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════════════════════

async function runWithConcurrency(tasks, limit) {
  const results = [];
  const executing = new Set();
  for (const task of tasks) {
    const p = task().then(r => { executing.delete(p); return r; });
    executing.add(p);
    results.push(p);
    if (executing.size >= limit) await Promise.race(executing);
  }
  return Promise.all(results);
}

// ═══════════════════════════════════════════════════════════════════════════════
// BLOCK BUILDER — Converts data worker output → CanvasRenderer block layout
// Pure JS, no LLM. Deterministic transformation.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Convert InsightsChartCard format → ChartRenderer format.
 * InsightsChartCard: { type, title, labels, values, series2Values, series1Name, series2Name }
 * ChartRenderer:     { type, data, xKey, yKey, series, compatibleTypes, tickFormatter }
 */
function convertChartData(cd, fallbackTitle) {
  if (!cd || cd.type === 'none') return null;

  const labels = cd.labels || [];
  const values = cd.values || [];
  const hasSeries2 = cd.series2Values && cd.series2Values.length > 0;

  const data = labels.map((label, i) => {
    const row = { name: String(label), value: Number(values[i]) || 0 };
    if (hasSeries2) row.series2 = Number(cd.series2Values[i]) || 0;
    return row;
  });

  // Map chart type + determine compatible switches
  let type = cd.type;
  let compatibleTypes;
  let series;

  if (type === 'donut') {
    compatibleTypes = ['donut', 'pie', 'bar'];
  } else if (type === 'line') {
    compatibleTypes = ['line', 'area', 'bar'];
    if (hasSeries2) series = ['value', 'series2'];
  } else {
    type = 'bar';
    compatibleTypes = ['bar', 'horizontal_bar', 'donut'];
  }

  return {
    type,
    data,
    xKey: 'name',
    yKey: 'value',
    series,
    title: cd.title || fallbackTitle,
    compatibleTypes,
    tickFormatter: { y: 'compact' },
  };
}

/**
 * Build a CanvasRenderer-compatible block layout from data worker cards + assembler layout.
 */
function buildBlockLayout(dataCards, layout) {
  const blocks = [];
  let row = 1;

  // ── Narrative block (executive summary from assembler) ──
  if (layout?.narrative) {
    blocks.push({
      id: 'narrative', type: 'narrative',
      col: 1, row, colSpan: 12, rowSpan: 1,
      props: { title: 'Executive Summary', text: layout.narrative },
    });
    row++;
  }

  // ── KPI card → metric blocks across top row ──
  const kpiCard = dataCards.find(c => c.type === 'kpi');
  if (kpiCard?.metrics?.length) {
    const count = Math.min(kpiCard.metrics.length, 6); // max 6 metrics per row
    const colSpan = Math.max(2, Math.floor(12 / count));
    for (let i = 0; i < count; i++) {
      const m = kpiCard.metrics[i];
      blocks.push({
        id: `metric_${i}`, type: 'metric',
        col: 1 + i * colSpan, row, colSpan, rowSpan: 1,
        props: { label: m.label, value: m.value, subtitle: m.detail },
      });
    }
    row++;

    // If KPI card has analysis text, add as a small alert/info block
    if (kpiCard.analysis && kpiCard.analysis.length > 30) {
      blocks.push({
        id: 'kpi_insight', type: 'alert',
        col: 1, row, colSpan: 12, rowSpan: 1,
        props: { severity: 'info', title: 'Key Insight', description: kpiCard.analysis },
      });
      row++;
    }
  }

  // ── Remaining cards → chart, table, or narrative blocks ──
  const sections = layout?.sections || dataCards.map((c, i) => ({ cardId: c.id, width: i === 0 ? 'full' : 'half' }));
  const cardMap = Object.fromEntries(dataCards.map(c => [c.id, c]));
  const placed = new Set(kpiCard ? [kpiCard.id] : []);

  let col = 1;
  for (const section of sections) {
    const card = cardMap[section.cardId];
    if (!card || placed.has(card.id)) continue;
    placed.add(card.id);

    const isFull = section.width === 'full';
    const span = isFull ? 12 : 6;

    // Wrap to next row if no space
    if (col + span - 1 > 12) { row += 2; col = 1; }

    const hasChart = card.chartData?.type && card.chartData.type !== 'none';
    const hasTable = card.tableData?.columns?.length > 0;

    if (hasChart) {
      const chart = convertChartData(card.chartData, card.title);
      if (chart) {
        blocks.push({
          id: `chart_${card.id}`, type: 'chart',
          col, row, colSpan: span, rowSpan: 2,
          props: { title: card.title, height: 280, chart, cardId: card.id },
        });
      }
    } else if (hasTable) {
      blocks.push({
        id: `table_${card.id}`, type: 'table',
        col, row, colSpan: span, rowSpan: 2,
        props: { title: card.title, columns: card.tableData.columns, rows: card.tableData.rows },
      });
    } else if (card.metrics?.length) {
      // Card with only metrics (no chart/table) → KPI row
      blocks.push({
        id: `kpirow_${card.id}`, type: 'kpi_row',
        col, row, colSpan: span, rowSpan: 1,
        props: { kpis: card.metrics.map(m => ({ label: m.label, value: m.value, subtitle: m.detail })) },
      });
    }

    col += span;
    if (col > 12) { row += 2; col = 1; }
  }

  // ── Collect analysis texts into findings block ──
  const findings = dataCards
    .filter(c => c.analysis && c.analysis.length > 40 && c.id !== kpiCard?.id)
    .map(c => c.analysis);
  if (findings.length >= 2) {
    if (col !== 1) { row += 2; col = 1; }
    blocks.push({
      id: 'findings', type: 'findings',
      col: 1, row, colSpan: 12, rowSpan: 2,
      props: { title: 'Key Findings', findings },
    });
    row += 2;
  }

  return {
    title: 'Insights Dashboard',
    subtitle: `${dataCards.length} analysis cards · ${blocks.length} blocks · ${TODAY}`,
    thinking: '',
    blocks,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════════════════════

export async function runInsightsAgent({ provider, model, onProgress, userId, signal, healthCheck } = {}) {
  const t0 = Date.now();

  // ── Phase 1: Plan cards (with health check results if available) ──
  onProgress?.('Phase 1: Planning analysis...');
  const specs = await planCards({ provider, model, onProgress, signal, healthCheck });
  if (!specs.length) { console.warn('[insights] No cards planned'); return null; }
  console.info(`[insights] Phase 1 done: ${specs.length} cards planned (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

  // ── Phase 2: Data workers (parallel) ──
  const schemaHint = buildEnrichedSchemaPrompt();
  onProgress?.(`Phase 2: Collecting data (${specs.length} cards)...`);

  let done = 0;
  const dataCards = await runWithConcurrency(
    specs.map(spec => () => {
      return buildDataCard(spec, { provider, model, signal, schemaHint }).then(card => {
        done++;
        onProgress?.(`Phase 2: ${done}/${specs.length} data cards done`);
        return card;
      });
    }),
    4,
  );

  const validCards = dataCards.filter(c => c && c.metrics?.length > 0);
  console.info(`[insights] Phase 2 done: ${validCards.length}/${dataCards.length} cards (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  if (!validCards.length) { console.warn('[insights] No data cards'); return null; }

  // ── Phase 3: Layout assembly (fast — just JSON ordering + narrative) ──
  onProgress?.('Phase 3: Assembling layout...');
  const layout = await assembleLayout(validCards, { provider, model, signal });

  // ── Phase 4: Block builder (deterministic — converts to CanvasRenderer format) ──
  onProgress?.('Phase 4: Building block layout...');
  const blockLayout = buildBlockLayout(validCards, layout);
  console.info(`[insights] Done! ${validCards.length} cards → ${blockLayout.blocks.length} blocks, ${((Date.now() - t0) / 1000).toFixed(0)}s total`);

  return {
    dataCards: validCards,
    layout,
    blockLayout,
    suggestions: [],
    title: 'Insights Dashboard',
    subtitle: blockLayout.subtitle,
    thinking: `Planned ${specs.length} cards → ${validCards.length} data → ${blockLayout.blocks.length} blocks`,
  };
}

// ── Exports for per-card regeneration ────────────────────────────────────────
export { buildDataCard, convertChartData, buildBlockLayout };
