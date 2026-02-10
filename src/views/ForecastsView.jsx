/**
 * Forecasts View - Component Forecast (BOM-Derived)
 * 產品化的 BOM Explosion 主頁：Run 計算 → 選擇批次 → 查看結果（Results + Trace + Inventory）
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  TrendingUp, PlayCircle, Loader2, AlertTriangle, Check, ChevronDown, ChevronUp,
  Database, Search, ChevronLeft, ChevronRight, Filter, X, Download, RefreshCw,
  Package, AlertCircle, Calendar, Hash, DollarSign, Brain, Settings
} from 'lucide-react';
import { Card, Button, Badge } from '../components/ui';
import { executeBomExplosion, pollBomExplosionStatus } from '../services/bomExplosionService';
import { runDemandForecast } from '../services/demandForecastEngine';
import { runSupplyForecast, supplyForecastService } from '../services/supplyForecastService';
import {
  demandFgService,
  bomEdgesService,
  componentDemandService,
  componentDemandTraceService,
  forecastRunsService,
  demandForecastService
} from '../services/supabaseClient';
import { importBatchesService } from '../services/importHistoryService';
import { useUrlTabState } from '../hooks/useUrlTabState';
import {
  loadInventoryProjection,
  computeSeriesForKey,
  FORECAST_WARN_ROWS,
  FORECAST_STOP_ROWS,
  FORECAST_TOP_N
} from '../services/inventoryProjectionService';
import { runCostForecast, getCostResults, getCostResultsByKey, getCostRuleSets } from '../services/costForecastService';
import {
  runRevenueForecast,
  getMarginAtRiskResults,
  getRevenueTerms,
  saveRevenueTerm,
  deleteRevenueTerm
} from '../services/revenueForecastService';
import dualModelForecastService from '../services/dualModelForecastService';
import ModelToggle from '../components/forecast/ModelToggle';
import ConsensusWarning from '../components/forecast/ConsensusWarning';
import ConfidenceOverlayChart from '../components/forecast/ConfidenceOverlayChart';

const ForecastsView = ({ user, addNotification }) => {
  // ========== Run 區塊 States ==========
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
  
  // ========== Results/Trace/Inventory/Demand Forecast/Supply Forecast States (tab synced to URL) ==========
  const [activeTab, setActiveTab] = useUrlTabState('results', 'tab', ['results', 'trace', 'inventory', 'demand_forecast', 'supply_forecast', 'cost_forecast', 'revenue_forecast']);
  const [data, setData] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [filters, setFilters] = useState({});
  const [showFilters, setShowFilters] = useState(true);
  
  // ========== Inventory Tab States ==========
  const [forecastRuns, setForecastRuns] = useState([]);
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

  // ========== Revenue Forecast Tab States ==========
  const [revenueForecastRuns, setRevenueForecastRuns] = useState([]);
  const [selectedRevenueRunId, setSelectedRevenueRunId] = useState(null);
  const [revenueForecastData, setRevenueForecastData] = useState([]);
  const [revenueForecastLoading, setRevenueForecastLoading] = useState(false);
  const [revenueForecastError, setRevenueForecastError] = useState(null);
  const [revenueSourceRunId, setRevenueSourceRunId] = useState(null);
  const [revenueKpis, setRevenueKpis] = useState({ totalKeys: 0, marginAtRisk: 0, penaltyAtRisk: 0, totalAtRisk: 0, topFg: null });
  const [revenueRunLoading, setRevenueRunLoading] = useState(false);
  const [revenueRunResult, setRevenueRunResult] = useState(null);
  const [revenueRiskInputMode, setRevenueRiskInputMode] = useState('deterministic'); // 'deterministic' | 'probabilistic'
  const [revenueDemandSource, setRevenueDemandSource] = useState('uploaded'); // 'uploaded' | 'demand_forecast'
  const [revenueTopN, setRevenueTopN] = useState(200);
  const [revenueTerms, setRevenueTerms] = useState([]);
  const [showRevenueTermModal, setShowRevenueTermModal] = useState(false);
  const [editingRevenueTerm, setEditingRevenueTerm] = useState(null);
  const [selectedRevenueKey, setSelectedRevenueKey] = useState(null);

  const itemsPerPage = 100;

  // ========== Load batches and forecast runs on mount ==========
  useEffect(() => {
    if (user?.id) {
      loadBatches();
      loadForecastRuns();
    }
  }, [user]);

  // ========== Load data when batch/tab/page/filters change ==========
  useEffect(() => {
    if (selectedBatchId && user?.id && activeTab !== 'inventory') {
      loadData();
    }
  }, [selectedBatchId, activeTab, currentPage, filters, user]);

  // ========== Load inventory projection when run changes ==========
  useEffect(() => {
    if (activeTab === 'inventory' && selectedRunId && user?.id) {
      loadInventoryData();
    }
  }, [activeTab, selectedRunId, user]);

  /**
   * 載入 BOM Explosion 批次清單
   */
  const loadBatches = async () => {
    if (!user?.id) return;
    
    setLoadingBatches(true);
    try {
      const allBatches = await importBatchesService.getAllBatches(user.id, {
        limit: 50
      });
      
      // 篩選 bom_explosion 批次（target_table 或 upload_type）且 status='completed'
      const bomBatches = allBatches
        .filter(b => (b.target_table === 'bom_explosion' || b.upload_type === 'bom_explosion') && b.status === 'completed')
        .slice(0, 10); // 最近 10 筆
      
      setBatches(bomBatches);
      
      // 預設選擇最新的批次
      if (bomBatches.length > 0 && !selectedBatchId) {
        setSelectedBatchId(bomBatches[0].id);
      }
    } catch (error) {
      console.error('Error loading batches:', error);
      addNotification(`載入批次清單失敗: ${error.message}`, 'error');
    } finally {
      setLoadingBatches(false);
    }
  };

  /**
   * 載入 Forecast Runs 清單（供 Inventory Tab 使用）
   */
  const loadForecastRuns = async (forceReselect = false) => {
    if (!user?.id) return;
    
    try {
      const runs = await forecastRunsService.listRuns(user.id, { limit: 20 });
      setForecastRuns(runs || []);
      
      // 預設選擇最新的有 time_buckets 的 run（Inventory tab 需要 time_buckets）
      if (runs && runs.length > 0 && (!selectedRunId || forceReselect)) {
        const runWithBuckets = runs.find(r => 
          Array.isArray(r.parameters?.time_buckets) && r.parameters.time_buckets.length > 0
        );
        if (runWithBuckets) {
          setSelectedRunId(runWithBuckets.id);
        } else if (!selectedRunId) {
          setSelectedRunId(runs[0].id);
        }
      }
    } catch (error) {
      console.error('Error loading forecast runs:', error);
    }
  };

  /**
   * ========== Dual Model Forecast Functions ==========
   */

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
   * Execute dual-model forecast
   */
  const executeDualModelForecast = useCallback(async (materialCode) => {
    if (!materialCode) {
      addNotification('請選擇一個產品料號', 'error');
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
        addNotification('使用快取的預測結果', 'info');
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
          addNotification('檢測到模型預測差異較大，請查看共識警告', 'warning');
        }
      }

      // Cache the result
      dualModelForecastService.cacheForecast(cacheKey, result, 60); // Cache for 60 minutes
      
      addNotification(
        `預測完成！使用 ${result.forecast.model} 模型`,
        'success'
      );

    } catch (error) {
      console.error('Dual model forecast failed:', error);
      setDualModelError(error.message);
      addNotification(`預測失敗: ${error.message}`, 'error');
    } finally {
      setDualModelLoading(false);
    }
  }, [selectedModel, forecastHorizon, showComparison, addNotification]);

  /**
   * Analyze SKU and get model recommendation
   */
  const analyzeSKU = useCallback(async (materialCode) => {
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
      addNotification(`SKU 分析失敗: ${error.message}`, 'error');
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
   * Handle material selection for dual model forecast
   */
  const handleDualModelMaterialSelect = useCallback((materialCode) => {
    setSelectedDemandMaterial(materialCode);
    
    // Auto-analyze SKU when material is selected
    if (materialCode) {
      analyzeSKU(materialCode);
    }
    
    // Clear previous forecast
    setDualModelForecast(null);
    setConsensusWarning(null);
    setDualModelError(null);
  }, [analyzeSKU]);

  /**
   * 載入 Inventory Projection 資料
   */
  const loadInventoryData = useCallback(async () => {
    if (!user?.id || !selectedRunId) return;

    setInventoryLoading(true);
    setInventoryError(null);
    setExpandedKey(null);
    setExpandedSeries([]);

    try {
      // 取得選中的 run 資訊
      const selectedRun = forecastRuns.find(r => r.id === selectedRunId);
      const runTimeBuckets = selectedRun?.parameters?.time_buckets || [];
      const runPlantId = selectedRun?.parameters?.plant_id || null;

      if (runTimeBuckets.length === 0) {
        setInventoryError('此 Forecast Run 無有效的 time_buckets 設定');
        setInventoryMode('STOP');
        setInventorySummaryRows([]);
        setInventoryKpis({ itemsProjected: 0, atRiskItems: 0, earliestStockoutBucket: null, totalShortageQty: 0 });
        return;
      }

      // 根據 inbound source 決定參數
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
      setInventoryError(`載入庫存投影失敗: ${error.message}`);
      setInventoryMode('STOP');
    } finally {
      setInventoryLoading(false);
    }
  }, [user?.id, selectedRunId, forecastRuns, inventoryInboundSource, inventorySupplyRunId]);

  /**
   * 展開/收起單一 key 的 bucket series
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
   * 載入 Supply Forecast Runs（供 Inventory Tab 使用）
   */
  const loadSupplyForecastRunsForInventory = async () => {
    if (!user?.id) return;
    
    try {
      const runs = await supplyForecastService.listRuns(user.id, { limit: 20 });
      setSupplyForecastRunsForInventory(runs || []);
      
      // 如果有 runs 且目前沒有選擇，自動選擇第一個
      if (runs && runs.length > 0 && !inventorySupplyRunId) {
        setInventorySupplyRunId(runs[0].id);
      }
    } catch (error) {
      console.error('Error loading supply forecast runs for inventory:', error);
    }
  };

  /**
   * 處理 inbound source 切換
   */
  const handleInboundSourceChange = (source) => {
    setInventoryInboundSource(source);
    // 切換到 supply_forecast 時，自動載入 runs
    if (source === 'supply_forecast') {
      loadSupplyForecastRunsForInventory();
    }
  };

  /**
   * Run Probabilistic Inventory Forecast (Monte Carlo)
   */
  const handleRunProbForecast = async () => {
    if (!user?.id || !selectedRunId) {
      addNotification('請先選擇一個 Forecast Run', 'error');
      return;
    }

    setProbLoading(true);
    
    try {
      // Dynamic import to avoid circular dependency
      const { inventoryProbForecastService } = await import('../services/inventoryProbForecastService');
      
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
      const { inventoryProbForecastService } = await import('../services/inventoryProbForecastService');
      
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
      const { inventoryProbForecastService } = await import('../services/inventoryProbForecastService');
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
   * 執行 BOM Explosion
   */
  /**
   * 執行 BOM Explosion - Edge Function 兩段式流程
   * 1. 啟動 Edge Function job (立即回傳 batchId)
   * 2. 輪詢 import_batches 狀態直到 completed/failed
   */
  const handleRunBomExplosion = async () => {
    if (!user?.id) {
      addNotification('請先登入', 'error');
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

      // Step 1: 啟動 Edge Function job
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

      // Step 1.5: If reused, verify data actually exists — stale cache detection
      if (startResult.status === 'reused' && startResult.batchId) {
        const verifyResult = await componentDemandService.getComponentDemandsByBatch(
          user.id, startResult.batchId, { limit: 1, offset: 0 }
        );
        console.log('[BOM] Reuse verification:', { batchId: startResult.batchId, actualCount: verifyResult.count });

        if (!verifyResult.count || verifyResult.count === 0) {
          console.warn('[BOM] Reused batch has 0 component_demand rows — forcing new run');
          addNotification('快取資料已過期，重新計算中...', 'info');
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

      // Step 2: 開始輪詢狀態
      addNotification(
        `BOM Explosion 計算中... (Batch: ${startResult.batchId.slice(0, 8)})`,
        'info'
      );

      const callbacks = {
        onProgress: (status, metadata) => {
          console.log(`BOM Explosion progress: ${status}`, metadata);
          // 可選：更新 UI 顯示進度
          if (status === 'running') {
            // 顯示計算中的狀態
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

      // Step 3: 處理結果
      setRunResult(finalResult);

      if (finalResult.success) {
        const errorCount = finalResult.errors?.length || 0;
        if (errorCount > 0) {
          addNotification(
            `BOM Explosion 完成！產生 ${finalResult.componentDemandCount} 筆 Component 需求，但有 ${errorCount} 個警告`,
            'warning'
          );
        } else {
          addNotification(
            `BOM Explosion 完成！產生 ${finalResult.componentDemandCount} 筆 Component 需求，${finalResult.traceCount} 筆追溯記錄`,
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
          `BOM Explosion 失敗: ${finalResult.error}`,
          'error'
        );
        setRunError(finalResult.error || 'BOM Explosion 執行失敗');
      }

    } catch (error) {
      console.error('BOM Explosion failed:', error);
      const errorMsg = error.message || 'BOM Explosion 執行失敗';
      setRunError(errorMsg);
      addNotification(`BOM Explosion 執行失敗: ${errorMsg}`, 'error');
    } finally {
      setRunLoading(false);
    }
  };

  /**
   * 載入資料（Results 或 Trace）
   */
  const loadData = async () => {
    if (!selectedBatchId || !user?.id) return;
    
    setLoading(true);
    console.log('[loadData] START', { userId: user.id, batchId: selectedBatchId, activeTab, currentPage, filters });
    
    try {
      const offset = (currentPage - 1) * itemsPerPage;
      
      if (activeTab === 'results') {
        // Load component_demand
        const result = await componentDemandService.getComponentDemandsByBatch(
          user.id,
          selectedBatchId,
          {
            filters,
            limit: itemsPerPage,
            offset
          }
        );
        
        console.log('[loadData] component_demand result:', { count: result.count, dataLength: result.data?.length, firstRow: result.data?.[0] });
        setData(result.data || []);
        setTotalCount(result.count || 0);
      } else {
        // Load component_demand_trace
        const result = await componentDemandTraceService.getTracesByBatch(
          user.id,
          selectedBatchId,
          {
            filters,
            limit: itemsPerPage,
            offset
          }
        );
        
        console.log('[loadData] trace result:', { count: result.count, dataLength: result.data?.length, firstRow: result.data?.[0] });
        setData(result.data || []);
        setTotalCount(result.count || 0);
      }
    } catch (err) {
      console.error('[loadData] Error:', err);
      addNotification(`載入失敗: ${err.message}`, 'error');
      setData([]);
      setTotalCount(0);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Handle filter change
   */
  const handleFilterChange = (field, value) => {
    setFilters(prev => ({
      ...prev,
      [field]: value
    }));
    setCurrentPage(1);
  };

  /**
   * Clear all filters
   */
  const clearFilters = () => {
    setFilters({});
    setCurrentPage(1);
  };

  /**
   * Handle tab switch
   */
  const handleTabSwitch = (tab) => {
    setActiveTab(tab);
    setFilters({});
    setCurrentPage(1);
    setInventorySearchTerm('');
    setExpandedKey(null);
    setExpandedSeries([]);
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
   * 過濾後的 inventory summary rows
   */
  const filteredInventoryRows = inventorySummaryRows.filter(row => {
    if (!inventorySearchTerm) return true;
    const term = inventorySearchTerm.toLowerCase();
    return row.key.toLowerCase().includes(term);
  }).slice(0, FORECAST_TOP_N);

  /**
   * Handle batch selection
   */
  const handleBatchSelect = (batchId) => {
    setSelectedBatchId(batchId);
    setFilters({});
    setCurrentPage(1);
    setRunResult(null); // Clear run result when switching batches
  };

  /**
   * Download CSV
   */
  const handleDownloadCSV = () => {
    if (data.length === 0) {
      addNotification('無資料可匯出', 'warning');
      return;
    }

    try {
      // Get columns (exclude metadata columns)
      const excludeColumns = ['id', 'user_id', 'batch_id', 'updated_at'];
      const columns = Object.keys(data[0]).filter(key => !excludeColumns.includes(key));

      // Build CSV
      const headers = columns.join(',');
      const rows = data.map(row => {
        return columns.map(col => {
          const value = row[col];
          // Handle special types
          if (value === null || value === undefined) return '';
          if (typeof value === 'object') return JSON.stringify(value).replace(/"/g, '""');
          if (typeof value === 'string' && value.includes(',')) return `"${value}"`;
          return value;
        }).join(',');
      });

      const csv = [headers, ...rows].join('\n');

      // Create blob and download
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `forecast_${activeTab}_${selectedBatchId}_${new Date().toISOString().split('T')[0]}.csv`;
      link.click();
      URL.revokeObjectURL(url);

      addNotification(`已匯出 ${data.length} 筆資料`, 'success');
    } catch (error) {
      console.error('Error downloading CSV:', error);
      addNotification(`匯出失敗: ${error.message}`, 'error');
    }
  };

  /**
   * Get filter fields based on active tab
   */
  const getFilterFields = () => {
    if (activeTab === 'trace') {
      return [
        { key: 'bom_level', label: 'BOM Level', placeholder: '例如 1, 2, 3...' },
        { key: 'fg_material_code', label: 'FG Material', placeholder: '搜尋 FG 料號...' },
        { key: 'component_material_code', label: 'Component Material', placeholder: '搜尋 Component 料號...' }
      ];
    }
    // Results tab
    return [
      { key: 'material_code', label: 'Material Code', placeholder: '搜尋料號...' },
      { key: 'plant_id', label: 'Plant ID', placeholder: '搜尋工廠代碼...' },
      { key: 'time_bucket', label: 'Time Bucket', placeholder: '例如 2026-W02' }
    ];
  };

  /**
   * Get display columns
   */
  const getDisplayColumns = () => {
    if (data.length === 0) return [];
    
    if (activeTab === 'trace') {
      // Priority columns for trace
      const traceColumns = [
        'bom_level',
        'qty_multiplier',
        'trace_meta',
        'created_at'
      ];
      return traceColumns.filter(col => col in data[0]);
    }
    
    // Results: exclude metadata columns
    const excludeColumns = ['id', 'user_id', 'batch_id', 'updated_at'];
    return Object.keys(data[0])
      .filter(key => !excludeColumns.includes(key))
      .slice(0, 10);
  };

  /**
   * Render cell value
   */
  const renderCellValue = (row, col) => {
    const value = row[col];
    
    // Special handling for trace_meta
    if (col === 'trace_meta' && typeof value === 'object' && value !== null) {
      return (
        <div className="space-y-1 text-xs max-w-xs">
          {value.path && (
            <div className="truncate" title={JSON.stringify(value.path)}>
              <span className="font-semibold">Path:</span> {JSON.stringify(value.path)}
            </div>
          )}
          {value.fg_material_code && (
            <div><span className="font-semibold">FG:</span> {value.fg_material_code}</div>
          )}
          {value.component_material_code && (
            <div><span className="font-semibold">Comp:</span> {value.component_material_code}</div>
          )}
          {value.fg_qty !== undefined && (
            <div><span className="font-semibold">FG Qty:</span> {value.fg_qty}</div>
          )}
          {value.component_qty !== undefined && (
            <div><span className="font-semibold">Comp Qty:</span> {value.component_qty}</div>
          )}
        </div>
      );
    }
    
    // Default rendering
    if (typeof value === 'object' && value !== null) {
      return JSON.stringify(value).substring(0, 50) + '...';
    }
    if (typeof value === 'number') {
      return value.toLocaleString();
    }
    return String(value ?? '-').substring(0, 50);
  };

  /**
   * Pagination
   */
  const totalPages = Math.ceil(totalCount / itemsPerPage);
  const startItem = (currentPage - 1) * itemsPerPage + 1;
  const endItem = Math.min(currentPage * itemsPerPage, totalCount);

  const goToNextPage = () => {
    if (currentPage < totalPages) {
      setCurrentPage(currentPage + 1);
    }
  };

  const goToPrevPage = () => {
    if (currentPage > 1) {
      setCurrentPage(currentPage - 1);
    }
  };

  /**
   * ========== Cost Forecast Tab Functions ==========
   */
  
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
          `Cost Forecast 完成: ${result.kpis?.overall?.totalKeys || 0} keys, Total $${result.kpis?.overall?.totalCost?.toLocaleString() || 0}`,
          result.mode === 'degraded' ? 'warning' : 'success'
        );
        // Reload runs list
        await loadCostForecastRuns();
        if (result.costRunId) {
          setSelectedCostRunId(result.costRunId);
        }
      } else {
        addNotification(`Cost Forecast 失敗: ${result.error}`, 'error');
      }
    } catch (error) {
      console.error('Cost forecast failed:', error);
      addNotification(`Cost Forecast 失敗: ${error.message}`, 'error');
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

  // Load cost forecast data when tab is active
  useEffect(() => {
    if (activeTab === 'cost_forecast' && user?.id) {
      loadCostForecastRuns();
      loadCostRuleSets();
      loadInventoryProjectionRuns(); // Load source runs for dropdown
    }
  }, [activeTab, user?.id]);

  useEffect(() => {
    if (activeTab === 'cost_forecast' && selectedCostRunId) {
      handleCostRunSelect(selectedCostRunId);
    }
  }, [activeTab, selectedCostRunId]);

  // Load revenue forecast data when tab is active
  useEffect(() => {
    if (activeTab === 'revenue_forecast' && user?.id) {
      loadRevenueForecastRuns();
      loadRevenueTerms();
      loadInventoryProjectionRuns(); // Load source runs for dropdown
    }
  }, [activeTab, user?.id]);

  useEffect(() => {
    if (activeTab === 'revenue_forecast' && selectedRevenueRunId) {
      handleRevenueRunSelect(selectedRevenueRunId);
    }
  }, [activeTab, selectedRevenueRunId]);

  /**
   * ========== Revenue Forecast Tab Functions ==========
   */
  
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
          `Revenue Forecast 完成: ${result.kpis?.overall?.totalKeys || 0} FG keys, Margin at Risk $${result.kpis?.overall?.totalMarginAtRisk?.toLocaleString() || 0}`,
          result.mode === 'degraded' ? 'warning' : 'success'
        );
        // Reload runs list
        await loadRevenueForecastRuns();
        if (result.revenueRunId) {
          setSelectedRevenueRunId(result.revenueRunId);
        }
      } else {
        addNotification(`Revenue Forecast 失敗: ${result.error}`, 'error');
      }
    } catch (error) {
      console.error('Revenue forecast failed:', error);
      addNotification(`Revenue Forecast 失敗: ${error.message}`, 'error');
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

  /**
   * Format date
   */
  const formatDate = (dateString) => {
    if (!dateString) return '-';
    const date = new Date(dateString);
    return date.toLocaleString('zh-TW', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  /**
   * ========== Demand Forecast Tab Functions ==========
   */

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
      addNotification('請先登入', 'error');
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
        throw new Error('請提供至少一個 Time Bucket');
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
          `Demand Forecast 完成！產生 ${result.statistics.totalForecasts} 筆預測（${result.statistics.totalMaterials} 個 FG）`,
          'success'
        );
        // Reload runs list
        await loadDemandForecastRuns();
        if (result.forecastRunId) {
          setSelectedDemandRunId(result.forecastRunId);
        }
      } else {
        addNotification(`Demand Forecast 失敗: ${result.error}`, 'error');
      }
    } catch (error) {
      console.error('Demand forecast failed:', error);
      addNotification(`Demand Forecast 失敗: ${error.message}`, 'error');
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
      addNotification('無資料可匯出', 'warning');
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

      addNotification(`已匯出 ${demandForecastData.length} 筆預測資料`, 'success');
    } catch (error) {
      console.error('Error downloading CSV:', error);
      addNotification(`匯出失敗: ${error.message}`, 'error');
    }
  };

  // Load demand forecast data when tab is active and selection changes
  useEffect(() => {
    if (activeTab === 'demand_forecast' && user?.id) {
      loadDemandForecastRuns();
    }
  }, [activeTab, user?.id]);

  // Load demand forecast runs for BOM Explosion section when demand source is demand_forecast
  useEffect(() => {
    if (demandSource === 'demand_forecast' && user?.id) {
      loadDemandForecastRuns();
    }
  }, [demandSource, user?.id]);

  useEffect(() => {
    if (activeTab === 'demand_forecast' && selectedDemandRunId) {
      loadDemandForecastMaterials();
    }
  }, [activeTab, selectedDemandRunId]);

  useEffect(() => {
    if (activeTab === 'demand_forecast' && selectedDemandRunId) {
      loadDemandForecastData();
    }
  }, [activeTab, selectedDemandRunId, selectedDemandMaterial]);

  /**
   * ========== Supply Forecast Tab Functions ==========
   */

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
      addNotification('請先登入', 'error');
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
        throw new Error('請提供至少一個 Time Bucket');
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
          `Supply Forecast 完成！產生 ${result.statistics.supplierStatsCount} 個 Supplier Stats, ${result.statistics.inboundBucketsCount} 個 Inbound Buckets`,
          'success'
        );
        // Reload runs list
        await loadSupplyForecastRuns();
        if (result.forecastRunId) {
          setSelectedSupplyRunId(result.forecastRunId);
        }
      } else {
        addNotification(`Supply Forecast 失敗: ${result.error}`, 'error');
      }
    } catch (error) {
      console.error('Supply forecast failed:', error);
      addNotification(`Supply Forecast 失敗: ${error.message}`, 'error');
      setSfRunResult({ success: false, error: error.message });
    } finally {
      setSfRunLoading(false);
    }
  };

  // Load supply forecast data when tab is active
  useEffect(() => {
    if (activeTab === 'supply_forecast' && user?.id) {
      loadSupplyForecastRuns();
    }
  }, [activeTab, user?.id]);

  useEffect(() => {
    if (activeTab === 'supply_forecast' && selectedSupplyRunId) {
      loadSupplyForecastData();
    }
  }, [activeTab, selectedSupplyRunId]);

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
            執行 BOM Explosion 計算，查看和管理 Component 需求預測
          </p>
        </div>
      </div>

      {/* Run 區塊 */}
      <Card>
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <PlayCircle className="w-6 h-6 text-purple-500" />
            <div>
              <h3 className="font-semibold text-lg">執行 BOM Explosion</h3>
              <p className="text-sm text-slate-500">
                將 FG 需求展開為 Component 需求（需先上傳 demand_fg 和 bom_edge 資料）
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
                Plant ID（留空 = 全部工廠）
              </label>
              <input
                type="text"
                value={plantId}
                onChange={(e) => setPlantId(e.target.value)}
                placeholder="例如: P001（留空表示全部）"
                className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 focus:ring-2 focus:ring-purple-500 outline-none"
                disabled={runLoading}
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium">
                Time Buckets（留空 = 全部時間）
              </label>
              <input
                type="text"
                value={timeBuckets}
                onChange={(e) => setTimeBuckets(e.target.value)}
                placeholder="例如: 2026-W01, 2026-W02（逗號分隔）"
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
              {runLoading ? '計算中...' : 'Run BOM Explosion'}
            </Button>
          </div>

          {/* Error Display */}
          {runError && (
            <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <h4 className="font-semibold text-red-900 dark:text-red-100 mb-1">
                    執行失敗
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
                    Component 需求
                  </div>
                </div>

                <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
                  <div className="text-3xl font-bold text-blue-600">
                    {runResult.traceCount || 0}
                  </div>
                  <div className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                    追溯記錄
                  </div>
                </div>

                <div className="p-4 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-800">
                  <div className="text-3xl font-bold text-amber-600">
                    {runResult.errors?.length || 0}
                  </div>
                  <div className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                    錯誤/警告
                  </div>
                </div>

                <div className="p-4 bg-purple-50 dark:bg-purple-900/20 rounded-lg border border-purple-200 dark:border-purple-800">
                  <div className="text-2xl font-bold text-purple-600">
                    {runResult.success ? '✓' : '⚠'}
                  </div>
                  <div className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                    {runResult.success ? '成功' : '有警告'}
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
                        BOM Explosion 執行成功
                      </h4>
                      <p className="text-sm text-green-800 dark:text-green-200">
                        已產生 {runResult.componentDemandCount} 筆 Component 需求和 {runResult.traceCount} 筆追溯記錄。
                        {runResult.batchId && (
                          <span className="block mt-1">
                            批次 ID: <code className="px-2 py-0.5 bg-green-100 dark:bg-green-800 rounded text-xs font-mono">
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
                        錯誤/警告詳情 ({runResult.errors.length} 項)
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
            <h3 className="font-semibold text-lg">選擇批次</h3>
            <Button
              onClick={loadBatches}
              variant="secondary"
              size="sm"
              icon={RefreshCw}
              disabled={loadingBatches}
            >
              重新整理
            </Button>
          </div>

          {loadingBatches ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
            </div>
          ) : batches.length === 0 ? (
            <div className="py-8 text-center text-slate-500">
              <p>尚無批次記錄</p>
              <p className="text-sm mt-2">請先執行 BOM Explosion 計算</p>
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
                {activeTab === 'results' && (
                  <Badge variant="blue" className="ml-2">
                    {totalCount}
                  </Badge>
                )}
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
                {activeTab === 'trace' && (
                  <Badge variant="blue" className="ml-2">
                    {totalCount}
                  </Badge>
                )}
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
                {activeTab === 'inventory' && inventoryKpis.itemsProjected > 0 && (
                  <Badge variant="blue" className="ml-2">
                    {inventoryKpis.itemsProjected}
                  </Badge>
                )}
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
                {activeTab === 'demand_forecast' && demandForecastData.length > 0 && (
                  <Badge variant="blue" className="ml-2">
                    {demandForecastData.length}
                  </Badge>
                )}
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
                {activeTab === 'supply_forecast' && supplyForecastData.length > 0 && (
                  <Badge variant="blue" className="ml-2">
                    {supplyForecastData.length}
                  </Badge>
                )}
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
                {activeTab === 'cost_forecast' && costForecastData.length > 0 && (
                  <Badge variant="blue" className="ml-2">
                    {costForecastData.length}
                  </Badge>
                )}
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
                {activeTab === 'revenue_forecast' && revenueForecastData.length > 0 && (
                  <Badge variant="pink" className="ml-2">
                    {revenueForecastData.length}
                  </Badge>
                )}
              </button>
            </div>
          </Card>

          {/* Results/Trace Tab Content */}
          {(activeTab === 'results' || activeTab === 'trace') && selectedBatchId && (
            <>
              {/* Filters */}
              <Card className="bg-slate-50 dark:bg-slate-800/50">
                <div className="flex items-center justify-between mb-3">
                  <button
                    onClick={() => setShowFilters(!showFilters)}
                    className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-300 hover:text-purple-600 dark:hover:text-purple-400"
                  >
                    <Filter className="w-4 h-4" />
                    {showFilters ? '隱藏篩選' : '顯示篩選'}
                  </button>
                  <div className="flex items-center gap-2">
                    {Object.keys(filters).some(key => filters[key]) && (
                      <button
                        onClick={clearFilters}
                        className="text-sm text-purple-600 dark:text-purple-400 hover:underline"
                      >
                        清除篩選
                      </button>
                    )}
                    <Button
                      onClick={handleDownloadCSV}
                      variant="secondary"
                      size="sm"
                      icon={Download}
                      disabled={data.length === 0}
                    >
                      Download CSV
                    </Button>
                  </div>
                </div>

                {showFilters && (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    {getFilterFields().map(field => (
                      <div key={field.key}>
                        <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                          {field.label}
                        </label>
                        <div className="relative">
                          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                          <input
                            type="text"
                            placeholder={field.placeholder}
                            value={filters[field.key] || ''}
                            onChange={(e) => handleFilterChange(field.key, e.target.value)}
                            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 focus:ring-2 focus:ring-purple-500 outline-none"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              {/* Data Table */}
              <Card>
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="font-semibold text-lg">
                      {activeTab === 'results' ? 'Component Demand' : 'Trace Records'}
                    </h3>
                    <p className="text-sm text-slate-500">
                      共 {totalCount} 筆記錄
                    </p>
                  </div>
                </div>

                {loading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="w-8 h-8 animate-spin text-purple-500" />
                    <span className="ml-3 text-slate-600 dark:text-slate-400">載入中...</span>
                  </div>
                ) : data.length === 0 ? (
                  <div className="py-12 text-center">
                    <Database className="w-16 h-16 mx-auto text-slate-300 dark:text-slate-600 mb-4" />
                    <h3 className="text-lg font-semibold text-slate-600 dark:text-slate-400 mb-2">
                      無資料
                    </h3>
                    <p className="text-sm text-slate-500">
                      {Object.keys(filters).some(key => filters[key])
                        ? '請調整篩選條件'
                        : '此批次無資料'}
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-slate-100 dark:bg-slate-800 sticky top-0">
                          <tr>
                            <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">
                              #
                            </th>
                            {getDisplayColumns().map(col => (
                              <th key={col} className="px-3 py-2 text-left text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">
                                {col.replace(/_/g, ' ')}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                          {data.map((row, idx) => (
                            <tr key={idx} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                              <td className="px-3 py-2 text-slate-500 text-xs">
                                {startItem + idx}
                              </td>
                              {getDisplayColumns().map(col => (
                                <td key={col} className="px-3 py-2">
                                  {renderCellValue(row, col)}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {/* Pagination */}
                    {totalPages > 1 && (
                      <div className="mt-4 pt-4 border-t dark:border-slate-700">
                        <div className="flex items-center justify-between">
                          <div className="text-sm text-slate-600 dark:text-slate-400">
                            顯示 {startItem} - {endItem} / 共 {totalCount} 筆
                          </div>
                          
                          <div className="flex items-center gap-2">
                            <button
                              onClick={goToPrevPage}
                              disabled={currentPage === 1}
                              className="p-2 rounded-lg border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <ChevronLeft className="w-4 h-4" />
                            </button>
                            
                            <div className="px-4 py-2 text-sm font-medium">
                              Page {currentPage} / {totalPages}
                            </div>
                            
                            <button
                              onClick={goToNextPage}
                              disabled={currentPage === totalPages}
                              className="p-2 rounded-lg border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <ChevronRight className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </Card>
            </>
          )}

          {/* ========== Inventory Tab Content ========== */}
          {activeTab === 'inventory' && (
            <>
              {/* Run Selector */}
              <Card>
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-lg flex items-center gap-2">
                      <Calendar className="w-5 h-5 text-purple-500" />
                      選擇 Forecast Run
                    </h3>
                    <Button
                      onClick={() => loadForecastRuns(true)}
                      variant="secondary"
                      size="sm"
                      icon={RefreshCw}
                    >
                      重新整理
                    </Button>
                  </div>

                  {forecastRuns.length === 0 ? (
                    <div className="py-6 text-center text-slate-500">
                      <p>尚無 Forecast Run</p>
                      <p className="text-sm mt-1">請先執行 BOM Explosion 計算</p>
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
                              <span className="font-medium">Buckets:</span> {run.parameters?.time_buckets?.length || 0} 個
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
                        資料量較大，可能影響效能
                      </h4>
                      <p className="text-sm text-amber-800 dark:text-amber-200 mt-1">
                        目前載入 {inventoryPerf.totalRows.toLocaleString()} 筆資料（超過 {FORECAST_WARN_ROWS.toLocaleString()} 筆警告閾值）。
                        僅顯示前 {FORECAST_TOP_N} 個風險項目。
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
                        載入失敗
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
                        {inventoryLoading ? '載入中...' : `共 ${inventorySummaryRows.length} 個 keys（顯示前 ${Math.min(filteredInventoryRows.length, FORECAST_TOP_N)} 個）`}
                      </p>
                    </div>
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                      <input
                        type="text"
                        placeholder="搜尋 Key (MATERIAL|PLANT)..."
                        value={inventorySearchTerm}
                        onChange={(e) => setInventorySearchTerm(e.target.value)}
                        className="pl-9 pr-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 focus:ring-2 focus:ring-purple-500 outline-none w-64"
                      />
                    </div>
                  </div>

                  {inventoryLoading ? (
                    <div className="flex items-center justify-center py-12">
                      <Loader2 className="w-8 h-8 animate-spin text-purple-500" />
                      <span className="ml-3 text-slate-600 dark:text-slate-400">載入投影資料中...</span>
                    </div>
                  ) : filteredInventoryRows.length === 0 ? (
                    <div className="py-12 text-center">
                      <Package className="w-16 h-16 mx-auto text-slate-300 dark:text-slate-600 mb-4" />
                      <h3 className="text-lg font-semibold text-slate-600 dark:text-slate-400 mb-2">
                        無投影資料
                      </h3>
                      <p className="text-sm text-slate-500">
                        {inventorySearchTerm ? '請調整搜尋條件' : '選擇的 Run 無 component_demand 資料'}
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
                          {filteredInventoryRows.map((row, idx) => (
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
                                        Bucket Series（可手算驗證：end = begin + inbound - demand）
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
                                            {expandedSeries.map((s, sIdx) => (
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
          )}
        </>
      )}

      {/* ========== Demand Forecast Tab Content ========== */}
      {activeTab === 'demand_forecast' && (
        <>
          {/* Run Execution Section */}
          <Card>
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <PlayCircle className="w-6 h-6 text-purple-500" />
                <div>
                  <h3 className="font-semibold text-lg">執行 Demand Forecast</h3>
                  <p className="text-sm text-slate-500">
                    使用 Moving Average (MA) 演算法預測 FG 需求（需先上傳 demand_fg 資料）
                  </p>
                </div>
              </div>

              {/* Input Filters */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-4 border-t dark:border-slate-700">
                <div className="space-y-2">
                  <label className="block text-sm font-medium">
                    Plant ID（留空 = 全部工廠）
                  </label>
                  <input
                    type="text"
                    value={dfPlantId}
                    onChange={(e) => setDfPlantId(e.target.value)}
                    placeholder="例如: P001"
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
                    placeholder="例如: 2026-W10, 2026-W11, 2026-W12"
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
                  {dfRunLoading ? '計算中...' : 'Run Demand Forecast'}
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
                        {dfRunResult.success ? 'Demand Forecast 完成' : '執行失敗'}
                      </h4>
                      {dfRunResult.success ? (
                        <div className="text-sm text-green-800 dark:text-green-200 space-y-1">
                          <p>產生 {dfRunResult.statistics.totalForecasts} 筆預測（{dfRunResult.statistics.totalMaterials} 個 FG）</p>
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
                  選擇 Demand Forecast Run
                </h3>
                <Button
                  onClick={loadDemandForecastRuns}
                  variant="secondary"
                  size="sm"
                  icon={RefreshCw}
                >
                  重新整理
                </Button>
              </div>

              {demandForecastRuns.length === 0 ? (
                <div className="py-6 text-center text-slate-500">
                  <p>尚無 Demand Forecast Run</p>
                  <p className="text-sm mt-1">請先執行 Demand Forecast 計算</p>
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
                  選擇 FG Material
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
                    全部 ({demandForecastData.length} 筆)
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
                      <h3 className="font-semibold text-lg">AI 雙模型預測</h3>
                      <p className="text-sm text-slate-500">
                        使用 LightGBM 穩定性與 Amazon Chronos AI 泛化能力的組合預測
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
                        預測天數
                      </label>
                      <select
                        value={forecastHorizon}
                        onChange={(e) => setForecastHorizon(parseInt(e.target.value))}
                        className="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 focus:ring-2 focus:ring-purple-500 outline-none"
                        disabled={dualModelLoading}
                      >
                        <option value={7}>7 天</option>
                        <option value={14}>14 天</option>
                        <option value={30}>30 天</option>
                        <option value={60}>60 天</option>
                        <option value={90}>90 天</option>
                      </select>
                    </div>

                    <div className="space-y-2">
                      <label className="block text-sm font-medium">
                        顯示模型比較
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
                          啟用模型對比分析
                        </label>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <label className="block text-sm font-medium invisible">
                        執行預測
                      </label>
                      <Button
                        onClick={() => executeDualModelForecast(selectedDemandMaterial)}
                        disabled={dualModelLoading || !selectedDemandMaterial}
                        variant="primary"
                        icon={dualModelLoading ? Loader2 : Brain}
                        className="w-full"
                      >
                        {dualModelLoading ? '預測中...' : '執行 AI 預測'}
                      </Button>
                    </div>
                  </div>

                  {/* SKU Analysis Display */}
                  {skuAnalysis && (
                    <div className="bg-slate-50 dark:bg-slate-800 rounded-lg p-4">
                      <h4 className="font-medium text-slate-900 dark:text-slate-100 mb-2">
                        SKU 分析結果
                      </h4>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                        <div>
                          <span className="text-slate-500">數據點數:</span>
                          <div className="font-medium">{skuAnalysis.analysis?.data_points || 'N/A'}</div>
                        </div>
                        <div>
                          <span className="text-slate-500">推薦模型:</span>
                          <div className="font-medium">{skuAnalysis.recommended_model?.toUpperCase() || 'N/A'}</div>
                        </div>
                        <div>
                          <span className="text-slate-500">數據充足性:</span>
                          <div className="font-medium">{skuAnalysis.analysis?.data_sufficiency || 'N/A'}</div>
                        </div>
                        <div>
                          <span className="text-slate-500">Chronos 適合性:</span>
                          <div className="font-medium">
                            {skuAnalysis.chronos_suitability?.suitable ? '適合' : '不適合'}
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
                        預測統計分析
                      </h3>
                      
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4">
                          <div className="text-2xl font-bold text-blue-600">
                            {dualModelForecast.forecast.median?.toFixed(0) || 'N/A'}
                          </div>
                          <div className="text-sm text-blue-600">主要預測均值</div>
                          <div className="text-xs text-blue-500 mt-1">
                            {dualModelForecast.forecast.model?.toUpperCase()}
                          </div>
                        </div>
                        
                        <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-4">
                          <div className="text-2xl font-bold text-green-600">
                            {dualModelForecast.forecast.risk_score?.toFixed(0) || 'N/A'}
                          </div>
                          <div className="text-sm text-green-600">風險分數</div>
                          <div className="text-xs text-green-500 mt-1">
                            {dualModelForecast.forecast.risk_score < 30 ? '低風險' : 
                             dualModelForecast.forecast.risk_score < 70 ? '中風險' : '高風險'}
                          </div>
                        </div>
                        
                        {dualModelForecast.comparison && (
                          <div className="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-4">
                            <div className="text-2xl font-bold text-purple-600">
                              {dualModelForecast.comparison.deviation_pct?.toFixed(1) || '0'}%
                            </div>
                            <div className="text-sm text-purple-600">模型偏差</div>
                            <div className="text-xs text-purple-500 mt-1">
                              {dualModelForecast.comparison.agreement_level}
                            </div>
                          </div>
                        )}
                        
                        <div className="bg-orange-50 dark:bg-orange-900/20 rounded-lg p-4">
                          <div className="text-2xl font-bold text-orange-600">
                            {forecastHorizon}
                          </div>
                          <div className="text-sm text-orange-600">預測天數</div>
                          <div className="text-xs text-orange-500 mt-1">
                            {dualModelForecast.cached ? '快取結果' : '即時計算'}
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
                          AI 預測失敗
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
                <h3 className="font-semibold text-lg">Demand Forecast 結果</h3>
                <p className="text-sm text-slate-500">
                  {demandForecastLoading ? '載入中...' : `共 ${demandForecastData.length} 筆預測`}
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
                <span className="ml-3 text-slate-600 dark:text-slate-400">載入中...</span>
              </div>
            ) : demandForecastError ? (
              <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                <p className="text-red-800 dark:text-red-200">{demandForecastError}</p>
              </div>
            ) : demandForecastData.length === 0 ? (
              <div className="py-12 text-center">
                <TrendingUp className="w-16 h-16 mx-auto text-slate-300 dark:text-slate-600 mb-4" />
                <h3 className="text-lg font-semibold text-slate-600 dark:text-slate-400 mb-2">
                  無預測資料
                </h3>
                <p className="text-sm text-slate-500">
                  請選擇一個 Demand Forecast Run
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
                      歷史 Demand FG 資料（最近 {demandHistoricalData.length} 筆）
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
      )}

      {/* ========== Supply Forecast Tab Content ========== */}
      {activeTab === 'supply_forecast' && (
        <>
          {/* Run Execution Section */}
          <Card>
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <PlayCircle className="w-6 h-6 text-purple-500" />
                <div>
                  <h3 className="font-semibold text-lg">執行 Supply Forecast</h3>
                  <p className="text-sm text-slate-500">
                    預測供應到貨時間/可靠度（Lead time distribution、On-time rate、Delay risk）
                  </p>
                </div>
              </div>

              {/* Input Filters */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-4 border-t dark:border-slate-700">
                <div className="space-y-2">
                  <label className="block text-sm font-medium">
                    Plant ID（留空 = 全部工廠）
                  </label>
                  <input
                    type="text"
                    value={sfPlantId}
                    onChange={(e) => setSfPlantId(e.target.value)}
                    placeholder="例如: P001"
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
                    placeholder="例如: 2026-W10, 2026-W11, 2026-W12"
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
                  {sfRunLoading ? '計算中...' : 'Run Supply Forecast'}
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
                        {sfRunResult.success ? 'Supply Forecast 完成' : '執行失敗'}
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
                  選擇 Supply Forecast Run
                </h3>
                <Button
                  onClick={loadSupplyForecastRuns}
                  variant="secondary"
                  size="sm"
                  icon={RefreshCw}
                >
                  重新整理
                </Button>
              </div>

              {supplyForecastRuns.length === 0 ? (
                <div className="py-6 text-center text-slate-500">
                  <p>尚無 Supply Forecast Run</p>
                  <p className="text-sm mt-1">請先執行 Supply Forecast 計算</p>
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
                  {supplyForecastLoading ? '載入中...' : `共 ${supplyForecastData.length} 個 Inbound Buckets`}
                </p>
              </div>
            </div>

            {supplyForecastLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-8 h-8 animate-spin text-purple-500" />
                <span className="ml-3 text-slate-600 dark:text-slate-400">載入中...</span>
              </div>
            ) : supplyForecastError ? (
              <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                <p className="text-red-800 dark:text-red-200">{supplyForecastError}</p>
              </div>
            ) : supplyForecastData.length === 0 ? (
              <div className="py-12 text-center">
                <Package className="w-16 h-16 mx-auto text-slate-300 dark:text-slate-600 mb-4" />
                <h3 className="text-lg font-semibold text-slate-600 dark:text-slate-400 mb-2">
                  無供應預測資料
                </h3>
                <p className="text-sm text-slate-500">
                  請選擇一個 Supply Forecast Run
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
                    關閉
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
      )}

      {/* ========== Cost Forecast Tab ========== */}
      {activeTab === 'cost_forecast' && (
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
                  {costRunLoading ? '計算中...' : 'Run Cost Forecast'}
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
                        {costRunResult.success ? 'Cost Forecast 完成' : '執行失敗'}
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
                  選擇 Cost Forecast Run
                </h3>
                <Button
                  onClick={loadCostForecastRuns}
                  variant="secondary"
                  size="sm"
                  icon={RefreshCw}
                >
                  重新整理
                </Button>
              </div>

              {costForecastRuns.length === 0 ? (
                <div className="py-6 text-center text-slate-500">
                  <p>尚無 Cost Forecast Run</p>
                  <p className="text-sm mt-1">請先執行 Cost Forecast 計算</p>
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
                  {costForecastLoading ? '載入中...' : `共 ${costForecastData.length} 個 Keys`}
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
                <span className="ml-3 text-slate-600 dark:text-slate-400">載入中...</span>
              </div>
            ) : costForecastError ? (
              <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                <p className="text-red-800 dark:text-red-200">{costForecastError}</p>
              </div>
            ) : costForecastData.length === 0 ? (
              <div className="py-12 text-center">
                <DollarSign className="w-16 h-16 mx-auto text-slate-300 dark:text-slate-600 mb-4" />
                <h3 className="text-lg font-semibold text-slate-600 dark:text-slate-400 mb-2">
                  無成本預測資料
                </h3>
                <p className="text-sm text-slate-500">
                  請選擇一個 Cost Forecast Run
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
                    關閉
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
                            {action === 'expedite' && 'Shortage × Unit Cost'}
                            {action === 'substitution' && 'Fixed + (Shortage × Var Cost)'}
                            {action === 'disruption' && 'P(Stockout) × Cost If Stockout'}
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
      )}

      {/* ========== Revenue Forecast Tab ========== */}
      {activeTab === 'revenue_forecast' && (
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
                  {revenueRunLoading ? '計算中...' : 'Run Revenue Forecast'}
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
                        {revenueRunResult.success ? 'Revenue Forecast 完成' : '執行失敗'}
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
                選擇 Revenue Forecast Run
              </h3>
              <Button
                onClick={loadRevenueForecastRuns}
                variant="outline"
                size="sm"
                icon={RefreshCw}
              >
                重新整理
              </Button>
            </div>

            {revenueForecastRuns.length === 0 ? (
              <div className="py-6 text-center text-slate-500">
                <p>尚無 Revenue Forecast Run</p>
                <p className="text-sm mt-1">請先執行 Revenue Forecast 計算</p>
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
                  {revenueForecastLoading ? '載入中...' : `共 ${revenueForecastData.length} rows`}
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
                <p className="text-slate-500">載入中...</p>
              </div>
            ) : revenueForecastData.length === 0 ? (
              <div className="py-12 text-center text-slate-500">
                <TrendingUp className="w-16 h-16 mx-auto text-slate-300 dark:text-slate-600 mb-4" />
                <h3 className="text-lg font-semibold text-slate-600 dark:text-slate-400 mb-2">
                  無營收預測資料
                </h3>
                <p className="text-sm text-slate-500">
                  請選擇一個 Revenue Forecast Run
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
      )}
    </div>
  );
};

export default ForecastsView;
