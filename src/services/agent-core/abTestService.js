// @product: data-analyst
//
// abTestService.js
// ─────────────────────────────────────────────────────────────────────────────
// A/B test (experiment) analysis service for general-purpose analysis.
// Operates on dataset profiles (uploaded CSV/Excel) and produces
// an ab_test_report artifact with statistical test results.
//
// Supports: Welch's t-test, Cohen's d effect size, confidence intervals.
// Works with ANY dataset — schema-agnostic.
// ─────────────────────────────────────────────────────────────────────────────

import { datasetProfilesService } from '../data-prep/datasetProfilesService';
import { saveJsonArtifact } from '../../utils/artifactStore';

// ── Statistical Helpers ─────────────────────────────────────────────────────

/**
 * Compute basic statistics for an array of numbers.
 * @param {number[]} values
 * @returns {{ n, mean, std, variance, min, max }}
 */
function computeGroupStats(values) {
  const n = values.length;
  if (n === 0) return { n: 0, mean: 0, std: 0, variance: 0, min: 0, max: 0 };

  const sum = values.reduce((s, v) => s + v, 0);
  const mean = sum / n;

  // Sample variance (n-1)
  const variance = n > 1
    ? values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)
    : 0;
  const std = Math.sqrt(variance);

  const sorted = [...values].sort((a, b) => a - b);

  return { n, mean, std, variance, min: sorted[0], max: sorted[n - 1] };
}

/**
 * Approximate the two-tailed p-value from a t-statistic using
 * the normal approximation (valid for df > 30; reasonable for smaller df).
 *
 * Uses the rational approximation of the cumulative normal distribution
 * (Abramowitz & Stegun 26.2.17).
 *
 * @param {number} t - t-statistic (absolute value used)
 * @param {number} df - degrees of freedom
 * @returns {number} two-tailed p-value
 */
function tTestPValue(t, df) {
  // For very large df, t ≈ z
  // For smaller df, apply a continuity correction: z = t * (1 - 1/(4*df))
  const absT = Math.abs(t);
  const z = df > 100 ? absT : absT * (1 - 1 / (4 * df));

  // Standard normal CDF approximation (Abramowitz & Stegun)
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const x = z / Math.sqrt(2);
  const t_ = 1 / (1 + p * Math.abs(x));
  const erf = 1 - (a1 * t_ + a2 * t_ ** 2 + a3 * t_ ** 3 + a4 * t_ ** 4 + a5 * t_ ** 5) * Math.exp(-x * x);

  const cdf = 0.5 * (1 + (x >= 0 ? erf : -erf));
  const pValue = 2 * (1 - cdf);

  return Math.max(0, Math.min(1, pValue));
}

/**
 * Compute Welch's degrees of freedom.
 * df = (s1²/n1 + s2²/n2)² / ( (s1²/n1)²/(n1-1) + (s2²/n2)²/(n2-1) )
 */
function welchDf(s1, n1, s2, n2) {
  const v1 = (s1 ** 2) / n1;
  const v2 = (s2 ** 2) / n2;
  const numerator = (v1 + v2) ** 2;
  const denominator = (v1 ** 2) / (n1 - 1) + (v2 ** 2) / (n2 - 1);
  return denominator > 0 ? numerator / denominator : n1 + n2 - 2;
}

/**
 * Get the approximate t critical value for a given alpha and df.
 * Uses the normal approximation for simplicity.
 */
