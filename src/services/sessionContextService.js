/**
 * sessionContextService.js
 *
 * Manages structured per-conversation session context for the SmartOps 2.0
 * Autonomous Chat Brain. Enables stateful conversations where each turn
 * builds on previous results (iterative refinement, plan comparison, etc.).
 *
 * Persistence: localStorage (primary) + Supabase (async write-through for
 * cross-device sync) with graceful degradation.
 */

import { supabase, isSupabaseConfigured } from './supabaseClient';

// ── Constants ────────────────────────────────────────────────────────────────

const STORAGE_PREFIX = 'di_session_ctx_';
const MAX_INTENT_HISTORY = 50;
const CONTEXT_VERSION = 'v1';
const SYNC_DEBOUNCE_MS = 1500;
const SYNC_TABLE = 'di_session_contexts';

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create an empty session context for a conversation.
 * @param {string} conversationId
 * @returns {Object} SessionContext
 */
export function createSessionContext(conversationId) {
  return {
    version: CONTEXT_VERSION,
    conversation_id: conversationId,
    updated_at: new Date().toISOString(),

    // Dataset context
    dataset: {
      profile_id: null,
      user_file_id: null,
      profile_summary: '',
      contract_confirmed: false,
    },

    // Forecast context
    forecast: {
      run_id: null,
      created_at: null,
      key_metrics: {
        mape: null,
        mae: null,
        horizon_periods: null,
        granularity: null,
      },
      model_used: null,
    },

    // Current plan context
    plan: {
      run_id: null,
      created_at: null,
      kpis: {
        estimated_total_cost: null,
        estimated_service_level: null,
        estimated_stockout_units: null,
        estimated_holding_units: null,
      },
      constraints: {},
      objective: null,
      solver_status: null,
      risk_mode: null,
    },

    // Previous plan (for comparison after re-run)
    previous_plan: {
      run_id: null,
      kpis: {},
      constraints: {},
      objective: null,
    },

    // User-specified parameter overrides (applied on next run)
    overrides: {
      budget_cap: null,
      service_level_target: null,
      planning_horizon_days: null,
      moq_overrides: {},
      lead_time_overrides: {},
      safety_stock_overrides: {},
      risk_settings: {
        risk_mode: null,
        safety_stock_alpha: null,
      },
    },

    // Intent history for context-aware parsing
    intent_history: [],

    // Pending approval tracking
    pending_approvals: [],

    // Active alert state
    active_alerts: {
      last_scan_at: null,
      alert_ids: [],
      dismissed_ids: [],
    },

    // Supplier event tracking (real-time Sense layer)
    supplier_events: {
      last_event_at: null,
      recent_event_ids: [],
      event_count: 0,
      last_risk_delta: null,
    },

    // Negotiation state (multi-round infeasibility resolution)
    negotiation: {
      round: 0,
      active_plan_run_id: null,
      trigger: null,
      options: null,
      evaluation: null,
      report: null,
      applied_option_id: null,
      history: [],
    },
  };
}

// ── Storage helpers ──────────────────────────────────────────────────────────

function storageKey(userId, conversationId) {
  return `${STORAGE_PREFIX}${userId}_${conversationId}`;
}

function persistToStorage(userId, conversationId, context) {
  try {
    const key = storageKey(userId, conversationId);
    localStorage.setItem(key, JSON.stringify(context));
  } catch {
    // localStorage full or unavailable — silent fail
  }
}

