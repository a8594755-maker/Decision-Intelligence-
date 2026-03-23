import { extractAnalysisPayloadsFromToolCall } from './analysisToolResultService.js';
import { DI_PROMPT_IDS, runDiPrompt } from './diModelRouterService.js';
import { SAP_TABLE_REGISTRY, SAP_DATASET_INFO } from './sapDataQueryService.js';
import { detectDomain, verifyFormulaConsistency } from './analysisDomainEnrichment.js';
import { WARNING_ACKNOWLEDGMENT_PATTERNS } from './preAnalysisDataValidator.js';
import {
  REQUESTED_PERCENTILE_KEYS,
  collectPercentileKeysFromText,
  detectRequestedSpecialChart,
  getStructuredAnswerCoverage,
} from './agentAnswerCoverageService.js';

const DEFAULT_ANSWER_CONTRACT = Object.freeze({
  task_type: 'mixed',
  required_dimensions: [],
  required_outputs: [],
  audience_language: 'en',
  brevity: 'short',
  analysis_depth: [],
});

const VALID_ANALYSIS_DEPTH_FLAGS = new Set([
  'methodology_disclosure',
  'relative_metrics',
  'trend_context',
  'sensitivity_range',
  'actionable_parameters',
]);

function inferAnalysisDepth(taskType, brevity) {
  const flags = [];
  if (taskType === 'recommendation' || taskType === 'diagnostic') {
    flags.push('methodology_disclosure', 'actionable_parameters', 'sensitivity_range');
  }
  if (taskType === 'comparison' || taskType === 'trend') {
    flags.push('relative_metrics', 'trend_context');
  }
  if (brevity === 'analysis' && !flags.includes('relative_metrics')) {
    flags.push('relative_metrics');
  }
  return flags;
}

const TASK_KEYWORDS = Object.freeze({
  comparison: [/\b(vs|versus|compare|comparison|difference|delta|against)\b/i, /(比較|差異|對比|相較|相對|vs|對照)/],
  trend: [/\b(trend|over time|timeline|monthly|weekly|daily|hourly|seasonal|trajectory)\b/i, /(趨勢|走勢|隨時間|月度|每月|每週|每日|每小時|季節性)/],
  ranking: [/\b(rank|ranking|top|bottom|best|worst|sorted|order by)\b/i, /(排行|排名|前\d+|前幾|最高|最低|最佳|最差)/],
  diagnostic: [/\b(why|root cause|diagnose|issue|problem|anomaly|investigate|reason)\b/i, /(原因|為什麼|診斷|問題|異常|調查|根因)/],
  recommendation: [/\b(recommend|suggest|should|next step|action|what should)\b/i, /(建議|應該|下一步|怎麼做|行動)/],
  lookup: [/\b(what is|show me|list|lookup|find|how many|count)\b/i, /(查詢|列出|顯示|找出|多少|有幾個)/],
});

const OUTPUT_KEYWORDS = Object.freeze({
  chart: [/\b(chart|plot|graph|visuali[sz]e|heatmap|histogram|scatter|bar|pie|treemap)\b/i, /(圖表|圖|熱力圖|折線圖|柱狀圖|散點圖|圓餅圖|視覺化|可視化)/],
  table: [/\b(table|tabular|matrix|breakdown)\b/i, /(表格|矩陣|明細|拆解)/],
  recommendation: [/\b(recommend|suggest|what should|next step|action)\b/i, /(建議|下一步|行動)/],
  caveat: [/\b(caveat|limitation|assumption|proxy)\b/i, /(限制|假設|近似|代理指標|注意)/],
});

const DIMENSION_PATTERNS = Object.freeze([
  { label: 'revenue', patterns: [/\brevenue\b/i, /\bsales\b/i, /(營收|收入|銷售額)/] },
  { label: 'quantiles', patterns: [/\bquantiles?\b/i, /\bpercentiles?\b/i, /(分位數|百分位|百分位數)/] },
  { label: 'orders', patterns: [/\border volume\b/i, /\border count\b/i, /\borders?\b/i, /(訂單量|訂單數|下單量)/] },
  { label: 'delivery days', patterns: [/\bdelivery days\b/i, /\bshipping days\b/i, /\blead time\b/i, /(配送天數|交付天數|運送天數|時效|配送時間)/] },
  { label: 'return rate', patterns: [/\breturn rate\b/i, /\bcancel(?:lation)? rate\b/i, /\brefund rate\b/i, /(退貨率|取消率|退款率|退單率)/] },
  { label: 'rating', patterns: [/\brating\b/i, /\breview score\b/i, /(評分|評論分數|滿意度)/] },
  { label: 'profit', patterns: [/\bprofit\b/i, /\bmargin\b/i, /(利潤|毛利|利潤率|毛利率)/] },
  { label: 'customers', patterns: [/\bcustomers?\b/i, /(客戶|顧客)/] },
  { label: 'products', patterns: [/\bproducts?\b/i, /(產品|商品)/] },
  { label: 'sellers', patterns: [/\bsellers?\b/i, /(賣家|商家)/] },
  { label: 'categories', patterns: [/\bcategories?\b/i, /(品類|類別|分類)/] },
  { label: 'payments', patterns: [/\bpayments?\b/i, /(付款|支付)/] },
  { label: 'retention', patterns: [/\bretention\b/i, /(留存)/] },
  { label: 'conversion', patterns: [/\bconversion\b/i, /(轉換率|轉化率)/] },
  { label: 'satisfaction', patterns: [/\bsatisfaction\b/i, /(滿意度)/] },
  // ── Supply chain dimensions ──
  { label: 'safety_stock', patterns: [/\bsafety stock\b/i, /(安全庫存|安全存量)/] },
  { label: 'reorder_point', patterns: [/\breorder point\b/i, /\bROP\b/, /(補貨點|再訂購點|補貨參數)/] },
  { label: 'eoq', patterns: [/\bEOQ\b/i, /\beconomic order quantity\b/i, /(經濟訂購量)/] },
  { label: 'service_level', patterns: [/\bservice level\b/i, /(服務水準|服務水平)/] },
  { label: 'lead_time', patterns: [/\blead time\b/i, /\breplenishment time\b/i, /(前置時間|交期|補貨時間)/] },
  { label: 'demand_variability', patterns: [/\bdemand variab/i, /\bdemand std/i, /\bCV\b/, /(需求波動|變異係數)/] },
  { label: 'holding_cost', patterns: [/\bholding cost\b/i, /(持有成本|庫存持有)/] },
  { label: 'fill_rate', patterns: [/\bfill rate\b/i, /(充填率|滿足率)/] },
  { label: 'inventory_turns', patterns: [/\binventory turn/i, /(庫存周轉)/] },
]);

const DEBUG_PATTERNS = [
  /\bSQL Query\b/i,
  /\bReasoning complete\b/i,
  /\bAgent executed\b/i,
  /\bThinking\b/i,
  /\banalysis records\b/i,
  /\bstatus:\s*(success|failed?)\b/i,
  /^SELECT\b/i,
  /^WITH\b/i,
];

const PSEUDO_TABLE_PATTERN = /\S+\s{2,}\S+/;
const MARKDOWN_TABLE_PATTERN = /^\|.*\|$/;
const QA_PASS_THRESHOLD = 8.0;
const QA_DIMENSION_WEIGHTS = Object.freeze({
  correctness: 0.35,
  completeness: 0.18,
  evidence_alignment: 0.13,
  visualization_fit: 0.08,
  caveat_quality: 0.08,
  clarity: 0.05,
  methodology_transparency: 0.07,
  actionability: 0.06,
});
const QA_DIMENSION_KEYS = Object.freeze(Object.keys(QA_DIMENSION_WEIGHTS));
const CROSS_MODEL_REVIEW_PROVIDER = import.meta.env.VITE_DI_AGENT_QA_REVIEW_PROVIDER || 'gemini';
const CROSS_MODEL_REVIEW_MODEL = import.meta.env.VITE_DI_AGENT_QA_REVIEW_MODEL
  || import.meta.env.VITE_DI_GEMINI_MODEL
  || import.meta.env.VITE_GEMINI_MODEL
  || 'gemini-3.1-pro-preview';
const METRIC_ALIAS_PATTERNS = Object.freeze([
  { key: 'median', patterns: [/\bmedian\b/i, /\bp50\b/i, /(中位數|中央値)/] },
  { key: 'p10', patterns: [/\bp10\b/i, /\b10(th)? percentile\b/i, /(10分位|第10分位)/] },
  { key: 'p25', patterns: [/\bp25\b/i, /\b25(th)? percentile\b/i, /(25分位|第25分位)/] },
  { key: 'p75', patterns: [/\bp75\b/i, /\b75(th)? percentile\b/i, /(75分位|第75分位)/] },
  { key: 'p90', patterns: [/\bp90\b/i, /\b90(th)? percentile\b/i, /(90分位|第90分位)/] },
  { key: 'p95', patterns: [/\bp95\b/i, /\b95(th)? percentile\b/i, /(95分位|第95分位)/] },
  { key: 'p99', patterns: [/\bp99\b/i, /\b99(th)? percentile\b/i, /(99分位|第99分位)/] },
  { key: 'gini', patterns: [/\bgini\b/i, /(基尼)/] },
  { key: 'top 10 share', patterns: [/\btop 10 share\b/i, /\btop 10 sellers?\b/i, /(前10|top 10)/i] },
  { key: 'max revenue', patterns: [/\bmax(imum)? revenue\b/i, /\bhighest seller\b/i, /(最高營收|最高賣家)/] },
  { key: 'mean', patterns: [/\bmean\b/i, /\baverage\b/i, /\bavg\b/i, /(平均值|平均)/] },
  { key: 'min', patterns: [/\bmin(imum)?\b/i, /(最小值|最低值)/] },
  { key: 'max', patterns: [/\bmax(imum)?\b/i, /(最大值|最高值)/] },
  { key: 'std', patterns: [/\bstd\s*dev\b/i, /\bstandard deviation\b/i, /(標準差)/] },
  { key: 'count', patterns: [/\bcount\b/i, /\btotal\s+(sellers?|orders?|customers?|products?)\b/i, /(總數|總計)/] },
]);
const DIMENSION_LABELS = new Set(DIMENSION_PATTERNS.map((entry) => entry.label));

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function uniqueStrings(items = []) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const normalized = String(item || '').trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function clamp(text, maxChars = 5000) {
  return String(text || '').slice(0, maxChars);
}

function detectAudienceLanguage(text) {
  const sample = String(text || '');
  const cjkCount = (sample.match(/[\u3400-\u9fff]/g) || []).length;
  return cjkCount >= Math.max(4, Math.floor(sample.length * 0.12)) ? 'zh' : 'en';
}

function inferTaskType(message) {
  const text = String(message || '');
  for (const [taskType, patterns] of Object.entries(TASK_KEYWORDS)) {
    if (patterns.some((pattern) => pattern.test(text))) return taskType;
  }
  return 'mixed';
}

function inferRequiredDimensions(message) {
  const text = String(message || '');
  const matches = [];
  for (const entry of DIMENSION_PATTERNS) {
    if (entry.patterns.some((pattern) => pattern.test(text))) {
      matches.push(entry.label);
    }
  }
  return uniqueStrings(matches);
}

function inferRequiredOutputs(message, taskType) {
  const text = String(message || '');
  const outputs = [];

  for (const [output, patterns] of Object.entries(OUTPUT_KEYWORDS)) {
    if (patterns.some((pattern) => pattern.test(text))) {
      outputs.push(output);
    }
  }

  if (taskType === 'comparison') outputs.push('comparison', 'table');
  if (taskType === 'trend') outputs.push('chart');
  if (taskType === 'ranking') outputs.push('table');

  return uniqueStrings(outputs.filter((item) => ['chart', 'table', 'comparison', 'recommendation', 'caveat'].includes(item)));
}

