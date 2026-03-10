/**
 * Phase 3 Tests — Multi-round State Tracking + Market Dynamics
 *
 * Tests for:
 *   - NegotiationStateTracker (state machine, action recording, expiry)
 *   - NegotiationGameAdapter (event processing, response parsing, UI action mapping)
 *   - Integration: event → adapter → tracker → CFR re-query
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  NegotiationStateTracker,
  getStateTracker,
  _resetStateTracker,
  NEGOTIATION_STATUS,
} from './negotiation-state-tracker.js';

import {
  NegotiationGameAdapter,
  classifyEventImpact,
  parseSupplierResponse,
  getGameAdapter,
  _resetGameAdapter,
} from './negotiation-game-adapter.js';

import { ACTIONS, ROUND_ORDER } from './negotiation-types.js';

// ---------------------------------------------------------------------------
// Mock: negotiation-lookup-service
// ---------------------------------------------------------------------------

vi.mock('./negotiation-lookup-service.js', () => {
  const mockLookup = {
    isLoaded: false,
    findNearestScenario: vi.fn(() => null),
    lookupStrategy: vi.fn(() => ({ found: false })),
  };
  return {
    getLookupService: () => mockLookup,
    __mockLookup: mockLookup,
  };
});

// Mock computeRiskDelta from supplierEventConnectorService
vi.mock('../../supplierEventConnectorService', () => ({
  computeRiskDelta: vi.fn((event) => ({
    material_code: event.material_code || null,
    plant_id: event.plant_id || null,
    supplier_id: event.supplier_id || 'SUP001',
    risk_score_delta: event.severity === 'critical' ? 40 : event.severity === 'high' ? 20 : 10,
    metrics_delta: { p90_delay_days: null, overdue_ratio: null },
    evidence_refs: [`event_type=${event.event_type}`],
  })),
  EVENT_CONNECTOR_CONFIG: {},
}));

// ---------------------------------------------------------------------------
// NegotiationStateTracker Tests
// ---------------------------------------------------------------------------

describe('NegotiationStateTracker', () => {
  let tracker;

  beforeEach(() => {
    _resetStateTracker();
    tracker = new NegotiationStateTracker();
  });

  describe('startNegotiation', () => {
    it('should create a new negotiation with correct initial state', () => {
      const state = tracker.startNegotiation({
        planRunId: 42,
        trigger: 'infeasible',
        riskScore: 100,
        supplierKpis: { on_time_rate: 0.85 },
      });

      expect(state.negotiation_id).toMatch(/^neg_42_/);
      expect(state.plan_run_id).toBe(42);
      expect(state.status).toBe(NEGOTIATION_STATUS.ACTIVE);
      expect(state.current_round).toBe(0);
      expect(state.current_round_name).toBe('OPENING');
      expect(state.action_history).toHaveLength(0);
      expect(state.cfr_history_key).toBe('');
      expect(state.trigger).toBe('infeasible');
    });

    it('should compute buyer position bucket from risk score', () => {
      const state = tracker.startNegotiation({
        planRunId: 1,
        trigger: 'kpi_shortfall',
        riskScore: 30, // VERY_STRONG
      });
      expect(state.buyer_position.bucket).toBe(4);

      const state2 = tracker.startNegotiation({
        planRunId: 2,
        trigger: 'kpi_shortfall',
        riskScore: 170, // VERY_WEAK
      });
      expect(state2.buyer_position.bucket).toBe(0);
    });

    it('should track by plan run ID', () => {
      tracker.startNegotiation({
        planRunId: 99,
        trigger: 'infeasible',
        riskScore: 100,
      });
      const found = tracker.getByPlanRun(99);
      expect(found).not.toBeNull();
      expect(found.plan_run_id).toBe(99);
    });
  });

  describe('recordBuyerAction', () => {
    it('should record action and update CFR history key', () => {
      const { negotiation_id } = tracker.startNegotiation({
        planRunId: 1,
        trigger: 'infeasible',
        riskScore: 100,
      });

      const state = tracker.recordBuyerAction(negotiation_id, ACTIONS.COUNTER);
      expect(state.action_history).toHaveLength(1);
      expect(state.action_history[0].player_name).toBe('buyer');
      expect(state.action_history[0].action).toBe('counter');
      expect(state.cfr_history_key).toBe('c');
    });

    it('should resolve on accept', () => {
      const { negotiation_id } = tracker.startNegotiation({
        planRunId: 1,
        trigger: 'infeasible',
        riskScore: 100,
      });

      const state = tracker.recordBuyerAction(negotiation_id, ACTIONS.ACCEPT);
      expect(state.status).toBe(NEGOTIATION_STATUS.RESOLVED_AGREEMENT);
    });

    it('should resolve walkaway on reject in final round', () => {
      const { negotiation_id } = tracker.startNegotiation({
        planRunId: 1,
        trigger: 'infeasible',
        riskScore: 100,
      });

      // Advance to CLOSING (round 2)
      tracker.recordBuyerAction(negotiation_id, ACTIONS.COUNTER);
      tracker.recordSupplierAction(negotiation_id, ACTIONS.COUNTER); // → CONCESSION
      tracker.recordBuyerAction(negotiation_id, ACTIONS.COUNTER);
      tracker.recordSupplierAction(negotiation_id, ACTIONS.COUNTER); // → CLOSING

      const state = tracker.recordBuyerAction(negotiation_id, ACTIONS.REJECT);
      expect(state.status).toBe(NEGOTIATION_STATUS.RESOLVED_WALKAWAY);
    });

    it('should return null for non-active negotiation', () => {
      const { negotiation_id } = tracker.startNegotiation({
        planRunId: 1,
        trigger: 'infeasible',
        riskScore: 100,
      });
      tracker.recordBuyerAction(negotiation_id, ACTIONS.ACCEPT);
      // Already resolved
      const result = tracker.recordBuyerAction(negotiation_id, ACTIONS.COUNTER);
      expect(result).toBeNull();
    });
  });

  describe('recordSupplierAction', () => {
    it('should advance round on supplier counter', () => {
      const { negotiation_id } = tracker.startNegotiation({
        planRunId: 1,
        trigger: 'infeasible',
        riskScore: 100,
      });

      tracker.recordBuyerAction(negotiation_id, ACTIONS.COUNTER);
      const state = tracker.recordSupplierAction(negotiation_id, ACTIONS.COUNTER);

      expect(state.current_round).toBe(1);
      expect(state.current_round_name).toBe('CONCESSION');
      expect(state.cfr_history_key).toBe('c:c');
    });

    it('should resolve on supplier accept', () => {
      const { negotiation_id } = tracker.startNegotiation({
        planRunId: 1,
        trigger: 'infeasible',
        riskScore: 100,
      });
      tracker.recordBuyerAction(negotiation_id, ACTIONS.COUNTER);

      const state = tracker.recordSupplierAction(negotiation_id, ACTIONS.ACCEPT);
      expect(state.status).toBe(NEGOTIATION_STATUS.RESOLVED_AGREEMENT);
    });

    it('should build correct multi-action history key', () => {
      const { negotiation_id } = tracker.startNegotiation({
        planRunId: 1,
        trigger: 'infeasible',
        riskScore: 100,
      });

      tracker.recordBuyerAction(negotiation_id, ACTIONS.COUNTER);
      tracker.recordSupplierAction(negotiation_id, ACTIONS.COUNTER);
      tracker.recordBuyerAction(negotiation_id, ACTIONS.REJECT);
      const state = tracker.recordSupplierAction(negotiation_id, ACTIONS.COUNTER);

      expect(state.cfr_history_key).toBe('c:c:r:c');
    });
  });

  describe('recordMarketEvent', () => {
    it('should record event and re-compute position bucket', () => {
      const { negotiation_id } = tracker.startNegotiation({
        planRunId: 1,
        trigger: 'infeasible',
        riskScore: 100,
      });

      const state = tracker.recordMarketEvent(negotiation_id, {
        event_type: 'delivery_delay',
        severity: 'high',
        risk_delta: 30, // risk goes from 100 → 130
        occurred_at: new Date().toISOString(),
        description: 'Late shipment',
      });

      expect(state.market_events).toHaveLength(1);
      // Higher risk = weaker buyer position
      expect(state.buyer_position.risk_score).toBe(130);
    });

    it('should not affect non-active negotiations', () => {
      const { negotiation_id } = tracker.startNegotiation({
        planRunId: 1,
        trigger: 'infeasible',
        riskScore: 100,
      });
      tracker.recordBuyerAction(negotiation_id, ACTIONS.ACCEPT);

      const result = tracker.recordMarketEvent(negotiation_id, {
        event_type: 'force_majeure',
        severity: 'critical',
        risk_delta: 50,
      });
      expect(result).toBeNull();
    });
  });

  describe('mapUiActionToCfr', () => {
    it('should map sent+hardball to counter', () => {
      expect(NegotiationStateTracker.mapUiActionToCfr('sent', { tone: 'hardball' })).toBe('counter');
    });

    it('should map sent+win_win to accept', () => {
      expect(NegotiationStateTracker.mapUiActionToCfr('sent', { tone: 'win_win' })).toBe('accept');
    });

    it('should map skip to reject', () => {
      expect(NegotiationStateTracker.mapUiActionToCfr('skip')).toBe('reject');
    });

    it('should map copy to null', () => {
      expect(NegotiationStateTracker.mapUiActionToCfr('copy')).toBeNull();
    });

    it('should map sent+persuasion to counter', () => {
      expect(NegotiationStateTracker.mapUiActionToCfr('sent', { tone: 'persuasion' })).toBe('counter');
    });
  });

  describe('expireStale', () => {
    it('should expire negotiations older than maxAge', () => {
      const { negotiation_id } = tracker.startNegotiation({
        planRunId: 1,
        trigger: 'infeasible',
        riskScore: 100,
      });

      // Manipulate updated_at to be old
      const state = tracker._negotiations.get(negotiation_id);
      state.updated_at = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

      const expired = tracker.expireStale();
      expect(expired).toBe(1);

      const s = tracker.getById(negotiation_id);
      expect(s.status).toBe(NEGOTIATION_STATUS.EXPIRED);
    });

    it('should not expire recent negotiations', () => {
      tracker.startNegotiation({
        planRunId: 1,
        trigger: 'infeasible',
        riskScore: 100,
      });

      const expired = tracker.expireStale();
      expect(expired).toBe(0);
    });
  });

  describe('exportAsArtifact / importFromArtifact', () => {
    it('should roundtrip through artifact export/import', () => {
      const { negotiation_id } = tracker.startNegotiation({
        planRunId: 42,
        trigger: 'infeasible',
        riskScore: 80,
        supplierKpis: { on_time_rate: 0.9 },
      });

      tracker.recordBuyerAction(negotiation_id, ACTIONS.COUNTER, { tone: 'hardball' });

      const artifact = tracker.exportAsArtifact(negotiation_id);
      expect(artifact.version).toBe('v1');
      expect(artifact.total_actions).toBe(1);

      // Import into a fresh tracker
      const tracker2 = new NegotiationStateTracker();
      const imported = tracker2.importFromArtifact(artifact);

      expect(imported.negotiation_id).toBe(negotiation_id);
      expect(imported.plan_run_id).toBe(42);
      expect(imported.action_history).toHaveLength(1);
      expect(imported.cfr_history_key).toBe('c');
    });
  });

  describe('activeCount', () => {
    it('should count active negotiations', () => {
      tracker.startNegotiation({ planRunId: 1, trigger: 'infeasible', riskScore: 100 });
      tracker.startNegotiation({ planRunId: 2, trigger: 'infeasible', riskScore: 100 });
      expect(tracker.activeCount).toBe(2);

      const { negotiation_id } = tracker.startNegotiation({ planRunId: 3, trigger: 'infeasible', riskScore: 100 });
      tracker.recordBuyerAction(negotiation_id, ACTIONS.ACCEPT);
      expect(tracker.activeCount).toBe(2);
    });
  });

  describe('singleton', () => {
    it('should return the same instance', () => {
      _resetStateTracker();
      const a = getStateTracker();
      const b = getStateTracker();
      expect(a).toBe(b);
    });
  });
});

// ---------------------------------------------------------------------------
// classifyEventImpact Tests
// ---------------------------------------------------------------------------

describe('classifyEventImpact', () => {
  it('should classify delivery_delay as buyer_gains', () => {
    const result = classifyEventImpact({ event_type: 'delivery_delay', severity: 'high' });
    expect(result.relevant).toBe(true);
    expect(result.leverage_shift).toBe('buyer_gains');
  });

  it('should classify force_majeure as both_lose', () => {
    const result = classifyEventImpact({ event_type: 'force_majeure', severity: 'critical' });
    expect(result.relevant).toBe(true);
    expect(result.leverage_shift).toBe('both_lose');
  });

  it('should classify low severity shipment_status as not relevant', () => {
    const result = classifyEventImpact({ event_type: 'shipment_status', severity: 'low' });
    expect(result.relevant).toBe(false);
  });

  it('should handle unknown event types', () => {
    const result = classifyEventImpact({ event_type: 'unknown_type' });
    expect(result.relevant).toBe(false);
  });

  it('should classify price_change as market_shift', () => {
    const result = classifyEventImpact({ event_type: 'price_change', severity: 'medium' });
    expect(result.relevant).toBe(true);
    expect(result.impact).toBe('market_shift');
  });
});

// ---------------------------------------------------------------------------
// parseSupplierResponse Tests
// ---------------------------------------------------------------------------

describe('parseSupplierResponse', () => {
  it('should detect accept signals in English', () => {
    const result = parseSupplierResponse('We agree to the proposed terms. Deal confirmed.');
    expect(result.action).toBe('accept');
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('should detect reject signals in English', () => {
    const result = parseSupplierResponse('We cannot accept these terms. This is unacceptable.');
    expect(result.action).toBe('reject');
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('should detect counter signals in English', () => {
    const result = parseSupplierResponse('We propose an alternative: how about $45/unit instead?');
    expect(result.action).toBe('counter');
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('should detect accept signals in Chinese', () => {
    const result = parseSupplierResponse('我們同意這個方案，沒問題。');
    expect(result.action).toBe('accept');
  });

  it('should detect reject signals in Chinese', () => {
    const result = parseSupplierResponse('不行，我們拒絕這個條件。');
    expect(result.action).toBe('reject');
  });

  it('should detect counter signals in Chinese', () => {
    const result = parseSupplierResponse('我們建議折衷方案，如果可以的話。');
    expect(result.action).toBe('counter');
  });

  it('should return counter with low confidence for empty/ambiguous input', () => {
    const result = parseSupplierResponse('');
    expect(result.action).toBe('counter');
    expect(result.confidence).toBe(0.3);
  });

  it('should return counter with low confidence for null input', () => {
    const result = parseSupplierResponse(null);
    expect(result.action).toBe('counter');
    expect(result.confidence).toBe(0.3);
  });
});

// ---------------------------------------------------------------------------
// NegotiationGameAdapter Tests
// ---------------------------------------------------------------------------

describe('NegotiationGameAdapter', () => {
  let adapter;
  let mockTracker;

  beforeEach(() => {
    _resetStateTracker();
    _resetGameAdapter();
    mockTracker = new NegotiationStateTracker();
    adapter = new NegotiationGameAdapter({
      getTracker: () => mockTracker,
    });
  });

  describe('processSupplierEvent', () => {
    it('should apply relevant events to active negotiations', () => {
      const { negotiation_id } = mockTracker.startNegotiation({
        planRunId: 1,
        trigger: 'infeasible',
        riskScore: 100,
        supplierKpis: { supplier_id: 'SUP001' },
      });

      const result = adapter.processSupplierEvent(
        {
          event_type: 'delivery_delay',
          severity: 'high',
          supplier_id: 'SUP001',
          occurred_at: new Date().toISOString(),
        },
        { negotiationId: negotiation_id }
      );

      expect(result.applied).toBe(true);
      expect(result.negotiations_affected).toContain(negotiation_id);
    });

    it('should not apply irrelevant events', () => {
      mockTracker.startNegotiation({
        planRunId: 1,
        trigger: 'infeasible',
        riskScore: 100,
      });

      const result = adapter.processSupplierEvent({
        event_type: 'shipment_status',
        severity: 'low',
        supplier_id: 'SUP001',
      });

      expect(result.applied).toBe(false);
    });

    it('should log events for debugging', () => {
      const { negotiation_id } = mockTracker.startNegotiation({
        planRunId: 1,
        trigger: 'infeasible',
        riskScore: 100,
      });

      adapter.processSupplierEvent(
        {
          event_id: 'evt_001',
          event_type: 'quality_alert',
          severity: 'medium',
          occurred_at: new Date().toISOString(),
        },
        { negotiationId: negotiation_id }
      );

      const log = adapter.getEventLog();
      expect(log).toHaveLength(1);
      expect(log[0].event_id).toBe('evt_001');
    });
  });

  describe('processSupplierResponse', () => {
    it('should parse supplier text and record action', () => {
      const { negotiation_id } = mockTracker.startNegotiation({
        planRunId: 1,
        trigger: 'infeasible',
        riskScore: 100,
      });
      // Buyer acts first
      mockTracker.recordBuyerAction(negotiation_id, ACTIONS.COUNTER);

      const { state, parsed } = adapter.processSupplierResponse({
        negotiationId: negotiation_id,
        responseText: 'We propose meeting halfway at $48/unit instead.',
      });

      expect(parsed.action).toBe('counter');
      expect(state).not.toBeNull();
      expect(state.current_round).toBe(1); // advanced to CONCESSION
    });

    it('should resolve on supplier accept text', () => {
      const { negotiation_id } = mockTracker.startNegotiation({
        planRunId: 1,
        trigger: 'infeasible',
        riskScore: 100,
      });
      mockTracker.recordBuyerAction(negotiation_id, ACTIONS.COUNTER);

      const { state } = adapter.processSupplierResponse({
        negotiationId: negotiation_id,
        responseText: 'We agree to your terms. Deal confirmed.',
      });

      expect(state.status).toBe(NEGOTIATION_STATUS.RESOLVED_AGREEMENT);
    });
  });

  describe('getNegotiationSummary', () => {
    it('should return a display-ready summary', () => {
      const { negotiation_id } = mockTracker.startNegotiation({
        planRunId: 1,
        trigger: 'infeasible',
        riskScore: 100,
      });
      mockTracker.recordBuyerAction(negotiation_id, ACTIONS.COUNTER);
      mockTracker.recordSupplierAction(negotiation_id, ACTIONS.COUNTER);

      const summary = adapter.getNegotiationSummary(negotiation_id);
      expect(summary.total_actions).toBe(2);
      expect(summary.buyer_actions).toBe(1);
      expect(summary.supplier_actions).toBe(1);
      expect(summary.current_round_name).toBe('CONCESSION');
      expect(summary.rounds).toHaveLength(1); // all in OPENING
    });

    it('should return null for unknown negotiation', () => {
      expect(adapter.getNegotiationSummary('nonexistent')).toBeNull();
    });
  });

  describe('singleton', () => {
    it('should return same instance via getGameAdapter', () => {
      _resetGameAdapter();
      const a = getGameAdapter();
      const b = getGameAdapter();
      expect(a).toBe(b);
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: Full negotiation lifecycle
// ---------------------------------------------------------------------------

describe('Integration: Full negotiation lifecycle', () => {
  let tracker;
  let adapter;

  beforeEach(() => {
    _resetStateTracker();
    tracker = new NegotiationStateTracker();
    adapter = new NegotiationGameAdapter({ getTracker: () => tracker });
  });

  it('should complete a 3-round negotiation with agreement', () => {
    // Round 1: OPENING
    const { negotiation_id } = tracker.startNegotiation({
      planRunId: 1,
      trigger: 'infeasible',
      riskScore: 80,
      supplierKpis: { on_time_rate: 0.85 },
    });

    // Buyer sends hardball draft
    const s1 = tracker.recordBuyerAction(negotiation_id, ACTIONS.COUNTER, { tone: 'hardball' });
    expect(s1.current_round).toBe(0);
    expect(s1.cfr_history_key).toBe('c');

    // Supplier counters
    const s2 = tracker.recordSupplierAction(negotiation_id, ACTIONS.COUNTER);
    expect(s2.current_round).toBe(1);
    expect(s2.current_round_name).toBe('CONCESSION');
    expect(s2.cfr_history_key).toBe('c:c');

    // Market event: delivery delay → buyer position weakens
    const s3 = tracker.recordMarketEvent(negotiation_id, {
      event_type: 'delivery_delay',
      severity: 'high',
      risk_delta: 25,
    });
    expect(s3.market_events).toHaveLength(1);

    // Round 2: CONCESSION
    const s4 = tracker.recordBuyerAction(negotiation_id, ACTIONS.COUNTER, { tone: 'persuasion' });
    expect(s4.cfr_history_key).toBe('c:c:c');

    const s5 = tracker.recordSupplierAction(negotiation_id, ACTIONS.COUNTER);
    expect(s5.current_round).toBe(2);
    expect(s5.current_round_name).toBe('CLOSING');

    // Round 3: CLOSING — buyer accepts
    const s6 = tracker.recordBuyerAction(negotiation_id, ACTIONS.ACCEPT, { tone: 'win_win' });
    expect(s6.status).toBe(NEGOTIATION_STATUS.RESOLVED_AGREEMENT);
    expect(s6.cfr_history_key).toBe('c:c:c:c:a');
    expect(s6.action_history).toHaveLength(5);
  });

  it('should handle walkaway after 3 rounds of rejection', () => {
    const { negotiation_id } = tracker.startNegotiation({
      planRunId: 2,
      trigger: 'kpi_shortfall',
      riskScore: 50,
    });

    // Fast-forward to final round
    tracker.recordBuyerAction(negotiation_id, ACTIONS.COUNTER);
    tracker.recordSupplierAction(negotiation_id, ACTIONS.COUNTER);
    tracker.recordBuyerAction(negotiation_id, ACTIONS.COUNTER);
    tracker.recordSupplierAction(negotiation_id, ACTIONS.COUNTER);

    // Supplier rejects in CLOSING
    const s = tracker.recordSupplierAction(negotiation_id, ACTIONS.REJECT);
    expect(s.status).toBe(NEGOTIATION_STATUS.RESOLVED_WALKAWAY);
  });

  it('should export and re-import preserving full state', () => {
    const { negotiation_id } = tracker.startNegotiation({
      planRunId: 10,
      trigger: 'infeasible',
      riskScore: 100,
      supplierKpis: { on_time_rate: 0.75 },
    });
    tracker.recordBuyerAction(negotiation_id, ACTIONS.COUNTER);
    tracker.recordSupplierAction(negotiation_id, ACTIONS.COUNTER);
    tracker.recordMarketEvent(negotiation_id, {
      event_type: 'price_change',
      severity: 'medium',
      risk_delta: 5,
    });

    const artifact = tracker.exportAsArtifact(negotiation_id);

    // Import into fresh tracker
    const tracker2 = new NegotiationStateTracker();
    const imported = tracker2.importFromArtifact(artifact);

    expect(imported.current_round).toBe(1);
    expect(imported.current_round_name).toBe('CONCESSION');
    expect(imported.action_history).toHaveLength(2);
    expect(imported.market_events).toHaveLength(1);
    expect(imported.cfr_history_key).toBe('c:c');

    // Can continue the negotiation
    const s = tracker2.recordBuyerAction(imported.negotiation_id, ACTIONS.ACCEPT);
    expect(s.status).toBe(NEGOTIATION_STATUS.RESOLVED_AGREEMENT);
  });

  it('should process supplier text response via adapter', () => {
    const { negotiation_id } = tracker.startNegotiation({
      planRunId: 5,
      trigger: 'infeasible',
      riskScore: 100,
    });
    tracker.recordBuyerAction(negotiation_id, ACTIONS.COUNTER);

    const { state, parsed } = adapter.processSupplierResponse({
      negotiationId: negotiation_id,
      responseText: 'Confirmed, we accept your revised pricing. 同意報價。',
    });

    expect(parsed.action).toBe('accept');
    expect(state.status).toBe(NEGOTIATION_STATUS.RESOLVED_AGREEMENT);
  });
});
