// SnapshotCompareView.jsx — Side-by-side comparison of two snapshot versions
// Shows metric deltas and finding differences between versions of the same query.

import { useMemo } from 'react';
import { ArrowRight, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { Card } from '../ui/Card';
import { parseMetricValue } from '../../services/forecast/insightsAnalyticsEngine';

function MetricDelta({ label, oldVal, newVal }) {
  const oldNum = parseMetricValue(oldVal);
  const newNum = parseMetricValue(newVal);
  const hasDelta = oldNum != null && newNum != null && !isNaN(oldNum) && !isNaN(newNum);
  const delta = hasDelta ? newNum - oldNum : null;
  const pct = hasDelta && oldNum !== 0 ? ((delta / Math.abs(oldNum)) * 100).toFixed(1) : null;

  const Icon = delta > 0 ? TrendingUp : delta < 0 ? TrendingDown : Minus;
  const color = delta > 0
    ? 'text-emerald-600'
    : delta < 0
      ? 'text-red-600'
      : 'text-[var(--text-tertiary)]';

  return (
    <div className="flex items-center justify-between py-1.5 border-b border-[var(--border-default)] last:border-0">
      <span className="text-xs text-[var(--text-secondary)] truncate max-w-[40%]">{label}</span>
      <div className="flex items-center gap-2 text-xs">
        <span className="text-[var(--text-tertiary)]">{oldVal}</span>
        <ArrowRight className="w-3 h-3 text-[var(--text-tertiary)]" />
        <span className="font-medium text-[var(--text-primary)]">{newVal}</span>
        {hasDelta && (
          <span className={`flex items-center gap-0.5 ${color}`}>
            <Icon className="w-3 h-3" />
            {pct != null && `${pct}%`}
          </span>
        )}
      </div>
    </div>
  );
}

function FindingsDiff({ oldFindings, newFindings }) {
  const oldSet = new Set(oldFindings || []);
  const newSet = new Set(newFindings || []);
  const added = (newFindings || []).filter(f => !oldSet.has(f));
  const removed = (oldFindings || []).filter(f => !newSet.has(f));
  const kept = (newFindings || []).filter(f => oldSet.has(f));

  if (!added.length && !removed.length && !kept.length) return null;

  return (
    <div className="space-y-2">
      {added.length > 0 && (
        <div>
          <span className="text-[10px] font-medium text-emerald-600 uppercase">New</span>
          <ul className="mt-0.5 space-y-0.5">
            {added.map((f, i) => (
              <li key={i} className="text-xs text-emerald-700 dark:text-emerald-300 flex items-start gap-1">
                <span className="mt-0.5">+</span>
                <span className="line-clamp-2">{f}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {removed.length > 0 && (
        <div>
          <span className="text-[10px] font-medium text-red-600 uppercase">Removed</span>
          <ul className="mt-0.5 space-y-0.5">
            {removed.map((f, i) => (
              <li key={i} className="text-xs text-red-600 dark:text-red-400 flex items-start gap-1 line-through opacity-60">
                <span className="mt-0.5">-</span>
                <span className="line-clamp-2">{f}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {kept.length > 0 && (
        <div>
          <span className="text-[10px] font-medium text-[var(--text-tertiary)] uppercase">Unchanged</span>
          <ul className="mt-0.5 space-y-0.5">
            {kept.slice(0, 3).map((f, i) => (
              <li key={i} className="text-xs text-[var(--text-tertiary)] flex items-start gap-1">
                <span className="mt-0.5">=</span>
                <span className="line-clamp-1">{f}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function SnapshotCompareView({ older, newer, onClose }) {
  // Build metric comparison by matching labels
  const metricPairs = useMemo(() => {
    const oldMap = {};
    for (const p of (older?.metric_pills || [])) {
      oldMap[p.label?.toLowerCase()] = p.value;
    }
    const pairs = [];
    for (const p of (newer?.metric_pills || [])) {
      const key = p.label?.toLowerCase();
      pairs.push({
        label: p.label,
        oldVal: oldMap[key] || '—',
        newVal: p.value,
      });
      delete oldMap[key];
    }
    // Metrics only in older version
    for (const [key, val] of Object.entries(oldMap)) {
      pairs.push({ label: key, oldVal: val, newVal: '—' });
    }
    return pairs;
  }, [older, newer]);

  if (!older || !newer) return null;

  return (
    <Card className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Version Comparison</h3>
        {onClose && (
          <button onClick={onClose} className="text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
            Close
          </button>
        )}
      </div>

      {/* Timeline */}
      <div className="flex items-center gap-3 text-xs text-[var(--text-secondary)]">
        <span>{new Date(older.created_at).toLocaleDateString()}</span>
        <ArrowRight className="w-3 h-3" />
        <span className="font-medium">{new Date(newer.created_at).toLocaleDateString()}</span>
      </div>

      {/* Metric deltas */}
      {metricPairs.length > 0 && (
        <div>
          <h4 className="text-[10px] font-medium text-[var(--text-tertiary)] uppercase tracking-wide mb-1">Metrics</h4>
          {metricPairs.map((p, i) => (
            <MetricDelta key={i} label={p.label} oldVal={p.oldVal} newVal={p.newVal} />
          ))}
        </div>
      )}

      {/* Findings diff */}
      <div>
        <h4 className="text-[10px] font-medium text-[var(--text-tertiary)] uppercase tracking-wide mb-1">Findings</h4>
        <FindingsDiff oldFindings={older.key_findings} newFindings={newer.key_findings} />
      </div>
    </Card>
  );
}
