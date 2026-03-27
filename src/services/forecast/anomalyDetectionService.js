// @product: data-analyst
//
// anomalyDetectionService.js
// ─────────────────────────────────────────────────────────────────────────────
// Anomaly detection service for general-purpose analysis.
// Operates on dataset profiles (uploaded CSV/Excel) and produces
// an anomaly_report artifact with detected outliers and summary statistics.
//
// Supports: z-score, IQR, isolation_forest (placeholder), time-series,
//           group-by detection.
// Works with ANY dataset — schema-agnostic.
// ─────────────────────────────────────────────────────────────────────────────

import { datasetProfilesService } from '../data-prep/datasetProfilesService';
import { saveJsonArtifact } from '../../utils/artifactStore';

// ── Helpers ─────────────────────────────────────────────────────────────────

const SUPPORTED_METHODS = ['zscore', 'iqr', 'isolation_forest'];

export function getNumericValues(rows, column) {
  return rows.map((r, i) => ({ index: i, raw: r[column], value: Number(r[column]) }))
    .filter(v => !isNaN(v.value));
}

export function computeStats(nums) {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  const mean = sum / sorted.length;
  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / sorted.length;
  const std = Math.sqrt(variance);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  return { mean, std, q1, q3, iqr, min: sorted[0], max: sorted[sorted.length - 1] };
}

/**
 * Detect anomalies in a single column using z-score method.
 * @param {Object[]} entries - Array of { index, value }
 * @param {number} threshold - Z-score threshold (default 3)
 * @returns {Object[]} Anomalies
 */
function detectZscore(entries, column, threshold = 3) {
  const values = entries.map(e => e.value);
  const stats = computeStats(values);
  if (!stats || stats.std === 0) return [];

  const anomalies = [];
  for (const entry of entries) {
    const z = Math.abs((entry.value - stats.mean) / stats.std);
    if (z > threshold) {
      anomalies.push({
        row_index: entry.index,
        column,
        value: entry.value,
        expected_range: [
          Math.round((stats.mean - threshold * stats.std) * 1000) / 1000,
          Math.round((stats.mean + threshold * stats.std) * 1000) / 1000,
        ],
        method: 'zscore',
        z_score: Math.round(z * 1000) / 1000,
      });
    }
  }
  return anomalies;
}

/**
 * Detect anomalies in a single column using IQR method.
 */
function detectIqr(entries, column) {
  const values = entries.map(e => e.value);
  const stats = computeStats(values);
  if (!stats || stats.iqr === 0) return [];

  const lower = stats.q1 - 1.5 * stats.iqr;
  const upper = stats.q3 + 1.5 * stats.iqr;

  const anomalies = [];
  for (const entry of entries) {
    if (entry.value < lower || entry.value > upper) {
      anomalies.push({
        row_index: entry.index,
        column,
        value: entry.value,
        expected_range: [Math.round(lower * 1000) / 1000, Math.round(upper * 1000) / 1000],
        method: 'iqr',
      });
    }
  }
  return anomalies;
}

/**
 * Detect time-series anomalies using rolling mean ± 3 std.
 * @param {Object[]} rows - Dataset rows
 * @param {string} column - Numeric column to check
 * @param {string} timeColumn - Time/date column for ordering
 * @returns {Object[]} Anomalies
 */
function detectTimeSeriesAnomalies(rows, column, timeColumn) {
  // Sort by time column
  const indexed = rows.map((r, i) => ({
    index: i,
    time: new Date(r[timeColumn]),
    value: Number(r[column]),
  })).filter(e => !isNaN(e.value) && !isNaN(e.time.getTime()));

  indexed.sort((a, b) => a.time - b.time);
  if (indexed.length < 5) return [];

  const windowSize = Math.max(3, Math.floor(indexed.length * 0.1));
  const anomalies = [];

  for (let i = windowSize; i < indexed.length; i++) {
    const window = indexed.slice(Math.max(0, i - windowSize), i);
    const windowValues = window.map(w => w.value);
    const stats = computeStats(windowValues);
    if (!stats || stats.std === 0) continue;

    const deviation = Math.abs(indexed[i].value - stats.mean);
    if (deviation > 3 * stats.std) {
      anomalies.push({
        row_index: indexed[i].index,
        column,
        value: indexed[i].value,
        expected_range: [
          Math.round((stats.mean - 3 * stats.std) * 1000) / 1000,
          Math.round((stats.mean + 3 * stats.std) * 1000) / 1000,
        ],
        method: 'time_series',
        rolling_mean: Math.round(stats.mean * 1000) / 1000,
        rolling_std: Math.round(stats.std * 1000) / 1000,
      });
    }
  }
  return anomalies;
}

// ── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Detect anomalies in a dataset.
 *
 * @param {Object} params
 * @param {string} params.datasetId - Dataset profile ID
 * @param {string[]} [params.columns] - Columns to analyze (default: all numeric)
 * @param {string} [params.method='iqr'] - Detection method: 'zscore', 'iqr', 'isolation_forest'
 * @param {string} [params.groupBy] - Column to group by for per-group detection
 * @param {string} [params.timeColumn] - Time column for time-series anomaly detection
 * @param {string} [params.userId]
 * @returns {Promise<{ anomalies, summary, artifact_id }>}
 */
