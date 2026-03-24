// @product: data-analyst
//
// dataCleaningService.js
// ─────────────────────────────────────────────────────────────────────────────
// Data cleaning & transformation service for general-purpose analysis.
// Operates on dataset profiles (uploaded CSV/Excel) and produces
// a cleaned_dataset artifact with full audit trail.
//
// Supports: missing value handling, deduplication, type conversion,
//           column rename, outlier treatment, standardization.
// ─────────────────────────────────────────────────────────────────────────────

import { datasetProfilesService } from './datasetProfilesService';
import { saveJsonArtifact } from '../utils/artifactStore';

// ── Operation Types ─────────────────────────────────────────────────────────

export const CLEANING_OPS = {
  FILL_MISSING:   'fill_missing',
  DROP_MISSING:   'drop_missing',
  DEDUPLICATE:    'deduplicate',
  TYPE_CONVERT:   'type_convert',
  RENAME_COLUMN:  'rename_column',
  OUTLIER_CAP:    'outlier_cap',
  STANDARDIZE:    'standardize',
  NORMALIZE:      'normalize',
  TRIM_WHITESPACE:'trim_whitespace',
  FILTER_ROWS:    'filter_rows',
};

const FILL_STRATEGIES = ['mean', 'median', 'mode', 'zero', 'forward_fill', 'backward_fill', 'constant'];
const OUTLIER_METHODS = ['iqr', 'zscore'];
const CONVERT_TYPES = ['number', 'string', 'date', 'boolean'];

// ── Helpers ─────────────────────────────────────────────────────────────────

function computeColumnStats(rows, column) {
  const values = rows.map(r => r[column]).filter(v => v != null && v !== '');
  const nums = values.map(Number).filter(n => !isNaN(n));

  if (nums.length === 0) {
    return { count: values.length, nullCount: rows.length - values.length, type: 'string' };
  }

  nums.sort((a, b) => a - b);
  const sum = nums.reduce((s, v) => s + v, 0);
  const mean = sum / nums.length;
  const median = nums.length % 2 === 0
    ? (nums[nums.length / 2 - 1] + nums[nums.length / 2]) / 2
    : nums[Math.floor(nums.length / 2)];

  const q1 = nums[Math.floor(nums.length * 0.25)];
  const q3 = nums[Math.floor(nums.length * 0.75)];
  const iqr = q3 - q1;

  const variance = nums.reduce((s, v) => s + (v - mean) ** 2, 0) / nums.length;
  const std = Math.sqrt(variance);

  // Mode (most frequent)
  const freq = {};
  for (const v of values) {
    freq[v] = (freq[v] || 0) + 1;
  }
  const mode = Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0];

  return {
    count: values.length,
    nullCount: rows.length - values.length,
    type: 'number',
    mean, median, std, q1, q3, iqr,
    min: nums[0],
    max: nums[nums.length - 1],
    mode,
  };
}

function deepCloneRows(rows) {
  return rows.map(r => ({ ...r }));
}

// ── Operation Executors ─────────────────────────────────────────────────────

function fillMissing(rows, { column, strategy, constant_value }) {
  if (!FILL_STRATEGIES.includes(strategy)) {
    throw new Error(`Invalid fill strategy: ${strategy}. Use one of: ${FILL_STRATEGIES.join(', ')}`);
  }

  const stats = computeColumnStats(rows, column);
  let fillValue;

  switch (strategy) {
    case 'mean':     fillValue = stats.mean; break;
    case 'median':   fillValue = stats.median; break;
    case 'mode':     fillValue = stats.mode; break;
    case 'zero':     fillValue = 0; break;
    case 'constant': fillValue = constant_value ?? ''; break;
    case 'forward_fill': {
      let last = null;
      for (const row of rows) {
        if (row[column] != null && row[column] !== '') last = row[column];
        else row[column] = last;
      }
      return { rows, affected: stats.nullCount, strategy };
    }
    case 'backward_fill': {
      let last = null;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i][column] != null && rows[i][column] !== '') last = rows[i][column];
        else rows[i][column] = last;
      }
      return { rows, affected: stats.nullCount, strategy };
    }
  }

  let affected = 0;
  for (const row of rows) {
    if (row[column] == null || row[column] === '') {
      row[column] = fillValue;
      affected++;
    }
  }
  return { rows, affected, strategy, fillValue };
}

