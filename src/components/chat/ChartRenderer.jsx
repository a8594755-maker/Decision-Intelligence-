/**
 * ChartRenderer.jsx
 *
 * Universal chart renderer with 19 chart types and an interactive type switcher.
 * Extracted from AnalysisResultCard and extended with new chart types.
 *
 * Props:
 * - chart: { type, data, xKey, yKey, label, title, series, gini, innerRadius,
 *            referenceLines?, colorMap?, colors?, xAxisLabel?, yAxisLabel?, tickFormatter? }
 * - height: number (default 260)
 * - compatibleTypes: string[] — chart types the user can switch to
 * - showSwitcher: boolean (default true when compatibleTypes provided)
 */

import React, { useState } from 'react';
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, Rectangle,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
  ScatterChart, Scatter, ZAxis,
  AreaChart, Area,
  Treemap,
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  FunnelChart, Funnel, LabelList,
  Sankey as RechartsSankey,
  ComposedChart, ReferenceLine,
} from 'recharts';
import { ChevronDown } from 'lucide-react';

// ── Constants ────────────────────────────────────────────────────────────────

const CHART_PALETTES = {
  default: ['#0d9488', '#6366f1', '#2563eb', '#d97706', '#dc2626', '#7c3aed', '#db2777', '#0891b2', '#059669', '#ca8a04'],
  diverging: ['#059669', '#dc2626'],
  sequential: ['#ccfbf1', '#99f6e4', '#5eead4', '#2dd4bf', '#14b8a6', '#0d9488'],
  categorical: ['#0d9488', '#dc2626', '#059669', '#d97706', '#7c3aed', '#db2777', '#6366f1', '#ca8a04'],
};

// Default palette — backward-compatible export
const CHART_COLORS = CHART_PALETTES.default;
const HEATMAP_COLORS = CHART_PALETTES.sequential;
const WEEKDAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function selectPalette(chartType) {
  if (chartType === 'waterfall') return CHART_PALETTES.diverging;
  if (chartType === 'heatmap') return CHART_PALETTES.sequential;
  return CHART_PALETTES.default;
}

const CHART_TYPE_LABELS = {
  bar: 'Bar',
  horizontal_bar: 'Horizontal Bar',
  line: 'Line',
  area: 'Area',
  pie: 'Pie',
  donut: 'Donut',
  scatter: 'Scatter',
  bubble: 'Bubble',
  stacked_bar: 'Stacked Bar',
  grouped_bar: 'Grouped Bar',
  histogram: 'Histogram',
  lorenz: 'Lorenz',
  heatmap: 'Heatmap',
  treemap: 'Treemap',
  radar: 'Radar',
  funnel: 'Funnel',
  sankey: 'Sankey',
  waterfall: 'Waterfall',
  pareto: 'Pareto',
};

const MARGIN = { top: 8, right: 20, left: 10, bottom: 5 };
const TICK_STYLE = { fontSize: 10, fill: '#78716c' };
const GRID_PROPS = { strokeDasharray: '3 3', stroke: '#f5f5f4', strokeOpacity: 0.7 };
const TOOLTIP_STYLE = { fontSize: 11, borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.08)', border: 'none', padding: '8px 12px', backgroundColor: 'var(--surface-card)', color: 'var(--text-primary)' };

function isNumericLike(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string') return false;
  return /^-?\d+(\.\d+)?$/.test(value.trim());
}

function formatCompactNumber(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return value;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toFixed(0);
}

function formatHeatmapAxisLabel(value) {
  if (isNumericLike(value)) {
    return String(value).padStart(2, '0');
  }
  return String(value);
}

function sortHeatmapValues(values) {
  if (values.every((value) => WEEKDAY_ORDER.includes(String(value)))) {
    return [...values].sort((a, b) => WEEKDAY_ORDER.indexOf(String(a)) - WEEKDAY_ORDER.indexOf(String(b)));
  }
  if (values.every(isNumericLike)) {
    return [...values].sort((a, b) => Number(a) - Number(b));
  }
  return values;
}

// ── Enhancement Helpers (referenceLines, colorMap, tickFormatter, axisLabel) ─

const TICK_FORMATTERS = {
  compact: formatCompactNumber,
  currency: (v) => typeof v === 'number' ? `R$${formatCompactNumber(v)}` : v,
  percent: (v) => typeof v === 'number' ? `${v.toFixed(1)}%` : v,
};

function buildTickFormatter(fmt) {
  return TICK_FORMATTERS[fmt] || undefined;
}

/**
 * Deconflict reference lines that are too close together.
 * When two lines on the same axis are within MIN_GAP_PX pixels of each other
 * (estimated via value proximity), merge their labels or offset them.
 */
