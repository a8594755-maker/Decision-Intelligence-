import { extractAnalysisPayloadsFromToolCall } from './analysisToolResultService.js';

export const REQUESTED_PERCENTILE_KEYS = Object.freeze(['p10', 'p25', 'p50', 'p75', 'p90', 'p95', 'p99']);

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
  // ── Composite / trend dimensions ──
  { label: 'revenue trend', patterns: [/\brevenue\s+trend/i, /\bsales\s+trend/i, /\btrend\s+(?:in\s+)?(?:revenue|sales)/i, /(營收趨勢|收入趨勢|銷售趨勢)/] },
  { label: 'order trend', patterns: [/\border\s+(?:volume\s+)?trend/i, /\btrend\s+(?:in\s+)?orders/i, /(訂單趨勢)/] },
  { label: 'growth', patterns: [/\bgrowth\s+rate/i, /\byoy\b/i, /\bmom\b/i, /\bqoq\b/i, /(成長率|增長率|同比|環比)/] },
  { label: 'seasonality', patterns: [/\bseasonal/i, /\bcyclical/i, /(季節性|週期性)/] },
]);

const SPECIAL_CHART_REQUESTS = Object.freeze([
  { key: 'histogram', patterns: [/\bhistogram\b/i, /(直方圖)/] },
  { key: 'heatmap', patterns: [/\bheatmap\b/i, /(熱力圖)/] },
  { key: 'scatter', patterns: [/\bscatter\b/i, /(散點圖)/] },
  { key: 'pie', patterns: [/\bpie\b/i, /(圓餅圖)/] },
  { key: 'treemap', patterns: [/\btreemap\b/i, /(樹狀圖|矩形樹圖)/] },
]);

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