function normalizeAnswerContract(contract, message, mode = 'default') {
  const taskType = contract?.task_type && typeof contract.task_type === 'string'
    ? contract.task_type
    : inferTaskType(message);
  const requiredDimensions = Array.isArray(contract?.required_dimensions)
    ? uniqueStrings(contract.required_dimensions)
    : inferRequiredDimensions(message);
  const requiredOutputs = Array.isArray(contract?.required_outputs)
    ? uniqueStrings(contract.required_outputs)
    : inferRequiredOutputs(message, taskType);
  const audienceLanguage = typeof contract?.audience_language === 'string' && contract.audience_language.trim()
    ? contract.audience_language.trim()
    : detectAudienceLanguage(message);

  const brevity = (contract?.brevity === 'analysis' || contract?.brevity === 'short') ? contract.brevity : 'short';
  const resolvedTaskType = taskType || DEFAULT_ANSWER_CONTRACT.task_type;

  // Derive analysis_depth from contract or auto-infer from task_type + brevity
  const analysisDepth = Array.isArray(contract?.analysis_depth) && contract.analysis_depth.length > 0
    ? contract.analysis_depth.filter((flag) => VALID_ANALYSIS_DEPTH_FLAGS.has(flag))
    : inferAnalysisDepth(resolvedTaskType, brevity);

  return {
    task_type: resolvedTaskType,
    required_dimensions: requiredDimensions,
    required_outputs: requiredOutputs,
    audience_language: audienceLanguage || (mode === 'analysis' ? 'zh' : 'en'),
    brevity,
    analysis_depth: analysisDepth,
  };
}

function getCanonicalToolPayload(toolCall) {
  const result = toolCall?.result;
  if (!result?.success) return null;

  const nested = result?.result;
  if (
    isPlainObject(nested)
    && typeof nested.success === 'boolean'
    && ('result' in nested || '_analysisCards' in nested || 'artifactTypes' in nested || 'toolId' in nested)
  ) {
    return nested.success ? nested : null;
  }

  return result;
}

function getStructuredRows(toolCall) {
  const payload = getCanonicalToolPayload(toolCall);
  const rows = payload?.result?.rows;
  return Array.isArray(rows) ? rows : [];
}

function getRowCount(toolCall) {
  const payload = getCanonicalToolPayload(toolCall);
  const rowCount = payload?.result?.rowCount;
  if (Number.isFinite(rowCount)) return rowCount;
  const rows = payload?.result?.rows;
  return Array.isArray(rows) ? rows.length : 0;
}

function serializeArgs(args) {
  if (!args || !isPlainObject(args) || Object.keys(args).length === 0) return null;
  return JSON.stringify(args, null, 2);
}

function extractSqlTableNames(sql = '') {
  const matches = String(sql || '').match(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi) || [];
  return Array.from(new Set(matches
    .map((fragment) => fragment.replace(/\b(?:FROM|JOIN)\s+/i, '').trim().toLowerCase())
    .filter((name) => Boolean(SAP_TABLE_REGISTRY[name]))));
}

function getDatasetInfoForTable(tableName) {
  const entry = SAP_TABLE_REGISTRY[tableName];
  if (!entry) return null;
  return entry.source === 'csv' ? SAP_DATASET_INFO.olist : SAP_DATASET_INFO.di_ops;
}

function buildSqlSourceMeta(toolCall) {
  const payload = getCanonicalToolPayload(toolCall);
  const payloadMeta = payload?.result?.meta || {};
  const tables = Array.isArray(payloadMeta?.tables_queried) && payloadMeta.tables_queried.length > 0
    ? payloadMeta.tables_queried
    : extractSqlTableNames(toolCall?.args?.sql || '');
  const datasetLabels = Array.from(new Set(tables.map((table) => getDatasetInfoForTable(table)?.label).filter(Boolean)));
  const datasetScopes = Array.from(new Set(tables.map((table) => getDatasetInfoForTable(table)?.scope).filter(Boolean)));

  return {
    tables,
    datasetLabel: payloadMeta?.dataset_label || (datasetLabels.length === 1 ? datasetLabels[0] : datasetLabels.join(' + ')),
    datasetScope: payloadMeta?.dataset_scope || (datasetScopes.length === 1 ? datasetScopes[0] : (datasetScopes.length > 1 ? 'mixed' : null)),
  };
}

function summarizeSuccess(toolCall) {
  const payload = getCanonicalToolPayload(toolCall);
  const rowCount = getRowCount(toolCall);
  const analysisCards = extractAnalysisPayloadsFromToolCall(toolCall);

  if (toolCall?.name === 'list_sap_tables' && payload?.result) {
    const tableCount = Array.isArray(payload?.result?.tables) ? payload.result.tables.length : 0;
    return tableCount > 0
      ? `Listed ${tableCount} table schema${tableCount === 1 ? '' : 's'}`
      : 'Listed available table schemas';
  }

  if (toolCall?.name === 'query_sap_data' && payload?.result) {
    const sourceMeta = buildSqlSourceMeta(toolCall);
    const sourceParts = [];
    if (sourceMeta.datasetLabel) sourceParts.push(sourceMeta.datasetLabel);
    if (sourceMeta.tables.length > 0) sourceParts.push(`tables: ${sourceMeta.tables.join(', ')}`);
    const sourceSuffix = sourceParts.length > 0 ? ` (${sourceParts.join('; ')})` : '';
    return rowCount > 0
      ? `Returned ${rowCount} row${rowCount === 1 ? '' : 's'}${sourceSuffix}`
      : `Executed, returned 0 rows / no evidence${sourceSuffix}`;
  }

  if (analysisCards.length > 0) {
    const firstCard = analysisCards[0];
    return firstCard?.title || firstCard?.analysisType || 'Analysis artifact generated';
  }

  if (payload?.artifactTypes?.length > 0) {
    return `Produced ${payload.artifactTypes.join(', ')}`;
  }

  return 'Completed successfully';
}

function buildTrace(toolCalls = [], rawNarrative = '') {
  const failedAttempts = [];
  const successfulQueries = [];

  for (const toolCall of Array.isArray(toolCalls) ? toolCalls : []) {
    if (!toolCall?.name) continue;
    const success = Boolean(toolCall?.result?.success);
    const sql = toolCall?.args?.sql || null;
    const sqlSourceMeta = buildSqlSourceMeta(toolCall);
    const base = {
      id: toolCall?.id || `${toolCall.name}-${successfulQueries.length + failedAttempts.length}`,
      name: toolCall.name,
      sql,
      args: serializeArgs(toolCall.args),
      rowCount: getRowCount(toolCall),
      tables: sqlSourceMeta.tables,
      dataset_label: sqlSourceMeta.datasetLabel || null,
      dataset_scope: sqlSourceMeta.datasetScope || null,
      summary: success ? summarizeSuccess(toolCall) : String(toolCall?.result?.error || 'Tool failed'),
    };

    if (success) {
      successfulQueries.push({
        ...base,
        kind: sql ? 'sql' : 'tool',
        result: toolCall.result,
        purpose: toolCall?.name === 'generate_chart'
          ? 'Generated chart artifact'
          : toolCall?.name === 'query_sap_data'
            ? 'Executed data query'
            : 'Completed tool step',
      });
      continue;
    }

    failedAttempts.push({
      ...base,
      error: String(toolCall?.result?.error || 'Tool failed'),
      result: toolCall.result,
    });
  }

  return {
    failed_attempts: failedAttempts,
    successful_queries: successfulQueries,
    raw_narrative: rawNarrative ? String(rawNarrative) : null,
  };
}

function formatValue(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    if (Math.abs(value) >= 1000) return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value);
    if (Number.isInteger(value)) return String(value);
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
  }
  if (value == null) return 'N/A';
  return String(value);
}

