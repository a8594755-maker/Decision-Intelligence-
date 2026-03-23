import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Database, FileWarning, FileText, Wrench } from 'lucide-react';
import { Card } from '../ui';
import SqlQueryBlock from './SqlQueryBlock';

function formatFailureCategoryLabel(category) {
  return String(category || '').trim().replace(/_/g, ' ');
}

function ToggleRow({ expanded, onToggle, icon: Icon, title, meta }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-slate-700 transition-colors hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800/70"
    >
      {expanded ? <ChevronDown size={15} className="text-slate-400" /> : <ChevronRight size={15} className="text-slate-400" />}
      {Icon ? <Icon size={15} className="text-slate-500 dark:text-slate-400" /> : null}
      <span className="font-medium">{title}</span>
      {meta ? <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">{meta}</span> : null}
    </button>
  );
}

function TraceAttemptCard({ attempt, variant = 'success' }) {
  const [expanded, setExpanded] = useState(false);
  const isFailure = variant === 'failure';
  const title = attempt?.name || 'tool';
  const failureCategory = isFailure ? String(attempt?.category || '').trim() : '';
  const failureCategoryLabel = formatFailureCategoryLabel(failureCategory);
  const meta = isFailure
    ? failureCategoryLabel ? `failed · ${failureCategoryLabel}` : 'failed'
    : attempt?.rowCount > 0
      ? `${attempt.rowCount} rows`
      : 'completed';

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900/40">
      <ToggleRow
        expanded={expanded}
        onToggle={() => setExpanded((value) => !value)}
        icon={isFailure ? FileWarning : Wrench}
        title={title}
        meta={meta}
      />
      <div className="px-3 pb-3">
        <p className={`text-sm ${isFailure ? 'text-rose-600 dark:text-rose-300' : 'text-slate-600 dark:text-slate-300'}`}>
          {isFailure ? attempt?.error || attempt?.summary : attempt?.summary}
        </p>
        {expanded ? (
          <div className="mt-3 space-y-3">
            {attempt?.sql ? (
              <SqlQueryBlock
                sql={attempt.sql}
                result={attempt.result}
                toolName={`${title} SQL`}
                defaultExpanded={false}
                variant={isFailure ? 'failure' : 'success'}
                summary={attempt.summary}
              />
            ) : null}
            {!attempt?.sql && attempt?.args ? (
              <pre className="overflow-x-auto rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-950/40 dark:text-slate-300">
                {attempt.args}
              </pre>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default function ExecutionTraceCard({ trace, agentLabel }) {
  const [expanded, setExpanded] = useState(false);
  const [narrativeExpanded, setNarrativeExpanded] = useState(false);
  const failedAttempts = Array.isArray(trace?.failed_attempts) ? trace.failed_attempts : [];
  const successfulQueries = Array.isArray(trace?.successful_queries) ? trace.successful_queries : [];
  const rawNarrative = typeof trace?.raw_narrative === 'string' ? trace.raw_narrative.trim() : '';

  const sections = useMemo(() => {
    return {
      failed: failedAttempts.length,
      success: successfulQueries.length,
      narrative: rawNarrative ? 1 : 0,
    };
  }, [failedAttempts.length, successfulQueries.length, rawNarrative]);

  if (sections.failed + sections.success + sections.narrative === 0) return null;

  return (
    <Card className="w-full border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-900/40 p-0">
      <div className="border-b border-slate-200 dark:border-slate-800 px-4 py-3">
        <ToggleRow
          expanded={expanded}
          onToggle={() => setExpanded((value) => !value)}
          icon={Database}
          title={agentLabel ? `Execution Trace — ${agentLabel}` : 'Execution Trace'}
          meta={`${failedAttempts.length} failed • ${successfulQueries.length} successful`}
        />
      </div>

      {expanded ? (
        <div className="space-y-4 px-4 py-4">
          {failedAttempts.length > 0 ? (
            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
                Failed Attempts
              </div>
              {failedAttempts.map((attempt) => (
                <TraceAttemptCard key={attempt.id} attempt={attempt} variant="failure" />
              ))}
            </div>
          ) : null}

          {successfulQueries.length > 0 ? (
            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
                Successful Steps
              </div>
              {successfulQueries.map((attempt) => (
                <TraceAttemptCard key={attempt.id} attempt={attempt} variant="success" />
              ))}
            </div>
          ) : null}

          {rawNarrative ? (
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-700 dark:bg-slate-900/40">
              <ToggleRow
                expanded={narrativeExpanded}
                onToggle={() => setNarrativeExpanded((value) => !value)}
                icon={FileText}
                title="Full Narrative"
              />
              {narrativeExpanded ? (
                <div className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-600 dark:text-slate-300">
                  {rawNarrative}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
