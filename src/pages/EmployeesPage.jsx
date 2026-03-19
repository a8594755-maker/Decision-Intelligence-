// @product: ai-employee
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot, CheckCircle2, Clock, AlertTriangle, BarChart3, ChevronRight, Plus, FileText, DollarSign, ShieldCheck, Shield, XCircle, Timer } from 'lucide-react';
import { Card, Modal } from '../components/ui';
import { useAuth } from '../contexts/AuthContext';
import { getOrCreateWorker, listEmployeesByManager, getKpis, WORKER_TEMPLATES, listTemplatesFromDB } from '../services/aiEmployee/queries.js';
import { getEmployeeCostSummary } from '../services/modelRoutingService';
import { getLatestMetrics } from '../services/aiEmployee/styleLearning/trustMetricsService';

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

// ── Autonomy badge ───────────────────────────────────────────────────────

const AUTONOMY_CONFIG = {
  A1: { label: 'A1 · Learning',    color: 'text-slate-500 bg-slate-100' },
  A2: { label: 'A2 · Guided',      color: 'text-blue-600 bg-blue-50' },
  A3: { label: 'A3 · Autonomous',  color: 'text-emerald-600 bg-emerald-50' },
  A4: { label: 'A4 · Trusted',     color: 'text-purple-600 bg-purple-50' },
};

