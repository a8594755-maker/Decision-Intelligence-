import React, { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

const ROW_HEIGHT = 44;
const VIRTUALIZE_THRESHOLD = 100;

/**
 * Table Component
 * Basic table container with sticky header, hover, and selection styles
 *
 * @param {Array} columns - Column definitions [{ key, label, align, sortable, width }]
 * @param {Array} data - Data array
 * @param {Function} onRowClick - Row click callback
 * @param {string} selectedRowId - Selected row ID
 * @param {Function} renderCell - Custom cell render function (column, row, value)
 * @param {boolean} stickyHeader - Whether to fix header
 * @param {string} emptyMessage - Empty state message
 * @param {ReactNode} emptyIcon - Empty state icon
 * @param {string} className - Additional CSS class
 * @param {boolean|number} virtualize - Enable virtualization (true = auto at 100+ rows, number = custom threshold)
 * @param {number} maxHeight - Max height in px for virtualized table (default 600)
 */
export const Table = ({
  columns = [],
  data = [],
  onRowClick,
  selectedRowId,
  renderCell,
  stickyHeader = true,
  emptyMessage = 'No data',
  emptyIcon,
  className = '',
  virtualize = false,
  maxHeight = 600,
}) => {
  const parentRef = useRef(null);
  const threshold = typeof virtualize === 'number' ? virtualize : VIRTUALIZE_THRESHOLD;
  const shouldVirtualize = virtualize !== false && data.length >= threshold;

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: shouldVirtualize ? data.length : 0,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });
  // Get column alignment class
  const getAlignClass = (align) => {
    switch (align) {
      case 'right': return 'text-right';
      case 'center': return 'text-center';
      default: return 'text-left';
    }
  };

  // Empty state
  if (data.length === 0) {
    return (
      <div className={`w-full ${className}`}>
        <div className="overflow-x-auto rounded-lg border border-[var(--border-default)]">
          <table className="w-full">
            {/* Header */}
            <thead className="bg-[var(--surface-subtle)]">
              <tr>
                {columns.map((column) => (
                  <th
                    key={column.key}
                    className={`px-4 py-3 text-xs font-semibold uppercase text-[var(--text-secondary)] ${getAlignClass(column.align)}`}
                    style={{ width: column.width }}
                  >
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            {/* Empty Body */}
            <tbody>
              <tr>
                <td colSpan={columns.length} className="px-4 py-12 text-center">
                  <div className="flex flex-col items-center justify-center text-[var(--text-muted)]">
                    {emptyIcon && (
                      <div className="mb-3 text-[var(--text-muted)]">
                        {emptyIcon}
                      </div>
                    )}
                    <p className="text-sm">{emptyMessage}</p>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  const renderRow = (row, rowIndex) => {
    const rowId = row.id || rowIndex;
    const isSelected = selectedRowId === rowId;

    return (
      <tr
        key={rowId}
        onClick={() => onRowClick && onRowClick(row)}
        className={`
          transition-colors
          ${onRowClick ? 'cursor-pointer' : ''}
          ${isSelected
            ? 'bg-[var(--accent-active)] border-l-4 border-[var(--brand-500)]'
            : 'hover:bg-[var(--accent-hover)]'
          }
        `}
      >
        {columns.map((column) => {
          const value = row[column.key];
          return (
            <td
              key={`${rowId}-${column.key}`}
              className={`px-4 py-3 text-[var(--text-primary)] ${getAlignClass(column.align)}`}
            >
              {renderCell ? renderCell(column, row, value) : value}
            </td>
          );
        })}
      </tr>
    );
  };

  const header = (
    <thead className={`bg-[var(--surface-subtle)] ${stickyHeader ? 'sticky top-0 z-10' : ''}`}>
      <tr>
        {columns.map((column) => (
          <th
            key={column.key}
            className={`px-4 py-3 text-xs font-semibold uppercase text-[var(--text-secondary)] ${getAlignClass(column.align)}`}
            style={{ width: column.width }}
          >
            {column.label}
          </th>
        ))}
      </tr>
    </thead>
  );

  if (shouldVirtualize) {
    const virtualRows = virtualizer.getVirtualItems();
    return (
      <div className={`w-full ${className}`}>
        <div
          ref={parentRef}
          className="overflow-auto rounded-lg border border-[var(--border-default)]"
          style={{ maxHeight }}
        >
          <table className="w-full text-sm">
            {header}
            <tbody className="divide-y divide-[var(--border-default)] bg-[var(--surface-card)]">
              {virtualRows.length > 0 && (
                <tr style={{ height: virtualRows[0].start }}>
                  <td colSpan={columns.length} style={{ padding: 0, border: 'none' }} />
                </tr>
              )}
              {virtualRows.map((virtualRow) => renderRow(data[virtualRow.index], virtualRow.index))}
              {virtualRows.length > 0 && (
                <tr style={{ height: virtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end }}>
                  <td colSpan={columns.length} style={{ padding: 0, border: 'none' }} />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div className={`w-full ${className}`}>
      <div className="overflow-x-auto rounded-lg border border-[var(--border-default)]">
        <table className="w-full text-sm">
          {header}
          <tbody className="divide-y divide-[var(--border-default)] bg-[var(--surface-card)]">
            {data.map((row, rowIndex) => renderRow(row, rowIndex))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

/**
 * TableHeader Component (sub-component)
 * Standalone header component with sorting support
 */
export const TableHeader = ({
  column,
  sortKey,
  sortDirection,
  onSort,
  children
}) => {
  const isSorted = sortKey === column.key;
  const canSort = column.sortable !== false && onSort;

  return (
    <th
      onClick={() => canSort && onSort(column.key)}
      className={`
        px-4 py-3 text-xs font-semibold uppercase text-[var(--text-secondary)]
        ${column.align === 'right' ? 'text-right' : column.align === 'center' ? 'text-center' : 'text-left'}
        ${canSort ? 'cursor-pointer hover:bg-[var(--accent-hover)]' : ''}
      `}
      style={{ width: column.width }}
    >
      <div className={`flex items-center gap-1 ${column.align === 'right' ? 'justify-end' : column.align === 'center' ? 'justify-center' : 'justify-start'}`}>
        {children || column.label}
        {canSort && (
          <span className="text-[var(--text-muted)]">
            {isSorted ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}
          </span>
        )}
      </div>
    </th>
  );
};

export default Table;
