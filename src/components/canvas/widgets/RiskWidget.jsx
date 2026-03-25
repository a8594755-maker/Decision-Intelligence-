/**
 * RiskWidget — Dual-mode canvas widget for risk analysis.
 *
 * mode="artifact" (default): Pure props from canvas events (no internal fetching)
 * mode="live": Uses useRiskData hook for standalone page rendering with
 *              live Supabase data, coverage calc, profit-at-risk, filtering.
 *
 * Supports: risk_scores, risk_adjustments, risk_delta_summary
 */

import React, { useMemo, useState, memo } from 'react';
import {
  ShieldAlert, AlertTriangle, Filter, RefreshCw, Loader2,
  Search, LayoutGrid, List, Table2, X
} from 'lucide-react';

const RISK_COLORS = {
  critical: { bg: '#fef2f2', text: '#dc2626', border: '#fecaca' },
  high:     { bg: '#fff7ed', text: '#ea580c', border: '#fed7aa' },
  medium:   { bg: '#fefce8', text: '#ca8a04', border: '#fef08a' },
  warning:  { bg: '#fefce8', text: '#ca8a04', border: '#fef08a' },
  low:      { bg: '#f0fdf4', text: '#16a34a', border: '#bbf7d0' },
  safe:     { bg: '#f0fdf4', text: '#16a34a', border: '#bbf7d0' },
};

function RiskBadge({ level }) {
  const c = RISK_COLORS[level] || RISK_COLORS.medium;
  return (
    <span
      className="inline-flex px-2 py-0.5 rounded-full text-xs font-semibold"
      style={{ backgroundColor: c.bg, color: c.text, border: `1px solid ${c.border}` }}
    >
      {level}
    </span>
  );
}

function KPI({ label, value, variant = 'default' }) {
  const colorMap = { danger: '#dc2626', warning: '#ca8a04', success: '#16a34a', default: 'var(--text-primary)' };
  return (
    <div className="flex flex-col items-center px-4 py-2 rounded-lg" style={{ backgroundColor: 'var(--surface-raised)' }}>
      <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span className="text-lg font-bold" style={{ color: colorMap[variant] }}>{value}</span>
    </div>
  );
}

// ── Artifact Mode (original pure-props display) ─────────────────────────────

function RiskWidgetArtifact({ data = {} }) {
  const [filterLevel, setFilterLevel] = useState('all');

  const scores = useMemo(() => data.scores || data.risk_scores || data.rows || [], [data.scores, data.risk_scores, data.rows]);

  const summary = useMemo(() => {
    if (data.summary) return data.summary;
    const s = { critical: 0, high: 0, medium: 0, low: 0 };
    scores.forEach(r => {
      const lvl = r.risk_level || (r.risk_score >= 80 ? 'critical' : r.risk_score >= 60 ? 'high' : r.risk_score >= 40 ? 'medium' : 'low');
      s[lvl] = (s[lvl] || 0) + 1;
    });
    return s;
  }, [data.summary, scores]);

  const filtered = useMemo(() => {
    if (filterLevel === 'all') return scores;
    return scores.filter(r => {
      const lvl = r.risk_level || (r.risk_score >= 80 ? 'critical' : r.risk_score >= 60 ? 'high' : r.risk_score >= 40 ? 'medium' : 'low');
      return lvl === filterLevel;
    });
  }, [scores, filterLevel]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--border-default)' }}>
        <div className="flex items-center gap-2">
          <ShieldAlert size={18} className="text-red-500" />
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Risk Analysis</h3>
        </div>
        <div className="flex items-center gap-1">
          <Filter size={14} style={{ color: 'var(--text-muted)' }} />
          <select value={filterLevel} onChange={e => setFilterLevel(e.target.value)}
            className="text-xs rounded px-2 py-1 border"
            style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-base)', color: 'var(--text-primary)' }}>
            <option value="all">All Levels</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
      </div>

      <div className="flex gap-3 px-4 py-3 overflow-x-auto">
        <KPI label="Critical" value={summary.critical || 0} variant="danger" />
        <KPI label="High" value={summary.high || 0} variant="warning" />
        <KPI label="Medium" value={summary.medium || 0} variant="default" />
        <KPI label="Low" value={summary.low || 0} variant="success" />
        <KPI label="Total" value={scores.length} />
      </div>

      <div className="flex-1 overflow-auto px-4 py-2">
        {filtered.length > 0 ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ color: 'var(--text-muted)' }}>
                <th className="pb-2 font-medium">Material</th>
                <th className="pb-2 font-medium">Plant</th>
                <th className="pb-2 font-medium text-right">Score</th>
                <th className="pb-2 font-medium text-center">Level</th>
                <th className="pb-2 font-medium text-right">Days to Stockout</th>
                <th className="pb-2 font-medium text-right">On-Time Rate</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row, i) => {
                const lvl = row.risk_level || (row.risk_score >= 80 ? 'critical' : row.risk_score >= 60 ? 'high' : row.risk_score >= 40 ? 'medium' : 'low');
                return (
                  <tr key={i} className="border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                    <td className="py-1.5 font-medium">{row.material_code || row.entity_id || '-'}</td>
                    <td className="py-1.5">{row.plant_id || '-'}</td>
                    <td className="py-1.5 text-right font-mono">{row.risk_score?.toFixed?.(1) ?? '-'}</td>
                    <td className="py-1.5 text-center"><RiskBadge level={lvl} /></td>
                    <td className="py-1.5 text-right">{row.metrics?.p90_delay_days?.toFixed?.(1) ?? row.days_to_stockout ?? '-'}</td>
                    <td className="py-1.5 text-right">{row.metrics?.on_time_rate != null ? `${(row.metrics.on_time_rate * 100).toFixed(0)}%` : '-'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="flex items-center justify-center h-40 text-sm" style={{ color: 'var(--text-muted)' }}>
            No risk data available
          </div>
        )}
      </div>
    </div>
  );
}

