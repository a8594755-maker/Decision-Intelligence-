/**
 * sapQueryChatHandler.js
 *
 * Handles QUERY_DATA intent by:
 *   1. Building a deterministic query plan (dataset + candidate tables + chart need)
 *   2. Probing table availability inside the current session
 *   3. Generating SQL only against non-empty tables in the chosen dataset
 *   4. Retrying once in the same dataset when the first SQL returns 0 rows
 *
 * This bypasses the agent loop for direct data queries and gives us a stable,
 * inspectable fast path before any agent fallback is considered.
 */

import { SAP_DATASET_INFO, SAP_TABLE_REGISTRY, executeQuery, probeTables } from './sapDataQueryService.js';
import { invokeAiProxy } from '../ai-infra/aiProxyService.js';
import { inferChartSpec, getCompatibleTypes } from '../charts/chartSpecInference.js';

const AGENT_CHAT_MODEL = import.meta.env.VITE_DI_CHAT_MODEL || 'gpt-5.4';

const CHART_REQUEST_PATTERN = /\b(chart|plot|graph|visuali[sz]e|distribution|breakdown|trend|histogram|scatter|bar|line|pie|dashboard)\b|(圖表|圖|視覺化|可视化|分布|趨勢|趋势|直方圖|直方图|散點圖|散点图|長條圖|柱状图|折線圖|折线图|圓餅圖|饼图)/i;

const DATASET_PATTERNS = Object.freeze({
  di_ops: [
    /\b(supplier|suppliers|vendor|vendors|material|materials|inventory|stock|po\b|purchase order|purchase orders|goods receipt|goods receipts|procurement)\b/i,
    /(供應商|供应商|物料|庫存|库存|採購|采购|採購單|采购单|收貨|收货|進貨|进货)/,
  ],
});

const TABLE_KEYWORDS = Object.freeze({
  customers: [/\bcustomer|customers\b/i, /(客戶|客户|顧客|顾客)/],
  orders: [/\border|orders\b/i, /(訂單|订单)/],
  order_items: [/\border item|order items|line item|line items\b/i, /(訂單項目|订单项目|明細|明细)/],
  payments: [/\bpayment|payments|revenue|gmv|sales\b/i, /(付款|支付|營收|营收|銷售額|销售额)/],
  reviews: [/\breview|reviews|rating|ratings|satisfaction\b/i, /(評論|评论|評分|评分|滿意度|满意度)/],
  products: [/\bproduct|products|sku|category|categories\b/i, /(產品|产品|商品|品類|品类|類別|类别)/],
  sellers: [/\bseller|sellers|merchant|merchants|vendor|vendors\b/i, /(賣家|卖家|商家)/],
  geolocation: [/\bgeo|geography|location|city|state|region|zip\b/i, /(地理|地區|地区|城市|州|省|郵遞區號|邮递区号)/],
  category_translation: [/\btranslation|translated|english category\b/i, /(翻譯|翻译|英文類別|英文类别)/],
  suppliers: [/\bsupplier|suppliers|vendor|vendors\b/i, /(供應商|供应商)/],
  materials: [/\bmaterial|materials|sku|item master\b/i, /(物料|料號|料号)/],
  inventory_snapshots: [/\binventory|stock|on.?hand|safety stock\b/i, /(庫存|库存|現有量|现有量|安全庫存|安全库存)/],
  po_open_lines: [/\bpo\b|purchase order|open order|open qty|inbound\b/i, /(採購單|采购单|未結採購|未结采购|在途|開放訂單|开放订单)/],
  goods_receipts: [/\bgoods receipt|goods receipts|receipt|receipts|delivery|on.?time\b/i, /(收貨|收货|到貨|到货|準時交付|准时交付)/],
});

const DEFAULT_CANDIDATE_TABLES = Object.freeze({
  olist: ['orders', 'order_items', 'payments', 'customers', 'products', 'sellers', 'reviews'],
  di_ops: ['suppliers', 'materials', 'inventory_snapshots', 'po_open_lines', 'goods_receipts'],
});

function normalizeMessage(text) {
  return String(text || '').trim();
}

function isChineseLike(text) {
  return /[\u3400-\u9fff]/.test(String(text || ''));
}

function matchesAny(text, patterns = []) {
  return patterns.some((pattern) => pattern.test(text));
}

