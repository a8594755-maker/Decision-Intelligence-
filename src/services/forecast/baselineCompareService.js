/**
 * baselineCompareService.js
 *
 * Detects stale baselines and builds automatic comparison context
 * when a new plan run completes relative to an existing baseline.
 *
 * "Baseline-aware" means the copilot can:
 *   1. Detect when current plan KPIs have drifted from the approved baseline
 *   2. Auto-generate delta summaries for decision bundles
 *   3. Flag when a baseline is stale (age, data freshness, constraint changes)
 *   4. Suggest baseline refresh actions
 */

// ── Staleness thresholds ────────────────────────────────────────────────────

const STALE_AGE_HOURS = 72;        // Baseline older than 72h is considered stale
const STALE_DRIFT_THRESHOLD = 0.1; // 10% KPI drift triggers staleness warning

// ── Staleness detection ─────────────────────────────────────────────────────

/**
 * Check if a baseline is stale.
 *
 * @param {object} params
 * @param {object} params.baseline           - Baseline metadata { run_id, created_at, kpis }
 * @param {object} [params.currentKpis]      - Current plan KPIs for drift detection
 * @param {object} [params.datasetUpdatedAt] - When underlying data was last refreshed
 * @returns {{ isStale, reasons: string[], age_hours: number, drift: object|null }}
 */
export function checkBaselineStaleness({ baseline, currentKpis = null, datasetUpdatedAt = null }) {
  if (!baseline) {
    return { isStale: true, reasons: ['No baseline exists'], age_hours: Infinity, drift: null };
  }

  const reasons = [];
  const now = new Date();
  const baselineDate = new Date(baseline.created_at || baseline.updated_at || 0);
  const ageMs = now - baselineDate;
  const ageHours = ageMs / (1000 * 60 * 60);

  // Age check
  if (ageHours > STALE_AGE_HOURS) {
    reasons.push(`Baseline is ${Math.round(ageHours)}h old (threshold: ${STALE_AGE_HOURS}h)`);
  }

  // Data freshness check
  if (datasetUpdatedAt) {
    const dataDate = new Date(datasetUpdatedAt);
    if (dataDate > baselineDate) {
      reasons.push('Underlying data has been updated since baseline was created');
    }
  }

  // KPI drift check
  let drift = null;
  if (currentKpis && baseline.kpis) {
    drift = computeKpiDrift(baseline.kpis, currentKpis);
    const significantDrifts = Object.entries(drift).filter(
      ([, d]) => Math.abs(d.pct_change) > STALE_DRIFT_THRESHOLD
    );
    if (significantDrifts.length > 0) {
      const driftLabels = significantDrifts.map(
        ([key, d]) => `${key}: ${d.pct_change > 0 ? '+' : ''}${(d.pct_change * 100).toFixed(1)}%`
      );
      reasons.push(`KPI drift detected: ${driftLabels.join(', ')}`);
    }
  }

  return {
    isStale: reasons.length > 0,
    reasons,
    age_hours: Math.round(ageHours * 10) / 10,
    drift,
  };
}

// ── KPI drift computation ───────────────────────────────────────────────────

/**
 * Compute per-KPI drift between baseline and current values.
 *
 * @param {object} baselineKpis - { estimated_total_cost, estimated_service_level, ... }
 * @param {object} currentKpis  - same shape
 * @returns {object} { [kpi_name]: { baseline, current, delta, pct_change } }
 */
export function computeKpiDrift(baselineKpis, currentKpis) {
  if (!baselineKpis || !currentKpis) return {};

  const drift = {};
  const allKeys = new Set([...Object.keys(baselineKpis), ...Object.keys(currentKpis)]);

  for (const key of allKeys) {
    const baseVal = Number(baselineKpis[key]);
    const curVal = Number(currentKpis[key]);

    if (!Number.isFinite(baseVal) || !Number.isFinite(curVal)) continue;

    const delta = curVal - baseVal;
    const pctChange = baseVal !== 0 ? delta / Math.abs(baseVal) : (delta !== 0 ? Infinity : 0);

    drift[key] = {
      baseline: baseVal,
      current: curVal,
      delta,
      pct_change: pctChange,
    };
  }

  return drift;
}

