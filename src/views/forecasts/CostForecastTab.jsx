/**
 * Cost Forecast Tab - Cost forecast, rule sets, KPIs
 * Handles cost forecast run execution, run selection, KPI display,
 * cost summary table, and cost details drawer.
 *
 * @typedef {Object} CostForecastTabProps
 * @property {Object} user - Current user object (must have .id)
 * @property {Function} addNotification - Notification callback (message, level)
 */

import React, { useState, useEffect } from 'react';
import {
  PlayCircle, Loader2, AlertTriangle, Check,
  Download, RefreshCw, Calendar, DollarSign, Database
} from 'lucide-react';
import { Card, Button, Badge } from '../../components/ui';
import { forecastRunsService } from '../../services/infra/supabaseClient';
import { runCostForecast, getCostResultsByKey, getCostRuleSets } from '../../services/forecast/costForecastService';

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
 * @param {CostForecastTabProps} props
 */
const CostForecastTab = ({ user, addNotification }) => {
  // ========== Cost Forecast Tab States ==========
  const [costForecastRuns, setCostForecastRuns] = useState([]);
  const [selectedCostRunId, setSelectedCostRunId] = useState(null);
  const [costForecastData, setCostForecastData] = useState([]);
  const [costForecastLoading, setCostForecastLoading] = useState(false);
  const [costForecastError, setCostForecastError] = useState(null);
  const [selectedCostRuleSet, setSelectedCostRuleSet] = useState(null);
  const [costRuleSets, setCostRuleSets] = useState([]);
  const [costSourceRunId, setCostSourceRunId] = useState(null);
  const [costKpis, setCostKpis] = useState({ expedite: 0, substitution: 0, disruption: 0, total: 0, keys: 0 });
  const [costRunLoading, setCostRunLoading] = useState(false);
  const [costRunResult, setCostRunResult] = useState(null);
  const [selectedCostKey, setSelectedCostKey] = useState(null);
  const [inventoryProjectionRuns, setInventoryProjectionRuns] = useState([]);

  // Load cost forecast data when component mounts
  useEffect(() => {
    if (user?.id) {
      loadCostForecastRuns();
      loadCostRuleSets();
      loadInventoryProjectionRuns();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs only when user changes
  }, [user?.id]);

  // Load cost data when run selection changes
  useEffect(() => {
    if (selectedCostRunId) {
      handleCostRunSelect(selectedCostRunId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs only when run selection changes
  }, [selectedCostRunId]);

  // Handle run cost forecast
  const handleRunCostForecast = async () => {
    if (!user?.id || !costSourceRunId) return;

    setCostRunLoading(true);
    setCostRunResult(null);

    try {
      const result = await runCostForecast(user.id, costSourceRunId, {
        ruleSetId: selectedCostRuleSet,
        useProbInputs: true
      });

      setCostRunResult(result);

      if (result.success) {
        addNotification(
          `Cost Forecast complete: ${result.kpis?.overall?.totalKeys || 0} keys, Total $${result.kpis?.overall?.totalCost?.toLocaleString() || 0}`,
          result.mode === 'degraded' ? 'warning' : 'success'
        );
        // Reload runs list
        await loadCostForecastRuns();
        if (result.costRunId) {
          setSelectedCostRunId(result.costRunId);
        }
      } else {
        addNotification(`Cost Forecast failed: ${result.error}`, 'error');
      }
    } catch (error) {
      console.error('Cost forecast failed:', error);
      addNotification(`Cost Forecast failed: ${error.message}`, 'error');
      setCostRunResult({ success: false, error: error.message });
    } finally {
      setCostRunLoading(false);
    }
  };

  // Load cost forecast runs
  const loadCostForecastRuns = async () => {
    if (!user?.id) return;

    try {
      const runs = await forecastRunsService.listRuns(user.id, { limit: 50 });
      // Filter for cost_forecast runs
      const costRuns = (runs || []).filter(r => r.kind === 'cost_forecast');
      setCostForecastRuns(costRuns);
    } catch (err) {
      console.error('Failed to load cost forecast runs:', err);
    }
  };

  // Handle cost run selection
  const handleCostRunSelect = async (runId) => {
    setSelectedCostRunId(runId);
    setSelectedCostKey(null);

    if (!runId || !user?.id) {
      setCostForecastData([]);
      setCostKpis({ expedite: 0, substitution: 0, disruption: 0, total: 0, keys: 0 });
      return;
    }

    setCostForecastLoading(true);
    setCostForecastError(null);

    try {
      // Load cost results grouped by key
      const result = await getCostResultsByKey(user.id, runId);

      if (result.success) {
        setCostForecastData(result.data);

        // Calculate KPIs
        const expedite = result.data.reduce((sum, r) => sum + (r.expedite_cost || 0), 0);
        const substitution = result.data.reduce((sum, r) => sum + (r.substitution_cost || 0), 0);
        const disruption = result.data.reduce((sum, r) => sum + (r.disruption_cost || 0), 0);

        setCostKpis({
          expedite,
          substitution,
          disruption,
          total: expedite + substitution + disruption,
          keys: result.data.length
        });
      } else {
        setCostForecastError(result.error);
        setCostForecastData([]);
      }
    } catch (error) {
      setCostForecastError(error.message);
      setCostForecastData([]);
    } finally {
      setCostForecastLoading(false);
    }
  };

  // Download cost CSV
  const downloadCostCSV = () => {
    if (costForecastData.length === 0) return;

    const headers = ['Key', 'Material', 'Plant', 'P(Stockout)', 'Shortage', 'Expedite', 'Substitution', 'Disruption', 'Total', 'Best Action'];
    const rows = costForecastData.map(r => [
      r.key,
      r.material_code,
      r.plant_id,
      r.p_stockout || 0,
      r.shortage_qty || 0,
      r.expedite_cost || 0,
      r.substitution_cost || 0,
      r.disruption_cost || 0,
      r.total_cost || 0,
      r.cheapest_action
    ]);

    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `cost_forecast_${selectedCostRunId}_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  // Load cost rule sets
  const loadCostRuleSets = async () => {
    if (!user?.id) return;

    try {
      const result = await getCostRuleSets(user.id);
      if (result.success) {
        setCostRuleSets(result.data || []);
      }
    } catch (err) {
      console.error('Failed to load cost rule sets:', err);
    }
  };

  // Load inventory projection runs for cost forecast source
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
      {/* Run Cost Forecast Card */}
      <Card>
        <div className="space-y-4">
          <h3 className="font-semibold text-lg flex items-center gap-2">
            <DollarSign className="w-5 h-5 text-green-500" />
            Run Cost Forecast
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Source Run Selection */}
            <div className="space-y-2">
              <label className="block text-sm font-medium">
                Source Inventory Run <span className="text-red-500">*</span>
              </label>
              <select
                value={costSourceRunId || ''}
                onChange={(e) => setCostSourceRunId(e.target.value || null)}
                className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800"
                disabled={costRunLoading}
              >
                <option value="">Select a run...</option>
                {inventoryProjectionRuns.map(run => (
                  <option key={run.id} value={run.id}>
                    {formatDate(run.created_at)} - {run.parameters?.input_demand_source || 'unknown'}
                  </option>
                ))}
              </select>
              <p className="text-xs text-slate-500">
                Cost forecast uses inventory run as input source
              </p>
            </div>

            {/* Rule Set Selection */}
            <div className="space-y-2">
              <label className="block text-sm font-medium">
                Cost Rule Set
              </label>
              <select
                value={selectedCostRuleSet || ''}
                onChange={(e) => setSelectedCostRuleSet(e.target.value || null)}
                className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800"
                disabled={costRunLoading}
              >
                <option value="">Default Rules (v1.0.0)</option>
                {costRuleSets.map(rule => (
                  <option key={rule.id} value={rule.id}>
                    {rule.rule_set_version}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Execute Button */}
          <div className="flex justify-center">
            <Button
              onClick={handleRunCostForecast}
              disabled={costRunLoading || !costSourceRunId}
              variant="primary"
              icon={costRunLoading ? Loader2 : PlayCircle}
              className="px-8"
            >
              {costRunLoading ? 'Calculating...' : 'Run Cost Forecast'}
            </Button>
          </div>

          {/* Result Display */}
          {costRunResult && (
            <div className={`p-4 rounded-lg border ${costRunResult.success ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800' : 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800'}`}>
              <div className="flex items-start gap-3">
                {costRunResult.success ? (
                  <Check className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                ) : (
                  <AlertTriangle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                )}
                <div className="flex-1">
                  <h4 className={`font-semibold mb-1 ${costRunResult.success ? 'text-green-900 dark:text-green-100' : 'text-red-900 dark:text-red-100'}`}>
                    {costRunResult.success ? 'Cost Forecast Complete' : 'Execution Failed'}
                  </h4>
                  {costRunResult.success ? (
                    <div className="text-sm text-green-800 dark:text-green-200 space-y-1">
                      <p>Keys: {costRunResult.kpis?.overall?.totalKeys} |
                         Expedite: ${costRunResult.kpis?.expedite?.totalCost?.toLocaleString()} |
                         Substitution: ${costRunResult.kpis?.substitution?.totalCost?.toLocaleString()} |
                         Disruption: ${costRunResult.kpis?.disruption?.totalCost?.toLocaleString()}</p>
                      <p>Run ID: <code className="px-2 py-0.5 bg-green-100 dark:bg-green-800 rounded text-xs font-mono">{costRunResult.costRunId}</code></p>
                      {costRunResult.mode === 'degraded' && (
                        <p className="text-amber-600">⚠️ Degraded mode: {costRunResult.metrics?.degradedReason}</p>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm text-red-800 dark:text-red-200">{costRunResult.error}</p>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* Run Selector */}
      <Card>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-lg flex items-center gap-2">
              <Calendar className="w-5 h-5 text-green-500" />
              Select Cost Forecast Run
            </h3>
            <Button
              onClick={loadCostForecastRuns}
              variant="secondary"
              size="sm"
              icon={RefreshCw}
            >
              Refresh
            </Button>
          </div>

          {costForecastRuns.length === 0 ? (
            <div className="py-6 text-center text-slate-500">
              <p>No Cost Forecast Runs yet</p>
              <p className="text-sm mt-1">Please run Cost Forecast first</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {costForecastRuns.slice(0, 9).map(run => (
                <div
                  key={run.id}
                  onClick={() => handleCostRunSelect(run.id)}
                  className={`p-3 rounded-lg border-2 cursor-pointer transition-all ${
                    selectedCostRunId === run.id
                      ? 'border-green-500 bg-green-50 dark:bg-green-900/20'
                      : 'border-slate-200 dark:border-slate-700 hover:border-green-300 dark:hover:border-green-700'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-green-600 dark:text-green-400">
                      {run.parameters?.rule_set_version || 'v1.0.0'}
                    </span>
                    {selectedCostRunId === run.id && (
                      <Check className="w-4 h-4 text-green-600" />
                    )}
                  </div>
                  <div className="text-xs text-slate-500 space-y-1">
                    <div>
                      <span className="font-medium">Keys:</span> {run.result_summary?.keys || 0}
                    </div>
                    <div>
                      <span className="font-medium">Total Cost:</span> ${run.result_summary?.total_expected_cost?.toLocaleString() || 0}
                    </div>
                    {run.result_summary?.degraded && (
                      <div className="text-amber-600">⚠️ Degraded</div>
                    )}
                    <div className="text-slate-400">
                      {formatDate(run.created_at)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      {/* KPI Cards */}
      {selectedCostRunId && costForecastData.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card className="p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
            <div className="text-2xl font-bold text-blue-600">
              ${costKpis.expedite.toLocaleString()}
            </div>
            <div className="text-sm text-slate-600 dark:text-slate-400 mt-1">
              Total Expedite Cost
            </div>
          </Card>
          <Card className="p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
            <div className="text-2xl font-bold text-amber-600">
              ${costKpis.substitution.toLocaleString()}
            </div>
            <div className="text-sm text-slate-600 dark:text-slate-400 mt-1">
              Total Substitution Cost
            </div>
          </Card>
          <Card className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
            <div className="text-2xl font-bold text-red-600">
              ${costKpis.disruption.toLocaleString()}
            </div>
            <div className="text-sm text-slate-600 dark:text-slate-400 mt-1">
              Total Disruption Cost
            </div>
          </Card>
          <Card className="p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800">
            <div className="text-2xl font-bold text-green-600">
              ${costKpis.total.toLocaleString()}
            </div>
            <div className="text-sm text-slate-600 dark:text-slate-400 mt-1">
              Grand Total ({costKpis.keys} keys)
            </div>
          </Card>
        </div>
      )}

      {/* Cost Summary Table */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-semibold text-lg">Cost Forecast Summary</h3>
            <p className="text-sm text-slate-500">
              {costForecastLoading ? 'Loading...' : `${costForecastData.length} Keys total`}
            </p>
          </div>
          {costForecastData.length > 0 && (
            <Button
              variant="secondary"
              size="sm"
              icon={Download}
              onClick={() => downloadCostCSV()}
            >
              Export CSV
            </Button>
          )}
        </div>

        {costForecastLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-green-500" />
            <span className="ml-3 text-slate-600 dark:text-slate-400">Loading...</span>
          </div>
        ) : costForecastError ? (
          <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
            <p className="text-red-800 dark:text-red-200">{costForecastError}</p>
          </div>
        ) : costForecastData.length === 0 ? (
          <div className="py-12 text-center">
            <DollarSign className="w-16 h-16 mx-auto text-slate-300 dark:text-slate-600 mb-4" />
            <h3 className="text-lg font-semibold text-slate-600 dark:text-slate-400 mb-2">
              No Cost Forecast Data
            </h3>
            <p className="text-sm text-slate-500">
              Please select a Cost Forecast Run
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 dark:bg-slate-800 sticky top-0">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">Key</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">P(Stockout)</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">Shortage</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">Expedite</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">Substitution</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">Disruption</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">Total</th>
                  <th className="px-3 py-2 text-center text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">Best Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                {costForecastData.map((row, idx) => (
                  <tr
                    key={idx}
                    className={`hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer ${selectedCostKey === row.key ? 'bg-green-50 dark:bg-green-900/20' : ''}`}
                    onClick={() => setSelectedCostKey(row.key === selectedCostKey ? null : row.key)}
                  >
                    <td className="px-3 py-2 font-mono text-xs">{row.key}</td>
                    <td className="px-3 py-2 text-right">
                      <span className={row.p_stockout > 0.2 ? 'text-red-600 font-semibold' : 'text-slate-600'}>
                        {(row.p_stockout * 100).toFixed(1)}%
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">{row.shortage_qty?.toLocaleString() || '0'}</td>
                    <td className="px-3 py-2 text-right">${row.expedite_cost?.toLocaleString() || '0'}</td>
                    <td className="px-3 py-2 text-right">${row.substitution_cost?.toLocaleString() || '0'}</td>
                    <td className="px-3 py-2 text-right">${row.disruption_cost?.toLocaleString() || '0'}</td>
                    <td className="px-3 py-2 text-right font-semibold">${row.total_cost?.toLocaleString() || '0'}</td>
                    <td className="px-3 py-2 text-center">
                      <span className={`text-xs px-2 py-1 rounded ${
                        row.cheapest_action === 'expedite' ? 'bg-blue-100 text-blue-700' :
                        row.cheapest_action === 'substitution' ? 'bg-amber-100 text-amber-700' :
                        'bg-red-100 text-red-700'
                      }`}>
                        {row.cheapest_action}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Cost Details Drawer */}
      {selectedCostKey && (
        <Card className="bg-slate-50 dark:bg-slate-800/50">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-lg flex items-center gap-2">
                <Database className="w-5 h-5 text-green-500" />
                Cost Details: {selectedCostKey}
              </h3>
              <button
                onClick={() => setSelectedCostKey(null)}
                className="text-sm text-slate-500 hover:text-green-600"
              >
                Close
              </button>
            </div>
            {costForecastData.find(r => r.key === selectedCostKey) && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {['expedite', 'substitution', 'disruption'].map(action => {
                  const row = costForecastData.find(r => r.key === selectedCostKey);
                  const cost = row?.[`${action}_cost`] || 0;
                  const isCheapest = row?.cheapest_action === action;
                  return (
                    <div key={action} className={`p-4 rounded-lg border ${isCheapest ? 'border-green-400 bg-green-50 dark:bg-green-900/30' : 'border-slate-200 dark:border-slate-700'}`}>
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-semibold capitalize">{action}</span>
                        {isCheapest && <Badge variant="green">Best</Badge>}
                      </div>
                      <div className="text-2xl font-bold">${cost.toLocaleString()}</div>
                      <div className="text-xs text-slate-500 mt-1">
                        {action === 'expedite' && 'Shortage x Unit Cost'}
                        {action === 'substitution' && 'Fixed + (Shortage x Var Cost)'}
                        {action === 'disruption' && 'P(Stockout) x Cost If Stockout'}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Card>
      )}
    </>
  );
};

export default CostForecastTab;
