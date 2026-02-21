/**
 * Closed-Loop Audit Store v0
 *
 * In-memory persistence for closed-loop run records.
 * Each run captures trigger facts, decision, parameter patch, and outcome
 * for full auditability. Thread-safe within a single Node process.
 *
 * Pattern: mirrors InMemoryAsyncRunStore from async_runs.py
 */

import { CLOSED_LOOP_STATUS } from './closedLoopConfig.js';

// ─── ID generation ────────────────────────────────────────────────────────────

let _seq = 0;

function generateId() {
  _seq += 1;
  const ts = Date.now().toString(36);
  const seq = _seq.toString(36).padStart(4, '0');
  return `cl_run_${ts}_${seq}`;
}

/** Reset sequence counter (for testing only). */
export function _resetSequence() {
  _seq = 0;
}

// ─── ClosedLoopStore ──────────────────────────────────────────────────────────

export class ClosedLoopStore {
  constructor() {
    /** @type {Map<string, Object>} */
    this._runs = new Map();
  }

  /**
   * Create a new closed-loop run record.
   *
   * @param {Object} params
   * @param {string|number} params.dataset_id
   * @param {string|number} params.forecast_run_id
   * @param {string} params.mode            - 'dry_run' | 'auto_run' | 'manual_approve'
   * @param {Object} params.trigger_facts   - Snapshot of inputs at evaluation time
   * @returns {Object} The created ClosedLoopRun record
   */
  createRun({ dataset_id, forecast_run_id, mode = 'dry_run', trigger_facts = {} } = {}) {
    const id = generateId();
    const run = {
      id,
      dataset_id: dataset_id ?? null,
      forecast_run_id: forecast_run_id ?? null,
      created_at: new Date().toISOString(),
      status: CLOSED_LOOP_STATUS.NO_TRIGGER,
      mode,
      trigger_facts,
      trigger_decision: null,
      param_patch: null,
      planning_run_id: null,
      planning_run_status: null,
      outcome: null,
      cooldown_key: null,
      cooldown_expires_at: null,
      finished_at: null,
      error: null
    };
    this._runs.set(id, run);
    return { ...run };
  }

  /**
   * Update fields on an existing run.
   *
   * @param {string} id
   * @param {Object} patch - Fields to merge onto the run
   * @returns {Object|null} Updated run, or null if not found
   */
  updateRun(id, patch = {}) {
    const run = this._runs.get(id);
    if (!run) return null;

    const updated = { ...run, ...patch };
    this._runs.set(id, updated);
    return { ...updated };
  }

  /**
   * Get a run by ID.
   * @param {string} id
   * @returns {Object|null}
   */
  getRun(id) {
    const run = this._runs.get(id);
    return run ? { ...run } : null;
  }

  /**
   * Get all runs for a dataset, newest first.
   * @param {string|number} datasetId
   * @param {number} limit - Max results (default: 50)
   * @returns {Object[]}
   */
  getRunsByDataset(datasetId, limit = 50) {
    const results = [];
    for (const run of this._runs.values()) {
      if (String(run.dataset_id) === String(datasetId)) {
        results.push({ ...run });
      }
    }
    // Sort newest first; use ID as tiebreaker when timestamps match (sub-ms creation)
    results.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
    return results.slice(0, limit);
  }

  /**
   * Get the most recent run for a dataset.
   * @param {string|number} datasetId
   * @returns {Object|null}
   */
  getLatestRun(datasetId) {
    const runs = this.getRunsByDataset(datasetId, 1);
    return runs.length > 0 ? runs[0] : null;
  }

  /**
   * Purge runs older than maxAgeMs.
   * @param {number} maxAgeMs
   * @returns {number} Count of purged records
   */
  purgeOlderThan(maxAgeMs) {
    const cutoff = Date.now() - maxAgeMs;
    let count = 0;
    for (const [id, run] of this._runs) {
      if (new Date(run.created_at).getTime() < cutoff) {
        this._runs.delete(id);
        count += 1;
      }
    }
    return count;
  }

  /**
   * Dump all runs for debugging.
   * @returns {Object[]}
   */
  dump() {
    return Array.from(this._runs.values()).map((r) => ({ ...r }));
  }

  /**
   * Clear all records (for testing).
   */
  clear() {
    this._runs.clear();
  }

  /**
   * Count of stored runs.
   * @returns {number}
   */
  get size() {
    return this._runs.size;
  }
}

// ─── Singleton instance ───────────────────────────────────────────────────────

export const closedLoopStore = new ClosedLoopStore();
