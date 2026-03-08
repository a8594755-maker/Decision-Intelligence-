/**
 * Synthetic ERP Sandbox
 *
 * Generate, explore, and compare synthetic ERP datasets.
 * Supports scenario injection, KPI visualization, and forecast integration.
 */

import React, { useState, useCallback } from 'react';
import {
  Database, Play, Trash2, ChevronDown, ChevronRight,
  Package, Factory, Truck, GitBranch, BarChart3,
  TrendingUp, AlertTriangle, RefreshCw, Layers,
  Zap, ShieldAlert, ClipboardList,
} from 'lucide-react';
import { Card, Badge, Button } from '../components/ui';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
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

// ══════════════════════════════════════════════
//  Sub-components
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
  // Sample if too many points
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
          <Tooltip
            contentStyle={{
              backgroundColor: 'var(--surface-card)',
              border: '1px solid var(--border-default)',
              borderRadius: 8,
              fontSize: 12,
            }}
          />
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

  const set = (k, v) => setCfg(prev => ({ ...prev, [k]: v }));

  const handleSubmit = (e) => {
    e.preventDefault();
    const payload = {
      seed: Number(cfg.seed),
      n_materials: Number(cfg.n_materials),
      n_plants: Number(cfg.n_plants),
      n_suppliers: Number(cfg.n_suppliers),
      days: Number(cfg.days),
      chaos_intensity: cfg.chaos_intensity,
      disruptions: cfg.scenario ? [cfg.scenario] : [],
    };
    onGenerate(payload);
  };

  const inputCls = "w-full px-3 py-1.5 rounded-lg border text-sm bg-[var(--surface-base)] border-[var(--border-default)] text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-indigo-500/40";

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
    </Card>
  );
}

// ══════════════════════════════════════════════
//  Dataset Explorer
// ══════════════════════════════════════════════

