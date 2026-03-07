/**
 * Supply Forecast Tab - Supply forecast, supplier stats, inbound traces
 * Handles supply forecast run execution, run selection, inbound summary,
 * supplier stats KPIs, and trace details.
 *
 * @typedef {Object} SupplyForecastTabProps
 * @property {Object} user - Current user object (must have .id)
 * @property {Function} addNotification - Notification callback (message, level)
 */

import React, { useState, useEffect } from 'react';
import {
  PlayCircle, Loader2, AlertTriangle, Check,
  RefreshCw, Package, Calendar, Database
} from 'lucide-react';
import { Card, Button, Badge } from '../../components/ui';
import { runSupplyForecast, supplyForecastService } from '../../services/supplyForecastService';
import { forecastRunsService } from '../../services/supabaseClient';

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
 * @param {SupplyForecastTabProps} props
 */
const SupplyForecastTab = ({ user, addNotification }) => {
  // ========== Supply Forecast Tab States ==========
  const [supplyForecastRuns, setSupplyForecastRuns] = useState([]);
  const [selectedSupplyRunId, setSelectedSupplyRunId] = useState(null);
  const [supplyForecastData, setSupplyForecastData] = useState([]);
  const [supplyForecastLoading, setSupplyForecastLoading] = useState(false);
  const [supplyForecastError, setSupplyForecastError] = useState(null);
  const [sfPlantId, setSfPlantId] = useState('');
  const [sfTimeBuckets, setSfTimeBuckets] = useState('');
  const [sfHistoryWindow, setSfHistoryWindow] = useState(90);
  const [sfRunLoading, setSfRunLoading] = useState(false);
  const [sfRunResult, setSfRunResult] = useState(null);
  const [sfSupplierStats, setSfSupplierStats] = useState([]);
  const [sfSelectedInbound, setSfSelectedInbound] = useState(null);
  const [sfInboundTraces, setSfInboundTraces] = useState([]);

  // Load supply forecast data when component mounts
  useEffect(() => {
    if (user?.id) {
      loadSupplyForecastRuns();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs only when user changes
  }, [user?.id]);

  // Load data when run selection changes
  useEffect(() => {
    if (selectedSupplyRunId) {
      loadSupplyForecastData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs only when run selection changes
  }, [selectedSupplyRunId]);

  /**
   * Load supply forecast runs
   */
  const loadSupplyForecastRuns = async () => {
    if (!user?.id) return;

    try {
      const runs = await supplyForecastService.listRuns(user.id, { limit: 20 });
      setSupplyForecastRuns(runs || []);

      // Select first run if none selected
      if (runs && runs.length > 0 && !selectedSupplyRunId) {
        setSelectedSupplyRunId(runs[0].id);
      }
    } catch (error) {
      console.error('Error loading supply forecast runs:', error);
    }
  };

  /**
   * Load supply forecast data for selected run
   */
  const loadSupplyForecastData = async () => {
    if (!user?.id || !selectedSupplyRunId) return;

    setSupplyForecastLoading(true);
    setSupplyForecastError(null);

    try {
      // Get inbound forecast data
      const inbound = await supplyForecastService.getInboundByRun(
        user.id,
        selectedSupplyRunId
      );
      setSupplyForecastData(inbound || []);

      // Get supplier stats
      const stats = await supplyForecastService.getSupplierStatsByRun(
        user.id,
        selectedSupplyRunId
      );
      setSfSupplierStats(stats || []);
    } catch (error) {
      console.error('Error loading supply forecast data:', error);
      setSupplyForecastError(error.message);
    } finally {
      setSupplyForecastLoading(false);
    }
  };

  /**
   * Handle supply forecast run selection
   */
  const handleSupplyRunSelect = (runId) => {
    setSelectedSupplyRunId(runId);
    setSfSelectedInbound(null);
    setSfInboundTraces([]);
  };

  /**
   * Load trace for selected inbound
   */
  const loadInboundTrace = async (inboundId) => {
    if (!user?.id || !inboundId) return;

    try {
      const traces = await supplyForecastService.getTraceForInbound(
        user.id,
        inboundId,
        { limit: 50 }
      );
      setSfInboundTraces(traces || []);
    } catch (error) {
      console.error('Error loading inbound trace:', error);
    }
  };

  /**
   * Execute supply forecast run
   */
  const handleRunSupplyForecast = async () => {
    if (!user?.id) {
      addNotification('Please log in first', 'error');
      return;
    }

    setSfRunLoading(true);
    setSfRunResult(null);

    try {
      // Parse inputs
      const plantIdFilter = sfPlantId.trim() || null;
      const targetTimeBuckets = sfTimeBuckets.trim()
        ? sfTimeBuckets.split(',').map(t => t.trim()).filter(Boolean)
        : [];

      if (targetTimeBuckets.length === 0) {
        throw new Error('Please provide at least one Time Bucket');
      }

      console.log('Running supply forecast:', { plantIdFilter, targetTimeBuckets, historyWindow: sfHistoryWindow });

      // Execute forecast
      const result = await runSupplyForecast(
        {
          userId: user.id,
          plantId: plantIdFilter,
          timeBuckets: targetTimeBuckets,
          historyWindowDays: sfHistoryWindow,
          modelVersion: 'supply_v1',
          scenarioName: 'supply_forecast'
        },
        {
          forecastRunsService,
          supplyForecastService
        }
      );

      console.log('Supply forecast result:', result);
      setSfRunResult(result);

      if (result.success) {
        addNotification(
          `Supply Forecast complete! Generated ${result.statistics.supplierStatsCount} Supplier Stats, ${result.statistics.inboundBucketsCount} Inbound Buckets`,
          'success'
        );
        // Reload runs list
        await loadSupplyForecastRuns();
        if (result.forecastRunId) {
          setSelectedSupplyRunId(result.forecastRunId);
        }
      } else {
        addNotification(`Supply Forecast failed: ${result.error}`, 'error');
      }
    } catch (error) {
      console.error('Supply forecast failed:', error);
      addNotification(`Supply Forecast failed: ${error.message}`, 'error');
      setSfRunResult({ success: false, error: error.message });
    } finally {
      setSfRunLoading(false);
    }
  };

  return (
    <>
      {/* Run Execution Section */}
      <Card>
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <PlayCircle className="w-6 h-6 text-purple-500" />
            <div>
              <h3 className="font-semibold text-lg">Run Supply Forecast</h3>
              <p className="text-sm text-slate-500">
                Forecast supply delivery time/reliability (Lead time distribution, On-time rate, Delay risk)
              </p>
            </div>
          </div>

          {/* Input Filters */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-4 border-t dark:border-slate-700">
            <div className="space-y-2">
              <label className="block text-sm font-medium">
                Plant ID (leave empty = all plants)
              </label>
              <input
                type="text"
                value={sfPlantId}
                onChange={(e) => setSfPlantId(e.target.value)}
                placeholder="e.g. P001"
                className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 focus:ring-2 focus:ring-purple-500 outline-none"
                disabled={sfRunLoading}
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium">
                Target Time Buckets <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={sfTimeBuckets}
                onChange={(e) => setSfTimeBuckets(e.target.value)}
                placeholder="e.g. 2026-W10, 2026-W11, 2026-W12"
                className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 focus:ring-2 focus:ring-purple-500 outline-none"
                disabled={sfRunLoading}
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium">
                History Window (days)
              </label>
              <input
                type="number"
                value={sfHistoryWindow}
                onChange={(e) => setSfHistoryWindow(parseInt(e.target.value) || 90)}
                min="30"
                max="365"
                className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 focus:ring-2 focus:ring-purple-500 outline-none"
                disabled={sfRunLoading}
              />
            </div>
          </div>

          {/* Execute Button */}
          <div className="flex justify-center">
            <Button
              onClick={handleRunSupplyForecast}
              disabled={sfRunLoading || !sfTimeBuckets.trim()}
              variant="primary"
              icon={sfRunLoading ? Loader2 : PlayCircle}
              className="px-8"
            >
              {sfRunLoading ? 'Calculating...' : 'Run Supply Forecast'}
            </Button>
          </div>

          {/* Result Display */}
          {sfRunResult && (
            <div className={`p-4 rounded-lg border ${sfRunResult.success ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800' : 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800'}`}>
              <div className="flex items-start gap-3">
                {sfRunResult.success ? (
                  <Check className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                ) : (
                  <AlertTriangle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                )}
                <div className="flex-1">
                  <h4 className={`font-semibold mb-1 ${sfRunResult.success ? 'text-green-900 dark:text-green-100' : 'text-red-900 dark:text-red-100'}`}>
                    {sfRunResult.success ? 'Supply Forecast Complete' : 'Execution Failed'}
                  </h4>
                  {sfRunResult.success ? (
                    <div className="text-sm text-green-800 dark:text-green-200 space-y-1">
                      <p>Suppliers: {sfRunResult.statistics.supplierStatsCount} | PO Lines: {sfRunResult.statistics.poForecastsCount} | Inbound Buckets: {sfRunResult.statistics.inboundBucketsCount}</p>
                      <p>Run ID: <code className="px-2 py-0.5 bg-green-100 dark:bg-green-800 rounded text-xs font-mono">{sfRunResult.forecastRunId}</code></p>
                      <p>Model: supply_v1 | History Window: {sfRunResult.runRecord?.parameters?.history_window_days} days</p>
                    </div>
                  ) : (
                    <p className="text-sm text-red-800 dark:text-red-200">{sfRunResult.error}</p>
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
              <Calendar className="w-5 h-5 text-purple-500" />
              Select Supply Forecast Run
            </h3>
            <Button
              onClick={loadSupplyForecastRuns}
              variant="secondary"
              size="sm"
              icon={RefreshCw}
            >
              Refresh
            </Button>
          </div>

          {supplyForecastRuns.length === 0 ? (
            <div className="py-6 text-center text-slate-500">
              <p>No Supply Forecast Runs yet</p>
              <p className="text-sm mt-1">Please run Supply Forecast first</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {supplyForecastRuns.slice(0, 9).map(run => (
                <div
                  key={run.id}
                  onClick={() => handleSupplyRunSelect(run.id)}
                  className={`p-3 rounded-lg border-2 cursor-pointer transition-all ${
                    selectedSupplyRunId === run.id
                      ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20'
                      : 'border-slate-200 dark:border-slate-700 hover:border-purple-300 dark:hover:border-purple-700'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-purple-600 dark:text-purple-400">
                      {run.scenario_name || 'baseline'}
                    </span>
                    {selectedSupplyRunId === run.id && (
                      <Check className="w-4 h-4 text-purple-600" />
                    )}
                  </div>
                  <div className="text-xs text-slate-500 space-y-1">
                    <div>
                      <span className="font-medium">Model:</span> {run.parameters?.model_version || 'supply_v1'}
                    </div>
                    <div>
                      <span className="font-medium">Plant:</span> {run.parameters?.plant_id || 'All'}
                    </div>
                    <div>
                      <span className="font-medium">History:</span> {run.parameters?.history_window_days || 90} days
                    </div>
                    <div>
                      <span className="font-medium">Buckets:</span> {run.parameters?.time_buckets?.length || 0}
                    </div>
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
      {selectedSupplyRunId && sfSupplierStats.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card className="p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
            <div className="text-2xl font-bold text-blue-600">
              {sfSupplierStats.length}
            </div>
            <div className="text-sm text-slate-600 dark:text-slate-400 mt-1">
              Suppliers Covered
            </div>
          </Card>
          <Card className="p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800">
            <div className="text-2xl font-bold text-green-600">
              {Math.round(sfSupplierStats.reduce((sum, s) => sum + (s.on_time_rate || 0), 0) / sfSupplierStats.length * 100)}%
            </div>
            <div className="text-sm text-slate-600 dark:text-slate-400 mt-1">
              Avg On-time Rate
            </div>
          </Card>
          <Card className="p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
            <div className="text-2xl font-bold text-amber-600">
              {supplyForecastData.filter(i => i.avg_delay_prob > 0.3).length}
            </div>
            <div className="text-sm text-slate-600 dark:text-slate-400 mt-1">
              High Delay Risk
            </div>
          </Card>
          <Card className="p-4 bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800">
            <div className="text-2xl font-bold text-purple-600">
              {Math.round(supplyForecastData.reduce((sum, i) => sum + i.p50_qty, 0)).toLocaleString()}
            </div>
            <div className="text-sm text-slate-600 dark:text-slate-400 mt-1">
              Total Inbound P50
            </div>
          </Card>
        </div>
      )}

      {/* Inbound Summary Table */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-semibold text-lg">Inbound Forecast Summary</h3>
            <p className="text-sm text-slate-500">
              {supplyForecastLoading ? 'Loading...' : `${supplyForecastData.length} Inbound Buckets total`}
            </p>
          </div>
        </div>

        {supplyForecastLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-purple-500" />
            <span className="ml-3 text-slate-600 dark:text-slate-400">Loading...</span>
          </div>
        ) : supplyForecastError ? (
          <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
            <p className="text-red-800 dark:text-red-200">{supplyForecastError}</p>
          </div>
        ) : supplyForecastData.length === 0 ? (
          <div className="py-12 text-center">
            <Package className="w-16 h-16 mx-auto text-slate-300 dark:text-slate-600 mb-4" />
            <h3 className="text-lg font-semibold text-slate-600 dark:text-slate-400 mb-2">
              No Supply Forecast Data
            </h3>
            <p className="text-sm text-slate-500">
              Please select a Supply Forecast Run
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 dark:bg-slate-800 sticky top-0">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">Material</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">Plant</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">Bucket</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">P50 Qty</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">P90 Qty</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">Avg Delay Prob</th>
                  <th className="px-3 py-2 text-center text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">Suppliers</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                {supplyForecastData.map((row, idx) => (
                  <tr
                    key={idx}
                    className={`hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer ${sfSelectedInbound === row.id ? 'bg-purple-50 dark:bg-purple-900/20' : ''}`}
                    onClick={() => {
                      setSfSelectedInbound(row.id);
                      loadInboundTrace(row.id);
                    }}
                  >
                    <td className="px-3 py-2 font-mono text-xs">{row.material_code}</td>
                    <td className="px-3 py-2 text-xs">{row.plant_id}</td>
                    <td className="px-3 py-2 font-mono text-xs">{row.time_bucket}</td>
                    <td className="px-3 py-2 text-right font-semibold">{row.p50_qty?.toLocaleString() || '0'}</td>
                    <td className="px-3 py-2 text-right text-slate-600">{row.p90_qty?.toLocaleString() || '-'}</td>
                    <td className="px-3 py-2 text-right">
                      <span className={row.avg_delay_prob > 0.3 ? 'text-red-600 font-semibold' : 'text-slate-600'}>
                        {(row.avg_delay_prob * 100).toFixed(0)}%
                      </span>
                    </td>
                    <td className="px-3 py-2 text-center">{row.supplier_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Trace Details Drawer */}
      {sfSelectedInbound && sfInboundTraces.length > 0 && (
        <Card className="bg-slate-50 dark:bg-slate-800/50">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-lg flex items-center gap-2">
                <Database className="w-5 h-5 text-purple-500" />
                Trace Details ({sfInboundTraces.length} PO Lines)
              </h3>
              <button
                onClick={() => setSfSelectedInbound(null)}
                className="text-sm text-slate-500 hover:text-purple-600"
              >
                Close
              </button>
            </div>
            <div className="max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-100 dark:bg-slate-800 sticky top-0">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-semibold uppercase">PO Line</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold uppercase">Supplier</th>
                    <th className="px-3 py-2 text-right text-xs font-semibold uppercase">Qty</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold uppercase">P50 Bucket</th>
                    <th className="px-3 py-2 text-right text-xs font-semibold uppercase">Delay Prob</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                  {sfInboundTraces.map((trace, idx) => (
                    <tr key={idx} className="hover:bg-white dark:hover:bg-slate-700">
                      <td className="px-3 py-2 font-mono text-xs">{trace.po_line_id}</td>
                      <td className="px-3 py-2 text-xs">{trace.supplier_id}</td>
                      <td className="px-3 py-2 text-right">{trace.contrib_qty?.toLocaleString()}</td>
                      <td className="px-3 py-2 font-mono text-xs">{trace.arrival_p50_bucket}</td>
                      <td className="px-3 py-2 text-right">
                        <span className={trace.delay_prob > 0.3 ? 'text-red-600' : 'text-slate-600'}>
                          {(trace.delay_prob * 100).toFixed(0)}%
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </Card>
      )}
    </>
  );
};

export default SupplyForecastTab;
