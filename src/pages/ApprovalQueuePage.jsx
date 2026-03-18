/**
 * ApprovalQueuePage — Standalone manager approval queue
 *
 * Dedicated page for managers to review, approve, reject, and escalate
 * all pending governance items across all workers and tasks.
 */

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import {
  listPending,
  approveItem,
  rejectItem,
  escalateItem,
  getGovernanceStats,
  checkEscalations,
  GOVERNANCE_TYPES,
  GOVERNANCE_STATUS,
  ESCALATION_REASONS,
} from '../services/governanceService';
import {
  CheckCircle, XCircle, AlertTriangle, Clock, Shield,
  ChevronDown, ChevronUp, Filter, RefreshCw, ArrowUpRight,
} from 'lucide-react';

// ── Type Display Config ──────────────────────────────────────────────────────

const TYPE_META = {
  plan_approval:    { label: 'Plan Approval',    color: 'blue',   icon: Shield },
  step_approval:    { label: 'Step Approval',    color: 'indigo', icon: CheckCircle },
  output_approval:  { label: 'Output Review',    color: 'green',  icon: CheckCircle },
  revision_request: { label: 'Revision',         color: 'amber',  icon: AlertTriangle },
  risk_replan:      { label: 'Risk Re-plan',     color: 'red',    icon: AlertTriangle },
  closed_loop:      { label: 'Closed Loop',      color: 'purple', icon: RefreshCw },
  model_promotion:  { label: 'Model Promotion',  color: 'teal',   icon: ArrowUpRight },
};

const URGENCY_COLORS = {
  critical: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  high:     'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
  normal:   'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  low:      'bg-gray-50 text-gray-500 dark:bg-gray-900 dark:text-gray-400',
};

