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
