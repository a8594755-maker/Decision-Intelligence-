/**
 * decisionWorkOrderContract.js — Decision Work Order Schema (v2)
 *
 * Unified contract for all task intake, regardless of source channel.
 * Every task entering the system — from chat, event_queue, schedule, webhook,
 * KPI breach, or manual trigger — must be normalized to this shape before
 * entering the orchestrator.
 *
 * This extends the existing WorkOrder in taskIntakeService.js with:
 *   - intent_type (structured intent classification)
 *   - business_domain (scope of the decision)
 *   - entity_refs (structured references to business entities)
 *   - required_decision (what type of decision is needed)
 *   - risk_level (pre-assessed risk)
 *   - attachments / input_context (structured data payloads)
 *
 * @module contracts/decisionWorkOrderContract
 */

// ── Intent Types ────────────────────────────────────────────────────────────

export const INTENT_TYPES = {
  // Supply Planning
  INVENTORY_REPLAN:       'inventory_replan',
  DEMAND_REVIEW:          'demand_review',
  SAFETY_STOCK_ADJUST:    'safety_stock_adjust',
  REPLENISHMENT_PLAN:     'replenishment_plan',
  ALLOCATION_OPTIMIZE:    'allocation_optimize',

  // Procurement
  SUPPLIER_RISK_ASSESS:   'supplier_risk_assess',
  PROCUREMENT_EXPEDITE:   'procurement_expedite',
  DUAL_SOURCE_EVALUATE:   'dual_source_evaluate',

  // Analysis
  FORECAST_REFRESH:       'forecast_refresh',
  KPI_ANALYSIS:           'kpi_analysis',
  SCENARIO_COMPARE:       'scenario_compare',
  ROOT_CAUSE_ANALYZE:     'root_cause_analyze',

  // Reporting
  GENERATE_REPORT:        'generate_report',
  DAILY_SUMMARY:          'daily_summary',
  MBR_PREPARE:            'mbr_prepare',

  // Operational
  DATA_QUALITY_CHECK:     'data_quality_check',
  EXCEPTION_HANDLE:       'exception_handle',

  // General
  AD_HOC_QUERY:           'ad_hoc_query',
};

// ── Business Domains ────────────────────────────────────────────────────────

export const BUSINESS_DOMAINS = {
  SUPPLY_PLANNING:  'supply_planning',
  PROCUREMENT:      'procurement',
  INVENTORY:        'inventory',
  LOGISTICS:        'logistics',
  DEMAND:           'demand',
  RISK:             'risk',
  ANALYTICS:        'analytics',
  OPERATIONS:       'operations',
};

// ── Source Channels ─────────────────────────────────────────────────────────

export const SOURCE_CHANNELS = {
  CHAT:               'chat',
  EVENT_QUEUE:        'event_queue',
  SCHEDULE:           'schedule',
  KPI_BREACH:         'kpi_breach',
  WEBHOOK:            'webhook',
  MANUAL:             'manual',
  EMAIL:              'email',
  MEETING_TRANSCRIPT: 'meeting_transcript',
  PROACTIVE_ALERT:    'proactive_alert',
  CLOSED_LOOP:        'closed_loop',
  API:                'api',
};

// ── Risk Levels ─────────────────────────────────────────────────────────────

export const RISK_LEVELS = {
  LOW:      'low',
  MEDIUM:   'medium',
  HIGH:     'high',
  CRITICAL: 'critical',
};

// ── Required Decision Types ─────────────────────────────────────────────────

export const DECISION_TYPES = {
  REPLENISH_OR_REALLOCATE: 'replenish_or_reallocate',
  EXPEDITE_OR_DEFER:       'expedite_or_defer',
  APPROVE_OR_REJECT:       'approve_or_reject',
  ADJUST_PARAMETERS:       'adjust_parameters',
  SWITCH_SUPPLIER:         'switch_supplier',
  ESCALATE:                'escalate',
  INFORMATIONAL:           'informational',  // No decision needed, just report
};

// ── Validation ──────────────────────────────────────────────────────────────

const REQUIRED_FIELDS = ['intent_type', 'worker_id', 'source_channel', 'request_summary'];

