// @product: ai-employee
import { useState, useEffect, useCallback } from 'react';
import {
  Plus, RefreshCw, Play, ChevronRight, Clock, CheckCircle2,
  AlertTriangle, Loader2, FileText, CalendarDays, Tag, Bell,
  Calendar, Pause, PlayCircle, Trash2, Zap,
} from 'lucide-react';
import { Card, Modal, Select } from '../components/ui';
import { useAuth } from '../contexts/AuthContext';
import * as aiEmployeeService from '../services/aiEmployeeService';
import { executeTaskWithLoop } from '../services/aiEmployeeExecutor';
import { TEMPLATE_OPTIONS } from '../services/agentLoopTemplates';
import { STEP_STATUS } from '../services/agentLoopService';
import { getNotifications, getUnreadCount, markAllRead } from '../services/notificationService';
import { getSchedules, createSchedule, pauseSchedule, resumeSchedule, deleteSchedule, SCHEDULE_TYPES } from '../services/scheduledTaskService';

// ── Constants ─────────────────────────────────────────────────────────────

const STATUS_FILTERS = [
  { value: '',               label: 'All' },
  { value: 'todo',           label: 'To Do' },
  { value: 'in_progress',   label: 'In Progress' },
  { value: 'waiting_review',label: 'Awaiting Review' },
  { value: 'blocked',       label: 'Blocked' },
  { value: 'done',          label: 'Done' },
];

const PRIORITY_OPTIONS = [
  { value: 'low',    label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high',   label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];

const WORKFLOW_OPTIONS = TEMPLATE_OPTIONS;

const STATUS_STYLE = {
  todo:           'text-slate-500  bg-slate-100  dark:bg-slate-800',
  in_progress:   'text-blue-600   bg-blue-50    dark:bg-blue-900/20',
  waiting_review:'text-amber-600  bg-amber-50   dark:bg-amber-900/20',
  blocked:       'text-red-600    bg-red-50     dark:bg-red-900/20',
  done:          'text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20',
};

const STATUS_LABEL = {
  todo: 'To Do', in_progress: 'In Progress', waiting_review: 'Awaiting Review',
  blocked: 'Blocked', done: 'Done',
};

const PRIORITY_STYLE = {
  low:    'text-slate-500 bg-slate-100',
  medium: 'text-blue-600  bg-blue-50',
  high:   'text-orange-600 bg-orange-50',
  urgent: 'text-red-600   bg-red-50',
};

// ── Helpers ───────────────────────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtTime(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function Badge({ label, className }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${className}`}>
      {label}
    </span>
  );
}

// ── New Task Modal ────────────────────────────────────────────────────────

