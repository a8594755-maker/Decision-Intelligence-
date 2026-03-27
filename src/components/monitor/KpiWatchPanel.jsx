/**
 * KpiWatchPanel — KPI watch rule management + breach history UI
 *
 * Features:
 *   - Rule list with enable/disable toggle
 *   - Create/edit rule form
 *   - Breach history table with severity badges
 *   - Monitor status indicator
 *
 * Props:
 *   rules:        KPI watch rules array
 *   breaches:     breach history array
 *   monitorStatus: { running, polls, breaches, lastPollAt }
 *   onCreateRule:  (rule) => void
 *   onToggleRule:  (ruleId, enabled) => void
 *   onDeleteRule:  (ruleId) => void
 *   onResolveBreach: (breachId) => void
 *   onTestRule:    (ruleId) => void
 */

import { useState } from 'react';
import {
  Activity, AlertTriangle, Plus, Trash2, ToggleLeft, ToggleRight,
  CheckCircle2, Clock, Gauge, ChevronDown, ChevronUp, Play,
} from 'lucide-react';

const METRIC_TYPE_LABELS = {
  inventory_days_on_hand: 'Inventory Days on Hand',
  open_po_aging_days: 'Open PO Aging (days)',
  supplier_on_time_rate: 'Supplier On-Time Rate',
  forecast_accuracy: 'Forecast Accuracy',
  stockout_risk: 'Stockout Risk',
  service_level: 'Service Level',
};

const THRESHOLD_TYPE_LABELS = {
  below: 'Below',
  above: 'Above',
  drift: 'Drift from',
  outside_range: 'Outside range',
};

const SEVERITY_STYLES = {
  critical: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  high: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  low: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
};