function deconflictReferenceLines(lines = [], maxLines = 3) {
  if (lines.length <= 1) return lines;

  // Cap at maxLines — keep first, last, and middle ones
  let capped = lines;
  if (lines.length > maxLines) {
    const sorted = [...lines].sort((a, b) => {
      const aVal = typeof a.value === 'number' ? a.value : String(a.value || '');
      const bVal = typeof b.value === 'number' ? b.value : String(b.value || '');
      return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
    });
    // Keep first, last, and evenly-spaced middle lines
    const step = Math.max(1, Math.floor((sorted.length - 1) / (maxLines - 1)));
    const indices = new Set([0, sorted.length - 1]);
    for (let i = step; i < sorted.length - 1; i += step) indices.add(i);
    capped = [...indices].sort((a, b) => a - b).map((idx) => sorted[idx]);
  }

  // Merge labels for lines with identical values
  const merged = [];
  const seen = new Map();
  for (const line of capped) {
    const key = `${line.axis || 'y'}:${line.value}`;
    if (seen.has(key)) {
      const existing = seen.get(key);
      if (line.label && existing.label) {
        existing.label = `${existing.label}/${line.label}`;
      }
    } else {
      const copy = { ...line };
      seen.set(key, copy);
      merged.push(copy);
    }
  }

  // Alternate label positions when lines on the same axis are close by value
  const byAxis = { x: [], y: [] };
  for (const line of merged) byAxis[line.axis === 'x' ? 'x' : 'y'].push(line);
  for (const group of Object.values(byAxis)) {
    if (group.length < 2) continue;
    group.sort((a, b) => {
      const av = typeof a.value === 'number' ? a.value : 0;
      const bv = typeof b.value === 'number' ? b.value : 0;
      return av - bv;
    });
    const allNumeric = group.every((l) => typeof l.value === 'number');
    if (!allNumeric) continue;
    const range = (group[group.length - 1].value || 1) - (group[0].value || 0);
    for (let i = 1; i < group.length; i++) {
      const gap = Math.abs(group[i].value - group[i - 1].value);
      if (range > 0 && gap / range < 0.06) {
        // Too close — alternate label position to avoid overlap
        group[i]._labelOffset = i % 2 === 0 ? 'top' : 'insideTopRight';
      }
    }
  }

  return merged;
}

function renderReferenceLines(lines = [], yAxisId) {
  const deconflicted = deconflictReferenceLines(lines);
  return deconflicted.map((ref, i) => {
    const position = ref._labelOffset
      || (ref.axis === 'x' ? 'top' : 'right');
    return (
      <ReferenceLine
        key={`ref-${i}`}
        {...(ref.axis === 'x' ? { x: ref.value } : { y: ref.value })}
        {...(yAxisId ? { yAxisId } : {})}
        stroke={ref.color || '#ef4444'}
        strokeDasharray={ref.strokeDasharray || '4 4'}
        label={ref.label ? {
          value: ref.label,
          position,
          fontSize: 9,
          fill: ref.color || '#ef4444',
        } : undefined}
      />
    );
  });
}

function resolveBarColor(chart, entry, index) {
  const xVal = entry?.[chart.xKey];
  if (chart.colorMap && xVal != null && chart.colorMap[xVal]) return chart.colorMap[xVal];
  if (chart.colors?.[index]) return chart.colors[index];
  return null; // caller decides default
}

function axisLabelProp(text, axis) {
  if (!text) return {};
  if (axis === 'y') {
    return { label: { value: text, angle: -90, position: 'insideLeft', fontSize: 10, fill: '#94a3b8', offset: -5 } };
  }
  return { label: { value: text, position: 'insideBottomRight', offset: -5, fontSize: 10, fill: '#94a3b8' } };
}

// ── Main Component ───────────────────────────────────────────────────────────

/**
 * Detect if a multi-series chart has incompatible scales (>10x magnitude difference).
 * Returns split single-series charts if incompatible, or null if OK.
 */
function splitIfIncompatibleScales(chart) {
  const seriesKeys = Array.isArray(chart?.series) ? chart.series : [];
  if (seriesKeys.length < 2 || !Array.isArray(chart?.data) || chart.data.length === 0) return null;

  const magnitudes = seriesKeys.map(key => {
    const vals = chart.data.map(d => Math.abs(Number(d?.[key]) || 0)).filter(v => v > 0);
    return vals.length > 0 ? Math.max(...vals) : 0;
  }).filter(v => v > 0);

  if (magnitudes.length < 2) return null;

  const ratio = Math.max(...magnitudes) / Math.max(Math.min(...magnitudes), 1e-9);
  if (ratio <= 10) return null; // Scales compatible

  // Split into separate single-series charts
  return seriesKeys.map(key => ({
    ...chart,
    title: `${chart.title || 'Chart'} — ${key}`,
    yKey: key,
    series: [key],
  }));
}

