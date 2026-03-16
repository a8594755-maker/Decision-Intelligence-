/**
 * taskIntakeService.js — Unified Task Intake Orchestration Layer
 *
 * Normalizes task requests from all intake sources (chat, schedule, alerts,
 * email, meeting transcripts) into a unified work order schema before
 * forwarding to the planner/orchestrator.
 *
 * Responsibilities:
 *   1. Message normalization across intake sources
 *   2. Dedup / merge (prevent duplicate tasks for same intent)
 *   3. Priority / SLA / owner extraction
 *   4. Clarification workflow (when intent is ambiguous)
 *   5. Work order creation with unified schema
 *
 * Architecture:
 *   IntakeSource → normalize() → dedup() → enrichWithSLA() → WorkOrder
 *                                                              ↓
 *                                                    planner.createPlan()
 */

import { listTasks } from './aiEmployee/queries.js';
import { fromLegacyWorkOrder, validateDecisionWorkOrder } from '../contracts/decisionWorkOrderContract.js';

// ── Intake Source Types ──────────────────────────────────────────────────────

export const INTAKE_SOURCES = {
  CHAT:               'chat',
  SCHEDULE:           'schedule',
  PROACTIVE_ALERT:    'proactive_alert',
  CLOSED_LOOP:        'closed_loop',
  EMAIL:              'email',
  MEETING_TRANSCRIPT: 'meeting_transcript',
  API:                'api',
};

// ── SLA Configurations ──────────────────────────────────────────────────────

export const SLA_PRESETS = {
  critical: { response_minutes: 15,  resolution_hours: 2,  escalation_hours: 1   },
  urgent:   { response_minutes: 30,  resolution_hours: 4,  escalation_hours: 2   },
  high:     { response_minutes: 60,  resolution_hours: 8,  escalation_hours: 4   },
  medium:   { response_minutes: 120, resolution_hours: 24, escalation_hours: 12  },
  low:      { response_minutes: 480, resolution_hours: 72, escalation_hours: 48  },
};

// ── Priority Detection ──────────────────────────────────────────────────────

const URGENCY_KEYWORDS = {
  critical: ['urgent', 'asap', 'immediately', 'critical', 'emergency', 'stockout', 'down', '緊急', '立刻'],
  high:     ['important', 'priority', 'soon', 'expedite', 'high priority', '重要', '優先'],
  low:      ['when you can', 'no rush', 'low priority', 'whenever', '不急'],
};

/**
 * Detect priority from message text.
 * @param {string} text
 * @returns {'critical'|'urgent'|'high'|'medium'|'low'}
 */
function detectPriority(text) {
  if (!text) return 'medium';
  const lower = text.toLowerCase();

  for (const [level, keywords] of Object.entries(URGENCY_KEYWORDS)) {
    if (keywords.some(k => lower.includes(k))) return level;
  }
  return 'medium';
}

// ── Owner Extraction ────────────────────────────────────────────────────────

const OWNER_PATTERNS = [
  /assign(?:ed)?\s+to\s+(\S+)/i,
  /owner:\s*(\S+)/i,
  /responsible:\s*(\S+)/i,
  /@(\w+)/,
];

/**
 * Extract owner hint from message text.
 * @param {string} text
 * @returns {string|null}
 */
