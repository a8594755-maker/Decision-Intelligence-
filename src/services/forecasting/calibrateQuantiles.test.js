import { describe, expect, it } from 'vitest';
import {
  buildQuantileCalibration,
  applyCalibratedQuantiles,
  computeCalibrationMetrics
} from './calibrateQuantiles';

describe('calibrateQuantiles', () => {
  it('computes q90 residual from synthetic residuals', () => {
    const backtestRows = [
      { series_key: 'S1', actual: 9, p50_pred: 10 },
      { series_key: 'S1', actual: 10, p50_pred: 10 },
      { series_key: 'S1', actual: 11, p50_pred: 10 },
      { series_key: 'S1', actual: 12, p50_pred: 10 },
      { series_key: 'S1', actual: 13, p50_pred: 10 }
    ];

    const calibration = buildQuantileCalibration({ backtestRows, minSeriesSamples: 30 });
    expect(calibration.global.q90_residual).toBeCloseTo(2.6, 6);
  });

  it('computes p90 coverage correctly from backtest rows', () => {
    const backtestRows = [
      { series_key: 'S1', actual: 9, p50_pred: 10 },
      { series_key: 'S1', actual: 10, p50_pred: 10 },
      { series_key: 'S1', actual: 11, p50_pred: 10 },
      { series_key: 'S1', actual: 12, p50_pred: 10 },
      { series_key: 'S1', actual: 13, p50_pred: 10 }
    ];

    const calibration = buildQuantileCalibration({ backtestRows, minSeriesSamples: 30 });
    const metrics = computeCalibrationMetrics({ backtestRows, calibration });

    expect(metrics.p90_coverage).toBeCloseTo(0.8, 6);
    expect(metrics.coverage_samples).toBe(5);
  });

  it('falls back to global quantile when series samples are insufficient', () => {
    const backtestRows = [
      { series_key: 'A', actual: 20, p50_pred: 10 },
      { series_key: 'A', actual: 20, p50_pred: 10 },
      ...Array.from({ length: 30 }, () => ({ series_key: 'B', actual: 11, p50_pred: 10 }))
    ];

    const calibration = buildQuantileCalibration({ backtestRows, minSeriesSamples: 3 });

    const aPoint = applyCalibratedQuantiles({ p50: 10, seriesKey: 'A', calibration });
    const bPoint = applyCalibratedQuantiles({ p50: 10, seriesKey: 'B', calibration });

    expect(aPoint.scope_used).toBe('global');
    expect(aPoint.p90).toBeCloseTo(11, 6);
    expect(bPoint.scope_used).toBe('per_series');
    expect(bPoint.p90).toBeCloseTo(11, 6);
  });
});