function loadFromStorage(userId, conversationId) {
  try {
    const key = storageKey(userId, conversationId);
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.version !== CONTEXT_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ── Supabase sync layer (async, non-blocking) ───────────────────────────────

let isSyncTableUnavailable = false;
const _debounceTimers = new Map();

function syncToSupabase(userId, conversationId, context) {
  if (!isSupabaseConfigured || isSyncTableUnavailable) return;

  const key = `${userId}_${conversationId}`;
  if (_debounceTimers.has(key)) clearTimeout(_debounceTimers.get(key));

  _debounceTimers.set(key, setTimeout(async () => {
    _debounceTimers.delete(key);
    try {
      const { error } = await supabase
        .from(SYNC_TABLE)
        .upsert({
          user_id: userId,
          conversation_id: conversationId,
          context_data: context,
          version: context.version || CONTEXT_VERSION,
          updated_at: context.updated_at || new Date().toISOString(),
        }, { onConflict: 'user_id,conversation_id' });

      if (error) {
        if (_isMissingSyncTable(error)) { isSyncTableUnavailable = true; return; }
        console.warn('[SessionSync] Supabase write failed:', error.message);
      }
    } catch (err) {
      console.warn('[SessionSync] Supabase write error:', err?.message || err);
    }
  }, SYNC_DEBOUNCE_MS));
}

async function fetchFromSupabase(userId, conversationId) {
  if (!isSupabaseConfigured || isSyncTableUnavailable) return null;
  try {
    const { data, error } = await supabase
      .from(SYNC_TABLE)
      .select('context_data, updated_at')
      .eq('user_id', userId)
      .eq('conversation_id', conversationId)
      .maybeSingle();

    if (error) {
      if (_isMissingSyncTable(error)) { isSyncTableUnavailable = true; return null; }
      console.warn('[SessionSync] Supabase read failed:', error.message);
      return null;
    }
    return data || null;
  } catch (err) {
    console.warn('[SessionSync] Supabase read error:', err?.message || err);
    return null;
  }
}

function deleteFromSupabase(userId, conversationId) {
  if (!isSupabaseConfigured || isSyncTableUnavailable) return;
  supabase
    .from(SYNC_TABLE)
    .delete()
    .eq('user_id', userId)
    .eq('conversation_id', conversationId)
    .then(({ error }) => {
      if (error && !_isMissingSyncTable(error)) {
        console.warn('[SessionSync] Supabase delete failed:', error.message);
      }
    })
    .catch(() => {});
}

function _isMissingSyncTable(error) {
  if (!error) return false;
  const blob = [error?.message, error?.details, error?.hint]
    .filter(Boolean).join(' ').toLowerCase();
  return (
    String(error?.code || '').toUpperCase() === '42P01' ||
    String(error?.code || '').toUpperCase() === 'PGRST205' ||
    Number(error?.status || 0) === 404 ||
    blob.includes('does not exist') ||
    blob.includes('schema cache') ||
    blob.includes(SYNC_TABLE)
  );
}

/**
 * Async reconciliation: check Supabase for a newer version of context.
 * If remote is newer, update localStorage and return the remote version.
 * If local is newer, push local to Supabase. Returns null if no change needed.
 */
export async function reconcileSessionContext(userId, conversationId) {
  const local = loadFromStorage(userId, conversationId);
  const remote = await fetchFromSupabase(userId, conversationId);

  if (!remote?.context_data) {
    if (local) syncToSupabase(userId, conversationId, local);
    return null;
  }

  const localTime = local?.updated_at ? new Date(local.updated_at).getTime() : 0;
  const remoteTime = remote.updated_at ? new Date(remote.updated_at).getTime() : 0;

  if (remoteTime > localTime) {
    const remoteCtx = remote.context_data;
    persistToStorage(userId, conversationId, remoteCtx);
    return remoteCtx;
  }

  if (local && localTime > remoteTime) {
    syncToSupabase(userId, conversationId, local);
  }
  return null;
}

// ── CRUD operations ──────────────────────────────────────────────────────────

/**
 * Get session context for a conversation. Creates a new one if not found.
 * @param {string} userId
 * @param {string} conversationId
 * @returns {Object} SessionContext
 */
export function getSessionContext(userId, conversationId) {
  const stored = loadFromStorage(userId, conversationId);
  if (stored) return stored;
  return createSessionContext(conversationId);
}

/**
 * Update session context via a patch function.
 * @param {string} userId
 * @param {string} conversationId
 * @param {Function} patchFn - (currentContext) => patchedContext
 * @returns {Object} Updated SessionContext
 */
export function updateSessionContext(userId, conversationId, patchFn) {
  const current = getSessionContext(userId, conversationId);
  const patched = typeof patchFn === 'function' ? patchFn(current) : { ...current, ...patchFn };
  patched.updated_at = new Date().toISOString();
  persistToStorage(userId, conversationId, patched);
  syncToSupabase(userId, conversationId, patched);
  return patched;
}

/**
 * Update dataset context fields.
 * @param {string} userId
 * @param {string} conversationId
 * @param {Object} datasetInfo - { profile_id, user_file_id, profile_summary, contract_confirmed }
 * @returns {Object} Updated SessionContext
 */
export function updateDatasetContext(userId, conversationId, datasetInfo) {
  return updateSessionContext(userId, conversationId, (ctx) => ({
    ...ctx,
    dataset: {
      ...ctx.dataset,
      ...datasetInfo,
    },
  }));
}

/**
 * Update forecast context after a forecast run completes.
 * @param {string} userId
 * @param {string} conversationId
 * @param {Object} forecastResult - result from chatForecastService
 * @returns {Object} Updated SessionContext
 */
export function updateForecastContext(userId, conversationId, forecastResult) {
  if (!forecastResult) return getSessionContext(userId, conversationId);

  const run = forecastResult.run || forecastResult;
  const metrics = forecastResult.evaluation || forecastResult.key_metrics || {};

  return updateSessionContext(userId, conversationId, (ctx) => ({
    ...ctx,
    forecast: {
      run_id: run.id ?? run.run_id ?? null,
      created_at: new Date().toISOString(),
      key_metrics: {
        mape: metrics.mape ?? metrics.metric_mape ?? null,
        mae: metrics.mae ?? metrics.metric_mae ?? null,
        horizon_periods: metrics.horizon_periods ?? null,
        granularity: metrics.granularity ?? null,
      },
      model_used: metrics.selected_model_global ?? metrics.model_used ?? null,
    },
  }));
}

/**
 * Update plan context after a plan run completes.
 * @param {string} userId
 * @param {string} conversationId
 * @param {Object} planResult - result from chatPlanningService.runPlanFromDatasetProfile
 * @returns {Object} Updated SessionContext
 */
export function updatePlanContext(userId, conversationId, planResult) {
  if (!planResult) return getSessionContext(userId, conversationId);

  const run = planResult.run || {};
  const solverResult = planResult.solver_result || {};
  const kpis = solverResult.kpis || {};

  return updateSessionContext(userId, conversationId, (ctx) => ({
    ...ctx,
    plan: {
      run_id: run.id ?? null,
      created_at: new Date().toISOString(),
      kpis: {
        estimated_total_cost: kpis.estimated_total_cost ?? null,
        estimated_service_level: kpis.estimated_service_level ?? null,
        estimated_stockout_units: kpis.estimated_stockout_units ?? null,
        estimated_holding_units: kpis.estimated_holding_units ?? null,
      },
      constraints: planResult._submitted_constraints || ctx.plan.constraints || {},
      objective: planResult._submitted_objective || ctx.plan.objective || null,
      solver_status: solverResult.status ?? null,
      risk_mode: planResult.risk_mode ?? null,
    },
  }));
}

/**
 * Rotate current plan to previous_plan before a re-run.
 * Call this BEFORE running a new plan so the user can compare.
 * @param {string} userId
 * @param {string} conversationId
 * @returns {Object} Updated SessionContext
 */
export function rotatePlanContext(userId, conversationId) {
  return updateSessionContext(userId, conversationId, (ctx) => ({
    ...ctx,
    previous_plan: {
      run_id: ctx.plan.run_id,
      kpis: { ...ctx.plan.kpis },
      constraints: { ...ctx.plan.constraints },
      objective: ctx.plan.objective,
    },
  }));
}

/**
 * Apply a parameter override for future runs.
 * @param {string} userId
 * @param {string} conversationId
 * @param {string} key - override key (e.g., 'budget_cap', 'risk_settings.risk_mode')
 * @param {*} value - the override value
 * @returns {Object} Updated SessionContext
 */
export function applyParameterOverride(userId, conversationId, key, value) {
  return updateSessionContext(userId, conversationId, (ctx) => {
    const overrides = { ...ctx.overrides };

    // Handle nested keys (e.g., 'risk_settings.risk_mode')
    const parts = String(key).split('.');
    if (parts.length === 2 && typeof overrides[parts[0]] === 'object' && overrides[parts[0]] !== null) {
      overrides[parts[0]] = { ...overrides[parts[0]], [parts[1]]: value };
    } else {
      overrides[parts[0]] = value;
    }

    return { ...ctx, overrides };
  });
}

/**
 * Record an intent in the conversation's intent history.
 * @param {string} userId
 * @param {string} conversationId
 * @param {string} intent - intent type (e.g., 'RUN_PLAN', 'CHANGE_PARAM')
 * @param {Object} params - extracted parameters
 * @returns {Object} Updated SessionContext
 */
export function recordIntent(userId, conversationId, intent, params = {}) {
  return updateSessionContext(userId, conversationId, (ctx) => {
    const history = [...(ctx.intent_history || [])];
    history.push({
      intent,
      timestamp: new Date().toISOString(),
      params,
    });
    // Cap history length
    if (history.length > MAX_INTENT_HISTORY) {
      history.splice(0, history.length - MAX_INTENT_HISTORY);
    }
    return { ...ctx, intent_history: history };
  });
}

// ── Pending approvals ────────────────────────────────────────────────────────

/**
 * Add a pending approval to session context.
 * @param {string} userId
 * @param {string} conversationId
 * @param {Object} approval - { approval_id, run_id, status, deadline, narrative_summary }
 * @returns {Object} Updated SessionContext
 */
export function addPendingApproval(userId, conversationId, approval) {
  return updateSessionContext(userId, conversationId, (ctx) => ({
    ...ctx,
    pending_approvals: [...(ctx.pending_approvals || []), approval],
  }));
}

/**
 * Resolve a pending approval (approve/reject/expire).
 * @param {string} userId
 * @param {string} conversationId
 * @param {string} approvalId
 * @param {string} status - 'APPROVED' | 'REJECTED' | 'EXPIRED'
 * @returns {Object} Updated SessionContext
 */
export function resolvePendingApproval(userId, conversationId, approvalId, status) {
  return updateSessionContext(userId, conversationId, (ctx) => ({
    ...ctx,
    pending_approvals: (ctx.pending_approvals || []).map((a) =>
      a.approval_id === approvalId ? { ...a, status, decided_at: new Date().toISOString() } : a
    ),
  }));
}

// ── Derived getters ──────────────────────────────────────────────────────────

/**
 * Get effective constraints by merging plan constraints with user overrides.
 * @param {Object} ctx - SessionContext
 * @returns {Object} merged constraints
 */
export function getEffectiveConstraints(ctx) {
  const base = ctx?.plan?.constraints || {};
  const overrides = ctx?.overrides || {};

  return {
    ...base,
    ...(overrides.budget_cap != null ? { budget_cap: overrides.budget_cap } : {}),
    ...(Object.keys(overrides.moq_overrides || {}).length > 0
      ? { moq: mergeMoqOverrides(base.moq, overrides.moq_overrides) }
      : {}),
  };
}

/**
 * Get effective objective by merging plan objective with user overrides.
 * @param {Object} ctx - SessionContext
 * @returns {Object} merged objective
 */
export function getEffectiveObjective(ctx) {
  const base = ctx?.plan?.objective || {};
  const overrides = ctx?.overrides || {};
  const riskSettings = overrides.risk_settings || {};

  const result = typeof base === 'string' ? { optimize_for: base } : { ...base };

  if (overrides.service_level_target != null) {
    result.service_level_target = overrides.service_level_target;
  }

  return { result, risk_mode: riskSettings.risk_mode ?? ctx?.plan?.risk_mode ?? null };
}

/**
 * Check if a previous plan exists for comparison.
 * @param {Object} ctx - SessionContext
 * @returns {boolean}
 */
export function canCompareWithPrevious(ctx) {
  return ctx?.previous_plan?.run_id != null && ctx?.plan?.run_id != null;
}

/**
 * Get the last forecast run ID from session context.
 * @param {Object} ctx - SessionContext
 * @returns {number|null}
 */
export function getLastForecastRunId(ctx) {
  return ctx?.forecast?.run_id ?? null;
}

/**
 * Get the last plan run ID from session context.
 * @param {Object} ctx - SessionContext
 * @returns {number|null}
 */
export function getLastPlanRunId(ctx) {
  return ctx?.plan?.run_id ?? null;
}

/**
 * Build a compact summary of session context for the intent parser prompt.
 * @param {Object} ctx - SessionContext
 * @returns {string}
 */
export function buildSessionSummary(ctx) {
  if (!ctx) return 'No session context available.';

  const parts = [];

  if (ctx.dataset?.profile_id) {
    parts.push(`Dataset: profile_id=${ctx.dataset.profile_id}${ctx.dataset.profile_summary ? ` (${ctx.dataset.profile_summary})` : ''}`);
  }

  if (ctx.forecast?.run_id) {
    const m = ctx.forecast.key_metrics || {};
    parts.push(`Last Forecast: run_id=${ctx.forecast.run_id}, MAPE=${m.mape ?? '?'}, model=${ctx.forecast.model_used ?? '?'}`);
  }

  if (ctx.plan?.run_id) {
    const k = ctx.plan.kpis || {};
    parts.push(`Last Plan: run_id=${ctx.plan.run_id}, status=${ctx.plan.solver_status ?? '?'}, cost=$${k.estimated_total_cost ?? '?'}, SL=${k.estimated_service_level ?? '?'}, risk_mode=${ctx.plan.risk_mode ?? 'off'}`);
  }

  if (ctx.previous_plan?.run_id) {
    parts.push(`Previous Plan: run_id=${ctx.previous_plan.run_id} (available for comparison)`);
  }

  const overrideKeys = Object.entries(ctx.overrides || {})
    .filter(([, v]) => {
      if (v == null) return false;
      if (typeof v === 'object' && !Array.isArray(v)) {
        // Only count nested objects if they have at least one non-null value
        return Object.values(v).some((nested) => nested != null);
      }
      return true;
    })
    .map(([k]) => k);
  if (overrideKeys.length > 0) {
    parts.push(`Active Overrides: ${overrideKeys.join(', ')}`);
  }

  const pendingCount = (ctx.pending_approvals || []).filter((a) => a.status === 'PENDING').length;
  if (pendingCount > 0) {
    parts.push(`Pending Approvals: ${pendingCount}`);
  }

  if (ctx.negotiation?.round > 0) {
    parts.push(`Active Negotiation: round=${ctx.negotiation.round}, trigger=${ctx.negotiation.trigger}, plan_run=${ctx.negotiation.active_plan_run_id}`);
  }

  if (ctx.supplier_events?.event_count > 0) {
    parts.push(`Supplier Events: ${ctx.supplier_events.event_count} received, last at ${ctx.supplier_events.last_event_at}`);
  }

  return parts.length > 0 ? parts.join('\n') : 'Empty session — no dataset, forecast, or plan yet.';
}

// ── Negotiation context ──────────────────────────────────────────────────────

/**
 * Update negotiation context after a negotiation round completes.
 * @param {string} userId
 * @param {string} conversationId
 * @param {Object} negotiationResult - from runNegotiation()
 * @param {number} planRunId - the plan run that triggered negotiation
 * @returns {Object} Updated SessionContext
 */
export function updateNegotiationContext(userId, conversationId, negotiationResult, planRunId) {
  return updateSessionContext(userId, conversationId, (ctx) => ({
    ...ctx,
    negotiation: {
      ...ctx.negotiation,
      round: (ctx.negotiation?.round || 0) + 1,
      active_plan_run_id: planRunId,
      trigger: negotiationResult.trigger,
      options: negotiationResult.negotiation_options,
      evaluation: negotiationResult.negotiation_evaluation,
      report: negotiationResult.negotiation_report,
      applied_option_id: null,
    },
  }));
}

/**
 * Record that the user applied a negotiation option.
 * @param {string} userId
 * @param {string} conversationId
 * @param {string} optionId - e.g. 'opt_001'
 * @param {number} newPlanRunId - the run ID of the re-solved plan
 * @param {Object} kpis - KPIs from the new plan
 * @returns {Object} Updated SessionContext
 */
export function recordNegotiationOptionApplied(userId, conversationId, optionId, newPlanRunId, kpis) {
  return updateSessionContext(userId, conversationId, (ctx) => ({
    ...ctx,
    negotiation: {
      ...ctx.negotiation,
      applied_option_id: optionId,
      history: [
        ...(ctx.negotiation?.history || []),
        {
          round: ctx.negotiation?.round || 1,
          option_id: optionId,
          plan_run_id: newPlanRunId,
          kpis,
          applied_at: new Date().toISOString(),
        },
      ],
    },
  }));
}

/**
 * Clear negotiation context (e.g. after successful resolution).
 * @param {string} userId
 * @param {string} conversationId
 * @returns {Object} Updated SessionContext
 */
export function clearNegotiationContext(userId, conversationId) {
  return updateSessionContext(userId, conversationId, (ctx) => ({
    ...ctx,
    negotiation: createSessionContext('').negotiation,
  }));
}

// ── Alert helpers ────────────────────────────────────────────────────────────

/**
 * Dismiss an alert in the session context.
 * @param {string} userId
 * @param {string} conversationId
 * @param {string} alertId
 * @returns {Object} Updated SessionContext
 */
export function dismissAlert(userId, conversationId, alertId) {
  return updateSessionContext(userId, conversationId, (ctx) => {
    const dismissed = new Set(ctx.active_alerts?.dismissed_ids || []);
    dismissed.add(alertId);
    return {
      ...ctx,
      active_alerts: {
        ...ctx.active_alerts,
        dismissed_ids: Array.from(dismissed),
      },
    };
  });
}

/**
 * Record a supplier event in session context.
 * @param {string} userId
 * @param {string} conversationId
 * @param {Object} eventResult - From processSupplierEvent
 * @returns {Object} Updated SessionContext
 */
export function updateSupplierEventContext(userId, conversationId, eventResult) {
  if (!eventResult?.accepted) return getSessionContext(userId, conversationId);

  return updateSessionContext(userId, conversationId, (ctx) => {
    const recent = [...(ctx.supplier_events?.recent_event_ids || [])];
    recent.push(eventResult.event?.event_id);
    if (recent.length > 20) recent.splice(0, recent.length - 20);

    return {
      ...ctx,
      supplier_events: {
        last_event_at: new Date().toISOString(),
        recent_event_ids: recent,
        event_count: (ctx.supplier_events?.event_count || 0) + 1,
        last_risk_delta: eventResult.risk_delta || null,
      },
    };
  });
}

/**
 * Clear all session context for a conversation.
 * @param {string} userId
 * @param {string} conversationId
 */
export function clearSessionContext(userId, conversationId) {
  try {
    localStorage.removeItem(storageKey(userId, conversationId));
  } catch {
    // silent
  }
  deleteFromSupabase(userId, conversationId);
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function mergeMoqOverrides(baseMoq, moqOverrides) {
  if (!Array.isArray(baseMoq)) return baseMoq;
  return baseMoq.map((item) => {
    const override = moqOverrides[item.sku] ?? moqOverrides[item.material_code];
    if (override != null) return { ...item, min_qty: override };
    return item;
  });
}

export default {
  createSessionContext,
  getSessionContext,
  updateSessionContext,
  updateDatasetContext,
  updateForecastContext,
  updatePlanContext,
  rotatePlanContext,
  applyParameterOverride,
  recordIntent,
  addPendingApproval,
  resolvePendingApproval,
  getEffectiveConstraints,
  getEffectiveObjective,
  canCompareWithPrevious,
  getLastForecastRunId,
  getLastPlanRunId,
  buildSessionSummary,
  updateNegotiationContext,
  recordNegotiationOptionApplied,
  clearNegotiationContext,
  dismissAlert,
  updateSupplierEventContext,
  clearSessionContext,
  reconcileSessionContext,
};
