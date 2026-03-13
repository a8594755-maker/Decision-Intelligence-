// @product: ai-employee
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot, CheckCircle2, Clock, AlertTriangle, BarChart3, ChevronRight, Plus, FileText, DollarSign } from 'lucide-react';
import { Card } from '../components/ui';
import { useAuth } from '../contexts/AuthContext';
import * as aiEmployeeService from '../services/aiEmployeeService';
import { getLatestSummary } from '../services/dailySummaryService';
import { getEmployeeCostSummary } from '../services/modelRoutingService';

// ── Status badge ──────────────────────────────────────────────────────────

const STATUS_CONFIG = {
  idle:           { label: 'Idle',           color: 'text-slate-500 bg-slate-100 dark:bg-slate-800' },
  working:        { label: 'Working',        color: 'text-blue-600  bg-blue-50   dark:bg-blue-900/20' },
  waiting_review: { label: 'Awaiting Review',color: 'text-amber-600 bg-amber-50  dark:bg-amber-900/20' },
  blocked:        { label: 'Blocked',        color: 'text-red-600   bg-red-50    dark:bg-red-900/20' },
};

function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.idle;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${cfg.color}`}>
      {cfg.label}
    </span>
  );
}

// ── KPI tile ──────────────────────────────────────────────────────────────

function KpiTile({ label, value, icon: Icon, color = 'text-slate-700 dark:text-slate-300' }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5">
        <Icon className={`w-3.5 h-3.5 ${color}`} />
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{label}</span>
      </div>
      <span className={`text-lg font-semibold ${color}`}>
        {value ?? '—'}
      </span>
    </div>
  );
}

// ── Employee card ─────────────────────────────────────────────────────────

function EmployeeCard({ employee, kpis, onViewTasks }) {
  return (
    <Card variant="elevated" className="p-6 flex flex-col gap-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center flex-shrink-0">
            <Bot className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
          </div>
          <div>
            <p className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
              {employee.name}
            </p>
            <p className="text-xs capitalize" style={{ color: 'var(--text-muted)' }}>
              {(employee.role || 'employee').replace(/_/g, ' ')}
            </p>
          </div>
        </div>
        <StatusBadge status={employee.status} />
      </div>

      {/* Description */}
      {employee.description && (
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          {employee.description}
        </p>
      )}

      {/* KPI grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-2 border-t" style={{ borderColor: 'var(--border-default)' }}>
        <KpiTile
          label="Tasks Done"
          value={kpis?.tasks_completed ?? 0}
          icon={CheckCircle2}
          color="text-emerald-600"
        />
        <KpiTile
          label="Open Tasks"
          value={kpis?.tasks_open ?? 0}
          icon={Clock}
          color="text-blue-600"
        />
        <KpiTile
          label="On-Time %"
          value={kpis?.on_time_rate_pct != null ? `${kpis.on_time_rate_pct}%` : '—'}
          icon={BarChart3}
          color="text-indigo-600"
        />
        <KpiTile
          label="Review Pass %"
          value={kpis?.review_pass_rate_pct != null ? `${kpis.review_pass_rate_pct}%` : '—'}
          icon={AlertTriangle}
          color="text-amber-600"
        />
      </div>

      {/* Footer actions */}
      <div className="flex gap-2 pt-1">
        <button
          onClick={onViewTasks}
          className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
        >
          View Tasks
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </Card>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function EmployeesPage() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [employee, setEmployee] = useState(null);
  const [kpis, setKpis] = useState(null);
  const [dailySummary, setDailySummary] = useState(null);
  const [costData, setCostData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const emp = await aiEmployeeService.getOrCreateAiden(user.id);
        if (cancelled) return;
        setEmployee(emp);

        const k = await aiEmployeeService.getKpis(emp.id);
        if (!cancelled) setKpis(k);

        // Phase 3: daily summary + cost (best-effort)
        try {
          const summary = await getLatestSummary(emp.id);
          if (!cancelled) setDailySummary(summary);
        } catch { /* */ }
        try {
          const cost = await getEmployeeCostSummary(emp.id, { days: 7 });
          if (!cancelled) setCostData(cost);
        } catch { /* */ }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [user?.id]);

  return (
    <div className="h-full flex flex-col" style={{ backgroundColor: 'var(--surface-bg)' }}>
      {/* ── Header ── */}
      <div
        className="h-14 flex items-center justify-between px-6 flex-shrink-0 border-b"
        style={{ backgroundColor: 'var(--surface-card)', borderColor: 'var(--border-default)' }}
      >
        <div className="flex items-center gap-2.5">
          <Bot className="w-5 h-5 text-indigo-600" />
          <span className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
            AI Employees
          </span>
        </div>
        <button
          onClick={() => navigate('/employees/tasks')}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          New Task
        </button>
      </div>

      {/* ── Content ── */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <div className="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : employee ? (
          <div className="max-w-2xl">
            <EmployeeCard
              employee={employee}
              kpis={kpis}
              onViewTasks={() => navigate('/employees/tasks')}
            />

            {/* Daily Summary + Cost cards */}
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Daily Summary */}
              <Card variant="elevated" className="p-4">
                <div className="flex items-center gap-2 mb-3">
                  <FileText className="w-4 h-4 text-blue-500" />
                  <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>Daily Summary</span>
                </div>
                {dailySummary ? (
                  <div className="space-y-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
                    <p>{dailySummary.tasks_completed ?? 0} completed, {dailySummary.tasks_failed ?? 0} failed, {dailySummary.tasks_in_progress ?? 0} in progress</p>
                    {dailySummary.highlights?.map((h, i) => (
                      <p key={i} className="text-emerald-600">{h}</p>
                    ))}
                    {dailySummary.issues?.map((issue, i) => (
                      <p key={i} className="text-red-600">{issue}</p>
                    ))}
                    <p className="pt-1" style={{ color: 'var(--text-muted)' }}>
                      {dailySummary.date}
                    </p>
                  </div>
                ) : (
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>No summary available yet.</p>
                )}
              </Card>

              {/* 7-Day Cost */}
              <Card variant="elevated" className="p-4">
                <div className="flex items-center gap-2 mb-3">
                  <DollarSign className="w-4 h-4 text-emerald-500" />
                  <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>7-Day Cost</span>
                </div>
                {costData ? (
                  <div className="space-y-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
                    <p className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
                      ${costData.total_cost?.toFixed(4) ?? '0.0000'}
                    </p>
                    <p>{costData.total_calls ?? 0} model calls</p>
                    {costData.by_tier && Object.entries(costData.by_tier).map(([tier, data]) => (
                      <p key={tier}>
                        {tier}: ${data.cost?.toFixed(4)} ({data.calls} calls)
                      </p>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>No cost data yet.</p>
                )}
              </Card>
            </div>

            {/* Quick links */}
            <div className="mt-4 grid grid-cols-2 gap-3">
              <button
                onClick={() => navigate('/employees/tasks')}
                className="flex items-center gap-2 p-4 rounded-lg border text-sm font-medium transition-colors hover:bg-[var(--surface-subtle)]"
                style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
              >
                <Clock className="w-4 h-4 text-blue-500" />
                Task Board
              </button>
              <button
                onClick={() => navigate('/employees/review')}
                className="flex items-center gap-2 p-4 rounded-lg border text-sm font-medium transition-colors hover:bg-[var(--surface-subtle)]"
                style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
              >
                <CheckCircle2 className="w-4 h-4 text-amber-500" />
                Review Queue
                {(kpis?.tasks_open ?? 0) > 0 && (
                  <span className="ml-auto px-1.5 py-0.5 text-xs rounded-full bg-amber-100 text-amber-700 font-medium">
                    {kpis.tasks_open}
                  </span>
                )}
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            No AI employees found.
          </p>
        )}
      </div>
    </div>
  );
}
