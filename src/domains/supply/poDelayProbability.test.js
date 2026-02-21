/**
 * Unit tests for poDelayProbability.js
 *
 * Test strategy:
 *   T1  Sufficient history, PO not yet due → time_aware_v1 model
 *   T2  Insufficient history → fallback_prior
 *   T3  PO already overdue → overdue_floor model
 *   T4  urgency_factor increases as days_until_due decreases
 *   T5  risk_entity p90_delay_days / overdue_ratio affects output
 *   T6  Determinism (same input → same output)
 *   T7  p_late clamped to [0.01, 0.99]
 *   T8  risk_tier classification
 *   T9  batchComputePODelayProbabilities batch processing
 *   T10 Batch results sorted by p_late descending
 */

import { describe, it, expect } from 'vitest';
import {
  computePODelayProbability,
  batchComputePODelayProbabilities,
  daysUntilDue,
  computeUrgencyFactor,
  DELAY_PROB_CONFIG,
} from './poDelayProbability.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const GOOD_SUPPLIER_STATS = {
  supplier_id: 'SUP-A',
  plant_id: 'P1',
  sample_size: 15,
  on_time_rate: 0.75,
  lead_time_p50_days: 14,
  lead_time_p90_days: 21,
  metrics: { fallback_used: false, fallback_reason: null },
};

const LOW_SAMPLE_STATS = {
  supplier_id: 'SUP-B',
  plant_id: 'P1',
  sample_size: 2,
  on_time_rate: 0.9,
  lead_time_p50_days: 7,
  lead_time_p90_days: 10,
  metrics: { fallback_used: true, fallback_reason: 'Insufficient sample size (2 < 3)' },
};

const NO_STATS = {
  supplier_id: 'SUP-C',
  plant_id: 'P1',
  sample_size: 0,
  on_time_rate: 0.7,
  lead_time_p50_days: 14,
  lead_time_p90_days: 18,
  metrics: { fallback_used: true, fallback_reason: 'No receipt history available' },
};

const HIGH_RISK_ENTITY = {
  entity_type: 'supplier_material',
  entity_id: 'MAT-001',
  material_code: 'MAT-001',
  plant_id: 'P1',
  risk_score: 82,
  metrics: {
    p90_delay_days: 8.5,
    overdue_ratio: 0.35,
    on_time_rate: 0.62,
    avg_delay_days: 5.2,
  },
};

const LOW_RISK_ENTITY = {
  entity_type: 'supplier_material',
  entity_id: 'MAT-002',
  material_code: 'MAT-002',
  plant_id: 'P1',
  risk_score: 20,
  metrics: {
    p90_delay_days: 1.0,
    overdue_ratio: 0.05,
    on_time_rate: 0.92,
    avg_delay_days: 0.8,
  },
};

const NOW = '2026-02-21';

// ── T1: time_aware_v1 — not yet due ──────────────────────────────────────────

