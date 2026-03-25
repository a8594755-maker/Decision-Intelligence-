/**
 * evidenceRegistry.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Evidence-First Architecture: deterministic evidence collection and verification.
 *
 * Collects all tool call results from the agent loop, extracts scope metadata,
 * computes derived values (averages, growth rates) deterministically in JS,
 * flags extreme values, and produces a verified evidence brief for the
 * synthesis agent.
 *
 * This separates "data collection" from "narrative writing" — the synthesis
 * agent only sees verified, pre-computed data and never needs to do math.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const EPSILON = 1e-10;

/**
 * Format a number for business readability (K/M/B suffixes).
 */
function formatBusinessNumber(num) {
  if (!Number.isFinite(num)) return 'N/A';
  const abs = Math.abs(num);
  if (abs >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(num / 1e3).toFixed(1)}K`;
  if (Number.isInteger(num)) return String(num);
  return num.toFixed(2);
}

export class EvidenceRegistry {
  constructor() {
    this.entries = [];
    this.derivedValues = {};
    this.warnings = [];
  }

  /**
   * Register a SQL query tool call result.
   */
  registerQueryResult(toolCall) {
    const sql = toolCall?.args?.sql || '';
    const result = this._extractResult(toolCall);
    const scope = this._extractScope(sql);

    const entry = {
      id: `ev_${this.entries.length}`,
      type: 'sql',
      tool: toolCall?.name || 'query_sap_data',
      sql,
      scope,
      rows: Array.isArray(result?.rows) ? result.rows : [],
      rowCount: Number.isFinite(result?.rowCount) ? result.rowCount
        : (Array.isArray(result?.rows) ? result.rows.length : 0),
      columns: result?.meta?.columns || this._inferColumns(result?.rows),
      registeredAt: Date.now(),
    };
    this.entries.push(entry);
    return entry.id;
  }

  /**
   * Register a Python analysis tool call result.
   */
  registerPythonResult(toolCall) {
    const result = this._extractResult(toolCall);
    const entry = {
      id: `ev_${this.entries.length}`,
      type: 'python',
      tool: toolCall?.name || 'run_python_analysis',
      code: toolCall?.args?.code || '',
      scope: { filters: [], raw: 'python_analysis' },
      rows: Array.isArray(result?.rows) ? result.rows : [],
      rowCount: Array.isArray(result?.rows) ? result.rows.length : 0,
      columns: this._inferColumns(result?.rows),
      summary: result?.summary || '',
      metrics: result?.metrics || null,
      registeredAt: Date.now(),
    };
    this.entries.push(entry);
    return entry.id;
  }

  /**
   * Register a chart generation result.
   */
  registerChartResult(toolCall) {
    const result = this._extractResult(toolCall);
    const entry = {
      id: `ev_${this.entries.length}`,
      type: 'chart',
      tool: toolCall?.name || 'generate_chart',
      recipeId: toolCall?.args?.recipe_id || '',
      scope: { filters: [], raw: 'chart_artifact' },
      rows: [],
      rowCount: 0,
      columns: [],
      metrics: result?.metrics || result?.result?.metrics || null,
      highlights: result?.highlights || result?.result?.highlights || [],
      registeredAt: Date.now(),
    };
    this.entries.push(entry);
    return entry.id;
  }

  /**
   * Extract nested result from various tool call shapes.
   */
  _extractResult(toolCall) {
    const result = toolCall?.result;
    if (!result) return {};
    // Unwrap nested result.result if present
    if (result.result && typeof result.result === 'object' && 'rows' in result.result) {
      return result.result;
    }
    return result;
  }

  /**
   * Infer column names from first row of data.
   */
  _inferColumns(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return [];
    const first = rows[0];
    return first && typeof first === 'object' ? Object.keys(first) : [];
  }

  /**
   * Extract scope metadata from SQL WHERE clause.
   */
  _extractScope(sql) {
    const filters = [];
    if (!sql) return { filters, raw: '' };

    const whereMatch = sql.match(/WHERE\s+(.+?)(?:\bGROUP\b|\bORDER\b|\bLIMIT\b|\bHAVING\b|$)/is);
    if (whereMatch) {
      // Status filters
      const statusMatches = [...whereMatch[1].matchAll(/(\w+)\s*=\s*'([^']+)'/gi)];
      for (const m of statusMatches) {
        filters.push({ column: m[1], operator: '=', value: m[2] });
      }
      // IN filters
      const inMatches = [...whereMatch[1].matchAll(/(\w+)\s+IN\s*\(([^)]+)\)/gi)];
      for (const m of inMatches) {
        filters.push({ column: m[1], operator: 'IN', value: m[2].trim() });
      }
      // Date range
      const dateMatches = [...whereMatch[1].matchAll(
        /(\w+)\s*(>=?|<=?|BETWEEN)\s*'(\d{4}-\d{2}(?:-\d{2})?)'/gi
      )];
      for (const m of dateMatches) {
        filters.push({ column: m[1], operator: m[2], value: m[3] });
      }
    }
    return { filters, raw: sql };
  }

  /**
   * Identify numeric columns from rows.
   */
  _identifyNumericColumns(entry) {
    if (entry.rows.length === 0) return [];
    const first = entry.rows[0];
    if (!first || typeof first !== 'object') return [];
    return Object.keys(first).filter(col => {
      // Check first few rows to confirm numeric
      const sample = entry.rows.slice(0, 5);
      return sample.every(row => {
        const val = row[col];
        return val === null || val === undefined || Number.isFinite(parseFloat(val));
      }) && sample.some(row => Number.isFinite(parseFloat(row[col])));
    });
  }

  /**
   * Deterministically compute derived values from all registered evidence.
   * This replaces LLM mental math with exact JS computation.
   */
  computeDerivedValues() {
    const derived = {};

    for (const entry of this.entries) {
      if (entry.rowCount === 0) continue;
      const rows = entry.rows;
      const numericCols = this._identifyNumericColumns(entry);

      for (const col of numericCols) {
        const values = rows
          .map(r => parseFloat(r[col]))
          .filter(Number.isFinite);
        if (values.length === 0) continue;

        const sum = values.reduce((a, b) => a + b, 0);
        const avg = sum / values.length;
        const min = Math.min(...values);
        const max = Math.max(...values);
        const sorted = [...values].sort((a, b) => a - b);
        const median = sorted.length % 2 === 0
          ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
          : sorted[Math.floor(sorted.length / 2)];

        derived[`${entry.id}.${col}`] = {
          sum, avg, min, max, median,
          count: values.length,
          scope: entry.scope,
          formatted: {
            sum: formatBusinessNumber(sum),
            avg: formatBusinessNumber(avg),
            min: formatBusinessNumber(min),
            max: formatBusinessNumber(max),
            median: formatBusinessNumber(median),
          },
        };
      }
    }

    this._crossValidateScopes(derived);
    this.derivedValues = derived;
    return derived;
  }

  /**
   * Detect scope inconsistencies across queries for the same metric.
   */
  _crossValidateScopes(derived) {
    const byMetric = {};
    for (const [key, val] of Object.entries(derived)) {
      const metric = key.split('.').pop();
      if (!byMetric[metric]) byMetric[metric] = [];
      byMetric[metric].push({ key, ...val });
    }

    for (const [metric, entries] of Object.entries(byMetric)) {
      if (entries.length < 2) continue;
      const scopes = entries.map(e => JSON.stringify(e.scope.filters));
      const uniqueScopes = [...new Set(scopes)];
      if (uniqueScopes.length > 1) {
        this.warnings.push({
          type: 'scope_mismatch',
          metric,
          message: `"${metric}" has ${uniqueScopes.length} different query scopes — synthesizer must explicitly state which scope each number refers to`,
          entries: entries.map(e => ({ key: e.key, scope: e.scope, sum: e.sum })),
        });
      }
    }
  }

  /**
   * Flag extreme values (e.g. MoM% > 10000%) and replace with null.
   */
  flagExtremeValues() {
    for (const entry of this.entries) {
      for (const row of entry.rows) {
        for (const [col, val] of Object.entries(row)) {
          const num = parseFloat(val);
          if (!Number.isFinite(num)) continue;
          if (/mom|yoy|growth|change|pct|percent/i.test(col) && Math.abs(num) > 10000) {
            row[`${col}_flag`] = 'extreme_base_near_zero';
            row[col] = null;
          }
        }
      }
    }
  }

  /**
   * Describe scope in natural language for the synthesizer.
   */
  _describeScopeInNaturalLanguage(scope) {
    if (!scope || scope.filters.length === 0) return 'No filters — full dataset scope';
    const parts = scope.filters.map(f => `${f.column} ${f.operator || '='} ${f.value}`);
    return `Filtered by: ${parts.join(', ')}`;
  }

  /**
   * Build the evidence brief that the synthesis agent will use as its sole data source.
   */
  toSynthesisBrief() {
    return {
      evidence_entries: this.entries.map(e => ({
        id: e.id,
        type: e.type,
        tool: e.tool,
        scope_description: this._describeScopeInNaturalLanguage(e.scope),
        row_count: e.rowCount,
        columns: e.columns,
        sample_rows: e.rows.slice(0, 20),
        full_row_count: e.rowCount,
        ...(e.metrics ? { metrics: e.metrics } : {}),
        ...(e.highlights ? { highlights: e.highlights } : {}),
        ...(e.summary ? { summary: e.summary } : {}),
      })),
      derived_values: this.derivedValues,
      warnings: this.warnings,
      scope_summary: this._buildScopeSummary(),
    };
  }

  _buildScopeSummary() {
    const allFilters = this.entries.flatMap(e => e.scope.filters);
    if (allFilters.length === 0) return 'All queries are unfiltered (full dataset scope).';
    const filterDescs = [...new Set(allFilters.map(f => `${f.column}${f.operator || '='}${f.value}`))];
    return `Active filters across queries: ${filterDescs.join(', ')}. Ensure all narrative numbers reference the correct scope.`;
  }

  /**
   * Check if the registry has any meaningful evidence.
   */
  hasEvidence() {
    return this.entries.some(e => e.rowCount > 0 || e.type === 'chart');
  }

  /**
   * Get summary stats for logging.
   */
  getSummary() {
    return {
      totalEntries: this.entries.length,
      totalRows: this.entries.reduce((sum, e) => sum + e.rowCount, 0),
      derivedValueCount: Object.keys(this.derivedValues).length,
      warningCount: this.warnings.length,
      types: [...new Set(this.entries.map(e => e.type))],
    };
  }
}

export default EvidenceRegistry;
