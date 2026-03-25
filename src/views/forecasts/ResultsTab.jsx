/**
 * Results Tab - BOM Explosion Results & Trace
 * Handles both 'results' and 'trace' sub-tabs with pagination, filtering, and CSV download.
 *
 * @typedef {Object} ResultsTabProps
 * @property {Object} user - Current user object (must have .id)
 * @property {Function} addNotification - Notification callback (message, level)
 * @property {string} selectedBatchId - Currently selected batch ID
 * @property {string} activeTab - Current active tab ('results' | 'trace')
 */

import React, { useState, useEffect } from 'react';
import {
  Loader2, Search, ChevronLeft, ChevronRight, Filter, Download, Database
} from 'lucide-react';
import { Card, Button, Badge } from '../../components/ui';
import {
  componentDemandService,
  componentDemandTraceService
} from '../../services/infra/supabaseClient';

const itemsPerPage = 100;

/**
 * @param {ResultsTabProps} props
 */
const ResultsTab = ({ user, addNotification, selectedBatchId, activeTab }) => {
  // ========== Results/Trace States ==========
  const [data, setData] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [filters, setFilters] = useState({});
  const [showFilters, setShowFilters] = useState(true);

  // ========== Load data when batch/tab/page/filters change ==========
  useEffect(() => {
    if (selectedBatchId && user?.id) {
      loadData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs only when selection/filters change
  }, [selectedBatchId, activeTab, currentPage, filters, user]);

  /**
   * Load data (Results or Trace)
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
      addNotification(`Failed to load: ${err.message}`, 'error');
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
   * Download CSV
   */
  const handleDownloadCSV = () => {
    if (data.length === 0) {
      addNotification('No data to export', 'warning');
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

      addNotification(`Exported ${data.length} records`, 'success');
    } catch (error) {
      console.error('Error downloading CSV:', error);
      addNotification(`Export failed: ${error.message}`, 'error');
    }
  };

  /**
   * Get filter fields based on active tab
   */
  const getFilterFields = () => {
    if (activeTab === 'trace') {
      return [
        { key: 'bom_level', label: 'BOM Level', placeholder: 'e.g. 1, 2, 3...' },
        { key: 'fg_material_code', label: 'FG Material', placeholder: 'Search FG material...' },
        { key: 'component_material_code', label: 'Component Material', placeholder: 'Search component material...' }
      ];
    }
    // Results tab
    return [
      { key: 'material_code', label: 'Material Code', placeholder: 'Search material code...' },
      { key: 'plant_id', label: 'Plant ID', placeholder: 'Search plant ID...' },
      { key: 'time_bucket', label: 'Time Bucket', placeholder: 'e.g. 2026-W02' }
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

  if (!selectedBatchId) return null;

  return (
    <>
      {/* Filters */}
      <Card className="bg-slate-50 dark:bg-slate-800/50">
        <div className="flex items-center justify-between mb-3">
          <button
            onClick={() => setShowFilters(!showFilters)}
            className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-300 hover:text-purple-600 dark:hover:text-purple-400"
          >
            <Filter className="w-4 h-4" />
            {showFilters ? 'Hide Filters' : 'Show Filters'}
          </button>
          <div className="flex items-center gap-2">
            {Object.keys(filters).some(key => filters[key]) && (
              <button
                onClick={clearFilters}
                className="text-sm text-purple-600 dark:text-purple-400 hover:underline"
              >
                Clear Filters
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
              Total {totalCount} records
            </p>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-purple-500" />
            <span className="ml-3 text-slate-600 dark:text-slate-400">Loading...</span>
          </div>
        ) : data.length === 0 ? (
          <div className="py-12 text-center">
            <Database className="w-16 h-16 mx-auto text-slate-300 dark:text-slate-600 mb-4" />
            <h3 className="text-lg font-semibold text-slate-600 dark:text-slate-400 mb-2">
              No Data
            </h3>
            <p className="text-sm text-slate-500">
              {Object.keys(filters).some(key => filters[key])
                ? 'Please adjust filter criteria'
                : 'No data in this batch'}
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
                    Showing {startItem} - {endItem} of {totalCount} records
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
  );
};

export default ResultsTab;
