/**
 * worklogTaxonomy.js — Decision-centric Worklog Event Types (v2)
 *
 * Defines structured event types for the audit trail, organized by
 * the 5-phase decision pipeline.
 *
 * Used by orchestrator.js and worklogRepo.js for consistent audit logging.
 *
 * @module services/aiEmployee/worklogTaxonomy
 */

// ── Worklog Categories ──────────────────────────────────────────────────────

export const WORKLOG_CATEGORIES = Object.freeze({
  TASK_LIFECYCLE:   'task_lifecycle',
  STEP_PROGRESS:    'step_progress',
  DECISION:         'decision',
  DATA:             'data',
  REVIEW:           'review',
  PUBLISH:          'publish',
  VALUE:            'value',
});

// ── Decision-Centric Event Types ────────────────────────────────────────────

export const WORKLOG_EVENTS = Object.freeze({
  // ── Intake / Ingest ──
  INTAKE_RECEIVED:       'intake_received',
  INTAKE_NORMALIZED:     'intake_normalized',
  INTAKE_DEDUPLICATED:   'intake_deduplicated',
  INTAKE_NEEDS_CLARIFICATION: 'intake_needs_clarification',
  CLARIFICATION_RECEIVED: 'clarification_received',

  // ── Analysis ──
  ANALYSIS_STARTED:      'analysis_started',
  ANALYSIS_COMPLETED:    'analysis_completed',
  ANALYSIS_FAILED:       'analysis_failed',
  DATA_LOADED:           'data_loaded',
  DATA_QUALITY_ASSESSED: 'data_quality_assessed',
  CONTEXT_ACQUIRED:      'context_acquired',

  // ── Artifact Generation ──
  ARTIFACT_GENERATED:    'artifact_generated',
  DECISION_BRIEF_BUILT:  'decision_brief_built',
  EVIDENCE_PACK_BUILT:   'evidence_pack_built',
  WRITEBACK_PAYLOAD_BUILT: 'writeback_payload_built',

  // ── Review ──
  REVIEW_REQUESTED:      'review_requested',
  REVIEW_RESOLVED:       'review_resolved',
  REVIEW_ESCALATED:      'review_escalated',
  REVIEW_AUTO_APPROVED:  'review_auto_approved',

  // ── Publish / Writeback ──
  WRITEBACK_PREPARED:    'writeback_prepared',
  WRITEBACK_APPLIED:     'writeback_applied',
  WRITEBACK_FAILED:      'writeback_failed',
  EXPORT_COMPLETED:      'export_completed',
  NOTIFICATION_SENT:     'notification_sent',

  // ── Task Lifecycle (existing, extended) ──
  TASK_CREATED:          'task_created',
  TASK_APPROVED:         'task_approved',
  TASK_COMPLETED:        'task_completed',
  TASK_FAILED:           'task_failed',
  TASK_CANCELLED:        'task_cancelled',
  TASK_RETRIED:          'task_retried',

  // ── Step (existing) ──
  STEP_STARTED:          'step_started',
  STEP_SUCCEEDED:        'step_succeeded',
  STEP_FAILED:           'step_failed',
  STEP_RETRIED:          'step_retried',
  STEP_SKIPPED:          'step_skipped',

  // ── Value Tracking ──
  VALUE_EVENT_RECORDED:  'value_event_recorded',
});

// ── Helper: Build worklog entry ─────────────────────────────────────────────

/**
 * Build a structured worklog entry.
 *
 * @param {string} event - WORKLOG_EVENTS value
 * @param {Object} data - Event-specific data
 * @param {Object} [context] - { taskId, stepId, pipelinePhase }
 * @returns {Object} Worklog content object
 */
export function buildWorklogEntry(event, data = {}, context = {}) {
  return {
    event,
    pipeline_phase: context.pipelinePhase || null,
    timestamp: new Date().toISOString(),
    ...data,
  };
}

/**
 * Map a pipeline phase to its expected worklog events.
 * Useful for audit completeness checks.
 */
export const PHASE_EXPECTED_EVENTS = Object.freeze({
  ingest: [
    WORKLOG_EVENTS.INTAKE_RECEIVED,
    WORKLOG_EVENTS.INTAKE_NORMALIZED,
  ],
  analyze: [
    WORKLOG_EVENTS.ANALYSIS_STARTED,
    WORKLOG_EVENTS.ANALYSIS_COMPLETED,
  ],
  draft_plan: [
    WORKLOG_EVENTS.ARTIFACT_GENERATED,
    WORKLOG_EVENTS.DECISION_BRIEF_BUILT,
  ],
  review_gate: [
    WORKLOG_EVENTS.REVIEW_REQUESTED,
    WORKLOG_EVENTS.REVIEW_RESOLVED,
  ],
  publish: [
    WORKLOG_EVENTS.WRITEBACK_PREPARED,
  ],
});

/**
 * Check audit completeness for a task's worklogs against expected events.
 *
 * @param {Object[]} worklogs - Array of worklog entries
 * @param {string[]} phases - Phases to check (default: all)
 * @returns {{ complete: boolean, missing: Object }}
 */
export function checkAuditCompleteness(worklogs, phases = null) {
  const phasesToCheck = phases || Object.keys(PHASE_EXPECTED_EVENTS);
  const events = worklogs.map(w => w.content?.event || w.event).filter(Boolean);
  const missing = {};
  let allComplete = true;

  for (const phase of phasesToCheck) {
    const expected = PHASE_EXPECTED_EVENTS[phase] || [];
    const missingEvents = expected.filter(e => !events.includes(e));
    if (missingEvents.length > 0) {
      missing[phase] = missingEvents;
      allComplete = false;
    }
  }

  return { complete: allComplete, missing };
}
