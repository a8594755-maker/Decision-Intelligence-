/**
 * Negotiation Persistence Service
 *
 * Supabase-backed CRUD for negotiation cases and events.
 * Replaces the in-memory-only NegotiationStateTracker with durable storage
 * while keeping the tracker as a fast in-memory cache for real-time UI.
 *
 * Tables: di_negotiation_cases, di_negotiation_events
 * Fallback: localStorage when Supabase is unavailable.
 */

import { supabase } from './supabaseClient';

const CASES_TABLE = 'di_negotiation_cases';
const EVENTS_TABLE = 'di_negotiation_events';
const LOCAL_KEY = 'di_negotiation_cases_local';

// ── Helpers ─────────────────────────────────────────────────────────────────

const nowIso = () => new Date().toISOString();

async function trySupabase(fn) {
  try {
    return await fn();
  } catch {
    return null;
  }
}

function getLocalCases() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]');
  } catch {
    return [];
  }
}

function setLocalCases(items) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(items.slice(0, 200)));
  } catch {
    // Quota exceeded — silent
  }
}

// ── Cases ───────────────────────────────────────────────────────────────────

/**
 * Create a new negotiation case.
 *
 * @param {string} userId
 * @param {Object} params
 * @param {number} params.planRunId
 * @param {string} params.trigger        - 'infeasible' | 'kpi_shortfall'
 * @param {Object} params.buyerPosition  - { bucket, name, risk_score, signals_used }
 * @param {string} [params.scenarioId]
 * @param {Object} [params.supplierKpis]
 * @returns {Promise<Object>} Created case row
 */
