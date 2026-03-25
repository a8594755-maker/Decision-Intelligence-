// @product: data-analyst
//
// datasetJoinService.js
// ─────────────────────────────────────────────────────────────────────────────
// Dataset join service for general-purpose analysis.
// Performs in-JS joins between two dataset profiles (no DuckDB dependency).
//
// Supports: inner, left, right, outer joins.
// Auto-detects join keys when not specified.
// Works with ANY dataset — schema-agnostic.
// ─────────────────────────────────────────────────────────────────────────────

import { datasetProfilesService } from './datasetProfilesService';
import { saveJsonArtifact } from '../../utils/artifactStore';

// ── Helpers ─────────────────────────────────────────────────────────────────

const SUPPORTED_JOIN_TYPES = ['inner', 'left', 'right', 'outer'];

/**
 * Extract rows from a dataset profile.
 * @param {Object} profile
 * @returns {Object[]}
 */
function extractRows(profile) {
  return profile.sheets?.[0]?.rows
    || profile.data?.rows
    || profile.rows
    || [];
}

/**
 * Auto-detect join keys by finding columns with matching names or high value overlap.
 * @param {Object[]} leftRows
 * @param {Object[]} rightRows
 * @returns {{ leftKey: string, rightKey: string, method: string } | null}
 */
function autoDetectKeys(leftRows, rightRows) {
  if (leftRows.length === 0 || rightRows.length === 0) return null;

  const leftCols = Object.keys(leftRows[0]);
  const rightCols = Object.keys(rightRows[0]);

  // Strategy 1: exact column name match
  const commonCols = leftCols.filter(c => rightCols.includes(c));
  if (commonCols.length > 0) {
    // Pick the column with highest unique value overlap
    let bestCol = null;
    let bestOverlap = 0;

    for (const col of commonCols) {
      const leftVals = new Set(leftRows.slice(0, 500).map(r => String(r[col] ?? '')).filter(v => v !== ''));
      const rightVals = new Set(rightRows.slice(0, 500).map(r => String(r[col] ?? '')).filter(v => v !== ''));
      const overlap = [...leftVals].filter(v => rightVals.has(v)).length;
      const overlapRate = overlap / Math.max(Math.min(leftVals.size, rightVals.size), 1);

      if (overlapRate > bestOverlap) {
        bestOverlap = overlapRate;
        bestCol = col;
      }
    }

    if (bestCol && bestOverlap > 0.1) {
      return { leftKey: bestCol, rightKey: bestCol, method: 'name_match', overlap_rate: bestOverlap };
    }
  }

  // Strategy 2: cross-column value overlap (different names, similar values)
  let bestPair = null;
  let bestOverlap = 0;

  for (const lc of leftCols.slice(0, 10)) {
    const leftVals = new Set(leftRows.slice(0, 500).map(r => String(r[lc] ?? '')).filter(v => v !== ''));
    if (leftVals.size < 2 || leftVals.size > leftRows.length * 0.95) continue; // Skip constants and near-unique

    for (const rc of rightCols.slice(0, 10)) {
      if (commonCols.includes(rc)) continue;
      const rightVals = new Set(rightRows.slice(0, 500).map(r => String(r[rc] ?? '')).filter(v => v !== ''));
      if (rightVals.size < 2) continue;

      const overlap = [...leftVals].filter(v => rightVals.has(v)).length;
      const overlapRate = overlap / Math.max(Math.min(leftVals.size, rightVals.size), 1);

      if (overlapRate > bestOverlap && overlapRate > 0.3) {
        bestOverlap = overlapRate;
        bestPair = { leftKey: lc, rightKey: rc, method: 'value_overlap', overlap_rate: overlapRate };
      }
    }
  }

  return bestPair;
}

/**
 * Build a lookup index for fast join matching.
 * @param {Object[]} rows
 * @param {string} key
 * @returns {Map<string, Object[]>}
 */
function buildIndex(rows, key) {
  const index = new Map();
  for (const row of rows) {
    const k = String(row[key] ?? '');
    if (!index.has(k)) index.set(k, []);
    index.get(k).push(row);
  }
  return index;
}

/**
 * Merge two row objects, prefixing conflicting columns.
 * @param {Object} left
 * @param {Object} right
 * @param {string[]} leftCols
 * @param {string[]} rightCols
 * @param {string} leftKey
 * @param {string} rightKey
 * @returns {Object}
 */
function mergeRows(left, right, leftCols, rightCols, leftKey, rightKey) {
  const result = {};

  // Copy left columns
  for (const col of leftCols) {
    result[col] = left ? left[col] : null;
  }

  // Copy right columns, prefix if conflict (except the join key)
  for (const col of rightCols) {
    if (col === rightKey && leftKey !== rightKey) {
      result[col] = right ? right[col] : null;
    } else if (leftCols.includes(col) && col !== leftKey) {
      result[`${col}_right`] = right ? right[col] : null;
    } else if (!leftCols.includes(col)) {
      result[col] = right ? right[col] : null;
    }
  }

  return result;
}

// ── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Join two datasets.
 *
 * @param {Object} params
 * @param {string} params.leftDatasetId - Left dataset profile ID
 * @param {string} params.rightDatasetId - Right dataset profile ID
 * @param {string} [params.joinType='inner'] - Join type: 'inner', 'left', 'right', 'outer'
 * @param {string} [params.leftKey] - Left join key column
 * @param {string} [params.rightKey] - Right join key column
 * @param {string} [params.userId]
 * @returns {Promise<{ joined_rows, row_count, left_count, right_count, join_type, match_rate, columns, artifact_id }>}
 */
