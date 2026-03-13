// @product: ai-employee
import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, CheckCircle2, XCircle, RotateCcw, AlertTriangle, Clock, Loader2, FileText } from 'lucide-react';
import { Card } from '../components/ui';
import { useAuth } from '../contexts/AuthContext';
import * as aiEmployeeService from '../services/aiEmployeeService';

// ── Helpers ───────────────────────────────────────────────────────────────

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// ── Review action panel ───────────────────────────────────────────────────

function ReviewPanel({ item, onDecision, deciding }) {
  const [comment, setComment] = useState('');

  // Latest run for this task
  const runs = item.ai_employee_runs || [];
  const latestRun = runs[0] || null;

  const inputStyle = {
    borderColor: 'var(--border-default)',
    backgroundColor: 'var(--surface-bg)',
    color: 'var(--text-primary)',
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Task header */}
      <div>
        <h3 className="font-semibold text-base mb-1" style={{ color: 'var(--text-primary)' }}>
          {item.title}
        </h3>
        {item.description && (
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{item.description}</p>
        )}
        <div className="flex items-center gap-2 mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
          <span>Priority: <span className="capitalize font-medium">{item.priority}</span></span>
          <span>·</span>
          <span>Type: <span className="font-medium">{item.input_context?.workflow_type || '—'}</span></span>
          {item.due_at && (
            <>
              <span>·</span>
              <span>Due {fmtTime(item.due_at)}</span>
            </>
          )}
        </div>
      </div>

      {/* Run summary */}
      {latestRun && (
        <Card variant="elevated" className="!p-4">
          <p className="text-xs font-medium mb-2" style={{ color: 'var(--text-muted)' }}>
            RUN RESULT
          </p>
          <div className="flex items-start gap-2">
            {latestRun.status === 'succeeded'
              ? <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" />
              : <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
            }
            <div>
              <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
                {latestRun.summary || 'No summary available.'}
              </p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                Completed {fmtTime(latestRun.ended_at)} · {(latestRun.artifact_refs || []).length} artifact(s)
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* Comment textarea */}
      <div>
        <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
          Comment <span style={{ color: 'var(--text-muted)' }}>(required for revision / reject)</span>
        </label>
        <textarea
          className="w-full px-3 py-2 rounded-lg border text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500"
          style={inputStyle}
          rows={3}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Leave feedback or instructions for Aiden…"
          disabled={deciding}
        />
      </div>

      {/* Action buttons */}
      <div className="flex gap-2">
        <button
          onClick={() => onDecision(item, latestRun, 'approved', comment)}
          disabled={deciding}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors"
        >
          {deciding === 'approved'
            ? <Loader2 className="w-4 h-4 animate-spin" />
            : <CheckCircle2 className="w-4 h-4" />
          }
          Approve
        </button>

        <button
          onClick={() => {
            if (!comment.trim()) { alert('Please add a comment before requesting revision.'); return; }
            onDecision(item, latestRun, 'needs_revision', comment);
          }}
          disabled={deciding}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium border transition-colors hover:bg-[var(--surface-subtle)] disabled:opacity-50"
          style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
        >
          {deciding === 'needs_revision'
            ? <Loader2 className="w-4 h-4 animate-spin" />
            : <RotateCcw className="w-4 h-4" />
          }
          Needs Revision
        </button>

        <button
          onClick={() => {
            if (!comment.trim()) { alert('Please add a comment before rejecting.'); return; }
            onDecision(item, latestRun, 'rejected', comment);
          }}
          disabled={deciding}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium border border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-50 transition-colors"
        >
          {deciding === 'rejected'
            ? <Loader2 className="w-4 h-4 animate-spin" />
            : <XCircle className="w-4 h-4" />
          }
          Reject
        </button>
      </div>
    </div>
  );
}

// ── Queue list item ───────────────────────────────────────────────────────