function getDatasetTables(datasetKey) {
  return Object.entries(SAP_TABLE_REGISTRY)
    .filter(([, entry]) => (datasetKey === 'di_ops' ? entry.source === 'supabase' : entry.source === 'csv'))
    .map(([name]) => name);
}

function detectTargetDataset(userMessage, preferredDataset = null) {
  if (preferredDataset && SAP_DATASET_INFO[preferredDataset]) return preferredDataset;
  const normalized = normalizeMessage(userMessage);
  if (matchesAny(normalized, DATASET_PATTERNS.di_ops)) return 'di_ops';
  return 'olist';
}

function detectCandidateTables(userMessage, targetDataset) {
  const normalized = normalizeMessage(userMessage);
  const tables = getDatasetTables(targetDataset);
  const matched = tables.filter((tableName) => matchesAny(normalized, TABLE_KEYWORDS[tableName] || []));
  return matched.length > 0 ? matched : (DEFAULT_CANDIDATE_TABLES[targetDataset] || tables);
}

function buildQueryPlan(userMessage, opts = {}) {
  const targetDataset = detectTargetDataset(userMessage, opts.targetDataset || null);
  const datasetInfo = SAP_DATASET_INFO[targetDataset];
  const candidateTables = detectCandidateTables(userMessage, targetDataset);

  return {
    targetDataset,
    datasetLabel: datasetInfo?.label || targetDataset,
    datasetScope: datasetInfo?.scope || null,
    wantsChart: CHART_REQUEST_PATTERN.test(normalizeMessage(userMessage)),
    candidateTables,
  };
}

function buildScopedSchemaPrompt(tableNames, tableProbes = []) {
  const probeMap = new Map((tableProbes || []).map((probe) => [probe.table_name, probe]));

  return (tableNames || []).map((tableName) => {
    const entry = SAP_TABLE_REGISTRY[tableName];
    const probe = probeMap.get(tableName);
    const rowInfo = Number.isFinite(probe?.row_count)
      ? `${probe.row_count} rows available in current session`
      : 'row count unavailable';
    const lines = [`- ${tableName} (${entry.sapEquivalent}; ${rowInfo}): ${entry.columns.join(', ')}`];

    if (entry.columnDescriptions) {
      lines.push(...Object.entries(entry.columnDescriptions).map(([column, text]) => `    ${column}: ${text}`));
    }

    return lines.join('\n');
  }).join('\n');
}

function buildSqlSystemPrompt({ queryPlan, tableProbes, retryContext = null }) {
  const allowedTables = (tableProbes || []).map((probe) => probe.table_name);
  const schema = buildScopedSchemaPrompt(allowedTables, tableProbes);
  const retryBlock = retryContext
    ? `
Retry context:
- Previous SQL returned 0 rows.
- Previous SQL: ${retryContext.previousSql}
- Stay in the SAME dataset and only use these allowed tables: ${allowedTables.join(', ')}
- Only fix joins, loosen over-specific filters, or choose a more appropriate aggregation.
- Do NOT switch datasets or invent unavailable columns.
`
    : '';

  return `You are a SQL + chart generator. Output a JSON object with exactly two fields:
1. "sql": a valid SQL SELECT query
2. "chart": a chart spec object OR null

Output ONLY JSON. No markdown, no explanation, no code fences.

Target dataset:
- ${queryPlan.datasetLabel}
- Scope: ${queryPlan.datasetScope}
- Allowed tables only: ${allowedTables.join(', ')}

Available tables and columns:
${schema}
${retryBlock}
SQL rules:
- Only SELECT statements
- Use only the allowed tables listed above
- Use table aliases for JOINs
- Add LIMIT 50 if the user did not request a larger result set
- For count/how-many questions, use COUNT(*)
- Column names must exactly match the schema above
- If the user asks for trend/time-series, use the real date/timestamp columns from the schema above
- If the question is about Dataset B and the allowed tables are operational tables, stay in Dataset B even if it is sparse
- CRITICAL TIME AGGREGATION: When the user asks for "monthly", "per month", "月均", "每月", or any periodic metric, you MUST GROUP BY DATE_TRUNC('month', <date_column>). Never report a bare SUM() across the full dataset as a "monthly" figure.
- Olist data spans ~24 months (2016-09 to 2018-10). A bare SUM() without time grouping produces the ALL-TIME total (~24x the actual monthly value). To compute a monthly average, use: SUM(val) / COUNT(DISTINCT DATE_TRUNC('month', date_col)).
- If reporting an average across time, always include the month count in output so the consumer can verify the denominator.

DuckDB SQL dialect notes:
- CTEs (WITH ... AS) supported
- Window functions supported
- DATE_TRUNC, EXTRACT, INTERVAL supported
- PERCENTILE_CONT, MEDIAN, MODE, QUANTILE_DISC supported
- STRING_AGG, CONCAT supported
- LATERAL JOIN does NOT support aggregate functions — use CTE + GROUP BY instead

Chart rules:
- If the user explicitly wants a chart/plot/visualization, set chart to a fitting spec
- If the result is a single scalar metric, set chart to null

Chart spec shape: { "type": string, "xKey": string, "yKey": string }
Valid chart types: bar, horizontal_bar, line, area, pie, donut, scatter, stacked_bar, grouped_bar, histogram`;
}

