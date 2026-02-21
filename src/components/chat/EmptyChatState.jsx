import React from 'react';
import { Sparkles, Bot } from 'lucide-react';

export default function EmptyChatState({ quickPrompts = [], onSelectPrompt }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-6">
      <div className="w-12 h-12 rounded-2xl bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300 flex items-center justify-center mb-3">
        <Bot className="w-6 h-6" />
      </div>
      <h2 className="text-base font-medium text-slate-800 dark:text-slate-100">How can I help today?</h2>
      <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 max-w-lg">
        Upload data with the paperclip, ask for a forecast or replenishment plan, and review white-box artifacts in Canvas.
      </p>

      <div className="mt-5 flex items-center gap-1 text-xs text-slate-400">
        <Sparkles className="w-3.5 h-3.5" />
        Suggestions
      </div>
      <div className="mt-2 flex flex-wrap justify-center gap-2 max-w-2xl">
        {quickPrompts.slice(0, 3).map((prompt) => (
          <button
            key={prompt.label}
            type="button"
            onClick={() => onSelectPrompt?.(prompt.prompt)}
            className="rounded-full border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            {prompt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
