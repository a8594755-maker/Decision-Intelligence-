// insightsAnalyticsEngine.js
// ─────────────────────────────────────────────────────────────────────────────
// Pure computation engine for the Insights Hub dashboard.
// Transforms raw analysis_snapshots into chart-ready data structures.
// Zero LLM cost — all deterministic.
// ─────────────────────────────────────────────────────────────────────────────

// ── Metric value parser ─────────────────────────────────────────────────────

const CURRENCY_PREFIXES = /^[R$€¥£]+\s*/;
const SUFFIX_MULTIPLIERS = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };
const DURATION_UNITS = /\s*(days?|hours?|weeks?|months?|mins?|minutes?|seconds?|yrs?|years?)$/i;

/**
 * Parse a metric value string into a number + unit.
 *
 * Examples:
 *   "R$1.2M"    → { value: 1200000, unit: '$' }
 *   "92%"       → { value: 92, unit: '%' }
 *   "4.2 days"  → { value: 4.2, unit: 'days' }
 *   "$850K"     → { value: 850000, unit: '$' }
 *   "1,234"     → { value: 1234, unit: '' }
 *   "N/A"       → { value: null, unit: '' }
 *
 * @param {string} str
 * @returns {{ value: number|null, unit: string }}
 */
export function parseMetricValue(str) {
  if (!str || typeof str !== 'string') return { value: null, unit: '' };

  let s = str.trim();
  let unit = '';

  // Detect and strip currency prefix
  const currencyMatch = s.match(CURRENCY_PREFIXES);
  if (currencyMatch) {
    unit = '$';
    s = s.replace(CURRENCY_PREFIXES, '');
  }

  // Detect and strip duration suffix
  const durationMatch = s.match(DURATION_UNITS);
  if (durationMatch) {
    unit = durationMatch[1].toLowerCase().replace(/s$/, '');
    if (unit === 'minute' || unit === 'min') unit = 'min';
    if (unit === 'yr') unit = 'year';
    s = s.replace(DURATION_UNITS, '');
  }

  // Detect percentage
  if (s.endsWith('%')) {
    unit = '%';
    s = s.slice(0, -1);
  }

  // Strip commas and whitespace
  s = s.replace(/,/g, '').trim();

  // Detect suffix multiplier (K, M, B, T)
  const lastChar = s.slice(-1).toLowerCase();
  let multiplier = 1;
  if (SUFFIX_MULTIPLIERS[lastChar] && s.length > 1) {
    multiplier = SUFFIX_MULTIPLIERS[lastChar];
    s = s.slice(0, -1);
  }

  // Parse number
  const num = parseFloat(s);
  if (Number.isNaN(num)) return { value: null, unit: '' };

  return { value: num * multiplier, unit };
}

// ── Metric label normalization ──────────────────────────────────────────────

const STRIP_PREFIXES = /^(total|avg|average|mean|median|sum|net|gross)\s+/i;
const STRIP_PARENS = /\s*\([^)]*\)\s*/g;

/**
 * Normalize a metric label for grouping.
 * "Total Revenue (R$)" and "Revenue" → "revenue"
 */
export function normalizeMetricLabel(label) {
  if (!label || typeof label !== 'string') return '';
  return label
    .trim()
    .replace(STRIP_PARENS, ' ')   // remove "(R$)" etc, leave space
    .replace(STRIP_PREFIXES, '')  // remove "Total ", "Avg " etc
    .replace(/\s+/g, ' ')        // collapse whitespace
    .trim()
    .toLowerCase();
}

// ── Metric evolution ────────────────────────────────────────────────────────

/**
 * Build metric evolution time-series from snapshot metric_pills.
 * Groups by normalized label, requires ≥2 data points.
 *
 * @param {object[]} snapshots
 * @returns {Array<{ label: string, unit: string, latest: number, delta: number|null, points: Array<{ date: string, value: number }> }>}
 */
export function buildMetricEvolution(snapshots) {
  if (!snapshots?.length) return [];

  // Collect all metric points grouped by normalized label
  const groups = {};

  for (const snap of snapshots) {
    const date = snap.created_at?.slice(0, 10);
    if (!date) continue;

    for (const pill of (snap.metric_pills || [])) {
      const normLabel = normalizeMetricLabel(pill.label);
      if (!normLabel) continue;

      const { value, unit } = parseMetricValue(pill.value);
      if (value === null) continue;

      if (!groups[normLabel]) {
        groups[normLabel] = { label: pill.label, unit, points: [] };
      }
      groups[normLabel].points.push({ date, value });
    }
  }

  // Filter to ≥2 points, sort by date, compute delta
  return Object.values(groups)
    .filter(g => g.points.length >= 2)
    .map(g => {
      const sorted = g.points.sort((a, b) => a.date.localeCompare(b.date));
      const latest = sorted[sorted.length - 1].value;
      const prev = sorted[sorted.length - 2].value;
      const delta = prev !== 0 ? ((latest - prev) / Math.abs(prev)) * 100 : null;
      return {
        label: g.label,
        unit: g.unit,
        latest,
        delta: delta !== null ? Math.round(delta * 10) / 10 : null,
        points: sorted,
      };
    })
    .sort((a, b) => b.points.length - a.points.length);
}

