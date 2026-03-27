/**
 * evidenceBundleV1.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Evidence Bundle V1: structured output from the executor phase.
 *
 * Extends the existing EvidenceRegistry (governance/evidenceRegistry.js) with:
 *   - Normalized metrics extraction from tool results
 *   - Auto-detected caveats (proxy data, small sample, temporal gaps)
 *   - Data lineage tracking (metric → source tool → source row)
 *   - Analyst draft (short LLM summary for renderer context)
 *
 * This separates data collection (executor) from narrative writing (renderer).
 * The renderer receives ONLY this bundle — never raw agent prose.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { EvidenceRegistry } from '../governance/evidenceRegistry.js';

// ── Constants ────────────────────────────────────────────────────────────────

const SMALL_SAMPLE_THRESHOLD = 30;
const TEMPORAL_GAP_WARNING_MONTHS = 3;

// ── Caveat Auto-Detection ───────────────────────────────────────────────────

/**
 * Auto-detect caveats from evidence entries.
 */
function detectCaveats(entries) {
  const caveats = [];

  for (const entry of entries) {
    // Small sample size
    if (entry.rowCount > 0 && entry.rowCount < SMALL_SAMPLE_THRESHOLD) {
      caveats.push(`Small sample size (${entry.rowCount} rows) in ${entry.tool} result — statistical reliability is limited.`);
    }

    // Zero-row queries
    if (entry.rowCount === 0 && entry.type === 'sql') {
      caveats.push(`Query returned 0 rows from ${entry.tool} — the filter may be too restrictive or the data may not exist.`);
    }
  }

  // Deduplicate
  return [...new Set(caveats)];
}

/**
 * Extract normalized metrics from tool call results.
 * Each metric tracks its source for lineage.
 */
function extractNormalizedMetrics(entries) {
  const metrics = [];

  for (const entry of entries) {
    if (entry.rowCount === 0) continue;

    // Extract from pre-computed metrics (if available)
    if (entry.metrics && typeof entry.metrics === 'object') {
      for (const [label, value] of Object.entries(entry.metrics)) {
        if (value == null) continue;
        metrics.push({
          label,
          value: String(value),
          source_tool: entry.tool,
          source_id: entry.id,
          confidence: 'high',
        });
      }
    }

    // Extract aggregate metrics from SQL results
    if (entry.type === 'sql' && entry.rows.length === 1) {
      const row = entry.rows[0];
      if (row && typeof row === 'object') {
        for (const [col, val] of Object.entries(row)) {
          if (val == null || typeof val === 'object') continue;
          const num = parseFloat(val);
          if (Number.isFinite(num)) {
            metrics.push({
              label: col,
              value: String(val),
              source_tool: entry.tool,
              source_id: entry.id,
              confidence: 'high',
            });
          }
        }
      }
    }
  }

  return metrics;
}

/**
 * Build data lineage entries from evidence.
 */
function buildLineage(entries) {
  return entries
    .filter(e => e.rowCount > 0)
    .map(e => ({
      metric: e.columns.join(', '),
      sql_ref: e.sql || e.code || e.recipeId || '',
      row_count: e.rowCount,
      confidence: e.rowCount >= SMALL_SAMPLE_THRESHOLD ? 'high' : 'low',
      source_tool: e.tool,
      source_id: e.id,
    }));
}

// ── EvidenceBundleV1 Class ───────────────────────────────────────────────────

export class EvidenceBundleV1 {
  /**
   * @param {Object} opts
   * @param {Array} opts.toolCalls - executed tool calls with results [{name, args, result}]
   * @param {string} opts.analystDraft - LLM's short summary (for renderer context)
   */
  constructor({ toolCalls = [], analystDraft = '' } = {}) {
    this.registry = new EvidenceRegistry();
    this.toolCalls = toolCalls;
    this.analystDraft = analystDraft;

    // Register all tool calls into the evidence registry
    for (const tc of toolCalls) {
      if (!tc?.result?.success) continue;

      const name = tc.name || '';
      if (name === 'query_sap_data' || name === 'list_sap_tables') {
        this.registry.registerQueryResult(tc);
      } else if (name === 'run_python_analysis') {
        this.registry.registerPythonResult(tc);
      } else if (name === 'generate_chart') {
        this.registry.registerChartResult(tc);
      } else {
        // Generic tool: try to register as query-like
        this.registry.registerQueryResult(tc);
      }
    }

    // Compute derived values
    this.registry.computeDerivedValues();
    this.registry.flagExtremeValues();
  }

  /**
   * Get the full evidence bundle as a plain object.
   * This is the primary input to the renderer.
   */
  toBundle() {
    const entries = this.registry.entries;

    return Object.freeze({
      tool_results: this.toolCalls.map(tc => ({
        name: tc.name,
        args: tc.args,
        success: tc.result?.success ?? false,
        row_count: tc.result?.result?.rowCount ?? tc.result?.result?.rows?.length ?? 0,
      })),
      normalized_metrics: extractNormalizedMetrics(entries),
      charts: this._extractCharts(),
      caveats: detectCaveats(entries),
      lineage: buildLineage(entries),
      analyst_draft: this.analystDraft,
      synthesis_brief: this.registry.toSynthesisBrief(),
      warnings: this.registry.warnings,
      summary: this.registry.getSummary(),
    });
  }

  /**
   * Extract chart specifications from tool results.
   */
  _extractCharts() {
    const charts = [];

    for (const tc of this.toolCalls) {
      if (!tc?.result?.success) continue;

      const result = tc.result?.result || tc.result;

      // Charts from generate_chart
      if (tc.name === 'generate_chart' || tc.name === 'run_python_analysis') {
        const nestedCharts = result?.charts || result?._analysisCards?.[0]?.charts;
        if (Array.isArray(nestedCharts)) {
          charts.push(...nestedCharts);
        }
      }
    }

    return charts;
  }

  /**
   * Check if the bundle has meaningful evidence.
   */
  hasEvidence() {
    return this.registry.hasEvidence();
  }

  /**
   * Get the number of successful tool calls with data.
   */
  getEvidenceCount() {
    return this.registry.entries.filter(e => e.rowCount > 0 || e.type === 'chart').length;
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Build an EvidenceBundleV1 from the agent loop's tool calls.
 *
 * @param {Array} toolCalls - [{name, args, result}]
 * @param {string} analystDraft - LLM's final text (short summary only)
 * @returns {EvidenceBundleV1}
 */
export function buildEvidenceBundle(toolCalls, analystDraft = '') {
  return new EvidenceBundleV1({ toolCalls, analystDraft });
}

export default {
  EvidenceBundleV1,
  buildEvidenceBundle,
};
