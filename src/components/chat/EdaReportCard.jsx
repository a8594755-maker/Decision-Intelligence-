/**
 * EdaReportCard
 *
 * Renders eda_report artifacts from edaService.js. Shows:
 * - Data quality score (completeness, uniqueness)
 * - Column type summary (numeric, categorical, datetime)
 * - Per-column statistics (expandable)
 * - Top correlations
 * - Highlights & warnings
 */

import React, { useState, useMemo } from 'react';
import {
  BarChart3, Hash, Calendar, Type, AlertTriangle, TrendingUp,
  ChevronDown, ChevronRight, Database, Sparkles,
} from 'lucide-react';
import { Card, Badge } from '../ui';

const TYPE_CONFIG = {
  numeric:      { icon: Hash,     color: 'text-blue-600',   bg: 'bg-blue-50',   label: 'Numeric' },
  categorical:  { icon: Type,     color: 'text-purple-600', bg: 'bg-purple-50', label: 'Categorical' },
  datetime:     { icon: Calendar, color: 'text-green-600',  bg: 'bg-green-50',  label: 'Date/Time' },
  text:         { icon: Type,     color: 'text-[var(--text-secondary)]',   bg: 'bg-[var(--surface-subtle)]',   label: 'Text' },
  empty:        { icon: Type,     color: 'text-[var(--text-muted)]',   bg: 'bg-[var(--surface-subtle)]',   label: 'Empty' },
};

function QualityBadge({ score }) {
  const color = score >= 80 ? 'success' : score >= 60 ? 'warning' : 'danger';
  const label = score >= 80 ? 'Good' : score >= 60 ? 'Fair' : 'Poor';
  return <Badge type={color}>{label} ({score}%)</Badge>;
}

