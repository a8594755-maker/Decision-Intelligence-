// insightsHubAgent.js
// ─────────────────────────────────────────────────────────────────────────────
// Self-sufficient AI Data Analyst for the Insights Hub.
// Outputs a complete HTML dashboard — full creative freedom.
// ─────────────────────────────────────────────────────────────────────────────

import { invokeAiProxy } from '../ai-infra/aiProxyService.js';
import { getAgentToolMode } from '../agent-core/chatAgentLoop.js';
import { datasetProfilesService } from '../data-prep/datasetProfilesService.js';
import { executeQuery, getSchema } from '../sap-erp/sapDataQueryService.js';

// ── Agent Tool Definitions ──────────────────────────────────────────────────

const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_tables',
      description: 'List all queryable SQL tables with columns and descriptions. Call this FIRST — these are the REAL table names for query_data.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_dataset_profile',
      description: 'Get uploaded dataset metadata — column cardinality, distinct values, numeric stats, date ranges. NOTE: table names here are semantic classifications, NOT SQL names. Use list_tables for SQL names.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_data',
      description: 'Run a SQL query (DuckDB syntax). Use table names from list_tables. Examples: "SELECT * FROM orders LIMIT 5", "SELECT DATE_TRUNC(\'month\', order_purchase_timestamp) as month, COUNT(*) as orders, SUM(oi.price) as revenue FROM orders o JOIN order_items oi ON o.order_id = oi.order_id GROUP BY 1 ORDER BY 1".',
      parameters: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'SQL SELECT query (DuckDB syntax)' },
          reason: { type: 'string', description: 'What this query computes' },
        },
        required: ['sql'],
      },
    },
  },
];

// ── Tool Executor ───────────────────────────────────────────────────────────

async function executeTool(name, args, { userId } = {}) {
  switch (name) {
    case 'list_tables': {
      try {
        const schema = await getSchema();
        return (schema.tables || []).map(t => ({
          table: t.table_name,
          description: t.description,
          columns: (t.columns || []).map(c => {
            const desc = t.column_descriptions?.[c];
            return desc ? `${c} — ${desc}` : c;
          }),
        }));
      } catch (err) {
        return { error: `Failed to list tables: ${err.message}` };
      }
    }
    case 'read_dataset_profile': {
      try {
        if (!userId) return { error: 'No userId available' };
        const profiles = await datasetProfilesService.listAll(userId, { limit: 10 });
        return (profiles || []).map(p => {
          const pj = p.profile_json || {};
          return {
            id: p.id,
            sheets: (pj.sheets || []).map(s => ({
              name: s.sheet_name || s.name,
              uploadType: s.upload_type || s.guessed_type,
              rowCount: s.row_count,
              columns: (s.columns || []).map(c => {
                const col = { name: c.column || c.name, type: c.guessed_type };
                if (c.cardinality != null) col.cardinality = c.cardinality;
                if (c.distinct_values?.length) col.distinctValues = c.distinct_values.slice(0, 15);
                else if (c.top_values?.length) col.topValues = c.top_values.slice(0, 10);
                if (c.stats) col.stats = c.stats;
                if (c.date_range) col.dateRange = c.date_range;
                if (c.granularity) col.granularity = c.granularity;
                return col;
              }),
            })),
          };
        });
      } catch (err) {
        return { error: `Failed: ${err.message}` };
      }
    }
    case 'query_data': {
      if (!args?.sql) return { error: 'Missing sql parameter' };
      if (!/^\s*select/i.test(args.sql)) return { error: 'Only SELECT queries allowed' };
      const sql = /limit\s+\d/i.test(args.sql) ? args.sql : `${args.sql} LIMIT 100`;
      try {
        const result = await executeQuery({ sql });
        return { rows: (result.rows || []).slice(0, 100), rowCount: result.rows?.length || 0 };
      } catch (err) {
        return { error: err.message };
      }
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── System Prompt ───────────────────────────────────────────────────────────

const AGENT_SYSTEM_PROMPT = `You are the company's SENIOR DATA ANALYST. You build a complete HTML dashboard from raw data.

## LANGUAGE RULE
ALL output in English. Translate non-English labels. Keep currency symbols (R$, ¥, €) as-is.

## Your Mission
1. EXPLORE — Discover tables, columns, and data values
2. COMPUTE — Query data to calculate KPIs, trends, distributions
3. PRESENT — Build a beautiful HTML dashboard with your findings
4. RECOMMEND — Suggest deeper analyses the user can approve

## Workflow
Call MULTIPLE tools per turn (parallel).

Turn 1: Call list_tables + read_dataset_profile (parallel)
         IMPORTANT: Use table names from list_tables for ALL SQL queries.
Turn 2: Call query_data 3-5 times to explore and compute key metrics
Turn 3: Call query_data 2-3 more times for additional dimensions
Turn 4: Output the final dashboard

## Analysis Planning
Think like a senior data analyst. Cover ALL relevant dimensions:
  * Executive Summary: total orders, revenue, avg order value, unique customers
  * Time-based: monthly trends, seasonality, YoY comparison
  * Category-based: top categories by revenue/orders
  * Geographic: revenue by state/region
  * Customer: segmentation, retention, purchase frequency
  * Payment: method distribution, installment analysis
  * Quality: review/rating distribution
  * Operations: delivery performance, cancellation rates
  * Seller: top performers, geographic distribution
  * Correlation: delivery time vs rating, price vs rating

## Tools
- list_tables — REAL SQL table names + columns. Call FIRST.
- read_dataset_profile — column metadata (distinct values, stats, date ranges)
- query_data — SQL SELECT (DuckDB syntax). Use table names from list_tables.

## Output Format
Output a JSON object with:
{
  "title": "Dashboard title",
  "subtitle": "Brief context",
  "thinking": "Your analytical reasoning",
  "html": "<full HTML dashboard — see guidelines below>",
  "suggestions": [
    { "title": "Analysis name", "description": "What it reveals", "query": "Full analysis query", "priority": "high|medium|low" }
  ]
}

## HTML Dashboard Guidelines
The "html" field must be a COMPLETE, self-contained HTML document:

- All CSS in <style> tags (no external links)
- Use CSS Grid and Flexbox for layout
- Max width 1400px, centered
- Color palette: #3b82f6 (blue), #6366f1 (indigo), #10b981 (emerald), #f59e0b (amber), #ef4444 (red), #64748b (slate)
- Background: #f8fafc, cards: white with subtle border and shadow
- Typography: system-ui font, sizes 11-28px
- KPIs: large bold numbers with small labels and trend arrows (▲▼)
- Charts: use inline SVG — rect for bars, polyline for lines, circle+path for pie
- Tables: zebra striping, compact rows, sticky headers
- Responsive: works on 1400px width
- Make it information-dense, professional, and visually appealing
- Think Bloomberg Terminal meets Stripe Dashboard

## Suggestions
The "suggestions" array is rendered OUTSIDE the HTML by the app.
Each suggestion needs: title, description, query (complete analysis question), priority.
List ALL analyses you recommend but didn't compute. Be comprehensive.`;

// ── Agent Loop ──────────────────────────────────────────────────────────────

const MAX_ITERATIONS = 10;

function parseAgentOutput(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* not pure JSON */ }
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) { try { return JSON.parse(fenceMatch[1].trim()); } catch { /* */ } }
  // Try extracting JSON with html field
  const jsonMatch = text.match(/\{[\s\S]*"html"[\s\S]*\}/);
  if (jsonMatch) { try { return JSON.parse(jsonMatch[0]); } catch { /* */ } }
  // Fallback: legacy blocks format
  const blocksMatch = text.match(/\{[\s\S]*"blocks"[\s\S]*\}/);
  if (blocksMatch) { try { return JSON.parse(blocksMatch[0]); } catch { /* */ } }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) { try { return JSON.parse(text.slice(start, end + 1)); } catch { /* */ } }
  return null;
}

