/**
 * StackedGroupedTemplate.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Pre-compiled stacked/grouped bar chart template (Layer C).
 * Features: gradient fills per series, rounded top bars, smart tooltip,
 * clean legend, dark mode, entrance animation.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts';

const SERIES_COLORS = [
  { base: '#3b82f6', light: '#93c5fd' },  // blue
  { base: '#8b5cf6', light: '#c4b5fd' },  // violet
  { base: '#10b981', light: '#6ee7b7' },  // emerald
  { base: '#f59e0b', light: '#fcd34d' },  // amber
  { base: '#ef4444', light: '#fca5a5' },  // red
  { base: '#06b6d4', light: '#67e8f9' },  // cyan
  { base: '#ec4899', light: '#f9a8d4' },  // pink
  { base: '#6366f1', light: '#a5b4fc' },  // indigo
];

function SmartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const total = payload.reduce((sum, p) => sum + Number(p.value || 0), 0);
  return (
    <div className="rounded-xl bg-white dark:bg-slate-800 shadow-lg border border-slate-200 dark:border-slate-700 px-4 py-3 text-sm min-w-[160px]">
      <p className="font-semibold text-slate-700 dark:text-slate-200 mb-1.5">{label}</p>
      {payload.map((entry, i) => (
        <p key={i} className="flex justify-between gap-3 text-slate-600 dark:text-slate-300">
          <span>
            <span style={{ color: entry.color }}>●</span> {entry.name}
          </span>
          <strong>{Number(entry.value).toLocaleString()}</strong>
        </p>
      ))}
      {payload.length > 1 && (
        <p className="flex justify-between gap-3 mt-1 pt-1 border-t border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 font-semibold">
          <span>Total</span>
          <span>{total.toLocaleString()}</span>
        </p>
      )}
    </div>
  );
}

function CustomLegend({ payload }) {
  return (
    <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 mt-2">
      {payload?.map((entry, i) => (
        <div key={i} className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400">
          <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ backgroundColor: entry.color }} />
          {entry.value}
        </div>
      ))}
    </div>
  );
}

export default function StackedGroupedTemplate({ chart, height = 300 }) {
  const { data, xKey, yKey, series, label, xAxisLabel, yAxisLabel } = chart;

  const seriesKeys = useMemo(() => {
    if (Array.isArray(series) && series.length > 0) return series;
    if (yKey) return [yKey];
    return [];
  }, [series, yKey]);

  const isStacked = chart.type === 'stacked_bar';
  const tickStyle = { fontSize: 11, fill: '#64748b' };

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 20, right: 20, bottom: 40, left: 20 }}>
        <defs>
          {seriesKeys.map((key, i) => {
            const c = SERIES_COLORS[i % SERIES_COLORS.length];
            return (
              <linearGradient key={key} id={`sg-grad-${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={c.base} stopOpacity={0.9} />
                <stop offset="100%" stopColor={c.base} stopOpacity={0.65} />
              </linearGradient>
            );
          })}
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
        <XAxis
          dataKey={xKey}
          tick={tickStyle}
          angle={data.length > 8 ? -35 : 0}
          textAnchor={data.length > 8 ? 'end' : 'middle'}
          height={data.length > 8 ? 60 : 40}
          label={xAxisLabel ? { value: xAxisLabel, position: 'insideBottom', offset: -10, style: { fontSize: 12, fill: '#94a3b8' } } : undefined}
        />
        <YAxis
          tick={tickStyle}
          label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft', style: { fontSize: 12, fill: '#94a3b8' } } : undefined}
        />
        <Tooltip content={<SmartTooltip />} cursor={{ fill: 'rgba(59,130,246,0.06)' }} />
        <Legend content={<CustomLegend />} />
        {seriesKeys.map((key, i) => {
          const isLast = i === seriesKeys.length - 1;
          return (
            <Bar
              key={key}
              dataKey={key}
              fill={`url(#sg-grad-${i})`}
              stackId={isStacked ? 'stack' : undefined}
              radius={isStacked && isLast ? [6, 6, 0, 0] : isStacked ? [0, 0, 0, 0] : [6, 6, 0, 0]}
              name={key}
              animationDuration={800}
              animationEasing="ease-out"
            />
          );
        })}
      </BarChart>
    </ResponsiveContainer>
  );
}
