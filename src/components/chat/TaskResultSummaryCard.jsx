/**
 * TaskResultSummaryCard.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Renders orchestrator task results directly in chat:
 *   - Step completion summary
 *   - Inline tables (auto-detected from artifact data)
 *   - Inline line charts (via Recharts)
 *   - Key metric highlights
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useState, useMemo } from 'react';
import {
  CheckCircle, XCircle, ChevronDown, ChevronUp,
  FileText, BarChart2, Table as TableIcon, TrendingUp,
  AlertTriangle, Lightbulb, Zap, Database,
} from 'lucide-react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend,
} from 'recharts';
import AnalysisResultCard from './AnalysisResultCard';

// ── Colors for multi-series charts ──────────────────────────────────────────

const CHART_COLORS = [
  '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6',
  '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1',
];

// ── Artifact type detection ─────────────────────────────────────────────────

function getArtifactType(art) {
  if (!art || typeof art !== 'object') return 'unknown';
  return art.artifact_type || art.type || 'unknown';
}

function getArtifactLabel(art) {
  if (typeof art === 'string') return art;
  if (art?.label) return art.label;
  const type = getArtifactType(art);
  return type.replace(/_/g, ' ');
}

function getArtifactData(art) {
  if (!art) return null;
  // Python executor returns data as array or payload as object with data inside
  if (Array.isArray(art.data)) return art.data;
  if (Array.isArray(art.payload)) return art.payload;
  if (art.payload?.data && Array.isArray(art.payload.data)) return art.payload.data;
  if (art.payload?.rows && Array.isArray(art.payload.rows)) return art.payload.rows;
  if (art.data?.rows && Array.isArray(art.data.rows)) return art.data.rows;
  return null;
}

function isAnalysisResultArtifact(art) {
  const type = getArtifactType(art);
  if (type === 'analysis_result') return true;
  // Also detect by shape: data is an object with analysisType + metrics
  const data = art?.data;
  return data && !Array.isArray(data) && data.analysisType && data.metrics;
}

function isChartArtifact(art) {
  const type = getArtifactType(art);
  return type.includes('chart') || type.includes('line') || type.includes('bar')
    || type === 'forecast_series' || type === 'inventory_projection';
}

function isTableArtifact(art) {
  const type = getArtifactType(art);
  const data = getArtifactData(art);
  if (!data || data.length === 0) return false;
  return type === 'table' || type === 'plan_table' || type === 'risk_scores'
    || (!isChartArtifact(art) && typeof data[0] === 'object');
}

// ── Extract highlights from all artifacts ───────────────────────────────────

function extractHighlights(steps) {
  const highlights = [];
  for (const step of steps) {
    if (!step.artifacts) continue;
    for (const art of step.artifacts) {
      if (!art || typeof art !== 'object') continue;
      const data = getArtifactData(art);

      // Row count for tables
      if (isTableArtifact(art) && data) {
        highlights.push({ text: `${data.length} rows`, step: step.step_name });
      }

      // MAPE / accuracy metrics (search in data rows)
      if (data && data.length > 0) {
        const firstRow = data[0];
        if (firstRow.MAPE != null) highlights.push({ text: `MAPE: ${Number(firstRow.MAPE).toFixed(1)}%`, step: step.step_name });
        if (firstRow.mape != null) highlights.push({ text: `MAPE: ${Number(firstRow.mape).toFixed(1)}%`, step: step.step_name });
      }

      // Comparison from forecast bridge
      if (art.comparison?.overall_mape != null) {
        highlights.push({ text: `Overall MAPE: ${art.comparison.overall_mape}%`, step: step.step_name });
      }
    }
  }
  return highlights;
}

// ── Inline Table Renderer ───────────────────────────────────────────────────

const MAX_TABLE_ROWS = 20;
const MAX_TABLE_COLS = 8;

function InlineTable({ data, label }) {
  const [showAll, setShowAll] = useState(false);
  if (!data || data.length === 0) return null;

  const allColumns = Object.keys(data[0]);
  const columns = allColumns.slice(0, MAX_TABLE_COLS);
  const displayRows = showAll ? data : data.slice(0, MAX_TABLE_ROWS);
  const hasMore = data.length > MAX_TABLE_ROWS;
  const hasMoreCols = allColumns.length > MAX_TABLE_COLS;

  return (
    <div className="mt-2 overflow-x-auto">
      {label && (
        <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{label}</div>
      )}
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="bg-gray-100 dark:bg-gray-700">
            {columns.map(col => (
              <th key={col} className="px-2 py-1 text-left font-medium text-gray-600 dark:text-gray-300 border-b border-gray-200 dark:border-gray-600 whitespace-nowrap">
                {col}
              </th>
            ))}
            {hasMoreCols && (
              <th className="px-2 py-1 text-left text-gray-400 dark:text-gray-500 border-b border-gray-200 dark:border-gray-600">
                +{allColumns.length - MAX_TABLE_COLS}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {displayRows.map((row, i) => (
            <tr key={i} className={i % 2 === 0 ? 'bg-white dark:bg-gray-800' : 'bg-gray-50 dark:bg-gray-750'}>
              {columns.map(col => (
                <td key={col} className="px-2 py-1 text-gray-700 dark:text-gray-300 border-b border-gray-100 dark:border-gray-700 whitespace-nowrap max-w-[200px] truncate">
                  {formatCellValue(row[col])}
                </td>
              ))}
              {hasMoreCols && <td className="px-2 py-1 text-gray-400">…</td>}
            </tr>
          ))}
        </tbody>
      </table>
      {hasMore && !showAll && (
        <button
          onClick={() => setShowAll(true)}
          className="mt-1 text-xs text-blue-600 dark:text-blue-400 hover:underline"
        >
          Show all {data.length} rows
        </button>
      )}
    </div>
  );
}

function formatCellValue(val) {
  if (val == null) return '—';
  if (typeof val === 'number') {
    if (Number.isInteger(val)) return val.toLocaleString();
    return val.toFixed(2);
  }
  if (typeof val === 'boolean') return val ? 'Yes' : 'No';
  return String(val);
}

// ── Inline Chart Renderer ───────────────────────────────────────────────────

function InlineChart({ data, label }) {
  const chartConfig = useMemo(() => {
    if (!data || data.length === 0) return null;

    const firstRow = data[0];
    const allKeys = Object.keys(firstRow);

    // Find the x-axis key (time/period/date/month)
    const xKey = allKeys.find(k =>
      /period|month|date|time|year|bucket|x/i.test(k)
    ) || allKeys[0];

    // Find numeric y-axis keys
    const yKeys = allKeys.filter(k =>
      k !== xKey && typeof firstRow[k] === 'number'
    ).slice(0, 8); // max 8 series (actual + up to 7 models)

    if (yKeys.length === 0) return null;

    return { xKey, yKeys };
  }, [data]);

  // Track which series are hidden (click legend to toggle)
  const [hiddenSeries, setHiddenSeries] = useState(new Set());

  if (!chartConfig) return null;

  const handleLegendClick = (data) => {
    // Recharts 3.x: onClick(data, index, event) — data has dataKey or value
    const key = data?.dataKey || data?.value;
    if (!key) return;
    setHiddenSeries(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Style for actual line: thicker, solid; model lines: dashed
  const getStrokeStyle = (key, i) => {
    const isActual = /actual/i.test(key);
    return {
      stroke: CHART_COLORS[i % CHART_COLORS.length],
      strokeWidth: isActual ? 2.5 : 2,
      strokeDasharray: isActual ? undefined : '6 3',
    };
  };

  return (
    <div className="mt-2">
      {label && (
        <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{label}</div>
      )}
      <div style={{ height: chartConfig.yKeys.length > 3 ? 260 : 200 }} className="w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
            <XAxis
              dataKey={chartConfig.xKey}
              tick={{ fontSize: 10 }}
              interval="preserveStartEnd"
            />
            <YAxis tick={{ fontSize: 10 }} width={50} />
            <Tooltip
              contentStyle={{ fontSize: 11, borderRadius: 6 }}
              formatter={(val) => typeof val === 'number' ? val.toLocaleString() : val}
            />
            <Legend
              wrapperStyle={{ fontSize: 11, cursor: 'pointer' }}
              onClick={handleLegendClick}
              formatter={(value, entry) => {
                const key = entry?.dataKey || value;
                const isHidden = hiddenSeries.has(key);
                return (
                  <span style={{
                    color: isHidden ? '#ccc' : entry?.color,
                    textDecoration: isHidden ? 'line-through' : 'none',
                  }}>
                    {value}
                  </span>
                );
              }}
            />
            {chartConfig.yKeys.map((key, i) => {
              // Recharts 3.x: `hide` only dims, doesn't remove. Skip render entirely.
              if (hiddenSeries.has(key)) return null;
              const style = getStrokeStyle(key, i);
              return (
                <Line
                  key={key}
                  type="monotone"
                  dataKey={key}
                  stroke={style.stroke}
                  strokeWidth={style.strokeWidth}
                  strokeDasharray={style.strokeDasharray}
                  dot={data.length <= 24 ? { r: 3 } : false}
                  name={key.replace(/_/g, ' ')}
                  connectNulls
                />
              );
            })}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ── Render a single artifact ────────────────────────────────────────────────

function isMetadataArtifact(art) {
  return getArtifactType(art) === 'metadata';
}

function MetadataBadge({ art }) {
  const label = getArtifactLabel(art);
  return (
    <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-200">
      <BarChart2 className="w-3 h-3" />
      {label}
    </div>
  );
}

const GRADE_STYLES = {
  A: { bg: 'bg-green-100 dark:bg-green-900/50', text: 'text-green-800 dark:text-green-200', border: 'border-green-300 dark:border-green-700' },
  B: { bg: 'bg-blue-100 dark:bg-blue-900/50', text: 'text-blue-800 dark:text-blue-200', border: 'border-blue-300 dark:border-blue-700' },
  C: { bg: 'bg-yellow-100 dark:bg-yellow-900/50', text: 'text-yellow-800 dark:text-yellow-200', border: 'border-yellow-300 dark:border-yellow-700' },
  D: { bg: 'bg-red-100 dark:bg-red-900/50', text: 'text-red-800 dark:text-red-200', border: 'border-red-300 dark:border-red-700' },
};

function AnalysisBlock({ art }) {
  const data = getArtifactData(art);
  const parsed = data?.[0];
  if (!parsed) return null;

  // Fallback: plain text content (old format)
  if (!parsed.grade && parsed.content) {
    return (
      <div className="border border-blue-200 dark:border-blue-800 rounded-lg p-4 bg-blue-50/50 dark:bg-blue-950/30">
        <div className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap leading-relaxed">{parsed.content}</div>
        {parsed._meta && <AnalysisMeta meta={parsed._meta} />}
      </div>
    );
  }

  const grade = parsed.grade?.toUpperCase() || '?';
  const gs = GRADE_STYLES[grade] || GRADE_STYLES.B;

  return (
    <div className="border border-blue-200 dark:border-blue-800 rounded-lg overflow-hidden bg-white dark:bg-gray-800">
      {/* Grade header — deterministic (JS computed) */}
      <div className={`flex items-center gap-3 px-4 py-3 ${gs.bg} border-b ${gs.border}`}>
        <span className={`text-2xl font-bold ${gs.text}`}>{grade}</span>
        <span className={`text-sm ${gs.text}`}>{parsed.grade_reason}</span>
      </div>

      {/* MAPE by model — deterministic (JS computed) */}
      {parsed.mape_by_model && Object.keys(parsed.mape_by_model).length > 0 && (
        <div className="px-4 pt-3 flex flex-wrap gap-3">
          {Object.entries(parsed.mape_by_model).map(([model, mape]) => (
            <div key={model} className="flex items-center gap-1.5">
              <span className="text-xs text-gray-500 dark:text-gray-400">{model}:</span>
              <span className={`text-sm font-semibold ${mape < 10 ? 'text-green-600 dark:text-green-400' : mape < 20 ? 'text-blue-600 dark:text-blue-400' : 'text-orange-600 dark:text-orange-400'}`}>
                {mape}%
              </span>
            </div>
          ))}
          {parsed.best_model && (
            <span className="text-xs text-gray-400 dark:text-gray-500 self-center ml-auto">
              Best: {parsed.best_model.name}
            </span>
          )}
        </div>
      )}

      <div className="p-4 space-y-3">
        {/* Trend interpretation — from LLM (qualitative, no numbers) */}
        {parsed.trend_interpretation && (
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <TrendingUp className="w-3.5 h-3.5 text-blue-500" />
              <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Trend Analysis</span>
            </div>
            <p className="text-sm text-gray-700 dark:text-gray-300 pl-5">{parsed.trend_interpretation}</p>
          </div>
        )}

        {/* Anomaly explanation — from LLM */}
        {parsed.anomaly_explanation && parsed.anomaly_explanation !== 'null' && (
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <AlertTriangle className="w-3.5 h-3.5 text-orange-500" />
              <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Anomaly</span>
            </div>
            <p className="text-sm text-orange-700 dark:text-orange-300 pl-5">{parsed.anomaly_explanation}</p>
          </div>
        )}

        {/* Category insight — from LLM */}
        {parsed.category_insight && (
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <Lightbulb className="w-3.5 h-3.5 text-amber-500" />
              <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Insight</span>
            </div>
            <p className="text-sm text-gray-700 dark:text-gray-300 pl-5">{parsed.category_insight}</p>
          </div>
        )}

        {/* Recommendations — from LLM */}
        {parsed.recommendations?.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <Zap className="w-3.5 h-3.5 text-blue-500" />
              <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Recommendations</span>
            </div>
            <ul className="space-y-1">
              {parsed.recommendations.map((item, i) => (
                <li key={i} className="text-sm text-gray-700 dark:text-gray-300 pl-5 relative before:content-['→'] before:absolute before:left-1 before:text-blue-400">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Worst period — deterministic */}
        {parsed.worst_period && (
          <div className="text-xs text-gray-400 dark:text-gray-500 pl-5">
            Highest error: {parsed.worst_period.period} ({parsed.worst_period.model}, {parsed.worst_period.pct_error}%)
          </div>
        )}
      </div>

      {/* Footer: model + data sources */}
      {parsed._meta && <AnalysisMeta meta={parsed._meta} />}
    </div>
  );
}

function AnalysisMeta({ meta }) {
  if (!meta) return null;
  const time = meta.generated_at ? new Date(meta.generated_at).toLocaleString() : '';
  return (
    <div className="px-4 py-2 border-t border-gray-100 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/20">
      <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 mb-0.5">
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 font-medium text-[11px]">
          {meta.model}
        </span>
        {time && <span className="text-[10px] text-gray-400 dark:text-gray-500">{time}</span>}
      </div>
      {meta.data_sources?.length > 0 && (
        <div className="flex items-center gap-1 text-[10px] text-gray-400 dark:text-gray-500">
          <Database className="w-2.5 h-2.5 flex-shrink-0" />
          <span>{meta.data_sources.join(' · ')}</span>
        </div>
      )}
    </div>
  );
}

function ArtifactRenderer({ art }) {
  const data = getArtifactData(art);
  const label = getArtifactLabel(art);

  if (isMetadataArtifact(art)) {
    return <MetadataBadge art={art} />;
  }
  // Rich analysis result → delegate to AnalysisResultCard (metrics, charts, tables)
  if (isAnalysisResultArtifact(art)) {
    const payload = art.data;
    return <AnalysisResultCard payload={payload} />;
  }
  if (getArtifactType(art) === 'analysis') {
    return <AnalysisBlock art={art} />;
  }
  if (isChartArtifact(art) && data && data.length > 0) {
    return <InlineChart data={data} label={label} />;
  }
  if (isTableArtifact(art) && data && data.length > 0) {
    return <InlineTable data={data} label={label} />;
  }

  // Fallback: if data exists but isn't recognized, try table
  if (data && data.length > 0 && typeof data[0] === 'object') {
    return <InlineTable data={data} label={label} />;
  }

  return null;
}

// ── Main Component ──────────────────────────────────────────────────────────

export default function TaskResultSummaryCard({ payload }) {
  const { steps = [], taskTitle } = payload || {};
  const [expanded, setExpanded] = useState(true); // Default open

  const succeededSteps = steps.filter(s => s.status === 'succeeded');
  const failedSteps = steps.filter(s => s.status === 'failed');
  const totalArtifacts = steps.reduce((sum, s) => sum + (s.artifacts?.length || 0), 0);
  const highlights = extractHighlights(steps);

  // Collect all renderable artifacts
  const renderableArtifacts = useMemo(() => {
    const arts = [];
    for (const step of steps) {
      if (!step.artifacts) continue;
      for (const art of step.artifacts) {
        if (!art || typeof art !== 'object') continue;
        // analysis_result artifacts have object data (not array)
        if (isAnalysisResultArtifact(art)) {
          arts.push({ art, stepName: step.step_name });
          continue;
        }
        const data = getArtifactData(art);
        if (data && data.length > 0) {
          arts.push({ art, stepName: step.step_name });
        }
      }
    }
    return arts;
  }, [steps]);

  return (
    <div className="rounded-lg border border-green-200 bg-green-50 dark:bg-green-950/30 dark:border-green-800 p-4 my-2 max-w-2xl">
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <CheckCircle className="w-5 h-5 text-green-600 dark:text-green-400 flex-shrink-0" />
        <span className="font-semibold text-green-800 dark:text-green-200">
          Task Completed
        </span>
        {taskTitle && (
          <span className="text-sm text-green-600 dark:text-green-400 truncate ml-1">
            — {taskTitle}
          </span>
        )}
      </div>

      {/* Summary stats */}
      <div className="flex gap-4 text-sm text-green-700 dark:text-green-300 mb-2">
        <span>{succeededSteps.length} step{succeededSteps.length !== 1 ? 's' : ''} completed</span>
        {failedSteps.length > 0 && (
          <span className="text-red-600 dark:text-red-400">
            {failedSteps.length} failed
          </span>
        )}
        <span>{totalArtifacts} artifact{totalArtifacts !== 1 ? 's' : ''}</span>
      </div>

      {/* Key highlights */}
      {highlights.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          {highlights.map((h, i) => (
            <span
              key={i}
              className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-200"
            >
              {h.text}
            </span>
          ))}
        </div>
      )}

      {/* ── Inline artifact rendering ── */}
      {renderableArtifacts.length > 0 && (
        <div className="space-y-4 mt-3 pt-3 border-t border-green-200 dark:border-green-800">
          {renderableArtifacts.map(({ art, stepName }, i) => (
            <div key={i} className="bg-white dark:bg-gray-800 rounded-lg p-3 border border-gray-200 dark:border-gray-700">
              <div className="flex items-center gap-1.5 mb-1">
                {isChartArtifact(art) ? (
                  <TrendingUp className="w-3.5 h-3.5 text-blue-500" />
                ) : (
                  <TableIcon className="w-3.5 h-3.5 text-gray-500" />
                )}
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
                  {stepName}
                </span>
              </div>
              <ArtifactRenderer art={art} />
            </div>
          ))}
        </div>
      )}

      {/* Expandable step details */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-sm text-green-600 dark:text-green-400 hover:text-green-800 dark:hover:text-green-200 transition-colors mt-3"
      >
        {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        {expanded ? 'Hide step details' : 'Show step details'}
      </button>

      {expanded && (
        <div className="mt-2 space-y-1.5">
          {steps.map((step, i) => {
            const isOk = step.status === 'succeeded';
            const StatusIcon = isOk ? CheckCircle : XCircle;
            const statusColor = isOk ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400';

            return (
              <div
                key={i}
                className="flex items-center gap-2 px-2 py-1 rounded bg-white/60 dark:bg-gray-800/40 text-sm"
              >
                <StatusIcon className={`w-3.5 h-3.5 flex-shrink-0 ${statusColor}`} />
                <span className="text-gray-700 dark:text-gray-300">
                  {step.step_name || `Step ${step.step_index ?? i}`}
                </span>
                {step.artifacts?.length > 0 && (
                  <span className="text-xs text-gray-400 dark:text-gray-500 ml-auto">
                    {step.artifacts.length} artifact{step.artifacts.length !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