function DatasetExplorer({ dataset, onDelete, onRefresh }) {
  const { descriptor, kpis, summary } = dataset;
  const [salesData, setSalesData] = useState(null);
  const [selectedSku, setSelectedSku] = useState('');
  const [skus, setSkus] = useState([]);
  const [masterData, setMasterData] = useState(null);
  const [loadingSection, setLoadingSection] = useState('');

  const id = descriptor.dataset_id;

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

  const loadSales = useCallback(async (sku) => {
    if (!sku) return;
    setLoadingSection('sales');
    try {
      const res = await api(`/synthetic/datasets/${id}/sales?material_code=${sku}&days=365`);
      setSalesData(res.records || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingSection('');
    }
  }, [id]);

  const loadMasterData = useCallback(async () => {
    if (masterData) return;
    setLoadingSection('master');
    try {
      const res = await api(`/synthetic/datasets/${id}/master-data`);
      setMasterData(res);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingSection('');
    }
  }, [id, masterData]);

  // Load SKUs on mount
  React.useEffect(() => { loadSkus(); }, [loadSkus]);

  const agg = kpis?.aggregate || {};

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

      {/* ── KPI Tiles ── */}
      {agg.fill_rate != null && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <MetricTile
            icon={TrendingUp}
            label="Fill Rate"
            value={`${(agg.fill_rate * 100).toFixed(1)}%`}
            sub={agg.fill_rate >= 0.95 ? 'Target met' : 'Below 95% target'}
            accent={agg.fill_rate >= 0.95 ? 'text-emerald-600' : 'text-amber-600'}
          />
          <MetricTile
            icon={AlertTriangle}
            label="Stockout Days"
            value={agg.stockout_days}
            sub={`across all SKU-plant pairs`}
            accent={agg.stockout_days === 0 ? 'text-emerald-600' : 'text-red-600'}
          />
          <MetricTile
            icon={Package}
            label="Avg Inventory"
            value={agg.avg_inventory?.toLocaleString()}
            sub={`turns: ${agg.inventory_turns}`}
            accent="text-indigo-600"
          />
          <MetricTile
            icon={BarChart3}
            label="Total Cost"
            value={`$${(agg.total_cost || 0).toLocaleString()}`}
            sub={`holding: $${(agg.holding_cost || 0).toLocaleString()}`}
            accent="text-indigo-600"
          />
        </div>
      )}

      {/* ── KPI Time Series Chart ── */}
      {kpis?.time_series && (
        <KpiChart data={kpis.time_series} title="Inventory / Demand / Fill Rate Over Time" />
      )}

      {/* ── Sales Data ── */}
      <Card>
        <SectionHeader icon={TrendingUp} title="Sales History" count={salesData?.length}>
          <div className="flex items-center gap-2">
            <select
              value={selectedSku}
              onChange={e => { setSelectedSku(e.target.value); loadSales(e.target.value); }}
              className="px-2 py-1 rounded-lg border text-xs bg-[var(--surface-base)] border-[var(--border-default)] text-[var(--text-primary)]"
            >
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
              <Tooltip contentStyle={{ backgroundColor: 'var(--surface-card)', border: '1px solid var(--border-default)', borderRadius: 8, fontSize: 12 }} />
              <Line type="monotone" dataKey="sales" stroke="rgb(99,102,241)" strokeWidth={1.5} dot={false} name="Sales" />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-xs text-slate-400 py-4 text-center">Select a SKU and click Load to see sales history</p>
        )}
      </Card>

      {/* ── Master Data (collapsible) ── */}
      <CollapsibleSection icon={Layers} title="Master Data" count={summary?.n_demand_pairs}>
        <div className="space-y-3">
          {!masterData ? (
            <Button variant="secondary" icon={Database} onClick={loadMasterData} disabled={loadingSection === 'master'}>
              {loadingSection === 'master' ? 'Loading...' : 'Load Master Data'}
            </Button>
          ) : (
            <>
              {/* Materials */}
              <div>
                <p className="text-xs font-semibold mb-2 flex items-center gap-1.5" style={{ color: 'var(--text-secondary)' }}>
                  <Package className="w-3.5 h-3.5" /> Materials ({masterData.materials?.count})
                </p>
                <DataTable
                  rows={masterData.materials?.data || []}
                  columns={[
                    { key: 'material_code', label: 'Code' },
                    { key: 'material_type', label: 'Type' },
                    { key: 'category', label: 'Category' },
                    { key: 'base_demand', label: 'Base Demand' },
                    { key: 'lead_time_days', label: 'Lead Time' },
                    { key: 'unit_cost', label: 'Unit Cost', render: v => `$${v}` },
                    { key: 'lifecycle_status', label: 'Status' },
                  ]}
                />
              </div>

              {/* Suppliers */}
              <div>
                <p className="text-xs font-semibold mb-2 flex items-center gap-1.5" style={{ color: 'var(--text-secondary)' }}>
                  <Truck className="w-3.5 h-3.5" /> Suppliers ({masterData.suppliers?.count})
                </p>
                <DataTable
                  rows={masterData.suppliers?.data || []}
                  columns={[
                    { key: 'supplier_id', label: 'ID' },
                    { key: 'name', label: 'Name' },
                    { key: 'country', label: 'Country' },
                    { key: 'reliability', label: 'Reliability', render: v => `${(v * 100).toFixed(0)}%` },
                    { key: 'defect_rate', label: 'Defect Rate', render: v => `${(v * 100).toFixed(1)}%` },
                    { key: 'base_lead_time', label: 'Lead Time' },
                  ]}
                />
              </div>

              {/* Plants */}
              <div>
                <p className="text-xs font-semibold mb-2 flex items-center gap-1.5" style={{ color: 'var(--text-secondary)' }}>
                  <Factory className="w-3.5 h-3.5" /> Plants ({masterData.plants?.count})
                </p>
                <DataTable
                  rows={masterData.plants?.data || []}
                  columns={[
                    { key: 'plant_id', label: 'ID' },
                    { key: 'name', label: 'Name' },
                    { key: 'region', label: 'Region' },
                    { key: 'capacity_factor', label: 'Capacity' },
                  ]}
                />
              </div>

              {/* BOM */}
              <div>
                <p className="text-xs font-semibold mb-2 flex items-center gap-1.5" style={{ color: 'var(--text-secondary)' }}>
                  <GitBranch className="w-3.5 h-3.5" /> BOM Edges ({masterData.bom_edges?.count})
                </p>
                <DataTable
                  rows={masterData.bom_edges?.data || []}
                  columns={[
                    { key: 'parent_material', label: 'Parent' },
                    { key: 'child_material', label: 'Child' },
                    { key: 'qty_per', label: 'Qty Per' },
                    { key: 'uom', label: 'UOM' },
                    { key: 'scrap_rate', label: 'Scrap %', render: v => `${(v * 100).toFixed(1)}%` },
                  ]}
                />
              </div>
            </>
          )}
        </div>
      </CollapsibleSection>

      {/* ── By-Material KPIs ── */}
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
    </div>
  );
}

// ══════════════════════════════════════════════
//  Main Page
// ══════════════════════════════════════════════

export default function SyntheticERPSandbox() {
  const [datasets, setDatasets] = useState([]);     // [{descriptor, kpis, summary}]
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

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

  // Load existing datasets on mount
  React.useEffect(() => { refreshList(); }, [refreshList]);

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

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-8 py-6 space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Synthetic ERP Sandbox</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
            Generate SAP-like datasets for testing forecast, planning, and simulation pipelines
          </p>
        </div>
        <Button variant="secondary" icon={RefreshCw} onClick={refreshList}>
          Refresh
        </Button>
      </div>

      {error && (
        <Card variant="alert" className="!py-3 !px-4">
          <p className="text-sm text-red-600">{error}</p>
        </Card>
      )}

      {/* Generator */}
      <GeneratorForm onGenerate={handleGenerate} loading={loading} />

      {/* Dataset list */}
      {datasets.length === 0 && !loading && (
        <Card className="text-center !py-12">
          <Database className="w-10 h-10 mx-auto text-slate-300 dark:text-slate-600 mb-3" />
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>No datasets yet. Generate one above.</p>
        </Card>
      )}

      {datasets.map(ds => (
        <DatasetExplorer
          key={ds.descriptor.dataset_id}
          dataset={ds}
          onDelete={handleDelete}
          onRefresh={refreshList}
        />
      ))}
    </div>
  );
}