async function generateSql(userMessage, { queryPlan, tableProbes, retryContext = null } = {}) {
  const systemPrompt = buildSqlSystemPrompt({ queryPlan, tableProbes, retryContext });

  try {
    const result = await invokeAiProxy('openai_chat_tools', {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: normalizeMessage(userMessage) },
      ],
      model: AGENT_CHAT_MODEL,
      temperature: 0.1,
      maxOutputTokens: 512,
    });

    const text = result?.choices?.[0]?.message?.content || result?.text || '';
    const cleaned = String(text || '').replace(/^```(?:json|sql)?\n?/i, '').replace(/\n?```$/i, '').trim();

    try {
      const parsed = JSON.parse(cleaned);
      if (parsed && typeof parsed.sql === 'string') {
        return { sql: parsed.sql.trim(), chart: parsed.chart || null };
      }
    } catch {
      // Fall through and treat the raw content as SQL for backward compatibility.
    }

    return { sql: cleaned, chart: null };
  } catch (err) {
    console.error('[sapQueryChatHandler] SQL generation failed:', err);
    return null;
  }
}

function buildMeta({ queryPlan, tablesChecked, retryCount = 0, emptyReason = null, sqlAttempts = [], queryResultMeta = null }) {
  return {
    datasetScope: queryPlan?.datasetScope || null,
    datasetLabel: queryPlan?.datasetLabel || null,
    tablesChecked,
    retryCount,
    emptyReason,
    queryPlan,
    sqlAttempts,
    tablesQueried: Array.isArray(queryResultMeta?.tables_queried) ? queryResultMeta.tables_queried : [],
  };
}

function buildNoDataSummary(userMessage, meta) {
  const languageIsZh = isChineseLike(userMessage);
  const tableNames = (meta?.tablesChecked || []).map((table) => table.table_name).join(', ');

  if (meta?.emptyReason === 'dataset_tables_empty') {
    return languageIsZh
      ? `未執行 SQL。${meta.datasetLabel} 目前沒有可查詢資料。已檢查資料表：${tableNames || '無'}。這代表資料集為空，不是 SQL 執行失敗。`
      : `SQL was skipped because ${meta.datasetLabel} currently has no queryable data. Checked tables: ${tableNames || 'none'}. This is an empty-dataset result, not a SQL execution failure.`;
  }

  return languageIsZh
    ? `已執行查詢，回傳 0 rows / no evidence。資料集：${meta.datasetLabel}。已檢查資料表：${tableNames || '無'}。重試次數：${meta.retryCount || 0}。這通常表示條件過嚴，或目前資料集中沒有符合條件的資料。`
    : `Executed query, returned 0 rows / no evidence. Dataset: ${meta.datasetLabel}. Checked tables: ${tableNames || 'none'}. Retry count: ${meta.retryCount || 0}. This usually means the filters are too strict or the dataset has no matching records right now.`;
}

function buildFailureSummary(userMessage, error) {
  return isChineseLike(userMessage)
    ? `SQL fast-path 失敗：${error}`
    : `SQL fast-path failed: ${error}`;
}

