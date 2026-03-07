/**
 * NegotiationPanel - Step 9 Agentic Negotiation Loop v0
 *
 * Shown when a plan run is infeasible or KPI shortfall detected.
 * Lets users:
 *   - Generate candidate relaxation options (deterministic)
 *   - View ranked options with computed delta KPIs
 *   - Apply an option (navigates to scenario comparison)
 *   - Toggle the LLM explanation (negotiation_report narrative)
 */

import React, { useState } from 'react';
import {
  AlertTriangle,
  Zap,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronRight,
  Loader2,
  ExternalLink,
  BookOpen
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const Badge = ({ children, variant = 'info' }) => {
  const colours = {
    success: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
    warning: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
    danger:  'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
    info:    'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
    muted:   'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300'
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${colours[variant] || colours.info}`}>
      {children}
    </span>
  );
};

const FeasibilityBadge = ({ status, feasible }) => {
  if (status === 'failed') return <Badge variant="danger">Re-solve failed</Badge>;
  if (feasible === false) return <Badge variant="warning">Infeasible</Badge>;
  return <Badge variant="success">Feasible</Badge>;
};

const DeltaValue = ({ label, value, unit = '', positiveGood = true }) => {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return (
      <div className="text-xs text-slate-400">
        <span className="font-medium text-slate-500">{label}:</span> —
      </div>
    );
  }
  const num = Number(value);
  const isPositive = num > 0;
  const isNeutral = Math.abs(num) < 1e-6;
  const isGood = isNeutral ? false : (positiveGood ? isPositive : !isPositive);
  const colourClass = isNeutral
    ? 'text-slate-500'
    : isGood
      ? 'text-emerald-600 dark:text-emerald-400'
      : 'text-red-600 dark:text-red-400';

  const prefix = isPositive ? '+' : '';
  const display = unit === '%'
    ? `${prefix}${(num * 100).toFixed(2)}${unit}`
    : `${prefix}${num.toFixed(4)}${unit}`;

  return (
    <div className="text-xs">
      <span className="font-medium text-slate-500">{label}:</span>{' '}
      <span className={`font-semibold ${colourClass}`}>{display}</span>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Option Card
// ---------------------------------------------------------------------------

const OptionCard = ({ option, evalResult, isRecommended, onApply }) => {
  const [expanded, setExpanded] = useState(false);

  const status = evalResult?.status;
  const feasible = evalResult?.kpis?.scenario?.feasible;
  const delta = evalResult?.kpis?.delta || {};
  const notes = evalResult?.notes || [];
  const evidenceRefs = evalResult?.evidence_refs || option.evidence_refs || [];

  return (
    <div
      className={`rounded-lg border p-4 transition-colors ${
        isRecommended
          ? 'border-blue-400 bg-blue-50/50 dark:border-blue-500/50 dark:bg-blue-900/10'
          : 'border-slate-200 bg-white dark:border-slate-700/60 dark:bg-slate-800/40'
      }`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2 min-w-0">
          <span className="text-xs font-mono text-slate-400 mt-0.5 shrink-0">
            {option.option_id}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium text-slate-800 dark:text-slate-200">
                {option.title}
              </span>
              {isRecommended && (
                <Badge variant="info">Recommended</Badge>
              )}
            </div>
            <div className="mt-1">
              <FeasibilityBadge status={status} feasible={feasible} />
            </div>
          </div>
        </div>
        {onApply && (
          <button
            onClick={() => onApply(option, evalResult)}
            className="shrink-0 px-3 py-1.5 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors"
          >
            Apply
          </button>
        )}
      </div>

      {/* Delta KPIs */}
      {evalResult && (
        <div className="mt-3 grid grid-cols-3 gap-x-4 gap-y-1">
          <DeltaValue
            label="Service Δ"
            value={delta.service_level_proxy}
            unit="%"
            positiveGood
          />
          <DeltaValue
            label="Stockout Δ"
            value={delta.stockout_units}
            positiveGood={false}
          />
          <DeltaValue
            label="Cost Δ"
            value={delta.estimated_total_cost}
            positiveGood={false}
          />
        </div>
      )}

      {/* Expand / collapse why + evidence */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="mt-3 flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="w-3 h-3" />
        ) : (
          <ChevronRight className="w-3 h-3" />
        )}
        Details & evidence
      </button>

      {expanded && (
        <div className="mt-2 space-y-2 text-xs text-slate-600 dark:text-slate-400">
          {Array.isArray(option.why) && option.why.length > 0 && (
            <div>
              <div className="font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Why:
              </div>
              <ul className="space-y-0.5 list-disc list-inside">
                {option.why.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          {evidenceRefs.length > 0 && (
            <div>
              <div className="font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Evidence refs:
              </div>
              <ul className="space-y-0.5">
                {evidenceRefs.map((ref, i) => (
                  <li key={i} className="font-mono text-slate-400">{ref}</li>
                ))}
              </ul>
            </div>
          )}
          {notes.length > 0 && (
            <div>
              <div className="font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Notes:
              </div>
              <ul className="space-y-0.5 list-disc list-inside">
                {notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main NegotiationPanel
// ---------------------------------------------------------------------------

/**
 * NegotiationPanel
 *
 * Props:
 *   planRunId          {number}   - plan child run ID
 *   trigger            {string}   - 'infeasible' | 'kpi_shortfall'
 *   isGenerating       {boolean}  - true while runNegotiation in flight
 *   negotiationOptions {Object}   - negotiation_options artifact payload
 *   negotiationEval    {Object}   - negotiation_evaluation artifact payload
 *   negotiationReport  {Object}   - negotiation_report artifact payload
 *   onGenerateOptions  {Function} - () => void  – triggers runNegotiation
 *   onApplyOption      {Function} - (option, evalResult) => void
 */
export default function NegotiationPanel({
  planRunId,
  trigger,
  isGenerating = false,
  negotiationOptions = null,
  negotiationEval = null,
  negotiationReport = null,
  onGenerateOptions,
  onApplyOption
}) {
  const [showExplain, setShowExplain] = useState(false);

  const rankedOptions = negotiationEval?.ranked_options || [];
  const optionDefs = negotiationOptions?.options || [];
  const recommendedId = negotiationReport?.recommended_option_id;

  // Build lookup: option_id → eval result
  const evalByOptionId = Object.fromEntries(
    rankedOptions.map((r) => [r.option_id, r])
  );

  const triggerLabel =
    trigger === 'infeasible'
      ? 'Solver returned INFEASIBLE'
      : 'KPI shortfall detected';

  const triggerIcon =
    trigger === 'infeasible' ? (
      <XCircle className="w-4 h-4 text-red-500 shrink-0" />
    ) : (
      <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
    );

  return (
    <div className="rounded-xl border border-amber-300 dark:border-amber-600/50 bg-amber-50/40 dark:bg-amber-900/10 p-4 space-y-4">
      {/* ---- Header ---- */}
      <div className="flex items-center gap-2">
        {triggerIcon}
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">
            Resolve / Improve Plan
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            {triggerLabel}
            {planRunId ? ` · Run #${planRunId}` : ''}
          </div>
        </div>
      </div>

      {/* ---- Generate button (before options exist) ---- */}
      {!negotiationOptions && (
        <button
          onClick={onGenerateOptions}
          disabled={isGenerating || !onGenerateOptions}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-600 disabled:opacity-60 text-white text-sm font-medium transition-colors"
        >
          {isGenerating ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Zap className="w-4 h-4" />
          )}
          {isGenerating ? 'Generating options…' : 'Generate Options'}
        </button>
      )}

      {/* ---- Options list ---- */}
      {negotiationOptions && optionDefs.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-xs font-semibold text-slate-600 dark:text-slate-300 uppercase tracking-wide">
              Candidate Options
              {rankedOptions.length > 0 && (
                <span className="ml-2 normal-case font-normal text-slate-400">
                  (ranked by: {negotiationEval.ranking_method?.split(':')[0]?.trim()})
                </span>
              )}
            </div>
            {isGenerating && (
              <div className="flex items-center gap-1 text-xs text-slate-400">
                <Loader2 className="w-3 h-3 animate-spin" />
                Evaluating…
              </div>
            )}
          </div>

          {/* Show options in rank order if evaluated, else in generation order */}
          {(rankedOptions.length > 0 ? rankedOptions : optionDefs).map((item) => {
            const optionId = item.option_id;
            const optDef = optionDefs.find((o) => o.option_id === optionId) || item;
            const evalResult = evalByOptionId[optionId] || null;

            return (
              <OptionCard
                key={optionId}
                option={optDef}
                evalResult={evalResult}
                isRecommended={optionId === recommendedId}
                onApply={onApplyOption}
              />
            );
          })}
        </div>
      )}

      {/* ---- LLM Explanation Toggle ---- */}
      {negotiationReport && (
        <div className="border-t border-amber-200 dark:border-amber-700/40 pt-3">
          <button
            onClick={() => setShowExplain((v) => !v)}
            className="flex items-center gap-2 text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
          >
            <BookOpen className="w-3.5 h-3.5" />
            {showExplain ? 'Hide' : 'Explain'} negotiation narrative
            {showExplain ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
          </button>

          {showExplain && (
            <div className="mt-3 space-y-2 text-xs text-slate-700 dark:text-slate-300">
              <div className="font-semibold text-slate-800 dark:text-slate-200">
                Summary
              </div>
              <p className="leading-relaxed">{negotiationReport.summary}</p>

              {Array.isArray(negotiationReport.bullet_reasons) &&
                negotiationReport.bullet_reasons.length > 0 && (
                  <div>
                    <div className="font-semibold text-slate-800 dark:text-slate-200 mb-1">
                      Key points
                    </div>
                    <ul className="space-y-1 list-disc list-inside">
                      {negotiationReport.bullet_reasons.map((reason, i) => (
                        <li key={i}>{reason}</li>
                      ))}
                    </ul>
                  </div>
                )}

              <div className="flex items-center gap-1.5 mt-2">
                {negotiationReport.evidence_validated ? (
                  <>
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                    <span className="text-emerald-600 dark:text-emerald-400">
                      Numbers validated against computed evidence
                    </span>
                  </>
                ) : (
                  <>
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                    <span className="text-amber-600 dark:text-amber-400">
                      Rule-based fallback (no LLM numbers)
                    </span>
                  </>
                )}
                {negotiationReport.generated_by && (
                  <span className="text-slate-400 ml-1">
                    · {negotiationReport.generated_by}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ---- Empty state (generated but no options) ---- */}
      {negotiationOptions && optionDefs.length === 0 && (
        <div className="text-xs text-slate-500 dark:text-slate-400 italic">
          No relaxation options could be generated for this evidence set.
        </div>
      )}
    </div>
  );
}
