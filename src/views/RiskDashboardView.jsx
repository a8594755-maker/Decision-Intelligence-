/**
 * Risk Dashboard View - Supply Coverage Risk
 * 
 * 資料流：
 * 1. 載入 Open PO（必需）+ Inventory Snapshots（可選）
 * 2. Domain 計算（coverageCalculator）→ 3. mapSupplyCoverageToUI → 4. uiRows
 * 5. KPI/Table/Details 全部從 uiRows 派生
 * 
 * Horizon: 固定 3 buckets
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Loader2, RefreshCw, AlertCircle } from 'lucide-react';
import { Button } from '../components/ui';
import { supabase } from '../services/supabaseClient';

// Domain 層計算函數
import { calculateSupplyCoverageRiskBatch } from '../domains/risk/coverageCalculator.js';

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

// 資料轉換 Adapter（新版）
import { mapSupplyCoverageToUI } from '../components/risk/mapDomainToUI';

// PO 正規化工具
import { normalizeOpenPOBatch } from '../utils/poNormalizer';

// 固定 Horizon（Bucket-Based）
const HORIZON_BUCKETS = 3; // 未來 N 個 time_bucket

const RiskDashboardView = ({ user, addNotification }) => {
  // ========== State 管理 ==========
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [uiRows, setUiRows] = useState([]); // 單一資料來源
  
  // 篩選與搜尋
  const [plants, setPlants] = useState(['all']);
  const [selectedPlant, setSelectedPlant] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedRiskLevel, setSelectedRiskLevel] = useState('all');
  
  // 右側 Details Panel
  const [selectedRow, setSelectedRow] = useState(null);
  
  // 資料批次時間
  const [dataSnapshotTime, setDataSnapshotTime] = useState(null);
  
  // 診斷 KPI
  const [diagnostics, setDiagnostics] = useState({
    inventoryPairs: 0,     // Inventory pairs (Universe)
    poPairs: 0,            // PO pairs
    unionPairs: 0,         // Union pairs (Inventory ∪ PO)
    matchedPairs: 0,       // Matched pairs (Inventory ∩ PO) - 真正的交集
    inboundPairsInHorizon: 0 // Inbound pairs in horizon
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

  // ========== 資料載入 ==========

  const loadRiskData = async () => {
    if (!user?.id) return;
    
    setLoading(true);
    setError(null);
    
    try {
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

      // 正規化 PO 資料（time_bucket → eta, material_code → item, etc.）
      const normalizedPOData = normalizeOpenPOBatch(rawPoData);
      
      if (normalizedPOData.length === 0) {
        throw new Error('PO 資料正規化後為空（可能欄位格式錯誤）');
      }

      // 診斷：計算 Inventory pairs (Universe)
      const inventoryPairsSet = new Set();
      inventoryData.forEach(inv => {
        const item = (inv.material_code || inv.item || '').trim().toUpperCase();
        const factory = (inv.plant_id || inv.factory || '').trim().toUpperCase();
        if (item && factory) {
          inventoryPairsSet.add(`${item}|${factory}`);
        }
      });

      // 診斷：計算 PO pairs
      const poPairsSet = new Set();
      normalizedPOData.forEach(po => {
        const key = `${po.item}|${po.factory}`;
        poPairsSet.add(key);
      });

      // 診斷：計算 Matched pairs (Inventory ∩ PO) - 真正的交集
      const matchedPairsSet = new Set();
      poPairsSet.forEach(key => {
        if (inventoryPairsSet.has(key)) {
          matchedPairsSet.add(key);
        }
      });

      console.log('📊 診斷資訊（載入前）:');
      console.log(`- Inventory pairs (Universe): ${inventoryPairsSet.size}`);
      console.log(`- PO pairs: ${poPairsSet.size}`);
      console.log(`- Matched pairs (Inventory ∩ PO): ${matchedPairsSet.size}`);
      console.log(`- Raw PO records: ${rawPoData.length}`);
      console.log(`- Raw inventory records: ${inventoryData.length}`);

      // Step 3: Domain 計算（Supply Coverage Risk - Bucket-Based）
      const domainResults = calculateSupplyCoverageRiskBatch({
        openPOs: normalizedPOData,
        inventorySnapshots: inventoryData,
        horizonBuckets: HORIZON_BUCKETS
      });

      // Step 4: 計算 Profit at Risk（M2）
      const { rows: rowsWithProfit, summary: profitSummaryData } = calculateProfitAtRiskBatch({
        riskRows: domainResults,
        financials: financialsData,
        useFallback: true  // 允許使用 fallback 假設
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

      // 設定診斷 KPI
      setDiagnostics({
        inventoryPairs: inventoryPairsSet.size,
        poPairs: poPairsSet.size,
        unionPairs: unionPairsSet.size,
        matchedPairs: matchedPairsSet.size,  // 使用前面計算的交集
        inboundPairsInHorizon: inboundPairsSet.size
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
  }, [user]);

  // ========== 派生資料（從 uiRows 單一來源）==========

  // 篩選後的資料
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

    return filtered;
  }, [uiRows, selectedPlant, searchTerm, selectedRiskLevel]);

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
            </div>
          </div>
        </div>

        <div className="flex gap-2">
          <Button
            onClick={loadRiskData}
            variant="primary"
            icon={RefreshCw}
            disabled={loading}
          >
            重新整理
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
              <div>• <span className="font-medium">Data source:</span> Open PO + Inventory snapshots{profitSummary.itemsWithRealFinancials > 0 && ' + FG financials'}</div>
              <div>• <span className="font-medium">Limitation:</span> Stockout date/Days to stockout require demand/usage/forecast data (Coming later)</div>
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
          />
        </div>

        {/* 右側：Details Panel */}
        {selectedRow && (
          <div className="lg:col-span-4 transition-all duration-300">
            <DetailsPanel
              details={selectedRow}
              onClose={handleCloseDetails}
              horizonDays={HORIZON_BUCKETS}
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default RiskDashboardView;
