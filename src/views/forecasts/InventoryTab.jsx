/**
 * Inventory Tab - Inventory Projections & Probabilistic Forecast
 * Handles deterministic inventory projection, probabilistic Monte Carlo simulation,
 * inbound source selection, and expanded bucket series.
 *
 * @typedef {Object} InventoryTabProps
 * @property {Object} user - Current user object (must have .id)
 * @property {Function} addNotification - Notification callback (message, level)
 * @property {Array} forecastRuns - List of forecast runs from parent
 * @property {Function} loadForecastRuns - Callback to reload forecast runs
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  TrendingUp, Loader2, AlertTriangle, Check, ChevronDown, ChevronUp,
  Search, RefreshCw, Package, AlertCircle, Calendar, Hash, PlayCircle
} from 'lucide-react';
import { Card, Button, Badge } from '../../components/ui';
import { supplyForecastService } from '../../services/forecast/supplyForecastService';
import {
  loadInventoryProjection,
  computeSeriesForKey,
  FORECAST_WARN_ROWS,
  FORECAST_STOP_ROWS,
  FORECAST_TOP_N
} from '../../services/forecast/inventoryProjectionService';

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
 * @param {InventoryTabProps} props
 */
const InventoryTab = ({ user, addNotification, forecastRuns, loadForecastRuns }) => {
  // ========== Inventory Tab States ==========
  const [selectedRunId, setSelectedRunId] = useState(null);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [inventoryError, setInventoryError] = useState(null);
  const [inventoryMode, setInventoryMode] = useState('FULL'); // 'FULL' | 'WARN' | 'STOP'
  const [inventorySummaryRows, setInventorySummaryRows] = useState([]);
  const [inventoryKpis, setInventoryKpis] = useState({ itemsProjected: 0, atRiskItems: 0, earliestStockoutBucket: null, totalShortageQty: 0 });
  const [inventoryPerf, setInventoryPerf] = useState({ demandRows: 0, inboundRows: 0, snapshotRows: 0, totalRows: 0 });
  const [expandedKey, setExpandedKey] = useState(null);
  const [expandedSeries, setExpandedSeries] = useState([]);
  const [inventorySearchTerm, setInventorySearchTerm] = useState('');
  const projectionCacheRef = useRef(null);

  // Inbound source selection for Inventory tab
  const [inventoryInboundSource, setInventoryInboundSource] = useState('raw_po'); // 'raw_po' | 'supply_forecast'
  const [inventorySupplyRunId, setInventorySupplyRunId] = useState(null);
  const [supplyForecastRunsForInventory, setSupplyForecastRunsForInventory] = useState([]);

  // ========== Probabilistic Inventory Forecast States ==========
  const [inventoryProjectionMode, setInventoryProjectionMode] = useState('deterministic'); // 'deterministic' | 'probabilistic'
  const [probTrials, setProbTrials] = useState(200);
  const [probSeed, setProbSeed] = useState(12345);
  const [probLoading, setProbLoading] = useState(false);
  const [probSummaryRows, setProbSummaryRows] = useState([]);
  const [probSeriesData, setProbSeriesData] = useState([]);
  const [selectedProbKey, setSelectedProbKey] = useState(null);
  const [hasProbResults, setHasProbResults] = useState(false);

  // ========== Auto-select best run on mount ==========
  useEffect(() => {
    if (forecastRuns && forecastRuns.length > 0 && !selectedRunId) {
      const runWithBuckets = forecastRuns.find(r =>
        Array.isArray(r.parameters?.time_buckets) && r.parameters.time_buckets.length > 0
      );
      if (runWithBuckets) {
        setSelectedRunId(runWithBuckets.id);
      } else {
        setSelectedRunId(forecastRuns[0].id);
      }
    }
  }, [forecastRuns, selectedRunId]);

  // ========== Load inventory projection when run changes ==========
  useEffect(() => {
    if (selectedRunId && user?.id) {
      loadInventoryData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs only when run/user changes
  }, [selectedRunId, user]);

  /**
   * Load Inventory Projection data
   */
  const loadInventoryData = useCallback(async () => {
    if (!user?.id || !selectedRunId) return;

    setInventoryLoading(true);
    setInventoryError(null);
    setExpandedKey(null);
    setExpandedSeries([]);

    try {
      // Get selected run info
      const selectedRun = forecastRuns.find(r => r.id === selectedRunId);
      const runTimeBuckets = selectedRun?.parameters?.time_buckets || [];
      const runPlantId = selectedRun?.parameters?.plant_id || null;

      if (runTimeBuckets.length === 0) {
        setInventoryError('This Forecast Run has no valid time_buckets setting');
        setInventoryMode('STOP');
        setInventorySummaryRows([]);
        setInventoryKpis({ itemsProjected: 0, atRiskItems: 0, earliestStockoutBucket: null, totalShortageQty: 0 });
        return;
      }

      // Determine parameters based on inbound source
      const projectionOptions = {
        inboundSource: inventoryInboundSource,
        supplyForecastRunId: inventoryInboundSource === 'supply_forecast' ? inventorySupplyRunId : null
      };

      const result = await loadInventoryProjection(user.id, selectedRunId, runTimeBuckets, runPlantId, projectionOptions);

      setInventoryMode(result.mode);
      setInventorySummaryRows(result.summaryRows || []);
      setInventoryKpis(result.kpis);
      setInventoryPerf(result.perf);
      projectionCacheRef.current = result.cache;

      if (result.mode === 'STOP') {
        setInventoryError(result.reason === 'rows_too_large'
          ? `Rows too large (${result.perf.totalRows.toLocaleString()} > ${FORECAST_STOP_ROWS.toLocaleString()}), narrow the run and retry.`
          : `Unable to load projection data${result.reason ? `: ${result.reason}` : ''}`);
        return;
      }
    } catch (error) {
      console.error('Error loading inventory projection:', error);
      setInventoryError(`Failed to load inventory projection: ${error.message}`);
      setInventoryMode('STOP');
    } finally {
      setInventoryLoading(false);
    }
  }, [user?.id, selectedRunId, forecastRuns, inventoryInboundSource, inventorySupplyRunId]);

  /**
   * Toggle expand/collapse for a single key's bucket series
   */
  const handleToggleExpand = useCallback((key) => {
    if (expandedKey === key) {
      setExpandedKey(null);
      setExpandedSeries([]);
    } else {
      setExpandedKey(key);
      if (projectionCacheRef.current) {
        const series = computeSeriesForKey(projectionCacheRef.current, key);
        setExpandedSeries(series);
      } else {
        setExpandedSeries([]);
      }
    }
  }, [expandedKey]);

  /**
   * Load Supply Forecast Runs (for Inventory Tab)
   */
  const loadSupplyForecastRunsForInventory = async () => {
    if (!user?.id) return;

    try {
      const runs = await supplyForecastService.listRuns(user.id, { limit: 20 });
      setSupplyForecastRunsForInventory(runs || []);

      // Auto-select first run if available and none selected
      if (runs && runs.length > 0 && !inventorySupplyRunId) {
        setInventorySupplyRunId(runs[0].id);
      }
    } catch (error) {
      console.error('Error loading supply forecast runs for inventory:', error);
    }
  };

  /**
   * Handle inbound source switch
   */
  const handleInboundSourceChange = (source) => {
    setInventoryInboundSource(source);
    // Auto-load runs when switching to supply_forecast
    if (source === 'supply_forecast') {
      loadSupplyForecastRunsForInventory();
    }
  };

  /**
   * Run Probabilistic Inventory Forecast (Monte Carlo)
   */
  const handleRunProbForecast = async () => {
    if (!user?.id || !selectedRunId) {
      addNotification('Please select a Forecast Run first', 'error');
      return;
    }

    setProbLoading(true);

    try {
      // Dynamic import to avoid circular dependency
      const { inventoryProbForecastService } = await import('../../services/forecast/inventoryProbForecastService');

      const result = await inventoryProbForecastService.run(
        user.id,
        selectedRunId,
        {
          trials: probTrials,
          seed: probSeed,
          inboundSource: inventoryInboundSource,
          demandSource: 'uploaded' // Will be read from BOM run parameters
        }
      );

      if (result.mode === 'failed') {
        addNotification(`Probabilistic forecast failed: ${result.reason}`, 'error');
      } else {
        addNotification(
          `Monte Carlo complete! Avg P(stockout): ${(result.kpis?.avgPStockout * 100).toFixed(1)}%, ${result.kpis?.keysAtRisk} keys at risk`,
          'success'
        );
        setHasProbResults(true);
        // Load the results
        await loadProbResults();
      }
    } catch (error) {
      console.error('Error running probabilistic forecast:', error);
      addNotification(`Monte Carlo failed: ${error.message}`, 'error');
    } finally {
      setProbLoading(false);
    }
  };

  /**
   * Load probabilistic forecast results
   */
  const loadProbResults = async () => {
    if (!user?.id || !selectedRunId) return;

    try {
      const { inventoryProbForecastService } = await import('../../services/forecast/inventoryProbForecastService');

      // Check if results exist
      const hasResults = await inventoryProbForecastService.hasResults(user.id, selectedRunId);
      setHasProbResults(hasResults);

      if (hasResults) {
        const summary = await inventoryProbForecastService.getSummaryByRun(user.id, selectedRunId);
        setProbSummaryRows(summary || []);
      }
    } catch (error) {
      console.error('Error loading prob results:', error);
    }
  };

  /**
   * Load probabilistic series for a key
   */
  const loadProbSeriesForKey = async (materialCode, plantId) => {
    if (!user?.id || !selectedRunId) return;

    try {
      const { inventoryProbForecastService } = await import('../../services/forecast/inventoryProbForecastService');
      const series = await inventoryProbForecastService.getSeriesByRun(
        user.id,
        selectedRunId,
        materialCode,
        plantId
      );
      setProbSeriesData(series || []);
      setSelectedProbKey(`${materialCode}|${plantId}`);
    } catch (error) {
      console.error('Error loading prob series:', error);
    }
  };

  /**
   * Handle forecast run selection
   */
  const handleRunSelect = (runId) => {
    setSelectedRunId(runId);
    setExpandedKey(null);
    setExpandedSeries([]);
  };

  /**
   * Filtered inventory summary rows
   */
  const filteredInventoryRows = inventorySummaryRows.filter(row => {
    if (!inventorySearchTerm) return true;
    const term = inventorySearchTerm.toLowerCase();
    return row.key.toLowerCase().includes(term);
  }).slice(0, FORECAST_TOP_N);

  return (
    <>
      {/* Run Selector */}
      <Card>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-lg flex items-center gap-2">
              <Calendar className="w-5 h-5 text-purple-500" />
              Select Forecast Run
            </h3>
            <Button
              onClick={() => loadForecastRuns(true)}
              variant="secondary"
              size="sm"
              icon={RefreshCw}
            >
              Refresh
            </Button>
          </div>

          {forecastRuns.length === 0 ? (
            <div className="py-6 text-center text-slate-500">
              <p>No Forecast Runs yet</p>
              <p className="text-sm mt-1">Please run BOM Explosion first</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {forecastRuns.slice(0, 9).map(run => (
                <div
                  key={run.id}
                  onClick={() => handleRunSelect(run.id)}
                  className={`p-3 rounded-lg border-2 cursor-pointer transition-all ${
                    selectedRunId === run.id
                      ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20'
                      : 'border-slate-200 dark:border-slate-700 hover:border-purple-300 dark:hover:border-purple-700'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-purple-600 dark:text-purple-400">
                      {run.scenario_name || 'baseline'}
                    </span>
                    {selectedRunId === run.id && (
                      <Check className="w-4 h-4 text-purple-600" />
                    )}
                  </div>
                  <div className="text-xs text-slate-500 space-y-1">
                    <div>
                      <span className="font-medium">Plant:</span> {run.parameters?.plant_id || 'All'}
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

      {/* Inbound Source Selector */}
      <Card>
        <div className="space-y-4">
          <h3 className="font-semibold text-lg flex items-center gap-2">
            <Package className="w-5 h-5 text-purple-500" />
            Inbound Source
          </h3>

          <div className="flex gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                value="raw_po"
                checked={inventoryInboundSource === 'raw_po'}
                onChange={(e) => handleInboundSourceChange(e.target.value)}
                className="w-4 h-4 text-purple-600"
              />
              <span className="text-sm">Raw PO Open Lines</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                value="supply_forecast"
                checked={inventoryInboundSource === 'supply_forecast'}
                onChange={(e) => handleInboundSourceChange(e.target.value)}
                className="w-4 h-4 text-purple-600"
              />
              <span className="text-sm">Supply Forecast</span>
            </label>
          </div>

          {/* Supply Forecast Run Selector */}
          {inventoryInboundSource === 'supply_forecast' && (
            <div className="space-y-2 pt-2 border-t dark:border-slate-700">
              <label className="block text-sm font-medium">
                Select Supply Forecast Run
              </label>
              <select
                value={inventorySupplyRunId || ''}
                onChange={(e) => setInventorySupplyRunId(e.target.value || null)}
                className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 focus:ring-2 focus:ring-purple-500 outline-none"
              >
                <option value="">
                  {supplyForecastRunsForInventory.length === 0 ? 'No supply forecast runs' : 'Select a run...'}
                </option>
                {supplyForecastRunsForInventory.map(run => (
                  <option key={run.id} value={run.id}>
                    {run.scenario_name || 'baseline'} - {run.parameters?.model_version || 'supply_v1'} ({run.parameters?.time_buckets?.length || 0} buckets) - {formatDate(run.created_at)}
                  </option>
                ))}
              </select>
              {supplyForecastRunsForInventory.length === 0 && (
                <p className="text-xs text-amber-600">
                  No supply forecast runs found. Please run Supply Forecast first.
                </p>
              )}
            </div>
          )}

          {/* Reload Button */}
          {selectedRunId && (
            <div className="flex justify-end">
              <Button
                onClick={loadInventoryData}
                variant="secondary"
                size="sm"
                icon={RefreshCw}
                disabled={inventoryLoading || (inventoryInboundSource === 'supply_forecast' && !inventorySupplyRunId)}
              >
                {inventoryLoading ? 'Loading...' : 'Reload Projection'}
              </Button>
            </div>
          )}
        </div>
      </Card>

      {/* Probabilistic Mode Controls */}
      <Card>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-lg flex items-center gap-2">
              <TrendingUp className="w-5 h-5 text-purple-500" />
              Projection Mode
            </h3>
            <Badge variant={inventoryProjectionMode === 'probabilistic' ? 'purple' : 'blue'}>
              {inventoryProjectionMode === 'probabilistic' ? 'Monte Carlo' : 'Deterministic'}
            </Badge>
          </div>

          {/* Mode Toggle */}
          <div className="flex gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                value="deterministic"
                checked={inventoryProjectionMode === 'deterministic'}
                onChange={(e) => setInventoryProjectionMode(e.target.value)}
                className="w-4 h-4 text-purple-600"
              />
              <span className="text-sm">Deterministic</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                value="probabilistic"
                checked={inventoryProjectionMode === 'probabilistic'}
                onChange={(e) => setInventoryProjectionMode(e.target.value)}
                className="w-4 h-4 text-purple-600"
              />
              <span className="text-sm">Probabilistic (Monte Carlo)</span>
            </label>
          </div>

          {/* Probabilistic Controls */}
          {inventoryProjectionMode === 'probabilistic' && (
            <div className="space-y-4 pt-4 border-t dark:border-slate-700">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="block text-sm font-medium">Trials</label>
                  <select
                    value={probTrials}
                    onChange={(e) => setProbTrials(parseInt(e.target.value))}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800"
                    disabled={probLoading}
                  >
                    <option value={200}>200 (Fast)</option>
                    <option value={500}>500 (Balanced)</option>
                    <option value={1000}>1000 (Accurate)</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <label className="block text-sm font-medium">Seed (optional)</label>
                  <input
                    type="number"
                    value={probSeed}
                    onChange={(e) => setProbSeed(parseInt(e.target.value) || 12345)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800"
                    disabled={probLoading}
                  />
                </div>
              </div>

              <div className="flex justify-between items-center">
                <p className="text-xs text-slate-500">
                  Monte Carlo simulation with lognormal demand sampling and 2-point arrival mixing.
                </p>
                <Button
                  onClick={handleRunProbForecast}
                  disabled={probLoading || !selectedRunId}
                  variant="primary"
                  size="sm"
                  icon={probLoading ? Loader2 : PlayCircle}
                >
                  {probLoading ? 'Running MC...' : hasProbResults ? 'Re-Run Monte Carlo' : 'Run Monte Carlo'}
                </Button>
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* Performance Warning Banner */}
      {inventoryMode === 'WARN' && (
        <div className="p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div>
              <h4 className="font-semibold text-amber-900 dark:text-amber-100">
                Large data volume, may affect performance
              </h4>
              <p className="text-sm text-amber-800 dark:text-amber-200 mt-1">
                Currently loaded {inventoryPerf.totalRows.toLocaleString()} rows (exceeds {FORECAST_WARN_ROWS.toLocaleString()} warning threshold).
                Only showing top {FORECAST_TOP_N} risk items.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Error Display */}
      {inventoryError && (
        <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
            <div>
              <h4 className="font-semibold text-red-900 dark:text-red-100">
                Load Failed
              </h4>
              <p className="text-sm text-red-800 dark:text-red-200 mt-1">
                {inventoryError}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* KPI Cards */}
      {selectedRunId && !inventoryError && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card className="p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
            <div className="flex items-center gap-2 mb-2">
              <Hash className="w-4 h-4 text-blue-600" />
              <span className="text-xs font-medium text-blue-600">Items Projected</span>
            </div>
            <div className="text-2xl font-bold text-blue-700 dark:text-blue-300">
              {inventoryLoading ? '...' : inventoryKpis.itemsProjected.toLocaleString()}
            </div>
          </Card>

          <Card className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="w-4 h-4 text-red-600" />
              <span className="text-xs font-medium text-red-600">At-Risk Items</span>
            </div>
            <div className="text-2xl font-bold text-red-700 dark:text-red-300">
              {inventoryLoading ? '...' : inventoryKpis.atRiskItems.toLocaleString()}
            </div>
          </Card>

          <Card className="p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
            <div className="flex items-center gap-2 mb-2">
              <Calendar className="w-4 h-4 text-amber-600" />
              <span className="text-xs font-medium text-amber-600">Earliest Stockout</span>
            </div>
            <div className="text-lg font-bold text-amber-700 dark:text-amber-300 truncate">
              {inventoryLoading ? '...' : (inventoryKpis.earliestStockoutBucket || 'None')}
            </div>
          </Card>

          <Card className="p-4 bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800">
            <div className="flex items-center gap-2 mb-2">
              <Package className="w-4 h-4 text-purple-600" />
              <span className="text-xs font-medium text-purple-600">Total Shortage</span>
            </div>
            <div className="text-2xl font-bold text-purple-700 dark:text-purple-300">
              {inventoryLoading ? '...' : inventoryKpis.totalShortageQty.toLocaleString()}
            </div>
          </Card>
        </div>
      )}

      {/* Summary Table */}
      {selectedRunId && !inventoryError && (
        <Card>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold text-lg">Inventory Projection Summary</h3>
              <p className="text-sm text-slate-500">
                {inventoryLoading ? 'Loading...' : `${inventorySummaryRows.length} keys total (showing top ${Math.min(filteredInventoryRows.length, FORECAST_TOP_N)})`}
              </p>
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                placeholder="Search Key (MATERIAL|PLANT)..."
                value={inventorySearchTerm}
                onChange={(e) => setInventorySearchTerm(e.target.value)}
                className="pl-9 pr-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 focus:ring-2 focus:ring-purple-500 outline-none w-64"
              />
            </div>
          </div>

          {inventoryLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-8 h-8 animate-spin text-purple-500" />
              <span className="ml-3 text-slate-600 dark:text-slate-400">Loading projection data...</span>
            </div>
          ) : filteredInventoryRows.length === 0 ? (
            <div className="py-12 text-center">
              <Package className="w-16 h-16 mx-auto text-slate-300 dark:text-slate-600 mb-4" />
              <h3 className="text-lg font-semibold text-slate-600 dark:text-slate-400 mb-2">
                No Projection Data
              </h3>
              <p className="text-sm text-slate-500">
                {inventorySearchTerm ? 'Please adjust search criteria' : 'Selected run has no component_demand data'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-100 dark:bg-slate-800 sticky top-0">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-slate-600 dark:text-slate-400 w-8"></th>
                    <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">Key</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">Stockout Bucket</th>
                    <th className="px-3 py-2 text-right text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">Shortage Qty</th>
                    <th className="px-3 py-2 text-right text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">Min Available</th>
                    <th className="px-3 py-2 text-right text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">Start On-Hand</th>
                    <th className="px-3 py-2 text-right text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">Total Demand</th>
                    <th className="px-3 py-2 text-right text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">Total Inbound</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                  {filteredInventoryRows.map((row, _idx) => (
                    <React.Fragment key={row.key}>
                      <tr
                        className={`hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer ${
                          row.shortageQty > 0 ? 'bg-red-50/50 dark:bg-red-900/10' : ''
                        }`}
                        onClick={() => handleToggleExpand(row.key)}
                      >
                        <td className="px-3 py-2 text-slate-500">
                          {expandedKey === row.key ? (
                            <ChevronUp className="w-4 h-4" />
                          ) : (
                            <ChevronDown className="w-4 h-4" />
                          )}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">
                          {row.key}
                        </td>
                        <td className="px-3 py-2">
                          {row.stockoutBucket ? (
                            <Badge variant="red">{row.stockoutBucket}</Badge>
                          ) : (
                            <span className="text-slate-400">-</span>
                          )}
                        </td>
                        <td className={`px-3 py-2 text-right font-medium ${row.shortageQty > 0 ? 'text-red-600' : 'text-slate-600 dark:text-slate-400'}`}>
                          {row.shortageQty.toLocaleString()}
                        </td>
                        <td className={`px-3 py-2 text-right ${row.minAvailable < 0 ? 'text-red-600 font-medium' : ''}`}>
                          {row.minAvailable.toLocaleString()}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {row.startOnHand.toLocaleString()}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {row.totalDemand.toLocaleString()}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {row.totalInbound.toLocaleString()}
                        </td>
                      </tr>

                      {/* Expanded Series */}
                      {expandedKey === row.key && expandedSeries.length > 0 && (
                        <tr>
                          <td colSpan={8} className="px-3 py-2 bg-slate-50 dark:bg-slate-800/50">
                            <div className="ml-6 p-3 border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900">
                              <h4 className="text-sm font-semibold mb-2 text-slate-700 dark:text-slate-300">
                                Bucket Series (verify: end = begin + inbound - demand)
                              </h4>
                              <div className="overflow-x-auto">
                                <table className="w-full text-xs">
                                  <thead className="bg-slate-100 dark:bg-slate-800">
                                    <tr>
                                      <th className="px-2 py-1.5 text-left font-semibold">Bucket</th>
                                      <th className="px-2 py-1.5 text-right font-semibold">Begin</th>
                                      <th className="px-2 py-1.5 text-right font-semibold">Inbound</th>
                                      <th className="px-2 py-1.5 text-right font-semibold">Demand</th>
                                      <th className="px-2 py-1.5 text-right font-semibold">End</th>
                                      <th className="px-2 py-1.5 text-right font-semibold">Available</th>
                                      <th className="px-2 py-1.5 text-center font-semibold">Shortage</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                                    {expandedSeries.map((s, _sIdx) => (
                                      <tr
                                        key={s.bucket}
                                        className={s.shortageFlag ? 'bg-red-50 dark:bg-red-900/20' : ''}
                                      >
                                        <td className="px-2 py-1.5 font-mono">{s.bucket}</td>
                                        <td className="px-2 py-1.5 text-right">{s.begin.toLocaleString()}</td>
                                        <td className="px-2 py-1.5 text-right text-green-600">{s.inbound > 0 ? `+${s.inbound.toLocaleString()}` : s.inbound}</td>
                                        <td className="px-2 py-1.5 text-right text-orange-600">{s.demand > 0 ? `-${s.demand.toLocaleString()}` : s.demand}</td>
                                        <td className="px-2 py-1.5 text-right font-medium">{s.end.toLocaleString()}</td>
                                        <td className={`px-2 py-1.5 text-right ${s.available < 0 ? 'text-red-600 font-medium' : ''}`}>
                                          {s.available.toLocaleString()}
                                        </td>
                                        <td className="px-2 py-1.5 text-center">
                                          {s.shortageFlag ? (
                                            <AlertTriangle className="w-4 h-4 text-red-600 mx-auto" />
                                          ) : (
                                            <span className="text-slate-400">-</span>
                                          )}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Performance Info Footer */}
          {!inventoryLoading && inventorySummaryRows.length > 0 && (
            <div className="mt-4 pt-4 border-t dark:border-slate-700 text-xs text-slate-500 flex items-center justify-between">
              <div>
                Demand: {inventoryPerf.demandRows.toLocaleString()} rows |
                Inbound: {inventoryPerf.inboundRows.toLocaleString()} rows |
                Snapshots: {inventoryPerf.snapshotRows.toLocaleString()} rows
              </div>
              <div>
                Fetch: {inventoryPerf.fetchMs}ms | Compute: {inventoryPerf.computeMs}ms | Keys: {inventoryPerf.keys}
              </div>
            </div>
          )}
        </Card>
      )}

      {/* Probabilistic Summary Table */}
      {inventoryProjectionMode === 'probabilistic' && hasProbResults && (
        <Card>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold text-lg flex items-center gap-2">
                <TrendingUp className="w-5 h-5 text-purple-500" />
                Probabilistic Inventory Summary (Monte Carlo)
              </h3>
              <p className="text-sm text-slate-500">
                {probSummaryRows.length} keys | {probTrials} trials | Seed: {probSeed}
              </p>
            </div>
            <Button
              onClick={loadProbResults}
              variant="secondary"
              size="sm"
              icon={RefreshCw}
            >
              Refresh
            </Button>
          </div>

          {probSummaryRows.length === 0 ? (
            <div className="py-12 text-center">
              <TrendingUp className="w-16 h-16 mx-auto text-slate-300 dark:text-slate-600 mb-4" />
              <h3 className="text-lg font-semibold text-slate-600 dark:text-slate-400 mb-2">
                No Monte Carlo Results
              </h3>
              <p className="text-sm text-slate-500">
                Run Monte Carlo simulation to see probabilistic projections
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-100 dark:bg-slate-800 sticky top-0">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">Key</th>
                    <th className="px-3 py-2 text-right text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">P(Stockout)</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">Stockout P50</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">Stockout P90</th>
                    <th className="px-3 py-2 text-right text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">Expected Shortage</th>
                    <th className="px-3 py-2 text-right text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">Exp. Min Available</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                  {probSummaryRows.slice(0, 20).map((row, idx) => (
                    <tr
                      key={row.id || idx}
                      className={`hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer ${selectedProbKey === `${row.material_code}|${row.plant_id}` ? 'bg-purple-50 dark:bg-purple-900/20' : ''}`}
                      onClick={() => loadProbSeriesForKey(row.material_code, row.plant_id)}
                    >
                      <td className="px-3 py-2 font-mono text-xs">
                        {row.material_code}|{row.plant_id}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <span className={row.p_stockout > 0.5 ? 'text-red-600 font-semibold' : row.p_stockout > 0.2 ? 'text-amber-600' : 'text-green-600'}>
                          {(row.p_stockout * 100).toFixed(1)}%
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        {row.stockout_bucket_p50 ? (
                          <Badge variant="amber">{row.stockout_bucket_p50}</Badge>
                        ) : (
                          <span className="text-slate-400">-</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {row.stockout_bucket_p90 ? (
                          <Badge variant="red">{row.stockout_bucket_p90}</Badge>
                        ) : (
                          <span className="text-slate-400">-</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {row.expected_shortage_qty > 0 ? (
                          <span className="text-red-600">{row.expected_shortage_qty.toLocaleString()}</span>
                        ) : (
                          <span className="text-slate-400">-</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {row.expected_min_available?.toLocaleString() || '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {probSummaryRows.length > 20 && (
                <p className="text-xs text-slate-500 mt-2 text-center">
                  Showing top 20 of {probSummaryRows.length} keys by P(stockout)
                </p>
              )}
            </div>
          )}

          {/* Fan Chart for Selected Key */}
          {selectedProbKey && probSeriesData.length > 0 && (
            <div className="mt-6 pt-6 border-t dark:border-slate-700">
              <h4 className="text-sm font-semibold mb-3 text-slate-700 dark:text-slate-300">
                Inventory Fan Chart: {selectedProbKey}
              </h4>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-100 dark:bg-slate-800">
                    <tr>
                      <th className="px-2 py-1.5 text-left font-semibold">Bucket</th>
                      <th className="px-2 py-1.5 text-right font-semibold">P10</th>
                      <th className="px-2 py-1.5 text-right font-semibold">P50</th>
                      <th className="px-2 py-1.5 text-right font-semibold">P90</th>
                      <th className="px-2 py-1.5 text-right font-semibold">P(Stockout)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                    {probSeriesData.map((s, idx) => (
                      <tr
                        key={idx}
                        className={s.p_stockout_bucket > 0.5 ? 'bg-red-50 dark:bg-red-900/20' : s.p_stockout_bucket > 0.2 ? 'bg-amber-50 dark:bg-amber-900/10' : ''}
                      >
                        <td className="px-2 py-1.5 font-mono">{s.time_bucket}</td>
                        <td className="px-2 py-1.5 text-right text-slate-600">{s.inv_p10?.toLocaleString() || '-'}</td>
                        <td className="px-2 py-1.5 text-right font-medium">{s.inv_p50?.toLocaleString() || '-'}</td>
                        <td className="px-2 py-1.5 text-right text-slate-600">{s.inv_p90?.toLocaleString() || '-'}</td>
                        <td className="px-2 py-1.5 text-right">
                          <span className={s.p_stockout_bucket > 0.5 ? 'text-red-600 font-semibold' : s.p_stockout_bucket > 0.2 ? 'text-amber-600' : 'text-green-600'}>
                            {(s.p_stockout_bucket * 100).toFixed(0)}%
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </Card>
      )}
    </>
  );
};

export default InventoryTab;