// ── Live Mode (full risk dashboard) ─────────────────────────────────────────

function RiskWidgetLiveImpl({ user, globalDataSource }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [allRows, setAllRows] = useState([]);
  const [profitSummary, setProfitSummary] = useState({ totalProfitAtRisk: 0 });

  // Filters
  const [forecastRunsList, setForecastRunsList] = useState([]);
  const [selectedForecastRunId, setSelectedForecastRunId] = useState(null);
  const [plants, setPlants] = useState(['all']);
  const [selectedPlant, setSelectedPlant] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedRiskLevel, setSelectedRiskLevel] = useState('all');
  const [viewMode, setViewMode] = useState('table');
  const [selectedRow, setSelectedRow] = useState(null);

  // Load data
  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!user?.id) { setLoading(false); setError('Sign in to view risk data.'); return; }
      setLoading(true);
      setError(null);

      try {
        const [
          { supabase, forecastRunsService, componentDemandService },
          { calculateSupplyCoverageRiskBatch },
          { calculateInventoryRisk },
          { calculateProfitAtRiskBatch },
          { mapSupplyCoverageToUI },
          { normalizeOpenPOBatch },
          { aggregateComponentDemandToDaily, normalizeKey },
        ] = await Promise.all([
          import('../../../services/infra/supabaseClient'),
          import('../../../domains/risk/coverageCalculator.js'),
          import('../../../domains/inventory/calculator.js'),
          import('../../../domains/risk/profitAtRiskCalculator.js'),
          import('../../../components/risk/mapDomainToUI'),
          import('../../../utils/poNormalizer'),
          import('../../../utils/componentDemandAggregator'),
        ]);

        // Load forecast runs
        let runs = [];
        try {
          runs = await forecastRunsService.listRuns(user.id, { limit: 30 });
        } catch (_err) {
          // Forecast runs are optional here; fall back to the default latest-data view.
        }
        if (!cancelled) setForecastRunsList(runs || []);

        const runId = selectedForecastRunId || runs?.[0]?.id || null;

        // Component demand
        let demandAgg = {};
        if (runId) {
          try {
            const runMeta = runs.find(r => r.id === runId);
            const timeBuckets = Array.isArray(runMeta?.parameters?.time_buckets) ? runMeta.parameters.time_buckets : null;
            const dr = await componentDemandService.getComponentDemandsByForecastRun(user.id, runId, { timeBuckets: timeBuckets || undefined });
            demandAgg = aggregateComponentDemandToDaily(dr, 3, { timeBuckets, daysPerBucket: 7 });
          } catch (_err) {
            // Risk browsing still works without demand aggregation enrichment.
          }
        }

        // PO data
        let poQ = supabase.from('po_open_lines').select('*').eq('user_id', user.id);
        if (globalDataSource === 'sap') poQ = poQ.eq('source', 'sap_sync');
        else poQ = poQ.or('source.is.null,source.neq.sap_sync');
        const { data: rawPo, error: poErr } = await poQ.order('time_bucket', { ascending: true });
        if (poErr) throw new Error(`PO load failed: ${poErr.message}`);
        if (!rawPo?.length) throw new Error('EMPTY_PO_DATA');

        // Inventory
        let invQ = supabase.from('material_stock_snapshots').select('*').eq('user_id', user.id);
        if (globalDataSource === 'sap') invQ = invQ.eq('source', 'sap_sync');
        else invQ = invQ.or('source.is.null,source.neq.sap_sync');
        const { data: invData } = await invQ.order('snapshot_at', { ascending: false });
        const inventory = invData || [];

        // Safety stock
        const ssMap = {};
        try {
          const { data: isData } = await supabase.from('inventory_snapshots').select('material_code, plant_id, safety_stock, onhand_qty').eq('user_id', user.id);
          (isData || []).forEach(r => { const k = normalizeKey(r.material_code, r.plant_id); if (k && k !== '|') ssMap[k] = { safety_stock: parseFloat(r.safety_stock || 0) }; });
        } catch (_err) {
          // Safety stock is optional; default to zero when absent.
        }

        // Financials
        const { data: finData } = await supabase.from('fg_financials').select('*').eq('user_id', user.id);

        // Normalize
        const normPO = normalizeOpenPOBatch(rawPo);
        if (!normPO.length) throw new Error('PO empty after normalization');

        // Suppliers
        let suppLT = {};
        try {
          const { data: sd } = await supabase.from('suppliers').select('id, lead_time_days').eq('user_id', user.id);
          (sd || []).forEach(s => { const lt = parseFloat(s.lead_time_days); if (!isNaN(lt) && lt >= 0) suppLT[s.id] = lt; });
        } catch (_err) {
          // Supplier lead times are optional; fall back to default lead times.
        }

        const keyLT = {};
        normPO.forEach(po => {
          const k = normalizeKey(po.item, po.factory);
          if (!k || k === '|' || keyLT[k]) return;
          const sid = po.supplierId || po._raw?.supplier_id;
          const d = sid ? suppLT[sid] : undefined;
          keyLT[k] = typeof d === 'number' ? { leadTimeDays: d } : { leadTimeDays: 7 };
        });

        // Coverage risk
        const domRes = calculateSupplyCoverageRiskBatch({
          openPOs: normPO,
          inventorySnapshots: inventory.map(inv => {
            const k = normalizeKey(inv.material_code, inv.plant_id);
            return { material_code: inv.material_code, plant_id: inv.plant_id, on_hand_qty: inv.qty, safety_stock: ssMap[k]?.safety_stock || 0, snapshot_date: inv.snapshot_at };
          }),
          horizonBuckets: 3,
        });

        // Inventory risk
        domRes.forEach(row => {
          const ik = normalizeKey(row.material_code || row.item, row.plant_id || row.factory);
          const dd = demandAgg[ik]?.dailyDemand;
          if (typeof dd === 'number' && dd > 0) {
            try {
              const ir = calculateInventoryRisk({ currentStock: row.onHand ?? 0, safetyStock: row.safetyStock ?? 0, dailyDemand: dd, leadTimeDays: keyLT[ik]?.leadTimeDays || 7, demandVolatility: 0.1 });
              row.daysToStockout = ir.daysToStockout;
              row.stockoutProbability = ir.probability;
            } catch (_err) {
              // Leave inventory enrichment empty for malformed rows.
            }
          }
        });

        // Profit at risk
        const { rows: withProfit, summary: pSum } = calculateProfitAtRiskBatch({ riskRows: domRes, financials: finData || [], useFallback: true });

        // Map to UI
        const uiRows = withProfit.map(dr => { const w = []; return mapSupplyCoverageToUI(dr, w); });

        if (!cancelled) {
          setAllRows(uiRows);
          setProfitSummary(pSum);
          const uniquePlants = new Set();
          uiRows.forEach(r => { if (r.plantId) uniquePlants.add(r.plantId); });
          setPlants(['all', ...Array.from(uniquePlants).sort()]);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message === 'EMPTY_PO_DATA'
            ? { type: 'empty', message: 'No Open PO data', hint: 'Upload po_open_lines.xlsx' }
            : { type: 'error', message: err.message || 'Loading failed' });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [user?.id, selectedForecastRunId, globalDataSource]);

  // Filter rows
  const displayRows = useMemo(() => {
    let rows = [...allRows];
    if (selectedPlant !== 'all') rows = rows.filter(r => r.plantId === selectedPlant);
    if (searchTerm.trim()) {
      const t = searchTerm.toLowerCase();
      rows = rows.filter(r => (r.item || '').toLowerCase().includes(t) || (r.materialCode || '').toLowerCase().includes(t));
    }
    if (selectedRiskLevel !== 'all') rows = rows.filter(r => r.riskLevel === selectedRiskLevel);
    return rows;
  }, [allRows, selectedPlant, searchTerm, selectedRiskLevel]);

  const liveKpis = useMemo(() => {
    const c = displayRows.filter(r => r.riskLevel === 'critical').length;
    const w = displayRows.filter(r => r.riskLevel === 'warning').length;
    return { criticalCount: c, warningCount: w, shortageWithinHorizon: c + w, totalItems: displayRows.length };
  }, [displayRows]);

  const formatCurrency = (val) => {
    if (val == null || isNaN(val)) return '-';
    return `$${Number(val).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--border-default)' }}>
        <div className="flex items-center gap-2">
          <ShieldAlert size={18} className="text-red-500" />
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Supply Coverage Risk</h3>
        </div>
        <div className="flex items-center gap-2">
          {/* View mode toggle */}
          <div className="flex items-center gap-0.5 p-0.5 rounded border" style={{ borderColor: 'var(--border-default)' }}>
            {[{ icon: Table2, mode: 'table' }, { icon: LayoutGrid, mode: 'grid' }, { icon: List, mode: 'list' }].map(({ icon: Icon, mode }) => (
              <button key={mode} onClick={() => setViewMode(mode)}
                className={`p-1 rounded ${viewMode === mode ? 'bg-indigo-100 text-indigo-600' : ''}`} title={mode}>
                {React.createElement(Icon, { size: 13 })}
              </button>
            ))}
          </div>
          <button onClick={() => window.location.reload()} className="p-1.5 rounded hover:bg-gray-100" title="Refresh">
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {/* Forecast Run Selector */}
      {forecastRunsList.length > 0 && (
        <div className="px-4 py-2 border-b flex items-center gap-2" style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-raised)' }}>
          <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Forecast Run:</span>
          <select value={selectedForecastRunId || ''} onChange={e => setSelectedForecastRunId(e.target.value || null)}
            className="text-xs rounded px-2 py-1 border flex-1 max-w-xs"
            style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-base)', color: 'var(--text-primary)' }}>
            <option value="">Latest</option>
            {forecastRunsList.map(r => (
              <option key={r.id} value={r.id}>{r.scenario_name || 'baseline'} — {new Date(r.created_at).toLocaleDateString()}</option>
            ))}
          </select>
        </div>
      )}

      {/* Filter Bar */}
      <div className="px-4 py-2 border-b flex items-center gap-2 flex-wrap" style={{ borderColor: 'var(--border-default)' }}>
        <div className="relative flex-1 min-w-[120px] max-w-[200px]">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3" style={{ color: 'var(--text-muted)' }} />
          <input type="text" placeholder="Search material..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
            className="w-full pl-7 pr-2 py-1.5 text-xs rounded border outline-none focus:ring-1 focus:ring-blue-500"
            style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-base)', color: 'var(--text-primary)' }} />
        </div>
        <select value={selectedPlant} onChange={e => setSelectedPlant(e.target.value)}
          className="text-xs rounded px-2 py-1.5 border"
          style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-base)', color: 'var(--text-primary)' }}>
          {plants.map(p => <option key={p} value={p}>{p === 'all' ? 'All Plants' : p}</option>)}
        </select>
        <select value={selectedRiskLevel} onChange={e => setSelectedRiskLevel(e.target.value)}
          className="text-xs rounded px-2 py-1.5 border"
          style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-base)', color: 'var(--text-primary)' }}>
          <option value="all">All Risk</option>
          <option value="critical">Critical</option>
          <option value="warning">Warning</option>
          <option value="safe">Safe</option>
        </select>
        {(searchTerm || selectedPlant !== 'all' || selectedRiskLevel !== 'all') && (
          <button onClick={() => { setSearchTerm(''); setSelectedPlant('all'); setSelectedRiskLevel('all'); }}
            className="text-xs text-blue-600 hover:underline">Clear</button>
        )}
      </div>

      {/* KPIs */}
      <div className="flex gap-3 px-4 py-3 overflow-x-auto">
        <KPI label="Critical" value={liveKpis.criticalCount} variant="danger" />
        <KPI label="Warning" value={liveKpis.warningCount} variant="warning" />
        <KPI label="Shortage" value={liveKpis.shortageWithinHorizon} variant="danger" />
        <KPI label="Total" value={liveKpis.totalItems} />
        {profitSummary.totalProfitAtRisk > 0 && (
          <KPI label="Profit at Risk" value={formatCurrency(profitSummary.totalProfitAtRisk)} variant="danger" />
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto px-4 py-2">
        {loading ? (
          <div className="flex items-center justify-center h-40">
            <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
            <span className="ml-2 text-sm" style={{ color: 'var(--text-muted)' }}>Loading risk data...</span>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-40">
            <AlertTriangle className="w-8 h-8 text-amber-500 mb-2" />
            <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{error.message}</p>
            {error.hint && <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{error.hint}</p>}
          </div>
        ) : displayRows.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-sm" style={{ color: 'var(--text-muted)' }}>
            No risk entries match filters
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ color: 'var(--text-muted)' }}>
                <th className="pb-2 font-medium">Material</th>
                <th className="pb-2 font-medium">Plant</th>
                <th className="pb-2 font-medium text-center">Risk</th>
                <th className="pb-2 font-medium text-right">Gap Qty</th>
                <th className="pb-2 font-medium text-right">Days to SO</th>
                <th className="pb-2 font-medium text-right">Profit at Risk</th>
              </tr>
            </thead>
            <tbody>
              {displayRows.map((row, i) => (
                <tr key={i} className="border-t cursor-pointer hover:bg-indigo-50/20"
                  style={{ borderColor: 'var(--border-subtle)' }}
                  onClick={() => setSelectedRow(selectedRow === row ? null : row)}>
                  <td className="py-1.5 font-medium">{row.item || '-'}</td>
                  <td className="py-1.5">{row.plantId || '-'}</td>
                  <td className="py-1.5 text-center"><RiskBadge level={row.riskLevel || 'safe'} /></td>
                  <td className="py-1.5 text-right font-mono">{row.gapQty != null ? Math.round(row.gapQty).toLocaleString() : '-'}</td>
                  <td className="py-1.5 text-right">
                    {row.daysToStockout === Infinity ? '∞' : row.daysToStockout?.toFixed?.(0) ?? '-'}
                  </td>
                  <td className="py-1.5 text-right">{formatCurrency(row.profitAtRisk)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Details Panel (slide-in) */}
      {selectedRow && (
        <div className="border-t px-4 py-3" style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-raised)' }}>
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              {selectedRow.item} — {selectedRow.plantId}
            </span>
            <button onClick={() => setSelectedRow(null)} className="p-1 rounded hover:bg-gray-200">
              <X size={14} />
            </button>
          </div>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div><span style={{ color: 'var(--text-muted)' }}>Risk Level:</span> <RiskBadge level={selectedRow.riskLevel || 'safe'} /></div>
            <div><span style={{ color: 'var(--text-muted)' }}>On Hand:</span> <b>{Number.isFinite(Number(selectedRow.onHand)) ? Number(selectedRow.onHand).toLocaleString() : '-'}</b></div>
            <div><span style={{ color: 'var(--text-muted)' }}>Inbound Qty:</span> <b>{Number.isFinite(Number(selectedRow.inboundQty)) ? Number(selectedRow.inboundQty).toLocaleString() : '-'}</b></div>
            <div><span style={{ color: 'var(--text-muted)' }}>Gap Qty:</span> <b>{Number.isFinite(Number(selectedRow.gapQty)) ? Number(selectedRow.gapQty).toLocaleString() : '-'}</b></div>
            <div><span style={{ color: 'var(--text-muted)' }}>Days to SO:</span> <b>{selectedRow.daysToStockout === Infinity ? '∞' : selectedRow.daysToStockout?.toFixed?.(0) ?? '-'}</b></div>
            <div><span style={{ color: 'var(--text-muted)' }}>Profit at Risk:</span> <b>{formatCurrency(selectedRow.profitAtRisk)}</b></div>
          </div>
          {selectedRow.recommendedAction && (
            <div className="mt-2 text-xs p-2 rounded bg-blue-50 text-blue-700">
              <b>Recommended:</b> {selectedRow.recommendedAction}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Export ──────────────────────────────────────────────────────────────

function RiskWidget({ mode = 'artifact', data = {}, user, globalDataSource }) {
  if (mode === 'live') {
    return <RiskWidgetLiveImpl user={user} globalDataSource={globalDataSource} />;
  }
  return <RiskWidgetArtifact data={data} />;
}

export default memo(RiskWidget);
