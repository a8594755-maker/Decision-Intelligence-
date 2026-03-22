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

  const systemPrompt = `You are a SQL generator. Given user questions about enterprise data, output ONLY a valid SQL SELECT query. No explanation, no markdown, no code fences — just the raw SQL.

Available tables and columns:
${schema}

Rules:
- Only SELECT statements
- Use table aliases for JOINs (e.g., FROM orders o JOIN customers c ON ...)
- Add LIMIT 50 if the user doesn't specify a limit
- For "how many" questions, use COUNT(*)
- For "which/what" questions, use DISTINCT or GROUP BY as appropriate
- Column names are exactly as listed above (lowercase, underscores)`;

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
    return text.replace(/^```(?:sql)?\n?/i, '').replace(/\n?```$/i, '').trim();
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
  const sql = await generateSql(userMessage);
  if (!sql) {
    return {
      sql: null,
      result: { success: false, rows: [], rowCount: 0 },
      summary: '無法將問題轉換為 SQL 查詢。請嘗試更具體的描述。',
    };
  }

  const result = await executeQuery({ sql });

  let summary;
  if (!result.success) {
    summary = `SQL 執行失敗：${result.error}`;
  } else if (result.rowCount === 0) {
    summary = '查詢完成，沒有找到符合條件的資料。';
  } else {
    summary = formatResultSummary(result);
  }

  return { sql, result, summary };
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
