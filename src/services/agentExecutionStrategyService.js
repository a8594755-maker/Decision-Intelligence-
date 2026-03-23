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

  const mustJudge = hasDataAnalysisSignal || hasCodingSignal || hasNumericSignal;
  const dualGenerate = mustJudge && !hasMutatingSignal && (mode === 'analysis' || hasAttachments || hasCodingSignal || hasNumericSignal);

  const triggerReasons = [];
  if (hasDataAnalysisSignal) triggerReasons.push('data_analysis');
  if (hasCodingSignal) triggerReasons.push('coding');
  if (hasNumericSignal) triggerReasons.push('numeric_reasoning');
  if (hasMutatingSignal) triggerReasons.push('mutating_action');
  if (hasAttachments) triggerReasons.push('attachment_context');

  return {
    mustJudge,
    dualGenerate,
    triggerReasons,
    riskLevel: dualGenerate ? 'high' : mustJudge ? 'medium' : 'normal',
  };
}

export default {
  resolveAgentExecutionStrategy,
};
