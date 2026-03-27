import React from 'react';
import { Sparkles, Bot } from 'lucide-react';

export default function EmptyChatState({ quickPrompts = [], onSelectPrompt, variant = 'default' }) {
  if (variant === 'ai_employee') {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 py-12 text-center">
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-[20px] bg-[var(--brand-600)] text-white shadow-sm">
          <Bot className="h-7 w-7" />
        </div>
        <h2 className="text-3xl font-semibold tracking-tight text-[var(--text-primary)]">
          What should your worker handle?
        </h2>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--text-muted)]">
          Describe an analysis, upload a dataset, ask for a report, or let the digital worker break a task into steps and run it.
        </p>

        {quickPrompts.length > 0 && (
          <>
            <div className="mt-8 flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.18em] text-[var(--text-muted)]">
              <Sparkles className="h-3.5 w-3.5" />
              Suggestions
            </div>

            <div className="mt-4 grid w-full max-w-3xl gap-3 sm:grid-cols-2">
              {quickPrompts.slice(0, 4).map((prompt) => (
                <button
                  key={prompt.label}
                  type="button"
                  onClick={() => onSelectPrompt?.(prompt.prompt)}
                  className="rounded-[22px] border border-[var(--border-default)] bg-[var(--surface-card)] px-5 py-4 text-left shadow-[var(--shadow-card)] transition hover:-translate-y-0.5 hover:border-[var(--brand-500)]/40 hover:shadow-[var(--shadow-elevated)] cursor-pointer"
                >
                  <div className="text-sm font-semibold text-[var(--text-primary)]">{prompt.label}</div>
                  <div className="mt-2 text-xs leading-5 text-[var(--text-muted)]">
                    {prompt.prompt}
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-6">
      <div className="w-12 h-12 rounded-2xl bg-[var(--brand-50)] text-[var(--brand-600)] flex items-center justify-center mb-3">
        <Bot className="w-6 h-6" />
      </div>
      <h2 className="text-base font-medium text-[var(--text-primary)]">How can I help today?</h2>
      <p className="text-sm text-[var(--text-muted)] mt-1 max-w-lg">
        Upload data with the paperclip, assign a task or ask a question, and review deliverables in Canvas.
      </p>

      {quickPrompts.length > 0 && (
        <>
          <div className="mt-5 flex items-center gap-1 text-xs text-[var(--text-muted)]">
            <Sparkles className="w-3.5 h-3.5" />
            Suggestions
          </div>
          <div className="mt-2 flex flex-wrap justify-center gap-2 max-w-2xl">
            {quickPrompts.slice(0, 3).map((prompt) => (
              <button
                key={prompt.label}
                type="button"
                onClick={() => onSelectPrompt?.(prompt.prompt)}
                className="rounded-full border border-[var(--border-default)] px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--accent-hover)] transition-colors cursor-pointer"
              >
                {prompt.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
