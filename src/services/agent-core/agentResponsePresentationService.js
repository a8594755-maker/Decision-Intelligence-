import { extractAnalysisPayloadsFromToolCall } from '../data-prep/analysisToolResultService.js';
import { DI_PROMPT_IDS, runDiPrompt } from '../planning/diModelRouterService.js';
import { isProviderCircuitOpen } from '../ai-infra/aiProxyService.js';
import { getModelConfig } from '../ai-infra/modelConfigService.js';
import { EvidenceRegistry } from '../governance/evidenceRegistry.js';
import { synthesizeFromEvidence } from '../governance/evidenceSynthesisService.js';
import { SAP_TABLE_REGISTRY, SAP_DATASET_INFO } from '../sap-erp/sapDataQueryService.js';
import { detectDomain, verifyFormulaConsistency } from '../data-prep/analysisDomainEnrichment.js';
import { WARNING_ACKNOWLEDGMENT_PATTERNS } from '../data-prep/preAnalysisDataValidator.js';
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
    flags.push('relative_metrics', 'trend_context', 'methodology_disclosure');
  }
  if (taskType === 'mixed') {
    flags.push('methodology_disclosure', 'relative_metrics');
  }
  if (brevity === 'analysis') {
    if (!flags.includes('relative_metrics')) flags.push('relative_metrics');
    if (!flags.includes('methodology_disclosure')) flags.push('methodology_disclosure');
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
  { label: 'annual change', patterns: [/\bannual change\b/i, /\bannual trend\b/i, /\byearly trend\b/i, /\byear(?:ly|-to-year| over year)? change\b/i, /\bstart-to-end\b/i, /(年度趨勢|年度變化|年變化|年度成長|年增變化|逐年變化|逐年趨勢|年度走勢)/] },
  { label: 'cagr', patterns: [/\bcagr\b/i, /\bcompound annual growth rate\b/i, /\bannual growth rate\b/i, /(年均成長率|年均增长率|複合成長率|複合年增長率|複合年增长率|年化成長率|年化增长率)/] },
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
  /<\/?(?:thought|thinking|reasoning|reflection)>/i,
];

const PSEUDO_TABLE_PATTERN = /\S+\s{2,}\S+/;
const MARKDOWN_TABLE_PATTERN = /^\|.*\|$/;
const QA_PASS_THRESHOLD = 8.0;
const QA_DIMENSION_WEIGHTS = Object.freeze({
  correctness: 0.28,
  completeness: 0.12,
  evidence_alignment: 0.13,
  visualization_fit: 0.08,
  caveat_quality: 0.12,
  clarity: 0.04,
  methodology_transparency: 0.07,
  actionability: 0.06,
  information_density: 0.10,
});
const QA_DIMENSION_KEYS = Object.freeze(Object.keys(QA_DIMENSION_WEIGHTS));
function getCrossModelReviewConfig() {
  const envProvider = import.meta.env.VITE_DI_AGENT_QA_REVIEW_PROVIDER;
  const envModel = import.meta.env.VITE_DI_AGENT_QA_REVIEW_MODEL;
  if (envProvider && envModel) return { provider: envProvider, model: envModel };
  const cfg = getModelConfig('judge');
  return { provider: cfg.provider, model: cfg.model };
}
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

/**
 * Convert Unix ms timestamps (2000-2040 range) to ISO date strings in row objects.
 */
function formatTimestampValues(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const [key, val] of Object.entries(row)) {
    if (typeof val === 'number' && val > 9.46e11 && val < 2.21e12) {
      out[key] = new Date(val).toISOString().slice(0, 10);
    } else {
      out[key] = val;
    }
  }
  return out;
}

/**
 * Round floating-point numbers to 2 decimal places to avoid display artifacts
 * like 5202955.049999449 that confuse the synthesis LLM.
 */
function cleanFloatsInRow(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const [key, val] of Object.entries(row)) {
    if (typeof val === 'number' && !Number.isInteger(val)) {
      out[key] = Math.round(val * 100) / 100;
    } else {
      out[key] = val;
    }
  }
  return out;
}

/**
 * Infer semantic metadata for each column in SQL results.
 * Helps the synthesis LLM interpret raw numbers correctly.
 */
export function inferColumnMeta(rows, toolCall) {
  if (!Array.isArray(rows) || rows.length === 0) return {};
  const meta = {};
  const sqlText = String(toolCall?.args?.sql || toolCall?.args?.query || '').toLowerCase();
  const datasetHintText = [
    toolCall?.result?.result?.meta?.dataset_label,
    toolCall?.result?.result?.meta?.dataset_scope,
    toolCall?.result?.meta?.dataset_label,
    toolCall?.result?.meta?.dataset_scope,
  ].filter(Boolean).join(' ').toLowerCase();
  const currencyHintText = `${sqlText} ${datasetHintText}`;
  const firstRow = rows[0];

  for (const [col, val] of Object.entries(firstRow || {})) {
    if (typeof val !== 'number') continue;
    const colLower = col.toLowerCase();
    const entry = {};

    // Detect unit type from column name
    if (/revenue|price|value|amount|cost|payment|freight|金額|營收|價格/.test(colLower)) {
      entry.unit = 'currency';
      if (/brl|brazil|brasil|reais|r\$|olist/.test(currencyHintText)) entry.likely_currency = 'BRL';
      else if (/\beur\b|\beuro\b/.test(currencyHintText)) entry.likely_currency = 'EUR';
      else if (/\bgbp\b|\bpound\b|\bsterling\b|\buk\b|\bunited kingdom\b/.test(currencyHintText)) entry.likely_currency = 'GBP';
      else if (/\busd\b|\bus dollar\b|\bunited states\b/.test(currencyHintText)) entry.likely_currency = 'USD';
    } else if (/count|qty|quantity|orders|items|筆數|數量/.test(colLower)) {
      entry.unit = 'count';
    } else if (/pct|percent|ratio|rate|growth|cagr|change/.test(colLower)) {
      if (/pct|percent/.test(colLower)) {
        entry.unit = 'percentage';
      } else if (/cagr|growth.*rate/i.test(colLower) && Math.abs(val) > 1.0) {
        entry.unit = 'ratio_multiplier';
        entry.extreme_growth = true;
        entry.display_hint = `EXTREME raw ratio-like value ${val.toFixed(2)}. Keep this unit unless a dedicated percentage field exists. Add a low-base caveat if applicable.`;
      } else if (Math.abs(val) < 50) {
        entry.unit = 'ratio_multiplier';
        entry.display_hint = 'raw ratio-like value; keep as-is (or Nx) unless a dedicated percentage field exists';
      } else {
        entry.unit = 'percentage';
      }
    } else if (/avg_|mean_|average|平均/.test(colLower)) {
      entry.unit = 'average';
      entry.aggregation = 'mean';
    }

    // Detect aggregation scope from SQL
    if (/group\s+by\s+.*year|按.*年/.test(sqlText)) {
      entry.scope = 'per_year';
    } else if (/group\s+by\s+.*month|按.*月/.test(sqlText)) {
      entry.scope = 'per_month';
    }

    // Flag floating-point precision issues
    if (typeof val === 'number' && String(val).includes('.') && String(val).split('.')[1]?.length > 4) {
      entry.precision_note = 'raw floating-point; round to 2 decimals for display';
    }

    if (Object.keys(entry).length > 0) {
      meta[col] = entry;
    }
  }
  return meta;
}

/**
 * Build a merged column→meta map from all successful query tool calls.
 * Used to give pill/value formatters semantic awareness (e.g., ratio_multiplier for CAGR).
 */
function buildColumnMetaMap(toolCalls = []) {
  const merged = {};
  for (const tc of (Array.isArray(toolCalls) ? toolCalls : [])) {
    if (tc?.name !== 'query_sap_data' || !tc?.result?.success) continue;
    const rows = getStructuredRows(tc);
    if (rows.length === 0) continue;
    const meta = inferColumnMeta(rows, tc);
    for (const [col, entry] of Object.entries(meta)) {
      if (!merged[col]) merged[col] = entry;
    }
  }
  return merged;
}

function formatPercentageValue(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return formatValue(value);
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value);
}

/**
 * Format a numeric value with semantic awareness from columnMeta.
 * Keep raw ratio-like values unless the evidence explicitly provides percentage fields.
 */
function formatValueWithMeta(value, colMeta) {
  if (colMeta?.unit === 'ratio_multiplier' && typeof value === 'number') return formatValue(value);
  if (colMeta?.unit === 'percentage' && typeof value === 'number') return `${formatPercentageValue(value)}%`;
  return formatValue(value);
}

function detectPreferredCurrencySymbolFromText(sample = '') {
  const text = String(sample || '').toLowerCase();
  if (!text) return '';
  if (/r\$|\bbrl\b|\breais?\b|\bbrazil\b|\bbrasil\b|\bolist\b/.test(text)) return 'R$';
  if (/\beur\b|\beuro\b/.test(text)) return '€';
  if (/\bgbp\b|\bpound\b|\bsterling\b|\buk\b|\bunited kingdom\b/.test(text)) return '£';
  if (/\busd\b|\bus dollar\b|\bunited states\b/.test(text)) return '$';
  return '';
}

function collectBriefTextForCurrencyHint(briefLike) {
  if (!briefLike || typeof briefLike !== 'object') return '';
  const parts = [
    briefLike.headline,
    briefLike.executive_summary,
    briefLike.summary,
    briefLike.methodology_note,
    ...(Array.isArray(briefLike.metric_pills) ? briefLike.metric_pills.flatMap((pill) => [pill?.label, pill?.value]) : []),
    ...(Array.isArray(briefLike.data_lineage) ? briefLike.data_lineage.flatMap((entry) => [entry?.metric, entry?.sql_ref]) : []),
    ...(Array.isArray(briefLike.key_findings) ? briefLike.key_findings : []),
    ...(Array.isArray(briefLike.caveats) ? briefLike.caveats : []),
  ];
  return parts.filter(Boolean).join(' ');
}

function detectPreferredCurrencySymbol(toolCalls = [], briefLike = null) {
  const symbols = [];
  const columnMetaMap = buildColumnMetaMap(toolCalls);
  for (const entry of Object.values(columnMetaMap)) {
    switch (entry?.likely_currency) {
      case 'BRL':
        symbols.push('R$');
        break;
      case 'USD':
        symbols.push('$');
        break;
      case 'EUR':
        symbols.push('€');
        break;
      case 'GBP':
        symbols.push('£');
        break;
      default:
        break;
    }
  }
  if (symbols.length === 0) {
    const toolHintText = (Array.isArray(toolCalls) ? toolCalls : [])
      .flatMap((tc) => [
        tc?.args?.sql,
        tc?.args?.query,
        tc?.result?.result?.meta?.dataset_label,
        tc?.result?.result?.meta?.dataset_scope,
        tc?.result?.meta?.dataset_label,
        tc?.result?.meta?.dataset_scope,
      ])
      .filter(Boolean)
      .join(' ');
    return detectPreferredCurrencySymbolFromText(`${toolHintText} ${collectBriefTextForCurrencyHint(briefLike)}`);
  }
  const counts = symbols.reduce((acc, symbol) => {
    acc[symbol] = (acc[symbol] || 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

function tryParseJsonCandidate(candidate) {
  const text = String(candidate || '').trim();
  if (!text) return null;

  const attempts = [
    text,
    text.replace(/,\s*([}\]])/g, '$1'),
    text.replace(/,\s*([}\]])/g, '$1').replace(/[\x00-\x1F\x7F]/g, ' '),
  ];

  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      // keep trying
    }
  }

  return null;
}

function extractBalancedJsonObjectCandidates(text = '', { maxCandidates = 12 } = {}) {
  const sample = String(text || '');
  const candidates = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < sample.length; i++) {
    const ch = sample[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(sample.slice(start, i + 1));
        start = -1;
        if (candidates.length >= maxCandidates) break;
      }
    }
  }

  return candidates;
}

function decodeJsonStringSegment(segment) {
  try {
    return JSON.parse(segment);
  } catch {
    return null;
  }
}

function extractJsonLikeFieldValue(text = '', fieldName = '') {
  const sample = String(text || '');
  const field = String(fieldName || '').trim();
  if (!sample || !field) return null;

  const matcher = new RegExp(`"${field}"\\s*:`, 'i');
  const match = matcher.exec(sample);
  if (!match) return null;

  let index = match.index + match[0].length;
  while (index < sample.length && /\s/.test(sample[index])) index += 1;
  if (index >= sample.length) return null;

  const startChar = sample[index];
  if (startChar === '"') {
    let end = index;
    let inEscape = false;
    while (++end < sample.length) {
      const ch = sample[end];
      if (inEscape) {
        inEscape = false;
        continue;
      }
      if (ch === '\\') {
        inEscape = true;
        continue;
      }
      if (ch === '"') {
        return decodeJsonStringSegment(sample.slice(index, end + 1));
      }
    }
    return null;
  }

  if (startChar === '[' || startChar === '{') {
    const closer = startChar === '[' ? ']' : '}';
    let depth = 0;
    let inString = false;
    let inEscape = false;
    for (let end = index; end < sample.length; end++) {
      const ch = sample[end];
      if (inEscape) {
        inEscape = false;
        continue;
      }
      if (ch === '\\') {
        if (inString) inEscape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === startChar) depth += 1;
      if (ch === closer) depth -= 1;
      if (depth === 0) {
        return tryParseJsonCandidate(sample.slice(index, end + 1));
      }
    }
    return null;
  }

  const primitiveMatch = sample.slice(index).match(/^(null|true|false|-?\d+(?:\.\d+)?)/i);
  if (!primitiveMatch) return null;
  return tryParseJsonCandidate(primitiveMatch[1]);
}

function extractStructuredBriefFields(text = '') {
  const extracted = {};
  const candidateFields = [
    'headline',
    'executive_summary',
    'summary',
    'metric_pills',
    'data_lineage',
    'tables',
    'charts',
    'chart_specs',
    'key_findings',
    'implications',
    'caveats',
    'next_steps',
    'methodology_note',
  ];

  for (const fieldName of candidateFields) {
    const value = extractJsonLikeFieldValue(text, fieldName);
    if (value != null) extracted[fieldName] = value;
  }

  if (!(extracted.headline || extracted.summary || extracted.executive_summary || extracted.metric_pills || extracted.tables || extracted.charts || extracted.chart_specs)) {
    return null;
  }

  return {
    headline: extracted.headline || 'Analysis complete.',
    ...(extracted.executive_summary ? { executive_summary: extracted.executive_summary } : {}),
    summary: extracted.summary || '',
    ...(Array.isArray(extracted.metric_pills) ? { metric_pills: extracted.metric_pills } : {}),
    ...(Array.isArray(extracted.data_lineage) ? { data_lineage: extracted.data_lineage } : {}),
    ...(Array.isArray(extracted.tables) ? { tables: extracted.tables } : {}),
    ...(Array.isArray(extracted.charts) ? { charts: extracted.charts } : {}),
    ...(Array.isArray(extracted.chart_specs) ? { chart_specs: extracted.chart_specs } : {}),
    ...(Array.isArray(extracted.key_findings) ? { key_findings: extracted.key_findings } : {}),
    ...(Array.isArray(extracted.implications) ? { implications: extracted.implications } : {}),
    ...(Array.isArray(extracted.caveats) ? { caveats: extracted.caveats } : {}),
    ...(Array.isArray(extracted.next_steps) ? { next_steps: extracted.next_steps } : {}),
    ...(typeof extracted.methodology_note === 'string' ? { methodology_note: extracted.methodology_note } : {}),
  };
}

function countStructuredBriefRichness(brief) {
  if (!isPlainObject(brief)) return 0;
  return [
    typeof brief.headline === 'string' && brief.headline.trim(),
    typeof brief.executive_summary === 'string' && brief.executive_summary.trim(),
    typeof brief.summary === 'string' && brief.summary.trim(),
    Array.isArray(brief.metric_pills) && brief.metric_pills.length > 0,
    Array.isArray(brief.data_lineage) && brief.data_lineage.length > 0,
    Array.isArray(brief.tables) && brief.tables.length > 0,
    Array.isArray(brief.charts) && brief.charts.length > 0,
    Array.isArray(brief.chart_specs) && brief.chart_specs.length > 0,
    Array.isArray(brief.key_findings) && brief.key_findings.length > 0,
    Array.isArray(brief.implications) && brief.implications.length > 0,
    Array.isArray(brief.caveats) && brief.caveats.length > 0,
    Array.isArray(brief.next_steps) && brief.next_steps.length > 0,
    typeof brief.methodology_note === 'string' && brief.methodology_note.trim(),
  ].filter(Boolean).length;
}

