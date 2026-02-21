/**
 * RiskTriggerNotificationCard.jsx
 *
 * Chat inline card: displays closed-loop risk trigger results (Gap 8C).
 *
 * Shown when: closed_loop.triggered = true (from workflowAEngine optimize step)
 *
 * Props:
 *   payload: {
 *     closed_loop_status: 'TRIGGERED_DRY_RUN' | 'RERUN_COMPLETED' | 'NO_TRIGGER'
 *     trigger_decision: { should_trigger, reasons[] }
 *     param_patch: { patch, explanation[], rules[] }
 *     planning_run_id: number | null
 *     requires_approval: boolean
 *   }
 *   onApproveReplan?: (paramPatch) => void
 *   onDismiss?: () => void
 */

import React, { useState } from 'react';
import { Card, Badge } from '../ui';

// ── Trigger type labels ───────────────────────────────────────────────────────

const TRIGGER_LABELS = {
  coverage_outside_band:  'Forecast Coverage',
  uncertainty_widens:     'Uncertainty Shift',
  p50_shift:              'Demand Shift',
  risk_severity_crossed:  'Supplier Risk',
};

// ── ParamChangePill ───────────────────────────────────────────────────────────

function ParamChangePill({ label, before, after, highlight = false }) {
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md
      ${highlight
        ? 'bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-700'
        : 'bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700'}`}>
      <span className="font-mono font-medium text-slate-600 dark:text-slate-300">
        {label}
      </span>
      {before != null && (
        <>
          <span className="text-slate-400 line-through text-[10px]">{String(before)}</span>
          <span className="text-slate-400">&rarr;</span>
        </>
      )}
      <span className={`font-semibold ${highlight ? 'text-orange-700 dark:text-orange-300' : 'text-slate-700 dark:text-slate-200'}`}>
        {String(after)}
      </span>
    </span>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

export default function RiskTriggerNotificationCard({
  payload,
  onApproveReplan,
  onDismiss,
}) {
  const [showDetails, setShowDetails] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  if (!payload || dismissed) return null;

  const {
    closed_loop_status,
    trigger_decision,
    param_patch,
    planning_run_id,
    requires_approval = false,
  } = payload;

  const isTriggered = trigger_decision?.should_trigger === true;
  const isRerun     = closed_loop_status === 'RERUN_COMPLETED';
  const isDryRun    = closed_loop_status === 'TRIGGERED_DRY_RUN';
  const noTrigger   = closed_loop_status === 'NO_TRIGGER';

  if (noTrigger || !isTriggered) return null;

  const triggerReasons = trigger_decision?.reasons || [];
  const explanation    = param_patch?.explanation || [];
  const patch          = param_patch?.patch || {};

  // Build param changes display
  const paramChanges = [];
  if (patch.safety_stock_alpha != null) {
    paramChanges.push({
      label: 'safety_stock_alpha',
      before: null,
      after: patch.safety_stock_alpha,
      highlight: patch.safety_stock_alpha > 0.5,
    });
  }
  if (patch.objective?.stockout_penalty != null) {
    paramChanges.push({
      label: 'stockout_penalty',
      before: patch.objective.stockout_penalty_base,
      after: patch.objective.stockout_penalty,
      highlight: true,
    });
  }

  const leadTimeEntries = Object.entries(patch.lead_time_buffer_by_key || {});
  if (leadTimeEntries.length > 0) {
    paramChanges.push({
      label: `lead_time_buffer (${leadTimeEntries.length} SKU)`,
      before: null,
      after: `+${leadTimeEntries[0]?.[1] ?? '?'}d`,
      highlight: true,
    });
  }

  const handleApprove = async () => {
    if (!onApproveReplan) return;
    setIsApproving(true);
    try {
      await onApproveReplan(param_patch);
    } finally {
      setIsApproving(false);
    }
  };

  const handleDismiss = () => {
    setDismissed(true);
    onDismiss?.();
  };

  // Status config
  const statusConfig = isRerun
    ? { label: 'Auto-Replanned',  badgeType: 'success', border: 'border-emerald-200 dark:border-emerald-700' }
    : requires_approval
      ? { label: 'Needs Approval', badgeType: 'warning', border: 'border-orange-200 dark:border-orange-700' }
      : { label: 'Dry Run',       badgeType: 'info',    border: 'border-blue-200 dark:border-blue-700' };

  return (
    <Card className={`w-full border ${statusConfig.border}`}>
      <div className="space-y-3">

        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div>
            <h4 className="font-semibold text-sm text-slate-800 dark:text-slate-100">
              Risk Trigger Detected
            </h4>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              {triggerReasons.length} trigger condition{triggerReasons.length !== 1 ? 's' : ''} fired
              {isRerun && planning_run_id && ` · Replanned (run #${planning_run_id})`}
            </p>
          </div>
          <Badge type={statusConfig.badgeType}>{statusConfig.label}</Badge>
        </div>

        {/* Trigger reasons */}
        <div className="space-y-1">
          {triggerReasons.slice(0, 4).map((reason, i) => (
            <div key={i} className="flex items-start gap-2 text-xs">
              <span className="font-medium text-slate-700 dark:text-slate-200">
                {TRIGGER_LABELS[reason.trigger_type] || reason.trigger_type}
              </span>
              {reason.detail && (
                <span className="text-slate-500 dark:text-slate-400">— {reason.detail}</span>
              )}
              {reason.severity && (
                <Badge
                  type={reason.severity === 'high' ? 'danger' : 'info'}
                  className="ml-auto text-[9px] px-1 py-0 shrink-0"
                >
                  {reason.severity}
                </Badge>
              )}
            </div>
          ))}
        </div>

        {/* Param changes */}
        {paramChanges.length > 0 && (
          <div>
            <p className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-1.5">
              Parameter Adjustments
            </p>
            <div className="flex flex-wrap gap-1.5">
              {paramChanges.map((p, i) => (
                <ParamChangePill key={i} {...p} />
              ))}
            </div>
          </div>
        )}

        {/* Explanation details (collapsible) */}
        {explanation.length > 0 && (
          <div>
            <button
              onClick={() => setShowDetails((v) => !v)}
              className="text-[11px] text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
            >
              {showDetails ? 'Hide' : 'Show'} policy rules ({explanation.length})
            </button>
            {showDetails && (
              <div className="mt-2 space-y-1">
                {explanation.map((exp, i) => (
                  <p key={i} className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                    &bull; {exp}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Action buttons */}
        {isDryRun && !isRerun && (
          <div className="flex items-center gap-2 pt-1 border-t border-slate-100 dark:border-slate-700">
            {onApproveReplan && (
              <button
                onClick={handleApprove}
                disabled={isApproving}
                className="text-xs font-medium py-1.5 px-3 rounded-md bg-amber-600 hover:bg-amber-700 disabled:opacity-60 text-white transition-colors"
              >
                {isApproving ? 'Replanning...' : 'Approve & Replan'}
              </button>
            )}
            <button
              onClick={handleDismiss}
              className="text-xs text-slate-500 hover:text-slate-700 transition-colors"
            >
              Keep Current Plan
            </button>
          </div>
        )}

        {isRerun && (
          <div className="text-xs text-emerald-600 dark:text-emerald-400 pt-1 border-t border-slate-100 dark:border-slate-700">
            Plan automatically updated with risk-adjusted parameters.
          </div>
        )}

      </div>
    </Card>
  );
}
