import React from 'react';

/**
 * Table Component
 * 基本表格容器，支援 sticky header、hover、點選樣式
 * 
 * @param {Array} columns - 欄位定義 [{ key, label, align, sortable, width }]
 * @param {Array} data - 資料陣列
 * @param {Function} onRowClick - 點擊列的回調
 * @param {string} selectedRowId - 選中列的 ID
 * @param {Function} renderCell - 自定義 cell 渲染函數 (column, row, value)
 * @param {boolean} stickyHeader - 是否固定表頭
 * @param {string} emptyMessage - 空狀態訊息
 * @param {ReactNode} emptyIcon - 空狀態圖示
 * @param {string} className - 額外 CSS class
 */
export const Table = ({
  columns = [],
  data = [],
  onRowClick,
  selectedRowId,
  renderCell,
  stickyHeader = true,
  emptyMessage = '暫無資料',
  emptyIcon,
  className = ''
}) => {
  // 取得欄位對齊樣式
  const getAlignClass = (align) => {
    switch (align) {
      case 'right': return 'text-right';
      case 'center': return 'text-center';
      default: return 'text-left';
    }
  };

  // Empty 狀態
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
 * TableHeader Component (子元件)
 * 可單獨使用的表頭元件，支援排序
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
