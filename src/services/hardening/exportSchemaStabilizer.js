/**
 * exportSchemaStabilizer.js — Freezes the spreadsheet export schema for v1 stability
 *
 * Wraps exportSchemaValidator with versioned schema registry, migration helpers,
 * and strict validation for design-partner readiness.
 *
 * @module services/hardening/exportSchemaStabilizer
 */

import {
  EXPORT_COLUMNS,
  validateExportSchema,
  normalizeExportRows,
  exportToCsv,
} from './exportSchemaValidator.js';

// ── Schema Version Registry ─────────────────────────────────────────────────

export const SCHEMA_VERSION = '1.0.0';

export const SCHEMA_VERSIONS = Object.freeze({
  '1.0.0': {
    columns: EXPORT_COLUMNS,
    frozen_at: '2026-03-17',
    breaking_changes: [],
  },
});

// ── Column Fingerprint ──────────────────────────────────────────────────────

export function getSchemaFingerprint(version = SCHEMA_VERSION) {
  const schema = SCHEMA_VERSIONS[version];
  if (!schema) return null;
  const keys = schema.columns.map(c => `${c.key}:${c.type}:${c.required}`).join('|');
  let hash = 0;
  for (let i = 0; i < keys.length; i++) {
    hash = ((hash << 5) - hash + keys.charCodeAt(i)) | 0;
  }
  return `v${version}-${Math.abs(hash).toString(36)}`;
}

// ── Stable Export Builder ───────────────────────────────────────────────────

/**
 * Build a stable, versioned export artifact ready for design partners.
 *
 * @param {Object} params
 * @param {Object[]} params.rows - Raw plan rows
 * @param {string} params.taskId
 * @param {string} params.format - 'csv' | 'excel'
 * @param {Object} [params.approvalMeta]
 * @returns {{ ok: boolean, artifact?: Object, errors?: string[] }}
 */
export function buildStableExport({ rows, taskId, format = 'csv', approvalMeta = null }) {
  // 1. Normalize rows to canonical schema
  const normalized = normalizeExportRows(rows);

  // 2. Validate against schema
  const validation = validateExportSchema({ data: normalized });
  if (!validation.valid) {
    return { ok: false, errors: validation.errors };
  }

  // 3. Generate CSV content if format=csv
  const csvContent = format === 'csv' ? exportToCsv(normalized) : null;

  // 4. Build versioned artifact
  const artifact = {
    artifact_type: 'spreadsheet_export',
    schema_version: SCHEMA_VERSION,
    schema_fingerprint: getSchemaFingerprint(),
    format,
    columns: EXPORT_COLUMNS.map(c => ({ key: c.key, label: c.label, type: c.type })),
    row_count: normalized.length,
    data: normalized,
    csv: csvContent,
    task_id: taskId,
    approval: approvalMeta || null,
    exported_at: new Date().toISOString(),
    warnings: validation.warnings,
  };

  return { ok: true, artifact };
}

/**
 * Validate that an existing export artifact matches the current frozen schema.
 * Used for regression testing / replay.
 */
export function validateSchemaCompatibility(artifact) {
  if (!artifact?.schema_version) {
    return { compatible: false, reason: 'Missing schema_version' };
  }
  if (!SCHEMA_VERSIONS[artifact.schema_version]) {
    return { compatible: false, reason: `Unknown schema version: ${artifact.schema_version}` };
  }

  const validation = validateExportSchema({ data: artifact.data || [] });
  return {
    compatible: validation.valid,
    current_version: SCHEMA_VERSION,
    artifact_version: artifact.schema_version,
    errors: validation.errors,
    warnings: validation.warnings,
  };
}