function tCritical(alpha, df) {
  // For two-tailed, we need z_{alpha/2}
  // Using common lookup for typical alpha values, fallback to z-approximation
  const halfAlpha = alpha / 2;

  // Inverse normal approximation (Beasley-Springer-Moro algorithm, simplified)
  // For common values:
  if (Math.abs(halfAlpha - 0.025) < 0.001) return 1.96;
  if (Math.abs(halfAlpha - 0.005) < 0.001) return 2.576;
  if (Math.abs(halfAlpha - 0.05) < 0.001) return 1.645;
  if (Math.abs(halfAlpha - 0.005) < 0.0001) return 2.576;

  // Generic approximation using rational formula
  const p = halfAlpha;
  const t_ = Math.sqrt(-2 * Math.log(p));
  const c0 = 2.515517, c1 = 0.802853, c2 = 0.010328;
  const d1 = 1.432788, d2 = 0.189269, d3 = 0.001308;
  return t_ - (c0 + c1 * t_ + c2 * t_ ** 2) / (1 + d1 * t_ + d2 * t_ ** 2 + d3 * t_ ** 3);
}

// ── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Analyze an A/B test experiment.
 *
 * @param {Object} params
 * @param {string} params.datasetId - Dataset profile ID
 * @param {string} params.treatmentColumn - Column identifying control/treatment groups
 * @param {string} params.metricColumn - Numeric metric column to compare
 * @param {string} [params.controlValue] - Value in treatmentColumn for control group
 * @param {string} [params.treatmentValue] - Value in treatmentColumn for treatment group
 * @param {number} [params.alpha=0.05] - Significance level
 * @param {string} [params.userId]
 * @returns {Promise<{ control, treatment, test, recommendation, artifact_id }>}
 */
