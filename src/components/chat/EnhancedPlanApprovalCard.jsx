/**
 * EnhancedPlanApprovalCard.jsx
 *
 * Extended plan approval card with:
 * - Live deadline countdown
 * - Batch approve/reject when multiple pending
 * - Collapsible audit trail
 * - Urgency indicators
 */

import React, { useState, useEffect } from 'react';
import { ShieldCheck, Clock, AlertTriangle, ChevronDown, ChevronUp, CheckCircle2, XCircle } from 'lucide-react';
import Card from '../ui/Card';
import Badge from '../ui/Badge';
import Button from '../ui/Button';

function formatTimeRemaining(minutesRemaining) {
  if (minutesRemaining == null || minutesRemaining <= 0) return 'Expired';
  if (minutesRemaining < 60) return `${Math.round(minutesRemaining)}m`;
  const hours = Math.floor(minutesRemaining / 60);
  const mins = Math.round(minutesRemaining % 60);
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

function DeadlineCountdown({ deadline, isUrgent, isCritical, isExpired }) {
  const [remaining, setRemaining] = useState(null);

  useEffect(() => {
    if (!deadline) return;

    const update = () => {
      const ms = new Date(deadline).getTime() - Date.now();
      setRemaining(Math.max(0, ms / (1000 * 60)));
    };
    update();

    const interval = setInterval(update, 60 * 1000); // update every minute
    return () => clearInterval(interval);
  }, [deadline]);

  if (!deadline) return null;

  const color = isExpired
    ? 'text-red-600 dark:text-red-400'
    : isCritical
    ? 'text-red-500 dark:text-red-400'
    : isUrgent
    ? 'text-amber-500 dark:text-amber-400'
    : 'text-[var(--text-muted)]';

  return (
    <div className={`flex items-center gap-1 text-xs font-medium ${color}`}>
      <Clock className="w-3.5 h-3.5" />
      {isExpired ? (
        <span>Deadline passed</span>
      ) : (
        <span>{formatTimeRemaining(remaining)} remaining</span>
      )}
    </div>
  );
}

export default function EnhancedPlanApprovalCard({
  payload,
  onApprove,
  onReject,
  onBatchApprove,
  _onBatchReject,
  onReviewIndividually,
}) {
  const [showAuditTrail, setShowAuditTrail] = useState(false);

  if (!payload) return null;

  const {
    approval,
    summary_text,
    deadline,
    is_urgent,
    is_critical,
    is_expired,
    batch_context,
    audit_trail = [],
  } = payload;

  const isPending = approval?.status === 'PENDING';

  return (
    <Card category="plan" className={`
      ${is_critical || is_expired
        ? 'border-red-300 dark:border-red-800 bg-red-50/60 dark:bg-red-900/10'
        : is_urgent
        ? 'border-amber-300 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-900/10'
        : 'border-blue-200 dark:border-blue-800 bg-blue-50/60 dark:bg-blue-900/10'
      }
    `}>
      <div className="space-y-3">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <h4 className="font-semibold text-sm flex items-center gap-2">
              <ShieldCheck className={`w-4 h-4 ${
                is_critical || is_expired ? 'text-red-600' : is_urgent ? 'text-amber-600' : 'text-blue-600'
              }`} />
              Plan Approval Required
            </h4>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5">
              Run #{approval?.run_id ?? '?'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge type={isPending ? 'warning' : approval?.status === 'APPROVED' ? 'success' : 'danger'}>
              {approval?.status || 'PENDING'}
            </Badge>
            {is_critical && isPending && (
              <Badge type="danger">
                <AlertTriangle className="w-3 h-3 inline mr-0.5" />
                Critical
              </Badge>
            )}
            {is_urgent && !is_critical && isPending && (
              <Badge type="warning">
                <AlertTriangle className="w-3 h-3 inline mr-0.5" />
                Urgent
              </Badge>
            )}
          </div>
        </div>

        {/* Summary */}
        {summary_text && (
          <p className="text-sm text-[var(--text-secondary)]">{summary_text}</p>
        )}

        {/* Deadline Countdown */}
        {isPending && deadline && (
          <DeadlineCountdown
            deadline={deadline}
            isUrgent={is_urgent}
            isCritical={is_critical}
            isExpired={is_expired}
          />
        )}

        {/* Batch Context */}
        {batch_context && isPending && (
          <div className="bg-[var(--surface-subtle)] rounded-lg px-3 py-2 text-xs text-[var(--text-secondary)]">
            {batch_context.total_pending} approvals pending
            <span className="text-[var(--text-muted)] mx-1">|</span>
            Runs: {batch_context.run_ids?.join(', ')}
          </div>
        )}

        {/* Action Buttons */}
        {isPending && (
          <div className="flex flex-wrap items-center gap-2">
            {/* Individual actions */}
            <Button
              variant="success"
              size="sm"
              onClick={() => onApprove?.(approval?.approval_id)}
            >
              <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
              Approve
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => onReject?.(approval?.approval_id)}
            >
              <XCircle className="w-3.5 h-3.5 mr-1" />
              Reject
            </Button>

            {/* Batch actions */}
            {batch_context && (
              <>
                <div className="w-px h-6 bg-[var(--border-default)] mx-1" />
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => onBatchApprove?.(batch_context.approval_ids)}
                >
                  Approve All {batch_context.total_pending}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onReviewIndividually?.()}
                >
                  Review Individually
                </Button>
              </>
            )}
          </div>
        )}

        {/* Audit Trail */}
        {audit_trail.length > 0 && (
          <div>
            <button
              onClick={() => setShowAuditTrail(!showAuditTrail)}
              className="flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
            >
              {showAuditTrail ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              Audit Trail ({audit_trail.length})
            </button>
            {showAuditTrail && (
              <div className="mt-2 space-y-1.5 pl-3 border-l-2 border-[var(--border-default)]">
                {audit_trail.map((event, i) => (
                  <div key={i} className="text-xs text-[var(--text-secondary)]">
                    <span className="font-medium">{event.action}</span>
                    <span className="text-[var(--text-muted)]"> by </span>
                    <span>{event.actor || 'system'}</span>
                    <span className="text-[var(--text-muted)] ml-1">
                      {event.created_at ? new Date(event.created_at).toLocaleString() : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
