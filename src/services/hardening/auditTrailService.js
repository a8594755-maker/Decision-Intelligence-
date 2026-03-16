/**
 * auditTrailService.js — Complete audit trail for the decision pipeline
 *
 * Provides a unified audit log that captures every significant event
 * across the full decision lifecycle: intake → analyze → plan → review → publish → value.
 *
 * Builds on worklogTaxonomy.js but adds decision-specific audit entries.
 *
 * @module services/hardening/auditTrailService
 */

// ── Audit Event Types ───────────────────────────────────────────────────────

export const AUDIT_EVENTS = Object.freeze({
  // Intake
  TASK_RECEIVED:          'task_received',
  DWO_CREATED:            'dwo_created',
  EVENT_MATCHED:          'event_matched',

  // Pipeline
  PHASE_STARTED:          'phase_started',
  PHASE_COMPLETED:        'phase_completed',
  ARTIFACT_PRODUCED:      'artifact_produced',

  // Review
  REVIEW_REQUESTED:       'review_requested',
  REVIEW_SUBMITTED:       'review_submitted',
  AUTO_APPROVED:          'auto_approved',

  // Publish
  PUBLISH_ATTEMPTED:      'publish_attempted',
  PUBLISH_SUCCEEDED:      'publish_succeeded',
  PUBLISH_FAILED:         'publish_failed',
  PUBLISH_DEDUPLICATED:   'publish_deduplicated',

  // Value
  VALUE_RECORDED:         'value_recorded',

  // Error/Recovery
  STEP_RETRY:             'step_retry',
  SELF_HEAL:              'self_heal',
  ESCALATION:             'escalation',
});

// ── Audit Entry Builder ─────────────────────────────────────────────────────

/**
 * Build a structured audit entry.
 *
 * @param {string} event - AUDIT_EVENTS value
 * @param {Object} data - Event-specific data
 * @param {Object} [context] - { taskId, workerId, stepName, userId }
 * @returns {Object} Audit entry
 */
export function buildAuditEntry(event, data = {}, context = {}) {
  return {
    audit_event: event,
    task_id: context.taskId || null,
    worker_id: context.workerId || null,
    step_name: context.stepName || null,
    user_id: context.userId || null,
    data,
    timestamp: new Date().toISOString(),
  };
}

// ── Audit Trail Builder ─────────────────────────────────────────────────────

/**
 * Build a complete audit trail for a task from worklogs and artifacts.
 *
 * @param {Object} params
 * @param {Object[]} params.worklogs - Task worklogs
 * @param {Object[]} params.steps - Task steps with artifacts
 * @param {Object} [params.resolution] - Review resolution
 * @param {Object[]} [params.publishAttempts] - Publish attempt records
 * @param {Object[]} [params.valueEvents] - ROI value events
 * @returns {Object} { entries: AuditEntry[], completeness: Object }
 */
export function buildFullAuditTrail({
  worklogs = [],
  steps = [],
  resolution = null,
  publishAttempts = [],
  valueEvents = [],
}) {
  const entries = [];

  // 1. Task lifecycle from worklogs
  for (const wl of worklogs) {
    entries.push({
      audit_event: wl.event || wl.data?.event || 'worklog_entry',
      task_id: wl.task_id,
      worker_id: wl.employee_id,
      step_name: wl.step_name || null,
      data: wl.data || wl,
      timestamp: wl.created_at || wl.timestamp,
    });
  }

  // 2. Step artifacts
  for (const step of steps) {
    if (step.status === 'succeeded' && step.artifact_refs?.length > 0) {
      for (const art of step.artifact_refs) {
        entries.push(buildAuditEntry(AUDIT_EVENTS.ARTIFACT_PRODUCED, {
          artifact_type: art.artifact_type || art.type,
          step_name: step.step_name,
          step_index: step.step_index,
        }, { taskId: step.task_id, stepName: step.step_name }));
      }
    }
  }

  // 3. Review resolution
  if (resolution) {
    entries.push(buildAuditEntry(AUDIT_EVENTS.REVIEW_SUBMITTED, {
      decision: resolution.decision,
      reviewer_id: resolution.reviewer_id,
      publish_permission: resolution.publish_permission,
      has_notes: Boolean(resolution.review_notes),
    }, { taskId: resolution.task_id, userId: resolution.reviewer_id }));
  }

  // 4. Publish attempts
  for (const attempt of publishAttempts) {
    const event = attempt.deduplicated ? AUDIT_EVENTS.PUBLISH_DEDUPLICATED
      : attempt.ok ? AUDIT_EVENTS.PUBLISH_SUCCEEDED
      : AUDIT_EVENTS.PUBLISH_FAILED;
    entries.push(buildAuditEntry(event, attempt, { taskId: attempt.task_id }));
  }

  // 5. Value events
  for (const ve of valueEvents) {
    entries.push(buildAuditEntry(AUDIT_EVENTS.VALUE_RECORDED, {
      value_type: ve.value_type,
      value_amount: ve.value_amount,
      confidence: ve.confidence,
    }, { taskId: ve.task_id, workerId: ve.worker_id }));
  }

  // Sort by timestamp
  entries.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));

  // Completeness check
  const completeness = checkAuditCompleteness(entries);

  return { entries, completeness };
}

/**
 * Check audit trail completeness.
 *
 * @param {Object[]} entries - Audit entries
 * @returns {{ complete: boolean, missing: string[], score: number }}
 */
export function checkAuditCompleteness(entries) {
  const eventTypes = new Set(entries.map(e => e.audit_event));

  const expectedEvents = [
    'task_received',
    'artifact_produced',
  ];

  const desiredEvents = [
    'review_submitted',
    'publish_succeeded',
    'value_recorded',
  ];

  const missingRequired = expectedEvents.filter(e => !eventTypes.has(e));
  const missingDesired = desiredEvents.filter(e => !eventTypes.has(e));

  const totalExpected = expectedEvents.length + desiredEvents.length;
  const present = totalExpected - missingRequired.length - missingDesired.length;
  const score = totalExpected > 0 ? present / totalExpected : 0;

  return {
    complete: missingRequired.length === 0,
    missing: [...missingRequired.map(e => `[required] ${e}`), ...missingDesired.map(e => `[desired] ${e}`)],
    score: Math.round(score * 100) / 100,
  };
}

/**
 * Format audit trail for display.
 */
export function formatAuditTrail(entries) {
  return entries.map(e => ({
    time: e.timestamp,
    event: e.audit_event,
    actor: e.user_id || e.worker_id || 'system',
    step: e.step_name || null,
    summary: _summarizeAuditEntry(e),
  }));
}

function _summarizeAuditEntry(entry) {
  const d = entry.data || {};
  switch (entry.audit_event) {
    case AUDIT_EVENTS.ARTIFACT_PRODUCED:
      return `Produced ${d.artifact_type} at step "${d.step_name}"`;
    case AUDIT_EVENTS.REVIEW_SUBMITTED:
      return `Review: ${d.decision} by ${d.reviewer_id}`;
    case AUDIT_EVENTS.PUBLISH_SUCCEEDED:
      return `Published ${d.operation} (key: ${d.idempotency_key?.slice(0, 12)}...)`;
    case AUDIT_EVENTS.PUBLISH_FAILED:
      return `Publish failed: ${d.error}`;
    case AUDIT_EVENTS.VALUE_RECORDED:
      return `Value: ${d.value_type} $${d.value_amount} (conf ${Math.round((d.confidence || 0) * 100)}%)`;
    default:
      return entry.audit_event;
  }
}