function NewTaskModal({ onClose, onCreated, employeeId, userId }) {
  const [form, setForm] = useState({
    title: '',
    description: '',
    priority: 'medium',
    template_id: 'plan',
    dataset_profile_id: '',
    due_at: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  function set(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    console.log('[NewTask] submit fired — employeeId:', employeeId, 'form:', form);
    if (!employeeId) { setError('Employee not loaded yet — please wait a moment and try again.'); return; }
    if (!form.title.trim()) { setError('Title is required.'); return; }
    if (!form.dataset_profile_id.trim()) { setError('Dataset profile ID is required.'); return; }

    setSaving(true);
    setError(null);
    try {
      // Determine if this is a composite template or single-step
      const isComposite = WORKFLOW_OPTIONS.find((o) => o.value === form.template_id)?.composite;
      const task = await aiEmployeeService.createTask(employeeId, {
        title: form.title.trim(),
        description: form.description.trim() || null,
        priority: form.priority,
        input_context: {
          workflow_type: isComposite ? form.template_id : form.template_id,
          template_id: form.template_id,
          dataset_profile_id: form.dataset_profile_id.trim(),
        },
        due_at: form.due_at ? new Date(form.due_at).toISOString() : null,
        assigned_by_user_id: userId,
      });
      console.log('[NewTask] createTask result:', task);
      onCreated(task);
    } catch (err) {
      console.error('[NewTask] createTask error:', err);
      setError(err?.message || 'Failed to create task.');
    } finally {
      setSaving(false);
    }
  }

  const inputCls = 'w-full px-3 py-2 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500';
  const inputStyle = { borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-bg)', color: 'var(--text-primary)' };

  return (
    <Modal isOpen onClose={onClose} title="New Task">
      <form onSubmit={handleSubmit} className="space-y-4 p-1">
        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Title *</label>
          <input
            className={inputCls}
            style={inputStyle}
            value={form.title}
            onChange={(e) => set('title', e.target.value)}
            placeholder="e.g. Weekly replenishment plan for SKU-A"
            autoFocus
          />
        </div>

        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Description</label>
          <textarea
            className={`${inputCls} resize-none`}
            style={inputStyle}
            rows={2}
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder="What should Aiden focus on?"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Priority</label>
            <select
              className={inputCls}
              style={inputStyle}
              value={form.priority}
              onChange={(e) => set('priority', e.target.value)}
            >
              {PRIORITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Task Type</label>
            <select
              className={inputCls}
              style={inputStyle}
              value={form.template_id}
              onChange={(e) => set('template_id', e.target.value)}
            >
              <optgroup label="Multi-Step">
                {WORKFLOW_OPTIONS.filter((o) => o.composite).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </optgroup>
              <optgroup label="Single Analysis">
                {WORKFLOW_OPTIONS.filter((o) => !o.composite).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </optgroup>
            </select>
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
            Dataset Profile ID *
          </label>
          <input
            className={inputCls}
            style={inputStyle}
            value={form.dataset_profile_id}
            onChange={(e) => set('dataset_profile_id', e.target.value)}
            placeholder="Paste dataset profile UUID"
          />
        </div>

        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Due Date</label>
          <input
            type="date"
            className={inputCls}
            style={inputStyle}
            value={form.due_at}
            onChange={(e) => set('due_at', e.target.value)}
          />
        </div>

        {error && (
          <p className="text-xs text-red-600">{error}</p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm border transition-colors hover:bg-[var(--surface-subtle)]"
            style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Creating…' : 'Create Task'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Task list item ────────────────────────────────────────────────────────

function TaskListItem({ task, isSelected, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors flex items-start gap-2 ${
        isSelected
          ? 'bg-indigo-50 dark:bg-indigo-900/20'
          : 'hover:bg-[var(--surface-subtle)]'
      }`}
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
          {task.title}
        </p>
        <div className="flex items-center gap-1.5 mt-1">
          <Badge label={STATUS_LABEL[task.status] || task.status} className={STATUS_STYLE[task.status] || ''} />
          <Badge label={task.priority} className={PRIORITY_STYLE[task.priority] || ''} />
          {task.source_type === 'scheduled' && (
            <Badge label="auto" className="text-purple-600 bg-purple-50 dark:bg-purple-900/20" />
          )}
        </div>
      </div>
      {isSelected && <ChevronRight className="w-4 h-4 text-indigo-400 flex-shrink-0 mt-0.5" />}
    </button>
  );
}

// ── Worklog entry ─────────────────────────────────────────────────────────

function WorklogEntry({ entry }) {
  const icons = {
    task_update: <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />,
    escalation:  <AlertTriangle className="w-3.5 h-3.5 text-red-500" />,
    daily_summary: <FileText className="w-3.5 h-3.5 text-blue-500" />,
    retrospective: <FileText className="w-3.5 h-3.5 text-purple-500" />,
  };
  const note = entry.content?.note || entry.content?.issue || JSON.stringify(entry.content).slice(0, 80);
  return (
    <div className="flex items-start gap-2 py-1.5">
      <div className="mt-0.5 flex-shrink-0">{icons[entry.log_type] || icons.daily_summary}</div>
      <div className="flex-1 min-w-0">
        <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{note}</p>
        <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{fmtTime(entry.created_at)}</p>
      </div>
    </div>
  );
}

// ── Step progress bar (agent loop) ────────────────────────────────────────

const STEP_STATUS_STYLE = {
  pending:     'text-slate-500  bg-slate-100  dark:bg-slate-800',
  running:     'text-blue-600   bg-blue-50    dark:bg-blue-900/20',
  succeeded:   'text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20',
  failed:      'text-red-600    bg-red-50     dark:bg-red-900/20',
  blocked:     'text-red-600    bg-red-50     dark:bg-red-900/20',
  review_hold: 'text-amber-600  bg-amber-50   dark:bg-amber-900/20',
  skipped:     'text-slate-400  bg-slate-50   dark:bg-slate-800',
};

const STEP_STATUS_ICON = {
  pending:     <Clock className="w-3 h-3" />,
  running:     <Loader2 className="w-3 h-3 animate-spin" />,
  succeeded:   <CheckCircle2 className="w-3 h-3" />,
  failed:      <AlertTriangle className="w-3 h-3" />,
  blocked:     <AlertTriangle className="w-3 h-3" />,
  review_hold: <Clock className="w-3 h-3" />,
  skipped:     null,
};

function StepProgressBar({ loopState }) {
  if (!loopState?.steps?.length) return null;
  return (
    <div>
      <p className="text-xs font-medium mb-2" style={{ color: 'var(--text-muted)' }}>
        STEPS
      </p>
      <div className="flex items-center gap-1 flex-wrap">
        {loopState.steps.map((step, i) => (
          <div key={step.name} className="flex items-center">
            {i > 0 && <div className="w-3 h-px mx-0.5" style={{ backgroundColor: 'var(--border-default)' }} />}
            <div
              className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium ${STEP_STATUS_STYLE[step.status] || STEP_STATUS_STYLE.pending}`}
              title={step.error ? `Error: ${step.error}` : step.status}
            >
              {STEP_STATUS_ICON[step.status]}
              <span>{step.name}</span>
              {step.retry_count > 0 && (
                <span className="text-[10px] opacity-60">({step.retry_count})</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Task detail panel ─────────────────────────────────────────────────────

function TaskDetail({ task, logs, onRun, running }) {
  const canRun = task.status === 'todo' || task.status === 'blocked';
  const ctx = task.input_context || {};

  return (
    <div className="flex flex-col gap-5 p-6 overflow-y-auto">
      {/* Title + badges */}
      <div>
        <div className="flex items-start justify-between gap-3 mb-2">
          <h2 className="font-semibold text-base" style={{ color: 'var(--text-primary)' }}>{task.title}</h2>
          <Badge label={STATUS_LABEL[task.status] || task.status} className={`flex-shrink-0 ${STATUS_STYLE[task.status] || ''}`} />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Badge label={task.priority} className={PRIORITY_STYLE[task.priority] || ''} />
          {(ctx.template_id || ctx.workflow_type) && (
            <Badge label={ctx.template_id || ctx.workflow_type} className="text-indigo-600 bg-indigo-50 dark:bg-indigo-900/20" />
          )}
        </div>
      </div>

      {/* Step progress bar (agent loop) */}
      {task.loop_state && <StepProgressBar loopState={task.loop_state} />}

      {/* Description */}
      {task.description && (
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{task.description}</p>
      )}

      {/* Meta */}
      <div className="grid grid-cols-2 gap-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
        {task.due_at && (
          <div className="flex items-center gap-1.5">
            <CalendarDays className="w-3.5 h-3.5" />
            <span>Due {fmtDate(task.due_at)}</span>
          </div>
        )}
        {ctx.dataset_profile_id && (
          <div className="flex items-center gap-1.5">
            <Tag className="w-3.5 h-3.5" />
            <span className="truncate font-mono">{ctx.dataset_profile_id}</span>
          </div>
        )}
      </div>

      {/* Run action */}
      {canRun && (
        <div className="pt-1">
          <button
            onClick={() => onRun(task)}
            disabled={running}
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {running
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Running…</>
              : <><Play className="w-4 h-4" /> Run Now</>
            }
          </button>
        </div>
      )}

      {/* Waiting review notice */}
      {task.status === 'waiting_review' && (
        <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-amber-50 dark:bg-amber-900/20 text-amber-700 text-sm">
          <Clock className="w-4 h-4 flex-shrink-0" />
          Awaiting manager review — go to the Review Queue to approve.
        </div>
      )}

      {/* Work log */}
      {logs.length > 0 && (
        <div>
          <p className="text-xs font-medium mb-2" style={{ color: 'var(--text-muted)' }}>
            WORK LOG
          </p>
          <div className="divide-y" style={{ borderColor: 'var(--border-default)' }}>
            {logs.map((l) => <WorklogEntry key={l.id} entry={l} />)}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function EmployeeTasksPage() {
  const { user } = useAuth();

  const [employee, setEmployee] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [selectedTaskId, setSelectedTaskId] = useState(null);
  const [logs, setLogs] = useState([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [runningId, setRunningId] = useState(null);
  const [showNewTask, setShowNewTask] = useState(false);
  const [runError, setRunError] = useState(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState([]);
  const [showNotifs, setShowNotifs] = useState(false);
  const [schedules, setSchedules] = useState([]);
  const [showSchedules, setShowSchedules] = useState(false);

  const selectedTask = tasks.find((t) => t.id === selectedTaskId) || null;

  // Load employee + tasks
  const loadTasks = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    try {
      const emp = await aiEmployeeService.getOrCreateAiden(user.id);
      setEmployee(emp);
      const ts = await aiEmployeeService.listTasksByUser(user.id, { status: statusFilter || undefined });
      setTasks(ts);
      if (ts.length > 0 && !selectedTaskId) setSelectedTaskId(ts[0].id);
      // Load notifications + schedules (best-effort)
      try { setUnreadCount(await getUnreadCount(user.id)); } catch { /* */ }
      if (emp?.id) {
        try { setSchedules(await getSchedules(emp.id)); } catch { /* */ }
      }
    } finally {
      setLoading(false);
    }
  }, [user?.id, statusFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadTasks(); }, [loadTasks]);

  // Load logs for selected task — use userId to query across all Aiden instances
  useEffect(() => {
    if (!selectedTask || !user?.id) { setLogs([]); return; }
    aiEmployeeService.listWorklogs(employee?.id, { taskId: selectedTask.id, limit: 10, userId: user.id })
      .then(setLogs)
      .catch(() => setLogs([]));
  }, [selectedTask?.id, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleRun(task) {
    if (!user?.id || runningId) return;
    setRunningId(task.id);
    setRunError(null);
    // Optimistically mark in_progress so the task stays visible
    setTasks((prev) => prev.map((t) => t.id === task.id ? { ...t, status: 'in_progress' } : t));

    // Poll for step progress during execution
    const pollInterval = setInterval(async () => {
      try {
        const fresh = await aiEmployeeService.getTask(task.id);
        if (fresh) {
          setTasks((prev) => prev.map((t) => t.id === fresh.id ? fresh : t));
        }
      } catch { /* ignore polling errors */ }
    }, 2000);

    try {
      await executeTaskWithLoop(task, user.id);
    } catch (err) {
      setRunError(err?.message || 'Task execution failed.');
    } finally {
      clearInterval(pollInterval);
      setRunningId(null);
      await loadTasks();
    }
  }

  function handleTaskCreated(task) {
    console.log('[TaskBoard] handleTaskCreated:', task);
    setShowNewTask(false);
    setTasks((prev) => [task, ...prev]);
    setSelectedTaskId(task.id);
  }

  return (
    <div className="h-full flex flex-col" style={{ backgroundColor: 'var(--surface-bg)' }}>
      {/* ── Header ── */}
      <div
        className="h-14 flex items-center justify-between px-4 flex-shrink-0 border-b gap-3"
        style={{ backgroundColor: 'var(--surface-card)', borderColor: 'var(--border-default)' }}
      >
        <span className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>Task Board</span>
        <div className="flex items-center gap-2">
          {/* Schedules toggle */}
          <button
            onClick={() => setShowSchedules((v) => !v)}
            className={`p-1.5 rounded-lg transition-colors hover:bg-[var(--surface-subtle)] ${showSchedules ? 'bg-indigo-50 dark:bg-indigo-900/20' : ''}`}
            title="Scheduled Tasks"
          >
            <Calendar className="w-4 h-4" style={{ color: showSchedules ? 'var(--accent-primary, #6366f1)' : 'var(--text-muted)' }} />
          </button>
          {/* Notification bell */}
          <button
            onClick={async () => {
              setShowNotifs((v) => !v);
              if (!showNotifs) {
                try {
                  setNotifications(await getNotifications(user.id, { limit: 20 }));
                } catch { /* */ }
              }
            }}
            className="p-1.5 rounded-lg transition-colors hover:bg-[var(--surface-subtle)] relative"
            title="Notifications"
          >
            <Bell className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
            {unreadCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 w-4 h-4 flex items-center justify-center text-[10px] font-bold bg-red-500 text-white rounded-full">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </button>
          <button
            onClick={loadTasks}
            className="p-1.5 rounded-lg transition-colors hover:bg-[var(--surface-subtle)]"
            title="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} style={{ color: 'var(--text-muted)' }} />
          </button>
          <button
            onClick={() => setShowNewTask(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            New Task
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* ── Left: task list ── */}
        <aside
          className="w-72 flex-shrink-0 flex flex-col border-r"
          style={{ borderColor: 'var(--border-default)' }}
        >
          {/* Status filter */}
          <div className="p-2 border-b" style={{ borderColor: 'var(--border-default)' }}>
            <select
              className="w-full px-2.5 py-1.5 rounded-lg border text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
              style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-bg)', color: 'var(--text-secondary)' }}
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              {STATUS_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-5 h-5 animate-spin text-indigo-400" />
              </div>
            ) : tasks.length === 0 ? (
              <div className="px-3 py-8 text-center">
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>No tasks yet.</p>
                <button
                  onClick={() => setShowNewTask(true)}
                  className="mt-2 text-xs text-indigo-600 hover:underline"
                >
                  Create the first one
                </button>
              </div>
            ) : (
              tasks.map((t) => (
                <TaskListItem
                  key={t.id}
                  task={t}
                  isSelected={t.id === selectedTaskId}
                  onClick={() => setSelectedTaskId(t.id)}
                />
              ))
            )}
          </div>
        </aside>

        {/* ── Right: task detail ── */}
        <main className="flex-1 overflow-hidden">
          {runError && (
            <div className="mx-6 mt-4 flex items-center gap-2 px-3 py-2.5 rounded-lg bg-red-50 text-red-700 text-sm">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              <span>{runError}</span>
              <button onClick={() => setRunError(null)} className="ml-auto text-xs underline">Dismiss</button>
            </div>
          )}
          {selectedTask ? (
            <TaskDetail
              task={selectedTask}
              logs={logs}
              onRun={handleRun}
              running={runningId === selectedTask.id}
            />
          ) : (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Select a task to view details</p>
            </div>
          )}
        </main>
      </div>

      {/* ── Notification dropdown ── */}
      {showNotifs && (
        <div
          className="absolute top-14 right-4 w-80 max-h-96 overflow-y-auto rounded-xl shadow-lg border z-50"
          style={{ backgroundColor: 'var(--surface-card)', borderColor: 'var(--border-default)' }}
        >
          <div className="flex items-center justify-between px-3 py-2 border-b" style={{ borderColor: 'var(--border-default)' }}>
            <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>Notifications</span>
            {unreadCount > 0 && (
              <button
                onClick={async () => {
                  try {
                    await markAllRead(user.id);
                    setUnreadCount(0);
                    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
                  } catch { /* */ }
                }}
                className="text-xs text-indigo-600 hover:underline"
              >
                Mark all read
              </button>
            )}
          </div>
          {notifications.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs" style={{ color: 'var(--text-muted)' }}>No notifications yet.</p>
          ) : (
            notifications.map((n) => (
              <div
                key={n.id}
                className={`px-3 py-2.5 border-b text-xs ${!n.read ? 'bg-indigo-50/50 dark:bg-indigo-900/10' : ''}`}
                style={{ borderColor: 'var(--border-default)' }}
              >
                <p className="font-medium" style={{ color: 'var(--text-primary)' }}>{n.title}</p>
                <p className="mt-0.5" style={{ color: 'var(--text-muted)' }}>{fmtTime(n.created_at)}</p>
              </div>
            ))
          )}
        </div>
      )}

      {/* ── Schedules panel ── */}
      {showSchedules && (
        <div
          className="absolute top-14 right-24 w-96 max-h-96 overflow-y-auto rounded-xl shadow-lg border z-50"
          style={{ backgroundColor: 'var(--surface-card)', borderColor: 'var(--border-default)' }}
        >
          <div className="flex items-center justify-between px-3 py-2 border-b" style={{ borderColor: 'var(--border-default)' }}>
            <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>Scheduled Tasks</span>
          </div>
          {schedules.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs" style={{ color: 'var(--text-muted)' }}>No schedules configured.</p>
          ) : (
            schedules.map((s) => (
              <div
                key={s.id}
                className="px-3 py-2.5 border-b flex items-center gap-2"
                style={{ borderColor: 'var(--border-default)' }}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                    {s.task_template?.title || s.schedule_type}
                  </p>
                  <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    {s.schedule_type} at {s.hour || 8}:00 UTC
                    {s.status === 'paused' && ' (paused)'}
                  </p>
                </div>
                <button
                  onClick={async () => {
                    try {
                      if (s.status === 'active') await pauseSchedule(s.id);
                      else await resumeSchedule(s.id);
                      setSchedules(await getSchedules(employee.id));
                    } catch { /* */ }
                  }}
                  className="p-1 rounded hover:bg-[var(--surface-subtle)]"
                  title={s.status === 'active' ? 'Pause' : 'Resume'}
                >
                  {s.status === 'active'
                    ? <Pause className="w-3.5 h-3.5 text-amber-500" />
                    : <PlayCircle className="w-3.5 h-3.5 text-emerald-500" />
                  }
                </button>
                <button
                  onClick={async () => {
                    try {
                      await deleteSchedule(s.id);
                      setSchedules((prev) => prev.filter((x) => x.id !== s.id));
                    } catch { /* */ }
                  }}
                  className="p-1 rounded hover:bg-[var(--surface-subtle)]"
                  title="Delete"
                >
                  <Trash2 className="w-3.5 h-3.5 text-red-400" />
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {/* ── New task modal ── */}
      {showNewTask && (
        <NewTaskModal
          onClose={() => setShowNewTask(false)}
          onCreated={handleTaskCreated}
          employeeId={employee?.id ?? null}
          userId={user?.id}
        />
      )}
    </div>
  );
}
