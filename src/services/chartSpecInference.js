/**
 * chartSpecInference.js
 *
 * Universal chart type inference from tabular data.
 * Works with ANY dataset — no hardcoded column names.
 * Analyzes column types (numeric, date, categorical), cardinality,
 * and value distributions to recommend the best chart type.
 *
 * Usage:
 *   import { inferChartSpec } from './chartSpecInference';
 *   const spec = inferChartSpec(rows);
 *   // → { type, xKey, yKey, compatibleTypes } | null
 */

// ── Column Type Detection ────────────────────────────────────────────────────

const DATE_PATTERNS = [
  /^\d{4}-\d{2}-\d{2}$/,                       // 2024-01-15
  /^\d{4}-\d{2}$/,                              // 2024-01
  /^\d{4}\/\d{2}\/\d{2}$/,                      // 2024/01/15
  /^\d{4}-\d{2}-\d{2}T/,                        // ISO datetime
  /^\d{2}\/\d{2}\/\d{4}$/,                      // MM/DD/YYYY or DD/MM/YYYY
];

/**
 * Sample up to N rows for type detection (avoid scanning huge datasets).
 */
const SAMPLE_SIZE = 100;

function sampleRows(rows) {
  if (rows.length <= SAMPLE_SIZE) return rows;
  const step = Math.floor(rows.length / SAMPLE_SIZE);
  return rows.filter((_, i) => i % step === 0).slice(0, SAMPLE_SIZE);
}

/**
 * Classify a column based on its values.
 * Returns { isNumeric, isDate, isCategorical, uniqueCount }.
 */
function classifyColumn(rows, colName) {
  const sample = sampleRows(rows);
  const values = sample.map(r => r[colName]).filter(v => v != null && v !== '');
  if (values.length === 0) return { isNumeric: false, isDate: false, isCategorical: false, uniqueCount: 0 };

  // Count numeric values
  let numericCount = 0;
  for (const v of values) {
    if (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)))) {
      numericCount++;
    }
  }
  const isNumeric = numericCount / values.length >= 0.8;

  // Count date-like values
  let dateCount = 0;
  if (!isNumeric) {
    for (const v of values) {
      const s = String(v).trim();
      if (DATE_PATTERNS.some(p => p.test(s))) {
        dateCount++;
      }
    }
  }
  const isDate = dateCount / values.length >= 0.7;

  // Unique values
  const uniqueSet = new Set(values.map(v => String(v)));
  const uniqueCount = uniqueSet.size;

  // Categorical: string, not date, not numeric.
  // For small datasets (≤50 rows), any non-numeric non-date string is categorical.
  // For larger datasets, require unique values < 50% of rows to filter out IDs/free text.
  const isCategorical = !isNumeric && !isDate && values.length > 0 &&
    (rows.length <= 50 || uniqueCount < rows.length * 0.5);

  return { isNumeric, isDate, isCategorical, uniqueCount };
}

// ── Proportion Detection ─────────────────────────────────────────────────────

/**
 * Check if numeric values look like percentages (sum ≈ 100) or proportions (sum ≈ 1.0).
 */
function looksLikeProportion(rows, yKey) {
  const values = rows.map(r => Number(r[yKey])).filter(v => !isNaN(v));
  if (values.length === 0) return false;
  if (values.some(v => v < 0)) return false;
  const sum = values.reduce((a, b) => a + b, 0);
  return (Math.abs(sum - 100) <= 5) || (Math.abs(sum - 1.0) <= 0.05);
}

// ── Main Inference ───────────────────────────────────────────────────────────

/**
 * Infer the best chart spec from tabular data.
 *
 * @param {Array<Record<string, any>>} rows — query result rows
 * @returns {{ type: string, xKey: string, yKey: string, compatibleTypes: string[] } | null}
 */
