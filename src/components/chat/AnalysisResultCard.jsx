/**
 * AnalysisResultCard.jsx
 *
 * Universal card for structured analysis results.
 * Renders metrics grid, Recharts charts, collapsible tables, highlights, and details.
 *
 * Payload shape:
 *   { analysisType, title, summary, metrics, charts[], tables[], highlights[], details[] }
 */

import React, { useState } from 'react';
import { ChevronDown, ChevronUp, BarChart3, TrendingUp, Table2, Database, Code2, Copy, Check } from 'lucide-react';
import ChartRenderer from './ChartRenderer.jsx';
import { inferChartSpec, getCompatibleTypes } from '../../services/chartSpecInference.js';

export default function AnalysisResultCard({ payload }) {
  const [showTable, setShowTable] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [showMethodology, setShowMethodology] = useState(false);

  if (!payload) return null;
  const { title, summary, metrics = {}, charts = [], tables = [], highlights = [], details = [], _methodology, _executionMeta } = payload;
  const hasMethodology = _methodology?.queries?.length > 0 || _executionMeta?.code;

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
      {Object.keys(metrics).length > 0 && (
        <div className="px-4 pb-3">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {Object.entries(metrics).map(([key, value]) => (
              <div key={key} className="rounded-lg bg-white/80 dark:bg-gray-800/60 border border-slate-100 dark:border-slate-700 px-3 py-2">
                <div className="text-[10px] font-medium text-slate-400 dark:text-slate-500 uppercase tracking-wide">{key}</div>
                <div className="text-sm font-semibold text-slate-800 dark:text-slate-100 mt-0.5">
                  {value}
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

      {/* Charts — use shared ChartRenderer; auto-infer from tables if no charts provided */}
      {(charts.length > 0 || (charts.length === 0 && tables.length > 0)) && (
        <div className="px-4 pb-3 space-y-4">
          {(charts.length > 0 ? charts : autoInferChartsFromTables(tables)).map((chart, i) => (
            <ChartRenderer
              key={i}
              chart={chart}
              height={220}
              compatibleTypes={chart.compatibleTypes || getCompatibleTypes(chart.type, chart.data)}
              showSwitcher={true}
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
          {showTable && tables.map((tbl, ti) => (
            <div key={ti} className="mt-2 overflow-x-auto">
              {tbl.title && <div className="text-xs font-medium text-slate-500 mb-1">{tbl.title}</div>}
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-600">
                    {tbl.columns.map((col, ci) => (
                      <th key={ci} className="text-left py-1.5 px-2 text-slate-500 dark:text-slate-400 font-medium whitespace-nowrap">
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(tbl.rows || []).slice(0, 20).map((row, ri) => (
                    <tr key={ri} className="border-b border-slate-100 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                      {(Array.isArray(row) ? row : Object.values(row)).map((cell, ci) => (
                        <td key={ci} className="py-1 px-2 text-slate-700 dark:text-slate-300 whitespace-nowrap">
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {(tbl.rows || []).length > 20 && (
                <div className="text-[10px] text-slate-400 mt-1">Showing 20 of {tbl.rows.length} rows</div>
              )}
            </div>
          ))}
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
