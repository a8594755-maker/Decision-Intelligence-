/**
 * Ops Dashboard
 *
 * Operational monitoring for system health, import quality, planning performance,
 * data quality, closed-loop status, and system resource usage.
 * Admin-only page for system maintenance and troubleshooting.
 */

import React, { useState, useEffect, useMemo } from 'react';
import {
  Activity, Upload, Calculator, AlertTriangle, Clock, TrendingUp,
  RefreshCw, BarChart3, Database, Shield, Zap, CheckCircle2,
  XCircle, GitBranch, HardDrive, Cpu
} from 'lucide-react';
import { Card } from '../components/ui';
import { useAuth } from '../contexts/AuthContext';
import { getOperationalHealthSummary as getOperationalSummary } from '../services/observability/operationalMetrics';

function MetricCard({ icon: Icon, label, value, sub, accent = 'text-indigo-600' }) {
  return (
    <Card className="!p-4">
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-lg bg-slate-100 dark:bg-slate-800">
          <Icon className={`w-5 h-5 ${accent}`} />
        </div>
        <div>
          <p className="text-xs text-slate-500">{label}</p>
          <p className="text-xl font-bold mt-0.5" style={{ color: 'var(--text-primary)' }}>{value}</p>
          {sub && <p className="text-[10px] text-slate-400 mt-0.5">{sub}</p>}
        </div>
      </div>
    </Card>
  );
}

function HealthSection({ title, icon: SectionIcon, metrics, children }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {SectionIcon && <SectionIcon className="w-4 h-4 text-slate-400" />}
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      </div>
      {metrics && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {metrics.map((m, i) => (
            <MetricCard key={i} {...m} />
          ))}
        </div>
      )}
      {children}
    </div>
  );
}

