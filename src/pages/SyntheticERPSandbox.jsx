/**
 * Synthetic ERP Sandbox
 *
 * Generate, explore, and compare synthetic ERP datasets.
 * Supports scenario injection, KPI visualization, and forecast integration.
 */

import React, { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Database, Play, Trash2, ChevronDown, ChevronRight,
  Package, Factory, Truck, GitBranch, BarChart3,
  TrendingUp, AlertTriangle, RefreshCw, Layers,
  Zap, ShieldAlert, ClipboardList, Upload, Download,
  ArrowRightLeft, ExternalLink, CheckCircle, XCircle,
} from 'lucide-react';
import { Card, Badge, Button } from '../components/ui';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine, Area, ComposedChart,
} from 'recharts';

const ML_API = import.meta.env.VITE_ML_API_URL || 'http://localhost:8000';

async function api(path, opts = {}) {
  const res = await fetch(`${ML_API}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

const SEVERITY_BADGE = { low: 'info', medium: 'warning', high: 'danger', critical: 'danger' };
const DISRUPTION_LABELS = {
  demand_spike: 'Demand Spike', demand_crash: 'Demand Crash',
  supplier_delay: 'Supplier Delay', quality_issue: 'Quality Defect',
  plant_shutdown: 'Plant Shutdown',
};
const TOOLTIP_STYLE = {
  backgroundColor: 'var(--surface-card)',
  border: '1px solid var(--border-default)',
  borderRadius: 8,
  fontSize: 12,
};

// ══════════════════════════════════════════════
//  Shared sub-components
// ══════════════════════════════════════════════

function MetricTile({ icon, label, value, sub, accent = 'text-[var(--brand-600)]' }) {
  const Icon = icon;
  return (
    <Card className="!p-4">
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-lg bg-[var(--surface-subtle)]">
          {Icon ? <Icon className={`w-5 h-5 ${accent}`} /> : null}
        </div>
        <div className="min-w-0">
          <p className="text-xs text-slate-500 truncate">{label}</p>
          <p className="text-xl font-bold mt-0.5" style={{ color: 'var(--text-primary)' }}>{value}</p>
          {sub && <p className="text-[10px] text-slate-400 mt-0.5">{sub}</p>}
        </div>
      </div>
    </Card>
  );
}

function SectionHeader({ icon, title, count, children }) {
  const Icon = icon;
  return (
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-2">
        {Icon ? <Icon className="w-4 h-4 text-[var(--brand-600)]" /> : null}
        <h3 className="text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
          {title}
        </h3>
        {count != null && <Badge type="info">{count}</Badge>}
      </div>
      {children}
    </div>
  );
}

function KpiChart({ data, title }) {
  if (!data || data.length === 0) return null;
  const sampled = data.length > 120
    ? data.filter((_, i) => i % Math.ceil(data.length / 120) === 0)
    : data;

  return (
    <Card className="!p-4">
      <p className="text-xs font-medium mb-3" style={{ color: 'var(--text-secondary)' }}>{title}</p>
      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart data={sampled}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default)" />
          <XAxis dataKey="day" tick={{ fontSize: 10 }} />
          <YAxis yAxisId="left" tick={{ fontSize: 10 }} />
          <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10 }} domain={[0, 1]} />
          <Tooltip contentStyle={TOOLTIP_STYLE} />
          <Area yAxisId="left" type="monotone" dataKey="inventory" fill="rgba(99,102,241,0.1)" stroke="rgb(99,102,241)" strokeWidth={1.5} name="Inventory" />
          <Line yAxisId="left" type="monotone" dataKey="demand" stroke="rgb(239,68,68)" strokeWidth={1.5} dot={false} name="Demand" />
          <Line yAxisId="right" type="monotone" dataKey="fill_rate" stroke="rgb(16,185,129)" strokeWidth={2} dot={false} name="Fill Rate" />
          <ReferenceLine yAxisId="right" y={0.95} stroke="rgb(245,158,11)" strokeDasharray="5 3" label={{ value: "95%", position: "right", fill: "rgb(245,158,11)", fontSize: 10 }} />
        </ComposedChart>
      </ResponsiveContainer>
    </Card>
  );
}

function DataTable({ rows, columns, maxRows = 20 }) {
  if (!rows || rows.length === 0) return <p className="text-xs text-slate-400 py-4 text-center">No data</p>;
  const display = rows.slice(0, maxRows);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b" style={{ borderColor: 'var(--border-default)' }}>
            {columns.map(c => (
              <th key={c.key} className="py-2 px-3 text-left font-medium" style={{ color: 'var(--text-secondary)' }}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {display.map((row, i) => (
            <tr key={i} className="border-b last:border-0" style={{ borderColor: 'var(--border-default)' }}>
              {columns.map(c => (
                <td key={c.key} className="py-1.5 px-3" style={{ color: 'var(--text-primary)' }}>
                  {c.render ? c.render(row[c.key], row) : String(row[c.key] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > maxRows && (
        <p className="text-[10px] text-slate-400 mt-1 text-center">Showing {maxRows} of {rows.length} rows</p>
      )}
    </div>
  );
}

function CollapsibleSection({ icon, title, count, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  const Icon = icon;
  return (
    <Card>
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-2 text-left">
        {open ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
        {Icon ? <Icon className="w-4 h-4 text-[var(--brand-600)]" /> : null}
        <span className="text-sm font-semibold flex-1" style={{ color: 'var(--text-primary)' }}>{title}</span>
        {count != null && <Badge type="info">{count}</Badge>}
      </button>
      {open && <div className="mt-4">{children}</div>}
    </Card>
  );
}

function TabBar({ tabs, active, onChange }) {
  return (
    <div className="flex gap-0.5 overflow-x-auto border-b" style={{ borderColor: 'var(--border-default)' }}>
      {tabs.map((t, i) => {
        const showDivider = i > 0 && t.group !== tabs[i - 1].group;
        return (
          <React.Fragment key={t.key}>
            {showDivider && (
              <div className="self-stretch flex items-center px-1">
                <div className="w-px h-4 bg-[var(--border-default)]" />
              </div>
            )}
            <button
              onClick={() => onChange(t.key)}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors border-b-2 ${
                active === t.key
                  ? 'text-[var(--brand-600)] border-[var(--brand-600)]'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              <t.icon className="w-3.5 h-3.5" />{t.label}
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
}

const selectCls = "px-2 py-1 rounded-lg border text-xs bg-[var(--surface-base)] border-[var(--border-default)] text-[var(--text-primary)]";
const inputCls = "w-full px-3 py-1.5 rounded-lg border text-sm bg-[var(--surface-base)] border-[var(--border-default)] text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--brand-500)]/40";

// ══════════════════════════════════════════════
//  Scenario Explainer + Disruption Timeline
// ══════════════════════════════════════════════

function DisruptionTimeline({ disruptions, totalDays }) {
  if (!disruptions || disruptions.length === 0) return null;
  return (
    <div className="mt-3">
      <p className="text-[10px] text-slate-400 mb-1">Timeline (day 0 &rarr; {totalDays})</p>
      <div className="relative h-5 bg-[var(--surface-subtle)] rounded overflow-hidden">
        {disruptions.map((d, i) => {
          const left = `${(d.start_day / totalDays) * 100}%`;
          const width = `${Math.max((d.duration_days / totalDays) * 100, 1)}%`;
          const bg = d.side === 'demand' ? 'bg-amber-400' : 'bg-red-400';
          return (
            <div
              key={i}
              className={`absolute top-0 h-full ${bg} rounded opacity-80`}
              style={{ left, width }}
              title={`${DISRUPTION_LABELS[d.name] || d.name}: day ${d.start_day}\u2013${d.start_day + d.duration_days} (${d.severity})`}
            />
          );
        })}
      </div>
      <div className="flex gap-3 mt-1">
        <span className="flex items-center gap-1 text-[10px] text-slate-400"><span className="w-2 h-2 rounded bg-amber-400 inline-block" /> Demand</span>
        <span className="flex items-center gap-1 text-[10px] text-slate-400"><span className="w-2 h-2 rounded bg-red-400 inline-block" /> Supply</span>
      </div>
    </div>
  );
}

function ScenarioExplainer({ disruptions, totalDays }) {
  if (!disruptions || disruptions.length === 0) return null;
  return (
    <div className="mt-3 pt-3 border-t" style={{ borderColor: 'var(--border-default)' }}>
      <div className="flex items-center gap-2 mb-2">
        <ShieldAlert className="w-3.5 h-3.5 text-[var(--brand-600)]" />
        <span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>Scenario Disruptions</span>
        <Badge type="info">{disruptions.length}</Badge>
      </div>
      <div className="space-y-1.5">
        {disruptions.map((d, i) => (
          <div key={i} className="flex items-center gap-2 text-xs flex-wrap">
            <Badge type={d.side === 'demand' ? 'warning' : 'danger'}>{d.side}</Badge>
            <span style={{ color: 'var(--text-primary)' }}>{DISRUPTION_LABELS[d.name] || d.name}</span>
            <Badge type={SEVERITY_BADGE[d.severity] || 'info'}>{d.severity}</Badge>
            <span className="text-slate-400">
              Days {d.start_day}&ndash;{d.start_day + d.duration_days} | Target: {d.target_material === 'all' ? 'all materials' : d.target_material}
            </span>
          </div>
        ))}
      </div>
      <DisruptionTimeline disruptions={disruptions} totalDays={totalDays} />
    </div>
  );
}

// ══════════════════════════════════════════════
//  Generator Form
// ══════════════════════════════════════════════

const SCENARIO_TEMPLATES = [
  { value: '', label: 'None (baseline)' },
  { value: 'single_spike', label: 'Demand Spike' },
  { value: 'supplier_crisis', label: 'Supplier Crisis' },
  { value: 'quality_recall', label: 'Quality Recall' },
  { value: 'multi_disruption', label: 'Multi-Disruption' },
  { value: 'plant_emergency', label: 'Plant Emergency' },
  { value: '__custom', label: 'Custom...' },
];

const DISRUPTION_TYPES = [
  { value: 'demand_spike', label: 'Demand Spike', side: 'demand' },
  { value: 'demand_crash', label: 'Demand Crash', side: 'demand' },
  { value: 'supplier_delay', label: 'Supplier Delay', side: 'supply' },
  { value: 'quality_issue', label: 'Quality Defect', side: 'supply' },
  { value: 'plant_shutdown', label: 'Plant Shutdown', side: 'supply' },
];

const QUICK_START_PRESETS = [
  {
    icon: Play, label: 'Quick Demo',
    desc: '10 products, 3 factories, 1 year of baseline data',
    config: { seed: 42, n_materials: 10, n_plants: 3, n_suppliers: 5, days: 365, chaos_intensity: 'medium', disruptions: [] },
  },
  {
    icon: Truck, label: 'Supplier Crisis',
    desc: 'See what happens when a key supplier goes down',
    config: { seed: 42, n_materials: 10, n_plants: 3, n_suppliers: 5, days: 365, chaos_intensity: 'high', disruptions: ['supplier_crisis'] },
  },
  {
    icon: TrendingUp, label: 'Demand Spike',
    desc: 'Sudden surge in orders — can your supply chain cope?',
    config: { seed: 42, n_materials: 10, n_plants: 3, n_suppliers: 5, days: 365, chaos_intensity: 'medium', disruptions: ['single_spike'] },
  },
  {
    icon: Zap, label: 'Stress Test',
    desc: 'Multiple disruptions at once with extreme variability',
    config: { seed: 99, n_materials: 20, n_plants: 5, n_suppliers: 8, days: 365, chaos_intensity: 'extreme', disruptions: ['multi_disruption'] },
  },
];

function QuickStartPanel({ onGenerate, loading }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      {QUICK_START_PRESETS.map(p => (
        <Card
          key={p.label}
          className="!p-4 cursor-pointer hover:ring-2 hover:ring-[var(--brand-500)]/30 transition-all hover:shadow-md"
          onClick={() => !loading && onGenerate(p.config)}
        >
          <div className="flex items-center gap-2 mb-2">
            <div className="p-1.5 rounded-lg bg-[var(--accent-active)]">
              <p.icon className="w-4 h-4 text-[var(--brand-600)]" />
            </div>
            <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{p.label}</span>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">{p.desc}</p>
        </Card>
      ))}
    </div>
  );
}

const EMPTY_DISRUPTION = { name: 'demand_spike', severity: 'medium', start_day: 60, duration_days: 14, target_material: '', target_plant: '' };

function CustomDisruptionEditor({ disruptions, onChange, totalDays }) {
  const addDisruption = () => onChange([...disruptions, { ...EMPTY_DISRUPTION }]);
  const removeDisruption = (i) => onChange(disruptions.filter((_, idx) => idx !== i));
  const updateDisruption = (i, field, value) => {
    const updated = [...disruptions];
    updated[i] = { ...updated[i], [field]: value };
    onChange(updated);
  };

  return (
    <div className="mt-3 pt-3 border-t space-y-2" style={{ borderColor: 'var(--border-default)' }}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldAlert className="w-3.5 h-3.5 text-[var(--brand-600)]" />
          <span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>Custom Disruptions</span>
          <Badge type="info">{disruptions.length}</Badge>
        </div>
        <Button variant="secondary" onClick={addDisruption} className="!text-xs !px-2 !py-1">+ Add</Button>
      </div>
      {disruptions.map((d, i) => (
        <div key={i} className="grid grid-cols-2 md:grid-cols-7 gap-2 items-end p-2 rounded-lg bg-[var(--surface-subtle)]">
          <label className="space-y-0.5">
            <span className="text-[10px] text-slate-400">Type</span>
            <select value={d.name} onChange={e => updateDisruption(i, 'name', e.target.value)} className={selectCls}>
              {DISRUPTION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </label>
          <label className="space-y-0.5">
            <span className="text-[10px] text-slate-400">Severity</span>
            <select value={d.severity} onChange={e => updateDisruption(i, 'severity', e.target.value)} className={selectCls}>
              {['low', 'medium', 'high', 'critical'].map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
          <label className="space-y-0.5">
            <span className="text-[10px] text-slate-400">Start Day</span>
            <input type="number" min={0} max={totalDays} value={d.start_day} onChange={e => updateDisruption(i, 'start_day', Number(e.target.value))} className={selectCls} />
          </label>
          <label className="space-y-0.5">
            <span className="text-[10px] text-slate-400">Duration</span>
            <input type="number" min={1} max={365} value={d.duration_days} onChange={e => updateDisruption(i, 'duration_days', Number(e.target.value))} className={selectCls} />
          </label>
          <label className="space-y-0.5">
            <span className="text-[10px] text-slate-400">Target Material</span>
            <input type="text" placeholder="all" value={d.target_material} onChange={e => updateDisruption(i, 'target_material', e.target.value)} className={selectCls} />
          </label>
          <label className="space-y-0.5">
            <span className="text-[10px] text-slate-400">Target Plant</span>
            <input type="text" placeholder="all" value={d.target_plant} onChange={e => updateDisruption(i, 'target_plant', e.target.value)} className={selectCls} />
          </label>
          <div className="flex items-end">
            <button onClick={() => removeDisruption(i)} className="text-red-400 hover:text-red-600 p-1"><Trash2 className="w-3.5 h-3.5" /></button>
          </div>
        </div>
      ))}
      {disruptions.length > 0 && (
        <DisruptionTimeline
          disruptions={disruptions.map(d => ({
            ...d,
            side: DISRUPTION_TYPES.find(t => t.value === d.name)?.side || 'demand',
            target_material: d.target_material || 'all',
          }))}
          totalDays={totalDays}
        />
      )}
    </div>
  );
}

function GeneratorForm({ onGenerate, loading }) {
  const [cfg, setCfg] = useState({
    seed: 42,
    n_materials: 10,
    n_plants: 3,
    n_suppliers: 5,
    days: 365,
    chaos_intensity: 'medium',
    scenario: '',
  });
  const [templateInfo, setTemplateInfo] = useState(null);
  const [customDisruptions, setCustomDisruptions] = useState([{ ...EMPTY_DISRUPTION }]);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    api('/synthetic/scenario-templates').then(r => setTemplateInfo(r.templates)).catch(() => {});
  }, []);

  const set = (k, v) => setCfg(prev => ({ ...prev, [k]: v }));

  const handleSubmit = (e) => {
    e.preventDefault();
    let disruptions = [];
    if (cfg.scenario === '__custom') {
      disruptions = customDisruptions.map(d => ({
        name: d.name,
        severity: d.severity,
        start_day: d.start_day,
        duration_days: d.duration_days,
        ...(d.target_material ? { target_material: d.target_material } : {}),
        ...(d.target_plant ? { target_plant: d.target_plant } : {}),
      }));
    } else if (cfg.scenario) {
      disruptions = [cfg.scenario];
    }
    onGenerate({
      seed: Number(cfg.seed),
      n_materials: Number(cfg.n_materials),
      n_plants: Number(cfg.n_plants),
      n_suppliers: Number(cfg.n_suppliers),
      days: Number(cfg.days),
      chaos_intensity: cfg.chaos_intensity,
      disruptions,
    });
  };

  const selectedTemplate = cfg.scenario && cfg.scenario !== '__custom' && templateInfo?.[cfg.scenario];

  return (
    <Card>
      <SectionHeader icon={Database} title="Generate Dataset" />
      <form onSubmit={handleSubmit} className="space-y-3">
        {/* Primary row — the 3 choices that matter + Generate */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <label className="space-y-1">
            <span className="text-xs text-slate-500">Products</span>
            <input type="number" min={1} max={50} value={cfg.n_materials} onChange={e => set('n_materials', e.target.value)} className={inputCls} title="Number of finished goods to simulate" />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-slate-500">Disruption Scenario</span>
            <select value={cfg.scenario} onChange={e => set('scenario', e.target.value)} className={inputCls}>
              {SCENARIO_TEMPLATES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-xs text-slate-500">Variability</span>
            <select value={cfg.chaos_intensity} onChange={e => set('chaos_intensity', e.target.value)} className={inputCls} title="How much randomness in the data">
              {['calm', 'low', 'medium', 'high', 'extreme'].map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
          <div className="flex items-end">
            <Button variant="primary" icon={Play} disabled={loading} type="submit" className="w-full">
              {loading ? 'Generating...' : 'Generate'}
            </Button>
          </div>
        </div>
        {/* Advanced toggle */}
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center gap-1 text-xs text-slate-400 hover:text-[var(--brand-600)] transition-colors"
        >
          {showAdvanced ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          Advanced Settings
        </button>
        {/* Advanced row */}
        {showAdvanced && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <label className="space-y-1">
              <span className="text-xs text-slate-500">Random Seed</span>
              <input type="number" value={cfg.seed} onChange={e => set('seed', e.target.value)} className={inputCls} title="Same seed = reproducible data" />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-slate-500">Factories</span>
              <input type="number" min={1} max={10} value={cfg.n_plants} onChange={e => set('n_plants', e.target.value)} className={inputCls} title="Number of manufacturing locations" />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-slate-500">Time Span (days)</span>
              <input type="number" min={30} max={1095} value={cfg.days} onChange={e => set('days', e.target.value)} className={inputCls} title="Simulation duration" />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-slate-500">Suppliers</span>
              <input type="number" min={1} max={20} value={cfg.n_suppliers} onChange={e => set('n_suppliers', e.target.value)} className={inputCls} />
            </label>
          </div>
        )}
      </form>
      {selectedTemplate && (
        <ScenarioExplainer disruptions={selectedTemplate.disruptions} totalDays={Number(cfg.days)} />
      )}
      {cfg.scenario === '__custom' && (
        <CustomDisruptionEditor disruptions={customDisruptions} onChange={setCustomDisruptions} totalDays={Number(cfg.days)} />
      )}
    </Card>
  );
}

// ══════════════════════════════════════════════
//  Forecast Lab
// ══════════════════════════════════════════════

const FORECAST_MODELS = [
  { value: '', label: 'Auto (best fit)' },
  { value: 'holtwinters', label: 'Holt-Winters' },
  { value: 'prophet', label: 'Prophet' },
  { value: 'linear', label: 'Linear' },
];

function ForecastLab({ datasetId, skus, salesLoader: _salesLoader }) {
  const [sku, setSku] = useState(skus[0] || '');
  const [horizon, setHorizon] = useState(30);
  const [modelType, setModelType] = useState('');
  const [result, setResult] = useState(null);
  const [historyData, setHistoryData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareResults, setCompareResults] = useState(null);
  const [error, setError] = useState('');

  const runForecast = async () => {
    if (!sku) return;
    setLoading(true);
    setError('');
    setCompareResults(null);
    try {
      const [fcRes, salesRes] = await Promise.all([
        api(`/synthetic/datasets/${datasetId}/forecast`, {
          method: 'POST',
          body: JSON.stringify({
            material_code: sku,
            horizon_days: Number(horizon),
            ...(modelType ? { model_type: modelType } : {}),
          }),
        }),
        api(`/synthetic/datasets/${datasetId}/sales?material_code=${sku}&days=365`),
      ]);
      setResult(fcRes);
      setHistoryData(salesRes.records || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const runModelCompare = async () => {
    if (!sku) return;
    setCompareLoading(true);
    setError('');
    try {
      const models = ['holtwinters', 'prophet', 'linear'];
      const [salesRes, ...fcResults] = await Promise.all([
        api(`/synthetic/datasets/${datasetId}/sales?material_code=${sku}&days=365`),
        ...models.map(m =>
          api(`/synthetic/datasets/${datasetId}/forecast`, {
            method: 'POST',
            body: JSON.stringify({ material_code: sku, horizon_days: Number(horizon), model_type: m }),
          }).catch(() => null)
        ),
      ]);
      setHistoryData(salesRes.records || []);
      const results = {};
      models.forEach((m, i) => { if (fcResults[i]) results[m] = fcResults[i]; });
      setCompareResults(results);
      setResult(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setCompareLoading(false);
    }
  };

  // Build chart data combining history tail + forecast
  const chartData = React.useMemo(() => {
    if (!result?.forecast) return null;
    const fc = result.forecast;
    const preds = fc.predictions || fc.forecast || [];
    if (preds.length === 0) return null;

    const data = [];
    // Last 60 days of history
    const histTail = (historyData || []).slice(-60);
    histTail.forEach((h, i) => {
      data.push({ idx: i - histTail.length, history: h.sales, forecast: null });
    });
    // Forecast
    preds.forEach((p, i) => {
      data.push({
        idx: i + 1,
        history: i === 0 && histTail.length > 0 ? histTail[histTail.length - 1].sales : null,
        forecast: typeof p === 'number' ? p : (p.value ?? p.yhat ?? p.predicted),
        lower: p.lower ?? p.yhat_lower ?? undefined,
        upper: p.upper ?? p.yhat_upper ?? undefined,
      });
    });
    return data;
  }, [result, historyData]);

  const metrics = result?.forecast?.metrics || result?.forecast?.evaluation || {};
  const modelUsed = result?.forecast?.model || result?.forecast?.model_type || 'auto';

  return (
    <div className="space-y-4">
      <Card className="!p-4">
        <SectionHeader icon={Zap} title="Run Forecast" />
        <div className="flex items-end gap-3 flex-wrap">
          <label className="space-y-1">
            <span className="text-xs text-slate-500">SKU</span>
            <select value={sku} onChange={e => setSku(e.target.value)} className={selectCls}>
              {skus.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-xs text-slate-500">Horizon (days)</span>
            <input type="number" min={7} max={90} value={horizon} onChange={e => setHorizon(e.target.value)} className={inputCls} style={{ width: 80 }} />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-slate-500">Model</span>
            <select value={modelType} onChange={e => setModelType(e.target.value)} className={selectCls}>
              {FORECAST_MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </label>
          <Button variant="primary" icon={Zap} onClick={runForecast} disabled={loading || compareLoading || !sku}>
            {loading ? 'Running...' : 'Run Forecast'}
          </Button>
          <Button variant="secondary" icon={ArrowRightLeft} onClick={runModelCompare} disabled={loading || compareLoading || !sku} className="!text-xs">
            {compareLoading ? 'Comparing...' : 'Compare All Models'}
          </Button>
        </div>
        {error && <p className="text-xs text-red-500 mt-2">{error}</p>}
      </Card>

      {result && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MetricTile icon={Zap} label="Model" value={modelUsed} accent="text-[var(--brand-600)]" />
            <MetricTile icon={BarChart3} label="History Points" value={result.history_points} accent="text-[var(--brand-600)]" />
            {metrics.mape != null && (
              <MetricTile icon={TrendingUp} label="MAPE" value={`${(metrics.mape * 100).toFixed(1)}%`} accent={metrics.mape < 0.15 ? 'text-emerald-600' : 'text-amber-600'} />
            )}
            {metrics.mae != null && (
              <MetricTile icon={AlertTriangle} label="MAE" value={metrics.mae.toFixed(1)} accent="text-[var(--brand-600)]" />
            )}
          </div>

          {chartData && (
            <Card className="!p-4">
              <p className="text-xs font-medium mb-3" style={{ color: 'var(--text-secondary)' }}>
                Forecast: {sku} ({horizon} days)
              </p>
              <ResponsiveContainer width="100%" height={220}>
                <ComposedChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default)" />
                  <XAxis dataKey="idx" tick={{ fontSize: 10 }} label={{ value: 'Day', position: 'insideBottom', offset: -2, fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
                  {chartData.some(d => d.upper != null) && (
                    <Area type="monotone" dataKey="upper" fill="rgba(99,102,241,0.08)" stroke="none" name="Upper" />
                  )}
                  {chartData.some(d => d.lower != null) && (
                    <Area type="monotone" dataKey="lower" fill="rgba(99,102,241,0.08)" stroke="none" name="Lower" />
                  )}
                  <Line type="monotone" dataKey="history" stroke="rgb(156,163,175)" strokeWidth={1.5} dot={false} name="History" connectNulls={false} />
                  <Line type="monotone" dataKey="forecast" stroke="rgb(99,102,241)" strokeWidth={2} dot={false} name="Forecast" strokeDasharray="6 3" />
                  <ReferenceLine x={0} stroke="var(--border-default)" strokeDasharray="3 3" />
                </ComposedChart>
              </ResponsiveContainer>
            </Card>
          )}
        </>
      )}

      {/* Model-to-Model Comparison */}
      {compareResults && Object.keys(compareResults).length > 0 && (
        <>
          <Card className="!p-4">
            <p className="text-xs font-medium mb-3" style={{ color: 'var(--text-secondary)' }}>Model Comparison: {sku}</p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b" style={{ borderColor: 'var(--border-default)' }}>
                    <th className="text-left py-1.5 px-2 text-slate-500">Model</th>
                    <th className="text-right py-1.5 px-2 text-slate-500">MAPE</th>
                    <th className="text-right py-1.5 px-2 text-slate-500">MAE</th>
                    <th className="text-right py-1.5 px-2 text-slate-500">History Pts</th>
                    <th className="text-left py-1.5 px-2 text-slate-500">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(compareResults).map(([model, res]) => {
                    const m = res?.forecast?.metrics || res?.forecast?.evaluation || {};
                    const mName = res?.forecast?.model || model;
                    return (
                      <tr key={model} className="border-b" style={{ borderColor: 'var(--border-default)' }}>
                        <td className="py-1.5 px-2 font-semibold" style={{ color: 'var(--text-primary)' }}>{FORECAST_MODELS.find(f => f.value === model)?.label || mName}</td>
                        <td className="py-1.5 px-2 text-right">{m.mape != null ? <span className={m.mape < 0.15 ? 'text-emerald-600' : m.mape < 0.3 ? 'text-amber-600' : 'text-red-500'}>{(m.mape * 100).toFixed(1)}%</span> : '--'}</td>
                        <td className="py-1.5 px-2 text-right" style={{ color: 'var(--text-primary)' }}>{m.mae != null ? m.mae.toFixed(1) : '--'}</td>
                        <td className="py-1.5 px-2 text-right" style={{ color: 'var(--text-primary)' }}>{res?.history_points || '--'}</td>
                        <td className="py-1.5 px-2"><Badge type="success">OK</Badge></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Overlay chart with all models */}
          <Card className="!p-4">
            <p className="text-xs font-medium mb-3" style={{ color: 'var(--text-secondary)' }}>Forecast Overlay ({horizon} days)</p>
            <ResponsiveContainer width="100%" height={260}>
              <ComposedChart data={(() => {
                const histTail = (historyData || []).slice(-30);
                const data = histTail.map((h, i) => ({ idx: i - histTail.length, history: h.sales }));
                const maxLen = Math.max(...Object.values(compareResults).map(r => {
                  const p = r?.forecast?.predictions || r?.forecast?.forecast || [];
                  return p.length;
                }));
                for (let i = 0; i < maxLen; i++) {
                  const pt = { idx: i + 1 };
                  if (i === 0 && histTail.length > 0) pt.history = histTail[histTail.length - 1].sales;
                  for (const [model, res] of Object.entries(compareResults)) {
                    const preds = res?.forecast?.predictions || res?.forecast?.forecast || [];
                    const p = preds[i];
                    pt[model] = p != null ? (typeof p === 'number' ? p : (p.value ?? p.yhat ?? p.predicted)) : null;
                  }
                  data.push(pt);
                }
                return data;
              })()}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default)" />
                <XAxis dataKey="idx" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip contentStyle={TOOLTIP_STYLE} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <Line type="monotone" dataKey="history" stroke="rgb(156,163,175)" strokeWidth={1.5} dot={false} name="History" connectNulls={false} />
                <Line type="monotone" dataKey="holtwinters" stroke="rgb(99,102,241)" strokeWidth={2} dot={false} name="Holt-Winters" strokeDasharray="6 3" />
                <Line type="monotone" dataKey="prophet" stroke="rgb(16,185,129)" strokeWidth={2} dot={false} name="Prophet" strokeDasharray="6 3" />
                <Line type="monotone" dataKey="linear" stroke="rgb(249,115,22)" strokeWidth={2} dot={false} name="Linear" strokeDasharray="6 3" />
                <ReferenceLine x={0} stroke="var(--border-default)" strokeDasharray="3 3" />
              </ComposedChart>
            </ResponsiveContainer>
          </Card>
        </>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════
//  Compare Mode
// ══════════════════════════════════════════════

function CompareMetricTile({ icon, label, leftVal, rightVal, format = v => v, lowerIsBetter = false }) {
  const Icon = icon;
  const delta = rightVal - leftVal;
  const pct = leftVal !== 0 ? ((delta / Math.abs(leftVal)) * 100).toFixed(1) : '--';
  const isImprovement = lowerIsBetter ? delta < 0 : delta > 0;
  const arrowColor = Math.abs(delta) < 0.001 ? 'text-slate-400' : isImprovement ? 'text-emerald-600' : 'text-red-500';
  const arrow = delta > 0 ? '\u25B2' : delta < 0 ? '\u25BC' : '\u2014';

  return (
    <Card className="!p-4">
      <div className="flex items-center gap-2 mb-2">
        {Icon ? <Icon className="w-4 h-4 text-[var(--brand-600)]" /> : null}
        <span className="text-xs text-slate-500">{label}</span>
      </div>
      <div className="flex items-baseline gap-3">
        <div className="text-center">
          <p className="text-[10px] text-slate-400">Baseline</p>
          <p className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{format(leftVal)}</p>
        </div>
        <span className={`text-sm font-bold ${arrowColor}`}>{arrow} {pct}%</span>
        <div className="text-center">
          <p className="text-[10px] text-slate-400">Compare</p>
          <p className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{format(rightVal)}</p>
        </div>
      </div>
    </Card>
  );
}

function CompareView({ leftDataset, rightDataset, templateInfo }) {
  // Hooks must be called before any early return
  const overlayData = React.useMemo(() => {
    if (!leftDataset || !rightDataset) return [];
    const lts = leftDataset.kpis?.time_series || [];
    const rts = rightDataset.kpis?.time_series || [];
    const maxLen = Math.max(lts.length, rts.length);
    const step = maxLen > 120 ? Math.ceil(maxLen / 120) : 1;
    const data = [];
    for (let i = 0; i < maxLen; i += step) {
      data.push({
        day: i,
        left_fill_rate: lts[i]?.fill_rate ?? null,
        right_fill_rate: rts[i]?.fill_rate ?? null,
        left_inventory: lts[i]?.inventory ?? null,
        right_inventory: rts[i]?.inventory ?? null,
      });
    }
    return data;
  }, [leftDataset, rightDataset]);

  // By-material delta table
  const deltaRows = React.useMemo(() => {
    if (!leftDataset || !rightDataset) return [];
    const lm = leftDataset.kpis?.by_material || {};
    const rm = rightDataset.kpis?.by_material || {};
    const allMats = [...new Set([...Object.keys(lm), ...Object.keys(rm)])].sort();
    return allMats.map(mat => {
      const l = lm[mat] || {};
      const r = rm[mat] || {};
      return {
        material_code: mat,
        left_fill_rate: l.fill_rate ?? null,
        right_fill_rate: r.fill_rate ?? null,
        delta_fill_rate: (r.fill_rate ?? 0) - (l.fill_rate ?? 0),
        left_cost: l.total_cost ?? 0,
        right_cost: r.total_cost ?? 0,
        delta_cost: (r.total_cost ?? 0) - (l.total_cost ?? 0),
      };
    });
  }, [leftDataset, rightDataset]);

  if (!leftDataset || !rightDataset) return null;

  const lk = leftDataset.kpis?.aggregate || {};
  const rk = rightDataset.kpis?.aggregate || {};
  const lId = leftDataset.descriptor.dataset_id;
  const rId = rightDataset.descriptor.dataset_id;
  const lDisruptions = leftDataset.descriptor.disruptions || [];
  const rDisruptions = rightDataset.descriptor.disruptions || [];

  const fmtPct = v => v != null ? `${(v * 100).toFixed(1)}%` : '--';
  const fmtCost = v => `$${(v || 0).toLocaleString()}`;

  // Resolve template disruption descriptions for display
  const resolveDisruptions = (names) => {
    if (!names || names.length === 0) return null;
    const all = [];
    for (const n of names) {
      if (templateInfo?.[n]?.disruptions) all.push(...templateInfo[n].disruptions);
      else all.push({ name: n, side: '?', severity: '?', start_day: 0, duration_days: 0, target_material: 'all' });
    }
    return all.length > 0 ? all : null;
  };

  return (
    <div className="space-y-4">
      {/* Scenario Details */}
      {(lDisruptions.length > 0 || rDisruptions.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Card className="!p-4">
            <p className="text-xs font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>Baseline Scenarios</p>
            {lDisruptions.length === 0 ? (
              <Badge type="success">No disruptions</Badge>
            ) : (
              <div className="space-y-1">
                {(resolveDisruptions(lDisruptions) || lDisruptions.map(n => ({ name: n }))).map((d, i) => (
                  <div key={i} className="flex items-center gap-1.5 text-xs">
                    <Badge type={d.side === 'demand' ? 'warning' : d.side === 'supply' ? 'danger' : 'info'}>{d.side || d.name}</Badge>
                    <span style={{ color: 'var(--text-primary)' }}>{DISRUPTION_LABELS[d.name] || d.name}</span>
                    {d.severity && d.severity !== '?' && <Badge type={SEVERITY_BADGE[d.severity] || 'info'}>{d.severity}</Badge>}
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card className="!p-4">
            <p className="text-xs font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>Compare Scenarios</p>
            {rDisruptions.length === 0 ? (
              <Badge type="success">No disruptions</Badge>
            ) : (
              <div className="space-y-1">
                {(resolveDisruptions(rDisruptions) || rDisruptions.map(n => ({ name: n }))).map((d, i) => (
                  <div key={i} className="flex items-center gap-1.5 text-xs">
                    <Badge type={d.side === 'demand' ? 'warning' : d.side === 'supply' ? 'danger' : 'info'}>{d.side || d.name}</Badge>
                    <span style={{ color: 'var(--text-primary)' }}>{DISRUPTION_LABELS[d.name] || d.name}</span>
                    {d.severity && d.severity !== '?' && <Badge type={SEVERITY_BADGE[d.severity] || 'info'}>{d.severity}</Badge>}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {/* KPI Comparison */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <CompareMetricTile icon={TrendingUp} label="Fill Rate" leftVal={lk.fill_rate ?? 0} rightVal={rk.fill_rate ?? 0} format={v => `${(v * 100).toFixed(1)}%`} />
        <CompareMetricTile icon={AlertTriangle} label="Stockout Days" leftVal={lk.stockout_days ?? 0} rightVal={rk.stockout_days ?? 0} format={v => String(v)} lowerIsBetter />
        <CompareMetricTile icon={BarChart3} label="Total Cost" leftVal={lk.total_cost ?? 0} rightVal={rk.total_cost ?? 0} format={v => `$${v.toLocaleString()}`} lowerIsBetter />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <CompareMetricTile icon={Package} label="Avg Inventory" leftVal={lk.avg_inventory ?? 0} rightVal={rk.avg_inventory ?? 0} format={v => v.toLocaleString()} />
        <CompareMetricTile icon={RefreshCw} label="Inventory Turns" leftVal={lk.inventory_turns ?? 0} rightVal={rk.inventory_turns ?? 0} format={v => String(v)} />
      </div>

      {/* Overlay Time Series */}
      {overlayData.length > 0 && (
        <Card className="!p-4">
          <p className="text-xs font-medium mb-3" style={{ color: 'var(--text-secondary)' }}>Fill Rate Overlay</p>
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={overlayData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default)" />
              <XAxis dataKey="day" tick={{ fontSize: 10 }} />
              <YAxis domain={[0, 1]} tick={{ fontSize: 10 }} />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Line type="monotone" dataKey="left_fill_rate" stroke="rgb(99,102,241)" strokeWidth={2} dot={false} name={lId.slice(-12)} />
              <Line type="monotone" dataKey="right_fill_rate" stroke="rgb(249,115,22)" strokeWidth={2} dot={false} name={rId.slice(-12)} />
              <ReferenceLine y={0.95} stroke="rgb(245,158,11)" strokeDasharray="5 3" />
            </ComposedChart>
          </ResponsiveContainer>
        </Card>
      )}

      {/* Inventory Level Overlay */}
      {overlayData.length > 0 && overlayData.some(d => d.left_inventory != null) && (
        <Card className="!p-4">
          <p className="text-xs font-medium mb-3" style={{ color: 'var(--text-secondary)' }}>Inventory Level Overlay</p>
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={overlayData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default)" />
              <XAxis dataKey="day" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Area type="monotone" dataKey="left_inventory" stroke="rgb(99,102,241)" fill="rgba(99,102,241,0.1)" strokeWidth={1.5} dot={false} name={`${lId.slice(-12)} inv`} />
              <Area type="monotone" dataKey="right_inventory" stroke="rgb(249,115,22)" fill="rgba(249,115,22,0.1)" strokeWidth={1.5} dot={false} name={`${rId.slice(-12)} inv`} />
            </ComposedChart>
          </ResponsiveContainer>
        </Card>
      )}

      {/* Summary Stats Comparison */}
      <Card className="!p-4">
        <p className="text-xs font-medium mb-3" style={{ color: 'var(--text-secondary)' }}>Summary Statistics</p>
        <div className="grid grid-cols-2 gap-4 text-xs">
          <div>
            <p className="font-semibold mb-2 text-[var(--brand-600)]">{lId.slice(-12)} (Baseline)</p>
            <div className="space-y-1">
              <p>Total Demand: <strong style={{ color: 'var(--text-primary)' }}>{(lk.total_demand || 0).toLocaleString()}</strong></p>
              <p>Total Fulfilled: <strong style={{ color: 'var(--text-primary)' }}>{(lk.total_fulfilled || 0).toLocaleString()}</strong></p>
              <p>Total Stockout: <strong style={{ color: '#ef4444' }}>{(lk.total_stockout || 0).toLocaleString()}</strong></p>
              <p>Holding Cost: <strong style={{ color: 'var(--text-primary)' }}>${(lk.total_holding_cost || 0).toLocaleString()}</strong></p>
              <p>Stockout Cost: <strong style={{ color: '#ef4444' }}>${(lk.total_stockout_cost || 0).toLocaleString()}</strong></p>
            </div>
          </div>
          <div>
            <p className="font-semibold mb-2 text-orange-600">{rId.slice(-12)} (Compare)</p>
            <div className="space-y-1">
              <p>Total Demand: <strong style={{ color: 'var(--text-primary)' }}>{(rk.total_demand || 0).toLocaleString()}</strong></p>
              <p>Total Fulfilled: <strong style={{ color: 'var(--text-primary)' }}>{(rk.total_fulfilled || 0).toLocaleString()}</strong></p>
              <p>Total Stockout: <strong style={{ color: '#ef4444' }}>{(rk.total_stockout || 0).toLocaleString()}</strong></p>
              <p>Holding Cost: <strong style={{ color: 'var(--text-primary)' }}>${(rk.total_holding_cost || 0).toLocaleString()}</strong></p>
              <p>Stockout Cost: <strong style={{ color: '#ef4444' }}>${(rk.total_stockout_cost || 0).toLocaleString()}</strong></p>
            </div>
          </div>
        </div>
      </Card>

      {/* By-Material Delta Table */}
      <CollapsibleSection icon={ClipboardList} title="By-Material Delta" count={deltaRows.length} defaultOpen>
        <DataTable
          rows={deltaRows}
          columns={[
            { key: 'material_code', label: 'Material' },
            { key: 'left_fill_rate', label: 'Baseline FR', render: fmtPct },
            { key: 'right_fill_rate', label: 'Compare FR', render: fmtPct },
            {
              key: 'delta_fill_rate', label: '\u0394 FR',
              render: v => {
                const color = Math.abs(v) < 0.001 ? '' : v > 0 ? 'text-emerald-600' : 'text-red-500';
                return <span className={color}>{v > 0 ? '+' : ''}{(v * 100).toFixed(1)}%</span>;
              },
            },
            { key: 'left_cost', label: 'Baseline Cost', render: fmtCost },
            { key: 'right_cost', label: 'Compare Cost', render: fmtCost },
            {
              key: 'delta_cost', label: '\u0394 Cost',
              render: v => {
                const color = Math.abs(v) < 1 ? '' : v < 0 ? 'text-emerald-600' : 'text-red-500';
                return <span className={color}>{v > 0 ? '+' : ''}${v.toLocaleString()}</span>;
              },
            },
          ]}
          maxRows={50}
        />
      </CollapsibleSection>
    </div>
  );
}

// ══════════════════════════════════════════════
//  Handoff Panel
// ══════════════════════════════════════════════

function HandoffPanel({ datasetId, descriptor: _descriptor, navigate: _navigate, onHandoff, onExportExcel }) {
  const cards = [
    {
      icon: Upload,
      label: 'Use as Plan Dataset',
      desc: 'Load into Plan Studio as active dataset',
      action: () => onHandoff(datasetId, 'plan'),
      variant: 'primary',
    },
    {
      icon: TrendingUp,
      label: 'Run Forecast',
      desc: 'Load dataset + auto-run demand forecast',
      action: () => onHandoff(datasetId, 'forecast'),
      variant: 'secondary',
    },
    {
      icon: ShieldAlert,
      label: 'Risk Analysis',
      desc: 'Load dataset + run risk workflow',
      action: () => onHandoff(datasetId, 'risk'),
      variant: 'secondary',
    },
    {
      icon: Download,
      label: 'Export Excel',
      desc: 'Download as .xlsx for import into any module',
      action: () => onExportExcel(datasetId),
      variant: 'secondary',
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map(c => (
        <Card key={c.label} className="!p-3 cursor-pointer hover:ring-2 hover:ring-[var(--brand-500)]/30 transition-shadow" onClick={c.action}>
          <div className="flex items-center gap-2 mb-1.5">
            <c.icon className="w-4 h-4 text-[var(--brand-600)]" />
            <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{c.label}</span>
          </div>
          <p className="text-[10px] text-slate-400">{c.desc}</p>
        </Card>
      ))}
    </div>
  );
}

// ══════════════════════════════════════════════
//  Dataset Explorer (Tabbed)
// ══════════════════════════════════════════════

const EXPLORER_TABS = [
  { key: 'overview', label: 'Overview', icon: BarChart3, group: 'data' },
  { key: 'plant_sales', label: 'Plant Sales', icon: Factory, group: 'data' },
  { key: 'inventory', label: 'Stock', icon: Package, group: 'data' },
  { key: 'purchase_orders', label: 'POs', icon: Truck, group: 'supply' },
  { key: 'goods_receipts', label: 'Receipts', icon: CheckCircle, group: 'supply' },
  { key: 'quality', label: 'Quality', icon: AlertTriangle, group: 'supply' },
  { key: 'bom', label: 'BOM', icon: GitBranch, group: 'supply' },
  { key: 'forecast', label: 'Forecast Lab', icon: Zap, group: 'tools' },
  { key: 'handoff', label: 'Handoff', icon: ExternalLink, group: 'tools' },
];

function DatasetExplorer({ dataset, onDelete, onRefresh: _onRefresh, onHandoff, onExportExcel, navigate }) {
  const { descriptor, kpis, summary } = dataset;
  const [activeTab, setActiveTab] = useState('overview');
  // Overview state
  const [salesData, setSalesData] = useState(null);
  const [selectedSku, setSelectedSku] = useState('');
  const [skus, setSkus] = useState([]);
  const [masterData, setMasterData] = useState(null);
  const [loadingSection, setLoadingSection] = useState('');
  // Stock state
  const [stockData, setStockData] = useState(null);
  const [stockFilter, setStockFilter] = useState({ material: '', plant: '' });
  // PO state
  const [poData, setPoData] = useState(null);
  const [poFilter, setPoFilter] = useState({ material: '', plant: '' });
  // Goods Receipts state
  const [grData, setGrData] = useState(null);
  const [grFilter, setGrFilter] = useState({ material: '', plant: '' });
  // Quality Incidents state
  const [qiData, setQiData] = useState(null);
  const [qiFilter, setQiFilter] = useState({ material: '', plant: '' });
  // BOM state
  const [bomData, setBomData] = useState(null);
  const [bomFilter, setBomFilter] = useState('');
  // Plant sales state
  const [plantSalesData, setPlantSalesData] = useState(null);
  const [plantSalesFilter, setPlantSalesFilter] = useState({ material: '', plant: '' });

  const id = descriptor.dataset_id;

  // Load SKU list on mount
  const loadSkus = useCallback(async () => {
    if (skus.length > 0) return;
    try {
      const res = await api(`/synthetic/datasets/${id}/sales`);
      setSkus(res.available_skus || []);
      if (res.available_skus?.length > 0) setSelectedSku(res.available_skus[0]);
    } catch (err) {
      console.error(err);
    }
  }, [id, skus.length]);

  useEffect(() => { loadSkus(); }, [loadSkus]);

  // Auto-load tab data on first visit
  useEffect(() => {
    if (activeTab === 'inventory' && !stockData && loadingSection !== 'stock') loadStock();
    if (activeTab === 'purchase_orders' && !poData && loadingSection !== 'po') loadPOs();
    if (activeTab === 'goods_receipts' && !grData && loadingSection !== 'gr') loadGoodsReceipts();
    if (activeTab === 'quality' && !qiData && loadingSection !== 'qi') loadQualityIncidents();
    if (activeTab === 'bom' && !bomData && loadingSection !== 'bom') loadBom();
  }, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadSales = useCallback(async (sku) => {
    if (!sku) return;
    setLoadingSection('sales');
    try {
      const res = await api(`/synthetic/datasets/${id}/sales?material_code=${sku}&days=365`);
      setSalesData(res.records || []);
    } catch (err) { console.error(err); }
    finally { setLoadingSection(''); }
  }, [id]);

  const loadMasterData = useCallback(async () => {
    if (masterData) return;
    setLoadingSection('master');
    try {
      const res = await api(`/synthetic/datasets/${id}/master-data`);
      setMasterData(res);
    } catch (err) { console.error(err); }
    finally { setLoadingSection(''); }
  }, [id, masterData]);

  const loadStock = useCallback(async () => {
    setLoadingSection('stock');
    try {
      const params = new URLSearchParams();
      if (stockFilter.material) params.set('material_code', stockFilter.material);
      if (stockFilter.plant) params.set('plant_id', stockFilter.plant);
      const qs = params.toString();
      const res = await api(`/synthetic/datasets/${id}/stock${qs ? `?${qs}` : ''}`);
      setStockData(res);
    } catch (err) { console.error(err); }
    finally { setLoadingSection(''); }
  }, [id, stockFilter]);

  const loadPOs = useCallback(async () => {
    setLoadingSection('po');
    try {
      const params = new URLSearchParams();
      if (poFilter.material) params.set('material_code', poFilter.material);
      if (poFilter.plant) params.set('plant_id', poFilter.plant);
      const qs = params.toString();
      const res = await api(`/synthetic/datasets/${id}/purchase-orders${qs ? `?${qs}` : ''}`);
      setPoData(res);
    } catch (err) { console.error(err); }
    finally { setLoadingSection(''); }
  }, [id, poFilter]);

  const loadGoodsReceipts = useCallback(async () => {
    setLoadingSection('gr');
    try {
      const params = new URLSearchParams();
      if (grFilter.material) params.set('material_code', grFilter.material);
      if (grFilter.plant) params.set('plant_id', grFilter.plant);
      const qs = params.toString();
      const res = await api(`/synthetic/datasets/${id}/goods-receipts${qs ? `?${qs}` : ''}`);
      setGrData(res);
    } catch (err) { console.error(err); }
    finally { setLoadingSection(''); }
  }, [id, grFilter]);

  const loadQualityIncidents = useCallback(async () => {
    setLoadingSection('qi');
    try {
      const params = new URLSearchParams();
      if (qiFilter.material) params.set('material_code', qiFilter.material);
      if (qiFilter.plant) params.set('plant_id', qiFilter.plant);
      const qs = params.toString();
      const res = await api(`/synthetic/datasets/${id}/quality-incidents${qs ? `?${qs}` : ''}`);
      setQiData(res);
    } catch (err) { console.error(err); }
    finally { setLoadingSection(''); }
  }, [id, qiFilter]);

  const loadBom = useCallback(async () => {
    setLoadingSection('bom');
    try {
      const qs = bomFilter ? `?parent_material=${bomFilter}` : '';
      const res = await api(`/synthetic/datasets/${id}/bom${qs}`);
      setBomData(res);
    } catch (err) { console.error(err); }
    finally { setLoadingSection(''); }
  }, [id, bomFilter]);

  const loadPlantSales = useCallback(async () => {
    if (!plantSalesFilter.material) return;
    setLoadingSection('plant_sales');
    try {
      const params = new URLSearchParams({ material_code: plantSalesFilter.material, days: '365' });
      if (plantSalesFilter.plant) params.set('plant_id', plantSalesFilter.plant);
      const res = await api(`/synthetic/datasets/${id}/sales-by-plant?${params}`);
      setPlantSalesData(res);
    } catch (err) { console.error(err); }
    finally { setLoadingSection(''); }
  }, [id, plantSalesFilter]);

  const agg = kpis?.aggregate || {};

  // Get plant IDs for filter dropdowns (from descriptor or master data)
  const plantIds = React.useMemo(() => {
    if (masterData?.plants?.data) return masterData.plants.data.map(p => p.plant_id);
    return [];
  }, [masterData]);

  return (
    <div className="space-y-4">
      {/* ── Header ── */}
      <Card>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-[var(--accent-active)]">
              <Database className="w-5 h-5 text-[var(--brand-600)]" />
            </div>
            <div>
              <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{id}</p>
              <p className="text-[10px] text-slate-400">
                seed={descriptor.seed} | {descriptor.n_materials} materials | {descriptor.n_plants} plants | {descriptor.n_days} days
                {descriptor.disruptions?.length > 0 && ` | scenarios: ${descriptor.disruptions.join(', ')}`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge type={descriptor.disruptions?.length > 0 ? 'warning' : 'success'}>
              {descriptor.disruptions?.length > 0 ? 'Disrupted' : 'Baseline'}
            </Badge>
            <Button variant="ghost" icon={Trash2} onClick={() => onDelete(id)} className="!text-red-500">
              Delete
            </Button>
          </div>
        </div>
      </Card>

      {/* ── Tab Bar ── */}
      <TabBar tabs={EXPLORER_TABS} active={activeTab} onChange={setActiveTab} />

      {/* ── Overview Tab ── */}
      {activeTab === 'overview' && (
        <>
          {/* KPI Tiles */}
          {agg.fill_rate != null && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MetricTile icon={TrendingUp} label="Fill Rate" value={`${(agg.fill_rate * 100).toFixed(1)}%`} sub={agg.fill_rate >= 0.95 ? 'Target met' : 'Below 95% target'} accent={agg.fill_rate >= 0.95 ? 'text-emerald-600' : 'text-amber-600'} />
              <MetricTile icon={AlertTriangle} label="Stockout Days" value={agg.stockout_days} sub="across all SKU-plant pairs" accent={agg.stockout_days === 0 ? 'text-emerald-600' : 'text-red-600'} />
              <MetricTile icon={Package} label="Avg Inventory" value={agg.avg_inventory?.toLocaleString()} sub={`turns: ${agg.inventory_turns}`} accent="text-[var(--brand-600)]" />
              <MetricTile icon={BarChart3} label="Total Cost" value={`$${(agg.total_cost || 0).toLocaleString()}`} sub={`holding: $${(agg.holding_cost || 0).toLocaleString()}`} accent="text-[var(--brand-600)]" />
            </div>
          )}
          {kpis?.time_series && <KpiChart data={kpis.time_series} title="Inventory / Demand / Fill Rate Over Time" />}

          {/* Sales Data */}
          <Card>
            <SectionHeader icon={TrendingUp} title="Sales History" count={salesData?.length}>
              <div className="flex items-center gap-2">
                <select value={selectedSku} onChange={e => { setSelectedSku(e.target.value); loadSales(e.target.value); }} className={selectCls}>
                  {skus.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <Button variant="secondary" icon={RefreshCw} onClick={() => loadSales(selectedSku)} disabled={loadingSection === 'sales'} className="!text-xs !px-2 !py-1">
                  Load
                </Button>
              </div>
            </SectionHeader>
            {salesData && salesData.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={salesData.filter((_, i) => i % Math.max(1, Math.ceil(salesData.length / 180)) === 0)}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default)" />
                  <XAxis dataKey="date" tick={{ fontSize: 9 }} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
                  <Line type="monotone" dataKey="sales" stroke="rgb(99,102,241)" strokeWidth={1.5} dot={false} name="Sales" />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-xs text-slate-400 py-4 text-center">Select a SKU and click Load to see sales history</p>
            )}
          </Card>

          {/* Master Data */}
          <CollapsibleSection icon={Layers} title="Master Data" count={summary?.n_demand_pairs}>
            <div className="space-y-3">
              {!masterData ? (
                <Button variant="secondary" icon={Database} onClick={loadMasterData} disabled={loadingSection === 'master'}>
                  {loadingSection === 'master' ? 'Loading...' : 'Load Master Data'}
                </Button>
              ) : (
                <>
                  <div>
                    <p className="text-xs font-semibold mb-2 flex items-center gap-1.5" style={{ color: 'var(--text-secondary)' }}><Package className="w-3.5 h-3.5" /> Materials ({masterData.materials?.count})</p>
                    <DataTable rows={masterData.materials?.data || []} columns={[
                      { key: 'material_code', label: 'Code' }, { key: 'material_type', label: 'Type' }, { key: 'category', label: 'Category' },
                      { key: 'base_demand', label: 'Base Demand' }, { key: 'lead_time_days', label: 'Lead Time' },
                      { key: 'unit_cost', label: 'Unit Cost', render: v => `$${v}` }, { key: 'lifecycle_status', label: 'Status' },
                    ]} />
                  </div>
                  <div>
                    <p className="text-xs font-semibold mb-2 flex items-center gap-1.5" style={{ color: 'var(--text-secondary)' }}><Truck className="w-3.5 h-3.5" /> Suppliers ({masterData.suppliers?.count})</p>
                    <DataTable rows={masterData.suppliers?.data || []} columns={[
                      { key: 'supplier_id', label: 'ID' }, { key: 'name', label: 'Name' }, { key: 'country', label: 'Country' },
                      { key: 'reliability', label: 'Reliability', render: v => `${(v * 100).toFixed(0)}%` },
                      { key: 'defect_rate', label: 'Defect Rate', render: v => `${(v * 100).toFixed(1)}%` }, { key: 'base_lead_time', label: 'Lead Time' },
                    ]} />
                  </div>
                  <div>
                    <p className="text-xs font-semibold mb-2 flex items-center gap-1.5" style={{ color: 'var(--text-secondary)' }}><Factory className="w-3.5 h-3.5" /> Plants ({masterData.plants?.count})</p>
                    <DataTable rows={masterData.plants?.data || []} columns={[
                      { key: 'plant_id', label: 'ID' }, { key: 'name', label: 'Name' }, { key: 'region', label: 'Region' }, { key: 'capacity_factor', label: 'Capacity' },
                    ]} />
                  </div>
                  <div>
                    <p className="text-xs font-semibold mb-2 flex items-center gap-1.5" style={{ color: 'var(--text-secondary)' }}><GitBranch className="w-3.5 h-3.5" /> BOM Edges ({masterData.bom_edges?.count})</p>
                    <DataTable rows={masterData.bom_edges?.data || []} columns={[
                      { key: 'parent_material', label: 'Parent' }, { key: 'child_material', label: 'Child' },
                      { key: 'qty_per', label: 'Qty Per' }, { key: 'uom', label: 'UOM' },
                      { key: 'scrap_rate', label: 'Scrap %', render: v => `${(v * 100).toFixed(1)}%` },
                    ]} />
                  </div>
                </>
              )}
            </div>
          </CollapsibleSection>

          {/* By-Material KPIs */}
          {kpis?.by_material && Object.keys(kpis.by_material).length > 0 && (
            <CollapsibleSection icon={ClipboardList} title="KPIs by Material" count={Object.keys(kpis.by_material).length}>
              <DataTable
                rows={Object.entries(kpis.by_material).map(([mat, k]) => ({ material_code: mat, ...k }))}
                columns={[
                  { key: 'material_code', label: 'Material' },
                  { key: 'fill_rate', label: 'Fill Rate', render: v => `${(v * 100).toFixed(1)}%` },
                  { key: 'stockout_days', label: 'Stockout Days' },
                  { key: 'avg_inventory', label: 'Avg Inv' },
                  { key: 'inventory_turns', label: 'Turns' },
                  { key: 'total_cost', label: 'Cost', render: v => `$${v.toLocaleString()}` },
                ]}
                maxRows={50}
              />
            </CollapsibleSection>
          )}
        </>
      )}

      {/* ── Plant Sales Tab ── */}
      {activeTab === 'plant_sales' && (
        <Card>
          <SectionHeader icon={Factory} title="Plant-Level Sales" count={plantSalesData?.count} />
          <div className="flex items-end gap-3 flex-wrap mb-3">
            <label className="space-y-1">
              <span className="text-xs text-slate-500">Material (required)</span>
              <select value={plantSalesFilter.material} onChange={e => setPlantSalesFilter(p => ({ ...p, material: e.target.value }))} className={selectCls}>
                <option value="">Select SKU...</option>
                {skus.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs text-slate-500">Plant</span>
              <select value={plantSalesFilter.plant} onChange={e => setPlantSalesFilter(p => ({ ...p, plant: e.target.value }))} className={selectCls}>
                <option value="">All</option>
                {plantIds.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <Button variant="secondary" icon={RefreshCw} onClick={loadPlantSales} disabled={loadingSection === 'plant_sales' || !plantSalesFilter.material} className="!text-xs">
              {loadingSection === 'plant_sales' ? 'Loading...' : 'Load'}
            </Button>
          </div>
          {plantSalesData && plantSalesData.records?.length > 0 ? (
            <>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={plantSalesData.records.filter((_, i) => i % Math.max(1, Math.ceil(plantSalesData.records.length / 180)) === 0)}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default)" />
                  <XAxis dataKey="date" tick={{ fontSize: 9 }} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Line type="monotone" dataKey="sales" stroke="rgb(99,102,241)" strokeWidth={1.5} dot={false} name="Sales" />
                </LineChart>
              </ResponsiveContainer>
              <div className="mt-3">
                <DataTable
                  rows={plantSalesData.records.slice(-50)}
                  columns={[
                    { key: 'date', label: 'Date' },
                    { key: 'sku', label: 'Material' },
                    { key: 'plant_id', label: 'Plant' },
                    { key: 'sales', label: 'Demand', render: v => Number(v).toLocaleString() },
                  ]}
                  maxRows={50}
                />
              </div>
            </>
          ) : plantSalesData ? (
            <p className="text-xs text-slate-400 py-4 text-center">No plant-level sales data found</p>
          ) : (
            <p className="text-xs text-slate-400 py-4 text-center">Select a material and click Load to see plant-level sales</p>
          )}
        </Card>
      )}

      {/* ── Stock Snapshots Tab ── */}
      {activeTab === 'inventory' && (
        <Card>
          <SectionHeader icon={Package} title="Stock Snapshots" count={stockData?.count} />
          <div className="flex items-end gap-3 flex-wrap mb-3">
            <label className="space-y-1">
              <span className="text-xs text-slate-500">Material</span>
              <select value={stockFilter.material} onChange={e => setStockFilter(p => ({ ...p, material: e.target.value }))} className={selectCls}>
                <option value="">All</option>
                {skus.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs text-slate-500">Plant</span>
              <select value={stockFilter.plant} onChange={e => setStockFilter(p => ({ ...p, plant: e.target.value }))} className={selectCls}>
                <option value="">All</option>
                {plantIds.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <Button variant="secondary" icon={RefreshCw} onClick={loadStock} disabled={loadingSection === 'stock'} className="!text-xs">
              {loadingSection === 'stock' ? 'Loading...' : 'Load'}
            </Button>
          </div>
          {stockData ? (
            <DataTable
              rows={stockData.snapshots || []}
              columns={[
                { key: 'snapshot_at', label: 'Date' },
                { key: 'material_code', label: 'Material' },
                { key: 'plant_id', label: 'Plant' },
                { key: 'qty', label: 'Qty', render: v => Number(v).toLocaleString() },
                { key: 'uom', label: 'UOM' },
                { key: 'stock_type', label: 'Type' },
              ]}
              maxRows={200}
            />
          ) : (
            <p className="text-xs text-slate-400 py-4 text-center">{loadingSection === 'stock' ? 'Loading stock snapshots...' : 'No stock data available. Click Load to retry.'}</p>
          )}
        </Card>
      )}

      {/* ── Purchase Orders Tab ── */}
      {activeTab === 'purchase_orders' && (
        <Card>
          <SectionHeader icon={Truck} title="Purchase Orders" count={poData?.count} />
          <div className="flex items-end gap-3 flex-wrap mb-3">
            <label className="space-y-1">
              <span className="text-xs text-slate-500">Material</span>
              <select value={poFilter.material} onChange={e => setPoFilter(p => ({ ...p, material: e.target.value }))} className={selectCls}>
                <option value="">All</option>
                {skus.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs text-slate-500">Plant</span>
              <select value={poFilter.plant} onChange={e => setPoFilter(p => ({ ...p, plant: e.target.value }))} className={selectCls}>
                <option value="">All</option>
                {plantIds.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <Button variant="secondary" icon={RefreshCw} onClick={loadPOs} disabled={loadingSection === 'po'} className="!text-xs">
              {loadingSection === 'po' ? 'Loading...' : 'Load'}
            </Button>
          </div>
          {poData ? (
            <>
              <div className="flex gap-4 mb-3 text-xs">
                <span className="text-slate-500">Total POs: <strong style={{ color: 'var(--text-primary)' }}>{poData.count}</strong></span>
                {poData.purchase_orders?.length > 0 && (
                  <span className="text-slate-500">
                    Total Ordered: <strong style={{ color: 'var(--text-primary)' }}>{poData.purchase_orders.reduce((s, p) => s + (p.ordered_qty || 0), 0).toLocaleString()}</strong>
                  </span>
                )}
              </div>
              <DataTable
                rows={poData.purchase_orders || []}
                columns={[
                  { key: 'order_date', label: 'Order Date' },
                  { key: 'material_code', label: 'Material' },
                  { key: 'plant_id', label: 'Plant' },
                  { key: 'ordered_qty', label: 'Qty', render: v => Number(v).toLocaleString() },
                  { key: 'expected_receipt_date', label: 'Expected Receipt' },
                  { key: 'status', label: 'Status' },
                  { key: 'unit_cost', label: 'Unit Cost', render: v => `$${Number(v).toFixed(2)}` },
                ]}
                maxRows={200}
              />
            </>
          ) : (
            <p className="text-xs text-slate-400 py-4 text-center">{loadingSection === 'po' ? 'Loading purchase orders...' : 'No purchase order data available. Click Load to retry.'}</p>
          )}
        </Card>
      )}

      {/* ── Goods Receipts Tab ── */}
      {activeTab === 'goods_receipts' && (
        <Card>
          <SectionHeader icon={CheckCircle} title="Goods Receipts" count={grData?.count} />
          <div className="flex items-end gap-3 flex-wrap mb-3">
            <label className="space-y-1">
              <span className="text-xs text-slate-500">Material</span>
              <select value={grFilter.material} onChange={e => setGrFilter(p => ({ ...p, material: e.target.value }))} className={selectCls}>
                <option value="">All</option>
                {skus.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs text-slate-500">Plant</span>
              <select value={grFilter.plant} onChange={e => setGrFilter(p => ({ ...p, plant: e.target.value }))} className={selectCls}>
                <option value="">All</option>
                {plantIds.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <Button variant="secondary" icon={RefreshCw} onClick={loadGoodsReceipts} disabled={loadingSection === 'gr'} className="!text-xs">
              {loadingSection === 'gr' ? 'Loading...' : 'Load'}
            </Button>
          </div>
          {grData ? (
            <>
              <div className="flex gap-4 mb-3 text-xs">
                <span className="text-slate-500">Total GRs: <strong style={{ color: 'var(--text-primary)' }}>{grData.count}</strong></span>
                {grData.goods_receipts?.length > 0 && (
                  <>
                    <span className="text-slate-500">
                      Total Received: <strong style={{ color: 'var(--text-primary)' }}>{grData.goods_receipts.reduce((s, g) => s + (g.received_qty || 0), 0).toLocaleString()}</strong>
                    </span>
                    <span className="text-slate-500">
                      Total Rejected: <strong style={{ color: '#ef4444' }}>{grData.goods_receipts.reduce((s, g) => s + (g.rejected_qty || 0), 0).toLocaleString()}</strong>
                    </span>
                  </>
                )}
              </div>
              <DataTable
                rows={grData.goods_receipts || []}
                columns={[
                  { key: 'receipt_date', label: 'Receipt Date' },
                  { key: 'gr_id', label: 'GR ID' },
                  { key: 'po_id', label: 'PO ID' },
                  { key: 'material_code', label: 'Material' },
                  { key: 'plant_id', label: 'Plant' },
                  { key: 'received_qty', label: 'Received', render: v => Number(v).toLocaleString() },
                  { key: 'accepted_qty', label: 'Accepted', render: v => Number(v).toLocaleString() },
                  { key: 'rejected_qty', label: 'Rejected', render: v => v > 0 ? <span style={{color:'#ef4444'}}>{Number(v).toLocaleString()}</span> : '0' },
                  { key: 'total_value', label: 'Value', render: v => `$${Number(v).toLocaleString()}` },
                ]}
                maxRows={200}
              />
            </>
          ) : (
            <p className="text-xs text-slate-400 py-4 text-center">{loadingSection === 'gr' ? 'Loading goods receipts...' : 'No goods receipt data available. Click Load to retry.'}</p>
          )}
        </Card>
      )}

      {/* ── Quality Incidents Tab ── */}
      {activeTab === 'quality' && (
        <Card>
          <SectionHeader icon={AlertTriangle} title="Quality Incidents" count={qiData?.count} />
          <div className="flex items-end gap-3 flex-wrap mb-3">
            <label className="space-y-1">
              <span className="text-xs text-slate-500">Material</span>
              <select value={qiFilter.material} onChange={e => setQiFilter(p => ({ ...p, material: e.target.value }))} className={selectCls}>
                <option value="">All</option>
                {skus.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs text-slate-500">Plant</span>
              <select value={qiFilter.plant} onChange={e => setQiFilter(p => ({ ...p, plant: e.target.value }))} className={selectCls}>
                <option value="">All</option>
                {plantIds.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <Button variant="secondary" icon={RefreshCw} onClick={loadQualityIncidents} disabled={loadingSection === 'qi'} className="!text-xs">
              {loadingSection === 'qi' ? 'Loading...' : 'Load'}
            </Button>
          </div>
          {qiData ? (
            <>
              <div className="flex gap-4 mb-3 text-xs">
                <span className="text-slate-500">Total Incidents: <strong style={{ color: 'var(--text-primary)' }}>{qiData.count}</strong></span>
                {qiData.quality_incidents?.length > 0 && (
                  <>
                    <span className="text-slate-500">
                      Open: <strong style={{ color: '#ef4444' }}>{qiData.quality_incidents.filter(q => q.status === 'open').length}</strong>
                    </span>
                    <span className="text-slate-500">
                      Resolved: <strong style={{ color: '#22c55e' }}>{qiData.quality_incidents.filter(q => q.status === 'resolved').length}</strong>
                    </span>
                  </>
                )}
              </div>
              <DataTable
                rows={qiData.quality_incidents || []}
                columns={[
                  { key: 'incident_date', label: 'Date' },
                  { key: 'incident_id', label: 'ID' },
                  { key: 'material_code', label: 'Material' },
                  { key: 'plant_id', label: 'Plant' },
                  { key: 'severity', label: 'Severity', render: v => <Badge type={v === 'critical' || v === 'high' ? 'danger' : v === 'medium' ? 'warning' : 'info'}>{v}</Badge> },
                  { key: 'defect_rate', label: 'Defect Rate', render: v => `${(v * 100).toFixed(1)}%` },
                  { key: 'affected_qty', label: 'Affected Qty', render: v => Number(v).toLocaleString() },
                  { key: 'status', label: 'Status', render: v => <Badge type={v === 'open' ? 'danger' : 'success'}>{v}</Badge> },
                  { key: 'description', label: 'Description' },
                ]}
                maxRows={200}
              />
            </>
          ) : (
            <p className="text-xs text-slate-400 py-4 text-center">{loadingSection === 'qi' ? 'Loading quality incidents...' : 'No quality incident data available. Click Load to retry.'}</p>
          )}
        </Card>
      )}

      {/* ── BOM Explorer Tab ── */}
      {activeTab === 'bom' && (
        <Card>
          <SectionHeader icon={GitBranch} title="BOM Explorer" count={bomData?.count} />
          <div className="flex items-end gap-3 flex-wrap mb-3">
            <label className="space-y-1">
              <span className="text-xs text-slate-500">Parent Material</span>
              <select value={bomFilter} onChange={e => setBomFilter(e.target.value)} className={selectCls}>
                <option value="">All</option>
                {skus.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <Button variant="secondary" icon={RefreshCw} onClick={loadBom} disabled={loadingSection === 'bom'} className="!text-xs">
              {loadingSection === 'bom' ? 'Loading...' : 'Load'}
            </Button>
          </div>
          {bomData ? (
            <DataTable
              rows={bomData.bom_edges || []}
              columns={[
                { key: 'parent_material', label: 'Parent' },
                { key: 'child_material', label: 'Child' },
                { key: 'qty_per', label: 'Qty Per' },
                { key: 'uom', label: 'UOM' },
                { key: 'scrap_rate', label: 'Scrap %', render: v => `${(v * 100).toFixed(1)}%` },
              ]}
              maxRows={100}
            />
          ) : (
            <p className="text-xs text-slate-400 py-4 text-center">{loadingSection === 'bom' ? 'Loading BOM edges...' : 'No BOM data available. Click Load to retry.'}</p>
          )}
        </Card>
      )}

      {/* ── Forecast Lab Tab ── */}
      {activeTab === 'forecast' && (
        <ForecastLab datasetId={id} skus={skus} />
      )}

      {/* ── Handoff Tab ── */}
      {activeTab === 'handoff' && (
        <div className="space-y-4">
          <Card className="!p-4">
            <SectionHeader icon={ExternalLink} title="Handoff to Modules" />
            <p className="text-xs text-slate-400 mb-3">
              Use this synthetic dataset in other Decision Intelligence modules.
            </p>
          </Card>
          <HandoffPanel
            datasetId={id}
            descriptor={descriptor}
            navigate={navigate}
            onHandoff={onHandoff}
            onExportExcel={onExportExcel}
          />
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════
//  Main Page
// ══════════════════════════════════════════════

export default function SyntheticERPSandbox() {
  const navigate = useNavigate();
  const [datasets, setDatasets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [templateInfo, setTemplateInfo] = useState(null);
  // Compare mode
  const [compareMode, setCompareMode] = useState(false);
  const [compareLeft, setCompareLeft] = useState('');
  const [compareRight, setCompareRight] = useState('');

  const refreshList = useCallback(async () => {
    try {
      const list = await api('/synthetic/datasets');
      const details = await Promise.all(
        (list.datasets || []).map(d => api(`/synthetic/datasets/${d.dataset_id}`))
      );
      setDatasets(details);
    } catch {
      // API may not be running
    }
  }, []);

  useEffect(() => { refreshList(); }, [refreshList]);
  useEffect(() => {
    api('/synthetic/scenario-templates').then(r => setTemplateInfo(r.templates)).catch(() => {});
  }, []);

  const handleGenerate = useCallback(async (payload) => {
    setLoading(true);
    setError('');
    try {
      await api('/synthetic/generate', { method: 'POST', body: JSON.stringify(payload) });
      await refreshList();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [refreshList]);

  const handleDelete = useCallback(async (id) => {
    try {
      await api(`/synthetic/datasets/${id}`, { method: 'DELETE' });
      await refreshList();
    } catch (err) {
      setError(err.message);
    }
  }, [refreshList]);

  const handleHandoff = useCallback(async (datasetId, target) => {
    setError('');
    try {
      const exportData = await api(`/synthetic/datasets/${datasetId}/planning-export`);
      // Store in localStorage for cross-module access
      localStorage.setItem('di_synth_handoff', JSON.stringify({
        ...exportData,
        handoff_target: target,
        handoff_at: new Date().toISOString(),
      }));
      // Navigate to Plan Studio with synth data + autoRun intent
      navigate('/plan', {
        state: {
          syntheticDataset: exportData,
          autoRun: target !== 'plan' ? target : undefined,
        },
      });
    } catch (err) {
      setError(`Failed to load dataset for ${target}: ${err.message}`);
    }
  }, [navigate]);

  const handleExportExcel = useCallback(async (datasetId) => {
    setError('');
    try {
      const res = await fetch(`${ML_API}/synthetic/datasets/${datasetId}/export-excel`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `synthetic_${datasetId}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(`Export failed: ${err.message}`);
    }
  }, []);

  // ── Event trigger (Phase 2: Event-Driven Backbone) ──────────────────────
  const [eventStatus, setEventStatus] = useState(null);

  const handleTriggerEvent = useCallback(async (eventType, payload = {}) => {
    setError('');
    try {
      const result = await api('/api/v1/events/ingest', {
        method: 'POST',
        body: JSON.stringify({
          event_type: eventType,
          source_system: 'synthetic_sandbox',
          payload: {
            ...payload,
            triggered_at: new Date().toISOString(),
            sandbox: true,
          },
        }),
      });
      setEventStatus({ type: eventType, id: result.event_id, ok: true });
      setTimeout(() => setEventStatus(null), 4000);
    } catch (err) {
      setEventStatus({ type: eventType, ok: false, error: err.message });
    }
  }, []);

  const leftDataset = datasets.find(d => d.descriptor.dataset_id === compareLeft);
  const rightDataset = datasets.find(d => d.descriptor.dataset_id === compareRight);

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-8 py-6 space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Synthetic ERP Sandbox</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
            Generate SAP-like datasets for testing forecast, planning, and simulation pipelines
          </p>
        </div>
        <div className="flex items-center gap-2">
          {datasets.length >= 2 && (
            <Button
              variant={compareMode ? 'primary' : 'secondary'}
              icon={ArrowRightLeft}
              onClick={() => setCompareMode(!compareMode)}
            >
              {compareMode ? 'Exit Compare' : 'Compare'}
            </Button>
          )}
          <Button variant="secondary" icon={RefreshCw} onClick={refreshList}>
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <Card variant="alert" className="!py-3 !px-4">
          <p className="text-sm text-red-600">{error}</p>
        </Card>
      )}

      {/* Compare Mode */}
      {compareMode && datasets.length >= 2 && (
        <div className="space-y-4">
          <Card className="!p-4">
            <SectionHeader icon={ArrowRightLeft} title="Compare Datasets" />
            <div className="flex items-end gap-4 flex-wrap">
              <label className="space-y-1">
                <span className="text-xs text-slate-500">Baseline (left)</span>
                <select value={compareLeft} onChange={e => setCompareLeft(e.target.value)} className={inputCls} style={{ minWidth: 200 }}>
                  <option value="">Select dataset...</option>
                  {datasets.map(d => (
                    <option key={d.descriptor.dataset_id} value={d.descriptor.dataset_id}>
                      {d.descriptor.dataset_id} (seed={d.descriptor.seed})
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-xs text-slate-500">Compare (right)</span>
                <select value={compareRight} onChange={e => setCompareRight(e.target.value)} className={inputCls} style={{ minWidth: 200 }}>
                  <option value="">Select dataset...</option>
                  {datasets.map(d => (
                    <option key={d.descriptor.dataset_id} value={d.descriptor.dataset_id}>
                      {d.descriptor.dataset_id} (seed={d.descriptor.seed})
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </Card>
          {leftDataset && rightDataset && (
            <CompareView leftDataset={leftDataset} rightDataset={rightDataset} templateInfo={templateInfo} />
          )}
        </div>
      )}

      {/* Event Trigger Panel (Phase 2) */}
      {!compareMode && (
        <Card className="!p-4">
          <div className="flex items-center gap-2 mb-3">
            <Zap className="w-4 h-4 text-amber-500" />
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Trigger Event</h3>
            <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">Event-Driven</span>
          </div>
          <p className="text-xs mb-3" style={{ color: 'var(--text-secondary)' }}>
            Inject synthetic supply chain events into the event queue. Matched events auto-create worker tasks.
          </p>
          <div className="flex flex-wrap gap-2">
            {[
              { type: 'supplier_delay', label: 'Supplier Delay', payload: { supplier_id: 'S-DEMO-01', material_code: 'MAT-001', delay_days: 7, severity: 'high' } },
              { type: 'inventory_below_threshold', label: 'Low Inventory', payload: { material_code: 'MAT-002', plant_id: 'P001', current_doh: 3, threshold_doh: 7, severity: 'critical' } },
              { type: 'demand_spike', label: 'Demand Spike', payload: { material_code: 'MAT-003', plant_id: 'P001', spike_pct: 45, severity: 'medium' } },
              { type: 'po_overdue', label: 'PO Overdue', payload: { po_number: 'PO-DEMO-100', supplier_id: 'S-DEMO-02', overdue_days: 5, severity: 'high' } },
              { type: 'forecast_accuracy_drift', label: 'Forecast Drift', payload: { material_code: 'MAT-001', mape_current: 0.32, mape_baseline: 0.15, severity: 'medium' } },
            ].map(({ type, label, payload }) => (
              <button
                key={type}
                onClick={() => handleTriggerEvent(type, payload)}
                className="px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors hover:bg-slate-50 dark:hover:bg-slate-800"
                style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
              >
                <ShieldAlert className="w-3 h-3 inline mr-1 opacity-60" />
                {label}
              </button>
            ))}
          </div>
          {eventStatus && (
            <div className={`mt-2 text-xs px-3 py-1.5 rounded ${eventStatus.ok ? 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300' : 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300'}`}>
              {eventStatus.ok
                ? <><CheckCircle className="w-3 h-3 inline mr-1" />Event "{eventStatus.type}" queued (ID: {eventStatus.id})</>
                : <><XCircle className="w-3 h-3 inline mr-1" />Failed: {eventStatus.error}</>
              }
            </div>
          )}
        </Card>
      )}

      {/* Generator */}
      {!compareMode && <GeneratorForm onGenerate={handleGenerate} loading={loading} />}

      {/* Welcome / Quick-start */}
      {!compareMode && datasets.length === 0 && !loading && (
        <div className="space-y-4">
          <div className="text-center py-4">
            <Database className="w-10 h-10 mx-auto text-[var(--brand-500)] mb-3" />
            <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>Create Your First Dataset</h2>
            <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
              Pick a scenario below to generate synthetic ERP data instantly, or configure your own above.
            </p>
          </div>
          <QuickStartPanel onGenerate={handleGenerate} loading={loading} />
        </div>
      )}

      {!compareMode && datasets.map(ds => (
        <DatasetExplorer
          key={ds.descriptor.dataset_id}
          dataset={ds}
          onDelete={handleDelete}
          onRefresh={refreshList}
          onHandoff={handleHandoff}
          onExportExcel={handleExportExcel}
          navigate={navigate}
        />
      ))}
    </div>
  );
}
