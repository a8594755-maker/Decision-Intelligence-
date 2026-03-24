/**
 * chartColorSystem.js
 *
 * Unified semantic color system for all chart recipes.
 * Each color has a clear meaning — percentile segments, rankings, reference lines.
 */

// ── Semantic Colors ─────────────────────────────────────────────────────────

export const SEMANTIC_COLORS = Object.freeze({
  // Percentile segments (cool → warm = low → high)
  percentile: Object.freeze({
    p0_p10:   '#94a3b8', // slate-400  — bottom, inactive
    p10_p25:  '#8b5cf6', // violet     — low segment
    p25_p50:  '#3b82f6', // blue       — mid-low segment
    p50_p75:  '#10b981', // emerald    — mid-high segment
    p75_p90:  '#f59e0b', // amber      — high segment
    p90_p100: '#ef4444', // red        — top segment
  }),

  // Ranking (gold/silver/bronze + default)
  ranking: Object.freeze({
    first:   '#ef4444',
    second:  '#f59e0b',
    third:   '#f59e0b',
    default: '#3b82f6',
  }),

  // Reference lines
  reference: Object.freeze({
    median:  '#f59e0b',
    mean:    '#94a3b8',
    p90:     '#ef4444',
    target:  '#10b981',
  }),

  // Positive / Negative / Neutral
  sentiment: Object.freeze({
    positive: '#10b981',
    negative: '#ef4444',
    neutral:  '#94a3b8',
  }),
});

// ── Percentile Color Resolver ───────────────────────────────────────────────

/**
 * Get color for a value based on its position within percentile boundaries.
 *
 * @param {number} value - The value to color
 * @param {object} percentiles - { p10, p25, p50, p75, p90 }
 * @returns {string} Hex color
 */
export function getPercentileColor(value, percentiles) {
  if (value == null || !percentiles) return SEMANTIC_COLORS.percentile.p25_p50;
  if (value <= (percentiles.p10 ?? -Infinity)) return SEMANTIC_COLORS.percentile.p0_p10;
  if (value <= (percentiles.p25 ?? -Infinity)) return SEMANTIC_COLORS.percentile.p10_p25;
  if (value <= (percentiles.p50 ?? -Infinity)) return SEMANTIC_COLORS.percentile.p25_p50;
  if (value <= (percentiles.p75 ?? Infinity))  return SEMANTIC_COLORS.percentile.p50_p75;
  if (value <= (percentiles.p90 ?? Infinity))  return SEMANTIC_COLORS.percentile.p75_p90;
  return SEMANTIC_COLORS.percentile.p90_p100;
}

/**
 * Get ranking color (1st, 2nd, 3rd, or default).
 *
 * @param {number} rank - 1-based rank
 * @returns {string} Hex color
 */
export function getRankingColor(rank) {
  if (rank === 1) return SEMANTIC_COLORS.ranking.first;
  if (rank === 2) return SEMANTIC_COLORS.ranking.second;
  if (rank === 3) return SEMANTIC_COLORS.ranking.third;
  return SEMANTIC_COLORS.ranking.default;
}

/**
 * Build a colorMap object for histogram bars based on percentile thresholds.
 * Maps each bin label to its semantic color based on the bin midpoint.
 *
 * @param {Array<{label: string, midpoint: number}>} bins
 * @param {object} percentiles - { p10, p25, p50, p75, p90 }
 * @returns {object} { [binLabel]: hexColor }
 */
export function buildPercentileColorMap(bins, percentiles) {
  if (!Array.isArray(bins) || !percentiles) return {};
  const colorMap = {};
  for (const bin of bins) {
    if (bin?.label != null) {
      colorMap[bin.label] = getPercentileColor(bin.midpoint, percentiles);
    }
  }
  return colorMap;
}

/**
 * Standard reference line colors for common statistical markers.
 *
 * @param {'median'|'mean'|'p90'|'target'} type
 * @returns {string} Hex color
 */
export function getReferenceLineColor(type) {
  return SEMANTIC_COLORS.reference[type] || SEMANTIC_COLORS.reference.mean;
}
