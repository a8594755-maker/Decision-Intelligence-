import { Play, Sparkles } from 'lucide-react';

const PRIORITY_STYLES = {
  high: 'border-amber-300 dark:border-amber-700 bg-amber-50/50 dark:bg-amber-950/20',
  medium: 'border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/20',
  low: 'border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-900/50',
};

const PRIORITY_BADGE = {
  high: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300',
  medium: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300',
  low: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400',
};

export default function SuggestionBlock({ title, description, query, priority = 'medium', onAction, loading }) {
  const style = PRIORITY_STYLES[priority] || PRIORITY_STYLES.medium;
  const badge = PRIORITY_BADGE[priority] || PRIORITY_BADGE.medium;

  return (
    <div className={`h-full rounded-xl border ${style} p-4 flex flex-col`}>
      <div className="flex items-start gap-2 mb-2">
        <Sparkles className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-300 truncate">{title}</h4>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0 ${badge}`}>
              {priority}
            </span>
          </div>
          {description && (
            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed line-clamp-3">
              {description}
            </p>
          )}
        </div>
      </div>
      <div className="mt-auto pt-3">
        <button
          onClick={() => onAction?.({ type: 'run_suggestion', query })}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Play className="w-3 h-3" />
          {loading ? 'Running...' : 'Run Analysis'}
        </button>
      </div>
    </div>
  );
}
