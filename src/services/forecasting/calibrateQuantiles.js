import { quantile } from '../../utils/stats/quantile';

export const CALIBRATION_METHOD = 'empirical_residual_quantile_v1';
export const DEFAULT_MIN_SERIES_SAMPLES = 30;
const DEFAULT_P90_QUANTILE = 0.9;
const DEFAULT_P10_QUANTILE = 0.1;

const toFiniteNumber = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const toSeriesKey = (value) => String(value || '').trim();

const normalizeBacktestRows = (rows = []) => {
  if (!Array.isArray(rows)) return [];

  return rows
    .map((row) => {
      const actual = toFiniteNumber(row?.actual);
      const p50Pred = toFiniteNumber(row?.p50_pred);
      const seriesKey = toSeriesKey(row?.series_key || row?.seriesKey || row?.key);
      if (actual === null || p50Pred === null || !seriesKey) return null;

      return {
        series_key: seriesKey,
        actual,
        p50_pred: p50Pred,
        residual: actual - p50Pred
      };
    })
    .filter(Boolean);
};

const round = (value) => (Number.isFinite(value) ? Number(value.toFixed(6)) : null);

const buildDefaultCalibration = ({
  p90Quantile,
  p10Quantile,
  minSeriesSamples
}) => ({
  calibration_method: CALIBRATION_METHOD,
  calibration_scope: 'global',
  p90_quantile: p90Quantile,
  p10_quantile: p10Quantile,
  min_series_samples: minSeriesSamples,
  sample_size: 0,
  global: {
    q90_residual: 0,
    q10_residual: 0,
    sample_size: 0
  },
  per_series: {},
  per_series_enabled_count: 0
});

export function buildQuantileCalibration({
  backtestRows = [],
  minSeriesSamples = DEFAULT_MIN_SERIES_SAMPLES,
  p90Quantile = DEFAULT_P90_QUANTILE,
  p10Quantile = DEFAULT_P10_QUANTILE
} = {}) {
  const normalizedRows = normalizeBacktestRows(backtestRows);
  if (normalizedRows.length === 0) {
    return buildDefaultCalibration({
      p90Quantile,
      p10Quantile,
      minSeriesSamples
    });
  }

  const allResiduals = normalizedRows.map((row) => row.residual);
  const globalQ90 = quantile(allResiduals, p90Quantile);
  const globalQ10 = quantile(allResiduals, p10Quantile);

  const residualsBySeries = new Map();
  normalizedRows.forEach((row) => {
    if (!residualsBySeries.has(row.series_key)) {
      residualsBySeries.set(row.series_key, []);
    }
    residualsBySeries.get(row.series_key).push(row.residual);
  });

  const perSeries = {};
  let enabledCount = 0;
  residualsBySeries.forEach((residuals, seriesKey) => {
    const sampleSize = residuals.length;
    // Calibrate per-series only when residual sample size is large enough; otherwise fallback to global calibration.
    const enabled = sampleSize >= minSeriesSamples;
    if (enabled) {
      enabledCount += 1;
    }

    perSeries[seriesKey] = {
      sample_size: sampleSize,
      enabled,
      q90_residual: enabled ? quantile(residuals, p90Quantile) : null,
      q10_residual: enabled ? quantile(residuals, p10Quantile) : null
    };
  });

  return {
    calibration_method: CALIBRATION_METHOD,
    calibration_scope: enabledCount > 0 ? 'hybrid_per_series' : 'global',
    p90_quantile: p90Quantile,
    p10_quantile: p10Quantile,
    min_series_samples: minSeriesSamples,
    sample_size: normalizedRows.length,
    global: {
      q90_residual: globalQ90,
      q10_residual: globalQ10,
      sample_size: allResiduals.length
    },
    per_series: perSeries,
    per_series_enabled_count: enabledCount
  };
}

const getResidualQuantiles = ({ calibration = {}, seriesKey = '' }) => {
  const key = toSeriesKey(seriesKey);
  const perSeries = calibration?.per_series?.[key];
  if (perSeries?.enabled) {
    return {
      scope_used: 'per_series',
      q90_residual: toFiniteNumber(perSeries.q90_residual) ?? 0,
      q10_residual: toFiniteNumber(perSeries.q10_residual) ?? 0
    };
  }

  return {
    scope_used: 'global',
    q90_residual: toFiniteNumber(calibration?.global?.q90_residual) ?? 0,
    q10_residual: toFiniteNumber(calibration?.global?.q10_residual) ?? 0
  };
};

export function applyCalibratedQuantiles({
  p50,
  seriesKey,
  calibration
} = {}) {
  const p50Value = toFiniteNumber(p50);
  if (p50Value === null) {
    return {
      p50: null,
      p90: null,
      p10: null,
      forecast: null,
      upper: null,
      lower: null,
      scope_used: 'global'
    };
  }

  const safeP50 = Math.max(0, p50Value);
  const { q90_residual, q10_residual, scope_used } = getResidualQuantiles({ calibration, seriesKey });

  // Keep upper quantile non-decreasing over P50 to avoid inverted uncertainty bounds.
  const upperResidual = Math.max(0, q90_residual);
  const p90 = Math.max(safeP50, safeP50 + upperResidual);

  const p10Candidate = safeP50 + q10_residual;
  const p10 = Math.max(0, Math.min(safeP50, p10Candidate));

  return {
    p50: round(safeP50),
    p90: round(p90),
    p10: round(p10),
    forecast: round(safeP50),
    upper: round(p90),
    lower: round(p10),
    scope_used
  };
}

const pinballLoss = (actual, prediction, quantileLevel) => {
  if (!Number.isFinite(actual) || !Number.isFinite(prediction)) return null;
  if (actual <= prediction) {
    return (1 - quantileLevel) * (prediction - actual);
  }
  return quantileLevel * (actual - prediction);
};

export function computeCalibrationMetrics({
  backtestRows = [],
  calibration = null
} = {}) {
  const normalizedRows = normalizeBacktestRows(backtestRows);
  if (normalizedRows.length === 0) {
    return {
      p90_coverage: null,
      p90_pinball_loss: null,
      coverage_samples: 0
    };
  }

  let coverageCount = 0;
  const losses = [];

  normalizedRows.forEach((row) => {
    const calibrated = applyCalibratedQuantiles({
      p50: row.p50_pred,
      seriesKey: row.series_key,
      calibration
    });

    if (Number.isFinite(calibrated.p90) && row.actual <= calibrated.p90) {
      coverageCount += 1;
    }

    const loss = pinballLoss(row.actual, calibrated.p90, DEFAULT_P90_QUANTILE);
    if (Number.isFinite(loss)) losses.push(loss);
  });

  const coverage = coverageCount / normalizedRows.length;
  const avgLoss = losses.length > 0
    ? losses.reduce((sum, value) => sum + value, 0) / losses.length
    : null;

  return {
    p90_coverage: round(coverage),
    p90_pinball_loss: round(avgLoss),
    coverage_samples: normalizedRows.length
  };
}

export default {
  CALIBRATION_METHOD,
  DEFAULT_MIN_SERIES_SAMPLES,
  buildQuantileCalibration,
  applyCalibratedQuantiles,
  computeCalibrationMetrics
};
