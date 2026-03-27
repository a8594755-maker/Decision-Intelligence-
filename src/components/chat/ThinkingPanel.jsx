import React, { useEffect, useRef, useState } from 'react';
import { Brain, CheckCircle2, ChevronDown, ChevronRight, X } from 'lucide-react';

/**
 * ThinkingPanel — ChatGPT-style right-side panel for real-time reasoning display.
 *
 * Self-contained: includes its own header with timer and close button.
 * Parent should render this as the full content of a secondary panel.
 *
 * @param {Array} steps — thinking step objects from thinkingStepsRef
 * @param {boolean} completed — whether reasoning is finished
 * @param {number} startTime — Date.now() when thinking started (for timer)
 * @param {Function} onClose — callback to close the panel
 */
export default function ThinkingPanel({ steps = [], completed = false, startTime, onClose }) {
  const scrollRef = useRef(null);
  const [elapsed, setElapsed] = useState(0);
  const [stepsCollapsed, setStepsCollapsed] = useState(false);

  // Timer — count up every second while thinking
  useEffect(() => {
    if (completed || !startTime) return;
    const tick = () => setElapsed(Math.floor((Date.now() - startTime) / 1000));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [completed, startTime]);

  // Freeze final time when completed + auto-collapse steps
  useEffect(() => {
    if (completed && startTime) {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
      setStepsCollapsed(true);
    }
  }, [completed, startTime]);

  // Auto-scroll to bottom as new steps arrive (only when expanded)
  useEffect(() => {
    if (stepsCollapsed) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [steps, stepsCollapsed]);

  const formatTime = (s) => {
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header — self-contained with timer + close */}
      <div className="flex items-center gap-2 px-5 py-3 border-b border-[var(--border-default)] shrink-0">
        {completed ? (
          <CheckCircle2 className="w-4 h-4 text-[var(--status-success)] shrink-0" />
        ) : (
          <span className="relative flex h-4 w-4 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--brand-500)] opacity-30" />
            <Brain className="relative w-3.5 h-3.5 text-[var(--brand-600)]" />
          </span>
        )}
        <span className="text-sm font-semibold text-[var(--text-primary)]">
          {completed ? 'Thinking complete' : 'Thinking'}
        </span>
        <span className="text-xs text-[var(--text-muted)] font-mono tabular-nums">
          · {formatTime(elapsed)}
        </span>
        <div className="ml-auto">
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--accent-hover)] transition-colors cursor-pointer"
              aria-label="Close thinking panel"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Collapsed summary bar */}
      {stepsCollapsed && completed ? (
        <div className="px-5 py-4">
          <button
            type="button"
            onClick={() => setStepsCollapsed(false)}
            className="flex items-center gap-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer w-full text-left"
          >
            <ChevronRight className="w-3.5 h-3.5 shrink-0" />
            <span>Thought for {formatTime(elapsed)} · {steps.filter(s => (s.content || '').trim()).length} steps</span>
          </button>
        </div>
      ) : (
        /* Steps list */
        <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin px-5 py-4">
          {completed && (
            <button
              type="button"
              onClick={() => setStepsCollapsed(true)}
              className="flex items-center gap-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors cursor-pointer mb-3"
            >
              <ChevronDown className="w-3.5 h-3.5 shrink-0" />
              <span>Collapse</span>
            </button>
          )}
          <div className="space-y-4">
            {steps.map((step, i) => {
              const content = (step.content || '').trim();
              if (!content) return null;
              return (
                <div key={`${step.agentKey || 'default'}-${step.step}-${i}`} className="flex items-start gap-3">
                  {/* Numbered bullet */}
                  <span className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--surface-subtle)] text-[10px] font-bold text-[var(--text-secondary)] shrink-0">
                    {i + 1}
                  </span>

                  {/* Content — capped height with internal scroll for long data */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-[var(--text-primary)] leading-relaxed whitespace-pre-wrap max-h-[120px] overflow-y-auto scrollbar-thin">
                      {content}
                    </p>
                    {/* Agent/model attribution (if multiple agents) */}
                    {step.agentLabel && (
                      <p className="mt-1 text-[10px] text-[var(--text-muted)]">
                        {[step.agentLabel, step.model].filter(Boolean).join(' · ')}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Live indicator at bottom */}
            {!completed && (
              <div className="flex items-center gap-2 text-xs text-[var(--text-muted)] pt-1">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--brand-500)] animate-pulse" />
                <span>Processing...</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
