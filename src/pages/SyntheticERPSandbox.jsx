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
  ArrowRightLeft, ExternalLink,
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

function MetricTile({ icon: Icon, label, value, sub, accent = 'text-indigo-600' }) {
  return (
    <Card className="!p-4">
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-lg bg-slate-100 dark:bg-slate-800">
          <Icon className={`w-5 h-5 ${accent}`} />
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

function SectionHeader({ icon: Icon, title, count, children }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-2">
        <Icon className="w-4 h-4 text-indigo-600" />
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

function CollapsibleSection({ icon: Icon, title, count, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Card>
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-2 text-left">
        {open ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
        <Icon className="w-4 h-4 text-indigo-600" />
        <span className="text-sm font-semibold flex-1" style={{ color: 'var(--text-primary)' }}>{title}</span>
        {count != null && <Badge type="info">{count}</Badge>}
      </button>
      {open && <div className="mt-4">{children}</div>}
    </Card>
  );
}

function TabBar({ tabs, active, onChange }) {
  return (
    <div className="flex gap-1 overflow-x-auto border-b" style={{ borderColor: 'var(--border-default)' }}>
      {tabs.map(t => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors border-b-2 ${
            active === t.key
              ? 'text-indigo-600 border-indigo-600'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          <t.icon className="w-3.5 h-3.5" />{t.label}
        </button>
      ))}
    </div>
  );
}

const selectCls = "px-2 py-1 rounded-lg border text-xs bg-[var(--surface-base)] border-[var(--border-default)] text-[var(--text-primary)]";
const inputCls = "w-full px-3 py-1.5 rounded-lg border text-sm bg-[var(--surface-base)] border-[var(--border-default)] text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-indigo-500/40";

// ══════════════════════════════════════════════
//  Scenario Explainer + Disruption Timeline
// ══════════════════════════════════════════════

function DisruptionTimeline({ disruptions, totalDays }) {
  if (!disruptions || disruptions.length === 0) return null;
  return (
    <div className="mt-3">
      <p className="text-[10px] text-slate-400 mb-1">Timeline (day 0 &rarr; {totalDays})</p>
      <div className="relative h-5 bg-slate-100 dark:bg-slate-800 rounded overflow-hidden">
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
        <ShieldAlert className="w-3.5 h-3.5 text-indigo-600" />
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
];

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

  useEffect(() => {
    api('/synthetic/scenario-templates').then(r => setTemplateInfo(r.templates)).catch(() => {});
  }, []);

  const set = (k, v) => setCfg(prev => ({ ...prev, [k]: v }));

  const handleSubmit = (e) => {
    e.preventDefault();
    onGenerate({
      seed: Number(cfg.seed),
      n_materials: Number(cfg.n_materials),
      n_plants: Number(cfg.n_plants),
      n_suppliers: Number(cfg.n_suppliers),
      days: Number(cfg.days),
      chaos_intensity: cfg.chaos_intensity,
      disruptions: cfg.scenario ? [cfg.scenario] : [],
    });
  };

  const selectedTemplate = cfg.scenario && templateInfo?.[cfg.scenario];

  return (
    <Card>
      <SectionHeader icon={Database} title="Generate Dataset" />
      <form onSubmit={handleSubmit} className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <label className="space-y-1">
          <span className="text-xs text-slate-500">Seed</span>
          <input type="number" value={cfg.seed} onChange={e => set('seed', e.target.value)} className={inputCls} />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-slate-500">FG Materials</span>
          <input type="number" min={1} max={50} value={cfg.n_materials} onChange={e => set('n_materials', e.target.value)} className={inputCls} />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-slate-500">Plants</span>
          <input type="number" min={1} max={10} value={cfg.n_plants} onChange={e => set('n_plants', e.target.value)} className={inputCls} />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-slate-500">Days</span>
          <input type="number" min={30} max={1095} value={cfg.days} onChange={e => set('days', e.target.value)} className={inputCls} />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-slate-500">Chaos Intensity</span>
          <select value={cfg.chaos_intensity} onChange={e => set('chaos_intensity', e.target.value)} className={inputCls}>
            {['calm', 'low', 'medium', 'high', 'extreme'].map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs text-slate-500">Scenario</span>
          <select value={cfg.scenario} onChange={e => set('scenario', e.target.value)} className={inputCls}>
            {SCENARIO_TEMPLATES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs text-slate-500">Suppliers</span>
          <input type="number" min={1} max={20} value={cfg.n_suppliers} onChange={e => set('n_suppliers', e.target.value)} className={inputCls} />
        </label>
        <div className="flex items-end">
          <Button variant="primary" icon={Play} disabled={loading} type="submit" className="w-full">
            {loading ? 'Generating...' : 'Generate'}
          </Button>
        </div>
      </form>
      {selectedTemplate && (
        <ScenarioExplainer disruptions={selectedTemplate.disruptions} totalDays={Number(cfg.days)} />
      )}
    </Card>
  );
}

// ══════════════════════════════════════════════
//  Forecast Lab
// ══════════════════════════════════════════════

function ForecastLab({ datasetId, skus }) {
  const [sku, setSku] = useState(skus[0] || '');
  const [horizon, setHorizon] = useState(30);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const runForecast = async () => {
    if (!sku) return;
    setLoading(true);
    setError('');
    try {
      const res = await api(`/synthetic/datasets/${datasetId}/forecast`, {
        method: 'POST',
        body: JSON.stringify({ material_code: sku, horizon_days: Number(horizon) }),
      });
      setResult(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Build chart data combining history tail + forecast
  const chartData = React.useMemo(() => {
    if (!result?.forecast) return null;
    const fc = result.forecast;
    const preds = fc.predictions || fc.forecast || [];
    if (preds.length === 0) return null;
    return preds.map((p, i) => ({
      idx: i + 1,
      forecast: typeof p === 'number' ? p : (p.value ?? p.yhat ?? p.predicted),
      lower: p.lower ?? p.yhat_lower ?? undefined,
      upper: p.upper ?? p.yhat_upper ?? undefined,
    }));
  }, [result]);

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
          <Button variant="primary" icon={Zap} onClick={runForecast} disabled={loading || !sku}>
            {loading ? 'Running...' : 'Run Forecast'}
          </Button>
        </div>
        {error && <p className="text-xs text-red-500 mt-2">{error}</p>}
      </Card>

      {result && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MetricTile icon={Zap} label="Model" value={modelUsed} accent="text-indigo-600" />
            <MetricTile icon={BarChart3} label="History Points" value={result.history_points} accent="text-indigo-600" />
            {metrics.mape != null && (
              <MetricTile icon={TrendingUp} label="MAPE" value={`${(metrics.mape * 100).toFixed(1)}%`} accent={metrics.mape < 0.15 ? 'text-emerald-600' : 'text-amber-600'} />
            )}
            {metrics.mae != null && (
              <MetricTile icon={AlertTriangle} label="MAE" value={metrics.mae.toFixed(1)} accent="text-indigo-600" />
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
                  {chartData[0]?.upper != null && (
                    <Area type="monotone" dataKey="upper" fill="rgba(99,102,241,0.08)" stroke="none" name="Upper" />
                  )}
                  {chartData[0]?.lower != null && (
                    <Area type="monotone" dataKey="lower" fill="rgba(99,102,241,0.08)" stroke="none" name="Lower" />
                  )}
                  <Line type="monotone" dataKey="forecast" stroke="rgb(99,102,241)" strokeWidth={2} dot={false} name="Forecast" />
                </ComposedChart>
              </ResponsiveContainer>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════
//  Compare Mode
// ══════════════════════════════════════════════

function CompareMetricTile({ icon: Icon, label, leftVal, rightVal, format = v => v, lowerIsBetter = false }) {
  const delta = rightVal - leftVal;
  const pct = leftVal !== 0 ? ((delta / Math.abs(leftVal)) * 100).toFixed(1) : '--';
  const isImprovement = lowerIsBetter ? delta < 0 : delta > 0;
  const arrowColor = Math.abs(delta) < 0.001 ? 'text-slate-400' : isImprovement ? 'text-emerald-600' : 'text-red-500';
  const arrow = delta > 0 ? '\u25B2' : delta < 0 ? '\u25BC' : '\u2014';

  return (
    <Card className="!p-4">
      <div className="flex items-center gap-2 mb-2">
        <Icon className="w-4 h-4 text-indigo-600" />
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

function CompareView({ leftDataset, rightDataset }) {
  if (!leftDataset || !rightDataset) return null;
  const lk = leftDataset.kpis?.aggregate || {};
  const rk = rightDataset.kpis?.aggregate || {};
  const lId = leftDataset.descriptor.dataset_id;
  const rId = rightDataset.descriptor.dataset_id;

  // Overlay time series
  const overlayData = React.useMemo(() => {
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

  const fmtPct = v => v != null ? `${(v * 100).toFixed(1)}%` : '--';
  const fmtCost = v => `$${(v || 0).toLocaleString()}`;

  return (
    <div className="space-y-4">
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

function HandoffPanel({ datasetId, descriptor, navigate, onUseAsDataset, onExportExcel }) {
  const cards = [
    {
      icon: Upload,
      label: 'Use as Plan Dataset',
      desc: 'Load into Plan Studio as active dataset',
      action: () => onUseAsDataset(datasetId),
      variant: 'primary',
    },
    {
      icon: Download,
      label: 'Export Excel',
      desc: 'Download as .xlsx for import into any module',
      action: () => onExportExcel(datasetId),
      variant: 'secondary',
    },
    {
      icon: TrendingUp,
      label: 'Forecast Studio',
      desc: 'Open Forecast Studio',
      action: () => navigate('/forecast'),
      variant: 'secondary',
    },
    {
      icon: ShieldAlert,
      label: 'Risk Center',
      desc: 'Open Risk Center',
      action: () => navigate('/risk'),
      variant: 'secondary',
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map(c => (
        <Card key={c.label} className="!p-3 cursor-pointer hover:ring-2 hover:ring-indigo-500/30 transition-shadow" onClick={c.action}>
          <div className="flex items-center gap-2 mb-1.5">
            <c.icon className="w-4 h-4 text-indigo-600" />
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
  { key: 'overview', label: 'Overview', icon: BarChart3 },
  { key: 'inventory', label: 'Stock Snapshots', icon: Package },
  { key: 'purchase_orders', label: 'Purchase Orders', icon: Truck },
  { key: 'bom', label: 'BOM Explorer', icon: GitBranch },
  { key: 'forecast', label: 'Forecast Lab', icon: Zap },
  { key: 'handoff', label: 'Handoff', icon: ExternalLink },
];

function DatasetExplorer({ dataset, onDelete, onRefresh, onUseAsDataset, onExportExcel, navigate }) {
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
  // BOM state
  const [bomData, setBomData] = useState(null);
  const [bomFilter, setBomFilter] = useState('');

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

  const loadBom = useCallback(async () => {
    setLoadingSection('bom');
    try {
      const qs = bomFilter ? `?parent_material=${bomFilter}` : '';
      const res = await api(`/synthetic/datasets/${id}/bom${qs}`);
      setBomData(res);
    } catch (err) { console.error(err); }
    finally { setLoadingSection(''); }
  }, [id, bomFilter]);

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
            <div className="p-2 rounded-lg bg-indigo-50 dark:bg-indigo-900/20">
              <Database className="w-5 h-5 text-indigo-600" />
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
              <MetricTile icon={Package} label="Avg Inventory" value={agg.avg_inventory?.toLocaleString()} sub={`turns: ${agg.inventory_turns}`} accent="text-indigo-600" />
              <MetricTile icon={BarChart3} label="Total Cost" value={`$${(agg.total_cost || 0).toLocaleString()}`} sub={`holding: $${(agg.holding_cost || 0).toLocaleString()}`} accent="text-indigo-600" />
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
            <p className="text-xs text-slate-400 py-4 text-center">Click Load to fetch stock snapshots</p>
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
            <p className="text-xs text-slate-400 py-4 text-center">Click Load to fetch purchase orders</p>
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
            <p className="text-xs text-slate-400 py-4 text-center">Click Load to fetch BOM edges</p>
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
            onUseAsDataset={onUseAsDataset}
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

  const handleUseAsDataset = useCallback(async (datasetId) => {
    setError('');
    try {
      const exportData = await api(`/synthetic/datasets/${datasetId}/planning-export`);
      navigate('/plan', { state: { syntheticDataset: exportData } });
    } catch (err) {
      setError(`Failed to load dataset for planning: ${err.message}`);
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
            <CompareView leftDataset={leftDataset} rightDataset={rightDataset} />
          )}
        </div>
      )}

      {/* Generator */}
      {!compareMode && <GeneratorForm onGenerate={handleGenerate} loading={loading} />}

      {/* Dataset list */}
      {!compareMode && datasets.length === 0 && !loading && (
        <Card className="text-center !py-12">
          <Database className="w-10 h-10 mx-auto text-slate-300 dark:text-slate-600 mb-3" />
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>No datasets yet. Generate one above.</p>
        </Card>
      )}

      {!compareMode && datasets.map(ds => (
        <DatasetExplorer
          key={ds.descriptor.dataset_id}
          dataset={ds}
          onDelete={handleDelete}
          onRefresh={refreshList}
          onUseAsDataset={handleUseAsDataset}
          onExportExcel={handleExportExcel}
          navigate={navigate}
        />
      ))}
    </div>
  );
}
