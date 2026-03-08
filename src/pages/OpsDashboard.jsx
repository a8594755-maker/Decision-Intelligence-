/**
 * Ops Dashboard
 *
 * Operational monitoring for system health, import quality, and planning performance.
 * Admin-only page for system maintenance and troubleshooting.
 */

import React, { useState, useEffect, useMemo } from 'react';
import {
  Activity, Upload, Calculator, AlertTriangle, Clock, TrendingUp,
  RefreshCw, BarChart3, Database
} from 'lucide-react';
import { Card, Badge } from '../components/ui';
import { useAuth } from '../contexts/AuthContext';
import { getOperationalSummary } from '../services/observability/operationalMetrics';

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

function HealthSection({ title, metrics }) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {metrics.map((m, i) => (
          <MetricCard key={i} {...m} />
        ))}
      </div>
    </div>
  );
}

export default function OpsDashboard() {
  const { user } = useAuth();
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = () => {
    setLoading(true);
    try {
      const data = getOperationalSummary();
      setSummary(data);
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
      { icon: AlertTriangle, label: 'Review Required', value: imp.review_required || 0, accent: 'text-amber-600' },
      { icon: AlertTriangle, label: 'Fallback Used', value: imp.fallback_used || 0, accent: 'text-orange-600' },
    ];
  }, [summary]);

  const planningMetrics = useMemo(() => {
    if (!summary) return [];
    const plan = summary.planning || {};
    const avgLatency = plan.latency_ms?.length > 0
      ? Math.round(plan.latency_ms.reduce((a, b) => a + b, 0) / plan.latency_ms.length)
      : 0;
    return [
      { icon: Calculator, label: 'Plan Attempts', value: plan.attempts || 0, accent: 'text-indigo-600' },
      { icon: Activity, label: 'Success Rate', value: plan.attempts > 0 ? `${((plan.successes / plan.attempts) * 100).toFixed(0)}%` : '--', accent: 'text-emerald-600' },
      { icon: Clock, label: 'Avg Latency', value: avgLatency > 0 ? `${avgLatency}ms` : '--', accent: 'text-blue-600' },
      { icon: AlertTriangle, label: 'Zero-Result Plans', value: plan.zero_result_plans || 0, accent: 'text-red-600' },
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
          </div>
          <button
            onClick={refresh}
            className="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            title="Refresh"
          >
            <RefreshCw className={`w-5 h-5 text-slate-500 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Alerts */}
        {summary?.alerts?.length > 0 && (
          <div className="space-y-2">
            {summary.alerts.map((alert, i) => (
              <div key={i} className="flex items-center gap-2 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
                <AlertTriangle className="w-4 h-4 text-red-600 flex-shrink-0" />
                <span className="text-sm text-red-800 dark:text-red-200">{alert}</span>
              </div>
            ))}
          </div>
        )}

        {/* Import Health */}
        <HealthSection title="Import Health" metrics={importMetrics} />

        {/* Planning Health */}
        <HealthSection title="Planning Health" metrics={planningMetrics} />

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
