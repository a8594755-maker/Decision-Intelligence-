/**
 * InsightsChartCard — Renders a single chart card using Recharts.
 * Takes chartData from data workers and renders interactive charts.
 */
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';

// Read chart palette from CSS variables for dark mode support
function getCssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function getChartColors() {
  return Array.from({ length: 8 }, (_, i) => getCssVar(`--chart-${i + 1}`) || '#6366f1');
}

function formatValue(v) {
  if (v >= 1_000_000) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

function formatAxisTick(v) {
  if (v >= 1_000_000) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1e3).toFixed(0)}K`;
  return v;
}

function truncateLabel(s, max = 12) {
  return s && s.length > max ? s.slice(0, max) + '…' : s;
}

const GRID_STROKE = 'var(--border-default)';
const TICK_STYLE = { fontSize: 10, fill: 'var(--text-muted)' };

function BarChartCard({ chartData }) {
  const COLORS = getChartColors();
  const data = (chartData.labels || []).map((label, i) => ({
    name: truncateLabel(label),
    value: chartData.values[i] || 0,
  }));

  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={data} margin={{ top: 10, right: 10, left: 10, bottom: 60 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} strokeOpacity={0.5} />
        <XAxis dataKey="name" tick={TICK_STYLE} angle={-45} textAnchor="end" interval={0} />
        <YAxis tick={TICK_STYLE} tickFormatter={formatAxisTick} />
        <Tooltip formatter={(v) => formatValue(v)} contentStyle={{ backgroundColor: 'var(--surface-card)', border: '1px solid var(--border-default)', borderRadius: 8 }} />
        <Bar dataKey="value" radius={[4, 4, 0, 0]}>
          {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function LineChartCard({ chartData }) {
  const COLORS = getChartColors();
  const hasSeries2 = chartData.series2Values && chartData.series2Values.length > 0;
  const maxV1 = Math.max(...(chartData.values || [1]));
  const maxV2 = hasSeries2 ? Math.max(...chartData.series2Values) : 0;
  const needDualAxis = hasSeries2 && (maxV1 / (maxV2 || 1) > 10 || maxV2 / (maxV1 || 1) > 10);

  const data = (chartData.labels || []).map((label, i) => ({
    name: label,
    series1: chartData.values[i] || 0,
    ...(hasSeries2 ? { series2: chartData.series2Values[i] || 0 } : {}),
  }));

  const step = data.length > 12 ? Math.ceil(data.length / 8) : 1;

  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data} margin={{ top: 10, right: needDualAxis ? 50 : 10, left: 10, bottom: 30 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} strokeOpacity={0.5} />
        <XAxis dataKey="name" tick={{ fontSize: 9, fill: 'var(--text-muted)' }} angle={-45} textAnchor="end" interval={step - 1} />
        <YAxis yAxisId="left" tick={TICK_STYLE} tickFormatter={formatAxisTick} />
        {needDualAxis && (
          <YAxis yAxisId="right" orientation="right" tick={TICK_STYLE} tickFormatter={formatAxisTick} />
        )}
        <Tooltip formatter={(v) => formatValue(v)} contentStyle={{ backgroundColor: 'var(--surface-card)', border: '1px solid var(--border-default)', borderRadius: 8 }} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Line yAxisId="left" type="monotone" dataKey="series1" name={chartData.series1Name || 'Series 1'} stroke={COLORS[0]} strokeWidth={2} dot={{ r: 3 }} />
        {hasSeries2 && (
          <Line yAxisId={needDualAxis ? 'right' : 'left'} type="monotone" dataKey="series2" name={chartData.series2Name || 'Series 2'} stroke={COLORS[7]} strokeWidth={2} dot={{ r: 3 }} />
        )}
      </LineChart>
    </ResponsiveContainer>
  );
}

function DonutChartCard({ chartData }) {
  const COLORS = getChartColors();
  const nums = (chartData.values || []).map(v => Number(v) || 0);
  const total = nums.reduce((a, b) => a + b, 0);
  const data = (chartData.labels || []).map((label, i) => ({
    name: String(label),
    value: nums[i],
  }));

  return (
    <ResponsiveContainer width="100%" height={280}>
      <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="45%"
          innerRadius={60}
          outerRadius={90}
          paddingAngle={2}
          dataKey="value"
          label={({ name, percent }) => percent > 0.05 ? `${(percent * 100).toFixed(1)}%` : ''}
          labelLine={false}
        >
          {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
        </Pie>
        <Tooltip formatter={(v) => `${formatValue(v)} (${(v / total * 100).toFixed(1)}%)`} contentStyle={{ backgroundColor: 'var(--surface-card)', border: '1px solid var(--border-default)', borderRadius: 8 }} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <text x="50%" y="42%" textAnchor="middle" dominantBaseline="middle" style={{ fontSize: 20, fontWeight: 700, fill: 'var(--text-primary)' }}>
          {formatValue(total)}
        </text>
        <text x="50%" y="52%" textAnchor="middle" dominantBaseline="middle" style={{ fontSize: 11, fill: 'var(--text-secondary)' }}>
          Total
        </text>
      </PieChart>
    </ResponsiveContainer>
  );
}

export default function InsightsChartCard({ card, embedded = false }) {
  const cd = card?.chartData;
  if (!cd || cd.type === 'none') return null;

  const ChartComponent = {
    bar: BarChartCard,
    line: LineChartCard,
    donut: DonutChartCard,
  }[cd.type];

  if (!ChartComponent) return null;

  // Embedded mode: just the chart, no wrapper card/title/analysis (parent handles those)
  if (embedded) return <ChartComponent chartData={cd} />;

  return (
    <div className="bg-[var(--surface-card)] border border-[var(--border-default)] rounded-xl p-4 mb-4">
      <h3 className="text-[15px] font-semibold text-[var(--text-primary)] mb-3">
        {cd.title || card.title}
      </h3>
      <ChartComponent chartData={cd} />
      {card.analysis && (
        <p className="text-xs text-[var(--text-secondary)] mt-3 p-2 bg-[var(--status-success-bg)] border-l-[3px] border-l-[var(--status-success)] rounded">
          {card.analysis}
        </p>
      )}
    </div>
  );
}
