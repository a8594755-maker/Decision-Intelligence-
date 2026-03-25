// @product: data-analyst
//
// autoInsightService.js
// ─────────────────────────────────────────────────────────────────────────────
// Auto Insight Discovery service for general-purpose analysis.
// Scans dataset profiles (uploaded CSV/Excel) and automatically discovers
// statistically interesting patterns: trends, skewness, concentration,
// cross-group differences, correlations, and outliers.
//
// Works with ANY dataset — schema-agnostic.
// ─────────────────────────────────────────────────────────────────────────────

import { datasetProfilesService } from '../data-prep/datasetProfilesService';
import { saveJsonArtifact } from '../../utils/artifactStore';

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract numeric values from a column, filtering nulls and non-numerics.
 * @param {Object[]} rows
 * @param {string} col
 * @returns {number[]}
 */
function extractNumerics(rows, col) {
  return rows
    .map(r => Number(r[col]))
    .filter(n => !isNaN(n));
}

/**
 * Infer whether a column is numeric (>80% parseable as number).
 * @param {Object[]} rows
 * @param {string} col
 * @returns {boolean}
 */
function isNumericColumn(rows, col) {
  const sample = rows.slice(0, 200);
  const valid = sample.filter(r => r[col] != null && r[col] !== '');
  if (valid.length === 0) return false;
  const numCount = valid.filter(r => !isNaN(Number(r[col]))).length;
  return numCount / valid.length > 0.8;
}

/**
 * Infer whether a column is categorical (low unique ratio, non-numeric).
 * @param {Object[]} rows
 * @param {string} col
 * @returns {boolean}
 */
function isCategoricalColumn(rows, col) {
  if (isNumericColumn(rows, col)) return false;
  const values = rows.map(r => r[col]).filter(v => v != null && v !== '');
  if (values.length === 0) return false;
  const uniqueRatio = new Set(values.map(String)).size / values.length;
  return uniqueRatio < 0.3 && new Set(values.map(String)).size >= 2;
}

