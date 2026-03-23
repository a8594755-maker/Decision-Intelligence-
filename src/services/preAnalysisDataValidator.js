/**
 * Pre-Analysis Data Validator
 *
 * Generic, domain-agnostic validation layer that inspects SQL query result rows
 * for statistical properties that should influence how the agent interprets data.
 *
 * 3-layer design:
 *   Layer 1: Deterministic checks on rows (this file)
 *   Layer 2: Prompt instructions injected into agent loop (chatAgentLoop.js)
 *   Layer 3: QA enforcement penalizes unacknowledged warnings (agentResponsePresentationService.js)
 */

// ── Column Type Detection ───────────────────────────────────────────────────

const DATE_COL_PATTERN = /date|time|month|week|year|period|quarter|日期|月份|期間|季度/i;
const ENTITY_COL_PATTERN = /store_id|warehouse_id|plant_id|region|location|branch|site|門市|倉庫|廠區/i;
const SELLER_PATTERN = /seller|vendor|supplier|賣家|供應商|廠商/i;
const CUSTOMER_PATTERN = /customer|buyer|client|顧客|客戶|買家/i;
const AGG_PREFIX_PATTERN = /^(avg|sum|count|total|mean|max|min|std|median)_/i;

function isDateColumn(colName) {
  return DATE_COL_PATTERN.test(colName);
}

