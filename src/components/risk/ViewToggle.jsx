import { LayoutGrid, List, Table2 } from 'lucide-react';

/**
 * ViewToggle Component
 * Segmented control for switching between table, grid and list views
 */
export default function ViewToggle({ viewMode, onViewChange }) {
  const modes = [
    { key: 'table', icon: Table2, label: 'Table' },
    { key: 'grid',  icon: LayoutGrid, label: 'Grid' },
    { key: 'list',  icon: List, label: 'List' },
  ];

  return (
    <div className="inline-flex items-center bg-slate-100 dark:bg-slate-700 rounded-lg p-1">
      {modes.map(({ key, icon, label }) => {
        const Icon = icon;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onViewChange(key)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-all duration-200 ${
              viewMode === key
                ? 'bg-white dark:bg-slate-600 text-slate-900 dark:text-slate-100 shadow-sm'
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
            }`}
            aria-pressed={viewMode === key}
          >
            {Icon ? <Icon className="w-4 h-4" /> : null}
            <span className="hidden sm:inline">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
