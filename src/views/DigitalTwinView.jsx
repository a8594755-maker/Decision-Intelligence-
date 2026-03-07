import React, { useState, useEffect, useMemo } from 'react';
import {
  Cpu, Play, Target, Zap, Package, DollarSign,
  TrendingUp, TrendingDown, AlertTriangle, Loader2, BarChart3, Layers,
  SlidersHorizontal, RotateCcw, ArrowRight,
} from 'lucide-react';
import {
  ComposedChart, LineChart, Line, Area, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, BarChart, Cell,
} from 'recharts';
import { Card, Button, Badge, Select } from '../components/ui';
import * as digitalTwinService from '../services/digitalTwinService';

// ── Constants ───────────────────────────────────────────────────────────────

const TABS = [
  { key: 'simulation', label: 'Simulation', icon: Play },
  { key: 'comparison', label: 'Strategy Comparison', icon: Layers },
  { key: 'optimizer', label: 'Parameter Optimizer', icon: Target },
  { key: 'tuner', label: 'Strategy Tuner', icon: SlidersHorizontal },
];

const CHAOS_OPTIONS = [
  { value: '', label: 'Default (scenario-defined)' },
  { value: 'calm', label: 'Calm' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'extreme', label: 'Extreme' },
];

const COST_COLORS = {
  holding_cost: '#3b82f6',
  stockout_cost: '#ef4444',
  ordering_cost: '#f59e0b',
  purchase_cost: '#8b5cf6',
};

const STRATEGY_COLORS = {
  conservative: '#3b82f6',
  balanced: '#10b981',
  aggressive: '#f59e0b',
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatCurrency(v) {
  if (v == null) return '—';
  return '$' + Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function formatPct(v) {
  if (v == null) return '—';
  return Number(v).toFixed(1) + '%';
}

function formatNum(v, digits = 1) {
  if (v == null) return '—';
  return Number(v).toFixed(digits);
}

// ── Tuner constants ─────────────────────────────────────────────────────────

const DEFAULT_TUNER_PARAMS = {
  safety_stock_factor: 1.5,
  reorder_point: 250,
  order_quantity_days: 14,
  holding_cost_per_unit_day: 0.5,
  stockout_penalty_per_unit: 15.0,
  ordering_cost_per_order: 100.0,
};

const TUNER_PARAM_CONFIG = [
  { key: 'safety_stock_factor', label: 'Safety Stock Factor', min: 0.5, max: 4.0, step: 0.1, group: 'strategy', displayFn: (v) => v.toFixed(1) },
  { key: 'reorder_point', label: 'Reorder Point', min: 50, max: 800, step: 10, group: 'strategy', displayFn: (v) => Math.round(v).toLocaleString() },
  { key: 'order_quantity_days', label: 'Order Qty (days)', min: 7, max: 42, step: 1, group: 'strategy', displayFn: (v) => `${Math.round(v)}d` },
  { key: 'holding_cost_per_unit_day', label: 'Holding Cost / unit / day', min: 0.1, max: 5.0, step: 0.1, group: 'cost', displayFn: (v) => `$${v.toFixed(2)}` },
  { key: 'stockout_penalty_per_unit', label: 'Stockout Penalty / unit', min: 1, max: 50, step: 1, group: 'cost', displayFn: (v) => `$${v.toFixed(0)}` },
  { key: 'ordering_cost_per_order', label: 'Ordering Cost / order', min: 10, max: 500, step: 10, group: 'cost', displayFn: (v) => `$${v.toFixed(0)}` },
];

// ── Sub-components ──────────────────────────────────────────────────────────

function KpiCard({ label, value, icon: Icon, color = 'text-blue-600 dark:text-blue-400' }) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
          <div className="text-xl font-bold mt-1 text-slate-900 dark:text-slate-100">{value}</div>
        </div>
        {Icon && <Icon className={`w-5 h-5 ${color}`} />}
      </div>
    </Card>
  );
}