// ── Activity chart ──────────────────────────────────────────────────────────

/**
 * Build analysis activity bar chart data (reports per day).
 * Fills gaps with 0 for clean bar chart rendering.
 *
 * @param {object[]} snapshots
 * @param {number} [days=30]
 * @returns {Array<{ date: string, count: number }>}
 */
export function buildActivityChart(snapshots, days = 30) {
  const now = new Date();
  const buckets = {};

  // Initialize all days with 0
  for (let d = days - 1; d >= 0; d--) {
    const dt = new Date(now);
    dt.setDate(dt.getDate() - d);
    buckets[dt.toISOString().slice(0, 10)] = 0;
  }

  // Count snapshots per day
  for (const snap of (snapshots || [])) {
    const date = snap.created_at?.slice(0, 10);
    if (date && date in buckets) {
      buckets[date]++;
    }
  }

  return Object.entries(buckets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date: date.slice(5), count })); // MM-DD for compact labels
}

// ── Topic distribution ──────────────────────────────────────────────────────

/**
 * Build tag frequency distribution for donut chart.
 *
 * @param {object[]} snapshots
 * @returns {Array<{ name: string, value: number }>}
 */
export function buildTopicDistribution(snapshots) {
  if (!snapshots?.length) return [];

  const counts = {};
  for (const snap of snapshots) {
    for (const tag of (snap.tags || [])) {
      counts[tag] = (counts[tag] || 0) + 1;
    }
  }

  return Object.entries(counts)
    .map(([name, value]) => ({ name: name.charAt(0).toUpperCase() + name.slice(1), value }))
    .sort((a, b) => b.value - a.value);
}

// ── Top findings ────────────────────────────────────────────────────────────

/**
 * Aggregate and deduplicate key_findings across snapshots.
 * Ranked by frequency (how many reports mention the same finding).
 *
 * @param {object[]} snapshots
 * @param {number} [limit=8]
 * @returns {Array<{ text: string, frequency: number, tags: string[] }>}
 */
export function buildTopFindings(snapshots, limit = 8) {
  if (!snapshots?.length) return [];

  const findings = {};

  for (const snap of snapshots) {
    for (const finding of (snap.key_findings || [])) {
      const text = typeof finding === 'string' ? finding.trim() : '';
      if (text.length < 10) continue;

      // Normalize for dedup: lowercase, strip leading bullets/numbers
      const key = text.toLowerCase().replace(/^[-•*\d.)\s]+/, '').trim();
      if (!key) continue;

      if (!findings[key]) {
        findings[key] = { text, frequency: 0, tagsSet: new Set() };
      }
      findings[key].frequency++;
      (snap.tags || []).forEach(t => findings[key].tagsSet.add(t));
    }
  }

  return Object.values(findings)
    .map(f => ({ text: f.text, frequency: f.frequency, tags: [...f.tagsSet] }))
    .sort((a, b) => b.frequency - a.frequency || b.text.length - a.text.length)
    .slice(0, limit);
}

// ── Extract latest KPIs from snapshots ──────────────────────────────────────

/**
 * Extract the most recent unique KPI values from snapshot metric_pills.
 * Deduplicates by normalized label — newest snapshot wins.
 * Snapshots must be sorted newest-first (default from fetchSnapshots).
 *
 * @param {object[]} snapshots
 * @param {number} [limit=8]
 * @returns {Array<{ label: string, value: string, numericValue: number|null, unit: string, date: string, sourceHeadline: string }>}
 */
export function extractLatestKpis(snapshots, limit = 8) {
  if (!snapshots?.length) return [];

  const seen = new Map(); // normalized label → entry

  for (const snap of snapshots) {
    const date = snap.created_at?.slice(0, 10) || '';
    for (const pill of (snap.metric_pills || [])) {
      const normLabel = normalizeMetricLabel(pill.label);
      if (!normLabel || seen.has(normLabel)) continue;

      const { value: numericValue, unit } = parseMetricValue(pill.value);
      seen.set(normLabel, {
        label: pill.label,
        value: typeof pill.value === 'string' ? pill.value : String(pill.value ?? ''),
        numericValue,
        unit,
        date,
        sourceHeadline: snap.headline || '',
      });

      if (seen.size >= limit) return [...seen.values()];
    }
  }

  return [...seen.values()];
}

