/**
 * DelegationPanel.jsx — Multi-Worker Delegation UI (Phase 8)
 *
 * Displays delegation status for all three collaboration patterns:
 *   - Sequential Handoff chains (progress steps)
 *   - Parallel Fan-Out (worker grid + merge status)
 *   - Escalation (escalation badge + coordinator response)
 *
 * Props:
 *   delegations:    delegation[]
 *   chainStatuses:  { [chainId]: ChainStatus }
 *   fanOutStatuses: { [fanOutId]: FanOutStatus }
 *   onViewTask:     (taskId) => void
 *   onResolveEscalation: (delegationId, resolution) => void
 */

import { useState } from 'react';
import {
  ArrowRight, GitBranch, AlertTriangle, CheckCircle2,
  Clock, XCircle, Users, ChevronDown, ChevronUp,
  Zap, ArrowUpRight,
} from 'lucide-react';

// ── Status Badge ────────────────────────────────────────────────────────────

const STATUS_CONFIG = {
  pending:   { label: 'Pending',   icon: Clock,        color: 'text-slate-400',  bg: 'bg-slate-100 dark:bg-slate-800' },
  active:    { label: 'Active',    icon: Zap,           color: 'text-blue-600',   bg: 'bg-blue-100 dark:bg-blue-900/30' },
  completed: { label: 'Completed', icon: CheckCircle2,  color: 'text-emerald-600', bg: 'bg-emerald-100 dark:bg-emerald-900/30' },
  failed:    { label: 'Failed',    icon: XCircle,       color: 'text-red-600',    bg: 'bg-red-100 dark:bg-red-900/30' },
  cancelled: { label: 'Cancelled', icon: XCircle,       color: 'text-slate-400',  bg: 'bg-slate-100 dark:bg-slate-800' },
  skipped:   { label: 'Skipped',   icon: Clock,         color: 'text-slate-400',  bg: 'bg-slate-100 dark:bg-slate-800' },
};

function StatusBadge({ status }) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.pending;
  const Icon = config.icon;

  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${config.bg} ${config.color}`}>
      <Icon className="w-3 h-3" />
      {config.label}
    </span>
  );
}

// ── Type Badge ──────────────────────────────────────────────────────────────

const TYPE_CONFIG = {
  handoff:    { label: 'Handoff',    icon: ArrowRight,      color: 'text-indigo-600',  bg: 'bg-indigo-100 dark:bg-indigo-900/30' },
  fan_out:    { label: 'Fan-Out',    icon: GitBranch,       color: 'text-purple-600',  bg: 'bg-purple-100 dark:bg-purple-900/30' },
  escalation: { label: 'Escalation', icon: AlertTriangle,   color: 'text-amber-600',   bg: 'bg-amber-100 dark:bg-amber-900/30' },
};

function TypeBadge({ type }) {
  const config = TYPE_CONFIG[type] || TYPE_CONFIG.handoff;
  const Icon = config.icon;

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${config.bg} ${config.color}`}>
      <Icon className="w-3 h-3" />
      {config.label}
    </span>
  );
}

// ── Handoff Chain View ──────────────────────────────────────────────────────

