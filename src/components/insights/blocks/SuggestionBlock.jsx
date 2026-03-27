import { Play, Sparkles } from 'lucide-react';

const PRIORITY_STYLES = {
  high: 'border-[var(--status-warning)] bg-[var(--status-warning-bg)]',
  medium: 'border-[var(--status-info)] bg-[var(--status-info-bg)]',
  low: 'border-[var(--border-default)] bg-[var(--surface-subtle)]',
};

const PRIORITY_BADGE = {
  high: 'bg-[var(--status-warning-bg)] text-[var(--status-warning-text)]',
  medium: 'bg-[var(--status-info-bg)] text-[var(--status-info-text)]',
  low: 'bg-[var(--surface-subtle)] text-[var(--text-secondary)]',
};

export default function SuggestionBlock({ title, description, query, priority = 'medium', onAction, loading }) {
  const style = PRIORITY_STYLES[priority] || PRIORITY_STYLES.medium;
  const badge = PRIORITY_BADGE[priority] || PRIORITY_BADGE.medium;

  return (
    <div className={`h-full rounded-xl border ${style} p-4 flex flex-col`}>
      <div className="flex items-start gap-2 mb-2">
        <Sparkles className="w-4 h-4 text-[var(--status-warning)] mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h4 className="text-sm font-semibold text-[var(--text-primary)] truncate">{title}</h4>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0 ${badge}`}>
              {priority}
            </span>
          </div>
          {description && (
            <p className="text-xs text-[var(--text-secondary)] leading-relaxed line-clamp-3">
              {description}
            </p>
          )}
        </div>
      </div>
      <div className="mt-auto pt-3">
        <button
          onClick={() => onAction?.({ type: 'run_suggestion', query })}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--brand-600)] hover:bg-[var(--brand-700)] text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          <Play className="w-3 h-3" />
          {loading ? 'Running...' : 'Deep Dive →'}
        </button>
      </div>
    </div>
  );
}
