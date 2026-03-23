const BLOCKED_EXECUTION_PATTERNS = [
  /\b(forecast|predict|plan|replenish|risk|workflow|scenario|simulate|approval|approve|reject|negotiate|export|excel|xlsx|powerbi)\b/i,
  /(預測|計畫|補貨|風險|工作流|情境|模擬|審批|核准|否決|談判|匯出|excel|報表匯出|工作簿)/,
];

const PYTHON_ANALYSIS_PATTERNS = [
  /\b(analysis|analyze|insight|insights|performance|scorecard|segmentation|mix|composition|distribution|trend|correlation|concentration|benchmark|breakdown|cohort|kpi|dashboard|gini|lorenz|deep dive)\b/i,
  // Chart / visualization keywords (EN)
  /\b(chart|plot|graph|heatmap|histogram|scatter|bar chart|pie chart|treemap|funnel|waterfall|pareto|radar|sankey|bubble|visuali[sz]e|show .*(trend|distribution|breakdown|ranking))\b/i,
  // Analysis + chart keywords (ZH)
  /(分析|洞察|績效|表現|分群|組成|結構|佔比|分布|趨勢|相關|集中度|基尼|洛倫茲|客群|看板|深入)/,
  /(圖表|圖|熱力圖|折線圖|柱狀圖|長條圖|圓餅圖|散點圖|直方圖|漏斗圖|瀑布圖|雷達圖|樹狀圖|氣泡圖|排行|排名|營收|訂單量|配送|評分|賣家)/,
];

function normalizeQuery(query) {
  return String(query || '').trim();
}

function isBlockedExecutionPrompt(query) {
  return BLOCKED_EXECUTION_PATTERNS.some((pattern) => pattern.test(query));
}

function hasPythonAnalysisSignals(query) {
  return PYTHON_ANALYSIS_PATTERNS.some((pattern) => pattern.test(query));
}

/**
 * Resolve whether a query should be routed to the Python analysis engine.
 * Returns { type: 'python', toolId } or null.
 */
export function resolveDirectAnalysisRequest(query, opts = {}) {
  const normalized = normalizeQuery(query);
  const { hasUploadedData = false } = opts;

  if (!normalized || normalized.length < 3) return null;
  if (isBlockedExecutionPrompt(normalized)) return null;

  if (hasUploadedData || hasPythonAnalysisSignals(normalized)) {
    return {
      type: 'python',
      toolId: 'run_python_analysis',
    };
  }

  return null;
}

export function buildDirectAnalysisAgentPrompt(query) {
  const normalized = normalizeQuery(query);
  return [
    'Run a direct business data analysis for the following request.',
    `User request: "${normalized}"`,
    '',
    'Choose the best tool per the Tool Selection Rules in your system prompt.',
    'Return structured analysis with metrics, charts, tables, and concise findings.',
  ].join('\n');
}
