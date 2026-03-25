// @product: ai-employee
// ============================================
// Human Review Center — Deliverables + Evidence + Approval
// Left:  Queue list (narrow)
// Center: Employee-style deliverable preview with evidence on demand
// Right:  Revision log + review actions
// ============================================

import { useState, useEffect, useCallback } from 'react';
import {
  RefreshCw, CheckCircle2, XCircle, RotateCcw, AlertTriangle,
  Clock, Loader2, FileText, Eye, Bot,
  BarChart3, Table2, Shield, Zap, Paperclip, GitCompare,
  Activity,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { listPendingReviews, createReview } from '../services/aiEmployee/queries.js';
import { appendWorklog } from '../services/aiEmployee/persistence/worklogRepo.js';
import { attachFeedback } from '../services/memory/aiEmployeeMemoryService';
import { resolveReviewDecision } from '../services/aiEmployee/index.js';
import { buildDeliverablePreview } from '../services/aiEmployee/deliverableProfile.js';
import { buildTaskTimeline, computeReplayCompleteness, EVIDENCE_EVENTS } from '../services/tasks/taskTimelineService';
import { listGovernanceByTask, GOVERNANCE_STATUS } from '../services/planning/approvalWorkflowService';
import AuditTimelineCard from '../components/chat/AuditTimelineCard';
import { TASK_STATES } from '../services/aiEmployee/taskStateMachine.js';
import { STEP_STATES } from '../services/aiEmployee/stepStateMachine.js';

// ── Helpers ───────────────────────────────────────────────────────────────

function fmtTime(iso) {
  if (!iso) return '\u2014';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function fmtRelative(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const ms = Date.now() - d.getTime();
  if (ms < 0) return 'just now'; // future timestamp guard
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

function safePreviewText(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncatePreview(value, limit = 1800) {
  const normalized = safePreviewText(value);
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit).trim()}…`;
}

function computeSlaStatus(item) {
  const sla = item.input_context?.sla;
  if (!sla?.deadline) return null;
  const now = Date.now();
  const deadline = new Date(sla.deadline).getTime();
  const remaining = deadline - now;
  if (remaining <= 0) return { label: 'SLA Exceeded', color: 'bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400' };
  // "approaching" = within 25% of total duration or less than 1 hour
  const created = new Date(item.created_at).getTime();
  const totalWindow = deadline - created;
  const threshold = Math.min(totalWindow * 0.25, 3600000); // 25% or 1h
  if (remaining <= threshold) return { label: 'SLA Soon', color: 'bg-amber-50 text-amber-600 dark:bg-amber-900/20 dark:text-amber-400' };
  return { label: 'Within SLA', color: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400' };
}

function StatusBanner({ latestRun }) {
  if (!latestRun) return null;

  const succeeded = latestRun.status === 'succeeded';

  return (
    <div
      className="flex items-center gap-2 px-5 py-2.5 border-b text-sm"
      style={{
        borderColor: 'var(--border-default)',
        backgroundColor: succeeded ? 'rgba(16, 185, 129, 0.05)' : 'rgba(239, 68, 68, 0.05)',
      }}
    >
      {succeeded
        ? <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
        : <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0" />
      }
      <span style={{ color: 'var(--text-primary)' }}>
        {latestRun.summary || (succeeded ? 'Completed successfully' : 'Completed with issues')}
      </span>
      <span className="ml-auto text-xs" style={{ color: 'var(--text-muted)' }}>
        {fmtRelative(latestRun.ended_at)}
      </span>
    </div>
  );
}

function EvidenceArtifactGrid({ artifactRefs }) {
  const [selectedArtifact, setSelectedArtifact] = useState(null);

  const grouped = {};
  for (const ref of artifactRefs) {
    const cat = categorizeArtifact(ref.type || ref.artifact_type);
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(ref);
  }

  const categoryLabels = { forecast: 'Forecast', plan: 'Plan', risk: 'Risk', report: 'Report', other: 'Other' };
  const categoryIcons = { forecast: BarChart3, plan: Table2, risk: Shield, report: FileText, other: FileText };

  if (artifactRefs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-14 gap-2">
        <FileText className="w-10 h-10" style={{ color: 'var(--text-muted)' }} />
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No evidence artifacts captured for this run.</p>
      </div>
    );
  }

  return (
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
  );
}

function StepTracker({ loopState }) {
  const steps = loopState?.steps;
  if (!steps?.length) return null;

  const statusColor = {
    succeeded: 'bg-emerald-500 border-emerald-200',
    done: 'bg-emerald-500 border-emerald-200',
    running: 'bg-blue-500 border-blue-200 animate-pulse',
    failed: 'bg-red-500 border-red-200',
    review_hold: 'bg-amber-500 border-amber-200',
    waiting_input: 'bg-amber-500 border-amber-200',
    pending: 'bg-slate-300 border-slate-200',
    skipped: 'bg-slate-200 border-slate-100',
  };

  return (
    <div className="flex items-center gap-1 py-2">
      {steps.map((step, i) => (
        <div key={step.name || i} className="flex items-center">
          {i > 0 && <div className="w-4 h-px mx-0.5" style={{ backgroundColor: 'var(--border-default)' }} />}
          <div className="flex items-center gap-1" title={`${step.name}: ${step.status}`}>
            <div className={`w-2.5 h-2.5 rounded-full border-2 ${statusColor[step.status] || statusColor.pending}`} />
            <span className="text-[10px] capitalize" style={{ color: 'var(--text-muted)' }}>{step.name}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function RevisionDiffView({ runs }) {
  if (!runs || runs.length < 2) return null;

  const current = runs[0];
  const previous = runs[1];
  const currentSummary = current?.summary || 'No summary';
  const previousSummary = previous?.summary || 'No summary';

  if (currentSummary === previousSummary) return null;

  return (
    <div className="p-4 rounded-2xl border" style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)' }}>
      <div className="flex items-center gap-2 mb-3">
        <GitCompare className="w-4 h-4 text-indigo-500" />
        <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          Revision Comparison
        </h4>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="p-3 rounded-xl" style={{ backgroundColor: 'rgba(239, 68, 68, 0.05)' }}>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-red-500 mb-1">Previous</p>
          <p className="text-xs leading-5" style={{ color: 'var(--text-secondary)' }}>{previousSummary}</p>
        </div>
        <div className="p-3 rounded-xl" style={{ backgroundColor: 'rgba(16, 185, 129, 0.05)' }}>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-500 mb-1">Current</p>
          <p className="text-xs leading-5" style={{ color: 'var(--text-secondary)' }}>{currentSummary}</p>
        </div>
      </div>
    </div>
  );
}

function DeliverableViewer({ item }) {
  const [activeTab, setActiveTab] = useState('deliverable');
  const [taskTimeline, setTaskTimeline] = useState(null);
  const [traceCompleteness, setTraceCompleteness] = useState(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [governanceItems, setGovernanceItems] = useState([]);

  const loadTimeline = useCallback((taskId) => {
    if (!taskId) return;
    setTimelineLoading(true);
    buildTaskTimeline(taskId).then(timeline => {
      setTaskTimeline(timeline);
      setTraceCompleteness(computeReplayCompleteness(timeline));
    }).catch(() => {
      setTaskTimeline(null);
      setTraceCompleteness(null);
    }).finally(() => setTimelineLoading(false));

    // Also load governance approvals for this task via the unified service
    listGovernanceByTask(taskId).then(setGovernanceItems).catch(() => setGovernanceItems([]));
  }, []);

  const itemId = item?.id;
  useEffect(() => {
    loadTimeline(itemId); // eslint-disable-line react-hooks/set-state-in-effect -- async fetch pattern
  }, [itemId, loadTimeline]);

  const workflowType = item.input_context?.workflow_type || 'task';
  const deliverable = buildDeliverablePreview(item);
  const latestRun = deliverable.latestRun;
  const deliverableIcon = deliverable.previewKind === 'spreadsheet'
    ? Table2
    : deliverable.previewKind === 'bi'
      ? BarChart3
      : FileText;
  const DeliverableIcon = deliverableIcon;
  const previewExcerpt = deliverable.rawPreview ? truncatePreview(deliverable.rawPreview) : '';
  const attachments = [
    deliverable.primaryAttachmentName,
    ...deliverable.attachmentNames,
  ].filter(Boolean);

  return (
    <div className="h-full flex flex-col">
      <div className="px-5 py-4 border-b flex-shrink-0" style={{ borderColor: 'var(--border-default)' }}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-semibold text-base" style={{ color: 'var(--text-primary)' }}>
              {item.title}
            </h2>
            {item.description && (
              <p className="text-sm mt-1 line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
                {item.description}
              </p>
            )}
          </div>
          <div className="px-3 py-2 rounded-xl border min-w-[190px]" style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-subtle)' }}>
            <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              Deliverable
            </p>
            <p className="text-sm font-semibold mt-1" style={{ color: 'var(--text-primary)' }}>
              {deliverable.profile.label}
            </p>
            <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
              {deliverable.profile.channel}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
          <span className="px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600 dark:bg-indigo-900/20 dark:text-indigo-400 font-medium capitalize">
            {workflowType}
          </span>
          <span className="px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800">
            {deliverable.profile.audience}
          </span>
          <span>Format: <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>{deliverable.profile.format}</span></span>
          <span>Priority: <span className="capitalize font-medium" style={{ color: 'var(--text-secondary)' }}>{item.priority}</span></span>
          {item.due_at && <span>Due {fmtTime(item.due_at)}</span>}
        </div>
      </div>

      <StatusBanner latestRun={latestRun} />

      {/* Step tracker */}
      {item.loop_state && (
        <div className="px-5 border-b" style={{ borderColor: 'var(--border-default)' }}>
          <StepTracker loopState={item.loop_state} />
        </div>
      )}

      <div className="px-5 pt-4 pb-2 border-b flex items-center gap-2" style={{ borderColor: 'var(--border-default)' }}>
        {[
          { key: 'deliverable', label: 'Deliverable' },
          { key: 'evidence', label: `Evidence${deliverable.evidenceArtifacts.length ? ` (${deliverable.evidenceArtifacts.length})` : ''}` },
          { key: 'timeline', label: `Timeline${taskTimeline?.length ? ` (${taskTimeline.length})` : ''}` },
        ].map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
              activeTab === tab.key ? 'text-white' : ''
            }`}
            style={{
              backgroundColor: activeTab === tab.key ? '#4f46e5' : 'var(--surface-subtle)',
              color: activeTab === tab.key ? '#ffffff' : 'var(--text-secondary)',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        {activeTab === 'deliverable' ? (
          <div className="space-y-4">
            {/* Revision diff (shown when task has multiple runs) */}
            <RevisionDiffView runs={item.ai_employee_runs} />

            <section className="p-5 rounded-2xl border" style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)' }}>
              <div className="flex items-start gap-4">
                <div className="w-11 h-11 rounded-2xl flex items-center justify-center border" style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-subtle)' }}>
                  <DeliverableIcon className="w-5 h-5 text-indigo-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                    Manager-ready output
                  </p>
                  <h3 className="text-lg font-semibold mt-1" style={{ color: 'var(--text-primary)' }}>
                    {deliverable.headline}
                  </h3>
                  <p className="text-sm mt-2 leading-6" style={{ color: 'var(--text-secondary)' }}>
                    {deliverable.summary || 'Deliverable draft is ready for review.'}
                  </p>
                </div>
              </div>
            </section>

            {deliverable.sections.length > 0 && (
              <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                {deliverable.sections.map((section) => (
                  <div
                    key={section.label}
                    className="p-4 rounded-2xl border"
                    style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)' }}
                  >
                    <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {section.label}
                    </h4>
                    <ul className="mt-3 space-y-2">
                      {section.items.map((entry, index) => (
                        <li key={`${section.label}-${index}`} className="flex items-start gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                          <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-indigo-500 flex-shrink-0" />
                          <span>{entry}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </section>
            )}

            {previewExcerpt && (
              <section className="p-4 rounded-2xl border" style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)' }}>
                <div className="flex items-center gap-2 mb-2">
                  <FileText className="w-4 h-4 text-indigo-500" />
                  <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                    Draft excerpt
                  </h4>
                </div>
                <p className="text-sm leading-6 whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>
                  {previewExcerpt}
                </p>
              </section>
            )}

            <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <div className="p-4 rounded-2xl border" style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)' }}>
                <div className="flex items-center gap-2 mb-2">
                  <Paperclip className="w-4 h-4 text-indigo-500" />
                  <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                    Deliverable package
                  </h4>
                </div>
                {attachments.length > 0 ? (
                  <ul className="space-y-2">
                    {attachments.map((name, index) => (
                      <li key={`${name}-${index}`} className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                        {name}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                    No named attachments were saved for this run.
                  </p>
                )}
              </div>

              <div className="p-4 rounded-2xl border" style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)' }}>
                <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                  Review guidance
                </h4>
                <p className="text-sm mt-2 leading-6" style={{ color: 'var(--text-secondary)' }}>
                  Approve if this reads like a normal employee deliverable for {deliverable.profile.audience.toLowerCase()}.
                  Use Evidence when you need the underlying artifacts, intermediate outputs, or raw tool traces.
                </p>
              </div>
            </section>
          </div>
        ) : activeTab === 'evidence' ? (
          <EvidenceArtifactGrid artifactRefs={deliverable.evidenceArtifacts} />
        ) : activeTab === 'timeline' ? (
          <div className="space-y-4">
            {/* Trace Completeness + SLA Status */}
            <div className="flex items-center flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-indigo-500" />
                <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>Audit Trail</span>
              </div>
              {traceCompleteness && (
                <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${
                  traceCompleteness.score >= 80 ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400' :
                  traceCompleteness.score >= 50 ? 'bg-amber-50 text-amber-600 dark:bg-amber-900/20 dark:text-amber-400' :
                  'bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400'
                }`}>
                  {traceCompleteness.score}% traced
                </span>
              )}
              {traceCompleteness?.missing?.length > 0 && (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800" style={{ color: 'var(--text-muted)' }}>
                  {traceCompleteness.missing.length} gap{traceCompleteness.missing.length > 1 ? 's' : ''}
                </span>
              )}
            </div>

            {/* Governance approvals (from unified approvalWorkflowService) */}
            {governanceItems.length > 0 && (
              <div className="p-3 rounded-xl border" style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)' }}>
                <div className="flex items-center gap-2 mb-2">
                  <Shield className="w-3.5 h-3.5 text-indigo-500" />
                  <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>Governance Approvals</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800" style={{ color: 'var(--text-muted)' }}>
                    {governanceItems.length}
                  </span>
                </div>
                <div className="space-y-1.5">
                  {governanceItems.map((gi) => (
                    <div key={gi.id} className="flex items-center gap-2 text-xs">
                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                        gi.status === GOVERNANCE_STATUS.APPROVED ? 'bg-emerald-500' :
                        gi.status === GOVERNANCE_STATUS.REJECTED ? 'bg-red-500' :
                        gi.status === GOVERNANCE_STATUS.ESCALATED ? 'bg-amber-500' :
                        gi.status === GOVERNANCE_STATUS.EXPIRED ? 'bg-slate-400' :
                        'bg-blue-500'
                      }`} />
                      <span className="capitalize" style={{ color: 'var(--text-secondary)' }}>
                        {(gi.type || 'approval').replace(/_/g, ' ')}
                      </span>
                      <span className="capitalize font-medium" style={{ color: 'var(--text-primary)' }}>
                        {gi.status}
                      </span>
                      {gi.reviewed_at && (
                        <span style={{ color: 'var(--text-muted)' }}>{fmtRelative(gi.reviewed_at)}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* SLA info from task intake */}
            {item.input_context?.sla?.deadline && (() => {
              const sla = computeSlaStatus(item);
              return sla ? (
                <div className="p-3 rounded-xl border" style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)' }}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Clock className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />
                      <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>SLA Target</span>
                    </div>
                    <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${sla.color}`}>
                      {sla.label}
                    </span>
                  </div>
                  <p className="text-xs mt-1.5" style={{ color: 'var(--text-secondary)' }}>
                    Deadline: {fmtTime(item.input_context.sla.deadline)}
                    {item.input_context.sla.tier && <> &middot; Tier: <span className="capitalize">{item.input_context.sla.tier}</span></>}
                  </p>
                </div>
              ) : null;
            })()}

            {/* Capability policy display */}
            {item.input_context?.capability_policy && (
              <div className="p-3 rounded-xl border" style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)' }}>
                <div className="flex items-center gap-2 mb-2">
                  <Shield className="w-3.5 h-3.5 text-indigo-500" />
                  <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>Capability Policy</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(item.input_context.capability_policy).map(([key, val]) => (
                    <span key={key} className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800" style={{ color: 'var(--text-secondary)' }}>
                      {key}: {typeof val === 'boolean' ? (val ? 'yes' : 'no') : String(val)}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Timeline card */}
            {timelineLoading ? (
              <div className="flex items-center justify-center py-14">
                <Loader2 className="w-5 h-5 animate-spin text-indigo-400" />
              </div>
            ) : taskTimeline && taskTimeline.length > 0 ? (
              <AuditTimelineCard
                events={taskTimeline.map(e => ({
                  type: e.event_type,
                  timestamp: e.timestamp,
                  step_name: e.detail?.step_name,
                  message: e.detail?.error || e.detail?.feedback || e.detail?.decision,
                  details: e.detail,
                  artifacts: e.detail?.artifact_id ? [e.detail.artifact_id] : undefined,
                }))}
                taskTitle={item.title}
                taskId={item.id}
              />
            ) : (
              <div className="flex flex-col items-center justify-center py-14 gap-2">
                <Activity className="w-10 h-10" style={{ color: 'var(--text-muted)' }} />
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No timeline events recorded yet.</p>
              </div>
            )}
          </div>
        ) : null}
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
                const retried = step.retry_count > 0;
                return (
                  <div key={step.name || i} className="relative pb-4 last:pb-0">
                    {/* Dot on timeline */}
                    <div
                      className={`absolute -left-[calc(0.5rem+1px)] top-1 w-3 h-3 rounded-full border-2 ${
                        step.status === STEP_STATES.SUCCEEDED ? 'bg-emerald-500 border-emerald-200' :
                        step.status === STEP_STATES.FAILED ? 'bg-red-500 border-red-200' :
                        step.status === STEP_STATES.REVIEW_HOLD ? 'bg-amber-500 border-amber-200' :
                        step.status === STEP_STATES.RUNNING ? 'bg-blue-500 border-blue-200 animate-pulse' :
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
            placeholder="Leave feedback for the worker..."
            disabled={deciding}
          />

          <div className="flex flex-col gap-2 mt-3">
            <button
              onClick={() => onDecision(item, runs?.[0] || null, 'approved', comment)}
              disabled={deciding || !runs?.length}
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
                  onDecision(item, runs?.[0] || null, 'needs_revision', comment);
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
  const workerName = item.ai_employees?.name || null;
  const revisionCount = runs.length > 1 ? runs.length - 1 : 0;
  const slaStatus = computeSlaStatus(item);

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
      {workerName && (
        <div className="flex items-center gap-1 mt-1">
          <Bot className="w-3 h-3 text-indigo-400" />
          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{workerName}</span>
        </div>
      )}
      <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
        <span className="text-xs px-1.5 py-0.5 rounded-full text-indigo-600 bg-indigo-50 dark:bg-indigo-900/20 capitalize font-medium">
          {item.input_context?.workflow_type || 'task'}
        </span>
        {slaStatus && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${slaStatus.color}`}>
            {slaStatus.label}
          </span>
        )}
        {retries > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">
            {retries} self-fix
          </span>
        )}
        {revisionCount > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-700 font-medium">
            rev {revisionCount}
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
      const pending = await listPendingReviews(user.id);
      setItems(pending);
      if (pending.length === 0) {
        setSelectedId(null);
      } else if (!selectedId || !pending.some((item) => item.id === selectedId)) {
        setSelectedId(pending[0].id);
      }
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
      const review = await createReview(item.id, run?.id || null, {
        decision,
        comments: comment || null,
        createdBy: user.id,
      });

      try { await attachFeedback(item.id, decision, comment || null); }
      catch { /* memory update is best-effort */ }

      const empId = item.employee_id || item.ai_employees?.id;

      const resolution = await resolveReviewDecision(item, {
        userId: user.id,
        decision,
        comment,
        review,
        run,
      });

      if (empId) {
        await appendWorklog(empId, item.id, run?.id || null, 'task_update', {
          previous_status: resolution.previousStatus || item.status || TASK_STATES.REVIEW_HOLD,
          new_status: resolution.nextStatus,
          note: comment || `Manager ${decision}.`,
          review_decision: decision,
          output_profile_proposal_id: resolution.outputProfileProposal?.id || null,
          output_profile_proposal_status: resolution.outputProfileProposal?.status || null,
        });
      }

      showToast(resolution.message, resolution.toastType);

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

        {/* ── Center: Deliverable preview ── */}
        <main className="flex-1 min-w-0 overflow-hidden">
          {selectedItem ? (
            <DeliverableViewer key={selectedItem.id} item={selectedItem} />
          ) : (
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <div className="w-14 h-14 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
                <FileText className="w-7 h-7" style={{ color: 'var(--text-muted)' }} />
              </div>
              <p className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                {items.length > 0 ? 'Select a task to review' : 'Nothing to review'}
              </p>
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Manager-ready deliverables will appear here for your approval
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
