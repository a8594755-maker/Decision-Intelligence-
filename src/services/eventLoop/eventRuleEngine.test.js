/**
 * Tests for Phase 2 — Event Rule Engine
 */

import { describe, it, expect } from 'vitest';

import {
  EVENT_TYPES,
  EVENT_STATUS,
  matchEventType,
  checkCondition,
  isInCooldown,
  matchEventRule,
  buildDWOFromEvent,
} from './eventRuleEngine.js';

// ── matchEventType ──────────────────────────────────────────────────────────

describe('matchEventType', () => {
  it('matches exact event type', () => {
    expect(matchEventType('supplier_delay', 'supplier_delay')).toBe(true);
  });

  it('rejects non-matching type', () => {
    expect(matchEventType('supplier_delay', 'demand_spike')).toBe(false);
  });

  it('matches wildcard *', () => {
    expect(matchEventType('supplier_delay', '*')).toBe(true);
    expect(matchEventType('anything', '*')).toBe(true);
  });

  it('matches glob pattern supplier_*', () => {
    expect(matchEventType('supplier_delay', 'supplier_*')).toBe(true);
    expect(matchEventType('supplier_quality_issue', 'supplier_*')).toBe(true);
    expect(matchEventType('demand_spike', 'supplier_*')).toBe(false);
  });

  it('matches glob pattern *_threshold', () => {
    expect(matchEventType('inventory_below_threshold', '*_threshold')).toBe(true);
    expect(matchEventType('supplier_delay', '*_threshold')).toBe(false);
  });

  it('handles null/empty gracefully', () => {
    expect(matchEventType(null, 'test')).toBe(false);
    expect(matchEventType('test', null)).toBe(false);
    expect(matchEventType('', '')).toBe(false); // empty strings are invalid
  });
});

// ── checkCondition ──────────────────────────────────────────────────────────

describe('checkCondition', () => {
  it('returns true for empty conditions', () => {
    expect(checkCondition({ severity: 'high' }, {})).toBe(true);
    expect(checkCondition({ severity: 'high' }, null)).toBe(true);
  });

  it('matches simple equality', () => {
    expect(checkCondition({ severity: 'high' }, { severity: 'high' })).toBe(true);
    expect(checkCondition({ severity: 'low' }, { severity: 'high' })).toBe(false);
  });

  it('matches nested dot-notation', () => {
    expect(checkCondition(
      { entity: { site: 'P001' } },
      { 'entity.site': 'P001' }
    )).toBe(true);
  });

  it('supports $gt operator', () => {
    expect(checkCondition({ delay_days: 10 }, { delay_days: { $gt: 5 } })).toBe(true);
    expect(checkCondition({ delay_days: 3 }, { delay_days: { $gt: 5 } })).toBe(false);
  });

  it('supports $gte operator', () => {
    expect(checkCondition({ delay_days: 5 }, { delay_days: { $gte: 5 } })).toBe(true);
    expect(checkCondition({ delay_days: 4 }, { delay_days: { $gte: 5 } })).toBe(false);
  });

  it('supports $lt operator', () => {
    expect(checkCondition({ doh: 3 }, { doh: { $lt: 7 } })).toBe(true);
    expect(checkCondition({ doh: 10 }, { doh: { $lt: 7 } })).toBe(false);
  });

  it('supports $in operator', () => {
    expect(checkCondition({ severity: 'high' }, { severity: { $in: ['high', 'critical'] } })).toBe(true);
    expect(checkCondition({ severity: 'low' }, { severity: { $in: ['high', 'critical'] } })).toBe(false);
  });

  it('supports $ne operator', () => {
    expect(checkCondition({ status: 'active' }, { status: { $ne: 'inactive' } })).toBe(true);
    expect(checkCondition({ status: 'inactive' }, { status: { $ne: 'inactive' } })).toBe(false);
  });

  it('handles multiple conditions (AND)', () => {
    expect(checkCondition(
      { severity: 'high', delay_days: 10 },
      { severity: 'high', delay_days: { $gt: 5 } }
    )).toBe(true);
    expect(checkCondition(
      { severity: 'low', delay_days: 10 },
      { severity: 'high', delay_days: { $gt: 5 } }
    )).toBe(false);
  });

  it('returns false for null payload', () => {
    expect(checkCondition(null, { severity: 'high' })).toBe(false);
  });
});

