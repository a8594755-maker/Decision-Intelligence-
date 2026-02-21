/**
 * Unit tests for forecastToPlanParams.js
 *
 * Test cases:
 *   T-FP1 – Calibrated forecast with good coverage → alpha=0.5
 *   T-FP2 – Uncalibrated forecast (calibration_passed=false) → alpha=0.8
 *   T-FP3 – Wide uncertainty (coverage > upper band) → alpha=1.0
 *   T-FP4 – Uncertainty widened vs previous → stockout_penalty increased
 *   T-FP5 – High-risk supplier → lead_time_buffer added
 *   T-FP6 – Per-SKU safety stock correctly computed
 *   T-FP7 – Determinism: identical inputs → identical output (minus timestamps)
 *   T-FP8 – Config overrides respected
 *   T-FP9 – Graceful degradation when calibrationMeta is null
 */

import { describe, it, expect } from 'vitest';
import { derivePlanningParams, aggregateUncertaintyWidth, aggregateP50 } from './forecastToPlanParams';
import { CLOSED_LOOP_CONFIG } from './closedLoopConfig';

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const BASIC_SERIES = [
  { sku: 'SKU-A', plant_id: 'P1', date: '2026-01-01', p10: 5, p50: 10, p90: 15 },
  { sku: 'SKU-A', plant_id: 'P1', date: '2026-01-02', p10: 6, p50: 12, p90: 18 },
  { sku: 'SKU-B', plant_id: 'P1', date: '2026-01-01', p10: 20, p50: 30, p90: 40 },
  { sku: 'SKU-B', plant_id: 'P1', date: '2026-01-02', p10: 22, p50: 32, p90: 42 }
];

const WIDENED_SERIES = [
  { sku: 'SKU-A', plant_id: 'P1', date: '2026-01-01', p10: 2, p50: 10, p90: 22 },
  { sku: 'SKU-A', plant_id: 'P1', date: '2026-01-02', p10: 3, p50: 12, p90: 25 },
  { sku: 'SKU-B', plant_id: 'P1', date: '2026-01-01', p10: 15, p50: 30, p90: 50 },
  { sku: 'SKU-B', plant_id: 'P1', date: '2026-01-02', p10: 17, p50: 32, p90: 52 }
];

const GOOD_CALIBRATION = {
  calibration_passed: true,
  coverage_10_90: 0.85,
  uncertainty_method: 'conformal'
};

const BAD_CALIBRATION = {
  calibration_passed: false,
  coverage_10_90: 0.55,
  uncertainty_method: 'conformal'
};

const WIDE_CALIBRATION = {
  calibration_passed: true,
  coverage_10_90: 0.97,  // > upper_band (0.95)
  uncertainty_method: 'conformal'
};

const HIGH_RISK_BUNDLE = {
  riskScores: [
    {
      entity_type: 'supplier_material',
      entity_id: 'SKU-A',
      material_code: 'SKU-A',
      plant_id: 'P1',
      risk_score: 75,
      metrics: { p90_delay_days: 8, overdue_ratio: 0.30, on_time_rate: 0.65, avg_delay_days: 5 }
    }
  ]
};

