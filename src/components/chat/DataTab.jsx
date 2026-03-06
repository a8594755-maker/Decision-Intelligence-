/**
 * DataTab.jsx
 *
 * Plan Studio Data tab — browse and inline-edit database records.
 * Supports suppliers, materials, inventory snapshots, and open POs.
 */

import React, { useState, useCallback, useMemo } from 'react';
import { Database, ChevronLeft, ChevronRight, Search, X, History, ArrowUpDown } from 'lucide-react';
import { Button } from '../ui';
import InlineEditCell from './InlineEditCell';
import { useLiveTableData } from '../../hooks/useLiveTableData';
import { TABLE_REGISTRY, getAvailableTables } from '../../services/liveDataQueryService';

const TABLES = getAvailableTables();

export default function DataTab({ userId, canEdit = true }) {
  const [activeTable, setActiveTable] = useState(TABLES[0]?.key || 'suppliers');
  const [filterInputs, setFilterInputs] = useState({});
  const [showHistory, setShowHistory] = useState(false);

  const {
    rows,
    totalCount,
    totalPages,
    currentPage,
    loading,
    error,
    sortConfig,
    editHistory,
    handleUpdateField,
    nextPage,
    prevPage,
    applyFilters,
    clearFilters,
    toggleSort,
  } = useLiveTableData({ userId, tableName: activeTable });

  const config = TABLE_REGISTRY[activeTable];

  // ── Table switch ─────────────────────────────────────────────────────────

  const switchTable = useCallback((tableKey) => {
    setActiveTable(tableKey);
    setFilterInputs({});
    clearFilters();
  }, [clearFilters]);

  // ── Filter submit ────────────────────────────────────────────────────────

  const handleFilterSubmit = useCallback((e) => {
    e.preventDefault();
    applyFilters(filterInputs);
  }, [filterInputs, applyFilters]);

  const handleClearFilters = useCallback(() => {
    setFilterInputs({});
    clearFilters();
  }, [clearFilters]);

  // ── Column definitions ───────────────────────────────────────────────────

  const columns = useMemo(() => {
    if (!config) return [];
    return config.displayColumns.map((col) => ({
      key: col,
      label: col.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      editable: !!config.editableFields[col],
      fieldConfig: config.editableFields[col] || null,
    }));
  }, [config]);

  if (!config) return null;

  const idField = config.idField;
  const startRow = currentPage * 50 + 1;
  const endRow = Math.min(startRow + rows.length - 1, totalCount);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Table selector */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
        <Database className="w-4 h-4 text-gray-500" />
        {TABLES.map((t) => (
          <button
            key={t.key}
            onClick={() => switchTable(t.key)}
            className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
              activeTable === t.key
                ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
                : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700'
            }`}
          >
            {t.label}
          </button>
        ))}
        <div className="flex-1" />
        <button
          onClick={() => setShowHistory(!showHistory)}
          className={`p-1 rounded transition-colors ${
            showHistory ? 'text-blue-600 bg-blue-50' : 'text-gray-400 hover:text-gray-600'
          }`}
          title="Edit History"
        >
          <History className="w-4 h-4" />
        </button>
      </div>

      {/* Filters */}
      {config.filterFields.length > 0 && (
        <form
          onSubmit={handleFilterSubmit}
          className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-200 dark:border-gray-700"
        >
          {config.filterFields.map((f) => (
            <input
              key={f.key}
              type="text"
              placeholder={f.label}
              value={filterInputs[f.key] || ''}
              onChange={(e) => setFilterInputs((prev) => ({ ...prev, [f.key]: e.target.value }))}
              className="px-2 py-1 text-xs border border-gray-300 rounded bg-white dark:bg-gray-800 dark:border-gray-600 dark:text-gray-200 w-28"
            />
          ))}
          <Button size="xs" variant="outline" type="submit">
            <Search className="w-3 h-3 mr-1" /> Filter
          </Button>
          {Object.values(filterInputs).some(Boolean) && (
            <button
              type="button"
              onClick={handleClearFilters}
              className="text-xs text-gray-400 hover:text-gray-600"
            >
              <X className="w-3 h-3" />
            </button>
          )}
          <span className="ml-auto text-xs text-gray-500">
            {totalCount} record{totalCount !== 1 ? 's' : ''}
          </span>
        </form>
      )}

      {/* Error */}
      {error && (
        <div className="px-3 py-2 text-xs text-red-600 bg-red-50 dark:bg-red-900/20">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-gray-50 dark:bg-gray-800 z-10">
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer select-none hover:text-gray-700 dark:hover:text-gray-200"
                  onClick={() => toggleSort(col.key)}
                >
                  <span className="flex items-center gap-1">
                    {col.label}
                    {sortConfig?.column === col.key && (
                      <ArrowUpDown className="w-3 h-3 text-blue-500" />
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {loading && rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-8 text-center text-gray-400">
                  Loading...
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-8 text-center text-gray-400">
                  No records found
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={row[idField]}
                  className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
                >
                  {columns.map((col) => (
                    <td key={col.key} className="px-3 py-1.5">
                      {col.editable && canEdit ? (
                        <InlineEditCell
                          value={row[col.key]}
                          fieldConfig={col.fieldConfig}
                          onSave={(newValue) => handleUpdateField(row[idField], col.key, newValue)}
                        />
                      ) : (
                        <span className="text-sm text-gray-700 dark:text-gray-300 truncate block">
                          {row[col.key] != null ? String(row[col.key]) : '—'}
                        </span>
                      )}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination footer */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-3 py-2 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
          <span className="text-xs text-gray-500">
            Showing {startRow}–{endRow} of {totalCount}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={prevPage}
              disabled={currentPage === 0}
              className="p-1 text-gray-500 hover:text-gray-700 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-xs text-gray-600 dark:text-gray-400">
              Page {currentPage + 1} / {totalPages}
            </span>
            <button
              onClick={nextPage}
              disabled={currentPage >= totalPages - 1}
              className="p-1 text-gray-500 hover:text-gray-700 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Edit history panel */}
      {showHistory && editHistory.length > 0 && (
        <div className="border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 max-h-32 overflow-auto">
          <div className="px-3 py-1.5 text-xs font-medium text-gray-500 uppercase tracking-wider">
            Recent Edits
          </div>
          {editHistory.slice(0, 10).map((edit) => (
            <div
              key={edit.id}
              className="px-3 py-1 text-xs text-gray-600 dark:text-gray-400 border-t border-gray-100 dark:border-gray-700/50"
            >
              <span className="font-medium">{edit.table_name}.{edit.field_name}</span>
              {' '}
              <span className="text-gray-400">{edit.old_value}</span>
              {' → '}
              <span className="text-blue-600 dark:text-blue-400">{edit.new_value}</span>
              {' '}
              <span className="text-gray-400">
                {edit.created_at ? new Date(edit.created_at).toLocaleString() : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
