function isAnalysisPayload(payload) {
  return Boolean(payload && typeof payload === 'object' && (payload.title || payload.analysisType));
}

export function extractAnalysisPayloadsFromToolCall(toolCall) {
  if (!toolCall?.result?.success) return [];

  if (toolCall.name?.startsWith('analyze_')) {
    return isAnalysisPayload(toolCall.result?.result) ? [toolCall.result.result] : [];
  }

  if (toolCall.name === 'run_python_analysis') {
    const cards = Array.isArray(toolCall.result?._analysisCards)
      ? toolCall.result._analysisCards.filter(isAnalysisPayload)
      : [];
    if (cards.length > 0) return cards;
    return isAnalysisPayload(toolCall.result?.result) ? [toolCall.result.result] : [];
  }

  // generate_chart: chatToolAdapter wraps the executor result in an extra { success, result } envelope,
  // so _analysisCards lives at toolCall.result.result._analysisCards (two levels deep).
  if (toolCall.name === 'generate_chart') {
    const inner = toolCall.result?.result; // unwrap adapter envelope
    const cards = Array.isArray(inner?._analysisCards)
      ? inner._analysisCards.filter(isAnalysisPayload)
      : [];
    if (cards.length > 0) return cards;
    // Fallback: single result nested one more level
    return isAnalysisPayload(inner?.result) ? [inner.result] : [];
  }

  return [];
}

export function isRenderableAnalysisToolCall(toolCall) {
  return extractAnalysisPayloadsFromToolCall(toolCall).length > 0;
}
