/**
 * Revenue Forecast Tab - Revenue forecast, margin at risk, terms
 * Handles revenue forecast run execution, run selection, KPI display,
 * revenue summary table, and revenue terms management.
 *
 * @typedef {Object} RevenueForecastTabProps
 * @property {Object} user - Current user object (must have .id)
 * @property {Function} addNotification - Notification callback (message, level)
 */

import React, { useState, useEffect } from 'react';
import {
  TrendingUp, PlayCircle, Loader2, AlertCircle, Check,
  Download, RefreshCw, Calendar
} from 'lucide-react';
import { Card, Button, Badge } from '../../components/ui';
import { forecastRunsService } from '../../services/supabaseClient';
import {
  runRevenueForecast,
  getMarginAtRiskResults,
  getRevenueTerms
} from '../../services/revenueForecastService';

/**
 * Format date for display
 */
const formatDate = (dateString) => {
  if (!dateString) return '-';
  const date = new Date(dateString);
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
};

/**
 * @param {RevenueForecastTabProps} props
 */
const RevenueForecastTab = ({ user, addNotification }) => {
  // ========== Revenue Forecast Tab States ==========
  const [revenueForecastRuns, setRevenueForecastRuns] = useState([]);
  const [selectedRevenueRunId, setSelectedRevenueRunId] = useState(null);
  const [revenueForecastData, setRevenueForecastData] = useState([]);
  const [revenueForecastLoading, setRevenueForecastLoading] = useState(false);
  const [_revenueForecastError, setRevenueForecastError] = useState(null);
  const [revenueSourceRunId, setRevenueSourceRunId] = useState(null);
  const [revenueKpis, setRevenueKpis] = useState({ totalKeys: 0, marginAtRisk: 0, penaltyAtRisk: 0, totalAtRisk: 0, topFg: null });
  const [revenueRunLoading, setRevenueRunLoading] = useState(false);
  const [revenueRunResult, setRevenueRunResult] = useState(null);
  const [revenueRiskInputMode, setRevenueRiskInputMode] = useState('deterministic'); // 'deterministic' | 'probabilistic'
  const [revenueDemandSource, _setRevenueDemandSource] = useState('uploaded'); // 'uploaded' | 'demand_forecast'
  const [revenueTopN, setRevenueTopN] = useState(200);
  const [revenueTerms, setRevenueTerms] = useState([]);
  const [_showRevenueTermModal, setShowRevenueTermModal] = useState(false);
  const [_editingRevenueTerm, _setEditingRevenueTerm] = useState(null);
  const [_selectedRevenueKey, setSelectedRevenueKey] = useState(null);
  const [inventoryProjectionRuns, setInventoryProjectionRuns] = useState([]);

  // Load revenue forecast data when component mounts
  useEffect(() => {
    if (user?.id) {
      loadRevenueForecastRuns();
      loadRevenueTerms();
      loadInventoryProjectionRuns();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs only when user changes
  }, [user?.id]);

  // Load revenue data when run selection changes
  useEffect(() => {
    if (selectedRevenueRunId) {
      handleRevenueRunSelect(selectedRevenueRunId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs only when run selection changes
  }, [selectedRevenueRunId]);

  // Handle run revenue forecast
  const handleRunRevenueForecast = async () => {
    if (!user?.id || !revenueSourceRunId) return;

    setRevenueRunLoading(true);
    setRevenueRunResult(null);

    try {
      const result = await runRevenueForecast(user.id, revenueSourceRunId, {
        riskInputMode: revenueRiskInputMode,
        demandSource: revenueDemandSource,
        topN: revenueTopN
      });

      setRevenueRunResult(result);

      if (result.success) {
        addNotification(
          `Revenue Forecast complete: ${result.kpis?.overall?.totalKeys || 0} FG keys, Margin at Risk $${result.kpis?.overall?.totalMarginAtRisk?.toLocaleString() || 0}`,
          result.mode === 'degraded' ? 'warning' : 'success'
        );
        // Reload runs list
        await loadRevenueForecastRuns();
        if (result.revenueRunId) {
          setSelectedRevenueRunId(result.revenueRunId);
        }
      } else {
        addNotification(`Revenue Forecast failed: ${result.error}`, 'error');
      }
    } catch (error) {
      console.error('Revenue forecast failed:', error);
      addNotification(`Revenue Forecast failed: ${error.message}`, 'error');
      setRevenueRunResult({ success: false, error: error.message });
    } finally {
      setRevenueRunLoading(false);
    }
  };

  // Load revenue forecast runs
  const loadRevenueForecastRuns = async () => {
    if (!user?.id) return;

    try {
      const runs = await forecastRunsService.listRuns(user.id, { limit: 50 });
      // Filter for revenue_forecast runs
      const revenueRuns = (runs || []).filter(r => r.kind === 'revenue_forecast');
      setRevenueForecastRuns(revenueRuns);
    } catch (err) {
      console.error('Failed to load revenue forecast runs:', err);
    }
  };

  // Handle revenue run selection
  const handleRevenueRunSelect = async (runId) => {
    setSelectedRevenueRunId(runId);
    setSelectedRevenueKey(null);

    if (!runId || !user?.id) {
      setRevenueForecastData([]);
      setRevenueKpis({ totalKeys: 0, marginAtRisk: 0, penaltyAtRisk: 0, totalAtRisk: 0, topFg: null });
      return;
    }

    setRevenueForecastLoading(true);
    setRevenueForecastError(null);

    try {
      // Load margin at risk results
      const result = await getMarginAtRiskResults(user.id, runId, { limit: 1000 });

      if (result.success) {
        setRevenueForecastData(result.data);

        // Calculate KPIs
        const marginAtRisk = result.data.reduce((sum, r) => sum + (r.expected_margin_at_risk || 0), 0);
        const penaltyAtRisk = result.data.reduce((sum, r) => sum + (r.expected_penalty_at_risk || 0), 0);

        // Find top FG
        const byKey = {};
        for (const row of result.data) {
          const key = `${row.fg_material_code}|${row.plant_id}`;
          if (!byKey[key]) {
            byKey[key] = { fgMaterialCode: row.fg_material_code, plantId: row.plant_id, total: 0 };
          }
          byKey[key].total += (row.expected_margin_at_risk || 0) + (row.expected_penalty_at_risk || 0);
        }
        const topFg = Object.values(byKey).sort((a, b) => b.total - a.total)[0] || null;

        setRevenueKpis({
          totalKeys: Object.keys(byKey).length,
          marginAtRisk,
          penaltyAtRisk,
          totalAtRisk: marginAtRisk + penaltyAtRisk,
          topFg
        });
      } else {
        setRevenueForecastError(result.error);
        setRevenueForecastData([]);
      }
    } catch (error) {
      setRevenueForecastError(error.message);
      setRevenueForecastData([]);
    } finally {
      setRevenueForecastLoading(false);
    }
  };

  // Load revenue terms
  const loadRevenueTerms = async () => {
    if (!user?.id) return;

    try {
      const result = await getRevenueTerms(user.id);
      if (result.success) {
        setRevenueTerms(result.data || []);
      }
    } catch (err) {
      console.error('Failed to load revenue terms:', err);
    }
  };

  // Download revenue CSV
  const downloadRevenueCSV = () => {
    if (revenueForecastData.length === 0) return;

    const headers = ['FG', 'Plant', 'Bucket', 'Demand', 'Impacted', 'Margin/Unit', 'Margin at Risk', 'Penalty', 'Total at Risk'];
    const rows = revenueForecastData.map(r => [
      r.fg_material_code,
      r.plant_id,
      r.time_bucket,
      r.demand_qty || 0,
      r.impacted_qty || 0,
      r.margin_per_unit || 0,
      r.expected_margin_at_risk || 0,
      r.expected_penalty_at_risk || 0,
      (r.expected_margin_at_risk || 0) + (r.expected_penalty_at_risk || 0)
    ]);

    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `revenue_forecast_${selectedRevenueRunId}_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  // Load inventory projection runs for revenue forecast source
  const loadInventoryProjectionRuns = async () => {
    if (!user?.id) return;

    try {
      const runs = await forecastRunsService.listRuns(user.id, { limit: 50 });
      // Filter for inventory_projection runs or runs without specific kind (BOM Explosion runs)
      const ipRuns = (runs || []).filter(r =>
        r.kind === 'inventory_projection' ||
        !r.kind || // BOM Explosion runs have null kind
        r.kind === 'bom_explosion'
      );
      setInventoryProjectionRuns(ipRuns);
    } catch (err) {
      console.error('Failed to load inventory projection runs:', err);
    }
  };

  return (
    <>
      {/* Run Revenue Forecast Card */}
      <Card>
        <div className="space-y-4">
          <h3 className="font-semibold text-lg flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-pink-500" />
            Run Revenue Forecast
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Source Run Selection */}
            <div className="space-y-2">
              <label className="block text-sm font-medium">
                Source BOM Run <span className="text-red-500">*</span>
              </label>
              <select
                value={revenueSourceRunId || ''}
                onChange={(e) => setRevenueSourceRunId(e.target.value || null)}
                className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800"
                disabled={revenueRunLoading}
              >
                <option value="">Select a run...</option>
                {inventoryProjectionRuns.map(run => (
                  <option key={run.id} value={run.id}>
                    {formatDate(run.created_at)} - {run.parameters?.input_demand_source || 'unknown'}
                  </option>
                ))}
              </select>
              <p className="text-xs text-slate-500">
                Revenue forecast uses BOM explosion run as input source
              </p>
            </div>

            {/* Risk Input Mode */}
            <div className="space-y-2">
              <label className="block text-sm font-medium">
                Risk Input Mode
              </label>
              <select
                value={revenueRiskInputMode}
                onChange={(e) => setRevenueRiskInputMode(e.target.value)}
                className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800"
                disabled={revenueRunLoading}
              >
                <option value="deterministic">Deterministic</option>
                <option value="probabilistic">Probabilistic</option>
              </select>
              <p className="text-xs text-slate-500">
                How to calculate impacted quantity
              </p>
            </div>

            {/* Top N */}
            <div className="space-y-2">
              <label className="block text-sm font-medium">
                Top N FG Keys
              </label>
              <input
                type="number"
                value={revenueTopN}
                onChange={(e) => setRevenueTopN(parseInt(e.target.value) || 200)}
                min="1"
                max="1000"
                className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800"
                disabled={revenueRunLoading}
              />
              <p className="text-xs text-slate-500">
                Limit to top N FG keys (default: 200)
              </p>
            </div>
          </div>

          {/* Revenue Terms Summary */}
          <div className="bg-slate-50 dark:bg-slate-900/50 rounded-lg p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-600 dark:text-slate-400">
                Revenue Terms: {revenueTerms.length} FG items configured
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowRevenueTermModal(true)}
              >
                Manage Terms
              </Button>
            </div>
          </div>

          {/* Run Button */}
          <div className="flex items-center gap-4">
            <Button
              onClick={handleRunRevenueForecast}
              disabled={!revenueSourceRunId || revenueRunLoading || revenueTerms.length === 0}
              icon={revenueRunLoading ? Loader2 : PlayCircle}
              className="px-8"
            >
              {revenueRunLoading ? 'Calculating...' : 'Run Revenue Forecast'}
            </Button>
          </div>

          {/* Result Display */}
          {revenueRunResult && (
            <div className={`mt-4 p-4 rounded-lg ${
              revenueRunResult.success
                ? 'bg-pink-50 dark:bg-pink-900/30 border border-pink-200 dark:border-pink-800'
                : 'bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800'
            }`}>
              <div className="flex items-start gap-3">
                {revenueRunResult.success ? (
                  <Check className="w-5 h-5 text-pink-600 dark:text-pink-400 mt-0.5" />
                ) : (
                  <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400 mt-0.5" />
                )}
                <div className="flex-1">
                  <h4 className={`font-semibold mb-1 ${revenueRunResult.success ? 'text-pink-900 dark:text-pink-100' : 'text-red-900 dark:text-red-100'}`}>
                    {revenueRunResult.success ? 'Revenue Forecast Complete' : 'Execution Failed'}
                  </h4>
                  {revenueRunResult.success ? (
                    <div className="text-sm text-pink-800 dark:text-pink-200 space-y-1">
                      <p>FG Keys: {revenueRunResult.kpis?.overall?.totalKeys || 0}</p>
                      <p>Margin at Risk: ${(revenueRunResult.kpis?.overall?.totalMarginAtRisk || 0).toLocaleString()}</p>
                      {revenueRunResult.kpis?.overall?.totalPenaltyAtRisk > 0 && (
                        <p>Penalty at Risk: ${(revenueRunResult.kpis?.overall?.totalPenaltyAtRisk || 0).toLocaleString()}</p>
                      )}
                      <p>Total at Risk: ${(revenueRunResult.kpis?.overall?.totalAtRisk || 0).toLocaleString()}</p>
                      {revenueRunResult.mode === 'degraded' && (
                        <p className="text-amber-600 dark:text-amber-400">
                          ⚠️ Degraded mode: {revenueRunResult.degradedReason || 'Performance limit reached'}
                        </p>
                      )}
                      <p className="text-xs mt-2">Run ID: {revenueRunResult.revenueRunId}</p>
                    </div>
                  ) : (
                    <p className="text-sm text-red-800 dark:text-red-200">
                      {revenueRunResult.error}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* Select Revenue Run Card */}
      <Card>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-lg flex items-center gap-2">
            <Calendar className="w-5 h-5 text-pink-500" />
            Select Revenue Forecast Run
          </h3>
          <Button
            onClick={loadRevenueForecastRuns}
            variant="outline"
            size="sm"
            icon={RefreshCw}
          >
            Refresh
          </Button>
        </div>

        {revenueForecastRuns.length === 0 ? (
          <div className="py-6 text-center text-slate-500">
            <p>No Revenue Forecast Runs yet</p>
            <p className="text-sm mt-1">Please run Revenue Forecast first</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {revenueForecastRuns.map(run => (
              <div
                key={run.id}
                onClick={() => setSelectedRevenueRunId(run.id)}
                className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                  selectedRevenueRunId === run.id
                    ? 'border-pink-500 bg-pink-50 dark:bg-pink-900/30'
                    : 'border-slate-200 dark:border-slate-700 hover:border-pink-300'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-slate-500">
                    {formatDate(run.created_at)}
                  </span>
                  <Badge
                    variant={run.status === 'completed' ? 'green' : run.status === 'failed' ? 'red' : 'yellow'}
                    className="text-xs"
                  >
                    {run.status}
                  </Badge>
                </div>
                <div className="font-medium text-sm truncate">
                  {run.parameters?.risk_input_mode || 'deterministic'}
                </div>
                {run.result_summary && (
                  <div className="text-xs text-slate-600 dark:text-slate-400 mt-1">
                    Keys: {run.result_summary.keys || 0} |
                    Total: ${(run.result_summary.total_at_risk || 0).toLocaleString()}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* KPI Cards */}
      {selectedRevenueRunId && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card className="bg-gradient-to-br from-pink-50 to-white dark:from-pink-900/20 dark:to-slate-800">
            <div className="text-sm text-slate-600 dark:text-slate-400">FG Keys Processed</div>
            <div className="text-3xl font-bold text-pink-600 dark:text-pink-400">
              {revenueKpis.totalKeys}
            </div>
          </Card>
          <Card className="bg-gradient-to-br from-rose-50 to-white dark:from-rose-900/20 dark:to-slate-800">
            <div className="text-sm text-slate-600 dark:text-slate-400">Margin at Risk</div>
            <div className="text-3xl font-bold text-rose-600 dark:text-rose-400">
              ${revenueKpis.marginAtRisk.toLocaleString()}
            </div>
          </Card>
          <Card className="bg-gradient-to-br from-orange-50 to-white dark:from-orange-900/20 dark:to-slate-800">
            <div className="text-sm text-slate-600 dark:text-slate-400">Penalty at Risk</div>
            <div className="text-3xl font-bold text-orange-600 dark:text-orange-400">
              ${revenueKpis.penaltyAtRisk.toLocaleString()}
            </div>
          </Card>
          <Card className="bg-gradient-to-br from-red-50 to-white dark:from-red-900/20 dark:to-slate-800">
            <div className="text-sm text-slate-600 dark:text-slate-400">Total at Risk</div>
            <div className="text-3xl font-bold text-red-600 dark:text-red-400">
              ${revenueKpis.totalAtRisk.toLocaleString()}
            </div>
            {revenueKpis.topFg && (
              <div className="text-xs text-slate-500 mt-1">
                Top: {revenueKpis.topFg.fgMaterialCode} ({revenueKpis.topFg.plantId})
              </div>
            )}
          </Card>
        </div>
      )}

      {/* Revenue Forecast Summary Table */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-semibold text-lg">Revenue Forecast Summary</h3>
            <p className="text-sm text-slate-500">
              {revenueForecastLoading ? 'Loading...' : `${revenueForecastData.length} rows total`}
            </p>
          </div>
          {revenueForecastData.length > 0 && (
            <Button
              onClick={downloadRevenueCSV}
              variant="outline"
              size="sm"
              icon={Download}
            >
              Export CSV
            </Button>
          )}
        </div>

        {revenueForecastLoading ? (
          <div className="py-12 text-center">
            <Loader2 className="w-8 h-8 mx-auto animate-spin text-pink-500 mb-2" />
            <p className="text-slate-500">Loading...</p>
          </div>
        ) : revenueForecastData.length === 0 ? (
          <div className="py-12 text-center text-slate-500">
            <TrendingUp className="w-16 h-16 mx-auto text-slate-300 dark:text-slate-600 mb-4" />
            <h3 className="text-lg font-semibold text-slate-600 dark:text-slate-400 mb-2">
              No Revenue Forecast Data
            </h3>
            <p className="text-sm text-slate-500">
              Please select a Revenue Forecast Run
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 dark:bg-slate-800 sticky top-0">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">FG</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">Plant</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">Bucket</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">Demand</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">Impacted</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">Margin/Unit</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">Margin at Risk</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">Penalty</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                {revenueForecastData.map((row, idx) => (
                  <tr
                    key={idx}
                    onClick={() => setSelectedRevenueKey(`${row.fg_material_code}|${row.plant_id}|${row.time_bucket}`)}
                    className="hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer"
                  >
                    <td className="px-3 py-2 font-mono text-xs">{row.fg_material_code}</td>
                    <td className="px-3 py-2 text-xs">{row.plant_id}</td>
                    <td className="px-3 py-2 font-mono text-xs">{row.time_bucket}</td>
                    <td className="px-3 py-2 text-right">{row.demand_qty?.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right font-semibold">{row.impacted_qty?.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right">${row.margin_per_unit?.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right text-rose-600 font-semibold">
                      ${row.expected_margin_at_risk?.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right text-orange-600">
                      ${row.expected_penalty_at_risk?.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right font-bold text-red-600">
                      ${((row.expected_margin_at_risk || 0) + (row.expected_penalty_at_risk || 0)).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
};

export default RevenueForecastTab;
