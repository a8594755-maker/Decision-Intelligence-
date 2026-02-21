/**
 * Unit tests for triggerEngine.js
 *
 * Test cases:
 *   T-TE1  – Stable forecast, good calibration → no trigger
 *   T-TE2  – Coverage below lower band → trigger fires
 *   T-TE3  – Coverage above upper band → trigger fires
 *   T-TE4  – Uncertainty widens beyond threshold → trigger fires
 *   T-TE5  – P50 shifts beyond threshold → trigger fires
 *   T-TE6  – Risk severity crosses threshold → trigger fires
 *   T-TE7  – Multiple triggers fire simultaneously
 *   T-TE8  – Cooldown active → trigger suppressed
 *   T-TE9  – Cooldown expired → trigger fires normally
 *   T-TE10 – Dedupe key format correct
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  evaluateTriggers,
  createCooldownManager
} from './triggerEngine';
import { TRIGGER_TYPES, CLOSED_LOOP_CONFIG } from './closedLoopConfig';

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const STABLE_SERIES = [
  { sku: 'SKU-A', plant_id: 'P1', date: '2026-01-01', p10: 5, p50: 10, p90: 15 },
  { sku: 'SKU-A', plant_id: 'P1', date: '2026-01-02', p10: 6, p50: 12, p90: 18 }
];

const WIDENED_SERIES = [
  { sku: 'SKU-A', plant_id: 'P1', date: '2026-01-01', p10: 2, p50: 10, p90: 24 },
  { sku: 'SKU-A', plant_id: 'P1', date: '2026-01-02', p10: 3, p50: 12, p90: 27 }
];

const SHIFTED_P50_SERIES = [
  { sku: 'SKU-A', plant_id: 'P1', date: '2026-01-01', p10: 5, p50: 15, p90: 20 },
  { sku: 'SKU-A', plant_id: 'P1', date: '2026-01-02', p10: 6, p50: 18, p90: 24 }
];

const GOOD_CALIBRATION = {
  calibration_passed: true,
  coverage_10_90: 0.85,
  uncertainty_method: 'conformal'
};

const LOW_COVERAGE_CALIBRATION = {
  calibration_passed: false,
  coverage_10_90: 0.55    // < lower_band (0.70)
};

const HIGH_COVERAGE_CALIBRATION = {
  calibration_passed: true,
  coverage_10_90: 0.97    // > upper_band (0.95)
};

const HIGH_RISK_BUNDLE = {
  riskScores: [
    {
      entity_type: 'supplier_material',
      material_code: 'SKU-A',
      plant_id: 'P1',
      risk_score: 80,
      metrics: { p90_delay_days: 8 }
    }
  ]
};

const LOW_RISK_BUNDLE = {
  riskScores: [
    {
      entity_type: 'supplier_material',
      material_code: 'SKU-A',
      plant_id: 'P1',
      risk_score: 20,
      metrics: { p90_delay_days: 1 }
    }
  ]
};

function baseContext(overrides = {}) {
  return {
    dataset_id: 'ds_123',
    forecast_run_id: 'fr_456',
    currentForecast: { series: STABLE_SERIES },
    previousForecast: { series: STABLE_SERIES },
    calibrationMeta: GOOD_CALIBRATION,
    riskBundle: LOW_RISK_BUNDLE,
    cooldownManager: createCooldownManager(),
    ...overrides
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('evaluateTriggers', () => {
  it('T-TE1: stable forecast with good calibration → no trigger', () => {
    const result = evaluateTriggers(baseContext());

    expect(result.should_trigger).toBe(false);
    expect(result.reasons).toHaveLength(0);
    expect(result.cooldown_active).toBe(false);
    expect(result.suppressed_by_cooldown).toBe(false);
  });

  it('T-TE2: coverage below lower band → trigger fires', () => {
    const result = evaluateTriggers(baseContext({
      calibrationMeta: LOW_COVERAGE_CALIBRATION
    }));

    expect(result.should_trigger).toBe(true);
    expect(result.reasons.some(r => r.trigger_type === TRIGGER_TYPES.COVERAGE_OUTSIDE_BAND)).toBe(true);
    const reason = result.reasons.find(r => r.trigger_type === TRIGGER_TYPES.COVERAGE_OUTSIDE_BAND);
    expect(reason.severity).toBe('high');
    expect(reason.evidence.direction).toBe('below');
  });

  it('T-TE3: coverage above upper band → trigger fires', () => {
    const result = evaluateTriggers(baseContext({
      calibrationMeta: HIGH_COVERAGE_CALIBRATION
    }));

    expect(result.should_trigger).toBe(true);
    const reason = result.reasons.find(r => r.trigger_type === TRIGGER_TYPES.COVERAGE_OUTSIDE_BAND);
    expect(reason.evidence.direction).toBe('above');
    expect(reason.severity).toBe('medium');
  });

  it('T-TE4: uncertainty widens beyond threshold → trigger fires', () => {
    const result = evaluateTriggers(baseContext({
      currentForecast: { series: WIDENED_SERIES },
      previousForecast: { series: STABLE_SERIES },
      calibrationMeta: GOOD_CALIBRATION
    }));

    expect(result.should_trigger).toBe(true);
    const reason = result.reasons.find(r => r.trigger_type === TRIGGER_TYPES.UNCERTAINTY_WIDENS);
    expect(reason).toBeDefined();
    expect(reason.evidence.delta_pct).toBeGreaterThan(CLOSED_LOOP_CONFIG.uncertainty_width_change_pct);
  });

  it('T-TE5: P50 shifts beyond threshold → trigger fires', () => {
    const result = evaluateTriggers(baseContext({
      currentForecast: { series: SHIFTED_P50_SERIES },
      previousForecast: { series: STABLE_SERIES },
      calibrationMeta: GOOD_CALIBRATION
    }));

    expect(result.should_trigger).toBe(true);
    const reason = result.reasons.find(r => r.trigger_type === TRIGGER_TYPES.P50_SHIFT);
    expect(reason).toBeDefined();
    expect(Math.abs(reason.evidence.shift_pct)).toBeGreaterThan(CLOSED_LOOP_CONFIG.p50_shift_pct);
  });

  it('T-TE6: risk severity crosses threshold → trigger fires', () => {
    const result = evaluateTriggers(baseContext({
      riskBundle: HIGH_RISK_BUNDLE,
      // Stable everything else so only risk triggers
      calibrationMeta: GOOD_CALIBRATION
    }));

    expect(result.should_trigger).toBe(true);
    const reason = result.reasons.find(r => r.trigger_type === TRIGGER_TYPES.RISK_SEVERITY_CROSSED);
    expect(reason).toBeDefined();
    expect(reason.evidence.max_risk_score).toBe(80);
  });

  it('T-TE7: multiple triggers fire simultaneously', () => {
    const result = evaluateTriggers(baseContext({
      currentForecast: { series: WIDENED_SERIES },
      previousForecast: { series: STABLE_SERIES },
      calibrationMeta: LOW_COVERAGE_CALIBRATION,
      riskBundle: HIGH_RISK_BUNDLE
    }));

    expect(result.should_trigger).toBe(true);
    const types = result.reasons.map(r => r.trigger_type);
    expect(types).toContain(TRIGGER_TYPES.COVERAGE_OUTSIDE_BAND);
    expect(types).toContain(TRIGGER_TYPES.UNCERTAINTY_WIDENS);
    expect(types).toContain(TRIGGER_TYPES.RISK_SEVERITY_CROSSED);
    expect(result.reasons.length).toBeGreaterThanOrEqual(3);
  });

  it('T-TE8: cooldown active → trigger suppressed', () => {
    const manager = createCooldownManager();
    // First evaluation: trigger fires
    const first = evaluateTriggers(baseContext({
      calibrationMeta: LOW_COVERAGE_CALIBRATION,
      cooldownManager: manager
    }));
    expect(first.should_trigger).toBe(true);

    // Record cooldown
    manager.record(first.dedupe_key);

    // Second evaluation with same key: suppressed
    const second = evaluateTriggers(baseContext({
      calibrationMeta: LOW_COVERAGE_CALIBRATION,
      cooldownManager: manager
    }));
    expect(second.should_trigger).toBe(false);
    expect(second.suppressed_by_cooldown).toBe(true);
    expect(second.cooldown_active).toBe(true);
    expect(second.reasons.length).toBeGreaterThan(0); // reasons still detected
  });

  it('T-TE9: cooldown expired → trigger fires normally', () => {
    const manager = createCooldownManager({ default_cooldown_ms: 1 }); // 1ms cooldown
    // First trigger
    const first = evaluateTriggers(baseContext({
      calibrationMeta: LOW_COVERAGE_CALIBRATION,
      cooldownManager: manager
    }));
    expect(first.should_trigger).toBe(true);
    manager.record(first.dedupe_key, 1); // 1ms cooldown

    // Wait for expiration
    return new Promise((resolve) => {
      setTimeout(() => {
        const second = evaluateTriggers(baseContext({
          calibrationMeta: LOW_COVERAGE_CALIBRATION,
          cooldownManager: manager
        }));
        expect(second.should_trigger).toBe(true);
        expect(second.suppressed_by_cooldown).toBe(false);
        resolve();
      }, 10); // 10ms wait, cooldown was 1ms
    });
  });

  it('T-TE10: dedupe key format is correct', () => {
    const result = evaluateTriggers(baseContext({
      calibrationMeta: LOW_COVERAGE_CALIBRATION
    }));

    // Key should contain dataset_id, trigger type(s), ISO week, forecast_run_id
    expect(result.dedupe_key).toContain('ds_123');
    expect(result.dedupe_key).toContain('fr_456');
    expect(result.dedupe_key).toContain(TRIGGER_TYPES.COVERAGE_OUTSIDE_BAND);
    // Should contain ISO week format
    expect(result.dedupe_key).toMatch(/\d{4}-W\d{2}/);
  });

  it('returns correct structure when no triggers fire', () => {
    const result = evaluateTriggers(baseContext());

    expect(result).toHaveProperty('should_trigger');
    expect(result).toHaveProperty('reasons');
    expect(result).toHaveProperty('dedupe_key');
    expect(result).toHaveProperty('cooldown_active');
    expect(result).toHaveProperty('suppressed_by_cooldown');
    expect(result).toHaveProperty('evaluated_at');
  });

  it('skips coverage check when calibrationMeta is null', () => {
    const result = evaluateTriggers(baseContext({
      calibrationMeta: null
    }));

    expect(result.reasons.filter(
      r => r.trigger_type === TRIGGER_TYPES.COVERAGE_OUTSIDE_BAND
    )).toHaveLength(0);
  });

  it('skips uncertainty/p50 checks when no previous forecast', () => {
    const result = evaluateTriggers(baseContext({
      previousForecast: null,
      calibrationMeta: GOOD_CALIBRATION,
      riskBundle: LOW_RISK_BUNDLE
    }));

    expect(result.reasons.filter(r =>
      r.trigger_type === TRIGGER_TYPES.UNCERTAINTY_WIDENS ||
      r.trigger_type === TRIGGER_TYPES.P50_SHIFT
    )).toHaveLength(0);
  });
});

describe('createCooldownManager', () => {
  let manager;

  beforeEach(() => {
    manager = createCooldownManager();
  });

  it('check returns inactive for unknown key', () => {
    const result = manager.check('unknown_key');
    expect(result.active).toBe(false);
    expect(result.expires_at).toBeNull();
  });

  it('record + check returns active', () => {
    manager.record('test_key', 60000);
    const result = manager.check('test_key');
    expect(result.active).toBe(true);
    expect(result.expires_at).toBeDefined();
  });

  it('reset clears specific key', () => {
    manager.record('key_a', 60000);
    manager.record('key_b', 60000);
    manager.reset('key_a');

    expect(manager.check('key_a').active).toBe(false);
    expect(manager.check('key_b').active).toBe(true);
  });

  it('reset with no args clears all', () => {
    manager.record('key_a', 60000);
    manager.record('key_b', 60000);
    manager.reset();

    expect(manager.check('key_a').active).toBe(false);
    expect(manager.check('key_b').active).toBe(false);
  });

  it('dump returns active entries', () => {
    manager.record('key_a', 60000);
    const dumped = manager.dump();
    expect(dumped).toHaveProperty('key_a');
    expect(dumped.key_a).toHaveProperty('recorded_at');
    expect(dumped.key_a).toHaveProperty('expires_at');
  });

  it('respects max_cooldown_ms cap', () => {
    const shortManager = createCooldownManager({ max_cooldown_ms: 100 });
    shortManager.record('key_a', 999999); // Try to exceed max
    const dumped = shortManager.dump();
    const entry = dumped.key_a;
    const duration = new Date(entry.expires_at) - new Date(entry.recorded_at);
    expect(duration).toBeLessThanOrEqual(100);
  });
});
