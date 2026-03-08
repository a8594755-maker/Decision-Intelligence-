/**
 * Operational Metrics Aggregator
 *
 * Aggregates cross-pipeline metrics for operational health monitoring.
 * Builds on existing structuredLogger, pipelineSpan, importMetrics, and dataQualityTracker.
 *
 * Counters are in-memory (reset on page reload). This is intentional for a frontend SPA.
 */

import { logger } from './structuredLogger';
import { createDataQualityTracker } from './dataQualityTracker';

const MAX_LATENCY_SAMPLES = 1000;

const counters = {
  import_attempts: 0,
  import_successes: 0,
  import_failures: 0,
  mapping_review_required: 0,
  fallback_used: 0,
  degraded_capability: 0,
  planning_attempts: 0,
  planning_successes: 0,
  planning_failures: 0,
  planning_latency_ms: [],
  zero_result_plans: 0,
  empty_output_plans: 0,
};

// ── Public recording API ──────────────────────────────────────────────────

export function recordImportAttempt() { counters.import_attempts++; }
export function recordImportSuccess() { counters.import_successes++; }
export function recordImportFailure() { counters.import_failures++; }
export function recordMappingReviewRequired() { counters.mapping_review_required++; }
export function recordFallbackUsed(count = 1) { counters.fallback_used += count; }
export function recordDegradedCapability(count = 1) { counters.degraded_capability += count; }
export function recordPlanningAttempt() { counters.planning_attempts++; }

export function recordPlanningSuccess(latencyMs) {
  counters.planning_successes++;
  counters.planning_latency_ms.push(latencyMs);
  if (counters.planning_latency_ms.length > MAX_LATENCY_SAMPLES) {
    counters.planning_latency_ms = counters.planning_latency_ms.slice(-MAX_LATENCY_SAMPLES);
  }
}

export function recordPlanningFailure() { counters.planning_failures++; }
export function recordZeroResultPlan() { counters.zero_result_plans++; }
export function recordEmptyOutputPlan() { counters.empty_output_plans++; }

// ── Health summary ────────────────────────────────────────────────────────

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function buildAlerts(c, logStats) {
  const alerts = [];

  if (c.planning_attempts > 0 && c.planning_failures / c.planning_attempts > 0.2) {
    alerts.push({
      level: 'error',
      code: 'HIGH_PLANNING_FAILURE_RATE',
      message: `Planning failure rate is ${Math.round((c.planning_failures / c.planning_attempts) * 100)}%`,
    });
  }

  if (c.zero_result_plans > 0) {
    alerts.push({
      level: 'warn',
      code: 'ZERO_RESULT_PLANS',
      message: `${c.zero_result_plans} planning run${c.zero_result_plans !== 1 ? 's' : ''} produced zero results`,
    });
  }

  if (c.empty_output_plans > 0) {
    alerts.push({
      level: 'warn',
      code: 'EMPTY_OUTPUT_PLANS',
      message: `${c.empty_output_plans} planning run${c.empty_output_plans !== 1 ? 's' : ''} produced empty output`,
    });
  }

  if (logStats?.byLevel?.error > 5) {
    alerts.push({
      level: 'warn',
      code: 'HIGH_ERROR_LOG_RATE',
      message: `${logStats.byLevel.error} error-level log entries in buffer`,
    });
  }

  return alerts;
}

/**
 * Get the operational health summary.
 * Combines counter data with logger stats and quality trend.
 */
export function getOperationalHealthSummary() {
  const logStats = logger.getStats();
  const qualityTracker = createDataQualityTracker();
  const trend = qualityTracker.getTrend();

  const p50 = percentile(counters.planning_latency_ms, 50);
  const p95 = percentile(counters.planning_latency_ms, 95);

  const importFailureRate = counters.import_attempts > 0
    ? Math.round((counters.import_failures / counters.import_attempts) * 100) / 100
    : 0;
  const mappingReviewRate = counters.import_attempts > 0
    ? Math.round((counters.mapping_review_required / counters.import_attempts) * 100) / 100
    : 0;
  const planningFailureRate = counters.planning_attempts > 0
    ? Math.round((counters.planning_failures / counters.planning_attempts) * 100) / 100
    : 0;
  const fallbackUsageRate = counters.planning_attempts > 0
    ? Math.round((counters.fallback_used / counters.planning_attempts) * 100) / 100
    : 0;

  return {
    timestamp: new Date().toISOString(),
    import: {
      attempts: counters.import_attempts,
      successes: counters.import_successes,
      failures: counters.import_failures,
      failure_rate: importFailureRate,
      mapping_review_required: counters.mapping_review_required,
      mapping_review_rate: mappingReviewRate,
    },
    planning: {
      attempts: counters.planning_attempts,
      successes: counters.planning_successes,
      failures: counters.planning_failures,
      failure_rate: planningFailureRate,
      latency_p50_ms: p50,
      latency_p95_ms: p95,
      zero_result_plans: counters.zero_result_plans,
      empty_output_plans: counters.empty_output_plans,
    },
    data_quality: {
      fallback_usage_count: counters.fallback_used,
      fallback_usage_rate: fallbackUsageRate,
      degraded_capability_count: counters.degraded_capability,
      quality_trend: trend,
    },
    logger: logStats,
    alerts: buildAlerts(counters, logStats),
  };
}

/** Reset counters (for testing). */
export function resetCounters() {
  counters.import_attempts = 0;
  counters.import_successes = 0;
  counters.import_failures = 0;
  counters.mapping_review_required = 0;
  counters.fallback_used = 0;
  counters.degraded_capability = 0;
  counters.planning_attempts = 0;
  counters.planning_successes = 0;
  counters.planning_failures = 0;
  counters.planning_latency_ms = [];
  counters.zero_result_plans = 0;
  counters.empty_output_plans = 0;
}
