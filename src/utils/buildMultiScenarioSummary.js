/**
 * buildMultiScenarioSummary.js
 *
 * Pure functions: from multiple scenario comparison artifacts, generate a
 * summary matrix with per-KPI best, weighted recommendation, and CSV export.
 */

// ── KPI definitions ───────────────────────────────────────────────────────────

export const COMPARISON_KPIS = [
  { key: 'service_level_proxy', label: 'Service Level',  format: 'pct',    goodDirection: 'up',   weight: 0.35 },
  { key: 'estimated_total_cost', label: 'Total Cost',     format: 'dollar', goodDirection: 'down', weight: 0.30 },
  { key: 'stockout_units',       label: 'Stockout Units', format: 'int',    goodDirection: 'down', weight: 0.20 },
  { key: 'holding_units',        label: 'Holding Units',  format: 'int',    goodDirection: 'down', weight: 0.10 },
  { key: 'fill_rate',            label: 'Fill Rate',      format: 'pct',    goodDirection: 'up',   weight: 0.05 },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

const safeNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export const formatKpi = (value, format) => {
  if (value == null) return '\u2014';
  switch (format) {
    case 'pct':    return `${(value * 100).toFixed(1)}%`;
    case 'dollar': return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
    case 'int':    return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
    default:       return String(value);
  }
};

/**
 * Normalise KPI values to [0, 1] scores (higher = better).
 * goodDirection='up'  → higher raw value = higher score
 * goodDirection='down' → lower raw value  = higher score
 */
function normalizeKpiScore(values, goodDirection) {
  const valid = values.filter((v) => v !== null);
  if (valid.length === 0) return values.map(() => null);

  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const range = max - min;

  return values.map((v) => {
    if (v === null) return null;
    if (range === 0) return 1.0;
    const normalized = (v - min) / range;
    return goodDirection === 'up' ? normalized : 1 - normalized;
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * @param {{ baseRunId: number, results: Array }} params
 *   results — succeeded batch results (each must have .comparison)
 * @returns {object} multi_scenario_summary
 */
export function buildMultiScenarioSummary({ baseRunId, results = [] }) {
  if (results.length === 0) {
    return { scenarios: [], kpi_matrix: [], recommended_scenario: null, base_run_id: baseRunId };
  }

  // ── Build per-scenario KPI rows ─────────────────────────────────────────────
  const scenarioKpis = results.map((r) => {
    const comp = r.comparison;
    const scenario = comp?.kpis?.scenario || {};

    const fillRate = safeNum(scenario.fill_rate) ?? safeNum(scenario.service_level_proxy);

    return {
      index: r.index,
      name: r.name,
      overrides: r.overrides,
      scenario_id: r.scenario_id,
      scenario_run_id: r.scenario_run_id,
      status: r.status,
      kpis: {
        service_level_proxy: safeNum(scenario.service_level_proxy),
        estimated_total_cost: safeNum(scenario.estimated_total_cost),
        stockout_units: safeNum(scenario.stockout_units),
        holding_units: safeNum(scenario.holding_units),
        fill_rate: fillRate,
      },
      kpi_deltas: {
        service_level_proxy: safeNum(comp?.kpis?.delta?.service_level_proxy),
        estimated_total_cost: safeNum(comp?.kpis?.delta?.estimated_total_cost),
        stockout_units: safeNum(comp?.kpis?.delta?.stockout_units),
        holding_units: safeNum(comp?.kpis?.delta?.holding_units),
      },
      notes: comp?.notes || [],
    };
  });

  // ── Weighted recommendation scores ──────────────────────────────────────────
  const allScores = new Array(scenarioKpis.length).fill(0);

  COMPARISON_KPIS.forEach((kpiDef) => {
    const values = scenarioKpis.map((s) => s.kpis[kpiDef.key]);
    const normalizedScores = normalizeKpiScore(values, kpiDef.goodDirection);

    scenarioKpis.forEach((_, idx) => {
      const score = normalizedScores[idx];
      if (score !== null) allScores[idx] += score * kpiDef.weight;
    });
  });

  scenarioKpis.forEach((s, idx) => {
    s.recommendation_score = allScores[idx] != null
      ? Number(allScores[idx].toFixed(4))
      : null;
  });

  const ranked = [...scenarioKpis].sort(
    (a, b) => (b.recommendation_score ?? -1) - (a.recommendation_score ?? -1),
  );

  // ── Best scenario per KPI ───────────────────────────────────────────────────
  const bestByKpi = {};
  COMPARISON_KPIS.forEach((kpiDef) => {
    const valid = scenarioKpis.filter((s) => s.kpis[kpiDef.key] !== null);
    if (valid.length === 0) { bestByKpi[kpiDef.key] = null; return; }
    const best = valid.reduce((prev, curr) => {
      const pv = prev.kpis[kpiDef.key];
      const cv = curr.kpis[kpiDef.key];
      return (kpiDef.goodDirection === 'up' ? cv > pv : cv < pv) ? curr : prev;
    });
    bestByKpi[kpiDef.key] = { scenario_name: best.name, value: best.kpis[kpiDef.key] };
  });

  // ── KPI matrix (row = KPI, col = scenario) ─────────────────────────────────
  const kpiMatrix = COMPARISON_KPIS.map((kpiDef) => ({
    kpi_key: kpiDef.key,
    kpi_label: kpiDef.label,
    format: kpiDef.format,
    good_direction: kpiDef.goodDirection,
    values: scenarioKpis.map((s) => ({
      scenario_name: s.name,
      raw: s.kpis[kpiDef.key],
      formatted: formatKpi(s.kpis[kpiDef.key], kpiDef.format),
      delta_vs_base: s.kpi_deltas[kpiDef.key] ?? null,
      is_best: bestByKpi[kpiDef.key]?.scenario_name === s.name,
    })),
    best_scenario: bestByKpi[kpiDef.key],
  }));

  const recommended = ranked[0] ?? null;

  return {
    version: 'v1',
    base_run_id: baseRunId,
    scenarios: scenarioKpis,
    ranked_scenarios: ranked,
    kpi_matrix: kpiMatrix,
    best_by_kpi: bestByKpi,
    recommended_scenario: recommended
      ? {
          name: recommended.name,
          scenario_id: recommended.scenario_id,
          recommendation_score: recommended.recommendation_score,
          key_reasons: buildRecommendationReasons(recommended, bestByKpi),
        }
      : null,
    generated_at: new Date().toISOString(),
  };
}

/**
 * Build human-readable recommendation reasons.
 */
function buildRecommendationReasons(scenario, bestByKpi) {
  const reasons = [];
  COMPARISON_KPIS.forEach((kpiDef) => {
    if (bestByKpi[kpiDef.key]?.scenario_name === scenario.name) {
      reasons.push(`Best ${kpiDef.label}: ${formatKpi(scenario.kpis[kpiDef.key], kpiDef.format)}`);
    }
  });
  if (reasons.length === 0 && scenario.recommendation_score != null) {
    reasons.push(`Highest composite score (${(scenario.recommendation_score * 100).toFixed(0)})`);
  }
  return reasons;
}

// ── CSV export ────────────────────────────────────────────────────────────────

/**
 * Export multi-scenario summary to CSV string.
 * @param {object} summary — output of buildMultiScenarioSummary
 * @returns {string}
 */
export function exportMultiScenarioToCsv(summary) {
  if (!summary?.scenarios?.length) return 'No scenario data available.';

  const names = summary.scenarios.map((s) => s.name);
  const header = ['KPI', 'Direction', ...names, 'Best Scenario'].join(',');

  const rows = COMPARISON_KPIS.map((kpiDef) => {
    const matrixRow = summary.kpi_matrix.find((r) => r.kpi_key === kpiDef.key);
    if (!matrixRow) return null;

    const values = names.map((name) => {
      const cell = matrixRow.values.find((v) => v.scenario_name === name);
      return cell ? `"${cell.formatted}"` : '\u2014';
    });

    const best = matrixRow.best_scenario?.scenario_name || '\u2014';
    return [
      `"${kpiDef.label}"`,
      kpiDef.goodDirection === 'up' ? 'Higher Better' : 'Lower Better',
      ...values,
      `"${best}"`,
    ].join(',');
  }).filter(Boolean);

  const recRow = summary.recommended_scenario
    ? [
        '"Recommendation Score"',
        '\u2014',
        ...summary.scenarios.map((s) =>
          `"${s.recommendation_score != null ? (s.recommendation_score * 100).toFixed(0) + '%' : '\u2014'}"`,
        ),
        `"${summary.recommended_scenario.name}"`,
      ].join(',')
    : null;

  return [header, ...rows, recRow].filter(Boolean).join('\n');
}
