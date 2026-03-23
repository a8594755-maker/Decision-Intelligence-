import React, { useState } from 'react';
import { ChevronDown, ChevronRight, GitCompareArrows } from 'lucide-react';
import { Card } from '../ui';
import AgentBriefCard from './AgentBriefCard';
import ExecutionTraceCard from './ExecutionTraceCard';

function formatFailureCategoryLabel(category) {
  return String(category || '').trim().replace(/_/g, ' ');
}

export default function AgentAlternativeCard({ candidate }) {
  const [expanded, setExpanded] = useState(false);

  if (!candidate) return null;
  const status = candidate?.status || 'completed';
  const failedReason = String(candidate?.failedReason || '').trim();
  const failureCategory = String(candidate?.failureCategory || '').trim();
  const failureCategoryLabel = formatFailureCategoryLabel(failureCategory);
  const hasBrief = Boolean(candidate?.brief);
  const statusLabel = status === 'timed_out'
    ? 'timed out'
    : status === 'failed'
      ? 'failed'
      : 'completed';

  return (
    <Card className="w-full border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-900/30 p-0">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <div className="rounded-xl bg-emerald-100 p-2 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
          <GitCompareArrows size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Alternative Answer
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {[candidate.label, candidate.provider, candidate.model].filter(Boolean).join(' · ')}
          </div>
        </div>
        <div className={`rounded-full px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.12em] ${
          status === 'completed'
            ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
            : 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300'
        }`}>
          {statusLabel}
        </div>
        {expanded ? <ChevronDown size={16} className="text-slate-400" /> : <ChevronRight size={16} className="text-slate-400" />}
      </button>

      {expanded ? (
        <div className="space-y-3 border-t border-slate-200 px-4 py-4 dark:border-slate-800">
          {hasBrief ? (
            <AgentBriefCard brief={candidate.brief} />
          ) : (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900/40 dark:bg-rose-950/20 dark:text-rose-200">
              {failureCategoryLabel ? `[${failureCategoryLabel}] ` : ''}{failedReason || 'This candidate did not produce a usable answer.'}
            </div>
          )}
          {candidate.trace ? <ExecutionTraceCard trace={candidate.trace} /> : null}
        </div>
      ) : null}
    </Card>
  );
}
