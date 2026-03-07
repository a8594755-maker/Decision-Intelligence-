/**
 * Risk Dashboard - Filter Bar Component
 * 
 * Top filter bar: Plant, material search, risk level, Export
 */

import React from 'react';
import { Filter, Search, Download, FileSpreadsheet, X } from 'lucide-react';
import { Button } from '../ui';

const FilterBar = ({
  // Plant filter
  plants = [],
  selectedPlant,
  onPlantChange,

  // Material search
  searchTerm,
  onSearchChange,

  // Risk level filter
  selectedRiskLevel,
  onRiskLevelChange,

  // Export
  onExport,
  onExportExcel,
  exportDisabled = true,

  // Clear filters
  onClearFilters
}) => {
  const hasActiveFilters = selectedPlant !== 'all' || searchTerm || selectedRiskLevel !== 'all';

  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm p-4">
      <div className="flex flex-col lg:flex-row lg:items-center gap-3">
        {/* Left: Filters */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <Filter className="w-4 h-4 text-slate-600 dark:text-slate-400" />
          <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Filters</span>
        </div>

        {/* Plant dropdown */}
        <div className="flex-1 min-w-[150px] max-w-[200px]">
          <select
            value={selectedPlant}
            onChange={(e) => onPlantChange(e.target.value)}
            className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
          >
            <option value="all">All Plants</option>
            {plants.map(plant => (
              <option key={plant} value={plant}>
                {plant}
              </option>
            ))}
          </select>
        </div>

        {/* Material search box */}
        <div className="flex-1 min-w-[200px] max-w-[300px] relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            placeholder="Search material..."
            value={searchTerm}
            onChange={(e) => onSearchChange(e.target.value)}
            className="w-full pl-10 pr-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
          />
        </div>

        {/* Risk level filter */}
        <div className="flex-1 min-w-[150px] max-w-[200px]">
          <select
            value={selectedRiskLevel}
            onChange={(e) => onRiskLevelChange(e.target.value)}
            className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
          >
            <option value="all">All Levels</option>
            <option value="critical">🔴 Critical</option>
            <option value="warning">🟡 Warning</option>
            <option value="low">🟢 OK</option>
          </select>
        </div>

        {/* Right: Action buttons */}
        <div className="flex items-center gap-2 lg:ml-auto">
          {/* Clear filters */}
          {hasActiveFilters && (
            <Button
              onClick={onClearFilters}
              variant="secondary"
              size="sm"
              icon={X}
            >
              Clear
            </Button>
          )}

          {/* Export CSV */}
          <Button
            onClick={onExport}
            variant="secondary"
            icon={Download}
            disabled={exportDisabled}
            title={exportDisabled ? 'No data to export' : 'Export to CSV'}
          >
            CSV
          </Button>

          {/* Export Excel */}
          {onExportExcel && (
            <Button
              onClick={onExportExcel}
              variant="secondary"
              icon={FileSpreadsheet}
              disabled={exportDisabled}
              title={exportDisabled ? 'No data to export' : 'Export to Excel'}
            >
              Excel
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

export default FilterBar;
