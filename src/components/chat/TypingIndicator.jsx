import React from 'react';

export default function TypingIndicator({ label = 'Assistant is typing...' }) {
  return (
    <div className="inline-flex items-center gap-2 text-sm text-[var(--text-secondary)]">
      <span className="flex items-center gap-1.5" aria-hidden>
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--brand-500)] animate-pulse" />
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--brand-500)] animate-pulse [animation-delay:120ms]" />
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--brand-500)] animate-pulse [animation-delay:240ms]" />
      </span>
      <span>{label}</span>
    </div>
  );
}