export default function ChartRenderer({ chart: rawChart, height = 260, compatibleTypes, showSwitcher, mini = false }) {
  const [overrideType, setOverrideType] = useState(null);

  if (!rawChart) return null;

  // Sanitize: ensure all numeric data values are actual numbers (not strings)
  const chart = { ...rawChart };
  if (Array.isArray(chart.data)) {
    chart.data = chart.data.map(row => {
      const clean = { ...row };
      for (const key of Object.keys(clean)) {
        if (key === (chart.xKey || 'name')) continue; // keep label as string
        if (typeof clean[key] === 'string' && !isNaN(clean[key])) clean[key] = Number(clean[key]);
      }
      return clean;
    });
  }

  // Auto-split multi-series charts with incompatible scales
  const splitCharts = splitIfIncompatibleScales(chart);
  if (splitCharts) {
    return (
      <div className="space-y-4">
        {splitCharts.map((subChart, i) => (
          <ChartRenderer key={`${subChart.title}-${i}`} chart={subChart} height={height} mini={mini} />
        ))}
      </div>
    );
  }

  const effectiveType = overrideType || chart.type;
  const effectiveChart = { ...chart, type: effectiveType };
  const canSwitch = !mini && showSwitcher !== false && compatibleTypes && compatibleTypes.length > 1;
  const effectiveHeight = mini ? Math.min(height, 140) : height;

  return (
    <div>
      {/* Chart type switcher (hidden in mini mode) */}
      {canSwitch && (
        <div className="flex items-center justify-end gap-1.5 mb-1.5">
          <span className="text-[10px] text-slate-400">Chart:</span>
          <div className="relative inline-block">
            <select
              value={effectiveType}
              onChange={(e) => setOverrideType(e.target.value)}
              className="appearance-none text-[10px] font-medium pl-2 pr-5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 cursor-pointer hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
            >
              {compatibleTypes.map((t) => (
                <option key={t} value={t}>{CHART_TYPE_LABELS[t] || t}</option>
              ))}
            </select>
            <ChevronDown className="absolute right-1 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400 pointer-events-none" />
          </div>
        </div>
      )}

      {/* Chart title (hidden in mini mode) */}
      {!mini && chart.title && (
        <div className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-2">{chart.title}</div>
      )}

      {/* Chart body — heatmap/sankey use custom rendering, skip ResponsiveContainer */}
      <div className={mini ? 'rounded-lg overflow-hidden' : 'bg-white dark:bg-gray-800/40 rounded-lg p-2 border border-slate-100 dark:border-slate-700'}>
        {effectiveType === 'heatmap' || effectiveType === 'sankey' ? (
          <div style={{ width: '100%', height: effectiveHeight }}>
            {renderChartByType(effectiveChart)}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={effectiveHeight}>
            {renderChartByType(effectiveChart)}
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

// ── Chart Renderers ──────────────────────────────────────────────────────────

function renderChartByType(chart) {
  let { type, data = [], xKey, yKey, label, series } = chart;

  // ── Auto-fix: comma-separated yKey → split into series ──
  if (yKey && typeof yKey === 'string' && yKey.includes(',')) {
    const keys = yKey.split(',').map(k => k.trim()).filter(Boolean);
    if (keys.length > 1) {
      console.info('[ChartRenderer] Auto-fixing comma-separated yKey:', yKey, '→ series:', keys);
      yKey = keys[0];
      series = keys;
      if (type === 'bar' && keys.length > 1) type = 'grouped_bar';
    }
  }

  // Sankey uses object-shaped data { nodes, links }, skip array validation
  if (type === 'sankey') {
    if (!data || (!data.nodes?.length && !data.links?.length)) {
      return <div className="text-xs text-slate-400 text-center py-8">No chart data</div>;
    }
  } else {
    if (!data || !Array.isArray(data) || data.length === 0 || data.every(d => !d || Object.keys(d).length === 0)) {
      return <div className="text-xs text-slate-400 text-center py-8">No chart data</div>;
    }

    if (yKey && data.every(d => d[yKey] == null)) {
      console.warn('[ChartRenderer] yKey mismatch — data keys:', Object.keys(data[0]), 'yKey:', yKey);
    }
  }

  switch (type) {
    case 'line':
      return renderLine(chart);
    case 'bar':
      return renderBar(chart);
    case 'horizontal_bar':
      return renderHorizontalBar(chart);
    case 'pie':
      return renderPie(chart, false);
    case 'donut':
      return renderPie(chart, true);
    case 'scatter':
      return renderScatter(chart);
    case 'stacked_bar':
      return renderStackedBar(chart);
    case 'grouped_bar':
      return renderGroupedBar(chart);
    case 'area':
      return renderArea(chart);
    case 'histogram':
      return renderHistogram(chart);
    case 'lorenz':
      return renderLorenz(chart);
    case 'heatmap':
      return renderHeatmap(chart);
    case 'treemap':
      return renderTreemap(chart);
    case 'radar':
      return renderRadar(chart);
    case 'funnel':
      return renderFunnel(chart);
    case 'sankey':
      return renderSankey(chart);
    case 'waterfall':
      return renderWaterfall(chart);
    case 'pareto':
      return renderPareto(chart);
    case 'bubble':
      return renderBubble(chart);
    default:
      // Fallback: vertical bar
      return renderBar(chart);
  }
}

function renderLine(chart) {
  const { data, xKey, yKey, label, series, referenceLines, xAxisLabel, yAxisLabel, tickFormatter: tf } = chart;
  const yKeys = series || (Array.isArray(yKey) ? yKey : [yKey]);
  return (
    <LineChart data={data} margin={MARGIN}>
      <CartesianGrid {...GRID_PROPS} />
      <XAxis dataKey={xKey} tick={TICK_STYLE} angle={-30} textAnchor="end" height={50} tickFormatter={buildTickFormatter(tf?.x)} {...axisLabelProp(xAxisLabel, 'x')} />
      <YAxis tick={TICK_STYLE} tickFormatter={buildTickFormatter(tf?.y)} {...axisLabelProp(yAxisLabel, 'y')} />
      <Tooltip contentStyle={TOOLTIP_STYLE} />
      <Legend wrapperStyle={{ fontSize: 11 }} />
      {yKeys.map((k, i) => (
        <Line key={k} type="monotone" dataKey={k} stroke={CHART_COLORS[i % CHART_COLORS.length]} strokeWidth={2} dot={{ r: 2.5, strokeWidth: 1.5 }} activeDot={{ r: 5, strokeWidth: 2 }} name={yKeys.length === 1 ? (label || k) : k} />
      ))}
      {renderReferenceLines(referenceLines)}
    </LineChart>
  );
}

function renderBar(chart) {
  const { data, xKey, yKey, label, referenceLines, colorMap, colors, xAxisLabel, yAxisLabel, tickFormatter: tf } = chart;
  const needsCustomColor = !!(colorMap || colors);
  return (
    <BarChart data={data} margin={MARGIN}>
      <CartesianGrid {...GRID_PROPS} />
      <XAxis dataKey={xKey} tick={TICK_STYLE} angle={-30} textAnchor="end" height={50} tickFormatter={buildTickFormatter(tf?.x)} {...axisLabelProp(xAxisLabel, 'x')} />
      <YAxis tick={TICK_STYLE} tickFormatter={buildTickFormatter(tf?.y)} {...axisLabelProp(yAxisLabel, 'y')} />
      <Tooltip contentStyle={TOOLTIP_STYLE} />
      <Bar
        dataKey={yKey}
        fill={CHART_COLORS[0]}
        radius={[6, 6, 0, 0]}
        name={label || yKey}
        shape={needsCustomColor
          ? (props) => <Rectangle {...props} fill={resolveBarColor(chart, props.payload, props.index) || CHART_COLORS[0]} />
          : undefined}
      />
      {renderReferenceLines(referenceLines)}
    </BarChart>
  );
}

function renderHorizontalBar(chart) {
  const { data, xKey, yKey, label, referenceLines, colorMap, colors, xAxisLabel, yAxisLabel, tickFormatter: tf } = chart;
  const sorted = [...data].sort((a, b) => (Number(b[yKey]) || 0) - (Number(a[yKey]) || 0));
  const needsCustomColor = !!(colorMap || colors);
  return (
    <BarChart data={sorted} layout="vertical" margin={{ ...MARGIN, left: 80 }}>
      <CartesianGrid {...GRID_PROPS} />
      <XAxis type="number" tick={TICK_STYLE} tickFormatter={buildTickFormatter(tf?.y)} {...axisLabelProp(xAxisLabel, 'x')} />
      <YAxis dataKey={xKey} type="category" tick={TICK_STYLE} width={75} {...axisLabelProp(yAxisLabel, 'y')} />
      <Tooltip contentStyle={TOOLTIP_STYLE} />
      <Bar
        dataKey={yKey}
        fill={CHART_COLORS[0]}
        radius={[0, 6, 6, 0]}
        name={label || yKey}
        shape={needsCustomColor
          ? (props) => <Rectangle {...props} fill={resolveBarColor(chart, props.payload, props.index) || CHART_COLORS[0]} />
          : undefined}
      />
      {renderReferenceLines(referenceLines)}
    </BarChart>
  );
}

function renderPie({ data, xKey, yKey, label }, isDonut) {
  return (
    <PieChart>
      <Pie
        data={data}
        dataKey={yKey}
        nameKey={xKey}
        cx="50%"
        cy="50%"
        outerRadius={80}
        innerRadius={isDonut ? 45 : 0}
        label={({ name, percent, x, y, midAngle }) => {
          const RADIAN = Math.PI / 180;
          const radius = 95;
          const cx2 = x + radius * Math.cos(-midAngle * RADIAN) * 0.15;
          const cy2 = y + radius * Math.sin(-midAngle * RADIAN) * 0.15;
          return (
            <text x={cx2} y={cy2} textAnchor={cx2 > x ? 'start' : 'end'} dominantBaseline="central" fontSize={10} fill="#475569">
              {`${name} ${(percent * 100).toFixed(0)}%`}
            </text>
          );
        }}
        labelLine={{ strokeWidth: 1, stroke: '#94a3b8' }}
      >
        {data.map((_, i) => (
          <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
        ))}
      </Pie>
      <Tooltip contentStyle={TOOLTIP_STYLE} />
      <Legend wrapperStyle={{ fontSize: 11 }} />
    </PieChart>
  );
}

function renderScatter(chart) {
  const { data, xKey, yKey, label, referenceLines, xAxisLabel, yAxisLabel, tickFormatter: tf } = chart;
  return (
    <ScatterChart margin={MARGIN}>
      <CartesianGrid {...GRID_PROPS} />
      <XAxis dataKey={xKey} name={xKey} tick={TICK_STYLE} tickFormatter={buildTickFormatter(tf?.x)} {...axisLabelProp(xAxisLabel, 'x')} />
      <YAxis dataKey={yKey} name={yKey} tick={TICK_STYLE} tickFormatter={buildTickFormatter(tf?.y)} {...axisLabelProp(yAxisLabel, 'y')} />
      <ZAxis range={[30, 30]} />
      <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ strokeDasharray: '3 3' }} />
      <Scatter name={label || `${xKey} vs ${yKey}`} data={data} fill={CHART_COLORS[0]} />
      {renderReferenceLines(referenceLines)}
    </ScatterChart>
  );
}

function renderStackedBar(chart) {
  const { data, xKey, yKey, series, label, referenceLines, xAxisLabel, yAxisLabel, tickFormatter: tf } = chart;
  const yKeys = series || (Array.isArray(yKey) ? yKey : [yKey]);
  return (
    <BarChart data={data} margin={MARGIN}>
      <CartesianGrid {...GRID_PROPS} />
      <XAxis dataKey={xKey} tick={TICK_STYLE} angle={-30} textAnchor="end" height={50} tickFormatter={buildTickFormatter(tf?.x)} {...axisLabelProp(xAxisLabel, 'x')} />
      <YAxis tick={TICK_STYLE} tickFormatter={buildTickFormatter(tf?.y)} {...axisLabelProp(yAxisLabel, 'y')} />
      <Tooltip contentStyle={TOOLTIP_STYLE} />
      <Legend wrapperStyle={{ fontSize: 11 }} />
      {yKeys.map((k, i) => (
        <Bar key={k} dataKey={k} stackId="stack" fill={CHART_COLORS[i % CHART_COLORS.length]} name={k} />
      ))}
      {renderReferenceLines(referenceLines)}
    </BarChart>
  );
}

function renderGroupedBar(chart) {
  const { data, xKey, yKey, series, label, referenceLines, xAxisLabel, yAxisLabel, tickFormatter: tf } = chart;
  const yKeys = series || (Array.isArray(yKey) ? yKey : [yKey]);
  return (
    <BarChart data={data} margin={MARGIN}>
      <CartesianGrid {...GRID_PROPS} />
      <XAxis dataKey={xKey} tick={TICK_STYLE} angle={-30} textAnchor="end" height={50} tickFormatter={buildTickFormatter(tf?.x)} {...axisLabelProp(xAxisLabel, 'x')} />
      <YAxis tick={TICK_STYLE} tickFormatter={buildTickFormatter(tf?.y)} {...axisLabelProp(yAxisLabel, 'y')} />
      <Tooltip contentStyle={TOOLTIP_STYLE} />
      <Legend wrapperStyle={{ fontSize: 11 }} />
      {yKeys.map((k, i) => (
        <Bar key={k} dataKey={k} fill={CHART_COLORS[i % CHART_COLORS.length]} radius={[6, 6, 0, 0]} name={k} />
      ))}
      {renderReferenceLines(referenceLines)}
    </BarChart>
  );
}

function renderArea(chart) {
  const { data, xKey, yKey, label, series, referenceLines, xAxisLabel, yAxisLabel, tickFormatter: tf } = chart;
  const yKeys = series || (Array.isArray(yKey) ? yKey : [yKey]);
  return (
    <AreaChart data={data} margin={MARGIN}>
      <CartesianGrid {...GRID_PROPS} />
      <XAxis dataKey={xKey} tick={TICK_STYLE} angle={-30} textAnchor="end" height={50} tickFormatter={buildTickFormatter(tf?.x)} {...axisLabelProp(xAxisLabel, 'x')} />
      <YAxis tick={TICK_STYLE} tickFormatter={buildTickFormatter(tf?.y)} {...axisLabelProp(yAxisLabel, 'y')} />
      <Tooltip contentStyle={TOOLTIP_STYLE} />
      <Legend wrapperStyle={{ fontSize: 11 }} />
      {yKeys.map((k, i) => (
        <Area key={k} type="monotone" dataKey={k} stroke={CHART_COLORS[i % CHART_COLORS.length]} fill={CHART_COLORS[i % CHART_COLORS.length]} fillOpacity={0.12} strokeWidth={2} activeDot={{ r: 4, strokeWidth: 2 }} name={yKeys.length === 1 ? (label || k) : k} />
      ))}
      {renderReferenceLines(referenceLines)}
    </AreaChart>
  );
}

function renderHistogram(chart) {
  const { data, xKey, yKey, label, referenceLines, colorMap, colors, xAxisLabel, yAxisLabel, tickFormatter: tf } = chart;
  const needsCustomColor = !!(colorMap || colors);
  return (
    <BarChart data={data} margin={MARGIN} barCategoryGap={0} barGap={0}>
      <CartesianGrid {...GRID_PROPS} />
      <XAxis dataKey={xKey} tick={TICK_STYLE} angle={-30} textAnchor="end" height={50} tickFormatter={buildTickFormatter(tf?.x)} {...axisLabelProp(xAxisLabel, 'x')} />
      <YAxis tick={TICK_STYLE} tickFormatter={buildTickFormatter(tf?.y)} {...axisLabelProp(yAxisLabel, 'y')} />
      <Tooltip contentStyle={TOOLTIP_STYLE} />
      <Bar
        dataKey={yKey}
        fill={CHART_COLORS[4]}
        name={label || yKey}
        shape={needsCustomColor
          ? (props) => <Rectangle {...props} fill={resolveBarColor(chart, props.payload, props.index) || CHART_COLORS[4]} />
          : undefined}
      />
      {renderReferenceLines(referenceLines)}
    </BarChart>
  );
}

function renderLorenz(chart) {
  const { data, xKey, yKey, label, gini } = chart;
  const diagonalData = data.map(d => ({ ...d, equality: d[xKey] }));
  return (
    <div>
      {gini != null && (
        <div className="text-[10px] text-slate-500 dark:text-slate-400 mb-1 text-right">
          Gini = <span className="font-semibold text-blue-600 dark:text-blue-400">{gini.toFixed(3)}</span>
        </div>
      )}
      <LineChart data={diagonalData} margin={MARGIN}>
        <CartesianGrid {...GRID_PROPS} />
        <XAxis dataKey={xKey} tick={TICK_STYLE} unit="%" label={{ value: 'Cumulative % of Population', position: 'insideBottomRight', offset: -5, fontSize: 10 }} />
        <YAxis tick={TICK_STYLE} unit="%" label={{ value: 'Cumulative % of Value', angle: -90, position: 'insideLeft', fontSize: 10 }} />
        <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v) => { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? `${n.toFixed(1)}%` : String(v ?? ''); }} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Line type="monotone" dataKey="equality" stroke="#9ca3af" strokeWidth={1.5} strokeDasharray="6 4" dot={false} name="Perfect Equality" />
        <Line type="monotone" dataKey={yKey} stroke={CHART_COLORS[4]} strokeWidth={2.5} dot={false} name={label || 'Lorenz Curve'} />
      </LineChart>
    </div>
  );
}

