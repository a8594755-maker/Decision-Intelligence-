/**
 * useLiveTableData.js
 *
 * React hook for Plan Studio Data tab. Manages pagination, filtering,
 * sorting, and optimistic updates for live database records.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { queryTable, updateField, TABLE_REGISTRY } from '../services/liveDataQueryService';
import { getRecentEdits } from '../services/dataEditAuditService';

const DEFAULT_PAGE_SIZE = 50;

export function useLiveTableData({ userId, tableName, pageSize = DEFAULT_PAGE_SIZE }) {
  const [rows, setRows] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const [filters, setFilters] = useState({});
  const [sortConfig, setSortConfig] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [editHistory, setEditHistory] = useState([]);

  const fetchIdRef = useRef(0);

  // ── Fetch data ─────────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    if (!userId || !tableName || !TABLE_REGISTRY[tableName]) return;

    const fetchId = ++fetchIdRef.current;
    setLoading(true);
    setError(null);

    try {
      const result = await queryTable(userId, tableName, {
        filters,
        sort: sortConfig,
        limit: pageSize,
        offset: currentPage * pageSize,
      });

      // Prevent stale response from overriding newer one
      if (fetchId !== fetchIdRef.current) return;

      setRows(result.rows);
      setTotalCount(result.totalCount);
    } catch (err) {
      if (fetchId !== fetchIdRef.current) return;
      setError(err.message || 'Failed to load data');
      setRows([]);
      setTotalCount(0);
    } finally {
      if (fetchId === fetchIdRef.current) setLoading(false);
    }
  }, [userId, tableName, filters, sortConfig, currentPage, pageSize]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // ── Load edit history ──────────────────────────────────────────────────────

  const loadEditHistory = useCallback(async () => {
    if (!userId) return;
    try {
      const edits = await getRecentEdits(userId, 20);
      setEditHistory(edits);
    } catch {
      // non-fatal
    }
  }, [userId]);

  useEffect(() => {
    loadEditHistory();
  }, [loadEditHistory]);

  // ── Update field (optimistic) ──────────────────────────────────────────────

  const handleUpdateField = useCallback(async (recordId, fieldName, newValue) => {
    const config = TABLE_REGISTRY[tableName];
    if (!config) return;

    const idField = config.idField;

    // Optimistic update
    const previousRows = [...rows];
    setRows((prev) =>
      prev.map((row) =>
        row[idField] === recordId ? { ...row, [fieldName]: newValue } : row
      )
    );

    try {
      await updateField(userId, tableName, recordId, fieldName, newValue);
      // Refresh edit history
      loadEditHistory();
    } catch (err) {
      // Roll back optimistic update
      setRows(previousRows);
      throw err;
    }
  }, [userId, tableName, rows, loadEditHistory]);

  // ── Pagination ─────────────────────────────────────────────────────────────

  const totalPages = Math.ceil(totalCount / pageSize);

  const goToPage = useCallback((page) => {
    setCurrentPage(Math.max(0, Math.min(page, totalPages - 1)));
  }, [totalPages]);

  const nextPage = useCallback(() => {
    goToPage(currentPage + 1);
  }, [currentPage, goToPage]);

  const prevPage = useCallback(() => {
    goToPage(currentPage - 1);
  }, [currentPage, goToPage]);

  // ── Filtering ──────────────────────────────────────────────────────────────

  const applyFilters = useCallback((newFilters) => {
    setFilters(newFilters);
    setCurrentPage(0);
  }, []);

  const clearFilters = useCallback(() => {
    setFilters({});
    setCurrentPage(0);
  }, []);

  // ── Sorting ────────────────────────────────────────────────────────────────

  const toggleSort = useCallback((column) => {
    setSortConfig((prev) => {
      if (prev?.column === column) {
        return { column, ascending: !prev.ascending };
      }
      return { column, ascending: true };
    });
    setCurrentPage(0);
  }, []);

  return {
    rows,
    totalCount,
    totalPages,
    currentPage,
    loading,
    error,
    filters,
    sortConfig,
    editHistory,

    // Actions
    fetchData,
    handleUpdateField,
    goToPage,
    nextPage,
    prevPage,
    applyFilters,
    clearFilters,
    toggleSort,
  };
}
