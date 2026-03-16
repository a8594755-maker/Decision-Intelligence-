/**
 * Negotiation State Tracker — Multi-round dialogue tracking across chat turns
 *
 * Tracks the lifecycle of a procurement negotiation:
 *   - Records human actions (sent, skip, copy) per round
 *   - Maintains action history for CFR info-set key construction
 *   - Advances negotiation rounds (OPENING → CONCESSION → CLOSING → RESOLVED)
 *   - Re-queries CFR lookup on each round advance
 *   - Persists state as `cfr_negotiation_state` artifact
 *
 * State machine:
 *   OPENING → (action) → CONCESSION → (action) → CLOSING → (action) → RESOLVED
 *
 * Each round transition can be triggered by:
 *   1. User takes an action via NegotiationActionCard (sent/skip)
 *   2. User pastes supplier response → LLM parses → action inferred
 */

import { ROUNDS, ROUND_ORDER, ACTIONS, ACTION_LIST, PLAYERS } from './negotiation-types.js';
import { getLookupService } from './negotiation-lookup-service.js';
import { computePositionBucket } from './negotiation-position-buckets.js';

// ---------------------------------------------------------------------------
// Negotiation Status
// ---------------------------------------------------------------------------

export const NEGOTIATION_STATUS = Object.freeze({
  ACTIVE: 'active',
  RESOLVED_AGREEMENT: 'resolved_agreement',
  RESOLVED_WALKAWAY: 'resolved_walkaway',
  EXPIRED: 'expired',
});

// ---------------------------------------------------------------------------
// State Shape
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} NegotiationState
 * @property {string}   negotiation_id    - unique ID for this negotiation
 * @property {number}   plan_run_id       - originating plan run
 * @property {string}   status            - ACTIVE | RESOLVED_* | EXPIRED
 * @property {number}   current_round     - 0=OPENING, 1=CONCESSION, 2=CLOSING
 * @property {string}   current_round_name- 'OPENING' | 'CONCESSION' | 'CLOSING'
 * @property {Object[]} action_history    - [{ round, player, action, timestamp, details }]
 * @property {Object}   buyer_position    - { bucket, name, risk_score, signals_used }
 * @property {string}   cfr_history_key   - accumulated CFR history string (e.g., 'c:a:c')
 * @property {Object}   cfr_strategy      - latest CFR lookup result
 * @property {string}   scenario_id       - matched CFR scenario
 * @property {Object}   supplier_kpis     - cached supplier KPIs
 * @property {string}   created_at        - ISO timestamp
 * @property {string}   updated_at        - ISO timestamp
 * @property {Object[]} market_events     - supplier events that occurred during negotiation
 */

// ---------------------------------------------------------------------------
// NegotiationStateTracker
// ---------------------------------------------------------------------------

export class NegotiationStateTracker {
  constructor() {
    /** @type {Map<string, NegotiationState>} negotiation_id → state */
    this._negotiations = new Map();
    /** @type {Map<number, string>} plan_run_id → negotiation_id */
    this._byPlanRun = new Map();
  }

  get activeCount() {
    let count = 0;
    for (const s of this._negotiations.values()) {
      if (s.status === NEGOTIATION_STATUS.ACTIVE) count++;
    }
    return count;
  }

  /**
   * Start a new negotiation for a plan run.
   *
   * @param {Object} params
   * @param {number}  params.planRunId
   * @param {string}  params.trigger        - 'infeasible' | 'kpi_shortfall'
   * @param {number}  params.riskScore      - buyer's risk_score
   * @param {Object}  params.supplierKpis   - { on_time_rate, defect_rate, ... }
   * @param {string}  [params.scenarioId]   - CFR scenario ID (auto-detected if null)
   * @returns {NegotiationState}
   */
  startNegotiation({ planRunId, trigger, riskScore, supplierKpis = {}, scenarioId = null }) {
    const id = `neg_${planRunId}_${Date.now()}`;
    const position = computePositionBucket({ risk_score: riskScore });

    // Auto-detect scenario
    let sid = scenarioId;
    if (!sid) {
      const lookup = getLookupService();
      if (lookup.isLoaded) {
        sid = lookup.findNearestScenario(supplierKpis);
      }
    }

    const state = {
      negotiation_id: id,
      plan_run_id: planRunId,
      status: NEGOTIATION_STATUS.ACTIVE,
      trigger,
      current_round: 0,
      current_round_name: ROUND_ORDER[0],
      action_history: [],
      buyer_position: position,
      cfr_history_key: '',
      cfr_strategy: null,
      scenario_id: sid,
      supplier_kpis: { ...supplierKpis },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      market_events: [],
    };

    // Initial CFR lookup
    this._updateCfrStrategy(state);

    this._negotiations.set(id, state);
    this._byPlanRun.set(planRunId, id);

    return { ...state };
  }

  /**
   * Get negotiation state by ID.
   */
  getById(negotiationId) {
    const s = this._negotiations.get(negotiationId);
    return s ? { ...s } : null;
  }