function SeverityBadge({ severity }) {
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium uppercase ${SEVERITY_STYLES[severity] || SEVERITY_STYLES.low}`}>
      {severity}
    </span>
  );
}

function MonitorStatusBadge({ status }) {
  if (!status) return null;
  const running = status.running;
  return (
    <div className={`flex items-center gap-1.5 text-xs font-medium ${running ? 'text-emerald-600' : 'text-slate-400'}`}>
      <div className={`w-2 h-2 rounded-full ${running ? 'bg-emerald-500 animate-pulse' : 'bg-slate-300'}`} />
      {running ? 'Monitor Active' : 'Monitor Stopped'}
      {status.lastPollAt && (
        <span className="text-slate-400 font-normal ml-1">
          (polled {status.polls}x, {status.breaches} breach{status.breaches !== 1 ? 'es' : ''})
        </span>
      )}
    </div>
  );
}

// ── Create Rule Form ────────────────────────────────────────────────────────

function CreateRuleForm({ onSubmit, onCancel }) {
  const [form, setForm] = useState({
    name: '',
    metric_type: 'inventory_days_on_hand',
    threshold_type: 'below',
    threshold_value: '',
    severity: 'medium',
    check_interval_minutes: 60,
    cooldown_minutes: 240,
  });

  function handleSubmit(e) {
    e.preventDefault();
    if (!form.name || form.threshold_value === '') return;
    onSubmit({ ...form, threshold_value: Number(form.threshold_value) });
  }

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  return (
    <form onSubmit={handleSubmit} className="border border-[var(--brand-500)] rounded-lg p-3 bg-[var(--accent-active)] space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">Name</span>
          <input value={form.name} onChange={e => set('name', e.target.value)}
            className="w-full mt-0.5 px-2 py-1 border rounded text-xs bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700" />
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">Metric</span>
          <select value={form.metric_type} onChange={e => set('metric_type', e.target.value)}
            className="w-full mt-0.5 px-2 py-1 border rounded text-xs bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700">
            {Object.entries(METRIC_TYPE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <label className="block">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">Threshold Type</span>
          <select value={form.threshold_type} onChange={e => set('threshold_type', e.target.value)}
            className="w-full mt-0.5 px-2 py-1 border rounded text-xs bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700">
            {Object.entries(THRESHOLD_TYPE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">Value</span>
          <input type="number" value={form.threshold_value} onChange={e => set('threshold_value', e.target.value)}
            className="w-full mt-0.5 px-2 py-1 border rounded text-xs bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700" />
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">Severity</span>
          <select value={form.severity} onChange={e => set('severity', e.target.value)}
            className="w-full mt-0.5 px-2 py-1 border rounded text-xs bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700">
            {['low', 'medium', 'high', 'critical'].map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">Check interval (min)</span>
          <input type="number" value={form.check_interval_minutes} onChange={e => set('check_interval_minutes', Number(e.target.value))}
            className="w-full mt-0.5 px-2 py-1 border rounded text-xs bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700" />
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">Cooldown (min)</span>
          <input type="number" value={form.cooldown_minutes} onChange={e => set('cooldown_minutes', Number(e.target.value))}
            className="w-full mt-0.5 px-2 py-1 border rounded text-xs bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700" />
        </label>
      </div>
      <div className="flex gap-2 pt-1">
        <button type="submit" className="px-3 py-1 bg-[var(--brand-600)] text-white rounded text-xs font-medium hover:bg-[var(--brand-700)]">
          Create Rule
        </button>
        <button type="button" onClick={onCancel} className="px-3 py-1 bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 rounded text-xs font-medium hover:bg-slate-300">
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── Main Panel ──────────────────────────────────────────────────────────────

export default function KpiWatchPanel({
  rules = [],
  breaches = [],
  monitorStatus = null,
  onCreateRule,
  onToggleRule,
  onDeleteRule,
  onResolveBreach,
  onTestRule,
}) {
  const [showCreate, setShowCreate] = useState(false);
  const [activeTab, setActiveTab] = useState('rules'); // 'rules' | 'breaches'
  const [expandedRule, setExpandedRule] = useState(null);

  function handleCreate(rule) {
    onCreateRule?.(rule);
    setShowCreate(false);
  }

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 bg-gradient-to-r from-emerald-50 to-white dark:from-emerald-950/30 dark:to-slate-900">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-emerald-600" />
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">KPI Monitor</h3>
          </div>
          <MonitorStatusBadge status={monitorStatus} />
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-slate-200 dark:border-slate-700">
        <button
          onClick={() => setActiveTab('rules')}
          className={`flex-1 py-2 text-xs font-medium text-center transition-colors ${
            activeTab === 'rules'
              ? 'text-[var(--brand-600)] border-b-2 border-[var(--brand-600)]'
              : 'text-slate-500 hover:text-slate-700'
          }`}
        >
          Watch Rules ({rules.length})
        </button>
        <button
          onClick={() => setActiveTab('breaches')}
          className={`flex-1 py-2 text-xs font-medium text-center transition-colors ${
            activeTab === 'breaches'
              ? 'text-red-600 border-b-2 border-red-600'
              : 'text-slate-500 hover:text-slate-700'
          }`}
        >
          Breaches ({breaches.filter(b => !b.resolved).length} active)
        </button>
      </div>

      <div className="p-3">
        {activeTab === 'rules' && (
          <div className="space-y-2">
            {/* Add rule button */}
            {!showCreate && (
              <button
                onClick={() => setShowCreate(true)}
                className="flex items-center gap-1.5 px-2 py-1 text-xs text-[var(--brand-600)] hover:text-[var(--brand-700)] font-medium"
              >
                <Plus className="w-3.5 h-3.5" /> Add Watch Rule
              </button>
            )}
            {showCreate && <CreateRuleForm onSubmit={handleCreate} onCancel={() => setShowCreate(false)} />}

            {/* Rule list */}
            {rules.length === 0 && !showCreate && (
              <p className="text-xs text-slate-400 text-center py-4">No watch rules configured</p>
            )}
            {rules.map(rule => (
              <div key={rule.id} className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
                <div
                  className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50"
                  onClick={() => setExpandedRule(expandedRule === rule.id ? null : rule.id)}
                >
                  <div className="flex items-center gap-2">
                    <Gauge className="w-3.5 h-3.5 text-slate-400" />
                    <span className="text-xs font-medium text-slate-700 dark:text-slate-200">{rule.name}</span>
                    <SeverityBadge severity={rule.severity} />
                    {!rule.enabled && (
                      <span className="text-[10px] text-slate-400 italic">disabled</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={e => { e.stopPropagation(); onTestRule?.(rule.id); }}
                      className="p-1 text-slate-400 hover:text-[var(--brand-600)]" title="Test rule"
                    >
                      <Play className="w-3 h-3" />
                    </button>
                    <button
                      onClick={e => { e.stopPropagation(); onToggleRule?.(rule.id, !rule.enabled); }}
                      className="p-1 text-slate-400 hover:text-emerald-600" title="Toggle"
                    >
                      {rule.enabled ? <ToggleRight className="w-4 h-4 text-emerald-500" /> : <ToggleLeft className="w-4 h-4" />}
                    </button>
                    <button
                      onClick={e => { e.stopPropagation(); onDeleteRule?.(rule.id); }}
                      className="p-1 text-slate-400 hover:text-red-600" title="Delete"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                    {expandedRule === rule.id ? <ChevronUp className="w-3.5 h-3.5 text-slate-400" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-400" />}
                  </div>
                </div>
                {expandedRule === rule.id && (
                  <div className="px-3 py-2 border-t border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/30 text-xs text-slate-600 dark:text-slate-300 space-y-1">
                    <div><span className="text-slate-400">Metric:</span> {METRIC_TYPE_LABELS[rule.metric_type] || rule.metric_type}</div>
                    <div><span className="text-slate-400">Threshold:</span> {THRESHOLD_TYPE_LABELS[rule.threshold_type]} {rule.threshold_value}{rule.threshold_upper != null ? ` – ${rule.threshold_upper}` : ''}</div>
                    <div><span className="text-slate-400">Check every:</span> {rule.check_interval_minutes} min | <span className="text-slate-400">Cooldown:</span> {rule.cooldown_minutes} min</div>
                    {rule.last_checked_at && <div><span className="text-slate-400">Last checked:</span> {new Date(rule.last_checked_at).toLocaleString()}</div>}
                    {rule.last_breached_at && <div><span className="text-slate-400">Last breach:</span> {new Date(rule.last_breached_at).toLocaleString()}</div>}
                    {rule.entity_filter && Object.keys(rule.entity_filter).length > 0 && (
                      <div><span className="text-slate-400">Filter:</span> {JSON.stringify(rule.entity_filter)}</div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {activeTab === 'breaches' && (
          <div className="space-y-1.5">
            {breaches.length === 0 && (
              <p className="text-xs text-slate-400 text-center py-4">No breaches recorded</p>
            )}
            {breaches.map(breach => (
              <div key={breach.id} className="flex items-center justify-between px-3 py-2 border border-slate-200 dark:border-slate-700 rounded text-xs">
                <div className="flex items-center gap-2">
                  <AlertTriangle className={`w-3 h-3 ${breach.resolved ? 'text-slate-300' : 'text-red-500'}`} />
                  <span className="font-mono text-slate-600 dark:text-slate-300">
                    {METRIC_TYPE_LABELS[breach.metric_type] || breach.metric_type}
                  </span>
                  <span className="text-slate-400">
                    {breach.metric_value} {THRESHOLD_TYPE_LABELS[breach.threshold_type]?.toLowerCase()} {breach.threshold_value}
                  </span>
                  <SeverityBadge severity={breach.severity} />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-slate-400">
                    {new Date(breach.created_at).toLocaleString()}
                  </span>
                  {breach.resolved ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                  ) : (
                    <button
                      onClick={() => onResolveBreach?.(breach.id)}
                      className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 text-[10px] font-medium hover:bg-emerald-200"
                    >
                      Resolve
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
