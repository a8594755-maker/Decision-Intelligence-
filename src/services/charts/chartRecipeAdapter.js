/**
 * chartRecipeAdapter.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Adapts chart recipes for arbitrary datasets by resolving column mappings.
 *
 * The problem: existing 50+ chart recipes hardcode Olist table/column names.
 * This adapter provides a bridge layer that:
 *   1. Detects column semantics from any uploaded dataset (date, numeric, category)
 *   2. Maps generic recipe params to actual column names
 *   3. Injects dataset rows as JSON into recipe_params.data_json
 *
 * Generic recipes (chartRecipes_generic.js) use data_json natively.
 * Domain recipes can be adapted via column name substitution.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { datasetProfilesService } from '../data-prep/datasetProfilesService';

// ── Column Semantic Detection ───────────────────────────────────────────────

/**
 * Detect column semantics from row data.
 * @param {Object[]} rows - Dataset rows
 * @returns {{ dateColumns: string[], numericColumns: string[], categoryColumns: string[], idColumns: string[] }}
 */
export function detectColumnSemantics(rows) {
  if (!rows?.length) return { dateColumns: [], numericColumns: [], categoryColumns: [], idColumns: [] };

  const columns = Object.keys(rows[0]);
  const sample = rows.slice(0, Math.min(100, rows.length));

  const dateColumns = [];
  const numericColumns = [];
  const categoryColumns = [];
  const idColumns = [];

  for (const col of columns) {
    const values = sample.map(r => r[col]).filter(v => v != null && v !== '');
    if (values.length === 0) continue;

    // Check if numeric
    const numCount = values.filter(v => !isNaN(Number(v))).length;
    const numRatio = numCount / values.length;

    // Check if date
    const dateCount = values.filter(v => {
      const d = new Date(v);
      return !isNaN(d.getTime()) && String(v).length > 4;
    }).length;
    const dateRatio = dateCount / values.length;

    // Check uniqueness
    const uniqueRatio = new Set(values.map(String)).size / values.length;

    if (dateRatio > 0.7 && numRatio < 0.5) {
      dateColumns.push(col);
    } else if (numRatio > 0.8) {
      numericColumns.push(col);
    } else if (uniqueRatio > 0.9 && values.length > 10) {
      idColumns.push(col);
    } else {
      categoryColumns.push(col);
    }
  }

  return { dateColumns, numericColumns, categoryColumns, idColumns };
}

/**
 * Prepare recipe params for a generic recipe by injecting dataset data and column mappings.
 *
 * @param {Object} params
 * @param {string} params.datasetId - Dataset profile ID
 * @param {string} params.recipeId - Recipe ID from catalog
 * @param {Object} [params.overrides] - User-specified column overrides
 * @param {number} [params.maxRows=5000] - Max rows to pass to Python
 * @returns {{ recipe_params: Object, columns: Object }}
 */
export function prepareGenericRecipeParams({ datasetId, recipeId, overrides = {}, maxRows = 5000 }) {
  const profile = datasetProfilesService.getById(datasetId);
  if (!profile) throw new Error(`Dataset profile not found: ${datasetId}`);

  const rawRows = profile.sheets?.[0]?.rows
    || profile.data?.rows
    || profile.rows
    || [];

  if (rawRows.length === 0) throw new Error('Dataset has no rows');

  const rows = rawRows.length > maxRows ? rawRows.slice(0, maxRows) : rawRows;
  const semantics = detectColumnSemantics(rows);

  // Build column mapping
  const columnMapping = {
    date: overrides.date_col || semantics.dateColumns[0] || null,
    numeric: overrides.value_cols
      ? overrides.value_cols.split(',').map(s => s.trim())
      : semantics.numericColumns,
    category: overrides.category_col || overrides.group_col || semantics.categoryColumns[0] || null,
    id: semantics.idColumns[0] || null,
  };

  // Build recipe_params with data_json and detected columns
  const recipeParams = {
    data_json: JSON.stringify(rows),
    ...overrides,
  };

  // Auto-fill common params if not overridden
  if (!recipeParams.date_col && columnMapping.date) {
    recipeParams.date_col = columnMapping.date;
  }
  if (!recipeParams.value_col && columnMapping.numeric.length > 0) {
    recipeParams.value_col = columnMapping.numeric[0];
  }
  if (!recipeParams.value_cols && columnMapping.numeric.length > 0) {
    recipeParams.value_cols = columnMapping.numeric.slice(0, 5).join(',');
  }
  if (!recipeParams.group_col && columnMapping.category) {
    recipeParams.group_col = columnMapping.category;
  }
  if (!recipeParams.category_col && columnMapping.category) {
    recipeParams.category_col = columnMapping.category;
  }
  if (!recipeParams.x_col && columnMapping.numeric.length >= 2) {
    recipeParams.x_col = columnMapping.numeric[0];
  }
  if (!recipeParams.y_col && columnMapping.numeric.length >= 2) {
    recipeParams.y_col = columnMapping.numeric[1];
  }

  return { recipe_params: recipeParams, columns: columnMapping };
}

/**
 * Suggest the best generic recipe for a dataset based on its shape.
 *
 * @param {string} datasetId
 * @returns {string[]} Ordered list of recommended recipe IDs
 */
export function suggestGenericRecipes(datasetId) {
  const profile = datasetProfilesService.getById(datasetId);
  if (!profile) return [];

  const rawRows = profile.sheets?.[0]?.rows
    || profile.data?.rows
    || profile.rows
    || [];

  if (rawRows.length === 0) return [];

  const semantics = detectColumnSemantics(rawRows);
  const suggestions = [];

  // Always suggest missing data check and distribution overview
  suggestions.push('generic_missing_data_heatmap');
  suggestions.push('generic_distribution_grid');

  // If has date column, suggest time series
  if (semantics.dateColumns.length > 0 && semantics.numericColumns.length > 0) {
    suggestions.push('generic_time_series_multi');
  }

  // If has 2+ numeric columns, suggest correlation and scatter
  if (semantics.numericColumns.length >= 2) {
    suggestions.push('generic_correlation_matrix');
    suggestions.push('generic_scatter_with_regression');
  }

  // If has category column, suggest group comparison and box plot
  if (semantics.categoryColumns.length > 0 && semantics.numericColumns.length > 0) {
    suggestions.push('generic_group_comparison');
    suggestions.push('generic_top_n_bar');
    suggestions.push('generic_box_plot_by_group');
  }

  return suggestions;
}

export default {
  detectColumnSemantics,
  prepareGenericRecipeParams,
  suggestGenericRecipes,
};
