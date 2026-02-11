import React from 'react';

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
  className = ''
}) => {
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
        <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
          <table className="w-full">
            {/* Header */}
            <thead className="bg-slate-100 dark:bg-slate-800">
              <tr>
                {columns.map((column) => (
                  <th
                    key={column.key}
                    className={`px-4 py-3 text-xs font-semibold uppercase text-slate-700 dark:text-slate-300 ${getAlignClass(column.align)}`}
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
                  <div className="flex flex-col items-center justify-center text-slate-500 dark:text-slate-400">
                    {emptyIcon && (
                      <div className="mb-3 text-slate-300 dark:text-slate-600">
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

  return (
    <div className={`w-full ${className}`}>
      <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
        <table className="w-full text-sm">
          {/* Header */}
          <thead className={`bg-slate-100 dark:bg-slate-800 ${stickyHeader ? 'sticky top-0 z-10' : ''}`}>
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  className={`px-4 py-3 text-xs font-semibold uppercase text-slate-700 dark:text-slate-300 ${getAlignClass(column.align)}`}
                  style={{ width: column.width }}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          
          {/* Body */}
          <tbody className="divide-y divide-slate-200 dark:divide-slate-700 bg-white dark:bg-slate-800">
            {data.map((row, rowIndex) => {
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
                      ? 'bg-blue-50 dark:bg-blue-900/20 border-l-4 border-blue-500' 
                      : 'hover:bg-slate-50 dark:hover:bg-slate-700/50'
                    }
                  `}
                >
                  {columns.map((column) => {
                    const value = row[column.key];
                    
                    return (
                      <td
                        key={`${rowId}-${column.key}`}
                        className={`px-4 py-3 text-slate-900 dark:text-slate-100 ${getAlignClass(column.align)}`}
                      >
                        {renderCell ? renderCell(column, row, value) : value}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
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
        px-4 py-3 text-xs font-semibold uppercase text-slate-700 dark:text-slate-300
        ${column.align === 'right' ? 'text-right' : column.align === 'center' ? 'text-center' : 'text-left'}
        ${canSort ? 'cursor-pointer hover:bg-slate-200 dark:hover:bg-slate-700' : ''}
      `}
      style={{ width: column.width }}
    >
      <div className={`flex items-center gap-1 ${column.align === 'right' ? 'justify-end' : column.align === 'center' ? 'justify-center' : 'justify-start'}`}>
        {children || column.label}
        {canSort && (
          <span className="text-slate-400">
            {isSorted ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}
          </span>
        )}
      </div>
    </th>
  );
};

export default Table;
