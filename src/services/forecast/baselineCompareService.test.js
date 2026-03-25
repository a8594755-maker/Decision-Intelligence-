import { describe, it, expect } from 'vitest';
import {
  checkBaselineStaleness,
  computeKpiDrift,
  buildBaselineComparison,
  buildStalenessWarningMessages,
} from './baselineCompareService';

describe('computeKpiDrift', () => {
  it('computes delta and pct_change for each KPI', () => {
    const drift = computeKpiDrift(
      { estimated_total_cost: 50000, estimated_service_level: 0.92 },
      { estimated_total_cost: 55000, estimated_service_level: 0.96 }
    );
    expect(drift.estimated_total_cost.delta).toBe(5000);
    expect(drift.estimated_total_cost.pct_change).toBeCloseTo(0.1);
    expect(drift.estimated_service_level.delta).toBeCloseTo(0.04);
    expect(drift.estimated_service_level.pct_change).toBeCloseTo(0.0435, 2);
  });

  it('handles zero baseline gracefully', () => {
    const drift = computeKpiDrift({ stockout_units: 0 }, { stockout_units: 10 });
    expect(drift.stockout_units.delta).toBe(10);
    expect(drift.stockout_units.pct_change).toBe(Infinity);
  });

  it('returns empty for null inputs', () => {
    expect(computeKpiDrift(null, { cost: 100 })).toEqual({});
    expect(computeKpiDrift({ cost: 100 }, null)).toEqual({});
  });

  it('handles non-numeric values', () => {
    const drift = computeKpiDrift(
      { cost: 100, status: 'optimal' },
      { cost: 120, status: 'infeasible' }
    );
    expect(drift.cost).toBeTruthy();
    expect(drift.status).toBeUndefined(); // Non-numeric skipped
  });
});

describe('checkBaselineStaleness', () => {
  it('returns stale for no baseline', () => {
    const result = checkBaselineStaleness({ baseline: null });
    expect(result.isStale).toBe(true);
    expect(result.reasons).toContain('No baseline exists');
  });

  it('detects age-based staleness', () => {
    const old = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString(); // 100h ago
    const result = checkBaselineStaleness({
      baseline: { created_at: old, kpis: {} },
    });
    expect(result.isStale).toBe(true);
    expect(result.reasons.some(r => r.includes('old'))).toBe(true);
    expect(result.age_hours).toBeGreaterThan(72);
  });

  it('detects data freshness staleness', () => {
    const baselineTime = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
    const dataTime = new Date().toISOString(); // now (after baseline)
    const result = checkBaselineStaleness({
      baseline: { created_at: baselineTime, kpis: {} },
      datasetUpdatedAt: dataTime,
    });
    expect(result.isStale).toBe(true);
    expect(result.reasons.some(r => r.includes('data has been updated'))).toBe(true);
  });

  it('detects KPI drift staleness', () => {
    const recent = new Date().toISOString();
    const result = checkBaselineStaleness({
      baseline: { created_at: recent, kpis: { estimated_total_cost: 50000 } },
      currentKpis: { estimated_total_cost: 60000 }, // 20% drift
    });
    expect(result.isStale).toBe(true);
    expect(result.reasons.some(r => r.includes('drift'))).toBe(true);
    expect(result.drift.estimated_total_cost.pct_change).toBeCloseTo(0.2);
  });

  it('returns not stale for fresh baseline with no drift', () => {
    const recent = new Date().toISOString();
    const result = checkBaselineStaleness({
      baseline: { created_at: recent, kpis: { cost: 100 } },
      currentKpis: { cost: 102 }, // 2% — below 10% threshold
    });
    expect(result.isStale).toBe(false);
    expect(result.reasons).toHaveLength(0);
  });
});

describe('buildBaselineComparison', () => {
  it('builds comparison with improved and degraded KPIs', () => {
    const comparison = buildBaselineComparison({
      baselineKpis: {
        estimated_total_cost: 55000,
        estimated_service_level: 0.92,
        stockout_units: 50,
      },
      currentKpis: {
        estimated_total_cost: 50000,    // improved (lower cost)
        estimated_service_level: 0.96,  // improved (higher SL)
        stockout_units: 60,             // degraded (more stockouts)
      },
      baselineRunId: 100,
      currentRunId: 200,
    });

    expect(comparison.baseline_run_id).toBe(100);
    expect(comparison.current_run_id).toBe(200);
    expect(comparison.improved.length).toBe(2); // cost down, SL up
    expect(comparison.degraded.length).toBe(1); // stockouts up
    expect(comparison.summary_text).toContain('run #100');
    expect(comparison.total_kpis).toBe(3);
  });

  it('handles unchanged KPIs', () => {
    const comparison = buildBaselineComparison({
      baselineKpis: { cost: 100 },
      currentKpis: { cost: 100 },
      baselineRunId: 1,
      currentRunId: 2,
    });
    expect(comparison.unchanged.length).toBe(1);
    expect(comparison.improved.length).toBe(0);
    expect(comparison.degraded.length).toBe(0);
  });
});

describe('buildStalenessWarningMessages', () => {
  it('returns empty for fresh baseline', () => {
    const msgs = buildStalenessWarningMessages({
      baseline: { created_at: new Date().toISOString(), kpis: {} },
    });
    expect(msgs).toHaveLength(0);
  });

  it('returns warning message for stale baseline', () => {
    const old = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
    const msgs = buildStalenessWarningMessages({
      baseline: { created_at: old, kpis: {} },
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('baseline_staleness_warning');
    expect(msgs[0].payload.reasons.length).toBeGreaterThan(0);
    expect(msgs[0].payload.suggested_actions.length).toBeGreaterThan(0);
  });
});