function isNumericValue(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function getNumericColumns(rows, columns) {
  return columns.filter((col) => {
    const sample = rows.slice(0, 20);
    const numericCount = sample.filter((r) => isNumericValue(r[col])).length;
    return numericCount > sample.length * 0.7;
  });
}

function findDateColumn(columns) {
  return columns.find((c) => isDateColumn(c)) || null;
}

function parseDateValue(val) {
  if (!val) return null;
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? null : d;
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// ── Check Functions ─────────────────────────────────────────────────────────

export function checkTimeSeriesStationarity(rows, columns) {
  const warnings = [];
  const dateCol = findDateColumn(columns);
  if (!dateCol) return warnings;

  const numericCols = getNumericColumns(rows, columns).filter((c) => c !== dateCol);

  for (const col of numericCols) {
    const validRows = rows.filter((r) => parseDateValue(r[dateCol]) && isNumericValue(r[col]));
    const sorted = [...validRows].sort((a, b) => parseDateValue(a[dateCol]) - parseDateValue(b[dateCol]));
    const mid = Math.floor(sorted.length / 2);
    if (mid < 3) continue; // need at least 6 data points

    const firstHalf = sorted.slice(0, mid).map((r) => r[col]);
    const secondHalf = sorted.slice(mid).map((r) => r[col]);
    const meanFirst = mean(firstHalf);
    const meanSecond = mean(secondHalf);

    if (Math.abs(meanFirst) < 1e-9) continue;
    const pctChange = (meanSecond - meanFirst) / Math.abs(meanFirst);

    if (Math.abs(pctChange) > 0.15) {
      const direction = pctChange > 0 ? 'upward' : 'downward';
      warnings.push({
        id: 'non_stationary_trend',
        severity: 'high',
        category: 'statistical',
        column: col,
        message: `Column "${col}" shows a ${Math.round(Math.abs(pctChange) * 100)}% ${direction} trend over the time range. Raw standard deviation will overstate variability.`,
        instruction: `Decompose the trend in "${col}" before computing variability metrics. Use detrended residuals, or apply a rolling window of recent periods only.`,
      });
    }
  }
  return warnings;
}

export function checkSeasonality(rows, columns) {
  const warnings = [];
  const dateCol = findDateColumn(columns);
  if (!dateCol) return warnings;

  const numericCols = getNumericColumns(rows, columns).filter((c) => c !== dateCol);

  for (const col of numericCols) {
    const monthBuckets = {};
    for (const row of rows) {
      const d = parseDateValue(row[dateCol]);
      if (!d || !isNumericValue(row[col])) continue;
      const month = d.getMonth(); // 0-11
      if (!monthBuckets[month]) monthBuckets[month] = [];
      monthBuckets[month].push(row[col]);
    }

    const distinctMonths = Object.keys(monthBuckets);
    if (distinctMonths.length < 4) continue; // need data across several months

    const monthlyMeans = distinctMonths.map((m) => mean(monthBuckets[m]));
    const overallMean = mean(monthlyMeans);
    if (Math.abs(overallMean) < 1e-9) continue;

    const cv = std(monthlyMeans) / Math.abs(overallMean);
    if (cv > 0.20) {
      warnings.push({
        id: 'seasonal_pattern',
        severity: 'medium',
        category: 'statistical',
        column: col,
        message: `Column "${col}" shows seasonal variation (CV across months: ${(cv * 100).toFixed(0)}%). Aggregate statistics may be misleading.`,
        instruction: `Seasonal patterns detected in "${col}". Decompose seasonality before computing aggregate statistics, or analyze per-season separately.`,
      });
      break; // one seasonal warning per query is enough
    }
  }
  return warnings;
}

export function checkSampleSize(rows, columns) {
  const warnings = [];
  const dateCol = findDateColumn(columns);

  if (rows.length < 30) {
    const severity = rows.length < 12 ? 'high' : 'medium';
    warnings.push({
      id: 'small_sample',
      severity,
      category: 'statistical',
      column: null,
      message: `Only ${rows.length} rows returned. Statistics computed from small samples are unreliable.`,
      instruction: `With only ${rows.length} data points, use robust estimators (median, IQR) instead of mean/std. State confidence intervals or explicitly caveat the small sample.`,
    });
  }

  if (dateCol) {
    const distinctPeriods = new Set();
    for (const row of rows) {
      const d = parseDateValue(row[dateCol]);
      if (d) distinctPeriods.add(`${d.getFullYear()}-${d.getMonth()}`);
    }
    if (distinctPeriods.size > 0 && distinctPeriods.size < 12) {
      warnings.push({
        id: 'small_sample',
        severity: 'high',
        category: 'statistical',
        column: dateCol,
        message: `Only ${distinctPeriods.size} distinct time periods in the data. Time-series statistics require at least 12 periods for reliability.`,
        instruction: `With only ${distinctPeriods.size} periods, seasonal patterns and trends cannot be reliably detected. Caveat any time-series conclusions.`,
      });
    }
  }

  return warnings;
}

export function checkOutlierContamination(rows, columns) {
  const warnings = [];
  const numericCols = getNumericColumns(rows, columns);

  for (const col of numericCols) {
    const values = rows.map((r) => r[col]).filter(isNumericValue);
    if (values.length < 10) continue;

    const sorted = [...values].sort((a, b) => a - b);
    const q1 = quantile(sorted, 0.25);
    const q3 = quantile(sorted, 0.75);
    const iqr = q3 - q1;
    if (iqr < 1e-9) continue;

    const lowerBound = q1 - 3 * iqr;
    const upperBound = q3 + 3 * iqr;
    const outlierCount = values.filter((v) => v < lowerBound || v > upperBound).length;
    const outlierPct = outlierCount / values.length;

    if (outlierPct > 0.05) {
      warnings.push({
        id: 'outlier_contamination',
        severity: 'medium',
        category: 'statistical',
        column: col,
        message: `Column "${col}" has ${(outlierPct * 100).toFixed(1)}% extreme outliers (>3×IQR). Mean and std will be heavily influenced.`,
        instruction: `Consider using robust statistics (median, trimmed mean) for "${col}", or investigate outliers before aggregating.`,
      });
    }
  }
  return warnings;
}

export function checkHighCardinality(rows, columns) {
  const warnings = [];
  const numericCols = new Set(getNumericColumns(rows, columns));
  const dateCol = findDateColumn(columns);

  const categoricalCols = columns.filter((c) => !numericCols.has(c) && c !== dateCol);

  for (const col of categoricalCols) {
    const groups = {};
    for (const row of rows) {
      const key = String(row[col] ?? '');
      if (!groups[key]) groups[key] = 0;
      groups[key]++;
    }

    const groupCount = Object.keys(groups).length;
    if (groupCount < 2) continue;

    const avgPerGroup = rows.length / groupCount;
    if (avgPerGroup < 5 && groupCount > 1) {
      warnings.push({
        id: 'insufficient_groups',
        severity: 'medium',
        category: 'statistical',
        column: col,
        message: `Column "${col}" has ${groupCount} groups but only ${avgPerGroup.toFixed(1)} observations per group on average. Per-group statistics are unreliable.`,
        instruction: `With few observations per group in "${col}", consider pooling similar groups or caveating per-group statistics.`,
      });
      break; // one warning is enough
    }
  }
  return warnings;
}

export function checkDataGaps(rows, columns) {
  const warnings = [];
  const dateCol = findDateColumn(columns);
  if (!dateCol) return warnings;

  const dates = rows
    .map((r) => parseDateValue(r[dateCol]))
    .filter(Boolean)
    .sort((a, b) => a - b);

  if (dates.length < 6) return warnings;

  // Detect monthly gaps
  const monthSet = new Set();
  for (const d of dates) {
    monthSet.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }

  const sortedMonths = [...monthSet].sort();
  if (sortedMonths.length < 3) return warnings;

  let gapCount = 0;
  for (let i = 1; i < sortedMonths.length; i++) {
    const [prevY, prevM] = sortedMonths[i - 1].split('-').map(Number);
    const [currY, currM] = sortedMonths[i].split('-').map(Number);
    const expectedNext = prevM === 12 ? `${prevY + 1}-01` : `${prevY}-${String(prevM + 1).padStart(2, '0')}`;
    if (`${currY}-${String(currM).padStart(2, '0')}` !== expectedNext) {
      gapCount++;
    }
  }

  if (gapCount > 0) {
    warnings.push({
      id: 'data_gaps',
      severity: 'medium',
      category: 'completeness',
      column: dateCol,
      message: `${gapCount} gap(s) found in the time series (missing months). Aggregated statistics may be biased.`,
      instruction: 'Account for missing periods when computing averages and standard deviations. State which periods are missing.',
    });
  }

  return warnings;
}

// ── Business Context Detection ──────────────────────────────────────────────

export function detectBusinessContext(sampleRows) {
  if (!Array.isArray(sampleRows) || sampleRows.length === 0) return [];

  const allColumns = new Set();
  for (const row of sampleRows.slice(0, 20)) {
    if (row && typeof row === 'object') {
      Object.keys(row).forEach((k) => allColumns.add(k));
    }
  }

  const colList = [...allColumns];
  const clues = [];

  // 1. Multi-party marketplace detection
  const hasSeller = colList.some((c) => SELLER_PATTERN.test(c));
  const hasCustomer = colList.some((c) => CUSTOMER_PATTERN.test(c));
  if (hasSeller && hasCustomer) {
    clues.push({
      id: 'multi_party_marketplace',
      message: 'Data contains both seller and customer entities, suggesting a marketplace model. Aggregate recommendations may not be actionable — each seller/vendor controls their own operations independently.',
      shortMessage: 'Marketplace data — aggregate recommendations may not be actionable per-seller.',
      acknowledgmentPatterns: [/marketplace|multi.?party|per.?seller|individual.?seller|per.?vendor|各賣家|平台|賣家各自/i],
    });
  }

  // 2. Multi-entity detection
  const entityCols = colList.filter((c) => ENTITY_COL_PATTERN.test(c));
  for (const col of entityCols) {
    const unique = new Set(sampleRows.map((r) => r[col]).filter((v) => v != null));
    if (unique.size > 1) {
      clues.push({
        id: 'multi_entity',
        message: `Data spans ${unique.size} distinct ${col} values. Pooling all entities may mask significant per-entity differences.`,
        shortMessage: `Multi-entity data (${col}) — consider per-entity analysis.`,
        acknowledgmentPatterns: [/per.?entity|per.?store|per.?warehouse|per.?plant|segmented|individual|各.*分別|分.*分析/i],
      });
      break; // one is enough
    }
  }

  // 3. Pre-aggregated data detection
  const aggCols = colList.filter((c) => AGG_PREFIX_PATTERN.test(c));
  if (aggCols.length >= 2) {
    clues.push({
      id: 'pre_aggregated',
      message: `Data appears pre-aggregated (columns: ${aggCols.slice(0, 3).join(', ')}${aggCols.length > 3 ? '...' : ''}). Computing standard deviation or percentiles from aggregated data will be misleading.`,
      shortMessage: 'Pre-aggregated data — individual-level statistics will be unreliable.',
      acknowledgmentPatterns: [/aggregat|pre.?comput|already.*summar|已彙總|已聚合|聚合/i],
    });
  }

  // 4. Time window detection
  const dateCol = findDateColumn(colList);
  if (dateCol) {
    const dates = sampleRows
      .map((r) => parseDateValue(r[dateCol]))
      .filter(Boolean)
      .sort((a, b) => a - b);

    if (dates.length >= 2) {
      const rangeMs = dates[dates.length - 1] - dates[0];
      const rangeDays = rangeMs / (1000 * 60 * 60 * 24);

      if (rangeDays < 90) {
        clues.push({
          id: 'short_time_window',
          message: `Time window is only ${Math.round(rangeDays)} days. Short windows may miss seasonality and yield unreliable trend estimates.`,
          shortMessage: 'Short time window — may miss seasonality.',
          acknowledgmentPatterns: [/short.*window|limited.*period|brief.*period|時間.*短|期間.*不足/i],
        });
      } else if (rangeDays > 1095) {
        clues.push({
          id: 'long_time_window',
          message: `Time window spans ${(rangeDays / 365).toFixed(1)} years. Long windows may include structural breaks, regime changes, or obsolete patterns.`,
          shortMessage: 'Long time window — may include structural breaks.',
          acknowledgmentPatterns: [/structural.*break|regime.*change|long.*window|時間.*長|結構.*變化/i],
        });
      }
    }
  }

  return clues;
}

// ── Main Entry Point ────────────────────────────────────────────────────────

export function validateQueryResultData(rows, columns, sql) {
  if (!Array.isArray(rows) || rows.length === 0 || !Array.isArray(columns) || columns.length === 0) {
    return { warnings: [] };
  }

  const warnings = [
    ...checkTimeSeriesStationarity(rows, columns),
    ...checkSeasonality(rows, columns),
    ...checkSampleSize(rows, columns),
    ...checkOutlierContamination(rows, columns),
    ...checkHighCardinality(rows, columns),
    ...checkDataGaps(rows, columns),
  ];

  return { warnings };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function formatWarningsForAgent(warnings) {
  if (!Array.isArray(warnings) || warnings.length === 0) return '';

  return warnings.map((w) => {
    const severity = w.severity === 'high' ? '🔴 HIGH' : '🟡 MEDIUM';
    return `${severity}: ${w.message}\n   → Action: ${w.instruction}`;
  }).join('\n\n');
}

export function getWarningIds(warnings) {
  if (!Array.isArray(warnings)) return [];
  return warnings.map((w) => w.id);
}

// ── Proxy Disclosure Prompt (static, injected into system prompt) ───────────

export const PROXY_DISCLOSURE_PROMPT = `
PROXY METRIC DISCLOSURE (MANDATORY):
When the dataset lacks the exact column needed for your analysis, you may use a related column as a proxy. If you do, you MUST:
1. State explicitly: "⚠️ Proxy: Using [actual_column] as proxy for [ideal_column]"
2. Explain WHY it is a reasonable proxy (or why it may not be)
3. State the direction and magnitude of potential bias
4. If the proxy is weak (e.g., customer delivery time as proxy for supplier lead time), add a caveat that the recommendation should be validated with actual data
Failure to disclose proxy usage is a QA failure.
`.trim();

// ── QA Warning Acknowledgment Patterns ──────────────────────────────────────

export const WARNING_ACKNOWLEDGMENT_PATTERNS = {
  non_stationary_trend: [/trend|non.?stationary|detrend|growth|decline|趨勢|非平穩|去趨勢/i],
  seasonal_pattern: [/season|decompos|季節|分解/i],
  small_sample: [/small sample|few.*observation|limited data|樣本.*小|觀察.*少|資料不足/i],
  outlier_contamination: [/outlier|robust|trimmed|離群|異常值/i],
  insufficient_groups: [/few.*per.*group|small.*group|分組.*少/i],
  data_gaps: [/gap|missing.*period|incomplete.*time|缺漏|遺漏/i],
};

export default {
  validateQueryResultData,
  formatWarningsForAgent,
  getWarningIds,
  detectBusinessContext,
  checkTimeSeriesStationarity,
  checkSeasonality,
  checkSampleSize,
  checkOutlierContamination,
  checkHighCardinality,
  checkDataGaps,
  PROXY_DISCLOSURE_PROMPT,
  WARNING_ACKNOWLEDGMENT_PATTERNS,
};
