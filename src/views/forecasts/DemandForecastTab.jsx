/**
 * Demand Forecast Tab - Demand forecast, dual model, material selection
 * Handles demand forecast run execution, run selection, material filtering,
 * dual model AI forecast, and forecast data display.
 *
 * @typedef {Object} DemandForecastTabProps
 * @property {Object} user - Current user object (must have .id)
 * @property {Function} addNotification - Notification callback (message, level)
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  TrendingUp, PlayCircle, Loader2, AlertTriangle, Check,
  Download, RefreshCw, Package, Calendar, Brain
} from 'lucide-react';
import { Card, Button, Badge } from '../../components/ui';
import { runDemandForecast } from '../../services/demandForecastEngine';
import {
  forecastRunsService,
  demandForecastService
} from '../../services/supabaseClient';
import dualModelForecastService from '../../services/dualModelForecastService';
import ModelToggle from '../../components/forecast/ModelToggle';
import ConsensusWarning from '../../components/forecast/ConsensusWarning';
import ConfidenceOverlayChart from '../../components/forecast/ConfidenceOverlayChart';

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
 * @param {DemandForecastTabProps} props
 */
const DemandForecastTab = ({ user, addNotification }) => {
  // ========== Demand Forecast Tab States ==========
  const [demandForecastRuns, setDemandForecastRuns] = useState([]);
  const [selectedDemandRunId, setSelectedDemandRunId] = useState(null);
  const [demandForecastMaterials, setDemandForecastMaterials] = useState([]);
  const [selectedDemandMaterial, setSelectedDemandMaterial] = useState(null);
  const [demandForecastData, setDemandForecastData] = useState([]);
  const [demandHistoricalData, setDemandHistoricalData] = useState([]);
  const [demandForecastLoading, setDemandForecastLoading] = useState(false);
  const [demandForecastError, setDemandForecastError] = useState(null);
  const [dfPlantId, setDfPlantId] = useState('');
  const [dfTimeBuckets, setDfTimeBuckets] = useState('');
  const [dfTrainWindow, setDfTrainWindow] = useState(8);
  const [dfRunLoading, setDfRunLoading] = useState(false);
  const [dfRunResult, setDfRunResult] = useState(null);

  // ========== Dual Model Forecast States ==========
  const [selectedModel, setSelectedModel] = useState('auto');
  const [recommendedModel, setRecommendedModel] = useState('lightgbm');
  const [modelStatus, setModelStatus] = useState({});
  const [dualModelForecast, setDualModelForecast] = useState(null);
  const [dualModelLoading, setDualModelLoading] = useState(false);
  const [dualModelError, setDualModelError] = useState(null);
  const [skuAnalysis, setSkuAnalysis] = useState(null);
  const [showComparison, setShowComparison] = useState(true);
  const [consensusWarning, setConsensusWarning] = useState(null);
  const [forecastHorizon, setForecastHorizon] = useState(30);

  /**
   * Load model status on component mount
   */
  useEffect(() => {
    const loadModelStatus = async () => {
      try {
        const status = await dualModelForecastService.getModelStatus();
        setModelStatus(status.models || {});
      } catch (error) {
        console.error('Failed to load model status:', error);
      }
    };

    loadModelStatus();
  }, []);

  /**
   * Load demand forecast runs when component mounts
   */
  useEffect(() => {
    if (user?.id) {
      loadDemandForecastRuns();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs only when user changes
  }, [user?.id]);

  /**
   * Load materials when run selection changes
   */
  useEffect(() => {
    if (selectedDemandRunId) {
      loadDemandForecastMaterials();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs only when run selection changes
  }, [selectedDemandRunId]);

  /**
   * Load demand forecast data when run/material changes
   */
  useEffect(() => {
    if (selectedDemandRunId) {
      loadDemandForecastData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs only when run/material changes
  }, [selectedDemandRunId, selectedDemandMaterial]);

  /**
   * Execute dual-model forecast
   */
  const executeDualModelForecast = useCallback(async (materialCode) => {
    if (!materialCode) {
      addNotification('Please select a material code', 'error');
      return;
    }

    setDualModelLoading(true);
    setDualModelError(null);
    setConsensusWarning(null);

    try {
      // Check cache first
      const cacheKey = dualModelForecastService.generateCacheKey({
        materialCode,
        horizonDays: forecastHorizon,
        modelType: selectedModel === 'auto' ? null : selectedModel,
        includeComparison: showComparison
      });

      const cachedResult = dualModelForecastService.getCachedForecast(cacheKey);
      if (cachedResult) {
        setDualModelForecast(cachedResult);
        if (cachedResult.consensus_warning) {
          setConsensusWarning(cachedResult.consensus_warning);
        }
        addNotification('Using cached forecast results', 'info');
        return;
      }

      // Execute forecast
      const result = await dualModelForecastService.executeForecastWithRetry({
        materialCode,
        horizonDays: forecastHorizon,
        modelType: selectedModel === 'auto' ? null : selectedModel,
        includeComparison: showComparison,
        userPreference: null
      });

      if (result.error) {
        throw new Error(result.error);
      }

      setDualModelForecast(result);

      // Handle consensus warning
      if (result.consensus_warning && result.consensus_warning.warning) {
        setConsensusWarning(result.consensus_warning);

        if (result.consensus_warning.level === 'high') {
          addNotification('Large model prediction deviation detected, please check consensus warning', 'warning');
        }
      }

      // Cache the result
      dualModelForecastService.cacheForecast(cacheKey, result, 60); // Cache for 60 minutes

      addNotification(
        `Forecast complete! Using ${result.forecast.model} model`,
        'success'
      );

    } catch (error) {
      console.error('Dual model forecast failed:', error);
      setDualModelError(error.message);
      addNotification(`Forecast failed: ${error.message}`, 'error');
    } finally {
      setDualModelLoading(false);
    }
  }, [selectedModel, forecastHorizon, showComparison, addNotification]);

  /**
   * Analyze SKU and get model recommendation
   */
  const _analyzeSKU = useCallback(async (materialCode) => {
    if (!materialCode) return;

    try {
      const analysis = await dualModelForecastService.analyzeSKU(materialCode);

      if (analysis.error) {
        throw new Error(analysis.error);
      }

      setSkuAnalysis(analysis);
      setRecommendedModel(analysis.recommended_model);

      // Auto-select recommended model if in auto mode
      if (selectedModel === 'auto' && analysis.recommended_model) {
        setSelectedModel(analysis.recommended_model);
      }

    } catch (error) {
      console.error('SKU analysis failed:', error);
      addNotification(`SKU analysis failed: ${error.message}`, 'error');
    }
  }, [selectedModel, addNotification]);

  /**
   * Handle model change
   */
  const handleModelChange = useCallback((newModel) => {
    setSelectedModel(newModel);

    // Clear current forecast when model changes
    setDualModelForecast(null);
    setConsensusWarning(null);
    setDualModelError(null);
  }, []);

  /**
   * Handle consensus warning dismissal
   */
  const handleDismissWarning = useCallback(() => {
    setConsensusWarning(null);
  }, []);

  /**
   * Handle model switch from consensus warning
   */
  const handleModelSwitch = useCallback((targetModel) => {
    handleModelChange(targetModel);

    // Re-execute forecast with new model if we have a material
    if (selectedDemandMaterial) {
      executeDualModelForecast(selectedDemandMaterial);
    }
  }, [handleModelChange, selectedDemandMaterial, executeDualModelForecast]);

  /**
   * Load demand forecast runs (kind = 'demand_forecast')
   */
  const loadDemandForecastRuns = async () => {
    if (!user?.id) return;

    try {
      const runs = await forecastRunsService.listRuns(user.id, { limit: 30 });
      // Filter to only demand_forecast kind
      const dfRuns = (runs || []).filter(r => r.parameters?.kind === 'demand_forecast');
      setDemandForecastRuns(dfRuns);

      // Select first run if none selected
      if (dfRuns.length > 0 && !selectedDemandRunId) {
        setSelectedDemandRunId(dfRuns[0].id);
      }
    } catch (error) {
      console.error('Error loading demand forecast runs:', error);
    }
  };

  /**
   * Load materials for selected demand forecast run
   */
  const loadDemandForecastMaterials = async () => {
    if (!user?.id || !selectedDemandRunId) return;

    try {
      const materials = await demandForecastService.getMaterialsByRun(user.id, selectedDemandRunId);
      setDemandForecastMaterials(materials);

      // Select first material if none selected
      if (materials.length > 0 && !selectedDemandMaterial) {
        setSelectedDemandMaterial(materials[0]);
      }
    } catch (error) {
      console.error('Error loading demand forecast materials:', error);
    }
  };

  /**
   * Load demand forecast data for selected run and material
   */
  const loadDemandForecastData = async () => {
    if (!user?.id || !selectedDemandRunId) return;

    setDemandForecastLoading(true);
    setDemandForecastError(null);

    try {
      // Get forecast data
      const forecasts = await demandForecastService.getForecastsByRun(
        user.id,
        selectedDemandRunId,
        { materialCode: selectedDemandMaterial || undefined }
      );
      setDemandForecastData(forecasts);

      // Get historical demand_fg data for comparison (if material selected)
      if (selectedDemandMaterial && forecasts.length > 0) {
        const plantId = forecasts[0]?.plant_id;
        const timeBuckets = forecasts.map(f => f.time_bucket);
        const minBucket = timeBuckets.sort()[0];

        // Get historical data before the forecast period
        const historical = await demandForecastService.getHistoricalDemandFg(
          user.id,
          plantId,
          selectedDemandMaterial,
          minBucket,
          12 // Get up to 12 historical buckets for context
        );
        setDemandHistoricalData(historical);
      } else {
        setDemandHistoricalData([]);
      }
    } catch (error) {
      console.error('Error loading demand forecast data:', error);
      setDemandForecastError(error.message);
    } finally {
      setDemandForecastLoading(false);
    }
  };

  /**
   * Handle demand forecast run selection
   */
  const handleDemandRunSelect = (runId) => {
    setSelectedDemandRunId(runId);
    setSelectedDemandMaterial(null);
    setDemandForecastData([]);
    setDemandHistoricalData([]);
  };

  /**
   * Handle demand forecast material selection
   */
  const handleDemandMaterialSelect = (materialCode) => {
    setSelectedDemandMaterial(materialCode);
  };

  /**
   * Execute demand forecast run
   */
  const handleRunDemandForecast = async () => {
    if (!user?.id) {
      addNotification('Please log in first', 'error');
      return;
    }

    setDfRunLoading(true);
    setDfRunResult(null);

    try {
      // Parse inputs
      const plantIdFilter = dfPlantId.trim() || null;
      const targetTimeBuckets = dfTimeBuckets.trim()
        ? dfTimeBuckets.split(',').map(t => t.trim()).filter(Boolean)
        : [];

      if (targetTimeBuckets.length === 0) {
        throw new Error('Please provide at least one Time Bucket');
      }

      console.log('Running demand forecast:', { plantIdFilter, targetTimeBuckets, trainWindow: dfTrainWindow });

      // Execute forecast
      const result = await runDemandForecast(
        {
          userId: user.id,
          plantId: plantIdFilter,
          targetTimeBuckets,
          trainWindowBuckets: dfTrainWindow,
          scenarioName: 'demand_forecast'
        },
        {
          forecastRunsService,
          demandForecastService
        }
      );

      console.log('Demand forecast result:', result);
      setDfRunResult(result);

      if (result.success) {
        addNotification(
          `Demand Forecast complete! Generated ${result.statistics.totalForecasts} forecasts (${result.statistics.totalMaterials} FGs)`,
          'success'
        );
        // Reload runs list
        await loadDemandForecastRuns();
        if (result.forecastRunId) {
          setSelectedDemandRunId(result.forecastRunId);
        }
      } else {
        addNotification(`Demand Forecast failed: ${result.error}`, 'error');
      }
    } catch (error) {
      console.error('Demand forecast failed:', error);
      addNotification(`Demand Forecast failed: ${error.message}`, 'error');
      setDfRunResult({ success: false, error: error.message });
    } finally {
      setDfRunLoading(false);
    }
  };

  /**
   * Download demand forecast CSV
   */
  const handleDownloadDemandForecastCSV = () => {
    if (demandForecastData.length === 0) {
      addNotification('No data to export', 'warning');
      return;
    }

    try {
      const columns = ['material_code', 'plant_id', 'time_bucket', 'p10', 'p50', 'p90', 'model_version', 'train_window_buckets'];
      const headers = columns.join(',');

      const rows = demandForecastData.map(row => {
        return columns.map(col => {
          const value = row[col];
          if (value === null || value === undefined) return '';
          if (typeof value === 'string' && value.includes(',')) return `"${value}"`;
          return value;
        }).join(',');
      });

      const csv = [headers, ...rows].join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const materialSuffix = selectedDemandMaterial ? `_${selectedDemandMaterial}` : '';
      link.download = `demand_forecast_${selectedDemandRunId}${materialSuffix}_${new Date().toISOString().split('T')[0]}.csv`;
      link.click();
      URL.revokeObjectURL(url);

      addNotification(`Exported ${demandForecastData.length} forecast records`, 'success');
    } catch (error) {
      console.error('Error downloading CSV:', error);
      addNotification(`Export failed: ${error.message}`, 'error');
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
              <h3 className="font-semibold text-lg">Run Demand Forecast</h3>
              <p className="text-sm text-slate-500">
                Forecast FG demand using Moving Average (MA) algorithm (requires demand_fg data uploaded first)
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
                value={dfPlantId}
                onChange={(e) => setDfPlantId(e.target.value)}
                placeholder="e.g. P001"
                className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 focus:ring-2 focus:ring-purple-500 outline-none"
                disabled={dfRunLoading}
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium">
                Target Time Buckets <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={dfTimeBuckets}
                onChange={(e) => setDfTimeBuckets(e.target.value)}
                placeholder="e.g. 2026-W10, 2026-W11, 2026-W12"
                className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 focus:ring-2 focus:ring-purple-500 outline-none"
                disabled={dfRunLoading}
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium">
                Train Window Buckets
              </label>
              <input
                type="number"
                value={dfTrainWindow}
                onChange={(e) => setDfTrainWindow(parseInt(e.target.value) || 8)}
                min="2"
                max="52"
                className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 focus:ring-2 focus:ring-purple-500 outline-none"
                disabled={dfRunLoading}
              />
            </div>
          </div>

          {/* Execute Button */}
          <div className="flex justify-center">
            <Button
              onClick={handleRunDemandForecast}
              disabled={dfRunLoading || !dfTimeBuckets.trim()}
              variant="primary"
              icon={dfRunLoading ? Loader2 : PlayCircle}
              className="px-8"
            >
              {dfRunLoading ? 'Calculating...' : 'Run Demand Forecast'}
            </Button>
          </div>

          {/* Result Display */}
          {dfRunResult && (
            <div className={`p-4 rounded-lg border ${dfRunResult.success ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800' : 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800'}`}>
              <div className="flex items-start gap-3">
                {dfRunResult.success ? (
                  <Check className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                ) : (
                  <AlertTriangle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                )}
                <div className="flex-1">
                  <h4 className={`font-semibold mb-1 ${dfRunResult.success ? 'text-green-900 dark:text-green-100' : 'text-red-900 dark:text-red-100'}`}>
                    {dfRunResult.success ? 'Demand Forecast Complete' : 'Execution Failed'}
                  </h4>
                  {dfRunResult.success ? (
                    <div className="text-sm text-green-800 dark:text-green-200 space-y-1">
                      <p>Generated {dfRunResult.statistics.totalForecasts} forecasts ({dfRunResult.statistics.totalMaterials} FGs)</p>
                      <p>Run ID: <code className="px-2 py-0.5 bg-green-100 dark:bg-green-800 rounded text-xs font-mono">{dfRunResult.forecastRunId}</code></p>
                      <p>Model: {dfRunResult.statistics.modelVersion} | Train Window: {dfRunResult.statistics.trainWindowBuckets}</p>
                    </div>
                  ) : (
                    <p className="text-sm text-red-800 dark:text-red-200">{dfRunResult.error}</p>
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
              Select Demand Forecast Run
            </h3>
            <Button
              onClick={loadDemandForecastRuns}
              variant="secondary"
              size="sm"
              icon={RefreshCw}
            >
              Refresh
            </Button>
          </div>

          {demandForecastRuns.length === 0 ? (
            <div className="py-6 text-center text-slate-500">
              <p>No Demand Forecast Runs yet</p>
              <p className="text-sm mt-1">Please run Demand Forecast first</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {demandForecastRuns.slice(0, 9).map(run => (
                <div
                  key={run.id}
                  onClick={() => handleDemandRunSelect(run.id)}
                  className={`p-3 rounded-lg border-2 cursor-pointer transition-all ${
                    selectedDemandRunId === run.id
                      ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20'
                      : 'border-slate-200 dark:border-slate-700 hover:border-purple-300 dark:hover:border-purple-700'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-purple-600 dark:text-purple-400">
                      {run.scenario_name || 'baseline'}
                    </span>
                    {selectedDemandRunId === run.id && (
                      <Check className="w-4 h-4 text-purple-600" />
                    )}
                  </div>
                  <div className="text-xs text-slate-500 space-y-1">
                    <div>
                      <span className="font-medium">Model:</span> {run.parameters?.model_version || 'ma_v1'}
                    </div>
                    <div>
                      <span className="font-medium">Plant:</span> {run.parameters?.plant_id || 'All'}
                    </div>
                    <div>
                      <span className="font-medium">Window:</span> {run.parameters?.train_window_buckets || 8} | Buckets: {run.parameters?.time_buckets?.length || 0}
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

      {/* Material Selector */}
      {selectedDemandRunId && demandForecastMaterials.length > 0 && (
        <Card>
          <div className="space-y-4">
            <h3 className="font-semibold text-lg flex items-center gap-2">
              <Package className="w-5 h-5 text-purple-500" />
              Select FG Material
            </h3>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => handleDemandMaterialSelect(null)}
                className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                  selectedDemandMaterial === null
                    ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300'
                    : 'border-slate-300 dark:border-slate-600 hover:border-purple-300'
                }`}
              >
                All ({demandForecastData.length} records)
              </button>
              {demandForecastMaterials.map(material => (
                <button
                  key={material}
                  onClick={() => handleDemandMaterialSelect(material)}
                  className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                    selectedDemandMaterial === material
                      ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300'
                      : 'border-slate-300 dark:border-slate-600 hover:border-purple-300'
                  }`}
                >
                  {material}
                </button>
              ))}
            </div>
          </div>
        </Card>
      )}

      {/* ========== Dual Model Forecast Section ========== */}
      {selectedDemandRunId && demandForecastMaterials.length > 0 && (
        <>
          {/* Model Selection and Controls */}
          <Card>
            <div className="space-y-6">
              <div className="flex items-center gap-3">
                <Brain className="w-6 h-6 text-purple-500" />
                <div>
                  <h3 className="font-semibold text-lg">AI Dual-Model Forecast</h3>
                  <p className="text-sm text-slate-500">
                    Combined forecast using LightGBM stability and Amazon Chronos AI generalization
                  </p>
                </div>
              </div>

              {/* Model Toggle */}
              <ModelToggle
                selectedModel={selectedModel}
                onModelChange={handleModelChange}
                recommendedModel={recommendedModel}
                modelStatus={modelStatus}
                isLoading={dualModelLoading}
                disabled={dualModelLoading}
              />

              {/* Forecast Controls */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <label className="block text-sm font-medium">
                    Forecast Horizon
                  </label>
                  <select
                    value={forecastHorizon}
                    onChange={(e) => setForecastHorizon(parseInt(e.target.value))}
                    className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 focus:ring-2 focus:ring-purple-500 outline-none"
                    disabled={dualModelLoading}
                  >
                    <option value={7}>7 days</option>
                    <option value={14}>14 days</option>
                    <option value={30}>30 days</option>
                    <option value={60}>60 days</option>
                    <option value={90}>90 days</option>
                  </select>
                </div>

                <div className="space-y-2">
                  <label className="block text-sm font-medium">
                    Model Comparison
                  </label>
                  <div className="flex items-center space-x-2 mt-3">
                    <input
                      type="checkbox"
                      id="showComparison"
                      checked={showComparison}
                      onChange={(e) => setShowComparison(e.target.checked)}
                      className="rounded border-slate-300 text-purple-600 focus:ring-purple-500"
                      disabled={dualModelLoading}
                    />
                    <label htmlFor="showComparison" className="text-sm text-slate-700">
                      Enable model comparison analysis
                    </label>
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="block text-sm font-medium invisible">
                    Run Forecast
                  </label>
                  <Button
                    onClick={() => executeDualModelForecast(selectedDemandMaterial)}
                    disabled={dualModelLoading || !selectedDemandMaterial}
                    variant="primary"
                    icon={dualModelLoading ? Loader2 : Brain}
                    className="w-full"
                  >
                    {dualModelLoading ? 'Forecasting...' : 'Run AI Forecast'}
                  </Button>
                </div>
              </div>

              {/* SKU Analysis Display */}
              {skuAnalysis && (
                <div className="bg-slate-50 dark:bg-slate-800 rounded-lg p-4">
                  <h4 className="font-medium text-slate-900 dark:text-slate-100 mb-2">
                    SKU Analysis Results
                  </h4>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                    <div>
                      <span className="text-slate-500">Data Points:</span>
                      <div className="font-medium">{skuAnalysis.analysis?.data_points || 'N/A'}</div>
                    </div>
                    <div>
                      <span className="text-slate-500">Recommended Model:</span>
                      <div className="font-medium">{skuAnalysis.recommended_model?.toUpperCase() || 'N/A'}</div>
                    </div>
                    <div>
                      <span className="text-slate-500">Data Sufficiency:</span>
                      <div className="font-medium">{skuAnalysis.analysis?.data_sufficiency || 'N/A'}</div>
                    </div>
                    <div>
                      <span className="text-slate-500">Chronos Suitability:</span>
                      <div className="font-medium">
                        {skuAnalysis.chronos_suitability?.suitable ? 'Suitable' : 'Not Suitable'}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </Card>

          {/* Consensus Warning */}
          {consensusWarning && (
            <ConsensusWarning
              consensusData={{
                ...consensusWarning,
                primary_model: dualModelForecast?.forecast?.model,
                secondary_model: dualModelForecast?.comparison?.secondary_model,
                primary_mean: dualModelForecast?.forecast?.median,
                secondary_mean: dualModelForecast?.comparison?.secondary_prediction,
                deviation_pct: dualModelForecast?.comparison?.deviation_pct
              }}
              onDismiss={handleDismissWarning}
              onModelSwitch={handleModelSwitch}
            />
          )}

          {/* Forecast Results */}
          {dualModelForecast && (
            <>
              {/* Confidence Overlay Chart */}
              <ConfidenceOverlayChart
                forecastData={dualModelForecast.forecast}
                comparisonData={dualModelForecast.comparison}
                historicalData={demandHistoricalData.slice(-30)} // Last 30 days of historical data
                showHistorical={true}
                showComparison={showComparison && dualModelForecast.comparison}
                height={400}
              />

              {/* Forecast Statistics */}
              <Card>
                <div className="space-y-4">
                  <h3 className="font-semibold text-lg flex items-center gap-2">
                    <TrendingUp className="w-5 h-5 text-purple-500" />
                    Forecast Statistics
                  </h3>

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4">
                      <div className="text-2xl font-bold text-blue-600">
                        {dualModelForecast.forecast.median?.toFixed(0) || 'N/A'}
                      </div>
                      <div className="text-sm text-blue-600">Primary Forecast Mean</div>
                      <div className="text-xs text-blue-500 mt-1">
                        {dualModelForecast.forecast.model?.toUpperCase()}
                      </div>
                    </div>

                    <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-4">
                      <div className="text-2xl font-bold text-green-600">
                        {dualModelForecast.forecast.risk_score?.toFixed(0) || 'N/A'}
                      </div>
                      <div className="text-sm text-green-600">Risk Score</div>
                      <div className="text-xs text-green-500 mt-1">
                        {dualModelForecast.forecast.risk_score < 30 ? 'Low Risk' :
                         dualModelForecast.forecast.risk_score < 70 ? 'Medium Risk' : 'High Risk'}
                      </div>
                    </div>

                    {dualModelForecast.comparison && (
                      <div className="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-4">
                        <div className="text-2xl font-bold text-purple-600">
                          {dualModelForecast.comparison.deviation_pct?.toFixed(1) || '0'}%
                        </div>
                        <div className="text-sm text-purple-600">Model Deviation</div>
                        <div className="text-xs text-purple-500 mt-1">
                          {dualModelForecast.comparison.agreement_level}
                        </div>
                      </div>
                    )}

                    <div className="bg-orange-50 dark:bg-orange-900/20 rounded-lg p-4">
                      <div className="text-2xl font-bold text-orange-600">
                        {forecastHorizon}
                      </div>
                      <div className="text-sm text-orange-600">Forecast Horizon</div>
                      <div className="text-xs text-orange-500 mt-1">
                        {dualModelForecast.cached ? 'Cached Result' : 'Real-time Calculation'}
                      </div>
                    </div>
                  </div>
                </div>
              </Card>
            </>
          )}

          {/* Error Display */}
          {dualModelError && (
            <Card>
              <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <h4 className="font-semibold text-red-900 dark:text-red-100 mb-1">
                      AI Forecast Failed
                    </h4>
                    <p className="text-sm text-red-800 dark:text-red-200">{dualModelError}</p>
                  </div>
                </div>
              </div>
            </Card>
          )}
        </>
      )}

      {/* Forecast Data Table */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-semibold text-lg">Demand Forecast Results</h3>
            <p className="text-sm text-slate-500">
              {demandForecastLoading ? 'Loading...' : `${demandForecastData.length} forecasts total`}
            </p>
          </div>
          <Button
            onClick={handleDownloadDemandForecastCSV}
            variant="secondary"
            size="sm"
            icon={Download}
            disabled={demandForecastData.length === 0}
          >
            Download CSV
          </Button>
        </div>

        {demandForecastLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-purple-500" />
            <span className="ml-3 text-slate-600 dark:text-slate-400">Loading...</span>
          </div>
        ) : demandForecastError ? (
          <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
            <p className="text-red-800 dark:text-red-200">{demandForecastError}</p>
          </div>
        ) : demandForecastData.length === 0 ? (
          <div className="py-12 text-center">
            <TrendingUp className="w-16 h-16 mx-auto text-slate-300 dark:text-slate-600 mb-4" />
            <h3 className="text-lg font-semibold text-slate-600 dark:text-slate-400 mb-2">
              No Forecast Data
            </h3>
            <p className="text-sm text-slate-500">
              Please select a Demand Forecast Run
            </p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-100 dark:bg-slate-800 sticky top-0">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">Material</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">Plant</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">Time Bucket</th>
                    <th className="px-3 py-2 text-right text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">P10</th>
                    <th className="px-3 py-2 text-right text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">P50 (Forecast)</th>
                    <th className="px-3 py-2 text-right text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">P90</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">Model</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                  {demandForecastData.map((row, idx) => (
                    <tr key={idx} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                      <td className="px-3 py-2 font-mono text-xs">{row.material_code}</td>
                      <td className="px-3 py-2 text-xs">{row.plant_id}</td>
                      <td className="px-3 py-2 font-mono text-xs">{row.time_bucket}</td>
                      <td className="px-3 py-2 text-right text-slate-600">{row.p10?.toLocaleString() || '-'}</td>
                      <td className="px-3 py-2 text-right font-semibold text-purple-600">{row.p50?.toLocaleString() || '-'}</td>
                      <td className="px-3 py-2 text-right text-slate-600">{row.p90?.toLocaleString() || '-'}</td>
                      <td className="px-3 py-2 text-xs">
                        {row.model_version}
                        {row.metrics?.fallback_used && (
                          <span className="ml-2 text-amber-600 text-xs">(fallback)</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Show historical data if available */}
            {demandHistoricalData.length > 0 && (
              <div className="mt-6 pt-6 border-t dark:border-slate-700">
                <h4 className="text-sm font-semibold mb-3 text-slate-600 dark:text-slate-400">
                  Historical Demand FG Data (latest {demandHistoricalData.length} records)
                </h4>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-100 dark:bg-slate-800 sticky top-0">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">Time Bucket</th>
                        <th className="px-3 py-2 text-right text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">Actual Demand</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                      {demandHistoricalData.map((row, idx) => (
                        <tr key={idx} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                          <td className="px-3 py-2 font-mono text-xs">{row.time_bucket}</td>
                          <td className="px-3 py-2 text-right">{row.demand_qty?.toLocaleString() || '0'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </Card>
    </>
  );
};

export default DemandForecastTab;