function normalizeSentence(text) {
  return String(text || '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitNarrativeIntoLines(text) {
  return String(text || '')
    .split(/\n+/)
    .map((line) => normalizeSentence(line))
    .filter(Boolean);
}

function splitNarrativeIntoSentences(text) {
  return splitNarrativeIntoLines(text)
    .flatMap((line) => line.split(/(?<=[。！？.!?])\s+/))
    .map((line) => normalizeSentence(line))
    .filter(Boolean);
}

function isDebugLine(line) {
  return DEBUG_PATTERNS.some((pattern) => pattern.test(line));
}

function extractCleanNarrativeSentences(text) {
  return splitNarrativeIntoSentences(text).filter((line) => !isDebugLine(line) && !MARKDOWN_TABLE_PATTERN.test(line));
}

function buildMetricPills(toolCalls = [], { brevity } = {}) {
  const maxPills = brevity === 'analysis' ? 8 : 4;
  const analysisPayloads = toolCalls.flatMap((toolCall) => extractAnalysisPayloadsFromToolCall(toolCall));
  const firstMetrics = analysisPayloads.find((payload) => isPlainObject(payload?.metrics))?.metrics;
  if (firstMetrics) {
    return Object.entries(firstMetrics)
      .slice(0, maxPills)
      .map(([label, value]) => ({ label: String(label), value: formatValue(value) }));
  }

  const firstRows = toolCalls.map((toolCall) => getStructuredRows(toolCall)).find((rows) => rows.length > 0) || [];
  if (firstRows.length > 0) {
    const firstRow = firstRows[0];
    return Object.entries(firstRow)
      .filter(([, value]) => typeof value === 'number' || (typeof value === 'string' && value.length <= 24))
      .slice(0, maxPills)
      .map(([label, value]) => ({ label, value: formatValue(value) }));
  }

  return [];
}

function buildEvidenceTables(toolCalls = [], answerContract, { brevity } = {}) {
  const isAnalysis = brevity === 'analysis';
  const maxTables = isAnalysis ? 4 : 2;
  const maxRows = isAnalysis ? 20 : 8;
  const maxColumns = isAnalysis ? 10 : 6;
  const tables = [];
  const structuredRowsCalls = (Array.isArray(toolCalls) ? toolCalls : []).filter((toolCall) => getStructuredRows(toolCall).length > 0);

  for (const toolCall of structuredRowsCalls.slice(0, maxTables)) {
    const rows = getStructuredRows(toolCall).slice(0, maxRows);
    const columns = uniqueStrings(rows.flatMap((row) => Object.keys(row))).slice(0, maxColumns);
    if (columns.length === 0) continue;
    tables.push({
      title: toolCall.name === 'query_sap_data'
        ? (answerContract?.task_type === 'comparison' ? 'Comparison Evidence' : 'Supporting Data')
        : toolCall.name,
      columns,
      rows: rows.map((row) => columns.map((column) => {
        const value = row?.[column];
        return typeof value === 'number' ? Number(value.toFixed(2)) : formatValue(value);
      })),
    });
  }

  if (tables.length > 0) return tables;

  const analysisPayloads = (Array.isArray(toolCalls) ? toolCalls : []).flatMap((toolCall) => extractAnalysisPayloadsFromToolCall(toolCall));
  const firstAnalysis = analysisPayloads.find((payload) => isPlainObject(payload?.metrics));
  if (firstAnalysis?.metrics) {
    const rows = Object.entries(firstAnalysis.metrics).map(([metric, value]) => [metric, formatValue(value)]);
    return [{
      title: firstAnalysis.title || 'Key Metrics',
      columns: ['Metric', 'Value'],
      rows,
    }];
  }

  return [];
}

function pickHeadline({ finalAnswerText, toolCalls, trace, answerContract }) {
  if (trace.failed_attempts.length > 0 && trace.successful_queries.length === 0) {
    return 'The request is currently blocked by tool failures and has no successful evidence yet.';
  }

  const narrative = extractCleanNarrativeSentences(finalAnswerText);
  if (narrative.length > 0) return narrative[0];

  const analysisPayloads = toolCalls.flatMap((toolCall) => extractAnalysisPayloadsFromToolCall(toolCall));
  if (analysisPayloads.length > 0) {
    return analysisPayloads[0]?.title || 'Analysis artifacts are ready.';
  }

  if (answerContract?.task_type === 'comparison') {
    return 'The requested comparison is ready with supporting evidence below.';
  }

  return 'Analysis complete.';
}

function pickSummary({ finalAnswerText, trace, answerContract, toolCalls }) {
  const successCount = trace.successful_queries.length;
  const failureCount = trace.failed_attempts.length;

  if (failureCount > 0 && successCount === 0) {
    return 'No successful evidence was produced for this request, so the brief should stay limited to caveats, generic guidance, and next steps.';
  }

  const narrative = extractCleanNarrativeSentences(finalAnswerText);
  if (narrative.length > 1) {
    return narrative.slice(0, 2).join(' ');
  }

  const analysisPayloads = toolCalls.flatMap((toolCall) => extractAnalysisPayloadsFromToolCall(toolCall));
  if (analysisPayloads.length > 0) {
    const first = analysisPayloads[0];
    if (first?.summary) return normalizeSentence(first.summary);
    return 'Review the structured artifact cards below for the detailed chart and metrics.';
  }

  if (successCount > 0 && failureCount > 0) {
    return `Completed ${successCount} tool step${successCount === 1 ? '' : 's'} with ${failureCount} caveat${failureCount === 1 ? '' : 's'} preserved in the execution trace.`;
  }
  if (successCount > 0) {
    return `Completed ${successCount} tool step${successCount === 1 ? '' : 's'} for this ${answerContract?.task_type || 'analysis'} request.`;
  }
  return 'The available evidence is incomplete, so the brief focuses on caveats and next steps.';
}

function inferKeyFindings({ finalAnswerText, toolCalls, answerContract, trace }) {
  if (trace?.failed_attempts?.length > 0 && trace?.successful_queries?.length === 0) {
    return [];
  }

  const findings = [];
  const narrativeLines = extractCleanNarrativeSentences(finalAnswerText);
  findings.push(...narrativeLines.slice(1, 4));

  const analysisPayloads = toolCalls.flatMap((toolCall) => extractAnalysisPayloadsFromToolCall(toolCall));
  for (const payload of analysisPayloads) {
    if (Array.isArray(payload?.highlights)) findings.push(...payload.highlights);
  }

  if (findings.length === 0 && answerContract?.required_dimensions?.length > 0) {
    findings.push(`Covered dimensions: ${answerContract.required_dimensions.join(', ')}.`);
  }

  return uniqueStrings(findings).slice(0, 5);
}

function inferImplications({ answerContract, toolCalls }) {
  if (answerContract?.task_type !== 'comparison' && answerContract?.task_type !== 'diagnostic') {
    return [];
  }

  const analysisPayloads = toolCalls.flatMap((toolCall) => extractAnalysisPayloadsFromToolCall(toolCall));
  const highlight = analysisPayloads.flatMap((payload) => payload?.highlights || []).find(Boolean);
  if (!highlight) return [];

  return [normalizeSentence(highlight)];
}

function inferCaveats({ finalAnswerText, trace, toolCalls }) {
  const caveats = [];
  const narrativeLines = splitNarrativeIntoLines(finalAnswerText);
  for (const line of narrativeLines) {
    if (/(proxy|approx|approximation|limitation|限制|近似|代理指標|注意)/i.test(line)) {
      caveats.push(line);
    }
  }

  if (trace.failed_attempts.length > 0) {
    caveats.push(`${trace.failed_attempts.length} tool attempt${trace.failed_attempts.length === 1 ? '' : 's'} failed; details remain available in the execution trace.`);
  }

  const queryFailures = trace.failed_attempts.filter((item) => item.name === 'query_sap_data');
  if (queryFailures.length > 0) {
    caveats.push('Some SQL lookups failed, so the final brief may rely on partial evidence or non-SQL artifacts.');
  }

  const analysisPayloads = toolCalls.flatMap((toolCall) => extractAnalysisPayloadsFromToolCall(toolCall));
  if (analysisPayloads.length > 0 && !finalAnswerText) {
    caveats.push('Interpretation is brief because the primary evidence is already shown in the chart/analysis cards below.');
  }

  return uniqueStrings(caveats).slice(0, 4);
}

function inferNextSteps({ answerContract, trace }) {
  if (trace.failed_attempts.length > 0) {
    return ['Retry with a narrower scope or a simpler metric definition to recover the missing evidence.'];
  }
  if (answerContract?.task_type === 'comparison') {
    return ['Drill into the weakest segment next and isolate the metric with the largest gap.'];
  }
  if (answerContract?.task_type === 'trend') {
    return ['Follow up on the inflection periods to validate operational or promotional drivers.'];
  }
  return [];
}

export function buildDeterministicAnswerContract({ userMessage, mode = 'default' }) {
  return normalizeAnswerContract(null, userMessage, mode);
}

export function buildDeterministicAgentBrief({
  userMessage,
  answerContract,
  toolCalls = [],
  finalAnswerText = '',
}) {
  const normalizedContract = normalizeAnswerContract(answerContract, userMessage);
  const brevity = normalizedContract?.brevity;
  const trace = buildTrace(toolCalls, finalAnswerText);

  return {
    headline: pickHeadline({ finalAnswerText, toolCalls, trace, answerContract: normalizedContract }),
    summary: pickSummary({ finalAnswerText, trace, answerContract: normalizedContract, toolCalls }),
    metric_pills: buildMetricPills(toolCalls, { brevity }),
    tables: buildEvidenceTables(toolCalls, normalizedContract, { brevity }),
    key_findings: inferKeyFindings({
      finalAnswerText,
      toolCalls,
      answerContract: normalizedContract,
      trace,
    }),
    implications: inferImplications({ answerContract: normalizedContract, toolCalls }),
    caveats: inferCaveats({ finalAnswerText, trace, toolCalls }),
    next_steps: inferNextSteps({ answerContract: normalizedContract, trace }),
  };
}

function normalizeBrief(brief, fallbackBrief, { brevity } = {}) {
  const isAnalysis = brevity === 'analysis';
  const source = isPlainObject(brief) ? brief : {};
  const fallback = isPlainObject(fallbackBrief) ? fallbackBrief : {};
  const normalized = {
    headline: normalizeSentence(source.headline || fallback.headline || 'Analysis complete.'),
    summary: normalizeSentence(source.summary || fallback.summary || ''),
    metric_pills: Array.isArray(source.metric_pills)
      ? source.metric_pills
        .filter((item) => isPlainObject(item) && item.label && item.value != null)
        .map((item) => ({ label: String(item.label), value: formatValue(item.value) }))
      : (fallback.metric_pills || []),
    tables: Array.isArray(source.tables)
      ? source.tables
        .filter((table) => isPlainObject(table) && Array.isArray(table.columns) && Array.isArray(table.rows))
        .map((table) => ({
          title: table.title ? String(table.title) : '',
          columns: table.columns.map((column) => String(column)),
          rows: table.rows.map((row) => Array.isArray(row) ? row.map((value) => (typeof value === 'number' ? value : formatValue(value))) : []),
        }))
      : (fallback.tables || []),
    charts: Array.isArray(source.charts)
      ? source.charts
        .filter((chart) => isPlainObject(chart) && chart.type && Array.isArray(chart.data))
        .map((chart) => ({
          type: String(chart.type),
          data: chart.data,
          xKey: chart.xKey ? String(chart.xKey) : '',
          yKey: chart.yKey ? String(chart.yKey) : '',
          ...(Array.isArray(chart.series) ? { series: chart.series.map(String) } : {}),
          ...(chart.title ? { title: String(chart.title) } : {}),
          ...(chart.xAxisLabel ? { xAxisLabel: String(chart.xAxisLabel) } : {}),
          ...(chart.yAxisLabel ? { yAxisLabel: String(chart.yAxisLabel) } : {}),
          ...(Array.isArray(chart.referenceLines) ? { referenceLines: chart.referenceLines } : {}),
        }))
      : (fallback.charts || []),
    key_findings: uniqueStrings(Array.isArray(source.key_findings) ? source.key_findings : fallback.key_findings || []).slice(0, isAnalysis ? 10 : 5),
    implications: uniqueStrings(Array.isArray(source.implications) ? source.implications : fallback.implications || []).slice(0, isAnalysis ? 6 : 4),
    caveats: uniqueStrings(Array.isArray(source.caveats) ? source.caveats : fallback.caveats || []).slice(0, isAnalysis ? 6 : 4),
    next_steps: uniqueStrings(Array.isArray(source.next_steps) ? source.next_steps : fallback.next_steps || []).slice(0, isAnalysis ? 6 : 4),
    methodology_note: typeof source.methodology_note === 'string' ? source.methodology_note.trim() : (fallback.methodology_note || null),
  };

  if (!normalized.summary) normalized.summary = fallback.summary || '';
  if (normalized.metric_pills.length === 0) normalized.metric_pills = fallback.metric_pills || [];
  if (normalized.tables.length === 0) normalized.tables = fallback.tables || [];
  if (normalized.charts.length === 0) normalized.charts = fallback.charts || [];
  if (normalized.key_findings.length === 0) normalized.key_findings = fallback.key_findings || [];
  if (normalized.implications.length === 0) normalized.implications = fallback.implications || [];
  if (normalized.caveats.length === 0) normalized.caveats = fallback.caveats || [];
  if (normalized.next_steps.length === 0) normalized.next_steps = fallback.next_steps || [];

  return normalized;
}

function buildBriefSearchText(brief) {
  const metricPillText = Array.isArray(brief?.metric_pills)
    ? brief.metric_pills.map((item) => [item?.label, item?.value].filter(Boolean).join(' ')).join(' ')
    : '';
  const tableText = Array.isArray(brief?.tables)
    ? brief.tables.flatMap((table) => [table.title, ...(table.columns || []), ...(table.rows || []).flat()]).join(' ')
    : '';

  return [
    brief?.headline,
    brief?.summary,
    metricPillText,
    ...(brief?.key_findings || []),
    ...(brief?.implications || []),
    ...(brief?.caveats || []),
    ...(brief?.next_steps || []),
    tableText,
  ].join(' ').toLowerCase();
}

function buildEvidenceClaimText(brief) {
  const metricPillText = Array.isArray(brief?.metric_pills)
    ? brief.metric_pills.map((item) => [item?.label, item?.value].filter(Boolean).join(' ')).join(' ')
    : '';
  const tableText = Array.isArray(brief?.tables)
    ? brief.tables.flatMap((table) => [table?.title, ...(table?.columns || []), ...(table?.rows || []).flat()]).join(' ')
    : '';

  return [
    brief?.headline,
    brief?.summary,
    metricPillText,
    ...(brief?.key_findings || []),
    ...(brief?.implications || []),
    tableText,
  ].join(' ');
}

function containsSpecificEvidenceNumber(text = '') {
  const sample = String(text || '').replace(/\b20\d{2}\b/g, ' ');
  return /\b\d+(?:[.,]\d+)?\s*%|\b\d{2,}(?:[.,]\d+)?\b/.test(sample);
}

function roundScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(10, Math.round(numeric * 10) / 10));
}

function scoreFromDimensionScores(scores) {
  const weighted = QA_DIMENSION_KEYS.reduce((sum, key) => {
    return sum + (Number(scores?.[key]) || 0) * QA_DIMENSION_WEIGHTS[key];
  }, 0);
  return roundScore(weighted);
}

function buildDefaultQaDimensionScores() {
  return {
    correctness: 10,
    completeness: 10,
    evidence_alignment: 10,
    visualization_fit: 10,
    caveat_quality: 10,
    clarity: 10,
    methodology_transparency: 10,
    actionability: 10,
  };
}

function lowerText(value) {
  return String(value || '').toLowerCase();
}

