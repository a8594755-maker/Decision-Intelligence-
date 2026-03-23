/**
 * AnalysisResultCard.jsx
 *
 * Universal card for structured analysis results.
 * Renders metrics grid, Recharts charts, collapsible tables, highlights, and details.
 *
 * Payload shape:
 *   { analysisType, title, summary, metrics, charts[], tables[], highlights[], details[] }
 */

import React, { useState, useCallback } from 'react';
import { ChevronDown, ChevronUp, BarChart3, TrendingUp, Table2, Database, Code2, Copy, Check, Sparkles, Loader2 } from 'lucide-react';
import ChartRenderer from './ChartRenderer.jsx';
import { inferChartSpec, getCompatibleTypes } from '../../services/chartSpecInference.js';
import { enhanceChartSpec } from '../../services/chartEnhancementService.js';

// ── EnhanceableChart — wraps ChartRenderer with enhance button + toggle ─────

function EnhanceableChart({ chart, height = 220, title, summary }) {
  const [enhancedSpec, setEnhancedSpec] = useState(null);
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [view, setView] = useState('original'); // 'original' | 'enhanced'
  const [error, setError] = useState(null);

  const handleEnhance = useCallback(async () => {
    if (isEnhancing || enhancedSpec) {
      // If already enhanced, just toggle to enhanced view
      if (enhancedSpec) setView('enhanced');
      return;
    }
    setIsEnhancing(true);
    setError(null);
    try {
      const result = await enhanceChartSpec(chart, { title, summary });
      setEnhancedSpec(result);
      setView('enhanced');
    } catch (err) {
      console.warn('[EnhanceableChart] Enhancement failed:', err?.message);
      setError('Enhancement failed');
    } finally {
      setIsEnhancing(false);
    }
  }, [chart, title, summary, isEnhancing, enhancedSpec]);

  const activeChart = view === 'enhanced' && enhancedSpec ? enhancedSpec : chart;
  const pillBase = 'text-[10px] font-medium px-2 py-0.5 rounded-full transition-colors';
  const pillActive = 'bg-blue-100 text-blue-700 dark:bg-blue-900/60 dark:text-blue-300';
  const pillInactive = 'text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 cursor-pointer';

  return (
    <div>
      <div className="flex items-center justify-between px-1 mb-1.5">
        <div className="flex gap-1">
          {enhancedSpec ? (
            <>
              <button onClick={() => setView('original')} className={`${pillBase} ${view === 'original' ? pillActive : pillInactive}`}>
                Original
              </button>
              <button onClick={() => setView('enhanced')} className={`${pillBase} ${view === 'enhanced' ? pillActive : pillInactive}`}>
                Enhanced
              </button>
            </>
          ) : <div />}
        </div>
        <button
          onClick={handleEnhance}
          disabled={isEnhancing}
          className="flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-blue-100 hover:text-blue-600 dark:hover:bg-blue-900/40 dark:hover:text-blue-300 disabled:opacity-50 transition-colors"
        >
          {isEnhancing ? (
            <><Loader2 size={10} className="animate-spin" /> Enhancing…</>
          ) : (
            <><Sparkles size={10} /> Enhance</>
          )}
        </button>
      </div>
      {error ? (
        <p className="text-[10px] text-red-400 dark:text-red-500 px-1 mb-1">{error}</p>
      ) : null}
      <ChartRenderer
        chart={activeChart}
        height={height}
        compatibleTypes={activeChart.compatibleTypes || getCompatibleTypes(activeChart.type, activeChart.data)}
        showSwitcher={true}
      />
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Turn raw keys like "total_sellers" / "avg_revenue" into "Total Sellers" / "Avg Revenue" */
function formatMetricLabel(key) {
  return key
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

/** Format numbers with locale grouping; leave non-numeric values untouched */
function formatMetricValue(v) {
  if (v == null) return '—';
  if (typeof v === 'number') {
    return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  // String that looks numeric (e.g. "9525.32")
  const n = Number(v);
  if (!isNaN(n) && v !== '') {
    return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  return v;
}

/** Pick grid column class based on metric count */
function metricsGridCols(count) {
  if (count <= 2) return 'grid-cols-2';
  if (count <= 3) return 'grid-cols-3';
  if (count <= 4) return 'grid-cols-2 sm:grid-cols-4';
  return 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4';
}

/** Check if a value looks numeric */
function looksNumeric(v) {
  if (typeof v === 'number') return true;
  if (typeof v === 'string' && v !== '' && !isNaN(Number(v))) return true;
  return false;
}

export default function AnalysisResultCard({ payload }) {
  const [showTable, setShowTable] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [showMethodology, setShowMethodology] = useState(false);

  if (!payload) return null;
  const { title, summary, metrics = {}, charts = [], tables = [], highlights = [], details = [], _methodology, _executionMeta } = payload;
  const hasMethodology = _methodology?.queries?.length > 0 || _executionMeta?.code;
  const metricEntries = Object.entries(metrics);

  return (
    <div className="w-full rounded-xl border border-blue-200 dark:border-blue-800 bg-gradient-to-br from-blue-50/80 to-white dark:from-blue-950/30 dark:to-gray-900 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-4 pt-4 pb-2">
        <div className="flex items-start gap-2">
          <div className="p-1.5 rounded-lg bg-blue-100 dark:bg-blue-900/50">
            <BarChart3 className="w-4 h-4 text-blue-600 dark:text-blue-400" />
          </div>
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{title}</h3>
        </div>
        {summary && (
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{summary}</p>
        )}
      </div>

      {/* Metrics Grid */}
      {metricEntries.length > 0 && (
        <div className="px-4 pb-3">
          <div className={`grid ${metricsGridCols(metricEntries.length)} gap-2`}>
            {metricEntries.map(([key, value]) => (
              <div key={key} className="rounded-lg bg-white/80 dark:bg-gray-800/60 border border-slate-100 dark:border-slate-700 px-3 py-2">
                <div className="text-[10px] font-medium text-slate-400 dark:text-slate-500 tracking-wide truncate" title={formatMetricLabel(key)}>
                  {formatMetricLabel(key)}
                </div>
                <div className="text-sm font-semibold text-slate-800 dark:text-slate-100 mt-0.5 truncate" title={String(value)}>
                  {formatMetricValue(value)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Highlights */}
      {highlights.length > 0 && (
        <div className="px-4 pb-3 flex flex-wrap gap-1.5">
          {highlights.map((h, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-blue-100/80 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
            >
              <TrendingUp className="w-3 h-3" />
              {h}
            </span>
          ))}
        </div>
      )}

      {/* Charts — use EnhanceableChart wrapper with enhance button + toggle */}
      {(charts.length > 0 || (charts.length === 0 && tables.length > 0)) && (
        <div className="px-4 pb-3 space-y-4">
          {(charts.length > 0 ? charts : autoInferChartsFromTables(tables)).map((chart, i) => (
            <EnhanceableChart
              key={i}
              chart={chart}
              height={220}
              title={title}
              summary={summary}
            />
          ))}
        </div>
      )}

      {/* Tables (collapsible) */}
      {tables.length > 0 && (
        <div className="px-4 pb-3">
          <button
            onClick={() => setShowTable(!showTable)}
            className="flex items-center gap-1 text-xs font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-200 transition-colors"
          >
            <Table2 className="w-3.5 h-3.5" />
            {showTable ? 'Hide' : 'Show'} Data Table
            {showTable ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
          {showTable && tables.map((tbl, ti) => {
            // Detect which columns are numeric (check first few rows)
            const sampleRows = (tbl.rows || []).slice(0, 5);
            const numericCols = new Set();
            if (sampleRows.length > 0) {
              tbl.columns.forEach((_, ci) => {
                const allNumeric = sampleRows.every(row => {
                  const cells = Array.isArray(row) ? row : Object.values(row);
                  return cells[ci] == null || looksNumeric(cells[ci]);
                });
                if (allNumeric) numericCols.add(ci);
              });
            }

            return (
              <div key={ti} className="mt-2 overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
                {tbl.title && <div className="text-xs font-medium text-slate-500 dark:text-slate-400 px-3 py-1.5 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700">{tbl.title}</div>}
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-600 bg-slate-50/50 dark:bg-slate-800/30">
                      {tbl.columns.map((col, ci) => (
                        <th key={ci} className={`py-1.5 px-2.5 text-slate-500 dark:text-slate-400 font-medium whitespace-nowrap ${numericCols.has(ci) ? 'text-right' : 'text-left'}`}>
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(tbl.rows || []).slice(0, 20).map((row, ri) => (
                      <tr key={ri} className={`border-b border-slate-100 dark:border-slate-700/50 hover:bg-blue-50/40 dark:hover:bg-blue-900/10 ${ri % 2 === 1 ? 'bg-slate-50/40 dark:bg-slate-800/20' : ''}`}>
                        {(Array.isArray(row) ? row : Object.values(row)).map((cell, ci) => (
                          <td key={ci} className={`py-1.5 px-2.5 text-slate-700 dark:text-slate-300 whitespace-nowrap ${numericCols.has(ci) ? 'text-right tabular-nums' : ''}`}>
                            {numericCols.has(ci) ? formatMetricValue(cell) : cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {(tbl.rows || []).length > 20 && (
                  <div className="text-[10px] text-slate-400 px-3 py-1.5 border-t border-slate-100 dark:border-slate-700">Showing 20 of {tbl.rows.length} rows</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Details (collapsible) */}
      {details.length > 0 && (
        <div className="px-4 pb-4">
          <button
            onClick={() => setShowDetails(!showDetails)}
            className="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
          >
            {showDetails ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            {showDetails ? 'Hide' : 'Show'} Details ({details.length})
          </button>
          {showDetails && (
            <div className="mt-2 space-y-1">
              {details.map((d, i) => (
                <div key={i} className="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-400">
                  <span className="text-blue-400 mt-0.5">&#9679;</span>
                  <span>{d}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Methodology (collapsible) — data sources, SQL queries, Python code */}
      {hasMethodology && (
        <div className="px-4 pb-4 border-t border-slate-200 dark:border-slate-700 pt-3">
          <button
            onClick={() => setShowMethodology(!showMethodology)}
            className="flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
          >
            <Code2 className="w-3.5 h-3.5" />
            {showMethodology ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            {showMethodology ? 'Hide' : 'Show'} Methodology
          </button>
          {showMethodology && (
            <MethodologySection methodology={_methodology} executionMeta={_executionMeta} />
          )}
        </div>
      )}
    </div>
  );
}

// ── Auto-infer charts from tables when no charts provided ────────────────────

function autoInferChartsFromTables(tables) {
  if (!tables || tables.length === 0) return [];
  const tbl = tables[0];
  if (!tbl.columns || !tbl.rows || tbl.rows.length === 0) return [];

  // Convert table rows to object format for inference
  const rows = tbl.rows.map(row => {
    if (Array.isArray(row)) {
      const obj = {};
      tbl.columns.forEach((col, i) => { obj[col] = row[i]; });
      return obj;
    }
    return row;
  });

  const spec = inferChartSpec(rows);
  if (!spec) return [];
  return [{ ...spec, data: rows, title: tbl.title }];
}

// ── Methodology Section ─────────────────────────────────────────────────────

function MethodologySection({ methodology, executionMeta }) {
  const engine = executionMeta?.engine || methodology?.engine || 'Unknown';
  const dataSources = methodology?.dataSources || [];
  const queries = methodology?.queries || [];
  const code = executionMeta?.code;
  const model = executionMeta?.llm_model;
  const execMs = executionMeta?.execution_ms;

  return (
    <div className="mt-3 space-y-3">
      {/* Engine + model badge */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          <Code2 className="w-3 h-3" />
          {engine}
        </span>
        {model && (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
            {model}
          </span>
        )}
        {execMs && (
          <span className="text-[10px] text-slate-400">{execMs}ms</span>
        )}
      </div>

      {/* Data sources */}
      {dataSources.length > 0 && (
        <div>
          <div className="flex items-center gap-1 mb-1.5">
            <Database className="w-3 h-3 text-slate-400" />
            <span className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Data Sources</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {dataSources.map((src, i) => (
              <span key={i} className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
                {src}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* SQL queries */}
      {queries.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-1.5">
            SQL Queries ({queries.length})
          </div>
          <div className="space-y-2">
            {queries.map((q, i) => (
              <CodeBlock
                key={i}
                code={q.sql}
                language="SQL"
                label={`Query ${i + 1} — ${q.rowCount} row${q.rowCount !== 1 ? 's' : ''}`}
              />
            ))}
          </div>
        </div>
      )}

      {/* Python code */}
      {code && (
        <div>
          <div className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-1.5">
            Generated Python Code
          </div>
          <CodeBlock code={code} language="Python" />
        </div>
      )}
    </div>
  );
}

function CodeBlock({ code, language, label }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="rounded-lg overflow-hidden border border-slate-700">
      <div className="flex items-center justify-between px-3 py-1.5 bg-slate-800 text-[10px] text-slate-400">
        <span className="font-medium">{label || language}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 hover:text-slate-200 transition-colors"
        >
          {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="px-3 py-2.5 text-[11px] font-mono text-emerald-300 whitespace-pre-wrap break-words overflow-x-auto leading-relaxed bg-slate-950/60 max-h-64 overflow-y-auto">
        {code}
      </pre>
    </div>
  );
}
