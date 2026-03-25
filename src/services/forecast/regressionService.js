// @product: data-analyst
//
// regressionService.js
// ─────────────────────────────────────────────────────────────────────────────
// Regression analysis service for general-purpose analysis.
// Operates on dataset profiles (uploaded CSV/Excel) and produces
// a regression_report artifact with model coefficients, diagnostics,
// feature importance, and multi-collinearity checks.
//
// Supports: OLS (normal equation). Logistic and ridge return placeholder.
// Works with ANY dataset — schema-agnostic.
// ─────────────────────────────────────────────────────────────────────────────

import { datasetProfilesService } from '../data-prep/datasetProfilesService';
import { saveJsonArtifact } from '../../utils/artifactStore';

// ── Matrix Helpers ──────────────────────────────────────────────────────────
// Minimal matrix operations for the normal equation: β = (XᵀX)⁻¹Xᵀy

/**
 * Transpose a matrix (2D array).
 * @param {number[][]} A
 * @returns {number[][]}
 */
function transpose(A) {
  const rows = A.length;
  const cols = A[0].length;
  const T = Array.from({ length: cols }, () => new Array(rows));
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      T[j][i] = A[i][j];
    }
  }
  return T;
}

/**
 * Multiply two matrices.
 * @param {number[][]} A - (m x n)
 * @param {number[][]} B - (n x p)
 * @returns {number[][]} - (m x p)
 */
function matMul(A, B) {
  const m = A.length;
  const n = B.length;
  const p = B[0].length;
  const C = Array.from({ length: m }, () => new Array(p).fill(0));
  for (let i = 0; i < m; i++) {
    for (let k = 0; k < n; k++) {
      if (A[i][k] === 0) continue;
      for (let j = 0; j < p; j++) {
        C[i][j] += A[i][k] * B[k][j];
      }
    }
  }
  return C;
}

/**
 * Multiply matrix by a column vector.
 * @param {number[][]} A - (m x n)
 * @param {number[]} v - (n)
 * @returns {number[]} - (m)
 */
function matVecMul(A, v) {
  return A.map(row => row.reduce((s, val, j) => s + val * v[j], 0));
}

/**
 * Invert a square matrix using Gauss-Jordan elimination.
 * @param {number[][]} M - (n x n)
 * @returns {number[][] | null} Inverse or null if singular
 */
function invertMatrix(M) {
  const n = M.length;
  // Augment with identity
  const aug = M.map((row, i) => {
    const ext = new Array(n).fill(0);
    ext[i] = 1;
    return [...row.map(v => v), ...ext];
  });

  for (let col = 0; col < n; col++) {
    // Partial pivoting
    let maxRow = col;
    let maxVal = Math.abs(aug[col][col]);
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > maxVal) {
        maxVal = Math.abs(aug[row][col]);
        maxRow = row;
      }
    }
    if (maxVal < 1e-12) return null; // Singular

    if (maxRow !== col) {
      [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
    }

    // Scale pivot row
    const pivot = aug[col][col];
    for (let j = 0; j < 2 * n; j++) {
      aug[col][j] /= pivot;
    }

    // Eliminate column in other rows
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = aug[row][col];
      for (let j = 0; j < 2 * n; j++) {
        aug[row][j] -= factor * aug[col][j];
      }
    }
  }

  // Extract inverse (right half)
  return aug.map(row => row.slice(n));
}

// ── Statistical Helpers ─────────────────────────────────────────────────────

function round4(v) {
  return Math.round(v * 10000) / 10000;
}

/**
 * Compute mean and std of an array.
 */
function meanStd(arr) {
  const n = arr.length;
  if (n === 0) return { mean: 0, std: 0 };
  const mean = arr.reduce((s, v) => s + v, 0) / n;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(n - 1, 1);
  return { mean, std: Math.sqrt(variance) };
}

// ── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Run regression analysis on a dataset.
 *
 * @param {Object} params
 * @param {string} params.datasetId - Dataset profile ID
 * @param {string} params.target - Target (dependent) variable column
 * @param {string[]} params.features - Feature (independent) variable columns
 * @param {string} [params.method='ols'] - Regression method: 'ols', 'logistic', 'ridge'
 * @param {string} [params.userId]
 * @returns {Promise<{ model, feature_importance, vif, residuals, artifact_id }>}
 */
