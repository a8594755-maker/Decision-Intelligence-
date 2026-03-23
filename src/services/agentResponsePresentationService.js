import { extractAnalysisPayloadsFromToolCall } from './analysisToolResultService.js';
import { DI_PROMPT_IDS, runDiPrompt } from './diModelRouterService.js';

const DEFAULT_ANSWER_CONTRACT = Object.freeze({
  task_type: 'mixed',
  required_dimensions: [],
  required_outputs: [],
  audience_language: 'en',
  brevity: 'short',
});

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
  correctness: 0.4,
  completeness: 0.2,
  evidence_alignment: 0.15,
  visualization_fit: 0.1,
  caveat_quality: 0.1,
  clarity: 0.05,
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
const SPECIAL_CHART_REQUESTS = Object.freeze([
  { key: 'histogram', patterns: [/\bhistogram\b/i, /(直方圖)/] },
  { key: 'heatmap', patterns: [/\bheatmap\b/i, /(熱力圖)/] },
  { key: 'scatter', patterns: [/\bscatter\b/i, /(散點圖)/] },
  { key: 'pie', patterns: [/\bpie\b/i, /(圓餅圖)/] },
  { key: 'treemap', patterns: [/\btreemap\b/i, /(樹狀圖|矩形樹圖)/] },
]);

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

  return {
    task_type: taskType || DEFAULT_ANSWER_CONTRACT.task_type,
    required_dimensions: requiredDimensions,
    required_outputs: requiredOutputs,
    audience_language: audienceLanguage || (mode === 'analysis' ? 'zh' : 'en'),
    brevity: 'short',
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

function summarizeSuccess(toolCall) {
  const payload = getCanonicalToolPayload(toolCall);
  const rowCount = getRowCount(toolCall);
  const analysisCards = extractAnalysisPayloadsFromToolCall(toolCall);

  if ((toolCall?.name === 'query_sap_data' || toolCall?.name === 'list_sap_tables') && payload?.result) {
    return rowCount > 0
      ? `Returned ${rowCount} row${rowCount === 1 ? '' : 's'}`
      : 'Query executed successfully';
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
    const base = {
      id: toolCall?.id || `${toolCall.name}-${successfulQueries.length + failedAttempts.length}`,
      name: toolCall.name,
      sql,
      args: serializeArgs(toolCall.args),
      rowCount: getRowCount(toolCall),
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

function buildMetricPills(toolCalls = []) {
  const analysisPayloads = toolCalls.flatMap((toolCall) => extractAnalysisPayloadsFromToolCall(toolCall));
  const firstMetrics = analysisPayloads.find((payload) => isPlainObject(payload?.metrics))?.metrics;
  if (firstMetrics) {
    return Object.entries(firstMetrics)
      .slice(0, 4)
      .map(([label, value]) => ({ label: String(label), value: formatValue(value) }));
  }

  const firstRows = toolCalls.map((toolCall) => getStructuredRows(toolCall)).find((rows) => rows.length > 0) || [];
  if (firstRows.length > 0) {
    const firstRow = firstRows[0];
    return Object.entries(firstRow)
      .filter(([, value]) => typeof value === 'number' || (typeof value === 'string' && value.length <= 24))
      .slice(0, 4)
      .map(([label, value]) => ({ label, value: formatValue(value) }));
  }

  return [];
}

function buildEvidenceTables(toolCalls = [], answerContract) {
  const tables = [];
  const structuredRowsCalls = (Array.isArray(toolCalls) ? toolCalls : []).filter((toolCall) => getStructuredRows(toolCall).length > 0);

  for (const toolCall of structuredRowsCalls.slice(0, 2)) {
    const rows = getStructuredRows(toolCall).slice(0, 8);
    const columns = uniqueStrings(rows.flatMap((row) => Object.keys(row))).slice(0, 6);
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
  const narrative = extractCleanNarrativeSentences(finalAnswerText);
  if (narrative.length > 0) return narrative[0];

  const analysisPayloads = toolCalls.flatMap((toolCall) => extractAnalysisPayloadsFromToolCall(toolCall));
  if (analysisPayloads.length > 0) {
    return analysisPayloads[0]?.title || 'Analysis artifacts are ready.';
  }

  if (trace.failed_attempts.length > 0 && trace.successful_queries.length === 0) {
    return 'The request is currently blocked by tool failures and needs a narrower retry.';
  }

  if (answerContract?.task_type === 'comparison') {
    return 'The requested comparison is ready with supporting evidence below.';
  }

  return 'Analysis complete.';
}

function pickSummary({ finalAnswerText, trace, answerContract, toolCalls }) {
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

  const successCount = trace.successful_queries.length;
  const failureCount = trace.failed_attempts.length;
  if (successCount > 0 && failureCount > 0) {
    return `Completed ${successCount} tool step${successCount === 1 ? '' : 's'} with ${failureCount} caveat${failureCount === 1 ? '' : 's'} preserved in the execution trace.`;
  }
  if (successCount > 0) {
    return `Completed ${successCount} tool step${successCount === 1 ? '' : 's'} for this ${answerContract?.task_type || 'analysis'} request.`;
  }
  return 'The available evidence is incomplete, so the brief focuses on caveats and next steps.';
}

function inferKeyFindings({ finalAnswerText, toolCalls, answerContract }) {
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
  const trace = buildTrace(toolCalls, finalAnswerText);

  return {
    headline: pickHeadline({ finalAnswerText, toolCalls, trace, answerContract: normalizedContract }),
    summary: pickSummary({ finalAnswerText, trace, answerContract: normalizedContract, toolCalls }),
    metric_pills: buildMetricPills(toolCalls),
    tables: buildEvidenceTables(toolCalls, normalizedContract),
    key_findings: inferKeyFindings({ finalAnswerText, toolCalls, answerContract: normalizedContract }),
    implications: inferImplications({ answerContract: normalizedContract, toolCalls }),
    caveats: inferCaveats({ finalAnswerText, trace, toolCalls }),
    next_steps: inferNextSteps({ answerContract: normalizedContract, trace }),
  };
}

function normalizeBrief(brief, fallbackBrief) {
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
    key_findings: uniqueStrings(Array.isArray(source.key_findings) ? source.key_findings : fallback.key_findings || []).slice(0, 5),
    implications: uniqueStrings(Array.isArray(source.implications) ? source.implications : fallback.implications || []).slice(0, 4),
    caveats: uniqueStrings(Array.isArray(source.caveats) ? source.caveats : fallback.caveats || []).slice(0, 4),
    next_steps: uniqueStrings(Array.isArray(source.next_steps) ? source.next_steps : fallback.next_steps || []).slice(0, 4),
  };

  if (!normalized.summary) normalized.summary = fallback.summary || '';
  if (normalized.metric_pills.length === 0) normalized.metric_pills = fallback.metric_pills || [];
  if (normalized.tables.length === 0) normalized.tables = fallback.tables || [];
  if (normalized.key_findings.length === 0) normalized.key_findings = fallback.key_findings || [];
  if (normalized.implications.length === 0) normalized.implications = fallback.implications || [];
  if (normalized.caveats.length === 0) normalized.caveats = fallback.caveats || [];
  if (normalized.next_steps.length === 0) normalized.next_steps = fallback.next_steps || [];

  return normalized;
}

function buildBriefSearchText(brief) {
  const tableText = Array.isArray(brief?.tables)
    ? brief.tables.flatMap((table) => [table.title, ...(table.columns || []), ...(table.rows || []).flat()]).join(' ')
    : '';

  return [
    brief?.headline,
    brief?.summary,
    ...(brief?.key_findings || []),
    ...(brief?.implications || []),
    ...(brief?.caveats || []),
    ...(brief?.next_steps || []),
    tableText,
  ].join(' ').toLowerCase();
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

function collectMetricFacts(items = [], sourceLabel = 'brief') {
  const facts = [];

  for (const item of items) {
    if (!item) continue;
    if (typeof item === 'string') {
      const numeric = parseNumericValue(item);
      const metricKey = detectMetricAlias(item);
      if (numeric != null && metricKey) {
        facts.push({ metricKey, value: numeric, source: sourceLabel, raw: item });
      }
      continue;
    }

    const label = String(item.label || '').trim();
    const value = String(item.value || '').trim();
    const numeric = parseNumericValue(value);
    const metricKey = detectMetricAlias(label) || detectMetricAlias(`${label} ${value}`);
    if (numeric != null && metricKey) {
      facts.push({ metricKey, value: numeric, source: sourceLabel, raw: `${label}: ${value}` });
    }
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
      ? Object.entries(payload.metrics).slice(0, 4).map(([label, value]) => `${label}=${formatValue(value)}`).join(', ')
      : 'none';

    return `${index + 1}. ${payload?.title || payload?.analysisType || 'artifact'} | charts=${chartTypes.join(', ') || 'none'} | metrics=${metrics}`;
  }).join('\n');
}

function collectContradictoryClaims({ brief, toolCalls = [] }) {
  const facts = [];
  facts.push(...collectMetricFacts(brief?.metric_pills || [], 'brief_metric_pills'));
  facts.push(...collectMetricFacts([
    brief?.headline,
    brief?.summary,
    ...(brief?.key_findings || []),
    ...(brief?.caveats || []),
  ], 'brief_text'));

  const analysisPayloads = (Array.isArray(toolCalls) ? toolCalls : []).flatMap((toolCall) => extractAnalysisPayloadsFromToolCall(toolCall));
  for (const payload of analysisPayloads) {
    if (isPlainObject(payload?.metrics)) {
      const metricItems = Object.entries(payload.metrics).map(([label, value]) => ({ label, value }));
      facts.push(...collectMetricFacts(metricItems, `artifact_metrics:${payload?.title || payload?.analysisType || 'artifact'}`));
    }
    facts.push(...collectMetricFacts([
      payload?.summary,
      ...(payload?.highlights || []),
    ], `artifact_text:${payload?.title || payload?.analysisType || 'artifact'}`));
  }

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

function detectRequestedSpecialChart(userMessage) {
  const text = String(userMessage || '');
  return SPECIAL_CHART_REQUESTS.find((entry) => entry.patterns.some((pattern) => pattern.test(text)))?.key || '';
}

function requiresCaveat({ trace, finalAnswerText, toolCalls, brief }) {
  if (Array.isArray(brief?.caveats) && brief.caveats.length > 0) return false;

  const joinedText = [
    finalAnswerText,
    summarizeArtifacts(toolCalls),
    ...trace.failed_attempts.map((attempt) => attempt?.error || attempt?.summary || ''),
  ].join(' ');

  return (
    trace.failed_attempts.length > 0
    || /(proxy|approx|approximation|限制|近似|代理指標|duplicate|duplication|partial evidence|incomplete)/i.test(joinedText)
  );
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

  const missingDimensions = (answerContract?.required_dimensions || []).filter((dimension) => (
    dimension && !briefText.includes(String(dimension).toLowerCase())
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

  const chartTypes = getChartTypesFromToolCalls(toolCalls);
  const wantsChart = (answerContract?.required_outputs || []).includes('chart');
  const requestedSpecialChart = detectRequestedSpecialChart(userMessage);
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

  if (requiresCaveat({ trace, finalAnswerText, toolCalls, brief })) {
    const issue = 'Brief is missing a caveat despite failed, proxy-based, or partial evidence.';
    blockers.push(issue);
    issues.push(issue);
    repairInstructions.push('Add a concise caveat for the failed step, proxy metric, or incomplete evidence.');
    dimensionScores.caveat_quality = Math.max(0, dimensionScores.caveat_quality - 6);
  }

  const hasSuccessfulEvidence = trace.successful_queries.length > 0 || chartTypes.length > 0;
  if (!hasSuccessfulEvidence && trace.failed_attempts.length > 0) {
    const issue = 'The answer appears confident despite lacking successful evidence.';
    blockers.push(issue);
    issues.push(issue);
    repairInstructions.push('State clearly that evidence is incomplete and avoid overconfident conclusions.');
    dimensionScores.correctness = Math.max(0, dimensionScores.correctness - 4);
    dimensionScores.caveat_quality = Math.max(0, dimensionScores.caveat_quality - 2);
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
    },
    trace,
  };
}

function normalizeQaReviewResult(review) {
  const dimensionScores = buildDefaultQaDimensionScores();
  for (const key of QA_DIMENSION_KEYS) {
    dimensionScores[key] = roundScore(review?.dimension_scores?.[key]);
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

  const scoreCandidates = [
    deterministicQa?.score,
    selfReview?.qa?.score,
    crossReview?.qa?.score,
    scoreFromDimensionScores(dimensionScores),
  ].filter((value) => typeof value === 'number');
  const score = roundScore(Math.min(...scoreCandidates));

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
    escalated: Boolean(crossReview),
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
      maxOutputTokens: 700,
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
        finalAnswerText: clamp(finalAnswerText, 3500),
        mode,
        repairInstructions,
      },
      temperature: 0.1,
      maxOutputTokens: 1800,
    });
    return normalizeBrief(result?.parsed, fallbackBrief);
  } catch (error) {
    console.warn('[agentResponsePresentation] Brief synthesis fallback:', error?.message);
    return fallbackBrief;
  }
}

function summarizeToolCallsForPrompt(toolCalls = []) {
  return (Array.isArray(toolCalls) ? toolCalls : []).map((toolCall) => {
    const rows = getStructuredRows(toolCall).slice(0, 4);
    const analysisPayloads = extractAnalysisPayloadsFromToolCall(toolCall)
      .slice(0, 2)
      .map((payload) => ({ title: payload?.title, analysisType: payload?.analysisType }));
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
      maxOutputTokens: 1000,
      providerOverride,
      modelOverride,
    });
    return {
      qa: normalizeQaReviewResult(result?.parsed),
      reviewer: {
        stage,
        provider: result?.provider || providerOverride || '',
        model: result?.model || modelOverride || '',
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
        provider: providerOverride || CROSS_MODEL_REVIEW_PROVIDER,
        model: modelOverride || CROSS_MODEL_REVIEW_MODEL,
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
      maxOutputTokens: 1800,
    });
    return normalizeBrief(result?.parsed, fallbackBrief);
  } catch (error) {
    console.warn('[agentResponsePresentation] Repair synthesis fallback:', error?.message);
    return normalizeBrief(brief, fallbackBrief);
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