function formatResultSummary(result) {
  const { rows, rowCount, truncated } = result;
  if (!rows || rows.length === 0) return 'No rows.';

  const columns = Object.keys(rows[0]);
  const displayRows = rows.slice(0, 30);

  let table = `| ${columns.join(' | ')} |\n`;
  table += `| ${columns.map(() => '---').join(' | ')} |\n`;
  for (const row of displayRows) {
    table += `| ${columns.map((col) => {
      const val = row[col];
      if (val == null) return '';
      if (typeof val === 'number') return Number.isInteger(val) ? String(val) : val.toFixed(2);
      return String(val).slice(0, 60);
    }).join(' | ')} |\n`;
  }

  let note = `Total ${rowCount} row${rowCount === 1 ? '' : 's'}`;
  if (truncated) note += ' (truncated)';
  if (displayRows.length < rows.length) note += `, showing first ${displayRows.length}`;

  return `${table}\n${note}`;
}

function buildCharts(resultRows, llmChart) {
  if (!Array.isArray(resultRows) || resultRows.length === 0) return [];
  const chartSpec = llmChart || inferChartSpec(resultRows);
  if (!chartSpec) return [];

  const compatibleTypes = chartSpec.compatibleTypes || getCompatibleTypes(chartSpec.type, resultRows);
  return [{
    ...chartSpec,
    data: resultRows,
    compatibleTypes,
  }];
}

/**
 * Handle a data query: build plan → probe tables → generate SQL → execute.
 *
 * @param {string} userMessage
 * @param {object} [opts]
 * @param {string} [opts.targetDataset]
 * @returns {{ sql: string|null, result: object, summary: string, charts: Array, meta: object }}
 */
export async function handleDataQuery(userMessage, opts = {}) {
  const queryPlan = buildQueryPlan(userMessage, opts);
  const probeResult = await probeTables(queryPlan.candidateTables);
  const availableTables = (probeResult.tables || []).filter((table) => !table.error && Number(table.row_count) > 0);

  if (availableTables.length === 0) {
    const meta = buildMeta({
      queryPlan,
      tablesChecked: probeResult.tables || [],
      retryCount: 0,
      emptyReason: 'dataset_tables_empty',
      sqlAttempts: [],
    });
    return {
      sql: null,
      result: {
        success: true,
        rows: [],
        rowCount: 0,
        truncated: false,
        meta,
      },
      summary: buildNoDataSummary(userMessage, meta),
      charts: [],
      meta,
    };
  }

  const initial = await generateSql(userMessage, {
    queryPlan,
    tableProbes: availableTables,
  });

  if (!initial?.sql) {
    const meta = buildMeta({
      queryPlan,
      tablesChecked: probeResult.tables || [],
      retryCount: 0,
      emptyReason: null,
      sqlAttempts: [],
    });
    return {
      sql: null,
      result: { success: false, rows: [], rowCount: 0, truncated: false, meta },
      summary: isChineseLike(userMessage)
        ? '無法將問題轉換為 SQL 查詢。'
        : 'Could not translate the question into SQL.',
      charts: [],
      meta,
    };
  }

  let sql = initial.sql.trim();
  let llmChart = initial.chart || null;
  let retryCount = 0;
  let sqlAttempts = [sql];
  let result = await executeQuery({ sql });

  if (result.success && result.rowCount === 0) {
    const retry = await generateSql(userMessage, {
      queryPlan,
      tableProbes: availableTables,
      retryContext: {
        previousSql: sql,
      },
    });

    if (retry?.sql) {
      retryCount = 1;
      sql = retry.sql.trim();
      llmChart = retry.chart || llmChart;
      sqlAttempts = [sqlAttempts[0], sql];
      result = await executeQuery({ sql });
    }
  }

  const emptyReason = result.success && result.rowCount === 0
    ? 'no_matching_rows_after_retry'
    : null;
  const meta = buildMeta({
    queryPlan,
    tablesChecked: probeResult.tables || [],
    retryCount,
    emptyReason,
    sqlAttempts,
    queryResultMeta: result.meta || null,
  });
  const mergedResult = {
    ...result,
    meta: {
      ...(result.meta || {}),
      ...meta,
    },
  };

  if (!result.success) {
    return {
      sql,
      result: mergedResult,
      summary: buildFailureSummary(userMessage, result.error),
      charts: [],
      meta,
    };
  }

  if (result.rowCount === 0) {
    return {
      sql,
      result: mergedResult,
      summary: buildNoDataSummary(userMessage, meta),
      charts: [],
      meta,
    };
  }

  return {
    sql,
    result: mergedResult,
    summary: formatResultSummary(result),
    charts: buildCharts(result.rows, llmChart),
    meta,
  };
}
