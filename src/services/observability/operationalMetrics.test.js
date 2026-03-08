import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordImportAttempt, recordImportSuccess, recordImportFailure,
  recordMappingReviewRequired, recordFallbackUsed, recordDegradedCapability,
  recordPlanningAttempt, recordPlanningSuccess, recordPlanningFailure,
  recordZeroResultPlan, recordEmptyOutputPlan,
  getOperationalHealthSummary, resetCounters,
} from './operationalMetrics';

describe('operationalMetrics', () => {
  beforeEach(() => {
    resetCounters();
  });

  it('returns zero counts when nothing recorded', () => {
    const summary = getOperationalHealthSummary();
    expect(summary.import.attempts).toBe(0);
    expect(summary.planning.attempts).toBe(0);
    expect(summary.data_quality.fallback_usage_count).toBe(0);
    expect(summary.alerts).toEqual([]);
  });

  it('correctly computes import failure rate', () => {
    recordImportAttempt();
    recordImportAttempt();
    recordImportSuccess();
    recordImportFailure();
    const summary = getOperationalHealthSummary();
    expect(summary.import.attempts).toBe(2);
    expect(summary.import.successes).toBe(1);
    expect(summary.import.failures).toBe(1);
    expect(summary.import.failure_rate).toBe(0.5);
  });

  it('correctly computes mapping review rate', () => {
    recordImportAttempt();
    recordImportAttempt();
    recordMappingReviewRequired();
    const summary = getOperationalHealthSummary();
    expect(summary.import.mapping_review_rate).toBe(0.5);
  });

  it('correctly computes planning latency percentiles', () => {
    recordPlanningAttempt(); recordPlanningSuccess(100);
    recordPlanningAttempt(); recordPlanningSuccess(200);
    recordPlanningAttempt(); recordPlanningSuccess(500);
    const summary = getOperationalHealthSummary();
    expect(summary.planning.latency_p50_ms).toBe(200);
    expect(summary.planning.latency_p95_ms).toBe(500);
  });

  it('handles single latency sample', () => {
    recordPlanningAttempt(); recordPlanningSuccess(42);
    const summary = getOperationalHealthSummary();
    expect(summary.planning.latency_p50_ms).toBe(42);
    expect(summary.planning.latency_p95_ms).toBe(42);
  });

  it('generates alert for high planning failure rate', () => {
    for (let i = 0; i < 5; i++) { recordPlanningAttempt(); recordPlanningFailure(); }
    const summary = getOperationalHealthSummary();
    const alert = summary.alerts.find(a => a.code === 'HIGH_PLANNING_FAILURE_RATE');
    expect(alert).toBeTruthy();
    expect(alert.level).toBe('error');
  });

  it('does not generate planning failure alert below threshold', () => {
    for (let i = 0; i < 8; i++) { recordPlanningAttempt(); recordPlanningSuccess(100); }
    recordPlanningAttempt(); recordPlanningFailure();
    const summary = getOperationalHealthSummary();
    const alert = summary.alerts.find(a => a.code === 'HIGH_PLANNING_FAILURE_RATE');
    expect(alert).toBeUndefined();
  });

  it('generates alert for zero result plans', () => {
    recordZeroResultPlan();
    const summary = getOperationalHealthSummary();
    expect(summary.alerts.some(a => a.code === 'ZERO_RESULT_PLANS')).toBe(true);
  });

  it('generates alert for empty output plans', () => {
    recordEmptyOutputPlan();
    const summary = getOperationalHealthSummary();
    expect(summary.alerts.some(a => a.code === 'EMPTY_OUTPUT_PLANS')).toBe(true);
  });

  it('tracks fallback and degraded capability counts', () => {
    recordPlanningAttempt();
    recordFallbackUsed(3);
    recordDegradedCapability(2);
    const summary = getOperationalHealthSummary();
    expect(summary.data_quality.fallback_usage_count).toBe(3);
    expect(summary.data_quality.degraded_capability_count).toBe(2);
    expect(summary.data_quality.fallback_usage_rate).toBe(3);
  });

  it('resetCounters clears everything', () => {
    recordImportAttempt();
    recordPlanningAttempt();
    recordFallbackUsed(5);
    resetCounters();
    const summary = getOperationalHealthSummary();
    expect(summary.import.attempts).toBe(0);
    expect(summary.planning.attempts).toBe(0);
    expect(summary.data_quality.fallback_usage_count).toBe(0);
  });

  it('summary includes timestamp', () => {
    const summary = getOperationalHealthSummary();
    expect(summary.timestamp).toBeDefined();
    expect(new Date(summary.timestamp).getTime()).not.toBeNaN();
  });
});