describe('computePODelayProbability: time_aware_v1', () => {
  it('T1-a: uses time_aware_v1 model with sufficient history and not yet due', () => {
    const result = computePODelayProbability({
      supplierStats: GOOD_SUPPLIER_STATS,
      riskEntity: LOW_RISK_ENTITY,
      promisedDate: '2026-03-07',
      nowDate: NOW,
    });

    expect(result.model_used).toBe('time_aware_v1');
    expect(result.p_late).toBeGreaterThan(0);
    expect(result.p_late).toBeLessThan(1);
    expect(result.is_overdue).toBe(false);
    expect(result.days_until_due).toBe(14);
  });

  it('T1-b: 3 days until due has higher p_late than 30 days (urgency effect)', () => {
    const args = { supplierStats: GOOD_SUPPLIER_STATS, riskEntity: LOW_RISK_ENTITY, nowDate: NOW };

    const near = computePODelayProbability({ ...args, promisedDate: '2026-02-24' });
    const far = computePODelayProbability({ ...args, promisedDate: '2026-03-23' });

    expect(near.p_late).toBeGreaterThan(far.p_late);
    expect(near.urgency_factor).toBeGreaterThan(far.urgency_factor);
  });

  it('T1-c: high_risk_entity p_late > low_risk_entity (same due date)', () => {
    const args = { supplierStats: GOOD_SUPPLIER_STATS, promisedDate: '2026-03-07', nowDate: NOW };

    const high = computePODelayProbability({ ...args, riskEntity: HIGH_RISK_ENTITY });
    const low = computePODelayProbability({ ...args, riskEntity: LOW_RISK_ENTITY });

    expect(high.p_late).toBeGreaterThan(low.p_late);
  });

  it('T1-d: evidence_refs contains p_base, urgency_factor, days_until_due', () => {
    const result = computePODelayProbability({
      supplierStats: GOOD_SUPPLIER_STATS,
      riskEntity: LOW_RISK_ENTITY,
      promisedDate: '2026-03-07',
      nowDate: NOW,
    });

    expect(result.evidence_refs.some((r) => r.startsWith('p_base='))).toBe(true);
    expect(result.evidence_refs.some((r) => r.startsWith('urgency_factor='))).toBe(true);
    expect(result.evidence_refs.some((r) => r.startsWith('days_until_due='))).toBe(true);
  });

  it('T1-e: p_late_p90 >= p_late', () => {
    const result = computePODelayProbability({
      supplierStats: GOOD_SUPPLIER_STATS,
      riskEntity: HIGH_RISK_ENTITY,
      promisedDate: '2026-03-07',
      nowDate: NOW,
    });

    expect(result.p_late_p90).toBeGreaterThanOrEqual(result.p_late);
  });

  it('T1-f: null riskEntity does not throw', () => {
    const result = computePODelayProbability({
      supplierStats: GOOD_SUPPLIER_STATS,
      riskEntity: null,
      promisedDate: '2026-03-07',
      nowDate: NOW,
    });

    expect(result.model_used).toBe('time_aware_v1');
    expect(result.p_late).toBeGreaterThan(0);
  });
});

// ── T2: fallback_prior ───────────────────────────────────────────────────────

describe('computePODelayProbability: fallback_prior', () => {
  it('T2-a: low sample size → fallback_prior model', () => {
    const result = computePODelayProbability({
      supplierStats: LOW_SAMPLE_STATS,
      riskEntity: null,
      promisedDate: '2026-03-07',
      nowDate: NOW,
    });

    expect(result.model_used).toBe('fallback_prior');
    expect(result.p_late).toBe(DELAY_PROB_CONFIG.FALLBACK_P_LATE);
  });

  it('T2-b: no history → fallback_prior', () => {
    const result = computePODelayProbability({
      supplierStats: NO_STATS,
      riskEntity: null,
      promisedDate: '2026-03-07',
      nowDate: NOW,
    });

    expect(result.model_used).toBe('fallback_prior');
    expect(result.evidence_refs.some((r) => r.startsWith('fallback_reason='))).toBe(true);
  });

  it('T2-c: fallback p_late_p90 <= 0.95', () => {
    const result = computePODelayProbability({
      supplierStats: NO_STATS,
      riskEntity: null,
      promisedDate: '2026-03-07',
      nowDate: NOW,
    });

    expect(result.p_late_p90).toBeLessThanOrEqual(0.95);
  });

  it('T2-d: fallback includes sample_size in output', () => {
    const result = computePODelayProbability({
      supplierStats: LOW_SAMPLE_STATS,
      riskEntity: null,
      promisedDate: '2026-03-07',
      nowDate: NOW,
    });

    expect(result.sample_size).toBe(2);
  });
});

// ── T3: overdue_floor ────────────────────────────────────────────────────────

