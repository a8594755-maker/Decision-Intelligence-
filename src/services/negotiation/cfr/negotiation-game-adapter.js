/**
 * Negotiation Game Adapter — Bridge between supplier events and CFR state
 *
 * Connects the real-time supplier event system (supplierEventConnectorService)
 * to the negotiation state tracker, enabling:
 *   - Market signal consumption between negotiation rounds
 *   - Dynamic position re-bucketing when risk scores change
 *   - CFR strategy re-query on material market shifts
 *   - Supplier response parsing from user-pasted text
 *
 * Event flow:
 *   supplierEventConnectorService → NegotiationGameAdapter → NegotiationStateTracker
 *     → re-query CFR lookup → updated strategy for next Human-in-the-Loop card
 */

import { computeRiskDelta, EVENT_CONNECTOR_CONFIG } from '../../sap-erp/supplierEventConnectorService';
import { getStateTracker } from './negotiation-state-tracker.js';
import { computeSupplierTypePriors } from './negotiation-types.js';
import { getLookupService } from './negotiation-lookup-service.js';

// ---------------------------------------------------------------------------
// Event type → negotiation relevance classification
// ---------------------------------------------------------------------------

/**
 * Classify how a supplier event affects an ongoing negotiation.
 *
 * @param {Object} event - Normalized supplier event
 * @returns {{ relevant: boolean, impact: string, leverage_shift: string }}
 */
export function classifyEventImpact(event) {
  const type = event?.event_type;
  const severity = event?.severity || 'medium';

  const classification = {
    delivery_delay: {
      relevant: true,
      impact: 'negative_supplier',
      leverage_shift: 'buyer_gains', // Supplier's failure strengthens buyer position
    },
    quality_alert: {
      relevant: true,
      impact: 'negative_supplier',
      leverage_shift: 'buyer_gains',
    },
    capacity_change: {
      relevant: true,
      impact: severity === 'critical' ? 'negative_supplier' : 'neutral',
      leverage_shift: severity === 'critical' ? 'buyer_gains' : 'neutral',
    },
    force_majeure: {
      relevant: true,
      impact: 'external_shock',
      leverage_shift: 'both_lose', // Neither side benefits; urgency increases
    },
    shipment_status: {
      relevant: severity !== 'low',
      impact: 'informational',
      leverage_shift: 'neutral',
    },
    price_change: {
      relevant: true,
      impact: 'market_shift',
      leverage_shift: 'depends', // Depends on direction
    },
  };

  return classification[type] || { relevant: false, impact: 'unknown', leverage_shift: 'neutral' };
}

// ---------------------------------------------------------------------------
// Supplier response parsing
// ---------------------------------------------------------------------------

/**
 * Parse a supplier's text response into a CFR action.
 * Uses keyword detection (deterministic) — no LLM required for MVP.
 *
 * @param {string} text - Supplier's response text
 * @returns {{ action: string, confidence: number, signals: string[] }}
 */
export function parseSupplierResponse(text) {
  if (!text || typeof text !== 'string') {
    return { action: 'counter', confidence: 0.3, signals: ['empty_input'] };
  }

  const lower = text.toLowerCase();
  const signals = [];

  // Accept signals
  const acceptPatterns = [
    /\bagree\b/, /\baccept\b/, /\bapproved?\b/, /\bdeal\b/,
    /\bconfirm(ed)?\b/, /\blet'?s proceed\b/, /\bsounds good\b/,
    /同意/, /接受/, /成交/, /沒問題/, /可以/,
  ];

  // Reject signals
  const rejectPatterns = [
    /\breject\b/, /\bdecline\b/, /\bcannot\b/, /\bcan'?t\b/,
    /\bunacceptable\b/, /\bno deal\b/, /\bwalk away\b/,
    /拒絕/, /不行/, /無法接受/, /不同意/,
  ];

  // Counter signals
  const counterPatterns = [
    /\bcounter\b/, /\bpropos(e|al)\b/, /\bhow about\b/, /\bwhat if\b/,
    /\binstead\b/, /\balternative\b/, /\bwe can offer\b/, /\bmeet .* halfway\b/,
    /還價/, /提議/, /建議/, /如果/, /折衷/,
  ];

  let acceptScore = 0;
  let rejectScore = 0;
  let counterScore = 0;

  for (const p of acceptPatterns) {
    if (p.test(lower)) { acceptScore++; signals.push(`accept:${p.source}`); }
  }
  for (const p of rejectPatterns) {
    if (p.test(lower)) { rejectScore++; signals.push(`reject:${p.source}`); }
  }
  for (const p of counterPatterns) {
    if (p.test(lower)) { counterScore++; signals.push(`counter:${p.source}`); }
  }

  const total = acceptScore + rejectScore + counterScore;

  if (total === 0) {
    // No clear signals — default to counter (most common in mid-negotiation)
    return { action: 'counter', confidence: 0.3, signals: ['no_clear_signal'] };
  }

  const max = Math.max(acceptScore, rejectScore, counterScore);
  const confidence = Math.min(0.95, 0.4 + (max / total) * 0.5);

  if (acceptScore === max) return { action: 'accept', confidence, signals };
  if (rejectScore === max) return { action: 'reject', confidence, signals };
  return { action: 'counter', confidence, signals };
}

