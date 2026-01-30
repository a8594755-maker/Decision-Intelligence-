/**
 * Forecasts View - Component Forecast (BOM-Derived)
 * 產品化的 BOM Explosion 主頁：Run 計算 → 選擇批次 → 查看結果（Results + Trace）
 */

import React, { useState, useEffect } from 'react';
import {
  TrendingUp, PlayCircle, Loader2, AlertTriangle, Check, ChevronDown, ChevronUp,
  Database, Search, ChevronLeft, ChevronRight, Filter, X, Download, RefreshCw
} from 'lucide-react';
import { Card, Button, Badge } from '../components/ui';
import { executeBomExplosion } from '../services/bomExplosionService';
import { 
  demandFgService, 
  bomEdgesService,
  componentDemandService,
  componentDemandTraceService
} from '../services/supabaseClient';
import { importBatchesService } from '../services/importHistoryService';

const ForecastsView = ({ user, addNotification }) => {
  // ========== Run 區塊 States ==========
  const [plantId, setPlantId] = useState('');
  const [timeBuckets, setTimeBuckets] = useState('');
  const [runLoading, setRunLoading] = useState(false);
  const [runResult, setRunResult] = useState(null);
  const [runError, setRunError] = useState(null);
  const [showRunErrors, setShowRunErrors] = useState(false);
  
  // ========== Batch Selector States ==========
  const [batches, setBatches] = useState([]);
  const [selectedBatchId, setSelectedBatchId] = useState(null);
  const [loadingBatches, setLoadingBatches] = useState(false);
  
  // ========== Results/Trace States ==========
  const [activeTab, setActiveTab] = useState('results'); // 'results' | 'trace'
  const [data, setData] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [filters, setFilters] = useState({});
  const [showFilters, setShowFilters] = useState(true);
  
  const itemsPerPage = 100;

  // ========== Load batches on mount ==========
  useEffect(() => {
    if (user?.id) {
      loadBatches();
    }
  }, [user]);

  // ========== Load data when batch/tab/page/filters change ==========
  useEffect(() => {
    if (selectedBatchId && user?.id) {
      loadData();
    }
  }, [selectedBatchId, activeTab, currentPage, filters, user]);

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
      
      // 篩選 target_table='bom_explosion' 且 status='completed'
      const bomBatches = allBatches
        .filter(b => b.target_table === 'bom_explosion' && b.status === 'completed')
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
   * 執行 BOM Explosion
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
      // 解析輸入
      const plantIdFilter = plantId.trim() || null;
      const timeBucketsFilter = timeBuckets.trim() 
        ? timeBuckets.split(',').map(t => t.trim()).filter(Boolean)
        : null;

      console.log('Fetching BOM Explosion data:', { plantIdFilter, timeBucketsFilter });

      // Step 1: Fetch demand_fg
      const demandFgRows = await demandFgService.fetchDemandFg(
        user.id,
        plantIdFilter,
        timeBucketsFilter
      );

      if (!demandFgRows || demandFgRows.length === 0) {
        throw new Error('找不到 FG 需求資料。請確認已上傳 demand_fg 資料，且篩選條件正確。');
      }

      console.log(`Fetched ${demandFgRows.length} FG demand rows`);

      // Step 2: Fetch bom_edges
      const bomEdgesRows = await bomEdgesService.fetchBomEdges(
        user.id,
        plantIdFilter
      );

      if (!bomEdgesRows || bomEdgesRows.length === 0) {
        throw new Error('找不到 BOM 關係資料。請確認已上傳 bom_edge 資料，且篩選條件正確。');
      }

      console.log(`Fetched ${bomEdgesRows.length} BOM edge rows`);

      // Step 3: Execute BOM Explosion
      const result = await executeBomExplosion(
        user.id,
        null, // Let the function create batch automatically
        demandFgRows,
        bomEdgesRows,
        {
          filename: `BOM Explosion - ${plantIdFilter || 'All Plants'} - ${new Date().toISOString()}`,
          metadata: {
            plant_id: plantIdFilter,
            time_buckets: timeBucketsFilter,
            source: 'forecasts_page',
            fg_demands_input: demandFgRows.length,
            bom_edges_input: bomEdgesRows.length
          }
        }
      );

      console.log('BOM Explosion result:', result);

      // Store result
      setRunResult(result);

      // Show success notification
      if (result.success) {
        addNotification(
          `BOM Explosion 完成！產生 ${result.componentDemandCount} 筆 Component 需求，${result.traceCount} 筆追溯記錄`,
          'success'
        );
      } else {
        addNotification(
          `BOM Explosion 完成但有 ${result.errors?.length || 0} 個錯誤或警告`,
          'warning'
        );
      }

      // Reload batches and select the new one
      await loadBatches();
      if (result.batchId) {
        setSelectedBatchId(result.batchId);
      }

    } catch (error) {
      console.error('BOM Explosion failed:', error);
      setRunError(error.message || 'BOM Explosion 執行失敗');
      addNotification(`BOM Explosion 執行失敗: ${error.message}`, 'error');
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
        
        setData(result.data || []);
        setTotalCount(result.count || 0);
      }
    } catch (err) {
      console.error('Error loading data:', err);
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
  };

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
                          {batch.success_rows} rows
                        </span>
                        {batch.metadata?.component_demand_count !== undefined && (
                          <span className="ml-2">
                            · {batch.metadata.component_demand_count} components
                          </span>
                        )}
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

      {/* Results/Trace Tabs */}
      {selectedBatchId && (
        <>
          {/* Tabs */}
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
            </div>
          </Card>

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
    </div>
  );
};

export default ForecastsView;
