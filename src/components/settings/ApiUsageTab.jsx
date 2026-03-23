/**
 * ApiUsageTab.jsx
 *
 * Settings tab showing LLM API usage: KPIs, provider balances, trend chart, breakdown, recent calls.
 */

import { useMemo } from 'react';
import {
  Activity, Hash, DollarSign, RefreshCw, Wallet, Loader2, AlertCircle,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { Card } from '../ui';
import useLlmUsage from '../../hooks/useLlmUsage';

// ── Helpers ──────────────────────────────────────────────────

function formatCost(v) {
  if (v == null) return '$0.00';
  return `$${Number(v).toFixed(4)}`;
}

function formatTokens(v) {
  if (v == null) return '0';
  return Number(v).toLocaleString();
}

function formatShortDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
}

function timeAgo(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

const STATUS_STYLES = {
  success: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  error: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  quota_exceeded: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
};

const PROVIDER_COLORS = { deepseek: '#6366f1', gemini: '#10b981', anthropic: '#f97316', openai: '#8b5cf6', kimi: '#0ea5e9', other: '#f59e0b' };

const PROVIDER_LABELS = { deepseek: 'DeepSeek', gemini: 'Gemini', anthropic: 'Anthropic (Claude)', openai: 'OpenAI', kimi: 'Kimi (Moonshot)' };

// ── Component ────────────────────────────────────────────────

export default function ApiUsageTab() {
  const {
    loading, error, todayKpis, dailyTrend, providerBreakdown, recentCalls,
    providerBilling, dateRange, setDateRange, refresh,
  } = useLlmUsage();

  // Pivot dailyTrend → chart data: one row per date, one key per provider
  const { chartData, providers } = useMemo(() => {
    const byDate = {};
    const provSet = new Set();
    for (const row of dailyTrend) {
      const key = row.usage_date;
      const prov = row.provider || 'other';
      provSet.add(prov);
      if (!byDate[key]) byDate[key] = { date: formatShortDate(key) };
      byDate[key][prov] = (byDate[key][prov] || 0) + (row.total_cost_usd || 0);
    }
    return {
      chartData: Object.values(byDate),
      providers: [...provSet].sort(),
    };
  }, [dailyTrend]);

  return (
    <div className="space-y-6">
      {/* Error banner */}
      {error && (
        <div className="text-sm text-red-600 bg-red-50 dark:bg-red-900/20 dark:text-red-400 p-3 rounded-lg">
          Failed to load usage data: {error}
        </div>
      )}

      {/* ── Section A: KPIs ── */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>Today</h3>
        <button
          onClick={refresh}
          disabled={loading}
          className="flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <KpiCard icon={Activity} label="API Calls" value={formatTokens(todayKpis.call_count)} color="text-indigo-500" />
        <KpiCard icon={Hash} label="Total Tokens" value={formatTokens(todayKpis.total_tokens)} color="text-emerald-500" />
        <KpiCard icon={DollarSign} label="Est. Cost" value={formatCost(todayKpis.total_cost_usd)} color="text-amber-500" />
      </div>

      {/* ── Section A2: Provider Balances ── */}
      <ProviderBalancesCard billing={providerBilling} />

      {/* ── Section B: Trend Chart ── */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Usage Trend</h3>
          <div className="flex gap-1">
            {[7, 30].map((d) => (
              <button
                key={d}
                onClick={() => setDateRange(d)}
                className={`px-2.5 py-1 text-xs rounded-md font-medium transition-colors ${
                  dateRange === d
                    ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400'
                    : 'hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
                style={dateRange !== d ? { color: 'var(--text-secondary)' } : undefined}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>

        {chartData.length === 0 ? (
          <p className="text-xs text-center py-12" style={{ color: 'var(--text-secondary)' }}>
            No usage data in the last {dateRange} days
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default)" />
              <XAxis dataKey="date" tick={{ fill: 'var(--text-secondary)', fontSize: 11 }} />
              <YAxis tick={{ fill: 'var(--text-secondary)', fontSize: 11 }} tickFormatter={(v) => `$${v.toFixed(3)}`} />
              <Tooltip
                contentStyle={{ backgroundColor: 'var(--surface-card)', border: '1px solid var(--border-default)', borderRadius: 8, fontSize: 12 }}
                formatter={(value) => formatCost(value)}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {providers.map((p) => (
                <Bar key={p} dataKey={p} stackId="a" fill={PROVIDER_COLORS[p] || PROVIDER_COLORS.other} name={p} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        )}
      </Card>

      {/* ── Section C: Provider Breakdown ── */}
      <Card>
        <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>
          Provider Breakdown ({dateRange}d)
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b" style={{ borderColor: 'var(--border-default)' }}>
                <th className="text-left py-2 font-medium" style={{ color: 'var(--text-secondary)' }}>Provider</th>
                <th className="text-right py-2 font-medium" style={{ color: 'var(--text-secondary)' }}>Calls</th>
                <th className="text-right py-2 font-medium" style={{ color: 'var(--text-secondary)' }}>Tokens</th>
                <th className="text-right py-2 font-medium" style={{ color: 'var(--text-secondary)' }}>Est. Cost</th>
              </tr>
            </thead>
            <tbody>
              {providerBreakdown.length === 0 && (
                <tr><td colSpan={4} className="text-center py-4" style={{ color: 'var(--text-secondary)' }}>No data</td></tr>
              )}
              {providerBreakdown.map((row) => (
                <tr key={row.provider} className="border-b last:border-b-0" style={{ borderColor: 'var(--border-default)' }}>
                  <td className="py-2 font-medium capitalize" style={{ color: 'var(--text-primary)' }}>
                    <span className="inline-block w-2 h-2 rounded-full mr-2" style={{ backgroundColor: PROVIDER_COLORS[row.provider] || PROVIDER_COLORS.other }} />
                    {row.provider}
                  </td>
                  <td className="text-right py-2" style={{ color: 'var(--text-primary)' }}>{formatTokens(row.call_count)}</td>
                  <td className="text-right py-2" style={{ color: 'var(--text-primary)' }}>{formatTokens(row.total_tokens)}</td>
                  <td className="text-right py-2 font-medium" style={{ color: 'var(--text-primary)' }}>{formatCost(row.total_cost_usd)}</td>
                </tr>
              ))}
            </tbody>
            {providerBreakdown.length > 1 && (
              <tfoot>
                <tr className="border-t font-semibold" style={{ borderColor: 'var(--border-default)' }}>
                  <td className="py-2" style={{ color: 'var(--text-primary)' }}>Total</td>
                  <td className="text-right py-2" style={{ color: 'var(--text-primary)' }}>
                    {formatTokens(providerBreakdown.reduce((s, r) => s + r.call_count, 0))}
                  </td>
                  <td className="text-right py-2" style={{ color: 'var(--text-primary)' }}>
                    {formatTokens(providerBreakdown.reduce((s, r) => s + r.total_tokens, 0))}
                  </td>
                  <td className="text-right py-2" style={{ color: 'var(--text-primary)' }}>
                    {formatCost(providerBreakdown.reduce((s, r) => s + r.total_cost_usd, 0))}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </Card>

      {/* ── Section D: Recent Calls ── */}
      <Card>
        <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>Recent Calls</h3>
        <div className="max-h-96 overflow-y-auto scrollbar-thin">
          <table className="w-full text-xs">
            <thead className="sticky top-0" style={{ backgroundColor: 'var(--surface-card)' }}>
              <tr className="border-b" style={{ borderColor: 'var(--border-default)' }}>
                <th className="text-left py-2 font-medium" style={{ color: 'var(--text-secondary)' }}>Time</th>
                <th className="text-left py-2 font-medium" style={{ color: 'var(--text-secondary)' }}>Model</th>
                <th className="text-right py-2 font-medium" style={{ color: 'var(--text-secondary)' }}>Tokens</th>
                <th className="text-right py-2 font-medium" style={{ color: 'var(--text-secondary)' }}>Cost</th>
                <th className="text-right py-2 font-medium" style={{ color: 'var(--text-secondary)' }}>Latency</th>
                <th className="text-center py-2 font-medium" style={{ color: 'var(--text-secondary)' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {recentCalls.length === 0 && (
                <tr><td colSpan={6} className="text-center py-8" style={{ color: 'var(--text-secondary)' }}>No recent calls</td></tr>
              )}
              {recentCalls.map((row) => (
                <tr key={row.id} className="border-b last:border-b-0" style={{ borderColor: 'var(--border-default)' }}>
                  <td className="py-1.5 whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{timeAgo(row.created_at)}</td>
                  <td className="py-1.5 font-medium" style={{ color: 'var(--text-primary)' }}>{row.model || row.provider || '\u2014'}</td>
                  <td className="text-right py-1.5 tabular-nums" style={{ color: 'var(--text-primary)' }}>
                    {row.total_tokens != null ? formatTokens(row.total_tokens) : '\u2014'}
                  </td>
                  <td className="text-right py-1.5 tabular-nums" style={{ color: 'var(--text-primary)' }}>{formatCost(row.estimated_cost_usd)}</td>
                  <td className="text-right py-1.5 tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                    {row.latency_ms != null ? `${row.latency_ms}ms` : '\u2014'}
                  </td>
                  <td className="text-center py-1.5">
                    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${STATUS_STYLES[row.status] || STATUS_STYLES.success}`}>
                      {row.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────

function KpiCard({ icon: Icon, label, value, color }) {
  return (
    <Card variant="elevated">
      <div className="flex items-center gap-3">
        <div className={`p-2 rounded-lg bg-slate-100 dark:bg-slate-800 ${color}`}>
          <Icon className="w-5 h-5" />
        </div>
        <div>
          <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{label}</p>
          <p className="text-xl font-bold tabular-nums" style={{ color: 'var(--text-primary)' }}>{value}</p>
        </div>
      </div>
    </Card>
  );
}

/**
 * Shows balance/billing info for all configured providers in a single card.
 */
function ProviderBalancesCard({ billing }) {
  const entries = [
    { key: 'deepseek', ...billing.deepseek },
    { key: 'anthropic', ...billing.anthropic },
    { key: 'openai', ...billing.openai },
    { key: 'kimi', ...billing.kimi },
  ];

  // Hide if all providers failed or have no data
  const hasAny = entries.some((e) => e.data || e.loading);
  if (!hasAny) return null;

  return (
    <Card>
      <h3 className="text-sm font-semibold mb-3 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
        <Wallet className="w-4 h-4" />
        Provider Balances
      </h3>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        {entries.map(({ key, data, loading: isLoading, error: err }) => (
          <BalanceItem key={key} provider={key} data={data} loading={isLoading} error={err} />
        ))}
      </div>
    </Card>
  );
}

function BalanceItem({ provider, data, loading: isLoading, error: err }) {
  const label = PROVIDER_LABELS[provider] || provider;
  const color = PROVIDER_COLORS[provider] || PROVIDER_COLORS.other;

  const balanceDisplay = useMemo(() => {
    if (isLoading) return <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color }} />;
    if (err || !data) return <span className="text-xs flex items-center gap-1" style={{ color: 'var(--text-secondary)' }}><AlertCircle className="w-3 h-3" /> N/A</span>;

    // DeepSeek / Kimi: { balance_usd }
    if ((provider === 'deepseek' || provider === 'kimi') && data.balance_usd != null) {
      return <span className="font-semibold">${Number(data.balance_usd).toFixed(2)}</span>;
    }

    // Anthropic & OpenAI: { total_cost_usd, total_tokens, period_days }
    if ((provider === 'anthropic' || provider === 'openai') && data.total_cost_usd != null) {
      return (
        <span className="font-semibold">
          ${Number(data.total_cost_usd).toFixed(2)}
          <span className="text-[10px] font-normal ml-1" style={{ color: 'var(--text-secondary)' }}>/ {data.period_days || 30}d</span>
        </span>
      );
    }

    // Admin key not configured
    if (data.code === 'admin_key_required' || data.code === 'missing_admin_key') {
      return <span className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>Admin Key required</span>;
    }

    return <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>N/A</span>;
  }, [provider, data, isLoading, err, color]);

  const tokenInfo = data?.total_tokens > 0
    ? `${Number(data.total_tokens).toLocaleString()} tokens`
    : null;

  return (
    <div className="flex flex-col gap-0.5 p-2 rounded-lg bg-slate-50 dark:bg-slate-800/50">
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
        <span className="text-xs flex-1" style={{ color: 'var(--text-secondary)' }}>{label}</span>
        <span className="text-sm tabular-nums" style={{ color: 'var(--text-primary)' }}>{balanceDisplay}</span>
      </div>
      {tokenInfo && (
        <div className="text-[10px] tabular-nums pl-4" style={{ color: 'var(--text-secondary)' }}>{tokenInfo}</div>
      )}
    </div>
  );
}