function renderHeatmap({ data, rowOrder, colOrder }) {
  const inferredRows = [...new Set(data.map(d => d.row))];
  const inferredCols = [...new Set(data.map(d => d.col))];
  const rows = Array.isArray(rowOrder) && rowOrder.length > 0 ? rowOrder : sortHeatmapValues(inferredRows);
  const cols = Array.isArray(colOrder) && colOrder.length > 0 ? colOrder : sortHeatmapValues(inferredCols);
  const valueMap = {};
  let minVal = Infinity, maxVal = -Infinity;
  data.forEach(d => {
    const key = `${d.row}|${d.col}`;
    valueMap[key] = d.value;
    if (d.value < minVal) minVal = d.value;
    if (d.value > maxVal) maxVal = d.value;
  });
  const cellW = cols.length >= 24 ? 32 : cols.length >= 16 ? 38 : 48;
  const cellH = 30;
  const labelW = 92;
  const headerH = 34;
  const legendH = 30;
  const svgWidth = labelW + cols.length * cellW;
  const svgHeight = headerH + rows.length * cellH + legendH;
  const legendCellW = 18;
  const getColor = (v) => {
    if (maxVal === minVal) return HEATMAP_COLORS[2];
    const idx = Math.floor(((v - minVal) / (maxVal - minVal)) * (HEATMAP_COLORS.length - 1));
    return HEATMAP_COLORS[Math.min(idx, HEATMAP_COLORS.length - 1)];
  };
  return (
    <div className="overflow-x-auto">
      <svg width={svgWidth} height={svgHeight}>
        {cols.map((col, ci) => (
          <text key={`h-${ci}`} x={labelW + ci * cellW + cellW / 2} y={headerH - 10} textAnchor="middle" fontSize={10} fill="#94a3b8">
            {formatHeatmapAxisLabel(col).slice(0, 12)}
          </text>
        ))}
        {rows.map((row, ri) => (
          <g key={`r-${ri}`}>
            <text x={labelW - 8} y={headerH + ri * cellH + cellH / 2 + 4} textAnchor="end" fontSize={10} fill="#94a3b8">
              {String(row).slice(0, 12)}
            </text>
            {cols.map((col, ci) => {
              const val = valueMap[`${row}|${col}`] ?? 0;
              return (
                <g key={`c-${ci}`}>
                  <rect
                    x={labelW + ci * cellW} y={headerH + ri * cellH}
                    width={cellW - 1} height={cellH - 1}
                    fill={getColor(val)} rx={3}
                  />
                  <text
                    x={labelW + ci * cellW + cellW / 2} y={headerH + ri * cellH + cellH / 2 + 4}
                    textAnchor="middle" fontSize={cols.length >= 24 ? 8 : 9} fill={val > (maxVal + minVal) / 2 ? '#fff' : '#334155'}
                  >
                    {typeof val === 'number' ? formatCompactNumber(val) : val}
                  </text>
                </g>
              );
            })}
          </g>
        ))}
        <g transform={`translate(${labelW}, ${headerH + rows.length * cellH + 10})`}>
          <text x={0} y={10} fontSize={10} fill="#94a3b8">Low volume</text>
          {HEATMAP_COLORS.map((color, idx) => (
            <rect
              key={`legend-${idx}`}
              x={64 + idx * (legendCellW + 4)}
              y={0}
              width={legendCellW}
              height={12}
              rx={2}
              fill={color}
            />
          ))}
          <text x={64 + HEATMAP_COLORS.length * (legendCellW + 4) + 8} y={10} fontSize={10} fill="#94a3b8">
            High volume
          </text>
          <text x={0} y={24} fontSize={10} fill="#cbd5e1">
            {formatCompactNumber(minVal)}
          </text>
          <text x={64 + HEATMAP_COLORS.length * (legendCellW + 4) - 4} y={24} textAnchor="end" fontSize={10} fill="#cbd5e1">
            {formatCompactNumber(maxVal)}
          </text>
        </g>
      </svg>
    </div>
  );
}