export default function ApprovalQueuePage() {
  const { user } = useAuth();
  const [items, setItems] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filterType, setFilterType] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);
  const [comment, setComment] = useState('');

  const userId = user?.id;

  // ── Load Data ────────────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const [pendingItems, govStats] = await Promise.all([
        listPending(userId, { type: filterType }),
        getGovernanceStats(userId),
      ]);
      setItems(pendingItems);
      setStats(govStats);
    } catch (err) {
      console.error('[ApprovalQueue] Load failed:', err);
    } finally {
      setLoading(false);
    }
  }, [userId, filterType]);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Auto-check escalations on mount ──
  useEffect(() => {
    if (!userId) return;
    checkEscalations(userId).catch(() => {});
  }, [userId]);

  // ── Actions ──────────────────────────────────────────────────────────────

  async function handleApprove(itemId) {
    setActionLoading(itemId);
    try {
      await approveItem(itemId, userId, comment || 'Approved');
      setComment('');
      setExpandedId(null);
      await loadData();
    } finally {
      setActionLoading(null);
    }
  }

  async function handleReject(itemId) {
    if (!comment.trim()) {
      alert('Please provide a reason for rejection.');
      return;
    }
    setActionLoading(itemId);
    try {
      await rejectItem(itemId, userId, comment);
      setComment('');
      setExpandedId(null);
      await loadData();
    } finally {
      setActionLoading(null);
    }
  }

  async function handleEscalate(itemId) {
    setActionLoading(itemId);
    try {
      await escalateItem(itemId, ESCALATION_REASONS.MANUAL, comment || 'Manually escalated');
      setComment('');
      setExpandedId(null);
      await loadData();
    } finally {
      setActionLoading(null);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
            Approval Queue
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            Review and approve pending governance items
          </p>
        </div>
        <button
          onClick={loadData}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors hover:bg-[var(--surface-subtle)]"
          style={{ color: 'var(--text-secondary)' }}
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Stats Bar */}
      {stats && (
        <div className="grid grid-cols-5 gap-3 mb-6">
          {[
            { label: 'Pending', value: stats.pending, color: 'text-amber-600' },
            { label: 'Approved', value: stats.approved, color: 'text-green-600' },
            { label: 'Rejected', value: stats.rejected, color: 'text-red-600' },
            { label: 'Escalated', value: stats.escalated, color: 'text-orange-600' },
            { label: 'Total', value: stats.total, color: 'text-[var(--text-primary)]' },
          ].map(({ label, value, color }) => (
            <div
              key={label}
              className="rounded-xl p-3 text-center"
              style={{ backgroundColor: 'var(--surface-card)', border: '1px solid var(--border-default)' }}
            >
              <div className={`text-2xl font-bold ${color}`}>{value}</div>
              <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Filter Bar */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <Filter className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
        <button
          onClick={() => setFilterType(null)}
          className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
            !filterType ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300' : 'bg-[var(--surface-subtle)] text-[var(--text-secondary)]'
          }`}
        >
          All
        </button>
        {Object.entries(GOVERNANCE_TYPES).map(([key, value]) => {
          const meta = TYPE_META[value] || {};
          return (
            <button
              key={key}
              onClick={() => setFilterType(value)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                filterType === value
                  ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300'
                  : 'bg-[var(--surface-subtle)] text-[var(--text-secondary)]'
              }`}
            >
              {meta.label || key}
            </button>
          );
        })}
      </div>

      {/* Items List */}
      {loading ? (
        <div className="text-center py-12" style={{ color: 'var(--text-muted)' }}>Loading...</div>
      ) : items.length === 0 ? (
        <div
          className="text-center py-12 rounded-xl"
          style={{ backgroundColor: 'var(--surface-card)', border: '1px solid var(--border-default)' }}
        >
          <CheckCircle className="w-10 h-10 mx-auto mb-3 text-green-500" />
          <p className="font-medium" style={{ color: 'var(--text-primary)' }}>All clear!</p>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>No pending items to review.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((item) => {
            const meta = TYPE_META[item.type] || { label: item.type, color: 'gray', icon: Shield };
            const TypeIcon = meta.icon;
            const isExpanded = expandedId === item.id;
            const isLoading = actionLoading === item.id;
            const timeLeft = item.escalation_at
              ? Math.max(0, new Date(item.escalation_at).getTime() - Date.now())
              : null;
            const hoursLeft = timeLeft != null ? Math.round(timeLeft / 3600000) : null;

            return (
              <div
                key={item.id}
                className="rounded-xl overflow-hidden transition-shadow hover:shadow-md"
                style={{ backgroundColor: 'var(--surface-card)', border: '1px solid var(--border-default)' }}
              >
                {/* Header row */}
                <button
                  onClick={() => setExpandedId(isExpanded ? null : item.id)}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left"
                >
                  <TypeIcon className={`w-5 h-5 flex-shrink-0 text-${meta.color}-500`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm truncate" style={{ color: 'var(--text-primary)' }}>
                        {item.title}
                      </span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${URGENCY_COLORS[item.urgency] || URGENCY_COLORS.normal}`}>
                        {item.urgency}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>
                      <span>{meta.label}</span>
                      {item.review_score != null && <span>Score: {item.review_score}</span>}
                      {hoursLeft != null && (
                        <span className={hoursLeft <= 1 ? 'text-red-500' : ''}>
                          <Clock className="w-3 h-3 inline mr-0.5" />
                          {hoursLeft}h until escalation
                        </span>
                      )}
                    </div>
                  </div>
                  {isExpanded ? <ChevronUp className="w-4 h-4 flex-shrink-0" /> : <ChevronDown className="w-4 h-4 flex-shrink-0" />}
                </button>

                {/* Expanded detail */}
                {isExpanded && (
                  <div className="px-4 pb-4 border-t" style={{ borderColor: 'var(--border-default)' }}>
                    {/* Description */}
                    {item.description && (
                      <p className="text-sm mt-3 mb-3" style={{ color: 'var(--text-secondary)' }}>
                        {item.description}
                      </p>
                    )}

                    {/* Payload preview */}
                    {item.payload && Object.keys(item.payload).length > 0 && (
                      <details className="mb-3">
                        <summary className="text-xs cursor-pointer" style={{ color: 'var(--text-muted)' }}>
                          View payload
                        </summary>
                        <pre
                          className="mt-1 p-2 rounded text-xs overflow-x-auto"
                          style={{ backgroundColor: 'var(--surface-subtle)', color: 'var(--text-secondary)' }}
                        >
                          {JSON.stringify(item.payload, null, 2)}
                        </pre>
                      </details>
                    )}

                    {/* Comment input */}
                    <textarea
                      value={comment}
                      onChange={(e) => setComment(e.target.value)}
                      placeholder="Add a comment (required for rejection)..."
                      rows={2}
                      className="w-full px-3 py-2 rounded-lg text-sm resize-none mb-3"
                      style={{
                        backgroundColor: 'var(--surface-subtle)',
                        color: 'var(--text-primary)',
                        border: '1px solid var(--border-default)',
                      }}
                    />

                    {/* Action buttons */}
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleApprove(item.id)}
                        disabled={isLoading}
                        className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium bg-green-600 text-white hover:bg-green-700 transition-colors disabled:opacity-50"
                      >
                        <CheckCircle className="w-4 h-4" />
                        Approve
                      </button>
                      <button
                        onClick={() => handleReject(item.id)}
                        disabled={isLoading}
                        className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-50"
                      >
                        <XCircle className="w-4 h-4" />
                        Reject
                      </button>
                      <button
                        onClick={() => handleEscalate(item.id)}
                        disabled={isLoading}
                        className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)] transition-colors disabled:opacity-50"
                        style={{ border: '1px solid var(--border-default)' }}
                      >
                        <ArrowUpRight className="w-4 h-4" />
                        Escalate
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
