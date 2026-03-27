import { MessageSquare } from 'lucide-react';
import ChartRenderer from '../../chat/ChartRenderer';

export default function ChartBlock({ chart, title, height = 260, loading, sourceHeadline, sourceDate, onAction, cardId }) {
  if (loading) {
    return (
      <div className="h-full rounded-xl border border-[var(--border-default)] bg-[var(--surface-card)] p-4 animate-pulse">
        <div className="h-4 w-40 bg-[var(--surface-subtle)] rounded mb-4" />
        <div className="h-48 bg-[var(--surface-subtle)] rounded" />
      </div>
    );
  }

  if (!chart) return null;

  return (
    <div className="h-full rounded-xl border border-[var(--border-default)] bg-[var(--surface-card)] p-4 flex flex-col">
      {title && (
        <div className="mb-3 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h4 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h4>
            {sourceHeadline && (
              <p className="text-[10px] text-[var(--text-muted)] mt-0.5 truncate">
                {sourceHeadline}{sourceDate ? ` · ${sourceDate}` : ''}
              </p>
            )}
          </div>
          {onAction && (
            <button
              onClick={() => onAction({ type: 'explore_insight', context: { title, chartType: chart.type, sourceHeadline } })}
              className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-medium text-[var(--text-muted)] hover:text-[var(--brand-600)] hover:bg-[var(--brand-50)] transition-colors cursor-pointer"
              title="Explore this insight in Chat"
              aria-label={`Explore chart: ${title}`}
            >
              <MessageSquare className="w-3 h-3" />
              <span>Explore</span>
            </button>
          )}
        </div>
      )}
      <div className="flex-1 min-h-0">
        <ChartRenderer chart={chart} height={height} compatibleTypes={chart.compatibleTypes} showSwitcher={true} />
      </div>
    </div>
  );
}