function extractOwnerHint(text) {
  if (!text) return null;
  for (const pattern of OWNER_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// ── Work Order Schema ───────────────────────────────────────────────────────

/**
 * @typedef {Object} WorkOrder
 * @property {string}  id                   - Unique work order ID
 * @property {string}  source               - Intake source (INTAKE_SOURCES)
 * @property {string}  source_ref           - Original source reference (alert_id, schedule_id, etc.)
 * @property {string}  title                - Normalized title
 * @property {string}  description          - Normalized description
 * @property {string}  priority             - 'critical'|'urgent'|'high'|'medium'|'low'
 * @property {Object}  sla                  - SLA configuration
 * @property {string}  owner_hint           - Suggested owner
 * @property {string}  employee_id          - Target AI employee
 * @property {string}  user_id              - Requesting user
 * @property {Object}  context              - Source-specific context
 * @property {boolean} needs_clarification  - Whether clarification is needed
 * @property {string}  clarification_reason - Why clarification is needed
 * @property {string}  dedup_key            - Key for deduplication
 * @property {string}  created_at           - ISO timestamp
 */

function generateWorkOrderId() {
  return `wo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Normalize ───────────────────────────────────────────────────────────────

/**
 * Normalize an intake message into a WorkOrder.
 *
 * @param {Object} params
 * @param {string} params.source          - INTAKE_SOURCES value
 * @param {string} params.message         - Raw message/content
 * @param {string} params.employeeId      - Target AI employee
 * @param {string} params.userId          - Requesting user
 * @param {Object} [params.metadata]      - Source-specific metadata
 * @returns {WorkOrder}
 */
export function normalizeIntake({
  source,
  message,
  employeeId,
  userId,
  metadata = {},
}) {
  const priority = metadata.priority || detectPriority(message);
  const ownerHint = metadata.owner || extractOwnerHint(message);
  const sla = SLA_PRESETS[priority] || SLA_PRESETS.medium;

  // Build dedup key from source + core content
  const dedupKey = buildDedupKey(source, message, metadata);

  // Determine if clarification is needed
  const { needsClarification, reason } = assessClarificationNeed(source, message, metadata);

  // Normalize title based on source
  const title = normalizeTitle(source, message, metadata);

  return {
    id: generateWorkOrderId(),
    source,
    source_ref: metadata.source_ref || metadata.alert_id || metadata.schedule_id || null,
    title,
    description: message || '',
    priority,
    sla: {
      ...sla,
      due_at: new Date(Date.now() + sla.resolution_hours * 3600000).toISOString(),
      escalation_at: new Date(Date.now() + sla.escalation_hours * 3600000).toISOString(),
    },
    owner_hint: ownerHint,
    employee_id: employeeId,
    user_id: userId,
    context: {
      ...metadata,
      original_source: source,
    },
    needs_clarification: needsClarification,
    clarification_reason: reason,
    dedup_key: dedupKey,
    created_at: new Date().toISOString(),
  };
}

// ── Title Normalization ─────────────────────────────────────────────────────

function normalizeTitle(source, message, metadata) {
  if (metadata.title) return metadata.title;

  switch (source) {
    case INTAKE_SOURCES.PROACTIVE_ALERT:
      return metadata.alert_type
        ? `[Alert] ${metadata.alert_type}: ${metadata.material_code || 'Unknown'}`
        : `[Alert] ${(message || '').slice(0, 60)}`;

    case INTAKE_SOURCES.SCHEDULE:
      return metadata.schedule_name || `[Scheduled] ${(message || '').slice(0, 60)}`;

    case INTAKE_SOURCES.CLOSED_LOOP:
      return `[Closed-Loop] ${metadata.trigger_type || 'Rerun'}: ${metadata.dataset_id || ''}`;

    case INTAKE_SOURCES.EMAIL:
      return metadata.subject || `[Email] ${(message || '').slice(0, 60)}`;

    case INTAKE_SOURCES.MEETING_TRANSCRIPT:
      return `[Meeting] ${metadata.meeting_title || (message || '').slice(0, 60)}`;

    default:
      return (message || '').slice(0, 80) || 'Untitled task';
  }
}

// ── Dedup ────────────────────────────────────────────────────────────────────

function buildDedupKey(source, message, metadata) {
  const parts = [source];

  if (metadata.alert_id) parts.push(`alert:${metadata.alert_id}`);
  else if (metadata.schedule_id) parts.push(`sched:${metadata.schedule_id}`);
  else if (metadata.closed_loop_run_id) parts.push(`cl:${metadata.closed_loop_run_id}`);
  else {
    // Content-based dedup: hash first 100 chars
    const content = (message || '').slice(0, 100).toLowerCase().replace(/\s+/g, '_');
    parts.push(`content:${content}`);
  }

  return parts.join('|');
}

/**
 * Check if a duplicate work order already exists for this intake.
 *
 * @param {string} employeeId
 * @param {string} dedupKey
 * @param {number} [windowHours=24] - Dedup window in hours
 * @returns {Promise<{isDuplicate: boolean, existingTaskId?: string}>}
 */
export async function checkDuplicate(employeeId, dedupKey, windowHours = 24) {
  try {
    const tasks = await listTasks(employeeId, { limit: 100 });
    const windowMs = windowHours * 3600000;
    const cutoff = Date.now() - windowMs;

    for (const task of tasks) {
      if (task.status === 'done') continue;

      const taskCreated = new Date(task.created_at).getTime();
      if (taskCreated < cutoff) continue;

      // Check by alert_id
      const taskAlertId = task.input_context?.alert_id;
      if (taskAlertId && dedupKey.includes(`alert:${taskAlertId}`)) {
        return { isDuplicate: true, existingTaskId: task.id };
      }

      // Check by schedule_id
      const taskScheduleId = task.input_context?.schedule_id;
      if (taskScheduleId && dedupKey.includes(`sched:${taskScheduleId}`)) {
        return { isDuplicate: true, existingTaskId: task.id };
      }

      // Check by closed_loop_run_id
      const taskClId = task.input_context?.closed_loop_run_id;
      if (taskClId && dedupKey.includes(`cl:${taskClId}`)) {
        return { isDuplicate: true, existingTaskId: task.id };
      }
    }

    return { isDuplicate: false };
  } catch {
    return { isDuplicate: false }; // dedup is best-effort
  }
}

// ── Clarification Assessment ─────────────────────────────────────────────────

function assessClarificationNeed(source, message, metadata) {
  // Structured sources (alerts, schedules) rarely need clarification
  if ([INTAKE_SOURCES.PROACTIVE_ALERT, INTAKE_SOURCES.SCHEDULE, INTAKE_SOURCES.CLOSED_LOOP].includes(source)) {
    return { needsClarification: false, reason: null };
  }

  // Chat/email messages may be ambiguous
  if (!message || message.trim().length < 10) {
    return { needsClarification: true, reason: 'Message too short to determine intent' };
  }

  // Check for missing required context
  if (source === INTAKE_SOURCES.EMAIL && !metadata.subject) {
    return { needsClarification: true, reason: 'Email subject missing — cannot determine task scope' };
  }

  return { needsClarification: false, reason: null };
}

// ── Unified Intake Pipeline ──────────────────────────────────────────────────

/**
 * Full intake pipeline: normalize → dedup → enrich → return work order.
 *
 * @param {Object} params - Same as normalizeIntake params
 * @returns {Promise<{workOrder: WorkOrder, status: 'created'|'duplicate'|'needs_clarification'}>}
 */
export async function processIntake(params) {
  // Step 1: Normalize
  const workOrder = normalizeIntake(params);

  // Step 2: Check clarification need
  if (workOrder.needs_clarification) {
    return { workOrder, status: 'needs_clarification' };
  }

  // Step 3: Dedup check
  const { isDuplicate, existingTaskId } = await checkDuplicate(
    params.employeeId,
    workOrder.dedup_key
  );

  if (isDuplicate) {
    return {
      workOrder: { ...workOrder, duplicate_of: existingTaskId },
      status: 'duplicate',
    };
  }

  // Step 4: Ready for planner
  return { workOrder, status: 'created' };
}

/**
 * Batch process multiple intake items (e.g., from alert scan).
 *
 * @param {Object[]} items - Array of normalizeIntake params
 * @returns {Promise<{created: WorkOrder[], duplicates: number, clarifications: number}>}
 */
export async function batchProcessIntake(items) {
  const created = [];
  let duplicates = 0;
  let clarifications = 0;

  for (const item of items) {
    const { workOrder, status } = await processIntake(item);
    if (status === 'created') {
      created.push(workOrder);
    } else if (status === 'duplicate') {
      duplicates++;
    } else if (status === 'needs_clarification') {
      clarifications++;
    }
  }

  return { created, duplicates, clarifications };
}

// ── Decision Work Order Conversion ────────────────────────────────────────────

/**
 * Process intake and convert to a Decision Work Order (v2).
 * Extends processIntake() with DWO conversion.
 *
 * @param {Object} params - Same as normalizeIntake params
 * @param {Object} [dwoOverrides] - Additional DWO fields (intent_type, business_domain, entity_refs, etc.)
 * @returns {Promise<{workOrder: Object, dwo: Object, dwoValidation: Object, status: string}>}
 */
export async function processIntakeAsDWO(params, dwoOverrides = {}) {
  const { workOrder, status } = await processIntake(params);

  // Convert to Decision Work Order regardless of status
  const dwo = fromLegacyWorkOrder(workOrder, dwoOverrides);
  const dwoValidation = validateDecisionWorkOrder(dwo);

  return { workOrder, dwo, dwoValidation, status };
}

// ── SLA Utilities ────────────────────────────────────────────────────────────

/**
 * Check SLA status for a work order.
 * @param {WorkOrder} workOrder
 * @returns {{ is_breached: boolean, is_warning: boolean, time_remaining_ms: number }}
 */
export function checkSLAStatus(workOrder) {
  if (!workOrder.sla?.due_at) {
    return { is_breached: false, is_warning: false, time_remaining_ms: Infinity };
  }

  const dueAt = new Date(workOrder.sla.due_at).getTime();
  const remaining = dueAt - Date.now();
  const escalationAt = workOrder.sla.escalation_at
    ? new Date(workOrder.sla.escalation_at).getTime() - Date.now()
    : Infinity;

  return {
    is_breached: remaining <= 0,
    is_warning: escalationAt <= 0 && remaining > 0,
    time_remaining_ms: Math.max(0, remaining),
  };
}
