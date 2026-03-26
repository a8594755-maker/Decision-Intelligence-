import React, { useEffect, useState } from 'react';
import { Brain, ChevronDown, ChevronRight, CheckCircle2 } from 'lucide-react';

const TONE_STYLES = Object.freeze({
  primary: {
    group: 'border-blue-100 bg-blue-50/60 dark:border-blue-900/40 dark:bg-blue-950/20',
    chip: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
    bubble: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  },
  secondary: {
    group: 'border-emerald-100 bg-emerald-50/60 dark:border-emerald-900/40 dark:bg-emerald-950/20',
    chip: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
    bubble: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  },
  judge: {
    group: 'border-amber-100 bg-amber-50/60 dark:border-amber-900/40 dark:bg-amber-950/20',
    chip: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
    bubble: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  },
  default: {
    group: 'border-slate-200 bg-slate-50/60 dark:border-slate-800 dark:bg-slate-900/30',
    chip: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
    bubble: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  },
});

function resolveToneStyles(tone) {
  return TONE_STYLES[tone] || TONE_STYLES.default;
}

function resolveStatusTone(status) {
  if (status === 'failed') return 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300';
  if (status === 'timed_out') return 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300';
  if (status === 'completed') return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300';
  return 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
}

/**
 * ThinkingStepsDisplay — renders the agent's real-time thinking/preamble steps
 * during multi-step execution. Shows each step with a numbered indicator and
 * the LLM's reasoning text as it streams in.
 *
 * @param {object} props
 * @param {Array<{step: number, type: string, content: string}>} props.steps
 * @param {boolean} [props.defaultCollapsed]
 * @param {boolean} [props.completed]
 */
export default function ThinkingStepsDisplay({
  steps,
  defaultCollapsed = false,
  completed = false,
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  useEffect(() => {
    setCollapsed(defaultCollapsed);
  }, [defaultCollapsed, steps?.length]);

  if (!steps?.length) return null;

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
      <div className="max-w-[85%] rounded-xl border border-blue-100 dark:border-blue-900/40 bg-blue-50/40 dark:bg-blue-950/20 px-4 py-3">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="w-full flex items-center gap-1.5 text-left"
        >
          {collapsed ? (
            <ChevronRight className="w-3.5 h-3.5 text-blue-500 dark:text-blue-400 shrink-0" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-blue-500 dark:text-blue-400 shrink-0" />
          )}
          <Brain className="w-3.5 h-3.5 text-blue-500 dark:text-blue-400 shrink-0" />
          <span className="text-[11px] font-medium text-blue-600 dark:text-blue-400 uppercase tracking-wide">
            Thinking
          </span>
          <span className="ml-auto text-[11px] text-blue-500 dark:text-blue-400">
            {steps.length} step{steps.length > 1 ? 's' : ''}
          </span>
        </button>

        {!collapsed && (
          <div className="space-y-3 mt-2">
            {Object.values(groups).map((group) => {
              const styles = resolveToneStyles(group.tone);
              return (
                <div key={group.key} className={`rounded-xl border px-3 py-3 ${styles.group}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] ${styles.chip}`}>
                      {group.label}
                    </span>
                    {(group.provider || group.model) ? (
                      <span className="text-[11px] text-[var(--text-muted)]">
                        {[group.provider, group.model].filter(Boolean).join(' · ')}
                      </span>
                    ) : null}
                    {group.status ? (
                      <span className={`inline-flex items-center rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${resolveStatusTone(group.status)}`}>
                        {group.status === 'timed_out' ? 'timed out' : group.status}
                      </span>
                    ) : null}
                  </div>

                  <div className="space-y-2 mt-3">
                    {group.steps.map((step, i) => (
                      <div key={`${group.key}-${step.step}-${i}`} className="flex items-start gap-2 text-xs">
                        <div className={`mt-0.5 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${styles.bubble}`}>
                          {i + 1}
                        </div>
                        <p className="flex-1 min-w-0 text-[var(--text-secondary)] whitespace-pre-wrap leading-relaxed">
                          {step.content}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex items-center gap-1.5 mt-2 text-[11px] text-blue-500 dark:text-blue-400">
          {completed ? (
            <>
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>Reasoning complete</span>
            </>
          ) : (
            <>
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
              <span>Reasoning...</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
