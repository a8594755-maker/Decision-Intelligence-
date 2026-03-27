// HealthCheckBar.jsx — Compact display of health check diagnostics
// Shows severity-colored pills with expandable detail panel.

import { useState } from 'react';
import { ChevronDown, ChevronUp, Activity, Database } from 'lucide-react';

const SEVERITY_STYLES = {
  critical: { pill: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300', dot: 'bg-red-500' },
  high:     { pill: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300', dot: 'bg-orange-500' },
  medium:   { pill: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300', dot: 'bg-amber-400' },
  low:      { pill: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400', dot: 'bg-slate-400' },
};

const METRIC_TYPE_LABELS = {
  trend: 'Trend',
  rate: 'Rate',
  concentration: 'Concentration',
  count: 'Count',
  average: 'Average',
};

function formatAnalysis(analysis) {
  if (!analysis) return '';
  if (analysis.z_score != null) return `Z=${analysis.z_score}, latest=${analysis.latest}, mean=${analysis.mean}`;
  if (analysis.top3_share != null) return `Top-3 share: ${analysis.top3_share}%`;
  if (analysis.value != null) return `Value: ${analysis.value}`;
  const entries = Object.entries(analysis).filter(([k]) => k !== 'severity' && k !== 'data_points');
  return entries.map(([k, v]) => `${k}: ${typeof v === 'number' ? Math.round(v * 100) / 100 : v}`).join(', ');
}

export default function HealthCheckBar({ healthCheck }) {
  const [expanded, setExpanded] = useState(false);

  const diagnostics = healthCheck?.diagnostics || [];
  if (diagnostics.length === 0) return null;

  const criticalCount = diagnostics.filter(d => d.analysis?.severity === 'critical').length;
  const highCount = diagnostics.filter(d => d.analysis?.severity === 'high').length;
  const schema = healthCheck?.schema_summary;

  return (
    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-card)] overflow-hidden">
      {/* Header bar */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--surface-subtle)] transition-colors"
      >
        <Activity className="w-4 h-4 text-[var(--text-secondary)] shrink-0" />
        <span className="text-xs font-medium text-[var(--text-primary)]">
          Health Check: {diagnostics.length} diagnostic{diagnostics.length !== 1 ? 's' : ''}
        </span>

        {/* Severity counts */}
        <div className="flex items-center gap-1.5">
          {criticalCount > 0 && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300 font-medium">
              {criticalCount} critical
            </span>
          )}
          {highCount > 0 && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300 font-medium">
              {highCount} high
            </span>
          )}
        </div>

        {/* Tables info */}
        {schema?.tables_with_data?.length > 0 && (
          <span className="text-[10px] text-[var(--text-muted)] flex items-center gap-1 ml-auto mr-2">
            <Database className="w-3 h-3" />
            {schema.tables_with_data.length} tables · {healthCheck.duration_ms}ms
          </span>
        )}

        {expanded ? <ChevronUp className="w-3.5 h-3.5 text-[var(--text-tertiary)]" /> : <ChevronDown className="w-3.5 h-3.5 text-[var(--text-tertiary)]" />}
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-[var(--border-default)] px-4 py-3 space-y-2">
          {diagnostics.map((d) => {
            const severity = d.analysis?.severity || 'low';
            const styles = SEVERITY_STYLES[severity] || SEVERITY_STYLES.low;
            return (
              <div key={d.id} className="flex items-start gap-2.5 py-1.5">
                <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${styles.dot}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-medium text-[var(--text-primary)]">{d.title}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${styles.pill}`}>
                      {severity}
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--surface-subtle)] text-[var(--text-tertiary)]">
                      {METRIC_TYPE_LABELS[d.metric_type] || d.metric_type}
                    </span>
                  </div>
                  <p className="text-[11px] text-[var(--text-secondary)] mt-0.5 font-mono">
                    {formatAnalysis(d.analysis)}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