function AutonomyBadge({ level }) {
  const cfg = AUTONOMY_CONFIG[level] || AUTONOMY_CONFIG.A1;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${cfg.color}`}>
      {cfg.label}
    </span>
  );
}

// ── KPI tile ──────────────────────────────────────────────────────────────

function KpiTile(props) {
  const { label, value, icon: Icon, color = 'text-slate-700 dark:text-slate-300' } = props;
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

function EmployeeCard({ employee, kpis, cost, trust, onViewTasks }) {
  const templateEntry = Object.values(WORKER_TEMPLATES).find((t) => t.role === employee.role);
  const iconKey = templateEntry?.icon;
  const iconClassName = "w-5 h-5 text-indigo-600 dark:text-indigo-400";

  return (
    <Card variant="elevated" className="p-6 flex flex-col gap-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center flex-shrink-0">
            {iconKey === 'bar-chart' ? <BarChart3 className={iconClassName} />
              : iconKey === 'file-text' ? <FileText className={iconClassName} />
              : iconKey === 'shield-check' ? <ShieldCheck className={iconClassName} />
              : <Bot className={iconClassName} />}
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
        <div className="flex items-center gap-1.5">
          <StatusBadge status={employee.status} />
          <AutonomyBadge level={trust?.autonomy_level} />
        </div>
      </div>

      {/* Description */}
      {employee.description && (
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          {employee.description}
        </p>
      )}

      {/* KPI grid */}
      <div className="grid grid-cols-4 sm:grid-cols-8 gap-3 pt-2 border-t" style={{ borderColor: 'var(--border-default)' }}>
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
          label="Overdue"
          value={kpis?.tasks_overdue ?? 0}
          icon={XCircle}
          color="text-red-600"
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
        <KpiTile
          label="Revisions"
          value={kpis?.reviews_revised ?? 0}
          icon={Timer}
          color="text-orange-600"
        />
        <KpiTile
          label="Cost"
          value={cost?.total_cost != null ? `$${cost.total_cost.toFixed(2)}` : '—'}
          icon={DollarSign}
          color="text-slate-600"
        />
        <KpiTile
          label="Autonomy"
          value={trust?.autonomy_level ?? '—'}
          icon={Shield}
          color="text-purple-600"
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

// ── Create Worker Modal ───────────────────────────────────────────────────

function CreateWorkerModal({ onClose, onCreated, existingRoles }) {
  const [templates, setTemplates] = useState([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingTemplates(true);
      try {
        // Fetch DB-backed templates, merged with hardcoded ones
        const dbTemplates = await listTemplatesFromDB();
        if (cancelled) return;

        // Merge: DB templates keyed by id take precedence over hardcoded
        const merged = new Map();
        for (const [id, tmpl] of Object.entries(WORKER_TEMPLATES)) {
          merged.set(id, { ...tmpl, id });
        }
        for (const tmpl of dbTemplates) {
          merged.set(tmpl.id, {
            ...merged.get(tmpl.id),
            ...tmpl,
            // Prefer allowed_capabilities from DB, fall back to capabilities
            capabilities: tmpl.allowed_capabilities || tmpl.capabilities || [],
          });
        }
        setTemplates(Array.from(merged.values()));
      } catch {
        // Fallback to hardcoded templates
        setTemplates(Object.entries(WORKER_TEMPLATES).map(([id, t]) => ({ ...t, id })));
      } finally {
        if (!cancelled) setLoadingTemplates(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const filteredTemplates = templates.filter(
    (tmpl) => !existingRoles.includes(tmpl.role || tmpl.id)
  );

  if (loadingTemplates) {
    return (
      <Modal isOpen onClose={onClose} title="Create Worker">
        <div className="p-6 flex items-center justify-center">
          <div className="w-5 h-5 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
        </div>
      </Modal>
    );
  }

  if (filteredTemplates.length === 0) {
    return (
      <Modal isOpen onClose={onClose} title="Create Worker">
        <div className="p-6 text-center">
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            All available worker types have already been created.
          </p>
          <button
            onClick={onClose}
            className="mt-4 px-4 py-2 rounded-lg text-sm border transition-colors hover:bg-[var(--surface-subtle)]"
            style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
          >
            Close
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal isOpen onClose={onClose} title="Create Worker">
      <div className="p-4 space-y-3">
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Choose a worker template. Each worker type can only be created once.
        </p>
        {filteredTemplates.map((tmpl) => {
          const tmplIconKey = tmpl.icon;
          const tmplIconCls = "w-5 h-5 text-indigo-600 dark:text-indigo-400";
          const caps = tmpl.allowed_capabilities || tmpl.capabilities || [];
          return (
            <button
              key={tmpl.id}
              onClick={() => onCreated(tmpl.id)}
              className="w-full flex items-start gap-3 p-4 rounded-lg border text-left transition-colors hover:bg-[var(--surface-subtle)]"
              style={{ borderColor: 'var(--border-default)' }}
            >
              <div className="w-10 h-10 rounded-full bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center flex-shrink-0">
                {tmplIconKey === 'bar-chart' ? <BarChart3 className={tmplIconCls} />
                  : tmplIconKey === 'file-text' ? <FileText className={tmplIconCls} />
                  : tmplIconKey === 'shield-check' ? <ShieldCheck className={tmplIconCls} />
                  : <Bot className={tmplIconCls} />}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                  {tmpl.name}
                  {tmpl._source === 'db' && (
                    <span className="ml-1.5 px-1 py-0.5 text-[9px] rounded bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20">
                      DB
                    </span>
                  )}
                </p>
                <p className="text-xs capitalize" style={{ color: 'var(--text-muted)' }}>
                  {(tmpl.role || tmpl.id).replace(/_/g, ' ')}
                </p>
                <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
                  {tmpl.description}
                </p>
                <div className="flex flex-wrap gap-1 mt-2">
                  {caps.map((cap) => (
                    <span
                      key={cap}
                      className="px-1.5 py-0.5 text-[10px] rounded bg-indigo-50 text-indigo-600 dark:bg-indigo-900/20"
                    >
                      {cap}
                    </span>
                  ))}
                </div>
              </div>
              <ChevronRight className="w-4 h-4 flex-shrink-0 mt-3" style={{ color: 'var(--text-muted)' }} />
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

// ── Team Performance Summary ─────────────────────────────────────────────

function TeamPerformanceSummary({ workers, kpisMap, costsMap, trustMap = {} }) {
  if (workers.length === 0) return null;

  // Aggregate KPIs across all workers
  let totalCompleted = 0;
  let totalOpen = 0;
  let totalOverdue = 0;
  let onTimeSum = 0;
  let onTimeCount = 0;
  let reviewPassSum = 0;
  let reviewPassCount = 0;
  let totalCost = 0;

  for (const w of workers) {
    const k = kpisMap[w.id];
    if (k) {
      totalCompleted += k.tasks_completed ?? 0;
      totalOpen += k.tasks_open ?? 0;
      totalOverdue += k.tasks_overdue ?? 0;
      if (k.on_time_rate_pct != null) { onTimeSum += k.on_time_rate_pct; onTimeCount++; }
      if (k.review_pass_rate_pct != null) { reviewPassSum += k.review_pass_rate_pct; reviewPassCount++; }
    }
    const c = costsMap[w.id];
    if (c?.total_cost) totalCost += c.total_cost;
  }

  const avgOnTime = onTimeCount ? Math.round(onTimeSum / onTimeCount) : null;
  const avgReviewPass = reviewPassCount ? Math.round(reviewPassSum / reviewPassCount) : null;
  const costPerTask = totalCompleted > 0 ? (totalCost / totalCompleted).toFixed(2) : null;

  // Compute average autonomy level
  const autonomyNumeric = { A1: 1, A2: 2, A3: 3, A4: 4 };
  let autonomySum = 0;
  let autonomyCount = 0;
  for (const w of workers) {
    const t = trustMap[w.id];
    if (t?.autonomy_level && autonomyNumeric[t.autonomy_level] != null) {
      autonomySum += autonomyNumeric[t.autonomy_level];
      autonomyCount++;
    }
  }
  const avgAutonomy = autonomyCount > 0
    ? `A${Math.round(autonomySum / autonomyCount)}`
    : '—';

  const tiles = [
    { label: 'Total Completed', value: totalCompleted, icon: CheckCircle2, color: 'text-emerald-600' },
    { label: 'Open Tasks', value: totalOpen, icon: Clock, color: 'text-blue-600' },
    { label: 'Overdue', value: totalOverdue, icon: XCircle, color: 'text-red-600' },
    { label: 'Avg On-Time %', value: avgOnTime != null ? `${avgOnTime}%` : '—', icon: BarChart3, color: 'text-indigo-600' },
    { label: 'Avg Review Pass %', value: avgReviewPass != null ? `${avgReviewPass}%` : '—', icon: AlertTriangle, color: 'text-amber-600' },
    { label: 'Total Cost', value: totalCost > 0 ? `$${totalCost.toFixed(2)}` : '—', icon: DollarSign, color: 'text-slate-600' },
    { label: 'Cost / Task', value: costPerTask ? `$${costPerTask}` : '—', icon: DollarSign, color: 'text-slate-600' },
    { label: 'Avg Autonomy', value: avgAutonomy, icon: Shield, color: 'text-purple-600' },
  ];

  return (
    <Card variant="elevated" className="p-5 mb-4">
      <p className="text-xs font-semibold uppercase tracking-wide mb-3" style={{ color: 'var(--text-muted)' }}>
        Team Performance
      </p>
      <div className="grid grid-cols-4 sm:grid-cols-8 gap-3">
        {tiles.map((t) => (
          <KpiTile key={t.label} label={t.label} value={t.value} icon={t.icon} color={t.color} />
        ))}
      </div>
    </Card>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function EmployeesPage() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [workers, setWorkers] = useState([]);
  const [kpisMap, setKpisMap] = useState({});
  const [costsMap, setCostsMap] = useState({});
  const [trustMap, setTrustMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);

  const loadWorkers = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    try {
      let emps = await listEmployeesByManager(user.id);

      // Auto-create default worker if none exist
      if (emps.length === 0) {
        await getOrCreateWorker(user.id);
        emps = await listEmployeesByManager(user.id);
      }

      setWorkers(emps);

      // Load KPIs + costs + trust metrics for each worker (best-effort, parallel)
      const [kpiResults, costResults, trustResults] = await Promise.all([
        Promise.all(
          emps.map(async (emp) => {
            try {
              return { id: emp.id, kpis: await getKpis(emp.id) };
            } catch {
              return { id: emp.id, kpis: null };
            }
          })
        ),
        Promise.all(
          emps.map(async (emp) => {
            try {
              return { id: emp.id, cost: await getEmployeeCostSummary(emp.id) };
            } catch {
              return { id: emp.id, cost: null };
            }
          })
        ),
        Promise.all(
          emps.map(async (emp) => {
            try {
              return { id: emp.id, trust: await getLatestMetrics(emp.id) };
            } catch {
              return { id: emp.id, trust: null };
            }
          })
        ),
      ]);

      const kMap = {};
      for (const r of kpiResults) kMap[r.id] = r.kpis;
      setKpisMap(kMap);

      const cMap = {};
      for (const r of costResults) cMap[r.id] = r.cost;
      setCostsMap(cMap);

      const tMap = {};
      for (const r of trustResults) tMap[r.id] = r.trust;
      setTrustMap(tMap);
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => { loadWorkers(); }, [loadWorkers]);

  async function handleCreateWorker(templateId) {
    if (!user?.id || creating) return;
    setCreating(true);
    try {
      await getOrCreateWorker(user.id, templateId);
      setShowCreate(false);
      await loadWorkers();
    } finally {
      setCreating(false);
    }
  }

  const existingRoles = workers.map((w) => w.role);

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
            Digital Workers
          </span>
          {workers.length > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-600 dark:bg-indigo-900/20">
              {workers.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate('/employees/tasks')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors hover:bg-[var(--surface-subtle)]"
            style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
          >
            <Clock className="w-3.5 h-3.5" />
            Task Board
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Create Worker
          </button>
        </div>
      </div>

      {/* ── Content ── */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <div className="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : workers.length > 0 ? (
          <div className="max-w-3xl space-y-4">
            {/* Team-level performance summary */}
            <TeamPerformanceSummary workers={workers} kpisMap={kpisMap} costsMap={costsMap} trustMap={trustMap} />

            {workers.map((emp) => (
              <EmployeeCard
                key={emp.id}
                employee={emp}
                kpis={kpisMap[emp.id]}
                cost={costsMap[emp.id]}
                trust={trustMap[emp.id]}
                onViewTasks={() => navigate(`/employees/tasks?worker=${emp.id}`)}
              />
            ))}

            {/* Quick links */}
            <div className="grid grid-cols-2 gap-3 pt-2">
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
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-48 gap-4">
            <Bot className="w-12 h-12 text-indigo-300" />
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              No digital workers yet. Create your first one.
            </p>
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
            >
              <Plus className="w-4 h-4" />
              Create Worker
            </button>
          </div>
        )}
      </div>

      {/* ── Create Worker Modal ── */}
      {showCreate && (
        <CreateWorkerModal
          onClose={() => setShowCreate(false)}
          onCreated={handleCreateWorker}
          existingRoles={existingRoles}
        />
      )}
    </div>
  );
}