describe('computePODelayProbability: overdue_floor', () => {
  it('T3-a: PO already overdue → overdue_floor model, p_late >= OVERDUE_FLOOR', () => {
    const result = computePODelayProbability({
      supplierStats: GOOD_SUPPLIER_STATS,
      riskEntity: LOW_RISK_ENTITY,
      promisedDate: '2026-02-15',
      nowDate: NOW,
    });

    expect(result.model_used).toBe('overdue_floor');
    expect(result.is_overdue).toBe(true);
    expect(result.p_late).toBeGreaterThanOrEqual(DELAY_PROB_CONFIG.OVERDUE_FLOOR);
    expect(result.days_until_due).toBe(-6);
  });

  it('T3-b: high overdue_ratio supplier → p_late >= OVERDUE_FLOOR', () => {
    const result = computePODelayProbability({
      supplierStats: GOOD_SUPPLIER_STATS,
      riskEntity: HIGH_RISK_ENTITY,
      promisedDate: '2026-02-15',
      nowDate: NOW,
    });

    expect(result.p_late).toBeGreaterThanOrEqual(DELAY_PROB_CONFIG.OVERDUE_FLOOR);
  });

  it('T3-c: overdue PO risk_tier is critical or high', () => {
    const result = computePODelayProbability({
      supplierStats: GOOD_SUPPLIER_STATS,
      riskEntity: LOW_RISK_ENTITY,
      promisedDate: '2026-02-15',
      nowDate: NOW,
    });

    expect(['critical', 'high']).toContain(result.risk_tier);
  });

  it('T3-d: overdue evidence_refs contain days_past_due', () => {
    const result = computePODelayProbability({
      supplierStats: GOOD_SUPPLIER_STATS,
      riskEntity: null,
      promisedDate: '2026-02-15',
      nowDate: NOW,
    });

    expect(result.evidence_refs.some((r) => r.startsWith('days_past_due='))).toBe(true);
  });
});

// ── T4: urgency_factor ───────────────────────────────────────────────────────

describe('computeUrgencyFactor', () => {
  it('T4-a: days=1 → high urgency, higher than days=30', () => {
    const u1 = computeUrgencyFactor(1);
    const u30 = computeUrgencyFactor(30);
    expect(u1).toBeGreaterThan(u30);
    expect(u1).toBeGreaterThan(1);
  });

  it('T4-b: days=null or <=0 → returns 1.0', () => {
    expect(computeUrgencyFactor(null)).toBe(1.0);
    expect(computeUrgencyFactor(0)).toBe(1.0);
    expect(computeUrgencyFactor(-5)).toBe(1.0);
  });

  it('T4-c: days=7 → urgency_factor = exp(8/7)', () => {
    expect(computeUrgencyFactor(7)).toBeCloseTo(Math.exp(8 / 7), 2);
  });

  it('T4-d: monotonically decreasing with increasing days', () => {
    const values = [1, 3, 7, 14, 30, 60].map((d) => computeUrgencyFactor(d));
    for (let i = 0; i < values.length - 1; i++) {
      expect(values[i]).toBeGreaterThan(values[i + 1]);
    }
  });
});

// ── T5: risk_tier classification ─────────────────────────────────────────────

describe('risk_tier classification', () => {
  it('T5-a: risk_tier is a valid value', () => {
    const result = computePODelayProbability({
      supplierStats: GOOD_SUPPLIER_STATS,
      riskEntity: HIGH_RISK_ENTITY,
      promisedDate: '2026-02-22',
      nowDate: NOW,
    });
    expect(['critical', 'high', 'medium', 'low']).toContain(result.risk_tier);
  });

  it('T5-b: very reliable supplier far from due → low tier', () => {
    const result = computePODelayProbability({
      supplierStats: {
        ...GOOD_SUPPLIER_STATS,
        on_time_rate: 0.98,
        sample_size: 30,
      },
      riskEntity: { ...LOW_RISK_ENTITY, risk_score: 5 },
      promisedDate: '2026-04-21',
      nowDate: NOW,
    });
    expect(result.risk_tier).toBe('low');
  });
});