function safeSerialize(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// Alias map: chart metric labels → dimension labels.
// Chart recipes use labels like "Total Sellers" or "Gini Coefficient" that
// don't match DIMENSION_PATTERNS directly. This alias table bridges the gap.
const METRIC_LABEL_ALIASES = Object.freeze({
  'total sellers': 'sellers',
  'active sellers': 'sellers',
  'seller count': 'sellers',
  'gini coefficient': 'revenue',
  'gini': 'revenue',
  'total revenue': 'revenue',
  'median revenue': 'revenue',
  'top 10 share': 'revenue',
  'total orders': 'orders',
  'order count': 'orders',
  'avg delivery days': 'delivery days',
  'late rate': 'delivery days',
  'on-time rate': 'delivery days',
  'average rating': 'rating',
  'review count': 'rating',
  'total customers': 'customers',
  'customer count': 'customers',
  'total products': 'products',
  'product count': 'products',
  'category count': 'categories',
  'revenue trend': 'revenue trend',
  'sales trend': 'revenue trend',
  'order trend': 'order trend',
  'monthly revenue': 'revenue trend',
  'revenue over time': 'revenue trend',
});

export function addDimensionHits(text, coveredDimensions) {
  const sample = String(text || '');
  for (const entry of DIMENSION_PATTERNS) {
    if (entry.patterns.some((pattern) => pattern.test(sample))) {
      coveredDimensions.add(entry.label);
    }
  }

  // Alias-based matching for chart metric labels
  const sampleLower = sample.toLowerCase();
  for (const [alias, dimension] of Object.entries(METRIC_LABEL_ALIASES)) {
    if (sampleLower.includes(alias)) {
      coveredDimensions.add(dimension);
    }
  }
}

function getQueryRowCount(toolCall) {
  const result = toolCall?.result?.result;
  if (Number.isFinite(result?.rowCount)) return result.rowCount;
  if (Array.isArray(result?.rows)) return result.rows.length;
  return null;
}

function getQueryRows(toolCall) {
  const rows = toolCall?.result?.result?.rows;
  return Array.isArray(rows) ? rows : [];
}

function tableLooksComparative(table) {
  return Array.isArray(table?.columns) && table.columns.length >= 2 && Array.isArray(table?.rows) && table.rows.length > 0;
}

function buildPayloadCoverageText(payload) {
  const chartText = Array.isArray(payload?.charts)
    ? payload.charts.flatMap((chart) => [
      chart?.title,
      chart?.xAxisLabel,
      chart?.yAxisLabel,
      ...(Array.isArray(chart?.referenceLines) ? chart.referenceLines.flatMap((line) => [line?.label, line?.value]) : []),
    ])
    : [];
  const tableText = Array.isArray(payload?.tables)
    ? payload.tables.flatMap((table) => [
      table?.title,
      ...(table?.columns || []),
      ...(table?.rows || []).flat(),
    ])
    : [];

  return [
    payload?.title,
    payload?.analysisType,
    payload?.summary,
    safeSerialize(payload?.metrics),
    ...(payload?.highlights || []),
    ...chartText,
    ...tableText,
  ].filter(Boolean).join(' ');
}

function isAnalysisLike(payload) {
  return Boolean(
    payload
    && typeof payload === 'object'
    && (payload.title || payload.analysisType || payload.metrics || payload.charts || payload.tables),
  );
}

export function detectRequestedSpecialChart(text = '') {
  const sample = String(text || '');
  return SPECIAL_CHART_REQUESTS.find((entry) => entry.patterns.some((pattern) => pattern.test(sample)))?.key || '';
}

export function collectPercentileKeysFromText(text = '') {
  const sample = String(text || '');
  const found = new Set();
  const labelPatterns = [
    ['p10', /\bp10\b|10(?:th)? percentile|第?10分位|10分位/i],
    ['p25', /\bp25\b|25(?:th)? percentile|第?25分位|25分位|q1\b/i],
    ['p50', /\bp50\b|\bmedian\b|中位數|q2\b/i],
    ['p75', /\bp75\b|75(?:th)? percentile|第?75分位|75分位|q3\b/i],
    ['p90', /\bp90\b|90(?:th)? percentile|第?90分位|90分位/i],
    ['p95', /\bp95\b|95(?:th)? percentile|第?95分位|95分位/i],
    ['p99', /\bp99\b|99(?:th)? percentile|第?99分位|99分位/i],
  ];

  for (const [key, pattern] of labelPatterns) {
    if (pattern.test(sample)) found.add(key);
  }

  return found;
}

export function getStructuredAnswerCoverage({
  toolCalls = [],
  requestedChart = '',
  userMessage = '',
} = {}) {
  const chartRequest = requestedChart || detectRequestedSpecialChart(userMessage);
  const coveredDimensions = new Set();
  const coveredOutputs = new Set();
  const foundPercentiles = new Set();
  const annotatedPercentiles = new Set();
  const chartTypes = new Set();
  const successfulButEmptyQueries = [];

  for (const toolCall of Array.isArray(toolCalls) ? toolCalls : []) {
    if (!toolCall?.result?.success) continue;

    if (toolCall?.name === 'query_sap_data' || toolCall?.name === 'list_sap_tables') {
      const rowCount = getQueryRowCount(toolCall);
      if (rowCount === 0) {
        successfulButEmptyQueries.push({
          id: toolCall?.id || null,
          name: toolCall?.name || 'query_sap_data',
          rowCount: 0,
          sql: toolCall?.args?.sql || null,
        });
      } else if (rowCount == null || rowCount > 0) {
        coveredOutputs.add('table');
        const sampleRows = getQueryRows(toolCall).slice(0, 5);
        const queryCoverageText = safeSerialize({
          args: toolCall?.args || {},
          rows: sampleRows,
        });
        addDimensionHits(queryCoverageText, coveredDimensions);
        collectPercentileKeysFromText(queryCoverageText).forEach((key) => foundPercentiles.add(key));
      }
    }

    const extractedPayloads = extractAnalysisPayloadsFromToolCall(toolCall);
    const analysisPayloads = extractedPayloads.length > 0
      ? extractedPayloads
      : (isAnalysisLike(toolCall?.result?.result) ? [toolCall.result.result] : []);
    for (const payload of analysisPayloads) {
      const payloadText = buildPayloadCoverageText(payload);
      addDimensionHits(payloadText, coveredDimensions);
      collectPercentileKeysFromText(payloadText).forEach((key) => foundPercentiles.add(key));

      const charts = Array.isArray(payload?.charts) ? payload.charts : [];
      const tables = Array.isArray(payload?.tables) ? payload.tables : [];

      if (charts.length > 0) coveredOutputs.add('chart');
      if (tables.length > 0) coveredOutputs.add('table');
      if (tables.some(tableLooksComparative)) coveredOutputs.add('comparison');

      for (const chart of charts) {
        const chartType = String(chart?.type || '').trim().toLowerCase();
        if (chartType) chartTypes.add(chartType);

        for (const line of Array.isArray(chart?.referenceLines) ? chart.referenceLines : []) {
          collectPercentileKeysFromText(line?.label).forEach((key) => annotatedPercentiles.add(key));
        }
      }
    }
  }

  if (foundPercentiles.size > 0) coveredDimensions.add('quantiles');

  const quantileCoverage = Object.fromEntries(
    REQUESTED_PERCENTILE_KEYS.map((key) => [key, foundPercentiles.has(key)]),
  );

  const compatChartTypes = chartRequest === 'histogram'
    ? new Set(['histogram', 'bar'])
    : new Set(chartRequest ? [chartRequest] : []);
  const hasCompatibleAnnotatedChart = compatChartTypes.size === 0
    || [...chartTypes].some((chartType) => compatChartTypes.has(chartType));

  return {
    coveredDimensions: uniqueStrings([...coveredDimensions]),
    coveredOutputs: uniqueStrings([...coveredOutputs]),
    quantileCoverage,
    foundPercentiles: uniqueStrings([...foundPercentiles]),
    annotatedPercentiles: uniqueStrings([...annotatedPercentiles]),
    hasHistogramQuantileAnnotations: hasCompatibleAnnotatedChart && annotatedPercentiles.size > 0,
    successfulButEmptyQueries,
    chartTypes: uniqueStrings([...chartTypes]),
  };
}

export default {
  REQUESTED_PERCENTILE_KEYS,
  addDimensionHits,
  collectPercentileKeysFromText,
  detectRequestedSpecialChart,
  getStructuredAnswerCoverage,
};
