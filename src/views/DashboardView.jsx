import React, { useState, useEffect, useMemo } from 'react';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell, Area, AreaChart
} from 'recharts';
import {
  TrendingUp, TrendingDown, Package, Building2, AlertTriangle, Database,
  DollarSign, Activity, ArrowUpRight, ArrowDownRight, RefreshCw, Clock,
  CheckCircle, XCircle, Upload, BarChart3, Layers, ShieldAlert, Cloud,
  ChevronRight, Loader2, Box, FileText, Target, Truck
} from 'lucide-react';
import { supabase } from '../services/infra/supabaseClient';
import { Card } from '../components/ui';

// ─── Color Palette ───
const COLORS = {
  blue: '#3b82f6',
  emerald: '#10b981',
  amber: '#f59e0b',
  red: '#ef4444',
  purple: '#8b5cf6',
  cyan: '#06b6d4',
  indigo: '#6366f1',
  rose: '#f43f5e',
};

const PIE_COLORS = [COLORS.emerald, COLORS.red, COLORS.amber, COLORS.blue, COLORS.purple];

// ─── Sparkline Mini Chart ───
const Sparkline = ({ data = [], color = COLORS.blue, height = 40 }) => {
  const validData = data.filter(v => typeof v === 'number' && !isNaN(v));
  if (validData.length < 2) return null;
  const max = Math.max(...validData);
  const min = Math.min(...validData);
  const range = max - min || 1;
  const w = 120;
  const h = height;
  const points = validData.map((v, i) => {
    const x = (i / (validData.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 4) - 2;
    return `${x},${y}`;
  }).join(' ');
  const areaPoints = `0,${h} ${points} ${w},${h}`;

  return (
    <svg width={w} height={h} className="overflow-visible">
      <polyline fill="none" stroke={color} strokeWidth="2" points={points} />
      <polygon fill={color} fillOpacity="0.1" points={areaPoints} />
    </svg>
  );
};

// ─── KPI Card ───
// eslint-disable-next-line no-unused-vars -- Icon is used in JSX below; ESLint false positive on destructured rename
const KpiCard = ({ title, value, subtitle, icon: Icon, color, trend, trendLabel, sparkData, onClick }) => {
  const isPositive = trend > 0;
  const trendColor = isPositive ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400';
  const TrendIcon = isPositive ? ArrowUpRight : ArrowDownRight;

  return (
    <div
      onClick={onClick}
      className={`relative bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-5 shadow-sm hover:shadow-md transition-all duration-200 ${onClick ? 'cursor-pointer hover:border-blue-400 dark:hover:border-blue-500' : ''} overflow-hidden`}
    >
      {/* Accent bar */}
      <div className={`absolute top-0 left-0 right-0 h-1 rounded-t-xl`} style={{ backgroundColor: color }} />

      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <div className="p-2 rounded-lg" style={{ backgroundColor: `${color}15` }}>
              <Icon className="w-4 h-4" style={{ color }} />
            </div>
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">{title}</span>
          </div>
          <div className="text-2xl font-bold text-slate-900 dark:text-slate-100 mt-2">{value}</div>
          <div className="flex items-center gap-2 mt-1">
            {trend !== undefined && trend !== null && (
              <span className={`flex items-center text-xs font-semibold ${trendColor}`}>
                <TrendIcon className="w-3 h-3 mr-0.5" />
                {Math.abs(trend)}%
              </span>
            )}
            {(subtitle || trendLabel) && (
              <span className="text-xs text-slate-500 dark:text-slate-400">{trendLabel || subtitle}</span>
            )}
          </div>
        </div>
        {sparkData && sparkData.length > 1 && (
          <div className="ml-3 flex-shrink-0">
            <Sparkline data={sparkData} color={color} />
          </div>
        )}
      </div>
      {onClick && (
        <ChevronRight className="absolute bottom-3 right-3 w-4 h-4 text-slate-300 dark:text-slate-600" />
      )}
    </div>
  );
};

// ─── Section Header ───
const SectionHeader = ({ title, subtitle, icon: Icon, color }) => (
  <div className="flex items-center gap-3 mb-4">
    {Icon && (
      <div className="p-2 rounded-lg" style={{ backgroundColor: `${color}15` }}>
        <Icon className="w-5 h-5" style={{ color }} />
      </div>
    )}
    <div>
      <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
      {subtitle && <p className="text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>}
    </div>
  </div>
);

// ─── Custom Tooltip ───
const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg p-3 text-sm">
      <p className="font-medium text-slate-700 dark:text-slate-300 mb-1">{label}</p>
      {payload.map((entry, i) => (
        <p key={i} style={{ color: entry.color }} className="text-xs">
          {entry.name}: <span className="font-semibold">{typeof entry.value === 'number' ? entry.value.toLocaleString() : entry.value}</span>
        </p>
      ))}
    </div>
  );
};