export async function analyzeExperiment({
  datasetId,
  treatmentColumn,
  metricColumn,
  controlValue,
  treatmentValue,
  alpha = 0.05,
  userId,
}) {
  // Load dataset
  const profile = datasetProfilesService.getById(datasetId);
  if (!profile) throw new Error(`Dataset profile not found: ${datasetId}`);

  const rawRows = profile.sheets?.[0]?.rows
    || profile.data?.rows
    || profile.rows
    || [];

  if (rawRows.length === 0) throw new Error('Dataset has no rows（資料集無資料列）');

  // Validate columns exist
  const allColumns = Object.keys(rawRows[0] || {});
  if (!allColumns.includes(treatmentColumn)) {
    throw new Error(`找不到分組欄位: ${treatmentColumn}`);
  }
  if (!allColumns.includes(metricColumn)) {
    throw new Error(`找不到指標欄位: ${metricColumn}`);
  }

  // Detect group values if not specified
  const uniqueGroups = [...new Set(rawRows.map(r => r[treatmentColumn]).filter(v => v != null && v !== ''))];

  if (uniqueGroups.length < 2) {
    throw new Error(`分組欄位 "${treatmentColumn}" 至少需要兩個不同值，目前只有: ${uniqueGroups.join(', ')}`);
  }

  const ctrlVal = controlValue ?? uniqueGroups[0];
  const treatVal = treatmentValue ?? uniqueGroups[1];

  // Split into groups
  const controlRows = rawRows.filter(r => String(r[treatmentColumn]) === String(ctrlVal));
  const treatmentRows = rawRows.filter(r => String(r[treatmentColumn]) === String(treatVal));

  if (controlRows.length === 0) throw new Error(`對照組無資料 (control="${ctrlVal}")`);
  if (treatmentRows.length === 0) throw new Error(`實驗組無資料 (treatment="${treatVal}")`);

  // Extract numeric values
  const controlValues = controlRows.map(r => Number(r[metricColumn])).filter(v => !isNaN(v));
  const treatmentValues = treatmentRows.map(r => Number(r[metricColumn])).filter(v => !isNaN(v));

  if (controlValues.length < 2) throw new Error('對照組數值資料不足 (need ≥ 2 numeric values in control)');
  if (treatmentValues.length < 2) throw new Error('實驗組數值資料不足 (need ≥ 2 numeric values in treatment)');

  // Compute group stats
  const controlStats = computeGroupStats(controlValues);
  const treatmentStats = computeGroupStats(treatmentValues);

  // ── Welch's t-test ────────────────────────────────────────────────────

  const se = Math.sqrt(
    (controlStats.variance / controlStats.n) + (treatmentStats.variance / treatmentStats.n)
  );

  const tStatistic = se > 0
    ? (treatmentStats.mean - controlStats.mean) / se
    : 0;

  const df = welchDf(controlStats.std, controlStats.n, treatmentStats.std, treatmentStats.n);
  const pValue = tTestPValue(tStatistic, df);
  const significant = pValue < alpha;

  // ── Effect size (Cohen's d) ───────────────────────────────────────────

  const pooledStd = Math.sqrt(
    ((controlStats.n - 1) * controlStats.variance + (treatmentStats.n - 1) * treatmentStats.variance)
    / (controlStats.n + treatmentStats.n - 2)
  );

  const cohensD = pooledStd > 0
    ? (treatmentStats.mean - controlStats.mean) / pooledStd
    : 0;

  // ── Confidence interval ───────────────────────────────────────────────

  const tCrit = tCritical(alpha, df);
  const ciLower = (treatmentStats.mean - controlStats.mean) - tCrit * se;
  const ciUpper = (treatmentStats.mean - controlStats.mean) + tCrit * se;

  // ── Recommendation ────────────────────────────────────────────────────

  const effectLabel = Math.abs(cohensD) < 0.2 ? '微小 (negligible)'
    : Math.abs(cohensD) < 0.5 ? '小 (small)'
    : Math.abs(cohensD) < 0.8 ? '中等 (medium)'
    : '大 (large)';

  const direction = treatmentStats.mean > controlStats.mean ? '提升' : '降低';

  let recommendation;
  if (significant) {
    recommendation = `實驗組相較對照組有統計顯著差異 (p=${pValue.toFixed(4)})，`
      + `指標${direction}了 ${Math.abs(treatmentStats.mean - controlStats.mean).toFixed(4)}，`
      + `效應量為${effectLabel} (d=${cohensD.toFixed(3)})。`
      + `建議採用實驗組方案。\n`
      + `The treatment group shows a statistically significant ${direction === '提升' ? 'increase' : 'decrease'} `
      + `with ${effectLabel} effect size. Recommend adopting the treatment.`;
  } else {
    recommendation = `實驗組與對照組之間無統計顯著差異 (p=${pValue.toFixed(4)}, α=${alpha})。`
      + `建議收集更多樣本或重新設計實驗。\n`
      + `No statistically significant difference found. Consider collecting more data or redesigning the experiment.`;
  }

  // ── Build result ──────────────────────────────────────────────────────

  const result = {
    control: {
      value: ctrlVal,
      n: controlStats.n,
      mean: Math.round(controlStats.mean * 10000) / 10000,
      std: Math.round(controlStats.std * 10000) / 10000,
    },
    treatment: {
      value: treatVal,
      n: treatmentStats.n,
      mean: Math.round(treatmentStats.mean * 10000) / 10000,
      std: Math.round(treatmentStats.std * 10000) / 10000,
    },
    test: {
      t_statistic: Math.round(tStatistic * 10000) / 10000,
      degrees_of_freedom: Math.round(df * 100) / 100,
      p_value: Math.round(pValue * 10000) / 10000,
      significant,
      alpha,
      effect_size: Math.round(cohensD * 10000) / 10000,
      effect_label: effectLabel,
      ci_lower: Math.round(ciLower * 10000) / 10000,
      ci_upper: Math.round(ciUpper * 10000) / 10000,
    },
    recommendation,
  };

  // Persist artifact
  let artifactId = null;
  try {
    artifactId = await saveJsonArtifact({
      type: 'ab_test_report',
      payload: {
        dataset_id: datasetId,
        treatment_column: treatmentColumn,
        metric_column: metricColumn,
        ...result,
      },
      userId,
    });
  } catch {
    // Non-critical — continue without persistence
  }

  return { ...result, artifact_id: artifactId };
}

// ── Exports ─────────────────────────────────────────────────────────────────

export default {
  analyzeExperiment,
};
