/**
 * decisionArtifactContract.js — Decision Artifact Schemas (v2)
 *
 * Defines the three core artifacts every completed decision task must produce:
 *   1. decision_brief   — Manager-facing recommendation with impact & risk
 *   2. evidence_pack_v2 — Audit-ready provenance (extends existing evidence_pack)
 *   3. writeback_payload — ERP-adapter-ready structured mutations
 *
 * These are registered into diArtifactContractV1.js as validators.
 *
 * @module contracts/decisionArtifactContract
 */

// ── Decision Brief ──────────────────────────────────────────────────────────

/**
 * @typedef {Object} DecisionBrief
 * @property {string}   summary             - 1-2 sentence executive summary
 * @property {string}   recommended_action  - Action code (e.g., 'replenish_now', 'defer_order')
 * @property {string}   recommended_action_label - Human-readable label
 * @property {Object}   business_impact     - Quantified impact
 * @property {number}   business_impact.cost_delta       - Cost change (negative = savings)
 * @property {string}   business_impact.service_level_impact - e.g., "+3%"
 * @property {number}   [business_impact.revenue_at_risk]
 * @property {number}   [business_impact.units_affected]
 * @property {Array}    risk_flags          - Array of { level, category, description }
 * @property {number}   confidence          - 0-1 confidence score
 * @property {string[]} assumptions         - Key assumptions behind the recommendation
 * @property {Object[]} [alternatives]      - Other options considered (optional)
 * @property {Object}   [scenario_comparison] - Base vs recommended scenario KPIs
 */

const DECISION_BRIEF_REQUIRED = ['summary', 'recommended_action', 'confidence'];

export function validateDecisionBrief(payload) {
  if (!payload || typeof payload !== 'object') {
    return { valid: false, reason: 'decision_brief must be a non-null object' };
  }

  for (const field of DECISION_BRIEF_REQUIRED) {
    if (payload[field] === undefined || payload[field] === null) {
      return { valid: false, reason: `decision_brief missing required field: ${field}` };
    }
  }

  if (typeof payload.confidence !== 'number' || payload.confidence < 0 || payload.confidence > 1) {
    return { valid: false, reason: 'decision_brief.confidence must be a number between 0 and 1' };
  }

  if (payload.risk_flags && !Array.isArray(payload.risk_flags)) {
    return { valid: false, reason: 'decision_brief.risk_flags must be an array' };
  }

  if (payload.assumptions && !Array.isArray(payload.assumptions)) {
    return { valid: false, reason: 'decision_brief.assumptions must be an array' };
  }

  return { valid: true };
}

// ── Evidence Pack v2 ────────────────────────────────────────────────────────

/**
 * @typedef {Object} EvidencePackV2
 * @property {Object[]} source_datasets     - Array of { dataset_id, name, row_count, loaded_at }
 * @property {Object}   timestamps          - { analysis_started_at, analysis_completed_at, data_as_of }
 * @property {Object[]} referenced_tables   - Array of { table_name, fields_used[], row_range }
 * @property {Object}   engine_versions     - { solver, forecaster, risk_engine, ... }
 * @property {string}   calculation_logic   - Human-readable summary of how the result was derived
 * @property {Object[]} [scenario_comparison] - Array of { scenario_id, label, kpis }
 * @property {string[]} assumptions         - Explicit assumptions
 * @property {Object[]} [evidence_refs]     - Pointers to other artifacts used as evidence
 */

const EVIDENCE_PACK_V2_REQUIRED = ['source_datasets', 'timestamps', 'engine_versions', 'calculation_logic'];

export function validateEvidencePackV2(payload) {
  if (!payload || typeof payload !== 'object') {
    return { valid: false, reason: 'evidence_pack_v2 must be a non-null object' };
  }

  for (const field of EVIDENCE_PACK_V2_REQUIRED) {
    if (payload[field] === undefined || payload[field] === null) {
      return { valid: false, reason: `evidence_pack_v2 missing required field: ${field}` };
    }
  }

  if (!Array.isArray(payload.source_datasets)) {
    return { valid: false, reason: 'evidence_pack_v2.source_datasets must be an array' };
  }

  if (typeof payload.timestamps !== 'object') {
    return { valid: false, reason: 'evidence_pack_v2.timestamps must be an object' };
  }

  if (typeof payload.engine_versions !== 'object') {
    return { valid: false, reason: 'evidence_pack_v2.engine_versions must be an object' };
  }

  return { valid: true };
}

// ── Writeback Payload ───────────────────────────────────────────────────────

/**
 * @typedef {Object} WritebackPayload
 * @property {string}   target_system       - e.g., 'sap_mm', 'oracle_scm', 'csv_export', 'excel'
 * @property {string}   format              - 'json' | 'csv' | 'idoc' | 'odata'
 * @property {Object[]} intended_mutations  - Array of { entity, action, field_changes, before, after }
 * @property {Object[]} affected_records    - Array of { entity_type, entity_id, description }
 * @property {string}   idempotency_key    - UUID for dedup on retry
 * @property {Object}   approval_metadata  - { approved_by, approved_at, review_id, policy_ref }
 * @property {string}   status             - 'pending_approval' | 'approved' | 'applied' | 'failed' | 'rolled_back'
 * @property {Object}   [rollback_payload] - Reverse mutations for undo
 */

const WRITEBACK_REQUIRED = ['target_system', 'intended_mutations', 'affected_records', 'idempotency_key', 'status'];

export function validateWritebackPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return { valid: false, reason: 'writeback_payload must be a non-null object' };
  }

  for (const field of WRITEBACK_REQUIRED) {
    if (payload[field] === undefined || payload[field] === null) {
      return { valid: false, reason: `writeback_payload missing required field: ${field}` };
    }
  }

  if (!Array.isArray(payload.intended_mutations)) {
    return { valid: false, reason: 'writeback_payload.intended_mutations must be an array' };
  }

  if (!Array.isArray(payload.affected_records)) {
    return { valid: false, reason: 'writeback_payload.affected_records must be an array' };
  }

  const validStatuses = ['pending_approval', 'approved', 'applied', 'failed', 'rolled_back'];
  if (!validStatuses.includes(payload.status)) {
    return { valid: false, reason: `writeback_payload.status must be one of: ${validStatuses.join(', ')}` };
  }

  return { valid: true };
}

// ── Registration helper ─────────────────────────────────────────────────────

/**
 * Returns a map of artifact type → validator for registration into
 * diArtifactContractV1.js V1_VALIDATORS.
 */
export function getDecisionArtifactValidators() {
  return {
    decision_brief: validateDecisionBrief,
    evidence_pack_v2: validateEvidencePackV2,
    writeback_payload: validateWritebackPayload,
  };
}
