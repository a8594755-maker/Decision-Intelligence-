/**
 * BarGradientTemplate.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Pre-compiled gradient bar chart template (Layer C).
 * Features: gradient fills, rounded bars, auto reference line, smart tooltip,
 * dark mode, responsive tick sizing, entrance animation.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from 'recharts';

const GRADIENT_PAIRS = [
  ['#3b82f6', '#1d4ed8'],  // blue
  ['#8b5cf6', '#6d28d9'],  // violet
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

export default function BarGradientTemplate({ chart, height = 300 }) {
  const { data, xKey, yKey, label, referenceLines, xAxisLabel, yAxisLabel } = chart;
  const gradientId = 'bar-grad-0';

  const autoRef = useMemo(() => {
    if (referenceLines?.length > 0) return referenceLines.slice(0, 3);
    const values = data.map(d => Number(d[yKey])).filter(v => !isNaN(v));
    if (values.length === 0) return [];
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return [{ value: Math.round(mean * 100) / 100, label: 'Average', color: '#94a3b8', strokeDasharray: '6 4' }];
  }, [data, yKey, referenceLines]);

  const tickStyle = { fontSize: 11, fill: '#64748b' };

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 20, right: 20, bottom: 40, left: 20 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={GRADIENT_PAIRS[0][0]} stopOpacity={0.9} />
            <stop offset="100%" stopColor={GRADIENT_PAIRS[0][1]} stopOpacity={0.7} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
        <XAxis
          dataKey={xKey}
          tick={tickStyle}
          angle={data.length > 10 ? -35 : 0}
          textAnchor={data.length > 10 ? 'end' : 'middle'}
          height={data.length > 10 ? 60 : 40}
          label={xAxisLabel ? { value: xAxisLabel, position: 'insideBottom', offset: -10, style: { fontSize: 12, fill: '#94a3b8' } } : undefined}
        />
        <YAxis
          tick={tickStyle}
          label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft', style: { fontSize: 12, fill: '#94a3b8' } } : undefined}
        />
        <Tooltip content={<SmartTooltip />} cursor={{ fill: 'rgba(59,130,246,0.06)' }} />
        <Bar
          dataKey={yKey}
          fill={`url(#${gradientId})`}
          radius={[8, 8, 0, 0]}
          name={label || yKey}
          animationDuration={800}
          animationEasing="ease-out"
        />
        {autoRef.map((ref, i) => (
          <ReferenceLine
            key={`ref-${i}`}
            y={ref.value}
            stroke={ref.color || '#94a3b8'}
            strokeDasharray={ref.strokeDasharray || '6 4'}
            label={{ value: `${ref.label}: ${ref.value}`, position: 'right', fill: '#94a3b8', fontSize: 10 }}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