// ---------------------------------------------------------------------------
// NegotiationGameAdapter
// ---------------------------------------------------------------------------

export class NegotiationGameAdapter {
  /**
   * @param {Object} [options]
   * @param {Function} [options.getTracker] - override for testing
   * @param {Function} [options.getLookup]  - override for testing
   */
  constructor(options = {}) {
    this._getTracker = options.getTracker || getStateTracker;
    this._getLookup = options.getLookup || getLookupService;
    this._eventLog = []; // recent events for debugging
  }

  /**
   * Process a supplier event and apply it to any active negotiation
   * involving the same supplier/material.
   *
   * @param {Object} event - Normalized supplier event
   * @param {Object} [options]
   * @param {string} [options.negotiationId] - target specific negotiation
   * @returns {{ applied: boolean, negotiations_affected: string[], impact: Object }}
   */
  processSupplierEvent(event, options = {}) {
    const classification = classifyEventImpact(event);
    if (!classification.relevant) {
      return { applied: false, negotiations_affected: [], impact: classification };
    }

    // Compute risk delta using the existing connector logic
    const riskDelta = computeRiskDelta(event);

    const tracker = this._getTracker();
    const affected = [];

    if (options.negotiationId) {
      // Target specific negotiation
      const result = tracker.recordMarketEvent(options.negotiationId, {
        event_type: event.event_type,
        severity: event.severity,
        risk_delta: riskDelta.risk_score_delta,
        occurred_at: event.occurred_at || new Date().toISOString(),
        description: event.description || '',
      });
      if (result) affected.push(options.negotiationId);
    } else {
      // Broadcast to all active negotiations (match by supplier/material if possible)
      for (const [negId, state] of tracker._negotiations || new Map()) {
        if (state.status !== 'active') continue;

        // Match: same supplier or material if specified
        const supplierMatch = !event.supplier_id ||
          state.supplier_kpis?.supplier_id === event.supplier_id;
        const materialMatch = !event.material_code ||
          state.supplier_kpis?.material_code === event.material_code;

        if (supplierMatch || materialMatch) {
          const result = tracker.recordMarketEvent(negId, {
            event_type: event.event_type,
            severity: event.severity,
            risk_delta: riskDelta.risk_score_delta,
            occurred_at: event.occurred_at || new Date().toISOString(),
            description: event.description || '',
          });
          if (result) affected.push(negId);
        }
      }
    }

    // Log for debugging
    this._eventLog.push({
      event_id: event.event_id,
      event_type: event.event_type,
      risk_delta: riskDelta.risk_score_delta,
      negotiations_affected: affected,
      timestamp: new Date().toISOString(),
    });

    // Trim log
    if (this._eventLog.length > 100) {
      this._eventLog = this._eventLog.slice(-50);
    }

    return {
      applied: affected.length > 0,
      negotiations_affected: affected,
      impact: classification,
      risk_delta: riskDelta.risk_score_delta,
    };
  }

  /**
   * Process a user's UI action from NegotiationActionCard.
   *
   * @param {Object} params
   * @param {string} params.negotiationId
   * @param {string} params.uiAction    - 'sent' | 'skip' | 'copy'
   * @param {Object} [params.details]   - { tone, draftIndex, wasEdited, ... }
   * @returns {Object|null} updated negotiation state
   */
  async processUserAction({ negotiationId, uiAction, details = {} }) {
    const tracker = this._getTracker();
    const { NegotiationStateTracker } = await import('./negotiation-state-tracker.js');

    const cfrAction = NegotiationStateTracker.mapUiActionToCfr(uiAction, details);
    if (!cfrAction) return null; // 'copy' doesn't change state

    return tracker.recordBuyerAction(negotiationId, cfrAction, {
      ui_action: uiAction,
      ...details,
    });
  }

