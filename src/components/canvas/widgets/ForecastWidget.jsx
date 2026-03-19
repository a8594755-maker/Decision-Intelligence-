/**
 * ForecastWidget — Dual-mode canvas widget for forecast data.
 *
 * mode="artifact" (default): Pure props from canvas events (no internal fetching)
 * mode="live": Uses useForecastData hook for standalone page rendering with
 *              forecast run selection, material filtering, sub-tab navigation.
 *
 * Supports: forecast_series, forecast_csv, metrics
 */

import React, { useMemo, useState, memo } from 'react';
import {
  TrendingUp, BarChart3, Table2, Loader2, ChevronDown,
  Database, RefreshCw, Search, Package
} from 'lucide-react';
import {
  AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend
} from 'recharts';

// ── Shared Components ───────────────────────────────────────────────────────

function KPIPill({ label, value, unit = '' }) {
  return (
    <div className="flex flex-col items-center px-4 py-2 rounded-lg" style={{ backgroundColor: 'var(--surface-raised)' }}>
      <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
        {typeof value === 'number' ? value.toLocaleString() : value}{unit && <span className="text-xs ml-1">{unit}</span>}
      </span>
    </div>
  );
}

function ForecastChart({ series }) {
  const hasQuantiles = series.length > 0 && series[0].p10 != null;

  if (!series.length) return null;

  return (
    <div className="w-full h-64">
      <ResponsiveContainer width="100%" height="100%">
        {hasQuantiles ? (
          <AreaChart data={series} margin={{ top: 10, right: 20, left: 10, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
            <XAxis dataKey="period" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip />
            <Legend />
            <Area type="monotone" dataKey="p90" stroke="#c084fc" fill="#ede9fe" fillOpacity={0.3} name="P90" />
            <Area type="monotone" dataKey="p50" stroke="#6366f1" fill="#c7d2fe" fillOpacity={0.5} name="P50" strokeWidth={2} />
            <Area type="monotone" dataKey="p10" stroke="#818cf8" fill="#e0e7ff" fillOpacity={0.3} name="P10" />
          </AreaChart>
        ) : (
          <LineChart data={series} margin={{ top: 10, right: 20, left: 10, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
            <XAxis dataKey="period" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip />
            <Line type="monotone" dataKey="p50" stroke="#6366f1" strokeWidth={2} dot={{ r: 3 }} name="Forecast" />
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

// ── Artifact Mode (enhanced with recharts) ──────────────────────────────────

function ForecastWidgetArtifact({ data = {} }) {
  const [viewMode, setViewMode] = useState('chart');

  const series = useMemo(() => data.series || data.forecast_series || [], [data.series, data.forecast_series]);
  const metrics = data.metrics || {};
  const materialCode = data.material_code || data.sku || 'All SKUs';

  const p50Values = useMemo(() => series.map(r => r.p50 ?? r.value ?? 0), [series]);
  const totalDemand = useMemo(() => p50Values.reduce((s, v) => s + v, 0), [p50Values]);
  const avgDemand = p50Values.length ? totalDemand / p50Values.length : 0;

  // Normalize series for chart (ensure p50 field exists)
  const chartSeries = useMemo(() => series.map(r => ({
    ...r,
    p50: r.p50 ?? r.value ?? 0,
  })), [series]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--border-default)' }}>
        <div className="flex items-center gap-2">
          <TrendingUp size={18} className="text-indigo-500" />
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            Demand Forecast — {materialCode}
          </h3>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setViewMode('chart')}
            className={`p-1.5 rounded ${viewMode === 'chart' ? 'bg-indigo-100 text-indigo-600' : ''}`} title="Chart view">
            <BarChart3 size={14} />
          </button>
          <button onClick={() => setViewMode('table')}
            className={`p-1.5 rounded ${viewMode === 'table' ? 'bg-indigo-100 text-indigo-600' : ''}`} title="Table view">
            <Table2 size={14} />
          </button>
        </div>
      </div>

      {/* KPI Strip */}
      <div className="flex gap-3 px-4 py-3 overflow-x-auto">
        <KPIPill label="Horizon" value={series.length} unit="periods" />
        <KPIPill label="Avg Demand" value={Math.round(avgDemand)} />
        <KPIPill label="Total" value={Math.round(totalDemand)} />
        {metrics.mape != null && <KPIPill label="MAPE" value={`${(metrics.mape * 100).toFixed(1)}%`} />}
        {metrics.rmse != null && <KPIPill label="RMSE" value={metrics.rmse.toFixed(1)} />}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto px-4 py-2">
        {viewMode === 'chart' ? (
          <div className="flex flex-col gap-4">
            <ForecastChart series={chartSeries} />
            {/* Quantile bands summary */}
            {series.length > 0 && series[0].p10 != null && (
              <div className="p-3 rounded-lg" style={{ backgroundColor: 'var(--surface-raised)' }}>
                <span className="text-xs font-medium mb-2 block" style={{ color: 'var(--text-muted)' }}>Quantile Range (last period)</span>
                <div className="flex gap-6 text-sm">
                  <span>P10: <b>{series[series.length - 1].p10?.toLocaleString()}</b></span>
                  <span>P50: <b>{series[series.length - 1].p50?.toLocaleString()}</b></span>
                  <span>P90: <b>{series[series.length - 1].p90?.toLocaleString()}</b></span>
                </div>
              </div>
            )}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ color: 'var(--text-muted)' }}>
                <th className="pb-2 font-medium">Period</th>
                <th className="pb-2 font-medium text-right">P10</th>
                <th className="pb-2 font-medium text-right">P50</th>
                <th className="pb-2 font-medium text-right">P90</th>
              </tr>
            </thead>
            <tbody>
              {series.map((row, i) => (
                <tr key={i} className="border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                  <td className="py-1.5">{row.period || row.date || `T+${i + 1}`}</td>
                  <td className="py-1.5 text-right">{row.p10?.toLocaleString() ?? '-'}</td>
                  <td className="py-1.5 text-right font-medium">{row.p50?.toLocaleString() ?? row.value?.toLocaleString() ?? '-'}</td>
                  <td className="py-1.5 text-right">{row.p90?.toLocaleString() ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {series.length === 0 && (
          <div className="flex items-center justify-center h-40 text-sm" style={{ color: 'var(--text-muted)' }}>
            No forecast data available
          </div>
        )}
      </div>
    </div>
  );
}

// ── Live Mode (full forecast studio in widget) ──────────────────────────────

const TABS = [
  { key: 'results', label: 'Results' },
  { key: 'chart', label: 'Chart' },
  { key: 'trace', label: 'Trace' },
];

function ForecastWidgetLive({ user }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [forecastRuns, setForecastRuns] = useState([]);
  const [selectedRunId, setSelectedRunId] = useState(null);
  const [materials, setMaterials] = useState([]);
  const [selectedMaterial, setSelectedMaterial] = useState(null);
  const [componentDemands, setComponentDemands] = useState([]);
  const [traceRecords, setTraceRecords] = useState([]);
  const [activeTab, setActiveTab] = useState('results');

  // Load forecast runs
  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!user?.id) { setLoading(false); setError('Sign in to view forecast runs.'); return; }
      try {
        const { forecastRunsService } = await import('../../../services/supabaseClient');
        const runs = await forecastRunsService.listRuns(user.id, { limit: 20 });
        if (!cancelled) {
          setForecastRuns(runs || []);
          if (runs?.length) {
            setSelectedRunId(prev => prev || runs[0].id);
          }
        }
      } catch (err) {
        console.error('ForecastWidget live: failed to load runs:', err);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [user?.id]);

  // Load run data when selection changes
  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!user?.id || !selectedRunId) { setLoading(false); return; }
      setLoading(true);
      setError(null);

      try {
        const { componentDemandService, supabase } = await import('../../../services/supabaseClient');

        const result = await componentDemandService.getComponentDemandsByForecastRun(
          user.id, selectedRunId, { limit: 2000 }
        );
        const demands = result?.data || result || [];

        if (!cancelled) {
          setComponentDemands(demands);
          const mats = [...new Set(demands.map(d => d.material_code).filter(Boolean))].sort();
          setMaterials(mats);
          if (mats.length) setSelectedMaterial(prev => prev && mats.includes(prev) ? prev : mats[0]);
        }

        // Load trace
        try {
          const { data: traces } = await supabase
            .from('bom_explosion_trace').select('*')
            .eq('user_id', user.id).eq('forecast_run_id', selectedRunId)
            .order('created_at', { ascending: false }).limit(500);
          if (!cancelled) setTraceRecords(traces || []);
        } catch (_) {
          if (!cancelled) setTraceRecords([]);
        }
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to load forecast data');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [user?.id, selectedRunId]);

  // Derived series for selected material
  const seriesData = useMemo(() => {
    if (!selectedMaterial || !componentDemands.length) return [];
    return componentDemands
      .filter(d => d.material_code === selectedMaterial)
      .map(d => ({
        period: d.time_bucket,
        p50: d.quantity || d.demand_qty || 0,
        p10: d.quantity_p10 || null,
        p90: d.quantity_p90 || null,
        plant_id: d.plant_id,
      }))
      .sort((a, b) => String(a.period).localeCompare(String(b.period)));
  }, [componentDemands, selectedMaterial]);

  const metrics = useMemo(() => ({
    totalDemands: componentDemands.length,
    uniqueMaterials: materials.length,
    totalQuantity: componentDemands.reduce((s, d) => s + (d.quantity || d.demand_qty || 0), 0),
    traceCount: traceRecords.length,
  }), [componentDemands, materials, traceRecords]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--border-default)' }}>
        <div className="flex items-center gap-2">
          <TrendingUp size={18} className="text-indigo-500" />
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Component Forecast</h3>
        </div>
      </div>

      {/* Run Selector */}
      <div className="px-4 py-2 border-b flex items-center gap-2 flex-wrap" style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-raised)' }}>
        <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Run:</span>
        <select value={selectedRunId || ''} onChange={e => setSelectedRunId(e.target.value || null)}
          className="text-xs rounded px-2 py-1 border flex-1 max-w-[250px]"
          style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-base)', color: 'var(--text-primary)' }}>
          <option value="">Select a run...</option>
          {forecastRuns.map(r => (
            <option key={r.id} value={r.id}>
              {r.scenario_name || 'baseline'} — {new Date(r.created_at).toLocaleDateString()}
              {r.parameters?.time_buckets?.length ? ` (${r.parameters.time_buckets.length} buckets)` : ''}
            </option>
          ))}
        </select>

        {materials.length > 0 && (
          <>
            <span className="text-xs font-medium ml-2" style={{ color: 'var(--text-muted)' }}>Material:</span>
            <select value={selectedMaterial || ''} onChange={e => setSelectedMaterial(e.target.value)}
              className="text-xs rounded px-2 py-1 border max-w-[180px]"
              style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-base)', color: 'var(--text-primary)' }}>
              {materials.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </>
        )}
      </div>

      {/* Sub-tabs */}
      <div className="flex border-b" style={{ borderColor: 'var(--border-default)' }}>
        {TABS.map(tab => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${
              activeTab === tab.key
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* KPIs */}
      <div className="flex gap-3 px-4 py-3 overflow-x-auto">
        <KPIPill label="Materials" value={metrics.uniqueMaterials} />
        <KPIPill label="Demands" value={metrics.totalDemands} />
        <KPIPill label="Total Qty" value={Math.round(metrics.totalQuantity)} />
        <KPIPill label="Traces" value={metrics.traceCount} />
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto px-4 py-2">
        {loading ? (
          <div className="flex items-center justify-center h-40">
            <Loader2 className="w-6 h-6 animate-spin text-indigo-500" />
            <span className="ml-2 text-sm" style={{ color: 'var(--text-muted)' }}>Loading...</span>
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-40 text-sm text-red-500">{error}</div>
        ) : !selectedRunId ? (
          <div className="flex items-center justify-center h-40 text-sm" style={{ color: 'var(--text-muted)' }}>
            Select a forecast run to view results
          </div>
        ) : activeTab === 'chart' ? (
          <div className="flex flex-col gap-4">
            {seriesData.length > 0 ? (
              <>
                <h4 className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                  {selectedMaterial} — Demand Forecast
                </h4>
                <ForecastChart series={seriesData} />
              </>
            ) : (
              <div className="text-sm text-center py-8" style={{ color: 'var(--text-muted)' }}>
                No chart data for selected material
              </div>
            )}
          </div>
        ) : activeTab === 'trace' ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ color: 'var(--text-muted)' }}>
                <th className="pb-2 font-medium text-xs">Parent</th>
                <th className="pb-2 font-medium text-xs">Child</th>
                <th className="pb-2 font-medium text-xs">Plant</th>
                <th className="pb-2 font-medium text-xs text-right">Qty</th>
                <th className="pb-2 font-medium text-xs">Bucket</th>
              </tr>
            </thead>
            <tbody>
              {traceRecords.slice(0, 200).map((t, i) => (
                <tr key={i} className="border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                  <td className="py-1 text-xs">{t.parent_material || '-'}</td>
                  <td className="py-1 text-xs font-medium">{t.child_material || t.material_code || '-'}</td>
                  <td className="py-1 text-xs">{t.plant_id || '-'}</td>
                  <td className="py-1 text-xs text-right font-mono">{t.exploded_qty?.toLocaleString() ?? t.quantity?.toLocaleString() ?? '-'}</td>
                  <td className="py-1 text-xs">{t.time_bucket || '-'}</td>
                </tr>
              ))}
              {traceRecords.length === 0 && (
                <tr><td colSpan={5} className="py-8 text-center text-xs" style={{ color: 'var(--text-muted)' }}>No trace records</td></tr>
              )}
            </tbody>
          </table>
        ) : (
          /* Results tab (default) */
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ color: 'var(--text-muted)' }}>
                <th className="pb-2 font-medium text-xs">Material</th>
                <th className="pb-2 font-medium text-xs">Plant</th>
                <th className="pb-2 font-medium text-xs">Bucket</th>
                <th className="pb-2 font-medium text-xs text-right">Quantity</th>
                <th className="pb-2 font-medium text-xs">Source</th>
              </tr>
            </thead>
            <tbody>
              {componentDemands.slice(0, 200).map((d, i) => (
                <tr key={i} className="border-t hover:bg-indigo-50/20" style={{ borderColor: 'var(--border-subtle)' }}>
                  <td className="py-1 text-xs font-medium">{d.material_code || '-'}</td>
                  <td className="py-1 text-xs">{d.plant_id || '-'}</td>
                  <td className="py-1 text-xs">{d.time_bucket || '-'}</td>
                  <td className="py-1 text-xs text-right font-mono">{(d.quantity || d.demand_qty || 0).toLocaleString()}</td>
                  <td className="py-1 text-xs">{d.source || 'bom'}</td>
                </tr>
              ))}
              {componentDemands.length === 0 && (
                <tr><td colSpan={5} className="py-8 text-center text-xs" style={{ color: 'var(--text-muted)' }}>No component demands</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ── Main Export ──────────────────────────────────────────────────────────────

/**
 * @param {object} props
 * @param {'artifact'|'live'} [props.mode='artifact']
 * @param {object} [props.data] - Artifact payload (artifact mode)
 * @param {object} [props.user] - Auth user (live mode)
 */
function ForecastWidget({ mode = 'artifact', data = {}, user }) {
  if (mode === 'live') {
    return <ForecastWidgetLive user={user} />;
  }
  return <ForecastWidgetArtifact data={data} />;
}

export default memo(ForecastWidget);