// ── T6: Determinism ──────────────────────────────────────────────────────────

describe('determinism', () => {
  it('T6: same input → identical output', () => {
    const args = {
      supplierStats: GOOD_SUPPLIER_STATS,
      riskEntity: HIGH_RISK_ENTITY,
      promisedDate: '2026-03-01',
      nowDate: NOW,
    };
    const r1 = computePODelayProbability(args);
    const r2 = computePODelayProbability(args);
    expect(r1).toEqual(r2);
    expect(r1.p_late).toBe(r2.p_late);
    expect(r1.evidence_refs).toEqual(r2.evidence_refs);
  });
});

// ── T7: clamp ────────────────────────────────────────────────────────────────

describe('p_late clamp', () => {
  it('T7-a: p_late stays within [0.01, 0.99] for extreme inputs', () => {
    const extremeStats = { ...GOOD_SUPPLIER_STATS, on_time_rate: 0.0001 };
    const result = computePODelayProbability({
      supplierStats: extremeStats,
      riskEntity: HIGH_RISK_ENTITY,
      promisedDate: '2026-02-22',
      nowDate: NOW,
    });
    expect(result.p_late).toBeGreaterThanOrEqual(DELAY_PROB_CONFIG.P_LATE_MIN);
    expect(result.p_late).toBeLessThanOrEqual(DELAY_PROB_CONFIG.P_LATE_MAX);
  });

  it('T7-b: near-perfect supplier still has p_late >= 0.01', () => {
    const perfectStats = { ...GOOD_SUPPLIER_STATS, on_time_rate: 0.9999 };
    const result = computePODelayProbability({
      supplierStats: perfectStats,
      riskEntity: null,
      promisedDate: '2026-06-01',
      nowDate: NOW,
    });
    expect(result.p_late).toBeGreaterThanOrEqual(DELAY_PROB_CONFIG.P_LATE_MIN);
  });
});

// ── T8: daysUntilDue ─────────────────────────────────────────────────────────

describe('daysUntilDue', () => {
  it('T8-a: 7 days ahead → 7', () => {
    expect(daysUntilDue('2026-02-28', '2026-02-21')).toBe(7);
  });

  it('T8-b: yesterday → -1', () => {
    expect(daysUntilDue('2026-02-20', '2026-02-21')).toBe(-1);
  });

  it('T8-c: null → null', () => {
    expect(daysUntilDue(null, NOW)).toBeNull();
  });

  it('T8-d: same day → 0', () => {
    expect(daysUntilDue('2026-02-21', '2026-02-21')).toBe(0);
  });

  it('T8-e: invalid date → null', () => {
    expect(daysUntilDue('not-a-date', NOW)).toBeNull();
  });
});

// ── T9/T10: batchComputePODelayProbabilities ─────────────────────────────────

