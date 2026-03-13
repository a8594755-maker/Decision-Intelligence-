/**
 * Tests: Phase E — External Signals + Outbound Communication
 *
 * Covers:
 *   - Supplier Communication Service (E1)
 *   - Macro Signal Service / Macro-Oracle (E3)
 *   - Signal-to-supplier-event conversion
 *   - Signal-to-negotiation pipeline
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── E1: Supplier Communication Service ─────────────────────────────────────

import {
  sendDraftViaEmail,
  sendDraftViaSlack,
  logOutboundAction,
  sendAndLog,
  clearRateLimiter,
  COMMUNICATION_CONFIG,
} from './supplierCommunicationService.js';

describe('Supplier Communication Service', () => {
  beforeEach(() => {
    clearRateLimiter();
  });

  describe('sendDraftViaEmail', () => {
    it('should return error when draft body is missing', async () => {
      const result = await sendDraftViaEmail({ draft: {}, recipient: 'test@example.com' });
      expect(result.sent).toBe(false);
      expect(result.error).toContain('body');
    });

    it('should return error when recipient is missing', async () => {
      const result = await sendDraftViaEmail({ draft: { body: 'Hello' }, recipient: '' });
      expect(result.sent).toBe(false);
      expect(result.error).toContain('Recipient');
    });

    it('should succeed with valid draft and recipient (stub)', async () => {
      const result = await sendDraftViaEmail({
        draft: { body: 'Proposal body', subject: 'Negotiation Update', tone: 'persuasion' },
        recipient: 'supplier@example.com',
      });
      expect(result.sent).toBe(true);
      expect(result.channel).toBe('email');
      expect(result.messageId).toMatch(/^email_/);
      expect(result.error).toBeNull();
    });
  });

  describe('sendDraftViaSlack', () => {
    it('should return error when draft body is missing', async () => {
      const result = await sendDraftViaSlack({ draft: {}, channelId: 'C123' });
      expect(result.sent).toBe(false);
      expect(result.error).toContain('body');
    });

    it('should return error when channelId is missing', async () => {
      const result = await sendDraftViaSlack({ draft: { body: 'Hello' }, channelId: '' });
      expect(result.sent).toBe(false);
      expect(result.error).toContain('Channel');
    });

    it('should succeed with valid draft and channel (stub)', async () => {
      const result = await sendDraftViaSlack({
        draft: { body: 'Counter-offer details', tone: 'collaborative' },
        channelId: 'C_NEGOTIATION',
      });
      expect(result.sent).toBe(true);
      expect(result.channel).toBe('slack');
      expect(result.messageId).toMatch(/^slack_/);
    });
  });

  describe('logOutboundAction', () => {
    it('should log a sent action and return an event ID', async () => {
      const result = await logOutboundAction({
        caseId: 'case_001',
        channel: 'manual',
        draft: { body: 'Draft text', tone: 'assertive' },
        action: 'sent',
        userId: 'user_1',
      });
      expect(result.logged).toBe(true);
      expect(result.eventId).toMatch(/^outbound_/);
      expect(result.error).toBeNull();
    });

    it('should log a skip action', async () => {
      const result = await logOutboundAction({
        caseId: 'case_002',
        channel: 'skip',
        draft: null,
        action: 'skip',
      });
      expect(result.logged).toBe(true);
    });

    it('should handle missing caseId gracefully', async () => {
      const result = await logOutboundAction({
        caseId: null,
        channel: 'manual',
        draft: { body: 'test' },
        action: 'sent',
      });
      // Should still succeed locally even without Supabase persistence
      expect(result.logged).toBe(true);
    });
  });

  describe('sendAndLog', () => {
    it('should send via email and log', async () => {
      const result = await sendAndLog({
        channel: 'email',
        draft: { body: 'Offer details', tone: 'formal', subject: 'Counter-offer' },
        caseId: 'case_003',
        recipient: 'supplier@example.com',
        supplierId: 'SUP_001',
      });
      expect(result.sent).toBe(true);
      expect(result.logged).toBe(true);
      expect(result.eventId).toBeTruthy();
    });

    it('should send via slack and log', async () => {
      const result = await sendAndLog({
        channel: 'slack',
        draft: { body: 'Update on terms', tone: 'collaborative' },
        caseId: 'case_004',
        recipient: 'C_PROCURE',
        supplierId: 'SUP_002',
      });
      expect(result.sent).toBe(true);
      expect(result.logged).toBe(true);
    });

    it('should handle manual channel (no actual send)', async () => {
      const result = await sendAndLog({
        channel: 'manual',
        draft: { body: 'Copied draft' },
        caseId: 'case_005',
      });
      expect(result.sent).toBe(true);
      expect(result.logged).toBe(true);
    });

    it('should rate-limit rapid sends to same supplier', async () => {
      // First send should succeed
      const r1 = await sendAndLog({
        channel: 'email',
        draft: { body: 'First offer' },
        caseId: 'case_006',
        recipient: 'a@b.com',
        supplierId: 'SUP_RATE',
      });
      expect(r1.sent).toBe(true);

      // Second immediate send should be rate-limited
      const r2 = await sendAndLog({
        channel: 'email',
        draft: { body: 'Second offer' },
        caseId: 'case_006',
        recipient: 'a@b.com',
        supplierId: 'SUP_RATE',
      });
      expect(r2.sent).toBe(false);
      expect(r2.error).toContain('Rate limited');
    });
  });

  describe('config', () => {
    it('should have valid defaults', () => {
      expect(COMMUNICATION_CONFIG.channels).toContain('email');
      expect(COMMUNICATION_CONFIG.channels).toContain('slack');
      expect(COMMUNICATION_CONFIG.channels).toContain('manual');
      expect(COMMUNICATION_CONFIG.max_body_length).toBeGreaterThan(0);
      expect(COMMUNICATION_CONFIG.min_send_interval_ms).toBeGreaterThan(0);
    });
  });
});

// ── E3: Macro Signal Service ────────────────────────────────────────────────

import {
  parseCommodityPrice,
  parseCurrencyMovement,
  parseGeopoliticalEvent,
  signalToSupplierEvent,
  processExternalSignals,
  feedSignalsToNegotiations,
  MACRO_SIGNAL_CONFIG,
  SIGNAL_TYPES,
} from './macroSignalService.js';

describe('Macro Signal Service', () => {
  describe('parseCommodityPrice', () => {
    it('should return null for below-threshold change', () => {
      const signal = parseCommodityPrice({
        commodity: 'steel',
        current_price: 101,
        previous_price: 100,
      });
      expect(signal).toBeNull();
    });

    it('should generate spike signal for large increase', () => {
      const signal = parseCommodityPrice({
        commodity: 'copper',
        current_price: 115,
        previous_price: 100,
        currency: 'USD',
        source: 'lme',
      });
      expect(signal).not.toBeNull();
      expect(signal.signal_type).toBe(SIGNAL_TYPES.COMMODITY_PRICE_SPIKE);
      expect(signal.commodity).toBe('copper');
      expect(signal.severity).toBe('critical'); // 15% >= 15% threshold → critical
      expect(signal.description).toContain('15.0%');
    });

    it('should generate drop signal for large decrease', () => {
      const signal = parseCommodityPrice({
        commodity: 'aluminum',
        current_price: 90,
        previous_price: 100,
      });
      expect(signal).not.toBeNull();
      expect(signal.signal_type).toBe(SIGNAL_TYPES.COMMODITY_PRICE_DROP);
      expect(signal.severity).toBe('high'); // 10% >= 10% threshold → high
    });

    it('should return null for invalid data', () => {
      expect(parseCommodityPrice(null)).toBeNull();
      expect(parseCommodityPrice({ commodity: 'steel' })).toBeNull();
      expect(parseCommodityPrice({ commodity: 'steel', current_price: 100, previous_price: 0 })).toBeNull();
    });

    it('should classify critical severity for extreme moves', () => {
      const signal = parseCommodityPrice({
        commodity: 'nickel',
        current_price: 200,
        previous_price: 100,
      });
      expect(signal.severity).toBe('critical'); // 100% >> 15%
    });
  });

  describe('parseCurrencyMovement', () => {
    it('should return null for below-threshold move', () => {
      const signal = parseCurrencyMovement({
        pair: 'USD/EUR',
        current_rate: 0.925,
        previous_rate: 0.92,
      });
      expect(signal).toBeNull();
    });

    it('should generate signal for significant currency move', () => {
      const signal = parseCurrencyMovement({
        pair: 'USD/CNY',
        current_rate: 7.5,
        previous_rate: 7.2,
        source: 'fx_market',
      });
      expect(signal).not.toBeNull();
      expect(signal.signal_type).toBe(SIGNAL_TYPES.CURRENCY_SHOCK);
      expect(signal.commodity).toBe('USD/CNY');
      expect(signal.severity).toBe('medium'); // ~4.2% → medium
    });

    it('should return null for invalid data', () => {
      expect(parseCurrencyMovement(null)).toBeNull();
      expect(parseCurrencyMovement({ pair: 'USD/EUR' })).toBeNull();
    });
  });

  describe('parseGeopoliticalEvent', () => {
    it('should parse a conflict event', () => {
      const signal = parseGeopoliticalEvent({
        event_type: 'conflict',
        region: 'Middle East',
        severity: 'high',
        description: 'Regional conflict escalation',
        affected_commodities: ['oil'],
      });
      expect(signal).not.toBeNull();
      expect(signal.signal_type).toBe(SIGNAL_TYPES.GEOPOLITICAL_DISRUPTION);
      expect(signal.region).toBe('Middle East');
      expect(signal.severity).toBe('high');
      expect(signal.commodity).toBe('oil');
    });

    it('should parse trade restriction', () => {
      const signal = parseGeopoliticalEvent({
        event_type: 'sanctions',
        region: 'APAC',
        severity: 'critical',
      });
      expect(signal.signal_type).toBe(SIGNAL_TYPES.TRADE_RESTRICTION);
    });

    it('should parse natural disaster', () => {
      const signal = parseGeopoliticalEvent({
        event_type: 'earthquake',
        region: 'Japan',
        severity: 'critical',
        description: 'Major earthquake in semiconductor region',
      });
      expect(signal.signal_type).toBe(SIGNAL_TYPES.NATURAL_DISASTER);
    });

    it('should return null for invalid input', () => {
      expect(parseGeopoliticalEvent(null)).toBeNull();
      expect(parseGeopoliticalEvent({ event_type: 'war' })).toBeNull(); // no region
    });
  });

  describe('signalToSupplierEvent', () => {
    it('should convert price spike to price_change event', () => {
      const signal = {
        signal_id: 'commodity_steel_123',
        signal_type: SIGNAL_TYPES.COMMODITY_PRICE_SPIKE,
        source: 'lme',
        commodity: 'steel',
        region: 'EU',
        magnitude: 45,
        severity: 'high',
        description: 'Steel price up 15%',
        detected_at: '2026-03-10T10:00:00Z',
        raw_data: { previous_price: 100, current_price: 115, currency: 'EUR' },
      };

      const event = signalToSupplierEvent(signal, { supplier_id: 'SUP_STEEL' });
      expect(event.event_type).toBe('price_change');
      expect(event.supplier_id).toBe('SUP_STEEL');
      expect(event.severity).toBe('high');
      expect(event.details.old_unit_price).toBe(100);
      expect(event.details.new_unit_price).toBe(115);
      expect(event.source_system).toContain('macro_oracle');
    });

    it('should convert geopolitical disruption to force_majeure', () => {
      const signal = {
        signal_id: 'geo_conflict_123',
        signal_type: SIGNAL_TYPES.GEOPOLITICAL_DISRUPTION,
        source: 'geopolitical_feed',
        commodity: null,
        region: 'Middle East',
        magnitude: 70,
        severity: 'high',
        description: 'Regional conflict',
        detected_at: '2026-03-10T10:00:00Z',
        raw_data: {},
      };

      const event = signalToSupplierEvent(signal);
      expect(event.event_type).toBe('force_majeure');
      expect(event.details.estimated_duration_days).toBe(14); // high → 14 days
    });

    it('should convert port congestion to shipment_status', () => {
      const signal = {
        signal_id: 'port_123',
        signal_type: SIGNAL_TYPES.PORT_CONGESTION,
        source: 'port_feed',
        severity: 'medium',
        region: 'Asia',
        magnitude: 40,
        description: 'Port congestion',
        detected_at: '2026-03-10T10:00:00Z',
        raw_data: {},
      };

      const event = signalToSupplierEvent(signal);
      expect(event.event_type).toBe('shipment_status');
      expect(event.details.status).toBe('delayed');
    });

    it('should use default supplier ID when none provided', () => {
      const signal = {
        signal_id: 'test_1',
        signal_type: SIGNAL_TYPES.CURRENCY_SHOCK,
        severity: 'medium',
        region: 'EU',
        magnitude: 30,
        detected_at: '2026-03-10T10:00:00Z',
        raw_data: { previous_rate: 1.0, current_rate: 1.05 },
      };

      const event = signalToSupplierEvent(signal);
      expect(event.supplier_id).toBe('macro_EU');
    });
  });

  describe('processExternalSignals', () => {
    it('should process mixed signal sources', () => {
      const result = processExternalSignals({
        commodityPrices: [
          { commodity: 'steel', current_price: 120, previous_price: 100 },
          { commodity: 'copper', current_price: 101, previous_price: 100 }, // below threshold
        ],
        currencyMoves: [
          { pair: 'USD/CNY', current_rate: 7.5, previous_rate: 7.2 },
        ],
        geopoliticalEvents: [
          { event_type: 'sanctions', region: 'APAC', severity: 'high' },
        ],
      });

      expect(result.signals.length).toBe(3); // steel + USD/CNY + sanctions
      expect(result.skipped).toBe(1); // copper below threshold
      expect(result.supplierEvents.length).toBe(3);
    });

    it('should handle empty inputs', () => {
      const result = processExternalSignals({});
      expect(result.signals).toHaveLength(0);
      expect(result.supplierEvents).toHaveLength(0);
      expect(result.skipped).toBe(0);
    });

    it('should cap signals per cycle', () => {
      const manyPrices = Array.from({ length: 100 }, (_, i) => ({
        commodity: `commodity_${i}`,
        current_price: 200,
        previous_price: 100, // 100% change — all will pass threshold
      }));

      const result = processExternalSignals({
        commodityPrices: manyPrices,
        config: { ...MACRO_SIGNAL_CONFIG, max_signals_per_cycle: 10 },
      });

      expect(result.signals.length).toBeLessThanOrEqual(10);
      expect(result.supplierEvents.length).toBeLessThanOrEqual(10);
    });
  });

  describe('feedSignalsToNegotiations', () => {
    it('should return zero updates with no state tracker', () => {
      const result = feedSignalsToNegotiations({ signals: [], stateTracker: null });
      expect(result.updated).toBe(0);
      expect(result.skipped).toBe(0);
    });

    it('should feed signals to a mock state tracker', () => {
      const mockTracker = {
        _negotiations: new Map([
          ['neg_1', { status: 'active' }],
        ]),
        recordMarketEvent: vi.fn().mockReturnValue({ status: 'active' }),
      };

      const signals = [
        {
          signal_id: 'sig_1',
          signal_type: SIGNAL_TYPES.COMMODITY_PRICE_SPIKE,
          severity: 'high',
          magnitude: 60,
          detected_at: '2026-03-10T10:00:00Z',
          description: 'Steel price spike',
        },
      ];

      const result = feedSignalsToNegotiations({
        signals,
        stateTracker: mockTracker,
      });

      expect(result.updated).toBe(1);
      expect(mockTracker.recordMarketEvent).toHaveBeenCalledWith('neg_1', expect.objectContaining({
        event_type: SIGNAL_TYPES.COMMODITY_PRICE_SPIKE,
        severity: 'high',
      }));
    });
  });

  describe('config', () => {
    it('should have valid defaults', () => {
      expect(MACRO_SIGNAL_CONFIG.poll_interval_ms).toBeGreaterThan(0);
      expect(MACRO_SIGNAL_CONFIG.commodity_price_change_threshold_pct).toBeGreaterThan(0);
      expect(MACRO_SIGNAL_CONFIG.currency_change_threshold_pct).toBeGreaterThan(0);
      expect(MACRO_SIGNAL_CONFIG.max_signals_per_cycle).toBeGreaterThan(0);
    });

    it('should have mappings for all signal types', () => {
      for (const signalType of Object.values(SIGNAL_TYPES)) {
        expect(MACRO_SIGNAL_CONFIG.signal_to_event_type[signalType]).toBeTruthy();
      }
    });
  });
});