export function inferChartSpec(rows) {
  if (!rows || rows.length === 0) return null;

  const columns = Object.keys(rows[0]);
  if (columns.length < 2) return null;

  // Classify all columns
  const colInfo = {};
  for (const col of columns) {
    colInfo[col] = classifyColumn(rows, col);
  }

  const numericCols = columns.filter(c => colInfo[c].isNumeric);
  const dateCols = columns.filter(c => colInfo[c].isDate);
  const catCols = columns.filter(c => colInfo[c].isCategorical);

  // ── Rule 1: Date + Numeric → Line (time series) ──────────────────────────
  if (dateCols.length >= 1 && numericCols.length >= 1) {
    const xKey = dateCols[0];
    if (numericCols.length === 1) {
      return {
        type: 'line',
        xKey,
        yKey: numericCols[0],
        compatibleTypes: ['line', 'area', 'bar'],
      };
    }
    // Multiple numeric → multi-series line
    return {
      type: 'line',
      xKey,
      yKey: numericCols[0],
      series: numericCols,
      compatibleTypes: ['line', 'area', 'stacked_bar', 'grouped_bar'],
    };
  }

  // ── Rule 2: Categorical + 1 Numeric ──────────────────────────────────────
  if (catCols.length >= 1 && numericCols.length === 1) {
    const xKey = catCols[0];
    const yKey = numericCols[0];
    const unique = colInfo[xKey].uniqueCount;

    // Small cardinality + proportion-like → pie
    if (unique <= 8 && looksLikeProportion(rows, yKey)) {
      return {
        type: 'pie',
        xKey,
        yKey,
        compatibleTypes: ['pie', 'donut', 'bar', 'horizontal_bar'],
      };
    }

    // Up to 30 categories → horizontal bar (ranking)
    if (unique <= 30) {
      return {
        type: 'horizontal_bar',
        xKey,
        yKey,
        compatibleTypes: ['horizontal_bar', 'bar', 'pie', 'donut'],
      };
    }

    // Many categories → vertical bar (truncate display in chart)
    return {
      type: 'bar',
      xKey,
      yKey,
      compatibleTypes: ['bar', 'horizontal_bar'],
    };
  }

  // ── Rule 3: Categorical + 2+ Numeric → Grouped bar ──────────────────────
  if (catCols.length >= 1 && numericCols.length >= 2) {
    return {
      type: 'grouped_bar',
      xKey: catCols[0],
      yKey: numericCols[0],
      series: numericCols,
      compatibleTypes: ['grouped_bar', 'stacked_bar', 'bar'],
    };
  }

  // ── Rule 4: 2+ Numeric only → Scatter ────────────────────────────────────
  if (numericCols.length >= 2 && catCols.length === 0 && dateCols.length === 0) {
    return {
      type: 'scatter',
      xKey: numericCols[0],
      yKey: numericCols[1],
      compatibleTypes: ['scatter', 'line'],
    };
  }

  // ── No good chart match ──────────────────────────────────────────────────
  return null;
}

/**
 * Given an existing chart spec, compute compatible types for the switcher.
 * Used when the LLM provides a chart type but not compatibleTypes.
 */
export function getCompatibleTypes(chartType, rows) {
  if (!rows || rows.length === 0) return [chartType];

  // Try full inference to get compatibleTypes
  const inferred = inferChartSpec(rows);
  if (inferred?.compatibleTypes) {
    // Ensure the requested type is included
    const types = inferred.compatibleTypes.includes(chartType)
      ? inferred.compatibleTypes
      : [chartType, ...inferred.compatibleTypes];
    return types;
  }

  // Fallback: common pairings
  const PAIRINGS = {
    bar: ['bar', 'horizontal_bar', 'pie'],
    horizontal_bar: ['horizontal_bar', 'bar', 'pie'],
    line: ['line', 'area', 'bar'],
    area: ['area', 'line', 'bar'],
    pie: ['pie', 'donut', 'bar'],
    donut: ['donut', 'pie', 'bar'],
    scatter: ['scatter', 'line'],
    stacked_bar: ['stacked_bar', 'grouped_bar', 'bar'],
    grouped_bar: ['grouped_bar', 'stacked_bar', 'bar'],
  };

  return PAIRINGS[chartType] || [chartType];
}
