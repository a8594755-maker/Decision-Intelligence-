/**
 * supplierEventConnectorService.test.js
 *
 * Unit tests for the real-time Supplier Event Connector.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  normalizeSupplierEvent,
  computeRiskDelta,
  applyRiskDeltaToScores,
  buildSupplierEventChatMessage,
  processSupplierEvent,
  processSupplierEventBatch,
  clearEventDedup,
  EVENT_CONNECTOR_CONFIG,
} from './supplierEventConnectorService';

// ── Mock dependencies ────────────────────────────────────────────────────────

vi.mock('./riskClosedLoopService', () => ({
  evaluateRiskReplanRecommendation: vi.fn(() => ({
    shouldReplan: false,
    recommendationCard: null,
    analysis: { shouldReplan: false, highRiskSkus: [], criticalRiskSkus: [], maxScore: 0 },
  })),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: () => ({
      insert: () => ({ data: null, error: null }),
    }),
  })),
}));

// ── Test Data ────────────────────────────────────────────────────────────────

const VALID_DELAY_EVENT = {
  event_id: 'evt-001',
  event_type: 'delivery_delay',
  supplier_id: 'SUP-A',
  supplier_name: 'Acme Corp',
  material_code: 'mat-100',
  plant_id: 'p1',
  severity: 'high',
  occurred_at: '2026-02-21T10:00:00Z',
  source_system: 'ERP',
  details: {
    original_eta: '2026-02-20',
    revised_eta: '2026-02-27',
    delay_days: 7,
    reason: 'Port congestion',
  },
};

const VALID_QUALITY_EVENT = {
  event_id: 'evt-002',
  event_type: 'quality_alert',
  supplier_id: 'SUP-B',
  material_code: 'MAT-200',
  severity: 'critical',
  occurred_at: '2026-02-21T11:00:00Z',
  details: {
    defect_rate_pct: 15,
    reject_qty: 500,
    quality_category: 'major',
  },
};

const VALID_FORCE_MAJEURE_EVENT = {
  event_id: 'evt-003',
  event_type: 'force_majeure',
  supplier_id: 'SUP-C',
  severity: 'critical',
  occurred_at: '2026-02-21T12:00:00Z',
  details: {
    event_category: 'natural_disaster',
    affected_region: 'Southeast Asia',
    estimated_duration_days: 21,
    affected_materials: ['MAT-100', 'MAT-200'],
  },
};

const VALID_CAPACITY_EVENT = {
  event_id: 'evt-004',
  event_type: 'capacity_change',
  supplier_id: 'SUP-D',
  material_code: 'MAT-300',
  severity: 'medium',
  occurred_at: '2026-02-21T13:00:00Z',
  details: {
    previous_capacity_pct: 100,
    new_capacity_pct: 60,
    effective_date: '2026-03-01',
    reason: 'Equipment maintenance',
  },
};

const VALID_SHIPMENT_EVENT = {
  event_id: 'evt-005',
  event_type: 'shipment_status',
  supplier_id: 'SUP-A',
  material_code: 'MAT-100',
  severity: 'high',
  occurred_at: '2026-02-21T14:00:00Z',
  details: {
    shipment_id: 'SHIP-001',
    status: 'delayed',
    current_location: 'Port of Shanghai',
    revised_eta: '2026-03-05',
  },
};

const VALID_PRICE_EVENT = {
  event_id: 'evt-006',
  event_type: 'price_change',
  supplier_id: 'SUP-E',
  material_code: 'MAT-400',
  severity: 'low',
  occurred_at: '2026-02-21T15:00:00Z',
  details: {
    old_unit_price: 10,
    new_unit_price: 12,
    currency: 'USD',
    effective_date: '2026-03-01',
  },
};

const EXISTING_RISK_SCORES = [
  {
    entity_type: 'supplier_material',
    entity_id: 'SUP-A_MAT-100',
    material_code: 'MAT-100',
    plant_id: 'P1',
    supplier: 'SUP-A',
    risk_score: 45,
    metrics: {
      p90_delay_days: 3,
      overdue_ratio: 0.1,
      on_time_rate: 0.85,
      avg_delay_days: 2,
    },
    drivers: [],
    evidence_refs: ['existing_data'],
  },
];

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  clearEventDedup();
  vi.clearAllMocks();
});

describe('normalizeSupplierEvent', () => {
  it('accepts a valid delivery_delay event', () => {
    const result = normalizeSupplierEvent(VALID_DELAY_EVENT);
    expect(result.valid).toBe(true);
    expect(result.event).toBeTruthy();
    expect(result.error).toBeNull();
  });

  it('uppercases material_code during normalization', () => {
    const result = normalizeSupplierEvent(VALID_DELAY_EVENT);
    expect(result.event.material_code).toBe('MAT-100');
  });

  it('uppercases plant_id during normalization', () => {
    const result = normalizeSupplierEvent(VALID_DELAY_EVENT);
    expect(result.event.plant_id).toBe('P1');
  });

  it('rejects an event missing event_type', () => {
    const result = normalizeSupplierEvent({ event_id: 'x', supplier_id: 'y' });
    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('rejects an event with invalid event_type', () => {
    const result = normalizeSupplierEvent({
      ...VALID_DELAY_EVENT,
      event_type: 'invalid_type',
    });
    expect(result.valid).toBe(false);
  });

  it('rejects an event missing supplier_id', () => {
    const result = normalizeSupplierEvent({
      event_id: 'x',
      event_type: 'delivery_delay',
      occurred_at: '2026-01-01',
    });
    expect(result.valid).toBe(false);
  });

  it('defaults severity to medium', () => {
    const result = normalizeSupplierEvent({
      event_id: 'evt-def',
      event_type: 'delivery_delay',
      supplier_id: 'SUP-X',
      occurred_at: '2026-01-01T00:00:00Z',
      details: { original_eta: '2026-01-01', revised_eta: '2026-01-05', delay_days: 4 },
    });
    expect(result.valid).toBe(true);
    expect(result.event.severity).toBe('medium');
  });

  it('accepts force_majeure without material_code', () => {
    const result = normalizeSupplierEvent(VALID_FORCE_MAJEURE_EVENT);
    expect(result.valid).toBe(true);
    expect(result.event.material_code).toBeUndefined();
  });

  it('defaults source_system to external', () => {
    const { source_system, ...rest } = VALID_DELAY_EVENT;
    const result = normalizeSupplierEvent(rest);
    expect(result.valid).toBe(true);
    expect(result.event.source_system).toBe('external');
  });
});

describe('computeRiskDelta', () => {
  it('computes positive risk delta for delivery_delay', () => {
    const event = normalizeSupplierEvent(VALID_DELAY_EVENT).event;
    const delta = computeRiskDelta(event);
    expect(delta.risk_score_delta).toBeGreaterThan(0);
    expect(delta.metrics_delta.p90_delay_days).toBe(7);
    expect(delta.evidence_refs).toContain('event_type=delivery_delay');
    expect(delta.evidence_refs).toContain('severity=high');
  });

  it('scales risk delta by severity multiplier', () => {
    const highEvent = normalizeSupplierEvent({ ...VALID_DELAY_EVENT, severity: 'high' }).event;
    const lowEvent = normalizeSupplierEvent({
      ...VALID_DELAY_EVENT,
      event_id: 'evt-low',
      severity: 'low',
    }).event;

    const highDelta = computeRiskDelta(highEvent);
    const lowDelta = computeRiskDelta(lowEvent);
    expect(highDelta.risk_score_delta).toBeGreaterThan(lowDelta.risk_score_delta);
  });

  it('computes high delta for force_majeure', () => {
    const event = normalizeSupplierEvent(VALID_FORCE_MAJEURE_EVENT).event;
    const delta = computeRiskDelta(event);
    expect(delta.risk_score_delta).toBeGreaterThanOrEqual(40);
    expect(delta.metrics_delta.p90_delay_days).toBe(21);
  });

  it('computes delta for quality_alert scaled by defect rate', () => {
    const event = normalizeSupplierEvent(VALID_QUALITY_EVENT).event;
    const delta = computeRiskDelta(event);
    expect(delta.risk_score_delta).toBeGreaterThan(0);
    expect(delta.evidence_refs).toContain('event_type=quality_alert');
  });

  it('computes delta for capacity_change based on reduction', () => {
    const event = normalizeSupplierEvent(VALID_CAPACITY_EVENT).event;
    const delta = computeRiskDelta(event);
    expect(delta.risk_score_delta).toBeGreaterThan(0);
    expect(delta.evidence_refs.some((r) => r.includes('capacity_reduction'))).toBe(true);
  });

  it('returns zero delta for delivered shipment status', () => {
    const event = normalizeSupplierEvent({
      ...VALID_SHIPMENT_EVENT,
      event_id: 'evt-delivered',
      details: { shipment_id: 'S1', status: 'delivered' },
    }).event;
    const delta = computeRiskDelta(event);
    expect(delta.risk_score_delta).toBe(0);
  });

  it('returns positive delta for delayed shipment status', () => {
    const event = normalizeSupplierEvent(VALID_SHIPMENT_EVENT).event;
    const delta = computeRiskDelta(event);
    expect(delta.risk_score_delta).toBeGreaterThan(0);
  });

  it('computes delta for price_change', () => {
    const event = normalizeSupplierEvent(VALID_PRICE_EVENT).event;
    const delta = computeRiskDelta(event);
    expect(delta.risk_score_delta).toBeGreaterThan(0);
    expect(delta.evidence_refs.some((r) => r.includes('price_change_pct'))).toBe(true);
  });

  it('returns zero delta for unknown event types', () => {
    // Force an event with unknown type (bypass Zod by calling computeRiskDelta directly)
    const delta = computeRiskDelta({
      event_type: 'unknown_type',
      supplier_id: 'SUP-X',
      severity: 'medium',
      details: {},
    });
    expect(delta.risk_score_delta).toBe(0);
    expect(delta.evidence_refs).toContain('unknown_event_type');
  });

  it('caps delivery_delay scaling at 3x base', () => {
    const event = normalizeSupplierEvent({
      ...VALID_DELAY_EVENT,
      event_id: 'evt-huge-delay',
      severity: 'medium',
      details: { original_eta: '2026-01-01', revised_eta: '2026-03-01', delay_days: 60 },
    }).event;
    const delta = computeRiskDelta(event);
    // 15 * min(60/7, 3) * 1.0 = 15 * 3 * 1.0 = 45
    expect(delta.risk_score_delta).toBe(45);
  });
});

describe('applyRiskDeltaToScores', () => {
  it('adds delta to matching SKU/plant in existing scores', () => {
    const delta = {
      material_code: 'MAT-100',
      plant_id: 'P1',
      supplier_id: 'SUP-A',
      risk_score_delta: 15,
      metrics_delta: { p90_delay_days: 7, overdue_ratio: 0.1 },
      evidence_refs: ['test'],
    };
    const updated = applyRiskDeltaToScores(EXISTING_RISK_SCORES, delta);
    expect(updated[0].risk_score).toBe(60); // 45 + 15
    expect(updated[0].metrics.p90_delay_days).toBe(10); // 3 + 7
    expect(updated[0].metrics.overdue_ratio).toBe(0.2); // 0.1 + 0.1
  });

  it('creates a new entry if SKU not in existing scores', () => {
    const delta = {
      material_code: 'MAT-999',
      plant_id: 'P2',
      supplier_id: 'SUP-Z',
      risk_score_delta: 20,
      metrics_delta: { p90_delay_days: 5, overdue_ratio: null },
      evidence_refs: ['new_entry'],
    };
    const updated = applyRiskDeltaToScores(EXISTING_RISK_SCORES, delta);
    expect(updated.length).toBe(2);
    expect(updated[1].material_code).toBe('MAT-999');
    expect(updated[1].risk_score).toBe(20);
  });

  it('does not mutate original array', () => {
    const original = JSON.parse(JSON.stringify(EXISTING_RISK_SCORES));
    const delta = {
      material_code: 'MAT-100',
      plant_id: 'P1',
      supplier_id: 'SUP-A',
      risk_score_delta: 15,
      metrics_delta: { p90_delay_days: 7, overdue_ratio: null },
      evidence_refs: [],
    };
    applyRiskDeltaToScores(EXISTING_RISK_SCORES, delta);
    expect(EXISTING_RISK_SCORES[0].risk_score).toBe(original[0].risk_score);
  });

  it('handles empty riskScores array', () => {
    const delta = {
      material_code: 'MAT-100',
      plant_id: 'P1',
      supplier_id: 'SUP-A',
      risk_score_delta: 10,
      metrics_delta: { p90_delay_days: null, overdue_ratio: null },
      evidence_refs: [],
    };
    const updated = applyRiskDeltaToScores([], delta);
    expect(updated.length).toBe(1);
    expect(updated[0].risk_score).toBe(10);
  });

  it('returns copy when delta is zero', () => {
    const delta = {
      material_code: 'MAT-100',
      plant_id: 'P1',
      supplier_id: 'SUP-A',
      risk_score_delta: 0,
      metrics_delta: { p90_delay_days: null, overdue_ratio: null },
      evidence_refs: [],
    };
    const updated = applyRiskDeltaToScores(EXISTING_RISK_SCORES, delta);
    expect(updated.length).toBe(1);
    expect(updated[0].risk_score).toBe(45); // unchanged
  });

  it('caps overdue_ratio at 1.0', () => {
    const delta = {
      material_code: 'MAT-100',
      plant_id: 'P1',
      supplier_id: 'SUP-A',
      risk_score_delta: 5,
      metrics_delta: { p90_delay_days: null, overdue_ratio: 0.95 },
      evidence_refs: [],
    };
    const updated = applyRiskDeltaToScores(EXISTING_RISK_SCORES, delta);
    expect(updated[0].metrics.overdue_ratio).toBeLessThanOrEqual(1.0);
  });
});

describe('buildSupplierEventChatMessage', () => {
  it('builds a valid chat message with correct structure', () => {
    const event = normalizeSupplierEvent(VALID_DELAY_EVENT).event;
    const riskDelta = computeRiskDelta(event);
    const msg = buildSupplierEventChatMessage({ event, riskDelta });

    expect(msg.role).toBe('system');
    expect(msg.type).toBe('supplier_event_card');
    expect(msg.is_proactive).toBe(true);
    expect(msg.timestamp).toBeTruthy();
    expect(msg.payload.event.event_id).toBe('evt-001');
    expect(msg.payload.event.event_type).toBe('delivery_delay');
    expect(msg.payload.risk_delta).toBeTruthy();
    expect(msg.payload.replan_recommendation).toBeNull();
  });

  it('includes replan recommendation when provided', () => {
    const event = normalizeSupplierEvent(VALID_DELAY_EVENT).event;
    const riskDelta = computeRiskDelta(event);
    const mockReplan = { type: 'risk_replan_recommendation_card', payload: {} };
    const msg = buildSupplierEventChatMessage({ event, riskDelta, replanRecommendation: mockReplan });

    expect(msg.payload.replan_recommendation).toBeTruthy();
    expect(msg.payload.replan_recommendation.type).toBe('risk_replan_recommendation_card');
  });
});

describe('processSupplierEvent', () => {
  it('accepts valid event and returns result', async () => {
    const result = await processSupplierEvent({
      event: VALID_DELAY_EVENT,
      userId: 'user1',
      conversationId: 'conv1',
    });
    expect(result.accepted).toBe(true);
    expect(result.event.event_id).toBe('evt-001');
    expect(result.risk_delta.risk_score_delta).toBeGreaterThan(0);
    expect(result.error).toBeNull();
  });

  it('rejects invalid event gracefully', async () => {
    const result = await processSupplierEvent({
      event: { event_id: 'x', supplier_id: 'y' },
      userId: 'user1',
    });
    expect(result.accepted).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('triggers alertMonitor.evaluateNow when delta exceeds threshold', async () => {
    const mockEval = vi.fn().mockResolvedValue(undefined);
    const result = await processSupplierEvent({
      event: VALID_FORCE_MAJEURE_EVENT,
      userId: 'user1',
      alertMonitor: { evaluateNow: mockEval },
    });
    expect(result.alerts_triggered).toBe(true);
    expect(mockEval).toHaveBeenCalledOnce();
  });

  it('does NOT trigger alert when delta is below threshold', async () => {
    const mockEval = vi.fn().mockResolvedValue(undefined);
    // price_change with small delta
    const result = await processSupplierEvent({
      event: {
        ...VALID_PRICE_EVENT,
        event_id: 'evt-small-price',
        severity: 'low',
        details: { old_unit_price: 10, new_unit_price: 10.1, currency: 'USD', effective_date: '2026-03-01' },
      },
      userId: 'user1',
      alertMonitor: { evaluateNow: mockEval },
    });
    expect(result.alerts_triggered).toBe(false);
    expect(mockEval).not.toHaveBeenCalled();
  });

  it('gracefully degrades when alertMonitor is null', async () => {
    const result = await processSupplierEvent({
      event: VALID_FORCE_MAJEURE_EVENT,
      userId: 'user1',
      alertMonitor: null,
    });
    expect(result.accepted).toBe(true);
    expect(result.alerts_triggered).toBe(false);
  });

  it('deduplicates events with same event_id', async () => {
    const event = { ...VALID_DELAY_EVENT, event_id: 'evt-dedup-test' };
    const first = await processSupplierEvent({ event, userId: 'user1' });
    const second = await processSupplierEvent({ event, userId: 'user1' });

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);
    expect(second.error).toContain('Duplicate');
  });
});

describe('processSupplierEventBatch', () => {
  it('processes multiple events and returns aggregated result', async () => {
    const result = await processSupplierEventBatch({
      events: [
        { ...VALID_DELAY_EVENT, event_id: 'batch-1' },
        { ...VALID_QUALITY_EVENT, event_id: 'batch-2' },
      ],
      userId: 'user1',
    });
    expect(result.accepted_count).toBe(2);
    expect(result.rejected_count).toBe(0);
    expect(result.aggregated_risk_delta).toBeGreaterThan(0);
  });

  it('rejects invalid events in batch while accepting valid ones', async () => {
    const result = await processSupplierEventBatch({
      events: [
        { ...VALID_DELAY_EVENT, event_id: 'batch-valid' },
        { event_id: 'bad', supplier_id: 'x' }, // invalid
      ],
      userId: 'user1',
    });
    expect(result.accepted_count).toBe(1);
    expect(result.rejected_count).toBe(1);
  });

  it('triggers alert only once for entire batch', async () => {
    const mockEval = vi.fn().mockResolvedValue(undefined);
    await processSupplierEventBatch({
      events: [
        { ...VALID_FORCE_MAJEURE_EVENT, event_id: 'batch-fm-1' },
        { ...VALID_DELAY_EVENT, event_id: 'batch-fm-2' },
      ],
      userId: 'user1',
      alertMonitor: { evaluateNow: mockEval },
    });
    expect(mockEval).toHaveBeenCalledOnce();
  });
});