// ── New Chart Types ──────────────────────────────────────────────────────────

function renderTreemap({ data, xKey = 'name', yKey = 'value' }) {
  const treemapData = data.map((d, i) => ({
    name: d[xKey] || d.name || `Item ${i}`,
    size: Number(d[yKey] || d.value || d.size) || 0,
    fill: CHART_COLORS[i % CHART_COLORS.length],
  }));

  const CustomContent = ({ x, y, width, height, name, size }) => {
    if (width < 30 || height < 20) return null;
    return (
      <g>
        <rect x={x} y={y} width={width} height={height} rx={4} fill="currentColor" style={{ fill: 'inherit' }} stroke="#fff" strokeWidth={2} />
        <text x={x + width / 2} y={y + height / 2 - 5} textAnchor="middle" fontSize={9} fill="#fff" fontWeight={500}>
          {String(name).slice(0, width / 6)}
        </text>
        <text x={x + width / 2} y={y + height / 2 + 8} textAnchor="middle" fontSize={8} fill="rgba(255,255,255,0.8)">
          {typeof size === 'number' ? (size >= 1000 ? `${(size / 1000).toFixed(1)}K` : size.toFixed(0)) : size}
        </text>
      </g>
    );
  };

  return (
    <Treemap
      data={treemapData}
      dataKey="size"
      nameKey="name"
      aspectRatio={4 / 3}
      content={<CustomContent />}
    >
      {treemapData.map((d, i) => (
        <Cell key={i} fill={d.fill} />
      ))}
      <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v) => typeof v === 'number' ? v.toLocaleString() : v} />
    </Treemap>
  );
}

