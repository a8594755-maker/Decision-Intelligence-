/**
 * Unit tests for closedLoopStore.js
 *
 * Test cases:
 *   T-ST1 – Create a run and retrieve by ID
 *   T-ST2 – Update a run status
 *   T-ST3 – Get latest run by dataset
 *   T-ST4 – Purge old runs
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ClosedLoopStore, _resetSequence } from './closedLoopStore';
import { CLOSED_LOOP_STATUS } from './closedLoopConfig';

describe('ClosedLoopStore', () => {
  let store;

  beforeEach(() => {
    store = new ClosedLoopStore();
    _resetSequence();
  });

  it('T-ST1: create a run and retrieve by ID', () => {
    const run = store.createRun({
      dataset_id: 'ds_1',
      forecast_run_id: 'fr_10',
      mode: 'dry_run',
      trigger_facts: { some: 'data' }
    });

    expect(run.id).toMatch(/^cl_run_/);
    expect(run.dataset_id).toBe('ds_1');
    expect(run.forecast_run_id).toBe('fr_10');
    expect(run.mode).toBe('dry_run');
    expect(run.status).toBe(CLOSED_LOOP_STATUS.NO_TRIGGER);
    expect(run.created_at).toBeDefined();
    expect(run.trigger_facts).toEqual({ some: 'data' });

    const retrieved = store.getRun(run.id);
    expect(retrieved).toEqual(run);
  });

  it('T-ST1b: getRun returns null for unknown ID', () => {
    expect(store.getRun('nonexistent')).toBeNull();
  });

  it('T-ST2: update a run status', () => {
    const run = store.createRun({ dataset_id: 'ds_1' });

    const updated = store.updateRun(run.id, {
      status: CLOSED_LOOP_STATUS.TRIGGERED_DRY_RUN,
      trigger_decision: { should_trigger: true, reasons: ['coverage_outside_band'] },
      param_patch: { safety_stock_alpha: 0.8 }
    });

    expect(updated.status).toBe(CLOSED_LOOP_STATUS.TRIGGERED_DRY_RUN);
    expect(updated.trigger_decision.should_trigger).toBe(true);
    expect(updated.param_patch.safety_stock_alpha).toBe(0.8);
    expect(updated.dataset_id).toBe('ds_1'); // original fields preserved

    // Re-read to verify persistence
    expect(store.getRun(run.id).status).toBe(CLOSED_LOOP_STATUS.TRIGGERED_DRY_RUN);
  });

  it('T-ST2b: updateRun returns null for unknown ID', () => {
    expect(store.updateRun('nonexistent', { status: 'ERROR' })).toBeNull();
  });

  it('T-ST3: get latest run by dataset', () => {
    store.createRun({ dataset_id: 'ds_1', forecast_run_id: 'fr_1' });
    store.createRun({ dataset_id: 'ds_1', forecast_run_id: 'fr_2' });
    store.createRun({ dataset_id: 'ds_2', forecast_run_id: 'fr_3' });

    const latest = store.getLatestRun('ds_1');
    expect(latest).not.toBeNull();
    expect(latest.forecast_run_id).toBe('fr_2'); // most recent

    const allDs1 = store.getRunsByDataset('ds_1');
    expect(allDs1).toHaveLength(2);
    expect(allDs1[0].forecast_run_id).toBe('fr_2'); // newest first
  });

  it('T-ST3b: getLatestRun returns null for empty dataset', () => {
    expect(store.getLatestRun('ds_nonexistent')).toBeNull();
  });

  it('T-ST4: purge old runs', () => {
    // Create runs
    const run1 = store.createRun({ dataset_id: 'ds_1' });
    store.createRun({ dataset_id: 'ds_1' });

    // Manually backdate run1
    store.updateRun(run1.id, {
      created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() // 2 hours ago
    });

    // Purge runs older than 1 hour
    const purged = store.purgeOlderThan(60 * 60 * 1000);
    expect(purged).toBe(1);
    expect(store.size).toBe(1);
  });

  it('clear removes all runs', () => {
    store.createRun({ dataset_id: 'ds_1' });
    store.createRun({ dataset_id: 'ds_2' });
    expect(store.size).toBe(2);

    store.clear();
    expect(store.size).toBe(0);
    expect(store.dump()).toHaveLength(0);
  });

  it('dump returns all runs', () => {
    store.createRun({ dataset_id: 'ds_1' });
    store.createRun({ dataset_id: 'ds_2' });

    const all = store.dump();
    expect(all).toHaveLength(2);
  });

  it('returns immutable copies (no mutation through returned objects)', () => {
    const run = store.createRun({ dataset_id: 'ds_1' });
    run.status = 'HACKED';

    // The store should not be affected
    const stored = store.getRun(run.id);
    expect(stored.status).toBe(CLOSED_LOOP_STATUS.NO_TRIGGER);
  });

  it('getRunsByDataset respects limit', () => {
    for (let i = 0; i < 5; i++) {
      store.createRun({ dataset_id: 'ds_1', forecast_run_id: `fr_${i}` });
    }

    const limited = store.getRunsByDataset('ds_1', 2);
    expect(limited).toHaveLength(2);
  });
});