// ═══════════════════════════════════════════════
// Main Dashboard View
// ═══════════════════════════════════════════════
const DashboardView = ({ setView, user, globalDataSource, setGlobalDataSource }) => {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [stats, setStats] = useState({
    suppliers: { total: 0, active: 0, inactive: 0 },
    inventory: { totalItems: 0, totalOnHand: 0, belowSafety: 0, uniqueMaterials: 0 },
    forecasts: { totalRuns: 0, recentRuns: [], latestStatus: '-' },
    imports: { totalBatches: 0, completed: 0, failed: 0, totalRows: 0, byType: {} },
    risk: { totalScored: 0, highRisk: 0, medRisk: 0, lowRisk: 0, avgScore: 0 },
    bom: { totalEdges: 0, totalDemandFg: 0 },
    decisionKpis: { serviceLevel: null, stockoutUnits: null, holdingUnits: null, totalCost: null, solverStatus: null, runDate: null },
  });

  const userId = user?.id;

  // ─── Fetch all dashboard data ───
  const fetchDashboardData = async (showRefresh = false) => {
    if (!userId) return;
    if (showRefresh) setRefreshing(true);
    else setLoading(true);

    try {
      const [
        suppliersRes,
        inventoryRes,
        forecastRunsRes,
        importBatchesRes,
        riskRes,
        bomEdgesRes,
        demandFgRes,
        planRunsRes,
      ] = await Promise.allSettled([
        // 1. Suppliers
        supabase.from('suppliers').select('id, status', { count: 'exact' }),
        // 2. Inventory snapshots (latest per material)
        supabase.from('inventory_snapshots').select('material_code, plant_id, onhand_qty, safety_stock, snapshot_date').eq('user_id', userId).order('snapshot_date', { ascending: false }).limit(2000),
        // 3. Forecast runs
        supabase.from('forecast_runs').select('id, status, kind, created_at, scenario_name').eq('user_id', userId).order('created_at', { ascending: false }).limit(20),
        // 4. Import batches (last 30 days)
        supabase.from('import_batches').select('id, status, upload_type, success_rows, error_rows, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(100),
        // 5. Risk score results (latest run)
        supabase.from('risk_score_results').select('score, material_code, plant_id').eq('user_id', userId).order('created_at', { ascending: false }).limit(500),
        // 6. BOM edges count
        supabase.from('bom_edges').select('id', { count: 'exact', head: true }).eq('user_id', userId),
        // 7. Demand FG count
        supabase.from('demand_fg').select('id', { count: 'exact', head: true }).eq('user_id', userId),
        // 8. Latest plan run with solver KPIs
        supabase.from('forecast_runs').select('id, status, kind, metadata, created_at').eq('user_id', userId).in('kind', ['plan', 'workflow_a', 'planning']).eq('status', 'completed').order('created_at', { ascending: false }).limit(1),
      ]);

      // Process suppliers
      const suppliersData = suppliersRes.status === 'fulfilled' ? (suppliersRes.value.data || []) : [];
      const activeSuppliers = suppliersData.filter(s => s.status === 'active').length;
      const inactiveSuppliers = suppliersData.filter(s => s.status === 'inactive').length;

      // Process inventory
      const invData = inventoryRes.status === 'fulfilled' ? (inventoryRes.value.data || []) : [];
      const invByKey = new Map();
      invData.forEach(r => {
        const key = `${r.material_code}|${r.plant_id}`;
        if (!invByKey.has(key)) invByKey.set(key, r);
      });
      const latestInv = Array.from(invByKey.values());
      const belowSafety = latestInv.filter(r => (r.onhand_qty || 0) < (r.safety_stock || 0)).length;
      const totalOnHand = latestInv.reduce((s, r) => s + (r.onhand_qty || 0), 0);

      // Process forecast runs
      const fRuns = forecastRunsRes.status === 'fulfilled' ? (forecastRunsRes.value.data || []) : [];
      const latestRun = fRuns[0];

      // Process import batches
      const batches = importBatchesRes.status === 'fulfilled' ? (importBatchesRes.value.data || []) : [];
      const completedBatches = batches.filter(b => b.status === 'completed').length;
      const failedBatches = batches.filter(b => b.status === 'failed').length;
      const totalImportedRows = batches.reduce((s, b) => s + (b.success_rows || 0), 0);
      const byType = {};
      batches.forEach(b => {
        const t = b.upload_type || 'unknown';
        if (!byType[t]) byType[t] = { count: 0, rows: 0 };
        byType[t].count++;
        byType[t].rows += (b.success_rows || 0);
      });

      // Process risk scores
      const riskData = riskRes.status === 'fulfilled' ? (riskRes.value.data || []) : [];
      const highRisk = riskData.filter(r => r.score >= 70).length;
      const medRisk = riskData.filter(r => r.score >= 40 && r.score < 70).length;
      const lowRisk = riskData.filter(r => r.score < 40).length;
      const avgScore = riskData.length > 0 ? Math.round(riskData.reduce((s, r) => s + (r.score || 0), 0) / riskData.length) : 0;

      // BOM counts
      const bomEdgeCount = bomEdgesRes.status === 'fulfilled' ? (bomEdgesRes.value.count || 0) : 0;
      const demandFgCount = demandFgRes.status === 'fulfilled' ? (demandFgRes.value.count || 0) : 0;

      // Decision KPIs from latest plan run
      const planRuns = planRunsRes.status === 'fulfilled' ? (planRunsRes.value.data || []) : [];
      let decisionKpis = { serviceLevel: null, stockoutUnits: null, holdingUnits: null, totalCost: null, solverStatus: null, runDate: null };
      if (planRuns.length > 0) {
        const latestPlan = planRuns[0];
        const meta = latestPlan.metadata || {};
        const kpis = meta.kpis || meta.solver_kpis || {};
        const solverMeta = meta.solver_meta || {};
        decisionKpis = {
          serviceLevel: kpis.estimated_service_level ?? kpis.service_level ?? null,
          stockoutUnits: kpis.estimated_stockout_units ?? kpis.stockout_units ?? null,
          holdingUnits: kpis.estimated_holding_units ?? kpis.holding_units ?? null,
          totalCost: kpis.estimated_total_cost ?? kpis.total_cost ?? null,
          solverStatus: solverMeta.status || latestPlan.status || null,
          runDate: latestPlan.created_at || null,
        };
      }

      setStats({
        suppliers: { total: suppliersData.length, active: activeSuppliers, inactive: inactiveSuppliers },
        inventory: { totalItems: latestInv.length, totalOnHand, belowSafety, uniqueMaterials: invByKey.size },
        forecasts: { totalRuns: fRuns.length, recentRuns: fRuns.slice(0, 5), latestStatus: latestRun?.status || '-' },
        imports: { totalBatches: batches.length, completed: completedBatches, failed: failedBatches, totalRows: totalImportedRows, byType, rawBatches: batches },
        risk: { totalScored: riskData.length, highRisk, medRisk, lowRisk, avgScore },
        bom: { totalEdges: bomEdgeCount, totalDemandFg: demandFgCount },
        decisionKpis,
      });
    } catch (err) {
      console.error('Dashboard fetch error:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchDashboardData();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchDashboardData runs when userId changes
  }, [userId]);

  // ─── Derived chart data ───
  const importTrendData = useMemo(() => {
    const batches = stats.imports.rawBatches || [];
    const byDate = {};
    batches.forEach(b => {
      const d = b.created_at?.slice(0, 10);
      if (!d) return;
      if (!byDate[d]) byDate[d] = { date: d, success: 0, failed: 0 };
      if (b.status === 'completed') byDate[d].success += (b.success_rows || 0);
      else if (b.status === 'failed') byDate[d].failed += (b.error_rows || 0);
    });
    return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date)).slice(-14);
  }, [stats.imports]);

  const importTypeData = useMemo(() => {
    return Object.entries(stats.imports.byType).map(([name, v]) => ({
      name: name.replace(/_/g, ' '),
      value: v.count,
      rows: v.rows,
    }));
  }, [stats.imports.byType]);

  const riskDistData = useMemo(() => {
    if (stats.risk.totalScored === 0) return [];
    return [
      { name: 'High Risk', value: stats.risk.highRisk, color: COLORS.red },
      { name: 'Medium Risk', value: stats.risk.medRisk, color: COLORS.amber },
      { name: 'Low Risk', value: stats.risk.lowRisk, color: COLORS.emerald },
    ].filter(d => d.value > 0);
  }, [stats.risk]);

  const supplierStatusData = useMemo(() => {
    if (stats.suppliers.total === 0) return [];
    return [
      { name: 'Active', value: stats.suppliers.active },
      { name: 'Inactive', value: stats.suppliers.inactive },
    ].filter(d => d.value > 0);
  }, [stats.suppliers]);

  // ─── Loading State ───
  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="flex flex-col items-center justify-center gap-4 py-24">
          <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
          <p className="text-slate-500 dark:text-slate-400 text-sm">Loading dashboard data...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="space-y-8 animate-fade-in">

        {/* ─── Header ─── */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold text-slate-900 dark:text-slate-100">
              Dashboard
            </h1>
            <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">
              {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {/* Data Source Toggle */}
            {setGlobalDataSource && (
              <div className="flex bg-slate-100 dark:bg-slate-700 rounded-lg p-1">
                <button
                  onClick={() => setGlobalDataSource('local')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                    globalDataSource === 'local'
                      ? 'bg-emerald-500 text-white shadow-sm'
                      : 'text-slate-500 dark:text-slate-400 hover:text-slate-700'
                  }`}
                >
                  <Database className="w-3.5 h-3.5" />
                  Local
                </button>
                <button
                  onClick={() => setGlobalDataSource('sap')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                    globalDataSource === 'sap'
                      ? 'bg-blue-500 text-white shadow-sm'
                      : 'text-slate-500 dark:text-slate-400 hover:text-slate-700'
                  }`}
                >
                  <Cloud className="w-3.5 h-3.5" />
                  SAP
                </button>
              </div>
            )}
            <button
              onClick={() => fetchDashboardData(true)}
              disabled={refreshing}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>

        {/* ─── KPI Cards Row 1 ─── */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiCard
            title="Suppliers"
            value={stats.suppliers.total.toLocaleString()}
            subtitle={`${stats.suppliers.active} active`}
            icon={Building2}
            color={COLORS.purple}
            onClick={() => setView('suppliers')}
          />
          <KpiCard
            title="Inventory Items"
            value={stats.inventory.totalItems.toLocaleString()}
            subtitle={`${stats.inventory.totalOnHand.toLocaleString()} total on-hand`}
            icon={Package}
            color={COLORS.blue}
          />
          <KpiCard
            title="Below Safety Stock"
            value={stats.inventory.belowSafety}
            subtitle={stats.inventory.totalItems > 0 ? `${Math.round(stats.inventory.belowSafety / stats.inventory.totalItems * 100)}% of items` : 'No data'}
            icon={AlertTriangle}
            color={stats.inventory.belowSafety > 0 ? COLORS.red : COLORS.emerald}
            onClick={() => setView('risk-dashboard')}
          />
          <KpiCard
            title="Risk Score (Avg)"
            value={stats.risk.avgScore > 0 ? stats.risk.avgScore : '-'}
            subtitle={`${stats.risk.highRisk} high risk items`}
            icon={ShieldAlert}
            color={stats.risk.avgScore >= 60 ? COLORS.red : stats.risk.avgScore >= 30 ? COLORS.amber : COLORS.emerald}
            onClick={() => setView('risk-dashboard')}
          />
        </div>

        {/* ─── KPI Cards Row 2 ─── */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiCard
            title="Forecast Runs"
            value={stats.forecasts.totalRuns}
            subtitle={`Latest: ${stats.forecasts.latestStatus}`}
            icon={TrendingUp}
            color={COLORS.indigo}
            onClick={() => setView('forecasts')}
          />
          <KpiCard
            title="Data Imports"
            value={stats.imports.totalBatches}
            subtitle={`${stats.imports.totalRows.toLocaleString()} rows imported`}
            icon={Upload}
            color={COLORS.cyan}
            onClick={() => setView('import-history')}
          />
          <KpiCard
            title="BOM Edges"
            value={stats.bom.totalEdges.toLocaleString()}
            subtitle={`${stats.bom.totalDemandFg.toLocaleString()} demand FG`}
            icon={Layers}
            color={COLORS.amber}
            onClick={() => setView('bom-data')}
          />
          <KpiCard
            title="Import Success Rate"
            value={stats.imports.totalBatches > 0 ? `${Math.round(stats.imports.completed / stats.imports.totalBatches * 100)}%` : '-'}
            subtitle={`${stats.imports.completed} completed / ${stats.imports.failed} failed`}
            icon={CheckCircle}
            color={stats.imports.failed > stats.imports.completed ? COLORS.red : COLORS.emerald}
            onClick={() => setView('import-history')}
          />
        </div>

        {/* ─── Decision KPIs Row ─── */}
        {(stats.decisionKpis.serviceLevel !== null || stats.decisionKpis.totalCost !== null) && (
          <>
            <SectionHeader
              title="Decision KPIs"
              subtitle={stats.decisionKpis.runDate ? `Latest plan: ${new Date(stats.decisionKpis.runDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : 'From latest plan run'}
              icon={Target}
              color={COLORS.emerald}
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <KpiCard
                title="Service Level"
                value={stats.decisionKpis.serviceLevel !== null ? `${(stats.decisionKpis.serviceLevel * 100).toFixed(1)}%` : '-'}
                subtitle="Estimated fill rate"
                icon={Target}
                color={stats.decisionKpis.serviceLevel >= 0.95 ? COLORS.emerald : stats.decisionKpis.serviceLevel >= 0.85 ? COLORS.amber : COLORS.red}
              />
              <KpiCard
                title="Stockout Units"
                value={stats.decisionKpis.stockoutUnits !== null ? Math.round(stats.decisionKpis.stockoutUnits).toLocaleString() : '-'}
                subtitle="Estimated shortage"
                icon={AlertTriangle}
                color={stats.decisionKpis.stockoutUnits === 0 ? COLORS.emerald : COLORS.red}
              />
              <KpiCard
                title="Holding Units"
                value={stats.decisionKpis.holdingUnits !== null ? Math.round(stats.decisionKpis.holdingUnits).toLocaleString() : '-'}
                subtitle="Avg inventory carried"
                icon={Truck}
                color={COLORS.blue}
              />
              <KpiCard
                title="Total Cost"
                value={stats.decisionKpis.totalCost !== null ? `$${Math.round(stats.decisionKpis.totalCost).toLocaleString()}` : '-'}
                subtitle="Order + holding + stockout"
                icon={DollarSign}
                color={COLORS.indigo}
              />
            </div>
          </>
        )}

        {/* ─── Charts Row ─── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

          {/* Import Trend Chart */}
          <Card className="!p-5">
            <SectionHeader title="Import Activity" subtitle="Rows imported over time" icon={BarChart3} color={COLORS.blue} />
            {importTrendData.length > 0 ? (
              <ResponsiveContainer width="100%" height={240} minWidth={1} minHeight={1}>
                <AreaChart data={importTrendData}>
                  <defs>
                    <linearGradient id="gradSuccess" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={COLORS.emerald} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={COLORS.emerald} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={v => v.slice(5)} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip content={<CustomTooltip />} />
                  <Area type="monotone" dataKey="success" name="Success Rows" stroke={COLORS.emerald} fill="url(#gradSuccess)" strokeWidth={2} />
                  <Area type="monotone" dataKey="failed" name="Failed Rows" stroke={COLORS.red} fill={COLORS.red} fillOpacity={0.1} strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-60 flex items-center justify-center text-slate-400 text-sm">No import data yet</div>
            )}
          </Card>

          {/* Risk Distribution */}
          <Card className="!p-5">
            <SectionHeader title="Risk Distribution" subtitle={`${stats.risk.totalScored} items scored`} icon={ShieldAlert} color={COLORS.red} />
            {riskDistData.length > 0 ? (
              <div className="flex items-center gap-6">
                <ResponsiveContainer width="50%" height={220} minWidth={1} minHeight={1}>
                  <PieChart>
                    <Pie
                      data={riskDistData}
                      cx="50%"
                      cy="50%"
                      innerRadius={55}
                      outerRadius={85}
                      paddingAngle={3}
                      dataKey="value"
                    >
                      {riskDistData.map((entry, i) => (
                        <Cell key={i} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip content={<CustomTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="flex-1 space-y-3">
                  {riskDistData.map((item, i) => (
                    <div key={i} className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: item.color }} />
                        <span className="text-sm text-slate-600 dark:text-slate-300">{item.name}</span>
                      </div>
                      <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">{item.value}</span>
                    </div>
                  ))}
                  <div className="pt-2 border-t border-slate-200 dark:border-slate-700">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-slate-500">Avg Score</span>
                      <span className={`text-lg font-bold ${
                        stats.risk.avgScore >= 60 ? 'text-red-500' : stats.risk.avgScore >= 30 ? 'text-amber-500' : 'text-emerald-500'
                      }`}>{stats.risk.avgScore}</span>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="h-60 flex items-center justify-center text-slate-400 text-sm">No risk data yet. Run a BOM explosion first.</div>
            )}
          </Card>
        </div>

        {/* ─── Bottom Row: Import Types + Supplier Status + Recent Runs ─── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* Import by Type */}
          <Card className="!p-5">
            <SectionHeader title="Imports by Type" subtitle="Distribution of uploaded data" icon={FileText} color={COLORS.cyan} />
            {importTypeData.length > 0 ? (
              <ResponsiveContainer width="100%" height={200} minWidth={1} minHeight={1}>
                <BarChart data={importTypeData} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11 }} />
                  <YAxis dataKey="name" type="category" tick={{ fontSize: 11 }} width={100} />
                  <Tooltip content={<CustomTooltip />} />
                  <Bar dataKey="value" name="Batches" fill={COLORS.cyan} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-48 flex items-center justify-center text-slate-400 text-sm">No imports yet</div>
            )}
          </Card>

          {/* Supplier Status */}
          <Card className="!p-5">
            <SectionHeader title="Supplier Status" subtitle={`${stats.suppliers.total} total suppliers`} icon={Building2} color={COLORS.purple} />
            {supplierStatusData.length > 0 ? (
              <div className="space-y-4 mt-4">
                {/* Visual bar */}
                <div className="flex h-4 rounded-full overflow-hidden bg-slate-100 dark:bg-slate-700">
                  {stats.suppliers.active > 0 && (
                    <div
                      className="bg-emerald-500 transition-all duration-500"
                      style={{ width: `${(stats.suppliers.active / stats.suppliers.total) * 100}%` }}
                    />
                  )}
                  {stats.suppliers.inactive > 0 && (
                    <div
                      className="bg-slate-400 transition-all duration-500"
                      style={{ width: `${(stats.suppliers.inactive / stats.suppliers.total) * 100}%` }}
                    />
                  )}
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-emerald-50 dark:bg-emerald-900/20 rounded-lg p-3 text-center">
                    <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{stats.suppliers.active}</div>
                    <div className="text-xs text-emerald-700 dark:text-emerald-300 mt-1">Active</div>
                  </div>
                  <div className="bg-slate-100 dark:bg-slate-700/50 rounded-lg p-3 text-center">
                    <div className="text-2xl font-bold text-slate-600 dark:text-slate-300">{stats.suppliers.inactive}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">Inactive</div>
                  </div>
                </div>
                <button
                  onClick={() => setView('suppliers')}
                  className="w-full text-center text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline py-1"
                >
                  View Supplier Portal →
                </button>
              </div>
            ) : (
              <div className="h-48 flex items-center justify-center text-slate-400 text-sm">No suppliers yet</div>
            )}
          </Card>

          {/* Recent Forecast Runs */}
          <Card className="!p-5">
            <SectionHeader title="Recent Forecast Runs" subtitle="Latest analysis runs" icon={TrendingUp} color={COLORS.indigo} />
            {stats.forecasts.recentRuns.length > 0 ? (
              <div className="space-y-2 mt-2">
                {stats.forecasts.recentRuns.map((run, i) => (
                  <div
                    key={run.id || i}
                    className="flex items-center justify-between p-2.5 rounded-lg bg-slate-50 dark:bg-slate-700/40 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                        run.status === 'completed' ? 'bg-emerald-500' :
                        run.status === 'failed' ? 'bg-red-500' :
                        run.status === 'running' ? 'bg-blue-500 animate-pulse' :
                        'bg-slate-400'
                      }`} />
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-slate-700 dark:text-slate-200 truncate">
                          {run.scenario_name || run.kind?.replace(/_/g, ' ') || 'Run'}
                        </div>
                        <div className="text-xs text-slate-400">
                          {run.created_at ? new Date(run.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-'}
                        </div>
                      </div>
                    </div>
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                      run.status === 'completed' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' :
                      run.status === 'failed' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' :
                      run.status === 'running' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' :
                      'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-400'
                    }`}>
                      {run.status || 'pending'}
                    </span>
                  </div>
                ))}
                <button
                  onClick={() => setView('forecasts')}
                  className="w-full text-center text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline py-1 mt-1"
                >
                  View All Forecasts →
                </button>
              </div>
            ) : (
              <div className="h-48 flex items-center justify-center text-slate-400 text-sm">No forecast runs yet</div>
            )}
          </Card>
        </div>

        {/* ─── Quick Actions ─── */}
        <Card className="!p-5">
          <SectionHeader title="Quick Actions" subtitle="Jump to key operations" icon={Activity} color={COLORS.blue} />
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mt-2">
            {[
              { label: 'Upload Data', icon: Upload, view: 'external', color: COLORS.cyan },
              { label: 'Risk Dashboard', icon: AlertTriangle, view: 'risk-dashboard', color: COLORS.red },
              { label: 'Forecasts', icon: TrendingUp, view: 'forecasts', color: COLORS.indigo },
              { label: 'BOM Health', icon: Layers, view: 'bom-data', color: COLORS.amber },
              { label: 'Cost Analysis', icon: DollarSign, view: 'cost-analysis', color: COLORS.emerald },
              { label: 'Audit Trail', icon: FileText, view: 'import-history', color: COLORS.purple },
            ].map(action => (
              <button
                key={action.view}
                onClick={() => setView(action.view)}
                className="flex flex-col items-center gap-2 p-4 rounded-xl bg-slate-50 dark:bg-slate-700/40 hover:bg-slate-100 dark:hover:bg-slate-700 border border-transparent hover:border-slate-200 dark:hover:border-slate-600 transition-all group"
              >
                <div className="p-2.5 rounded-lg transition-transform group-hover:scale-110" style={{ backgroundColor: `${action.color}15` }}>
                  <action.icon className="w-5 h-5" style={{ color: action.color }} />
                </div>
                <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{action.label}</span>
              </button>
            ))}
          </div>
        </Card>

      </div>
    </div>
  );
};

export default DashboardView;
