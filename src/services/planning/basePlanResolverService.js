/**
 * basePlanResolverService.js
 *
 * Deterministic fallback chain for resolving a baseline plan for the What-If
 * Explorer. Pure service — no React.
 *
 * Fallback order:
 *   1. routeRunId (from URL/prop)
 *   2. localStorage.lastBasePlanId_{userId}
 *   3. Latest approved baseline for the given dataset_profile_id
 *   4. Latest succeeded optimize run in DB for the given dataset_profile_id
 *   5. mode: 'none' (caller decides whether to auto-run baseline)
 */

import { diRunsService } from './diRunsService';
import { runPlanFromDatasetProfile } from './chatPlanningService';
import { getLatestApprovedBaseline } from './planWritebackService';

const LOCAL_STORAGE_KEY = (userId) => `lastBasePlanId_${userId}`;

// ── Persistence ─────────────────────────────────────────────────────────────

export function persistBasePlan(userId, run) {
  if (!userId || !run?.id) return;
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY(userId), String(run.id));
  } catch {
    // Ignore quota errors
  }
}

export function clearPersistedBasePlan(userId) {
  try {
    localStorage.removeItem(LOCAL_STORAGE_KEY(userId));
  } catch {
    // Ignore
  }
}

// ── Staleness validation ─────────────────────────────────────────────────────

/**
 * Checks whether a resolved run is still valid for the current context.
 *
 * @param {object} run - di_runs row
 * @param {object} opts
 * @param {number|null} opts.datasetProfileId - expected profile id
 * @param {string|null} opts.latestDataTs - ISO timestamp of last data import
 * @param {string|null} opts.latestContractTs - ISO timestamp of last contract update
 * @returns {{ valid: boolean, reason: string|null }}
 */
export function validateBasePlan(run, { datasetProfileId, latestDataTs = null, latestContractTs = null } = {}) {
  if (!run) return { valid: false, reason: 'no_run' };

  if (
    datasetProfileId != null &&
    Number(run.dataset_profile_id) !== Number(datasetProfileId)
  ) {
    return { valid: false, reason: 'profile_mismatch' };
  }

  const runTs = run.created_at ? new Date(run.created_at).getTime() : 0;

  if (latestDataTs) {
    const dataTs = new Date(latestDataTs).getTime();
    if (runTs < dataTs) return { valid: false, reason: 'stale_data' };
  }

  if (latestContractTs) {
    const contractTs = new Date(latestContractTs).getTime();
    if (runTs < contractTs) return { valid: false, reason: 'stale_contract' };
  }

  return { valid: true, reason: null };
}

// ── Core resolver ─────────────────────────────────────────────────────────────

/**
 * Resolves a baseline plan using the deterministic fallback chain.
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {number|null} opts.datasetProfileId
 * @param {number|null} opts.routeRunId - from URL / prop (highest priority)
 * @returns {Promise<{ mode: 'plan'|'none', basePlan: object|null, reason: string }>}
 */
export async function resolveBasePlan({ userId, datasetProfileId, routeRunId = null }) {
  if (!userId) return { mode: 'none', basePlan: null, reason: 'no_user' };

  // Step 1: routeRunId (prop or URL param)
  if (routeRunId) {
    try {
      const run = await diRunsService.getRunById(userId, Number(routeRunId));
      if (run && run.status === 'succeeded') {
        return { mode: 'plan', basePlan: run, reason: 'route_param' };
      }
    } catch {
      // Fall through
    }
  }

  // Step 2: localStorage
  try {
    const storedId = localStorage.getItem(LOCAL_STORAGE_KEY(userId));
    if (storedId) {
      const run = await diRunsService.getRunById(userId, Number(storedId));
      if (run && run.status === 'succeeded') {
        return { mode: 'plan', basePlan: run, reason: 'local_storage' };
      }
      // Stored ID no longer valid — clear it
      clearPersistedBasePlan(userId);
    }
  } catch {
    // Fall through
  }

  // Step 3: Latest approved baseline for this dataset profile
  if (datasetProfileId) {
    try {
      const approved = await getLatestApprovedBaseline({ userId, datasetProfileId: Number(datasetProfileId) });
      if (approved?.run_id) {
        const run = await diRunsService.getRunById(userId, Number(approved.run_id));
        if (run && run.status === 'succeeded') {
          return { mode: 'plan', basePlan: run, reason: 'approved_baseline' };
        }
      }
    } catch {
      // Fall through — approved baseline tables may not exist yet
    }
  }

  // Step 4: Latest DB run for this dataset profile
  if (datasetProfileId) {
    try {
      const run = await diRunsService.getLatestRunByStage(userId, {
        stage: 'optimize',
        status: 'succeeded',
        dataset_profile_id: Number(datasetProfileId),
        limit: 1
      });
      if (run) {
        return { mode: 'plan', basePlan: run, reason: 'db_latest' };
      }
    } catch {
      // Fall through
    }
  }

  return { mode: 'none', basePlan: null, reason: 'no_plan_found' };
}

// ── Recent plans ─────────────────────────────────────────────────────────────

/**
 * Fetches recent succeeded optimize runs for a dataset profile (for the selector).
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {number|null} opts.datasetProfileId
 * @param {number} opts.limit
 * @returns {Promise<object[]>}
 */
export async function fetchRecentPlans({ userId, datasetProfileId, limit = 8 }) {
  if (!userId) return [];
  try {
    // If we have a specific profile, filter by it
    if (datasetProfileId) {
      const _run = await diRunsService.getLatestRunByStage(userId, {
        stage: 'optimize',
        status: 'succeeded',
        dataset_profile_id: Number(datasetProfileId),
        limit
      });
      // getLatestRunByStage returns the first row; for a list we use getLatestRuns
      // and filter client-side (avoids a new DB method)
    }

    // Fetch recent runs and filter to succeeded optimize runs
    const allRecent = await diRunsService.getLatestRuns(userId, 30);
    return allRecent.filter(
      (r) =>
        r.stage === 'optimize' &&
        r.status === 'succeeded' &&
        (datasetProfileId == null || Number(r.dataset_profile_id) === Number(datasetProfileId))
    ).slice(0, limit);
  } catch {
    return [];
  }
}

// ── Auto-baseline ─────────────────────────────────────────────────────────────

/**
 * Attempts to create a new baseline plan automatically.
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {object} opts.datasetProfileRow - { id, profile_json, contract_json, user_file_id }
 * @param {function} [opts.onProgress] - ({ step, message }) callback
 * @param {string} [opts.riskMode] - 'off' | 'on'
 * @returns {Promise<{ success: boolean, run?: object, reason?: string }>}
 */
export async function runAutoBaseline({ userId, datasetProfileRow, onProgress = null, riskMode = 'off' }) {
  if (!userId || !datasetProfileRow?.id) {
    return { success: false, reason: 'missing_profile' };
  }

  try {
    onProgress?.({ step: 'start', message: 'Running baseline plan…' });

    const result = await runPlanFromDatasetProfile({
      userId,
      datasetProfileRow,
      riskMode,
      settings: {}
    });

    const run = result?.run;
    const solverStatusRaw = result?.solver_result?.status;
    const solverStatus = String(solverStatusRaw || '').trim().toUpperCase();

    if (!run || solverStatus === 'INFEASIBLE') {
      return {
        success: false,
        reason: solverStatus === 'INFEASIBLE'
          ? 'infeasible'
          : 'no_run_returned'
      };
    }

    onProgress?.({ step: 'done', message: 'Baseline ready.' });
    return { success: true, run };
  } catch (err) {
    return { success: false, reason: err?.message || 'unknown_error' };
  }
}
