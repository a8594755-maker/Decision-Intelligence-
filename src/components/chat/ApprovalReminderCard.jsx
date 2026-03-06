/**
 * ApprovalReminderCard.jsx
 *
 * Lightweight reminder card injected into chat when an approval deadline approaches.
 * Provides quick approve button and link to scroll to the full approval card.
 */

import React from 'react';
import { Clock, CheckCircle2, ArrowDown } from 'lucide-react';
import Card from '../ui/Card';
import Badge from '../ui/Badge';
import Button from '../ui/Button';

export default function ApprovalReminderCard({
  payload,
  onQuickApprove,
  onGoToApproval,
  onDismiss,
}) {
  if (!payload) return null;

  const {
    approval_id,
    run_id,
    hours_remaining,
    deadline,
    narrative_summary,
    is_critical,
  } = payload;

  const urgencyColor = is_critical
    ? 'border-red-300 dark:border-red-800 bg-red-50/60 dark:bg-red-900/10'
    : 'border-amber-300 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-900/10';

  const iconColor = is_critical
    ? 'text-red-500'
    : 'text-amber-500';

  return (
    <Card className={urgencyColor}>
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <Clock className={`w-4 h-4 ${iconColor}`} />
            <div>
              <h4 className="font-semibold text-sm text-slate-800 dark:text-slate-200">
                Approval Reminder
              </h4>
              <p className="text-xs text-slate-600 dark:text-slate-400">
                Run #{run_id} — {hours_remaining != null ? `${hours_remaining}h remaining` : 'deadline approaching'}
              </p>
            </div>
          </div>
          <Badge type={is_critical ? 'danger' : 'warning'}>
            {is_critical ? 'Critical' : 'Reminder'}
          </Badge>
        </div>

        {narrative_summary && (
          <p className="text-xs text-slate-600 dark:text-slate-400 line-clamp-2">
            {narrative_summary}
          </p>
        )}

        <div className="flex items-center gap-2">
          <Button
            variant="success"
            size="sm"
            onClick={() => onQuickApprove?.(approval_id)}
          >
            <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
            Quick Approve
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onGoToApproval?.(approval_id)}
          >
            <ArrowDown className="w-3.5 h-3.5 mr-1" />
            View Details
          </Button>
          {onDismiss && (
            <button
              onClick={() => onDismiss?.(approval_id)}
              className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 ml-auto"
            >
              Dismiss
            </button>
          )}
        </div>
      </div>
    </Card>
  );
}
