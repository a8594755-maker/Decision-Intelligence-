const DATA_ANALYSIS_PATTERNS = [
  /\b(sql|python|pandas|numpy|data|dataset|query|chart|plot|graph|visuali[sz]e|heatmap|histogram|scatter|trend|distribution|quantile|percentile|correlation|compare|comparison|metric|kpi|revenue|orders?|delivery|return rate|gini|lorenz|segment|ranking)\b/i,
  /(分析|圖表|圖|可視化|視覺化|查詢|資料|數據|直方圖|熱力圖|散點圖|趨勢|分布|分位數|相關|比較|營收|訂單|配送|退貨率|評分|基尼|排行)/,
];

const CODING_PATTERNS = [
  /\b(code|coding|bug|debug|fix|function|component|refactor|implementation|test|tests|script|typescript|javascript|react|jsx|ts|js)\b/i,
  /(程式|代碼|寫程式|修 bug|修正|重構|函式|元件|測試)/,
];

const NUMERIC_REASONING_PATTERNS = [
  /\b(calculate|calculation|compute|formula|estimate|model|forecast|score|scoring|benchmark|what.?if)\b/i,
  /(計算|推估|估算|公式|模型|評分|評估|模擬)/,
];

const MUTATING_ACTION_PATTERNS = [
  /\b(approve|reject|publish|register|create tool|negotiate|workflow|execute plan|run plan|replenish|export|send|writeback|sync)\b/i,
  /(核准|否決|發布|註冊工具|談判|工作流|執行計畫|補貨|匯出|送出|寫回|同步)/,
];

const EXECUTION_INTENT_PATTERNS = [
  /\b(approve|reject|publish|register|create tool|execute|run|launch|trigger|export|send|writeback|sync)\b/i,
  /(核准|否決|發布|註冊工具|執行|運行|啟動|觸發|匯出|送出|寫回|同步|直接做|直接跑)/,
];

const ANALYTICAL_CONTEXT_PATTERNS = [
  /\b(analy[sz]e|analysis|compare|comparison|recommend|recommendation|risk|impact|strategy|scenario|assess|evaluate|what.?if)\b/i,
  /(分析|比較|建議|風險|影響|策略|情境|評估|假設|怎麼|如何|拆解)/,
];

function hasPattern(patterns, text) {
  return patterns.some((pattern) => pattern.test(text));
}

const COMPLEX_TASK_TYPES = new Set(['recommendation', 'diagnostic', 'comparison', 'trend']);
const DUAL_THRESHOLD = 5;

export function computeQueryComplexity(userMessage, answerContract) {
  let score = 0;
  const dims = Array.isArray(answerContract?.required_dimensions) ? answerContract.required_dimensions.length : 0;
  const outputs = Array.isArray(answerContract?.required_outputs) ? answerContract.required_outputs.length : 0;
  const depth = Array.isArray(answerContract?.analysis_depth) ? answerContract.analysis_depth.length : 0;
  const taskType = answerContract?.task_type || 'mixed';

  // Dimension count: 0-3 points
  score += Math.min(3, dims);

  // Output count: 0-2 points
  score += Math.min(2, outputs);

  // Task type: complex types get 2, non-lookup gets 1
  if (COMPLEX_TASK_TYPES.has(taskType)) score += 2;
  else if (taskType !== 'lookup') score += 1;

  // Analysis depth: 1 point if >= 2 depth flags
  if (depth >= 2) score += 1;

  // Long message heuristic: likely complex question
  if (String(userMessage || '').length > 200) score += 1;

  return score;
}

function hasMutatingIntent(text) {
  const sample = String(text || '');
  if (!hasPattern(MUTATING_ACTION_PATTERNS, sample)) return false;
  if (hasPattern(EXECUTION_INTENT_PATTERNS, sample)) return true;
  if (hasPattern(ANALYTICAL_CONTEXT_PATTERNS, sample)) return false;
  return true;
}

export function resolveAgentExecutionStrategy({
  userMessage,
  answerContract,
  mode = 'default',
  hasAttachments = false,
}) {
  const message = String(userMessage || '');
  const requiredOutputs = Array.isArray(answerContract?.required_outputs) ? answerContract.required_outputs : [];
  const requiredDimensions = Array.isArray(answerContract?.required_dimensions) ? answerContract.required_dimensions : [];

  const hasDataAnalysisSignal = hasPattern(DATA_ANALYSIS_PATTERNS, message)
    || requiredOutputs.some((item) => ['chart', 'table', 'comparison', 'recommendation'].includes(item))
    || requiredDimensions.length > 0
    || mode === 'analysis'
    || hasAttachments;
  const hasCodingSignal = hasPattern(CODING_PATTERNS, message);
  const hasNumericSignal = hasPattern(NUMERIC_REASONING_PATTERNS, message)
    || ['comparison', 'diagnostic', 'ranking', 'trend', 'recommendation'].includes(answerContract?.task_type || '');
  const hasMutatingSignal = hasMutatingIntent(message);

  // Require at least TWO independent signals before triggering judge pipeline.
  // A single signal (e.g. the word "data" alone) is not enough to justify the overhead.
  const signalCount = [hasDataAnalysisSignal, hasCodingSignal, hasNumericSignal].filter(Boolean).length;
  const mustJudge = signalCount >= 2;
  const complexityScore = computeQueryComplexity(message, answerContract);
  const mayEscalate = mustJudge && !hasMutatingSignal && (complexityScore >= DUAL_THRESHOLD || hasAttachments);

  const triggerReasons = [];
  if (hasDataAnalysisSignal) triggerReasons.push('data_analysis');
  if (hasCodingSignal) triggerReasons.push('coding');
  if (hasNumericSignal) triggerReasons.push('numeric_reasoning');
  if (hasMutatingSignal) triggerReasons.push('mutating_action');
  if (hasAttachments) triggerReasons.push('attachment_context');

  return {
    mustJudge,
    mayEscalate,
    dualGenerate: mayEscalate, // backward compat — consumers still read dualGenerate
    complexityScore,
    triggerReasons,
    riskLevel: mayEscalate ? 'high' : mustJudge ? 'medium' : 'normal',
  };
}

export default {
  resolveAgentExecutionStrategy,
  computeQueryComplexity,
};
