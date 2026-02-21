import { describe, expect, it } from 'vitest';
import { buildActualVsForecastSeries } from './buildActualVsForecastSeries';

describe('buildActualVsForecastSeries', () => {
  it('keeps future actuals as null while forecast continues', () => {
    const payload = {
      groups: [
        {
          material_code: 'SKU-1',
          plant_id: 'P1',
          points: [
            { time_bucket: '2026-01-01', actual: 10, forecast: 11, lower: 9, upper: 13 },
            { time_bucket: '2026-01-08', actual: 12, forecast: 12.5, lower: 10, upper: 14 },
            { time_bucket: '2026-01-15', actual: null, forecast: 13, lower: 11, upper: 15 },
            { time_bucket: '2026-01-22', actual: null, forecast: 14, lower: 12, upper: 16 }
          ]
        }
      ]
    };

    const result = buildActualVsForecastSeries(payload);

    expect(result.rows).toHaveLength(4);
    expect(result.rows[2].actual).toBeNull();
    expect(result.rows[3].actual).toBeNull();
    expect(result.rows[2].p50).toBe(13);
    expect(result.rows[3].p50).toBe(14);
    expect(result.rows[2].p90).toBe(15);
    expect(result.rows[3].p90).toBe(16);
    expect(result.rows[2].forecast).toBe(result.rows[2].p50);
    expect(result.rows[3].forecast).toBe(result.rows[3].p50);
    expect(result.rows.some((row) => row.actual === 0 && row.time_bucket === '2026-01-15')).toBe(false);
    expect(result.series.map((s) => s.key)).toContain('actual');
    expect(result.series.map((s) => s.key)).toContain('p50');
    expect(result.series.map((s) => s.key)).toContain('p90');
  });

  it('keeps missing forecast as null (no zero imputation)', () => {
    const payload = {
      groups: [
        {
          points: [
            { time_bucket: '2026-01-01', actual: 5, forecast: 6 },
            { time_bucket: '2026-01-08', actual: null, forecast: null },
            { time_bucket: '2026-01-15', actual: null }
          ]
        }
      ]
    };

    const result = buildActualVsForecastSeries(payload);

    expect(result.rows).toHaveLength(3);
    expect(result.rows[1].p50).toBeNull();
    expect(result.rows[2].p50).toBeNull();
    expect(result.rows[1].forecast).toBeNull();
    expect(result.rows[2].forecast).toBeNull();
    expect(result.rows[1].p50).not.toBe(0);
    expect(result.rows[2].p50).not.toBe(0);
  });

  it('handles optional lower/upper without crashing', () => {
    const payload = {
      groups: [
        {
          points: [
            { time_bucket: '2026-01-01', actual: 10, forecast: 11 },
            { time_bucket: '2026-01-08', actual: null, forecast: 12 }
          ]
        }
      ]
    };

    const result = buildActualVsForecastSeries(payload);

    expect(result.rows).toHaveLength(2);
    expect(result.hasLower).toBe(false);
    expect(result.hasUpper).toBe(false);
    expect(result.series.map((s) => s.key)).toEqual(['actual', 'p50']);
  });

  it('uses p50 as forecast alias when p50 exists but forecast is missing', () => {
    const payload = {
      groups: [
        {
          points: [
            { time_bucket: '2026-01-01', actual: 10, p50: 12, p90: 15 },
            { time_bucket: '2026-01-08', actual: null, p50: 13, p90: 16 }
          ]
        }
      ]
    };

    const result = buildActualVsForecastSeries(payload);

    expect(result.rows[0].forecast).toBe(12);
    expect(result.rows[1].forecast).toBe(13);
    expect(result.rows[0].forecast).toBe(result.rows[0].p50);
    expect(result.rows[1].forecast).toBe(result.rows[1].p50);
  });
});