  /**
   * Get negotiation state by plan run ID.
   */
  getByPlanRun(planRunId) {
    const id = this._byPlanRun.get(planRunId);
    return id ? this.getById(id) : null;
  }

  /**
   * Record a buyer action and advance the negotiation.
   *
   * @param {string} negotiationId
   * @param {string} action         - 'accept' | 'reject' | 'counter'
   * @param {Object} [details]      - { tone, draftIndex, wasEdited, ... }
   * @returns {NegotiationState|null}
   */
  recordBuyerAction(negotiationId, action, details = {}) {
    const state = this._negotiations.get(negotiationId);
    if (!state || state.status !== NEGOTIATION_STATUS.ACTIVE) return null;

    // Record the action
    state.action_history.push({
      round: state.current_round,
      round_name: state.current_round_name,
      player: PLAYERS.BUYER,
      player_name: 'buyer',
      action,
      timestamp: new Date().toISOString(),
      details,
    });

    // Update CFR history key
    state.cfr_history_key = state.cfr_history_key
      ? `${state.cfr_history_key}:${action[0]}`
      : action[0];

    // Resolve on accept or reject in final round
    if (action === ACTIONS.ACCEPT) {
      state.status = NEGOTIATION_STATUS.RESOLVED_AGREEMENT;
      state.updated_at = new Date().toISOString();
      return { ...state };
    }

    if (action === ACTIONS.REJECT && state.current_round >= ROUND_ORDER.length - 1) {
      state.status = NEGOTIATION_STATUS.RESOLVED_WALKAWAY;
      state.updated_at = new Date().toISOString();
      return { ...state };
    }

    // Wait for supplier response before advancing round
    state.updated_at = new Date().toISOString();
    return { ...state };
  }

  /**
   * Record a supplier response (parsed from user-pasted reply or inferred).
   *
   * @param {string} negotiationId
   * @param {string} action         - 'accept' | 'reject' | 'counter'
   * @param {Object} [details]      - { parsed_from, confidence, ... }
   * @returns {NegotiationState|null}
   */
  recordSupplierAction(negotiationId, action, details = {}) {
    const state = this._negotiations.get(negotiationId);
    if (!state || state.status !== NEGOTIATION_STATUS.ACTIVE) return null;

    state.action_history.push({
      round: state.current_round,
      round_name: state.current_round_name,
      player: PLAYERS.SUPPLIER,
      player_name: 'supplier',
      action,
      timestamp: new Date().toISOString(),
      details,
    });

    // Update CFR history key
    state.cfr_history_key = state.cfr_history_key
      ? `${state.cfr_history_key}:${action[0]}`
      : action[0];

    // Supplier accepts → agreement
    if (action === ACTIONS.ACCEPT) {
      state.status = NEGOTIATION_STATUS.RESOLVED_AGREEMENT;
      state.updated_at = new Date().toISOString();
      return { ...state };
    }

    // Supplier rejects in final round → walkaway
    if (action === ACTIONS.REJECT && state.current_round >= ROUND_ORDER.length - 1) {
      state.status = NEGOTIATION_STATUS.RESOLVED_WALKAWAY;
      state.updated_at = new Date().toISOString();
      return { ...state };
    }

    // Advance to next round
    state.current_round = Math.min(state.current_round + 1, ROUND_ORDER.length - 1);
    state.current_round_name = ROUND_ORDER[state.current_round];

    // Re-query CFR for updated strategy
    this._updateCfrStrategy(state);

    state.updated_at = new Date().toISOString();
    return { ...state };
  }

  /**
   * Record a market event that occurred during the negotiation.
   * Triggers dynamic re-bucketing if risk_score changes.
   *
   * @param {string} negotiationId
   * @param {Object} event - supplier event from supplierEventConnectorService
   * @returns {NegotiationState|null}
   */
  recordMarketEvent(negotiationId, event) {
    const state = this._negotiations.get(negotiationId);
    if (!state || state.status !== NEGOTIATION_STATUS.ACTIVE) return null;

    state.market_events.push({
      event_type: event.event_type,
      severity: event.severity,
      risk_delta: event.risk_delta || 0,
      occurred_at: event.occurred_at || new Date().toISOString(),
      description: event.description || '',
    });

    // Re-compute position bucket if risk score changed
    if (Number.isFinite(event.risk_delta)) {
      const oldRiskScore = state.buyer_position.risk_score || 100;
      const newRiskScore = oldRiskScore + event.risk_delta;
      state.buyer_position = computePositionBucket({ risk_score: newRiskScore });
      state.buyer_position.risk_score = newRiskScore;

      // Re-query CFR with updated bucket
      this._updateCfrStrategy(state);
    }

    state.updated_at = new Date().toISOString();
    return { ...state };
  }

