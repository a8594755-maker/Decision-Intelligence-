/**
 * ROIDashboard — Displays ROI value tracking for Digital Workers
 *
 * Features:
 *   - Total value card (MTD / YTD toggle)
 *   - Value by type breakdown (bar chart representation)
 *   - Recent value events list with task drill-down
 *   - Confidence indicator
 *
 * Props:
 *   summary:       { total_value, by_type, event_count, avg_confidence, period }
 *   recentEvents:  value_event[] (latest 20)
 *   onPeriodChange: (period) => void
 *   onTaskClick:   (taskId) => void
 */

import { useState } from 'react';
import {
  DollarSign, TrendingUp, Clock, ShieldCheck,
  Package, Gauge, ArrowUpRight, ChevronRight,
} from 'lucide-react';

const VALUE_TYPE_CONFIG = {
  stockout_prevented:         { label: 'Stockout Prevention',    icon: Package,    color: 'text-red-600',    bg: 'bg-red-100 dark:bg-red-900/30' },
  cost_saved:                 { label: 'Cost Savings',           icon: DollarSign, color: 'text-emerald-600', bg: 'bg-emerald-100 dark:bg-emerald-900/30' },
  time_saved_hours:           { label: 'Time Saved',             icon: Clock,      color: 'text-blue-600',   bg: 'bg-blue-100 dark:bg-blue-900/30' },
  revenue_protected:          { label: 'Revenue Protected',      icon: ShieldCheck, color: 'text-purple-600', bg: 'bg-purple-100 dark:bg-purple-900/30' },
  expedite_avoided:           { label: 'Expedite Avoided',       icon: TrendingUp, color: 'text-amber-600',  bg: 'bg-amber-100 dark:bg-amber-900/30' },
  service_level_improvement:  { label: 'Service Level Gain',     icon: Gauge,      color: 'text-[var(--brand-600)]', bg: 'bg-[var(--accent-active)]' },
  manual_task_automated:      { label: 'Automation Value',       icon: Clock,      color: 'text-cyan-600',   bg: 'bg-cyan-100 dark:bg-cyan-900/30' },
};

function formatCurrency(amount) {
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(1)}K`;
  return `$${amount.toFixed(0)}`;
}

// ── Total Value Hero Card ───────────────────────────────────────────────────

function TotalValueCard({ summary, period, onPeriodChange }) {
  const total = summary?.total_value || 0;
  const count = summary?.event_count || 0;
  const avgConf = summary?.avg_confidence || 0;

  return (
    <div className="rounded-lg border border-emerald-200 dark:border-emerald-800 bg-gradient-to-br from-emerald-50 to-white dark:from-emerald-950/30 dark:to-slate-900 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center">
            <DollarSign className="w-4 h-4 text-emerald-600" />
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-emerald-600 dark:text-emerald-400">Total Value Generated</p>
            <p className="text-2xl font-bold text-slate-800 dark:text-slate-100">{formatCurrency(total)}</p>
          </div>
        </div>
        <div className="flex gap-1">
          {['mtd', 'ytd', 'all'].map(p => (
            <button
              key={p}
              onClick={() => onPeriodChange?.(p)}
              className={`px-2 py-0.5 rounded text-[10px] font-medium uppercase ${
                period === p
                  ? 'bg-emerald-600 text-white'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-500 hover:bg-slate-200'
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>
      <div className="flex gap-4 text-xs text-slate-500">
        <span>{count} value event{count !== 1 ? 's' : ''}</span>
        <span>Avg confidence: {Math.round(avgConf * 100)}%</span>
      </div>
    </div>
  );
}

// ── Value Breakdown ─────────────────────────────────────────────────────────

function ValueBreakdown({ byType, totalValue }) {
  const entries = Object.entries(byType || {}).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-3">
      <p className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-2">Value Breakdown</p>
      <div className="space-y-2">
        {entries.map(([type, amount]) => {
          const config = VALUE_TYPE_CONFIG[type] || { label: type, icon: DollarSign, color: 'text-slate-600', bg: 'bg-slate-100' };
          const Icon = config.icon;
          const pct = totalValue > 0 ? (amount / totalValue) * 100 : 0;

          return (
            <div key={type}>
              <div className="flex items-center justify-between mb-0.5">
                <div className="flex items-center gap-1.5">
                  <Icon className={`w-3 h-3 ${config.color}`} />
                  <span className="text-xs text-slate-600 dark:text-slate-300">{config.label}</span>
                </div>
                <span className="text-xs font-medium text-slate-800 dark:text-slate-100">
                  {formatCurrency(amount)}
                </span>
              </div>
              <div className="w-full h-1.5 rounded-full bg-slate-100 dark:bg-slate-800">
                <div
                  className={`h-full rounded-full ${config.bg.replace('bg-', 'bg-').replace('/30', '')}`}
                  style={{ width: `${Math.max(2, pct)}%`, backgroundColor: 'currentColor' }}
                >
                  <div className={`h-full rounded-full opacity-60 ${config.bg}`} style={{ width: '100%' }} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Recent Events ───────────────────────────────────────────────────────────

function RecentEventsList({ events, onTaskClick }) {
  if (!events || events.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-4 text-center">
        <p className="text-xs text-slate-400">No value events recorded yet</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
      <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-700">
        <p className="text-xs font-medium text-slate-600 dark:text-slate-300">Recent Value Events</p>
      </div>
      <div className="divide-y divide-slate-100 dark:divide-slate-800">
        {events.slice(0, 20).map((event, i) => {
          const config = VALUE_TYPE_CONFIG[event.value_type] || VALUE_TYPE_CONFIG.cost_saved;
          const Icon = config.icon;

          return (
            <div
              key={event.id || i}
              className="flex items-center justify-between px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer"
              onClick={() => onTaskClick?.(event.task_id)}
            >
              <div className="flex items-center gap-2">
                <div className={`w-6 h-6 rounded flex items-center justify-center ${config.bg}`}>
                  <Icon className={`w-3 h-3 ${config.color}`} />
                </div>
                <div>
                  <p className="text-xs font-medium text-slate-700 dark:text-slate-200">
                    {config.label}
                  </p>
                  <p className="text-[10px] text-slate-400">
                    {event.workflow_type || 'task'} • conf {Math.round((event.confidence || 0) * 100)}%
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-emerald-600">
                  +{formatCurrency(event.value_amount)}
                </span>
                <ChevronRight className="w-3 h-3 text-slate-300" />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main Dashboard ──────────────────────────────────────────────────────────

export default function ROIDashboard({
  summary = {},
  recentEvents = [],
  onPeriodChange,
  onTaskClick,
}) {
  const [period, setPeriod] = useState(summary.period || 'mtd');

  function handlePeriodChange(p) {
    setPeriod(p);
    onPeriodChange?.(p);
  }

  return (
    <div className="space-y-3">
      <TotalValueCard
        summary={summary}
        period={period}
        onPeriodChange={handlePeriodChange}
      />
      <ValueBreakdown
        byType={summary.by_type}
        totalValue={summary.total_value}
      />
      <RecentEventsList
        events={recentEvents}
        onTaskClick={onTaskClick}
      />
    </div>
  );
}
