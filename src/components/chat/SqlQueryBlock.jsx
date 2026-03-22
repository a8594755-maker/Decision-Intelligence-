/**
 * SqlQueryBlock.jsx
 *
 * Collapsible SQL query display for agent tool calls.
 * Shows the executed SQL with syntax highlighting (monospace),
 * result row count, and a toggle to expand/collapse.
 */

import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Database, Copy, Check } from 'lucide-react';

export default function SqlQueryBlock({ sql, result, toolName }) {
  const [expanded, setExpanded] = useState(true);
  const [copied, setCopied] = useState(false);

  if (!sql) return null;

  const success = result?.success;
  const rowCount = result?.result?.rowCount ?? result?.result?.rows?.length ?? 0;
  const truncated = result?.result?.truncated;

  const handleCopy = async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(sql);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  return (
    <div className="rounded-lg border border-slate-600/50 bg-slate-900/60 overflow-hidden mt-1.5 mb-1.5">
      {/* Header — always visible */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800/50 transition-colors"
      >
        {expanded
          ? <ChevronDown size={14} className="text-slate-500 flex-shrink-0" />
          : <ChevronRight size={14} className="text-slate-500 flex-shrink-0" />
        }
        <Database size={13} className="text-blue-400 flex-shrink-0" />
        <span className="text-blue-400 font-mono">{toolName || 'SQL Query'}</span>
        <span className="text-slate-500 ml-auto flex items-center gap-2">
          {success != null && (
            <span className={success ? 'text-green-400' : 'text-red-400'}>
              {success ? `${rowCount} row${rowCount !== 1 ? 's' : ''}` : 'error'}
            </span>
          )}
          {truncated && <span className="text-amber-400">(truncated)</span>}
        </span>
      </button>

      {/* Body — collapsible */}
      {expanded && (
        <div className="relative border-t border-slate-700/50">
          {/* Copy button */}
          <button
            type="button"
            onClick={handleCopy}
            className="absolute top-2 right-2 p-1 rounded text-slate-500 hover:text-slate-300 hover:bg-slate-700/50 transition-colors"
            title="Copy SQL"
          >
            {copied ? <Check size={13} className="text-green-400" /> : <Copy size={13} />}
          </button>

          {/* SQL code */}
          <pre className="px-3 py-2.5 pr-10 text-xs font-mono text-emerald-300 whitespace-pre-wrap break-words overflow-x-auto leading-relaxed bg-slate-950/40">
            {sql}
          </pre>
        </div>
      )}
    </div>
  );
}
