/**
 * sapQueryChatHandler.js
 *
 * Handles QUERY_DATA intent by:
 *   1. Translating the user's natural language question into SQL
 *   2. Executing the SQL via sapDataQueryService
 *   3. Returning structured results for chat display
 *
 * This bypasses the agent loop for data queries — more reliable than
 * waiting for the LLM to spontaneously call tools.
 */

import { SAP_TABLE_REGISTRY, executeQuery } from './sapDataQueryService.js';
import { invokeAiProxy } from './aiProxyService.js';
import { inferChartSpec, getCompatibleTypes } from './chartSpecInference.js';

const AGENT_CHAT_MODEL = import.meta.env.VITE_DI_CHAT_MODEL || 'gpt-5.4';

/**
 * Build a concise schema summary for the SQL generation prompt.
 */
function buildSchemaPrompt() {
  const lines = Object.entries(SAP_TABLE_REGISTRY).map(([name, entry]) => {
    return `- ${name} (${entry.sapEquivalent}): ${entry.columns.join(', ')}`;
  });
  return lines.join('\n');
}

/**
 * Use LLM to translate a natural language question into SQL.
 */
async function generateSql(userMessage) {
  const schema = buildSchemaPrompt();

  const systemPrompt = `You are a SQL + chart generator. Given user questions about enterprise data, output a JSON object with two fields:
1. "sql": a valid SQL SELECT query
2. "chart": a chart spec object OR null if no chart makes sense

Output ONLY the JSON — no explanation, no markdown, no code fences.

Example output:
{"sql": "SELECT customer_state AS state, COUNT(*) AS customer_count FROM customers GROUP BY customer_state ORDER BY customer_count DESC", "chart": {"type": "horizontal_bar", "xKey": "state", "yKey": "customer_count"}}

Available tables and columns:
${schema}

SQL rules:
- Only SELECT statements
- Use table aliases for JOINs (e.g., FROM orders o JOIN customers c ON ...)
- Add LIMIT 50 if the user doesn't specify a limit
- For "how many" questions, use COUNT(*)
- For "which/what" questions, use DISTINCT or GROUP BY as appropriate
- Column names are exactly as listed above (lowercase, underscores)

SQL dialect is DuckDB (PostgreSQL-compatible, in-browser WASM):
- CTEs (WITH ... AS) are fully supported and encouraged for readability
- Window functions fully supported: ROW_NUMBER(), RANK(), DENSE_RANK(), NTILE(), LAG(), LEAD() with OVER(PARTITION BY ... ORDER BY ...)
- Date functions: DATE_TRUNC('month', col), EXTRACT(YEAR FROM col), col + INTERVAL '7 days'
- Advanced aggregates: PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY col), MEDIAN(col), MODE(col), QUANTILE_DISC(0.9 ORDER BY col)
- String: STRING_AGG(col, ', '), REGEXP_MATCHES(), CONCAT()
- Standard SQL fully supported: COUNT, SUM, AVG, MIN, MAX, ROUND, CASE WHEN, UNION ALL, HAVING, DISTINCT

Chart type rules — pick the best type based on the QUESTION INTENT:
- "distribution"/"分布"/"breakdown" → "horizontal_bar"
- "trend"/"趨勢"/"over time" → "line"
- "proportion"/"占比"/"佔比"/"share" → "pie"
- "comparison"/"比較"/"compare" → "bar" or "grouped_bar"
- "correlation"/"關係"/"relationship" → "scatter"
- "composition over time" → "stacked_bar"
- For rankings/top-N → "horizontal_bar"
- If the query is a simple count or single value → set chart to null

Chart spec shape: { "type": string, "xKey": string, "yKey": string }
Valid types: bar, horizontal_bar, line, area, pie, donut, scatter, stacked_bar, grouped_bar, histogram`;

  try {
    const result = await invokeAiProxy('openai_chat_tools', {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      model: AGENT_CHAT_MODEL,
      temperature: 0.1,
      maxOutputTokens: 512,
    });

    const text = result?.choices?.[0]?.message?.content || result?.text || '';
    // Strip markdown code fences if present
    const cleaned = text.replace(/^```(?:json|sql)?\n?/i, '').replace(/\n?```$/i, '').trim();

    // Try to parse as JSON { sql, chart }
    try {
      const parsed = JSON.parse(cleaned);
      if (parsed && typeof parsed.sql === 'string') {
        return { sql: parsed.sql.trim(), chart: parsed.chart || null };
      }
    } catch {
      // Not JSON — treat entire response as raw SQL (backward-compatible)
    }

    return { sql: cleaned, chart: null };
  } catch (err) {
    console.error('[sapQueryChatHandler] SQL generation failed:', err);
    return null;
  }
}

/**
 * Handle a data query: generate SQL → execute → return results.
 *
 * @param {string} userMessage - The user's natural language question
 * @returns {{ sql: string, result: object, summary: string } | null}
 */
export async function handleDataQuery(userMessage) {
  const generated = await generateSql(userMessage);
  if (!generated) {
    return {
      sql: null,
      result: { success: false, rows: [], rowCount: 0 },
      summary: '無法將問題轉換為 SQL 查詢。請嘗試更具體的描述。',
      charts: [],
    };
  }

  const { sql, chart: llmChart } = generated;
  const result = await executeQuery({ sql });

  let summary;
  if (!result.success) {
    summary = `SQL 執行失敗：${result.error}`;
  } else if (result.rowCount === 0) {
    summary = '查詢完成，沒有找到符合條件的資料。';
  } else {
    summary = formatResultSummary(result);
  }

  // Build chart spec: LLM suggestion → fallback to data-structure inference
  let charts = [];
  if (result.success && result.rows?.length > 0) {
    const chartSpec = llmChart || inferChartSpec(result.rows);
    if (chartSpec) {
      const compatibleTypes = chartSpec.compatibleTypes || getCompatibleTypes(chartSpec.type, result.rows);
      charts = [{
        ...chartSpec,
        data: result.rows,
        compatibleTypes,
      }];
    }
  }

  return { sql, result, summary, charts };
}

/**
 * Format query results into a readable markdown summary.
 */
function formatResultSummary(result) {
  const { rows, rowCount, truncated } = result;
  if (!rows || rows.length === 0) return '沒有資料。';

  const columns = Object.keys(rows[0]);
  const displayRows = rows.slice(0, 30); // Show at most 30 rows in summary

  // Build markdown table
  let table = '| ' + columns.join(' | ') + ' |\n';
  table += '| ' + columns.map(() => '---').join(' | ') + ' |\n';
  for (const row of displayRows) {
    table += '| ' + columns.map((col) => {
      const val = row[col];
      if (val == null) return '';
      if (typeof val === 'number') return Number.isInteger(val) ? String(val) : val.toFixed(2);
      return String(val).slice(0, 60);
    }).join(' | ') + ' |\n';
  }

  let note = `共 ${rowCount} 筆結果`;
  if (truncated) note += `（已截斷至 500 筆）`;
  if (displayRows.length < rows.length) note += `，上方顯示前 ${displayRows.length} 筆`;

  return `${table}\n${note}`;
}
