/**
 * Unit tests for closedLoopRunner.js
 *
 * Test cases:
 *   T-CR1 – Feature flag disabled → NOT_ENABLED
 *   T-CR2 – No trigger fired → NO_TRIGGER
 *   T-CR3 – Trigger + dry_run → TRIGGERED_DRY_RUN, no plan call
 *   T-CR4 – Trigger + auto_run → calls planRunner, returns RERUN_COMPLETED
 *   T-CR5 – Error during plan submission → ERROR, base plan unaffected
 *   T-CR6 – Audit record persisted correctly in store
 *   T-CR7 – Cooldown prevents second trigger
 *   T-CR8 – manual_approve mode returns requires_approval=true
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runClosedLoop, isClosedLoopEnabled } from './closedLoopRunner';
import { ClosedLoopStore, _resetSequence } from './closedLoopStore';
import { createCooldownManager } from './triggerEngine';
import { CLOSED_LOOP_STATUS } from './closedLoopConfig';

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const STABLE_SERIES = [
  { sku: 'SKU-A', plant_id: 'P1', date: '2026-01-01', p10: 5, p50: 10, p90: 15 },
  { sku: 'SKU-A', plant_id: 'P1', date: '2026-01-02', p10: 6, p50: 12, p90: 18 }
];

const LOW_COVERAGE_CALIBRATION = {
  calibration_passed: false,
  coverage_10_90: 0.55
};

const GOOD_CALIBRATION = {
  calibration_passed: true,
  coverage_10_90: 0.85
};

const PROFILE_ROW = { id: 42, name: 'test-profile' };

function baseParams(overrides = {}) {
  return {
    userId: 'user_1',
    datasetProfileRow: PROFILE_ROW,
    forecastRunId: 'fr_100',
    forecastBundle: { series: STABLE_SERIES, metrics: { mape: 0.1 } },
    calibrationMeta: GOOD_CALIBRATION,
    previousForecast: { series: STABLE_SERIES },
    riskBundle: null,
    settings: { closed_loop: 'on' },
    mode: 'dry_run',
    configOverrides: {},
    ...overrides
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('isClosedLoopEnabled', () => {
  it('returns false with empty settings', () => {
    expect(isClosedLoopEnabled({})).toBe(false);
  });

  it('returns true when settings.closed_loop = "on"', () => {
    expect(isClosedLoopEnabled({ closed_loop: 'on' })).toBe(true);
  });

  it('returns true when settings.plan.closed_loop = "on"', () => {
    expect(isClosedLoopEnabled({ plan: { closed_loop: 'on' } })).toBe(true);
  });

  it('returns true when settings.closed_loop = true', () => {
    expect(isClosedLoopEnabled({ closed_loop: true })).toBe(true);
  });
});

describe('runClosedLoop', () => {
  let store;
  let cooldownManager;

  beforeEach(() => {
    store = new ClosedLoopStore();
    cooldownManager = createCooldownManager();
    _resetSequence();
  });

  it('T-CR1: feature flag disabled → NOT_ENABLED', async () => {
    const result = await runClosedLoop({
      ...baseParams({ settings: {} }), // no closed_loop flag
      store,
      cooldownManager
    });

    expect(result.closed_loop_status).toBe(CLOSED_LOOP_STATUS.NOT_ENABLED);
    expect(result.closed_loop_run_id).toBeNull();
    expect(result.trigger_decision).toBeNull();
  });

  it('T-CR2: no trigger fired → NO_TRIGGER', async () => {
    const result = await runClosedLoop({
      ...baseParams(),
      store,
      cooldownManager
    });

    expect(result.closed_loop_status).toBe(CLOSED_LOOP_STATUS.NO_TRIGGER);
    expect(result.closed_loop_run_id).toBeDefined();
    expect(result.trigger_decision.should_trigger).toBe(false);
    expect(result.param_patch).toBeNull();
  });

  it('T-CR3: trigger + dry_run → TRIGGERED_DRY_RUN, no plan call', async () => {
    const mockPlanRunner = vi.fn();

    const result = await runClosedLoop({
      ...baseParams({
        calibrationMeta: LOW_COVERAGE_CALIBRATION,
        mode: 'dry_run'
      }),
      planRunner: mockPlanRunner,
      store,
      cooldownManager
    });

    expect(result.closed_loop_status).toBe(CLOSED_LOOP_STATUS.TRIGGERED_DRY_RUN);
    expect(result.trigger_decision.should_trigger).toBe(true);
    expect(result.param_patch).toBeDefined();
    expect(result.param_patch.patch.safety_stock_alpha).toBe(0.8); // uncalibrated
    expect(result.planning_run_id).toBeNull();
    expect(mockPlanRunner).not.toHaveBeenCalled();
  });

  it('T-CR4: trigger + auto_run → calls planRunner, returns RERUN_COMPLETED', async () => {
    const mockPlanResult = {
      run: { id: 999 },
      solver_result: {
        status: 'feasible',
        kpis: { estimated_total_cost: 42.0 }
      }
    };
    const mockPlanRunner = vi.fn().mockResolvedValue(mockPlanResult);

    const result = await runClosedLoop({
      ...baseParams({
        calibrationMeta: LOW_COVERAGE_CALIBRATION,
        mode: 'auto_run'
      }),
      planRunner: mockPlanRunner,
      store,
      cooldownManager
    });

    expect(result.closed_loop_status).toBe(CLOSED_LOOP_STATUS.RERUN_COMPLETED);
    expect(result.planning_run_id).toBe(999);
    expect(result.planning_run_result).toBe(mockPlanResult);
    expect(mockPlanRunner).toHaveBeenCalledOnce();

    // Verify planRunner was called with patched objective
    const callArgs = mockPlanRunner.mock.calls[0][0];
    expect(callArgs.userId).toBe('user_1');
    expect(callArgs.forecastRunId).toBe('fr_100');
    expect(callArgs.objectiveOverride).toBeDefined();
    expect(callArgs.settings.closed_loop_meta).toBeDefined();
  });

  it('T-CR5: error during plan submission → ERROR', async () => {
    const mockPlanRunner = vi.fn().mockRejectedValue(new Error('Solver timeout'));

    const result = await runClosedLoop({
      ...baseParams({
        calibrationMeta: LOW_COVERAGE_CALIBRATION,
        mode: 'auto_run'
      }),
      planRunner: mockPlanRunner,
      store,
      cooldownManager
    });

    expect(result.closed_loop_status).toBe(CLOSED_LOOP_STATUS.ERROR);
    expect(result.explanation[0]).toContain('Solver timeout');

    // Verify store records error
    const storedRun = store.getRun(result.closed_loop_run_id);
    expect(storedRun.status).toBe(CLOSED_LOOP_STATUS.ERROR);
    expect(storedRun.error).toContain('Solver timeout');
  });

  it('T-CR6: audit record persisted correctly in store', async () => {
    const result = await runClosedLoop({
      ...baseParams({
        calibrationMeta: LOW_COVERAGE_CALIBRATION,
        mode: 'dry_run'
      }),
      store,
      cooldownManager
    });

    const storedRun = store.getRun(result.closed_loop_run_id);
    expect(storedRun).not.toBeNull();
    expect(storedRun.dataset_id).toBe(42);
    expect(storedRun.forecast_run_id).toBe('fr_100');
    expect(storedRun.mode).toBe('dry_run');
    expect(storedRun.trigger_facts.calibration_meta).toEqual(LOW_COVERAGE_CALIBRATION);
    expect(storedRun.trigger_decision.should_trigger).toBe(true);
    expect(storedRun.param_patch).toBeDefined();
    expect(storedRun.status).toBe(CLOSED_LOOP_STATUS.TRIGGERED_DRY_RUN);
    expect(storedRun.finished_at).toBeDefined();
  });

  it('T-CR7: cooldown prevents second trigger', async () => {
    // First run: triggers
    const first = await runClosedLoop({
      ...baseParams({
        calibrationMeta: LOW_COVERAGE_CALIBRATION,
        mode: 'dry_run'
      }),
      store,
      cooldownManager
    });
    expect(first.closed_loop_status).toBe(CLOSED_LOOP_STATUS.TRIGGERED_DRY_RUN);

    // Second run: same dataset + forecast → suppressed by cooldown
    const second = await runClosedLoop({
      ...baseParams({
        calibrationMeta: LOW_COVERAGE_CALIBRATION,
        mode: 'dry_run'
      }),
      store,
      cooldownManager
    });
    expect(second.closed_loop_status).toBe(CLOSED_LOOP_STATUS.NO_TRIGGER);
    expect(second.explanation[0]).toContain('suppressed');
  });

  it('T-CR8: manual_approve mode returns requires_approval', async () => {
    const result = await runClosedLoop({
      ...baseParams({
        calibrationMeta: LOW_COVERAGE_CALIBRATION,
        mode: 'manual_approve'
      }),
      store,
      cooldownManager
    });

    expect(result.closed_loop_status).toBe(CLOSED_LOOP_STATUS.TRIGGERED_DRY_RUN);
    expect(result.requires_approval).toBe(true);
    expect(result.param_patch).toBeDefined();
  });

  it('persists artifact via injected artifactSaver', async () => {
    const mockSaver = vi.fn().mockResolvedValue({ id: 'art_1' });

    await runClosedLoop({
      ...baseParams({
        calibrationMeta: LOW_COVERAGE_CALIBRATION,
        mode: 'dry_run'
      }),
      artifactSaver: mockSaver,
      store,
      cooldownManager
    });

    expect(mockSaver).toHaveBeenCalledTimes(2); // audit + param_patch
    expect(mockSaver.mock.calls[0][1]).toBe('closed_loop_audit');
    expect(mockSaver.mock.calls[1][1]).toBe('closed_loop_param_patch');
  });

  it('handles artifact save failure gracefully', async () => {
    const mockSaver = vi.fn().mockRejectedValue(new Error('DB down'));

    const result = await runClosedLoop({
      ...baseParams({
        calibrationMeta: LOW_COVERAGE_CALIBRATION,
        mode: 'dry_run'
      }),
      artifactSaver: mockSaver,
      store,
      cooldownManager
    });

    // Should still succeed overall
    expect(result.closed_loop_status).toBe(CLOSED_LOOP_STATUS.TRIGGERED_DRY_RUN);
  });
});