// ── Extract top charts from snapshots ───────────────────────────────────────

/**
 * Extract the best chart_specs from snapshots for direct rendering.
 * Deduplicates by chart title (newest wins). Requires data.length >= 2.
 * Returns objects directly compatible with ChartBlock/ChartRenderer.
 *
 * @param {object[]} snapshots
 * @param {number} [limit=6]
 * @returns {Array<{ type: string, data: object[], xKey: string, yKey: string, title: string, series?: object[], referenceLines?: object[], xAxisLabel?: string, yAxisLabel?: string, sourceHeadline: string, sourceDate: string }>}
 */
export function extractTopCharts(snapshots, limit = 6) {
  if (!snapshots?.length) return [];

  const seen = new Map(); // title → chart entry

  for (const snap of snapshots) {
    const sourceDate = snap.created_at?.slice(0, 10) || '';
    for (const chart of (snap.chart_specs || [])) {
      if (!chart?.data?.length || chart.data.length < 2) continue;
      if (!chart.type) continue;

      const title = (chart.title || `${chart.type} chart`).trim();
      const key = title.toLowerCase();
      if (seen.has(key)) continue;

      seen.set(key, {
        type: chart.type,
        data: chart.data,
        xKey: chart.xKey,
        yKey: chart.yKey,
        title,
        series: chart.series,
        referenceLines: chart.referenceLines,
        xAxisLabel: chart.xAxisLabel,
        yAxisLabel: chart.yAxisLabel,
        sourceHeadline: snap.headline || '',
        sourceDate,
      });

      if (seen.size >= limit) return [...seen.values()];
    }
  }

  return [...seen.values()];
}

// ── Extract top tables from snapshots ───────────────────────────────────────

/**
 * Extract the best table_specs from snapshots for direct rendering.
 * Requires valid columns and at least 1 row. Deduplicates by title.
 *
 * @param {object[]} snapshots
 * @param {number} [limit=3]
 * @returns {Array<{ columns: string[], rows: Array, title: string, sourceHeadline: string, sourceDate: string }>}
 */
export function extractTopTables(snapshots, limit = 3) {
  if (!snapshots?.length) return [];

  const seen = new Map();

  for (const snap of snapshots) {
    const sourceDate = snap.created_at?.slice(0, 10) || '';
    for (const table of (snap.table_specs || [])) {
      const cols = table?.columns || table?.headers;
      const rows = table?.rows || table?.data;
      if (!Array.isArray(cols) || !cols.length) continue;
      if (!Array.isArray(rows) || !rows.length) continue;

      const title = (table.title || 'Data Table').trim();
      const key = title.toLowerCase();
      if (seen.has(key)) continue;

      seen.set(key, {
        columns: cols,
        rows,
        title,
        sourceHeadline: snap.headline || '',
        sourceDate,
      });

      if (seen.size >= limit) return [...seen.values()];
    }
  }

  return [...seen.values()];
}

// ── Build aggregated insights summary ───────────────────────────────────────

/**
 * Aggregate findings, implications, caveats, and next_steps across snapshots.
 * Deduplicates findings. Returns structured summary for narrative blocks.
 *
 * @param {object[]} snapshots
 * @returns {{ findings: string[], implications: string[], caveats: string[], nextSteps: string[] }}
 */
export function buildInsightsSummary(snapshots) {
  if (!snapshots?.length) return { findings: [], implications: [], caveats: [], nextSteps: [] };

  // Reuse buildTopFindings for deduplication
  const topFindings = buildTopFindings(snapshots, 10);
  const findings = topFindings.map(f => f.text);

  // Collect unique implications, caveats, next_steps
  const implSet = new Set();
  const caveatSet = new Set();
  const nextSet = new Set();

  for (const snap of snapshots) {
    for (const item of (snap.implications || [])) {
      const t = typeof item === 'string' ? item.trim() : '';
      if (t.length >= 10) implSet.add(t);
    }
    for (const item of (snap.caveats || [])) {
      const t = typeof item === 'string' ? item.trim() : '';
      if (t.length >= 10) caveatSet.add(t);
    }
    for (const item of (snap.next_steps || [])) {
      const t = typeof item === 'string' ? item.trim() : '';
      if (t.length >= 10) nextSet.add(t);
    }
  }

  return {
    findings,
    implications: [...implSet].slice(0, 5),
    caveats: [...caveatSet].slice(0, 5),
    nextSteps: [...nextSet].slice(0, 5),
  };
}