function mean(arr) {
  return arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

// ── Insight Detectors ───────────────────────────────────────────────────────

/**
 * Detect significant slope changes in time-ordered numeric data.
 * Splits data into two halves, compares linear slopes.
 */
function detectTrendChange(nums, col) {
  if (nums.length < 10) return null;

  const mid = Math.floor(nums.length / 2);
  const firstHalf = nums.slice(0, mid);
  const secondHalf = nums.slice(mid);

  // Simple slope: (last - first) / length
  const slope1 = (firstHalf[firstHalf.length - 1] - firstHalf[0]) / firstHalf.length;
  const slope2 = (secondHalf[secondHalf.length - 1] - secondHalf[0]) / secondHalf.length;

  const overallStd = std(nums);
  if (overallStd === 0) return null;

  const slopeDiff = Math.abs(slope2 - slope1);
  const normalizedDiff = slopeDiff / overallStd;

  if (normalizedDiff < 0.1) return null;

  // Score: capped normalized difference
  const score = Math.min(normalizedDiff / 2, 1) * 0.8 + (nums.length > 50 ? 0.2 : nums.length / 250);

  const direction = slope2 > slope1 ? '加速上升' : '趨勢反轉';

  return {
    type: 'trend_change',
    score: Math.min(Math.round(score * 1000) / 1000, 1),
    title: `${col} 趨勢變化 — ${direction}`,
    description: `${col} 在資料中段出現顯著趨勢變化：前半段斜率=${slope1.toFixed(4)}，後半段斜率=${slope2.toFixed(4)}`,
    columns: [col],
    evidence: {
      slope_first_half: Math.round(slope1 * 10000) / 10000,
      slope_second_half: Math.round(slope2 * 10000) / 10000,
      slope_diff: Math.round(slopeDiff * 10000) / 10000,
      normalized_diff: Math.round(normalizedDiff * 1000) / 1000,
      data_points: nums.length,
    },
  };
}

/**
 * Detect columns with |skewness| > 2.
 */
function detectSkewedDistribution(nums, col) {
  if (nums.length < 10) return null;

  const n = nums.length;
  const m = mean(nums);
  const m2 = nums.reduce((s, v) => s + (v - m) ** 2, 0) / n;
  const m3 = nums.reduce((s, v) => s + (v - m) ** 3, 0) / n;
  const s = Math.sqrt(m2);
  if (s === 0) return 0;

  const skew = (n * m3) / ((n - 1) * (n - 2) * s ** 3) * n;

  if (Math.abs(skew) <= 2) return null;

  const direction = skew > 0 ? '右偏' : '左偏';
  // Score based on |skew| magnitude and data size
  const score = Math.min(Math.abs(skew) / 10, 0.8) + (n > 100 ? 0.2 : n / 500);

  return {
    type: 'skewed_distribution',
    score: Math.min(Math.round(score * 1000) / 1000, 1),
    title: `${col} 高度${direction} (skew=${skew.toFixed(2)})`,
    description: `${col} 的分布呈現高度${direction}態 (skewness=${skew.toFixed(2)})，代表資料集中於${skew > 0 ? '低值' : '高值'}端`,
    columns: [col],
    evidence: {
      skewness: Math.round(skew * 100) / 100,
      mean: Math.round(m * 100) / 100,
      std: Math.round(s * 100) / 100,
      n,
    },
  };
}

/**
 * Compute Gini coefficient, flag if > 0.6 (top 20% holds 80%+ of value).
 */
function detectConcentration(nums, col) {
  if (nums.length < 10) return null;

  // Gini only meaningful for non-negative values
  const positive = nums.filter(v => v >= 0);
  if (positive.length < 10) return null;

  positive.sort((a, b) => a - b);
  const n = positive.length;
  const totalSum = positive.reduce((s, v) => s + v, 0);
  if (totalSum === 0) return null;

  // Gini = (2 * sum(i * x_i)) / (n * sum(x_i)) - (n + 1) / n
  let weightedSum = 0;
  for (let i = 0; i < n; i++) {
    weightedSum += (i + 1) * positive[i];
  }
  const gini = (2 * weightedSum) / (n * totalSum) - (n + 1) / n;

  if (gini <= 0.6) return null;

  // Top 20% share
  const top20Start = Math.floor(n * 0.8);
  const top20Sum = positive.slice(top20Start).reduce((s, v) => s + v, 0);
  const top20Share = top20Sum / totalSum;

  const score = Math.min((gini - 0.4) / 0.6, 0.85) + (n > 100 ? 0.15 : n / 666);

  return {
    type: 'concentration',
    score: Math.min(Math.round(score * 1000) / 1000, 1),
    title: `${col} 高度集中 (Gini=${gini.toFixed(3)})`,
    description: `${col} 分布高度集中：前 20% 的資料佔總值的 ${(top20Share * 100).toFixed(1)}% (Gini=${gini.toFixed(3)})`,
    columns: [col],
    evidence: {
      gini: Math.round(gini * 1000) / 1000,
      top20_share: Math.round(top20Share * 1000) / 1000,
      n: positive.length,
      total_sum: Math.round(totalSum * 100) / 100,
    },
  };
}

/**
 * For each category x numeric pair, compare group means vs overall.
 * Flag if any group deviates > 2 std.
 */
function detectCrossGroupDifference(rows, catCol, numCol) {
  const groups = {};
  for (const row of rows) {
    const cat = row[catCol];
    const num = Number(row[numCol]);
    if (cat == null || cat === '' || isNaN(num)) continue;
    const key = String(cat);
    if (!groups[key]) groups[key] = [];
    groups[key].push(num);
  }

  const groupKeys = Object.keys(groups);
  if (groupKeys.length < 2 || groupKeys.length > 50) return null;

  const allValues = groupKeys.flatMap(k => groups[k]);
  if (allValues.length < 10) return null;

  const overallMean = mean(allValues);
  const overallStd = std(allValues);
  if (overallStd === 0) return null;

  // Find most deviating group
  let maxDeviation = 0;
  let maxGroup = null;
  let maxGroupMean = 0;
  const groupStats = {};

  for (const key of groupKeys) {
    const gMean = mean(groups[key]);
    const deviation = Math.abs(gMean - overallMean) / overallStd;
    groupStats[key] = {
      mean: Math.round(gMean * 100) / 100,
      count: groups[key].length,
      deviation: Math.round(deviation * 100) / 100,
    };
    if (deviation > maxDeviation) {
      maxDeviation = deviation;
      maxGroup = key;
      maxGroupMean = gMean;
    }
  }

  if (maxDeviation <= 2) return null;

  const direction = maxGroupMean > overallMean ? '高於' : '低於';
  const score = Math.min(maxDeviation / 6, 0.75) +
    (allValues.length > 100 ? 0.15 : allValues.length / 666) +
    (groupKeys.length >= 3 ? 0.1 : 0.05);

  return {
    type: 'cross_group_difference',
    score: Math.min(Math.round(score * 1000) / 1000, 1),
    title: `${catCol}="${maxGroup}" 的 ${numCol} 顯著${direction}平均`,
    description: `以 ${catCol} 分組後，"${maxGroup}" 群組的 ${numCol} 平均值 (${maxGroupMean.toFixed(2)}) 顯著${direction}整體平均 (${overallMean.toFixed(2)})，偏差 ${maxDeviation.toFixed(1)} 倍標準差`,
    columns: [catCol, numCol],
    evidence: {
      overall_mean: Math.round(overallMean * 100) / 100,
      overall_std: Math.round(overallStd * 100) / 100,
      max_deviation_group: maxGroup,
      max_deviation: Math.round(maxDeviation * 100) / 100,
      group_count: groupKeys.length,
      group_stats: groupStats,
    },
  };
}

/**
 * For each numeric pair, compute Pearson r; flag if |r| > 0.7.
 */
function detectStrongCorrelation(rows, col1, col2) {
  let sumXY = 0, sumX2 = 0, sumY2 = 0, count = 0;
  const vals1 = [];
  const vals2 = [];

  for (const row of rows) {
    const x = Number(row[col1]);
    const y = Number(row[col2]);
    if (isNaN(x) || isNaN(y)) continue;
    vals1.push(x);
    vals2.push(y);
  }

  if (vals1.length < 10) return null;

  const m1 = mean(vals1);
  const m2 = mean(vals2);

  for (let i = 0; i < vals1.length; i++) {
    const dx = vals1[i] - m1;
    const dy = vals2[i] - m2;
    sumXY += dx * dy;
    sumX2 += dx * dx;
    sumY2 += dy * dy;
    count++;
  }

  const denom = Math.sqrt(sumX2 * sumY2);
  if (denom === 0) return null;

  const r = sumXY / denom;

  if (Math.abs(r) <= 0.7) return null;

  const direction = r > 0 ? '正' : '負';
  const score = (Math.abs(r) - 0.5) / 0.5 * 0.75 + (count > 100 ? 0.25 : count / 400);

  return {
    type: 'strong_correlation',
    score: Math.min(Math.round(score * 1000) / 1000, 1),
    title: `${col1} 與 ${col2} 高度${direction}相關 (r=${r.toFixed(3)})`,
    description: `${col1} 與 ${col2} 之間存在強${direction}相關性 (Pearson r=${r.toFixed(3)}，N=${count})`,
    columns: [col1, col2],
    evidence: {
      pearson_r: Math.round(r * 1000) / 1000,
      r_squared: Math.round(r * r * 1000) / 1000,
      n: count,
    },
  };
}

/**
 * Detect values > 3 std from mean.
 */
function detectUnusualValues(nums, col, rows) {
  if (nums.length < 10) return null;

  const m = mean(nums);
  const s = std(nums);
  if (s === 0) return null;

  const threshold = 3;
  const unusual = [];

  for (let i = 0; i < rows.length; i++) {
    const v = Number(rows[i][col]);
    if (isNaN(v)) continue;
    const zScore = Math.abs(v - m) / s;
    if (zScore > threshold) {
      unusual.push({ index: i, value: v, z_score: Math.round(zScore * 100) / 100 });
    }
  }

  if (unusual.length === 0) return null;

  const coverage = unusual.length / nums.length;
  // Rare outliers are more interesting; too many = distribution issue
  const rarityBonus = coverage < 0.01 ? 0.3 : coverage < 0.05 ? 0.15 : 0;
  const effectSize = Math.min(
    mean(unusual.map(u => u.z_score)) / 6,
    0.5
  );
  const score = effectSize + rarityBonus + (nums.length > 100 ? 0.2 : nums.length / 500);

  // Keep top 5 most extreme
  unusual.sort((a, b) => b.z_score - a.z_score);
  const topUnusual = unusual.slice(0, 5);

  return {
    type: 'unusual_value',
    score: Math.min(Math.round(score * 1000) / 1000, 1),
    title: `${col} 含 ${unusual.length} 個異常值 (>3σ)`,
    description: `${col} 中發現 ${unusual.length} 個超過 3 倍標準差的異常值 (mean=${m.toFixed(2)}, std=${s.toFixed(2)})`,
    columns: [col],
    evidence: {
      mean: Math.round(m * 100) / 100,
      std: Math.round(s * 100) / 100,
      threshold_sigma: threshold,
      unusual_count: unusual.length,
      unusual_pct: Math.round(coverage * 10000) / 100,
      top_unusual: topUnusual,
    },
  };
}

// ── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Automatically discover insights from a dataset.
 *
 * Scans all numeric columns and detects: trend changes, skewed distributions,
 * concentration (Gini), cross-group differences, strong correlations, and
 * unusual values. Results are scored by interestingness and sorted descending.
 *
 * @param {Object} params
 * @param {string} params.datasetId - Dataset profile ID
 * @param {number} [params.maxInsights=10] - Maximum insights to return
 * @param {string[]} [params.focusColumns] - Specific columns to prioritize (default: all)
 * @param {string} [params.userId]
 * @returns {Promise<{ insights: Object[], dataset_id: string, column_count: number, row_count: number, artifact_id: string|null }>}
 */
export async function discoverInsights({ datasetId, maxInsights = 10, focusColumns, userId }) {
  // Load dataset
  const profile = datasetProfilesService.getById(datasetId);
  if (!profile) throw new Error(`Dataset profile not found: ${datasetId}`);

  const rawRows = profile.sheets?.[0]?.rows
    || profile.data?.rows
    || profile.rows
    || [];

  if (rawRows.length === 0) throw new Error('Dataset has no rows');

  const rows = rawRows;
  const allColumns = Object.keys(rows[0] || {});

  // Identify column types
  const numericCols = allColumns.filter(c => isNumericColumn(rows, c));
  const categoricalCols = allColumns.filter(c => isCategoricalColumn(rows, c));

  // If focusColumns provided, prioritize them but still scan others
  const priorityCols = focusColumns?.filter(c => allColumns.includes(c)) || [];
  const sortedNumericCols = [
    ...priorityCols.filter(c => numericCols.includes(c)),
    ...numericCols.filter(c => !priorityCols.includes(c)),
  ];

  const insights = [];

  // ── Per-column scans ────────────────────────────────────────────────────

  for (const col of sortedNumericCols) {
    const nums = extractNumerics(rows, col);
    if (nums.length < 10) continue;

    // Trend change
    const trend = detectTrendChange(nums, col);
    if (trend) insights.push(trend);

    // Skewed distribution
    const skew = detectSkewedDistribution(nums, col);
    if (skew) insights.push(skew);

    // Concentration (Gini)
    const conc = detectConcentration(nums, col);
    if (conc) insights.push(conc);

    // Unusual values
    const unusual = detectUnusualValues(nums, col, rows);
    if (unusual) insights.push(unusual);
  }

  // ── Cross-column scans ──────────────────────────────────────────────────

  // Strong correlations (limit pairs for performance)
  const corrCols = sortedNumericCols.slice(0, 20);
  for (let i = 0; i < corrCols.length; i++) {
    for (let j = i + 1; j < corrCols.length; j++) {
      const corr = detectStrongCorrelation(rows, corrCols[i], corrCols[j]);
      if (corr) insights.push(corr);
    }
  }

  // Cross-group differences (category x numeric)
  const catLimit = categoricalCols.slice(0, 10);
  const numLimit = sortedNumericCols.slice(0, 10);
  for (const catCol of catLimit) {
    for (const numCol of numLimit) {
      const diff = detectCrossGroupDifference(rows, catCol, numCol);
      if (diff) insights.push(diff);
    }
  }

  // ── Boost focus columns ─────────────────────────────────────────────────

  if (priorityCols.length > 0) {
    for (const insight of insights) {
      const hasFocus = insight.columns.some(c => priorityCols.includes(c));
      if (hasFocus) {
        insight.score = Math.min(insight.score * 1.15, 1);
        insight.score = Math.round(insight.score * 1000) / 1000;
      }
    }
  }

  // ── Sort and trim ───────────────────────────────────────────────────────

  insights.sort((a, b) => b.score - a.score);
  const topInsights = insights.slice(0, maxInsights);

  // ── Persist artifact ────────────────────────────────────────────────────

  const payload = {
    dataset_id: datasetId,
    row_count: rows.length,
    column_count: allColumns.length,
    numeric_columns: numericCols,
    categorical_columns: categoricalCols,
    total_insights_found: insights.length,
    insights_returned: topInsights.length,
    insights: topInsights,
  };

  let artifactId = null;
  try {
    artifactId = await saveJsonArtifact({
      type: 'auto_insights',
      payload,
      userId,
    });
  } catch {
    // Non-critical
  }

  return {
    insights: topInsights,
    dataset_id: datasetId,
    column_count: allColumns.length,
    row_count: rows.length,
    artifact_id: artifactId,
  };
}

// ── Exports ─────────────────────────────────────────────────────────────────

export default {
  discoverInsights,
};
