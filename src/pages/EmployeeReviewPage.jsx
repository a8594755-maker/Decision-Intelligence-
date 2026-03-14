// @product: ai-employee
// ============================================
// Human Review Center — Artifacts + Revision Log + Approval
// Left:  Queue list (narrow)
// Center: Beautiful artifact viewer (data report)
// Right:  Revision log + review actions
// ============================================

import { useState, useEffect, useCallback } from 'react';
import {
  RefreshCw, CheckCircle2, XCircle, RotateCcw, AlertTriangle,
  Clock, Loader2, FileText, Eye, ChevronRight,
  BarChart3, Table2, Shield, Zap, ArrowRight,
} from 'lucide-react';
import { Card } from '../components/ui';
import { useAuth } from '../contexts/AuthContext';
import * as aiEmployeeService from '../services/aiEmployeeService';
import { approveStepAndContinue, reviseStepAndRetry } from '../services/agentLoopService';
import { attachFeedback } from '../services/aiEmployeeMemoryService';

// ── Helpers ───────────────────────────────────────────────────────────────

function fmtTime(iso) {
  if (!iso) return '\u2014';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function fmtRelative(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ── Artifact type config ──────────────────────────────────────────────────

const ARTIFACT_ICONS = {
  forecast_series: BarChart3,
  forecast_csv: BarChart3,
  plan_table: Table2,
  plan_csv: Table2,
  risk_plan_table: Table2,
  constraint_check: Shield,
  replay_metrics: Zap,
  inventory_projection: BarChart3,
  risk_adjustments: Shield,
  metrics: BarChart3,
  solver_meta: FileText,
  report_json: FileText,
};

const ARTIFACT_CATEGORIES = {
  forecast: ['forecast_series', 'forecast_csv', 'metrics'],
  plan: ['plan_table', 'plan_csv', 'solver_meta', 'constraint_check', 'replay_metrics', 'inventory_projection'],
  risk: ['risk_adjustments', 'risk_plan_table', 'risk_solver_meta', 'risk_replay_metrics', 'risk_inventory_projection'],
  report: ['report_json', 'evidence_pack'],
};

function categorizeArtifact(type) {
  for (const [cat, types] of Object.entries(ARTIFACT_CATEGORIES)) {
    if (types.includes(type)) return cat;
  }
  return 'other';
}

// ── Artifact Viewer (center panel) ────────────────────────────────────────

function ArtifactViewer({ item }) {
  const [selectedArtifact, setSelectedArtifact] = useState(null);
  const runs = item.ai_employee_runs || [];
  const latestRun = runs[0] || null;
  const artifactRefs = latestRun?.artifact_refs || [];

  // Group artifacts by category
  const grouped = {};
  for (const ref of artifactRefs) {
    const cat = categorizeArtifact(ref.type || ref.artifact_type);
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(ref);
  }

  const categoryLabels = { forecast: 'Forecast', plan: 'Plan', risk: 'Risk', report: 'Report', other: 'Other' };
  const categoryIcons = { forecast: BarChart3, plan: Table2, risk: Shield, report: FileText, other: FileText };

  return (
    <div className="h-full flex flex-col">
      {/* Task header */}
      <div className="px-5 py-4 border-b flex-shrink-0" style={{ borderColor: 'var(--border-default)' }}>
        <h2 className="font-semibold text-base" style={{ color: 'var(--text-primary)' }}>
          {item.title}
        </h2>
        {item.description && (
          <p className="text-sm mt-1 line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
            {item.description}
          </p>
        )}
        <div className="flex items-center gap-3 mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
          <span className="px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600 dark:bg-indigo-900/20 dark:text-indigo-400 font-medium capitalize">
            {item.input_context?.workflow_type || 'task'}
          </span>
          <span>Priority: <span className="capitalize font-medium">{item.priority}</span></span>
          {item.due_at && <span>Due {fmtTime(item.due_at)}</span>}
        </div>
      </div>

      {/* Run status banner */}
      {latestRun && (
        <div
          className="flex items-center gap-2 px-5 py-2.5 border-b text-sm"
          style={{
            borderColor: 'var(--border-default)',
            backgroundColor: latestRun.status === 'succeeded' ? 'rgba(16, 185, 129, 0.05)' : 'rgba(239, 68, 68, 0.05)',
          }}
        >
          {latestRun.status === 'succeeded'
            ? <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
            : <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0" />
          }
          <span style={{ color: 'var(--text-primary)' }}>
            {latestRun.summary || (latestRun.status === 'succeeded' ? 'Completed successfully' : 'Completed with issues')}
          </span>
          <span className="ml-auto text-xs" style={{ color: 'var(--text-muted)' }}>
            {fmtRelative(latestRun.ended_at)}
          </span>
        </div>
      )}

      {/* Artifact grid */}
      <div className="flex-1 overflow-y-auto p-5">
        {artifactRefs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2">
            <FileText className="w-10 h-10" style={{ color: 'var(--text-muted)' }} />
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No artifacts generated yet</p>
          </div>
        ) : (
          <div className="space-y-5">
            {Object.entries(grouped).map(([cat, artifacts]) => {
              const CatIcon = categoryIcons[cat] || FileText;
              return (
                <div key={cat}>
                  <div className="flex items-center gap-2 mb-3">
                    <CatIcon className="w-4 h-4 text-indigo-500" />
                    <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                      {categoryLabels[cat] || cat}
                    </span>
                    <span className="text-xs px-1.5 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800" style={{ color: 'var(--text-muted)' }}>
                      {artifacts.length}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {artifacts.map((ref, i) => {
                      const ArtIcon = ARTIFACT_ICONS[ref.type || ref.artifact_type] || FileText;
                      const isSelected = selectedArtifact === `${cat}-${i}`;
                      return (
                        <button
                          key={`${cat}-${i}`}
                          onClick={() => setSelectedArtifact(isSelected ? null : `${cat}-${i}`)}
                          className={`text-left p-4 rounded-xl border transition-all ${
                            isSelected
                              ? 'border-indigo-300 bg-indigo-50/50 dark:bg-indigo-900/10 shadow-sm'
                              : 'border-transparent hover:border-[var(--border-default)] hover:shadow-sm'
                          }`}
                          style={{
                            backgroundColor: isSelected ? undefined : 'var(--surface-subtle)',
                          }}
                        >
                          <div className="flex items-start gap-3">
                            <div className="w-9 h-9 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-center flex-shrink-0">
                              <ArtIcon className="w-4 h-4 text-indigo-500" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                                {ref.label || ref.type || ref.artifact_type}
                              </p>
                              {ref.run_id && (
                                <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                                  Run #{ref.run_id}
                                </p>
                              )}
                            </div>
                            <Eye className="w-3.5 h-3.5 flex-shrink-0 mt-1" style={{ color: 'var(--text-muted)' }} />
                          </div>

                          {/* Expanded preview */}
                          {isSelected && ref.data && (
                            <div className="mt-3 pt-3 border-t text-xs font-mono overflow-auto max-h-48 rounded" style={{ borderColor: 'var(--border-default)' }}>
                              <pre style={{ color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                                {typeof ref.data === 'string' ? ref.data : JSON.stringify(ref.data, null, 2).slice(0, 2000)}
                              </pre>
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Revision Log + Review Actions (right panel) ──────────────────────────

function RevisionLogPanel({ item, onDecision, deciding }) {
  const [comment, setComment] = useState('');
  const runs = item.ai_employee_runs || [];
  const loopSteps = item.loop_state?.steps || [];

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-4 py-3 border-b flex-shrink-0" style={{ borderColor: 'var(--border-default)' }}>
        <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
          Review & History
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* ── AI Self-Correction Log ── */}
        {loopSteps.length > 0 && (
          <div className="px-4 pt-4 pb-2">
            <div className="flex items-center gap-1.5 mb-3">
              <Zap className="w-3.5 h-3.5 text-amber-500" />
              <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                AI Processing Steps
              </span>
            </div>
            <div className="relative pl-4 border-l-2" style={{ borderColor: 'var(--border-default)' }}>
              {loopSteps.map((step, i) => {
                const isLast = i === loopSteps.length - 1;
                const retried = step.retry_count > 0;
                return (
                  <div key={step.name || i} className="relative pb-4 last:pb-0">
                    {/* Dot on timeline */}
                    <div
                      className={`absolute -left-[calc(0.5rem+1px)] top-1 w-3 h-3 rounded-full border-2 ${
                        step.status === 'done' ? 'bg-emerald-500 border-emerald-200' :
                        step.status === 'failed' ? 'bg-red-500 border-red-200' :
                        step.status === 'review_hold' ? 'bg-amber-500 border-amber-200' :
                        step.status === 'running' ? 'bg-blue-500 border-blue-200 animate-pulse' :
                        'bg-slate-300 border-slate-200'
                      }`}
                    />

                    <div className="ml-2">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium capitalize" style={{ color: 'var(--text-primary)' }}>
                          {step.name}
                        </span>
                        {retried && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">
                            {step.retry_count} retry
                          </span>
                        )}
                      </div>
                      {step.summary && (
                        <p className="text-xs mt-0.5 line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
                          {step.summary}
                        </p>
                      )}
                      {step.error && (
                        <p className="text-xs mt-0.5 text-red-500 line-clamp-2">
                          Error: {step.error}
                        </p>
                      )}
                      {retried && (
                        <p className="text-[10px] mt-1 italic" style={{ color: 'var(--text-muted)' }}>
                          AI self-corrected {step.retry_count} time{step.retry_count > 1 ? 's' : ''} before succeeding
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Run History ── */}
        {runs.length > 1 && (
          <div className="px-4 pt-3 pb-2">
            <div className="flex items-center gap-1.5 mb-2">
              <Clock className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />
              <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                Run History
              </span>
            </div>
            {runs.slice(0, 5).map((run, i) => (
              <div key={run.id || i} className="flex items-center gap-2 py-1.5 text-xs">
                {run.status === 'succeeded'
                  ? <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                  : <XCircle className="w-3 h-3 text-red-500" />
                }
                <span style={{ color: 'var(--text-secondary)' }}>
                  {run.summary?.slice(0, 60) || run.status}
                </span>
                <span className="ml-auto" style={{ color: 'var(--text-muted)' }}>
                  {fmtRelative(run.ended_at)}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Separator */}
        <div className="mx-4 my-2 border-t" style={{ borderColor: 'var(--border-default)' }} />

        {/* ── Review Actions ── */}
        <div className="px-4 pt-2 pb-4">
          <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
            Your Decision
          </span>

          <textarea
            className="w-full mt-3 px-3 py-2.5 rounded-xl border text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500"
            style={{
              borderColor: 'var(--border-default)',
              backgroundColor: 'var(--surface-bg)',
              color: 'var(--text-primary)',
            }}
            rows={3}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Leave feedback for Aiden..."
            disabled={deciding}
          />

          <div className="flex flex-col gap-2 mt-3">
            <button
              onClick={() => onDecision(item, runs[0], 'approved', comment)}
              disabled={deciding}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white transition-all disabled:opacity-50"
              style={{
                background: 'linear-gradient(135deg, #059669 0%, #10b981 100%)',
                boxShadow: deciding ? 'none' : '0 2px 8px rgba(5, 150, 105, 0.3)',
              }}
            >
              {deciding === 'approved'
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : <CheckCircle2 className="w-4 h-4" />
              }
              Approve
            </button>

            <div className="flex gap-2">
              <button
                onClick={() => {
                  if (!comment.trim()) { alert('Please add a comment before requesting revision.'); return; }
                  onDecision(item, runs[0], 'needs_revision', comment);
                }}
                disabled={deciding}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium border transition-colors hover:bg-[var(--surface-subtle)] disabled:opacity-50"
                style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
              >
                {deciding === 'needs_revision'
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <RotateCcw className="w-3.5 h-3.5" />
                }
                Revise
              </button>

              <button
                onClick={() => {
                  if (!comment.trim()) { alert('Please add a comment before rejecting.'); return; }
                  onDecision(item, runs[0], 'rejected', comment);
                }}
                disabled={deciding}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50 transition-colors"
              >
                {deciding === 'rejected'
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <XCircle className="w-3.5 h-3.5" />
                }
                Reject
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Queue list item ───────────────────────────────────────────────────────

function QueueItem({ item, isSelected, onClick }) {
  const runs = item.ai_employee_runs || [];
  const latestRun = runs[0];
  const steps = item.loop_state?.steps || [];
  const retries = steps.reduce((n, s) => n + (s.retry_count || 0), 0);

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-3 rounded-xl transition-all ${
        isSelected
          ? 'bg-indigo-50 dark:bg-indigo-900/20 shadow-sm'
          : 'hover:bg-[var(--surface-subtle)]'
      }`}
    >
      <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
        {item.title}
      </p>
      <div className="flex items-center gap-1.5 mt-1.5">
        <span className="text-xs px-1.5 py-0.5 rounded-full text-indigo-600 bg-indigo-50 dark:bg-indigo-900/20 capitalize font-medium">
          {item.input_context?.workflow_type || 'task'}
        </span>
        {retries > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">
            {retries} self-fix
          </span>
        )}
      </div>
      {latestRun?.ended_at && (
        <span className="text-[10px] mt-1 block" style={{ color: 'var(--text-muted)' }}>
          {fmtRelative(latestRun.ended_at)}
        </span>
      )}
    </button>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────

export default function EmployeeReviewPage() {
  const { user } = useAuth();

  const [items, setItems] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [deciding, setDeciding] = useState(null);
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
      await aiEmployeeService.createReview(item.id, run?.id || null, {
        decision,
        comments: comment || null,
        created_by: user.id,
      });

      try { await attachFeedback(item.id, decision, comment || null); }
      catch { /* memory update is best-effort */ }

      const nextStatus = decision === 'approved'
        ? 'done'
        : decision === 'needs_revision'
        ? 'in_progress'
        : 'blocked';

      await aiEmployeeService.updateTaskStatus(item.id, nextStatus);

      const empStatus = decision === 'approved' ? 'idle' : 'working';
      const empId = item.employee_id || item.ai_employees?.id;
      if (empId) {
        await aiEmployeeService.updateEmployeeStatus(empId, empStatus);
      }

      if (item.loop_state?.steps?.length > 0) {
        const holdStep = item.loop_state.steps.find((s) => s.status === 'review_hold');
        if (holdStep) {
          try {
            if (decision === 'approved') {
              await approveStepAndContinue(item.id, holdStep.name);
            } else if (decision === 'needs_revision') {
              await reviseStepAndRetry(item.id, holdStep.name);
            }
          } catch (loopErr) {
            console.warn('[EmployeeReview] Agent loop step update failed:', loopErr?.message);
          }
        }
      }

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
          ? 'Revision requested \u2014 task sent back to Aiden.'
          : 'Task rejected.',
        decision === 'approved' ? 'success' : 'warning'
      );

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
        className="h-12 flex items-center justify-between px-5 flex-shrink-0 border-b"
        style={{ backgroundColor: 'var(--surface-card)', borderColor: 'var(--border-default)' }}
      >
        <div className="flex items-center gap-3">
          <CheckCircle2 className="w-4.5 h-4.5 text-indigo-500" />
          <span className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
            Review Center
          </span>
          {!loading && items.length > 0 && (
            <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
              {items.length} pending
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
          className={`mx-6 mt-3 flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium ${
            toast.type === 'success' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400' :
            toast.type === 'warning' ? 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400' :
            'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400'
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
        {/* ── Left: Queue list (narrow) ── */}
        <aside
          className="w-64 flex-shrink-0 flex flex-col border-r"
          style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)' }}
        >
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {loading ? (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="w-5 h-5 animate-spin text-indigo-400" />
              </div>
            ) : items.length === 0 ? (
              <div className="px-3 py-12 text-center">
                <CheckCircle2 className="w-10 h-10 text-emerald-400 mx-auto mb-3" />
                <p className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                  All clear!
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

        {/* ── Center: Artifact viewer ── */}
        <main className="flex-1 min-w-0 overflow-hidden">
          {selectedItem ? (
            <ArtifactViewer item={selectedItem} />
          ) : (
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <div className="w-14 h-14 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
                <FileText className="w-7 h-7" style={{ color: 'var(--text-muted)' }} />
              </div>
              <p className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                {items.length > 0 ? 'Select a task to review' : 'Nothing to review'}
              </p>
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Tasks completed by Aiden will appear here for your approval
              </p>
            </div>
          )}
        </main>

        {/* ── Right: Revision log + Review actions ── */}
        {selectedItem && (
          <aside
            className="w-80 flex-shrink-0 border-l overflow-hidden"
            style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)' }}
          >
            <RevisionLogPanel
              item={selectedItem}
              onDecision={handleDecision}
              deciding={deciding}
            />
          </aside>
        )}
      </div>
    </div>
  );
}
