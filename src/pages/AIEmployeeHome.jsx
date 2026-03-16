/**
 * AI Employee Home — Manager Console Dashboard
 *
 * Unified dashboard for managers to:
 *   - View all workers and their statuses
 *   - Track team KPIs and performance trends
 *   - Manage task assignments and approvals
 *   - Quick-access to chat interface
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bot, MessageSquare, CheckCircle2, Clock, AlertTriangle, BarChart3,
  ChevronRight, Users, Zap, TrendingUp, FileText, ArrowUpRight,
  Shield, Activity
} from 'lucide-react';
import { Card } from '../components/ui';
import { useAuth } from '../contexts/AuthContext';
import { listEmployeesByManager, getKpis } from '../services/aiEmployee/queries.js';
import { getLatestSummary } from '../services/dailySummaryService';
import DecisionSupportView from '../views/DecisionSupportView';

// ── Quick Stats Card ────────────────────────────────────────────────────────

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

  const loadData = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    try {
      const [emps, summary] = await Promise.all([
        listEmployeesByManager(user.id).catch(() => []),
        getLatestSummary(user.id).catch(() => null),
      ]);

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
      }
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => { loadData(); }, [loadData]);

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
        <div className="h-10 flex items-center px-4 border-b flex-shrink-0" style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)' }}>
          <button
            onClick={() => setView('dashboard')}
            className="text-xs font-medium px-2 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            style={{ color: 'var(--text-secondary)' }}
          >
            &larr; Dashboard
          </button>
        </div>
        <div className="flex-1 min-w-0 min-h-0">
          <DecisionSupportView user={user} addNotification={addNotification} mode="ai_employee" />
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
            <p className="text-xs font-semibold tracking-widest uppercase text-indigo-500">AI WORKFORCE</p>
            <h1 className="text-2xl font-bold tracking-tight" style={{ color: 'var(--text-primary)' }}>
              Manager Console
            </h1>
          </div>
          <button
            onClick={() => setView('chat')}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
          >
            <MessageSquare className="w-4 h-4" />
            Open Chat
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

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Workers List */}
          <div className="md:col-span-2 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Workers</h2>
              <button
                onClick={() => navigate('/employees')}
                className="text-xs text-indigo-600 hover:text-indigo-700 font-medium"
              >
                Manage &rarr;
              </button>
            </div>

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
                    onClick={() => navigate('/employees/tasks')}
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
