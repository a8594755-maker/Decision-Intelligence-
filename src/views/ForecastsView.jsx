/**
 * Forecasts View - Component Forecast (BOM-Derived)
 * BOM Explosion main page: Run calculation -> Select batch -> View results (Results + Trace + Inventory)
 *
 * This is the shell component that:
 * - Manages the tab bar and tab switching (via useUrlTabState)
 * - Manages shared state: batches, selectedBatchId, loadingBatches, forecastRuns
 * - Contains the "Run BOM Explosion" form and batch selector
 * - Renders tab components conditionally based on activeTab
 *
 * Tab components:
 * - ResultsTab: BOM explosion results and trace (activeTab = 'results' | 'trace')
 * - InventoryTab: Inventory projections and probabilistic forecast
 * - DemandForecastTab: Demand forecast, dual model, material selection
 * - SupplyForecastTab: Supply forecast, supplier stats, inbound traces
 * - CostForecastTab: Cost forecast, rule sets, KPIs
 * - RevenueForecastTab: Revenue forecast, margin at risk, terms
 */

import React, { useState, useEffect } from 'react';
import {
  TrendingUp, PlayCircle, Loader2, AlertTriangle, Check, ChevronDown, ChevronUp,
  RefreshCw, Package, DollarSign
} from 'lucide-react';
import { Card, Button } from '../components/ui';
import { executeBomExplosion, pollBomExplosionStatus } from '../services/planning/bomExplosionService';
import {
  componentDemandService,
  forecastRunsService
} from '../services/infra/supabaseClient';
import { importBatchesService } from '../services/data-prep/importHistoryService';
import { useUrlTabState } from '../hooks/useUrlTabState';

// Tab components
import ResultsTab from './forecasts/ResultsTab';
import InventoryTab from './forecasts/InventoryTab';
import DemandForecastTab from './forecasts/DemandForecastTab';
import SupplyForecastTab from './forecasts/SupplyForecastTab';
import CostForecastTab from './forecasts/CostForecastTab';
import RevenueForecastTab from './forecasts/RevenueForecastTab';

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

