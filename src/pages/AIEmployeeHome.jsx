/**
 * Digital Worker Home — Manager Console Dashboard
 *
 * Unified dashboard for managers to:
 *   - View all workers and their statuses
 *   - Track team KPIs and performance trends
 *   - Manage task assignments and approvals
 *   - Quick-access to chat interface
 */

import { lazy, Suspense, useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bot, MessageSquare, CheckCircle2, Clock, AlertTriangle, BarChart3,
  ChevronRight, Users, Zap, TrendingUp, FileText, ArrowUpRight,
  Shield, Activity, Target, Eye, Sparkles
} from 'lucide-react';
import { Card } from '../components/ui';
import { useAuth } from '../contexts/AuthContext';
import { listEmployeesByManager, getKpis, createWorkerFromTemplate, listTemplates } from '../services/aiEmployee/queries.js';
import { getLatestSummary } from '../services/dailySummaryService';
import { listPending, getGovernanceStats } from '../services/governanceService';
import { buildPerformanceDashboard, AUTONOMY_LABELS } from '../services/workerPerformanceService';

const DecisionSupportView = lazy(() => import('../views/DecisionSupportView'));

// ── Quick Stats Card ────────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars -- Icon is rendered in JSX below
function QuickStat({ icon: Icon, label, value, trend, accent = 'text-indigo-600' }) {
  return (
    <div className="flex items-center gap-3 p-3 rounded-lg bg-white dark:bg-slate-800/50 border" style={{ borderColor: 'var(--border-default)' }}>
      <div className="p-2 rounded-lg bg-slate-50 dark:bg-slate-800">
        <Icon className={`w-4 h-4 ${accent}`} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
        <div className="flex items-baseline gap-2">
          <p className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{value}</p>
          {trend && (
            <span className={`text-[10px] font-medium ${trend > 0 ? 'text-emerald-600' : trend < 0 ? 'text-red-500' : 'text-slate-400'}`}>
              {trend > 0 ? '+' : ''}{trend}%
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Worker Status Row ───────────────────────────────────────────────────────

const WORKER_STATUS_STYLES = {
  idle: { color: 'text-slate-500', bg: 'bg-slate-100 dark:bg-slate-800', dot: 'bg-slate-400' },
  working: { color: 'text-blue-600', bg: 'bg-blue-50 dark:bg-blue-900/20', dot: 'bg-blue-500' },
  waiting_review: { color: 'text-amber-600', bg: 'bg-amber-50 dark:bg-amber-900/20', dot: 'bg-amber-500' },
  blocked: { color: 'text-red-600', bg: 'bg-red-50 dark:bg-red-900/20', dot: 'bg-red-500' },
};

function WorkerRow({ worker, kpis, onClick }) {
  const statusCfg = WORKER_STATUS_STYLES[worker.status] || WORKER_STATUS_STYLES.idle;
  const completionRate = kpis?.tasks_completed && kpis?.tasks_open != null
    ? Math.round((kpis.tasks_completed / Math.max(kpis.tasks_completed + kpis.tasks_open, 1)) * 100)
    : null;

  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 p-3 rounded-lg border text-left transition-colors hover:bg-[var(--surface-subtle)]"
      style={{ borderColor: 'var(--border-default)' }}
    >
      <div className="w-8 h-8 rounded-full bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center flex-shrink-0">
        <Bot className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
            {worker.name}
          </span>
          <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusCfg.dot}`} />
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${statusCfg.bg} ${statusCfg.color}`}>
            {(worker.status || 'idle').replace(/_/g, ' ')}
          </span>
        </div>
        <p className="text-[11px] capitalize" style={{ color: 'var(--text-muted)' }}>
          {(worker.role || 'employee').replace(/_/g, ' ')}
        </p>
      </div>
      <div className="flex items-center gap-3 text-[11px] text-slate-500 flex-shrink-0">
        {kpis?.tasks_completed != null && (
          <span>{kpis.tasks_completed} done</span>
        )}
        {completionRate != null && (
          <span className="font-medium text-emerald-600">{completionRate}%</span>
        )}
        <ChevronRight className="w-3.5 h-3.5 text-slate-300" />
      </div>
    </button>
  );
}

// ── Recent Activity Feed ────────────────────────────────────────────────────

function ActivityFeed({ dailySummary }) {
  if (!dailySummary) {
    return (
      <div className="text-center py-6">
        <Activity className="w-8 h-8 mx-auto mb-2 text-slate-300 dark:text-slate-600" />
        <p className="text-xs text-slate-400">No recent activity.</p>
      </div>
    );
  }

  const items = [];
  if (dailySummary.tasks_completed > 0) {
    items.push({ icon: CheckCircle2, text: `${dailySummary.tasks_completed} task(s) completed`, color: 'text-emerald-600' });
  }
  if (dailySummary.tasks_created > 0) {
    items.push({ icon: FileText, text: `${dailySummary.tasks_created} new task(s) created`, color: 'text-blue-600' });
  }
  if (dailySummary.reviews_pending > 0) {
    items.push({ icon: AlertTriangle, text: `${dailySummary.reviews_pending} review(s) pending`, color: 'text-amber-600' });
  }
  if (dailySummary.artifacts_generated > 0) {
    items.push({ icon: FileText, text: `${dailySummary.artifacts_generated} artifact(s) generated`, color: 'text-indigo-600' });
  }

  if (items.length === 0) {
    items.push({ icon: Activity, text: 'All systems idle', color: 'text-slate-400' });
  }

  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div key={i} className="flex items-center gap-2">
          <item.icon className={`w-3.5 h-3.5 flex-shrink-0 ${item.color}`} />
          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{item.text}</span>
        </div>
      ))}
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────────────────────

