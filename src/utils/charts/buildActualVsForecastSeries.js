const toFiniteNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const getGroups = (payload = {}) => {
  if (Array.isArray(payload?.groups)) return payload.groups;
  if (Array.isArray(payload?.series_groups)) return payload.series_groups;
  if (Array.isArray(payload?.forecast_series_json?.groups)) return payload.forecast_series_json.groups;
  return [];
};

const resolvePoints = (payload = {}, options = {}) => {
  const rows = Array.isArray(payload?.rows) ? payload.rows : (Array.isArray(payload) ? payload : null);
  if (rows) return rows;

  const groups = getGroups(payload);
  if (groups.length === 0) return [];

  const groupKey = options?.groupKey || null;
  const explicitIndex = Number(options?.groupIndex);

  if (groupKey) {
    const byKey = groups.find((group) => group?.key === groupKey && Array.isArray(group?.points));
    if (byKey) return byKey.points;
  }

  if (Number.isFinite(explicitIndex) && explicitIndex >= 0 && groups[explicitIndex]?.points) {
    return Array.isArray(groups[explicitIndex].points) ? groups[explicitIndex].points : [];
  }

  const firstWithPoints = groups.find((group) => Array.isArray(group?.points) && group.points.length > 0);
  return firstWithPoints?.points || [];
};

export function buildActualVsForecastSeries(payload = {}, options = {}) {
  const points = resolvePoints(payload, options);

  const rows = points.map((point, index) => ({
    time_bucket: point?.time_bucket || point?.date || point?.period || `p_${index + 1}`,
    actual: toFiniteNumber(point?.actual),
    p50: toFiniteNumber(point?.p50 ?? point?.forecast),
    p90: toFiniteNumber(point?.p90 ?? point?.upper),
    forecast: toFiniteNumber(point?.p50 ?? point?.forecast),
    lower: toFiniteNumber(point?.lower ?? point?.p10),
    upper: toFiniteNumber(point?.p90 ?? point?.upper)
  }));

  const hasActual = rows.some((row) => row.actual !== null);
  const hasP50 = rows.some((row) => row.p50 !== null);
  const hasP90 = rows.some((row) => row.p90 !== null);
  const hasLower = rows.some((row) => row.lower !== null);
  const hasUpper = rows.some((row) => row.upper !== null) && !hasP90;

  const series = [
    ...(hasActual ? [{ key: 'actual', label: 'Actual', color: '#10b981' }] : []),
    ...(hasP50 ? [{ key: 'p50', label: 'P50 (Forecast)', color: '#2563eb' }] : []),
    ...(hasP90 ? [{ key: 'p90', label: 'P90', color: '#1d4ed8', dashed: true }] : []),
    ...(hasLower ? [{ key: 'lower', label: 'Lower', color: '#60a5fa', dashed: true }] : []),
    ...(hasUpper ? [{ key: 'upper', label: 'Upper', color: '#60a5fa', dashed: true }] : [])
  ];

  return {
    xKey: 'time_bucket',
    rows,
    series,
    hasLower,
    hasUpper
  };
}

export default {
  buildActualVsForecastSeries
};
