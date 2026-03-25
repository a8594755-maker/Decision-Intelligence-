/**
 * publishService.js — Publish dispatcher for approved decision artifacts
 *
 * Handles two v1 output channels:
 *   1. spreadsheet_export — CSV/Excel export via existing excelOpsService
 *   2. erp_adapter_payload — JSON structured payload (no direct ERP connection in v1)
 *
 * Design:
 *   - Every publish action requires a prior approval resolution
 *   - Writeback payloads must have idempotency keys
 *   - Publish results are tracked as artifacts
 *   - Failed publishes can be retried via the orchestrator
 *
 * @module services/publishService
 */

import { applyApproval, markWritebackFailed } from '../artifacts/writebackPayloadBuilder.js';
import { enforceApprovalGate, validateIdempotencyKey } from '../planning/approvalGateService.js';
import { checkIdempotency, _resetForTesting as _resetIdempotency } from '../hardening/idempotencyService.js';
import { executeWithRecovery } from '../hardening/publishRecoveryService.js';
import { validateExportSchema, normalizeExportRows } from '../hardening/exportSchemaValidator.js';
import { transformToErpPayload } from '../hardening/erpAdapterPayload.js';

// ── Publish Status ──────────────────────────────────────────────────────────

export const PUBLISH_STATUS = Object.freeze({
  PENDING:   'pending',
  APPROVED:  'approved',
  PUBLISHED: 'published',
  FAILED:    'failed',
});

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Publish a spreadsheet export from plan artifacts.
 *
 * @param {Object} params
 * @param {string} params.taskId
 * @param {Object} params.writebackPayload - writeback_payload artifact
 * @param {Object} params.decisionBrief - decision_brief artifact
 * @param {string} [params.format='csv'] - 'csv' | 'excel'
 * @param {string} [params.workerTemplateId]
 * @param {string} [params.autonomyLevel]
 * @returns {Promise<{ok: boolean, path?: string, error?: string}>}
 */
export async function publishSpreadsheetExport({
  taskId,
  writebackPayload,
  decisionBrief = null,
  format = 'csv',
  workerTemplateId = null,
  autonomyLevel = 'A1',
}) {
  // 1. Enforce approval gate
  const gate = enforceApprovalGate({
    taskId,
    actionType: 'export',
    writebackPayload,
    decisionBrief,
    workerTemplateId,
    autonomyLevel,
  });

  if (!gate.allowed) {
    return { ok: false, error: `Export blocked: ${gate.reason}`, needs_approval: true };
  }

  const idemKey = writebackPayload?.idempotency_key;

  // 2. Build export data from mutations
  const mutations = writebackPayload?.intended_mutations || [];
  const rawRows = mutations.map(m => ({
    material_code: m.field_changes?.material_code || '',
    plant_id: m.field_changes?.plant_id || '',
    action: m.action || '',
    quantity: m.field_changes?.quantity || 0,
    order_date: m.field_changes?.order_date || '',
    delivery_date: m.field_changes?.delivery_date || '',
    supplier_id: m.field_changes?.supplier_id || '',
    entity_type: m.entity || '',
  }));

  // 3. Validate schema via hardening validator
  const exportArtifactDraft = { data: rawRows };
  const schemaCheck = validateExportSchema(exportArtifactDraft);
  if (!schemaCheck.valid) {
    return { ok: false, error: `Export schema invalid: ${schemaCheck.errors.join('; ')}` };
  }

  // 4. Normalize rows to canonical schema
  const rows = normalizeExportRows(rawRows);

  // 5. Execute with idempotency + recovery
  const result = await executeWithRecovery({
    idempotencyKey: idemKey || `export_${taskId}_${Date.now()}`,
    operation: 'export',
    taskId,
    executeFn: async () => {
      const exportArtifact = {
        artifact_type: 'spreadsheet_export',
        format,
        row_count: rows.length,
        columns: rows.length > 0 ? Object.keys(rows[0]) : [],
        data: rows,
        task_id: taskId,
        idempotency_key: idemKey,
        approved_by: gate.resolution?.reviewer_id || null,
        exported_at: new Date().toISOString(),
        schema_warnings: schemaCheck.warnings,
      };
      return { ok: true, artifact: exportArtifact, row_count: rows.length };
    },
  });

  if (result.deduplicated) {
    return { ok: true, deduplicated: true, message: 'Export already published (idempotency)', ...(result.result || {}) };
  }
  return result.ok
    ? { ok: true, ...(result.result || {}) }
    : { ok: false, error: result.error };
}

/**
 * Publish a writeback payload (ERP adapter format).
 * v1: Generates the approved JSON payload; does NOT connect to ERP.
 *
 * @param {Object} params
 * @param {string} params.taskId
 * @param {Object} params.writebackPayload
 * @param {Object} params.decisionBrief
 * @param {Object} params.approval - { approved_by, review_id, policy_ref }
 * @param {string} [params.workerTemplateId]
 * @param {string} [params.autonomyLevel]
 * @returns {Promise<{ok: boolean, payload?: Object, error?: string}>}
 */
export async function publishWriteback({
  taskId,
  writebackPayload,
  decisionBrief = null,
  approval = {},
  workerTemplateId = null,
  autonomyLevel = 'A1',
}) {
  // 1. Enforce approval gate (writeback always requires approval in v1 defaults)
  const gate = enforceApprovalGate({
    taskId,
    actionType: 'writeback',
    writebackPayload,
    decisionBrief,
    workerTemplateId,
    autonomyLevel,
  });

  if (!gate.allowed) {
    return { ok: false, error: `Writeback blocked: ${gate.reason}`, needs_approval: true };
  }

  // 2. Validate idempotency key
  const idemCheck = validateIdempotencyKey(writebackPayload);
  if (!idemCheck.valid) {
    return { ok: false, error: idemCheck.reason };
  }

  const idemKey = writebackPayload.idempotency_key;

  // 3. Apply approval metadata to payload
  const approvedPayload = applyApproval(writebackPayload, {
    approved_by: approval.approved_by || gate.resolution?.reviewer_id || 'unknown',
    review_id: approval.review_id || gate.resolution?.id || null,
    policy_ref: approval.policy_ref || null,
  });

  // 4. Transform to ERP adapter format (if target_system specified)
  const erpResult = transformToErpPayload(approvedPayload);

  // 5. Execute with idempotency + recovery
  const result = await executeWithRecovery({
    idempotencyKey: idemKey,
    operation: 'writeback',
    taskId,
    executeFn: async () => {
      // v1: no-op — validate + produce approved payload; no direct ERP connection
      const publishedPayload = {
        ...approvedPayload,
        status: 'applied',
        applied_at: new Date().toISOString(),
        erp_adapter: erpResult.ok ? erpResult.adapter_payload : null,
        erp_errors: erpResult.ok ? null : erpResult.errors,
      };
      return { ok: true, payload: publishedPayload };
    },
  });

  if (result.deduplicated) {
    return { ok: true, deduplicated: true, message: 'Writeback already published (idempotency)', ...(result.result || {}) };
  }
  if (!result.ok) {
    const failedPayload = markWritebackFailed(approvedPayload, result.error);
    return { ok: false, error: result.error, payload: failedPayload };
  }
  return { ok: true, ...(result.result || {}) };
}

/**
 * Check if a publish key has been used (for idempotency queries).
 */
export function isPublished(type, idempotencyKey) {
  return checkIdempotency(idempotencyKey, type).exists;
}

// ── Reset (for testing) ─────────────────────────────────────────────────────

export function _resetForTesting() {
  _resetIdempotency();
}
