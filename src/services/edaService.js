// @product: data-analyst
//
// edaService.js
// ─────────────────────────────────────────────────────────────────────────────
// Exploratory Data Analysis (EDA) service for general-purpose analysis.
// Operates on dataset profiles (uploaded CSV/Excel) and produces
// an eda_report artifact with statistical summaries, distributions,
// correlations, and data quality indicators.
//
// Works with ANY dataset — schema-agnostic.
// ─────────────────────────────────────────────────────────────────────────────

import { datasetProfilesService } from './datasetProfilesService';
import { saveJsonArtifact } from '../utils/artifactStore';
import { computeColumnStats } from './dataCleaningService';

// ── Helpers ─────────────────────────────────────────────────────────────────

function inferColumnType(values) {
  if (values.length === 0) return 'empty';
  const sample = values.filter(v => v != null && v !== '').slice(0, 100);
  if (sample.length === 0) return 'empty';

  const numCount = sample.filter(v => !isNaN(Number(v))).length;
  if (numCount / sample.length > 0.8) return 'numeric';

  const dateCount = sample.filter(v => {
    const d = new Date(v);
    return !isNaN(d.getTime()) && String(v).length > 4;
  }).length;
  if (dateCount / sample.length > 0.7) return 'datetime';

  const uniqueRatio = new Set(sample.map(String)).size / sample.length;
  if (uniqueRatio < 0.05 && sample.length > 20) return 'categorical';

  return 'text';
}

function computeDistribution(values, bins = 20) {
  const nums = values.map(Number).filter(n => !isNaN(n));
  if (nums.length === 0) return null;

  nums.sort((a, b) => a - b);
  const min = nums[0];
  const max = nums[nums.length - 1];
  if (min === max) return { bins: [{ lower: min, upper: max, count: nums.length }] };

  const binWidth = (max - min) / bins;
  const histogram = Array.from({ length: bins }, (_, i) => ({
    lower: min + i * binWidth,
    upper: min + (i + 1) * binWidth,
    count: 0,
  }));

  for (const v of nums) {
    const idx = Math.min(Math.floor((v - min) / binWidth), bins - 1);
    histogram[idx].count++;
  }

  return { bins: histogram, binWidth };
}

function computeSkewness(values) {
  const nums = values.map(Number).filter(n => !isNaN(n));
  if (nums.length < 3) return null;

  const n = nums.length;
  const mean = nums.reduce((s, v) => s + v, 0) / n;
  const m2 = nums.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const m3 = nums.reduce((s, v) => s + (v - mean) ** 3, 0) / n;
  const std = Math.sqrt(m2);
  if (std === 0) return 0;

  return (n * m3) / ((n - 1) * (n - 2) * std ** 3) * n; // adjusted Fisher-Pearson
}

function computeKurtosis(values) {
  const nums = values.map(Number).filter(n => !isNaN(n));
  if (nums.length < 4) return null;

  const n = nums.length;
  const mean = nums.reduce((s, v) => s + v, 0) / n;
  const m2 = nums.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const m4 = nums.reduce((s, v) => s + (v - mean) ** 4, 0) / n;
  if (m2 === 0) return 0;

  return (m4 / (m2 ** 2)) - 3; // excess kurtosis
}

function computeCorrelationMatrix(rows, numericCols) {
  if (numericCols.length < 2) return null;
  // Limit to 20 columns for performance
  const cols = numericCols.slice(0, 20);
  const n = rows.length;

  // Extract numeric arrays
  const arrays = {};
  for (const col of cols) {
    arrays[col] = rows.map(r => Number(r[col])).map(v => isNaN(v) ? null : v);
  }

  // Compute means
  const means = {};
  for (const col of cols) {
    const valid = arrays[col].filter(v => v !== null);
    means[col] = valid.length > 0 ? valid.reduce((s, v) => s + v, 0) / valid.length : 0;
  }

  // Compute correlation coefficients
  const matrix = {};
  for (const c1 of cols) {
    matrix[c1] = {};
    for (const c2 of cols) {
      if (c1 === c2) { matrix[c1][c2] = 1; continue; }
      if (matrix[c2]?.[c1] != null) { matrix[c1][c2] = matrix[c2][c1]; continue; }

      let sumXY = 0, sumX2 = 0, sumY2 = 0, count = 0;
      for (let i = 0; i < n; i++) {
        const x = arrays[c1][i];
        const y = arrays[c2][i];
        if (x === null || y === null) continue;
        const dx = x - means[c1];
        const dy = y - means[c2];
        sumXY += dx * dy;
        sumX2 += dx * dx;
        sumY2 += dy * dy;
        count++;
      }

      const denom = Math.sqrt(sumX2 * sumY2);
      matrix[c1][c2] = denom > 0 ? sumXY / denom : 0;
    }
  }

  return { columns: cols, values: matrix };
}

