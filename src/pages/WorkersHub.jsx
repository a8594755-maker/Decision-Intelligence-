// @product: ai-employee
// ============================================
// Workers Hub — Unified container with horizontal tabs
// Consolidates: Task Board, Review + Approvals, Workers, Config
// ============================================

import { lazy, Suspense, useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ClipboardList, CheckSquare, Users, Settings2,
  Loader2,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { listPendingReviews, listTasksByUser } from '../services/aiEmployee/queries.js';
import {
  getPendingApprovals,
} from '../services/planning/approvalWorkflowService';

// ── Lazy-loaded tab panels ───────────────────────────────────────────────
const EmployeeTasksPage   = lazy(() => import('./EmployeeTasksPage'));
const EmployeeReviewPage  = lazy(() => import('./EmployeeReviewPage'));
const ApprovalQueuePage   = lazy(() => import('./ApprovalQueuePage'));
const EmployeesPage       = lazy(() => import('./EmployeesPage'));
const WorkerTemplatesPage = lazy(() => import('./WorkerTemplatesPage'));
const OutputProfilesPage  = lazy(() => import('./OutputProfilesPage'));
const ToolRegistryPage    = lazy(() => import('./ToolRegistryPage'));
const PolicyRulesPage     = lazy(() => import('./PolicyRulesPage'));
const WebhookConfigPage   = lazy(() => import('./WebhookConfigPage'));
const ScheduleManagerPage = lazy(() => import('./ScheduleManagerPage'));

// ── Tab definitions ──────────────────────────────────────────────────────

const TABS = [
  { key: 'tasks',   label: 'Task Board', icon: ClipboardList },
  { key: 'review',  label: 'Review',     icon: CheckSquare },
  { key: 'workers', label: 'Workers',    icon: Users },
  { key: 'config',  label: 'Config',     icon: Settings2 },
];

const CONFIG_SECTIONS = [
  { key: 'templates', label: 'Templates' },
  { key: 'profiles',  label: 'Output Profiles' },
  { key: 'tools',     label: 'Tool Library' },
  { key: 'policies',  label: 'Governance' },
  { key: 'webhooks',  label: 'Webhooks' },
  { key: 'schedules', label: 'Schedules' },
];

// ── Loading spinner ──────────────────────────────────────────────────────

function TabSpinner() {
  return (
    <div className="flex items-center justify-center h-64">
      <Loader2 className="w-6 h-6 animate-spin" style={{ color: 'var(--brand-600)' }} />
    </div>
  );
}

// ── Config Panel (vertical sub-tabs) ─────────────────────────────────────

function ConfigPanel({ section, onSectionChange }) {
  const active = section || 'templates';

  return (
    <div className="h-full flex">
      {/* Vertical sub-nav */}
      <div
        className="w-44 flex-shrink-0 border-r py-2 overflow-y-auto"
        style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)' }}
      >
        {CONFIG_SECTIONS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => onSectionChange(key)}
            className={[
              'w-full text-left px-4 py-2 text-sm font-medium transition-colors',
              active === key
                ? 'bg-[var(--brand-50)] text-[var(--brand-600)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-subtle)]',
            ].join(' ')}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Sub-panel content */}
      <div className="flex-1 min-w-0 overflow-hidden">
        <Suspense fallback={<TabSpinner />}>
          {active === 'templates' && <WorkerTemplatesPage />}
          {active === 'profiles'  && <OutputProfilesPage />}
          {active === 'tools'     && <ToolRegistryPage />}
          {active === 'policies'  && <PolicyRulesPage />}
          {active === 'webhooks'  && <WebhookConfigPage />}
          {active === 'schedules' && <ScheduleManagerPage />}
        </Suspense>
      </div>
    </div>
  );
}

// ── Badge component ──────────────────────────────────────────────────────

function TabBadge({ count }) {
  if (!count) return null;
  return (
    <span className="ml-1.5 min-w-[18px] h-[18px] flex items-center justify-center px-1 rounded-full text-[10px] font-bold bg-[var(--risk-critical)] text-white">
      {count > 99 ? '99+' : count}
    </span>
  );
}

// ── Main component ───────────────────────────────────────────────────────