function TabBar({ active, onChange }) {
  return (
    <div className="flex gap-1 bg-slate-100 dark:bg-slate-800 rounded-lg p-1">
      {TABS.map((tab) => {
        const Icon = tab.icon;
        const isActive = active === tab.key;
        return (
          <button
            key={tab.key}
            onClick={() => onChange(tab.key)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              isActive
                ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-400 shadow-sm'
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
            }`}
          >
            <Icon className="w-4 h-4" />
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

function ErrorBanner({ error }) {
  if (!error) return null;
  return (
    <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-700 dark:text-red-300 flex items-start gap-2">
      <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
      <span>{error}</span>
    </div>
  );
}

function TunerSliderRow({ label, min, max, step, value, onChange, displayFn, onSweep, sweepLoading }) {
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1">
        <label className="text-xs font-medium text-slate-700 dark:text-slate-300">{label}</label>
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-blue-600 dark:text-blue-400 min-w-[48px] text-right">
            {displayFn ? displayFn(value) : String(value)}
          </span>
          {onSweep && (
            <button type="button" onClick={onSweep} disabled={sweepLoading}
              className="text-slate-400 hover:text-blue-500 dark:hover:text-blue-400 disabled:opacity-40"
              title="Run sensitivity sweep">
              {sweepLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <BarChart3 className="w-3 h-3" />}
            </button>
          )}
        </div>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-1.5 appearance-none rounded-full bg-slate-200 dark:bg-slate-700 accent-blue-600 cursor-pointer"
      />
      <div className="flex justify-between text-[10px] text-slate-400 mt-0.5">
        <span>{displayFn ? displayFn(min) : min}</span>
        <span>{displayFn ? displayFn(max) : max}</span>
      </div>
    </div>
  );
}

function DeltaKpiCard({ label, baseline, custom, formatFn, goodDirection = 'up' }) {
  const delta = (custom != null && baseline != null) ? custom - baseline : null;
  const isGood = delta != null ? (goodDirection === 'up' ? delta > 0 : delta < 0) : null;
  const deltaColor = isGood === null ? 'text-slate-400'
    : isGood ? 'text-emerald-600 dark:text-emerald-400'
    : 'text-red-500 dark:text-red-400';
  const DeltaIcon = delta != null ? (delta > 0 ? TrendingUp : delta < 0 ? TrendingDown : null) : null;

  return (
    <Card className="p-3">
      <div className="text-xs text-slate-500 dark:text-slate-400 mb-2">{label}</div>
      <div className="grid grid-cols-2 gap-2 text-center">
        <div>
          <div className="text-[10px] text-slate-400 uppercase">Baseline</div>
          <div className="text-sm font-semibold text-slate-700 dark:text-slate-200">{formatFn(baseline)}</div>
        </div>
        <div>
          <div className="text-[10px] text-slate-400 uppercase">Custom</div>
          <div className="text-sm font-semibold text-slate-700 dark:text-slate-200">{formatFn(custom)}</div>
        </div>
      </div>
      {delta != null && (
        <div className={`text-xs font-medium mt-2 text-center flex items-center justify-center gap-0.5 ${deltaColor}`}>
          {DeltaIcon && <DeltaIcon className="w-3 h-3" />}
          {delta > 0 ? '+' : ''}{formatFn(delta)}
        </div>
      )}
    </Card>
  );
}

// ── Simulation Tab ──────────────────────────────────────────────────────────

function SimulationTab({ scenarios, addNotification }) {
  const [scenario, setScenario] = useState('normal');
  const [chaosIntensity, setChaosIntensity] = useState('');
  const [seed, setSeed] = useState(42);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [reoptLoading, setReoptLoading] = useState(false);
  const [reoptResult, setReoptResult] = useState(null);

  const handleRun = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await digitalTwinService.runSimulation({
        scenario,
        seed,
        chaosIntensity: chaosIntensity || undefined,
      });
      if (!res.success) throw new Error(res.error || 'Simulation failed');
      setResult(res);
      setReoptResult(null); // reset on new sim
    } catch (err) {
      setError(err.message);
      addNotification?.(`Simulation failed: ${err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleReoptimize = async () => {
    if (!result) return;
    setReoptLoading(true);
    try {
      const res = await digitalTwinService.runReoptimization({ simResult: result });
      setReoptResult(res);
    } catch (err) {
      addNotification?.(`Re-optimization analysis failed: ${err.message}`, 'error');
    } finally {
      setReoptLoading(false);
    }
  };

  const kpis = result?.kpis || {};
  const timeline = result?.timeline_sample || [];
  const chaosSummary = result?.chaos_summary || {};

  const costData = useMemo(() => {
    const cb = result?.cost_breakdown || {};
    return Object.entries(cb)
      .filter(([k]) => k !== 'total')
      .map(([key, val]) => ({ name: key.replace(/_/g, ' '), value: Number(val) || 0, key }));
  }, [result]);

  const scenarioOptions = useMemo(() => {
    if (!scenarios?.length) return [
      { value: 'normal', label: 'Normal' },
      { value: 'volatile', label: 'Volatile' },
      { value: 'disaster', label: 'Disaster' },
      { value: 'seasonal', label: 'Seasonal' },
    ];
    return scenarios.map((s) => ({ value: s.name, label: s.name.charAt(0).toUpperCase() + s.name.slice(1) }));
  }, [scenarios]);

  return (
    <div className="space-y-6">
      {/* Controls */}
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex-1 min-w-[140px]">
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Scenario</label>
            <select
              value={scenario}
              onChange={(e) => setScenario(e.target.value)}
              className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
            >
              {scenarioOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="min-w-[140px]">
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Chaos Intensity</label>
            <select
              value={chaosIntensity}
              onChange={(e) => setChaosIntensity(e.target.value)}
              className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
            >
              {CHAOS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="w-20">
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Seed</label>
            <input
              type="number"
              value={seed}
              onChange={(e) => setSeed(Number(e.target.value))}
              className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
            />
          </div>
          <Button onClick={handleRun} disabled={loading}>
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {loading ? 'Running...' : 'Run Simulation'}
          </Button>
        </div>
      </Card>

      <ErrorBanner error={error} />

      {result && (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <KpiCard label="Fill Rate" value={formatPct(kpis.fill_rate_pct)} icon={Target} color="text-emerald-600 dark:text-emerald-400" />
            <KpiCard label="Total Cost" value={formatCurrency(kpis.total_cost)} icon={DollarSign} color="text-red-500 dark:text-red-400" />
            <KpiCard label="Avg Inventory" value={formatNum(kpis.avg_inventory, 0)} icon={Package} color="text-blue-600 dark:text-blue-400" />
            <KpiCard label="Inventory Turns" value={formatNum(kpis.inventory_turns)} icon={TrendingUp} color="text-purple-600 dark:text-purple-400" />
            <KpiCard label="Stockout Days" value={kpis.stockout_days ?? '—'} icon={AlertTriangle} color="text-amber-500 dark:text-amber-400" />
          </div>

          {/* Timeline Chart */}
          {timeline.length > 0 && (
            <Card className="p-4">
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-3">Inventory & Demand Timeline</h3>
              <ResponsiveContainer width="100%" height={360}>
                <ComposedChart data={timeline}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="inventory" stroke="#2563eb" strokeWidth={2} dot={false} name="Inventory" />
                  <Line type="monotone" dataKey="demand" stroke="#ef4444" strokeWidth={1.5} strokeDasharray="5 3" dot={false} name="Demand" />
                  {timeline.some((d) => d.stockout_qty > 0) && (
                    <Area type="monotone" dataKey="stockout_qty" fill="#f59e0b" fillOpacity={0.3} stroke="#f59e0b" strokeWidth={1} name="Stockout" />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            </Card>
          )}

          {/* Cost Breakdown + Chaos Summary */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {costData.length > 0 && (
              <Card className="p-4">
                <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-3">Cost Breakdown</h3>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={costData} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={100} />
                    <Tooltip formatter={(v) => formatCurrency(v)} />
                    <Bar dataKey="value" name="Cost">
                      {costData.map((entry) => (
                        <Cell key={entry.key} fill={COST_COLORS[entry.key] || '#94a3b8'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </Card>
            )}

            <Card className="p-4">
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-3">Chaos Events Summary</h3>
              {Object.keys(chaosSummary).length > 0 ? (
                <div className="space-y-2">
                  {Object.entries(chaosSummary).map(([key, val]) => (
                    <div key={key} className="flex items-center justify-between text-sm">
                      <span className="text-slate-600 dark:text-slate-400 capitalize">{key.replace(/_/g, ' ')}</span>
                      <Badge type={typeof val === 'number' && val > 5 ? 'warning' : 'info'}>
                        {typeof val === 'object' ? JSON.stringify(val) : String(val)}
                      </Badge>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-slate-400">No chaos events recorded.</p>
              )}
            </Card>
          </div>

          {/* Re-Optimization Feedback (Phase 3 – P3.6) */}
          <Card className="p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">Re-Optimization Feedback</h3>
              <Button size="sm" variant="outline" onClick={handleReoptimize} disabled={reoptLoading}>
                {reoptLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                {reoptLoading ? 'Analyzing...' : 'Analyze for Re-optimization'}
              </Button>
            </div>
            {reoptResult && (
              <div className="space-y-3">
                <div className={`rounded-md px-3 py-2 text-sm ${reoptResult.should_reoptimize ? 'bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300' : 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-800 dark:text-emerald-300'}`}>
                  {reoptResult.summary}
                </div>
                {reoptResult.adjustments?.length > 0 && (
                  <div className="space-y-1">
                    {reoptResult.adjustments.map((adj, i) => (
                      <div key={i} className="flex items-center justify-between text-xs bg-slate-50 dark:bg-slate-800/50 rounded px-3 py-1.5">
                        <span className="text-slate-600 dark:text-slate-400">{adj.type.replace(/_/g, ' ')}</span>
                        <span className="text-slate-500 dark:text-slate-400">{adj.reason}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {!reoptResult && (
              <p className="text-xs text-slate-400">Run analysis to check if simulation results suggest constraint tightening for the solver.</p>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

// ── Comparison Tab ──────────────────────────────────────────────────────────

function ComparisonTab({ scenarios, addNotification }) {
  const [scenario, setScenario] = useState('normal');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const handleRun = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await digitalTwinService.runComparison({ scenario });
      if (!res.success) throw new Error(res.error || 'Comparison failed');
      setResult(res);
    } catch (err) {
      setError(err.message);
      addNotification?.(`Comparison failed: ${err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  const strategies = result?.strategies || {};
  const ranking = result?.ranking || [];
  const recommendation = result?.recommendation || '';

  const scenarioOptions = useMemo(() => {
    if (!scenarios?.length) return [
      { value: 'normal', label: 'Normal' },
      { value: 'volatile', label: 'Volatile' },
      { value: 'disaster', label: 'Disaster' },
      { value: 'seasonal', label: 'Seasonal' },
    ];
    return scenarios.map((s) => ({ value: s.name, label: s.name.charAt(0).toUpperCase() + s.name.slice(1) }));
  }, [scenarios]);

  return (
    <div className="space-y-6">
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex-1 min-w-[140px]">
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Scenario</label>
            <select
              value={scenario}
              onChange={(e) => setScenario(e.target.value)}
              className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
            >
              {scenarioOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <Button onClick={handleRun} disabled={loading}>
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Layers className="w-4 h-4" />}
            {loading ? 'Comparing...' : 'Compare Strategies'}
          </Button>
        </div>
      </Card>

      <ErrorBanner error={error} />

      {Object.keys(strategies).length > 0 && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {Object.entries(strategies).map(([name, data]) => {
              const kpis = data?.kpis || data || {};
              const isTop = ranking.length > 0 && ranking[0] === name;
              return (
                <Card key={name} className={`p-4 ${isTop ? 'ring-2 ring-emerald-400 dark:ring-emerald-600' : ''}`}>
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-sm font-semibold capitalize text-slate-700 dark:text-slate-300">{name}</h4>
                    {isTop && <Badge type="success">Best</Badge>}
                  </div>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-slate-500 dark:text-slate-400">Fill Rate</span>
                      <span className="font-medium">{formatPct(kpis.fill_rate_pct ?? (kpis.fill_rate != null ? kpis.fill_rate * 100 : null))}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500 dark:text-slate-400">Total Cost</span>
                      <span className="font-medium">{formatCurrency(kpis.total_cost)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500 dark:text-slate-400">Avg Inventory</span>
                      <span className="font-medium">{formatNum(kpis.avg_inventory, 0)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500 dark:text-slate-400">Stockout Days</span>
                      <span className="font-medium">{kpis.stockout_days ?? '—'}</span>
                    </div>
                  </div>
                  {/* Mini timeline */}
                  {data?.timeline_sample?.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-slate-200 dark:border-slate-700">
                      <ResponsiveContainer width="100%" height={100}>
                        <LineChart data={data.timeline_sample}>
                          <XAxis dataKey="date" hide />
                          <YAxis hide />
                          <Line type="monotone" dataKey="inventory" stroke={STRATEGY_COLORS[name] || '#6b7280'} strokeWidth={1.5} dot={false} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>

          {recommendation && (
            <Card className="p-4 bg-emerald-50/50 dark:bg-emerald-900/10 border-emerald-200 dark:border-emerald-800">
              <div className="flex items-start gap-2">
                <Zap className="w-4 h-4 text-emerald-600 dark:text-emerald-400 mt-0.5" />
                <div>
                  <h4 className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">Recommendation</h4>
                  <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">{recommendation}</p>
                </div>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

// ── Optimizer Tab ───────────────────────────────────────────────────────────

function OptimizerTab({ scenarios, addNotification, onResultReady }) {
  const [scenario, setScenario] = useState('normal');
  const [minFillRate, setMinFillRate] = useState(0.95);
  const [nTrials, setNTrials] = useState(30);
  const [method, setMethod] = useState('random');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const handleRun = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await digitalTwinService.runOptimization({
        scenario,
        nTrials,
        method,
        minFillRate,
      });
      if (!res.success) throw new Error(res.error || 'Optimization failed');
      setResult(res);
      onResultReady?.(res);
    } catch (err) {
      setError(err.message);
      addNotification?.(`Optimization failed: ${err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  const bestParams = result?.best_params || {};
  const topTrials = result?.top_5_trials || [];

  const scenarioOptions = useMemo(() => {
    if (!scenarios?.length) return [
      { value: 'normal', label: 'Normal' },
      { value: 'volatile', label: 'Volatile' },
      { value: 'disaster', label: 'Disaster' },
      { value: 'seasonal', label: 'Seasonal' },
    ];
    return scenarios.map((s) => ({ value: s.name, label: s.name.charAt(0).toUpperCase() + s.name.slice(1) }));
  }, [scenarios]);

  return (
    <div className="space-y-6">
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex-1 min-w-[140px]">
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Scenario</label>
            <select
              value={scenario}
              onChange={(e) => setScenario(e.target.value)}
              className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
            >
              {scenarioOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="w-36">
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
              Min Fill Rate: {(minFillRate * 100).toFixed(0)}%
            </label>
            <input
              type="range"
              min="0.85"
              max="0.99"
              step="0.01"
              value={minFillRate}
              onChange={(e) => setMinFillRate(Number(e.target.value))}
              className="w-full"
            />
          </div>
          <div className="w-20">
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Trials</label>
            <input
              type="number"
              value={nTrials}
              min={5}
              max={200}
              onChange={(e) => setNTrials(Number(e.target.value))}
              className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
            />
          </div>
          <div className="min-w-[100px]">
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Method</label>
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
            >
              <option value="random">Random</option>
              <option value="grid">Grid</option>
            </select>
          </div>
          <Button onClick={handleRun} disabled={loading}>
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Target className="w-4 h-4" />}
            {loading ? 'Optimizing...' : 'Run Optimizer'}
          </Button>
        </div>
      </Card>

      <ErrorBanner error={error} />

      {result && (
        <>
          {/* Best params */}
          <Card className="p-4 bg-blue-50/50 dark:bg-blue-900/10 border-blue-200 dark:border-blue-800">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-blue-700 dark:text-blue-300 flex items-center gap-2">
                <Zap className="w-4 h-4" /> Best Parameters Found
              </h3>
              <button onClick={() => onResultReady?.(result)}
                className="flex items-center gap-1 text-xs px-2 py-1 rounded-md text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-800/30 transition-colors"
                title="Load these params into the Strategy Tuner tab">
                <ArrowRight className="w-3 h-3" /> Apply to Tuner
              </button>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {Object.entries(bestParams).map(([key, val]) => (
                <div key={key}>
                  <div className="text-xs text-slate-500 dark:text-slate-400">{key.replace(/_/g, ' ')}</div>
                  <div className="text-lg font-bold text-slate-900 dark:text-slate-100">{formatNum(val, 2)}</div>
                </div>
              ))}
              <div>
                <div className="text-xs text-slate-500 dark:text-slate-400">Best Cost</div>
                <div className="text-lg font-bold text-slate-900 dark:text-slate-100">{formatCurrency(result.best_cost)}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500 dark:text-slate-400">Best Fill Rate</div>
                <div className="text-lg font-bold text-slate-900 dark:text-slate-100">{formatPct(result.best_fill_rate != null ? result.best_fill_rate * 100 : null)}</div>
              </div>
            </div>
          </Card>

          {/* Top trials */}
          {topTrials.length > 0 && (
            <Card className="p-4">
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-3">Top Trials</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-700 text-left">
                      <th className="pb-2 text-slate-500 dark:text-slate-400 font-medium">#</th>
                      <th className="pb-2 text-slate-500 dark:text-slate-400 font-medium">Safety Stock Factor</th>
                      <th className="pb-2 text-slate-500 dark:text-slate-400 font-medium">Reorder Pt Ratio</th>
                      <th className="pb-2 text-slate-500 dark:text-slate-400 font-medium">Order Qty Days</th>
                      <th className="pb-2 text-slate-500 dark:text-slate-400 font-medium">Cost</th>
                      <th className="pb-2 text-slate-500 dark:text-slate-400 font-medium">Fill Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topTrials.map((trial, i) => {
                      const params = trial.params || trial;
                      return (
                        <tr key={i} className="border-b border-slate-100 dark:border-slate-800">
                          <td className="py-2 text-slate-600 dark:text-slate-400">{i + 1}</td>
                          <td className="py-2">{formatNum(params.safety_stock_factor, 2)}</td>
                          <td className="py-2">{formatNum(params.reorder_point_ratio, 2)}</td>
                          <td className="py-2">{formatNum(params.order_quantity_days, 0)}</td>
                          <td className="py-2">{formatCurrency(trial.cost ?? trial.total_cost)}</td>
                          <td className="py-2">
                            <Badge type={(trial.fill_rate ?? 0) >= minFillRate ? 'success' : 'warning'}>
                              {formatPct((trial.fill_rate ?? 0) * 100)}
                            </Badge>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

// ── Strategy Tuner Tab ──────────────────────────────────────────────────────

function StrategyTunerTab({ scenarios, addNotification, optimizerResult }) {
  const [scenario, setScenario] = useState('normal');
  const [params, setParams] = useState({ ...DEFAULT_TUNER_PARAMS });
  const [strategyName, setStrategyName] = useState('custom');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [sensitivityParam, setSensitivityParam] = useState(null);
  const [sensitivityData, setSensitivityData] = useState([]);
  const [sensitivityLoading, setSensitivityLoading] = useState(false);

  const scenarioOptions = useMemo(() => {
    if (!scenarios?.length) return [
      { value: 'normal', label: 'Normal' },
      { value: 'volatile', label: 'Volatile' },
      { value: 'disaster', label: 'Disaster' },
      { value: 'seasonal', label: 'Seasonal' },
    ];
    return scenarios.map((s) => ({ value: s.name, label: s.name.charAt(0).toUpperCase() + s.name.slice(1) }));
  }, [scenarios]);

  const handleLoadFromOptimizer = () => {
    if (!optimizerResult?.best_params) return;
    const bp = optimizerResult.best_params;
    setParams((prev) => ({
      ...prev,
      safety_stock_factor: bp.safety_stock_factor ?? prev.safety_stock_factor,
      reorder_point: bp.reorder_point ?? (bp.reorder_point_ratio != null ? Math.round(bp.reorder_point_ratio * 200) : prev.reorder_point),
      order_quantity_days: bp.order_quantity_days ?? prev.order_quantity_days,
    }));
    addNotification?.('Loaded optimizer best params into tuner', 'success');
  };

  const handleReset = () => setParams({ ...DEFAULT_TUNER_PARAMS });

  const handleRun = async () => {
    setLoading(true);
    setError(null);
    try {
      const strategies = {
        baseline: {
          safety_stock_factor: DEFAULT_TUNER_PARAMS.safety_stock_factor,
          reorder_point: DEFAULT_TUNER_PARAMS.reorder_point,
          order_quantity_days: DEFAULT_TUNER_PARAMS.order_quantity_days,
        },
        [strategyName]: { ...params },
      };
      const res = await digitalTwinService.runComparison({ scenario, strategies });
      if (!res.success) throw new Error(res.error || 'Tuner run failed');
      setResult(res);
    } catch (err) {
      setError(err.message);
      addNotification?.(`Tuner failed: ${err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleSensitivitySweep = async (paramKey) => {
    setSensitivityParam(paramKey);
    setSensitivityLoading(true);
    setSensitivityData([]);
    try {
      const cfg = TUNER_PARAM_CONFIG.find((p) => p.key === paramKey);
      if (!cfg) return;
      const steps = 8;
      const stepSize = (cfg.max - cfg.min) / (steps - 1);
      const strategies = {};
      for (let i = 0; i < steps; i++) {
        const val = cfg.min + i * stepSize;
        strategies[`s${i}`] = { ...params, [paramKey]: Number(val.toFixed(3)) };
      }
      const res = await digitalTwinService.runComparison({ scenario, strategies });
      if (!res.success) throw new Error(res.error);
      const data = Object.entries(res.strategies)
        .map(([name, strat]) => ({
          paramValue: strategies[name]?.[paramKey],
          fill_rate: strat.kpis?.fill_rate_pct,
          total_cost: strat.kpis?.total_cost,
          stockout_days: strat.kpis?.stockout_days,
        }))
        .filter((d) => d.paramValue != null)
        .sort((a, b) => a.paramValue - b.paramValue);
      setSensitivityData(data);
    } catch (err) {
      addNotification?.(`Sensitivity sweep failed: ${err.message}`, 'error');
    } finally {
      setSensitivityLoading(false);
    }
  };

  // Extract results
  const customResult = result?.strategies?.[strategyName];
  const baselineResult = result?.strategies?.baseline;
  const customKpis = customResult?.kpis || {};
  const baselineKpis = baselineResult?.kpis || {};

  // Merge timelines for overlay chart
  const mergedTimeline = useMemo(() => {
    const baseTl = baselineResult?.timeline_sample || [];
    const custTl = customResult?.timeline_sample || [];
    const maxLen = Math.max(baseTl.length, custTl.length);
    const merged = [];
    for (let i = 0; i < maxLen; i++) {
      merged.push({
        date: baseTl[i]?.date || custTl[i]?.date || `Day ${i * 7}`,
        baseline_inv: baseTl[i]?.inventory ?? null,
        custom_inv: custTl[i]?.inventory ?? null,
        baseline_demand: baseTl[i]?.demand ?? null,
        custom_demand: custTl[i]?.demand ?? null,
      });
    }
    return merged;
  }, [baselineResult, customResult]); // strategyName intentionally omitted -- stable label

  const sensitivityLabel = TUNER_PARAM_CONFIG.find((p) => p.key === sensitivityParam)?.label || sensitivityParam;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* LEFT: Parameter Controls */}
        <div className="lg:col-span-1">
          <Card className="p-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                <SlidersHorizontal className="w-4 h-4" /> Parameters
              </h3>
              <div className="flex gap-1">
                {optimizerResult?.best_params && (
                  <button onClick={handleLoadFromOptimizer}
                    className="flex items-center gap-1 text-xs px-2 py-1 rounded-md text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                    title="Load optimizer best params">
                    <ArrowRight className="w-3 h-3" /> Load Best
                  </button>
                )}
                <button onClick={handleReset}
                  className="p-1 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                  title="Reset to defaults">
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Strategy name */}
            <div className="mb-4">
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Strategy Name</label>
              <input type="text" value={strategyName}
                onChange={(e) => setStrategyName(e.target.value.replace(/\s+/g, '_').toLowerCase() || 'custom')}
                className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-1.5 text-sm" />
            </div>

            {/* Inventory Strategy params */}
            <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-2">Inventory Strategy</p>
            {TUNER_PARAM_CONFIG.filter((p) => p.group === 'strategy').map((cfg) => (
              <TunerSliderRow key={cfg.key} label={cfg.label}
                min={cfg.min} max={cfg.max} step={cfg.step}
                value={params[cfg.key]} displayFn={cfg.displayFn}
                onChange={(v) => setParams((prev) => ({ ...prev, [cfg.key]: v }))}
                onSweep={() => handleSensitivitySweep(cfg.key)}
                sweepLoading={sensitivityLoading && sensitivityParam === cfg.key}
              />
            ))}

            {/* Cost params */}
            <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-2 mt-4">Cost Parameters</p>
            {TUNER_PARAM_CONFIG.filter((p) => p.group === 'cost').map((cfg) => (
              <TunerSliderRow key={cfg.key} label={cfg.label}
                min={cfg.min} max={cfg.max} step={cfg.step}
                value={params[cfg.key]} displayFn={cfg.displayFn}
                onChange={(v) => setParams((prev) => ({ ...prev, [cfg.key]: v }))}
                onSweep={() => handleSensitivitySweep(cfg.key)}
                sweepLoading={sensitivityLoading && sensitivityParam === cfg.key}
              />
            ))}

            {/* Scenario + Run */}
            <div className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-700">
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Scenario</label>
              <select value={scenario} onChange={(e) => setScenario(e.target.value)}
                className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm mb-3">
                {scenarioOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <Button onClick={handleRun} disabled={loading} className="w-full">
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                {loading ? 'Running...' : 'Run With These Params'}
              </Button>
            </div>
          </Card>
        </div>

        {/* RIGHT: Results */}
        <div className="lg:col-span-2 space-y-4">
          <ErrorBanner error={error} />

          {!result && !error && (
            <Card className="p-8 text-center">
              <SlidersHorizontal className="w-10 h-10 text-slate-300 dark:text-slate-600 mx-auto mb-3" />
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Adjust parameters and click <strong>Run</strong> to compare your custom strategy against the baseline.
              </p>
              <p className="text-xs text-slate-400 dark:text-slate-500 mt-2">
                Use the <BarChart3 className="w-3 h-3 inline" /> icon next to any slider to run a sensitivity sweep.
              </p>
            </Card>
          )}

          {result && (
            <>
              {/* KPI Delta Cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <DeltaKpiCard label="Fill Rate" baseline={baselineKpis.fill_rate_pct} custom={customKpis.fill_rate_pct} formatFn={formatPct} goodDirection="up" />
                <DeltaKpiCard label="Total Cost" baseline={baselineKpis.total_cost} custom={customKpis.total_cost} formatFn={formatCurrency} goodDirection="down" />
                <DeltaKpiCard label="Avg Inventory" baseline={baselineKpis.avg_inventory} custom={customKpis.avg_inventory} formatFn={(v) => formatNum(v, 0)} goodDirection="down" />
                <DeltaKpiCard label="Stockout Days" baseline={baselineKpis.stockout_days} custom={customKpis.stockout_days} formatFn={(v) => String(v ?? '—')} goodDirection="down" />
              </div>

              {/* Timeline Overlay */}
              {mergedTimeline.length > 0 && (
                <Card className="p-4">
                  <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-3">
                    Inventory Timeline: <span className="text-blue-600 dark:text-blue-400">{strategyName}</span> vs Baseline
                  </h3>
                  <ResponsiveContainer width="100%" height={300}>
                    <ComposedChart data={mergedTimeline}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                      <XAxis dataKey="date" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                      <YAxis tick={{ fontSize: 11 }} />
                      <Tooltip />
                      <Legend />
                      <Line type="monotone" dataKey="baseline_inv" stroke="#94a3b8" strokeWidth={1.5} dot={false} name="Baseline Inventory" />
                      <Line type="monotone" dataKey="custom_inv" stroke="#2563eb" strokeWidth={2} dot={false} name={`${strategyName} Inventory`} />
                      <Line type="monotone" dataKey="baseline_demand" stroke="#fbbf24" strokeWidth={1} strokeDasharray="4 3" dot={false} name="Demand" />
                    </ComposedChart>
                  </ResponsiveContainer>
                </Card>
              )}

              {/* Cost Breakdown Comparison */}
              {(customResult?.cost_breakdown || baselineResult?.cost_breakdown) && (
                <Card className="p-4">
                  <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-3">Cost Breakdown Comparison</h3>
                  <div className="grid grid-cols-2 gap-4">
                    {['holding_cost', 'stockout_cost', 'ordering_cost', 'purchase_cost'].map((key) => {
                      const baseVal = baselineResult?.cost_breakdown?.[key] ?? 0;
                      const custVal = customResult?.cost_breakdown?.[key] ?? 0;
                      const delta = custVal - baseVal;
                      const pctChange = baseVal > 0 ? ((delta / baseVal) * 100).toFixed(1) : '—';
                      return (
                        <div key={key} className="flex items-center justify-between text-sm">
                          <span className="text-slate-600 dark:text-slate-400 capitalize">{key.replace(/_/g, ' ')}</span>
                          <div className="text-right">
                            <span className="font-medium">{formatCurrency(custVal)}</span>
                            {delta !== 0 && (
                              <span className={`text-xs ml-2 ${delta < 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                                {delta > 0 ? '+' : ''}{pctChange}%
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </Card>
              )}
            </>
          )}

          {/* Sensitivity Analysis */}
          {sensitivityData.length > 0 && (
            <Card className="p-4">
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-3">
                Sensitivity: {sensitivityLabel}
              </h3>
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={sensitivityData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="paramValue" tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="left" tick={{ fontSize: 11 }} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
                  <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} domain={[0, 100]} unit="%" />
                  <Tooltip formatter={(v, name) => name === 'Fill Rate %' ? formatPct(v) : formatCurrency(v)} />
                  <Legend />
                  <Bar yAxisId="left" dataKey="total_cost" fill="#3b82f6" fillOpacity={0.7} name="Total Cost" />
                  <Line yAxisId="right" type="monotone" dataKey="fill_rate" stroke="#10b981" strokeWidth={2} dot name="Fill Rate %" />
                </ComposedChart>
              </ResponsiveContainer>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main View ───────────────────────────────────────────────────────────────

export default function DigitalTwinView({ _user, addNotification }) {
  const [activeTab, setActiveTab] = useState('simulation');
  const [scenarios, setScenarios] = useState([]);
  const [optimizerResult, setOptimizerResult] = useState(null);

  useEffect(() => {
    digitalTwinService.fetchScenarios()
      .then((res) => setScenarios(res?.scenarios || []))
      .catch(() => {}); // silent — scenario list is optional (fallback defaults exist)
  }, []);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-7xl mx-auto px-4 md:px-6 py-6 space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-purple-100 dark:bg-purple-900/30">
              <Cpu className="w-6 h-6 text-purple-600 dark:text-purple-400" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">Digital Twin Simulator</h1>
              <p className="text-sm text-slate-500 dark:text-slate-400">Day-by-day supply chain simulation with chaos engine</p>
            </div>
          </div>
          <TabBar active={activeTab} onChange={setActiveTab} />
        </div>

        {/* Tab Content */}
        {activeTab === 'simulation' && <SimulationTab scenarios={scenarios} addNotification={addNotification} />}
        {activeTab === 'comparison' && <ComparisonTab scenarios={scenarios} addNotification={addNotification} />}
        {activeTab === 'optimizer' && <OptimizerTab scenarios={scenarios} addNotification={addNotification} onResultReady={setOptimizerResult} />}
        {activeTab === 'tuner' && <StrategyTunerTab scenarios={scenarios} addNotification={addNotification} optimizerResult={optimizerResult} />}
      </div>
    </div>
  );
}