// ── isInCooldown ────────────────────────────────────────────────────────────

describe('isInCooldown', () => {
  const rule = { cooldown_seconds: 300 }; // 5 min

  it('returns false with no recent events', () => {
    const result = isInCooldown(rule, []);
    expect(result.inCooldown).toBe(false);
  });

  it('returns true when last event was 1 minute ago', () => {
    const oneMinAgo = new Date(Date.now() - 60_000).toISOString();
    const result = isInCooldown(rule, [
      { status: 'processed', processed_at: oneMinAgo },
    ]);
    expect(result.inCooldown).toBe(true);
    expect(result.cooldownRemainingMs).toBeGreaterThan(0);
  });

  it('returns false when last event was 10 minutes ago', () => {
    const tenMinAgo = new Date(Date.now() - 600_000).toISOString();
    const result = isInCooldown(rule, [
      { status: 'processed', processed_at: tenMinAgo },
    ]);
    expect(result.inCooldown).toBe(false);
  });

  it('returns false when cooldown is 0', () => {
    const result = isInCooldown({ cooldown_seconds: 0 }, [
      { status: 'processed', processed_at: new Date().toISOString() },
    ]);
    expect(result.inCooldown).toBe(false);
  });

  it('ignores non-processed events', () => {
    const result = isInCooldown(rule, [
      { status: 'failed', processed_at: new Date().toISOString() },
      { status: 'ignored', created_at: new Date().toISOString() },
    ]);
    expect(result.inCooldown).toBe(false);
  });
});

// ── matchEventRule ──────────────────────────────────────────────────────────

describe('matchEventRule', () => {
  const rules = [
    {
      id: 'rule-1',
      name: 'High severity supplier delay',
      event_type_pattern: 'supplier_delay',
      condition_json: { severity: 'high' },
      target_worker_id: 'worker-1',
      task_template_id: 'tpl-1',
      cooldown_seconds: 300,
      enabled: true,
      priority: 10,
    },
    {
      id: 'rule-2',
      name: 'Any inventory event',
      event_type_pattern: 'inventory_*',
      condition_json: {},
      target_worker_id: 'worker-2',
      task_template_id: 'tpl-2',
      cooldown_seconds: 600,
      enabled: true,
      priority: 5,
    },
    {
      id: 'rule-3',
      name: 'Disabled rule',
      event_type_pattern: '*',
      condition_json: {},
      target_worker_id: 'worker-3',
      enabled: false,
      priority: 100,
    },
  ];

  it('matches the correct rule for supplier_delay + high severity', () => {
    const event = { event_type: 'supplier_delay', payload: { severity: 'high' } };
    const result = matchEventRule(event, rules);
    expect(result.matched).toBe(true);
    expect(result.rule.id).toBe('rule-1');
  });

  it('does not match supplier_delay + low severity', () => {
    const event = { event_type: 'supplier_delay', payload: { severity: 'low' } };
    const result = matchEventRule(event, rules);
    expect(result.matched).toBe(false);
  });

  it('matches inventory_below_threshold via glob', () => {
    const event = { event_type: 'inventory_below_threshold', payload: {} };
    const result = matchEventRule(event, rules);
    expect(result.matched).toBe(true);
    expect(result.rule.id).toBe('rule-2');
  });

  it('skips disabled rules', () => {
    const event = { event_type: 'totally_unknown_event', payload: {} };
    const result = matchEventRule(event, rules);
    expect(result.matched).toBe(false); // rule-3 is disabled
  });

  it('respects cooldown', () => {
    const event = { event_type: 'supplier_delay', payload: { severity: 'high' } };
    const recentEvents = [
      { event_type: 'supplier_delay', status: 'processed', processed_at: new Date().toISOString() },
    ];
    const result = matchEventRule(event, rules, recentEvents);
    expect(result.matched).toBe(false); // rule-1 in cooldown
  });

  it('returns reason for no match', () => {
    const event = { event_type: 'unknown_type', payload: {} };
    const result = matchEventRule(event, rules);
    expect(result.matched).toBe(false);
    expect(result.reason).toBe('No matching rule found');
  });

  it('handles missing event_type', () => {
    const result = matchEventRule({}, rules);
    expect(result.matched).toBe(false);
    expect(result.reason).toContain('missing event_type');
  });

  it('selects higher priority rule first', () => {
    const allEnabled = rules.map(r => ({ ...r, enabled: true }));
    // rule-3 has priority 100 and matches *, should win
    const event = { event_type: 'supplier_delay', payload: { severity: 'high' } };
    const result = matchEventRule(event, allEnabled);
    expect(result.rule.id).toBe('rule-3');
  });
});