export default function AIEmployeeHome() {
  const { user, addNotification } = useAuth();
  const navigate = useNavigate();
  const [view, setView] = useState('dashboard'); // 'dashboard' | 'chat'
  const [workers, setWorkers] = useState([]);
  const [kpisMap, setKpisMap] = useState({});
  const [dailySummary, setDailySummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [pendingApprovals, setPendingApprovals] = useState([]);
  const [govStats, setGovStats] = useState(null);
  const [perfDashboards, setPerfDashboards] = useState({});
  const [showAddWorker, setShowAddWorker] = useState(false);
  const [addingWorker, setAddingWorker] = useState(false);
  const [availableTemplates, setAvailableTemplates] = useState([]);
  const selectedWorkerStorageKey = useMemo(
    () => (user?.id ? `ai-employee.active-worker.${user.id}` : null),
    [user?.id]
  );
  const [selectedWorkerId, setSelectedWorkerId] = useState(() => {
    try {
      return localStorage.getItem('ai-employee.active-worker') || '';
    } catch {
      return '';
    }
  });

  const persistSelectedWorker = useCallback((workerId) => {
    setSelectedWorkerId(workerId || '');
    try {
      if (selectedWorkerStorageKey) {
        if (workerId) localStorage.setItem(selectedWorkerStorageKey, workerId);
        else localStorage.removeItem(selectedWorkerStorageKey);
      }
      if (workerId) localStorage.setItem('ai-employee.active-worker', workerId);
      else localStorage.removeItem('ai-employee.active-worker');
    } catch {
      // best-effort local preference persistence
    }
  }, [selectedWorkerStorageKey]);

  const loadData = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    try {
      const [emps, summary, approvals, gStats, templates] = await Promise.all([
        listEmployeesByManager(user.id).catch(() => []),
        getLatestSummary(user.id).catch(() => null),
        listPending(user.id, { limit: 10 }).catch(() => []),
        getGovernanceStats(user.id).catch(() => null),
        listTemplates().catch(() => []),
      ]);
      setAvailableTemplates(templates || []);

      setPendingApprovals(approvals || []);
      setGovStats(gStats);

      setWorkers(emps || []);
      setDailySummary(summary);

      // Load KPIs in parallel
      if (emps?.length > 0) {
        const kpiResults = await Promise.all(
          emps.map(async (emp) => {
            try {
              return { id: emp.id, kpis: await getKpis(emp.id) };
            } catch {
              return { id: emp.id, kpis: null };
            }
          })
        );
        const kMap = {};
        for (const r of kpiResults) kMap[r.id] = r.kpis;
        setKpisMap(kMap);

        // Load performance dashboards (best-effort, non-blocking)
        Promise.all(
          emps.map(async (emp) => {
            try {
              return { id: emp.id, dashboard: await buildPerformanceDashboard(emp.id, { historyPeriods: 4, recentTaskLimit: 5 }) };
            } catch {
              return { id: emp.id, dashboard: null };
            }
          })
        ).then(perfResults => {
          const pMap = {};
          for (const r of perfResults) if (r.dashboard) pMap[r.id] = r.dashboard;
          setPerfDashboards(pMap);
        });
      }
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    if (!selectedWorkerStorageKey) return;
    try {
      const stored = localStorage.getItem(selectedWorkerStorageKey) || '';
      if (stored && stored !== selectedWorkerId) {
        setSelectedWorkerId(stored);
      }
    } catch {
      // best-effort preference restore
    }
  }, [selectedWorkerStorageKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (workers.length === 0) {
      if (selectedWorkerId) persistSelectedWorker('');
      return;
    }
    const hasSelectedWorker = workers.some((worker) => worker.id === selectedWorkerId);
    if (!hasSelectedWorker) {
      persistSelectedWorker(workers[0].id);
    }
  }, [workers, selectedWorkerId, persistSelectedWorker]);

  const selectedWorker = useMemo(
    () => workers.find((worker) => worker.id === selectedWorkerId) || workers[0] || null,
    [workers, selectedWorkerId]
  );

  const openWorkerChat = useCallback((workerId) => {
    persistSelectedWorker(workerId);
    setView('chat');
  }, [persistSelectedWorker]);

  // Aggregate stats
  const stats = useMemo(() => {
    let totalCompleted = 0;
    let totalOpen = 0;
    let totalReviewPending = 0;
    let avgOnTime = null;

    for (const w of workers) {
      const k = kpisMap[w.id];
      if (k) {
        totalCompleted += k.tasks_completed ?? 0;
        totalOpen += k.tasks_open ?? 0;
        if (k.on_time_rate_pct != null) {
          avgOnTime = avgOnTime == null ? k.on_time_rate_pct : (avgOnTime + k.on_time_rate_pct) / 2;
        }
      }
      if (w.status === 'waiting_review') totalReviewPending++;
    }

    return { totalCompleted, totalOpen, totalReviewPending, avgOnTime, workerCount: workers.length };
  }, [workers, kpisMap]);

  // Chat view
  if (view === 'chat') {
    return (
      <div className="h-full min-w-0 overflow-hidden flex flex-col">
        <div className="h-10 flex items-center justify-between gap-3 px-4 border-b flex-shrink-0" style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)' }}>
          <div className="flex items-center gap-2 min-w-0">
            <button
              onClick={() => setView('dashboard')}
              className="text-xs font-medium px-2 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              style={{ color: 'var(--text-secondary)' }}
            >
              &larr; Dashboard
            </button>
            {workers.length > 0 ? (
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[11px] uppercase tracking-wide whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                  Delegating to
                </span>
                <select
                  value={selectedWorker?.id || ''}
                  onChange={(event) => persistSelectedWorker(event.target.value)}
                  className="min-w-[180px] max-w-[260px] px-2.5 py-1 rounded-lg border text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-bg)', color: 'var(--text-primary)' }}
                >
                  {workers.map((worker) => (
                    <option key={worker.id} value={worker.id}>
                      {worker.name} ({(worker.role || '').replace(/_/g, ' ')})
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
          </div>
          <button
            onClick={() => navigate(selectedWorker ? `/employees/tasks?worker=${selectedWorker.id}` : '/employees/tasks')}
            className="text-xs font-medium px-2 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
            style={{ color: 'var(--text-secondary)' }}
          >
            Task Board &rarr;
          </button>
        </div>
        <div className="flex-1 min-w-0 min-h-0">
          <Suspense fallback={null}>
            <DecisionSupportView
              user={user}
              addNotification={addNotification}
              mode="ai_employee"
              activeWorkerId={selectedWorker?.id || null}
              activeWorkerLabel={selectedWorker?.name || null}
            />
          </Suspense>
        </div>
      </div>
    );
  }

  // Dashboard view
  return (
    <div className="h-full overflow-y-auto scrollbar-thin" style={{ backgroundColor: 'var(--surface-bg)' }}>
      <div className="max-w-5xl mx-auto px-4 md:px-8 py-8 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold tracking-widest uppercase text-indigo-500">DIGITAL WORKFORCE</p>
            <h1 className="text-2xl font-bold tracking-tight" style={{ color: 'var(--text-primary)' }}>
              Manager Console
            </h1>
          </div>
          <button
            onClick={() => {
              if (selectedWorker?.id) persistSelectedWorker(selectedWorker.id);
              setView('chat');
            }}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
          >
            <MessageSquare className="w-4 h-4" />
            {selectedWorker ? `Chat with ${selectedWorker.name}` : 'Open Chat'}
          </button>
        </div>

        {/* Quick Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <QuickStat icon={Users} label="Workers" value={stats.workerCount} accent="text-indigo-600" />
          <QuickStat icon={CheckCircle2} label="Completed" value={stats.totalCompleted} accent="text-emerald-600" />
          <QuickStat icon={Clock} label="Open Tasks" value={stats.totalOpen} accent="text-blue-600" />
          <QuickStat
            icon={BarChart3}
            label="On-Time %"
            value={stats.avgOnTime != null ? `${Math.round(stats.avgOnTime)}%` : '--'}
            accent="text-amber-600"
          />
        </div>

        {/* Review Alert */}
        {stats.totalReviewPending > 0 && (
          <button
            onClick={() => navigate('/employees/review')}
            className="w-full flex items-center gap-3 p-4 rounded-lg border-2 border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 text-left transition-colors hover:bg-amber-100 dark:hover:bg-amber-900/30"
          >
            <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                {stats.totalReviewPending} worker(s) awaiting review
              </p>
              <p className="text-xs text-amber-600 dark:text-amber-400">Click to open review queue</p>
            </div>
            <ArrowUpRight className="w-4 h-4 text-amber-600" />
          </button>
        )}

        {/* Approval Inbox */}
        {pendingApprovals.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                Approval Inbox ({pendingApprovals.length})
              </h2>
              {govStats && (
                <div className="flex gap-2 text-[10px]">
                  <span className="px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700">{govStats.approved} approved</span>
                  <span className="px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-900/40 text-red-700">{govStats.rejected} rejected</span>
                </div>
              )}
            </div>
            <div className="grid gap-2">
              {pendingApprovals.slice(0, 5).map((approval) => {
                const remaining = approval.expires_at ? new Date(approval.expires_at).getTime() - Date.now() : null;
                const isUrgent = remaining != null && remaining > 0 && remaining <= 4 * 3600000;
                const isCritical = remaining != null && remaining > 0 && remaining <= 3600000;
                const isExpired = remaining != null && remaining <= 0;

                return (
                  <div
                    key={approval.id}
                    className="flex items-center gap-3 p-3 rounded-lg border transition-colors hover:bg-[var(--surface-subtle)]"
                    style={{ borderColor: isUrgent ? 'var(--risk-warning)' : 'var(--border-default)' }}
                  >
                    <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                      isExpired ? 'bg-slate-400' : isCritical ? 'bg-red-500 animate-pulse' : isUrgent ? 'bg-amber-500' : 'bg-blue-500'
                    }`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{approval.title}</p>
                      <div className="flex items-center gap-2 text-[10px] text-slate-500">
                        <span className="uppercase">{(approval.type || '').replace(/_/g, ' ')}</span>
                        {remaining != null && !isExpired && (
                          <span className={isCritical ? 'text-red-600 font-medium' : isUrgent ? 'text-amber-600' : ''}>
                            {Math.floor(remaining / 3600000)}h {Math.floor((remaining % 3600000) / 60000)}m left
                          </span>
                        )}
                        {isExpired && <span className="text-slate-400">Expired</span>}
                      </div>
                    </div>
                    <button
                      onClick={() => navigate('/chat')}
                      className="text-xs px-2.5 py-1 rounded-md font-medium bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
                    >
                      Review
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Trust & Autonomy Dashboard */}
        {workers.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Trust & Autonomy</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {workers.map((w) => {
                const k = kpisMap[w.id];
                const trustScore = k ? Math.min(100, Math.round(
                  ((k.on_time_rate_pct ?? 50) * 0.4) +
                  ((k.review_pass_rate_pct ?? 50) * 0.3) +
                  (Math.min((k.tasks_completed ?? 0) * 2, 100) * 0.3)
                )) : 0;
                const autonomyLevel = trustScore >= 80 ? 'A3' : trustScore >= 60 ? 'A2' : trustScore >= 30 ? 'A1' : 'A0';
                const autonomyLabel = { A0: 'Manual', A1: 'Assisted', A2: 'Supervised', A3: 'Autonomous' }[autonomyLevel];

                return (
                  <Card key={w.id} className="!p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <Bot className="w-3.5 h-3.5 text-indigo-500" />
                      <span className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>{w.name}</span>
                    </div>
                    <div className="flex items-end gap-2 mb-1.5">
                      <span className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>{trustScore}</span>
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                        autonomyLevel === 'A3' ? 'bg-emerald-100 text-emerald-700'
                          : autonomyLevel === 'A2' ? 'bg-blue-100 text-blue-700'
                            : autonomyLevel === 'A1' ? 'bg-amber-100 text-amber-700'
                              : 'bg-slate-100 text-slate-600'
                      }`}>
                        {autonomyLevel}
                      </span>
                    </div>
                    <div className="w-full h-1.5 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          trustScore >= 80 ? 'bg-emerald-500' : trustScore >= 60 ? 'bg-blue-500' : trustScore >= 30 ? 'bg-amber-500' : 'bg-red-500'
                        }`}
                        style={{ width: `${trustScore}%` }}
                      />
                    </div>
                    <p className="text-[10px] text-slate-500 mt-1">{autonomyLabel}</p>
                  </Card>
                );
              })}
            </div>
          </div>
        )}

        {/* Performance Dashboard */}
        {Object.keys(perfDashboards).length > 0 && (
          <div className="space-y-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Performance Dashboard</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {workers.map((w) => {
                const perf = perfDashboards[w.id];
                if (!perf) return null;
                const m = perf.metrics;
                const trend = perf.trends;
                const trendIcon = trend?.direction === 'improving' ? '↑' : trend?.direction === 'declining' ? '↓' : '→';
                const trendColor = trend?.direction === 'improving' ? 'text-emerald-600' : trend?.direction === 'declining' ? 'text-red-500' : 'text-slate-400';

                return (
                  <Card key={w.id} className="!p-4">
                    {/* Header */}
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <Bot className="w-4 h-4 text-indigo-500" />
                        <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{w.name}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                          perf.autonomy_level === 'A4' ? 'bg-blue-100 text-blue-700'
                            : perf.autonomy_level === 'A3' ? 'bg-emerald-100 text-emerald-700'
                              : perf.autonomy_level === 'A2' ? 'bg-amber-100 text-amber-700'
                                : 'bg-slate-100 text-slate-600'
                        }`}>
                          {perf.autonomy_level} {perf.autonomy_label?.label || ''}
                        </span>
                        <span className={`text-xs font-medium ${trendColor}`}>{trendIcon}</span>
                      </div>
                    </div>

                    {/* Health Score */}
                    <div className="flex items-end gap-2 mb-3">
                      <div>
                        <p className="text-[10px] uppercase tracking-wide text-slate-500">Health Score</p>
                        <span className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{perf.health_score}</span>
                        <span className="text-xs text-slate-400">/100</span>
                      </div>
                      <div className="flex-1 ml-3">
                        <div className="w-full h-2 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${
                              perf.health_score >= 80 ? 'bg-emerald-500' : perf.health_score >= 60 ? 'bg-blue-500' : perf.health_score >= 40 ? 'bg-amber-500' : 'bg-red-500'
                            }`}
                            style={{ width: `${perf.health_score}%` }}
                          />
                        </div>
                      </div>
                    </div>

                    {/* Key Metrics Grid */}
                    {m && (
                      <div className="grid grid-cols-3 gap-2 text-center">
                        <div className="p-1.5 rounded bg-slate-50 dark:bg-slate-800/50">
                          <p className="text-[9px] text-slate-500">1st Pass</p>
                          <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                            {m.first_pass_acceptance_rate != null ? `${Math.round(m.first_pass_acceptance_rate * 100)}%` : '--'}
                          </p>
                        </div>
                        <div className="p-1.5 rounded bg-slate-50 dark:bg-slate-800/50">
                          <p className="text-[9px] text-slate-500">Avg Review</p>
                          <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                            {m.avg_review_score != null ? Math.round(m.avg_review_score) : '--'}
                          </p>
                        </div>
                        <div className="p-1.5 rounded bg-slate-50 dark:bg-slate-800/50">
                          <p className="text-[9px] text-slate-500">Replay</p>
                          <p className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                            {perf.replay_completeness?.avg_score ?? '--'}%
                          </p>
                        </div>
                      </div>
                    )}

                    {/* Autonomy by Task Type */}
                    {perf.autonomy_by_task_type && Object.keys(perf.autonomy_by_task_type).length > 0 && (
                      <div className="mt-3 pt-2 border-t" style={{ borderColor: 'var(--border-default)' }}>
                        <p className="text-[9px] text-slate-500 uppercase tracking-wide mb-1">Autonomy by Task Type</p>
                        <div className="flex flex-wrap gap-1">
                          {Object.entries(perf.autonomy_by_task_type).slice(0, 4).map(([wf, data]) => (
                            <span key={wf} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800">
                              <span className="text-slate-500">{wf}:</span>{' '}
                              <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{data.recommended_level}</span>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Workers List */}
          <div className="md:col-span-2 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Workers</h2>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowAddWorker(!showAddWorker)}
                  className="text-xs px-2 py-1 rounded-md font-medium bg-indigo-50 text-indigo-600 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:text-indigo-400 transition-colors"
                >
                  + Add Worker
                </button>
                <button
                  onClick={() => navigate('/employees')}
                  className="text-xs text-indigo-600 hover:text-indigo-700 font-medium"
                >
                  Manage &rarr;
                </button>
              </div>
            </div>

            {/* Add Worker Panel */}
            {showAddWorker && (
              <div className="p-3 rounded-lg border bg-slate-50 dark:bg-slate-800/50 space-y-2" style={{ borderColor: 'var(--border-default)' }}>
                <p className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>Select worker template:</p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {availableTemplates.map((tmpl) => (
                    <button
                      key={tmpl.id}
                      disabled={addingWorker}
                      onClick={async () => {
                        setAddingWorker(true);
                        try {
                          await createWorkerFromTemplate(user.id, tmpl.id);
                          setShowAddWorker(false);
                          loadData();
                        } catch (err) {
                          addNotification?.({ type: 'error', message: `Failed to create worker: ${err.message}` });
                        } finally {
                          setAddingWorker(false);
                        }
                      }}
                      className="flex items-center gap-2 p-2 rounded-lg border text-left transition-colors hover:bg-white dark:hover:bg-slate-700 disabled:opacity-50"
                      style={{ borderColor: 'var(--border-default)' }}
                    >
                      <div className="w-8 h-8 rounded-full bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center flex-shrink-0">
                        <Sparkles className="w-4 h-4 text-indigo-500" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>{tmpl.name}</p>
                        <p className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>
                          {(tmpl.role || '').replace(/_/g, ' ')}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {loading ? (
              <div className="flex items-center justify-center h-32">
                <div className="w-5 h-5 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : workers.length > 0 ? (
              <div className="space-y-2">
                {workers.map((w) => (
                  <WorkerRow
                    key={w.id}
                    worker={w}
                    kpis={kpisMap[w.id]}
                    onClick={() => openWorkerChat(w.id)}
                  />
                ))}
              </div>
            ) : (
              <Card className="!p-6 text-center">
                <Bot className="w-10 h-10 mx-auto mb-2 text-slate-300" />
                <p className="text-sm text-slate-500">No workers yet.</p>
                <button
                  onClick={() => navigate('/employees')}
                  className="mt-2 text-xs text-indigo-600 hover:underline"
                >
                  Create your first worker &rarr;
                </button>
              </Card>
            )}
          </div>

          {/* Sidebar: Activity + Quick Links */}
          <div className="space-y-4">
            {/* Recent Activity */}
            <Card className="!p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">Recent Activity</p>
              <ActivityFeed dailySummary={dailySummary} />
            </Card>

            {/* Quick Links */}
            <Card className="!p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">Quick Links</p>
              <div className="space-y-1.5">
                {[
                  { label: 'Task Board', icon: Clock, path: '/employees/tasks' },
                  { label: 'Review Queue', icon: CheckCircle2, path: '/employees/review' },
                  { label: 'Output Profiles', icon: FileText, path: '/output-profiles' },
                  { label: 'Tool Library', icon: Zap, path: '/tool-registry' },
                  { label: 'Trust & Autonomy', icon: Shield, path: '/employees' },
                ].map((link) => (
                  <button
                    key={link.path}
                    onClick={() => navigate(link.path)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-xs transition-colors hover:bg-slate-50 dark:hover:bg-slate-800"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    <link.icon className="w-3.5 h-3.5 text-slate-400" />
                    {link.label}
                    <ChevronRight className="w-3 h-3 ml-auto text-slate-300" />
                  </button>
                ))}
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
