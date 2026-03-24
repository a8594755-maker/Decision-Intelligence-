import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';

/**
 * A small copy-to-clipboard button. Accepts `getText` (a function that returns
 * the string to copy) so we can lazily compute the text only on click.
 */
export default function CopyAllButton({ getText, className = '' }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e) => {
    e.stopPropagation();
    try {
      const text = typeof getText === 'function' ? getText() : '';
      if (!text) return;
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard API may fail in some contexts */
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      title="Copy all"
      className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition-colors
        ${copied
          ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/30 dark:text-emerald-400'
          : 'bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-700 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-200'
        } ${className}`}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      <span>{copied ? 'Copied' : 'Copy All'}</span>
    </button>
  );
}