export default function WorkersHub() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const activeTab = searchParams.get('tab') || 'tasks';
  const configSection = searchParams.get('section') || 'templates';

  // Badge counts
  const [reviewCount, setReviewCount] = useState(0);
  const [taskCount, setTaskCount] = useState(0);

  const setTab = useCallback((tab) => {
    const params = new URLSearchParams(searchParams);
    params.set('tab', tab);
    if (tab !== 'config') params.delete('section');
    setSearchParams(params, { replace: true });
  }, [searchParams, setSearchParams]);

  const setConfigSection = useCallback((section) => {
    const params = new URLSearchParams(searchParams);
    params.set('tab', 'config');
    params.set('section', section);
    setSearchParams(params, { replace: true });
  }, [searchParams, setSearchParams]);

  // Load badge counts (best-effort)
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;

    async function loadCounts() {
      try {
        const [reviews, approvals, tasks] = await Promise.all([
          listPendingReviews(user.id).catch(() => []),
          getPendingApprovals(user.id).catch(() => []),
          listTasksByUser(user.id).catch(() => []),
        ]);
        if (cancelled) return;
        setReviewCount((reviews?.length || 0) + (approvals?.length || 0));
        const activeTasks = (tasks || []).filter(
          (t) => t.status && !['DONE', 'CANCELLED'].includes(t.status)
        );
        setTaskCount(activeTasks.length);
      } catch { /* best-effort */ }
    }

    loadCounts();
    return () => { cancelled = true; };
  }, [user?.id]);

  return (
    <div className="h-full flex flex-col" style={{ backgroundColor: 'var(--surface-base)' }}>
      {/* ── Tab bar ── */}
      <div
        className="flex-shrink-0 border-b"
        style={{ backgroundColor: 'var(--surface-card)', borderColor: 'var(--border-default)' }}
      >
        <div className="flex items-center h-12 px-4 gap-1">
          {TABS.map(({ key, label, icon: Icon }) => {
            const isActive = activeTab === key;
            const badge = key === 'tasks' ? taskCount
              : key === 'review' ? reviewCount
              : 0;

            return (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={[
                  'relative flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg transition-colors cursor-pointer',
                  isActive
                    ? 'text-[var(--brand-600)]'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-subtle)]',
                ].join(' ')}
                role="tab"
                aria-selected={isActive}
              >
                <Icon className="w-4 h-4" />
                {label}
                <TabBadge count={badge} />
                {/* Active indicator bar */}
                {isActive && (
                  <span
                    className="absolute bottom-0 left-2 right-2 h-0.5 rounded-full"
                    style={{ backgroundColor: 'var(--brand-600)' }}
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Tab content ── */}
      <div className="flex-1 min-h-0 overflow-hidden" role="tabpanel">
        <Suspense fallback={<TabSpinner />}>
          {activeTab === 'tasks'   && <EmployeeTasksPage />}
          {activeTab === 'review'  && (
            <ReviewComboPanel />
          )}
          {activeTab === 'workers' && <EmployeesPage />}
          {activeTab === 'config'  && (
            <ConfigPanel section={configSection} onSectionChange={setConfigSection} />
          )}
        </Suspense>
      </div>
    </div>
  );
}

// ── Review + Approvals combo panel ───────────────────────────────────────

function ReviewComboPanel() {
  const [subView, setSubView] = useState('reviews');

  return (
    <div className="h-full flex flex-col">
      {/* Sub-toggle */}
      <div
        className="flex items-center gap-1 px-4 py-2 border-b flex-shrink-0"
        style={{ borderColor: 'var(--border-default)' }}
      >
        <button
          onClick={() => setSubView('reviews')}
          className={[
            'px-3 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer',
            subView === 'reviews'
              ? 'bg-[var(--brand-50)] text-[var(--brand-600)]'
              : 'text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)]',
          ].join(' ')}
        >
          Deliverable Review
        </button>
        <button
          onClick={() => setSubView('approvals')}
          className={[
            'px-3 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer',
            subView === 'approvals'
              ? 'bg-[var(--brand-50)] text-[var(--brand-600)]'
              : 'text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)]',
          ].join(' ')}
        >
          Governance Approvals
        </button>
      </div>

      {/* Panel content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <Suspense fallback={<TabSpinner />}>
          {subView === 'reviews'   && <EmployeeReviewPage />}
          {subView === 'approvals' && <ApprovalQueuePage />}
        </Suspense>
      </div>
    </div>
  );
}
