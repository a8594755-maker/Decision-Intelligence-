/**
 * exportSchemaValidator.js — Validates and normalizes spreadsheet export schemas
 *
 * Ensures every export artifact has a stable, predictable column schema
 * regardless of which planning workflow produced it.
 *
 * @module services/hardening/exportSchemaValidator
 */

// ── Canonical Export Schema ─────────────────────────────────────────────────

export const EXPORT_COLUMNS = Object.freeze([
  { key: 'material_code',  label: 'Material Code',   type: 'string',  required: true },
  { key: 'plant_id',       label: 'Plant / Site',    type: 'string',  required: true },
  { key: 'action',         label: 'Action',          type: 'string',  required: true },
  { key: 'quantity',       label: 'Quantity',         type: 'number',  required: true },
  { key: 'order_date',     label: 'Order Date',      type: 'date',    required: false },
  { key: 'delivery_date',  label: 'Delivery Date',   type: 'date',    required: false },
  { key: 'supplier_id',    label: 'Supplier',        type: 'string',  required: false },
  { key: 'entity_type',    label: 'Entity Type',     type: 'string',  required: false },
  { key: 'unit_cost',      label: 'Unit Cost',       type: 'number',  required: false },
  { key: 'total_cost',     label: 'Total Cost',      type: 'number',  required: false },
]);

const REQUIRED_KEYS = EXPORT_COLUMNS.filter(c => c.required).map(c => c.key);
const ALL_KEYS = EXPORT_COLUMNS.map(c => c.key);

/**
 * Validate an export artifact's data against the canonical schema.
 *
 * @param {Object} exportArtifact - { data: Object[], columns: string[] }
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validateExportSchema(exportArtifact) {
  const errors = [];
  const warnings = [];

  if (!exportArtifact || typeof exportArtifact !== 'object') {
    return { valid: false, errors: ['Export artifact must be a non-null object'], warnings };
  }

  const data = exportArtifact.data || [];
  if (!Array.isArray(data)) {
    return { valid: false, errors: ['Export data must be an array'], warnings };
  }

  if (data.length === 0) {
    warnings.push('Export data is empty');
    return { valid: true, errors, warnings };
  }

  // Check required columns exist in first row
  const sampleKeys = Object.keys(data[0]);
  for (const key of REQUIRED_KEYS) {
    if (!sampleKeys.includes(key)) {
      errors.push(`Missing required column: ${key}`);
    }
  }

  // Check for unknown columns
  for (const key of sampleKeys) {
    if (!ALL_KEYS.includes(key)) {
      warnings.push(`Unknown column "${key}" — will be included but not validated`);
    }
  }

  // Validate data types for a sample of rows
  const sampleSize = Math.min(data.length, 10);
  for (let i = 0; i < sampleSize; i++) {
    const row = data[i];
    for (const col of EXPORT_COLUMNS) {
      const val = row[col.key];
      if (val === undefined || val === null || val === '') continue;

      if (col.type === 'number' && typeof val !== 'number' && isNaN(Number(val))) {
        warnings.push(`Row ${i}: "${col.key}" expected number, got "${typeof val}"`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Normalize export data to match the canonical schema.
 * Fills missing optional columns with null, reorders columns.
 *
 * @param {Object[]} rows - Raw export rows
 * @returns {Object[]} Normalized rows with canonical column order
 */
export function normalizeExportRows(rows) {
  if (!Array.isArray(rows)) return [];

  return rows.map(row => {
    const normalized = {};
    for (const col of EXPORT_COLUMNS) {
      const val = row[col.key];
      if (col.type === 'number' && val !== undefined && val !== null) {
        normalized[col.key] = Number(val) || 0;
      } else {
        normalized[col.key] = val ?? null;
      }
    }
    // Preserve extra columns at the end
    for (const key of Object.keys(row)) {
      if (!ALL_KEYS.includes(key)) {
        normalized[key] = row[key];
      }
    }
    return normalized;
  });
}

/**
 * Generate CSV string from normalized export rows.
 *
 * @param {Object[]} rows
 * @param {Object} [opts]
 * @param {string[]} [opts.columns] - Column order override
 * @returns {string}
 */
export function exportToCsv(rows, { columns = null } = {}) {
  if (!rows || rows.length === 0) return '';

  const cols = columns || ALL_KEYS;
  const header = cols.join(',');
  const lines = rows.map(row =>
    cols.map(key => {
      const val = row[key];
      if (val === null || val === undefined) return '';
      const str = String(val);
      return str.includes(',') || str.includes('"') || str.includes('\n')
        ? `"${str.replace(/"/g, '""')}"`
        : str;
    }).join(',')
  );

  return [header, ...lines].join('\n');
}
