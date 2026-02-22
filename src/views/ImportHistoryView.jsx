/**
 * Import History View
 * Import history query and batch undo management
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

const ImportHistoryView = ({ addNotification, user, setView }) => {
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
      addNotification(`Loading failed: ${error.message}`, 'error');
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
        user.id,
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
      addNotification(`Failed to load preview: ${error.message}`, 'error');
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
          addNotification(`Batch successfully undone, ${result.deleted_count} records deleted`, 'success');
        } else {
          addNotification(`Undo failed: ${result.error}`, 'error');
        }
      } else {
        // Multiple undo
        const result = await importBatchesService.undoMultipleBatches(batchIds, user.id);
        addNotification(
          `Batch undo complete: ${result.success_count} succeeded, ${result.error_count} failed`,
          result.error_count > 0 ? 'warning' : 'success'
        );
      }

      // Clear selection
      setSelectedBatches([]);
      
      // Reload batches
      await loadBatches();
    } catch (error) {
      console.error('Error undoing batch:', error);
      addNotification(`Undo failed: ${error.message}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  /**
   * Delete batch record (does not delete actual data)
   */
  const handleDeleteRecord = async (batchId) => {
    if (!window.confirm('Are you sure you want to delete this import record? (Actual data will not be deleted)')) {
      return;
    }

    setLoading(true);
    try {
      await importBatchesService.deleteBatch(batchId, user.id);
      addNotification('Record deleted', 'success');
      await loadBatches();
    } catch (error) {
      console.error('Error deleting batch record:', error);
      addNotification(`Delete failed: ${error.message}`, 'error');
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
      pending: { label: 'Pending', color: 'blue' },
      processing: { label: 'Processing', color: 'blue' },
      completed: { label: 'Completed', color: 'green' },
      failed: { label: 'Failed', color: 'red' },
      undone: { label: 'Undone', color: 'red' }
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
    return date.toLocaleString('en-US', {
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
          <span className="ml-3 text-slate-600 dark:text-slate-400">Loading...</span>
        </div>
      );
    }

    if (!previewModal.data || previewModal.data.length === 0) {
      return (
        <div className="py-12 text-center text-slate-500">
          No data
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
            Showing first 50 records only
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
            Import History
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            View all data import records, preview or undo batches
          </p>
        </div>
        <Button onClick={loadBatches} disabled={loading} icon={RefreshCw}>
          Refresh
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
                placeholder="Search filename, type..."
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
              <option value="all">All Statuses</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
              <option value="undone">Undone</option>
              <option value="pending">Pending</option>
              <option value="processing">Processing</option>
            </select>
          </div>

          {/* Type Filter */}
          <div>
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 focus:ring-2 focus:ring-blue-500 outline-none"
            >
              <option value="all">All Types</option>
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
                {selectedBatches.length} batches selected
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                onClick={() => handleUndoClick(selectedBatches)}
                variant="danger"
                icon={Undo2}
                size="sm"
              >
                Batch Undo
              </Button>
              <Button
                onClick={() => setSelectedBatches([])}
                variant="secondary"
                size="sm"
              >
                Deselect All
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
            <span className="ml-3 text-slate-600 dark:text-slate-400">Loading...</span>
          </div>
        ) : filteredBatches.length === 0 ? (
          <div className="py-12 text-center">
            <History className="w-16 h-16 mx-auto text-slate-300 dark:text-slate-600 mb-4" />
            <h3 className="text-lg font-semibold text-slate-600 dark:text-slate-400 mb-2">
              {searchTerm || filterStatus !== 'all' || filterType !== 'all'
                ? 'No matching import records'
                : 'No import records yet'}
            </h3>
            <p className="text-sm text-slate-500">
              {searchTerm || filterStatus !== 'all' || filterType !== 'all'
                ? 'Please adjust filter criteria'
                : 'Import history will appear here after uploading data'}
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
                      Date/Time
                      <button
                        onClick={() => setSortOrder(sortOrder === 'desc' ? 'asc' : 'desc')}
                        className="ml-2 inline-flex items-center"
                      >
                        {sortOrder === 'desc' ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
                      </button>
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">
                      Type
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">
                      Filename
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">
                      Target Table
                    </th>
                    <th className="px-4 py-3 text-center text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">
                      Success/Error
                    </th>
                    <th className="px-4 py-3 text-center text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">
                      Status
                    </th>
                    <th className="px-4 py-3 text-center text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">
                      Actions
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
                            Undone at: {formatDate(batch.undone_at)}
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
                            Error: {batch.metadata.error}
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
                            title="Preview Data"
                          >
                            <Eye className="w-4 h-4" />
                          </button>
                          {batch.status === 'completed' && (
                            <button
                              onClick={() => handleUndoClick([batch.id])}
                              className="p-1.5 hover:bg-red-100 dark:hover:bg-red-900/30 rounded text-red-600 dark:text-red-400"
                              title="Undo Batch"
                            >
                              <Undo2 className="w-4 h-4" />
                            </button>
                          )}
                          {batch.status === 'undone' && (
                            <button
                              onClick={() => handleDeleteRecord(batch.id)}
                              className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-700 rounded text-slate-600 dark:text-slate-400"
                              title="Delete Record"
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
                Showing {filteredBatches.length} / {batches.length} records
              </div>
              <div className="flex items-center gap-4">
                <span>
                  Completed: {batches.filter(b => b.status === 'completed').length}
                </span>
                <span>
                  Failed: {batches.filter(b => b.status === 'failed').length}
                </span>
                <span>
                  Undone: {batches.filter(b => b.status === 'undone').length}
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
          title={`Data Preview - ${previewModal.batch?.filename}`}
          size="xl"
        >
          <div className="space-y-4">
            {/* Batch Info */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-4 bg-slate-50 dark:bg-slate-800 rounded-lg">
              <div>
                <div className="text-xs text-slate-500 mb-1">Type</div>
                <div className="text-sm font-medium">
                  {getUploadTypeLabel(previewModal.batch?.upload_type)}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500 mb-1">Target Table</div>
                <div className="text-sm font-medium">
                  {previewModal.batch?.target_table}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500 mb-1">Success Count</div>
                <div className="text-sm font-medium text-green-600">
                  {previewModal.batch?.success_rows}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500 mb-1">Status</div>
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
          title="Confirm Batch Undo"
        >
          <div className="space-y-4">
            <div className="p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-6 h-6 text-amber-600 flex-shrink-0 mt-1" />
                <div>
                  <h4 className="font-semibold text-amber-900 dark:text-amber-100 mb-2">
                    Warning: This action cannot be undone
                  </h4>
                  <p className="text-sm text-amber-800 dark:text-amber-200 mb-2">
                    You are about to undo the import of the following {undoModal.batches.length} batch(es). This will:
                  </p>
                  <ul className="text-sm text-amber-800 dark:text-amber-200 list-disc list-inside space-y-1">
                    <li>Permanently delete all data from these batches in the database</li>
                    <li>Mark batch status as "Undone"</li>
                    <li>This action cannot be reversed</li>
                  </ul>
                </div>
              </div>
            </div>

            {/* Batch List */}
            <div className="max-h-60 overflow-y-auto border dark:border-slate-700 rounded-lg">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800 sticky top-0">
                  <tr>
                    <th className="px-3 py-2 text-left">Filename</th>
                    <th className="px-3 py-2 text-left">Type</th>
                    <th className="px-3 py-2 text-center">Success Count</th>
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
                Cancel
              </Button>
              <Button onClick={executeUndo} variant="danger" icon={Undo2}>
                Confirm Undo
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





