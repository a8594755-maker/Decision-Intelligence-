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
import { getInsightsChartModelConfig } from '../ai-infra/modelConfigService.js';

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

async function planCards({ provider, model, onProgress, signal }) {
  if (signal?.aborted) return [];
  onProgress?.('Planning analysis...');

  const enriched = buildEnrichedSchemaPrompt();
  const messages = [
    { role: 'system', content: PLANNER_PROMPT },
    { role: 'user', content: `Schema:\n${enriched}\n\nPlan a comprehensive dashboard. Include as many cards as the data supports (up to ${MAX_CARDS}).` },
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
      return { id: spec.id, title: spec.title, type: spec.type, ...parsed };
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
// PHASE 3: CHART WORKER (dedicated — generates all SVGs at once)
// ═══════════════════════════════════════════════════════════════════════════════

const SINGLE_CHART_PROMPT = `You generate ONE clean inline SVG chart. Follow the DATA HINTS exactly.

## SVG Foundation
- style="width:100%;max-width:450px;height:auto;" on <svg>
- font-family="system-ui,-apple-system,sans-serif"
- Colors: #6366f1 #8b5cf6 #06b6d4 #10b981 #f59e0b #ef4444 #64748b #a855f7 #ec4899 #14b8a6
- All numeric attributes: plain numbers (x="50" NOT escaped)

## Chart-Type Specific Rules

### Bar Chart
- viewBox="0 0 450 300"
- Plot area: x=60-430, y=20-230. Y-axis labels at x=55 (right-aligned).
- Bar width: max 35px, gap between bars ≥ 5px. If >8 bars, reduce width.
- X-axis labels at y=250, rotated -45° with text-anchor="end" if any label >6 chars.
- Truncate labels to 12 chars + "…" if longer.
- Show value on top of each bar (font-size 9, centered above bar).

### Line Chart
- viewBox="0 0 450 300"
- Plot area: x=60-420, y=30-230.
- DUAL AXIS if series have different magnitudes (>10x difference): left axis for larger, right axis for smaller.
- Data points: small circles r=3 on each point. Hover-friendly.
- Grid lines: light gray (#e2e8f0) horizontal dashed lines at 4-5 intervals.
- X-axis: show every Nth label so no overlap (if >12 points, show every 3rd).
- Legend at bottom with colored line samples.

### Donut Chart
- viewBox="0 0 220 220"
- Center (110,110), outer r=85, inner r=55.
- Center text: main metric value (font-size 18, font-weight bold) + label below (font-size 10).
- Slice labels: percentage on arc if ≥5%, else in legend only.
- Legend below chart, 2 columns if >4 items.

## Output: ONLY raw SVG
Start with <svg, end with </svg>. No JSON. No code fences. No text before/after.`;

/**
 * Analyze chart data and generate rendering hints for the LLM.
 * This makes chart generation data-aware without hardcoding specific datasets.
 */
function analyzeChartData(cd) {
  const hints = [];
  const values = cd.values || [];
  const labels = cd.labels || [];
  const s2 = cd.series2Values || [];

  if (!values.length) return 'No data available.';

  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min;

  // Scale detection
  if (max >= 1_000_000) hints.push(`Y-axis scale: use M (millions). Max value: ${(max/1e6).toFixed(1)}M, Min: ${(min/1e6).toFixed(1)}M`);
  else if (max >= 1_000) hints.push(`Y-axis scale: use K (thousands). Max value: ${(max/1e3).toFixed(1)}K, Min: ${(min/1e3).toFixed(1)}K`);
  else hints.push(`Y-axis range: ${min} to ${max}`);

  // Dual axis detection
  if (s2.length > 0) {
    const max2 = Math.max(...s2);
    const ratio = max / (max2 || 1);
    if (ratio > 10 || ratio < 0.1) {
      hints.push(`DUAL AXIS REQUIRED: Series 1 max=${max}, Series 2 max=${max2} (${Math.round(ratio)}x difference). Use LEFT axis for larger series, RIGHT axis for smaller.`);
    } else {
      hints.push(`Single axis OK: both series are similar scale (ratio ${ratio.toFixed(1)}x).`);
    }
  }

  // Label density
  if (labels.length > 12) hints.push(`${labels.length} labels — show every ${Math.ceil(labels.length / 8)}th label on X-axis to avoid overlap.`);
  const maxLabelLen = Math.max(...labels.map(l => String(l).length));
  if (maxLabelLen > 8) hints.push(`Long labels (max ${maxLabelLen} chars) — rotate -45° and truncate to 10 chars.`);

  // Bar count
  if (cd.type === 'bar' && labels.length > 8) hints.push(`${labels.length} bars — use narrower bars (max 25px width).`);

  // Donut: calculate percentages
  if (cd.type === 'donut') {
    const total = values.reduce((a, b) => a + b, 0);
    const pcts = values.map((v, i) => `${labels[i]}: ${(v / total * 100).toFixed(1)}%`);
    hints.push(`Total: ${total >= 1e6 ? (total/1e6).toFixed(1)+'M' : total >= 1e3 ? (total/1e3).toFixed(1)+'K' : total}. Slices: ${pcts.join(', ')}`);
  }

  // Trend detection for line charts
  if (cd.type === 'line' && values.length >= 3) {
    const first3avg = values.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
    const last3avg = values.slice(-3).reduce((a, b) => a + b, 0) / 3;
    if (last3avg > first3avg * 1.5) hints.push('Trend: strong upward growth.');
    else if (last3avg < first3avg * 0.5) hints.push('Trend: declining.');
    else hints.push('Trend: relatively stable.');
  }

  return hints.join('\n');
}

async function buildSingleChart(card, { provider, model, signal }) {
  const cd = card.chartData;
  if (!cd || cd.type === 'none') return null;

  const dataHints = analyzeChartData(cd);

  const messages = [
    { role: 'system', content: SINGLE_CHART_PROMPT },
    { role: 'user', content: `Chart type: ${cd.type}\nTitle: ${cd.title || card.title}\n\n## DATA HINTS (follow these):\n${dataHints}\n\nLabels: ${JSON.stringify(cd.labels)}\nValues: ${JSON.stringify(cd.values)}${cd.series2Values ? `\nSeries 2 values: ${JSON.stringify(cd.series2Values)}` : ''}` },
  ];

  try {
    // Use chart-specific model (default: deepseek-chat — Reasoner wastes tokens on thinking)
    const chartConfig = getInsightsChartModelConfig();
    const msg = await callLLM(messages, { model: chartConfig.model, provider: chartConfig.provider, maxTokens: 3000, temperature: 0.2 });
    let svg = msg?.content || '';

    // Combine all possible content sources
    const rc = msg?.reasoning_content || '';
    const allContent = [svg, rc].join('\n');
    console.info(`[chart:${card.id}] content=${svg.length}, reasoning=${rc.length}, total=${allContent.length} chars`);

    // Search for SVG in ALL content (content + reasoning_content)
    // DeepSeek Reasoner may put SVG in content mixed with thinking text
    let source = allContent;

    // Strip code fences (any type)
    const fence = source.match(/```(?:svg|xml|html|json)?\s*\n?([\s\S]*?)```/);
    if (fence) source = fence[1].trim();

    // Try JSON wrapper
    if (!source.includes('<svg') && source.includes('"svg"')) {
      try { const obj = JSON.parse(source); if (obj?.svg) source = obj.svg; } catch { /* */ }
    }

    // Extract SVG element from anywhere in the text
    const svgMatch = source.match(/<svg[\s\S]*?<\/svg>/i);
    if (svgMatch) {
      const clean = svgMatch[0]
        .replace(/\\"/g, '"')
        .replace(/\\n/g, '\n')
        .replace(/="\\+(\d[^"]*?)\\+"/g, '="$1"');
      console.info(`[chart:${card.id}] Generated ${clean.length} chars`);
      return [card.id, clean];
    }

    // Last resort: check if content has SVG-like tokens but malformed
    const hasSvgTokens = source.includes('viewBox') || source.includes('<rect') || source.includes('<circle') || source.includes('<path');
    console.warn(`[chart:${card.id}] No <svg>...</svg> found (${source.length} chars, hasSvgTokens=${hasSvgTokens})`);
    if (hasSvgTokens) {
      // Try wrapping fragments
      const fragStart = source.indexOf('<');
      const fragEnd = source.lastIndexOf('>') + 1;
      if (fragStart >= 0 && fragEnd > fragStart) {
        const frag = source.slice(fragStart, fragEnd);
        if (!frag.startsWith('<svg')) {
          const wrapped = `<svg viewBox="0 0 400 250" style="width:100%;max-width:400px;height:auto;" xmlns="http://www.w3.org/2000/svg">${frag}</svg>`;
          console.info(`[chart:${card.id}] Wrapped SVG fragments: ${wrapped.length} chars`);
          return [card.id, wrapped];
        }
      }
    }
  } catch (err) {
    console.warn(`[chart:${card.id}] Failed: ${err.message}`);
  }
  return null;
}

async function buildCharts(dataCards, { provider, model, signal }) {
  const needed = dataCards.filter(c => c.chartData?.type && c.chartData.type !== 'none');
  if (!needed.length) return {};

  console.info(`[charts] Generating ${needed.length} charts (parallel, max 2)`);
  const results = await runWithConcurrency(
    needed.map(card => () => buildSingleChart(card, { provider, model, signal })),
    2,
  );
  const charts = Object.fromEntries(results.filter(Boolean));
  console.info(`[charts] ${Object.keys(charts).length}/${needed.length} charts generated`);
  return charts;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 4: ASSEMBLER (composes final HTML dashboard)
// ═══════════════════════════════════════════════════════════════════════════════

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

function assembleFallback(dataCards, charts) {
  const cards = dataCards.map(c => {
    // If worker returned raw HTML, use it directly
    if (c._rawHtml) {
      return `<div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:20px;">
        <h3 style="font:600 15px system-ui;color:#1e293b;margin:0 0 12px;">${c.title}</h3>
        ${c._rawHtml}${charts[c.id] || ''}
      </div>`;
    }

    const metricsHtml = (c.metrics || []).map(m =>
      `<div style="flex:1;min-width:120px;"><div style="font-size:11px;color:#64748b;">${m.label}</div><div style="font-size:20px;font-weight:700;color:#1e293b;">${m.value}</div>${m.detail ? `<div style="font-size:10px;color:#94a3b8;">${m.detail}</div>` : ''}</div>`
    ).join('');

    const chartHtml = charts[c.id] || '';

    const tableHtml = c.tableData ? `<table style="width:100%;border-collapse:collapse;font-size:11px;margin-top:12px;">
      <tr>${c.tableData.columns.map(col => `<th style="text-align:left;padding:6px;background:#f1f5f9;font-weight:600;color:#475569;">${col}</th>`).join('')}</tr>
      ${c.tableData.rows.map(row => `<tr>${row.map(cell => `<td style="padding:4px 6px;border-bottom:1px solid #f1f5f9;">${cell}</td>`).join('')}</tr>`).join('')}
    </table>` : '';

    const analysisHtml = c.analysis ? `<p style="font-size:12px;color:#475569;margin-top:12px;padding:8px;background:#f0fdf4;border-left:3px solid #10b981;border-radius:4px;">${c.analysis}</p>` : '';

    return `<div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:20px;${c.type === 'kpi' ? 'grid-column:span 2;' : ''}">
      <h3 style="font:600 15px system-ui;color:#1e293b;margin:0 0 12px;">${c.title}</h3>
      <div style="display:flex;gap:16px;flex-wrap:wrap;">${metricsHtml}</div>
      ${chartHtml}${tableHtml}${analysisHtml}
    </div>`;
  }).join('\n');

  return `<!DOCTYPE html><html><head><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;background:#f8fafc;color:#1e293b;padding:24px;max-width:1200px;margin:0 auto}
h1{font-size:22px;font-weight:700}
.sub{font-size:12px;color:#64748b;margin-bottom:20px}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}
@media(max-width:768px){.grid{grid-template-columns:1fr}}
svg{max-width:100%;height:auto}
</style></head><body>
<h1>Insights Dashboard</h1>
<p class="sub">Generated by AI Data Analyst · ${TODAY}</p>
<div class="grid">${cards}</div>
</body></html>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 5: REVIEWER (Kimi K2.5) — kept for future use
// ═══════════════════════════════════════════════════════════════════════════════

export async function runReviewerAgent(html, { provider = 'kimi', model = 'kimi-k2.5', onProgress, signal } = {}) {
  if (!html || html.length < 200) return null;
  // ... reviewer implementation unchanged, will wire in later
  return null;
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

export async function runInsightsAgent({ provider, model, onProgress, userId, signal } = {}) {
  const t0 = Date.now();

  // ── Phase 1: Plan 4 cards ──
  onProgress?.('Phase 1: Planning analysis...');
  const specs = await planCards({ provider, model, onProgress, signal });
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
  console.info(`[insights] Done! ${validCards.length} cards, ${((Date.now() - t0) / 1000).toFixed(0)}s total`);

  return {
    dataCards: validCards,
    layout,
    suggestions: [],
    title: 'Insights Dashboard',
    subtitle: `${validCards.length} analysis cards · ${TODAY}`,
    thinking: `Planned ${specs.length} cards → ${validCards.length} data collected → layout assembled`,
  };
}
