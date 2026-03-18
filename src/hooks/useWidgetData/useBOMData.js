/**
 * useBOMData — Data hook for BOM widget live mode.
 *
 * Extracts the Supabase query, pagination, filtering, and tab logic
 * from the legacy BOMDataView so it can be reused by the enhanced BOMWidget.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '../../services/supabaseClient';

const ITEMS_PER_PAGE = 100;

const FILTER_FIELDS = {
  bom_edges: [
    { key: 'source', label: 'Source', placeholder: 'Filter source (erp_sync, csv, manual)...' },
    { key: 'batch_id', label: 'Batch ID', placeholder: 'Search batch ID...' },
    { key: 'plant_id', label: 'Plant ID', placeholder: 'Search plant code...' },
    { key: 'parent_material', label: 'Parent Material', placeholder: 'Search parent material...' },
    { key: 'child_material', label: 'Child Material', placeholder: 'Search child material...' },
  ],
  demand_fg: [
    { key: 'batch_id', label: 'Batch ID', placeholder: 'Search batch ID...' },
    { key: 'plant_id', label: 'Plant ID', placeholder: 'Search plant code...' },
    { key: 'material_code', label: 'Material Code', placeholder: 'Search material code...' },
    { key: 'time_bucket', label: 'Time Bucket', placeholder: 'Search time bucket...' },
  ],
};

const EXCLUDE_COLUMNS = ['id', 'user_id', 'created_at', 'updated_at'];
const MAX_DISPLAY_COLUMNS = 12;

/**
 * @param {object} opts
 * @param {object} opts.user - { id } from auth context
 * @param {string} [opts.globalDataSource] - 'sap' | 'local'
 * @param {string} [opts.initialTab] - 'bom_edges' | 'demand_fg'
 */
export default function useBOMData({ user, globalDataSource, initialTab = 'bom_edges' } = {}) {
  const [activeTab, setActiveTab] = useState(initialTab);
  const [data, setData] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [filters, setFilters] = useState({});

  const loadData = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    setError(null);

    try {
      const offset = (currentPage - 1) * ITEMS_PER_PAGE;

      let query = supabase
        .from(activeTab)
        .select('*', { count: 'exact' })
        .eq('user_id', user.id);

      // Global data source filter
      if (globalDataSource === 'sap') {
        query = query.eq('source', 'sap_sync');
      } else {
        query = query.or('source.is.null,source.neq.sap_sync');
      }

      query = query.order('created_at', { ascending: false })
        .range(offset, offset + ITEMS_PER_PAGE - 1);

      // Tab-specific filters
      const filterDefs = FILTER_FIELDS[activeTab] || [];
      for (const def of filterDefs) {
        const val = filters[def.key];
        if (!val) continue;
        if (def.key === 'source') {
          query = query.eq('source', val);
        } else {
          query = query.ilike(def.key, `%${val}%`);
        }
      }

      const { data: result, error: queryError, count } = await query;
      if (queryError) throw queryError;

      setData(result || []);
      setTotalCount(count || 0);
    } catch (err) {
      console.error('useBOMData: error loading:', err);
      setError(err?.message || String(err));
      setData([]);
      setTotalCount(0);
    } finally {
      setLoading(false);
    }
  }, [user?.id, activeTab, currentPage, filters, globalDataSource]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleTabSwitch = useCallback((tab) => {
    setActiveTab(tab);
    setFilters({});
    setCurrentPage(1);
  }, []);

  const handleFilterChange = useCallback((field, value) => {
    setFilters(prev => ({ ...prev, [field]: value }));
    setCurrentPage(1);
  }, []);

  const clearFilters = useCallback(() => {
    setFilters({});
    setCurrentPage(1);
  }, []);

  const filterFields = useMemo(() => FILTER_FIELDS[activeTab] || [], [activeTab]);

  const displayColumns = useMemo(() => {
    if (data.length === 0) return [];
    return Object.keys(data[0])
      .filter(key => !EXCLUDE_COLUMNS.includes(key))
      .slice(0, MAX_DISPLAY_COLUMNS);
  }, [data]);

  const totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);
  const startItem = (currentPage - 1) * ITEMS_PER_PAGE + 1;
  const endItem = Math.min(currentPage * ITEMS_PER_PAGE, totalCount);
  const hasActiveFilters = Object.values(filters).some(Boolean);

  return {
    // Data
    data,
    totalCount,
    loading,
    error,
    displayColumns,

    // Tabs
    activeTab,
    handleTabSwitch,

    // Filters
    filters,
    filterFields,
    hasActiveFilters,
    handleFilterChange,
    clearFilters,

    // Pagination
    currentPage,
    setCurrentPage,
    totalPages,
    startItem,
    endItem,

    // Actions
    refetch: loadData,
  };
}
