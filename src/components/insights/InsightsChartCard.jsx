/**
 * InsightsChartCard — Renders a single chart card using Recharts.
 * Takes chartData from data workers and renders interactive charts.
 */
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';

const COLORS = ['#6366f1', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#64748b', '#a855f7', '#ec4899', '#14b8a6'];

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

function BarChartCard({ chartData }) {
  const data = (chartData.labels || []).map((label, i) => ({
    name: truncateLabel(label),
    value: chartData.values[i] || 0,
  }));

  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={data} margin={{ top: 10, right: 10, left: 10, bottom: 60 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
        <XAxis dataKey="name" tick={{ fontSize: 10 }} angle={-45} textAnchor="end" interval={0} />
        <YAxis tick={{ fontSize: 10 }} tickFormatter={formatAxisTick} />
        <Tooltip formatter={(v) => formatValue(v)} />
        <Bar dataKey="value" radius={[4, 4, 0, 0]}>
          {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function LineChartCard({ chartData }) {
  const hasSeries2 = chartData.series2Values && chartData.series2Values.length > 0;
  const maxV1 = Math.max(...(chartData.values || [1]));
  const maxV2 = hasSeries2 ? Math.max(...chartData.series2Values) : 0;
  const needDualAxis = hasSeries2 && (maxV1 / (maxV2 || 1) > 10 || maxV2 / (maxV1 || 1) > 10);

  const data = (chartData.labels || []).map((label, i) => ({
    name: label,
    series1: chartData.values[i] || 0,
    ...(hasSeries2 ? { series2: chartData.series2Values[i] || 0 } : {}),
  }));

  // Show every Nth label to avoid overlap
  const step = data.length > 12 ? Math.ceil(data.length / 8) : 1;

  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data} margin={{ top: 10, right: needDualAxis ? 50 : 10, left: 10, bottom: 30 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
        <XAxis dataKey="name" tick={{ fontSize: 9 }} angle={-45} textAnchor="end" interval={step - 1} />
        <YAxis yAxisId="left" tick={{ fontSize: 10 }} tickFormatter={formatAxisTick} />
        {needDualAxis && (
          <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10 }} tickFormatter={formatAxisTick} />
        )}
        <Tooltip formatter={(v) => formatValue(v)} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Line yAxisId="left" type="monotone" dataKey="series1" name={chartData.series1Name || 'Series 1'} stroke="#6366f1" strokeWidth={2} dot={{ r: 3 }} />
        {hasSeries2 && (
          <Line yAxisId={needDualAxis ? 'right' : 'left'} type="monotone" dataKey="series2" name={chartData.series2Name || 'Series 2'} stroke="#10b981" strokeWidth={2} dot={{ r: 3 }} />
        )}
      </LineChart>
    </ResponsiveContainer>
  );
}

function DonutChartCard({ chartData }) {
  const total = (chartData.values || []).reduce((a, b) => a + b, 0);
  const data = (chartData.labels || []).map((label, i) => ({
    name: label,
    value: chartData.values[i] || 0,
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
        <Tooltip formatter={(v) => `${formatValue(v)} (${(v / total * 100).toFixed(1)}%)`} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <text x="50%" y="42%" textAnchor="middle" dominantBaseline="middle" style={{ fontSize: 20, fontWeight: 700, fill: '#1e293b' }}>
          {formatValue(total)}
        </text>
        <text x="50%" y="52%" textAnchor="middle" dominantBaseline="middle" style={{ fontSize: 11, fill: '#64748b' }}>
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
    <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 16, marginBottom: 16 }}>
      <h3 style={{ font: '600 15px system-ui', color: '#1e293b', margin: '0 0 12px' }}>
        {cd.title || card.title}
      </h3>
      <ChartComponent chartData={cd} />
      {card.analysis && (
        <p style={{ fontSize: 12, color: '#475569', marginTop: 12, padding: 8, background: '#f0fdf4', borderLeft: '3px solid #10b981', borderRadius: 4 }}>
          {card.analysis}
        </p>
      )}
    </div>
  );
}
