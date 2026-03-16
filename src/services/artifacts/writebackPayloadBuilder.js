/**
 * writebackPayloadBuilder.js — Builds writeback_payload artifacts
 *
 * Translates planning results into structured mutations that can be
 * sent to ERP systems or exported as spreadsheets.
 *
 * v1: Generates JSON payloads; actual ERP integration deferred.
 *
 * @module services/artifacts/writebackPayloadBuilder
 */

import { v4 as uuidv4 } from 'uuid';

// Lightweight UUID fallback if uuid package unavailable
function generateIdempotencyKey() {
  try {
    return uuidv4();
  } catch {
    return `idem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

// ── Target Systems ──────────────────────────────────────────────────────────

export const TARGET_SYSTEMS = Object.freeze({
  SAP_MM:     'sap_mm',
  SAP_PP:     'sap_pp',
  ORACLE_SCM: 'oracle_scm',
  CSV_EXPORT: 'csv_export',
  EXCEL:      'excel',
  JSON_FILE:  'json_file',
  GENERIC:    'generic',
});

// ── Mutation Actions ────────────────────────────────────────────────────────

export const MUTATION_ACTIONS = Object.freeze({
  CREATE_PO:          'create_po',
  UPDATE_PO:          'update_po',
  CREATE_PRODUCTION:  'create_production_order',
  ADJUST_SAFETY:      'adjust_safety_stock',
  TRANSFER:           'create_transfer_order',
  EXPEDITE:           'expedite_delivery',
  DEFER:              'defer_order',
  CANCEL:             'cancel_order',
});

/**
 * Build a writeback_payload artifact from planning results.
 *
 * @param {Object} params
 * @param {Object} params.planArtifacts - Prior step artifacts
 * @param {Object} params.taskMeta - Task metadata
 * @param {string} [params.targetSystem='csv_export'] - Target system
 * @param {string} [params.format='json'] - Output format
 * @returns {Object} writeback_payload artifact payload
 */
export function buildWritebackPayload({
  planArtifacts = {},
  taskMeta = {},
  targetSystem = TARGET_SYSTEMS.CSV_EXPORT,
  format = 'json',
}) {
  // Extract plan table
  const planTable = findPlanTable(planArtifacts);
  const rows = Array.isArray(planTable) ? planTable : planTable?.rows || [];

  // Build mutations from plan rows
  const mutations = rows.map(row => buildMutation(row, targetSystem));

  // Build affected records
  const affectedRecords = buildAffectedRecords(rows);

  return {
    target_system: targetSystem,
    format,
    intended_mutations: mutations,
    affected_records: affectedRecords,
    idempotency_key: generateIdempotencyKey(),
    approval_metadata: {
      approved_by: null,
      approved_at: null,
      review_id: null,
      policy_ref: null,
    },
    status: 'pending_approval',
    task_id: taskMeta.id || null,
    task_title: taskMeta.title || null,
    generated_at: new Date().toISOString(),
    mutation_summary: {
      total_mutations: mutations.length,
      total_qty: rows.reduce((sum, r) => sum + (r.order_qty || 0), 0),
      unique_skus: [...new Set(rows.map(r => r.sku || r.material_code).filter(Boolean))].length,
      unique_sites: [...new Set(rows.map(r => r.plant_id || r.site).filter(Boolean))].length,
    },
  };
}

/**
 * Apply approval metadata to a writeback payload.
 *
 * @param {Object} payload - Existing writeback_payload
 * @param {Object} approval - { approved_by, review_id, policy_ref }
 * @returns {Object} Updated payload with approved status
 */
export function applyApproval(payload, approval) {
  return {
    ...payload,
    status: 'approved',
    approval_metadata: {
      approved_by: approval.approved_by,
      approved_at: new Date().toISOString(),
      review_id: approval.review_id || null,
      policy_ref: approval.policy_ref || null,
    },
  };
}

/**
 * Mark a writeback payload as failed.
 */
export function markWritebackFailed(payload, errorMessage) {
  return {
    ...payload,
    status: 'failed',
    error_message: errorMessage,
    failed_at: new Date().toISOString(),
  };
}

// ── Internal helpers ────────────────────────────────────────────────────────

function findPlanTable(artifacts) {
  if (Array.isArray(artifacts)) {
    const match = artifacts.find(a =>
      a.artifact_type === 'plan_table' || a.artifact_type === 'risk_plan_table'
    );
    return match?.payload || null;
  }
  for (const stepArts of Object.values(artifacts || {})) {
    if (!Array.isArray(stepArts)) continue;
    const match = stepArts.find(a =>
      a.artifact_type === 'plan_table' || a.artifact_type === 'risk_plan_table'
    );
    if (match) return match.payload || match;
  }
  return null;
}

function buildMutation(row, targetSystem) {
  const sku = row.sku || row.material_code || 'UNKNOWN';
  const qty = row.order_qty || 0;
  const site = row.plant_id || row.site || 'DEFAULT';

  // Determine action based on row data
  let action = MUTATION_ACTIONS.CREATE_PO;
  if (row.action_type) {
    action = row.action_type;
  } else if (row.order_type === 'production') {
    action = MUTATION_ACTIONS.CREATE_PRODUCTION;
  } else if (row.order_type === 'transfer') {
    action = MUTATION_ACTIONS.TRANSFER;
  }

  const mutation = {
    entity: resolveEntityType(action, targetSystem),
    action,
    field_changes: {
      material_code: sku,
      plant_id: site,
      quantity: qty,
      order_date: row.order_date || null,
      delivery_date: row.arrival_date || row.delivery_date || null,
      supplier_id: row.supplier_id || null,
    },
  };

  // Add before/after for safety stock adjustments
  if (action === MUTATION_ACTIONS.ADJUST_SAFETY) {
    mutation.before = { safety_stock: row.current_safety_stock || null };
    mutation.after = { safety_stock: row.new_safety_stock || qty };
  }

  return mutation;
}

function resolveEntityType(action, targetSystem) {
  const entityMap = {
    [MUTATION_ACTIONS.CREATE_PO]: 'purchase_order',
    [MUTATION_ACTIONS.UPDATE_PO]: 'purchase_order',
    [MUTATION_ACTIONS.CREATE_PRODUCTION]: 'production_order',
    [MUTATION_ACTIONS.ADJUST_SAFETY]: 'material_master',
    [MUTATION_ACTIONS.TRANSFER]: 'transfer_order',
    [MUTATION_ACTIONS.EXPEDITE]: 'purchase_order',
    [MUTATION_ACTIONS.DEFER]: 'purchase_order',
    [MUTATION_ACTIONS.CANCEL]: 'purchase_order',
  };
  return entityMap[action] || 'generic_record';
}

function buildAffectedRecords(rows) {
  const recordMap = new Map();

  for (const row of rows) {
    const sku = row.sku || row.material_code || 'UNKNOWN';
    const site = row.plant_id || row.site || 'DEFAULT';
    const key = `${sku}@${site}`;

    if (!recordMap.has(key)) {
      recordMap.set(key, {
        entity_type: 'material',
        entity_id: sku,
        site,
        description: `${sku} at ${site}`,
        qty: 0,
        order_count: 0,
      });
    }

    const rec = recordMap.get(key);
    rec.qty += row.order_qty || 0;
    rec.order_count += 1;
  }

  return Array.from(recordMap.values());
}
