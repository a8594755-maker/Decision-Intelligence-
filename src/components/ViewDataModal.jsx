/**
 * View Data Modal - Advanced modal for viewing batch data
 * Supports filtering, pagination, and error handling
 */

import React, { useState, useEffect } from 'react';
import {
  X, Search, ChevronLeft, ChevronRight, Loader2, AlertCircle, Filter, Database, Cloud
} from 'lucide-react';
import { importBatchesService } from '../services/importHistoryService';
import { Badge } from './ui';

const ViewDataModal = ({ isOpen, onClose, batch, user, addNotification }) => {
  // State
  const [data, setData] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [filters, setFilters] = useState({});
  const [showFilters, setShowFilters] = useState(false);
  const [activeTab, setActiveTab] = useState('results'); // 'results' | 'trace'
  const [dataSource, setDataSource] = useState('local'); // 'local' | 'sap'
  
  const itemsPerPage = 100;
  
  // Check if current batch supports tabs (only bom_explosion)
  const showTabs = batch?.target_table === 'bom_explosion';

  // Load data when modal opens or filters/page/tab/dataSource change
  useEffect(() => {
    if (isOpen && batch && user) {
      console.log(`[ViewDataModal] Loading data with dataSource=${dataSource}, table=${batch?.target_table}`);
      loadData();
    }
  }, [isOpen, batch, user, currentPage, filters, activeTab, dataSource]);

  /**
   * Load batch data with filters and pagination
   */
  const loadData = async () => {
    if (!batch || !user?.id) return;
    
    setLoading(true);
    setError(null);
    
    try {
      const offset = (currentPage - 1) * itemsPerPage;
      
      const result = await importBatchesService.getBatchDataWithFilters(
        user.id,
        batch.id,
        batch.target_table,
        {
          filters,
          limit: itemsPerPage,
          offset,
          view: activeTab, // Pass activeTab as view parameter
          dataSource // Pass dataSource to switch between local and SAP data
        }
      );
      
      if (result.error) {
        setError(result.error);
        setData([]);
        setTotalCount(0);
      } else {
        setData(result.data);
        setTotalCount(result.count);
        setError(null);
      }
    } catch (err) {
      console.error('Error loading batch data:', err);
      const errorMsg = err?.message || err?.details || JSON.stringify(err);
      setError(errorMsg);
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
    setCurrentPage(1); // Reset to first page when filter changes
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
   * Get filter fields based on target table and active tab
   */
  const getFilterFields = () => {
    switch (batch?.target_table) {
      case 'bom_edges':
        return [
          { key: 'parent_material', label: 'Parent Material', placeholder: 'Search parent material...' },
          { key: 'child_material', label: 'Child Material', placeholder: 'Search child material...' },
          { key: 'plant_id', label: 'Plant ID', placeholder: 'Search plant code...' }
        ];
      case 'demand_fg':
        return [
          { key: 'material_code', label: 'Material Code', placeholder: 'Search material code...' },
          { key: 'plant_id', label: 'Plant ID', placeholder: 'Search plant code...' },
          { key: 'time_bucket', label: 'Time Bucket', placeholder: 'Search time bucket...' }
        ];
      case 'goods_receipts':
        return [
          { key: 'material_code', label: 'Material Code', placeholder: 'Search material code...' },
          { key: 'supplier_name', label: 'Supplier', placeholder: 'Search supplier...' },
          { key: 'plant_id', label: 'Plant ID', placeholder: 'Search plant code...' }
        ];
      case 'price_history':
        return [
          { key: 'material_code', label: 'Material Code', placeholder: 'Search material code...' },
          { key: 'supplier_name', label: 'Supplier', placeholder: 'Search supplier...' },
          { key: 'plant_id', label: 'Plant ID', placeholder: 'Search plant code...' }
        ];
      case 'suppliers':
        return [
          { key: 'supplier_code', label: 'Supplier Code', placeholder: 'Search supplier code...' },
          { key: 'supplier_name', label: 'Supplier Name', placeholder: 'Search supplier name...' }
        ];
      case 'bom_explosion':
        if (activeTab === 'trace') {
          // Trace tab filters
          return [
            { key: 'component_demand_id', label: 'Component Demand ID', placeholder: 'UUID...' },
            { key: 'fg_demand_id', label: 'FG Demand ID', placeholder: 'UUID...' },
            { key: 'bom_level', label: 'BOM Level', placeholder: 'e.g. 1, 2, 3...' },
            { key: 'component_material_code', label: 'Component Material', placeholder: 'Search component material...' },
            { key: 'fg_material_code', label: 'FG Material', placeholder: 'Search FG material...' }
          ];
        }
        // Results tab filters
        return [
          { key: 'material_code', label: 'Material Code', placeholder: 'Search material code...' },
          { key: 'plant_id', label: 'Plant ID', placeholder: 'Search plant code...' },
          { key: 'time_bucket', label: 'Time Bucket', placeholder: 'e.g. 2026-W02 or 2026-01-08' }
        ];
      default:
        return [];
    }
  };

  /**
   * Get table columns to display
   */
  const getDisplayColumns = () => {
    if (!data || data.length === 0) return [];
    
    const firstItem = data[0];
    
    // Special handling for trace tab
    if (batch?.target_table === 'bom_explosion' && activeTab === 'trace') {
      // Priority columns for trace view
      const traceColumns = [
        'component_demand_id',
        'fg_demand_id',
        'bom_edge_id',
        'qty_multiplier',
        'bom_level',
        'trace_meta',
        'created_at'
      ];
      return traceColumns.filter(col => col in firstItem);
    }
    
    // Default: exclude common metadata columns
    const excludeColumns = ['id', 'user_id', 'batch_id', 'upload_file_id', 'updated_at'];
    
    return Object.keys(firstItem)
      .filter(key => !excludeColumns.includes(key))
      .slice(0, 10); // Limit to 10 columns for display
  };

  /**
   * Pagination info
   */
  const totalPages = Math.ceil(totalCount / itemsPerPage);
  const startItem = (currentPage - 1) * itemsPerPage + 1;
  const endItem = Math.min(currentPage * itemsPerPage, totalCount);

  /**
   * Handle page navigation
   */
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
   * Render cell value with special handling for trace_meta
   */
  const renderCellValue = (row, col) => {
    const value = row[col];
    
    // Special handling for trace_meta (JSONB column)
    if (col === 'trace_meta' && typeof value === 'object' && value !== null) {
      const meta = value;
      return (
        <div className="space-y-1 text-xs">
          {meta.path && (
            <div className="truncate" title={JSON.stringify(meta.path)}>
              <span className="font-semibold">Path:</span> {JSON.stringify(meta.path)}
            </div>
          )}
          {meta.fg_material_code && (
            <div>
              <span className="font-semibold">FG:</span> {meta.fg_material_code}
            </div>
          )}
          {meta.component_material_code && (
            <div>
              <span className="font-semibold">Comp:</span> {meta.component_material_code}
            </div>
          )}
          {meta.fg_qty !== undefined && (
            <div>
              <span className="font-semibold">FG Qty:</span> {meta.fg_qty}
            </div>
          )}
          {meta.component_qty !== undefined && (
            <div>
              <span className="font-semibold">Comp Qty:</span> {meta.component_qty}
            </div>
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

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      {/* Backdrop */}
      <div 
        className="fixed inset-0 bg-black bg-opacity-50 transition-opacity"
        onClick={onClose}
      />
      
      {/* Modal */}
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="relative bg-white dark:bg-slate-900 rounded-lg shadow-xl max-w-7xl w-full max-h-[90vh] flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between p-6 border-b dark:border-slate-700">
            <div>
              <h3 className="text-xl font-bold text-slate-900 dark:text-white">
                View Data - {batch?.filename}
              </h3>
              <div className="flex items-center gap-3 mt-2">
                <Badge variant="blue">{batch?.upload_type}</Badge>
                <code className="px-2 py-1 bg-slate-100 dark:bg-slate-800 rounded text-xs">
                  {batch?.target_table}
                </code>
                <span className="text-sm text-slate-500">
                  Total: {totalCount} rows
                </span>
                {/* Data Source Badge */}
                <span className={`text-xs px-2 py-1 rounded-full font-medium ${
                  dataSource === 'sap' 
                    ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' 
                    : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                }`}>
                  {dataSource === 'sap' ? 'SAP Data' : 'Local Upload'}
                </span>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {showTabs && (
            <div className="border-b dark:border-slate-700 bg-white dark:bg-slate-900">
              <div className="flex px-6">
                <button
                  onClick={() => handleTabSwitch('results')}
                  className={`px-6 py-3 text-sm font-medium border-b-2 transition-colors ${
                    activeTab === 'results'
                      ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                      : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  Forecast Results
                </button>
                <button
                  onClick={() => handleTabSwitch('trace')}
                  className={`px-6 py-3 text-sm font-medium border-b-2 transition-colors ${
                    activeTab === 'trace'
                      ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                      : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  Trace
                </button>
              </div>
            </div>
          )}

          {/* Data Source Toggle */}
          <div className="border-b dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Data Source:</span>
                <div className="flex bg-white dark:bg-slate-700 rounded-lg p-1 border border-slate-200 dark:border-slate-600">
                  <button
                    onClick={() => setDataSource('local')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-all ${
                      dataSource === 'local'
                        ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                    }`}
                  >
                    <Database className="w-4 h-4" />
                    Local Upload
                  </button>
                  <button
                    onClick={() => setDataSource('sap')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-all ${
                      dataSource === 'sap'
                        ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                    }`}
                  >
                    <Cloud className="w-4 h-4" />
                    SAP Data
                  </button>
                </div>
              </div>
              {dataSource === 'local' && (
                <span className="text-xs text-slate-500">
                  Batch: {batch?.id?.slice(0, 8)}...
                </span>
              )}
              {dataSource === 'sap' && (
                <span className="text-xs text-slate-500">
                  Showing all SAP synced data
                </span>
              )}
            </div>
          </div>

          {/* Filters */}
          <div className="border-b dark:border-slate-700 p-4 bg-slate-50 dark:bg-slate-800/50">
            <div className="flex items-center justify-between mb-3">
              <button
                onClick={() => setShowFilters(!showFilters)}
                className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400"
              >
                <Filter className="w-4 h-4" />
                {showFilters ? 'Hide Filters' : 'Show Filters'}
              </button>
              {Object.keys(filters).some(key => filters[key]) && (
                <button
                  onClick={clearFilters}
                  className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
                >
                  Clear Filters
                </button>
              )}
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
                        className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 focus:ring-2 focus:ring-blue-500 outline-none"
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Content */}
          <div className="flex-1 overflow-auto p-6">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
                <span className="ml-3 text-slate-600 dark:text-slate-400">Loading...</span>
              </div>
            ) : error ? (
              <div className="py-12">
                <div className="max-w-2xl mx-auto bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-6">
                  <div className="flex items-start gap-3">
                    <AlertCircle className="w-6 h-6 text-red-600 flex-shrink-0 mt-1" />
                    <div>
                      <h4 className="font-semibold text-red-900 dark:text-red-100 mb-2">
                        Loading Failed
                      </h4>
                      <p className="text-sm text-red-800 dark:text-red-200 font-mono whitespace-pre-wrap">
                        {error}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            ) : data.length === 0 ? (
              <div className="py-12 text-center">
                <p className="text-slate-500">No data</p>
              </div>
            ) : (
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
            )}
          </div>

          {/* Footer with Pagination */}
          {!loading && !error && data.length > 0 && (
            <div className="border-t dark:border-slate-700 p-4 bg-slate-50 dark:bg-slate-800/50">
              <div className="flex items-center justify-between">
                <div className="text-sm text-slate-600 dark:text-slate-400">
                  Showing {startItem} - {endItem} of {totalCount}
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
        </div>
      </div>
    </div>
  );
};

export default ViewDataModal;
