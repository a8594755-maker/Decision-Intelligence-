/**
 * Risk Dashboard View - Supply Coverage Risk
 *
 * 資料流：
 * 1. 載入 Forecast Runs（可選 run_id）
 * 2. 載入 Open PO（必需）+ Inventory Snapshots（可選）+ component_demand（依 forecast_run_id）
 * 3. Domain 計算（coverageCalculator）→ Inventory risk（daysToStockout / P(stockout)）→ Profit at Risk
 * 4. mapSupplyCoverageToUI → uiRows
 * 5. KPI/Table/Details 全部從 uiRows 派生
 *
 * Horizon: 固定 3 buckets
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Loader2, RefreshCw, AlertCircle, Calculator } from 'lucide-react';
import { Button } from '../components/ui';
import { supabase } from '../services/supabaseClient';
import { forecastRunsService, componentDemandService } from '../services/supabaseClient';

// Domain 層計算函數
import { calculateSupplyCoverageRiskBatch } from '../domains/risk/coverageCalculator.js';
import { calculateInventoryRisk } from '../domains/inventory/calculator.js';

// Profit at Risk 計算（M2）
import {
  calculateProfitAtRiskBatch,
  getFallbackAssumption
} from '../domains/risk/profitAtRiskCalculator.js';

// Risk Dashboard 子元件
import FilterBar from '../components/risk/FilterBar';
import KPICards from '../components/risk/KPICards';
import RiskTable from '../components/risk/RiskTable';
import DetailsPanel from '../components/risk/DetailsPanel';
import AuditTimeline from '../components/risk/AuditTimeline'; // M7.3 WP3

// 資料轉換 Adapter（新版）
import { mapSupplyCoverageToUI } from '../components/risk/mapDomainToUI';

// PO 正規化、component_demand 彙總
import { normalizeOpenPOBatch } from '../utils/poNormalizer';
import { aggregateComponentDemandToDaily, normalizeKey } from '../utils/componentDemandAggregator';

// 固定 Horizon（Bucket-Based）
const HORIZON_BUCKETS = 3; // 未來 N 個 time_bucket
const DEFAULT_LEAD_TIME_DAYS = 7; // Inventory domain 用於 P(stockout)

const RiskDashboardView = ({ user, addNotification }) => {
  // ========== State 管理 ==========
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [uiRows, setUiRows] = useState([]); // 單一資料來源

  // Forecast Run 選擇（可選；null = 使用 latest run）
  const [forecastRunsList, setForecastRunsList] = useState([]);
  const [selectedForecastRunId, setSelectedForecastRunId] = useState(null); // null = "Latest"
  const [activeForecastRun, setActiveForecastRun] = useState(null); // 本次載入實際使用的 run { id, scenario_name, created_at }
  const [componentDemandCountForRun, setComponentDemandCountForRun] = useState(0); // 該 run 的 component_demand 筆數（0 = 無資料或未選 run）

  // 篩選與搜尋
  const [plants, setPlants] = useState(['all']);
  const [selectedPlant, setSelectedPlant] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedRiskLevel, setSelectedRiskLevel] = useState('all');

  // 右側 Details Panel
  const [selectedRow, setSelectedRow] = useState(null);

  // 資料批次時間
  const [dataSnapshotTime, setDataSnapshotTime] = useState(null);

  // 診斷 KPI（A3: demandKeysWithoutRiskRow / riskRowsWithoutDemand 供 key 對齊 debug）
  const [diagnostics, setDiagnostics] = useState({
    inventoryPairs: 0,
    poPairs: 0,
    unionPairs: 0,
    matchedPairs: 0,
    inboundPairsInHorizon: 0,
    demandKeysWithoutRiskRow: 0,
    riskRowsWithoutDemand: 0
  });

  // Profit at Risk 汇总（M2）
  const [profitSummary, setProfitSummary] = useState({
    totalProfitAtRisk: 0,
    criticalProfitAtRisk: 0,
    warningProfitAtRisk: 0,
    itemsWithRealFinancials: 0,
    itemsWithAssumption: 0,
    usingFallback: false
  });

  // Probabilistic forecast data (Step 2: P0)
  const [probResults, setProbResults] = useState({}); // Map<key, probSummary>
  const [probSeriesCache, setProbSeriesCache] = useState({}); // Map<key, series[]>
  const [loadingProb, setLoadingProb] = useState(false);
  const [hasProbResults, setHasProbResults] = useState(false);

  // Revenue at Risk data (M6 Gate-R5)
  const [revenueState, setRevenueState] = useState({
    mode: 'none', // 'none' | 'loaded' | 'degraded'
    reason: null,
    revenueRunId: null,
    summaryByKey: {}, // Map: key -> { marginAtRisk, penaltyAtRisk, totalAtRisk }
    perf: { loadMs: 0 }
  });

  // Risk Score data (M7 Gate-7.1)
  const [riskScoreState, setRiskScoreState] = useState({
    mode: 'none', // 'none' | 'loaded' | 'degraded'
    scoreByKey: {}, // Map: key -> { score, pStockout, impactUsd, urgencyWeight }
    perf: { loadMs: 0 }
  });
  const [calculatingRiskScores, setCalculatingRiskScores] = useState(false);

  // M7.3 WP3: Audit Timeline state
  const [auditEvents, setAuditEvents] = useState([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [selectedAuditEvent, setSelectedAuditEvent] = useState(null);
  const [replayDraft, setReplayDraft] = useState(null); // For What-if replay

  // ========== 資料載入 ==========

  const loadRiskData = async () => {
    if (!user?.id) return;

    setLoading(true);
    setError(null);

    try {
      // Step 0: 載入 Forecast Runs 清單，並決定本次使用的 run_id
      let runsList = [];
      try {
        runsList = await forecastRunsService.listRuns(user.id, { limit: 30 });
        setForecastRunsList(runsList || []);
      } catch (e) {
        console.warn('載入 forecast runs 失敗（將不使用 component_demand）:', e);
      }

      const runId = selectedForecastRunId || (runsList && runsList[0]?.id) || null;
      const runMeta = runId ? runsList.find(r => r.id === runId) || { id: runId, scenario_name: 'baseline', created_at: null } : null;
      setActiveForecastRun(runMeta);
      if (!runId) setComponentDemandCountForRun(0);

      // Step 0.5: 依 forecast_run_id 載入 component_demand 並彙總為 (material, plant) → dailyDemand
      let componentDemandAggregated = {};
      if (runId) {
        try {
          const runParams = runMeta?.parameters || {};
          const timeBucketsFromRun = Array.isArray(runParams.time_buckets) ? runParams.time_buckets : null;
          const t0 = performance.now();
          const demandRows = await componentDemandService.getComponentDemandsByForecastRun(user.id, runId, {
            timeBuckets: timeBucketsFromRun || undefined
          });
          const fetchMs = Math.round(performance.now() - t0);
          setComponentDemandCountForRun(demandRows?.length ?? 0);
          const t1 = performance.now();
          componentDemandAggregated = aggregateComponentDemandToDaily(demandRows, HORIZON_BUCKETS, {
            timeBuckets: timeBucketsFromRun,
            horizonBuckets: timeBucketsFromRun ? undefined : HORIZON_BUCKETS,
            daysPerBucket: 7
          });
          const aggregateMs = Math.round(performance.now() - t1);
          console.log(`📦 Forecast Run ${runId}: fetch ${demandRows?.length ?? 0} rows in ${fetchMs}ms, aggregate ${aggregateMs}ms → ${Object.keys(componentDemandAggregated).length} keys${timeBucketsFromRun ? ` (time_bucket in ${timeBucketsFromRun.length} buckets)` : ''}`);
        } catch (e) {
          setComponentDemandCountForRun(0);
          console.warn('載入 component_demand 失敗（Risk 將不顯示 daysToStockout）:', e);
          addNotification(`無法載入該 Forecast Run 的需求資料: ${e.message}`, 'warning');
        }
      }

      // Step 1: 載入 Open PO（必需）
      const { data: rawPoData, error: poError } = await supabase
        .from('po_open_lines')
        .select('*')
        .eq('user_id', user.id)
        .order('time_bucket', { ascending: true });

      if (poError) {
        console.error('PO 查詢錯誤:', poError);
        if (poError.code === '42P01') {
          throw new Error('資料表 po_open_lines 尚未建立，請聯絡管理員');
        }
        throw new Error(`載入 PO 資料失敗: ${poError.message}`);
      }

      if (!rawPoData || rawPoData.length === 0) {
        throw new Error('EMPTY_PO_DATA');
      }

      // Step 2: 載入庫存快照（可選）
      let inventoryData = [];
      const { data: invData, error: invError } = await supabase
        .from('inventory_snapshots')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (invError) {
        console.warn('載入庫存資料失敗（將使用 0 庫存）:', invError);
      } else {
        inventoryData = invData || [];
        setDataSnapshotTime(invData?.[0]?.created_at || new Date());
      }

      // Step 2.5: 載入 FG Financials（M2 - Profit at Risk）
      let financialsData = [];
      const { data: finData, error: finError } = await supabase
        .from('fg_financials')
        .select('*')
        .eq('user_id', user.id);

      if (finError) {
        console.warn('載入 financials 資料失敗（將使用 fallback 假設）:', finError);
      } else {
        financialsData = finData || [];
        console.log(`💰 載入 ${financialsData.length} 筆 financials 資料`);
      }

      // 正規化 PO 資料
      const normalizedPOData = normalizeOpenPOBatch(rawPoData);
      if (normalizedPOData.length === 0) {
        throw new Error('PO 資料正規化後為空（可能欄位格式錯誤）');
      }

      // Step 2.6: 載入 suppliers（A2: leadTimeDays 來源）→ 建 (item|factory) -> { leadTimeDays, source }
      let supplierIdToLeadDays = {};
      try {
        const { data: suppliersData } = await supabase
          .from('suppliers')
          .select('id, lead_time_days')
          .eq('user_id', user.id);
        if (suppliersData?.length) {
          suppliersData.forEach(s => {
            const lt = s.lead_time_days != null ? parseFloat(s.lead_time_days) : NaN;
            if (!isNaN(lt) && lt >= 0) supplierIdToLeadDays[s.id] = lt;
          });
        }
      } catch (e) {
        console.warn('載入 suppliers（lead_time_days）失敗，將使用預設值:', e);
      }
      const keyToLeadTime = {};
      normalizedPOData.forEach(po => {
        const key = normalizeKey(po.item, po.factory);
        if (!key || key === '|') return;
        if (keyToLeadTime[key] != null) return;
        const sid = po.supplierId || po._raw?.supplier_id;
        const days = sid ? supplierIdToLeadDays[sid] : undefined;
        if (typeof days === 'number' && days >= 0) {
          keyToLeadTime[key] = { leadTimeDays: days, source: 'supplier' };
        } else {
          keyToLeadTime[key] = { leadTimeDays: DEFAULT_LEAD_TIME_DAYS, source: 'fallback' };
        }
      });

      // 診斷：Inventory / PO / Matched pairs（A3: 全用 normalizeKey 對齊）
      const inventoryPairsSet = new Set();
      inventoryData.forEach(inv => {
        const key = normalizeKey(inv.material_code || inv.item, inv.plant_id || inv.factory);
        if (key && key !== '|') inventoryPairsSet.add(key);
      });
      const poPairsSet = new Set();
      normalizedPOData.forEach(po => {
        const key = normalizeKey(po.item, po.factory);
        if (key && key !== '|') poPairsSet.add(key);
      });
      const matchedPairsSet = new Set();
      poPairsSet.forEach(key => { if (inventoryPairsSet.has(key)) matchedPairsSet.add(key); });
      const unionKeys = new Set([...inventoryPairsSet, ...poPairsSet]);

      // A3: debug 用 mismatch 計數（demand 有但 risk 無 / risk 有但 demand 無）
      const demandKeySet = new Set(Object.keys(componentDemandAggregated));
      const demandKeysWithoutRisk = [...demandKeySet].filter(k => !unionKeys.has(k)).length;
      const riskRowsWithoutDemand = [...unionKeys].filter(k => !demandKeySet.has(k)).length;
      console.log('📊 診斷: Inv pairs', inventoryPairsSet.size, 'PO pairs', poPairsSet.size, 'Matched', matchedPairsSet.size);
      console.log('📊 Key 對齊: demand keys 無對應 risk row', demandKeysWithoutRisk, '| risk rows 無對應 demand', riskRowsWithoutDemand);

      // Step 3: Domain 計算（Supply Coverage Risk - Bucket-Based）
      const domainResults = calculateSupplyCoverageRiskBatch({
        openPOs: normalizedPOData,
        inventorySnapshots: inventoryData,
        horizonBuckets: HORIZON_BUCKETS
      });

      // Step 3.5: 使用 component_demand 彙總 + Inventory domain 計算 daysToStockout / P(stockout)；A2: leadTimeDays 從 supplier 或 fallback
      domainResults.forEach(row => {
        const key = normalizeKey(row.item, row.factory);
        const demandInfo = componentDemandAggregated[key];
        const dailyDemand = demandInfo?.dailyDemand;
        const onHand = row.onHand != null ? row.onHand : 0;
        const safetyStock = row.safetyStock != null ? row.safetyStock : 0;
        const ltInfo = keyToLeadTime[key] || { leadTimeDays: DEFAULT_LEAD_TIME_DAYS, source: 'fallback' };
        row.leadTimeDaysUsed = ltInfo.leadTimeDays;
        row.leadTimeDaysSource = ltInfo.source;

        if (typeof dailyDemand === 'number' && dailyDemand > 0) {
          try {
            const invRisk = calculateInventoryRisk({
              currentStock: onHand,
              safetyStock,
              dailyDemand,
              leadTimeDays: ltInfo.leadTimeDays,
              demandVolatility: 0.1
            });
            row.daysToStockout = invRisk.daysToStockout;
            row.stockoutProbability = invRisk.probability;
          } catch (e) {
            console.warn(`Inventory risk 計算跳過 ${key}:`, e);
          }
        }
      });

      // Step 4: 計算 Profit at Risk（M2）
      const { rows: rowsWithProfit, summary: profitSummaryData } = calculateProfitAtRiskBatch({
        riskRows: domainResults,
        financials: financialsData,
        useFallback: true
      });

      console.log('💰 Profit at Risk 汇总:', profitSummaryData);

      // Step 5: 轉換為 UI 格式
      const warnings = [];
      const calculatedRows = rowsWithProfit.map(domainResult => {
        const rowWarnings = [];
        const uiRow = mapSupplyCoverageToUI(domainResult, rowWarnings);
        warnings.push(...rowWarnings);
        return uiRow;
      });

      // 設定 Profit Summary
      setProfitSummary({
        ...profitSummaryData,
        usingFallback: financialsData.length === 0 || profitSummaryData.itemsWithAssumption > 0
      });

      // 診斷：計算 Union pairs 和 Inbound pairs in horizon
      const unionPairsSet = new Set();
      const inboundPairsSet = new Set();
      
      calculatedRows.forEach(row => {
        const key = `${row.item}|${row.plantId}`;
        unionPairsSet.add(key);
        
        if (row.inboundCount > 0) {
          inboundPairsSet.add(key);
        }
        
        // 🔍 診斷：檢查工廠欄位錯位
        if (typeof row.plantId === 'number' && [5, 10, 50].includes(row.plantId)) {
          console.warn('⚠️ 工廠欄位疑似錯位:', {
            item: row.item,
            plantId: row.plantId,
            factory: row.factory,
            onHand: row.onHand,
            inboundQty: row.inboundQty,
            _raw: row._raw
          });
        }
      });

      // 設定診斷 KPI（含 A3: key 對齊 mismatch 計數，供 debug/panel 使用）
      setDiagnostics({
        inventoryPairs: inventoryPairsSet.size,
        poPairs: poPairsSet.size,
        unionPairs: unionPairsSet.size,
        matchedPairs: matchedPairsSet.size,
        inboundPairsInHorizon: inboundPairsSet.size,
        demandKeysWithoutRiskRow: demandKeysWithoutRisk,
        riskRowsWithoutDemand
      });

      console.log('📊 診斷資訊（計算後）:');
      console.log(`- Union pairs (Inventory ∪ PO): ${unionPairsSet.size}`);
      console.log(`- Inbound pairs in horizon: ${inboundPairsSet.size}`);

      // 提取 unique plants
      const uniquePlants = new Set();
      calculatedRows.forEach(row => {
        if (row.plantId) uniquePlants.add(row.plantId);
      });

      // 設定單一資料來源（真實資料模式）
      setUiRows(calculatedRows);
      setPlants(['all', ...Array.from(uniquePlants).sort()]);

      // 顯示警告（如果有）
      if (warnings.length > 0) {
        console.warn('資料轉換警告:', warnings);
      }

      addNotification(`已載入 ${calculatedRows.length} 筆風險資料（REAL DATA）`, 'success');
    } catch (error) {
      console.error('載入風險資料失敗:', error);
      
      if (error.message === 'EMPTY_PO_DATA') {
        setError({
          type: 'empty',
          message: '尚無 Open PO 資料',
          hint: '請至「資料上傳」頁面匯入以下模板',
          templates: ['po_open_lines.xlsx (必需)', 'inventory_snapshots.xlsx (選填)']
        });
      } else {
        setError({
          type: 'error',
          message: error.message || '載入失敗',
          hint: '請檢查資料來源或聯絡管理員'
        });
      }
      
      addNotification(`載入失敗: ${error.message}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadRiskData();
  }, [user, selectedForecastRunId]);

  // ========== 派生資料（從 uiRows 單一來源）==========

  // 篩選後的資料（含 Revenue 整合 M6 Gate-R5）
  const filteredRows = useMemo(() => {
    let filtered = [...uiRows];

    if (selectedPlant !== 'all') {
      filtered = filtered.filter(r => r.plantId === selectedPlant);
    }

    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase();
      filtered = filtered.filter(r => 
        (r.item || '').toLowerCase().includes(term) ||
        (r.materialCode || '').toLowerCase().includes(term)
      );
    }

    if (selectedRiskLevel !== 'all') {
      filtered = filtered.filter(r => r.riskLevel === selectedRiskLevel);
    }

    // Merge revenue data (M6 Gate-R5) and risk score data (M7 Gate-7.1)
    return filtered.map(row => {
      const key = `${row.item}|${row.plantId}`;
      const revData = revenueState.summaryByKey[key];
      const scoreData = riskScoreState.scoreByKey[key];
      
      return {
        ...row,
        revMarginAtRisk: revData?.marginAtRisk || null,
        revPenaltyAtRisk: revData?.penaltyAtRisk || null,
        revTotalAtRisk: revData?.totalAtRisk || null,
        hasRevenueData: !!revData,
        riskScore: scoreData?.score || null,
        riskScorePStockout: scoreData?.pStockout || null,
        riskScoreImpact: scoreData?.impactUsd || null,
        riskScoreUrgency: scoreData?.urgencyWeight || null,
        hasRiskScore: !!scoreData
      };
    });
  }, [uiRows, selectedPlant, searchTerm, selectedRiskLevel, revenueState.summaryByKey, riskScoreState.scoreByKey]);

  // KPI 統計（從 filteredRows 派生）
  const kpis = useMemo(() => {
    const criticalCount = filteredRows.filter(r => r.riskLevel === 'critical').length;
    const warningCount = filteredRows.filter(r => r.riskLevel === 'warning').length;
    
    // Shortage within horizon（Bucket-Based：CRITICAL + WARNING）
    const shortageWithinHorizon = criticalCount + warningCount;
    
    return {
      criticalCount,
      warningCount,
      shortageWithinHorizon,
      totalItems: filteredRows.length,
      profitAtRisk: 0 // TODO: Week 2
    };
  }, [filteredRows]);

  // ========== 互動處理 ==========

  const handleRowSelect = (row) => {
    setSelectedRow(row);
  };

  const handleCloseDetails = () => {
    setSelectedRow(null);
  };

  const handleClearFilters = () => {
    setSelectedPlant('all');
    setSearchTerm('');
    setSelectedRiskLevel('all');
  };

  const handleExport = () => {
    addNotification('Export 功能開發中（Week 2）', 'info');
  };

  const handleRetry = () => {
    loadRiskData();
  };

  /**
   * Load probabilistic forecast summary for current run (Step 2: P0)
   */
  const loadProbData = async () => {
    if (!user?.id || !activeForecastRun?.id) return;

    setLoadingProb(true);
    try {
      const { inventoryProbForecastService } = await import('../services/inventoryProbForecastService');
      
      // Check if prob results exist
      const hasResults = await inventoryProbForecastService.hasResults(user.id, activeForecastRun.id);
      setHasProbResults(hasResults);

      if (hasResults) {
        const summary = await inventoryProbForecastService.getSummaryByRun(user.id, activeForecastRun.id);
        
        // Convert to Map<key, probSummary>
        const probMap = {};
        summary.forEach(row => {
          const key = `${row.material_code}|${row.plant_id}`;
          probMap[key] = row;
        });
        
        setProbResults(probMap);
        console.log(`📊 Loaded ${summary.length} prob results for run ${activeForecastRun.id.slice(0, 8)}`);
      }
    } catch (error) {
      console.warn('Failed to load prob data:', error);
      setHasProbResults(false);
    } finally {
      setLoadingProb(false);
    }
  };

  /**
   * Load prob series for a specific key (lazy load for details panel)
   */
  const loadProbSeriesForKey = async (materialCode, plantId) => {
    if (!user?.id || !activeForecastRun?.id) return;
    
    const key = `${materialCode}|${plantId}`;
    
    // Return cached if exists
    if (probSeriesCache[key]) {
      return probSeriesCache[key];
    }

    try {
      const { inventoryProbForecastService } = await import('../services/inventoryProbForecastService');
      const series = await inventoryProbForecastService.getSeriesByRun(
        user.id,
        activeForecastRun.id,
        materialCode,
        plantId
      );
      
      setProbSeriesCache(prev => ({ ...prev, [key]: series }));
      return series;
    } catch (error) {
      console.warn(`Failed to load prob series for ${key}:`, error);
      return [];
    }
  };

  /**
   * Load audit events timeline (M7.3 WP3)
   */
  const loadAuditEvents = async () => {
    if (!user?.id || !activeForecastRun?.id) return;
    
    setAuditLoading(true);
    try {
      const { listEvents } = await import('../services/auditService');
      const result = await listEvents(user.id, {
        bomRunId: activeForecastRun.id,
        limit: 100
      });
      
      if (result.success) {
        setAuditEvents(result.events);
      }
    } catch (error) {
      console.warn('Failed to load audit events:', error);
    } finally {
      setAuditLoading(false);
    }
  };

  /**
   * Handle What-if Replay from audit event
   */
  const handleReplayWhatIf = (event) => {
    if (!event.payload?.inputs?.action) return;
    
    // Extract key from event
    const key = event.key;
    if (!key) return;
    
    // Find the row in filteredRows
    const [materialCode, plantId] = key.split('|');
    const targetRow = filteredRows.find(r => 
      r.item === materialCode && r.plantId === plantId
    );
    
    if (!targetRow) {
      addNotification(`Cannot find row for key: ${key}`, 'warning');
      return;
    }
    
    // Set replay draft with action params
    setReplayDraft({
      eventId: event.id,
      action: event.payload.inputs.action,
      key
    });
    
    // Open details panel
    setSelectedRow(targetRow);
  };

  // Load prob data when run changes
  useEffect(() => {
    if (activeForecastRun?.id) {
      loadProbData();
      loadRevenueSummary(); // M6 Gate-R5: Load revenue data
      loadRiskScores(); // M7 Gate-7.1: Load risk scores
      loadAuditEvents(); // M7.3 WP3: Load audit timeline
    }
  }, [activeForecastRun?.id]);

  /**
   * Load revenue summary for current BOM run (M6 Gate-R5)
   */
  const loadRevenueSummary = async () => {
    console.log('🔍 loadRevenueSummary called', { userId: user?.id, runId: activeForecastRun?.id, kind: activeForecastRun?.kind });
    if (!user?.id || !activeForecastRun?.id) {
      console.log('❌ loadRevenueSummary skipped - missing user or run');
      return;
    }
    
    const startMs = Date.now();
    try {
      // Import revenue forecast service functions
      const { getLatestRevenueRunForBomRun, getRevenueSummaryByRun } = await import('../services/revenueForecastService');
      
      let revenueRunId;
      
      // If current run is already a revenue run, use it directly
      if (activeForecastRun.kind === 'revenue_forecast') {
        console.log('✅ Using current revenue run directly');
        revenueRunId = activeForecastRun.id;
      } else {
        // Otherwise, find revenue run for this BOM run
        console.log('🔍 Finding revenue run for BOM run:', activeForecastRun.id);
        const runResult = await getLatestRevenueRunForBomRun(user.id, activeForecastRun.id);
        console.log('📊 getLatestRevenueRunForBomRun result:', runResult);
        
        if (!runResult.success) {
          if (runResult.notFound) {
            setRevenueState({
              mode: 'none',
              reason: 'no_revenue_run',
              revenueRunId: null,
              summaryByKey: {},
              perf: { loadMs: Date.now() - startMs }
            });
            return;
          }
          throw new Error(runResult.error);
        }
        revenueRunId = runResult.data.id;
      }
      
      // Get summary by key
      console.log('📊 Getting revenue summary for run:', revenueRunId);
      const summaryResult = await getRevenueSummaryByRun(user.id, revenueRunId);
      
      if (!summaryResult.success) {
        throw new Error(summaryResult.error);
      }
      
      console.log('💰 Loaded revenue summary:', Object.keys(summaryResult.data).length, 'FG keys');
      
      setRevenueState({
        mode: 'loaded',
        reason: null,
        revenueRunId,
        summaryByKey: summaryResult.data,
        perf: { loadMs: Date.now() - startMs }
      });
      
    } catch (error) {
      console.warn('Failed to load revenue summary:', error);
      setRevenueState({
        mode: 'degraded',
        reason: error.message,
        revenueRunId: null,
        summaryByKey: {},
        perf: { loadMs: Date.now() - startMs }
      });
    }
  };

  /**
   * Load risk scores for current run (M7 Gate-7.1)
   */
  const loadRiskScores = async () => {
    if (!user?.id || !activeForecastRun?.id) return;
    
    const startMs = Date.now();
    try {
      const { getRiskScoresForRun } = await import('../services/riskScoreService');
      
      const result = await getRiskScoresForRun(user.id, activeForecastRun.id);
      
      if (!result.success) {
        setRiskScoreState({
          mode: 'none',
          scoreByKey: {},
          perf: { loadMs: Date.now() - startMs }
        });
        return;
      }
      
      setRiskScoreState({
        mode: 'loaded',
        scoreByKey: result.data,
        perf: { loadMs: Date.now() - startMs }
      });
      
      console.log(`🎯 Loaded risk scores: ${result.count} keys`);
      
    } catch (error) {
      console.warn('Failed to load risk scores:', error);
      setRiskScoreState({
        mode: 'degraded',
        scoreByKey: {},
        perf: { loadMs: Date.now() - startMs }
      });
    }
  };

  /**
   * Calculate risk scores for current run (M7 Gate-7.1)
   */
  const calculateRiskScores = async () => {
    if (!user?.id || !activeForecastRun?.id) return;
    
    setCalculatingRiskScores(true);
    console.log('🎯 Starting risk score calculation...');
    
    try {
      const { runRiskScoreCalculation } = await import('../services/riskScoreService');
      
      // Pass filteredRows for deterministic fallback
      const result = await runRiskScoreCalculation(
        user.id,
        activeForecastRun.id,
        {
          riskRows: filteredRows, // Use current risk data for deterministic P(stockout)
          currentBucket: null,
          maxKeys: 1000
        }
      );
      
      if (result.success) {
        console.log('✅ Risk score calculation complete:', result.kpis);
        // Reload to get the new scores
        await loadRiskScores();
      } else {
        console.error('❌ Risk score calculation failed:', result.error);
      }
      
    } catch (error) {
      console.error('Failed to calculate risk scores:', error);
    } finally {
      setCalculatingRiskScores(false);
    }
  };

  // ========== 渲染 ==========

  // Loading 狀態
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-blue-500 mb-3" />
        <span className="text-slate-600 dark:text-slate-400">載入風險資料中...</span>
        <span className="text-xs text-slate-500 mt-1">正在計算 {HORIZON_BUCKETS} buckets 風險評估</span>
      </div>
    );
  }

  // Error 狀態
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-4">
        <div className="max-w-md w-full bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
              <AlertCircle className="w-6 h-6 text-red-600 dark:text-red-400" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                {error.type === 'empty' ? '無資料' : '載入錯誤'}
              </h3>
              <p className="text-sm text-slate-600 dark:text-slate-400">
                {error.message}
              </p>
            </div>
          </div>

          {error.hint && (
            <div className="bg-slate-50 dark:bg-slate-900/50 rounded-lg p-3 mb-4">
              <p className="text-sm text-slate-700 dark:text-slate-300 mb-2">
                {error.hint}
              </p>
              {error.templates && (
                <ul className="text-xs text-slate-600 dark:text-slate-400 space-y-1">
                  {error.templates.map((template, idx) => (
                    <li key={idx}>• {template}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="flex gap-2">
            <Button onClick={handleRetry} variant="primary" icon={RefreshCw}>
              重試
            </Button>
            {error.type === 'empty' && (
              <Button 
                onClick={() => setView?.('external')} 
                variant="secondary"
              >
                前往上傳
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 max-w-[1800px] mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <div>
            <h1 className="text-2xl md:text-3xl font-bold text-slate-900 dark:text-slate-100">
              🚨 Supply Coverage Risk
            </h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
              Horizon: {HORIZON_BUCKETS} buckets · 最後更新: {dataSnapshotTime ? new Date(dataSnapshotTime).toLocaleString('zh-TW') : 'N/A'}
              {activeForecastRun && (
                <span className="ml-2 text-blue-600 dark:text-blue-400">
                  · Risk based on Forecast Run: {activeForecastRun.scenario_name || 'baseline'} ({String(activeForecastRun.id).slice(0, 8)}…)
                </span>
              )}
              {!activeForecastRun && forecastRunsList.length === 0 && (
                <span className="ml-2 text-amber-600 dark:text-amber-400">· No forecast run (supply coverage only)</span>
              )}
            </p>
            {/* 診斷 KPI */}
            <div className="flex items-center gap-3 mt-2 text-xs text-slate-600 dark:text-slate-400">
              <span title="Inventory pairs (Universe)">
                Inv: <span className="font-semibold text-slate-900 dark:text-slate-100">{diagnostics.inventoryPairs}</span>
              </span>
              <span className="text-slate-300 dark:text-slate-600">|</span>
              <span title="PO pairs">
                PO: <span className="font-semibold text-slate-900 dark:text-slate-100">{diagnostics.poPairs}</span>
              </span>
              <span className="text-slate-300 dark:text-slate-600">|</span>
              <span title="Union pairs (Inventory ∪ PO)">
                Union: <span className="font-semibold text-slate-900 dark:text-slate-100">{diagnostics.unionPairs}</span>
              </span>
              <span className="text-slate-300 dark:text-slate-600">|</span>
              <span title="Matched pairs (Inventory ∩ PO)">
                Matched: <span className="font-semibold text-blue-600 dark:text-blue-400">{diagnostics.matchedPairs}</span>
              </span>
              <span className="text-slate-300 dark:text-slate-600">|</span>
              <span title="Inbound pairs in horizon (H3)">
                Inbound(H3): <span className="font-semibold text-green-600 dark:text-green-400">{diagnostics.inboundPairsInHorizon}</span>
              </span>
              {(diagnostics.demandKeysWithoutRiskRow > 0 || diagnostics.riskRowsWithoutDemand > 0) && (
                <>
                  <span className="text-slate-300 dark:text-slate-600">|</span>
                  <span title="Key 對齊：demand 有但 risk 無 / risk 有但 demand 無">
                    Demand↔Risk: <span className="font-semibold text-amber-600 dark:text-amber-400">{diagnostics.demandKeysWithoutRiskRow}</span> / <span className="font-semibold text-amber-600 dark:text-amber-400">{diagnostics.riskRowsWithoutDemand}</span>
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="text-sm text-slate-600 dark:text-slate-400 whitespace-nowrap">Forecast Run:</label>
          <select
            className="rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 px-3 py-1.5 text-sm min-w-[200px]"
            value={selectedForecastRunId || ''}
            onChange={(e) => {
              const v = e.target.value;
              setSelectedForecastRunId(v || null);
            }}
            disabled={loading}
          >
            <option value="">Latest run</option>
            {(forecastRunsList || []).map((run) => (
              <option key={run.id} value={run.id}>
                {run.scenario_name || 'baseline'} — {run.created_at ? new Date(run.created_at).toLocaleString('zh-TW', { dateStyle: 'short', timeStyle: 'short' }) : run.id?.slice(0, 8)}
              </option>
            ))}
          </select>
          <Button
            onClick={loadRiskData}
            variant="primary"
            icon={RefreshCw}
            disabled={loading}
          >
            重新整理
          </Button>
          
          {/* M7 Gate-7.1: Calculate Risk Scores button */}
          <Button
            onClick={calculateRiskScores}
            variant="secondary"
            icon={Calculator}
            disabled={loading || !activeForecastRun?.id || calculatingRiskScores}
            title="計算 Risk Score (P(stockout) × $Impact × Urgency)"
          >
            {calculatingRiskScores ? '計算中...' : 'Calculate Risk Scores'}
          </Button>
        </div>
      </div>

      {/* Scope & Limitation Notice */}
      <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-3">
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 mt-0.5">
            <svg className="w-5 h-5 text-blue-600 dark:text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div className="flex-1 text-sm">
            <div className="font-semibold text-blue-900 dark:text-blue-100 mb-1">
              Supply Coverage Risk (Bucket-Based)
            </div>
            <div className="text-blue-800 dark:text-blue-200 space-y-1">
              <div>• <span className="font-medium">Horizon:</span> {HORIZON_BUCKETS} buckets（約 {HORIZON_BUCKETS} 週）</div>
              <div>• <span className="font-medium">Data source:</span> Open PO + Inventory snapshots{profitSummary.itemsWithRealFinancials > 0 && ' + FG financials'}{activeForecastRun && (componentDemandCountForRun > 0 ? ` + Demand: component_demand (${componentDemandCountForRun} rows)` : ' + Demand: 無（該 Run 無 component_demand）')}</div>
              <div>• <span className="font-medium">Days to stockout / P(stockout):</span> {activeForecastRun ? (componentDemandCountForRun > 0 ? '依 Forecast Run 的 component_demand 彙總為日均需求後計算' : '該 Forecast Run 無 component_demand 資料，無法計算（請確認已執行 BOM Explosion 並選對 Run）') : '請選擇 Forecast Run 以顯示（需先執行 BOM Explosion）；目前為 supply coverage only'}</div>
              {profitSummary.usingFallback && (
                <div className="pt-1 border-t border-blue-300 dark:border-blue-700 mt-2">
                  • <span className="font-medium">Profit at Risk:</span> {profitSummary.itemsWithRealFinancials > 0 
                    ? `Using real financials for ${profitSummary.itemsWithRealFinancials} items, ${getFallbackAssumption().displayText} for others` 
                    : `${getFallbackAssumption().displayText} (FG financials not loaded)`}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* A) Filter Bar */}
      <FilterBar
        plants={plants.filter(p => p !== 'all')}
        selectedPlant={selectedPlant}
        onPlantChange={setSelectedPlant}
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
        selectedRiskLevel={selectedRiskLevel}
        onRiskLevelChange={setSelectedRiskLevel}
        onExport={handleExport}
        exportDisabled={true}
        onClearFilters={handleClearFilters}
      />

      {/* B) KPI Cards */}
      <KPICards
        criticalCount={kpis.criticalCount}
        warningCount={kpis.warningCount}
        shortageWithinHorizon={kpis.shortageWithinHorizon}
        profitAtRisk={profitSummary.totalProfitAtRisk}
        criticalProfitAtRisk={profitSummary.criticalProfitAtRisk}
        totalItems={kpis.totalItems}
        dataSnapshotTime={dataSnapshotTime}
        horizonDays={HORIZON_BUCKETS}
      />

      {/* C) 主內容區：左側 Table + 右側 Details Panel */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* 左側：Risk Table */}
        <div className={`${selectedRow ? 'lg:col-span-8' : 'lg:col-span-12'} bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden transition-all duration-300`}>
          <div className="p-4 border-b border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-lg text-slate-900 dark:text-slate-100">
                風險清單
              </h2>
              <span className="text-sm text-slate-500 dark:text-slate-400">
                共 {filteredRows.length} 筆
              </span>
            </div>
          </div>
          
          <RiskTable
            risks={filteredRows}
            selectedRowId={selectedRow?.id}
            onRowSelect={handleRowSelect}
            loading={loading}
            probResults={probResults}
          />
        </div>

        {/* 右側：Details Panel */}
        {selectedRow && (
          <div className="lg:col-span-4 transition-all duration-300">
            <DetailsPanel
              details={selectedRow}
              user={user} // M7.2: Pass user for What-if service
              onClose={handleCloseDetails}
              horizonDays={HORIZON_BUCKETS}
              activeForecastRun={activeForecastRun}
              probSeries={probSeriesCache}
              loadProbSeriesForKey={loadProbSeriesForKey}
              hasProbResults={hasProbResults}
              revenueState={revenueState}
              riskScoreData={selectedRow.riskScore ? {
                score: selectedRow.riskScore,
                pStockout: selectedRow.riskScorePStockout,
                impactUsd: selectedRow.riskScoreImpact,
                urgencyWeight: selectedRow.riskScoreUrgency
              } : null}
              replayDraft={replayDraft} // M7.3 WP3: Replay draft
            />
          </div>
        )}
      </div>

      {/* D) Audit Timeline (M7.3 WP3) */}
      <div className="mt-6">
        <AuditTimeline
          events={auditEvents}
          loading={auditLoading}
          onReplay={handleReplayWhatIf}
        />
      </div>
    </div>
  );
};

export default RiskDashboardView;