function renderRadar({ data, xKey = 'dimension', series = [] }) {
  if (!series.length) {
    const keys = Object.keys(data[0] || {}).filter(k => k !== xKey);
    series = keys;
  }
  return (
    <RadarChart outerRadius={80} data={data}>
      <PolarGrid />
      <PolarAngleAxis dataKey={xKey} tick={{ fontSize: 9 }} />
      <PolarRadiusAxis tick={{ fontSize: 8 }} />
      {series.map((k, i) => (
        <Radar key={k} name={k} dataKey={k} stroke={CHART_COLORS[i % CHART_COLORS.length]} fill={CHART_COLORS[i % CHART_COLORS.length]} fillOpacity={0.15} strokeWidth={2} />
      ))}
      <Tooltip contentStyle={TOOLTIP_STYLE} />
      <Legend wrapperStyle={{ fontSize: 11 }} />
    </RadarChart>
  );
}

function renderFunnel({ data, xKey = 'stage', yKey = 'count' }) {
  const funnelData = data.map((d, i) => ({
    name: d[xKey] || d.name || d.stage,
    value: Number(d[yKey] || d.value || d.count) || 0,
    fill: CHART_COLORS[i % CHART_COLORS.length],
  }));
  return (
    <FunnelChart margin={{ top: 5, right: 120, left: 5, bottom: 5 }}>
      <Tooltip contentStyle={TOOLTIP_STYLE} />
      <Funnel dataKey="value" data={funnelData} isAnimationActive>
        <LabelList position="right" fill="#64748b" stroke="none" fontSize={10} dataKey="name" />
        <LabelList position="center" fill="#fff" stroke="none" fontSize={10} dataKey="value" formatter={(v) => v.toLocaleString()} />
      </Funnel>
    </FunnelChart>
  );
}