function computeValueCounts(values, maxCategories = 20) {
  const freq = {};
  for (const v of values) {
    const key = String(v ?? '(null)');
    freq[key] = (freq[key] || 0) + 1;
  }
  const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
  return {
    categories: sorted.slice(0, maxCategories).map(([value, count]) => ({ value, count })),
    total_unique: sorted.length,
    truncated: sorted.length > maxCategories,
  };
}

function computeMissingValueSummary(rows, columns) {
  const summary = {};
  for (const col of columns) {
    const nullCount = rows.filter(r => r[col] == null || r[col] === '').length;
    summary[col] = {
      missing: nullCount,
      present: rows.length - nullCount,
      missing_pct: rows.length > 0 ? (nullCount / rows.length * 100) : 0,
    };
  }
  return summary;
}

// ── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Run exploratory data analysis on a dataset.
 *
 * @param {Object} params
 * @param {string} params.datasetId - Dataset profile ID
 * @param {string[]} [params.columns] - Specific columns to analyze (default: all)
 * @param {number} [params.sampleSize] - Max rows to analyze (default: 10000)
 * @param {string} [params.userId]
 * @returns {Promise<Object>} EDA report
 */
export async function runExploratoryAnalysis({ datasetId, columns, sampleSize = 10000, userId }) {
  // Load dataset
  const profile = datasetProfilesService.getById(datasetId);
  if (!profile) throw new Error(`Dataset profile not found: ${datasetId}`);

  const rawRows = profile.sheets?.[0]?.rows
    || profile.data?.rows
    || profile.rows
    || [];

  if (rawRows.length === 0) throw new Error('Dataset has no rows');

  // Sample if needed
  const rows = rawRows.length > sampleSize
    ? rawRows.slice(0, sampleSize)
    : rawRows;

  const allColumns = Object.keys(rows[0] || {});
  const targetCols = columns?.filter(c => allColumns.includes(c)) || allColumns;

  // ── Per-column analysis ─────────────────────────────────────────────────

  const columnAnalysis = {};
  const numericCols = [];
  const categoricalCols = [];
  const datetimeCols = [];

  for (const col of targetCols) {
    const values = rows.map(r => r[col]);
    const colType = inferColumnType(values);
    const stats = computeColumnStats(rows, col);

    const analysis = {
      name: col,
      inferred_type: colType,
      count: stats.count,
      null_count: stats.nullCount,
      null_pct: rows.length > 0 ? (stats.nullCount / rows.length * 100) : 0,
      unique_count: new Set(values.filter(v => v != null && v !== '').map(String)).size,
    };

    if (colType === 'numeric') {
      numericCols.push(col);
      Object.assign(analysis, {
        mean: stats.mean,
        median: stats.median,
        std: stats.std,
        min: stats.min,
        max: stats.max,
        q1: stats.q1,
        q3: stats.q3,
        iqr: stats.iqr,
        skewness: computeSkewness(values),
        kurtosis: computeKurtosis(values),
        distribution: computeDistribution(values),
      });
    } else if (colType === 'categorical' || colType === 'text') {
      categoricalCols.push(col);
      analysis.value_counts = computeValueCounts(values);
    } else if (colType === 'datetime') {
      datetimeCols.push(col);
      const dates = values.filter(v => v != null && v !== '').map(v => new Date(v)).filter(d => !isNaN(d.getTime()));
      if (dates.length > 0) {
        dates.sort((a, b) => a - b);
        analysis.date_range = {
          min: dates[0].toISOString(),
          max: dates[dates.length - 1].toISOString(),
          span_days: Math.round((dates[dates.length - 1] - dates[0]) / (1000 * 60 * 60 * 24)),
        };
      }
    }

    columnAnalysis[col] = analysis;
  }

  // ── Cross-column analysis ───────────────────────────────────────────────

  const correlation = computeCorrelationMatrix(rows, numericCols);

  // Find top correlations (absolute value > 0.5, excluding self-correlation)
  const topCorrelations = [];
  if (correlation) {
    for (let i = 0; i < correlation.columns.length; i++) {
      for (let j = i + 1; j < correlation.columns.length; j++) {
        const c1 = correlation.columns[i];
        const c2 = correlation.columns[j];
        const r = correlation.values[c1][c2];
        if (Math.abs(r) > 0.5) {
          topCorrelations.push({ col1: c1, col2: c2, correlation: Math.round(r * 1000) / 1000 });
        }
      }
    }
    topCorrelations.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
  }

  // ── Missing value analysis ──────────────────────────────────────────────

  const missingValues = computeMissingValueSummary(rows, targetCols);
  const totalMissing = Object.values(missingValues).reduce((s, v) => s + v.missing, 0);
  const totalCells = rows.length * targetCols.length;

  // ── Data quality score ──────────────────────────────────────────────────

  const completeness = totalCells > 0 ? (1 - totalMissing / totalCells) * 100 : 100;
  const duplicateCheck = (() => {
    const seen = new Set();
    let dupes = 0;
    for (const r of rows) {
      const key = targetCols.map(c => String(r[c] ?? '')).join('|');
      if (seen.has(key)) dupes++;
      seen.add(key);
    }
    return { duplicates: dupes, uniqueness: rows.length > 0 ? ((rows.length - dupes) / rows.length * 100) : 100 };
  })();

  const qualityScore = Math.round(
    completeness * 0.5 + duplicateCheck.uniqueness * 0.3 + (numericCols.length > 0 ? 20 : 10)
  );

  // ── Build report ────────────────────────────────────────────────────────

  const report = {
    dataset_id: datasetId,
    row_count: rows.length,
    total_rows: rawRows.length,
    sampled: rawRows.length > sampleSize,
    column_count: targetCols.length,
    column_types: {
      numeric: numericCols,
      categorical: categoricalCols,
      datetime: datetimeCols,
      other: targetCols.filter(c => !numericCols.includes(c) && !categoricalCols.includes(c) && !datetimeCols.includes(c)),
    },
    columns: columnAnalysis,
    correlation,
    top_correlations: topCorrelations.slice(0, 10),
    missing_values: missingValues,
    data_quality: {
      completeness: Math.round(completeness * 10) / 10,
      uniqueness: Math.round(duplicateCheck.uniqueness * 10) / 10,
      duplicates: duplicateCheck.duplicates,
      quality_score: Math.min(qualityScore, 100),
    },
    highlights: buildHighlights(columnAnalysis, topCorrelations, missingValues, rows.length),
  };

  // Persist artifact
  let artifactId = null;
  try {
    artifactId = await saveJsonArtifact({
      type: 'eda_report',
      payload: report,
      userId,
    });
  } catch {
    // Non-critical
  }

  return { ...report, artifact_id: artifactId };
}

