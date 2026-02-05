/**
 * Risk Dashboard - Filter Bar Component
 * 
 * 頂部篩選欄：工廠、料號搜尋、風險等級、Export
 */

import React from 'react';
import { Filter, Search, Download, X } from 'lucide-react';
import { Button } from '../ui';

const FilterBar = ({
  // 工廠篩選
  plants = [],
  selectedPlant,
  onPlantChange,
  
  // 料號搜尋
  searchTerm,
  onSearchChange,
  
  // 風險等級篩選
  selectedRiskLevel,
  onRiskLevelChange,
  
  // Export
  onExport,
  exportDisabled = true,
  
  // 清除篩選
  onClearFilters
}) => {
  const hasActiveFilters = selectedPlant !== 'all' || searchTerm || selectedRiskLevel !== 'all';

  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm p-4">
      <div className="flex flex-col lg:flex-row lg:items-center gap-3">
        {/* 左側：篩選器 */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <Filter className="w-4 h-4 text-slate-600 dark:text-slate-400" />
          <span className="text-sm font-medium text-slate-700 dark:text-slate-300">篩選</span>
        </div>

        {/* 工廠下拉 */}
        <div className="flex-1 min-w-[150px] max-w-[200px]">
          <select
            value={selectedPlant}
            onChange={(e) => onPlantChange(e.target.value)}
            className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
          >
            <option value="all">全部工廠</option>
            {plants.map(plant => (
              <option key={plant} value={plant}>
                {plant}
              </option>
            ))}
          </select>
        </div>

        {/* 料號搜尋框 */}
        <div className="flex-1 min-w-[200px] max-w-[300px] relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            placeholder="搜尋料號..."
            value={searchTerm}
            onChange={(e) => onSearchChange(e.target.value)}
            className="w-full pl-10 pr-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
          />
        </div>

        {/* 風險等級篩選 */}
        <div className="flex-1 min-w-[150px] max-w-[200px]">
          <select
            value={selectedRiskLevel}
            onChange={(e) => onRiskLevelChange(e.target.value)}
            className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
          >
            <option value="all">全部等級</option>
            <option value="critical">🔴 Critical</option>
            <option value="warning">🟡 Warning</option>
            <option value="low">🟢 OK</option>
          </select>
        </div>

        {/* 右側：操作按鈕 */}
        <div className="flex items-center gap-2 lg:ml-auto">
          {/* 清除篩選 */}
          {hasActiveFilters && (
            <Button
              onClick={onClearFilters}
              variant="secondary"
              size="sm"
              icon={X}
            >
              清除
            </Button>
          )}

          {/* Export CSV */}
          <Button
            onClick={onExport}
            variant="secondary"
            icon={Download}
            disabled={exportDisabled}
            title={exportDisabled ? 'Export 功能開發中' : 'Export to CSV'}
          >
            Export
          </Button>
        </div>
      </div>
    </div>
  );
};

export default FilterBar;