// ── Cross-metric analysis ───────────────────────────────────────────────────

/**
 * Analyze metrics across snapshots: find anomalies, correlations, and generate
 * cross-metric insights. Pure computation — zero LLM cost.
 *
 * @param {object[]} snapshots
 * @returns {{ anomalies: object[], correlations: object[], insights: string[] }}
 */
export function analyzeCrossMetrics(snapshots) {
  if (!snapshots?.length) return { anomalies: [], correlations: [], insights: [] };

  const evolution = buildMetricEvolution(snapshots);
  const kpis = extractLatestKpis(snapshots, 20);

  // ── 1. Anomalies: metrics with large delta (|delta| > 20%) ──
  const anomalies = evolution
    .filter(m => m.delta != null && Math.abs(m.delta) > 20)
    .map(m => ({
      metric: m.label,
      latest: m.latest,
      delta: m.delta,
      unit: m.unit,
      direction: m.delta > 0 ? 'up' : 'down',
      severity: Math.abs(m.delta) > 50 ? 'high' : 'medium',
    }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  // ── 2. Correlations: metrics that move in the same or opposite direction ──
  const correlations = [];
  for (let i = 0; i < evolution.length; i++) {
    for (let j = i + 1; j < evolution.length; j++) {
      const a = evolution[i];
      const b = evolution[j];
      if (a.delta == null || b.delta == null) continue;

      // Both have significant movement
      if (Math.abs(a.delta) < 10 || Math.abs(b.delta) < 10) continue;

      const sameDirection = (a.delta > 0) === (b.delta > 0);
      correlations.push({
        metricA: a.label,
        metricB: b.label,
        deltaA: a.delta,
        deltaB: b.delta,
        relationship: sameDirection ? 'co-moving' : 'diverging',
      });
    }
  }

  // ── 3. Generate insights from patterns ──
  const insights = [];

  // Revenue vs Cost divergence
  const revenueMetric = evolution.find(m => normalizeMetricLabel(m.label).includes('revenue'));
  const costMetric = evolution.find(m => normalizeMetricLabel(m.label).includes('cost'));
  if (revenueMetric?.delta != null && costMetric?.delta != null) {
    if (costMetric.delta > revenueMetric.delta + 5) {
      insights.push(`Costs growing faster than revenue (${costMetric.label}: ${costMetric.delta > 0 ? '+' : ''}${costMetric.delta}% vs ${revenueMetric.label}: ${revenueMetric.delta > 0 ? '+' : ''}${revenueMetric.delta}%) — margin pressure detected`);
    } else if (revenueMetric.delta > costMetric.delta + 10) {
      insights.push(`Revenue outpacing costs (${revenueMetric.label}: +${revenueMetric.delta}% vs ${costMetric.label}: ${costMetric.delta > 0 ? '+' : ''}${costMetric.delta}%) — improving margins`);
    }
  }

  // Inventory vs Demand divergence
  const inventoryMetric = evolution.find(m => normalizeMetricLabel(m.label).includes('inventory'));
  const demandMetric = evolution.find(m => {
    const norm = normalizeMetricLabel(m.label);
    return norm.includes('demand') || norm.includes('order') || norm.includes('sales');
  });
  if (inventoryMetric?.delta != null && demandMetric?.delta != null) {
    if (inventoryMetric.delta < -10 && demandMetric.delta > 5) {
      insights.push(`Inventory declining (${inventoryMetric.delta}%) while demand rising (${demandMetric.delta > 0 ? '+' : ''}${demandMetric.delta}%) — potential supply risk`);
    }
  }

  // High anomaly alerts
  for (const a of anomalies.slice(0, 3)) {
    if (a.severity === 'high') {
      insights.push(`${a.metric} changed ${a.delta > 0 ? '+' : ''}${a.delta}% — significant ${a.direction === 'up' ? 'increase' : 'decrease'} detected`);
    }
  }

  // Data freshness
  if (snapshots.length > 0) {
    const latestDate = snapshots[0].created_at?.slice(0, 10);
    const daysSinceLatest = latestDate
      ? Math.floor((Date.now() - new Date(latestDate).getTime()) / (24 * 60 * 60 * 1000))
      : null;
    if (daysSinceLatest != null && daysSinceLatest > 7) {
      insights.push(`Latest analysis is ${daysSinceLatest} days old — consider running fresh analyses`);
    }
  }

  return { anomalies, correlations, insights };
}