function QueueItem({ item, isSelected, onClick }) {
  const runs = item.ai_employee_runs || [];
  const latestRun = runs[0];
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-3 rounded-lg transition-colors ${
        isSelected
          ? 'bg-indigo-50 dark:bg-indigo-900/20'
          : 'hover:bg-[var(--surface-subtle)]'
      }`}
    >
      <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
        {item.title}
      </p>
      <div className="flex items-center gap-1.5 mt-1">
        <span className="text-xs px-1.5 py-0.5 rounded-full text-indigo-600 bg-indigo-50 dark:bg-indigo-900/20 capitalize">
          {item.input_context?.workflow_type || 'task'}
        </span>
        {latestRun?.ended_at && (
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            · {fmtTime(latestRun.ended_at)}
          </span>
        )}
      </div>
    </button>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function EmployeeReviewPage() {
  const { user } = useAuth();

  const [items, setItems] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [deciding, setDeciding] = useState(null); // 'approved' | 'needs_revision' | 'rejected' | null
  const [toast, setToast] = useState(null);

  const selectedItem = items.find((i) => i.id === selectedId) || null;

  const loadQueue = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    try {
      const pending = await aiEmployeeService.listPendingReviews(user.id);
      setItems(pending);
      if (pending.length > 0 && !selectedId) setSelectedId(pending[0].id);
    } finally {
      setLoading(false);
    }
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadQueue(); }, [loadQueue]);

  function showToast(msg, type = 'success') {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }

  async function handleDecision(item, run, decision, comment) {
    if (!user?.id) return;
    setDeciding(decision);
    try {
      // 1. Create review record
      await aiEmployeeService.createReview(item.id, run?.id || null, {
        decision,
        comments: comment || null,
        created_by: user.id,
      });

      // 2. Update task status based on decision
      const nextStatus = decision === 'approved'
        ? 'done'
        : decision === 'needs_revision'
        ? 'in_progress'
        : 'blocked'; // rejected

      await aiEmployeeService.updateTaskStatus(item.id, nextStatus);

      // 3. Update employee status
      const empStatus = decision === 'approved'
        ? 'idle'
        : 'working'; // revision or blocked → working

      // Get employee id from the task via employee relationship
      const empId = item.employee_id || item.ai_employees?.id;
      if (empId) {
        await aiEmployeeService.updateEmployeeStatus(empId, empStatus);
      }

      // 4. Write worklog for the review decision
      if (empId) {
        await aiEmployeeService.appendWorklog(empId, item.id, run?.id || null, 'task_update', {
          previous_status: 'waiting_review',
          new_status: nextStatus,
          note: comment || `Manager ${decision}.`,
          review_decision: decision,
        });
      }

      showToast(
        decision === 'approved'
          ? 'Task approved and marked done.'
          : decision === 'needs_revision'
          ? 'Revision requested — task sent back to Aiden.'
          : 'Task rejected.',
        decision === 'approved' ? 'success' : 'warning'
      );

      // Remove from queue
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      setSelectedId(null);

    } catch (err) {
      showToast(`Error: ${err?.message || 'Something went wrong.'}`, 'error');
    } finally {
      setDeciding(null);
    }
  }

  return (
    <div className="h-full flex flex-col" style={{ backgroundColor: 'var(--surface-bg)' }}>
      {/* ── Header ── */}
      <div
        className="h-14 flex items-center justify-between px-4 flex-shrink-0 border-b"
        style={{ backgroundColor: 'var(--surface-card)', borderColor: 'var(--border-default)' }}
      >
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
            Review Queue
          </span>
          {!loading && items.length > 0 && (
            <span className="px-1.5 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">
              {items.length}
            </span>
          )}
        </div>
        <button
          onClick={loadQueue}
          className="p-1.5 rounded-lg transition-colors hover:bg-[var(--surface-subtle)]"
          title="Refresh"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} style={{ color: 'var(--text-muted)' }} />
        </button>
      </div>

      {/* ── Toast ── */}
      {toast && (
        <div
          className={`mx-6 mt-3 flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm ${
            toast.type === 'success' ? 'bg-emerald-50 text-emerald-700' :
            toast.type === 'warning' ? 'bg-amber-50 text-amber-700' :
            'bg-red-50 text-red-700'
          }`}
        >
          {toast.type === 'success'
            ? <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
            : <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          }
          {toast.msg}
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* ── Left: queue list ── */}
        <aside
          className="w-72 flex-shrink-0 flex flex-col border-r"
          style={{ borderColor: 'var(--border-default)' }}
        >
          <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-5 h-5 animate-spin text-indigo-400" />
              </div>
            ) : items.length === 0 ? (
              <div className="px-3 py-10 text-center">
                <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto mb-2" />
                <p className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                  All clear
                </p>
                <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                  No tasks waiting for review.
                </p>
              </div>
            ) : (
              items.map((item) => (
                <QueueItem
                  key={item.id}
                  item={item}
                  isSelected={item.id === selectedId}
                  onClick={() => setSelectedId(item.id)}
                />
              ))
            )}
          </div>
        </aside>

        {/* ── Right: review panel ── */}
        <main className="flex-1 overflow-y-auto p-6">
          {selectedItem ? (
            <ReviewPanel
              item={selectedItem}
              onDecision={handleDecision}
              deciding={deciding}
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full gap-2">
              <FileText className="w-8 h-8" style={{ color: 'var(--text-muted)' }} />
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                {items.length > 0 ? 'Select a task to review' : 'Nothing to review right now'}
              </p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
