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

// Queries containing blocked keywords are only blocked when they also contain
// action verbs (run/execute/start/launch). Analytical framing (compare/analyze/
// show/what difference) should pass through to the analysis engine.
const ANALYSIS_VERB_PATTERNS = [
  /\b(compare|compar|analyz|analy[sz]e|show|display|what.*(differen|impact|effect)|break\s*down|assess|evaluate)\b/i,
  /(比較|分析|顯示|差異|影響|拆解|評估|對比)/,
];

function isBlockedExecutionPrompt(query) {
  const hasBlockedKeyword = BLOCKED_EXECUTION_PATTERNS.some((pattern) => pattern.test(query));
  if (!hasBlockedKeyword) return false;
  // If the query uses analytical framing, allow it through
  const hasAnalysisVerb = ANALYSIS_VERB_PATTERNS.some((pattern) => pattern.test(query));
  if (hasAnalysisVerb) return false;
  return true;
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

export function buildDirectAnalysisAgentPrompt(query, answerContract = null) {
  const normalized = normalizeQuery(query);
  const deepDives = Array.isArray(answerContract?.suggested_deep_dives)
    ? answerContract.suggested_deep_dives
    : [];

  const parts = [
    'Run a direct business data analysis for the following request.',
    `User request: "${normalized}"`,
    '',
    'Choose the best tool per the Tool Selection Rules in your system prompt.',
    'Return structured analysis with metrics, charts, tables, and concise findings.',
  ];

  if (deepDives.length > 0) {
    parts.push('');
    parts.push('## Suggested Deep Dives (attempt at least one if data supports it)');
    deepDives.forEach((dd, i) => parts.push(`${i + 1}. ${dd}`));
    parts.push('');
    parts.push('After completing the primary analysis, run one additional query or analysis to explore a suggested deep dive. This adds depth beyond surface-level descriptive statistics.');
  }

  return parts.join('\n');
}