// ── Highlight Generation ────────────────────────────────────────────────────

function buildHighlights(columnAnalysis, topCorrelations, missingValues, rowCount) {
  const highlights = [];

  // High missing value columns
  for (const [col, info] of Object.entries(missingValues)) {
    if (info.missing_pct > 20) {
      highlights.push({
        type: 'warning',
        category: 'missing_data',
        message: `${col} 有 ${info.missing_pct.toFixed(1)}% 的缺失值`,
        column: col,
      });
    }
  }

  // Highly skewed columns
  for (const [col, info] of Object.entries(columnAnalysis)) {
    if (info.skewness != null && Math.abs(info.skewness) > 2) {
      highlights.push({
        type: 'info',
        category: 'distribution',
        message: `${col} 呈現${info.skewness > 0 ? '正' : '負'}偏態分布 (skew = ${info.skewness.toFixed(2)})`,
        column: col,
      });
    }
  }

  // Strong correlations
  for (const corr of topCorrelations.slice(0, 3)) {
    if (Math.abs(corr.correlation) > 0.8) {
      highlights.push({
        type: 'insight',
        category: 'correlation',
        message: `${corr.col1} 與 ${corr.col2} 高度${corr.correlation > 0 ? '正' : '負'}相關 (r = ${corr.correlation})`,
      });
    }
  }

  // Potential categorical columns with high cardinality
  for (const [col, info] of Object.entries(columnAnalysis)) {
    if (info.inferred_type === 'text' && info.unique_count > rowCount * 0.9 && rowCount > 10) {
      highlights.push({
        type: 'info',
        category: 'cardinality',
        message: `${col} 幾乎每列都是唯一值 (${info.unique_count} unique / ${rowCount} rows)，可能是 ID 欄位`,
        column: col,
      });
    }
  }

  return highlights;
}

// ── Exports ─────────────────────────────────────────────────────────────────

export default {
  runExploratoryAnalysis,
  inferColumnType,
  computeCorrelationMatrix,
};
