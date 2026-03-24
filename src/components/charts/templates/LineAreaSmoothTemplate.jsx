/**
 * LineAreaSmoothTemplate.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Pre-compiled smooth line/area chart template (Layer C).
 * Features: gradient area fill, smooth curves, animated dots, reference lines,
 * smart tooltip, dark mode, responsive design.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useMemo } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from 'recharts';

const SERIES_COLORS = [
  { stroke: '#3b82f6', fill: ['#3b82f6', '#dbeafe'] },  // blue
  { stroke: '#8b5cf6', fill: ['#8b5cf6', '#ede9fe'] },  // violet
  { stroke: '#10b981', fill: ['#10b981', '#d1fae5'] },  // emerald
  { stroke: '#f59e0b', fill: ['#f59e0b', '#fef3c7'] },  // amber
  { stroke: '#ef4444', fill: ['#ef4444', '#fee2e2'] },  // red
];

function SmartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl bg-white dark:bg-slate-800 shadow-lg border border-slate-200 dark:border-slate-700 px-4 py-3 text-sm">
      <p className="font-semibold text-slate-700 dark:text-slate-200 mb-1">{label}</p>
      {payload.map((entry, i) => (
        <p key={i} className="text-slate-600 dark:text-slate-300">
          <span style={{ color: entry.stroke || entry.color }}>●</span>{' '}
          {entry.name}: <strong>{Number(entry.value).toLocaleString()}</strong>
        </p>
      ))}
    </div>
  );
}

function CustomDot({ cx, cy, index, dataLength }) {
  // Show dots only at reasonable intervals to avoid clutter
  if (dataLength > 20 && index % Math.ceil(dataLength / 10) !== 0 && index !== dataLength - 1) return null;
  return (
    <circle cx={cx} cy={cy} r={3} fill="#fff" stroke="#3b82f6" strokeWidth={2} />
  );
}

export default function LineAreaSmoothTemplate({ chart, height = 300 }) {
  const { data, xKey, yKey, label, series, referenceLines, xAxisLabel, yAxisLabel } = chart;

  const seriesKeys = useMemo(() => {
    if (Array.isArray(series) && series.length > 0) return series;
    return [yKey];
  }, [series, yKey]);

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
      <AreaChart data={data} margin={{ top: 20, right: 20, bottom: 40, left: 20 }}>
        <defs>
          {seriesKeys.map((key, i) => {
            const colors = SERIES_COLORS[i % SERIES_COLORS.length];
            return (
              <linearGradient key={key} id={`area-grad-${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={colors.fill[0]} stopOpacity={0.3} />
                <stop offset="100%" stopColor={colors.fill[1]} stopOpacity={0.05} />
              </linearGradient>
            );
          })}
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
        <XAxis
          dataKey={xKey}
          tick={tickStyle}
          angle={data.length > 12 ? -35 : 0}
          textAnchor={data.length > 12 ? 'end' : 'middle'}
          height={data.length > 12 ? 60 : 40}
          label={xAxisLabel ? { value: xAxisLabel, position: 'insideBottom', offset: -10, style: { fontSize: 12, fill: '#94a3b8' } } : undefined}
        />
        <YAxis
          tick={tickStyle}
          label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft', style: { fontSize: 12, fill: '#94a3b8' } } : undefined}
        />
        <Tooltip content={<SmartTooltip />} />
        {seriesKeys.map((key, i) => {
          const colors = SERIES_COLORS[i % SERIES_COLORS.length];
          return (
            <Area
              key={key}
              type="monotone"
              dataKey={key}
              stroke={colors.stroke}
              strokeWidth={2.5}
              fill={`url(#area-grad-${i})`}
              name={seriesKeys.length === 1 ? (label || key) : key}
              dot={<CustomDot dataLength={data.length} />}
              activeDot={{ r: 5, stroke: colors.stroke, strokeWidth: 2, fill: '#fff' }}
              animationDuration={1000}
              animationEasing="ease-out"
            />
          );
        })}
        {autoRef.map((ref, i) => (
          <ReferenceLine
            key={`ref-${i}`}
            y={ref.value}
            stroke={ref.color || '#94a3b8'}
            strokeDasharray={ref.strokeDasharray || '6 4'}
            label={{ value: `${ref.label}: ${ref.value}`, position: 'right', fill: '#94a3b8', fontSize: 10 }}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}