const ForecastsView = ({ user, addNotification }) => {
  // ========== Run Section States ==========
  const [plantId, setPlantId] = useState('');
  const [timeBuckets, setTimeBuckets] = useState('');
  const [runLoading, setRunLoading] = useState(false);
  const [runResult, setRunResult] = useState(null);
  const [runError, setRunError] = useState(null);
  const [showRunErrors, setShowRunErrors] = useState(false);

  // ========== BOM Explosion Input Source States ==========
  const [demandSource, setDemandSource] = useState('demand_fg'); // 'demand_fg' | 'demand_forecast'
  const [selectedBomDemandRunId, setSelectedBomDemandRunId] = useState(null);
  const [bomInboundSource, setBomInboundSource] = useState('raw_po'); // 'raw_po' | 'supply_forecast'
  const [selectedBomSupplyRunId, setSelectedBomSupplyRunId] = useState(null);

  // ========== Batch Selector States ==========
  const [batches, setBatches] = useState([]);
  const [selectedBatchId, setSelectedBatchId] = useState(null);
  const [loadingBatches, setLoadingBatches] = useState(false);

  // ========== Tab State (synced to URL) ==========
  const [activeTab, setActiveTab] = useUrlTabState('results', 'tab', ['results', 'trace', 'inventory', 'demand_forecast', 'supply_forecast', 'cost_forecast', 'revenue_forecast']);

  // ========== Shared Forecast Runs (for Inventory Tab) ==========
  const [forecastRuns, setForecastRuns] = useState([]);

  // ========== Demand Forecast Runs (for BOM Explosion demand source selector) ==========
  const [demandForecastRuns, setDemandForecastRuns] = useState([]);

  // ========== Supply Forecast Runs (for BOM Explosion inbound source selector) ==========
  const [supplyForecastRuns, setSupplyForecastRuns] = useState([]);

  // ========== Load batches and forecast runs on mount ==========
  useEffect(() => {
    if (user?.id) {
      loadBatches();
      loadForecastRuns();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs only when user changes
  }, [user]);

  // ========== Load demand forecast runs for BOM Explosion section ==========
  useEffect(() => {
    if (demandSource === 'demand_forecast' && user?.id) {
      loadDemandForecastRunsForBom();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs only when demand source/user changes
  }, [demandSource, user?.id]);

  // ========== Load supply forecast runs for BOM Explosion section ==========
  useEffect(() => {
    if (bomInboundSource === 'supply_forecast' && user?.id) {
      loadSupplyForecastRunsForBom();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs only when inbound source/user changes
  }, [bomInboundSource, user?.id]);

  /**
   * Load BOM Explosion batch list
   */
  const loadBatches = async () => {
    if (!user?.id) return;

    setLoadingBatches(true);
    try {
      const allBatches = await importBatchesService.getAllBatches(user.id, {
        limit: 50
      });

      // Filter bom_explosion batches (target_table or upload_type) with status='completed'
      const bomBatches = allBatches
        .filter(b => (b.target_table === 'bom_explosion' || b.upload_type === 'bom_explosion') && b.status === 'completed')
        .slice(0, 10); // Latest 10 records

      setBatches(bomBatches);

      // Default to latest batch
      if (bomBatches.length > 0 && !selectedBatchId) {
        setSelectedBatchId(bomBatches[0].id);
      }
    } catch (error) {
      console.error('Error loading batches:', error);
      addNotification(`Failed to load batch list: ${error.message}`, 'error');
    } finally {
      setLoadingBatches(false);
    }
  };

  /**
   * Load Forecast Runs list (for Inventory Tab)
   */
  const loadForecastRuns = async (_forceReselect = false) => {
    if (!user?.id) return;

    try {
      const runs = await forecastRunsService.listRuns(user.id, { limit: 20 });
      setForecastRuns(runs || []);
    } catch (error) {
      console.error('Error loading forecast runs:', error);
    }
  };

  /**
   * Load demand forecast runs for BOM Explosion demand source dropdown
   */
  const loadDemandForecastRunsForBom = async () => {
    if (!user?.id) return;

    try {
      const runs = await forecastRunsService.listRuns(user.id, { limit: 30 });
      const dfRuns = (runs || []).filter(r => r.parameters?.kind === 'demand_forecast');
      setDemandForecastRuns(dfRuns);
    } catch (error) {
      console.error('Error loading demand forecast runs:', error);
    }
  };

  /**
   * Load supply forecast runs for BOM Explosion inbound source dropdown
   */
  const loadSupplyForecastRunsForBom = async () => {
    if (!user?.id) return;

    try {
      const runs = await forecastRunsService.listRuns(user.id, { limit: 30 });
      const sfRuns = (runs || []).filter(r => r.parameters?.kind === 'supply_forecast');
      setSupplyForecastRuns(sfRuns);
    } catch (error) {
      console.error('Error loading supply forecast runs:', error);
    }
  };

  /**
   * Handle tab switch
   */
  const handleTabSwitch = (tab) => {
    setActiveTab(tab);
  };

  /**
   * Handle batch selection
   */
  const handleBatchSelect = (batchId) => {
    setSelectedBatchId(batchId);
    setRunResult(null); // Clear run result when switching batches
  };

  /**
   * Execute BOM Explosion - Edge Function two-phase flow
   * 1. Start Edge Function job (immediately returns batchId)
   * 2. Poll import_batches status until completed/failed
   */
  const handleRunBomExplosion = async () => {
    if (!user?.id) {
      addNotification('Please log in first', 'error');
      return;
    }

    setRunLoading(true);
    setRunError(null);
    setRunResult(null);

    try {
      // Parse time buckets
      const timeBucketsFilter = timeBuckets.trim()
        ? timeBuckets.split(',').map(t => t.trim()).filter(Boolean)
        : null;

      const plantIdFilter = plantId.trim() || null;

      // Step 1: Start Edge Function job
      console.log('Starting BOM Explosion via Edge Function:', {
        plantId: plantIdFilter,
        timeBuckets: timeBucketsFilter,
        demandSource,
        demandForecastRunId: demandSource === 'demand_forecast' ? selectedBomDemandRunId : null
      });

      let startResult = await executeBomExplosion({
        filename: `BOM Explosion - ${plantIdFilter || 'All Plants'} - ${new Date().toISOString()}`,
        metadata: {
          plant_id: plantIdFilter,
          time_buckets: timeBucketsFilter,
          source: 'forecasts_page',
          demand_source: demandSource,
          input_demand_forecast_run_id: demandSource === 'demand_forecast' ? selectedBomDemandRunId : null,
          input_inbound_source: bomInboundSource,
          input_supply_forecast_run_id: bomInboundSource === 'supply_forecast' ? selectedBomSupplyRunId : null
        },
        scenarioName: 'baseline',
        demandSource: demandSource,
        inputDemandForecastRunId: demandSource === 'demand_forecast' ? selectedBomDemandRunId : null,
        inboundSource: bomInboundSource,
        inputSupplyForecastRunId: bomInboundSource === 'supply_forecast' ? selectedBomSupplyRunId : null
      });

      console.log('Edge Function job started:', startResult);

      // Step 1.5: If reused, verify data actually exists -- stale cache detection
      if (startResult.status === 'reused' && startResult.batchId) {
        const verifyResult = await componentDemandService.getComponentDemandsByBatch(
          user.id, startResult.batchId, { limit: 1, offset: 0 }
        );
        console.log('[BOM] Reuse verification:', { batchId: startResult.batchId, actualCount: verifyResult.count });

        if (!verifyResult.count || verifyResult.count === 0) {
          console.warn('[BOM] Reused batch has 0 component_demand rows -- forcing new run');
          addNotification('Cached data expired, recalculating...', 'info');
          startResult = await executeBomExplosion({
            filename: `BOM Explosion - ${plantIdFilter || 'All Plants'} - ${new Date().toISOString()}`,
            metadata: {
              plant_id: plantIdFilter,
              time_buckets: timeBucketsFilter,
              source: 'forecasts_page',
              demand_source: demandSource,
              input_demand_forecast_run_id: demandSource === 'demand_forecast' ? selectedBomDemandRunId : null,
              input_inbound_source: bomInboundSource,
              input_supply_forecast_run_id: bomInboundSource === 'supply_forecast' ? selectedBomSupplyRunId : null
            },
            scenarioName: 'baseline',
            demandSource: demandSource,
            inputDemandForecastRunId: demandSource === 'demand_forecast' ? selectedBomDemandRunId : null,
            inboundSource: bomInboundSource,
            inputSupplyForecastRunId: bomInboundSource === 'supply_forecast' ? selectedBomSupplyRunId : null,
            forceNewRun: true
          });
          console.log('Edge Function forced new run:', startResult);
        }
      }

      // Step 2: Start polling status
      addNotification(
        `BOM Explosion calculating... (Batch: ${startResult.batchId.slice(0, 8)})`,
        'info'
      );

      const callbacks = {
        onProgress: (status, metadata) => {
          console.log(`BOM Explosion progress: ${status}`, metadata);
          // Optional: update UI to show progress
          if (status === 'running') {
            // Show calculating status
          }
        },
        onComplete: (result) => {
          console.log('BOM Explosion completed:', result);
        },
        onError: (error) => {
          console.error('BOM Explosion failed during polling:', error);
        }
      };

      const finalResult = await pollBomExplosionStatus(
        startResult.batchId,
        callbacks,
        60,  // maxAttempts: 60 * 2s = 2 minutes
        2000 // intervalMs: 2 seconds
      );

      // Step 3: Handle result
      setRunResult(finalResult);

      if (finalResult.success) {
        const errorCount = finalResult.errors?.length || 0;
        if (errorCount > 0) {
          addNotification(
            `BOM Explosion complete! Generated ${finalResult.componentDemandCount} component demands, but with ${errorCount} warnings`,
            'warning'
          );
        } else {
          addNotification(
            `BOM Explosion complete! Generated ${finalResult.componentDemandCount} component demands, ${finalResult.traceCount} trace records`,
            'success'
          );
        }

        // Backfill time_buckets into the new forecast_run (deployed Edge Function may not set them)
        if (finalResult.forecastRunId) {
          try {
            const demandResult = await componentDemandService.getComponentDemandsByBatch(
              user.id, startResult.batchId, { limit: 500, offset: 0 }
            );
            if (demandResult.data?.length > 0) {
              const actualBuckets = [...new Set(demandResult.data.map(r => r.time_bucket))].sort();
              if (actualBuckets.length > 0) {
                const runData = await forecastRunsService.getRun(finalResult.forecastRunId);
                const currentParams = runData?.parameters || {};
                if (!Array.isArray(currentParams.time_buckets) || currentParams.time_buckets.length === 0) {
                  await forecastRunsService.updateRun(finalResult.forecastRunId, {
                    parameters: { ...currentParams, time_buckets: actualBuckets, horizon_buckets: actualBuckets.length }
                  });
                  console.log('[BOM] Backfilled time_buckets into forecast_run:', actualBuckets);
                }
              }
            }
          } catch (e) {
            console.warn('[BOM] Failed to backfill time_buckets:', e);
          }
        }

        // Reload batches and select the new one
        await loadBatches();
        setSelectedBatchId(startResult.batchId);

        // Reload forecast runs so Inventory tab can use the updated run (force re-select best run)
        await loadForecastRuns(true);
      } else {
        addNotification(
          `BOM Explosion failed: ${finalResult.error}`,
          'error'
        );
        setRunError(finalResult.error || 'BOM Explosion execution failed');
      }

    } catch (error) {
      console.error('BOM Explosion failed:', error);
      const errorMsg = error.message || 'BOM Explosion execution failed';
      setRunError(errorMsg);
      addNotification(`BOM Explosion execution failed: ${errorMsg}`, 'error');
    } finally {
      setRunLoading(false);
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h2 className="text-xl md:text-2xl font-bold flex items-center gap-2">
            <TrendingUp className="w-6 h-6 text-purple-500" />
            Component Forecast (BOM-Derived)
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            Run BOM Explosion calculations, view and manage component demand forecasts
          </p>
        </div>
      </div>

      {/* Run Section */}
      <Card>
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <PlayCircle className="w-6 h-6 text-purple-500" />
            <div>
              <h3 className="font-semibold text-lg">Run BOM Explosion</h3>
              <p className="text-sm text-slate-500">
                Expand FG demand into component demand (requires demand_fg and bom_edge data uploaded first)
              </p>
            </div>
          </div>

          {/* Input Filters */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4 border-t dark:border-slate-700">
            {/* Demand Source Selector */}
            <div className="space-y-2 md:col-span-2">
              <label className="block text-sm font-medium">
                Demand Source
              </label>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    value="demand_fg"
                    checked={demandSource === 'demand_fg'}
                    onChange={(e) => setDemandSource(e.target.value)}
                    className="w-4 h-4 text-purple-600"
                    disabled={runLoading}
                  />
                  <span className="text-sm">Uploaded demand_fg</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    value="demand_forecast"
                    checked={demandSource === 'demand_forecast'}
                    onChange={(e) => setDemandSource(e.target.value)}
                    className="w-4 h-4 text-purple-600"
                    disabled={runLoading}
                  />
                  <span className="text-sm">Demand forecast (select run)</span>
                </label>
              </div>
            </div>

            {/* Demand Forecast Run Selector - only shown when demand_forecast selected */}
            {demandSource === 'demand_forecast' && (
              <div className="space-y-2 md:col-span-2">
                <label className="block text-sm font-medium">
                  Select Demand Forecast Run
                </label>
                <select
                  value={selectedBomDemandRunId || ''}
                  onChange={(e) => setSelectedBomDemandRunId(e.target.value || null)}
                  className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 focus:ring-2 focus:ring-purple-500 outline-none"
                  disabled={runLoading || demandForecastRuns.length === 0}
                >
                  <option value="">
                    {demandForecastRuns.length === 0 ? 'No demand forecast runs available' : 'Select a run...'}
                  </option>
                  {demandForecastRuns.map(run => (
                    <option key={run.id} value={run.id}>
                      {run.scenario_name || 'baseline'} - {run.parameters?.model_version || 'ma_v1'} ({run.parameters?.time_buckets?.length || 0} buckets) - {formatDate(run.created_at)}
                    </option>
                  ))}
                </select>
                {demandForecastRuns.length === 0 && (
                  <p className="text-xs text-amber-600">
                    No demand forecast runs found. Please run Demand Forecast first.
                  </p>
                )}
              </div>
            )}

            {/* Inbound Source Selector */}
            <div className="space-y-2 md:col-span-2 pt-4 border-t dark:border-slate-700">
              <label className="block text-sm font-medium">
                Inbound Source (for Inventory Projection bloodline)
              </label>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    value="raw_po"
                    checked={bomInboundSource === 'raw_po'}
                    onChange={(e) => setBomInboundSource(e.target.value)}
                    className="w-4 h-4 text-purple-600"
                    disabled={runLoading}
                  />
                  <span className="text-sm">Raw PO Open Lines</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    value="supply_forecast"
                    checked={bomInboundSource === 'supply_forecast'}
                    onChange={(e) => setBomInboundSource(e.target.value)}
                    className="w-4 h-4 text-purple-600"
                    disabled={runLoading}
                  />
                  <span className="text-sm">Supply Forecast (select run)</span>
                </label>
              </div>
            </div>

            {/* Supply Forecast Run Selector - only shown when supply_forecast selected */}
            {bomInboundSource === 'supply_forecast' && (
              <div className="space-y-2 md:col-span-2">
                <label className="block text-sm font-medium">
                  Select Supply Forecast Run
                </label>
                <select
                  value={selectedBomSupplyRunId || ''}
                  onChange={(e) => setSelectedBomSupplyRunId(e.target.value || null)}
                  className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 focus:ring-2 focus:ring-purple-500 outline-none"
                  disabled={runLoading || supplyForecastRuns.length === 0}
                >
                  <option value="">
                    {supplyForecastRuns.length === 0 ? 'No supply forecast runs available' : 'Select a run...'}
                  </option>
                  {supplyForecastRuns.map(run => (
                    <option key={run.id} value={run.id}>
                      {run.scenario_name || 'baseline'} - {run.parameters?.model_version || 'supply_v1'} ({run.parameters?.time_buckets?.length || 0} buckets) - {formatDate(run.created_at)}
                    </option>
                  ))}
                </select>
                {supplyForecastRuns.length === 0 && (
                  <p className="text-xs text-amber-600">
                    No supply forecast runs found. Please run Supply Forecast first.
                  </p>
                )}
              </div>
            )}

            <div className="space-y-2">
              <label className="block text-sm font-medium">
                Plant ID (leave empty = all plants)
              </label>
              <input
                type="text"
                value={plantId}
                onChange={(e) => setPlantId(e.target.value)}
                placeholder="e.g. P001 (leave empty for all)"
                className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 focus:ring-2 focus:ring-purple-500 outline-none"
                disabled={runLoading}
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium">
                Time Buckets (leave empty = all time)
              </label>
              <input
                type="text"
                value={timeBuckets}
                onChange={(e) => setTimeBuckets(e.target.value)}
                placeholder="e.g. 2026-W01, 2026-W02 (comma separated)"
                className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 focus:ring-2 focus:ring-purple-500 outline-none"
                disabled={runLoading}
              />
            </div>
          </div>

          {/* Execute Button */}
          <div className="flex justify-center">
            <Button
              onClick={handleRunBomExplosion}
              disabled={runLoading}
              variant="primary"
              icon={runLoading ? Loader2 : PlayCircle}
              className="px-8"
            >
              {runLoading ? 'Calculating...' : 'Run BOM Explosion'}
            </Button>
          </div>

          {/* Error Display */}
          {runError && (
            <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <h4 className="font-semibold text-red-900 dark:text-red-100 mb-1">
                    Execution Failed
                  </h4>
                  <p className="text-sm text-red-800 dark:text-red-200">
                    {runError}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Success Result Display */}
          {runResult && (
            <div className="space-y-4 pt-4 border-t dark:border-slate-700">
              {/* KPI Cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="p-4 bg-green-50 dark:bg-green-900/20 rounded-lg border border-green-200 dark:border-green-800">
                  <div className="text-3xl font-bold text-green-600">
                    {runResult.componentDemandCount || 0}
                  </div>
                  <div className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                    Component Demands
                  </div>
                </div>

                <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
                  <div className="text-3xl font-bold text-blue-600">
                    {runResult.traceCount || 0}
                  </div>
                  <div className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                    Trace Records
                  </div>
                </div>

                <div className="p-4 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-800">
                  <div className="text-3xl font-bold text-amber-600">
                    {runResult.errors?.length || 0}
                  </div>
                  <div className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                    Errors/Warnings
                  </div>
                </div>

                <div className="p-4 bg-purple-50 dark:bg-purple-900/20 rounded-lg border border-purple-200 dark:border-purple-800">
                  <div className="text-2xl font-bold text-purple-600">
                    {runResult.success ? '\u2713' : '\u26A0'}
                  </div>
                  <div className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                    {runResult.success ? 'Success' : 'Has Warnings'}
                  </div>
                </div>
              </div>

              {/* Success Message */}
              {runResult.success && (
                <div className="p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
                  <div className="flex items-start gap-3">
                    <Check className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                    <div>
                      <h4 className="font-semibold text-green-900 dark:text-green-100 mb-1">
                        BOM Explosion Completed Successfully
                      </h4>
                      <p className="text-sm text-green-800 dark:text-green-200">
                        Generated {runResult.componentDemandCount} component demands and {runResult.traceCount} trace records.
                        {runResult.batchId && (
                          <span className="block mt-1">
                            Batch ID: <code className="px-2 py-0.5 bg-green-100 dark:bg-green-800 rounded text-xs font-mono">
                              {runResult.batchId}
                            </code>
                          </span>
                        )}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Errors/Warnings Display */}
              {runResult.errors && runResult.errors.length > 0 && (
                <div className="border border-amber-200 dark:border-amber-800 rounded-lg overflow-hidden">
                  <div
                    className="bg-amber-50 dark:bg-amber-900/20 px-4 py-3 border-b border-amber-200 dark:border-amber-800 cursor-pointer hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-colors"
                    onClick={() => setShowRunErrors(!showRunErrors)}
                  >
                    <div className="flex items-center justify-between">
                      <h4 className="font-semibold text-amber-900 dark:text-amber-100 flex items-center gap-2">
                        <AlertTriangle className="w-5 h-5" />
                        Errors/Warnings Details ({runResult.errors.length} items)
                      </h4>
                      {showRunErrors ? (
                        <ChevronUp className="w-5 h-5 text-amber-600" />
                      ) : (
                        <ChevronDown className="w-5 h-5 text-amber-600" />
                      )}
                    </div>
                  </div>

                  {showRunErrors && (
                    <div className="max-h-64 overflow-y-auto p-4 space-y-3">
                      {runResult.errors.map((error, idx) => (
                        <div
                          key={idx}
                          className="p-3 bg-white dark:bg-slate-800 border border-amber-200 dark:border-amber-700 rounded text-sm"
                        >
                          <div className="font-semibold text-amber-900 dark:text-amber-100 mb-1">
                            {error.type || 'ERROR'}
                          </div>
                          <div className="text-amber-800 dark:text-amber-200">
                            {error.message}
                          </div>
                          {error.material && (
                            <div className="text-xs text-amber-700 dark:text-amber-300 mt-1">
                              Material: {error.material}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </Card>

      {/* Batch Selector */}
      <Card>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-lg">Select Batch</h3>
            <Button
              onClick={loadBatches}
              variant="secondary"
              size="sm"
              icon={RefreshCw}
              disabled={loadingBatches}
            >
              Refresh
            </Button>
          </div>

          {loadingBatches ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
            </div>
          ) : batches.length === 0 ? (
            <div className="py-8 text-center text-slate-500">
              <p>No batch records yet</p>
              <p className="text-sm mt-2">Please run BOM Explosion first</p>
            </div>
          ) : (
            <div className="max-h-96 overflow-y-auto space-y-2 pr-2">
              {batches.map(batch => (
                <div
                  key={batch.id}
                  onClick={() => handleBatchSelect(batch.id)}
                  className={`p-4 rounded-lg border-2 cursor-pointer transition-all ${
                    selectedBatchId === batch.id
                      ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20'
                      : 'border-slate-200 dark:border-slate-700 hover:border-purple-300 dark:hover:border-purple-700'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <div className="font-medium text-sm">
                        {batch.filename}
                      </div>
                      <div className="text-xs text-slate-500 mt-1">
                        {formatDate(batch.created_at)} ·
                        <span className="ml-2 text-green-600 font-medium">
                          {batch.success_rows || batch.result_summary?.component_demand_count || batch.metadata?.component_demand_count || 0} rows
                        </span>
                      </div>
                    </div>
                    {selectedBatchId === batch.id && (
                      <Check className="w-5 h-5 text-purple-600 flex-shrink-0" />
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      {/* Results/Trace/Inventory Tabs */}
      {(selectedBatchId || forecastRuns.length > 0) && (
        <>
          {/* Tabs - Main tabs */}
          <Card>
            <div className="flex border-b dark:border-slate-700">
              <button
                onClick={() => handleTabSwitch('results')}
                className={`px-6 py-3 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === 'results'
                    ? 'border-purple-600 text-purple-600 dark:text-purple-400'
                    : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                Forecast Results
              </button>
              <button
                onClick={() => handleTabSwitch('trace')}
                className={`px-6 py-3 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === 'trace'
                    ? 'border-purple-600 text-purple-600 dark:text-purple-400'
                    : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                Trace
              </button>
              <button
                onClick={() => handleTabSwitch('inventory')}
                className={`px-6 py-3 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === 'inventory'
                    ? 'border-purple-600 text-purple-600 dark:text-purple-400'
                    : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                <Package className="w-4 h-4 inline-block mr-1" />
                Inventory (Projection)
              </button>
              <button
                onClick={() => handleTabSwitch('demand_forecast')}
                className={`px-6 py-3 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === 'demand_forecast'
                    ? 'border-purple-600 text-purple-600 dark:text-purple-400'
                    : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                <TrendingUp className="w-4 h-4 inline-block mr-1" />
                Demand Forecast
              </button>
              <button
                onClick={() => handleTabSwitch('supply_forecast')}
                className={`px-6 py-3 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === 'supply_forecast'
                    ? 'border-purple-600 text-purple-600 dark:text-purple-400'
                    : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                <Package className="w-4 h-4 inline-block mr-1" />
                Supply Forecast
              </button>
              <button
                onClick={() => handleTabSwitch('cost_forecast')}
                className={`px-6 py-3 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === 'cost_forecast'
                    ? 'border-purple-600 text-purple-600 dark:text-purple-400'
                    : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                <DollarSign className="w-4 h-4 inline-block mr-1" />
                Cost Forecast
              </button>
              <button
                onClick={() => handleTabSwitch('revenue_forecast')}
                className={`px-6 py-3 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === 'revenue_forecast'
                    ? 'border-pink-600 text-pink-600 dark:text-pink-400'
                    : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                <TrendingUp className="w-4 h-4 inline-block mr-1" />
                Revenue Forecast
              </button>
            </div>
          </Card>

          {/* Results/Trace Tab Content */}
          {(activeTab === 'results' || activeTab === 'trace') && selectedBatchId && (
            <ResultsTab
              user={user}
              addNotification={addNotification}
              selectedBatchId={selectedBatchId}
              activeTab={activeTab}
            />
          )}

          {/* Inventory Tab Content */}
          {activeTab === 'inventory' && (
            <InventoryTab
              user={user}
              addNotification={addNotification}
              forecastRuns={forecastRuns}
              loadForecastRuns={loadForecastRuns}
            />
          )}

          {/* Demand Forecast Tab Content */}
          {activeTab === 'demand_forecast' && (
            <DemandForecastTab
              user={user}
              addNotification={addNotification}
            />
          )}

          {/* Supply Forecast Tab Content */}
          {activeTab === 'supply_forecast' && (
            <SupplyForecastTab
              user={user}
              addNotification={addNotification}
            />
          )}

          {/* Cost Forecast Tab Content */}
          {activeTab === 'cost_forecast' && (
            <CostForecastTab
              user={user}
              addNotification={addNotification}
            />
          )}

          {/* Revenue Forecast Tab Content */}
          {activeTab === 'revenue_forecast' && (
            <RevenueForecastTab
              user={user}
              addNotification={addNotification}
            />
          )}
        </>
      )}
    </div>
  );
};

export default ForecastsView;
