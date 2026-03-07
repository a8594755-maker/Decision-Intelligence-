/**
 * Pipeline Span - Timing and metrics for pipeline stages
 */

export function createSpan(pipeline, stage, parentTraceId = null) {
  const startedAt = Date.now();
  const traceId = parentTraceId || `${pipeline}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const metrics = {};
  let endedAt = null;

  return {
    traceId,
    addMetric(key, value) { metrics[key] = value; },
    incrementMetric(key, delta = 1) { metrics[key] = (metrics[key] || 0) + delta; },
    end() { endedAt = Date.now(); },
    get durationMs() { return (endedAt || Date.now()) - startedAt; },
    toJSON() {
      return {
        pipeline,
        stage,
        traceId,
        startedAt: new Date(startedAt).toISOString(),
        endedAt: endedAt ? new Date(endedAt).toISOString() : null,
        durationMs: (endedAt || Date.now()) - startedAt,
        metrics,
      };
    },
  };
}