function recoverBestStructuredBrief(text = '') {
  const candidatePool = extractBalancedJsonObjectCandidates(text)
    .map((candidate) => tryParseJsonCandidate(candidate))
    .filter((candidate) => isPlainObject(candidate))
    .filter((candidate) => candidate.headline || candidate.summary || candidate.executive_summary)
    .map((candidate) => ({
      brief: candidate,
      richness: countStructuredBriefRichness(candidate),
    }));

  const extracted = extractStructuredBriefFields(text);
  if (extracted) {
    candidatePool.push({
      brief: extracted,
      richness: countStructuredBriefRichness(extracted),
    });
  }

  candidatePool.sort((a, b) => b.richness - a.richness);
  return candidatePool[0]?.brief || null;
}

function looksLikeSerializedJsonText(text = '') {
  const sample = String(text || '').trim();
  return /^\{[\s\S]*\}$/.test(sample) && /"headline"\s*:|"summary"\s*:|"metric_pills"\s*:|"tables"\s*:|"charts"\s*:/.test(sample);
}

function isMonetaryMetricLabel(label = '') {
  return /revenue|sales|gmv|amount|value|price|payment|cost|營收|收入|金額|銷售|客單價/i.test(String(label || ''));
}

function isCountMetricLabel(label = '') {
  return /count|orders|order count|items|qty|quantity|customers|sellers|regions|states|months|rows|筆數|數量|訂單|客戶|賣家|州數|月份/i.test(String(label || ''));
}

function inferMetricPillMeta(label = '', columnMetaMap = {}) {
  const labelLower = String(label || '').toLowerCase();
  const entries = Object.entries(columnMetaMap || {});
  const matchers = [
    {
      test: /cagr|growth|rate|增長率|增长率|成長率|年均成長率|年化成長率/,
      columnPattern: /cagr|growth|rate|pct|percent|change/,
      preferredUnits: ['percentage', 'ratio_multiplier'],
    },
    {
      test: /revenue|sales|gmv|amount|value|price|payment|cost|營收|收入|金額|銷售|客單價/,
      columnPattern: /revenue|sales|gmv|amount|value|price|payment|cost|freight/,
      preferredUnits: ['currency', 'average'],
    },
    {
      test: /count|orders|items|qty|quantity|customers|sellers|regions|states|months|rows|筆數|數量|訂單|客戶|賣家|州數|月份/,
      columnPattern: /count|orders|items|qty|quantity|customers|sellers|regions|states|months|rows/,
      preferredUnits: ['count'],
    },
  ];

  for (const matcher of matchers) {
    if (!matcher.test.test(labelLower)) continue;
    const candidates = entries
      .filter(([col, meta]) => matcher.columnPattern.test(String(col || '').toLowerCase()) || matcher.preferredUnits.includes(meta?.unit))
      .map(([, meta]) => meta)
      .filter(Boolean);
    for (const unit of matcher.preferredUnits) {
      const match = candidates.find((meta) => meta?.unit === unit);
      if (match) return match;
    }
    if (candidates[0]) return candidates[0];
  }

  return null;
}

