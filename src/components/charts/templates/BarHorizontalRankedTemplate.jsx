/**
 * BarHorizontalRankedTemplate.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Pre-compiled horizontal ranked bar chart template (Layer C).
 * Features: gradient fills, rounded bars, value labels, smart tooltip,
 * dark mode, entrance animation, sorted by value descending.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, LabelList,
} from 'recharts';

const GRADIENT_PAIRS = [
  ['#8b5cf6', '#6d28d9'],  // violet
  ['#3b82f6', '#1d4ed8'],  // blue
  ['#06b6d4', '#0891b2'],  // cyan
  ['#10b981', '#059669'],  // emerald
  ['#f59e0b', '#d97706'],  // amber
];

function SmartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl bg-white dark:bg-slate-800 shadow-lg border border-slate-200 dark:border-slate-700 px-4 py-3 text-sm">
      <p className="font-semibold text-slate-700 dark:text-slate-200 mb-1">{label}</p>
      {payload.map((entry, i) => (
        <p key={i} className="text-slate-600 dark:text-slate-300">
          <span style={{ color: entry.color }}>●</span>{' '}
          {entry.name}: <strong>{Number(entry.value).toLocaleString()}</strong>
        </p>
      ))}
    </div>
  );
}

export default function BarHorizontalRankedTemplate({ chart, height = 300 }) {
  const { data, xKey, yKey, label, xAxisLabel, yAxisLabel } = chart;

  const sortedData = useMemo(() => {
    return [...data].sort((a, b) => Number(b[yKey]) - Number(a[yKey]));
  }, [data, yKey]);

  const dynamicHeight = Math.max(height, sortedData.length * 36 + 60);
  const tickStyle = { fontSize: 11, fill: '#64748b' };

  return (
    <ResponsiveContainer width="100%" height={dynamicHeight}>
      <BarChart data={sortedData} layout="vertical" margin={{ top: 10, right: 60, bottom: 20, left: 20 }}>
        <defs>
          <linearGradient id="h-bar-grad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={GRADIENT_PAIRS[0][0]} stopOpacity={0.85} />
            <stop offset="100%" stopColor={GRADIENT_PAIRS[0][1]} stopOpacity={0.95} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
        <XAxis
          type="number"
          tick={tickStyle}
          label={yAxisLabel ? { value: yAxisLabel, position: 'insideBottom', offset: -5, style: { fontSize: 12, fill: '#94a3b8' } } : undefined}
        />
        <YAxis
          type="category"
          dataKey={xKey}
          tick={tickStyle}
          width={120}
          label={xAxisLabel ? { value: xAxisLabel, angle: -90, position: 'insideLeft', style: { fontSize: 12, fill: '#94a3b8' } } : undefined}
        />
        <Tooltip content={<SmartTooltip />} cursor={{ fill: 'rgba(139,92,246,0.06)' }} />
        <Bar
          dataKey={yKey}
          fill="url(#h-bar-grad)"
          radius={[0, 6, 6, 0]}
          name={label || yKey}
          animationDuration={800}
          animationEasing="ease-out"
        >
          <LabelList
            dataKey={yKey}
            position="right"
            formatter={(v) => Number(v).toLocaleString()}
            style={{ fontSize: 10, fill: '#64748b' }}
          />
          {sortedData.map((_, i) => {
            const opacity = 1 - (i / sortedData.length) * 0.4;
            return <Cell key={i} fillOpacity={opacity} />;
          })}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
