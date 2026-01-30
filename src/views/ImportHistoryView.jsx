/**
 * Import History View
 * 匯入歷史查詢與批次撤銷管理
 */

import React, { useState, useEffect } from 'react';
import {
  History, RefreshCw, Eye, Undo2, Trash2, CheckCircle, XCircle, Clock,
  AlertTriangle, Download, Search, Filter, ChevronDown, ChevronUp, Loader2, X, Database, TrendingUp
} from 'lucide-react';
import { Card, Button, Badge, Modal } from '../components/ui';
import { importBatchesService } from '../services/importHistoryService';
import UPLOAD_SCHEMAS from '../utils/uploadSchemas';
import ViewDataModal from '../components/ViewDataModal';

const ImportHistoryView = ({ addNotification, user }) => {
  // State
  const [batches, setBatches] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedBatches, setSelectedBatches] = useState([]);
  const [filterStatus, setFilterStatus] = useState('all'); // 'all' | 'completed' | 'undone'
  const [filterType, setFilterType] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [sortOrder, setSortOrder] = useState('desc'); // 'asc' | 'desc'
  
  // Preview modal
  const [previewModal, setPreviewModal] = useState({
    open: false,
    batch: null,
    data: [],
    loading: false
  });

  // Undo confirmation modal
  const [undoModal, setUndoModal] = useState({
    open: false,
    batches: []
  });

  // View data modal (new MVP dashboard)
  const [viewDataModal, setViewDataModal] = useState({
    open: false,
    batch: null
  });

  // Load batches on mount
  useEffect(() => {
    if (user?.id) {
      loadBatches();
    }
  }, [user]);

  /**
   * Load all import batches
   */
  const loadBatches = async () => {
    if (!user?.id) return;
    
    setLoading(true);
    try {
      const data = await importBatchesService.getAllBatches(user.id, {
        limit: 200
      });
      setBatches(data);
    } catch (error) {
      console.error('Error loading import history:', error);
      addNotification(`載入失敗: ${error.message}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  /**
   * Handle checkbox selection
   */
  const handleSelectBatch = (batchId, checked) => {
    if (checked) {
      setSelectedBatches(prev => [...prev, batchId]);
    } else {
      setSelectedBatches(prev => prev.filter(id => id !== batchId));
    }
  };

  /**
   * Select all / deselect all
   */
  const handleSelectAll = (checked) => {
    if (checked) {
      const completedBatchIds = filteredBatches
        .filter(b => b.status === 'completed')
        .map(b => b.id);
      setSelectedBatches(completedBatchIds);
    } else {
      setSelectedBatches([]);
    }
  };

  /**
   * Open preview modal
   */
  const handlePreview = async (batch) => {
    setPreviewModal({
      open: true,
      batch: batch,
      data: [],
      loading: true
    });

    try {
      const data = await importBatchesService.getBatchData(
        batch.id,
        batch.target_table,
        50
      );
      setPreviewModal(prev => ({
        ...prev,
        data: data,
        loading: false
      }));
    } catch (error) {
      console.error('Error loading batch data:', error);
      addNotification(`載入預覽失敗: ${error.message}`, 'error');
      setPreviewModal(prev => ({
        ...prev,
        loading: false
      }));
    }
  };

  /**
   * Close preview modal
   */
  const closePreviewModal = () => {
    setPreviewModal({
      open: false,
      batch: null,
      data: [],
      loading: false
    });
  };

  /**
   * Open view data modal (new MVP dashboard)
   */
  const handleViewData = (batch) => {
    setViewDataModal({
      open: true,
      batch: batch
    });
  };

  /**
   * Close view data modal
   */
  const closeViewDataModal = () => {
    setViewDataModal({
      open: false,
      batch: null
    });
  };

  /**
   * Open undo confirmation modal
   */
  const handleUndoClick = (batchIds) => {
    const batchesToUndo = batches.filter(b => batchIds.includes(b.id));
    setUndoModal({
      open: true,
      batches: batchesToUndo
    });
  };

  /**
   * Close undo modal
   */
  const closeUndoModal = () => {
    setUndoModal({
      open: false,
      batches: []
    });
  };

  /**
   * Execute undo (single or multiple)
   */
  const executeUndo = async () => {
    const batchIds = undoModal.batches.map(b => b.id);
    
    if (batchIds.length === 0) return;

    setLoading(true);
    closeUndoModal();

    try {
      if (batchIds.length === 1) {
        // Single undo
        const result = await importBatchesService.undoBatch(batchIds[0], user.id);
        if (result.success) {
          addNotification(`已成功撤銷批次，刪除了 ${result.deleted_count} 筆資料`, 'success');
        } else {
          addNotification(`撤銷失敗: ${result.error}`, 'error');
        }
      } else {
        // Multiple undo
        const result = await importBatchesService.undoMultipleBatches(batchIds, user.id);
        addNotification(
          `批量撤銷完成: ${result.success_count} 成功, ${result.error_count} 失敗`,
          result.error_count > 0 ? 'warning' : 'success'
        );
      }

      // Clear selection
      setSelectedBatches([]);
      
      // Reload batches
      await loadBatches();
    } catch (error) {
      console.error('Error undoing batch:', error);
      addNotification(`撤銷失敗: ${error.message}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  /**
   * Delete batch record (does not delete actual data)
   */
  const handleDeleteRecord = async (batchId) => {
    if (!window.confirm('確定要刪除這筆匯入記錄嗎？（不會刪除實際資料）')) {
      return;
    }

    setLoading(true);
    try {
      await importBatchesService.deleteBatch(batchId);
      addNotification('記錄已刪除', 'success');
      await loadBatches();
    } catch (error) {
      console.error('Error deleting batch record:', error);
      addNotification(`刪除失敗: ${error.message}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  /**
   * Filter and sort batches
   */
  const filteredBatches = batches
    .filter(batch => {
      // Status filter
      if (filterStatus !== 'all' && batch.status !== filterStatus) {
        return false;
      }
      
      // Type filter
      if (filterType !== 'all' && batch.upload_type !== filterType) {
        return false;
      }
      
      // Search term
      if (searchTerm) {
        const term = searchTerm.toLowerCase();
        return (
          batch.filename.toLowerCase().includes(term) ||
          batch.upload_type.toLowerCase().includes(term) ||
          batch.target_table.toLowerCase().includes(term)
        );
      }
      
      return true;
    })
    .sort((a, b) => {
      const dateA = new Date(a.created_at);
      const dateB = new Date(b.created_at);
      return sortOrder === 'desc' ? dateB - dateA : dateA - dateB;
    });

  /**
   * Get status badge
   */
  const getStatusBadge = (status) => {
    const statusConfig = {
      pending: { label: '處理中', color: 'blue' },
      completed: { label: '已完成', color: 'green' },
      undone: { label: '已撤銷', color: 'red' }
    };
    
    const config = statusConfig[status] || { label: status, color: 'gray' };
    return <Badge variant={config.color}>{config.label}</Badge>;
  };

  /**
   * Get upload type label
   */
  const getUploadTypeLabel = (uploadType) => {
    return UPLOAD_SCHEMAS[uploadType]?.label || uploadType;
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
   * Render preview modal content
   */
  const renderPreviewContent = () => {
    if (previewModal.loading) {
      return (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
          <span className="ml-3 text-slate-600 dark:text-slate-400">載入中...</span>
        </div>
      );
    }

    if (!previewModal.data || previewModal.data.length === 0) {
      return (
        <div className="py-12 text-center text-slate-500">
          無資料
        </div>
      );
    }

    // Get first item to determine columns
    const firstItem = previewModal.data[0];
    const columns = Object.keys(firstItem).filter(
      key => !['id', 'user_id', 'batch_id', 'upload_file_id', 'created_at', 'updated_at'].includes(key)
    ).slice(0, 8);

    return (
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-100 dark:bg-slate-800">
            <tr>
              {columns.map(col => (
                <th key={col} className="px-3 py-2 text-left font-semibold text-xs uppercase">
                  {col.replace(/_/g, ' ')}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
            {previewModal.data.map((row, idx) => (
              <tr key={idx} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                {columns.map(col => (
                  <td key={col} className="px-3 py-2">
                    {typeof row[col] === 'object' && row[col] !== null
                      ? JSON.stringify(row[col]).substring(0, 30) + '...'
                      : String(row[col] ?? '-').substring(0, 30)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {previewModal.data.length >= 50 && (
          <div className="mt-3 text-center text-sm text-slate-500">
            僅顯示前 50 筆資料
          </div>
        )}
      </div>
    );
  };

  // ========== Render ==========

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h2 className="text-xl md:text-2xl font-bold flex items-center gap-2">
            <History className="w-6 h-6 text-blue-500" />
            匯入歷史
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            查看所有資料匯入記錄，可預覽或撤銷批次
          </p>
        </div>
        <Button onClick={loadBatches} disabled={loading} icon={RefreshCw}>
          重新整理
        </Button>
      </div>

      {/* Filters and Search */}
      <Card>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {/* Search */}
          <div className="md:col-span-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                placeholder="搜尋檔案名稱、類型..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 focus:ring-2 focus:ring-blue-500 outline-none"
              />
            </div>
          </div>

          {/* Status Filter */}
          <div>
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 focus:ring-2 focus:ring-blue-500 outline-none"
            >
              <option value="all">所有狀態</option>
              <option value="completed">已完成</option>
              <option value="undone">已撤銷</option>
              <option value="pending">處理中</option>
            </select>
          </div>

          {/* Type Filter */}
          <div>
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 focus:ring-2 focus:ring-blue-500 outline-none"
            >
              <option value="all">所有類型</option>
              {Object.entries(UPLOAD_SCHEMAS).map(([key, config]) => (
                <option key={key} value={key}>{config.label}</option>
              ))}
            </select>
          </div>
        </div>
      </Card>

      {/* Batch Actions */}
      {selectedBatches.length > 0 && (
        <Card className="bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <CheckCircle className="w-5 h-5 text-blue-600" />
              <span className="font-medium text-blue-900 dark:text-blue-100">
                已選擇 {selectedBatches.length} 個批次
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                onClick={() => handleUndoClick(selectedBatches)}
                variant="danger"
                icon={Undo2}
                size="sm"
              >
                批量撤銷
              </Button>
              <Button
                onClick={() => setSelectedBatches([])}
                variant="secondary"
                size="sm"
              >
                取消選擇
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* Batches Table */}
      <Card>
        {loading && batches.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
            <span className="ml-3 text-slate-600 dark:text-slate-400">載入中...</span>
          </div>
        ) : filteredBatches.length === 0 ? (
          <div className="py-12 text-center">
            <History className="w-16 h-16 mx-auto text-slate-300 dark:text-slate-600 mb-4" />
            <h3 className="text-lg font-semibold text-slate-600 dark:text-slate-400 mb-2">
              {searchTerm || filterStatus !== 'all' || filterType !== 'all'
                ? '無符合的匯入記錄'
                : '尚無匯入記錄'}
            </h3>
            <p className="text-sm text-slate-500">
              {searchTerm || filterStatus !== 'all' || filterType !== 'all'
                ? '請調整篩選條件'
                : '開始上傳資料後，歷史記錄會顯示在這裡'}
            </p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-50 dark:bg-slate-800 border-b dark:border-slate-700">
                  <tr>
                    <th className="px-4 py-3 text-left w-12">
                      <input
                        type="checkbox"
                        checked={selectedBatches.length === filteredBatches.filter(b => b.status === 'completed').length && selectedBatches.length > 0}
                        onChange={(e) => handleSelectAll(e.target.checked)}
                        className="rounded"
                      />
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">
                      日期時間
                      <button
                        onClick={() => setSortOrder(sortOrder === 'desc' ? 'asc' : 'desc')}
                        className="ml-2 inline-flex items-center"
                      >
                        {sortOrder === 'desc' ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
                      </button>
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">
                      類型
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">
                      檔案名稱
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">
                      目標表格
                    </th>
                    <th className="px-4 py-3 text-center text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">
                      成功/失敗
                    </th>
                    <th className="px-4 py-3 text-center text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">
                      狀態
                    </th>
                    <th className="px-4 py-3 text-center text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">
                      操作
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                  {filteredBatches.map(batch => (
                    <tr key={batch.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selectedBatches.includes(batch.id)}
                          onChange={(e) => handleSelectBatch(batch.id, e.target.checked)}
                          disabled={batch.status !== 'completed'}
                          className="rounded"
                        />
                      </td>
                      <td className="px-4 py-3 text-sm">
                        <div className="flex items-center gap-2">
                          <Clock className="w-4 h-4 text-slate-400" />
                          {formatDate(batch.created_at)}
                        </div>
                        {batch.undone_at && (
                          <div className="text-xs text-red-600 dark:text-red-400 mt-1">
                            撤銷於: {formatDate(batch.undone_at)}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {getUploadTypeLabel(batch.upload_type)}
                      </td>
                      <td className="px-4 py-3 text-sm font-mono">
                        {batch.filename}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        <code className="px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded text-xs">
                          {batch.target_table}
                        </code>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <div className="flex items-center justify-center gap-2 text-sm">
                          <span className="text-green-600 dark:text-green-400 font-medium">
                            {batch.success_rows}
                          </span>
                          <span className="text-slate-400">/</span>
                          <span className="text-red-600 dark:text-red-400 font-medium">
                            {batch.error_rows}
                          </span>
                        </div>
                        {batch.metadata?.error && (
                          <div className="text-xs text-red-600 dark:text-red-400 mt-1 max-w-xs truncate" title={batch.metadata.error}>
                            錯誤: {batch.metadata.error}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {getStatusBadge(batch.status)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-center gap-2">
                          {batch.target_table === 'bom_explosion' && batch.status === 'completed' && (
                            <button
                              onClick={() => {
                                setView && setView('forecasts');
                                // Could also pass batchId via URL params or global state
                              }}
                              className="p-1.5 hover:bg-purple-100 dark:hover:bg-purple-900/30 rounded text-purple-600 dark:text-purple-400"
                              title="Open in Forecasts"
                            >
                              <TrendingUp className="w-4 h-4" />
                            </button>
                          )}
                          <button
                            onClick={() => handleViewData(batch)}
                            className="p-1.5 hover:bg-green-100 dark:hover:bg-green-900/30 rounded text-green-600 dark:text-green-400"
                            title="View Data (MVP Dashboard)"
                          >
                            <Database className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handlePreview(batch)}
                            className="p-1.5 hover:bg-blue-100 dark:hover:bg-blue-900/30 rounded text-blue-600 dark:text-blue-400"
                            title="預覽資料"
                          >
                            <Eye className="w-4 h-4" />
                          </button>
                          {batch.status === 'completed' && (
                            <button
                              onClick={() => handleUndoClick([batch.id])}
                              className="p-1.5 hover:bg-red-100 dark:hover:bg-red-900/30 rounded text-red-600 dark:text-red-400"
                              title="撤銷批次"
                            >
                              <Undo2 className="w-4 h-4" />
                            </button>
                          )}
                          {batch.status === 'undone' && (
                            <button
                              onClick={() => handleDeleteRecord(batch.id)}
                              className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-700 rounded text-slate-600 dark:text-slate-400"
                              title="刪除記錄"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Summary */}
            <div className="mt-4 pt-4 border-t dark:border-slate-700 flex items-center justify-between text-sm text-slate-600 dark:text-slate-400">
              <div>
                顯示 {filteredBatches.length} / {batches.length} 筆記錄
              </div>
              <div className="flex items-center gap-4">
                <span>
                  已完成: {batches.filter(b => b.status === 'completed').length}
                </span>
                <span>
                  已撤銷: {batches.filter(b => b.status === 'undone').length}
                </span>
              </div>
            </div>
          </>
        )}
      </Card>

      {/* Preview Modal */}
      {previewModal.open && (
        <Modal
          isOpen={previewModal.open}
          onClose={closePreviewModal}
          title={`資料預覽 - ${previewModal.batch?.filename}`}
          size="xl"
        >
          <div className="space-y-4">
            {/* Batch Info */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-4 bg-slate-50 dark:bg-slate-800 rounded-lg">
              <div>
                <div className="text-xs text-slate-500 mb-1">類型</div>
                <div className="text-sm font-medium">
                  {getUploadTypeLabel(previewModal.batch?.upload_type)}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500 mb-1">目標表格</div>
                <div className="text-sm font-medium">
                  {previewModal.batch?.target_table}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500 mb-1">成功筆數</div>
                <div className="text-sm font-medium text-green-600">
                  {previewModal.batch?.success_rows}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500 mb-1">狀態</div>
                <div className="text-sm">
                  {getStatusBadge(previewModal.batch?.status)}
                </div>
              </div>
            </div>

            {/* Data Table */}
            <div className="border dark:border-slate-700 rounded-lg overflow-hidden">
              {renderPreviewContent()}
            </div>
          </div>
        </Modal>
      )}

      {/* Undo Confirmation Modal */}
      {undoModal.open && (
        <Modal
          isOpen={undoModal.open}
          onClose={closeUndoModal}
          title="確認撤銷批次"
        >
          <div className="space-y-4">
            <div className="p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-6 h-6 text-amber-600 flex-shrink-0 mt-1" />
                <div>
                  <h4 className="font-semibold text-amber-900 dark:text-amber-100 mb-2">
                    警告：此操作無法復原
                  </h4>
                  <p className="text-sm text-amber-800 dark:text-amber-200 mb-2">
                    您即將撤銷以下 {undoModal.batches.length} 個批次的匯入，這將會：
                  </p>
                  <ul className="text-sm text-amber-800 dark:text-amber-200 list-disc list-inside space-y-1">
                    <li>從資料庫中永久刪除這些批次的所有資料</li>
                    <li>將批次狀態標記為「已撤銷」</li>
                    <li>此操作無法復原</li>
                  </ul>
                </div>
              </div>
            </div>

            {/* Batch List */}
            <div className="max-h-60 overflow-y-auto border dark:border-slate-700 rounded-lg">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800 sticky top-0">
                  <tr>
                    <th className="px-3 py-2 text-left">檔案名稱</th>
                    <th className="px-3 py-2 text-left">類型</th>
                    <th className="px-3 py-2 text-center">成功筆數</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                  {undoModal.batches.map(batch => (
                    <tr key={batch.id}>
                      <td className="px-3 py-2">{batch.filename}</td>
                      <td className="px-3 py-2">{getUploadTypeLabel(batch.upload_type)}</td>
                      <td className="px-3 py-2 text-center">{batch.success_rows}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-end gap-3 pt-4 border-t dark:border-slate-700">
              <Button onClick={closeUndoModal} variant="secondary">
                取消
              </Button>
              <Button onClick={executeUndo} variant="danger" icon={Undo2}>
                確認撤銷
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* View Data Modal (new MVP dashboard) */}
      {viewDataModal.open && (
        <ViewDataModal
          isOpen={viewDataModal.open}
          onClose={closeViewDataModal}
          batch={viewDataModal.batch}
          user={user}
          addNotification={addNotification}
        />
      )}
    </div>
  );
};

export default ImportHistoryView;