  /**
   * Map a user UI action (from NegotiationActionCard) to a CFR action.
   *
   * @param {string} uiAction - 'sent' | 'skip' | 'copy'
   * @param {Object} [details] - { tone, ... }
   * @returns {string} CFR action: 'accept' | 'reject' | 'counter'
   */
  static mapUiActionToCfr(uiAction, details = {}) {
    // 'sent' with hardball or persuasion tone → counter (pushing for better terms)
    // 'sent' with win_win tone → accept (collaborative)
    // 'skip' → reject (holding, not engaging)
    // 'copy' → no state change (informational)

    if (uiAction === 'sent') {
      if (details.tone === 'win_win') return ACTIONS.ACCEPT;
      return ACTIONS.COUNTER; // hardball or persuasion = counter
    }
    if (uiAction === 'skip') return ACTIONS.REJECT;
    return null; // 'copy' doesn't change state
  }

  /**
   * Expire stale negotiations (older than maxAge).
   *
   * @param {number} maxAgeMs - max age in milliseconds (default: 7 days)
   * @returns {number} count of expired negotiations
   */
  expireStale(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
    const now = Date.now();
    let count = 0;

    for (const [_id, state] of this._negotiations) {
      if (state.status !== NEGOTIATION_STATUS.ACTIVE) continue;
      const age = now - new Date(state.updated_at).getTime();
      if (age > maxAgeMs) {
        state.status = NEGOTIATION_STATUS.EXPIRED;
        state.updated_at = new Date().toISOString();
        count++;
      }
    }

    return count;
  }

  /**
   * Export state as artifact payload for persistence.
   *
   * @param {string} negotiationId
   * @returns {Object|null} cfr_negotiation_state artifact payload
   */
  exportAsArtifact(negotiationId) {
    const state = this._negotiations.get(negotiationId);
    if (!state) return null;

    return {
      version: 'v1',
      generated_at: new Date().toISOString(),
      negotiation_id: state.negotiation_id,
      plan_run_id: state.plan_run_id,
      current_round: state.current_round,
      current_round_name: state.current_round_name,
      status: state.status,
      action_history: state.action_history,
      buyer_position: state.buyer_position,
      cfr_history_key: state.cfr_history_key,
      scenario_id: state.scenario_id,
      market_events: state.market_events,
      rounds_completed: state.current_round,
      total_actions: state.action_history.length,
      created_at: state.created_at,
      updated_at: state.updated_at,
    };
  }

  /**
   * Import state from a previously persisted artifact.
   *
   * @param {Object} artifact - cfr_negotiation_state payload
   * @returns {NegotiationState|null}
   */
  importFromArtifact(artifact) {
    if (!artifact?.negotiation_id) return null;

    const state = {
      negotiation_id: artifact.negotiation_id,
      plan_run_id: artifact.plan_run_id,
      status: artifact.status || NEGOTIATION_STATUS.ACTIVE,
      trigger: artifact.trigger || null,
      current_round: artifact.current_round || 0,
      current_round_name: artifact.current_round_name || ROUND_ORDER[0],
      action_history: artifact.action_history || [],
      buyer_position: artifact.buyer_position || { bucket: 2, name: 'NEUTRAL', signals_used: [] },
      cfr_history_key: artifact.cfr_history_key || '',
      cfr_strategy: null,
      scenario_id: artifact.scenario_id || null,
      supplier_kpis: artifact.supplier_kpis || {},
      created_at: artifact.created_at || new Date().toISOString(),
      updated_at: artifact.updated_at || new Date().toISOString(),
      market_events: artifact.market_events || [],
    };

    // Re-query CFR
    this._updateCfrStrategy(state);

    this._negotiations.set(state.negotiation_id, state);
    if (state.plan_run_id) {
      this._byPlanRun.set(state.plan_run_id, state.negotiation_id);
    }

    return { ...state };
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /**
   * Re-query CFR lookup service for updated strategy at current state.
   */
  _updateCfrStrategy(state) {
    try {
      const lookup = getLookupService();
      if (!lookup.isLoaded || !state.scenario_id) {
        state.cfr_strategy = null;
        return;
      }

      const bucket = state.buyer_position?.bucket ?? 2;
      const round = ROUND_ORDER[state.current_round] || 'OPENING';
      const infoKey = `B|${bucket}|${round}|${state.cfr_history_key}`;

      const result = lookup.lookupStrategy(state.scenario_id, bucket, infoKey);

      if (result.found) {
        const probs = {};
        ACTION_LIST.forEach((a, i) => {
          probs[a] = result.strategy[i] || 0;
        });

        state.cfr_strategy = {
          cfr_action_probs: probs,
          position_strength: state.buyer_position?.name || 'NEUTRAL',
          source: result.source,
          info_key: infoKey,
        };
      } else {
        state.cfr_strategy = null;
      }
    } catch (err) {
      console.warn('[NegotiationStateTracker] CFR lookup failed:', err?.message);
      state.cfr_strategy = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance = null;

export function getStateTracker() {
  if (!_instance) {
    _instance = new NegotiationStateTracker();
  }
  return _instance;
}

export function _resetStateTracker() {
  _instance = null;
}

export default {
  NegotiationStateTracker,
  getStateTracker,
  _resetStateTracker,
  NEGOTIATION_STATUS,
};