export async function runRegression({ datasetId, target, features, method = 'ols', userId }) {
  // Logistic and ridge: placeholder
  if (method === 'logistic' || method === 'ridge') {
    return {
      model: {
        method,
        message: `${method} 迴歸需要 Python 後端支援，目前僅支援 OLS。`
          + ` (${method} regression requires the Python backend. Only OLS is currently available.)`,
      },
      feature_importance: [],
      vif: [],
      residuals: null,
      artifact_id: null,
    };
  }

  if (method !== 'ols') {
    throw new Error(`不支援的迴歸方法: ${method}。可用方法: ols, logistic (placeholder), ridge (placeholder)`);
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

  // Validate columns
  if (!allColumns.includes(target)) {
    throw new Error(`找不到目標欄位: ${target}`);
  }
  const validFeatures = features.filter(f => allColumns.includes(f) && f !== target);
  if (validFeatures.length === 0) {
    throw new Error('未找到有效的特徵欄位 (No valid feature columns found)');
  }

  // ── Extract clean numeric data ────────────────────────────────────────

  const cleanRows = rawRows.filter(r => {
    const yVal = Number(r[target]);
    if (isNaN(yVal)) return false;
    return validFeatures.every(f => !isNaN(Number(r[f])));
  });

  if (cleanRows.length < validFeatures.length + 2) {
    throw new Error(
      `有效資料列不足: ${cleanRows.length} 列（至少需要 ${validFeatures.length + 2} 列）。`
      + ` Not enough valid rows for regression.`
    );
  }

  const n = cleanRows.length;
  const p = validFeatures.length; // number of features (excluding intercept)

  // Build y vector
  const y = cleanRows.map(r => Number(r[target]));

  // Build X matrix (with intercept column)
  const X = cleanRows.map(r => [1, ...validFeatures.map(f => Number(r[f]))]);

  // ── OLS: β = (XᵀX)⁻¹Xᵀy ─────────────────────────────────────────────

  const Xt = transpose(X);
  const XtX = matMul(Xt, X);
  const XtXinv = invertMatrix(XtX);

  if (!XtXinv) {
    throw new Error('矩陣奇異，無法求解。特徵欄位可能存在完全共線性。 (Singular matrix — features may be perfectly collinear)');
  }

  const Xty = matVecMul(Xt, y);
  const beta = matVecMul(XtXinv, Xty);

  // ── Predictions and residuals ─────────────────────────────────────────

  const yHat = matVecMul(X, beta);
  const residuals = y.map((yi, i) => yi - yHat[i]);

  // ── R² and adjusted R² ────────────────────────────────────────────────

  const yMean = y.reduce((s, v) => s + v, 0) / n;
  const ssTot = y.reduce((s, v) => s + (v - yMean) ** 2, 0);
  const ssRes = residuals.reduce((s, v) => s + v ** 2, 0);
  const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  const adjRSquared = n > p + 1
    ? 1 - ((1 - rSquared) * (n - 1)) / (n - p - 1)
    : rSquared;

  // ── Standard errors of coefficients ───────────────────────────────────

  const mse = ssRes / Math.max(n - p - 1, 1);
  // Var(β) = MSE * (XᵀX)⁻¹
  const betaVarDiag = XtXinv.map((row, i) => mse * row[i]);
  const betaStdErrors = betaVarDiag.map(v => Math.sqrt(Math.max(v, 0)));

  // ── Build coefficient table ───────────────────────────────────────────

  const coefficients = [
    {
      feature: '(intercept)',
      coefficient: round4(beta[0]),
      std_error: round4(betaStdErrors[0]),
      t_stat: betaStdErrors[0] > 0 ? round4(beta[0] / betaStdErrors[0]) : null,
    },
    ...validFeatures.map((f, i) => ({
      feature: f,
      coefficient: round4(beta[i + 1]),
      std_error: round4(betaStdErrors[i + 1]),
      t_stat: betaStdErrors[i + 1] > 0 ? round4(beta[i + 1] / betaStdErrors[i + 1]) : null,
    })),
  ];

  // ── Feature importance (absolute standardized coefficients) ───────────

  const featureImportance = validFeatures.map((f, i) => {
    const fValues = cleanRows.map(r => Number(r[f]));
    const { std: fStd } = meanStd(fValues);
    const { std: yStd } = meanStd(y);
    const stdCoef = yStd > 0 && fStd > 0 ? Math.abs(beta[i + 1] * fStd / yStd) : 0;
    return { feature: f, importance: round4(stdCoef) };
  }).sort((a, b) => b.importance - a.importance);

  // ── VIF (Variance Inflation Factor) ───────────────────────────────────
  // Simplified: for each feature, regress on all other features, VIF = 1/(1-R²)

  const vif = validFeatures.map((f, idx) => {
    if (validFeatures.length < 2) return { feature: f, vif: 1.0 };

    const otherFeatures = validFeatures.filter((_, j) => j !== idx);
    const yf = cleanRows.map(r => Number(r[f]));
    const Xf = cleanRows.map(r => [1, ...otherFeatures.map(of => Number(r[of]))]);

    const Xft = transpose(Xf);
    const XftXf = matMul(Xft, Xf);
    const XftXfInv = invertMatrix(XftXf);

    if (!XftXfInv) return { feature: f, vif: Infinity };

    const Xfty = matVecMul(Xft, yf);
    const betaF = matVecMul(XftXfInv, Xfty);
    const yHatF = matVecMul(Xf, betaF);

    const yfMean = yf.reduce((s, v) => s + v, 0) / yf.length;
    const ssTotF = yf.reduce((s, v) => s + (v - yfMean) ** 2, 0);
    const ssResF = yf.reduce((s, v, i) => s + (v - yHatF[i]) ** 2, 0);
    const r2F = ssTotF > 0 ? 1 - ssResF / ssTotF : 0;

    const vifVal = r2F < 1 ? 1 / (1 - r2F) : Infinity;
    return { feature: f, vif: round4(vifVal) };
  });

  // ── Residuals summary ─────────────────────────────────────────────────

  const residualStats = meanStd(residuals);
  const sortedResiduals = [...residuals].sort((a, b) => a - b);

  const residualsSummary = {
    mean: round4(residualStats.mean),
    std: round4(residualStats.std),
    min: round4(sortedResiduals[0]),
    max: round4(sortedResiduals[sortedResiduals.length - 1]),
  };

  // ── Build result ──────────────────────────────────────────────────────

  const result = {
    model: {
      method: 'ols',
      r_squared: round4(rSquared),
      adj_r_squared: round4(adjRSquared),
      n_observations: n,
      n_features: p,
      mse: round4(mse),
      coefficients,
    },
    feature_importance: featureImportance,
    vif,
    residuals: residualsSummary,
  };

  // Persist artifact
  let artifactId = null;
  try {
    artifactId = await saveJsonArtifact({
      type: 'regression_report',
      payload: {
        dataset_id: datasetId,
        target,
        features: validFeatures,
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
  runRegression,
};