function formatMetricPillValue(raw, label, { currencySymbol = '', columnMetaMap = {} } = {}) {
  const rawStr = String(raw ?? '').trim();
  const numeric = parseNumericValue(rawStr);
  if (numeric == null) return formatPillValue(rawStr);

  if (/%|％/.test(rawStr)) return rawStr;

  const inferredMeta = inferMetricPillMeta(label, columnMetaMap);
  if (inferredMeta?.unit === 'percentage') {
    return formatValueWithMeta(numeric, inferredMeta);
  }

  if (isCountMetricLabel(label)) {
    return Math.round(numeric).toLocaleString('en-US');
  }

  const formatted = formatPillValue(rawStr);
  if ((inferredMeta?.unit === 'currency' || isMonetaryMetricLabel(label)) && !/[R$€¥£$]/.test(formatted)) {
    return currencySymbol ? `${currencySymbol}${formatted}` : formatted;
  }

  return formatted;
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

function stripThinkingTags(text) {
  if (!text || typeof text !== 'string') return text || '';
  return text
    .replace(/<(?:thought|thinking|reasoning|reflection)>[\s\S]*?<\/(?:thought|thinking|reasoning|reflection)>/gi, '')
    .replace(/<\/?(?:thought|thinking|reasoning|reflection)>/gi, '')
    .trim();
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

/**
 * Format metric pill values for business readability (e.g., 1010271.37 → "1.01M").
 * Already-formatted strings (with K/M/B/% suffix) pass through unchanged.
 */
function formatPillValue(raw) {
  const str = String(raw ?? '').trim();
  // Already formatted (has K/M/B suffix or % sign) — pass through
  if (/[KMB%]$/i.test(str)) return str;
  // Non-numeric content: contains letters, date patterns, or range connectors — pass through
  if (/[a-wyz]/i.test(str) || /\d{4}-\d{2}/.test(str) || /\bto\b|[~–—]/i.test(str)) return str;
  const num = parseFloat(str.replace(/,/g, ''));
  if (!Number.isFinite(num)) return str;
  const abs = Math.abs(num);
  if (abs >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${(num / 1_000).toFixed(1)}K`;
  if (abs >= 100) return num.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (abs >= 1) return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return str;
}

/**
 * Clean floating point residuals and extreme percentages in any string.
 * "1010271.3700000371" → "1,010,271.37"
 * "1103687.798%" → ">10,000%"
 */
function cleanFloatingPointInText(text) {
  if (typeof text !== 'string') return text;
  // Fix floating-point residuals: numbers with 5+ decimal places → truncate to 2
  let cleaned = text.replace(/(\d+\.\d{2})\d{5,}/g, '$1');
  // Cap extreme percentages (|value| > 10000%)
  cleaned = cleaned.replace(
    /([+-]?\d{5,}(?:\.\d+)?)\s*%/g,
    (_match, num) => {
      const val = parseFloat(num);
      if (Math.abs(val) > 10000) return val > 0 ? '>10,000%' : '<-10,000%';
      return _match;
    },
  );
  // Format large unformatted numbers in narrative (e.g., 1010271.37 → 1,010,271.37)
  cleaned = cleaned.replace(
    /(?<![.\d])(\d{4,})\.(\d{1,2})(?!\d)/g,
    (_match, intPart, decPart) => Number(intPart).toLocaleString('en-US') + '.' + decPart,
  );
  return cleaned;
}

/** Round float to 2 decimal places for table cells */
function cleanFloatNumber(num) {
  if (!Number.isFinite(num)) return num;
  return Math.round(num * 100) / 100;
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
  const sanitized = stripThinkingTags(text);
  return splitNarrativeIntoSentences(sanitized).filter((line) => !isDebugLine(line) && !MARKDOWN_TABLE_PATTERN.test(line));
}

function buildMetricPills(toolCalls = [], { brevity, columnMetaMap = {} } = {}) {
  const maxPills = brevity === 'analysis' ? 8 : 4;
  const analysisPayloads = toolCalls.flatMap((toolCall) => extractAnalysisPayloadsFromToolCall(toolCall));
  const firstMetrics = analysisPayloads.find((payload) => isPlainObject(payload?.metrics))?.metrics;
  if (firstMetrics) {
    return Object.entries(firstMetrics)
      .slice(0, maxPills)
      .map(([label, value]) => ({ label: String(label), value: formatValueWithMeta(value, columnMetaMap[label]) }));
  }

  const firstRows = toolCalls.map((toolCall) => getStructuredRows(toolCall)).find((rows) => rows.length > 0) || [];
  if (firstRows.length > 0) {
    const firstRow = firstRows[0];
    return Object.entries(firstRow)
      .filter(([, value]) => typeof value === 'number' || (typeof value === 'string' && value.length <= 24))
      .slice(0, maxPills)
      .map(([label, value]) => ({ label, value: formatValueWithMeta(value, columnMetaMap[label]) }));
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

/**
 * Auto-infer xKey/yKey from chart data if missing.
 * Returns the chart with inferred keys, or null if chart is unrenderable.
 */
function inferChartKeys(chart) {
  if (!isPlainObject(chart) || !Array.isArray(chart.data) || chart.data.length === 0) return null;
  const sample = chart.data[0];
  if (!isPlainObject(sample)) return null;
  const keys = Object.keys(sample);
  if (keys.length < 2) return null;
  const numericKeys = keys.filter((k) => typeof sample[k] === 'number');
  const stringKeys = keys.filter((k) => typeof sample[k] === 'string');
  if (!chart.xKey) chart.xKey = stringKeys[0] || keys[0];
  if (!chart.yKey) chart.yKey = numericKeys[0] || keys.find((k) => k !== chart.xKey) || keys[1];
  return chart;
}

function buildChartsFromToolCalls(toolCalls = [], { brevity } = {}) {
  const maxCharts = brevity === 'analysis' ? 4 : 2;
  const charts = [];
  for (const toolCall of Array.isArray(toolCalls) ? toolCalls : []) {
    const payloads = extractAnalysisPayloadsFromToolCall(toolCall);
    for (const payload of payloads) {
      if (!Array.isArray(payload?.charts)) continue;
      for (const chart of payload.charts) {
        if (!isPlainObject(chart) || !chart.type || !Array.isArray(chart.data) || chart.data.length === 0) continue;
        const cleanData = chart.data.filter(d => isPlainObject(d) && Object.keys(d).length > 0);
        if (cleanData.length === 0) continue;
        const built = {
          type: String(chart.type),
          data: cleanData,
          xKey: chart.xKey ? String(chart.xKey) : '',
          yKey: chart.yKey ? String(chart.yKey) : '',
          ...(Array.isArray(chart.series) ? { series: chart.series.map(String) } : {}),
          ...(chart.title ? { title: String(chart.title) } : {}),
          ...(chart.xAxisLabel ? { xAxisLabel: String(chart.xAxisLabel) } : {}),
          ...(chart.yAxisLabel ? { yAxisLabel: String(chart.yAxisLabel) } : {}),
          ...(Array.isArray(chart.referenceLines) ? { referenceLines: chart.referenceLines } : {}),
          ...(isPlainObject(chart.colorMap) ? { colorMap: chart.colorMap } : {}),
          ...(Array.isArray(chart.colors) ? { colors: chart.colors } : {}),
          ...(chart.tickFormatter ? { tickFormatter: chart.tickFormatter } : {}),
          ...(Array.isArray(chart.compatibleTypes) ? { compatibleTypes: chart.compatibleTypes } : {}),
        };
        // Auto-infer xKey/yKey if not provided by the recipe
        if (!built.xKey || !built.yKey) inferChartKeys(built);
        charts.push(built);
        if (charts.length >= maxCharts) return charts;
      }
    }
  }
  return charts;
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
  const cleanedText = stripThinkingTags(finalAnswerText);
  const normalizedContract = normalizeAnswerContract(answerContract, userMessage);
  const brevity = normalizedContract?.brevity;
  const trace = buildTrace(toolCalls, cleanedText);

  return {
    headline: pickHeadline({ finalAnswerText: cleanedText, toolCalls, trace, answerContract: normalizedContract }),
    summary: pickSummary({ finalAnswerText: cleanedText, trace, answerContract: normalizedContract, toolCalls }),
    metric_pills: buildMetricPills(toolCalls, { brevity, columnMetaMap: buildColumnMetaMap(toolCalls) }),
    tables: buildEvidenceTables(toolCalls, normalizedContract, { brevity }),
    charts: buildChartsFromToolCalls(toolCalls, { brevity }),
    key_findings: inferKeyFindings({
      finalAnswerText: cleanedText,
      toolCalls,
      answerContract: normalizedContract,
      trace,
    }),
    implications: inferImplications({ answerContract: normalizedContract, toolCalls }),
    caveats: inferCaveats({ finalAnswerText: cleanedText, trace, toolCalls }),
    next_steps: inferNextSteps({ answerContract: normalizedContract, trace }),
  };
}

/**
 * Sanitize a brief that may contain raw markdown dumps or malformed fields
 * (common with DeepSeek Reasoner or similar models that resist JSON structure).
 */
function sanitizeBrief(brief) {
  if (!isPlainObject(brief)) return brief;

  // Strip markdown headers from headline
  if (brief.headline && typeof brief.headline === 'string') {
    brief.headline = brief.headline.replace(/^#{1,4}\s*/, '').replace(/^\*{2}|[\*]{2}$/g, '').trim();
  }

  // Truncate summary if it contains markdown headers (sign of raw narrative dump)
  if (brief.summary && typeof brief.summary === 'string' && /^##\s/m.test(brief.summary)) {
    brief.summary = brief.summary.split(/\n##\s/)[0].trim();
  }

  // Cap summary length — if > 3000 chars, take first paragraph
  if (brief.summary && typeof brief.summary === 'string' && brief.summary.length > 3000) {
    const firstPara = brief.summary.split(/\n\n/)[0];
    brief.summary = firstPara.length > 200 ? firstPara : brief.summary.slice(0, 3000);
  }

  // Filter metric_pills: remove raw timestamps and non-numeric pills
  if (Array.isArray(brief.metric_pills)) {
    brief.metric_pills = brief.metric_pills.filter((p) => {
      if (!isPlainObject(p)) return false;
      const val = String(p.value || '');
      // Remove raw unix timestamps (10-13 digit numbers with no other content)
      if (/^\d{10,13}$/.test(val.trim())) return false;
      return true;
    });
  }

  return brief;
}

function normalizeBrief(brief, fallbackBrief, { brevity } = {}) {
  const isAnalysis = brevity === 'analysis';
  const source = isPlainObject(brief) ? sanitizeBrief({ ...brief }) : {};
  // Map agent's chart_specs field to charts for normalization
  if (!source.charts && Array.isArray(source.chart_specs)) {
    source.charts = source.chart_specs;
  }
  const fallback = isPlainObject(fallbackBrief) ? fallbackBrief : {};
  const normalized = {
    headline: normalizeSentence(cleanFloatingPointInText(source.headline || fallback.headline || 'Analysis complete.')),
    summary: normalizeSentence(cleanFloatingPointInText(source.summary || fallback.summary || '')),
    metric_pills: Array.isArray(source.metric_pills)
      ? source.metric_pills
        .filter((item) => isPlainObject(item) && item.label && item.value != null)
        .map((item) => ({
          label: String(item.label),
          value: typeof item.value === 'string' ? cleanFloatingPointInText(item.value) : String(item.value),
          ...(item.source ? { source: String(item.source) } : {}),
        }))
      : (fallback.metric_pills || []),
    tables: Array.isArray(source.tables)
      ? source.tables
        .filter((table) => isPlainObject(table) && Array.isArray(table.columns) && Array.isArray(table.rows))
        .map((table) => ({
          title: table.title ? String(table.title) : '',
          columns: table.columns.map((column) => String(column)),
          rows: table.rows.map((row) => Array.isArray(row) ? row.map((value) => (typeof value === 'number' ? cleanFloatNumber(value) : cleanFloatingPointInText(formatValue(value)))) : []),
        }))
      : (fallback.tables || []),
    charts: Array.isArray(source.charts)
      ? source.charts
        .filter((chart) => isPlainObject(chart) && chart.type && Array.isArray(chart.data))
        .map((chart) => {
          const cleanData = chart.data.filter(d => isPlainObject(d) && Object.keys(d).length > 0);
          return {
            type: String(chart.type),
            data: cleanData,
            xKey: chart.xKey ? String(chart.xKey) : '',
            yKey: chart.yKey ? String(chart.yKey) : '',
            ...(Array.isArray(chart.series) ? { series: chart.series.map(String) } : {}),
            ...(chart.title ? { title: String(chart.title) } : {}),
            ...(chart.xAxisLabel ? { xAxisLabel: String(chart.xAxisLabel) } : {}),
            ...(chart.yAxisLabel ? { yAxisLabel: String(chart.yAxisLabel) } : {}),
            ...(Array.isArray(chart.referenceLines) ? { referenceLines: chart.referenceLines } : {}),
            ...(isPlainObject(chart.colorMap) ? { colorMap: chart.colorMap } : {}),
            ...(Array.isArray(chart.colors) ? { colors: chart.colors } : {}),
            ...(chart.tickFormatter ? { tickFormatter: chart.tickFormatter } : {}),
            ...(Array.isArray(chart.compatibleTypes) ? { compatibleTypes: chart.compatibleTypes } : {}),
          };
        })
        .map((chart) => (!chart.xKey || !chart.yKey) ? (inferChartKeys(chart) || chart) : chart)
        .filter((chart) => chart.data.length > 0)
      : (fallback.charts || []),
    key_findings: uniqueStrings(Array.isArray(source.key_findings) ? source.key_findings.map(cleanFloatingPointInText) : fallback.key_findings || []).slice(0, isAnalysis ? 10 : 5),
    implications: uniqueStrings(Array.isArray(source.implications) ? source.implications.map(cleanFloatingPointInText) : fallback.implications || []).slice(0, isAnalysis ? 6 : 4),
    caveats: uniqueStrings(Array.isArray(source.caveats) ? source.caveats.map(cleanFloatingPointInText) : fallback.caveats || []).slice(0, isAnalysis ? 6 : 4),
    next_steps: uniqueStrings(Array.isArray(source.next_steps) ? source.next_steps.map(cleanFloatingPointInText) : fallback.next_steps || []).slice(0, isAnalysis ? 6 : 4),
    methodology_note: typeof source.methodology_note === 'string' ? cleanFloatingPointInText(source.methodology_note.trim()) : (fallback.methodology_note || null),
    executive_summary: typeof source.executive_summary === 'string' ? cleanFloatingPointInText(source.executive_summary.trim()) : (fallback.executive_summary || null),
    data_lineage: Array.isArray(source.data_lineage)
      ? source.data_lineage.filter((item) => isPlainObject(item) && item.metric)
      : (fallback.data_lineage || []),
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

function normalizeBriefForQa(brief, fallbackBrief, { brevity, toolCalls = [] } = {}) {
  const normalized = normalizeBrief(brief, fallbackBrief, { brevity });
  const columnMetaMap = buildColumnMetaMap(toolCalls);
  const currencySymbol = detectPreferredCurrencySymbol(toolCalls, normalized);
  const maxPills = brevity === 'analysis' ? 6 : 4;

  if (Array.isArray(normalized.metric_pills)) {
    normalized.metric_pills = normalized.metric_pills
      .map((pill) => ({
        ...pill,
        label: String(pill?.label || '').trim(),
        value: formatMetricPillValue(pill?.value, pill?.label, { currencySymbol, columnMetaMap }),
      }))
      .filter((pill) => pill.label && pill.value)
      .slice(0, maxPills);

    const unmatchedLabels = new Set(
      verifyMetricPillsAgainstEvidence(normalized, toolCalls)
        .map((failure) => {
          const match = String(failure || '').match(/Metric pill "([^":]+):/i);
          return match ? match[1].trim().toLowerCase() : null;
        })
        .filter(Boolean),
    );
    if (unmatchedLabels.size > 0) {
      normalized.metric_pills = normalized.metric_pills.filter(
        (pill) => !unmatchedLabels.has(String(pill?.label || '').trim().toLowerCase()),
      );
    }
  }

  if (typeof normalized.summary === 'string' && Array.isArray(normalized.key_findings) && normalized.key_findings.length > 1) {
    normalized.key_findings = normalized.key_findings.filter((finding) => (
      typeof finding !== 'string' || textSimilarity(normalized.summary, finding) < 0.9
    ));
    if (normalized.key_findings.length === 0 && Array.isArray(brief?.key_findings)) {
      normalized.key_findings = uniqueStrings(brief.key_findings.map(cleanFloatingPointInText)).slice(0, maxPills);
    }
  }

  return normalized;
}

/**
 * Lightweight deterministic repair: fixes the most common QA failures
 * without requiring an LLM call. Used as fallback when LLM repair times out.
 */
function applyDeterministicRepairs(brief, deterministicQa) {
  if (!brief || typeof brief !== 'object') return brief;
  const patched = JSON.parse(JSON.stringify(brief));

  const flags = deterministicQa?.flags || {};

  // Add missing proxy/limitation caveat if flagged
  if (flags.missing_proxy_caveat || flags.missing_limitation_caveat) {
    const caveats = Array.isArray(patched.caveats) ? patched.caveats : [];
    const hasProxy = caveats.some(c => /proxy|surrogate|approximat/i.test(c));
    if (!hasProxy) {
      caveats.push('Analysis uses proxy metrics where direct measurements are unavailable; interpret trends directionally rather than as precise values.');
      patched.caveats = caveats;
    }
  }

  // Strip metric pills that have no matching evidence
  if (flags.unmatched_pills && Array.isArray(patched.metric_pills)) {
    const unmatchedLabels = new Set(
      [...(deterministicQa?.issues || []), ...(deterministicQa?.blockers || [])]
        .filter(t => /pill.*no matching evidence/i.test(String(t || '')))
        .map(t => {
          const m = String(t || '').match(/pill "([^":]+):/i);
          return m ? m[1].toLowerCase() : null;
        })
        .filter(Boolean)
    );
    if (unmatchedLabels.size > 0) {
      patched.metric_pills = patched.metric_pills.filter(
        p => !unmatchedLabels.has(String(p?.label || '').toLowerCase())
      );
    }
  }

  // Confusion ranges for ratio↔percentage repair: detects Nx order-of-magnitude mismatches
  const CONFUSION_RANGES = [
    { min: 0.009, max: 0.011 },  // 1/100x
    { min: 0.09, max: 0.11 },    // 1/10x
    { min: 9, max: 11 },          // 10x
    { min: 90, max: 110 },        // 100x
    { min: 900, max: 1100 },      // 1000x
  ];
  const isConfusionRatio = (r) => CONFUSION_RANGES.some(({ min, max }) => r >= min && r <= max);

  // Fix pill-narrative magnitude inconsistency (ratio↔percentage confusion)
  if (flags.pill_narrative_inconsistency && Array.isArray(patched.metric_pills)) {
    const conflictingLabels = new Set(
      [...(deterministicQa?.blockers || []), ...(deterministicQa?.issues || [])]
        .filter((line) => /pill ".*conflicts with narrative/i.test(String(line || '')))
        .map((line) => {
          const match = String(line || '').match(/Pill "([^":]+):/i);
          return match ? match[1].trim().toLowerCase() : null;
        })
        .filter(Boolean),
    );

    if (conflictingLabels.size > 0) {
      patched.metric_pills = patched.metric_pills.filter((pill) => {
        const label = String(pill?.label || '').trim().toLowerCase();
        const rawVal = String(pill?.value || '').trim();
        const ambiguousGrowthUnit = /cagr|growth|rate|change|成長率|增长率|增長率|年均成長率|年均增长率/.test(label)
          && /[%％]|(?:^|\s)[xX](?:\s|$)|倍/.test(rawVal);
        return !(conflictingLabels.has(label) && ambiguousGrowthUnit);
      });
    }

    for (const pill of patched.metric_pills) {
      const label = String(pill?.label || '').trim();
      const rawVal = String(pill?.value || '').trim();
      if (!label || !rawVal) continue;
      const pillNum = parsePillNumber(rawVal);
      if (!pillNum || pillNum === 0) continue;

      // Build search patterns from label
      const labelWords = label.split(/[\s_-]+/).filter(w => w.length >= 2);
      const searchTerms = [label, ...labelWords].map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

      // Fix in summary + key_findings: replace raw ratio values with pill-consistent values
      const textFields = ['summary', 'executive_summary'];
      for (const field of textFields) {
        if (typeof patched[field] !== 'string') continue;
        for (const term of searchTerms) {
          const pattern = new RegExp(
            '(' + term + '[^\\d]{0,40}?)([+-]?\\d[\\d,]*(?:\\.\\d+)?)(?!\\s*[%xKMB倍])',
            'gi',
          );
          patched[field] = patched[field].replace(pattern, (fullMatch, prefix, numStr) => {
            const narrativeNum = parseFloat(numStr.replace(/,/g, ''));
            if (!Number.isFinite(narrativeNum) || narrativeNum === 0) return fullMatch;
            const ratio = pillNum / narrativeNum;
            if (isConfusionRatio(ratio)) {
              return prefix + rawVal; // Replace with the pill's formatted value
            }
            return fullMatch;
          });
        }
      }

      // Fix in key_findings array
      if (Array.isArray(patched.key_findings)) {
        patched.key_findings = patched.key_findings.map(finding => {
          if (typeof finding !== 'string') return finding;
          for (const term of searchTerms) {
            const pattern = new RegExp(
              '(' + term + '[^\\d]{0,40}?)([+-]?\\d[\\d,]*(?:\\.\\d+)?)(?!\\s*[%xKMB倍])',
              'gi',
            );
            finding = finding.replace(pattern, (fullMatch, prefix, numStr) => {
              const narrativeNum = parseFloat(numStr.replace(/,/g, ''));
              if (!Number.isFinite(narrativeNum) || narrativeNum === 0) return fullMatch;
              const ratio = pillNum / narrativeNum;
              if (isConfusionRatio(ratio)) {
                return prefix + rawVal;
              }
              return fullMatch;
            });
          }
          return finding;
        });
      }
    }
  }

  // Auto-detect extreme growth from pills even when flag wasn't set by computeDeterministicQa
  if (!flags.missing_low_base_caveat && Array.isArray(patched.metric_pills)) {
    for (const pill of patched.metric_pills) {
      const label = String(pill?.label || '').toLowerCase();
      if (!/cagr|growth|成長率|年均|annualized/i.test(label)) continue;
      const num = parsePillNumber(String(pill?.value || ''));
      if (Math.abs(num) > 500) {
        flags.missing_low_base_caveat = true;
        break;
      }
    }
  }

  // Auto-insert low-base CAGR caveat when extreme growth detected
  if (flags.missing_low_base_caveat) {
    const caveats = Array.isArray(patched.caveats) ? patched.caveats : [];
    const hasBaseCaveat = caveats.some(c => /low.?base|inflat|extreme.*growth|base.*period/i.test(c));
    if (!hasBaseCaveat) {
      caveats.push('CAGR exceeds 500% due to very low base-period values; interpret absolute growth figures for decision-making rather than annualized rates.');
      patched.caveats = caveats;
    }
  }

  // Auto-insert partial-year caveat when CAGR uses years with unequal month coverage
  if (flags.missing_partial_year_caveat) {
    const caveats = Array.isArray(patched.caveats) ? patched.caveats : [];
    const hasPartialCaveat = caveats.some(c => /partial.?year|incomplete.?year|部分年度|僅.*個月|only.*months/i.test(c));
    if (!hasPartialCaveat) {
      caveats.push('Some years in this analysis have partial data coverage (fewer months than others). CAGR and YoY comparisons across years with unequal coverage reflect data availability differences, not true growth. Prefer comparable full-coverage periods; use per-month normalization only when the base period has at least 6 months of coverage.');
      patched.caveats = caveats;
    }
  }

  return patched;
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
    information_density: 10,
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

  // Handle K/M/B suffixes first (e.g. "R$543.67K" → 543670)
  const kmb = raw.match(/([-+]?\d[\d,.]*)\s*([KMBkmb])\b/);
  if (kmb) {
    let num = parseFloat(kmb[1].replace(/,/g, ''));
    if (!Number.isFinite(num)) return null;
    const suffix = kmb[2].toUpperCase();
    if (suffix === 'K') num *= 1_000;
    else if (suffix === 'M') num *= 1_000_000;
    else if (suffix === 'B') num *= 1_000_000_000;
    return num;
  }

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

function detectMetricQualifier(text) {
  const sample = String(text || '').toLowerCase();
  const qualifiers = [];
  if (/normalized|標準化/.test(sample)) qualifiers.push('normalized');
  if (/\bmonthly\b|月均|平均月|每月|月營收/.test(sample)) qualifiers.push('monthly');
  else if (/\bannual\b|yearly|年度|年均|平均年|每年/.test(sample)) qualifiers.push('annual');
  if (/\boverall\b|整體|全平台|all regions|all states/.test(sample)) qualifiers.push('overall');
  return uniqueStrings(qualifiers).join(' ');
}

function detectMetricAlias(text) {
  const sample = String(text || '');
  const alias = METRIC_ALIAS_PATTERNS.find((entry) => entry.patterns.some((pattern) => pattern.test(sample)))?.key || '';
  const dimension = detectDimensionFromText(sample);
  const qualifier = detectMetricQualifier(sample);
  const parts = [alias, qualifier, dimension].filter(Boolean);
  if (parts.length > 0) return uniqueStrings(parts).join(' ');
  return '';
}

function isQuantifiedMetricKey(metricKey) {
  return Boolean(metricKey) && !DIMENSION_LABELS.has(metricKey);
}

function inferMetricFactUnit(metricKey, raw = '') {
  const sample = `${metricKey || ''} ${raw || ''}`.toLowerCase();
  if (/%|％|percent|percentage|cagr|growth|rate|成長率|增长率|增長率/.test(sample)) return 'percentage';
  if (/r\$|\$|€|£|revenue|sales|gmv|amount|value|price|payment|cost|營收|收入|金額|價格/.test(sample)) return 'currency';
  if (/orders?|count|qty|quantity|months?|rows?|regions?|states?|筆數|數量|月份|州數/.test(sample)) return 'count';
  return 'generic';
}

function extractFactContextKey(raw = '') {
  const sample = String(raw || '');
  const lower = sample.toLowerCase();
  const parts = [];

  const yearMatches = sample.match(/\b(?:19|20)\d{2}\b/g) || [];
  for (const year of yearMatches) {
    parts.push(`year:${year}`);
  }

  if (/\boverall\b|整體|全平台|all regions|all states|platform|total\b|^all$/i.test(sample)) {
    parts.push('scope:overall');
  }

  const ENTITY_STOPWORDS = new Set([
    'CAGR', 'YOY', 'MOM', 'QOQ', 'GMV', 'AVG', 'SQL', 'KPI', 'RFM', 'P50', 'P75', 'P90', 'P95', 'P99',
  ]);
  const upperTokens = sample.match(/\b[A-Z]{2,4}\b/g) || [];
  for (const token of upperTokens) {
    if (!ENTITY_STOPWORDS.has(token)) parts.push(`entity:${token}`);
  }

  const explicitContext = [...sample.matchAll(/\b(region|state|section|category|segment|group|entity|seller|customer|product|brand|channel|bucket|bin|metric|year)\s*[:=]\s*([A-Za-z0-9_\-\u3400-\u9fff]+)/gi)];
  for (const [, key, value] of explicitContext) {
    parts.push(`${String(key || '').toLowerCase()}:${String(value || '').toLowerCase()}`);
  }

  if (/^\s*(sp|rj|mg|pr|sc|rs|ba|go|df|es|ce|pe|pa|mt|ms|am|ap|rn|pb|al|se|pi|ma|ro|ac|rr|to)\b/i.test(lower)) {
    const match = lower.match(/^\s*([a-z]{2})\b/i);
    if (match?.[1]) parts.push(`entity:${match[1].toUpperCase()}`);
  }

  return uniqueStrings(parts).sort().join('|');
}

function pushMetricFact(facts, metricKey, numeric, sourceLabel, raw) {
  if (numeric == null || !isQuantifiedMetricKey(metricKey)) return;
  const unitType = inferMetricFactUnit(metricKey, raw);
  const contextKey = extractFactContextKey(raw);
  if (facts.some((fact) => fact.metricKey === metricKey && fact.unitType === unitType && fact.contextKey === contextKey && !areNumbersMeaningfullyDifferent(fact.value, numeric))) return;
  facts.push({ metricKey, value: numeric, source: sourceLabel, raw, unitType, contextKey });
}

function extractExplicitMetricFacts(raw, sourceLabel = 'brief_text') {
  const facts = [];
  const isValidMeanFactContext = (matchedText, fullText = '', offset = 0) => {
    const windowStart = Math.max(0, offset - 40);
    const windowEnd = Math.min(fullText.length, offset + String(matchedText || '').length + 40);
    const context = `${matchedText} ${fullText.slice(windowStart, windowEnd)}`.toLowerCase();
    const hasMetricNoun = /revenue|sales|gmv|amount|value|price|cost|payment|orders?|客單價|月營收|年營收|月均營收|平均月營收|平均年營收|每州營收|營收|收入|金額|均值/.test(context);
    const looksLikeGrowthContext = /cagr|growth|rate|增長率|增长率|成長率|年均成長率|年化成長率|normalized cagr|標準化 cagr|標準化成長/i.test(context);
    return hasMetricNoun && !looksLikeGrowthContext;
  };
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
        if (spec.key === 'mean' && !isValidMeanFactContext(match[0], raw, match.index || 0)) continue;
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
  const IDENTIFIER_COL = /region|state|year|month|date|section|category|segment|group|entity|seller|customer|product|brand|channel|bucket|bin|metric|name|label|cohort/i;

  for (const table of Array.isArray(tables) ? tables : []) {
    const columns = Array.isArray(table?.columns) ? table.columns.map((column) => String(column || '')) : [];
    const rows = Array.isArray(table?.rows) ? table.rows : [];
    if (columns.length === 0 || rows.length === 0) continue;

    for (const row of rows) {
      const cells = Array.isArray(row)
        ? row
        : columns.map((column) => row?.[column]);

      const rowContext = columns.map((column, idx) => {
        const cell = cells[idx];
        const numeric = parseNumericValue(cell);
        if (IDENTIFIER_COL.test(column)) return `${column}=${cell}`;
        if (looksLikeYearLiteral(cell, numeric)) return `${column}=${cell}`;
        if (typeof cell === 'string' && cell.trim() && numeric == null) return `${column}=${cell}`;
        return '';
      }).filter(Boolean).slice(0, 4).join(' | ');

      columns.forEach((column, index) => {
        const metricKey = detectMetricAlias(column);
        const numeric = parseNumericValue(cells[index]);
        pushMetricFact(facts, metricKey, numeric, sourceLabel, `${column}: ${cells[index]} ${rowContext}`.trim());
      });

      const rowLabelMetricKey = detectMetricAlias(cells[0]);
      if (rowLabelMetricKey && cells.length > 1) {
        const numeric = parseNumericValue(cells[1]);
        pushMetricFact(facts, rowLabelMetricKey, numeric, sourceLabel, `${cells[0]}: ${cells[1]} ${rowContext}`.trim());
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
// ── Scope mismatch: detect when brief mixes data from different scopes ──────
/**
 * Detect when the brief mixes numbers from different data scopes.
 * E.g., SQL filters to delivered-only but brief cites unfiltered chart totals.
 */
function detectScopeMismatch({ brief, toolCalls = [] }) {
  const tcs = Array.isArray(toolCalls) ? toolCalls : [];
  const sqlCalls = tcs.filter(tc => tc?.name === 'query_sap_data' && tc?.result?.success);
  const chartCalls = tcs.filter(tc => tc?.name === 'generate_chart' && tc?.result?.success);
  if (sqlCalls.length === 0 || chartCalls.length === 0) return null;

  // Check if SQL uses a scope filter that the chart doesn't
  const sqlFilters = sqlCalls.map(tc => {
    const sql = String(tc?.args?.sql || tc?.input?.sql || '').toLowerCase();
    const scopeMatch = sql.match(/where\s+.*?(?:order_status|status)\s*=\s*'(\w+)'/i);
    return scopeMatch ? scopeMatch[1] : null;
  }).filter(Boolean);
  if (sqlFilters.length === 0) return null;

  const briefText = [brief?.headline, brief?.summary, ...(brief?.key_findings || [])].filter(Boolean).join(' ');
  const claimsDeliveredOnly = /delivered.only|delivered orders only|已交付|僅.*delivered/i.test(briefText);

  if (claimsDeliveredOnly && sqlFilters.includes('delivered')) {
    const pillsFromChart = (brief?.metric_pills || []).filter(p =>
      /generate_chart|chart/i.test(String(p?.source || '')),
    );
    if (pillsFromChart.length > 0) {
      return 'Brief claims "delivered orders only" but metric pills cite chart artifact data which includes all order statuses. Use consistent data scope.';
    }
  }
  return null;
}

// ── Pill-vs-narrative consistency: detect ratio↔percentage confusion ────────────

/**
 * Detect cases where a metric pill value and the narrative cite the same metric
 * but with different magnitudes — typically ratio↔percentage confusion.
 * E.g., pill says "CAGR: 1118%" but narrative says "CAGR 為 11.18".
 */
function detectPillNarrativeInconsistency(brief) {
  const pills = Array.isArray(brief?.metric_pills) ? brief.metric_pills : [];
  if (pills.length === 0) return [];

  const narrativeText = [
    brief?.headline,
    brief?.summary,
    brief?.executive_summary,
    ...(brief?.key_findings || []),
  ].filter(Boolean).join('\n');

  const issues = [];

  for (const pill of pills) {
    const label = String(pill?.label || '').trim();
    const rawVal = String(pill?.value || '').trim();
    if (!label || !rawVal) continue;

    const pillNum = parsePillNumber(rawVal);
    if (!pillNum || pillNum === 0) continue;

    // Build label variants for fuzzy search (e.g., "整體 CAGR" → ["整體 CAGR", "整體", "CAGR"])
    const labelWords = label.split(/[\s_-]+/).filter(w => w.length >= 2);
    const searchTerms = [label, ...labelWords].map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

    // Find numbers near the label in narrative
    for (const term of searchTerms) {
      // Match: label ...up to 40 chars... number (with optional % or x suffix)
      const pattern = new RegExp(
        term + '[^\\d]{0,40}?([+-]?\\d[\\d,]*(?:\\.\\d+)?)\\s*(%|x|倍)?',
        'gi',
      );
      let match;
      while ((match = pattern.exec(narrativeText)) !== null) {
        const narrativeNumStr = match[1].replace(/,/g, '');
        let narrativeNum = parseFloat(narrativeNumStr);
        if (!Number.isFinite(narrativeNum) || narrativeNum === 0) continue;

        // Apply suffix
        const suffix = match[2] || '';
        if (suffix === '%') narrativeNum = narrativeNum; // already in % form
        else if (suffix === 'x' || suffix === '倍') narrativeNum = narrativeNum * 100; // convert multiplier to %

        // Compare pill value (already parsed, includes K/M/B expansion) vs narrative value
        const ratio = pillNum / narrativeNum;

        // Skip if values are close (within 10%) — no inconsistency
        if (ratio >= 0.9 && ratio <= 1.1) continue;

        // Detect ratio↔percentage confusion: ratio is near 100 or 0.01
        const isRatioPctConfusion = (
          (ratio >= 90 && ratio <= 110) ||   // pill is ~100x narrative (pill=1118, narrative=11.18)
          (ratio >= 0.009 && ratio <= 0.011)  // pill is ~0.01x narrative (pill=11.18, narrative=1118)
        );

        if (isRatioPctConfusion) {
          issues.push(
            `Pill "${label}: ${rawVal}" conflicts with narrative value "${match[0].trim()}" — likely ratio↔percentage unit confusion. Use consistent units.`,
          );
          break; // one issue per pill is enough
        }
      }
    }
  }

  return issues;
}

// ── Derived value consistency: check averages match totals/counts ────────────

/** Parse a pill value string like "R$13.59M" or "543,666" into a number */
function parsePillNumber(str) {
  if (typeof str !== 'string') return 0;
  const cleaned = str.replace(/[R$€¥£,\s]/g, '');
  const match = cleaned.match(/^([+-]?\d+(?:\.\d+)?)\s*([KMBkmb])?/);
  if (!match) return 0;
  let num = parseFloat(match[1]);
  const suffix = (match[2] || '').toUpperCase();
  if (suffix === 'K') num *= 1000;
  if (suffix === 'M') num *= 1_000_000;
  if (suffix === 'B') num *= 1_000_000_000;
  return num;
}

/**
 * Check internal consistency of derived values in the brief.
 * E.g., if brief says "24 months" and "average R$543K", verify 543K * 24 ≈ total.
 */
function checkDerivedValueConsistency({ brief }) {
  const issues = [];
  const pills = brief?.metric_pills || [];
  const text = [brief?.summary, ...(brief?.key_findings || [])].filter(Boolean).join(' ');

  // Extract total and average from pills
  const totalRevenuePill = pills.find(p => /total.*revenue|revenue.*total/i.test(p?.label));
  const avgRevenuePill = pills.find(p => /avg|average|mean/i.test(p?.label) && /revenue/i.test(p?.label));
  // Match "Months: 25" but NOT "Avg Monthly Revenue: R$543,666" or "Monthly Orders: 1234"
  const monthsPill = pills.find(p => /^months?$/i.test(String(p?.label || '').trim()) && !/missing/i.test(p?.label));

  if (totalRevenuePill && avgRevenuePill && monthsPill) {
    const total = parsePillNumber(totalRevenuePill.value);
    const avg = parsePillNumber(avgRevenuePill.value);
    const months = parsePillNumber(monthsPill.value);

    if (total > 0 && avg > 0 && months > 0) {
      const expectedAvg = total / months;
      const ratio = avg / expectedAvg;
      if (ratio < 0.9 || ratio > 1.1) {
        issues.push(
          `Monthly average (${avgRevenuePill.value}) does not match total (${totalRevenuePill.value}) ÷ months (${monthsPill.value}). Expected ≈${formatPillValue(String(Math.round(expectedAvg)))}.`,
        );
      }
    }
  }

  // Check for contradictory month counts in text
  const monthCounts = [...text.matchAll(/(\d{1,2})\s*(?:months?|個月)/gi)].map(m => parseInt(m[1], 10));
  const uniqueMonthCounts = [...new Set(monthCounts)].filter(n => n >= 12 && n <= 36);
  if (uniqueMonthCounts.length > 2) {
    issues.push(
      `Multiple contradictory month counts found in narrative: ${uniqueMonthCounts.join(', ')}. Reconcile with explicit explanation.`,
    );
  }

  return issues;
}

function collectEvidenceNumbers(toolCalls = []) {
  const evidenceNumbers = new Set();
  for (const tc of (Array.isArray(toolCalls) ? toolCalls : [])) {
    if (tc?.result?.success === false) continue;
    const rows = getStructuredRows(tc);
    for (const row of rows) {
      if (!isPlainObject(row)) continue;
      for (const val of Object.values(row)) {
        const numeric = typeof val === 'number' ? val : parseNumericValue(val);
        if (Number.isFinite(numeric)) evidenceNumbers.add(numeric);
      }
    }
    const payloads = extractAnalysisPayloadsFromToolCall(tc);
    for (const payload of payloads) {
      if (isPlainObject(payload?.metrics)) {
        for (const val of Object.values(payload.metrics)) {
          const numeric = typeof val === 'number' ? val : parseNumericValue(val);
          if (Number.isFinite(numeric)) evidenceNumbers.add(numeric);
        }
      }
      if (Array.isArray(payload?.highlights)) {
        for (const highlight of payload.highlights) {
          const matches = String(highlight || '').match(/(?:[R$€¥£]\$?\s*)?[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s?[KMB])?(?:%|％)?/g) || [];
          for (const match of matches) {
            const numeric = parseNumericValue(match);
            if (Number.isFinite(numeric)) evidenceNumbers.add(numeric);
          }
        }
      }
    }
  }
  return evidenceNumbers;
}

function hasEvidenceNumberMatch(rawValue, numericValue, evidenceNumbers, tolerance = 0.05) {
  if (!Number.isFinite(numericValue) || numericValue === 0) return false;
  for (const evNum of evidenceNumbers) {
    if (!Number.isFinite(evNum) || evNum === 0) continue;
    const ratio = Math.abs(numericValue - evNum) / Math.max(Math.abs(evNum), 1);
    if (ratio <= tolerance) return true;
  }

  const raw = String(rawValue || '');
  if (/%|％/.test(raw)) {
    const asRatio = numericValue / 100;
    for (const evNum of evidenceNumbers) {
      if (!Number.isFinite(evNum) || evNum === 0) continue;
      const ratio = Math.abs(asRatio - evNum) / Math.max(Math.abs(evNum), 1);
      if (ratio <= tolerance) return true;
    }
  } else {
    const asPct = numericValue * 100;
    for (const evNum of evidenceNumbers) {
      if (!Number.isFinite(evNum) || evNum === 0) continue;
      const ratio = Math.abs(asPct - evNum) / Math.max(Math.abs(evNum), 1);
      if (ratio <= tolerance) return true;
    }
  }

  return false;
}

function looksLikeYearLiteral(raw, numeric) {
  const token = String(raw || '').trim();
  return Number.isInteger(numeric)
    && numeric >= 1900
    && numeric <= 2100
    && !/[KMB%％xX倍,$€¥£]/.test(token)
    && !token.includes(',');
}

function extractNarrativeNumericClaims(text) {
  const sentences = extractCleanNarrativeSentences(text);
  const claims = [];
  const numberPattern = /(?:[R$€¥£]\$?\s*)?[+-]?(?:\d{1,3}(?:,\d{3})+|\d{4,}|\d+)(?:\.\d+)?(?:\s?[KMB])?(?:%|％|x|X|倍)?/g;

  for (const sentence of sentences) {
    const matches = sentence.matchAll(new RegExp(numberPattern.source, numberPattern.flags));
    for (const match of matches) {
      const raw = String(match[0] || '').trim();
      const numeric = parseNumericValue(raw);
      if (!Number.isFinite(numeric) || Math.abs(numeric) < 100) continue;
      if (looksLikeYearLiteral(raw, numeric)) continue;
      claims.push({ raw, value: numeric, sentence });
    }
  }

  return claims;
}

function buildSqlColumnRanges(toolCalls = []) {
  const sqlValues = new Map();
  for (const tc of (Array.isArray(toolCalls) ? toolCalls : [])) {
    if (tc?.name !== 'query_sap_data' || !tc?.result?.success) continue;
    const rows = getStructuredRows(tc);
    for (const row of rows) {
      if (!isPlainObject(row)) continue;
      for (const [col, val] of Object.entries(row)) {
        const num = typeof val === 'number' ? val : parseNumericValue(val);
        if (!Number.isFinite(num) || Math.abs(num) < 10) continue;
        if (!sqlValues.has(col)) sqlValues.set(col, new Set());
        sqlValues.get(col).add(num);
      }
    }
  }

  const MONETARY_COL = /revenue|price|value|amount|cost|payment|freight|金額|營收|價格|sales/i;
  const COUNT_COL = /order_count|count|quantity|qty|items|num_|total_orders|total_items|筆數|數量/i;
  const AVG_COL = /^avg_|^mean_|average/i;
  const GROWTH_COL = /cagr|growth|rate|成長率|增長率/i;

  const columnRanges = new Map();
  for (const [col, valueSet] of sqlValues.entries()) {
    const values = [...valueSet];
    const positiveValues = values.filter((value) => value > 0);
    columnRanges.set(col, {
      values,
      max: Math.max(...values),
      min: positiveValues.length > 0 ? Math.min(...positiveValues) : Math.min(...values),
      sum: values.reduce((acc, value) => acc + value, 0),
      count: values.length,
      isMonetary: MONETARY_COL.test(col),
      isCount: COUNT_COL.test(col),
      isAvg: AVG_COL.test(col),
      isGrowth: GROWTH_COL.test(col),
    });
  }

  return columnRanges;
}

function sentenceContextTags(sentence) {
  const sample = String(sentence || '');
  return {
    mentionsRevenue: /revenue|sales|gmv|營收|收入|銷售|金額/i.test(sample),
    mentionsGrowth: /cagr|growth|rate|成長率|增長率|年均成長率/i.test(sample),
    mentionsAverage: /\bavg\b|average|mean|平均/i.test(sample),
    mentionsTotal: /\btotal\b|整體|總營收|總計|合計/i.test(sample),
    mentionsOverall: /overall|整體|全平台|all regions|全地區/i.test(sample),
    mentionsCount: /count|orders|items|customers|sellers|regions|states|訂單|數量|筆數|州數/i.test(sample),
  };
}

function getCandidateColumnsForClaim(sentence, columnRanges) {
  const tags = sentenceContextTags(sentence);
  let candidates = [...columnRanges.entries()];

  // When sentence mentions BOTH growth and revenue (e.g., "營收由 X 增至 Y，成長率為 Z"),
  // don't force-filter to growth-only columns — the claim value could be either.
  if (tags.mentionsGrowth && !tags.mentionsRevenue) {
    candidates = candidates.filter(([col, range]) => range.isGrowth || /cagr|growth|rate/i.test(col));
  } else if (tags.mentionsRevenue && !tags.mentionsGrowth) {
    candidates = candidates.filter(([, range]) => range.isMonetary);
  } else if (tags.mentionsCount) {
    candidates = candidates.filter(([, range]) => range.isCount);
  }

  if (tags.mentionsOverall) {
    const overallCols = candidates.filter(([col]) => /overall|all_regions|allregions|platform|total_revenue_all_regions/i.test(col));
    if (overallCols.length > 0) candidates = overallCols;
  }

  if (tags.mentionsAverage) {
    const avgCols = candidates.filter(([col, range]) => range.isAvg || /avg|average|mean/i.test(col));
    if (avgCols.length > 0) candidates = avgCols;
  } else if (tags.mentionsTotal) {
    const totalCols = candidates.filter(([col]) => /total|overall|sum/i.test(col));
    if (totalCols.length > 0) candidates = totalCols;
  }

  return candidates;
}

// Extract large numeric values from narrative and compare them to plausible
// evidence columns only when there is nearby metric context. This avoids
// fragment-matching comma-formatted numbers like 5,202,955.05 → 202,955.
function detectMagnitudeMismatches({ brief, toolCalls = [] }) {
  const mismatches = [];
  const columnRanges = buildSqlColumnRanges(toolCalls);
  if (columnRanges.size === 0) return mismatches;

  const evidenceNumbers = collectEvidenceNumbers(toolCalls);
  const narrativeText = [
    brief?.headline,
    brief?.summary,
    ...(brief?.key_findings || []),
    ...(brief?.implications || []),
  ].filter(Boolean).join('\n');
  const claims = extractNarrativeNumericClaims(narrativeText);
  if (claims.length === 0) return mismatches;

  for (const claim of claims) {
    if (hasEvidenceNumberMatch(claim.raw, claim.value, evidenceNumbers, 0.05)) continue;

    const candidates = getCandidateColumnsForClaim(claim.sentence, columnRanges);
    if (candidates.length === 0) continue;

    const candidateValues = [];
    for (const [col, range] of candidates) {
      candidateValues.push(...range.values.map((value) => ({ col, value })));
      if (range.count > 1 && (range.isAvg || /\bavg|average|mean|平均/i.test(claim.sentence))) {
        candidateValues.push({ col, value: range.sum / range.count });
      }
      if ((/\btotal\b|整體|總|合計/i.test(claim.sentence) || /overall/i.test(claim.sentence)) && range.sum > 0) {
        candidateValues.push({ col, value: range.sum });
      }
    }
    if (candidateValues.length === 0) continue;

    let closest = candidateValues[0];
    let closestError = Math.abs(claim.value - closest.value) / Math.max(Math.abs(closest.value), 1);
    for (const candidate of candidateValues.slice(1)) {
      const error = Math.abs(claim.value - candidate.value) / Math.max(Math.abs(candidate.value), 1);
      if (error < closestError) {
        closest = candidate;
        closestError = error;
      }
    }

    if (closestError <= 0.5) continue;

    const columnRange = columnRanges.get(closest.col);

    // Skip when claim and column are in completely different magnitude ranges (>100x apart).
    // Skip when claim and column are in different magnitude ranges.
    // This prevents false positives from ambiguous column matching:
    //   - revenue (6M) vs growth rate column (max=60%) → 100,000x apart
    //   - monthly average (512K) vs annual average (6.7M) → 13x apart
    // Real mismatches are within the same order of magnitude (e.g., 5.2M vs 4.8M = 1.08x).
    // Threshold: 10x covers monthly↔annual confusion (12x) and still catches real errors.
    const magnitudeRatio = Math.abs(claim.value) / Math.max(Math.abs(columnRange.max), 1);
    if (magnitudeRatio > 10 || magnitudeRatio < 0.1) continue;

    const upperTolerance = columnRange?.max < 1000 ? 1.5 : 3;
    const lowerTolerance = columnRange?.min < 1000 ? 0.67 : 0.33;

    if (claim.value > columnRange.max * upperTolerance) {
      mismatches.push(
        `Narrative cites ${claim.raw} in "${claim.sentence}" but the closest evidence for "${closest.col}" peaks at ${formatValue(columnRange.max)} — re-check aggregation grain or unit.`,
      );
      continue;
    }
    if (claim.value < columnRange.min * lowerTolerance) {
      mismatches.push(
        `Narrative cites ${claim.raw} in "${claim.sentence}" but the closest evidence for "${closest.col}" bottoms at ${formatValue(columnRange.min)} — re-check aggregation grain or unit.`,
      );
    }
  }

  return mismatches;
}

/**
 * Detect extreme growth rates (CAGR > 500%) in tool call results that lack
 * a corresponding low-base caveat in the brief.
 */
function detectExtremeGrowthRates(toolCalls = [], brief) {
  const issues = [];
  const caveats = Array.isArray(brief?.caveats) ? brief.caveats : [];
  const hasBaseCaveat = caveats.some(c => /low.?base|inflat|extreme.*growth|base.*period|misleading|meaningless|低基期|極低基期|基期過低|基期很低|低基數|基期影響|受.*基期.*放大/i.test(c));
  if (hasBaseCaveat) return issues;

  for (const tc of (Array.isArray(toolCalls) ? toolCalls : [])) {
    if (tc?.result?.success === false) continue;
    const rows = getStructuredRows(tc);
    if (rows.length === 0) continue;
    const firstRow = rows[0];
    const colMeta = inferColumnMeta(rows, tc);

    for (const [col, val] of Object.entries(firstRow || {})) {
      if (typeof val !== 'number') continue;
      const colLower = col.toLowerCase();
      const isTemporalCol = /(^|_)(year|month|day|date)(_|$)/i.test(colLower);
      if (isTemporalCol) continue;

      const meta = colMeta[col];
      const isGrowthCol = /cagr|growth|rate|change|pct|percent/i.test(colLower)
        || meta?.unit === 'ratio_multiplier'
        || meta?.unit === 'percentage'
        || Boolean(meta?.extreme_growth);
      if (!isGrowthCol) continue;

      const growthPct = meta?.unit === 'percentage' ? val : val * 100;
      if (Math.abs(growthPct) > 500) {
        // Only flag if the brief actually cites this extreme value.
        // If the agent computed CAGR in SQL but chose NOT to use it in the brief
        // (e.g., switched to comparable-period growth), don't penalize.
        const briefText = [
          brief?.headline, brief?.summary, brief?.executive_summary,
          ...(Array.isArray(brief?.key_findings) ? brief.key_findings : []),
        ].filter(Boolean).join(' ');
        const pillValues = (Array.isArray(brief?.metric_pills) ? brief.metric_pills : [])
          .map(p => String(p?.value || ''));
        const valStr = val.toFixed(2);
        const pctStr = growthPct.toFixed(0);
        const briefCitesValue = briefText.includes(valStr) || briefText.includes(pctStr)
          || pillValues.some(pv => pv.includes(valStr) || pv.includes(pctStr));

        if (briefCitesValue) {
          issues.push(
            `SQL column "${col}" has extreme value ${valStr} (${pctStr}% growth) — likely from a very low base period. Brief must include a low-base caveat.`
          );
          break;
        }
      }
    }
  }

  return issues;
}

/**
 * Detect partial-year CAGR: if the tool call data validation warnings include
 * 'partial_year_coverage' but the brief contains CAGR pills or findings
 * without acknowledging partial-year coverage, flag it.
 */
function detectPartialYearCagr(toolCalls = [], brief) {
  const issues = [];
  const caveats = Array.isArray(brief?.caveats) ? brief.caveats : [];
  const hasPartialYearCaveat = caveats.some(c =>
    /partial.?year|incomplete.?year|部分年度|年度.*不完整|僅.*個月.*資料|only.*months.*data|coverage.*differ|資料覆蓋.*不同/i.test(c)
  );
  if (hasPartialYearCaveat) return issues;

  // Check if any tool call had a partial_year_coverage warning
  let hasPartialYearWarning = false;
  for (const tc of (Array.isArray(toolCalls) ? toolCalls : [])) {
    const warnings = tc?._dataValidationWarnings || [];
    if (warnings.some(w => w.id === 'partial_year_coverage')) {
      hasPartialYearWarning = true;
      break;
    }
  }
  if (!hasPartialYearWarning) return issues;

  // Check if brief mentions CAGR
  const briefText = [
    brief?.headline || '',
    brief?.summary || '',
    brief?.executive_summary || '',
    ...(Array.isArray(brief?.key_findings) ? brief.key_findings : []),
  ].join(' ');

  const pillLabels = (Array.isArray(brief?.metric_pills) ? brief.metric_pills : [])
    .map(p => String(p?.label || '').toLowerCase());

  const mentionsCagr = /cagr|compound.*annual.*growth|年均成長率|年均增长率|複合.*成長率/i.test(briefText)
    || pillLabels.some(l => /cagr|growth.*rate|成長率/i.test(l));

  if (mentionsCagr) {
    issues.push(
      'Brief computes CAGR but the data contains partial-year coverage (some years have significantly fewer months than others). CAGR across partial years measures data coverage expansion, not true business growth. Must add a caveat stating which years are partial and recommend using comparable full-coverage periods instead. Per-month normalization is only acceptable when the base period has at least 6 months of coverage.'
    );
  }

  return issues;
}

function buildYearCoverageProfile(toolCalls = []) {
  const coverageByYear = new Map();
  const addCoverage = (yearValue, monthsValue) => {
    const year = parseNumericValue(yearValue);
    const months = parseNumericValue(monthsValue);
    if (!Number.isInteger(year) || year < 1900 || year > 2100) return;
    if (!Number.isFinite(months) || months <= 0 || months > 12) return;
    if (!coverageByYear.has(year)) coverageByYear.set(year, []);
    coverageByYear.get(year).push(months);
  };

  for (const tc of (Array.isArray(toolCalls) ? toolCalls : [])) {
    if (tc?.name !== 'query_sap_data' || tc?.result?.success === false) continue;
    const rows = getStructuredRows(tc);
    for (const row of rows) {
      if (!isPlainObject(row)) continue;

      const rowYear = row.year ?? row.Year ?? row.YEAR;
      for (const [key, val] of Object.entries(row)) {
        if (/(^|_)covered_months($|_)|(^|_)overall_covered_months($|_)/i.test(key) && rowYear != null) {
          addCoverage(rowYear, val);
        }
        const yearSuffix = key.match(/(?:covered_)?months_(\d{4})/i);
        if (yearSuffix) addCoverage(yearSuffix[1], val);
      }
    }
  }

  return coverageByYear;
}

function detectGrowthEndpointYears(toolCalls = [], brief = {}) {
  const years = new Set();
  const briefText = [
    brief?.headline || '',
    brief?.executive_summary || '',
    brief?.summary || '',
    ...(Array.isArray(brief?.key_findings) ? brief.key_findings : []),
    ...(brief?.methodology_note ? [brief.methodology_note] : []),
  ].join(' ');

  for (const match of briefText.matchAll(/\b(?:19|20)\d{2}\b/g)) {
    years.add(Number(match[0]));
  }

  for (const tc of (Array.isArray(toolCalls) ? toolCalls : [])) {
    if (tc?.name !== 'query_sap_data' || tc?.result?.success === false) continue;
    const rows = getStructuredRows(tc);
    for (const row of rows) {
      if (!isPlainObject(row)) continue;
      for (const key of Object.keys(row)) {
        if (!/growth|cagr|avg_monthly|revenue|months|covered_months/i.test(key)) continue;
        for (const match of key.matchAll(/(?:19|20)\d{2}/g)) {
          years.add(Number(match[0]));
        }
      }
    }
  }

  return [...years].filter((year) => Number.isInteger(year)).sort((a, b) => a - b);
}

function detectInvalidGrowthBaseCoverage(toolCalls = [], brief) {
  const issues = [];
  const briefText = [
    brief?.headline || '',
    brief?.executive_summary || '',
    brief?.summary || '',
    ...(Array.isArray(brief?.key_findings) ? brief.key_findings : []),
    ...(Array.isArray(brief?.metric_pills) ? brief.metric_pills.map((pill) => `${pill?.label || ''} ${pill?.value || ''}`) : []),
    brief?.methodology_note || '',
  ].join(' ');

  const mentionsGrowth = /cagr|growth|rate|成長率|增长率|增長率/i.test(briefText);
  const mentionsNormalizedGrowth = /normalized|標準化|avg monthly|monthly average|per-month|月均|每月/i.test(briefText) && mentionsGrowth;
  if (!mentionsGrowth) return issues;

  const coverageByYear = buildYearCoverageProfile(toolCalls);
  if (coverageByYear.size === 0) return issues;

  const endpointYears = detectGrowthEndpointYears(toolCalls, brief);
  if (endpointYears.length < 2) return issues;
  const baseYear = endpointYears[0];
  const baseCoverages = coverageByYear.get(baseYear) || [];
  if (baseCoverages.length === 0) return issues;

  const minBaseCoverage = Math.min(...baseCoverages);
  if (minBaseCoverage >= 6) return issues;

  const methodLabel = mentionsNormalizedGrowth ? 'normalized growth' : 'growth comparison';
  issues.push(
    `The brief uses ${methodLabel} with base period ${baseYear}, but the base period has only ${minBaseCoverage} month(s) of coverage. Below 6 months, even per-month normalization is not reliable. Use comparable full-coverage periods or aligned same-period comparisons instead.`
  );
  return issues;
}

/**
 * Fact-check: verify that metric_pill values can be traced to tool call evidence.
 * Returns an array of failure descriptions for pills with no matching evidence.
 */
function verifyMetricPillsAgainstEvidence(brief, toolCalls = []) {
  const pills = Array.isArray(brief?.metric_pills) ? brief.metric_pills : [];
  if (pills.length === 0) return [];

  const evidenceNumbers = collectEvidenceNumbers(toolCalls);
  if (evidenceNumbers.size === 0) return [];

  const failures = [];
  for (const pill of pills) {
    const rawVal = String(pill?.value || '');
    // Extract the numeric part from formatted pill value (e.g., "R$210,000" → 210000, "R$4.53M" → 4530000)
    const pillNum = parseNumericValue(rawVal);
    if (pillNum == null || pillNum === 0) continue;

    const matched = hasEvidenceNumberMatch(rawVal, pillNum, evidenceNumbers, 0.05);
    if (!matched) {
      failures.push(`Metric pill "${pill.label}: ${rawVal}" has no matching value (±5%) in tool call evidence`);
    }
  }
  return failures;
}

/**
 * Detect contradictory claims: the SAME specific metric cited with different values
 * in different sections of the brief.
 *
 * Design principle: a "contradiction" requires that BOTH facts refer to the SAME
 * entity + time + scope. Different rows in a table, different pills for different
 * entities, and different narrative sentences about different subjects are NOT
 * contradictions — they are the whole point of comparative analysis.
 *
 * True contradictions only occur across source boundaries:
 *   - pill says "SP Revenue: 5.2M" but narrative says "SP revenue was 4.8M"
 *   - headline says "overall CAGR 20%" but finding says "overall CAGR 15%"
 *
 * NOT contradictions:
 *   - table row 1 (SP) = 5.2M vs table row 2 (RJ) = 1.8M (different entities)
 *   - pill "SP CAGR: 570%" vs pill "RJ CAGR: 217%" (different entities)
 *   - narrative "2016 revenue 50K" vs "2018 revenue 7.4M" (different time periods)
 */
function collectContradictoryClaims({ brief, toolCalls = [] }) {
  const facts = collectEvidenceMetricFacts({ brief, toolCalls });

  const groupedFacts = facts.reduce((acc, fact) => {
    if (!fact.metricKey) return acc;
    acc[fact.metricKey] = acc[fact.metricKey] || [];
    acc[fact.metricKey].push(fact);
    return acc;
  }, {});

  // Source category helpers
  const sourceCategory = (s) => {
    if (/brief_metric_pills/i.test(s)) return 'pills';
    if (/brief_table|artifact_table/i.test(s)) return 'tables';
    if (/brief_text/i.test(s)) return 'narrative';
    if (/artifact/i.test(s)) return 'artifact';
    return 'other';
  };

  const labelPart = (s) => String(s || '').replace(/[:=].*$/, '').toLowerCase().replace(/[\d,.%$R\s]+/g, '').trim();

  return Object.entries(groupedFacts).flatMap(([metricKey, metricFacts]) => {
    if (metricFacts.length < 2) return [];

    const conflicts = [];
    for (let i = 0; i < metricFacts.length; i++) {
      for (let j = i + 1; j < metricFacts.length; j++) {
        const a = metricFacts[i];
        const b = metricFacts[j];
        if (!areNumbersMeaningfullyDifferent(a.value, b.value)) continue;

        // If both facts carry explicit entity/time/scope context and that context differs,
        // they are parallel observations rather than contradictory claims.
        if (a.contextKey && b.contextKey && a.contextKey !== b.contextKey) continue;

        const catA = sourceCategory(a.source);
        const catB = sourceCategory(b.source);

        // ── Rule 1: NEVER flag within-table comparisons ──
        // Tables inherently have multiple rows with different values per entity/period.
        if (catA === 'tables' || catB === 'tables') continue;

        // ── Rule 2: NEVER flag within-pills comparisons ──
        // Pills for different entities (SP vs RJ) share the same metric key but are not contradictions.
        if (catA === 'pills' && catB === 'pills') continue;

        // ── Rule 3: Skip when unit types differ ──
        if (a.unitType && b.unitType && a.unitType !== b.unitType) continue;

        // ── Rule 3b: Skip when values differ by more than 5x in magnitude ──
        // If "mean" A = 4.53M (annual) and "mean" B = 543K (monthly), they are
        // clearly different metrics sharing the same alias, not a contradiction.
        // Real contradictions have similar magnitudes (e.g., 5.2M vs 4.8M).
        const magRatio = Math.max(Math.abs(a.value), 1) / Math.max(Math.abs(b.value), 1);
        if (magRatio > 5 || magRatio < 0.2) continue;

        // ── Rule 4: Only flag cross-source contradictions ──
        // A real contradiction: pill says X but narrative says Y for the SAME specific metric.
        // Require that the descriptive labels are very similar (>= 80% token overlap).
        const descA = labelPart(a.raw);
        const descB = labelPart(b.raw);
        if (descA && descB) {
          const similarity = textSimilarity(descA, descB);
          // Require high similarity (80%+) to flag as contradiction.
          // This filters out "SP revenue" vs "RJ revenue" (low overlap due to entity qualifier).
          if (similarity < 0.8) continue;
        }

        conflicts.push({ a, b });
      }
    }
    if (conflicts.length === 0) return [];

    const first = conflicts[0];
    const detail = [first.a, first.b].map((fact) => `${formatValue(fact.value)} (${fact.source})`);
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

// Chinese dimension labels → English synonym tokens for cross-language dimension matching
const DIMENSION_SYNONYM_MAP = Object.freeze({
  '年度趨勢': ['trend', 'annual', 'yearly'],
  '年均成長率': ['cagr', 'growth', 'annual', 'rate'],
  '整體平均': ['overall', 'average', 'mean'],
  '前三地區': ['top', 'region', 'ranking'],
  '地區營收': ['region', 'revenue'],
  '營收趨勢': ['revenue', 'trend'],
  '成長趨勢': ['growth', 'trend'],
  '客戶分布': ['customer', 'distribution'],
  '品類佔比': ['category', 'share', 'composition'],
  '利潤率趨勢': ['profit', 'margin', 'trend'],
  '月度趨勢': ['monthly', 'trend'],
  '季度趨勢': ['quarterly', 'trend'],
  '同期比較': ['yoy', 'comparison', 'period'],
  '供應商表現': ['supplier', 'performance'],
  '庫存水位': ['inventory', 'level', 'stock'],
  '訂單趨勢': ['order', 'trend'],
  '前三': ['top', 'ranking'],
  '年均': ['annual', 'average', 'cagr'],
  '趨勢': ['trend'],
  '排名': ['ranking', 'top'],
  '成長率': ['growth', 'rate', 'cagr'],
  '佔比': ['share', 'composition', 'ratio'],
  '分布': ['distribution'],
  '平均': ['average', 'mean'],
});

function hasCoveredDimension({ dimension, briefText, structuredCoverage }) {
  const normalized = String(dimension || '').trim().toLowerCase();
  if (!normalized) return true;

  const coveredDimensions = new Set(
    (structuredCoverage?.coveredDimensions || []).map((item) => String(item || '').toLowerCase())
  );
  const normalizedAlias = detectDimensionFromText(normalized);
  const aliasEntry = DIMENSION_PATTERNS.find((entry) => entry.label === normalizedAlias || entry.label === normalized);

  // 1. Exact match in structured coverage
  if (coveredDimensions.has(normalized)) return true;
  if (normalizedAlias && coveredDimensions.has(normalizedAlias)) return true;
  if (aliasEntry && aliasEntry.patterns.some((pattern) => pattern.test(briefText))) return true;

  // 2. Composite dimension: split "revenue trend" into tokens,
  //    check if ALL tokens are individually covered or appear as substring in a covered dimension
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length > 1) {
    const allTokensCovered = tokens.every((token) => {
      if (coveredDimensions.has(token)) return true;
      for (const covered of coveredDimensions) {
        if (covered.includes(token)) return true;
      }
      return briefText.includes(token);
    });
    if (allTokensCovered) return true;
  }

  // 3. Check if any covered dimension contains the full normalized string or vice versa
  for (const covered of coveredDimensions) {
    if (covered.includes(normalized) || normalized.includes(covered)) return true;
    if (normalizedAlias && (covered.includes(normalizedAlias) || normalizedAlias.includes(covered))) return true;
  }

  // 4. Special handling for quantiles/percentiles
  if (normalized === 'quantiles' || normalized === 'percentiles') {
    return (structuredCoverage?.foundPercentiles || []).length > 0
      || /\bquantiles?\b|\bpercentiles?\b|分位數|百分位/.test(briefText);
  }

  // 5. Chinese synonym expansion: map Chinese dimension labels to English tokens
  //    and check if those tokens appear in briefText or coveredDimensions
  const synonymTokens = DIMENSION_SYNONYM_MAP[normalized];
  if (synonymTokens) {
    const allSynonymsCovered = synonymTokens.every((syn) => {
      if (coveredDimensions.has(syn)) return true;
      for (const covered of coveredDimensions) {
        if (covered.includes(syn)) return true;
      }
      return new RegExp(`\\b${syn}s?\\b`, 'i').test(briefText);
    });
    if (allSynonymsCovered) return true;
  }
  // Also try partial synonym matches: if any key in the map is a substring of the dimension
  for (const [zhKey, enTokens] of Object.entries(DIMENSION_SYNONYM_MAP)) {
    if (zhKey !== normalized && normalized.includes(zhKey)) {
      const partialMatch = enTokens.every((syn) => {
        for (const covered of coveredDimensions) {
          if (covered.includes(syn)) return true;
        }
        return new RegExp(`\\b${syn}s?\\b`, 'i').test(briefText);
      });
      if (partialMatch) return true;
    }
  }

  // 6. Fuzzy text search: match with plurals and word-boundary variants
  const fuzzyPattern = new RegExp(
    tokens.map(t => t.replace(/s$/, '') + 's?').join('\\b.*\\b'),
    'i'
  );
  if (fuzzyPattern.test(briefText)) return true;

  // 7. Original fallback: exact substring
  return briefText.includes(normalized);
}

function extractTrendClaims(text) {
  const claims = [];
  const patterns = [
    { regex: /(\w+(?:\s+\w+)?)\s+(?:grew|increased|rose|surged|jumped|成長|增長|上升)/gi, direction: 'up' },
    { regex: /(\w+(?:\s+\w+)?)\s+(?:declined|decreased|dropped|fell|shrank|下降|減少|衰退)/gi, direction: 'down' },
  ];
  for (const { regex, direction } of patterns) {
    let match;
    while ((match = regex.exec(text)) !== null) {
      claims.push({ metric: match[1].trim(), direction });
    }
  }
  return claims;
}

function extractTrendFromToolCalls(toolCalls = []) {
  const trends = [];
  for (const tc of toolCalls) {
    if (tc?.name !== 'query_sap_data' || !tc?.result?.success) continue;
    const rows = tc?.result?.rows || [];
    if (rows.length < 2) continue;
    const numericKeys = Object.keys(rows[0] || {}).filter(k => typeof rows[0][k] === 'number');
    for (const key of numericKeys) {
      const firstVal = rows[0][key];
      const lastVal = rows[rows.length - 1][key];
      if (firstVal != null && lastVal != null && firstVal !== 0) {
        trends.push({
          metric: key,
          direction: lastVal > firstVal ? 'up' : 'down',
          startValue: firstVal,
          endValue: lastVal,
          isDefault: numericKeys.indexOf(key) === 0,
        });
      }
    }
  }
  return trends;
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
  const softBlockers = []; // Cosmetic/stylistic issues — don't trigger LLM repair
  const heuristicFindings = [];
  const issues = [];
  const repairInstructions = [];
  const dimensionScores = buildDefaultQaDimensionScores();
  const qaFlags = {}; // Accumulates flags during QA checks
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
    heuristicFindings.push(issue, ...magnitudeMismatches.slice(1));
    issues.push(issue, ...magnitudeMismatches.slice(1));
    repairInstructions.push(
      'Re-check aggregation grain and unit labeling for numeric claims. Only compare narrative values with the matching evidence metric, not unrelated columns.'
    );
    dimensionScores.correctness = Math.max(0, dimensionScores.correctness - 1.5);
    dimensionScores.evidence_alignment = Math.max(0, dimensionScores.evidence_alignment - 1.5);
    qaFlags.heuristic_magnitude_mismatch = true;
  }

  // ── Extreme growth rate: flag CAGR > 500% without low-base caveat ──
  const extremeGrowthIssues = detectExtremeGrowthRates(toolCalls, brief);
  if (extremeGrowthIssues.length > 0) {
    heuristicFindings.push(...extremeGrowthIssues);
    issues.push(...extremeGrowthIssues);
    repairInstructions.push('Add a caveat noting that extreme growth rates (>500%) are likely driven by very low base-period values and should not be used for forecasting.');
    dimensionScores.caveat_quality = Math.max(0, dimensionScores.caveat_quality - 3);
    qaFlags.missing_low_base_caveat = true;
  }

  // ── Coverage-aware growth validity: normalized / CAGR-style growth with insufficient base period ──
  const invalidGrowthBaseIssues = detectInvalidGrowthBaseCoverage(toolCalls, brief);
  if (invalidGrowthBaseIssues.length > 0) {
    blockers.push(...invalidGrowthBaseIssues);
    issues.push(...invalidGrowthBaseIssues);
    repairInstructions.push('Replace the current growth metric with a comparable full-coverage or aligned same-period comparison. Do not use normalized growth when the base period has fewer than 6 months of coverage.');
    dimensionScores.correctness = Math.max(0, dimensionScores.correctness - 6);
    dimensionScores.methodology_transparency = Math.max(0, dimensionScores.methodology_transparency - 3);
    dimensionScores.caveat_quality = Math.max(0, dimensionScores.caveat_quality - 2);
  }

  // ── Partial-year CAGR: flag CAGR computed across years with unequal coverage ──
  const partialYearIssues = detectPartialYearCagr(toolCalls, brief);
  if (partialYearIssues.length > 0) {
    heuristicFindings.push(...partialYearIssues);
    issues.push(...partialYearIssues);
    repairInstructions.push('Add a caveat stating which years have partial data coverage and how many months each contains. Prefer comparable full-coverage periods; use per-month normalization only when the base period has at least 6 months of coverage.');
    dimensionScores.caveat_quality = Math.max(0, dimensionScores.caveat_quality - 4);
    dimensionScores.correctness = Math.max(0, dimensionScores.correctness - 2);
    qaFlags.missing_partial_year_caveat = true;
  }

  // ── Scope consistency: detect mixed data scopes ──
  const scopeMismatch = detectScopeMismatch({ brief, toolCalls });
  if (scopeMismatch) {
    const issue = `Scope inconsistency: ${scopeMismatch}`;
    issues.push(issue);
    repairInstructions.push('Ensure all numbers come from the same data scope. If mixing scopes, explicitly label each set of numbers.');
    dimensionScores.correctness = Math.max(0, dimensionScores.correctness - 3);
    dimensionScores.evidence_alignment = Math.max(0, dimensionScores.evidence_alignment - 2);
  }

  // ── Derived value consistency: check if averages match totals/counts ──
  const derivedIssues = checkDerivedValueConsistency({ brief });
  for (const issue of derivedIssues) {
    issues.push(issue);
    repairInstructions.push('Verify and correct the derived value calculation.');
    dimensionScores.correctness = Math.max(0, dimensionScores.correctness - 2);
  }

  // ── Trend direction consistency: brief claims "growth/increase" but data shows decline ──
  const trendClaims = extractTrendClaims(combinedNarrativeText);
  const sqlTrendData = extractTrendFromToolCalls(toolCalls);
  if (trendClaims.length > 0 && sqlTrendData.length > 0) {
    for (const claim of trendClaims) {
      const matchingData = sqlTrendData.find(d => d.metric === claim.metric || d.isDefault);
      if (matchingData && claim.direction !== matchingData.direction) {
        const issue = `Trend mismatch: brief claims "${claim.metric} ${claim.direction}" but data shows ${matchingData.direction} (${matchingData.startValue} → ${matchingData.endValue})`;
        blockers.push(issue);
        issues.push(issue);
        repairInstructions.push(`Correct the trend direction for ${claim.metric} to match the data: ${matchingData.direction}.`);
        dimensionScores.correctness = Math.max(0, dimensionScores.correctness - 5);
      }
    }
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
    heuristicFindings.push('Pseudo-table formatting leaked into the brief.');
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
    softBlockers.push(issue);
    heuristicFindings.push(issue);
    issues.push(issue);
    repairInstructions.push('Remove repeated sentences and keep each section additive.');
    dimensionScores.clarity = Math.max(0, dimensionScores.clarity - 4);
  }

  // ── Content redundancy: pill values repeated verbatim in narrative ──
  const pillValues = (brief?.metric_pills || [])
    .map((p) => String(p?.value || '').trim())
    .filter((v) => v.length > 3);
  if (pillValues.length > 0) {
    const summaryText = String(brief?.summary || '');
    const findingsText = (brief?.key_findings || []).join(' ');
    const pillsInSummary = pillValues.filter((v) => summaryText.includes(v)).length;
    const pillsInFindings = pillValues.filter((v) => findingsText.includes(v)).length;

    // Dynamic threshold: analysis mode with many pills allows more restatement
    const isAnalysis = answerContract?.brevity === 'analysis';
    const pillBlockerThreshold = isAnalysis
      ? Math.max(4, Math.ceil(pillValues.length * 0.6))
      : 3;

    if (pillsInSummary >= pillBlockerThreshold) {
      const issue = `Summary restates ${pillsInSummary} of ${pillValues.length} metric pill values verbatim — must interpret, not restate.`;
      blockers.push(issue);
      issues.push(issue);
      repairInstructions.push('Rewrite summary to interpret metric pills contextually (e.g., "the high Gini coefficient suggests severe inequality") instead of restating exact values. Each pill value should appear in at most one narrative reference.');
      dimensionScores.information_density = Math.max(0, dimensionScores.information_density - 5);
    } else if (pillsInSummary >= 3) {
      // Below blocker threshold but still notable — soft issue, not a blocker
      const issue = `Summary restates ${pillsInSummary} of ${pillValues.length} metric pill values — consider more interpretive phrasing.`;
      heuristicFindings.push(issue);
      issues.push(issue);
      dimensionScores.information_density = Math.max(0, dimensionScores.information_density - 2);
    }
    if (pillsInFindings >= pillBlockerThreshold) {
      const issue = `Key findings restate ${pillsInFindings} of ${pillValues.length} metric pill values — findings must add new analysis.`;
      blockers.push(issue);
      issues.push(issue);
      repairInstructions.push('Replace restated values in key_findings with derived insights (e.g., instead of "Gini is 0.792", write "the bottom 50% of sellers collectively earn less than the top 10 sellers individually").');
      dimensionScores.information_density = Math.max(0, dimensionScores.information_density - 5);
    } else if (pillsInFindings >= 3) {
      const issue = `Key findings restate ${pillsInFindings} of ${pillValues.length} metric pill values — consider deriving more insights.`;
      heuristicFindings.push(issue);
      issues.push(issue);
      dimensionScores.information_density = Math.max(0, dimensionScores.information_density - 2);
    }

    // Check for values appearing in 3+ sections (headline, summary, findings, pills)
    const headlineText = String(brief?.headline || '');
    const tripleRepeat = pillValues.filter((v) => {
      let count = 0;
      if (headlineText.includes(v)) count++;
      if (summaryText.includes(v)) count++;
      if (findingsText.includes(v)) count++;
      count++; // pill itself
      return count >= 3;
    }).length;
    if (tripleRepeat > 0) {
      const issue = `${tripleRepeat} metric value(s) appear in 3+ sections (pills + headline/summary/findings).`;
      heuristicFindings.push(issue);
      issues.push(issue);
      repairInstructions.push('Each numeric value should appear in metric pills and at most one narrative reference with interpretation.');
      dimensionScores.information_density = Math.max(0, dimensionScores.information_density - Math.min(6, tripleRepeat * 2));
    }
  }

  // ── Pill-vs-narrative unit consistency (ratio↔percentage confusion) ──
  const pillNarrativeIssues = detectPillNarrativeInconsistency(brief);
  if (pillNarrativeIssues.length > 0) {
    blockers.push(...pillNarrativeIssues);
    issues.push(...pillNarrativeIssues);
    repairInstructions.push('Ensure metric pill values and narrative citations use the same unit for the same metric. If the pill shows a percentage, the narrative must also use percentage form.');
    dimensionScores.correctness = Math.max(0, dimensionScores.correctness - 5);
    qaFlags.pill_narrative_inconsistency = true;
  }

  // ── Findings–summary overlap: check n-gram overlap ──
  if (brief?.summary && brief?.key_findings?.length > 0) {
    const summaryTokens = tokenizeWords(brief.summary);
    const findingsTokens = tokenizeWords(brief.key_findings.join(' '));
    if (summaryTokens.length >= 8 && findingsTokens.length >= 8) {
      const overlap = textSimilarity(brief.summary, brief.key_findings.join(' '));
      if (overlap >= 0.5) {
        heuristicFindings.push('Key findings share >50% content with summary — findings should provide additional analysis.');
        issues.push('Key findings share >50% content with summary — findings should provide additional analysis.');
        repairInstructions.push('Differentiate key_findings from summary: findings should explain WHY, not restate WHAT.');
        dimensionScores.information_density = Math.max(0, dimensionScores.information_density - 4);
      }
    }
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

  const briefChartTypes = Array.isArray(brief?.charts)
    ? brief.charts
      .map((chart) => String(chart?.type || '').toLowerCase())
      .filter(Boolean)
    : [];
  const availableChartTypes = [...new Set([...chartTypes, ...briefChartTypes])];
  if (wantsChart && availableChartTypes.length === 0) {
    const issue = 'The request asked for a chart, but no structured chart artifact is present.';
    blockers.push(issue);
    issues.push(issue);
    repairInstructions.push('Ensure the answer includes or references a chart artifact that matches the request.');
    dimensionScores.visualization_fit = Math.max(0, dimensionScores.visualization_fit - 6);
  }
  const CHART_COMPAT = { histogram: ['bar', 'histogram'], bar: ['bar', 'histogram'] };
  const isChartCompat = availableChartTypes.some((t) => (CHART_COMPAT[requestedSpecialChart] || []).includes(t));
  if (requestedSpecialChart && availableChartTypes.length > 0 && !availableChartTypes.includes(requestedSpecialChart) && !isChartCompat) {
    const issue = `Requested ${requestedSpecialChart} but the artifact uses ${availableChartTypes.join(', ')}.`;
    blockers.push(issue);
    issues.push(issue);
    repairInstructions.push(`Align the chart type with the requested ${requestedSpecialChart}.`);
    dimensionScores.visualization_fit = Math.max(0, dimensionScores.visualization_fit - 6);
  }

  // ── Chart data passthrough: tool calls produced charts but brief has none ──
  const toolCallsHaveChartData = (Array.isArray(toolCalls) ? toolCalls : []).some((tc) => {
    const payloads = extractAnalysisPayloadsFromToolCall(tc);
    return payloads.some((p) => Array.isArray(p?.charts) && p.charts.some((c) => Array.isArray(c?.data) && c.data.length > 0));
  });
  const briefHasChartData = Array.isArray(brief?.charts) && brief.charts.some((c) => Array.isArray(c?.data) && c.data.length > 0);
  if (toolCallsHaveChartData && !briefHasChartData) {
    const issue = 'Tool calls produced charts with data but the brief contains no renderable charts — chart data was lost in synthesis.';
    blockers.push(issue);
    issues.push(issue);
    repairInstructions.push('Include the chart data from tool results in the brief charts array.');
    dimensionScores.visualization_fit = Math.max(0, dimensionScores.visualization_fit - 8);
    if (wantsChart) {
      dimensionScores.completeness = Math.max(0, dimensionScores.completeness - 3);
      dimensionScores.evidence_alignment = Math.max(0, dimensionScores.evidence_alignment - 2);
    }
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

  // Note: generate_chart recipes compute from raw dataset at query time — they are NOT pre-cached.
  // We no longer penalise chart-only evidence as "pre-computed" since it is deterministic and authoritative.

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

  // ── Caveat contradiction: caveats that question generate_chart results ──
  const chartToolSucceeded = (Array.isArray(toolCalls) ? toolCalls : []).some(
    (tc) => tc?.name === 'generate_chart' && tc?.success !== false
      && (tc?.result?.success !== false),
  );
  if (chartToolSucceeded) {
    const suspiciousCaveats = (brief?.caveats || []).filter((c) =>
      /pre-computed|conceptual|narrative.based|chart metrics|zero rows.*chart|not.*live.*sql|pre-cached/i.test(String(c || '')),
    );
    if (suspiciousCaveats.length > 0) {
      const issue = 'Caveat contradicts tool evidence: a successful generate_chart recipe is authoritative, not "conceptual" or "pre-computed".';
      blockers.push(issue);
      issues.push(issue);
      repairInstructions.push('Remove caveats that question the reliability of successfully executed chart recipes. Recipe outputs are computed from raw data at query time.');
      dimensionScores.caveat_quality = Math.max(0, dimensionScores.caveat_quality - 5);
    }
  }

  // ── Fact-check: verify metric_pill values exist in tool call evidence ──
  const pillFactCheckFailures = verifyMetricPillsAgainstEvidence(brief, toolCalls);
  if (pillFactCheckFailures.length > 0) {
    for (const failure of pillFactCheckFailures.slice(0, 3)) {
      issues.push(failure);
    }
    if (pillFactCheckFailures.length >= 2) {
      blockers.push(`${pillFactCheckFailures.length} metric pill(s) have no matching evidence in tool results`);
    }
    repairInstructions.push('Remove or correct metric pills whose values cannot be traced to any tool call result.');
    dimensionScores.correctness = Math.max(0, dimensionScores.correctness - Math.min(5, pillFactCheckFailures.length * 2));
    dimensionScores.evidence_alignment = Math.max(0, dimensionScores.evidence_alignment - Math.min(4, pillFactCheckFailures.length * 1.5));
    qaFlags.unmatched_pills = true;
  }

  // ── Fact-check: verify chart data completeness ──
  const briefCharts = Array.isArray(brief?.charts) ? brief.charts : [];
  const emptyCharts = briefCharts.filter(c => !Array.isArray(c.data) || c.data.length === 0);
  if (emptyCharts.length > 0 && briefCharts.length > 0) {
    const issue = `${emptyCharts.length} of ${briefCharts.length} chart(s) have empty data arrays — charts will render blank.`;
    blockers.push(issue);
    issues.push(issue);
    repairInstructions.push('Remove charts with empty data arrays or populate them from tool call results.');
    dimensionScores.visualization_fit = Math.max(0, dimensionScores.visualization_fit - emptyCharts.length * 3);
  }

  const score = scoreFromDimensionScores(dimensionScores);

  return {
    score,
    blockers: uniqueStrings(blockers),
    soft_blockers: uniqueStrings(softBlockers),
    hard_findings: uniqueStrings(blockers),
    heuristic_findings: uniqueStrings(heuristicFindings),
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
      ...qaFlags,
    },
    trace,
  };
}

function normalizeQaReviewResult(review) {
  const dimensionScores = buildDefaultQaDimensionScores();
  const imputedDimensions = [];
  // First pass: collect present scores
  const presentScores = [];
  for (const key of QA_DIMENSION_KEYS) {
    const raw = review?.dimension_scores?.[key];
    if (raw != null) {
      dimensionScores[key] = roundScore(raw);
      presentScores.push(dimensionScores[key]);
    }
  }
  // Impute missing dimensions using weighted avg of present scores × 0.8 (penalized estimate).
  // Weight by QA_DIMENSION_WEIGHTS so high-weight dimensions influence imputation more.
  let weightedSum = 0;
  let weightTotal = 0;
  for (const key of QA_DIMENSION_KEYS) {
    if (review?.dimension_scores?.[key] != null) {
      const w = QA_DIMENSION_WEIGHTS[key] || 0;
      weightedSum += dimensionScores[key] * w;
      weightTotal += w;
    }
  }
  const fallbackValue = weightTotal > 0
    ? roundScore((weightedSum / weightTotal) * 0.8)
    : 5.0;
  for (const key of QA_DIMENSION_KEYS) {
    if (dimensionScores[key] == null || review?.dimension_scores?.[key] == null) {
      dimensionScores[key] = fallbackValue;
      imputedDimensions.push(key);
    }
  }
  if (imputedDimensions.length > 0) {
    console.warn(`[validateAgentQaReview] imputed missing dimension_scores to ${fallbackValue}: ${imputedDimensions.join(', ')}`);
  }

  return {
    score: roundScore(review?.score),
    blockers: uniqueStrings(review?.blockers || []),
    issues: uniqueStrings(review?.issues || []),
    repair_instructions: uniqueStrings(review?.repair_instructions || []),
    dimension_scores: dimensionScores,
    _imputedDimensions: imputedDimensions.length > 0 ? imputedDimensions : undefined,
  };
}

function mergeQaResults({ deterministicQa, selfReview = null, crossReview = null, repairAttempted = false }) {
  const dimensionScores = buildDefaultQaDimensionScores();
  const heuristicOnlyDeterministic = (deterministicQa?.blockers || []).length === 0
    && (deterministicQa?.heuristic_findings || []).length > 0;

  // Dimension-level cap: LLM reviewers cannot drag any dimension more than
  // CAP_DELTA below the deterministic baseline. This prevents a single harsh
  // reviewer from collapsing scores (e.g. visualization_fit=0 when det=10).
  const CAP_DELTA = 3;

  for (const key of QA_DIMENSION_KEYS) {
    const deterministicVal = deterministicQa?.dimension_scores?.[key];
    const reviewerVals = [
      selfReview?.qa?.dimension_scores?.[key],
      crossReview?.qa?.dimension_scores?.[key],
    ].filter((value) => typeof value === 'number');

    if (typeof deterministicVal === 'number') {
      const floor = Math.max(0, deterministicVal - CAP_DELTA);
      const cappedReviewerVals = reviewerVals.map(v => Math.max(v, floor));
      const allVals = [deterministicVal, ...cappedReviewerVals];
      dimensionScores[key] = roundScore(Math.min(...allVals));
    } else if (reviewerVals.length > 0) {
      dimensionScores[key] = roundScore(Math.min(...reviewerVals));
    }
    // else: keep default 10
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

  // Relax cap when deterministic has unconfirmed missing-dimension blockers:
  // if det flagged "missing required dimensions" but LLM reviewer didn't, the det blocker
  // may be a false positive (e.g., Chinese label not matched). Allow LLM score more influence.
  const detMissingDimBlocker = (deterministicQa?.blockers || []).some(b => /missing required dimensions/i.test(b));
  const reviewerFlaggedMissing = [selfReview, crossReview].some(r =>
    (r?.qa?.blockers || r?.qa?.issues || []).some(b => /missing.*dimension|incomplete|未涵蓋/i.test(b))
  );
  const capDelta = (detMissingDimBlocker && !reviewerFlaggedMissing) ? 1 : 2;
  const effectiveDeterministicScore = heuristicOnlyDeterministic && reviewerScores.length > 0
    ? Math.max(deterministicScore, minReviewer)
    : deterministicScore;
  const effectiveDimensionScore = heuristicOnlyDeterministic && reviewerScores.length > 0
    ? Math.max(dimensionScore, minReviewer)
    : dimensionScore;

  const score = roundScore(Math.min(
    effectiveDeterministicScore,
    effectiveDimensionScore,
    Math.max(minReviewer, effectiveDeterministicScore - capDelta),
  ));

  const blockers = uniqueStrings([
    ...(deterministicQa?.blockers || []),
    ...(selfReview?.qa?.blockers || []),
    ...(crossReview?.qa?.blockers || []),
  ]);
  const softBlockerSet = new Set(uniqueStrings(deterministicQa?.soft_blockers || []));
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

  // Hard blockers = blockers minus soft blockers (for repair trigger decisions)
  const hardBlockers = blockers.filter(b => !softBlockerSet.has(b));

  return {
    status: blockers.length === 0 && score >= QA_PASS_THRESHOLD ? 'pass' : 'warning',
    score,
    pass_threshold: QA_PASS_THRESHOLD,
    blockers,
    soft_blockers: [...softBlockerSet],
    hard_blockers: hardBlockers,
    issues,
    repair_instructions: repairInstructions,
    dimension_scores: dimensionScores,
    reviewers,
    repair_attempted: repairAttempted,
    escalated: Boolean(crossReview?.qa),
    heuristic_only_deterministic: heuristicOnlyDeterministic,
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
        finalAnswerText: clamp(stripThinkingTags(finalAnswerText), 2500),
        mode,
        repairInstructions,
      },
      temperature: 0.1,
      maxOutputTokens: 4096,
    });
    const brief = normalizeBriefForQa(result?.parsed, fallbackBrief, { brevity: answerContract?.brevity, toolCalls });
    autoInjectMissingCaveats(brief, toolCalls);
    return brief;
  } catch (error) {
    console.warn('[agentResponsePresentation] Brief synthesis fallback:', error?.message);
    return fallbackBrief;
  }
}

/**
 * Auto-inject caveats when failed tool calls exist but caveats array is empty.
 * Mutates the brief in place.
 */
function autoInjectMissingCaveats(brief, toolCalls = []) {
  if (!isPlainObject(brief)) return;
  const caveats = Array.isArray(brief.caveats) ? brief.caveats : [];
  const failedTools = (Array.isArray(toolCalls) ? toolCalls : []).filter(
    (tc) => tc?.result && !tc.result.success
  );
  if (failedTools.length > 0 && caveats.length === 0) {
    const failedNames = uniqueStrings(failedTools.map((tc) => tc?.name || 'unknown')).join(', ');
    brief.caveats = [
      `Analysis used alternative methods due to sandbox or execution limitations (${failedNames} failed). Results may be less precise than originally intended.`,
    ];
  }
}

export function summarizeToolCallsForPrompt(toolCalls = []) {
  return (Array.isArray(toolCalls) ? toolCalls : []).map((toolCall) => {
    const rows = getStructuredRows(toolCall).slice(0, 15);
    const analysisPayloads = extractAnalysisPayloadsFromToolCall(toolCall)
      .slice(0, 4)
      .map((payload) => ({
        title: payload?.title,
        analysisType: payload?.analysisType,
        summary: payload?.summary || '',
        highlights: Array.isArray(payload?.highlights) ? payload.highlights.slice(0, 8) : [],
        chartTypes: Array.isArray(payload?.charts) ? payload.charts.map((chart) => chart?.type).filter(Boolean) : [],
        tableTitles: Array.isArray(payload?.tables) ? payload.tables.map((table) => table?.title).filter(Boolean) : [],
        referenceLineLabels: Array.isArray(payload?.charts)
          ? payload.charts.flatMap((chart) => Array.isArray(chart?.referenceLines) ? chart.referenceLines.map((line) => line?.label).filter(Boolean) : [])
          : [],
        metrics: isPlainObject(payload?.metrics)
          ? Object.entries(payload.metrics).slice(0, 16).map(([label, value]) => ({ label, value }))
          : [],
        referenceLineValues: Array.isArray(payload?.charts)
          ? payload.charts.flatMap((chart) =>
            (Array.isArray(chart?.referenceLines) ? chart.referenceLines : [])
              .map((line) => ({ label: line?.label, value: line?.value }))
              .filter((entry) => entry.label))
          : [],
        tableData: Array.isArray(payload?.tables)
          ? payload.tables.slice(0, 3).map((table) => ({
            title: table?.title,
            columns: table?.columns,
            rows: (table?.rows || []).slice(0, 20).map(formatTimestampValues),
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
      sampleRows: rows.map(formatTimestampValues).map(cleanFloatsInRow),
      columnMeta: inferColumnMeta(rows, toolCall),
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
        finalAnswerText: clamp(stripThinkingTags(finalAnswerText), 3000),
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
        provider: providerOverride || getCrossModelReviewConfig().provider,
        model: modelOverride || getCrossModelReviewConfig().model,
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

export async function repairBrief({
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
  const { provider: reviewProvider, model: reviewModel } = getCrossModelReviewConfig();
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
        finalAnswerText: clamp(stripThinkingTags(finalAnswerText), 3000),
        deterministicQa,
        qaScorecard,
        artifactSummary,
        mode,
      },
      temperature: 0.1,
      maxOutputTokens: 2000,
      timeout: /deepseek/i.test(reviewProvider || '') ? 60000 : 35000,
      providerOverride: reviewProvider,
      modelOverride: reviewModel,
    });
    return normalizeBriefForQa(result?.parsed, fallbackBrief, { brevity: answerContract?.brevity, toolCalls });
  } catch (error) {
    console.warn('[agentResponsePresentation] Repair synthesis fallback:', error?.message);
    // Apply deterministic-only repairs when LLM repair times out
    const patched = applyDeterministicRepairs(brief, deterministicQa);
    return normalizeBriefForQa(patched, fallbackBrief, { brevity: answerContract?.brevity, toolCalls });
  }
}

/**
 * Build an EvidenceRegistry from collected tool calls.
 * Registers SQL, Python, and chart results for deterministic verification.
 */
function buildEvidenceFromToolCalls(toolCalls) {
  const registry = new EvidenceRegistry();
  for (const tc of (Array.isArray(toolCalls) ? toolCalls : [])) {
    if (!tc?.result?.success) continue;
    if (tc.name === 'query_sap_data') {
      registry.registerQueryResult(tc);
    } else if (tc.name === 'run_python_analysis') {
      registry.registerPythonResult(tc);
    } else if (tc.name === 'generate_chart') {
      registry.registerChartResult(tc);
    }
  }
  if (registry.hasEvidence()) {
    registry.computeDerivedValues();
    registry.flagExtremeValues();
  }
  return registry;
}

export async function buildAgentPresentationPayload({
  userMessage,
  toolCalls = [],
  finalAnswerText = '',
  mode = 'default',
  answerContract: providedAnswerContract = null,
  forceCrossReview = false,
  complexityTier = 'complex', // 'meta' | 'simple' | 'complex'
  agentProvider = '',
  agentModel = '',
}) {
  const { provider: reviewProvider, model: reviewModel } = getCrossModelReviewConfig();
  // ── Meta tier: skip all LLM calls, use deterministic builders only ──
  if (complexityTier === 'meta') {
    const answerContract = normalizeAnswerContract(providedAnswerContract, userMessage, mode);
    const brief = buildDeterministicAgentBrief({ userMessage, answerContract, toolCalls, finalAnswerText });
    const deterministicQa = computeDeterministicQa({ userMessage, answerContract, brief, toolCalls, finalAnswerText });
    return {
      brief,
      trace: deterministicQa.trace,
      answerContract,
      review: buildCompatReview({ qa: { status: 'pass', score: 10, skipped: true }, deterministicQa }),
      qa: { status: 'pass', score: 10, skipped: true },
      skippedSteps: ['answer_contract_llm', 'brief_synthesis_llm', 'self_review', 'cross_review', 'repair'],
    };
  }

  const answerContract = providedAnswerContract
    ? normalizeAnswerContract(providedAnswerContract, userMessage, mode)
    : await deriveAnswerContract({ userMessage, mode });
  const artifactSummary = summarizeArtifacts(toolCalls);

  // ── Simple tier: deterministic contract + LLM brief + deterministic QA only ──
  if (complexityTier === 'simple') {
    const brief = await synthesizeBrief({ userMessage, answerContract, toolCalls, finalAnswerText, mode });
    const deterministicQa = computeDeterministicQa({ userMessage, answerContract, brief, toolCalls, finalAnswerText });
    const qa = mergeQaResults({ deterministicQa, selfReview: null, crossReview: null, repairAttempted: false });
    return {
      brief,
      trace: deterministicQa.trace,
      answerContract,
      review: buildCompatReview({ qa, deterministicQa }),
      qa,
      skippedSteps: ['self_review', 'cross_review', 'repair'],
    };
  }

  // ── Complex tier: full pipeline ──
  // Primary path (analysis mode): Direct JSON Brief from agent output — no synthesis LLM.
  // synthesizeBrief is fallback only, used when agent fails to produce valid JSON.
  let initialBrief;
  if (mode === 'analysis') {
    // Attempt 1: raw JSON parse
    try {
      const directBrief = JSON.parse(finalAnswerText);
      if (directBrief.headline && directBrief.summary) {
        initialBrief = directBrief;
      }
    } catch { /* not raw JSON */ }

    // Attempt 2: extract JSON from markdown fences (```json ... ```)
    if (!initialBrief) {
      const fenceMatch = (finalAnswerText || '').match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
      if (fenceMatch) {
        try {
          const fencedBrief = JSON.parse(fenceMatch[1]);
          if (fencedBrief.headline && fencedBrief.summary) {
            initialBrief = fencedBrief;
          }
        } catch { /* fenced content not valid JSON */ }
      }
    }

    // Attempt 3: Balanced JSON recovery — handles extra prose or multiple JSON objects
    if (!initialBrief) {
      const candidates = extractBalancedJsonObjectCandidates(finalAnswerText)
        .map((candidate) => ({ candidate, parsed: tryParseJsonCandidate(candidate) }))
        .filter(({ parsed }) => parsed && typeof parsed === 'object')
        .map(({ parsed }) => ({
          parsed,
          richness: [
            parsed?.headline,
            parsed?.summary,
            parsed?.executive_summary,
            Array.isArray(parsed?.metric_pills) && parsed.metric_pills.length > 0,
            Array.isArray(parsed?.tables) && parsed.tables.length > 0,
            Array.isArray(parsed?.charts) && parsed.charts.length > 0,
            Array.isArray(parsed?.key_findings) && parsed.key_findings.length > 0,
            Array.isArray(parsed?.implications) && parsed.implications.length > 0,
            Array.isArray(parsed?.caveats) && parsed.caveats.length > 0,
            Array.isArray(parsed?.next_steps) && parsed.next_steps.length > 0,
          ].filter(Boolean).length,
        }))
        .sort((a, b) => b.richness - a.richness);

      if (candidates[0]?.parsed?.headline || candidates[0]?.parsed?.summary) {
        initialBrief = candidates[0].parsed;
        console.info('[Presentation] Recovered balanced JSON brief from agent output');
      }
    }

    // Attempt 4: Lenient JSON repair — fix common LLM JSON mistakes
    if (!initialBrief) {
      try {
        let repaired = finalAnswerText;
        const jsonStart = repaired.indexOf('{');
        const jsonEnd = repaired.lastIndexOf('}');
        if (jsonStart >= 0 && jsonEnd > jsonStart) {
          repaired = repaired.slice(jsonStart, jsonEnd + 1);
        }
        repaired = repaired.replace(/,\s*([}\]])/g, '$1');
        repaired = repaired.replace(/[\x00-\x1F\x7F]/g, ' ');
        const repairedBrief = JSON.parse(repaired);
        if (repairedBrief.headline || repairedBrief.summary) {
          initialBrief = repairedBrief;
          console.info('[Presentation] Recovered JSON brief after lenient repair');
        }
      } catch { /* repair failed */ }
    }

    // Attempt 5: Field extraction — recover structured top-level fields from malformed JSON
    if (!initialBrief) {
      const extracted = {};
      const candidateFields = [
        'headline',
        'executive_summary',
        'summary',
        'metric_pills',
        'data_lineage',
        'tables',
        'charts',
        'chart_specs',
        'key_findings',
        'implications',
        'caveats',
        'next_steps',
        'methodology_note',
      ];

      for (const fieldName of candidateFields) {
        const value = extractJsonLikeFieldValue(finalAnswerText, fieldName);
        if (value != null) extracted[fieldName] = value;
      }

      if (extracted.headline || extracted.summary || extracted.executive_summary || extracted.metric_pills || extracted.tables || extracted.charts || extracted.chart_specs) {
        initialBrief = {
          headline: extracted.headline || 'Analysis complete.',
          ...(extracted.executive_summary ? { executive_summary: extracted.executive_summary } : {}),
          summary: extracted.summary || '',
          ...(Array.isArray(extracted.metric_pills) ? { metric_pills: extracted.metric_pills } : {}),
          ...(Array.isArray(extracted.data_lineage) ? { data_lineage: extracted.data_lineage } : {}),
          ...(Array.isArray(extracted.tables) ? { tables: extracted.tables } : {}),
          ...(Array.isArray(extracted.charts) ? { charts: extracted.charts } : {}),
          ...(Array.isArray(extracted.chart_specs) ? { chart_specs: extracted.chart_specs } : {}),
          ...(Array.isArray(extracted.key_findings) ? { key_findings: extracted.key_findings } : {}),
          ...(Array.isArray(extracted.implications) ? { implications: extracted.implications } : {}),
          ...(Array.isArray(extracted.caveats) ? { caveats: extracted.caveats } : {}),
          ...(Array.isArray(extracted.next_steps) ? { next_steps: extracted.next_steps } : {}),
          ...(typeof extracted.methodology_note === 'string' ? { methodology_note: extracted.methodology_note } : {}),
        };
        console.info('[Presentation] Extracted individual fields from malformed JSON');
      }
    }

    if (initialBrief) {
      console.info('[Presentation] Using direct JSON brief from agent (no synthesis LLM needed)');
    }
  }

  // Backfill empty chart data from tool calls (agent can't embed full data in JSON)
  if (initialBrief?.chart_specs || initialBrief?.charts) {
    const chartField = initialBrief.chart_specs ? 'chart_specs' : 'charts';
    const toolCharts = buildChartsFromToolCalls(toolCalls, { brevity: 'analysis' });
    const hasEmptyCharts = (initialBrief[chartField] || []).some(
      c => !Array.isArray(c.data) || c.data.length === 0
    );
    if (hasEmptyCharts && toolCharts.length > 0) {
      const filledCharts = (initialBrief[chartField] || []).map((agentChart, idx) => {
        if (Array.isArray(agentChart.data) && agentChart.data.length > 0) return agentChart;
        const match = toolCharts.find(
          tc => tc.type === agentChart.type && tc.title === agentChart.title
        ) || toolCharts[idx];
        if (match) {
          return {
            ...agentChart,
            data: match.data,
            xKey: agentChart.xKey || match.xKey,
            yKey: agentChart.yKey || match.yKey,
            ...(match.series && !agentChart.series ? { series: match.series } : {}),
          };
        }
        return agentChart;
      }).filter(c => Array.isArray(c.data) && c.data.length > 0);

      if (filledCharts.length < toolCharts.length) {
        const usedTypes = new Set(filledCharts.map(c => `${c.type}:${c.title}`));
        for (const tc of toolCharts) {
          if (!usedTypes.has(`${tc.type}:${tc.title}`)) {
            filledCharts.push(tc);
          }
        }
      }

      initialBrief[chartField] = filledCharts;
      console.info(`[Presentation] Backfilled ${filledCharts.length} charts from tool calls`);
    }
  }

  // ── Evidence-First Synthesis: build registry and use verified data ──
  const evidenceRegistry = buildEvidenceFromToolCalls(toolCalls);

  if (!initialBrief) {
    // Try evidence-based synthesis first (uses pre-computed, scope-verified data)
    if (evidenceRegistry.hasEvidence()) {
      try {
        const evidenceBrief = evidenceRegistry.toSynthesisBrief();
        console.info('[Presentation] Using evidence-based synthesis (pre-verified data)', evidenceRegistry.getSummary());
        const synthesized = await synthesizeFromEvidence({
          userMessage,
          answerContract,
          evidenceBrief,
          agentSummary: clamp(stripThinkingTags(finalAnswerText), 2500),
        });
        if (synthesized && (synthesized.headline || synthesized.summary)) {
          initialBrief = synthesized;
        }
      } catch (err) {
        console.warn('[Presentation] Evidence-based synthesis failed, falling back:', err?.message);
      }
    }

    // Standard synthesis fallback
    if (!initialBrief) {
      if (mode === 'analysis') {
        console.warn('[Presentation] Falling back to standard synthesis LLM');
      }
      initialBrief = await synthesizeBrief({
        userMessage,
        answerContract,
        toolCalls,
        finalAnswerText,
        mode,
      });
    }
  }
  initialBrief = normalizeBriefForQa(initialBrief, initialBrief, { brevity: answerContract?.brevity, toolCalls });
  if (looksLikeSerializedJsonText(initialBrief?.headline) || looksLikeSerializedJsonText(initialBrief?.summary)) {
    const recoveredStructuredBrief = recoverBestStructuredBrief(finalAnswerText);
    if (recoveredStructuredBrief) {
      initialBrief = normalizeBriefForQa(recoveredStructuredBrief, recoveredStructuredBrief, { brevity: answerContract?.brevity, toolCalls });
      console.info('[Presentation] Recovered structured brief after serialized JSON leaked into normalized fields');
    }
  }
  let initialDeterministicQa = computeDeterministicQa({
    userMessage,
    answerContract,
    brief: initialBrief,
    toolCalls,
    finalAnswerText,
  });
  const prePatchedBrief = applyDeterministicRepairs(initialBrief, initialDeterministicQa);
  if (JSON.stringify(prePatchedBrief) !== JSON.stringify(initialBrief)) {
    initialBrief = normalizeBriefForQa(prePatchedBrief, initialBrief, { brevity: answerContract?.brevity, toolCalls });
    initialDeterministicQa = computeDeterministicQa({
      userMessage,
      answerContract,
      brief: initialBrief,
      toolCalls,
      finalAnswerText,
    });
  }
  const skippedSteps = [];

  // ── Simplified QA pipeline (S3): 1-2 LLM calls instead of 4-6 ──
  // Step 1: Single unified LLM review (replaces separate self + cross reviews)
  let singleReview = null;
  if (!isProviderCircuitOpen(reviewProvider)) {
    singleReview = await requestQaReview({
      promptId: DI_PROMPT_IDS.AGENT_QA_SELF_REVIEW,
      stage: 'unified',
      userMessage,
      answerContract,
      brief: initialBrief,
      toolCalls,
      finalAnswerText,
      deterministicQa: initialDeterministicQa,
      artifactSummary,
      providerOverride: reviewProvider,
      modelOverride: reviewModel,
    });
  } else {
    skippedSteps.push('llm_review');
    console.warn(`[QA] Skipping LLM review — ${reviewProvider} circuit breaker is open`);
  }

  const initialQa = mergeQaResults({
    deterministicQa: initialDeterministicQa,
    selfReview: singleReview,
    crossReview: null,
    repairAttempted: false,
  });
  skippedSteps.push('cross_review');

  // Step 2: Conditional repair — only for severe issues (score < 5.0 or hard blockers)
  // Soft blockers (content duplication, pseudo-tables) are handled by deterministic repair only
  const hasHardBlockers = (initialQa.hard_blockers || []).length > 0;
  const needsRepair = (initialQa.score < 5.0 || hasHardBlockers) && !isProviderCircuitOpen(reviewProvider);

  if (needsRepair) {
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
    // Re-merge with deterministic QA only (no re-review LLM call)
    const repairedQa = mergeQaResults({
      deterministicQa: repairedDeterministicQa,
      selfReview: singleReview,
      crossReview: null,
      repairAttempted: true,
    });

    return {
      brief: repairedBrief,
      trace: repairedDeterministicQa.trace,
      answerContract,
      review: buildCompatReview({ qa: repairedQa, deterministicQa: repairedDeterministicQa }),
      qa: repairedQa,
      skippedSteps: [...skippedSteps, 'repaired_review'],
    };
  }

  if (initialQa.status === 'warning') {
    skippedSteps.push('repair_cycle');
  }

  return {
    brief: initialBrief,
    trace: initialDeterministicQa.trace,
    answerContract,
    review: buildCompatReview({ qa: initialQa, deterministicQa: initialDeterministicQa }),
    qa: initialQa,
    skippedSteps,
  };
}

/**
 * Immediate presentation: brief only, no QA.
 * Returns in < 5 seconds for instant user feedback (S5).
 */
export async function buildImmediatePresentation({
  userMessage, answerContract, toolCalls, finalAnswerText, mode,
}) {
  const ac = answerContract
    ? normalizeAnswerContract(answerContract, userMessage, mode)
    : await deriveAnswerContract({ userMessage, mode });

  // Try direct JSON brief from agent output (analysis mode only — default mode doesn't output JSON)
  let brief;
  if (mode === 'analysis') {
    try {
      const parsed = JSON.parse(finalAnswerText);
      if (parsed.headline && parsed.summary) {
        brief = normalizeBriefForQa(parsed, parsed, { brevity: ac?.brevity, toolCalls });
      } else {
        throw new Error('not a brief');
      }
    } catch { /* fallback below */ }
  }
  if (!brief) {
    brief = await synthesizeBrief({ userMessage, answerContract: ac, toolCalls, finalAnswerText, mode });
  }

  return {
    brief,
    answerContract: ac,
    qa: { status: 'pending', score: null, message: 'Quality check in progress...' },
  };
}

/**
 * Background QA: runs after user has already seen the brief.
 * Returns updated QA result for optional UI update (S5).
 */
export async function runBackgroundQa({
  userMessage, answerContract, brief, toolCalls, finalAnswerText,
}) {
  const { provider: reviewProvider, model: reviewModel } = getCrossModelReviewConfig();
  const deterministicQa = computeDeterministicQa({
    userMessage, answerContract, brief, toolCalls, finalAnswerText,
  });

  let review = null;
  if (!isProviderCircuitOpen(reviewProvider)) {
    review = await requestQaReview({
      promptId: DI_PROMPT_IDS.AGENT_QA_SELF_REVIEW,
      stage: 'unified',
      userMessage,
      answerContract,
      brief,
      toolCalls,
      finalAnswerText,
      deterministicQa,
      artifactSummary: summarizeArtifacts(toolCalls),
      providerOverride: reviewProvider,
      modelOverride: reviewModel,
    });
  }

  return mergeQaResults({
    deterministicQa,
    selfReview: review,
    crossReview: null,
    repairAttempted: false,
  });
}

export default {
  buildAgentPresentationPayload,
  buildDeterministicAnswerContract,
  buildDeterministicAgentBrief,
  buildImmediatePresentation,
  runBackgroundQa,
  computeDeterministicQa,
  reviewAgentBriefDeterministically,
  resolveAgentAnswerContract,
};