// ── Auto-comparison builder ─────────────────────────────────────────────────

/**
 * Build a comparison summary between baseline and current plan.
 * Returns a structured object suitable for chat display.
 *
 * @param {object} params
 * @param {object} params.baselineKpis  - Baseline KPIs
 * @param {object} params.currentKpis   - New plan KPIs
 * @param {number} params.baselineRunId - Baseline run ID
 * @param {number} params.currentRunId  - Current run ID
 * @returns {object} { summary_text, deltas, improved, degraded, unchanged }
 */
export function buildBaselineComparison({ baselineKpis, currentKpis, baselineRunId, currentRunId }) {
  const drift = computeKpiDrift(baselineKpis, currentKpis);
  const entries = Object.entries(drift);

  const improved = [];
  const degraded = [];
  const unchanged = [];

  for (const [key, d] of entries) {
    const isImprovement = isKpiImprovement(key, d.delta);
    const entry = { key, ...d, formatted: formatKpiDelta(key, d) };

    if (Math.abs(d.pct_change) < 0.005) {
      unchanged.push(entry);
    } else if (isImprovement) {
      improved.push(entry);
    } else {
      degraded.push(entry);
    }
  }

  // Sort by magnitude of change
  improved.sort((a, b) => Math.abs(b.pct_change) - Math.abs(a.pct_change));
  degraded.sort((a, b) => Math.abs(b.pct_change) - Math.abs(a.pct_change));

  const summaryParts = [];
  if (improved.length > 0) {
    summaryParts.push(`${improved.length} KPI(s) improved`);
  }
  if (degraded.length > 0) {
    summaryParts.push(`${degraded.length} KPI(s) degraded`);
  }
  if (unchanged.length > 0) {
    summaryParts.push(`${unchanged.length} unchanged`);
  }

  return {
    baseline_run_id: baselineRunId,
    current_run_id: currentRunId,
    summary_text: `Compared to baseline (run #${baselineRunId}): ${summaryParts.join(', ')}.`,
    deltas: drift,
    improved,
    degraded,
    unchanged,
    total_kpis: entries.length,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Determine if a KPI delta is an improvement.
 * For cost/stockout metrics, lower is better. For service levels, higher is better.
 */
function isKpiImprovement(key, delta) {
  const lowerIsBetter = /cost|stockout|penalty|shortage|overdue|delay/i.test(key);
  return lowerIsBetter ? delta < 0 : delta > 0;
}

/**
 * Format a KPI delta for display.
 */
function formatKpiDelta(key, drift) {
  const { delta, pct_change } = drift;
  const sign = delta > 0 ? '+' : '';

  if (/cost/i.test(key)) {
    return `${sign}$${Math.abs(delta).toLocaleString()} (${sign}${(pct_change * 100).toFixed(1)}%)`;
  }
  if (/service_level|fill_rate/i.test(key)) {
    return `${sign}${(delta * 100).toFixed(2)} pp`;
  }
  return `${sign}${delta.toLocaleString()} (${sign}${(pct_change * 100).toFixed(1)}%)`;
}

/**
 * Build staleness warning messages for chat.
 * Returns an array of chat message objects if baseline is stale, empty array otherwise.
 */
export function buildStalenessWarningMessages({ baseline, currentKpis, datasetUpdatedAt }) {
  const staleness = checkBaselineStaleness({ baseline, currentKpis, datasetUpdatedAt });

  if (!staleness.isStale) return [];

  return [{
    role: 'ai',
    type: 'baseline_staleness_warning',
    payload: {
      reasons: staleness.reasons,
      age_hours: staleness.age_hours,
      drift: staleness.drift,
      suggested_actions: [
        { action_id: 'run_plan', label: 'Refresh Baseline', priority: 1 },
        { action_id: 'compare_plans', label: 'Compare Plans', priority: 2 },
      ],
    },
    timestamp: new Date().toISOString(),
  }];
}

export default {
  checkBaselineStaleness,
  computeKpiDrift,
  buildBaselineComparison,
  buildStalenessWarningMessages,
};
