/**
 * Closed-Loop Persistence Layer
 *
 * Durable Supabase-backed persistence for closed-loop run records.
 * Wraps the in-memory ClosedLoopStore with DB persistence for audit trail.
 * Falls back to in-memory store when Supabase is unavailable.
 *
 * Table: di_closed_loop_runs
 */

import { supabase } from '../supabaseClient.js';
import { closedLoopStore } from './closedLoopStore.js';
import { CLOSED_LOOP_STATUS } from './closedLoopConfig.js';

const TABLE = 'di_closed_loop_runs';

// ── Helpers ─────────────────────────────────────────────────────────────────

async function trySupabase(fn) {
  try {
    return await fn();
  } catch (err) {
    console.warn('[closedLoopPersistence] Supabase error (falling back to local):', err.message);
    return null;
  }
}

// ── Persistent Store ────────────────────────────────────────────────────────

/**
 * Create a new closed-loop run with DB persistence.
 * Writes to both Supabase and in-memory store.
 */
export async function createRun({ dataset_id, forecast_run_id, mode = 'dry_run', trigger_facts = {}, user_id = null }) {
  // Create in-memory first for immediate availability
  const memRun = closedLoopStore.createRun({ dataset_id, forecast_run_id, mode, trigger_facts });

  // Persist to DB
  const dbRow = {
    id: memRun.id,
    dataset_id: dataset_id ?? null,
    forecast_run_id: forecast_run_id ?? null,
    user_id,
    mode,
    status: memRun.status,
    trigger_facts,
    trigger_decision: null,
    param_patch: null,
    planning_run_id: null,
    planning_run_status: null,
    outcome: null,
    cooldown_key: null,
    cooldown_expires_at: null,
    error: null,
    created_at: memRun.created_at,
    finished_at: null,
  };

  await trySupabase(async () => {
    const { error } = await supabase.from(TABLE).insert([dbRow]);
    if (error) throw error;
  });

  return memRun;
}

/**
 * Update a closed-loop run with DB persistence.
 */
export async function updateRun(id, patch = {}) {
  const updated = closedLoopStore.updateRun(id, patch);
  if (!updated) return null;

  await trySupabase(async () => {
    const dbPatch = { ...patch };
    // Ensure JSON fields are serializable
    if (dbPatch.trigger_facts && typeof dbPatch.trigger_facts === 'object') {
      dbPatch.trigger_facts = JSON.parse(JSON.stringify(dbPatch.trigger_facts));
    }
    if (dbPatch.param_patch && typeof dbPatch.param_patch === 'object') {
      dbPatch.param_patch = JSON.parse(JSON.stringify(dbPatch.param_patch));
    }
    if (dbPatch.outcome && typeof dbPatch.outcome === 'object') {
      dbPatch.outcome = JSON.parse(JSON.stringify(dbPatch.outcome));
    }
    const { error } = await supabase.from(TABLE).update(dbPatch).eq('id', id);
    if (error) throw error;
  });

  return updated;
}

/**
 * Complete a run: set status, outcome, and finished timestamp.
 */
export async function completeRun(id, { status, outcome = null, error: errorMsg = null }) {
  return updateRun(id, {
    status: status || CLOSED_LOOP_STATUS.RERUN_COMPLETED,
    outcome,
    error: errorMsg,
    finished_at: new Date().toISOString(),
  });
}

/**
 * Mark a run as errored.
 */
export async function errorRun(id, errorMessage) {
  return updateRun(id, {
    status: CLOSED_LOOP_STATUS.ERROR,
    error: errorMessage,
    finished_at: new Date().toISOString(),
  });
}

/**
 * Get run by ID — tries memory first, falls back to DB.
 */
export async function getRun(id) {
  const memRun = closedLoopStore.getRun(id);
  if (memRun) return memRun;

  const dbRun = await trySupabase(async () => {
    const { data, error } = await supabase.from(TABLE).select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data;
  });

  return dbRun;
}

/**
 * Get runs for a dataset — combines memory + DB results.
 */
export async function getRunsByDataset(datasetId, { limit = 50 } = {}) {
  // Try DB first for comprehensive history
  const dbRuns = await trySupabase(async () => {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('dataset_id', String(datasetId))
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data;
  });

  if (dbRuns && dbRuns.length > 0) return dbRuns;

  // Fallback to in-memory
  return closedLoopStore.getRunsByDataset(datasetId, limit);
}

/**
 * Get the most recent run for a dataset.
 */
export async function getLatestRun(datasetId) {
  const runs = await getRunsByDataset(datasetId, { limit: 1 });
  return runs.length > 0 ? runs[0] : null;
}

/**
 * Get runs by user for audit trail display.
 */
export async function getRunsByUser(userId, { limit = 50, status } = {}) {
  const result = await trySupabase(async () => {
    let query = supabase
      .from(TABLE)
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw error;
    return data;
  });

  return result || [];
}

/**
 * Get aggregate statistics for closed-loop runs.
 */
export async function getRunStats(userId) {
  const runs = await getRunsByUser(userId, { limit: 500 });

  return {
    total: runs.length,
    by_status: {
      no_trigger: runs.filter(r => r.status === CLOSED_LOOP_STATUS.NO_TRIGGER).length,
      triggered_dry_run: runs.filter(r => r.status === CLOSED_LOOP_STATUS.TRIGGERED_DRY_RUN).length,
      rerun_submitted: runs.filter(r => r.status === CLOSED_LOOP_STATUS.RERUN_SUBMITTED).length,
      rerun_completed: runs.filter(r => r.status === CLOSED_LOOP_STATUS.RERUN_COMPLETED).length,
      error: runs.filter(r => r.status === CLOSED_LOOP_STATUS.ERROR).length,
    },
    by_mode: {
      dry_run: runs.filter(r => r.mode === 'dry_run').length,
      auto_run: runs.filter(r => r.mode === 'auto_run').length,
      manual_approve: runs.filter(r => r.mode === 'manual_approve').length,
    },
    recent: runs.slice(0, 5),
  };
}

/**
 * Sync in-memory store to DB (batch upsert for recovery).
 */
export async function syncToDB() {
  const allRuns = closedLoopStore.dump();
  if (allRuns.length === 0) return { synced: 0 };

  const result = await trySupabase(async () => {
    const { data, error } = await supabase
      .from(TABLE)
      .upsert(allRuns.map(r => ({
        ...r,
        trigger_facts: r.trigger_facts ? JSON.parse(JSON.stringify(r.trigger_facts)) : null,
        param_patch: r.param_patch ? JSON.parse(JSON.stringify(r.param_patch)) : null,
        outcome: r.outcome ? JSON.parse(JSON.stringify(r.outcome)) : null,
      })), { onConflict: 'id' });
    if (error) throw error;
    return data;
  });

  return { synced: result ? allRuns.length : 0, fallback: !result };
}