function dropMissing(rows, { column, threshold }) {
  const before = rows.length;
  if (column) {
    rows = rows.filter(r => r[column] != null && r[column] !== '');
  } else {
    // Drop rows where null ratio exceeds threshold (default: any null)
    const pct = threshold ?? 0;
    const cols = Object.keys(rows[0] || {});
    rows = rows.filter(r => {
      const nullCount = cols.filter(c => r[c] == null || r[c] === '').length;
      return nullCount / cols.length <= pct;
    });
  }
  return { rows, dropped: before - rows.length };
}

function deduplicate(rows, { columns }) {
  const before = rows.length;
  const seen = new Set();
  const keyCols = columns || Object.keys(rows[0] || {});
  rows = rows.filter(r => {
    const key = keyCols.map(c => String(r[c] ?? '')).join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { rows, removed: before - rows.length };
}

function typeConvert(rows, { column, target_type }) {
  if (!CONVERT_TYPES.includes(target_type)) {
    throw new Error(`Invalid target type: ${target_type}. Use one of: ${CONVERT_TYPES.join(', ')}`);
  }

  let errors = 0;
  for (const row of rows) {
    const val = row[column];
    if (val == null || val === '') continue;
    try {
      switch (target_type) {
        case 'number':  row[column] = Number(val); if (isNaN(row[column])) { errors++; row[column] = null; } break;
        case 'string':  row[column] = String(val); break;
        case 'date':    row[column] = new Date(val).toISOString(); if (row[column] === 'Invalid Date') { errors++; row[column] = null; } break;
        case 'boolean': row[column] = ['true', '1', 'yes', 'y'].includes(String(val).toLowerCase()); break;
      }
    } catch {
      errors++;
      row[column] = null;
    }
  }
  return { rows, errors, target_type };
}

function renameColumn(rows, { old_name, new_name }) {
  for (const row of rows) {
    if (old_name in row) {
      row[new_name] = row[old_name];
      delete row[old_name];
    }
  }
  return { rows, renamed: `${old_name} → ${new_name}` };
}

function outlierCap(rows, { column, method, multiplier }) {
  if (!OUTLIER_METHODS.includes(method)) {
    throw new Error(`Invalid outlier method: ${method}. Use one of: ${OUTLIER_METHODS.join(', ')}`);
  }

  const stats = computeColumnStats(rows, column);
  if (stats.type !== 'number') return { rows, capped: 0, reason: 'non-numeric column' };

  let lower, upper;
  const mult = multiplier ?? (method === 'iqr' ? 1.5 : 3);

  if (method === 'iqr') {
    lower = stats.q1 - mult * stats.iqr;
    upper = stats.q3 + mult * stats.iqr;
  } else {
    lower = stats.mean - mult * stats.std;
    upper = stats.mean + mult * stats.std;
  }

  let capped = 0;
  for (const row of rows) {
    const v = Number(row[column]);
    if (isNaN(v)) continue;
    if (v < lower) { row[column] = lower; capped++; }
    if (v > upper) { row[column] = upper; capped++; }
  }
  return { rows, capped, lower, upper, method };
}

function standardize(rows, { column }) {
  const stats = computeColumnStats(rows, column);
  if (stats.type !== 'number' || stats.std === 0) return { rows, reason: 'non-numeric or zero std' };

  for (const row of rows) {
    const v = Number(row[column]);
    if (!isNaN(v)) row[column] = (v - stats.mean) / stats.std;
  }
  return { rows, mean: stats.mean, std: stats.std };
}

function normalize(rows, { column }) {
  const stats = computeColumnStats(rows, column);
  if (stats.type !== 'number' || stats.max === stats.min) return { rows, reason: 'non-numeric or constant' };

  const range = stats.max - stats.min;
  for (const row of rows) {
    const v = Number(row[column]);
    if (!isNaN(v)) row[column] = (v - stats.min) / range;
  }
  return { rows, min: stats.min, max: stats.max };
}

function trimWhitespace(rows, { column }) {
  let trimmed = 0;
  const cols = column ? [column] : Object.keys(rows[0] || {});
  for (const row of rows) {
    for (const c of cols) {
      if (typeof row[c] === 'string') {
        const before = row[c];
        row[c] = row[c].trim();
        if (row[c] !== before) trimmed++;
      }
    }
  }
  return { rows, trimmed };
}

function filterRows(rows, { column, operator, value }) {
  const before = rows.length;
  rows = rows.filter(r => {
    const v = r[column];
    switch (operator) {
      case 'eq':  return v == value;  // eslint-disable-line eqeqeq
      case 'neq': return v != value;  // eslint-disable-line eqeqeq
      case 'gt':  return Number(v) > Number(value);
      case 'gte': return Number(v) >= Number(value);
      case 'lt':  return Number(v) < Number(value);
      case 'lte': return Number(v) <= Number(value);
      case 'contains': return String(v ?? '').includes(String(value));
      case 'not_null': return v != null && v !== '';
      default: return true;
    }
  });
  return { rows, filtered: before - rows.length };
}

const OP_EXECUTORS = {
  [CLEANING_OPS.FILL_MISSING]:    fillMissing,
  [CLEANING_OPS.DROP_MISSING]:    dropMissing,
  [CLEANING_OPS.DEDUPLICATE]:     deduplicate,
  [CLEANING_OPS.TYPE_CONVERT]:    typeConvert,
  [CLEANING_OPS.RENAME_COLUMN]:   renameColumn,
  [CLEANING_OPS.OUTLIER_CAP]:     outlierCap,
  [CLEANING_OPS.STANDARDIZE]:     standardize,
  [CLEANING_OPS.NORMALIZE]:       normalize,
  [CLEANING_OPS.TRIM_WHITESPACE]: trimWhitespace,
  [CLEANING_OPS.FILTER_ROWS]:     filterRows,
};

// ── Auto-Detect Cleaning Operations ─────────────────────────────────────────

/**
 * Analyze a dataset and suggest cleaning operations automatically.
 * @param {Object[]} rows
 * @returns {{ suggestions: Array<{ op, column, reason, params }> }}
 */
export function suggestCleaningOps(rows) {
  if (!rows?.length) return { suggestions: [] };
  const suggestions = [];
  const columns = Object.keys(rows[0]);

  for (const col of columns) {
    const stats = computeColumnStats(rows, col);

    // Suggest fill/drop for missing values
    const nullPct = stats.nullCount / rows.length;
    if (nullPct > 0 && nullPct <= 0.3) {
      suggestions.push({
        op: CLEANING_OPS.FILL_MISSING,
        column: col,
        reason: `${(nullPct * 100).toFixed(1)}% missing values`,
        params: { strategy: stats.type === 'number' ? 'median' : 'mode' },
      });
    } else if (nullPct > 0.3 && nullPct <= 0.7) {
      suggestions.push({
        op: CLEANING_OPS.DROP_MISSING,
        column: col,
        reason: `${(nullPct * 100).toFixed(1)}% missing — consider dropping rows`,
        params: {},
      });
    }

    // Suggest outlier capping for numeric columns
    if (stats.type === 'number' && stats.iqr > 0) {
      const lower = stats.q1 - 1.5 * stats.iqr;
      const upper = stats.q3 + 1.5 * stats.iqr;
      const outlierCount = rows.filter(r => {
        const v = Number(r[col]);
        return !isNaN(v) && (v < lower || v > upper);
      }).length;
      if (outlierCount / rows.length > 0.02) {
        suggestions.push({
          op: CLEANING_OPS.OUTLIER_CAP,
          column: col,
          reason: `${outlierCount} outliers detected (${(outlierCount / rows.length * 100).toFixed(1)}%)`,
          params: { method: 'iqr', multiplier: 1.5 },
        });
      }
    }
  }

  // Suggest deduplication
  const allCols = Object.keys(rows[0]);
  const seen = new Set();
  let dupes = 0;
  for (const r of rows) {
    const key = allCols.map(c => String(r[c] ?? '')).join('|');
    if (seen.has(key)) dupes++;
    seen.add(key);
  }
  if (dupes > 0) {
    suggestions.push({
      op: CLEANING_OPS.DEDUPLICATE,
      column: null,
      reason: `${dupes} duplicate rows found`,
      params: {},
    });
  }

  return { suggestions };
}

// ── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Clean a dataset by applying a sequence of operations.
 *
 * @param {Object} params
 * @param {string} params.datasetId - Dataset profile ID
 * @param {Array<{ type: string, column?: string, [key: string]: any }>} params.operations
 * @param {boolean} [params.autoDetect=false] - If true, auto-detect and apply suggested ops
 * @param {string} [params.userId]
 * @returns {Promise<{ cleaned_rows: Object[], audit: Object[], artifact_id?: string }>}
 */
export async function cleanDataset({ datasetId, operations = [], autoDetect = false, userId }) {
  // Load dataset
  const profile = datasetProfilesService.getById(datasetId);
  if (!profile) throw new Error(`Dataset profile not found: ${datasetId}`);

  const rawRows = profile.sheets?.[0]?.rows
    || profile.data?.rows
    || profile.rows
    || [];

  if (rawRows.length === 0) throw new Error('Dataset has no rows');

  let rows = deepCloneRows(rawRows);
  const audit = [];
  const beforeCount = rows.length;

  // Auto-detect ops if requested
  let ops = [...operations];
  if (autoDetect && ops.length === 0) {
    const { suggestions } = suggestCleaningOps(rows);
    ops = suggestions.map(s => ({
      type: s.op,
      column: s.column,
      ...s.params,
    }));
  }

  // Execute each operation sequentially
  for (const op of ops) {
    const executor = OP_EXECUTORS[op.type];
    if (!executor) {
      audit.push({ op: op.type, status: 'skipped', reason: `Unknown operation: ${op.type}` });
      continue;
    }

    try {
      const result = executor(rows, op);
      rows = result.rows || rows;
      audit.push({
        op: op.type,
        column: op.column || null,
        status: 'applied',
        details: { ...result, rows: undefined },
      });
    } catch (err) {
      audit.push({
        op: op.type,
        column: op.column || null,
        status: 'error',
        error: err.message,
      });
    }
  }

  // Build cleaned dataset artifact
  const artifactPayload = {
    source_dataset_id: datasetId,
    original_row_count: beforeCount,
    cleaned_row_count: rows.length,
    columns: Object.keys(rows[0] || {}),
    operations_applied: audit.filter(a => a.status === 'applied').length,
    operations_failed: audit.filter(a => a.status === 'error').length,
    audit,
    sample_rows: rows.slice(0, 10),
  };

  let artifactId = null;
  try {
    artifactId = await saveJsonArtifact({
      type: 'cleaned_dataset',
      payload: artifactPayload,
      userId,
    });
  } catch {
    // Non-critical — continue without persistence
  }

  return {
    cleaned_rows: rows,
    row_count: rows.length,
    columns: Object.keys(rows[0] || {}),
    audit,
    artifact_id: artifactId,
  };
}

// ── Exports ─────────────────────────────────────────────────────────────────

export default {
  CLEANING_OPS,
  cleanDataset,
  suggestCleaningOps,
  computeColumnStats,
};
