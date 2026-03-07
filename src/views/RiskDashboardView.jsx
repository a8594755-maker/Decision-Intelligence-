/**
 * Risk Dashboard View - Supply Coverage Risk
 *
 * Data flow:
 * 1. Load Forecast Runs (optional run_id)
 * 2. Load Open PO (required) + Inventory Snapshots (optional) + component_demand (by forecast_run_id)
 * 3. Domain calculation (coverageCalculator) → Inventory risk (daysToStockout / P(stockout)) → Profit at Risk
 * 4. mapSupplyCoverageToUI → uiRows
 * 5. KPI/Table/Details all derived from uiRows
 *
 * Horizon: fixed 3 buckets
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Loader2, RefreshCw, AlertCircle, Calculator, Database, Cloud } from 'lucide-react';
import { Button } from '../components/ui';
import { supabase } from '../services/supabaseClient';
import { forecastRunsService, componentDemandService } from '../services/supabaseClient';

// Domain layer calculation functions
import { calculateSupplyCoverageRiskBatch } from '../domains/risk/coverageCalculator.js';
import { calculateInventoryRisk } from '../domains/inventory/calculator.js';

// Profit at Risk calculation (M2)
import {
  calculateProfitAtRiskBatch,
  getFallbackAssumption
} from '../domains/risk/profitAtRiskCalculator.js';

// Risk Dashboard sub-components
import FilterBar from '../components/risk/FilterBar';
import KPICards from '../components/risk/KPICards';
import RiskTable from '../components/risk/RiskTable';
import DetailsPanel from '../components/risk/DetailsPanel';
import AuditTimeline from '../components/risk/AuditTimeline'; // M7.3 WP3

// Dual-mode view components (M8)
import ViewToggle from '../components/risk/ViewToggle';
import RiskCardGrid from '../components/risk/RiskCardGrid';
import RiskListView from '../components/risk/RiskListView';
import RiskDetailModal from '../components/risk/RiskDetailModal';

// Data transformation Adapter (new version)
import { mapSupplyCoverageToUI } from '../components/risk/mapDomainToUI';

// Sample data loading
import { loadSampleWorkbook } from '../services/sampleDataService';

// PO normalization, component_demand aggregation
import { normalizeOpenPOBatch } from '../utils/poNormalizer';
import { aggregateComponentDemandToDaily, normalizeKey } from '../utils/componentDemandAggregator';

// Fixed Horizon (Bucket-Based)
const HORIZON_BUCKETS = 3; // Next N time_buckets
const DEFAULT_LEAD_TIME_DAYS = 7; // Used by Inventory domain for P(stockout)

const RiskDashboardView = ({ addNotification, user, setView, globalDataSource, setGlobalDataSource }) => {
  // ========== State Management ==========
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [uiRows, setUiRows] = useState([]); // Single data source

  // Forecast Run selection (optional; null = use latest run)
  const [forecastRunsList, setForecastRunsList] = useState([]);
  const [selectedForecastRunId, setSelectedForecastRunId] = useState(null); // null = "Latest"
  const [activeForecastRun, setActiveForecastRun] = useState(null); // Actual run used for this load { id, scenario_name, created_at }
  const [componentDemandCountForRun, setComponentDemandCountForRun] = useState(0); // component_demand count for this run (0 = no data or no run selected)

  // Filtering and search
  const [plants, setPlants] = useState(['all']);
  const [selectedPlant, setSelectedPlant] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedRiskLevel, setSelectedRiskLevel] = useState('all');

  // Right-side Details Panel
  const [selectedRow, setSelectedRow] = useState(null);

  // Data snapshot time
  const [dataSnapshotTime, setDataSnapshotTime] = useState(null);

  // Diagnostic KPI (A3: demandKeysWithoutRiskRow / riskRowsWithoutDemand for key alignment debug)
  const [diagnostics, setDiagnostics] = useState({
    inventoryPairs: 0,
    poPairs: 0,
    unionPairs: 0,
    matchedPairs: 0,
    inboundPairsInHorizon: 0,
    demandKeysWithoutRiskRow: 0,
    riskRowsWithoutDemand: 0
  });

  // Profit at Risk summary (M2)
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

  // M8: View Mode State (Table/Grid/List)
  const [viewMode, setViewMode] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('riskDashboardView');
      if (['table', 'grid', 'list'].includes(saved)) return saved;
    }
    return 'table';
  });

  // ========== Data Loading ==========

  const loadRiskData = async () => {
    if (!user?.id) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    // Safety timeout — if Supabase is paused/unreachable, don't spin forever
    const timeoutId = setTimeout(() => {
      setLoading(false);
      setError({
        type: 'error',
        message: 'Connection timed out',
        hint: 'Supabase may be paused or unreachable. Check your project at supabase.com/dashboard.'
      });
    }, 15000);

    try {
      // Step 0: Load Forecast Runs list and determine run_id for this load
      let runsList = [];
      try {
        runsList = await forecastRunsService.listRuns(user.id, { limit: 30 });
        setForecastRunsList(runsList || []);
      } catch (e) {
        console.warn('Failed to load forecast runs (will not use component_demand):', e);
      }

      const runId = selectedForecastRunId || (runsList && runsList[0]?.id) || null;
      const runMeta = runId ? runsList.find(r => r.id === runId) || { id: runId, scenario_name: 'baseline', created_at: null } : null;
      setActiveForecastRun(runMeta);
      if (!runId) setComponentDemandCountForRun(0);

      // Step 0.5: Load component_demand by forecast_run_id and aggregate to (material, plant) → dailyDemand
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
          console.warn('Failed to load component_demand (Risk will not show daysToStockout):', e);
          addNotification(`Unable to load demand data for this Forecast Run: ${e.message}`, 'warning');
        }
      }

      // Step 1: Load Open PO (required) — filter by dataSource
      let poQuery = supabase
        .from('po_open_lines')
        .select('*')
        .eq('user_id', user.id);
      if (globalDataSource === 'sap') {
        poQuery = poQuery.eq('source', 'sap_sync');
      } else {
        // Local: exclude SAP synced data (source is null or not sap_sync)
        poQuery = poQuery.or('source.is.null,source.neq.sap_sync');
      }
      poQuery = poQuery.order('time_bucket', { ascending: true });
      console.log(`[loadRiskData] dataSource=${globalDataSource}, querying po_open_lines...`);
      const { data: rawPoData, error: poError } = await poQuery;

      if (poError) {
        console.error('PO query error:', poError);
        if (poError.code === '42P01') {
          throw new Error('Table po_open_lines has not been created, please contact administrator');
        }
        throw new Error(`Failed to load PO data: ${poError.message}`);
      }

      if (!rawPoData || rawPoData.length === 0) {
        throw new Error('EMPTY_PO_DATA');
      }

      // Step 2: Load inventory snapshots (optional) — filter by dataSource
      let inventoryData = [];
      let invQuery = supabase
        .from('material_stock_snapshots')
        .select('*')
        .eq('user_id', user.id);
      if (globalDataSource === 'sap') {
        invQuery = invQuery.eq('source', 'sap_sync');
      } else {
        invQuery = invQuery.or('source.is.null,source.neq.sap_sync');
      }
      invQuery = invQuery.order('snapshot_at', { ascending: false });
      console.log(`[loadRiskData] dataSource=${globalDataSource}, querying material_stock_snapshots...`);
      const { data: invData, error: invError } = await invQuery;

      if (invError) {
        console.warn('Failed to load inventory data (will use 0 inventory):', invError);
      } else {
        inventoryData = invData || [];
        setDataSnapshotTime(invData?.[0]?.created_at || new Date());
      }

      // Step 2.3: Load inventory_snapshots (safety_stock source) — material_stock_snapshots has no safety_stock field
      const safetyStockMap = {}; // key: "MATERIAL|PLANT" -> safety_stock
      try {
        const { data: isData, error: isError } = await supabase
          .from('inventory_snapshots')
          .select('material_code, plant_id, safety_stock, onhand_qty')
          .eq('user_id', user.id);
        if (!isError && isData?.length) {
          isData.forEach(row => {
            const key = normalizeKey(row.material_code, row.plant_id);
            if (key && key !== '|') {
              safetyStockMap[key] = {
                safety_stock: parseFloat(row.safety_stock || 0),
                onhand_qty: parseFloat(row.onhand_qty || 0)
              };
            }
          });
          console.log(`🛡️ Loaded ${Object.keys(safetyStockMap).length} safety_stock entries (from inventory_snapshots)`);
        }
      } catch (e) {
        console.warn('Failed to load inventory_snapshots (safety_stock), will use 0:', e);
      }

      // Step 2.5: Load FG Financials (M2 - Profit at Risk)
      let financialsData = [];
      const { data: finData, error: finError } = await supabase
        .from('fg_financials')
        .select('*')
        .eq('user_id', user.id);

      if (finError) {
        console.warn('Failed to load financials data (will use fallback assumption):', finError);
      } else {
        financialsData = finData || [];
        console.log(`💰 Loaded ${financialsData.length} financials entries`);
      }

      // Normalize PO data
      const normalizedPOData = normalizeOpenPOBatch(rawPoData);
      if (normalizedPOData.length === 0) {
        throw new Error('PO data is empty after normalization (possible field format error)');
      }

      // Step 2.6: Load suppliers (A2: leadTimeDays source) → build (item|factory) -> { leadTimeDays, source }
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
        console.warn('Failed to load suppliers (lead_time_days), will use default value:', e);
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

      // Diagnostics: Inventory / PO / Matched pairs (A3: all using normalizeKey for alignment)
      const inventoryPairsSet = new Set();
      inventoryData.forEach(inv => {
        const key = normalizeKey(inv.material_code || inv.item, inv.plant_id || inv.factory);
        if (key && key !== '|') inventoryPairsSet.add(key);
      });
      const poPairsSet = new Set();
      normalizedPOData.forEach(po => {
        const key = normalizeKey(po.material_code || po.item, po.plant_id || po.factory);
        if (key && key !== '|') poPairsSet.add(key);
      });
      const matchedPairsSet = new Set();
      poPairsSet.forEach(key => { if (inventoryPairsSet.has(key)) matchedPairsSet.add(key); });
      const unionKeys = new Set([...inventoryPairsSet, ...poPairsSet]);

      // A3: debug mismatch count (demand has but risk doesn't / risk has but demand doesn't)
      const demandKeySet = new Set(Object.keys(componentDemandAggregated));
      const demandKeysWithoutRisk = [...demandKeySet].filter(k => !unionKeys.has(k)).length;
      const riskRowsWithoutDemand = [...unionKeys].filter(k => !demandKeySet.has(k)).length;
      console.log('📊 Diagnostics: Inv pairs', inventoryPairsSet.size, 'PO pairs', poPairsSet.size, 'Matched', matchedPairsSet.size);
      console.log('📊 Key alignment: demand keys without risk row', demandKeysWithoutRisk, '| risk rows without demand', riskRowsWithoutDemand);

      // Step 3: Domain calculation (Supply Coverage Risk - Bucket-Based)
      const domainResults = calculateSupplyCoverageRiskBatch({
        openPOs: normalizedPOData,
        inventorySnapshots: inventoryData.map(inv => {
          const key = normalizeKey(inv.material_code, inv.plant_id);
          const ssInfo = safetyStockMap[key];
          return {
            material_code: inv.material_code,
            plant_id: inv.plant_id,
            on_hand_qty: inv.qty,
            safety_stock: ssInfo?.safety_stock || 0,
            snapshot_date: inv.snapshot_at
          };
        }),
        horizonBuckets: HORIZON_BUCKETS
      });

      // Step 3.5: Use component_demand aggregation + Inventory domain to calculate daysToStockout / P(stockout); A2: leadTimeDays from supplier or fallback
      domainResults.forEach(row => {
        const itemKey = normalizeKey(row.material_code || row.item, row.plant_id || row.factory);
        const demandInfo = componentDemandAggregated[itemKey];
        const dailyDemand = demandInfo?.dailyDemand;
        const onHand = row.onHand != null ? row.onHand : 0;
        const safetyStock = row.safetyStock != null ? row.safetyStock : 0;
        const ltInfo = keyToLeadTime[itemKey] || { leadTimeDays: DEFAULT_LEAD_TIME_DAYS, source: 'fallback' };
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
            console.warn(`Inventory risk calculation skipped for ${itemKey}:`, e);
          }
        }
      });

      // Step 4: Calculate Profit at Risk (M2)
      const { rows: rowsWithProfit, summary: profitSummaryData } = calculateProfitAtRiskBatch({
        riskRows: domainResults,
        financials: financialsData,
        useFallback: true
      });

      console.log('💰 Profit at Risk summary:', profitSummaryData);

      // Step 5: Transform to UI format
      const warnings = [];
      const calculatedRows = rowsWithProfit.map(domainResult => {
        const rowWarnings = [];
        const uiRow = mapSupplyCoverageToUI(domainResult, rowWarnings);
        warnings.push(...rowWarnings);
        return uiRow;
      });

      // Set Profit Summary
      setProfitSummary({
        ...profitSummaryData,
        usingFallback: financialsData.length === 0 || profitSummaryData.itemsWithAssumption > 0
      });

      // Diagnostics: Calculate Union pairs and Inbound pairs in horizon
      const unionPairsSet = new Set();
      const inboundPairsSet = new Set();
      
      calculatedRows.forEach(row => {
        const key = `${row.item}|${row.plantId}`;
        unionPairsSet.add(key);
        
        if (row.inboundCount > 0) {
          inboundPairsSet.add(key);
        }
        
        // 🔍 Diagnostics: check plant field misalignment
        if (typeof row.plantId === 'number' && [5, 10, 50].includes(row.plantId)) {
          console.warn('⚠️ Plant field suspected misalignment:', {
            item: row.item,
            plantId: row.plantId,
            factory: row.factory,
            onHand: row.onHand,
            inboundQty: row.inboundQty,
            _raw: row._raw
          });
        }
      });

      // Set diagnostic KPI (including A3: key alignment mismatch count for debug/panel)
      setDiagnostics({
        inventoryPairs: inventoryPairsSet.size,
        poPairs: poPairsSet.size,
        unionPairs: unionPairsSet.size,
        matchedPairs: matchedPairsSet.size,
        inboundPairsInHorizon: inboundPairsSet.size,
        demandKeysWithoutRiskRow: demandKeysWithoutRisk,
        riskRowsWithoutDemand
      });

      console.log('📊 Diagnostics (after calculation):');
      console.log(`- Union pairs (Inventory ∪ PO): ${unionPairsSet.size}`);
      console.log(`- Inbound pairs in horizon: ${inboundPairsSet.size}`);

      // Extract unique plants
      const uniquePlants = new Set();
      calculatedRows.forEach(row => {
        if (row.plantId) uniquePlants.add(row.plantId);
      });

      // Set single data source (real data mode)
      setUiRows(calculatedRows);
      setPlants(['all', ...Array.from(uniquePlants).sort()]);

      // Show warnings (if any)
      if (warnings.length > 0) {
        console.warn('Data transformation warnings:', warnings);
      }

      addNotification(`Loaded ${calculatedRows.length} risk entries (REAL DATA)`, 'success');
    } catch (error) {
      console.error('Failed to load risk data:', error);
      
      if (error.message === 'EMPTY_PO_DATA') {
        setError({
          type: 'empty',
          message: 'No Open PO data available',
          hint: 'Please go to the Data Upload page to import the following templates',
          templates: ['po_open_lines.xlsx (required)', 'inventory_snapshots.xlsx (optional)']
        });
      } else {
        setError({
          type: 'error',
          message: error.message || 'Loading failed',
          hint: 'Please check data source or contact administrator'
        });
      }
      
      addNotification(`Loading failed: ${error.message}`, 'error');
    } finally {
      clearTimeout(timeoutId);
      setLoading(false);
    }
  };

  useEffect(() => {
    loadRiskData();
  }, [user, selectedForecastRunId, globalDataSource]);

  // ========== Derived Data (from uiRows single source) ==========

  // Filtered data (with Revenue integration M6 Gate-R5)
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
        revMarginAtRisk: revData?.marginAtRisk ?? null,
        revPenaltyAtRisk: revData?.penaltyAtRisk ?? null,
        revTotalAtRisk: revData?.totalAtRisk ?? null,
        hasRevenueData: !!revData,
        riskScore: scoreData?.score ?? null,
        riskScorePStockout: scoreData?.pStockout ?? null,
        riskScoreImpact: scoreData?.impactUsd ?? null,
        riskScoreUrgency: scoreData?.urgencyWeight ?? null,
        hasRiskScore: !!scoreData
      };
    });
  }, [uiRows, selectedPlant, searchTerm, selectedRiskLevel, revenueState.summaryByKey, riskScoreState.scoreByKey]);

  // KPI statistics (derived from filteredRows)
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
    };
  }, [filteredRows]);

  // ========== Interaction Handlers ==========

  const handleRowSelect = (row) => {
    setSelectedRow(row);
  };

  // M8: Handle view mode change with localStorage persistence - Reserved
  const handleViewModeChange = (newMode) => {
    setViewMode(newMode);
    localStorage.setItem('riskDashboardView', newMode);
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
    if (filteredRows.length === 0) return;
    try {
      const headers = ['Material', 'Plant', 'Risk Level', 'Gap Qty', 'Days to Stockout', 'P(Stockout)', 'Next Bucket', 'Profit at Risk', 'Currency', 'Data Quality'];
      const csvRows = filteredRows.map(r => [
        r.item, r.plantId, r.riskLevel, r.gapQty ?? 0,
        r.daysToStockout === Infinity ? '' : (r.daysToStockout ?? ''),
        r.pStockout != null ? (r.pStockout * 100).toFixed(1) + '%' : '',
        r.nextTimeBucket || '', r.profitAtRisk ?? 0, r.currency || 'USD',
        r.dataQualityLevel || 'missing'
      ]);
      const escape = v => { const s = String(v ?? ''); return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s; };
      const csv = [headers.map(escape).join(','), ...csvRows.map(row => row.map(escape).join(','))].join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `risk_export_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      addNotification(`Exported ${filteredRows.length} rows to CSV`, 'success');
    } catch (e) {
      addNotification('Export failed: ' + e.message, 'error');
    }
  };

  const handleExportExcel = async () => {
    if (filteredRows.length === 0) return;
    try {
      const XLSX = (await import('xlsx')).default || (await import('xlsx'));
      const wb = XLSX.utils.book_new();
      // Sheet 1: Risk Items
      const riskRows = filteredRows.map(r => ({
        Material: r.item, Plant: r.plantId, Risk_Level: r.riskLevel,
        Net_Available: r.netAvailable ?? 0, Gap_Qty: r.gapQty ?? 0,
        Days_To_Stockout: r.daysToStockout === Infinity ? null : (r.daysToStockout ?? null),
        P_Stockout: r.pStockout != null ? +(r.pStockout * 100).toFixed(1) : null,
        Next_Bucket: r.nextTimeBucket || '', Profit_At_Risk: r.profitAtRisk ?? 0,
        Currency: r.currency || 'USD', Data_Quality: r.dataQualityLevel || 'missing'
      }));
      const ws1 = XLSX.utils.json_to_sheet(riskRows);
      XLSX.utils.book_append_sheet(wb, ws1, 'Risk_Items');
      // Sheet 2: KPI Summary
      const kpiPairs = [
        ['Total Items', filteredRows.length],
        ['Critical', filteredRows.filter(r => r.riskLevel === 'critical').length],
        ['Warning', filteredRows.filter(r => r.riskLevel === 'warning').length],
        ['Total Profit at Risk', profitSummary.totalProfitAtRisk ?? 0],
        ['Critical Profit at Risk', profitSummary.criticalProfitAtRisk ?? 0],
        ['Items with Real Financials', profitSummary.itemsWithRealFinancials ?? 0],
        ['Items with Assumptions', profitSummary.itemsWithAssumption ?? 0],
        ['Data Snapshot', dataSnapshotTime || 'N/A'],
        ['Export Date', new Date().toISOString()],
      ];
      const ws2 = XLSX.utils.aoa_to_sheet([['Key', 'Value'], ...kpiPairs]);
      ws2['!cols'] = [{ wch: 28 }, { wch: 40 }];
      XLSX.utils.book_append_sheet(wb, ws2, 'KPI_Summary');
      // Download
      const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `risk_export_${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      addNotification(`Exported ${filteredRows.length} rows to Excel`, 'success');
    } catch (e) {
      addNotification('Excel export failed: ' + e.message, 'error');
    }
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
    console.log('[Replay] Event received:', event);
    
    if (!event.payload?.inputs?.action) {
      console.warn('[Replay] No action in payload');
      return;
    }
    
    // Extract key from event
    const key = event.key;
    console.log('[Replay] Key:', key);
    
    if (!key) {
      console.warn('[Replay] No key in event');
      return;
    }
    
    // Find the row in filteredRows
    const [materialCode, plantId] = key.split('|');
    console.log('[Replay] Looking for:', materialCode, plantId);
    console.log('[Replay] filteredRows count:', filteredRows.length);
    
    const targetRow = filteredRows.find(r => 
      r.item === materialCode && r.plantId === plantId
    );
    
    if (!targetRow) {
      console.warn('[Replay] Row not found for key:', key);
      addNotification(`Cannot find row for key: ${key}`, 'warning');
      return;
    }
    
    console.log('[Replay] Found row, setting replay draft:', event.payload.inputs.action);
    
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

  // ========== Rendering ==========

  // Loading state
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-blue-500 mb-3" />
        <span className="text-slate-600 dark:text-slate-400">Loading risk data...</span>
        <span className="text-xs text-slate-500 mt-1">Calculating {HORIZON_BUCKETS} buckets risk assessment</span>
      </div>
    );
  }

  // Error state
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
                {error.type === 'empty' ? 'No Data' : 'Loading Error'}
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
              Retry
            </Button>
            {error.type === 'empty' && (
              <>
                <Button
                  onClick={() => setView?.('external')}
                  variant="secondary"
                >
                  Go to Upload
                </Button>
                <Button
                  onClick={async () => {
                    try {
                      const { workbook: wb, fileName } = await loadSampleWorkbook();
                      addNotification?.(`Sample data "${fileName}" loaded — go to Upload to import`, 'success');
                      setView?.('external');
                    } catch (e) {
                      addNotification?.(`Failed to load sample: ${e.message}`, 'error');
                    }
                  }}
                  variant="secondary"
                  icon={Database}
                >
                  Load Sample Data
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-0">
      {/* Section A: Header, Notice, Filters, KPI - Constrained Width */}
      <div className="max-w-[1400px] mx-auto px-4 py-4 space-y-4">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <div>
              <h1 className="text-2xl md:text-3xl font-bold text-slate-900 dark:text-slate-100">
                🚨 Supply Coverage Risk
              </h1>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                Horizon: {HORIZON_BUCKETS} buckets · Last updated: {dataSnapshotTime ? new Date(dataSnapshotTime).toLocaleString('en-US') : 'N/A'}
                {activeForecastRun && (
                  <span className="ml-2 text-blue-600 dark:text-blue-400">
                    · Risk based on Forecast Run: {activeForecastRun.scenario_name || 'baseline'} ({String(activeForecastRun.id).slice(0, 8)}…)
                  </span>
                )}
                {!activeForecastRun && forecastRunsList.length === 0 && (
                  <span className="ml-2 text-amber-600 dark:text-amber-400">· No forecast run (supply coverage only)</span>
                )}
              </p>
              {/* Diagnostic KPI */}
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
                    <span title="Key alignment: demand has but risk doesn't / risk has but demand doesn't">
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
                  {run.scenario_name || 'baseline'} — {run.created_at ? new Date(run.created_at).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' }) : run.id?.slice(0, 8)}
                </option>
              ))}
            </select>
            <Button
              onClick={loadRiskData}
              variant="primary"
              icon={RefreshCw}
              disabled={loading}
            >
              Refresh
            </Button>
            
            {/* M7 Gate-7.1: Calculate Risk Scores button */}
            <Button
              onClick={calculateRiskScores}
              variant="secondary"
              icon={Calculator}
              disabled={loading || !activeForecastRun?.id || calculatingRiskScores}
              title="Calculate Risk Score (P(stockout) × $Impact × Urgency)"
            >
              {calculatingRiskScores ? 'Calculating...' : 'Calculate Risk Scores'}
            </Button>
          </div>
        </div>

        {/* Global Data Source Indicator */}
        <div className="flex items-center gap-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg p-3 border border-slate-200 dark:border-slate-700">
          <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Data Source:</span>
          <div className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md ${
            globalDataSource === 'sap' 
              ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' 
              : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
          }`}>
            {globalDataSource === 'sap' ? <Cloud className="w-4 h-4" /> : <Database className="w-4 h-4" />}
            {globalDataSource === 'sap' ? 'SAP Data' : 'Local Upload'}
          </div>
          <span className="text-xs text-slate-500">
            {globalDataSource === 'sap' ? 'Showing SAP synced data' : 'Showing manually uploaded data'}
          </span>
          <span className="text-xs text-blue-600 dark:text-blue-400">
            Switch on main Dashboard
          </span>
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
                <div>• <span className="font-medium">Horizon:</span> {HORIZON_BUCKETS} buckets (approx. {HORIZON_BUCKETS} weeks)</div>
                <div>• <span className="font-medium">Data source:</span> Open PO + Inventory snapshots{profitSummary.itemsWithRealFinancials > 0 && ' + FG financials'}{activeForecastRun && (componentDemandCountForRun > 0 ? ` + Demand: component_demand (${componentDemandCountForRun} rows)` : ' + Demand: None (this Run has no component_demand)')}</div>
                <div>• <span className="font-medium">Days to stockout / P(stockout):</span> {activeForecastRun ? (componentDemandCountForRun > 0 ? 'Calculated from Forecast Run component_demand aggregated to daily demand' : 'This Forecast Run has no component_demand data, cannot calculate (please confirm BOM Explosion has been run and correct Run is selected)') : 'Please select a Forecast Run to display (BOM Explosion must be run first); currently supply coverage only'}</div>
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
          onExportExcel={handleExportExcel}
          exportDisabled={filteredRows.length === 0}
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
          itemsWithRealFinancials={profitSummary.itemsWithRealFinancials || 0}
          itemsWithAssumption={profitSummary.itemsWithAssumption || 0}
          usingFallback={profitSummary.usingFallback}
        />
      </div>

      {/* Section B: Risk Table - Limited Width with Internal Scroll */}
      <div className="px-4 py-6">
        <div className="max-w-[1400px] mx-auto bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
          <div className="p-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
            <h2 className="font-semibold text-lg text-slate-900 dark:text-slate-100">
              Risk List
            </h2>
            <div className="flex items-center gap-3">
              <span className="text-sm text-slate-500 dark:text-slate-400">
                {filteredRows.length} items
              </span>
              <ViewToggle viewMode={viewMode} onViewChange={handleViewModeChange} />
            </div>
          </div>
          <div className={viewMode === 'table' ? 'overflow-x-auto' : 'p-4'}>
            {viewMode === 'table' && (
              <RiskTable
                risks={filteredRows}
                selectedRowId={selectedRow?.id}
                onRowSelect={handleRowSelect}
                loading={loading}
                probResults={probResults}
                compactMode={false}
              />
            )}
            {viewMode === 'grid' && (
              <RiskCardGrid
                risks={filteredRows}
                selectedRowId={selectedRow?.id}
                onRowSelect={handleRowSelect}
                loading={loading}
              />
            )}
            {viewMode === 'list' && (
              <RiskListView
                risks={filteredRows}
                selectedRowId={selectedRow?.id}
                onRowSelect={handleRowSelect}
                loading={loading}
              />
            )}
          </div>
        </div>
      </div>

      {/* Risk Detail Modal */}
      {selectedRow && (
        <>
          {/* Overlay */}
          <div
            className="fixed inset-0 bg-black/50 z-40 transition-opacity"
            onClick={handleCloseDetails}
          />
          
          {/* Modal Container */}
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
              <DetailsPanel
                details={selectedRow}
                user={user}
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
                replayDraft={replayDraft}
              />
            </div>
          </div>
        </>
      )}

      {/* Section C: Audit Timeline - Aligned Width */}
      <div className="px-4 py-4 border-t border-slate-200 dark:border-slate-700">
        <div className="max-w-[1400px] mx-auto">
          <AuditTimeline
            events={auditEvents}
            loading={auditLoading}
            onReplay={handleReplayWhatIf}
          />
        </div>
      </div>
    </div>
  );
};

export default RiskDashboardView;