function renderSankey({ data }) {
  try {
    // Sankey expects { nodes: [{name}], links: [{source, target, value}] }
    const sankeyData = data?.nodes ? data : { nodes: [], links: [] };
    if (!sankeyData.nodes.length) {
      return <div className="text-xs text-slate-400 text-center py-8">Invalid Sankey data</div>;
    }
    // Convert string source/target to numeric indices
    const nodeIndex = {};
    sankeyData.nodes.forEach((n, i) => { nodeIndex[n.name] = i; });
    const links = sankeyData.links.map(l => ({
      source: typeof l.source === 'number' ? l.source : (nodeIndex[l.source] ?? 0),
      target: typeof l.target === 'number' ? l.target : (nodeIndex[l.target] ?? 0),
      value: l.value,
    }));
    return (
      <RechartsSankey
        width={460}
        height={280}
        data={{ nodes: sankeyData.nodes, links }}
        node={{ fill: CHART_COLORS[0], opacity: 0.8 }}
        link={{ stroke: '#93c5fd', opacity: 0.3 }}
        nodePadding={20}
        margin={{ top: 5, right: 5, left: 5, bottom: 5 }}
      >
        <Tooltip contentStyle={TOOLTIP_STYLE} />
      </RechartsSankey>
    );
  } catch {
    return <div className="text-xs text-slate-400 text-center py-8">Sankey chart unavailable</div>;
  }
}