// ── buildDWOFromEvent ───────────────────────────────────────────────────────

describe('buildDWOFromEvent', () => {
  it('builds a valid DWO from event + rule', () => {
    const event = {
      id: 'evt-123',
      event_type: 'supplier_delay',
      source_system: 'erp_connector',
      payload: {
        supplier_id: 'S-001',
        material_code: 'MAT-100',
        delay_days: 7,
        severity: 'high',
        summary: 'Supplier S-001 delayed by 7 days',
      },
    };
    const rule = {
      id: 'rule-1',
      name: 'Supplier delay handler',
      target_worker_id: 'worker-1',
      intent_type: 'procurement_expedite',
      business_domain: 'procurement',
    };

    const dwo = buildDWOFromEvent(event, rule);

    expect(dwo.id).toMatch(/^dwo_/);
    expect(dwo.intent_type).toBe('procurement_expedite');
    expect(dwo.worker_id).toBe('worker-1');
    expect(dwo.business_domain).toBe('procurement');
    expect(dwo.source_channel).toBe('event_queue');
    expect(dwo.request_summary).toBe('Supplier S-001 delayed by 7 days');
    expect(dwo.risk_level).toBe('high');
    expect(dwo.entity_refs.supplier).toEqual(['S-001']);
    expect(dwo.entity_refs.sku).toEqual(['MAT-100']);
    expect(dwo.input_context.event_id).toBe('evt-123');
    expect(dwo.input_context.rule_name).toBe('Supplier delay handler');
  });

  it('uses auto intent mapping when rule has no intent_type', () => {
    const event = {
      id: 'evt-456',
      event_type: 'inventory_below_threshold',
      payload: { material_code: 'SKU-X', plant_id: 'P002' },
    };
    const rule = { id: 'r2', name: 'Low inv', target_worker_id: 'w2' };

    const dwo = buildDWOFromEvent(event, rule);
    expect(dwo.intent_type).toBe('inventory_replan');
    expect(dwo.entity_refs.sku).toEqual(['SKU-X']);
    expect(dwo.entity_refs.site).toEqual(['P002']);
  });
});

// ── EVENT_TYPES + EVENT_STATUS constants ────────────────────────────────────

describe('Event constants', () => {
  it('defines expected event types', () => {
    expect(EVENT_TYPES.SUPPLIER_DELAY).toBe('supplier_delay');
    expect(EVENT_TYPES.INVENTORY_BELOW_THRESHOLD).toBe('inventory_below_threshold');
    expect(EVENT_TYPES.KPI_BREACH).toBe('kpi_breach');
    expect(EVENT_TYPES.MANUAL_TRIGGER).toBe('manual_trigger');
  });

  it('defines expected statuses', () => {
    expect(EVENT_STATUS.PENDING).toBe('pending');
    expect(EVENT_STATUS.MATCHED).toBe('matched');
    expect(EVENT_STATUS.PROCESSED).toBe('processed');
    expect(EVENT_STATUS.FAILED).toBe('failed');
  });
});
