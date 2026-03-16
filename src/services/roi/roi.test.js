/**
 * Tests for Phase 6 — ROI Tracking
 *
 *   - roiCalculators.js — 4 calculators + aggregate extractor + summary
 */

import { describe, it, expect } from 'vitest';
import {
  estimateStockoutPreventionValue,
  estimateCostSavings,
  estimateTimeSaved,
  estimateRevenueProtected,
  extractValueEvents,
  summarizeValueEvents,
  VALUE_TYPES,
  ROI_DEFAULTS,
} from './roiCalculators.js';

// ── estimateStockoutPreventionValue ─────────────────────────────────────────

describe('estimateStockoutPreventionValue', () => {
  it('calculates stockout prevention value', () => {
    const result = estimateStockoutPreventionValue({
      atRiskUnits: 100,
      margin: 50,
      probability: 0.8,
      avoidedDays: 3,
    });
    expect(result).toBeTruthy();
    expect(result.value_type).toBe(VALUE_TYPES.STOCKOUT_PREVENTED);
    expect(result.value_amount).toBe(12000); // 100 × 50 × 0.8 × 3
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(0.95);
    expect(result.calculation_method).toContain('100 units');
  });

  it('returns null for zero units', () => {
    expect(estimateStockoutPreventionValue({ atRiskUnits: 0 })).toBeNull();
  });

  it('uses default margin', () => {
    const result = estimateStockoutPreventionValue({ atRiskUnits: 10 });
    expect(result.value_amount).toBe(10 * ROI_DEFAULTS.avg_unit_margin);
  });

  it('caps confidence at 0.95', () => {
    const result = estimateStockoutPreventionValue({
      atRiskUnits: 100, probability: 1.0, avoidedDays: 1,
    });
    expect(result.confidence).toBeLessThanOrEqual(0.95);
  });
});

// ── estimateCostSavings ─────────────────────────────────────────────────────

describe('estimateCostSavings', () => {
  it('calculates cost savings', () => {
    const result = estimateCostSavings({
      optimizedCost: 40000,
      baselineCost: 50000,
    });
    expect(result).toBeTruthy();
    expect(result.value_type).toBe(VALUE_TYPES.COST_SAVED);
    expect(result.value_amount).toBe(10000);
    expect(result.baseline_reference.pct_saved).toBeCloseTo(0.2, 1);
  });

  it('returns null when no savings', () => {
    expect(estimateCostSavings({ optimizedCost: 50000, baselineCost: 40000 })).toBeNull();
  });

  it('returns null for zero baseline', () => {
    expect(estimateCostSavings({ optimizedCost: 100, baselineCost: 0 })).toBeNull();
  });

  it('returns null for missing values', () => {
    expect(estimateCostSavings({ optimizedCost: null, baselineCost: 50000 })).toBeNull();
  });

  it('scales confidence with savings magnitude', () => {
    const small = estimateCostSavings({ optimizedCost: 49000, baselineCost: 50000 }); // 2%
    const large = estimateCostSavings({ optimizedCost: 30000, baselineCost: 50000 }); // 40%
    expect(large.confidence).toBeGreaterThan(small.confidence);
  });
});

// ── estimateTimeSaved ───────────────────────────────────────────────────────

describe('estimateTimeSaved', () => {
  it('calculates time saved for replenishment workflow', () => {
    const result = estimateTimeSaved({
      workflowType: 'replenishment',
      completionConfidence: 0.9,
    });
    expect(result).toBeTruthy();
    expect(result.value_type).toBe(VALUE_TYPES.TIME_SAVED_HOURS);
    // 4h manual × 0.9 × $75/h = $270
    expect(result.value_amount).toBe(270);
    expect(result.baseline_reference.manual_hours).toBe(4);
  });

  it('uses default workflow hours', () => {
    const result = estimateTimeSaved({ workflowType: 'unknown_workflow' });
    expect(result.baseline_reference.manual_hours).toBe(ROI_DEFAULTS.manual_hours_by_workflow.default);
  });

  it('allows override of manual hours', () => {
    const result = estimateTimeSaved({ standardManualHours: 10, completionConfidence: 1.0 });
    expect(result.value_amount).toBe(10 * ROI_DEFAULTS.hourly_analyst_cost);
  });

  it('respects custom hourly cost', () => {
    const result = estimateTimeSaved({
      workflowType: 'forecast',
      completionConfidence: 1.0,
      hourlyCost: 100,
    });
    // 2h × 1.0 × $100 = $200
    expect(result.value_amount).toBe(200);
  });
});

