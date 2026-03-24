/**
 * PieDonutModernTemplate.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Pre-compiled modern donut/pie chart template (Layer C).
 * Features: gradient fills, inner label, animated entrance, smart tooltip,
 * dark mode, clean legend, rounded corners.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useMemo } from 'react';
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

const COLORS = [
  '#3b82f6', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b',
  '#ef4444', '#ec4899', '#14b8a6', '#6366f1', '#eab308',
  '#0ea5e9', '#a855f7',
];

function SmartTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const entry = payload[0];
  return (
    <div className="rounded-xl bg-white dark:bg-slate-800 shadow-lg border border-slate-200 dark:border-slate-700 px-4 py-3 text-sm">
      <p className="text-slate-600 dark:text-slate-300">
        <span style={{ color: entry.payload?.fill }}>●</span>{' '}
        {entry.name}: <strong>{Number(entry.value).toLocaleString()}</strong>
        {entry.payload?.percent != null && (
          <span className="text-slate-400 ml-1">({(entry.payload.percent * 100).toFixed(1)}%)</span>
        )}
      </p>
    </div>
  );
}

function CustomLegend({ payload }) {
  return (
    <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 mt-2">
      {payload?.map((entry, i) => (
        <div key={i} className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400">
          <span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: entry.color }} />
          {entry.value}
        </div>
      ))}
    </div>
  );
}

const RADIAN = Math.PI / 180;

function renderCustomLabel({ cx, cy, midAngle, innerRadius, outerRadius, percent, name }) {
  if (percent < 0.05) return null; // Skip labels for tiny slices
  const radius = innerRadius + (outerRadius - innerRadius) * 0.5;
  const x = cx + radius * Math.cos(-midAngle * RADIAN);
  const y = cy + radius * Math.sin(-midAngle * RADIAN);
  return (
    <text x={x} y={y} fill="#fff" textAnchor="middle" dominantBaseline="central" fontSize={11} fontWeight={600}>
      {`${(percent * 100).toFixed(0)}%`}
    </text>
  );
}

export default function PieDonutModernTemplate({ chart, height = 300 }) {
  const { data, xKey, yKey, label, innerRadius: customInner } = chart;

  const total = useMemo(() => data.reduce((sum, d) => sum + Number(d[yKey] || 0), 0), [data, yKey]);
  const isDonut = chart.type === 'donut' || customInner;

  const outerR = Math.min(height * 0.35, 120);
  const innerR = isDonut ? outerR * 0.6 : 0;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="45%"
          innerRadius={innerR}
          outerRadius={outerR}
          dataKey={yKey}
          nameKey={xKey}
          paddingAngle={data.length > 1 ? 2 : 0}
          cornerRadius={4}
          label={renderCustomLabel}
          labelLine={false}
          animationDuration={800}
          animationEasing="ease-out"
        >
          {data.map((_, i) => (
            <Cell key={i} fill={COLORS[i % COLORS.length]} stroke="none" />
          ))}
        </Pie>
        <Tooltip content={<SmartTooltip />} />
        <Legend content={<CustomLegend />} />
        {isDonut && (
          <text x="50%" y="45%" textAnchor="middle" dominantBaseline="central">
            <tspan fontSize={20} fontWeight={700} fill="#334155" className="dark:fill-slate-200">
              {total >= 1000 ? `${(total / 1000).toFixed(1)}K` : total.toLocaleString()}
            </tspan>
            <tspan x="50%" dy="1.4em" fontSize={10} fill="#94a3b8">
              {label || 'Total'}
            </tspan>
          </text>
        )}
      </PieChart>
    </ResponsiveContainer>
  );
}
