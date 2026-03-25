/**
 * useSessionContext.js
 *
 * React hook that wraps sessionContextService for use in components.
 * Auto-loads context on conversationId change and auto-persists on mutation.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  getSessionContext,
  reconcileSessionContext,
  updateForecastContext as _updateForecast,
  updatePlanContext as _updatePlan,
  updateDatasetContext as _updateDataset,
  rotatePlanContext as _rotatePlan,
  applyParameterOverride as _applyOverride,
  recordIntent as _recordIntent,
  addPendingApproval as _addApproval,
  resolvePendingApproval as _resolveApproval,
  dismissAlert as _dismissAlert,
  updateNegotiationContext as _updateNegotiation,
  recordNegotiationOptionApplied as _recordNegOptionApplied,
  clearNegotiationContext as _clearNegotiation,
  getEffectiveConstraints,
  getEffectiveObjective,
  canCompareWithPrevious,
  getLastForecastRunId,
  getLastPlanRunId,
  buildSessionSummary,
  clearSessionContext,
} from '../services/memory/sessionContextService';

/**
 * @param {string|null} userId
 * @param {string|null} conversationId
 * @returns {Object} session context API
 */
export default function useSessionContext(userId, conversationId) {
  const [context, setContext] = useState(null);
  const prevConvRef = useRef(null);
  const reconcileRef = useRef(null);

  // Load context when conversationId changes
  useEffect(() => {
    if (!userId || !conversationId) {
      queueMicrotask(() => setContext(null));
      prevConvRef.current = null;
      return;
    }
    if (conversationId !== prevConvRef.current) {
      prevConvRef.current = conversationId;
      // Step 1: Immediate localStorage load (synchronous)
      queueMicrotask(() => setContext(getSessionContext(userId, conversationId)));

      // Step 2: Async reconciliation with Supabase (cross-device sync)
      const reconcileKey = `${userId}_${conversationId}`;
      if (reconcileRef.current !== reconcileKey) {
        reconcileRef.current = reconcileKey;
        reconcileSessionContext(userId, conversationId)
          .then((newerCtx) => {
            if (newerCtx && reconcileRef.current === reconcileKey) {
              setContext(newerCtx);
            }
          })
          .catch(() => { /* Offline or table missing — localStorage is fine */ });
      }
    }
  }, [userId, conversationId]);

  // Helper: apply a service function and sync local state
  const apply = useCallback((fn, ...args) => {
    if (!userId || !conversationId) return null;
    const updated = fn(userId, conversationId, ...args);
    setContext(updated);
    return updated;
  }, [userId, conversationId]);

  const updateDataset = useCallback(
    (datasetInfo) => apply(_updateDataset, datasetInfo),
    [apply]
  );

  const updateForecast = useCallback(
    (forecastResult) => apply(_updateForecast, forecastResult),
    [apply]
  );

  const updatePlan = useCallback(
    (planResult) => apply(_updatePlan, planResult),
    [apply]
  );

  const rotatePlan = useCallback(
    () => apply(_rotatePlan),
    [apply]
  );

  const applyOverride = useCallback(
    (key, value) => apply(_applyOverride, key, value),
    [apply]
  );

  const recordIntentAction = useCallback(
    (intent, params) => apply(_recordIntent, intent, params),
    [apply]
  );

  const addApproval = useCallback(
    (approval) => apply(_addApproval, approval),
    [apply]
  );

  const resolveApproval = useCallback(
    (approvalId, status) => apply(_resolveApproval, approvalId, status),
    [apply]
  );

  const dismissAlertAction = useCallback(
    (alertId) => apply(_dismissAlert, alertId),
    [apply]
  );

  const updateNegotiation = useCallback(
    (negotiationResult, planRunId) => apply(_updateNegotiation, negotiationResult, planRunId),
    [apply]
  );

  const recordNegOptionApplied = useCallback(
    (optionId, newPlanRunId, kpis) => apply(_recordNegOptionApplied, optionId, newPlanRunId, kpis),
    [apply]
  );

  const clearNegotiation = useCallback(
    () => apply(_clearNegotiation),
    [apply]
  );

  const clear = useCallback(() => {
    if (userId && conversationId) {
      clearSessionContext(userId, conversationId);
      setContext(null);
    }
  }, [userId, conversationId]);

  return {
    context,

    // Mutators
    updateDataset,
    updateForecast,
    updatePlan,
    rotatePlan,
    applyOverride,
    recordIntent: recordIntentAction,
    addApproval,
    resolveApproval,
    dismissAlert: dismissAlertAction,
    updateNegotiation,
    recordNegOptionApplied,
    clearNegotiation,
    clear,

    // Derived getters (computed from current context)
    effectiveConstraints: context ? getEffectiveConstraints(context) : {},
    effectiveObjective: context ? getEffectiveObjective(context) : {},
    canCompare: context ? canCompareWithPrevious(context) : false,
    lastForecastRunId: context ? getLastForecastRunId(context) : null,
    lastPlanRunId: context ? getLastPlanRunId(context) : null,
    sessionSummary: context ? buildSessionSummary(context) : '',
  };
}