function HandoffChainView({ chainStatus, onViewTask }) {
  if (!chainStatus) return null;

  const { delegations, total, completed, active_worker } = chainStatus;

  return (
    <div className="rounded-lg border border-indigo-200 dark:border-indigo-800 p-3">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <ArrowRight className="w-4 h-4 text-indigo-600" />
          <span className="text-xs font-medium text-slate-700 dark:text-slate-200">
            Sequential Handoff
          </span>
        </div>
        <span className="text-[10px] text-slate-500">
          {completed}/{total} steps
        </span>
      </div>

      {/* Step progress bar */}
      <div className="flex items-center gap-1 mb-3">
        {delegations.map((d, i) => (
          <div key={d.id} className="flex items-center flex-1">
            <div className={`flex-1 h-1.5 rounded-full ${
              d.status === 'completed' ? 'bg-emerald-500' :
              d.status === 'active' ? 'bg-blue-500 animate-pulse' :
              'bg-slate-200 dark:bg-slate-700'
            }`} />
            {i < delegations.length - 1 && (
              <ArrowRight className="w-3 h-3 text-slate-300 mx-0.5 flex-shrink-0" />
            )}
          </div>
        ))}
      </div>

      {/* Worker list */}
      <div className="space-y-1.5">
        {delegations.map((d) => (
          <div
            key={d.id}
            className={`flex items-center justify-between px-2 py-1.5 rounded text-xs ${
              d.status === 'active' ? 'bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800' :
              d.status === 'completed' ? 'bg-emerald-50/50 dark:bg-emerald-900/10' :
              'bg-slate-50 dark:bg-slate-800/50'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-slate-400 w-4">#{d.sequence_order + 1}</span>
              <span className="font-medium text-slate-700 dark:text-slate-200">
                {d.child_worker_id}
              </span>
            </div>
            <StatusBadge status={d.status} />
          </div>
        ))}
      </div>

      {active_worker && (
        <p className="text-[10px] text-blue-600 dark:text-blue-400 mt-2">
          Currently running: {active_worker}
        </p>
      )}
    </div>
  );
}

// ── Fan-Out View ────────────────────────────────────────────────────────────

function FanOutView({ fanOutStatus }) {
  if (!fanOutStatus) return null;

  const { delegations, total, completed, failed, in_progress } = fanOutStatus;

  return (
    <div className="rounded-lg border border-purple-200 dark:border-purple-800 p-3">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <GitBranch className="w-4 h-4 text-purple-600" />
          <span className="text-xs font-medium text-slate-700 dark:text-slate-200">
            Parallel Fan-Out
          </span>
        </div>
        <span className="text-[10px] text-slate-500">
          {completed}/{total} complete{failed > 0 ? `, ${failed} failed` : ''}
        </span>
      </div>

      {/* Worker grid */}
      <div className="grid grid-cols-2 gap-1.5">
        {delegations.map((d) => (
          <div
            key={d.id}
            className={`flex items-center justify-between px-2 py-1.5 rounded text-xs ${
              d.status === 'active' ? 'bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800' :
              d.status === 'completed' ? 'bg-emerald-50/50 dark:bg-emerald-900/10' :
              d.status === 'failed' ? 'bg-red-50/50 dark:bg-red-900/10' :
              'bg-slate-50 dark:bg-slate-800/50'
            }`}
          >
            <span className="font-medium text-slate-700 dark:text-slate-200 truncate">
              {d.child_worker_id}
            </span>
            <StatusBadge status={d.status} />
          </div>
        ))}
      </div>

      {in_progress > 0 && (
        <div className="mt-2 flex items-center gap-1 text-[10px] text-purple-600">
          <Clock className="w-3 h-3 animate-spin" />
          {in_progress} worker{in_progress > 1 ? 's' : ''} still running...
        </div>
      )}
    </div>
  );
}

// ── Escalation View ─────────────────────────────────────────────────────────

function EscalationView({ delegation, onResolve }) {
  const [showResolve, setShowResolve] = useState(false);
  const [instructions, setInstructions] = useState('');

  const reason = delegation?.context_json?.escalation_reason || 'Unknown reason';
  const isResolved = delegation?.status === 'completed';

  return (
    <div className={`rounded-lg border p-3 ${
      isResolved
        ? 'border-emerald-200 dark:border-emerald-800'
        : 'border-amber-200 dark:border-amber-800 bg-amber-50/30 dark:bg-amber-900/10'
    }`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <AlertTriangle className={`w-4 h-4 ${isResolved ? 'text-emerald-600' : 'text-amber-600'}`} />
          <span className="text-xs font-medium text-slate-700 dark:text-slate-200">
            Escalation
          </span>
        </div>
        <StatusBadge status={delegation?.status} />
      </div>

      <div className="text-xs text-slate-600 dark:text-slate-300 mb-2">
        <span className="text-slate-400">From:</span> {delegation?.parent_worker_id}
        <ArrowUpRight className="w-3 h-3 inline mx-1 text-amber-500" />
        <span className="text-slate-400">To:</span> {delegation?.child_worker_id}
      </div>

      <div className="text-xs text-amber-700 dark:text-amber-400 bg-amber-100/50 dark:bg-amber-900/20 rounded px-2 py-1 mb-2">
        {reason}
      </div>

      {isResolved && delegation.result_json && (
        <div className="text-xs text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 rounded px-2 py-1">
          Resolution: {delegation.result_json.decision || 'resolved'}
          {delegation.result_json.instructions && (
            <p className="text-slate-500 mt-1">{delegation.result_json.instructions}</p>
          )}
        </div>
      )}

      {!isResolved && onResolve && (
        <div className="mt-2">
          {!showResolve ? (
            <button
              onClick={() => setShowResolve(true)}
              className="text-[10px] text-amber-600 hover:text-amber-700 font-medium"
            >
              Resolve Escalation...
            </button>
          ) : (
            <div className="space-y-2">
              <textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder="Coordinator instructions..."
                className="w-full text-xs border border-slate-300 dark:border-slate-600 rounded px-2 py-1.5 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200"
                rows={2}
              />
              <div className="flex gap-1">
                <button
                  onClick={() => {
                    onResolve(delegation.id, { decision: 'override', instructions });
                    setShowResolve(false);
                  }}
                  className="px-2 py-1 rounded text-[10px] font-medium bg-amber-600 text-white hover:bg-amber-700"
                >
                  Override
                </button>
                <button
                  onClick={() => {
                    onResolve(delegation.id, { decision: 'confirm', instructions });
                    setShowResolve(false);
                  }}
                  className="px-2 py-1 rounded text-[10px] font-medium bg-emerald-600 text-white hover:bg-emerald-700"
                >
                  Confirm
                </button>
                <button
                  onClick={() => setShowResolve(false)}
                  className="px-2 py-1 rounded text-[10px] font-medium bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Delegation List Item ────────────────────────────────────────────────────

function DelegationRow({ delegation, onViewTask }) {
  return (
    <div className="flex items-center justify-between px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800/50">
      <div className="flex items-center gap-2">
        <TypeBadge type={delegation.delegation_type} />
        <div>
          <p className="text-xs font-medium text-slate-700 dark:text-slate-200">
            {delegation.parent_worker_id} → {delegation.child_worker_id}
          </p>
          <p className="text-[10px] text-slate-400">
            {delegation.delegation_type === 'handoff' && `Step ${delegation.sequence_order + 1}`}
            {delegation.delegation_type === 'escalation' && delegation.context_json?.escalation_reason}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <StatusBadge status={delegation.status} />
        {delegation.child_task_id && onViewTask && (
          <button
            onClick={() => onViewTask(delegation.child_task_id)}
            className="text-[10px] text-blue-600 hover:text-blue-700"
          >
            View
          </button>
        )}
      </div>
    </div>
  );
}

// ── Main Panel ──────────────────────────────────────────────────────────────

export default function DelegationPanel({
  delegations = [],
  chainStatuses = {},
  fanOutStatuses = {},
  onViewTask,
  onResolveEscalation,
}) {
  const [expanded, setExpanded] = useState(true);

  // Group delegations by type
  const escalations = delegations.filter(d => d.delegation_type === 'escalation');
  const chains = Object.values(chainStatuses);
  const fanOuts = Object.values(fanOutStatuses);

  const totalCount = delegations.length;
  const activeCount = delegations.filter(d => d.status === 'active').length;

  if (totalCount === 0) {
    return (
      <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-4 text-center">
        <Users className="w-6 h-6 text-slate-300 mx-auto mb-2" />
        <p className="text-xs text-slate-400">No active delegations</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2 border-b border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/50"
      >
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-slate-500" />
          <span className="text-xs font-medium text-slate-700 dark:text-slate-200">
            Worker Collaboration
          </span>
          {activeCount > 0 && (
            <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-600">
              {activeCount} active
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-slate-400">{totalCount} delegation{totalCount !== 1 ? 's' : ''}</span>
          {expanded ? <ChevronUp className="w-3 h-3 text-slate-400" /> : <ChevronDown className="w-3 h-3 text-slate-400" />}
        </div>
      </button>

      {expanded && (
        <div className="p-3 space-y-3">
          {/* Handoff Chains */}
          {chains.map((chain) => (
            <HandoffChainView
              key={chain.chain_id}
              chainStatus={chain}
              onViewTask={onViewTask}
            />
          ))}

          {/* Fan-Outs */}
          {fanOuts.map((fo) => (
            <FanOutView
              key={fo.fan_out_id}
              fanOutStatus={fo}
            />
          ))}

          {/* Escalations */}
          {escalations.map((esc) => (
            <EscalationView
              key={esc.id}
              delegation={esc}
              onResolve={onResolveEscalation}
            />
          ))}

          {/* Flat list for any ungrouped delegations */}
          {delegations.filter(d =>
            d.delegation_type !== 'escalation' &&
            !d.chain_id &&
            !d.fan_out_id
          ).length > 0 && (
            <div className="border-t border-slate-200 dark:border-slate-700 pt-2">
              <p className="text-[10px] text-slate-400 mb-1">Other Delegations</p>
              {delegations
                .filter(d => d.delegation_type !== 'escalation' && !d.chain_id && !d.fan_out_id)
                .map(d => <DelegationRow key={d.id} delegation={d} onViewTask={onViewTask} />)
              }
            </div>
          )}
        </div>
      )}
    </div>
  );
}
