import { Lightbulb, MessageSquare } from 'lucide-react';

export default function FindingsBlock({ title = 'Key Findings', findings = [], loading, onAction }) {
  if (loading) {
    return (
      <div className="h-full rounded-xl border border-[var(--border-default)] bg-[var(--surface-card)] p-5 animate-pulse">
        <div className="h-4 w-32 bg-[var(--surface-subtle)] rounded mb-4" />
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex gap-3 mb-3">
            <div className="h-6 w-6 rounded-full bg-[var(--surface-subtle)] shrink-0" />
            <div className="h-4 flex-1 bg-[var(--surface-subtle)] rounded" />
          </div>
        ))}
      </div>
    );
  }

  if (!findings.length) return null;

  const getText = (f) => typeof f === 'string' ? f : f.text || f.finding;

  return (
    <div className="h-full rounded-xl border border-[var(--border-default)] bg-[var(--surface-card)] p-5">
      <div className="flex items-center gap-2 mb-3">
        <Lightbulb className="w-4 h-4 text-[var(--status-warning)]" />
        <h4 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h4>
      </div>
      <ol className="space-y-2">
        {findings.map((f, i) => (
          <li key={i} className="flex gap-3 text-sm group">
            <span className="shrink-0 w-6 h-6 rounded-full bg-[var(--brand-50)] text-[var(--brand-700)] flex items-center justify-center text-xs font-bold">
              {i + 1}
            </span>
            <span className="text-[var(--text-secondary)] leading-snug flex-1">{getText(f)}</span>
            {onAction && (
              <button
                onClick={() => onAction({ type: 'explore_insight', context: { title: `Finding: ${getText(f).slice(0, 80)}`, finding: getText(f) } })}
                className="shrink-0 opacity-70 group-hover:opacity-100 p-1 rounded text-[var(--text-muted)] hover:text-[var(--brand-600)] hover:bg-[var(--brand-50)] transition-all cursor-pointer"
                title="Explore this finding"
                aria-label={`Explore finding: ${getText(f).slice(0, 40)}`}
              >
                <MessageSquare className="w-3.5 h-3.5" />
              </button>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