/**
 * Run the Insights Hub data analyst agent.
 * @returns {Promise<{ html?: string, suggestions?: object[], title?: string, thinking?: string } | null>}
 */
export async function runInsightsAgent({ provider, model, onProgress, userId, signal } = {}) {
  const toolMode = getAgentToolMode(provider);
  const messages = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
    { role: 'user', content: 'Conduct a FULL DATA REVIEW. Call list_tables AND read_dataset_profile in parallel first. Then query the data and build a comprehensive HTML dashboard with suggestions.' },
  ];

  let queryCount = 0;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    if (signal?.aborted) { console.info('[insightsAgent] Aborted'); return null; }

    const waitLabel = iteration === 0
      ? 'Agent is planning data exploration...'
      : queryCount > 0
        ? `Agent is thinking... (${queryCount} queries completed)`
        : 'Agent is analyzing...';
    onProgress?.(waitLabel);
    console.info(`[insightsAgent] Iteration ${iteration + 1}/${MAX_ITERATIONS} — calling ${toolMode} (${model})`);

    const result = await invokeAiProxy(toolMode, {
      messages, tools: AGENT_TOOLS, model,
      toolChoice: 'auto', temperature: 0.3, maxOutputTokens: 16384,
    });

    const assistantMsg = result?.choices?.[0]?.message;
    if (!assistantMsg) {
      if (result?.text) {
        const parsed = parseAgentOutput(result.text);
        if (parsed?.html || parsed?.blocks?.length) return parsed;
      }
      console.warn('[insightsAgent] No assistant message');
      return null;
    }

    const toolCalls = assistantMsg.tool_calls || [];

    if (toolCalls.length > 0) {
      messages.push({ role: 'assistant', content: assistantMsg.content || null, tool_calls: toolCalls });

      for (const tc of toolCalls) {
        if (signal?.aborted) return null;
        const fnName = tc.function?.name;
        let fnArgs = {};
        try { fnArgs = JSON.parse(tc.function?.arguments || '{}'); } catch { /* */ }

        if (fnName === 'query_data') queryCount++;
        const toolLabel = fnName === 'query_data'
          ? `[Query ${queryCount}] ${fnArgs.reason || fnArgs.sql?.slice(0, 60) || 'Running SQL...'}`
          : fnName === 'list_tables'
            ? 'Discovering tables...'
            : fnName === 'read_dataset_profile'
              ? 'Reading dataset metadata...'
              : `${fnName}...`;
        onProgress?.(toolLabel);
        console.info(`[insightsAgent] Tool call: ${fnName}(${JSON.stringify(fnArgs).slice(0, 200)})`);

        const toolResult = await executeTool(fnName, fnArgs, { userId });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(toolResult) });
      }
      continue;
    }

    // No tool calls — agent produced final output
    const content = assistantMsg.content || '';
    if (content) {
      onProgress?.('Building dashboard...');
      const parsed = parseAgentOutput(content);
      if (parsed?.html || parsed?.blocks?.length) {
        console.info(`[insightsAgent] Dashboard produced after ${iteration + 1} iterations (${queryCount} queries)`);
        return parsed;
      }
    }

    console.warn('[insightsAgent] Non-dashboard output after', iteration + 1, 'iterations');
    return null;
  }

  console.warn(`[insightsAgent] Exceeded ${MAX_ITERATIONS} iterations`);
  return null;
}