export async function joinDatasets({ leftDatasetId, rightDatasetId, joinType = 'inner', leftKey, rightKey, userId }) {
  if (!SUPPORTED_JOIN_TYPES.includes(joinType)) {
    throw new Error(`不支援的 join 類型: ${joinType}。可用類型: ${SUPPORTED_JOIN_TYPES.join(', ')}`);
  }

  // Load datasets
  const leftProfile = datasetProfilesService.getById(leftDatasetId);
  if (!leftProfile) throw new Error(`Left dataset profile not found: ${leftDatasetId}`);

  const rightProfile = datasetProfilesService.getById(rightDatasetId);
  if (!rightProfile) throw new Error(`Right dataset profile not found: ${rightDatasetId}`);

  const leftRows = extractRows(leftProfile);
  const rightRows = extractRows(rightProfile);

  if (leftRows.length === 0) throw new Error('左側資料集無資料列 (Left dataset has no rows)');
  if (rightRows.length === 0) throw new Error('右側資料集無資料列 (Right dataset has no rows)');

  const leftCols = Object.keys(leftRows[0]);
  const rightCols = Object.keys(rightRows[0]);

  // Auto-detect keys if not specified
  let resolvedLeftKey = leftKey;
  let resolvedRightKey = rightKey;
  let keyDetection = null;

  if (!resolvedLeftKey || !resolvedRightKey) {
    keyDetection = autoDetectKeys(leftRows, rightRows);
    if (!keyDetection) {
      throw new Error('無法自動偵測 join key，請手動指定 leftKey 和 rightKey (Cannot auto-detect join keys)');
    }
    resolvedLeftKey = resolvedLeftKey || keyDetection.leftKey;
    resolvedRightKey = resolvedRightKey || keyDetection.rightKey;
  }

  // Validate keys exist
  if (!leftCols.includes(resolvedLeftKey)) {
    throw new Error(`左側資料集不包含欄位: ${resolvedLeftKey}`);
  }
  if (!rightCols.includes(resolvedRightKey)) {
    throw new Error(`右側資料集不包含欄位: ${resolvedRightKey}`);
  }

  // Build index on right side
  const rightIndex = buildIndex(rightRows, resolvedRightKey);
  const joinedRows = [];
  const matchedRightKeys = new Set();

  // ── Perform join ──────────────────────────────────────────────────────

  for (const leftRow of leftRows) {
    const key = String(leftRow[resolvedLeftKey] ?? '');
    const matches = rightIndex.get(key);

    if (matches && matches.length > 0) {
      matchedRightKeys.add(key);
      for (const rightRow of matches) {
        joinedRows.push(mergeRows(leftRow, rightRow, leftCols, rightCols, resolvedLeftKey, resolvedRightKey));
      }
    } else if (joinType === 'left' || joinType === 'outer') {
      joinedRows.push(mergeRows(leftRow, null, leftCols, rightCols, resolvedLeftKey, resolvedRightKey));
    }
    // inner: skip unmatched left rows
    // right: handled below
  }

  // For right and outer joins, add unmatched right rows
  if (joinType === 'right' || joinType === 'outer') {
    for (const rightRow of rightRows) {
      const key = String(rightRow[resolvedRightKey] ?? '');
      if (!matchedRightKeys.has(key)) {
        joinedRows.push(mergeRows(null, rightRow, leftCols, rightCols, resolvedLeftKey, resolvedRightKey));
      }
    }
  }

  // ── Compute match rate ────────────────────────────────────────────────

  const leftUniqueKeys = new Set(leftRows.map(r => String(r[resolvedLeftKey] ?? '')));
  const rightUniqueKeys = new Set(rightRows.map(r => String(r[resolvedRightKey] ?? '')));
  const matchedKeys = [...leftUniqueKeys].filter(k => rightUniqueKeys.has(k));
  const matchRate = Math.round(
    (matchedKeys.length / Math.max(Math.min(leftUniqueKeys.size, rightUniqueKeys.size), 1)) * 10000
  ) / 100;

  const resultColumns = joinedRows.length > 0 ? Object.keys(joinedRows[0]) : [...leftCols, ...rightCols];

  // ── Persist artifact ──────────────────────────────────────────────────

  const artifactPayload = {
    left_dataset_id: leftDatasetId,
    right_dataset_id: rightDatasetId,
    join_type: joinType,
    left_key: resolvedLeftKey,
    right_key: resolvedRightKey,
    key_detection: keyDetection,
    left_count: leftRows.length,
    right_count: rightRows.length,
    row_count: joinedRows.length,
    match_rate: matchRate,
    columns: resultColumns,
    sample_rows: joinedRows.slice(0, 20),
  };

  let artifactId = null;
  try {
    artifactId = await saveJsonArtifact({
      type: 'joined_dataset',
      payload: artifactPayload,
      userId,
    });
  } catch {
    // Non-critical — continue without persistence
  }

  return {
    joined_rows: joinedRows,
    row_count: joinedRows.length,
    left_count: leftRows.length,
    right_count: rightRows.length,
    join_type: joinType,
    left_key: resolvedLeftKey,
    right_key: resolvedRightKey,
    key_detection: keyDetection,
    match_rate: matchRate,
    columns: resultColumns,
    artifact_id: artifactId,
  };
}

// ── Exports ─────────────────────────────────────────────────────────────────

export default {
  joinDatasets,
};
