/**
 * eventRuleEngine.js — Pure-function event rule matching engine.
 *
 * Evaluates incoming events against event_rules to determine:
 *   - Whether the event should trigger a task
 *   - Which worker and template to use
 *   - Whether the rule is in cooldown
 *
 * All functions are pure (no DB access) — the caller provides rules and history.
 *
 * @module services/eventLoop/eventRuleEngine
 */

import {
  createDecisionWorkOrder,
  INTENT_TYPES,
  SOURCE_CHANNELS,
} from '../../contracts/decisionWorkOrderContract.js';

// ── Event Types ─────────────────────────────────────────────────────────────

export const EVENT_TYPES = Object.freeze({
  // Supply chain events
  SUPPLIER_DELAY:              'supplier_delay',
  SUPPLIER_QUALITY_ISSUE:      'supplier_quality_issue',
  INVENTORY_BELOW_THRESHOLD:   'inventory_below_threshold',
  INVENTORY_EXCESS:            'inventory_excess',
  FORECAST_ACCURACY_DRIFT:     'forecast_accuracy_drift',
  PO_RECEIVED:                 'po_received',
  PO_OVERDUE:                  'po_overdue',
  DEMAND_SPIKE:                'demand_spike',
  DEMAND_CRASH:                'demand_crash',
  PLANT_SHUTDOWN:              'plant_shutdown',

  // System events
  KPI_BREACH:                  'kpi_breach',
  DATA_QUALITY_ALERT:          'data_quality_alert',
  SCHEDULE_TRIGGER:            'schedule_trigger',

  // Manual
  MANUAL_TRIGGER:              'manual_trigger',
});

// ── Event Status ────────────────────────────────────────────────────────────

export const EVENT_STATUS = Object.freeze({
  PENDING:   'pending',
  MATCHED:   'matched',
  IGNORED:   'ignored',
  PROCESSED: 'processed',
  FAILED:    'failed',
});

// ── Pattern Matching ────────────────────────────────────────────────────────

/**
 * Match an event type against a rule's event_type_pattern.
 * Supports exact match and glob-style wildcards (*, ?).
 *
 * @param {string} eventType - Actual event type
 * @param {string} pattern - Rule's event_type_pattern
 * @returns {boolean}
 */
export function matchEventType(eventType, pattern) {
  if (!eventType || !pattern) return false;
  if (pattern === '*') return true;
  if (pattern === eventType) return true;

  // Glob-style: convert * and ? to regex
  const regexStr = '^' + pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // escape regex special chars
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
    + '$';

  try {
    return new RegExp(regexStr).test(eventType);
  } catch {
    return false;
  }
}

/**
 * Check if an event payload matches a rule's condition_json.
 * Supports simple equality checks on top-level and nested fields.
 *
 * @param {Object} payload - Event payload
 * @param {Object} conditionJson - Rule conditions (e.g., { severity: "high", "entity.site": "P001" })
 * @returns {boolean}
 */
export function checkCondition(payload, conditionJson) {
  if (!conditionJson || Object.keys(conditionJson).length === 0) return true;
  if (!payload) return false;

  for (const [key, expectedValue] of Object.entries(conditionJson)) {
    const actualValue = getNestedValue(payload, key);

    // Comparison operators
    if (typeof expectedValue === 'object' && expectedValue !== null && !Array.isArray(expectedValue)) {
      // { "$gt": 10 }, { "$in": ["A", "B"] }, { "$gte": 5 }
      for (const [op, opVal] of Object.entries(expectedValue)) {
        switch (op) {
          case '$gt':  if (!(actualValue > opVal)) return false; break;
          case '$gte': if (!(actualValue >= opVal)) return false; break;
          case '$lt':  if (!(actualValue < opVal)) return false; break;
          case '$lte': if (!(actualValue <= opVal)) return false; break;
          case '$ne':  if (actualValue === opVal) return false; break;
          case '$in':  if (!Array.isArray(opVal) || !opVal.includes(actualValue)) return false; break;
          default: break;
        }
      }
    } else {
      // Simple equality
      if (actualValue !== expectedValue) return false;
    }
  }

  return true;
}

/**
 * Get a nested value from an object using dot notation.
 * @param {Object} obj
 * @param {string} path - e.g., "entity.site" or "metrics.on_time_rate"
 * @returns {*}
 */
function getNestedValue(obj, path) {
  return path.split('.').reduce((current, key) => current?.[key], obj);
}

// ── Cooldown Check ──────────────────────────────────────────────────────────

/**
 * Check if a rule is in cooldown based on recent event history.
 *
 * @param {Object} rule - Event rule with cooldown_seconds
 * @param {Object[]} recentEvents - Recent processed events matching this rule
 * @param {Date|string} [now] - Current time (default: new Date())
 * @returns {{ inCooldown: boolean, cooldownRemainingMs: number, lastProcessedAt: string|null }}
 */
