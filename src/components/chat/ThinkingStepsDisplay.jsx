import React, { useEffect, useState } from 'react';
import { Brain, ChevronDown, ChevronRight, CheckCircle2 } from 'lucide-react';

/**
 * ThinkingStepsDisplay — renders thinking steps inline in the chat thread.
 *
 * Two modes:
 * - `inline` (default when panel is active): compact one-line "Thinking..." indicator
 * - `expanded`: full collapsible thinking card (used for thinking_trace_card in history)
 *
 * @param {Array} steps
 * @param {boolean} defaultCollapsed
 * @param {boolean} completed
 * @param {"inline"|"expanded"} mode
 * @param {Function} onOpenPanel — callback to open the right-side thinking panel
 */
const formatTime = (s) => {
  if (!s || s <= 0) return null;
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
};

export default function ThinkingStepsDisplay({
  steps,
  defaultCollapsed = false,
  completed = false,
  mode = 'expanded',
  onOpenPanel,
  elapsedSeconds,
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed || completed);

  useEffect(() => {
    setCollapsed(defaultCollapsed || completed);
  }, [defaultCollapsed, completed, steps?.length]);

  if (!steps?.length) return null;

  /* ── Inline mode: compact one-line indicator ── */
  if (mode === 'inline') {
    return (
      <div className="w-full flex justify-start mb-2">
        <button
          type="button"
          onClick={onOpenPanel}
          className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)] transition-colors cursor-pointer"
        >
          {completed ? (
            <CheckCircle2 className="w-4 h-4 text-[var(--status-success)]" />
          ) : (
            <span className="relative flex h-4 w-4 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--brand-500)] opacity-30" />
              <Brain className="relative w-4 h-4 text-[var(--brand-600)]" />
            </span>
          )}
          <span className="font-medium">
            {completed ? 'Reasoning complete' : 'Reasoning...'}
          </span>
          <span className="text-xs text-[var(--text-muted)]">
            {formatTime(elapsedSeconds) ? `${formatTime(elapsedSeconds)} · ` : ''}{steps.length} step{steps.length > 1 ? 's' : ''}
          </span>
        </button>
      </div>
    );
  }

  /* ── Expanded mode: full collapsible card (for history/trace) ── */
  const groups = steps.reduce((acc, step) => {
    const key = step.agentKey || 'default';
    if (!acc[key]) {
      acc[key] = {
        key,
        label: step.agentLabel || 'Agent',
        provider: step.provider || '',
        model: step.model || '',
        tone: step.agentTone || 'default',
        status: '',
        steps: [],
      };
    }
    if (step.status) acc[key].status = step.status;
    acc[key].steps.push(step);
    return acc;
  }, {});

  return (
    <div className="w-full flex justify-start mb-2">
      <div className="max-w-[85%] rounded-xl border border-[var(--border-default)] bg-[var(--surface-card)] px-4 py-3">
        <button
          type="button"
          onClick={() => onOpenPanel ? onOpenPanel() : setCollapsed((v) => !v)}
          className="w-full flex items-center gap-1.5 text-left cursor-pointer"
        >
          {collapsed ? (
            <ChevronRight className="w-3.5 h-3.5 text-[var(--brand-600)] shrink-0" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-[var(--brand-600)] shrink-0" />
          )}
          <Brain className="w-3.5 h-3.5 text-[var(--brand-600)] shrink-0" />
          <span className="text-[11px] font-medium text-[var(--brand-700)] uppercase tracking-wide">
            Thinking
          </span>
          <span className="ml-auto text-[11px] text-[var(--text-muted)]">
            {formatTime(elapsedSeconds) ? `${formatTime(elapsedSeconds)} · ` : ''}{steps.length} step{steps.length > 1 ? 's' : ''}
          </span>
        </button>

        {!collapsed && (
          <div className="max-h-[300px] overflow-y-auto scrollbar-thin space-y-3 mt-3">
            {Object.values(groups).map((group) => (
              <div key={group.key} className="rounded-lg border border-[var(--border-default)] bg-[var(--surface-base)] px-3 py-3">
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <span className="inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.1em] bg-[var(--surface-subtle)] text-[var(--text-secondary)]">
                    {group.label}
                  </span>
                  {(group.provider || group.model) ? (
                    <span className="text-[11px] text-[var(--text-muted)]">
                      {[group.provider, group.model].filter(Boolean).join(' · ')}
                    </span>
                  ) : null}
                  {group.status ? (
                    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] ${
                      group.status === 'completed' ? 'bg-[var(--status-success-bg)] text-[var(--status-success-text)]' :
                      group.status === 'failed' ? 'bg-[var(--status-danger-bg)] text-[var(--status-danger-text)]' :
                      'bg-[var(--status-warning-bg)] text-[var(--status-warning-text)]'
                    }`}>
                      {group.status === 'timed_out' ? 'timed out' : group.status}
                    </span>
                  ) : null}
                </div>

                <div className="space-y-2">
                  {group.steps.map((step, i) => (
                    <div key={`${group.key}-${step.step}-${i}`} className="flex items-start gap-2 text-xs">
                      <div className="mt-0.5 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 bg-[var(--surface-subtle)] text-[var(--text-secondary)]">
                        {i + 1}
                      </div>
                      <p className="flex-1 min-w-0 text-[var(--text-secondary)] whitespace-pre-wrap leading-relaxed max-h-[100px] overflow-y-auto scrollbar-thin">
                        {step.content}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-1.5 mt-2 text-[11px] text-[var(--text-muted)]">
          {completed ? (
            <>
              <CheckCircle2 className="w-3.5 h-3.5 text-[var(--status-success)]" />
              <span>Reasoning complete</span>
            </>
          ) : (
            <>
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--brand-500)] animate-pulse" />
              <span>Reasoning...</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
