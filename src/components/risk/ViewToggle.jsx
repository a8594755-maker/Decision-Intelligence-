import { LayoutGrid, List } from 'lucide-react';

/**
 * ViewToggle Component
 * Segmented control for switching between grid and list views
 * 
 * @param {Object} props
 * @param {'grid' | 'list'} props.viewMode - Current view mode
 * @param {Function} props.onViewChange - Callback when view mode changes
 */
export default function ViewToggle({ viewMode, onViewChange }) {
  return (
    <div className="inline-flex items-center bg-slate-100 dark:bg-slate-700 rounded-lg p-1">
      <button
        type="button"
        onClick={() => onViewChange('grid')}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all duration-200 ${
          viewMode === 'grid'
            ? 'bg-white dark:bg-slate-600 text-slate-900 dark:text-slate-100 shadow-sm'
            : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
        }`}
        aria-pressed={viewMode === 'grid'}
      >
        <LayoutGrid className="w-4 h-4" />
        <span className="hidden sm:inline">Grid View</span>
      </button>
      
      <button
        type="button"
        onClick={() => onViewChange('list')}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all duration-200 ${
          viewMode === 'list'
            ? 'bg-white dark:bg-slate-600 text-slate-900 dark:text-slate-100 shadow-sm'
            : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
        }`}
        aria-pressed={viewMode === 'list'}
      >
        <List className="w-4 h-4" />
        <span className="hidden sm:inline">List View</span>
      </button>
    </div>
  );
}
