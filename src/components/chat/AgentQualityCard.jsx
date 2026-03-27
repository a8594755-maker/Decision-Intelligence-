import React, { useMemo, useState } from 'react';
import { BadgeCheck, ChevronDown, ChevronRight, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Card } from '../ui';

const DIMENSION_LABELS = Object.freeze({
  correctness: 'Correctness',
  completeness: 'Completeness',
  evidence_alignment: 'Evidence',
  visualization_fit: 'Viz Fit',
  caveat_quality: 'Caveats',
  clarity: 'Clarity',
});

function TonePill({ status, children }) {
  const classes = status === 'pass'
    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
    : 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300';

  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] ${classes}`}>
      {children}
    </span>
  );
}

export default function AgentQualityCard({ qa, judgeDecision = null }) {
  const [expanded, setExpanded] = useState(false);
  const normalizedIssues = Array.isArray(qa?.issues) ? qa.issues.filter(Boolean) : [];
  const dimensionScores = qa?.dimension_scores || {};
  const reviewerList = Array.isArray(qa?.reviewers) ? qa.reviewers : [];
  const reviewStatusLabel = 'Unified review';

  const dimensionEntries = useMemo(() => {
    return Object.entries(DIMENSION_LABELS).map(([key, label]) => ({
      key,
      label,
      value: typeof dimensionScores?.[key] === 'number' ? dimensionScores[key] : null,
    }));
  }, [dimensionScores]);

  if (!qa) return null;

  return (
    <Card category="analysis" className="w-full border-[var(--border-default)] bg-[var(--surface-base)] p-0">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <div className={`rounded-xl p-2 ${qa.status === 'pass' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'}`}>
          {qa.status === 'pass' ? <ShieldCheck size={16} /> : <ShieldAlert size={16} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-[var(--text-primary)]">Answer Quality</span>
            <TonePill status={qa.status}>{qa.status}</TonePill>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-muted)]">
            <span>{`Score ${Number(qa.score || 0).toFixed(1)} / ${Number(qa.pass_threshold || 8).toFixed(1)}`}</span>
            <span>{reviewStatusLabel}</span>
            <span>{qa.repair_attempted ? 'Repair executed' : 'No repair needed'}</span>
            {judgeDecision?.winnerLabel ? <span>{`Winner: ${judgeDecision.winnerLabel}`}</span> : null}
          </div>
        </div>
        {expanded ? <ChevronDown size={16} className="text-[var(--text-muted)]" /> : <ChevronRight size={16} className="text-[var(--text-muted)]" />}
      </button>

      {expanded ? (
        <div className="space-y-4 border-t border-[var(--border-default)] px-4 py-4 dark:border-[var(--border-default)]">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {dimensionEntries.map((item) => (
              <div
                key={item.key}
                className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-card)] px-3 py-3"
              >
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
                  {item.label}
                </div>
                <div className="mt-1 text-lg font-semibold text-[var(--text-primary)]">
                  {item.value == null ? 'N/A' : item.value.toFixed(1)}
                </div>
              </div>
            ))}
          </div>

          {normalizedIssues.length > 0 ? (
            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
                Top Issues
              </div>
              <ul className="space-y-1.5">
                {normalizedIssues.slice(0, 3).map((issue) => (
                  <li key={issue} className="flex items-start gap-2 text-sm text-[var(--text-secondary)]">
                    <BadgeCheck size={14} className="mt-1 shrink-0 text-[var(--text-muted)]" />
                    <span>{issue}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {judgeDecision ? (
            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
                Judge Verdict
              </div>
              <div className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-card)] px-3 py-3 text-sm text-[var(--text-secondary)]">
                {judgeDecision.summary ? <p>{judgeDecision.summary}</p> : null}
                {Array.isArray(judgeDecision.rationale) && judgeDecision.rationale.length > 0 ? (
                  <ul className="mt-2 space-y-1">
                    {judgeDecision.rationale.slice(0, 3).map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                ) : null}
                <div className="mt-2 text-xs text-[var(--text-muted)]">
                  {[judgeDecision?.reviewer?.provider, judgeDecision?.reviewer?.model].filter(Boolean).join(' · ')}
                </div>
              </div>
            </div>
          ) : null}

          {reviewerList.length > 0 ? (
            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
                Reviewer Details
              </div>
              <div className="space-y-2">
                {reviewerList.map((reviewer, index) => (
                  <div
                    key={`${reviewer.stage}-${reviewer.provider}-${index}`}
                    className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-card)] px-3 py-3"
                  >
                    <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--text-primary)]">
                      <span className="font-semibold">{reviewer.stage === 'cross_model' ? 'Cross-model' : 'Reviewer'}</span>
                      <span className="text-[var(--text-muted)]">{reviewer.provider || 'unknown provider'}</span>
                      <span className="text-[var(--text-muted)]">{reviewer.model || 'unknown model'}</span>
                      <span className="ml-auto text-xs font-medium text-[var(--text-muted)]">
                        {reviewer.score === 0 && Array.isArray(reviewer.issues) && reviewer.issues.some((i) => /unavailable/i.test(i))
                          ? 'Unavailable'
                          : `Score ${Number(reviewer.score || 0).toFixed(1)}`}
                      </span>
                    </div>
                    {Array.isArray(reviewer.issues) && reviewer.issues.length > 0 ? (
                      <ul className="mt-2 space-y-1 text-sm text-[var(--text-secondary)]">
                        {reviewer.issues.map((issue) => (
                          <li key={issue}>{issue}</li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