export async function detectAnomalies({ datasetId, columns, method = 'iqr', groupBy, timeColumn, userId }) {
  if (!SUPPORTED_METHODS.includes(method)) {
    throw new Error(`不支援的偵測方法: ${method}。可用方法: ${SUPPORTED_METHODS.join(', ')}`);
  }

  // Load dataset
  const profile = datasetProfilesService.getById(datasetId);
  if (!profile) throw new Error(`Dataset profile not found: ${datasetId}`);

  const rawRows = profile.sheets?.[0]?.rows
    || profile.data?.rows
    || profile.rows
    || [];

  if (rawRows.length === 0) throw new Error('Dataset has no rows（資料集無資料列）');

  const allColumns = Object.keys(rawRows[0] || {});

  // Determine which columns to analyze (only numeric ones)
  const targetCols = (columns?.filter(c => allColumns.includes(c)) || allColumns)
    .filter(col => {
      const sample = rawRows.slice(0, 100).map(r => r[col]).filter(v => v != null && v !== '');
      const numCount = sample.filter(v => !isNaN(Number(v))).length;
      return numCount / Math.max(sample.length, 1) > 0.8;
    });

  if (targetCols.length === 0) {
    throw new Error('未找到可分析的數值欄位 (No numeric columns found)');
  }

  // Resolve detection function
  // isolation_forest placeholder: use zscore with lower threshold (2.5)
  const effectiveMethod = method === 'isolation_forest' ? 'zscore' : method;
  const zThreshold = method === 'isolation_forest' ? 2.5 : 3;

  let allAnomalies = [];

  // ── Time-series anomalies ───────────────────────────────────────────────

  if (timeColumn && allColumns.includes(timeColumn)) {
    for (const col of targetCols) {
      if (col === timeColumn) continue;
      if (groupBy && allColumns.includes(groupBy)) {
        // Per-group time-series detection
        const groups = groupRows(rawRows, groupBy);
        for (const [groupVal, groupRows_] of Object.entries(groups)) {
          const tsAnomalies = detectTimeSeriesAnomalies(groupRows_, col, timeColumn);
          allAnomalies.push(...tsAnomalies.map(a => ({ ...a, group: groupVal })));
        }
      } else {
        const tsAnomalies = detectTimeSeriesAnomalies(rawRows, col, timeColumn);
        allAnomalies.push(...tsAnomalies);
      }
    }
  }

  // ── Standard anomalies ────────────────────────────────────────────────

  if (groupBy && allColumns.includes(groupBy)) {
    const groups = groupRows(rawRows, groupBy);
    for (const [groupVal, groupRows_] of Object.entries(groups)) {
      for (const col of targetCols) {
        if (col === groupBy || col === timeColumn) continue;
        const entries = getNumericValues(groupRows_, col);
        const detected = effectiveMethod === 'zscore'
          ? detectZscore(entries, col, zThreshold)
          : detectIqr(entries, col);
        allAnomalies.push(...detected.map(a => ({ ...a, group: groupVal })));
      }
    }
  } else {
    for (const col of targetCols) {
      if (col === timeColumn) continue;
      const entries = getNumericValues(rawRows, col);
      const detected = effectiveMethod === 'zscore'
        ? detectZscore(entries, col, zThreshold)
        : detectIqr(entries, col);
      allAnomalies.push(...detected);
    }
  }

  // ── Build summary ─────────────────────────────────────────────────────

  const byColumn = {};
  const byMethod = {};
  for (const a of allAnomalies) {
    byColumn[a.column] = (byColumn[a.column] || 0) + 1;
    byMethod[a.method] = (byMethod[a.method] || 0) + 1;
  }

  const summary = {
    total_anomalies: allAnomalies.length,
    total_rows: rawRows.length,
    anomaly_rate: rawRows.length > 0
      ? Math.round((allAnomalies.length / rawRows.length) * 10000) / 100
      : 0,
    by_column: byColumn,
    by_method: byMethod,
    columns_analyzed: targetCols.length,
  };

  // Persist artifact
  let artifactId = null;
  try {
    artifactId = await saveJsonArtifact({
      type: 'anomaly_report',
      payload: {
        dataset_id: datasetId,
        method,
        group_by: groupBy || null,
        time_column: timeColumn || null,
        anomalies: allAnomalies.slice(0, 1000), // Cap at 1000 for artifact size
        summary,
      },
      userId,
    });
  } catch {
    // Non-critical — continue without persistence
  }

  return {
    anomalies: allAnomalies,
    summary,
    artifact_id: artifactId,
  };
}

/**
 * Group rows by a column value.
 * @param {Object[]} rows
 * @param {string} column
 * @returns {Object<string, Object[]>}
 */
function groupRows(rows, column) {
  const groups = {};
  for (const row of rows) {
    const key = String(row[column] ?? '(null)');
    if (!groups[key]) groups[key] = [];
    groups[key].push(row);
  }
  return groups;
}

// ── Exports ─────────────────────────────────────────────────────────────────

export default {
  detectAnomalies,
};
