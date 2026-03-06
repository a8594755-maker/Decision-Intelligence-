/**
 * useBasePlanResolver — React hook
 *
 * Manages the lifecycle of baseline plan resolution for the What-If Explorer.
 * Implements the deterministic fallback chain and auto-baseline logic.
 *
 * Modes:
 *   'resolving'    — initial DB lookup in progress
 *   'auto_running' — auto-baseline plan creation in progress
 *   'plan'         — baseline plan resolved and valid
 *   'stale'        — baseline found but stale (needs user action)
 *   'no_plan'      — no plan found; showing empty state with actions
 *   'risk'         — risk-based What-If mode (no plan required)
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  resolveBasePlan,
  validateBasePlan,
  persistBasePlan,
  fetchRecentPlans,
  runAutoBaseline as _runAutoBaseline
} from '../services/basePlanResolverService';

const SESSION_GUARD_KEY = (userId, profileId) =>
  `autoBaselineAttempted_${userId}_${profileId}`;

/**
 * @param {object} opts
 * @param {string|null} opts.userId
 * @param {number|null} opts.datasetProfileId
 * @param {object|null} opts.datasetProfileRow - full profile row for auto-baseline
 * @param {number|null} opts.routeRunId - planId from prop/URL (highest priority)
 * @param {string|null} opts.latestDataTs - ISO timestamp for staleness check
 * @param {string|null} opts.latestContractTs - ISO timestamp for staleness check
 */
export function useBasePlanResolver({
  userId,
  datasetProfileId,
  datasetProfileRow = null,
  routeRunId = null,
  latestDataTs = null,
  latestContractTs = null
}) {
  const [mode, setMode] = useState('resolving');
  const [basePlan, setBasePlan] = useState(null);
  const [staleness, setStaleness] = useState(null); // { reason }
  const [recentPlans, setRecentPlans] = useState([]);
  const [error, setError] = useState(null);
  const [autoProgress, setAutoProgress] = useState(null);

  // Prevent double-resolve on StrictMode double-invocation
  const resolveCalledRef = useRef(false);

  // ── Recent plans loader ────────────────────────────────────────────────────

  const loadRecentPlans = useCallback(async () => {
    if (!userId) return;
    try {
      const plans = await fetchRecentPlans({ userId, datasetProfileId });
      setRecentPlans(plans);
    } catch {
      // Non-fatal
    }
  }, [userId, datasetProfileId]);

  // ── Core resolve effect ────────────────────────────────────────────────────

  const doResolve = useCallback(async () => {
    if (!userId) {
      setMode('no_plan');
      return;
    }

    setMode('resolving');
    setError(null);

    try {
      const { mode: resolvedMode, basePlan: run } = await resolveBasePlan({
        userId,
        datasetProfileId,
        routeRunId
      });

      if (resolvedMode === 'plan' && run) {
        // Validate staleness
        const { valid, reason } = validateBasePlan(run, {
          datasetProfileId,
          latestDataTs,
          latestContractTs
        });

        setBasePlan(run);
        persistBasePlan(userId, run);

        if (valid) {
          setMode('plan');
        } else {
          setStaleness({ reason });
          setMode('stale');
        }

        // Also load recent plans for the selector in the stale banner
        loadRecentPlans();
      } else {
        // No plan found — load recent plans for the empty-state selector
        await loadRecentPlans();
        setMode('no_plan');
      }
    } catch (err) {
      console.warn('[useBasePlanResolver] resolve error:', err?.message);
      setMode('no_plan');
    }
  }, [userId, datasetProfileId, routeRunId, latestDataTs, latestContractTs, loadRecentPlans]);

  useEffect(() => {
    if (resolveCalledRef.current) return;
    resolveCalledRef.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time resolve on mount; setState is inside an async callback
    doResolve();
  }, [doResolve]);

  const retryResolve = useCallback(() => {
    resolveCalledRef.current = false;
    doResolve();
  }, [doResolve]);

  // ── Auto-baseline ──────────────────────────────────────────────────────────

  const runAutoBaselineAction = useCallback(async ({ riskMode = 'off' } = {}) => {
    if (!userId) return;

    // Session guard: don't re-attempt if already tried this session
    const guardKey = SESSION_GUARD_KEY(userId, datasetProfileId ?? 'unknown');
    const alreadyTried = sessionStorage.getItem(guardKey);
    if (alreadyTried === '1') {
      // Already failed this session — go straight to risk mode
      setMode('risk');
      return;
    }

    if (!datasetProfileRow?.id) {
      // No profile row available — can't auto-run; show risk mode
      setMode('risk');
      setError('No dataset profile available for auto-baseline. Switch to Risk What-If or upload data first.');
      return;
    }

    setMode('auto_running');
    setError(null);
    setAutoProgress('Generating baseline plan…');

    // Mark guard before calling to prevent concurrent attempts
    try { sessionStorage.setItem(guardKey, '1'); } catch { /* ignore */ }

    const result = await _runAutoBaseline({
      userId,
      datasetProfileRow,
      riskMode,
      onProgress: ({ message }) => setAutoProgress(message)
    });

    setAutoProgress(null);

    if (result.success && result.run) {
      const run = result.run;
      setBasePlan(run);
      persistBasePlan(userId, run);
      setStaleness(null);
      setMode('plan');
    } else {
      const reasonMessages = {
        missing_profile: 'No dataset profile available.',
        infeasible: 'Plan is infeasible with current data/constraints.',
        no_run_returned: 'Plan generation returned no result.',
      };
      setError(reasonMessages[result.reason] || result.reason || 'Baseline generation failed.');
      setMode('risk');
    }
  }, [userId, datasetProfileId, datasetProfileRow]);

  // ── User actions ───────────────────────────────────────────────────────────

  const selectRecentPlan = useCallback((run) => {
    if (!run) return;
    setBasePlan(run);
    persistBasePlan(userId, run);
    setStaleness(null);
    setMode('plan');
  }, [userId]);

  const switchToRiskMode = useCallback(() => {
    setError(null);
    setMode('risk');
  }, []);

  // Use the stale baseline anyway (dismiss staleness warning, proceed with existing plan)
  const useBaselineAnyway = useCallback(() => {
    setStaleness(null);
    setMode('plan');
  }, []);

  // Return to plan resolution flow (e.g. after risk mode)
  const switchToPlanMode = useCallback(() => {
    retryResolve();
  }, [retryResolve]);

  // ── Derived values ─────────────────────────────────────────────────────────

  const resolvedRunId = basePlan?.id ?? null;

  return {
    mode,             // 'resolving' | 'auto_running' | 'plan' | 'stale' | 'no_plan' | 'risk'
    resolvedRunId,    // number | null
    basePlan,         // run object | null
    staleness,        // { reason } | null
    recentPlans,      // recent runs array
    error,            // string | null
    autoProgress,     // string | null (shown during auto_running)
    retryResolve,
    runAutoBaseline: runAutoBaselineAction,
    selectRecentPlan,
    useBaselineAnyway,
    switchToRiskMode,
    switchToPlanMode
  };
}