function renderWaterfall({ data, xKey = 'month', yKey = 'value', tickFormatter: tf }) {
  // Transform waterfall data: each bar has invisible base + visible change
  const waterfallBars = data.map((d) => {
    const val = Number(d[yKey]) || 0;
    const start = Number(d.start) || 0;
    const type = d.type || (val >= 0 ? 'increase' : 'decrease');
    const palette = CHART_PALETTES.diverging; // [green, red]
    if (type === 'total') {
      return { ...d, base: 0, change: val, fill: CHART_COLORS[0] };
    }
    return {
      ...d,
      base: val >= 0 ? start : start + val,
      change: Math.abs(val),
      fill: val >= 0 ? palette[0] : palette[1],
    };
  });

  return (
    <BarChart data={waterfallBars} margin={MARGIN}>
      <CartesianGrid {...GRID_PROPS} />
      <XAxis dataKey={xKey} tick={TICK_STYLE} angle={-30} textAnchor="end" height={50} tickFormatter={buildTickFormatter(tf?.x)} />
      <YAxis tick={TICK_STYLE} tickFormatter={buildTickFormatter(tf?.y)} />
      <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v, name) => name === 'base' ? null : v.toLocaleString()} />
      <Bar dataKey="base" stackId="waterfall" fill="transparent" />
      <Bar dataKey="change" stackId="waterfall" radius={[6, 6, 0, 0]}>
        {waterfallBars.map((d, i) => (
          <Cell key={i} fill={d.fill} />
        ))}
      </Bar>
    </BarChart>
  );
}

function renderPareto({ data, xKey = 'category', yKey = 'revenue', tickFormatter: tf }) {
  const y2Key = data[0]?.cumulative_pct != null ? 'cumulative_pct' : (Object.keys(data[0] || {}).find(k => /cum|pct/i.test(k)) || 'cumulative_pct');
  return (
    <ComposedChart data={data} margin={MARGIN}>
      <CartesianGrid {...GRID_PROPS} />
      <XAxis dataKey={xKey} tick={TICK_STYLE} angle={-30} textAnchor="end" height={50} tickFormatter={buildTickFormatter(tf?.x)} />
      <YAxis yAxisId="left" tick={TICK_STYLE} tickFormatter={buildTickFormatter(tf?.y)} />
      <YAxis yAxisId="right" orientation="right" tick={TICK_STYLE} unit="%" domain={[0, 100]} />
      <Tooltip contentStyle={TOOLTIP_STYLE} />
      <Legend wrapperStyle={{ fontSize: 11 }} />
      <Bar yAxisId="left" dataKey={yKey} fill={CHART_COLORS[0]} radius={[6, 6, 0, 0]} name={yKey} />
      <Line yAxisId="right" type="monotone" dataKey={y2Key} stroke={CHART_COLORS[3]} strokeWidth={2} dot={{ r: 2 }} name="Cumulative %" />
      <ReferenceLine yAxisId="right" y={80} stroke="#ef4444" strokeDasharray="4 4" label={{ value: '80%', position: 'right', fontSize: 9, fill: '#ef4444' }} />
    </ComposedChart>
  );
}

function renderBubble({ data, xKey, yKey, zKey = 'avg_rating', labelKey }) {
  const maxZ = Math.max(...data.map(d => Number(d[zKey]) || 0));
  const minZ = Math.min(...data.map(d => Number(d[zKey]) || 0));
  return (
    <ScatterChart margin={MARGIN}>
      <CartesianGrid {...GRID_PROPS} />
      <XAxis dataKey={xKey} name={xKey} tick={TICK_STYLE} />
      <YAxis dataKey={yKey} name={yKey} tick={TICK_STYLE} />
      <ZAxis dataKey={zKey} range={[40, 400]} domain={[minZ, maxZ]} name={zKey} />
      <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ strokeDasharray: '3 3' }} />
      <Legend wrapperStyle={{ fontSize: 11 }} />
      <Scatter name={`${xKey} × ${yKey} × ${zKey}`} data={data} fill={CHART_COLORS[0]} fillOpacity={0.6} />
    </ScatterChart>
  );
}

// ── Exports for external use ─────────────────────────────────────────────────

export { CHART_COLORS, CHART_TYPE_LABELS };