function ColumnStats({ col, data }) {
  const [open, setOpen] = useState(false);
  const typeConf = TYPE_CONFIG[data.inferred_type] || TYPE_CONFIG.text;
  const TypeIcon = typeConf.icon;

  return (
    <div className="border border-[var(--border-default)] rounded-lg mb-1">
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--accent-hover)]"
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <TypeIcon className={`w-3.5 h-3.5 ${typeConf.color}`} />
        <span className="font-medium flex-1 truncate">{col}</span>
        <span className="text-xs text-[var(--text-muted)]">{typeConf.label}</span>
        {data.null_pct > 0 && (
          <span className="text-xs text-amber-600">{data.null_pct.toFixed(1)}% null</span>
        )}
      </button>
      {open && (
        <div className="px-3 pb-2 text-xs text-[var(--text-secondary)] grid grid-cols-2 gap-x-4 gap-y-1">
          <span>Count: {data.count}</span>
          <span>Unique: {data.unique_count}</span>
          {data.mean != null && <span>Mean: {Number(data.mean).toFixed(2)}</span>}
          {data.median != null && <span>Median: {Number(data.median).toFixed(2)}</span>}
          {data.std != null && <span>Std: {Number(data.std).toFixed(2)}</span>}
          {data.min != null && <span>Range: [{Number(data.min).toFixed(2)}, {Number(data.max).toFixed(2)}]</span>}
          {data.skewness != null && <span>Skewness: {Number(data.skewness).toFixed(2)}</span>}
          {data.kurtosis != null && <span>Kurtosis: {Number(data.kurtosis).toFixed(2)}</span>}
          {data.date_range && <span className="col-span-2">Range: {data.date_range.min?.slice(0, 10)} ~ {data.date_range.max?.slice(0, 10)} ({data.date_range.span_days}d)</span>}
          {data.value_counts && (
            <div className="col-span-2 mt-1">
              <span className="font-medium">Top values: </span>
              {data.value_counts.categories?.slice(0, 5).map((c, i) => (
                <span key={i} className="mr-2">{c.value} ({c.count})</span>
              ))}
              {data.value_counts.truncated && <span className="text-[var(--text-muted)]">...+{data.value_counts.total_unique - 5} more</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function EdaReportCard({ payload }) {
  const [showAllColumns, setShowAllColumns] = useState(false);

  if (!payload) return null;

  const {
    row_count = 0,
    column_count = 0,
    column_types = {},
    columns = {},
    top_correlations = [],
    data_quality = {},
    highlights = [],
    sampled,
    total_rows,
  } = payload;

  const columnEntries = useMemo(() => Object.entries(columns), [columns]);
  const visibleColumns = showAllColumns ? columnEntries : columnEntries.slice(0, 8);

  return (
    <Card category="data" className="overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 border-b border-[var(--border-default)]">
        <Database className="w-4 h-4 text-blue-600" />
        <span className="font-semibold text-sm">Exploratory Data Analysis</span>
        <div className="ml-auto flex gap-2">
          <QualityBadge score={data_quality.quality_score || 0} />
        </div>
      </div>

      <div className="p-4 space-y-4">
        {/* Overview pills */}
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="px-2 py-1 bg-[var(--surface-subtle)] rounded-full">
            {sampled ? `${row_count.toLocaleString()} / ${total_rows?.toLocaleString()} rows (sampled)` : `${row_count.toLocaleString()} rows`}
          </span>
          <span className="px-2 py-1 bg-[var(--surface-subtle)] rounded-full">{column_count} columns</span>
          <span className="px-2 py-1 bg-blue-100 dark:bg-blue-900/30 rounded-full text-blue-700 dark:text-blue-300">
            {column_types.numeric?.length || 0} numeric
          </span>
          <span className="px-2 py-1 bg-purple-100 dark:bg-purple-900/30 rounded-full text-purple-700 dark:text-purple-300">
            {column_types.categorical?.length || 0} categorical
          </span>
          <span className="px-2 py-1 bg-green-100 dark:bg-green-900/30 rounded-full text-green-700 dark:text-green-300">
            {column_types.datetime?.length || 0} datetime
          </span>
          {data_quality.completeness != null && (
            <span className="px-2 py-1 bg-emerald-100 dark:bg-emerald-900/30 rounded-full text-emerald-700">
              {data_quality.completeness}% complete
            </span>
          )}
          {data_quality.duplicates > 0 && (
            <span className="px-2 py-1 bg-amber-100 dark:bg-amber-900/30 rounded-full text-amber-700">
              {data_quality.duplicates} duplicates
            </span>
          )}
        </div>

        {/* Highlights */}
        {highlights.length > 0 && (
          <div className="space-y-1">
            {highlights.map((h, i) => {
              const Icon = h.type === 'warning' ? AlertTriangle : h.type === 'insight' ? Sparkles : TrendingUp;
              const textColor = h.type === 'warning' ? 'text-amber-700 dark:text-amber-400' : h.type === 'insight' ? 'text-blue-700 dark:text-blue-400' : 'text-[var(--text-secondary)]';
              return (
                <div key={i} className={`flex items-start gap-2 text-xs ${textColor}`}>
                  <Icon className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>{h.message}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* Top Correlations */}
        {top_correlations.length > 0 && (
          <div>
            <div className="text-xs font-semibold text-[var(--text-secondary)] mb-1">Top Correlations</div>
            <div className="flex flex-wrap gap-1">
              {top_correlations.slice(0, 6).map((c, i) => (
                <span
                  key={i}
                  className={`text-xs px-2 py-0.5 rounded-full ${
                    Math.abs(c.correlation) > 0.8
                      ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                      : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                  }`}
                >
                  {c.col1} ↔ {c.col2}: {c.correlation > 0 ? '+' : ''}{c.correlation}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Column Details */}
        <div>
          <div className="text-xs font-semibold text-[var(--text-secondary)] mb-1">Column Details</div>
          {visibleColumns.map(([col, data]) => (
            <ColumnStats key={col} col={col} data={data} />
          ))}
          {columnEntries.length > 8 && (
            <button
              className="text-xs text-blue-600 hover:text-blue-700 mt-1"
              onClick={() => setShowAllColumns(!showAllColumns)}
            >
              {showAllColumns ? 'Show fewer' : `Show all ${columnEntries.length} columns`}
            </button>
          )}
        </div>
      </div>
    </Card>
  );
}
