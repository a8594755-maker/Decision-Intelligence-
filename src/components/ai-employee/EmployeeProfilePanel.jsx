// @product: ai-employee
// EmployeeProfilePanel — Right-side panel showing the digital worker's live status, current task, and daily KPIs.

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bot, CheckCircle2, Clock, AlertTriangle, Loader2,
  BarChart3, DollarSign, FileText, ArrowRight,
} from 'lucide-react';
import { getEmployee, getOrCreateWorker, listTasks } from '../../services/aiEmployee/queries.js';
import { getLatestSummary } from '../../services/dailySummaryService';
import { getEmployeeCostSummary } from '../../services/modelRoutingService';

const STATUS_STYLE = {
  idle:           { label: 'Idle',            dot: 'bg-slate-400',  text: 'text-slate-600 dark:text-slate-400' },
  working:        { label: 'Working',         dot: 'bg-blue-500 animate-pulse', text: 'text-blue-600 dark:text-blue-400' },
  waiting_review: { label: 'Awaiting Review', dot: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400' },
  blocked:        { label: 'Blocked',         dot: 'bg-red-500',   text: 'text-red-600 dark:text-red-400' },
};

export default function EmployeeProfilePanel({ userId, employeeId = null }) {
  const navigate = useNavigate();
  const [employee, setEmployee] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [kpis, setKpis] = useState(null);
  const [cost, setCost] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId && !employeeId) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const emp = employeeId
          ? await getEmployee(employeeId).catch(() => (userId ? getOrCreateWorker(userId) : null))
          : await getOrCreateWorker(userId);
        if (!emp) return;
        if (cancelled) return;
        setEmployee(emp);

        const [taskList, summary, costData] = await Promise.allSettled([
          listTasks(emp.id, { limit: 5 }),
          getLatestSummary(emp.id),
          getEmployeeCostSummary(emp.id),
        ]);
        if (cancelled) return;

        setTasks(taskList.status === 'fulfilled' ? taskList.value : []);
        setKpis(summary.status === 'fulfilled' ? summary.value : null);
        setCost(costData.status === 'fulfilled' ? costData.value : null);
      } catch {
        // silently fail — panel is supplementary
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    const interval = setInterval(load, 30000); // refresh every 30s
    return () => { cancelled = true; clearInterval(interval); };
  }, [userId, employeeId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-5 h-5 animate-spin text-indigo-400" />
      </div>
    );
  }

  if (!employee) {
    return (
      <div className="px-4 py-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
        No digital worker found.
      </div>
    );
  }

  const status = STATUS_STYLE[employee.status] || STATUS_STYLE.idle;
  const activeTasks = tasks.filter((t) => t.status === 'in_progress');
  const pendingReview = tasks.filter((t) => t.status === 'review_hold');

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* ── Avatar + Status ── */}
      <div className="flex items-center gap-3">
        <div className="w-12 h-12 rounded-full bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center">
          <Bot className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
            {employee.name || 'Digital Worker'}
          </p>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className={`w-2 h-2 rounded-full ${status.dot}`} />
            <span className={`text-xs font-medium ${status.text}`}>{status.label}</span>
          </div>
        </div>
      </div>

      {/* ── Quick KPI tiles ── */}
      <div className="grid grid-cols-2 gap-2">
        <KpiTile
          icon={CheckCircle2}
          label="Completed"
          value={kpis?.tasks_completed ?? tasks.filter((t) => t.status === 'done').length}
          color="text-emerald-600"
        />
        <KpiTile
          icon={Clock}
          label="In Queue"
          value={activeTasks.length}
          color="text-blue-600"
        />
        <KpiTile
          icon={AlertTriangle}
          label="Needs Review"
          value={pendingReview.length}
          color="text-amber-600"
        />
        <KpiTile
          icon={DollarSign}
          label="Today Cost"
          value={cost?.today_cost != null ? `$${cost.today_cost.toFixed(3)}` : '--'}
          color="text-slate-600"
        />
      </div>

      {/* ── Current task ── */}
      {activeTasks.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)' }}>
            Active Tasks
          </p>
          <div className="flex flex-col gap-1.5">
            {activeTasks.slice(0, 3).map((task) => (
              <button
                key={task.id}
                onClick={() => navigate(employee ? `/employees/tasks?worker=${employee.id}` : '/employees/tasks')}
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-colors hover:bg-[var(--surface-subtle)]"
              >
                {task.status === 'in_progress'
                  ? <Loader2 className="w-3.5 h-3.5 text-blue-500 animate-spin flex-shrink-0" />
                  : <Clock className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />}
                <span className="text-sm truncate flex-1" style={{ color: 'var(--text-primary)' }}>
                  {task.title}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Pending reviews ── */}
      {pendingReview.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)' }}>
            Awaiting Your Review
          </p>
          <div className="flex flex-col gap-1.5">
            {pendingReview.slice(0, 3).map((task) => (
              <button
                key={task.id}
                onClick={() => navigate('/employees/review')}
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-colors hover:bg-amber-50 dark:hover:bg-amber-900/10"
              >
                <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                <span className="text-sm truncate flex-1" style={{ color: 'var(--text-primary)' }}>
                  {task.title}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Quick links ── */}
      <div className="flex flex-col gap-1 mt-2 pt-3 border-t" style={{ borderColor: 'var(--border-default)' }}>
        <QuickLink icon={FileText} label="View all tasks" onClick={() => navigate(employee ? `/employees/tasks?worker=${employee.id}` : '/employees/tasks')} />
        <QuickLink icon={BarChart3} label="Performance" onClick={() => navigate('/employees')} />
      </div>
    </div>
  );
}

function KpiTile(props) {
  const { icon: Icon, label, value, color } = props;
  return (
    <div
      className="flex flex-col gap-0.5 p-2.5 rounded-lg"
      style={{ backgroundColor: 'var(--surface-subtle)' }}
    >
      <div className="flex items-center gap-1">
        <Icon className={`w-3 h-3 ${color}`} />
        <span className="text-[10px] uppercase tracking-wider font-medium" style={{ color: 'var(--text-muted)' }}>
          {label}
        </span>
      </div>
      <span className={`text-lg font-bold ${color}`}>{value ?? '--'}</span>
    </div>
  );
}

function QuickLink(props) {
  const { icon: Icon, label, onClick } = props;
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors hover:bg-[var(--surface-subtle)]"
      style={{ color: 'var(--text-secondary)' }}
    >
      <Icon className="w-3.5 h-3.5" />
      <span className="flex-1 text-left">{label}</span>
      <ArrowRight className="w-3 h-3" style={{ color: 'var(--text-muted)' }} />
    </button>
  );
}