export function isInCooldown(rule, recentEvents, now = new Date()) {
  if (!rule.cooldown_seconds || rule.cooldown_seconds <= 0) {
    return { inCooldown: false, cooldownRemainingMs: 0, lastProcessedAt: null };
  }

  const currentTime = typeof now === 'string' ? new Date(now) : now;
  const cooldownMs = rule.cooldown_seconds * 1000;

  // Find the most recent processed event for this rule
  const matchingEvents = (recentEvents || [])
    .filter(e => e.status === 'processed' || e.status === 'matched')
    .sort((a, b) => new Date(b.processed_at || b.created_at) - new Date(a.processed_at || a.created_at));

  if (matchingEvents.length === 0) {
    return { inCooldown: false, cooldownRemainingMs: 0, lastProcessedAt: null };
  }

  const lastProcessedAt = matchingEvents[0].processed_at || matchingEvents[0].created_at;
  const elapsed = currentTime.getTime() - new Date(lastProcessedAt).getTime();
  const remaining = cooldownMs - elapsed;

  return {
    inCooldown: remaining > 0,
    cooldownRemainingMs: Math.max(0, remaining),
    lastProcessedAt,
  };
}

// ── Rule Matching ───────────────────────────────────────────────────────────

/**
 * Find the best matching rule for an event.
 * Rules are sorted by priority (descending). First match wins.
 *
 * @param {Object} event - { event_type, payload }
 * @param {Object[]} rules - Array of event_rules (sorted by priority desc)
 * @param {Object[]} [recentEvents] - Recent processed events for cooldown check
 * @returns {{ matched: boolean, rule: Object|null, reason: string }}
 */
export function matchEventRule(event, rules, recentEvents = []) {
  if (!event?.event_type) {
    return { matched: false, rule: null, reason: 'Event missing event_type' };
  }

  // Sort rules by priority (higher first)
  const sortedRules = [...rules]
    .filter(r => r.enabled !== false)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0));

  for (const rule of sortedRules) {
    // 1. Check event type pattern
    if (!matchEventType(event.event_type, rule.event_type_pattern)) {
      continue;
    }

    // 2. Check payload conditions
    if (!checkCondition(event.payload, rule.condition_json)) {
      continue;
    }

    // 3. Check cooldown
    const ruleEvents = recentEvents.filter(e =>
      matchEventType(e.event_type, rule.event_type_pattern)
    );
    const { inCooldown, cooldownRemainingMs: _cooldownRemainingMs } = isInCooldown(rule, ruleEvents);
    if (inCooldown) {
      continue; // Skip this rule, check next
    }

    return { matched: true, rule, reason: `Matched rule "${rule.name}"` };
  }

  return { matched: false, rule: null, reason: 'No matching rule found' };
}

// ── DWO Builder ─────────────────────────────────────────────────────────────

/**
 * Build a Decision Work Order from a matched event + rule.
 *
 * @param {Object} event - { event_type, payload, source_system }
 * @param {Object} rule - Matched event_rule
 * @returns {Object} Decision Work Order
 */
export function buildDWOFromEvent(event, rule) {
  const payload = event.payload || {};

  // Extract entity refs from payload
  const entityRefs = {};
  if (payload.sku) entityRefs.sku = Array.isArray(payload.sku) ? payload.sku : [payload.sku];
  if (payload.material_code) entityRefs.sku = [payload.material_code];
  if (payload.site || payload.plant_id) entityRefs.site = [payload.site || payload.plant_id];
  if (payload.supplier_id) entityRefs.supplier = [payload.supplier_id];
  if (payload.time_bucket) entityRefs.time_bucket = payload.time_bucket;

  // Map event type to intent type
  const intentMapping = {
    [EVENT_TYPES.SUPPLIER_DELAY]:            INTENT_TYPES.PROCUREMENT_EXPEDITE,
    [EVENT_TYPES.SUPPLIER_QUALITY_ISSUE]:     INTENT_TYPES.SUPPLIER_RISK_ASSESS,
    [EVENT_TYPES.INVENTORY_BELOW_THRESHOLD]:  INTENT_TYPES.INVENTORY_REPLAN,
    [EVENT_TYPES.INVENTORY_EXCESS]:           INTENT_TYPES.ALLOCATION_OPTIMIZE,
    [EVENT_TYPES.FORECAST_ACCURACY_DRIFT]:    INTENT_TYPES.FORECAST_REFRESH,
    [EVENT_TYPES.PO_OVERDUE]:                 INTENT_TYPES.PROCUREMENT_EXPEDITE,
    [EVENT_TYPES.DEMAND_SPIKE]:               INTENT_TYPES.DEMAND_REVIEW,
    [EVENT_TYPES.DEMAND_CRASH]:               INTENT_TYPES.DEMAND_REVIEW,
    [EVENT_TYPES.KPI_BREACH]:                 INTENT_TYPES.KPI_ANALYSIS,
    [EVENT_TYPES.DATA_QUALITY_ALERT]:         INTENT_TYPES.DATA_QUALITY_CHECK,
  };

  return createDecisionWorkOrder({
    intent_type: rule.intent_type || intentMapping[event.event_type] || INTENT_TYPES.AD_HOC_QUERY,
    worker_id: rule.target_worker_id,
    business_domain: rule.business_domain || 'supply_planning',
    request_summary: payload.summary || payload.description || `${event.event_type}: ${payload.material_code || payload.sku || 'unknown entity'}`,
    source_channel: SOURCE_CHANNELS.EVENT_QUEUE,
    entity_refs: entityRefs,
    required_decision: payload.required_decision || 'informational',
    risk_level: payload.severity || 'medium',
    due_at: payload.due_at || null,
    input_context: {
      event_id: event.id,
      event_type: event.event_type,
      source_system: event.source_system,
      original_payload: payload,
      rule_id: rule.id,
      rule_name: rule.name,
    },
  });
}
