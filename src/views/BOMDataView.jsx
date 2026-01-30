/**
 * BOM Data View - Dashboard for viewing BOM Edges and Demand FG data
 * 提供 Tab 切換、搜尋篩選和分頁功能
 */

import React, { useState, useEffect } from 'react';
import {
  Database, Search, ChevronLeft, ChevronRight, Loader2, Filter, X, RefreshCw
} from 'lucide-react';
import { Card, Button, Badge } from '../components/ui';
import { supabase } from '../services/supabaseClient';

const BOMDataView = ({ user, addNotification }) => {
  // State
  const [activeTab, setActiveTab] = useState('bom_edges'); // 'bom_edges' | 'demand_fg'
  const [data, setData] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [filters, setFilters] = useState({});
  const [showFilters, setShowFilters] = useState(true);
  
  const itemsPerPage = 100;

  // Load data when tab, page, or filters change
  useEffect(() => {
    if (user?.id) {
      loadData();
    }
  }, [user, activeTab, currentPage, filters]);

  /**
   * Load data with filters and pagination
   */
  const loadData = async () => {
    if (!user?.id) return;
    
    setLoading(true);
    
    try {
      const offset = (currentPage - 1) * itemsPerPage;
      const tableName = activeTab;
      
      // Build query
      let query = supabase
        .from(tableName)
        .select('*', { count: 'exact' })
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .range(offset, offset + itemsPerPage - 1);
      
      // Apply filters
      if (activeTab === 'bom_edges') {
        if (filters.batch_id) {
          query = query.ilike('batch_id', `%${filters.batch_id}%`);
        }
        if (filters.plant_id) {
          query = query.ilike('plant_id', `%${filters.plant_id}%`);
        }
        if (filters.parent_material) {
          query = query.ilike('parent_material', `%${filters.parent_material}%`);
        }
        if (filters.child_material) {
          query = query.ilike('child_material', `%${filters.child_material}%`);
        }
      } else if (activeTab === 'demand_fg') {
        if (filters.batch_id) {
          query = query.ilike('batch_id', `%${filters.batch_id}%`);
        }
        if (filters.plant_id) {
          query = query.ilike('plant_id', `%${filters.plant_id}%`);
        }
        if (filters.material_code) {
          query = query.ilike('material_code', `%${filters.material_code}%`);
        }
        if (filters.time_bucket) {
          query = query.ilike('time_bucket', `%${filters.time_bucket}%`);
        }
      }
      
      const { data: result, error, count } = await query;
      
      if (error) throw error;
      
      setData(result || []);
      setTotalCount(count || 0);
    } catch (err) {
      console.error('Error loading data:', err);
      const errorMsg = err?.message || err?.details || JSON.stringify(err);
      addNotification(`載入失敗: ${errorMsg}`, 'error');
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
    setCurrentPage(1); // Reset to first page
  };

  /**
   * Clear all filters
   */
  const clearFilters = () => {
    setFilters({});
    setCurrentPage(1);
  };

  /**
   * Switch tab
   */
  const handleTabSwitch = (tab) => {
    setActiveTab(tab);
    setFilters({});
    setCurrentPage(1);
  };

  /**
   * Get filter fields based on active tab
   */
  const getFilterFields = () => {
    if (activeTab === 'bom_edges') {
      return [
        { key: 'batch_id', label: 'Batch ID', placeholder: '搜尋批次 ID...' },
        { key: 'plant_id', label: 'Plant ID', placeholder: '搜尋工廠代碼...' },
        { key: 'parent_material', label: 'Parent Material', placeholder: '搜尋父件料號...' },
        { key: 'child_material', label: 'Child Material', placeholder: '搜尋子件料號...' }
      ];
    } else {
      return [
        { key: 'batch_id', label: 'Batch ID', placeholder: '搜尋批次 ID...' },
        { key: 'plant_id', label: 'Plant ID', placeholder: '搜尋工廠代碼...' },
        { key: 'material_code', label: 'Material Code', placeholder: '搜尋料號...' },
        { key: 'time_bucket', label: 'Time Bucket', placeholder: '搜尋時間桶...' }
      ];
    }
  };

  /**
   * Get display columns
   */
  const getDisplayColumns = () => {
    if (data.length === 0) return [];
    
    const excludeColumns = ['id', 'user_id', 'created_at', 'updated_at'];
    
    return Object.keys(data[0])
      .filter(key => !excludeColumns.includes(key))
      .slice(0, 12); // Limit to 12 columns
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

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h2 className="text-xl md:text-2xl font-bold flex items-center gap-2">
            <Database className="w-6 h-6 text-blue-500" />
            BOM Data Dashboard
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            查看和搜尋 BOM 關係與成品需求資料
          </p>
        </div>
        <Button onClick={loadData} disabled={loading} icon={RefreshCw}>
          重新整理
        </Button>
      </div>

      {/* Tabs */}
      <Card>
        <div className="flex border-b dark:border-slate-700">
          <button
            onClick={() => handleTabSwitch('bom_edges')}
            className={`px-6 py-3 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'bom_edges'
                ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            BOM Edges
            {activeTab === 'bom_edges' && (
              <Badge variant="blue" className="ml-2">
                {totalCount}
              </Badge>
            )}
          </button>
          <button
            onClick={() => handleTabSwitch('demand_fg')}
            className={`px-6 py-3 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'demand_fg'
                ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            Demand FG
            {activeTab === 'demand_fg' && (
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
            className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400"
          >
            <Filter className="w-4 h-4" />
            {showFilters ? '隱藏篩選' : '顯示篩選'}
          </button>
          {Object.keys(filters).some(key => filters[key]) && (
            <button
              onClick={clearFilters}
              className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
            >
              清除篩選
            </button>
          )}
        </div>

        {showFilters && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
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
      </Card>

      {/* Data Table */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-semibold text-lg">
              {activeTab === 'bom_edges' ? 'BOM 關係資料' : 'FG 需求資料'}
            </h3>
            <p className="text-sm text-slate-500">
              共 {totalCount} 筆記錄
            </p>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
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
                : '尚無資料，請先上傳資料'}
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
                    <tr key={row.id || idx} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                      <td className="px-3 py-2 text-slate-500 text-xs">
                        {startItem + idx}
                      </td>
                      {getDisplayColumns().map(col => (
                        <td key={col} className="px-3 py-2">
                          {typeof row[col] === 'object' && row[col] !== null
                            ? JSON.stringify(row[col]).substring(0, 50) + '...'
                            : typeof row[col] === 'number'
                            ? row[col].toLocaleString()
                            : String(row[col] ?? '-').substring(0, 50)}
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
    </div>
  );
};

export default BOMDataView;
