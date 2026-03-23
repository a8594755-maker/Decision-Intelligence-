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
  const hasAvailableCrossReview = reviewerList.some((reviewer) => reviewer?.stage === 'cross_model' && reviewer?.available !== false);
  const hasUnavailableCrossReview = reviewerList.some((reviewer) => reviewer?.stage === 'cross_model' && reviewer?.available === false);
  const reviewStatusLabel = hasAvailableCrossReview
    ? 'Cross-model review used'
    : hasUnavailableCrossReview
      ? 'Cross-model review unavailable'
      : 'Self-review only';

  const dimensionEntries = useMemo(() => {
    return Object.entries(DIMENSION_LABELS).map(([key, label]) => ({
      key,
      label,
      value: typeof dimensionScores?.[key] === 'number' ? dimensionScores[key] : null,
    }));
  }, [dimensionScores]);

  if (!qa) return null;

  return (
    <Card className="w-full border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-900/40 p-0">
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
            <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">Answer Quality</span>
            <TonePill status={qa.status}>{qa.status}</TonePill>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
            <span>{`Score ${Number(qa.score || 0).toFixed(1)} / ${Number(qa.pass_threshold || 8).toFixed(1)}`}</span>
            <span>{reviewStatusLabel}</span>
            <span>{qa.repair_attempted ? 'Repair executed' : 'No repair needed'}</span>
            {judgeDecision?.winnerLabel ? <span>{`Winner: ${judgeDecision.winnerLabel}`}</span> : null}
          </div>
        </div>
        {expanded ? <ChevronDown size={16} className="text-slate-400" /> : <ChevronRight size={16} className="text-slate-400" />}
      </button>

      {expanded ? (
        <div className="space-y-4 border-t border-slate-200 px-4 py-4 dark:border-slate-800">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {dimensionEntries.map((item) => (
              <div
                key={item.key}
                className="rounded-xl border border-slate-200 bg-white px-3 py-3 dark:border-slate-700 dark:bg-slate-900/40"
              >
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">
                  {item.label}
                </div>
                <div className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-100">
                  {item.value == null ? 'N/A' : item.value.toFixed(1)}
                </div>
              </div>
            ))}
          </div>

          {normalizedIssues.length > 0 ? (
            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
                Top Issues
              </div>
              <ul className="space-y-1.5">
                {normalizedIssues.slice(0, 3).map((issue) => (
                  <li key={issue} className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-200">
                    <BadgeCheck size={14} className="mt-1 shrink-0 text-slate-400 dark:text-slate-500" />
                    <span>{issue}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {judgeDecision ? (
            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
                Judge Verdict
              </div>
              <div className="rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-200">
                {judgeDecision.summary ? <p>{judgeDecision.summary}</p> : null}
                {Array.isArray(judgeDecision.rationale) && judgeDecision.rationale.length > 0 ? (
                  <ul className="mt-2 space-y-1">
                    {judgeDecision.rationale.slice(0, 3).map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                ) : null}
                <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                  {[judgeDecision?.reviewer?.provider, judgeDecision?.reviewer?.model].filter(Boolean).join(' · ')}
                </div>
              </div>
            </div>
          ) : null}

          {reviewerList.length > 0 ? (
            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
                Reviewer Details
              </div>
              <div className="space-y-2">
                {reviewerList.map((reviewer, index) => (
                  <div
                    key={`${reviewer.stage}-${reviewer.provider}-${index}`}
                    className="rounded-xl border border-slate-200 bg-white px-3 py-3 dark:border-slate-700 dark:bg-slate-900/40"
                  >
                    <div className="flex flex-wrap items-center gap-2 text-sm text-slate-900 dark:text-slate-100">
                      <span className="font-semibold">{reviewer.stage === 'cross_model' ? 'Cross-model' : 'Self-review'}</span>
                      <span className="text-slate-500 dark:text-slate-400">{reviewer.provider || 'unknown provider'}</span>
                      <span className="text-slate-500 dark:text-slate-400">{reviewer.model || 'unknown model'}</span>
                      <span className="ml-auto text-xs font-medium text-slate-500 dark:text-slate-400">
                        {reviewer.score === 0 && Array.isArray(reviewer.issues) && reviewer.issues.some((i) => /unavailable/i.test(i))
                          ? 'Unavailable'
                          : `Score ${Number(reviewer.score || 0).toFixed(1)}`}
                      </span>
                    </div>
                    {Array.isArray(reviewer.issues) && reviewer.issues.length > 0 ? (
                      <ul className="mt-2 space-y-1 text-sm text-slate-600 dark:text-slate-300">
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