function tokenizeWords(text) {
  return lowerText(text)
    .replace(/[^a-z0-9\u3400-\u9fff\s]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function textSimilarity(a, b) {
  const aTokens = new Set(tokenizeWords(a));
  const bTokens = new Set(tokenizeWords(b));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  const shared = [...aTokens].filter((token) => bTokens.has(token)).length;
  return shared / Math.max(aTokens.size, bTokens.size);
}

function parseNumericValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const match = raw.match(/-?\d[\d,.]*/);
  if (!match) return null;

  let normalized = match[0];
  if (normalized.includes(',') && normalized.includes('.')) {
    normalized = normalized.replace(/,/g, '');
  } else if (normalized.includes(',') && !normalized.includes('.')) {
    const pieces = normalized.split(',');
    normalized = pieces.length > 1 && pieces[pieces.length - 1].length <= 2
      ? `${pieces.slice(0, -1).join('')}.${pieces[pieces.length - 1]}`
      : normalized.replace(/,/g, '');
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function detectDimensionFromText(text) {
  const sample = String(text || '');
  for (const entry of DIMENSION_PATTERNS) {
    if (entry.patterns.some((pattern) => pattern.test(sample))) {
      return entry.label;
    }
  }
  return '';
}

function detectMetricAlias(text) {
  const sample = String(text || '');
  const alias = METRIC_ALIAS_PATTERNS.find((entry) => entry.patterns.some((pattern) => pattern.test(sample)))?.key || '';
  const dimension = detectDimensionFromText(sample);
  if (alias && dimension) return `${alias} ${dimension}`;
  return alias || dimension;
}

function isQuantifiedMetricKey(metricKey) {
  return Boolean(metricKey) && !DIMENSION_LABELS.has(metricKey);
}

function pushMetricFact(facts, metricKey, numeric, sourceLabel, raw) {
  if (numeric == null || !isQuantifiedMetricKey(metricKey)) return;
  if (facts.some((fact) => fact.metricKey === metricKey && !areNumbersMeaningfullyDifferent(fact.value, numeric))) return;
  facts.push({ metricKey, value: numeric, source: sourceLabel, raw });
}

function extractExplicitMetricFacts(raw, sourceLabel = 'brief_text') {
  const facts = [];
  const explicitPercentileValuePatterns = (key, percentileText, percentileCnText) => ([
    new RegExp(`\\b${key}\\b(?!\\s*\\/)(?:\\s*(?:revenue|value))?\\s*(?:(?::|=|is|was|are)\\s*|(?:R\\$|\\$)\\s*)(-?\\d[\\d,.]*)`, 'ig'),
    new RegExp(`\\b${percentileText}\\b(?:\\s*(?:revenue|value))?\\s*(?:(?::|=|is|was|are)\\s*|(?:R\\$|\\$)\\s*)(-?\\d[\\d,.]*)`, 'ig'),
    new RegExp(`(?:${percentileCnText})(?:營收|值)?\\s*(?:(?::|=|為)\\s*|(?:R\\$|\\$)\\s*)(-?\\d[\\d,.]*)`, 'g'),
  ]);
  const explicitPatterns = [
    { key: 'median', patterns: [/\bmedian(?:\s+(?:seller\s+)?revenue)?\b(?:\s*\([^)]*\))?\s*(?:(?::|=|is|was|are)\s*|(?:R\$|\$)\s*)(-?\d[\d,.]*)/ig, /中位數(?:營收)?\s*(?:(?::|=|為)\s*|(?:R\$|\$)\s*)(-?\d[\d,.]*)/g, ...explicitPercentileValuePatterns('p50', '50(?:th)? percentile', '第?50分位|50分位')] },
    { key: 'p10', patterns: explicitPercentileValuePatterns('p10', '10(?:th)? percentile', '第?10分位|10分位') },
    { key: 'p25', patterns: explicitPercentileValuePatterns('p25', '25(?:th)? percentile', '第?25分位|25分位') },
    { key: 'p75', patterns: explicitPercentileValuePatterns('p75', '75(?:th)? percentile', '第?75分位|75分位') },
    { key: 'p90', patterns: explicitPercentileValuePatterns('p90', '90(?:th)? percentile', '第?90分位|90分位') },
    { key: 'p95', patterns: explicitPercentileValuePatterns('p95', '95(?:th)? percentile', '第?95分位|95分位') },
    { key: 'p99', patterns: explicitPercentileValuePatterns('p99', '99(?:th)? percentile', '第?99分位|99分位') },
    { key: 'mean', patterns: [/\b(?:mean|average|avg)(?:\s+seller|\s+revenue|\s+seller revenue)?\b[^0-9%\n]{0,24}(?:R\$|\$)?\s*(-?\d[\d,.]*)/ig, /平均(?:營收|值)?[^0-9%\n]{0,12}(?:R\$|\$)?\s*(-?\d[\d,.]*)/g] },
    { key: 'gini', patterns: [/\bgini\b[^0-9%\n]{0,12}(-?\d[\d,.]*)/ig, /基尼[^0-9%\n]{0,8}(-?\d[\d,.]*)/g] },
    { key: 'top 10 share', patterns: [/\btop\s*10(?:\s+sellers?)?(?:\s+share)?\b[^0-9\n]{0,16}(-?\d[\d,.]*)\s*%/ig, /(?:前10|top 10)(?:名)?(?:賣家)?(?:占比|佔比)?[^0-9\n]{0,12}(-?\d[\d,.]*)\s*%/ig] },
    { key: 'std', patterns: [/\b(?:std\s*dev|standard deviation)\b[^0-9%\n]{0,20}(?:R\$|\$)?\s*(-?\d[\d,.]*)/ig, /標準差[^0-9%\n]{0,10}(?:R\$|\$)?\s*(-?\d[\d,.]*)/g] },
    { key: 'count', patterns: [/\b(?:total sellers|seller count|total count)\b[^0-9%\n]{0,14}(\d[\d,.]*)/ig, /(?:賣家數|總賣家數|總數|總計)[^0-9%\n]{0,10}(\d[\d,.]*)/g] },
  ];

  for (const spec of explicitPatterns) {
    for (const pattern of spec.patterns) {
      const matcher = new RegExp(pattern.source, pattern.flags);
      for (const match of raw.matchAll(matcher)) {
        const numeric = parseNumericValue(match[1]);
        pushMetricFact(facts, spec.key, numeric, sourceLabel, raw);
      }
    }
  }

  return facts;
}

function collectMetricFacts(items = [], sourceLabel = 'brief') {
  const facts = [];

  for (const item of items) {
    if (!item) continue;
    if (typeof item === 'string') {
      facts.push(...extractExplicitMetricFacts(String(item), sourceLabel));
      continue;
    }

    const label = String(item.label || '').trim();
    const value = String(item.value || '').trim();
    const numeric = parseNumericValue(value);
    const metricKey = detectMetricAlias(label) || detectMetricAlias(`${label} ${value}`);
    pushMetricFact(facts, metricKey, numeric, sourceLabel, `${label}: ${value}`);
  }

  return facts;
}

function collectMetricFactsFromTables(tables = [], sourceLabel = 'brief_table') {
  const facts = [];

  for (const table of Array.isArray(tables) ? tables : []) {
    const columns = Array.isArray(table?.columns) ? table.columns.map((column) => String(column || '')) : [];
    const rows = Array.isArray(table?.rows) ? table.rows : [];
    if (columns.length === 0 || rows.length === 0) continue;

    for (const row of rows) {
      const cells = Array.isArray(row)
        ? row
        : columns.map((column) => row?.[column]);

      columns.forEach((column, index) => {
        const metricKey = detectMetricAlias(column);
        const numeric = parseNumericValue(cells[index]);
        pushMetricFact(facts, metricKey, numeric, sourceLabel, `${column}: ${cells[index]}`);
      });

      const rowLabelMetricKey = detectMetricAlias(cells[0]);
      if (rowLabelMetricKey && cells.length > 1) {
        const numeric = parseNumericValue(cells[1]);
        pushMetricFact(facts, rowLabelMetricKey, numeric, sourceLabel, `${cells[0]}: ${cells[1]}`);
      }
    }
  }

  return facts;
}

function collectMetricFactsFromCharts(charts = [], sourceLabel = 'artifact_chart') {
  const facts = [];

  for (const chart of Array.isArray(charts) ? charts : []) {
    const referenceLines = Array.isArray(chart?.referenceLines) ? chart.referenceLines : [];
    for (const line of referenceLines) {
      if (line?.label) {
        facts.push(...collectMetricFacts([String(line.label)], sourceLabel));
      }
    }
  }

  return facts;
}

function collectEvidenceMetricFacts({ brief, toolCalls = [] }) {
  const facts = [];
  facts.push(...collectMetricFacts(brief?.metric_pills || [], 'brief_metric_pills'));
  facts.push(...collectMetricFactsFromTables(brief?.tables || [], 'brief_tables'));
  facts.push(...collectMetricFacts([
    brief?.headline,
    brief?.summary,
    ...(brief?.key_findings || []),
    ...(brief?.caveats || []),
  ], 'brief_text'));

  const analysisPayloads = (Array.isArray(toolCalls) ? toolCalls : []).flatMap((toolCall) => extractAnalysisPayloadsFromToolCall(toolCall));
  for (const payload of analysisPayloads) {
    const payloadLabel = payload?.title || payload?.analysisType || 'artifact';
    if (isPlainObject(payload?.metrics)) {
      const metricItems = Object.entries(payload.metrics).map(([label, value]) => ({ label, value }));
      facts.push(...collectMetricFacts(metricItems, `artifact_metrics:${payloadLabel}`));
    }
    facts.push(...collectMetricFactsFromTables(payload?.tables || [], `artifact_tables:${payloadLabel}`));
    facts.push(...collectMetricFactsFromCharts(payload?.charts || [], `artifact_chart:${payloadLabel}`));
    facts.push(...collectMetricFacts([
      payload?.summary,
      ...(payload?.highlights || []),
    ], `artifact_text:${payloadLabel}`));
  }

  return facts;
}

function areNumbersMeaningfullyDifferent(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const delta = Math.abs(a - b);
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return delta > Math.max(0.5, scale * 0.02);
}

function summarizeArtifacts(toolCalls = []) {
  const analysisPayloads = (Array.isArray(toolCalls) ? toolCalls : []).flatMap((toolCall) => extractAnalysisPayloadsFromToolCall(toolCall));
  if (analysisPayloads.length === 0) return 'No structured artifacts.';

  return analysisPayloads.slice(0, 5).map((payload, index) => {
    const chartTypes = Array.isArray(payload?.charts)
      ? uniqueStrings(payload.charts.map((chart) => String(chart?.type || '').trim()).filter(Boolean))
      : [];
    const metrics = isPlainObject(payload?.metrics)
      ? Object.entries(payload.metrics).slice(0, 10).map(([label, value]) => `${label}=${formatValue(value)}`).join(', ')
      : 'none';

    return `${index + 1}. ${payload?.title || payload?.analysisType || 'artifact'} | charts=${chartTypes.join(', ') || 'none'} | metrics=${metrics}`;
  }).join('\n');
}

function normalizePercentileCoverageKey(metricKey) {
  const normalized = String(metricKey || '').toLowerCase();
  if (normalized === 'median' || normalized === 'median revenue') return 'p50';
  if (REQUESTED_PERCENTILE_KEYS.includes(normalized)) return normalized;
  if (normalized.startsWith('p10 ')) return 'p10';
  if (normalized.startsWith('p25 ')) return 'p25';
  if (normalized.startsWith('p50 ')) return 'p50';
  if (normalized.startsWith('p75 ')) return 'p75';
  if (normalized.startsWith('p90 ')) return 'p90';
  if (normalized.startsWith('p95 ')) return 'p95';
  if (normalized.startsWith('p99 ')) return 'p99';
  return '';
}

function collectNarrativeQuantileKeys(brief) {
  const found = new Set();
  const narrativeLines = [
    brief?.summary,
    ...(brief?.key_findings || []),
  ].filter(Boolean);
  const metricFacts = collectMetricFacts([
    ...narrativeLines,
  ], 'brief_narrative');

  for (const fact of metricFacts) {
    const normalizedKey = normalizePercentileCoverageKey(fact.metricKey);
    if (normalizedKey) found.add(normalizedKey);
  }

  for (const line of narrativeLines) {
    if (!/-?\d[\d,.]*/.test(String(line || ''))) continue;
    collectPercentileKeysFromText(line).forEach((key) => found.add(key));
  }

  return found;
}

function hasCoreQuantileNarrative(brief) {
  const narrativeKeys = collectNarrativeQuantileKeys(brief);
  return (
    narrativeKeys.has('p25')
    && narrativeKeys.has('p50')
    && narrativeKeys.has('p75')
    && (narrativeKeys.has('p90') || narrativeKeys.has('p95'))
  );
}

function containsInventedToolFailure(text = '') {
  const sample = String(text || '');
  return (
    /worker access error|sql worker access error|data[- ]connection error|sql connection (?:error|failed|unavailable)|local sql worker/i.test(sample)
    || /(?:sql|query(?:_sap_data)?|worker|connection|tool)[^.!?\n]{0,40}(?:failed|failure|error|unavailable|blocked|timed out|timeout|retry)/i.test(sample)
  );
}

function containsBlockedEvidenceClaim(text = '') {
  const sample = String(text || '');
  return (
    /(?:could not|couldn't|unable to|cannot|can't|did not|failed to)\s+(?:retrieve|get|return|access)[^.!?\n]{0,60}(?:sql|query|quantile|percentile|q1|q3|p95)/i.test(sample)
    || /once the sql connection is available|need to retry sql|retry and return the exact/i.test(sample)
  );
}

function hasMethodologyCaveat(brief) {
  return (brief?.caveats || []).some((line) => /proxy|approx|approximation|限制|近似|代理指標|duplicate|duplication|log[-\s]?scale|對數分箱/i.test(String(line || '')));
}

// ── Magnitude cross-validation: SQL result values vs narrative claims ──────
// Extracts large numeric values from SQL result rows and checks whether the
// brief text cites any number that is >3x or <0.33x of a SQL-returned value
// sharing the same column-name keyword.  This catches the "24-month total
// presented as monthly average" class of bug.
function detectMagnitudeMismatches({ brief, toolCalls = [] }) {
  const mismatches = [];
  // 1. Collect numeric values from successful query_sap_data results
  const sqlValues = new Map(); // columnName → Set<number>
  for (const tc of (Array.isArray(toolCalls) ? toolCalls : [])) {
    if (tc?.name !== 'query_sap_data' || !tc?.result?.success) continue;
    const rows = getStructuredRows(tc);
    for (const row of rows) {
      if (!isPlainObject(row)) continue;
      for (const [col, val] of Object.entries(row)) {
        const num = typeof val === 'number' ? val : parseFloat(String(val || '').replace(/,/g, ''));
        if (!Number.isFinite(num) || Math.abs(num) < 10) continue; // skip trivial values
        if (!sqlValues.has(col)) sqlValues.set(col, new Set());
        sqlValues.get(col).add(num);
      }
    }
  }
  if (sqlValues.size === 0) return mismatches;

  // 2. Collect numeric claims from brief narrative
  const briefText = [
    brief?.headline,
    brief?.summary,
    ...(brief?.key_findings || []),
    ...(brief?.implications || []),
  ].filter(Boolean).join(' ');

  // Extract all R$ or plain large numbers from brief
  const briefNumbers = [];
  const moneyPattern = /R?\$\s*([\d,.]+)/g;
  const plainNumPattern = /\b(\d{3,}(?:[,.]\d+)?)\b/g;
  for (const pattern of [moneyPattern, plainNumPattern]) {
    for (const match of briefText.matchAll(new RegExp(pattern.source, pattern.flags))) {
      const parsed = parseFloat(match[1].replace(/,/g, ''));
      if (Number.isFinite(parsed) && parsed >= 100) briefNumbers.push(parsed);
    }
  }
  if (briefNumbers.length === 0) return mismatches;

  // 3. For each SQL column, check if any brief number is wildly different
  //    from ALL values in that column (>3x or <0.33x every value)
  for (const [col, valueSet] of sqlValues) {
    const sqlNums = [...valueSet];
    // Only check revenue/price/value columns (most prone to aggregation errors)
    if (!/revenue|price|value|total|amount|sum|avg|mean|月均|營收/i.test(col)) continue;
    const maxSql = Math.max(...sqlNums);
    const minSql = Math.min(...sqlNums.filter((v) => v > 0));

    for (const briefNum of briefNumbers) {
      // Brief claims a number >3x the largest SQL value for this column
      if (briefNum > maxSql * 3 && maxSql > 100) {
        mismatches.push(
          `Narrative cites ${briefNum.toLocaleString()} but SQL column "${col}" max is ${maxSql.toLocaleString()} — possible ${Math.round(briefNum / maxSql)}x inflation.`
        );
      }
      // Brief claims a number <0.33x the smallest SQL value (possible under-reporting)
      if (briefNum > 0 && briefNum < minSql * 0.33 && minSql > 100) {
        mismatches.push(
          `Narrative cites ${briefNum.toLocaleString()} but SQL column "${col}" min is ${minSql.toLocaleString()} — possible under-reporting.`
        );
      }
    }
  }

  return mismatches;
}

function collectContradictoryClaims({ brief, toolCalls = [] }) {
  const facts = collectEvidenceMetricFacts({ brief, toolCalls });

  const groupedFacts = facts.reduce((acc, fact) => {
    if (!fact.metricKey) return acc;
    acc[fact.metricKey] = acc[fact.metricKey] || [];
    acc[fact.metricKey].push(fact);
    return acc;
  }, {});

  return Object.entries(groupedFacts).flatMap(([metricKey, metricFacts]) => {
    if (metricFacts.length < 2) return [];
    const distinctFacts = [];
    for (const fact of metricFacts) {
      if (!distinctFacts.some((entry) => !areNumbersMeaningfullyDifferent(entry.value, fact.value))) {
        distinctFacts.push(fact);
      }
    }
    if (distinctFacts.length < 2) return [];

    const detail = distinctFacts.slice(0, 3).map((fact) => `${formatValue(fact.value)} (${fact.source})`);
    return [`Conflicting ${metricKey} values detected: ${detail.join(' vs ')}`];
  });
}

function getChartTypesFromToolCalls(toolCalls = []) {
  return uniqueStrings((Array.isArray(toolCalls) ? toolCalls : [])
    .flatMap((toolCall) => extractAnalysisPayloadsFromToolCall(toolCall))
    .flatMap((payload) => Array.isArray(payload?.charts) ? payload.charts.map((chart) => String(chart?.type || '').toLowerCase()) : [])
    .filter(Boolean));
}

function requiresCaveat({ trace, finalAnswerText, toolCalls, brief }) {
  const caveats = Array.isArray(brief?.caveats) ? brief.caveats : [];

  const joinedText = [
    finalAnswerText,
    summarizeArtifacts(toolCalls),
    ...trace.failed_attempts.map((attempt) => attempt?.error || attempt?.summary || ''),
  ].join(' ');

  const needsFailureCaveat = trace.failed_attempts.length > 0;
  const needsMethodologyCaveat = /(proxy|approx|approximation|限制|近似|代理指標|duplicate|duplication)/i.test(joinedText);
  const needsPartialEvidenceCaveat = /partial evidence|incomplete/i.test(joinedText);
  const hasFailureCaveat = caveats.some((line) => /failed|failure|error|partial evidence|incomplete|失敗|錯誤|不完整/i.test(String(line || '')));

  if (needsFailureCaveat && !hasFailureCaveat) return true;
  if (needsMethodologyCaveat && !hasMethodologyCaveat(brief)) return true;
  if (needsPartialEvidenceCaveat && !hasFailureCaveat && !hasMethodologyCaveat(brief)) return true;
  return false;
}

function hasCoveredDimension({ dimension, briefText, structuredCoverage }) {
  const normalized = String(dimension || '').trim().toLowerCase();
  if (!normalized) return true;
  const coveredDimensions = new Set((structuredCoverage?.coveredDimensions || []).map((item) => String(item || '').toLowerCase()));
  if (coveredDimensions.has(normalized)) return true;
  if (normalized === 'quantiles' || normalized === 'percentiles') {
    return (structuredCoverage?.foundPercentiles || []).length > 0 || /\bquantiles?\b|\bpercentiles?\b|分位數|百分位/.test(briefText);
  }
  return briefText.includes(normalized);
}

export function computeDeterministicQa({
  userMessage = '',
  answerContract,
  brief,
  toolCalls = [],
  finalAnswerText = '',
}) {
  const trace = buildTrace(toolCalls, finalAnswerText);
  const blockers = [];
  const issues = [];
  const repairInstructions = [];
  const dimensionScores = buildDefaultQaDimensionScores();
  const briefText = buildBriefSearchText(brief);
  const requestedSpecialChart = detectRequestedSpecialChart(userMessage);
  const structuredCoverage = getStructuredAnswerCoverage({
    toolCalls,
    requestedChart: requestedSpecialChart,
    userMessage,
  });
  const wantsChart = (answerContract?.required_outputs || []).includes('chart');
  const chartTypes = getChartTypesFromToolCalls(toolCalls);
  const hasSuccessfulEvidence = trace.successful_queries.length > 0 || chartTypes.length > 0;
  const quantileRequested = (answerContract?.required_dimensions || []).some((dimension) => /quantiles?|percentiles?/i.test(String(dimension || '')));
  const combinedNarrativeText = [
    brief?.headline,
    brief?.summary,
    ...(brief?.key_findings || []),
    ...(brief?.caveats || []),
    finalAnswerText,
  ].filter(Boolean).join(' ');
  const evidenceClaimText = buildEvidenceClaimText(brief);

  const missingDimensions = (answerContract?.required_dimensions || []).filter((dimension) => (
    dimension && !hasCoveredDimension({ dimension, briefText, structuredCoverage })
  ));
  if (missingDimensions.length > 0) {
    const issue = `Missing required dimensions: ${missingDimensions.join(', ')}`;
    blockers.push(issue);
    issues.push(issue);
    repairInstructions.push(`Explicitly cover these dimensions: ${missingDimensions.join(', ')}.`);
    dimensionScores.completeness = Math.max(0, dimensionScores.completeness - Math.min(6, missingDimensions.length * 2.5));
  }

  const contradictoryClaims = collectContradictoryClaims({ brief, toolCalls });
  if (contradictoryClaims.length > 0) {
    blockers.push(...contradictoryClaims);
    issues.push(...contradictoryClaims);
    repairInstructions.push('Resolve contradictory metric values and keep one explained source of truth in the brief.');
    dimensionScores.correctness = Math.max(0, dimensionScores.correctness - 5);
    dimensionScores.evidence_alignment = Math.max(0, dimensionScores.evidence_alignment - 4);
  }

  // ── Magnitude mismatch: narrative numbers wildly different from SQL results ──
  const magnitudeMismatches = detectMagnitudeMismatches({ brief, toolCalls });
  if (magnitudeMismatches.length > 0) {
    const issue = `Magnitude mismatch between SQL evidence and narrative: ${magnitudeMismatches[0]}`;
    blockers.push(issue);
    issues.push(issue, ...magnitudeMismatches.slice(1));
    repairInstructions.push(
      'Re-check aggregation period: if the SQL sums across the full date range, divide by the number of months to get a true monthly average. '
      + 'Ensure narrative numbers match SQL result values within 3x tolerance.'
    );
    dimensionScores.correctness = Math.max(0, dimensionScores.correctness - 5);
    dimensionScores.evidence_alignment = Math.max(0, dimensionScores.evidence_alignment - 4);
  }

  if (trace.failed_attempts.length === 0 && containsInventedToolFailure(combinedNarrativeText)) {
    const issue = 'The answer claims a SQL, worker, connection, or tool failure that does not exist in the execution trace.';
    blockers.push(issue);
    issues.push(issue);
    repairInstructions.push('Remove the invented SQL/tool failure claim and rely on the successful artifact evidence instead.');
    dimensionScores.correctness = Math.max(0, dimensionScores.correctness - 6);
    dimensionScores.caveat_quality = Math.max(0, dimensionScores.caveat_quality - 4);
  }

  if (
    trace.failed_attempts.length === 0
    && structuredCoverage.successfulButEmptyQueries.length > 0
    && containsBlockedEvidenceClaim(combinedNarrativeText)
  ) {
    const issue = 'Successful 0-row SQL lookups were described as blocked or failed evidence.';
    blockers.push(issue);
    issues.push(issue);
    repairInstructions.push('Describe successful 0-row SQL lookups as adding no evidence, not as blocked or failed execution.');
    dimensionScores.correctness = Math.max(0, dimensionScores.correctness - 4);
    dimensionScores.evidence_alignment = Math.max(0, dimensionScores.evidence_alignment - 3);
  }

  const checkFields = [
    brief?.headline,
    brief?.summary,
    ...(brief?.key_findings || []),
    ...(brief?.implications || []),
    ...(brief?.caveats || []),
  ].filter(Boolean);

  if (checkFields.some((line) => DEBUG_PATTERNS.some((pattern) => pattern.test(String(line || ''))))) {
    const issue = 'Debug or execution transcript leaked into the main brief.';
    blockers.push(issue);
    issues.push(issue);
    repairInstructions.push('Remove tool/debug transcript from the brief and keep it only in the execution trace.');
    dimensionScores.clarity = Math.max(0, dimensionScores.clarity - 6);
  }

  if (checkFields.some((line) => PSEUDO_TABLE_PATTERN.test(String(line || '')) && !MARKDOWN_TABLE_PATTERN.test(String(line || '')))) {
    issues.push('Pseudo-table formatting leaked into the brief.');
    repairInstructions.push('Replace pseudo-table text with structured findings or structured tables.');
    dimensionScores.clarity = Math.max(0, dimensionScores.clarity - 3);
  }

  const normalizedSections = uniqueStrings(checkFields);
  const hasExactDuplicate = normalizedSections.length < checkFields.length;
  const hasNearDuplicate = normalizedSections.some((section, index) => (
    normalizedSections.slice(index + 1).some((other) => textSimilarity(section, other) >= 0.88)
  ));
  if (hasExactDuplicate || hasNearDuplicate) {
    const issue = 'The main brief repeats the same content across sections.';
    blockers.push(issue);
    issues.push(issue);
    repairInstructions.push('Remove repeated sentences and keep each section additive.');
    dimensionScores.clarity = Math.max(0, dimensionScores.clarity - 4);
  }

  const evidenceTables = Array.isArray(brief?.tables) ? brief.tables : [];
  const emptyEvidence = evidenceTables.length === 0;
  const singleColumnTable = evidenceTables.some((table) => Array.isArray(table?.columns) && table.columns.length <= 1);
  if (emptyEvidence) {
    issues.push('The brief has no structured evidence table.');
    dimensionScores.evidence_alignment = Math.max(0, dimensionScores.evidence_alignment - 3);
  }
  if (singleColumnTable) {
    issues.push('The evidence table is a low-value single-column dump.');
    repairInstructions.push('Reshape evidence into a comparative table with meaningful columns.');
    dimensionScores.evidence_alignment = Math.max(0, dimensionScores.evidence_alignment - 4);
  }
  if (answerContract?.task_type === 'comparison') {
    const hasComparableTable = evidenceTables.some((table) => (
      Array.isArray(table?.columns)
      && table.columns.length >= 2
      && Array.isArray(table?.rows)
      && table.rows.length > 0
    ));
    if (!hasComparableTable) {
      const issue = 'Comparison request lacks structured comparative evidence.';
      blockers.push(issue);
      issues.push(issue);
      repairInstructions.push('Add a comparison table or comparative findings that cover each requested dimension.');
      dimensionScores.completeness = Math.max(0, dimensionScores.completeness - 3);
      dimensionScores.evidence_alignment = Math.max(0, dimensionScores.evidence_alignment - 3);
    }
  }

  if (wantsChart && chartTypes.length === 0) {
    const issue = 'The request asked for a chart, but no structured chart artifact is present.';
    blockers.push(issue);
    issues.push(issue);
    repairInstructions.push('Ensure the answer includes or references a chart artifact that matches the request.');
    dimensionScores.visualization_fit = Math.max(0, dimensionScores.visualization_fit - 6);
  }
  const CHART_COMPAT = { histogram: ['bar', 'histogram'], bar: ['bar', 'histogram'] };
  const isChartCompat = chartTypes.some((t) => (CHART_COMPAT[requestedSpecialChart] || []).includes(t));
  if (requestedSpecialChart && chartTypes.length > 0 && !chartTypes.includes(requestedSpecialChart) && !isChartCompat) {
    const issue = `Requested ${requestedSpecialChart} but the artifact uses ${chartTypes.join(', ')}.`;
    blockers.push(issue);
    issues.push(issue);
    repairInstructions.push(`Align the chart type with the requested ${requestedSpecialChart}.`);
    dimensionScores.visualization_fit = Math.max(0, dimensionScores.visualization_fit - 6);
  }
  if (answerContract?.task_type === 'trend' && chartTypes.length > 0 && !chartTypes.some((type) => ['line', 'area', 'stacked_area'].includes(type))) {
    issues.push('Trend analysis is not using a trend-oriented chart type.');
    repairInstructions.push('Use a line or area chart framing for trend-focused requests.');
    dimensionScores.visualization_fit = Math.max(0, dimensionScores.visualization_fit - 3);
  }

  if (quantileRequested && requestedSpecialChart === 'histogram') {
    const foundPercentiles = new Set((structuredCoverage?.foundPercentiles || []).map((key) => String(key || '').toLowerCase()));
    const missingPercentiles = REQUESTED_PERCENTILE_KEYS.filter((key) => !structuredCoverage?.quantileCoverage?.[key] && !foundPercentiles.has(key));
    const annotatedPercentiles = new Set((structuredCoverage?.annotatedPercentiles || []).map((key) => String(key || '').toLowerCase()));
    const missingAnnotatedPercentiles = REQUESTED_PERCENTILE_KEYS.filter((key) => !annotatedPercentiles.has(key));

    if (missingPercentiles.length > 0) {
      const issue = `Missing required quantile values: ${missingPercentiles.map((key) => key.toUpperCase()).join(', ')}`;
      blockers.push(issue);
      issues.push(issue);
      repairInstructions.push(`Provide exact values for ${missingPercentiles.map((key) => key.toUpperCase()).join(', ')}.`);
      dimensionScores.completeness = Math.max(0, dimensionScores.completeness - 4);
      dimensionScores.evidence_alignment = Math.max(0, dimensionScores.evidence_alignment - 2);
    }

    if (missingAnnotatedPercentiles.length > 0) {
      const issue = `Histogram quantiles are not directly marked on the chart artifact: ${missingAnnotatedPercentiles.map((key) => key.toUpperCase()).join(', ')}`;
      blockers.push(issue);
      issues.push(issue);
      repairInstructions.push('Add quantile reference lines or equivalent chart annotations for the requested histogram.');
      dimensionScores.visualization_fit = Math.max(0, dimensionScores.visualization_fit - 4);
    }

    const artifactHasCoreQuantiles = ['p25', 'p50', 'p75'].every((key) => structuredCoverage?.quantileCoverage?.[key])
      && (structuredCoverage?.quantileCoverage?.p90 || structuredCoverage?.quantileCoverage?.p95);
    if (artifactHasCoreQuantiles && structuredCoverage?.hasHistogramQuantileAnnotations && !hasCoreQuantileNarrative(brief)) {
      const issue = 'Histogram quantiles are present in the artifact, but the brief does not clearly summarize the core cut points P25, P50, P75, and P90/P95.';
      // Soft issue, not blocker: the data exists in the artifact, just needs narration.
      // The repair cycle should fix this, so keep penalties moderate.
      issues.push(issue);
      repairInstructions.push('Summarize the core quantile cut points directly in the summary or key findings using the evidenced values.');
      dimensionScores.completeness = Math.max(0, dimensionScores.completeness - 2);
      dimensionScores.evidence_alignment = Math.max(0, dimensionScores.evidence_alignment - 1);
    }
  }

  if (requiresCaveat({ trace, finalAnswerText, toolCalls, brief })) {
    const issue = 'Brief is missing a caveat despite failed, proxy-based, or partial evidence.';
    blockers.push(issue);
    issues.push(issue);
    repairInstructions.push('Add a concise caveat for the failed step, proxy metric, or incomplete evidence.');
    dimensionScores.caveat_quality = Math.max(0, dimensionScores.caveat_quality - 6);
  }

  // Soft caveat: analysis relies solely on pre-computed chart artifact without raw SQL verification
  const successfulToolCalls = toolCalls.filter((tc) => tc?.result?.success);
  const hasOnlyChartEvidence = successfulToolCalls.length > 0
    && successfulToolCalls.every((tc) => tc?.name === 'generate_chart');
  const hasRawDataSource = successfulToolCalls.some((tc) =>
    tc?.name === 'query_sap_data' || tc?.name === 'run_python_analysis');
  if (hasOnlyChartEvidence && !hasRawDataSource && !hasMethodologyCaveat(brief)) {
    const issue = 'Analysis relies on a pre-computed chart artifact without independent data verification.';
    issues.push(issue);
    repairInstructions.push('Add a brief note that the analysis uses pre-computed chart metrics rather than live SQL queries.');
    dimensionScores.caveat_quality = Math.max(0, dimensionScores.caveat_quality - 3);
  }

  const hasStructuredEvidencePresentation = (Array.isArray(brief?.metric_pills) && brief.metric_pills.length > 0)
    || (Array.isArray(brief?.tables) && brief.tables.length > 0);

  if (!hasSuccessfulEvidence && trace.failed_attempts.length > 0 && hasStructuredEvidencePresentation) {
    const issue = 'The brief presents metric pills or evidence tables even though no tool call succeeded.';
    blockers.push(issue);
    issues.push(issue);
    repairInstructions.push('Remove unsupported metric pills and evidence tables when there is no successful tool evidence.');
    dimensionScores.correctness = Math.max(0, dimensionScores.correctness - 5);
    dimensionScores.evidence_alignment = Math.max(0, dimensionScores.evidence_alignment - 5);
  }

  if (!hasSuccessfulEvidence && trace.failed_attempts.length > 0 && containsSpecificEvidenceNumber(evidenceClaimText)) {
    const issue = 'The brief cites specific numbers despite having no successful evidence.';
    blockers.push(issue);
    issues.push(issue);
    repairInstructions.push('Remove unsupported numeric claims or restate them as generic heuristics instead of dataset-specific findings.');
    dimensionScores.correctness = Math.max(0, dimensionScores.correctness - 5);
    dimensionScores.evidence_alignment = Math.max(0, dimensionScores.evidence_alignment - 4);
  }

  if (!hasSuccessfulEvidence && trace.failed_attempts.length > 0) {
    const issue = 'The answer appears confident despite lacking successful evidence.';
    blockers.push(issue);
    issues.push(issue);
    repairInstructions.push('State clearly that evidence is incomplete and avoid overconfident conclusions.');
    dimensionScores.correctness = Math.max(0, dimensionScores.correctness - 4);
    dimensionScores.caveat_quality = Math.max(0, dimensionScores.caveat_quality - 2);
  }

  // ── Zero-row overconfidence: all SQL queries returned 0 rows but brief cites numbers ──
  const zeroRowSqlQueries = trace.successful_queries.filter(
    (q) => q.name === 'query_sap_data' && (q.rowCount === 0 || q.rowCount == null)
  );
  const hasOnlyZeroRowSqlEvidence = zeroRowSqlQueries.length > 0
    && trace.successful_queries.every((q) => q.name !== 'query_sap_data' || q.rowCount === 0 || q.rowCount == null);
  // Check if brief cites specific numbers (2+ digits) excluding years like 2024-2026
  const hasSpecificNumbers = /\b\d{2,}\b/.test(briefText) && !/^\s*$/.test(briefText.replace(/\b20[12]\d\b/g, ''));
  const hasNoCaveats = !brief?.caveats || brief.caveats.length === 0;
  const zeroRowOverconfidence = hasOnlyZeroRowSqlEvidence && hasSpecificNumbers && hasNoCaveats && chartTypes.length === 0;

  if (zeroRowOverconfidence) {
    const issue = 'Brief cites specific numbers but all SQL queries returned 0 rows and no chart artifact provided data — possible hallucination.';
    blockers.push(issue);
    issues.push(issue);
    contradictoryClaims.push(issue);
    repairInstructions.push('All SQL queries returned 0 rows. Remove unsupported numbers or add a caveat that no SQL evidence was found. Only cite numbers from chart/analysis artifacts if they exist.');
    dimensionScores.correctness = Math.max(0, dimensionScores.correctness - 5);
    dimensionScores.evidence_alignment = Math.max(0, dimensionScores.evidence_alignment - 5);
  }

  // ── Analysis Depth checks: methodology_transparency + actionability ──
  const analysisDepth = Array.isArray(answerContract?.analysis_depth) ? answerContract.analysis_depth : [];

  if (
    analysisDepth.includes('methodology_disclosure')
    && (answerContract?.task_type === 'recommendation' || answerContract?.task_type === 'diagnostic')
  ) {
    const METHODOLOGY_MARKERS = /\bbased on\b|formula|model|assumption|standard deviation|sigma|percentile|pareto|weighted average|ROP|EOQ|service level|z[=＝×]\d|confidence interval|SS\s*=|ROP\s*=|EOQ\s*=|σ.*√|sqrt\(L|service level.*\d+%|\d+%.*service/i;
    const methodologyText = [
      brief?.summary,
      brief?.methodology_note,
      ...(brief?.key_findings || []),
      ...(brief?.implications || []),
    ].filter(Boolean).join(' ');
    const hasMethodologyMarker = METHODOLOGY_MARKERS.test(methodologyText);
    const hasNumericThreshold = /\b\d+(?:\.\d+)?\s*(?:units?|days?|%|x|倍|個|天|件)/i.test(methodologyText);
    if (!hasMethodologyMarker && hasNumericThreshold) {
      const issue = 'Numeric thresholds cited without disclosing the methodology or model used.';
      blockers.push(issue);
      issues.push(issue);
      repairInstructions.push('State the formula, model, or assumption behind each numeric threshold (e.g., "SS = Z × √(LT × σ²_d + d̄² × σ²_LT), Z=1.645 for 95% service level").');
      dimensionScores.methodology_transparency = Math.max(0, dimensionScores.methodology_transparency - 6);
    }
  }

  if (
    analysisDepth.includes('actionable_parameters')
    && answerContract?.task_type === 'recommendation'
  ) {
    const ACTION_MARKERS = /set .+ to \d|target .+ at \d|\d+ units|\d+ days|\d+%|安全庫存.{0,10}\d|補貨點.{0,10}\d|目標.{0,10}\d/i;
    const RECOMMEND_MARKERS = /\brecommend|suggest|advise|建議|應該/i;
    const actionText = [
      ...(brief?.next_steps || []),
      ...(brief?.key_findings || []),
      ...(brief?.implications || []),
    ].filter(Boolean).join(' ');
    const hasActionMarker = ACTION_MARKERS.test(actionText);
    const hasRecommendMarker = RECOMMEND_MARKERS.test(actionText);
    if (hasRecommendMarker && !hasActionMarker) {
      const issue = 'Recommendations lack specific actionable parameters (e.g., "set safety stock to 45 units").';
      issues.push(issue);
      repairInstructions.push('Include at least one specific numeric parameter in each recommendation.');
      dimensionScores.actionability = Math.max(0, dimensionScores.actionability - 5);
    }
  }

  if (
    analysisDepth.includes('sensitivity_range')
    && answerContract?.task_type === 'recommendation'
  ) {
    const sensitivityTable = (brief?.tables || []).find((table) =>
      /sensitiv|scenario|what.if|parameter.comparison|情境|敏感度/i.test(String(table?.title || '')));
    if (!sensitivityTable) {
      const issue = 'Recommendation lacks a sensitivity analysis table with multiple scenarios.';
      blockers.push(issue);
      issues.push(issue);
      repairInstructions.push('Add a Sensitivity Analysis table with at least 3 scenarios (conservative/moderate/aggressive) and corresponding parameter + outcome.');
      dimensionScores.methodology_transparency = Math.max(0, dimensionScores.methodology_transparency - 4);
    } else {
      const tableRows = Array.isArray(sensitivityTable?.rows) ? sensitivityTable.rows : [];
      if (tableRows.length < 3) {
        const issue = `Sensitivity table has only ${tableRows.length} row(s); at least 3 scenarios required.`;
        issues.push(issue);
        repairInstructions.push('Expand the sensitivity table to at least 3 rows (e.g., conservative/moderate/aggressive).');
        dimensionScores.methodology_transparency = Math.max(0, dimensionScores.methodology_transparency - 2);
      }
    }
  }

  // ── Domain formula verification ──
  const domain = detectDomain(userMessage);
  if (domain.domainKey) {
    const formulaInconsistencies = verifyFormulaConsistency(brief, toolCalls, domain.domainKey);
    if (formulaInconsistencies.length > 0) {
      for (const finding of formulaInconsistencies.slice(0, 3)) {
        issues.push(finding);
      }
      const deduction = Math.min(6, formulaInconsistencies.length * 3);
      dimensionScores.correctness = Math.max(0, dimensionScores.correctness - deduction);
      repairInstructions.push('Recheck formula calculations against SQL evidence. Ensure SS = Z × √(LT × σ²_d + d̄² × σ²_LT) values match the stated inputs.');
    }
  }

  // ── Recipe compliance QA ──
  // When a recipe was active (e.g. safety_stock_optimization), check that key
  // outputs prescribed by the recipe are present in the agent response.
  if (answerContract?.recipe_id === 'safety_stock_optimization' || (
    domain.domainKey === 'supply_chain'
    && domain.matchedConcepts?.some(c => ['safety_stock', 'reorder_point', 'replenishment'].includes(c))
    && ['recommendation', 'diagnostic', 'mixed'].includes(answerContract?.task_type)
  )) {
    const combinedText = [brief, ...toolCalls.map(tc => JSON.stringify(tc.result || ''))].join(' ');

    // Check ABC-XYZ classification
    if (!/ABC|XYZ|分群|classification/i.test(combinedText)) {
      issues.push('Recipe prescribes ABC-XYZ classification but none found in output.');
      repairInstructions.push('Add ABC-XYZ classification: ABC by cumulative revenue (A=80%, B=15%, C=5%), XYZ by CV (X<0.25, Y<0.50, Z≥0.50). Assign differentiated service levels per group.');
      dimensionScores.methodology_transparency = Math.max(0, dimensionScores.methodology_transparency - 3);
    }

    // Check stationarity / stable period selection
    if (!/stabili|stationari|穩態|穩定期|stable.period|trend.detect/i.test(combinedText)) {
      issues.push('Recipe prescribes stationarity check and stable-period selection but none found.');
      repairInstructions.push('Check for demand trends (compare first-half vs second-half means). If trend >15%, use only the recent stable window for CV computation.');
      dimensionScores.methodology_transparency = Math.max(0, dimensionScores.methodology_transparency - 2);
    }

    // Check full SS formula usage (not just simplified)
    if (/σ_LT|σ²_LT|lead.time.std|lead.time.variab/i.test(combinedText) === false
        && !/simplified|σ_LT\s*=\s*0/i.test(combinedText)) {
      issues.push('Recipe prescribes full SS formula with σ_LT term but response uses simplified formula without disclosure.');
      repairInstructions.push('Use full formula SS = Z × √(LT × σ²_d + d̄² × σ²_LT) when lead time variability is available, or explicitly disclose when using simplified version (σ_LT=0).');
      dimensionScores.correctness = Math.max(0, dimensionScores.correctness - 2);
    }
  }

  // ── Pre-analysis data validation warning acknowledgment ──
  const dataValidationWarnings = toolCalls.flatMap((tc) => tc._dataValidationWarnings || []);
  const businessContextClues = toolCalls.flatMap((tc) => tc._businessContextClues || []);

  for (const warning of dataValidationWarnings.filter((w) => w.severity === 'high')) {
    const patterns = WARNING_ACKNOWLEDGMENT_PATTERNS[warning.id] || [];
    const acknowledged = patterns.some((p) => p.test(combinedNarrativeText));
    if (!acknowledged) {
      issues.push(`Data quality warning not addressed: ${warning.message}`);
      repairInstructions.push(`Address data quality issue: ${warning.instruction}`);
      dimensionScores.correctness = Math.max(0, dimensionScores.correctness - 3);
      dimensionScores.caveat_quality = Math.max(0, dimensionScores.caveat_quality - 2);
    }
  }

  for (const clue of businessContextClues) {
    const acknowledged = (clue.acknowledgmentPatterns || []).some((p) => p.test(combinedNarrativeText));
    if (!acknowledged) {
      issues.push(`Business context not addressed: ${clue.shortMessage}`);
      repairInstructions.push(`Add caveat about business context: ${clue.shortMessage}`);
      dimensionScores.caveat_quality = Math.max(0, dimensionScores.caveat_quality - 3);
    }
  }

  // Proxy disclosure check
  const proxyUsageHinted = /as.*(?:lead time|前置時間)|(?:delivery|交貨).*(?:as|作為|當作)|used.*as.*proxy|作為.*替代/i.test(combinedNarrativeText);
  const proxyDisclosed = /proxy|surrogate|approximate|替代指標|代理指標|近似值/i.test(combinedNarrativeText);
  if (proxyUsageHinted && !proxyDisclosed) {
    issues.push('Agent appears to use a proxy metric without explicit disclosure.');
    repairInstructions.push('Explicitly label any proxy metrics used with "⚠️ Proxy" and assess their impact on accuracy.');
    dimensionScores.methodology_transparency = Math.max(0, dimensionScores.methodology_transparency - 4);
  }

  const score = scoreFromDimensionScores(dimensionScores);

  return {
    score,
    blockers: uniqueStrings(blockers),
    issues: uniqueStrings(issues),
    repair_instructions: uniqueStrings(repairInstructions),
    dimension_scores: Object.fromEntries(QA_DIMENSION_KEYS.map((key) => [key, roundScore(dimensionScores[key])])),
    missing_dimensions: uniqueStrings(missingDimensions),
    contradictory_claims: uniqueStrings(contradictoryClaims),
    flags: {
      contradictions: contradictoryClaims.length > 0,
      chart_mismatch: blockers.some((issue) => /chart|histogram|heatmap|scatter|pie|treemap/i.test(issue)),
      empty_evidence: emptyEvidence || singleColumnTable,
      tool_failure_overconfidence: trace.failed_attempts.length > 0 && (!brief?.caveats || brief.caveats.length === 0),
      zero_row_overconfidence: zeroRowOverconfidence,
    },
    trace,
  };
}

function normalizeQaReviewResult(review) {
  const dimensionScores = buildDefaultQaDimensionScores();
  for (const key of QA_DIMENSION_KEYS) {
    const raw = review?.dimension_scores?.[key];
    // If the reviewer did not score a dimension (e.g. new dimensions not yet in model output), keep the default of 10
    dimensionScores[key] = raw != null ? roundScore(raw) : 10;
  }

  return {
    score: roundScore(review?.score),
    blockers: uniqueStrings(review?.blockers || []),
    issues: uniqueStrings(review?.issues || []),
    repair_instructions: uniqueStrings(review?.repair_instructions || []),
    dimension_scores: dimensionScores,
  };
}

function mergeQaResults({ deterministicQa, selfReview = null, crossReview = null, repairAttempted = false }) {
  const dimensionScores = buildDefaultQaDimensionScores();

  for (const key of QA_DIMENSION_KEYS) {
    const candidates = [
      deterministicQa?.dimension_scores?.[key],
      selfReview?.qa?.dimension_scores?.[key],
      crossReview?.qa?.dimension_scores?.[key],
    ].filter((value) => typeof value === 'number');
    dimensionScores[key] = roundScore(candidates.length > 0 ? Math.min(...candidates) : 10);
  }

  // Cap how far LLM reviewers can drag the score below the deterministic baseline.
  // LLM reviewers tend to anchor on listed blockers and give disproportionately low scores.
  const deterministicScore = typeof deterministicQa?.score === 'number' ? deterministicQa.score : 10;
  const reviewerScores = [
    selfReview?.qa?.score,
    crossReview?.qa?.score,
  ].filter((value) => typeof value === 'number');
  const dimensionScore = scoreFromDimensionScores(dimensionScores);
  const minReviewer = reviewerScores.length > 0 ? Math.min(...reviewerScores) : deterministicScore;
  const score = roundScore(Math.min(
    deterministicScore,
    dimensionScore,
    Math.max(minReviewer, deterministicScore - 2),
  ));

  const blockers = uniqueStrings([
    ...(deterministicQa?.blockers || []),
    ...(selfReview?.qa?.blockers || []),
    ...(crossReview?.qa?.blockers || []),
  ]);
  const issues = uniqueStrings([
    ...(deterministicQa?.issues || []),
    ...(selfReview?.qa?.issues || []),
    ...(crossReview?.qa?.issues || []),
  ]);
  const repairInstructions = uniqueStrings([
    ...(deterministicQa?.repair_instructions || []),
    ...(selfReview?.qa?.repair_instructions || []),
    ...(crossReview?.qa?.repair_instructions || []),
  ]);
  const reviewers = [
    ...(selfReview?.reviewer ? [selfReview.reviewer] : []),
    ...(crossReview?.reviewer ? [crossReview.reviewer] : []),
  ];

  return {
    status: blockers.length === 0 && score >= QA_PASS_THRESHOLD ? 'pass' : 'warning',
    score,
    pass_threshold: QA_PASS_THRESHOLD,
    blockers,
    issues,
    repair_instructions: repairInstructions,
    dimension_scores: dimensionScores,
    reviewers,
    repair_attempted: repairAttempted,
    escalated: Boolean(crossReview?.qa),
  };
}

function buildCompatReview({ qa, deterministicQa }) {
  return {
    pass: qa?.status === 'pass',
    issues: qa?.issues || [],
    missing_dimensions: deterministicQa?.missing_dimensions || [],
    contradictory_claims: deterministicQa?.contradictory_claims || [],
    repair_instructions: qa?.repair_instructions || [],
  };
}

export function reviewAgentBriefDeterministically({
  userMessage = '',
  answerContract,
  brief,
  toolCalls = [],
  finalAnswerText = '',
}) {
  const deterministicQa = computeDeterministicQa({
    userMessage,
    answerContract,
    brief,
    toolCalls,
    finalAnswerText,
  });

  return {
    pass: deterministicQa.blockers.length === 0 && deterministicQa.score >= QA_PASS_THRESHOLD,
    issues: deterministicQa.issues,
    missing_dimensions: deterministicQa.missing_dimensions,
    contradictory_claims: deterministicQa.contradictory_claims,
    repair_instructions: deterministicQa.repair_instructions,
  };
}

async function deriveAnswerContract({ userMessage, mode = 'default' }) {
  try {
    const result = await runDiPrompt({
      promptId: DI_PROMPT_IDS.AGENT_ANSWER_CONTRACT,
      input: { userMessage, mode },
      temperature: 0.1,
      maxOutputTokens: 2048,
    });
    return normalizeAnswerContract(result?.parsed, userMessage, mode);
  } catch (error) {
    console.warn('[agentResponsePresentation] Answer contract fallback:', error?.message);
    return buildDeterministicAnswerContract({ userMessage, mode });
  }
}

export async function resolveAgentAnswerContract({ userMessage, mode = 'default' }) {
  return deriveAnswerContract({ userMessage, mode });
}

async function synthesizeBrief({
  userMessage,
  answerContract,
  toolCalls = [],
  finalAnswerText = '',
  mode = 'default',
  repairInstructions = [],
}) {
  const fallbackBrief = buildDeterministicAgentBrief({
    userMessage,
    answerContract,
    toolCalls,
    finalAnswerText,
  });

  try {
    const result = await runDiPrompt({
      promptId: DI_PROMPT_IDS.AGENT_BRIEF_SYNTHESIS,
      input: {
        userMessage,
        answerContract,
        toolCalls: summarizeToolCallsForPrompt(toolCalls),
        finalAnswerText: clamp(finalAnswerText, 2500),
        mode,
        repairInstructions,
      },
      temperature: 0.1,
      maxOutputTokens: 4096,
    });
    return normalizeBrief(result?.parsed, fallbackBrief, { brevity: answerContract?.brevity });
  } catch (error) {
    console.warn('[agentResponsePresentation] Brief synthesis fallback:', error?.message);
    return fallbackBrief;
  }
}

function summarizeToolCallsForPrompt(toolCalls = []) {
  return (Array.isArray(toolCalls) ? toolCalls : []).map((toolCall) => {
    const rows = getStructuredRows(toolCall).slice(0, 3);
    const analysisPayloads = extractAnalysisPayloadsFromToolCall(toolCall)
      .slice(0, 2)
      .map((payload) => ({
        title: payload?.title,
        analysisType: payload?.analysisType,
        summary: payload?.summary || '',
        chartTypes: Array.isArray(payload?.charts) ? payload.charts.map((chart) => chart?.type).filter(Boolean) : [],
        tableTitles: Array.isArray(payload?.tables) ? payload.tables.map((table) => table?.title).filter(Boolean) : [],
        referenceLineLabels: Array.isArray(payload?.charts)
          ? payload.charts.flatMap((chart) => Array.isArray(chart?.referenceLines) ? chart.referenceLines.map((line) => line?.label).filter(Boolean) : [])
          : [],
        metrics: isPlainObject(payload?.metrics)
          ? Object.entries(payload.metrics).slice(0, 10).map(([label, value]) => ({ label, value }))
          : [],
        referenceLineValues: Array.isArray(payload?.charts)
          ? payload.charts.flatMap((chart) =>
            (Array.isArray(chart?.referenceLines) ? chart.referenceLines : [])
              .map((line) => ({ label: line?.label, value: line?.value }))
              .filter((entry) => entry.label))
          : [],
        tableData: Array.isArray(payload?.tables)
          ? payload.tables.slice(0, 2).map((table) => ({
            title: table?.title,
            columns: table?.columns,
            rows: (table?.rows || []).slice(0, 8),
          }))
          : [],
      }));
    return {
      id: toolCall?.id || null,
      name: toolCall?.name || 'unknown_tool',
      success: Boolean(toolCall?.result?.success),
      error: toolCall?.result?.success ? null : String(toolCall?.result?.error || ''),
      args: toolCall?.args || {},
      rowCount: getRowCount(toolCall),
      sampleRows: rows,
      analysisPayloads,
      artifactTypes: toolCall?.result?.artifactTypes || toolCall?.result?.result?.artifactTypes || [],
    };
  });
}

async function requestQaReview({
  promptId,
  stage,
  userMessage,
  answerContract,
  brief,
  toolCalls = [],
  finalAnswerText = '',
  deterministicQa = null,
  artifactSummary = '',
  providerOverride = '',
  modelOverride = '',
}) {
  try {
    const result = await runDiPrompt({
      promptId,
      input: {
        userMessage,
        answerContract,
        brief,
        toolCalls: summarizeToolCallsForPrompt(toolCalls),
        finalAnswerText: clamp(finalAnswerText, 3000),
        deterministicQa,
        artifactSummary,
      },
      temperature: 0.1,
      maxOutputTokens: 4096,
      providerOverride,
      modelOverride,
    });
    return {
      qa: normalizeQaReviewResult(result?.parsed),
      reviewer: {
        stage,
        available: true,
        provider: result?.provider || providerOverride || '',
        model: result?.model || modelOverride || '',
        transport: result?.transport || null,
        score: roundScore(result?.parsed?.score),
        issues: uniqueStrings(result?.parsed?.issues || []).slice(0, 6),
      },
    };
  } catch (error) {
    console.warn(`[agentResponsePresentation] ${stage} QA fallback:`, error?.message);
    if (stage !== 'cross_model') return null;
    return {
      qa: null,
      reviewer: {
        stage,
        available: false,
        provider: providerOverride || CROSS_MODEL_REVIEW_PROVIDER,
        model: modelOverride || CROSS_MODEL_REVIEW_MODEL,
        transport: null,
        score: 0,
        issues: [`Reviewer unavailable: ${error?.message?.includes('contract')
          ? 'Cross-model response did not match required JSON schema — check prompt compatibility with reviewer model.'
          : (error?.message || 'unknown error')}`],
      },
    };
  }
}

function shouldEscalateQa({ deterministicQa, selfReview, forceCrossReview = false }) {
  if (forceCrossReview) return true;
  if ((deterministicQa?.blockers || []).length > 0) return true;
  if ((selfReview?.qa?.score ?? 10) < QA_PASS_THRESHOLD) return true;
  return Boolean(
    deterministicQa?.flags?.contradictions
    || deterministicQa?.flags?.chart_mismatch
    || deterministicQa?.flags?.empty_evidence
    || deterministicQa?.flags?.tool_failure_overconfidence
  );
}

async function repairBrief({
  userMessage,
  answerContract,
  brief,
  toolCalls = [],
  finalAnswerText = '',
  mode = 'default',
  deterministicQa = null,
  qaScorecard = null,
  artifactSummary = '',
}) {
  const fallbackBrief = buildDeterministicAgentBrief({
    userMessage,
    answerContract,
    toolCalls,
    finalAnswerText,
  });

  try {
    const result = await runDiPrompt({
      promptId: DI_PROMPT_IDS.AGENT_QA_REPAIR_SYNTHESIS,
      input: {
        userMessage,
        answerContract,
        brief,
        toolCalls: summarizeToolCallsForPrompt(toolCalls),
        finalAnswerText: clamp(finalAnswerText, 3000),
        deterministicQa,
        qaScorecard,
        artifactSummary,
        mode,
      },
      temperature: 0.1,
      maxOutputTokens: 4096,
    });
    return normalizeBrief(result?.parsed, fallbackBrief, { brevity: answerContract?.brevity });
  } catch (error) {
    console.warn('[agentResponsePresentation] Repair synthesis fallback:', error?.message);
    return normalizeBrief(brief, fallbackBrief, { brevity: answerContract?.brevity });
  }
}

export async function buildAgentPresentationPayload({
  userMessage,
  toolCalls = [],
  finalAnswerText = '',
  mode = 'default',
  answerContract: providedAnswerContract = null,
  forceCrossReview = false,
}) {
  const answerContract = providedAnswerContract
    ? normalizeAnswerContract(providedAnswerContract, userMessage, mode)
    : await deriveAnswerContract({ userMessage, mode });
  const artifactSummary = summarizeArtifacts(toolCalls);

  const initialBrief = await synthesizeBrief({
    userMessage,
    answerContract,
    toolCalls,
    finalAnswerText,
    mode,
  });
  const initialDeterministicQa = computeDeterministicQa({
    userMessage,
    answerContract,
    brief: initialBrief,
    toolCalls,
    finalAnswerText,
  });
  const initialSelfReview = await requestQaReview({
    promptId: DI_PROMPT_IDS.AGENT_QA_SELF_REVIEW,
    stage: 'self',
    userMessage,
    answerContract,
    brief: initialBrief,
    toolCalls,
    finalAnswerText,
    deterministicQa: initialDeterministicQa,
    artifactSummary,
  });
  const shouldCrossReview = shouldEscalateQa({
    deterministicQa: initialDeterministicQa,
    selfReview: initialSelfReview,
    forceCrossReview,
  });
  const initialCrossReview = shouldCrossReview
    ? await requestQaReview({
      promptId: DI_PROMPT_IDS.AGENT_QA_CROSS_REVIEW,
      stage: 'cross_model',
      userMessage,
      answerContract,
      brief: initialBrief,
      toolCalls,
      finalAnswerText,
      deterministicQa: initialDeterministicQa,
      artifactSummary,
      providerOverride: CROSS_MODEL_REVIEW_PROVIDER,
      modelOverride: CROSS_MODEL_REVIEW_MODEL,
    })
    : null;
  const initialQa = mergeQaResults({
    deterministicQa: initialDeterministicQa,
    selfReview: initialSelfReview,
    crossReview: initialCrossReview,
    repairAttempted: false,
  });

  if (initialQa.status === 'warning') {
    const repairedBrief = await repairBrief({
      userMessage,
      answerContract,
      brief: initialBrief,
      toolCalls,
      finalAnswerText,
      mode,
      deterministicQa: initialDeterministicQa,
      qaScorecard: initialQa,
      artifactSummary,
    });
    const repairedDeterministicQa = computeDeterministicQa({
      userMessage,
      answerContract,
      brief: repairedBrief,
      toolCalls,
      finalAnswerText,
    });
    const repairedSelfReview = await requestQaReview({
      promptId: DI_PROMPT_IDS.AGENT_QA_SELF_REVIEW,
      stage: 'self',
      userMessage,
      answerContract,
      brief: repairedBrief,
      toolCalls,
      finalAnswerText,
      deterministicQa: repairedDeterministicQa,
      artifactSummary,
    });
    const repairedCrossReview = shouldCrossReview
      ? await requestQaReview({
        promptId: DI_PROMPT_IDS.AGENT_QA_CROSS_REVIEW,
        stage: 'cross_model',
        userMessage,
        answerContract,
        brief: repairedBrief,
        toolCalls,
        finalAnswerText,
        deterministicQa: repairedDeterministicQa,
        artifactSummary,
        providerOverride: CROSS_MODEL_REVIEW_PROVIDER,
        modelOverride: CROSS_MODEL_REVIEW_MODEL,
      })
      : null;
    const repairedQa = mergeQaResults({
      deterministicQa: repairedDeterministicQa,
      selfReview: repairedSelfReview,
      crossReview: repairedCrossReview,
      repairAttempted: true,
    });

    return {
      brief: repairedBrief,
      trace: repairedDeterministicQa.trace,
      answerContract,
      review: buildCompatReview({ qa: repairedQa, deterministicQa: repairedDeterministicQa }),
      qa: repairedQa,
    };
  }

  return {
    brief: initialBrief,
    trace: initialDeterministicQa.trace,
    answerContract,
    review: buildCompatReview({ qa: initialQa, deterministicQa: initialDeterministicQa }),
    qa: initialQa,
  };
}

export default {
  buildAgentPresentationPayload,
  buildDeterministicAnswerContract,
  buildDeterministicAgentBrief,
  computeDeterministicQa,
  reviewAgentBriefDeterministically,
  resolveAgentAnswerContract,
};