  /**
   * Process a supplier's text response (pasted by user).
   *
   * @param {Object} params
   * @param {string} params.negotiationId
   * @param {string} params.responseText - supplier's response text
   * @returns {{ state: Object|null, parsed: Object }}
   */
  processSupplierResponse({ negotiationId, responseText }) {
    const parsed = parseSupplierResponse(responseText);
    const tracker = this._getTracker();

    const state = tracker.recordSupplierAction(negotiationId, parsed.action, {
      parsed_from: 'text',
      confidence: parsed.confidence,
      signals: parsed.signals,
      text_preview: responseText?.slice(0, 200),
    });

    return { state, parsed };
  }

  /**
   * Update supplier type priors for a negotiation based on new KPI data.
   * Useful when KPIs are refreshed mid-negotiation.
   *
   * @param {string} negotiationId
   * @param {Object} updatedKpis - { on_time_rate, defect_rate, ... }
   * @returns {Object|null} updated supplier priors
   */
  updateSupplierPriors(negotiationId, updatedKpis) {
    const tracker = this._getTracker();
    const state = tracker._negotiations.get(negotiationId);
    if (!state) return null;

    // Update stored KPIs
    state.supplier_kpis = { ...state.supplier_kpis, ...updatedKpis };

    // Recompute priors
    const priors = computeSupplierTypePriors(updatedKpis);

    // Auto-detect nearest scenario with updated KPIs
    const lookup = this._getLookup();
    if (lookup.isLoaded) {
      const newScenario = lookup.findNearestScenario(updatedKpis);
      if (newScenario) {
        state.scenario_id = newScenario;
      }
    }

    state.updated_at = new Date().toISOString();
    return { priors, scenario_id: state.scenario_id };
  }

  /**
   * Get a summary of the current negotiation for display in UI.
   *
   * @param {string} negotiationId
   * @returns {Object|null} display-ready summary
   */
  getNegotiationSummary(negotiationId) {
    const tracker = this._getTracker();
    const state = tracker.getById(negotiationId);
    if (!state) return null;

    const buyerActions = state.action_history.filter(a => a.player_name === 'buyer');
    const supplierActions = state.action_history.filter(a => a.player_name === 'supplier');

    return {
      negotiation_id: state.negotiation_id,
      status: state.status,
      current_round: state.current_round,
      current_round_name: state.current_round_name,
      position_strength: state.buyer_position?.name || 'NEUTRAL',
      position_bucket: state.buyer_position?.bucket ?? 2,
      total_actions: state.action_history.length,
      buyer_actions: buyerActions.length,
      supplier_actions: supplierActions.length,
      market_events_count: state.market_events.length,
      cfr_strategy: state.cfr_strategy,
      rounds: buildRoundTimeline(state),
      created_at: state.created_at,
      updated_at: state.updated_at,
    };
  }

  /**
   * Get recent event log for debugging.
   */
  getEventLog() {
    return [...this._eventLog];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a round-by-round timeline from action history.
 *
 * @param {Object} state - NegotiationState
 * @returns {Object[]} timeline entries
 */
function buildRoundTimeline(state) {
  const rounds = [];
  let currentRound = -1;
  let roundEntry = null;

  for (const action of state.action_history) {
    if (action.round !== currentRound) {
      if (roundEntry) rounds.push(roundEntry);
      currentRound = action.round;
      roundEntry = {
        round: currentRound,
        round_name: action.round_name,
        actions: [],
      };
    }
    roundEntry.actions.push({
      player: action.player_name,
      action: action.action,
      timestamp: action.timestamp,
    });
  }

  if (roundEntry) rounds.push(roundEntry);

  // Add market events to their respective rounds
  for (const event of state.market_events || []) {
    const eventTime = new Date(event.occurred_at).getTime();
    // Find the round this event falls into
    for (const round of rounds) {
      const roundActions = round.actions;
      if (roundActions.length > 0) {
        const lastActionTime = new Date(roundActions[roundActions.length - 1].timestamp).getTime();
        if (eventTime >= lastActionTime) {
          round.market_events = round.market_events || [];
          round.market_events.push({
            type: event.event_type,
            severity: event.severity,
            risk_delta: event.risk_delta,
          });
          break;
        }
      }
    }
  }

  return rounds;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _adapterInstance = null;

export function getGameAdapter() {
  if (!_adapterInstance) {
    _adapterInstance = new NegotiationGameAdapter();
  }
  return _adapterInstance;
}

export function _resetGameAdapter() {
  _adapterInstance = null;
}

export default {
  NegotiationGameAdapter,
  getGameAdapter,
  _resetGameAdapter,
  classifyEventImpact,
  parseSupplierResponse,
};