function AlertBanner({ alerts }) {
  if (!alerts?.length) return null;

  const alertStyles = {
    error: 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-800 dark:text-red-200',
    warn: 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200',
  };

  const alertIcons = {
    error: XCircle,
    warn: AlertTriangle,
  };

  return (
    <div className="space-y-2">
      {alerts.map((alert, i) => {
        const style = alertStyles[alert.level] || alertStyles.warn;
        const IconComp = alertIcons[alert.level] || AlertTriangle;
        return (
          <div key={i} className={`flex items-center gap-2 p-3 rounded-lg border ${style}`}>
            <IconComp className="w-4 h-4 flex-shrink-0" />
            <div className="flex-1">
              <span className="text-sm font-medium">{alert.message}</span>
              {alert.code && (
                <span className="ml-2 text-[10px] opacity-60 font-mono">{alert.code}</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StatusIndicator({ status, label }) {
  const colors = {
    healthy: 'bg-emerald-500',
    degraded: 'bg-amber-500',
    down: 'bg-red-500',
    unknown: 'bg-slate-400',
  };

  return (
    <div className="flex items-center gap-2">
      <div className={`w-2.5 h-2.5 rounded-full ${colors[status] || colors.unknown}`} />
      <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{label}</span>
    </div>
  );
}

function SystemHealthBar({ summary }) {
  const importHealth = summary?.import?.attempts > 0
    ? (summary.import.failure_rate < 0.1 ? 'healthy' : summary.import.failure_rate < 0.3 ? 'degraded' : 'down')
    : 'unknown';

  const planningHealth = summary?.planning?.attempts > 0
    ? (summary.planning.failure_rate < 0.1 ? 'healthy' : summary.planning.failure_rate < 0.3 ? 'degraded' : 'down')
    : 'unknown';

  const dataQualityHealth = summary?.data_quality
    ? (summary.data_quality.fallback_usage_rate < 0.1 ? 'healthy' : summary.data_quality.fallback_usage_rate < 0.3 ? 'degraded' : 'down')
    : 'unknown';

  const logHealth = summary?.logger?.byLevel?.error > 10 ? 'degraded' : 'healthy';

  return (
    <Card className="!p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">System Health</p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatusIndicator status={importHealth} label="Data Import" />
        <StatusIndicator status={planningHealth} label="Planning Engine" />
        <StatusIndicator status={dataQualityHealth} label="Data Quality" />
        <StatusIndicator status={logHealth} label="Error Rate" />
      </div>
    </Card>
  );
}

function DataQualitySection({ summary }) {
  if (!summary?.data_quality) return null;
  const dq = summary.data_quality;

  const metrics = [
    {
      icon: Shield,
      label: 'Fallback Usage',
      value: dq.fallback_usage_count || 0,
      sub: dq.fallback_usage_rate > 0 ? `${(dq.fallback_usage_rate * 100).toFixed(0)}% of runs` : null,
      accent: dq.fallback_usage_rate > 0.2 ? 'text-amber-600' : 'text-emerald-600',
    },
    {
      icon: AlertTriangle,
      label: 'Degraded Capability',
      value: dq.degraded_capability_count || 0,
      accent: dq.degraded_capability_count > 0 ? 'text-amber-600' : 'text-emerald-600',
    },
    {
      icon: TrendingUp,
      label: 'Quality Trend',
      value: dq.quality_trend?.direction || 'stable',
      sub: dq.quality_trend?.samples ? `${dq.quality_trend.samples} samples` : null,
      accent: 'text-blue-600',
    },
    {
      icon: Database,
      label: 'Avg Score',
      value: dq.quality_trend?.avgScore != null ? `${(dq.quality_trend.avgScore * 100).toFixed(0)}%` : '--',
      accent: 'text-indigo-600',
    },
  ];

  return <HealthSection title="Data Quality" icon={Shield} metrics={metrics} />;
}

function LogsSection({ summary }) {
  if (!summary?.logger) return null;
  const log = summary.logger;

  const metrics = [
    { icon: Activity, label: 'Total Log Entries', value: log.totalEntries || 0, accent: 'text-slate-600' },
    { icon: AlertTriangle, label: 'Errors', value: log.byLevel?.error || 0, accent: log.byLevel?.error > 0 ? 'text-red-600' : 'text-emerald-600' },
    { icon: AlertTriangle, label: 'Warnings', value: log.byLevel?.warn || 0, accent: log.byLevel?.warn > 0 ? 'text-amber-600' : 'text-emerald-600' },
    { icon: CheckCircle2, label: 'Info', value: log.byLevel?.info || 0, accent: 'text-blue-600' },
  ];

  return <HealthSection title="Log Health" icon={Activity} metrics={metrics} />;
}

function LatencySection({ summary }) {
  if (!summary?.planning) return null;
  const plan = summary.planning;

  return (
    <HealthSection title="Performance" icon={Zap}>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricCard
          icon={Clock}
          label="P50 Latency"
          value={plan.latency_p50_ms > 0 ? `${plan.latency_p50_ms}ms` : '--'}
          accent="text-blue-600"
        />
        <MetricCard
          icon={Clock}
          label="P95 Latency"
          value={plan.latency_p95_ms > 0 ? `${plan.latency_p95_ms}ms` : '--'}
          accent={plan.latency_p95_ms > 5000 ? 'text-amber-600' : 'text-blue-600'}
        />
        <MetricCard
          icon={Calculator}
          label="Success Rate"
          value={plan.attempts > 0 ? `${((plan.successes / plan.attempts) * 100).toFixed(1)}%` : '--'}
          accent="text-emerald-600"
        />
        <MetricCard
          icon={AlertTriangle}
          label="Empty Outputs"
          value={plan.empty_output_plans || 0}
          accent={plan.empty_output_plans > 0 ? 'text-red-600' : 'text-emerald-600'}
        />
      </div>
    </HealthSection>
  );
}

export default function OpsDashboard() {
  const { user } = useAuth();
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState(null);

  const refresh = () => {
    setLoading(true);
    try {
      const data = getOperationalSummary();
      setSummary(data);
      setLastRefresh(new Date());
    } catch {
      setSummary(null);
    }
    setLoading(false);
  };

  useEffect(() => { refresh(); }, []);

  const importMetrics = useMemo(() => {
    if (!summary) return [];
    const imp = summary.import || {};
    return [
      { icon: Upload, label: 'Import Attempts', value: imp.attempts || 0, accent: 'text-blue-600' },
      { icon: Database, label: 'Success Rate', value: imp.attempts > 0 ? `${((imp.successes / imp.attempts) * 100).toFixed(0)}%` : '--', accent: 'text-emerald-600' },
      { icon: AlertTriangle, label: 'Review Required', value: imp.mapping_review_required || 0, accent: 'text-amber-600' },
      { icon: AlertTriangle, label: 'Failures', value: imp.failures || 0, accent: imp.failures > 0 ? 'text-red-600' : 'text-emerald-600' },
    ];
  }, [summary]);

  const planningMetrics = useMemo(() => {
    if (!summary) return [];
    const plan = summary.planning || {};
    return [
      { icon: Calculator, label: 'Plan Attempts', value: plan.attempts || 0, accent: 'text-indigo-600' },
      { icon: Activity, label: 'Successes', value: plan.successes || 0, accent: 'text-emerald-600' },
      { icon: Clock, label: 'P50 Latency', value: plan.latency_p50_ms > 0 ? `${plan.latency_p50_ms}ms` : '--', accent: 'text-blue-600' },
      { icon: AlertTriangle, label: 'Zero-Result Plans', value: plan.zero_result_plans || 0, accent: plan.zero_result_plans > 0 ? 'text-red-600' : 'text-emerald-600' },
    ];
  }, [summary]);

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="max-w-7xl mx-auto px-4 md:px-8 py-8 space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold tracking-widest uppercase text-indigo-500">OPERATIONS</p>
            <h1 className="text-2xl font-bold tracking-tight" style={{ color: 'var(--text-primary)' }}>
              Ops Dashboard
            </h1>
            {lastRefresh && (
              <p className="text-[10px] text-slate-400 mt-1">
                Last refreshed: {lastRefresh.toLocaleTimeString()}
              </p>
            )}
          </div>
          <button
            onClick={refresh}
            className="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            title="Refresh"
          >
            <RefreshCw className={`w-5 h-5 text-slate-500 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* System Health Bar */}
        {summary && <SystemHealthBar summary={summary} />}

        {/* Alerts */}
        <AlertBanner alerts={summary?.alerts} />

        {/* Import Health */}
        <HealthSection title="Import Health" icon={Upload} metrics={importMetrics} />

        {/* Planning Health */}
        <HealthSection title="Planning Health" icon={Calculator} metrics={planningMetrics} />

        {/* Performance */}
        <LatencySection summary={summary} />

        {/* Data Quality */}
        <DataQualitySection summary={summary} />

        {/* Log Health */}
        <LogsSection summary={summary} />

        {/* No data message */}
        {!summary && !loading && (
          <Card className="!p-8 text-center">
            <BarChart3 className="w-12 h-12 mx-auto mb-3 text-slate-300 dark:text-slate-600" />
            <p className="text-sm text-slate-500">No operational data available yet.</p>
            <p className="text-xs text-slate-400 mt-1">Run imports and planning workflows to generate metrics.</p>
          </Card>
        )}
      </div>
    </div>
  );
}
