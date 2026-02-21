const toFinite = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const round = (value) => (Number.isFinite(value) ? Number(value.toFixed(4)) : null);

export function toCanonicalForecastPoint({
  time_bucket = null,
  date = null,
  actual = null,
  p50 = null,
  p90 = null,
  p10 = null,
  is_forecast = null
} = {}) {
  const bucket = String(time_bucket || date || '').trim();

  const actualValue = toFinite(actual);
  const p50Value = toFinite(p50);
  const normalizedP50 = p50Value === null ? null : Math.max(0, p50Value);

  const p90Value = toFinite(p90);
  const normalizedP90 = p90Value === null
    ? null
    : Math.max(normalizedP50 ?? 0, p90Value, 0);

  const p10Value = toFinite(p10);
  const normalizedP10 = p10Value === null
    ? null
    : Math.max(0, Math.min(normalizedP50 ?? Number.POSITIVE_INFINITY, p10Value));

  return {
    time_bucket: bucket || null,
    actual: actualValue,
    p50: round(normalizedP50),
    p90: round(normalizedP90),
    forecast: round(normalizedP50),
    p10: round(normalizedP10),
    lower: round(normalizedP10),
    upper: round(normalizedP90),
    is_forecast: typeof is_forecast === 'boolean' ? is_forecast : normalizedP50 !== null
  };
}

export default {
  toCanonicalForecastPoint
};