export async function createCase(userId, { planRunId, trigger, buyerPosition, scenarioId, supplierKpis }) {
  const row = {
    user_id: userId,
    plan_run_id: planRunId,
    trigger,
    status: 'active',
    buyer_position: buyerPosition || {},
    scenario_id: scenarioId || null,
    supplier_kpis: supplierKpis || {},
    cfr_history_key: '',
    current_round: 0,
    current_round_name: 'OPENING',
    outcome: null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };

  const result = await trySupabase(async () => {
    const { data, error } = await supabase
      .from(CASES_TABLE)
      .insert([row])
      .select('*')
      .single();
    if (error) throw error;
    return data;
  });

  if (result) return result;

  // Fallback: local storage with generated ID
  const localRow = { ...row, id: `local-neg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
  const existing = getLocalCases();
  existing.unshift(localRow);
  setLocalCases(existing);
  return localRow;
}

/**
 * Record a negotiation event (action within a round).
 *
 * @param {string} caseId
 * @param {Object} event
 * @param {number} event.round
 * @param {string} event.roundName
 * @param {string} event.player        - 'buyer' | 'supplier'
 * @param {string} event.action        - 'accept' | 'reject' | 'counter'
 * @param {Object} [event.details]
 * @param {Object} [event.cfrSnapshot]
 * @param {string} [event.draftTone]
 * @param {string} [event.draftBody]
 * @returns {Promise<Object>} Created event row
 */
export async function recordEvent(caseId, { round, roundName, player, action, details, cfrSnapshot, draftTone, draftBody }) {
  const row = {
    case_id: caseId,
    round,
    round_name: roundName,
    player,
    action,
    details: details || {},
    cfr_strategy_snapshot: cfrSnapshot || null,
    draft_tone: draftTone || null,
    draft_body: draftBody || null,
    created_at: nowIso(),
  };

  const result = await trySupabase(async () => {
    const { data, error } = await supabase
      .from(EVENTS_TABLE)
      .insert([row])
      .select('*')
      .single();
    if (error) throw error;
    return data;
  });

  if (result) return result;

  // Fallback: attach event to local case
  const localCases = getLocalCases();
  const caseIdx = localCases.findIndex((c) => c.id === caseId);
  if (caseIdx >= 0) {
    if (!localCases[caseIdx]._events) localCases[caseIdx]._events = [];
    const localEvent = { ...row, id: `local-evt-${Date.now()}` };
    localCases[caseIdx]._events.push(localEvent);
    setLocalCases(localCases);
    return localEvent;
  }
  return { ...row, id: `local-evt-${Date.now()}` };
}

/**
 * Get active negotiation case for a plan run.
 */
export async function getCaseByPlanRun(userId, planRunId) {
  const result = await trySupabase(async () => {
    const { data, error } = await supabase
      .from(CASES_TABLE)
      .select('*')
      .eq('user_id', userId)
      .eq('plan_run_id', planRunId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data;
  });

  if (result !== null) return result;

  // Fallback
  const local = getLocalCases().find(
    (c) => c.user_id === userId && c.plan_run_id === planRunId && c.status === 'active'
  );
  return local || null;
}

/**
 * List negotiation cases for a user.
 *
 * @param {string} userId
 * @param {Object} [options]
 * @param {string} [options.status]  - filter by status
 * @param {number} [options.limit]   - max results (default 50)
 * @returns {Promise<Object[]>}
 */
export async function listCases(userId, { status, limit = 50 } = {}) {
  const result = await trySupabase(async () => {
    let query = supabase
      .from(CASES_TABLE)
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw error;
    return data;
  });

  if (result) return result;

  // Fallback
  let local = getLocalCases().filter((c) => c.user_id === userId);
  if (status) local = local.filter((c) => c.status === status);
  return local.slice(0, limit);
}

/**
 * Get a case with all its events (joined).
 */
export async function getCaseWithEvents(caseId) {
  const caseResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from(CASES_TABLE)
      .select('*')
      .eq('id', caseId)
      .single();
    if (error) throw error;
    return data;
  });

  const eventsResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from(EVENTS_TABLE)
      .select('*')
      .eq('case_id', caseId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data;
  });

  if (caseResult) {
    return { ...caseResult, events: eventsResult || [] };
  }

  // Fallback
  const local = getLocalCases().find((c) => c.id === caseId);
  if (local) {
    return { ...local, events: local._events || [] };
  }
  return null;
}

/**
 * Update case round state (e.g., advance round, update CFR history key).
 */
export async function updateCaseRound(caseId, { currentRound, currentRoundName, cfrHistoryKey }) {
  const updates = {
    current_round: currentRound,
    current_round_name: currentRoundName,
    cfr_history_key: cfrHistoryKey,
    updated_at: nowIso(),
  };

  const result = await trySupabase(async () => {
    const { data, error } = await supabase
      .from(CASES_TABLE)
      .update(updates)
      .eq('id', caseId)
      .select('*')
      .single();
    if (error) throw error;
    return data;
  });

  if (result) return result;

  // Fallback
  const local = getLocalCases();
  const idx = local.findIndex((c) => c.id === caseId);
  if (idx >= 0) {
    Object.assign(local[idx], updates);
    setLocalCases(local);
    return local[idx];
  }
  return null;
}

/**
 * Resolve a negotiation case.
 *
 * @param {string} caseId
 * @param {Object} outcome
 * @param {string} outcome.status  - 'resolved_agreement' | 'resolved_walkaway' | 'expired'
 * @param {Object} [outcome.terms] - agreed-upon terms (if agreement)
 */
export async function resolveCase(caseId, { status, terms }) {
  const updates = {
    status,
    outcome: terms || null,
    updated_at: nowIso(),
  };

  const result = await trySupabase(async () => {
    const { data, error } = await supabase
      .from(CASES_TABLE)
      .update(updates)
      .eq('id', caseId)
      .select('*')
      .single();
    if (error) throw error;
    return data;
  });

  if (result) return result;

  // Fallback
  const local = getLocalCases();
  const idx = local.findIndex((c) => c.id === caseId);
  if (idx >= 0) {
    Object.assign(local[idx], updates);
    setLocalCases(local);
    return local[idx];
  }
  return null;
}

/**
 * Get summary stats for user's negotiations.
 */
export async function getCaseStats(userId) {
  const cases = await listCases(userId, { limit: 500 });
  return {
    total: cases.length,
    active: cases.filter((c) => c.status === 'active').length,
    resolved_agreement: cases.filter((c) => c.status === 'resolved_agreement').length,
    resolved_walkaway: cases.filter((c) => c.status === 'resolved_walkaway').length,
    expired: cases.filter((c) => c.status === 'expired').length,
  };
}