// ── estimateRevenueProtected ────────────────────────────────────────────────

describe('estimateRevenueProtected', () => {
  it('calculates revenue protected', () => {
    const result = estimateRevenueProtected({
      serviceLevelDelta: 0.05,
      totalRevenue: 1000000,
    });
    expect(result).toBeTruthy();
    expect(result.value_type).toBe(VALUE_TYPES.REVENUE_PROTECTED);
    expect(result.value_amount).toBe(50000); // 5% × $1M
  });

  it('returns null for zero delta', () => {
    expect(estimateRevenueProtected({ serviceLevelDelta: 0, totalRevenue: 1000000 })).toBeNull();
  });

  it('returns null for negative delta', () => {
    expect(estimateRevenueProtected({ serviceLevelDelta: -0.05, totalRevenue: 1000000 })).toBeNull();
  });

  it('returns null for missing revenue', () => {
    expect(estimateRevenueProtected({ serviceLevelDelta: 0.05, totalRevenue: null })).toBeNull();
  });
});

// ── extractValueEvents ──────────────────────────────────────────────────────

describe('extractValueEvents', () => {
  const BRIEF = {
    summary: 'Test',
    recommended_action: 'replenish_now',
    confidence: 0.85,
    business_impact: {
      total_cost: 45000,
      stockouts_prevented: 140,
      service_level_impact: '+3.5%',
      units_affected: 1000,
    },
  };

  it('extracts all applicable value events from artifacts', () => {
    const events = extractValueEvents({
      decisionBrief: BRIEF,
      taskMeta: { id: 'task_1', workflowType: 'replenishment' },
      workerId: 'worker_1',
    });

    // Should have: stockout_prevented, cost_saved, time_saved, revenue_protected
    expect(events.length).toBeGreaterThanOrEqual(3);
    const types = events.map(e => e.value_type);
    expect(types).toContain(VALUE_TYPES.STOCKOUT_PREVENTED);
    expect(types).toContain(VALUE_TYPES.TIME_SAVED_HOURS);
    expect(types).toContain(VALUE_TYPES.COST_SAVED);
  });

  it('attaches task_id and worker_id', () => {
    const events = extractValueEvents({
      decisionBrief: BRIEF,
      taskMeta: { id: 'task_2', workflowType: 'replenishment' },
      workerId: 'worker_2',
    });
    for (const e of events) {
      expect(e.task_id).toBe('task_2');
      expect(e.worker_id).toBe('worker_2');
    }
  });

  it('returns time_saved even with minimal brief', () => {
    const events = extractValueEvents({
      decisionBrief: { confidence: 0.7, business_impact: {} },
      taskMeta: { id: 'task_3', workflowType: 'forecast' },
    });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].value_type).toBe(VALUE_TYPES.TIME_SAVED_HOURS);
  });

  it('returns empty for no brief', () => {
    const events = extractValueEvents({ taskMeta: { id: 'task_4' } });
    // Should still have time_saved
    expect(events.length).toBe(1);
  });
});

// ── summarizeValueEvents ────────────────────────────────────────────────────

describe('summarizeValueEvents', () => {
  it('aggregates value events', () => {
    const events = [
      { value_type: 'cost_saved', value_amount: 5000, confidence: 0.8 },
      { value_type: 'cost_saved', value_amount: 3000, confidence: 0.7 },
      { value_type: 'time_saved_hours', value_amount: 200, confidence: 0.9 },
    ];
    const summary = summarizeValueEvents(events);
    expect(summary.total_value).toBe(8200);
    expect(summary.event_count).toBe(3);
    expect(summary.by_type.cost_saved).toBe(8000);
    expect(summary.by_type.time_saved_hours).toBe(200);
    expect(summary.avg_confidence).toBe(0.8);
  });

  it('handles empty events', () => {
    const summary = summarizeValueEvents([]);
    expect(summary.total_value).toBe(0);
    expect(summary.event_count).toBe(0);
    expect(summary.avg_confidence).toBe(0);
  });

  it('handles null', () => {
    const summary = summarizeValueEvents(null);
    expect(summary.total_value).toBe(0);
  });
});