describe('batchComputePODelayProbabilities', () => {
  const PO_LINES = [
    { po_id: 'PO-001', supplier_id: 'SUP-A', material_code: 'MAT-001', plant_id: 'P1',
      open_qty: 100, promised_date: '2026-02-22' },
    { po_id: 'PO-002', supplier_id: 'SUP-A', material_code: 'MAT-002', plant_id: 'P1',
      open_qty: 50, promised_date: '2026-04-21' },
    { po_id: 'PO-003', supplier_id: 'SUP-B', material_code: 'MAT-003', plant_id: 'P1',
      open_qty: 200, promised_date: '2026-02-15' },
  ];

  const SUPPLIER_STATS = [GOOD_SUPPLIER_STATS, LOW_SAMPLE_STATS];
  const RISK_SCORES = [HIGH_RISK_ENTITY, LOW_RISK_ENTITY];

  it('T9-a: processes 3 PO lines, returns 3 signals', () => {
    const result = batchComputePODelayProbabilities({
      poOpenLines: PO_LINES,
      supplierStats: SUPPLIER_STATS,
      riskScores: RISK_SCORES,
      nowDate: NOW,
    });

    expect(result.po_delay_signals.length).toBe(3);
    expect(result.summary.total_pos).toBe(3);
  });

  it('T9-b: overdue PO counted in overdue_count', () => {
    const result = batchComputePODelayProbabilities({
      poOpenLines: PO_LINES,
      supplierStats: SUPPLIER_STATS,
      riskScores: RISK_SCORES,
      nowDate: NOW,
    });

    expect(result.summary.overdue_count).toBe(1);
  });

  it('T10: results sorted by p_late descending', () => {
    const result = batchComputePODelayProbabilities({
      poOpenLines: PO_LINES,
      supplierStats: SUPPLIER_STATS,
      riskScores: RISK_SCORES,
      nowDate: NOW,
    });

    const signals = result.po_delay_signals;
    for (let i = 0; i < signals.length - 1; i++) {
      expect(signals[i].p_late).toBeGreaterThanOrEqual(signals[i + 1].p_late);
    }
  });

  it('T9-c: high_risk_pos all have p_late >= threshold', () => {
    const result = batchComputePODelayProbabilities({
      poOpenLines: PO_LINES,
      supplierStats: SUPPLIER_STATS,
      riskScores: RISK_SCORES,
      nowDate: NOW,
    });

    result.high_risk_pos.forEach((po) => {
      expect(po.p_late).toBeGreaterThanOrEqual(DELAY_PROB_CONFIG.HIGH_RISK_P_LATE_THRESHOLD);
    });
  });

  it('T9-d: summary.model_version = "time_aware_v1"', () => {
    const result = batchComputePODelayProbabilities({
      poOpenLines: [],
      supplierStats: [],
      riskScores: [],
      nowDate: NOW,
    });
    expect(result.summary.model_version).toBe('time_aware_v1');
  });

  it('T9-e: empty input produces valid empty result', () => {
    const result = batchComputePODelayProbabilities({
      poOpenLines: [],
      supplierStats: [],
      riskScores: [],
      nowDate: NOW,
    });

    expect(result.po_delay_signals).toEqual([]);
    expect(result.high_risk_pos).toEqual([]);
    expect(result.summary.total_pos).toBe(0);
    expect(result.summary.avg_p_late).toBe(0);
  });

  it('T9-f: PO with "supplier" field (not supplier_id) still works', () => {
    const result = batchComputePODelayProbabilities({
      poOpenLines: [
        { po_id: 'PO-X', supplier: 'SUP-A', material_code: 'MAT-001', plant_id: 'P1',
          open_qty: 10, promised_date: '2026-03-01' },
      ],
      supplierStats: SUPPLIER_STATS,
      riskScores: RISK_SCORES,
      nowDate: NOW,
    });

    expect(result.po_delay_signals.length).toBe(1);
    expect(result.po_delay_signals[0].supplier_id).toBe('SUP-A');
  });

  it('T9-g: critical_risk_pos filtered correctly', () => {
    const result = batchComputePODelayProbabilities({
      poOpenLines: PO_LINES,
      supplierStats: SUPPLIER_STATS,
      riskScores: RISK_SCORES,
      nowDate: NOW,
    });

    result.critical_risk_pos.forEach((po) => {
      expect(po.p_late).toBeGreaterThanOrEqual(DELAY_PROB_CONFIG.CRITICAL_RISK_P_LATE_THRESHOLD);
    });
  });

  it('T9-h: fallback_count is correct for unknown suppliers', () => {
    const result = batchComputePODelayProbabilities({
      poOpenLines: [
        { po_id: 'PO-X', supplier_id: 'UNKNOWN-SUP', material_code: 'MAT-999', plant_id: 'P1',
          open_qty: 10, promised_date: '2026-03-01' },
      ],
      supplierStats: [],
      riskScores: [],
      nowDate: NOW,
    });

    expect(result.summary.fallback_count).toBe(1);
    expect(result.po_delay_signals[0].model_used).toBe('fallback_prior');
  });
});