/**
 * Validate a Decision Work Order.
 *
 * @param {Object} dwo - Decision Work Order payload
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateDecisionWorkOrder(dwo) {
  const errors = [];

  if (!dwo || typeof dwo !== 'object') {
    return { valid: false, errors: ['Decision Work Order must be a non-null object'] };
  }

  for (const field of REQUIRED_FIELDS) {
    if (!dwo[field]) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  if (dwo.intent_type && !Object.values(INTENT_TYPES).includes(dwo.intent_type)) {
    errors.push(`Unknown intent_type: ${dwo.intent_type}`);
  }

  if (dwo.business_domain && !Object.values(BUSINESS_DOMAINS).includes(dwo.business_domain)) {
    errors.push(`Unknown business_domain: ${dwo.business_domain}`);
  }

  if (dwo.source_channel && !Object.values(SOURCE_CHANNELS).includes(dwo.source_channel)) {
    errors.push(`Unknown source_channel: ${dwo.source_channel}`);
  }

  if (dwo.risk_level && !Object.values(RISK_LEVELS).includes(dwo.risk_level)) {
    errors.push(`Unknown risk_level: ${dwo.risk_level}`);
  }

  if (dwo.due_at && isNaN(Date.parse(dwo.due_at))) {
    errors.push('due_at must be a valid ISO 8601 timestamp');
  }

  if (dwo.entity_refs && typeof dwo.entity_refs !== 'object') {
    errors.push('entity_refs must be an object');
  }

  return { valid: errors.length === 0, errors };
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a Decision Work Order with defaults.
 *
 * @param {Object} params
 * @returns {Object} Decision Work Order
 */
export function createDecisionWorkOrder({
  intent_type,
  worker_id,
  business_domain = BUSINESS_DOMAINS.SUPPLY_PLANNING,
  request_summary,
  source_channel,
  entity_refs = {},
  required_decision = DECISION_TYPES.INFORMATIONAL,
  risk_level = RISK_LEVELS.MEDIUM,
  due_at = null,
  attachments = [],
  input_context = {},
  priority = 'medium',
  user_id = null,
}) {
  const now = new Date().toISOString();

  return {
    id: `dwo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    version: '2.0',
    intent_type,
    worker_id,
    business_domain,
    request_summary,
    source_channel,
    entity_refs,
    required_decision,
    risk_level,
    priority,
    due_at,
    attachments,
    input_context,
    user_id,
    created_at: now,
  };
}

// ── Conversion from legacy WorkOrder ────────────────────────────────────────

/**
 * Convert a legacy WorkOrder (from taskIntakeService) into a Decision Work Order.
 * Used during migration period — both shapes coexist.
 *
 * @param {Object} legacyWO - WorkOrder from taskIntakeService.normalizeIntake()
 * @param {Object} [overrides] - Additional DWO fields
 * @returns {Object} Decision Work Order
 */
export function fromLegacyWorkOrder(legacyWO, overrides = {}) {
  // Map legacy source to source_channel
  const sourceMapping = {
    chat: SOURCE_CHANNELS.CHAT,
    schedule: SOURCE_CHANNELS.SCHEDULE,
    proactive_alert: SOURCE_CHANNELS.PROACTIVE_ALERT,
    closed_loop: SOURCE_CHANNELS.CLOSED_LOOP,
    email: SOURCE_CHANNELS.EMAIL,
    meeting_transcript: SOURCE_CHANNELS.MEETING_TRANSCRIPT,
    api: SOURCE_CHANNELS.API,
  };

  return createDecisionWorkOrder({
    intent_type: overrides.intent_type || INTENT_TYPES.AD_HOC_QUERY,
    worker_id: legacyWO.employee_id || overrides.worker_id,
    business_domain: overrides.business_domain || BUSINESS_DOMAINS.SUPPLY_PLANNING,
    request_summary: legacyWO.title || legacyWO.description,
    source_channel: sourceMapping[legacyWO.source] || SOURCE_CHANNELS.MANUAL,
    entity_refs: overrides.entity_refs || {},
    required_decision: overrides.required_decision || DECISION_TYPES.INFORMATIONAL,
    risk_level: overrides.risk_level || RISK_LEVELS.MEDIUM,
    due_at: legacyWO.sla?.due_at || null,
    attachments: overrides.attachments || legacyWO.context?.attachments || [],
    input_context: legacyWO.context || {},
    priority: legacyWO.priority || 'medium',
    user_id: legacyWO.user_id,
    ...overrides,
  });
}
