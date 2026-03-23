/**
 * SqlQueryBlock.jsx
 *
 * Collapsible SQL query display for agent tool calls.
 * Shows the executed SQL with syntax highlighting (monospace),
 * result row count, and a toggle to expand/collapse.
 */

import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Database, Copy, Check } from 'lucide-react';

export default function SqlQueryBlock({
  sql,
  result,
  toolName,
  defaultExpanded = true,
  variant = null,
  summary = '',
  compact = false,
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [copied, setCopied] = useState(false);

  if (!sql) return null;

  const success = result?.success;
  const rowCount = result?.result?.rowCount ?? result?.result?.rows?.length ?? 0;
  const truncated = result?.result?.truncated;
  const resolvedVariant = variant || (success === false ? 'failure' : 'success');
  const toneClasses = resolvedVariant === 'failure'
    ? 'border-rose-200/80 bg-rose-50/80 text-rose-900 dark:border-rose-900/60 dark:bg-rose-950/20 dark:text-rose-100'
    : 'border-slate-200 bg-slate-50/80 text-slate-900 dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-100';
  const headerHoverClass = resolvedVariant === 'failure'
    ? 'hover:bg-rose-100/70 dark:hover:bg-rose-900/20'
    : 'hover:bg-slate-100/70 dark:hover:bg-slate-800/60';

  const handleCopy = async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(sql);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  return (
    <div className={`overflow-hidden rounded-lg border mt-1.5 mb-1.5 ${toneClasses}`}>
      {/* Header — always visible */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={`w-full flex items-center gap-2 px-3 ${compact ? 'py-1.5' : 'py-2'} text-xs font-medium transition-colors ${headerHoverClass}`}
      >
        {expanded
          ? <ChevronDown size={14} className="text-slate-500 flex-shrink-0" />
          : <ChevronRight size={14} className="text-slate-500 flex-shrink-0" />
        }
        <Database size={13} className={resolvedVariant === 'failure' ? 'text-rose-500 flex-shrink-0' : 'text-blue-500 flex-shrink-0'} />
        <span className="font-mono">{toolName || 'SQL Query'}</span>
        {summary ? <span className="truncate text-slate-500 dark:text-slate-400">{summary}</span> : null}
        <span className="text-slate-500 dark:text-slate-400 ml-auto flex items-center gap-2">
          {success != null && (
            <span className={success ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}>
              {success ? `${rowCount} row${rowCount !== 1 ? 's' : ''}` : 'error'}
            </span>
          )}
          {truncated && <span className="text-amber-500 dark:text-amber-400">(truncated)</span>}
        </span>
      </button>

      {/* Body — collapsible */}
      {expanded && (
        <div className="relative border-t border-slate-200/80 dark:border-slate-700/60">
          {/* Copy button */}
          <button
            type="button"
            onClick={handleCopy}
            className="absolute top-2 right-2 p-1 rounded text-slate-500 hover:text-slate-700 hover:bg-slate-200/70 transition-colors dark:hover:text-slate-300 dark:hover:bg-slate-700/50"
            title="Copy SQL"
          >
            {copied ? <Check size={13} className="text-emerald-500 dark:text-emerald-400" /> : <Copy size={13} />}
          </button>

          {/* SQL code */}
          <pre className="px-3 py-2.5 pr-10 text-xs font-mono whitespace-pre-wrap break-words overflow-x-auto leading-relaxed bg-white/80 text-slate-700 dark:bg-slate-950/40 dark:text-emerald-300">
            {sql}
          </pre>
        </div>
      )}
    </div>
  );
}
