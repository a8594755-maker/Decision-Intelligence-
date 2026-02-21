import { describe, expect, it } from 'vitest';
import { toCanonicalForecastPoint } from './forecastPointMapper';

describe('forecastPointMapper', () => {
  it('keeps forecast as alias of p50', () => {
    const point = toCanonicalForecastPoint({
      time_bucket: '2026-01-01',
      actual: null,
      p50: 12.34567,
      p90: 15.12345,
      p10: 10.11111,
      is_forecast: true
    });

    expect(point.p50).toBe(12.3457);
    expect(point.forecast).toBe(point.p50);
    expect(point.p90).toBe(15.1235);
    expect(point.upper).toBe(point.p90);
    expect(point.lower).toBe(point.p10);
  });

  it('keeps missing values as null without zero imputation', () => {
    const point = toCanonicalForecastPoint({
      time_bucket: '2026-01-08',
      actual: null,
      p50: null,
      p90: null,
      p10: null,
      is_forecast: false
    });

    expect(point.actual).toBeNull();
    expect(point.p50).toBeNull();
    expect(point.forecast).toBeNull();
    expect(point.p90).toBeNull();
    expect(point.upper).toBeNull();
    expect(point.lower).toBeNull();
  });
});
