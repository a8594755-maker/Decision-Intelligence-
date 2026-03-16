/**
 * UnifiedApprovalCard — renders approval requests for closed-loop, risk-replan,
 * and other approval types directly in the chat stream.
 *
 * Consumes the payload shape produced by approvalWorkflowService.buildUnifiedApprovalCard().
 *
 * Props:
 *   payload: { approval_id, approval_type, run_id, status, title, deadline,
 *              deadline_status, kpi_snapshot, decision_options }
 *   onDecision: (approvalId, decision) => void
 */

import { useState, useEffect } from 'react';
import {
  ShieldCheck, Clock, AlertTriangle, CheckCircle2,
  XCircle, ChevronDown, ChevronUp, Zap, Shield,
} from 'lucide-react';
import { Card, Button } from '../ui';

const TYPE_CONFIG = {
  closed_loop:     { label: 'Closed-Loop Rerun',   icon: Zap,         color: 'text-blue-600 dark:text-blue-400',    bg: 'bg-blue-100 dark:bg-blue-900/40' },
  risk_replan:     { label: 'Risk-Driven Replan',   icon: Shield,      color: 'text-amber-600 dark:text-amber-400',  bg: 'bg-amber-100 dark:bg-amber-900/40' },
  plan_commit:     { label: 'Plan Commit',          icon: ShieldCheck, color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-100 dark:bg-emerald-900/40' },
  negotiation:     { label: 'Negotiation',          icon: Shield,      color: 'text-purple-600 dark:text-purple-400', bg: 'bg-purple-100 dark:bg-purple-900/40' },
  model_promotion: { label: 'Model Promotion',      icon: ShieldCheck, color: 'text-indigo-600 dark:text-indigo-400', bg: 'bg-indigo-100 dark:bg-indigo-900/40' },
};

function formatTimeRemaining(deadline) {
  if (!deadline) return null;
  const remaining = new Date(deadline).getTime() - Date.now();
  if (remaining <= 0) return 'Expired';
  const hours = Math.floor(remaining / 3600000);
  const minutes = Math.floor((remaining % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${minutes}m remaining`;
  return `${minutes}m remaining`;
}

function DeadlineCountdown({ deadline }) {
  const [timeStr, setTimeStr] = useState(() => formatTimeRemaining(deadline));

  useEffect(() => {
    const interval = setInterval(() => {
      setTimeStr(formatTimeRemaining(deadline));
    }, 60000);
    return () => clearInterval(interval);
  }, [deadline]);

  if (!timeStr) return null;

  const isExpired = timeStr === 'Expired';
  const remaining = deadline ? new Date(deadline).getTime() - Date.now() : 0;
  const isUrgent = remaining > 0 && remaining <= 4 * 3600000;
  const isCritical = remaining > 0 && remaining <= 3600000;

  return (
    <div className={`flex items-center gap-1.5 text-xs font-medium ${
      isExpired ? 'text-slate-400' : isCritical ? 'text-red-600 animate-pulse' : isUrgent ? 'text-amber-600' : 'text-slate-500'
    }`}>
      <Clock className="w-3 h-3" />
      <span>{timeStr}</span>
    </div>
  );
}

export default function UnifiedApprovalCard({ payload, onDecision }) {
  const [expanded, setExpanded] = useState(false);
  const [decided, setDecided] = useState(false);
  const [chosenAction, setChosenAction] = useState(null);

  if (!payload) return null;

  const {
    approval_id,
    approval_type,
    run_id,
    status,
    title,
    deadline,
    deadline_status,
    kpi_snapshot,
    decision_options = ['approve', 'reject'],
  } = payload;

  const cfg = TYPE_CONFIG[approval_type] || TYPE_CONFIG.plan_commit;
  const TypeIcon = cfg.icon;
  const isResolved = status === 'approved' || status === 'rejected' || status === 'expired' || decided;

  const handleDecision = (decision) => {
    setDecided(true);
    setChosenAction(decision);
    onDecision?.(approval_id, decision);
  };

  const DECISION_STYLES = {
    approve:              { label: 'Approve',              icon: CheckCircle2, color: 'bg-emerald-600 hover:bg-emerald-700 text-white' },
    reject:               { label: 'Reject',               icon: XCircle,      color: 'bg-red-600 hover:bg-red-700 text-white' },
    approve_conservative: { label: 'Approve (Conservative)', icon: ShieldCheck, color: 'bg-amber-600 hover:bg-amber-700 text-white' },
  };

  return (
    <Card variant="elevated" className="!p-0 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b" style={{ borderColor: 'var(--border-default)' }}>
        <div className={`p-1.5 rounded-lg ${cfg.bg}`}>
          <TypeIcon className={`w-4 h-4 ${cfg.color}`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-[10px] font-bold uppercase tracking-wider ${cfg.color}`}>
              {cfg.label}
            </span>
            {status && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                status === 'approved' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                : status === 'rejected' ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
                : status === 'expired' ? 'bg-slate-100 text-slate-500'
                : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
              }`}>
                {decided ? chosenAction?.toUpperCase() : status.toUpperCase()}
              </span>
            )}
          </div>
          <p className="text-sm font-medium mt-0.5" style={{ color: 'var(--text-primary)' }}>
            {title || `Approval #${approval_id?.slice(0, 8)}`}
          </p>
        </div>
        <DeadlineCountdown deadline={deadline} />
      </div>

      {/* KPI Snapshot (if available) */}
      {kpi_snapshot && Object.keys(kpi_snapshot).length > 0 && (
        <div className="px-4 py-2.5 border-b" style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-subtle)' }}>
          <div className="flex flex-wrap gap-3">
            {Object.entries(kpi_snapshot).map(([key, val]) => (
              <div key={key} className="text-xs">
                <span className="text-slate-500">{key.replace(/_/g, ' ')}:</span>{' '}
                <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                  {typeof val === 'number' ? val.toLocaleString() : String(val)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Run ID & expand toggle */}
      {run_id && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center gap-2 px-4 py-2 text-xs hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors"
          style={{ color: 'var(--text-muted)' }}
        >
          <span>Run #{run_id}</span>
          <span className="ml-auto">{expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}</span>
        </button>
      )}

      {expanded && (
        <div className="px-4 py-2 text-xs space-y-1" style={{ backgroundColor: 'var(--surface-subtle)' }}>
          <div><span className="text-slate-500">Approval ID:</span> {approval_id}</div>
          <div><span className="text-slate-500">Type:</span> {approval_type}</div>
          {deadline && <div><span className="text-slate-500">Deadline:</span> {new Date(deadline).toLocaleString()}</div>}
          {deadline_status && (
            <div className="flex gap-3">
              {deadline_status.is_expired && <span className="text-red-500">EXPIRED</span>}
              {deadline_status.is_critical && !deadline_status.is_expired && <span className="text-red-500">CRITICAL</span>}
              {deadline_status.is_urgent && !deadline_status.is_critical && <span className="text-amber-500">URGENT</span>}
            </div>
          )}
        </div>
      )}

      {/* Decision Buttons */}
      {!isResolved && (
        <div className="flex items-center gap-2 px-4 py-3">
          {decision_options.map((option) => {
            // Support both string and object forms of decision_options
            const optionKey = typeof option === 'string' ? option : option.action || option.id;
            const style = DECISION_STYLES[optionKey] || DECISION_STYLES.approve;
            const BtnIcon = style.icon;
            const label = typeof option === 'object' && option.label ? option.label : style.label;
            return (
              <button
                key={optionKey}
                onClick={() => handleDecision(optionKey)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${style.color}`}
              >
                <BtnIcon className="w-3.5 h-3.5" />
                {label}
              </button>
            );
          })}
        </div>
      )}

      {/* Resolved state */}
      {isResolved && (
        <div className="px-4 py-2.5 text-xs flex items-center gap-2" style={{ color: 'var(--text-muted)' }}>
          {(chosenAction || status) === 'approved' || chosenAction === 'approve' || chosenAction === 'approve_conservative'
            ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
            : status === 'expired'
              ? <AlertTriangle className="w-3.5 h-3.5 text-slate-400" />
              : <XCircle className="w-3.5 h-3.5 text-red-500" />
          }
          <span>
            {decided
              ? `You chose: ${DECISION_STYLES[chosenAction]?.label || chosenAction}`
              : `Status: ${status}`
            }
          </span>
        </div>
      )}
    </Card>
  );
}
