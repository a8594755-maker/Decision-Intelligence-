import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Wrench } from 'lucide-react';

/**
 * Collapsible tool execution summary card.
 * Collapsed: "Agent executed 7 tools — 5 ✅ 2 ❌"
 * Expanded: List of tool calls with name, status, and error (if failed).
 */
export default function ToolExecutionSummary({ toolCalls = [], defaultCollapsed = true }) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return null;

  const successCount = toolCalls.filter(tc => tc.result?.success).length;
  const failCount = toolCalls.length - successCount;

  return (
    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-card)] overflow-hidden">
      <button
        type="button"
        onClick={() => setCollapsed(prev => !prev)}
        className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm transition-colors hover:bg-[var(--accent-hover)]"
      >
        {collapsed
          ? <ChevronRight size={14} className="text-[var(--text-muted)] shrink-0" />
          : <ChevronDown size={14} className="text-[var(--text-muted)] shrink-0" />
        }
        <Wrench size={14} className="text-[var(--text-muted)] shrink-0" />
        <span className="font-medium text-[var(--text-secondary)]">
          Agent executed {toolCalls.length} tool{toolCalls.length > 1 ? 's' : ''}
        </span>
        <span className="ml-auto flex items-center gap-2 text-xs text-[var(--text-muted)]">
          {successCount > 0 && <span className="text-[var(--status-success)]">✅ {successCount}</span>}
          {failCount > 0 && <span className="text-[var(--status-danger)]">❌ {failCount}</span>}
        </span>
      </button>

      {!collapsed && (
        <div className="border-t border-[var(--border-default)] px-4 py-2 space-y-1">
          {toolCalls.map((tc, i) => (
            <div key={tc.id || `tc-${i}`} className="flex items-start gap-2 text-xs py-1">
              <span className="shrink-0 mt-0.5">
                {tc.result?.success ? '✅' : '❌'}
              </span>
              <span className="font-mono text-[var(--text-primary)]">{tc.name}</span>
              {tc.result?.artifactTypes?.length > 0 && (
                <span className="text-[var(--text-muted)]">→ {tc.result.artifactTypes.join(', ')}</span>
              )}
              {!tc.result?.success && tc.result?.error && (
                <span className="text-[var(--status-danger)] truncate max-w-[300px]" title={tc.result.error}>
                  {tc.result.error}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