const LOW_RISK_BUNDLE = {
  riskScores: [
    {
      entity_type: 'supplier_material',
      entity_id: 'SKU-A',
      material_code: 'SKU-A',
      plant_id: 'P1',
      risk_score: 20,
      metrics: { p90_delay_days: 2, overdue_ratio: 0.05, on_time_rate: 0.95, avg_delay_days: 1 }
    }
  ]
};

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('derivePlanningParams', () => {
  it('T-FP1: calibrated forecast with good coverage uses alpha=0.5', () => {
    const result = derivePlanningParams({
      forecastBundle: { series: BASIC_SERIES },
      calibrationMeta: GOOD_CALIBRATION
    });

    expect(result.patch.safety_stock_alpha).toBe(CLOSED_LOOP_CONFIG.safety_stock_alpha_calibrated);
    expect(result.derived_values.effective_alpha).toBe(0.5);
    expect(result.derived_values.calibration_passed).toBe(true);
    expect(result.explanation.some(e => e.includes('R-CL1') && e.includes('Calibration passed'))).toBe(true);
  });

  it('T-FP2: uncalibrated forecast uses alpha=0.8', () => {
    const result = derivePlanningParams({
      forecastBundle: { series: BASIC_SERIES },
      calibrationMeta: BAD_CALIBRATION
    });

    expect(result.patch.safety_stock_alpha).toBe(CLOSED_LOOP_CONFIG.safety_stock_alpha_uncalibrated);
    expect(result.derived_values.effective_alpha).toBe(0.8);
    expect(result.explanation.some(e => e.includes('R-CL1') && e.includes('calibration failed'))).toBe(true);
  });

  it('T-FP3: wide uncertainty (coverage > upper_band) uses alpha=1.0', () => {
    const result = derivePlanningParams({
      forecastBundle: { series: BASIC_SERIES },
      calibrationMeta: WIDE_CALIBRATION
    });

    expect(result.patch.safety_stock_alpha).toBe(CLOSED_LOOP_CONFIG.safety_stock_alpha_wide_uncertainty);
    expect(result.derived_values.effective_alpha).toBe(1.0);
    expect(result.explanation.some(e => e.includes('R-CL1') && e.includes('wide uncertainty'))).toBe(true);
  });

  it('T-FP4: uncertainty widened vs previous increases stockout_penalty', () => {
    const result = derivePlanningParams({
      forecastBundle: { series: WIDENED_SERIES },
      calibrationMeta: GOOD_CALIBRATION,
      previousForecast: { series: BASIC_SERIES }
    });

    expect(result.patch.objective.stockout_penalty).toBeGreaterThan(CLOSED_LOOP_CONFIG.stockout_penalty_base);
    expect(result.patch.objective.stockout_penalty_base).toBe(CLOSED_LOOP_CONFIG.stockout_penalty_base);
    expect(result.derived_values.uncertainty_width_delta_pct).toBeGreaterThan(0);
    expect(result.explanation.some(e => e.includes('R-CL2'))).toBe(true);
  });

  it('T-FP4b: stable uncertainty does not increase stockout_penalty', () => {
    const result = derivePlanningParams({
      forecastBundle: { series: BASIC_SERIES },
      calibrationMeta: GOOD_CALIBRATION,
      previousForecast: { series: BASIC_SERIES }
    });

    expect(result.patch.objective.stockout_penalty).toBe(CLOSED_LOOP_CONFIG.stockout_penalty_base);
    expect(result.explanation.every(e => !e.includes('R-CL2'))).toBe(true);
  });

  it('T-FP5: high-risk supplier adds lead_time_buffer', () => {
    const result = derivePlanningParams({
      forecastBundle: { series: BASIC_SERIES },
      calibrationMeta: GOOD_CALIBRATION,
      riskBundle: HIGH_RISK_BUNDLE
    });

    expect(result.patch.lead_time_buffer_by_key['SKU-A|P1']).toBe(
      CLOSED_LOOP_CONFIG.lead_time_buffer_high_risk_days
    );
    expect(result.derived_values.risk_entities_above_threshold).toBe(1);
    expect(result.explanation.some(e => e.includes('R-CL3'))).toBe(true);
  });

  it('T-FP5b: low-risk supplier does not add lead_time_buffer', () => {
    const result = derivePlanningParams({
      forecastBundle: { series: BASIC_SERIES },
      calibrationMeta: GOOD_CALIBRATION,
      riskBundle: LOW_RISK_BUNDLE
    });

    expect(Object.keys(result.patch.lead_time_buffer_by_key)).toHaveLength(0);
    expect(result.derived_values.risk_entities_above_threshold).toBe(0);
  });

  it('T-FP6: per-SKU safety stock correctly computed', () => {
    const result = derivePlanningParams({
      forecastBundle: { series: BASIC_SERIES },
      calibrationMeta: GOOD_CALIBRATION
    });

    const alpha = 0.5;
    // SKU-A|P1: avg_p50=(10+12)/2=11, avg_p90=(15+18)/2=16.5 → 11 + 0.5*5.5 = 13.75
    expect(result.patch.safety_stock_by_key['SKU-A|P1']).toBeCloseTo(13.75, 4);
    // SKU-B|P1: avg_p50=(30+32)/2=31, avg_p90=(40+42)/2=41 → 31 + 0.5*10 = 36
    expect(result.patch.safety_stock_by_key['SKU-B|P1']).toBeCloseTo(36.0, 4);
  });

  it('T-FP7: determinism — identical inputs produce identical output', () => {
    const params = {
      forecastBundle: { series: BASIC_SERIES },
      calibrationMeta: GOOD_CALIBRATION,
      riskBundle: HIGH_RISK_BUNDLE,
      previousForecast: { series: BASIC_SERIES }
    };

    const result1 = derivePlanningParams(params);
    const result2 = derivePlanningParams(params);

    // Strip timestamps for comparison
    const strip = (r) => {
      const copy = JSON.parse(JSON.stringify(r));
      delete copy.generated_at;
      return copy;
    };

    expect(strip(result1)).toEqual(strip(result2));
  });

  it('T-FP8: config overrides respected', () => {
    const result = derivePlanningParams({
      forecastBundle: { series: BASIC_SERIES },
      calibrationMeta: GOOD_CALIBRATION,
      policyConfig: { safety_stock_alpha_calibrated: 0.3 }
    });

    expect(result.patch.safety_stock_alpha).toBe(0.3);
    expect(result.derived_values.effective_alpha).toBe(0.3);
  });

  it('T-FP9: graceful degradation when calibrationMeta is null', () => {
    const result = derivePlanningParams({
      forecastBundle: { series: BASIC_SERIES },
      calibrationMeta: null
    });

    expect(result.patch.safety_stock_alpha).toBe(CLOSED_LOOP_CONFIG.safety_stock_alpha_uncalibrated);
    expect(result.derived_values.calibration_passed).toBeNull();
    expect(result.derived_values.coverage_10_90).toBeNull();
    expect(result.explanation.some(e => e.includes('metadata absent'))).toBe(true);
  });

  it('T-FP9b: graceful degradation with empty object calibrationMeta', () => {
    const result = derivePlanningParams({
      forecastBundle: { series: BASIC_SERIES },
      calibrationMeta: {}
    });

    expect(result.patch.safety_stock_alpha).toBe(CLOSED_LOOP_CONFIG.safety_stock_alpha_uncalibrated);
  });

  it('returns correct structure with version and generated_at', () => {
    const result = derivePlanningParams({
      forecastBundle: { series: BASIC_SERIES }
    });

    expect(result.version).toBe('v0');
    expect(result.generated_at).toBeDefined();
    expect(result.patch).toBeDefined();
    expect(result.explanation).toBeInstanceOf(Array);
    expect(result.rules).toBeInstanceOf(Array);
    expect(result.derived_values).toBeDefined();
  });

  it('handles empty forecast series', () => {
    const result = derivePlanningParams({
      forecastBundle: { series: [] }
    });

    expect(Object.keys(result.patch.safety_stock_by_key)).toHaveLength(0);
  });

  it('handles missing forecastBundle', () => {
    const result = derivePlanningParams({});

    expect(result.patch.safety_stock_by_key).toBeDefined();
    expect(Object.keys(result.patch.safety_stock_by_key)).toHaveLength(0);
  });
});

describe('aggregateUncertaintyWidth', () => {
  it('computes sum of (p90 - p10) across all points', () => {
    const width = aggregateUncertaintyWidth(BASIC_SERIES);
    // (15-5) + (18-6) + (40-20) + (42-22) = 10 + 12 + 20 + 20 = 62
    expect(width).toBe(62);
  });

  it('returns 0 for empty series', () => {
    expect(aggregateUncertaintyWidth([])).toBe(0);
    expect(aggregateUncertaintyWidth(null)).toBe(0);
  });
});

describe('aggregateP50', () => {
  it('computes sum of p50 across all points', () => {
    const total = aggregateP50(BASIC_SERIES);
    // 10 + 12 + 30 + 32 = 84
    expect(total).toBe(84);
  });

  it('returns 0 for empty series', () => {
    expect(aggregateP50([])).toBe(0);
  });
});
