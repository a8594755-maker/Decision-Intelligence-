// @product: ai-employee
/**
 * ScheduleManagerPage — Manage recurring schedules and cron jobs.
 *
 * Features:
 *   - List all schedules per worker
 *   - Create new schedules (daily/weekly/monthly/cron/event-trigger)
 *   - Pause/resume/delete schedules
 *   - Manual trigger (fire now)
 *   - View execution history
 */
import { useState, useEffect, useCallback } from 'react';
import {
  Clock, Plus, Play, Pause, Trash2, CalendarDays, Timer,
  RefreshCw, CheckCircle2, AlertTriangle, Zap,
} from 'lucide-react';
import { Card, Modal } from '../components/ui';
import { useAuth } from '../contexts/AuthContext';
import {
  createSchedule, getSchedules, deleteSchedule, pauseSchedule,
  resumeSchedule, instantiateScheduledTask, getDueTasks,
  SCHEDULE_TYPES, createEventTrigger,
} from '../services/scheduledTaskService.js';
import { listEmployeesByManager } from '../services/aiEmployee/queries.js';

const SCHEDULE_TYPE_LABELS = {
  [SCHEDULE_TYPES.DAILY]:            'Daily',
  [SCHEDULE_TYPES.WEEKLY]:           'Weekly',
  [SCHEDULE_TYPES.MONTHLY]:          'Monthly',
  [SCHEDULE_TYPES.CRON]:             'Cron',
  [SCHEDULE_TYPES.ON_FILE_UPLOADED]: 'On File Upload',
  [SCHEDULE_TYPES.ON_FILE_MODIFIED]: 'On File Modified',
  [SCHEDULE_TYPES.ON_FILE_DETECTED]: 'On File Detected',
};

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ── Schedule Card ────────────────────────────────────────────────────────────

function ScheduleCard({ schedule, onPause, onResume, onDelete, onFireNow }) {
  const isActive = schedule.status === 'active';
  const isPaused = schedule.status === 'paused';
  const isEvent = schedule.schedule_type?.startsWith('on_file_');
  const typeLabel = SCHEDULE_TYPE_LABELS[schedule.schedule_type] || schedule.schedule_type;
  const taskTitle = schedule.task_template?.title || 'Untitled';

  return (
    <Card variant="elevated" className={`p-4 flex flex-col gap-2.5 ${!isActive && !isPaused ? 'opacity-50' : ''}`}>
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>{taskTitle}</span>
            <span className={`px-1.5 py-0.5 text-[10px] rounded font-medium ${
              isEvent ? 'text-purple-600 bg-purple-50 dark:bg-purple-900/20'
                : 'text-blue-600 bg-blue-50 dark:bg-blue-900/20'
            }`}>
              {typeLabel}
            </span>
            <span className={`px-1.5 py-0.5 text-[10px] rounded font-medium ${
              isActive ? 'text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20'
                : isPaused ? 'text-amber-600 bg-amber-50 dark:bg-amber-900/20'
                  : 'text-slate-500 bg-slate-100 dark:bg-slate-800'
            }`}>
              {schedule.status}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0 ml-3">
          {!isEvent && (
            <button onClick={() => onFireNow(schedule)} className="p-1.5 rounded-lg hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors" title="Fire now">
              <Play className="w-3.5 h-3.5 text-emerald-600" />
            </button>
          )}
          {isActive && (
            <button onClick={() => onPause(schedule.id)} className="p-1.5 rounded-lg hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors" title="Pause">
              <Pause className="w-3.5 h-3.5 text-amber-600" />
            </button>
          )}
          {isPaused && (
            <button onClick={() => onResume(schedule.id)} className="p-1.5 rounded-lg hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors" title="Resume">
              <RefreshCw className="w-3.5 h-3.5 text-emerald-600" />
            </button>
          )}
          <button onClick={() => onDelete(schedule.id)} className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
            <Trash2 className="w-3.5 h-3.5 text-red-500" />
          </button>
        </div>
      </div>

      {/* Schedule details */}
      <div className="flex gap-4 text-xs" style={{ color: 'var(--text-muted)' }}>
        {!isEvent && (
          <>
            <span className="flex items-center gap-1">
              <Timer className="w-3 h-3" />
              {schedule.hour != null ? `${String(schedule.hour).padStart(2, '0')}:00 UTC` : '—'}
            </span>
            {schedule.day_of_week != null && (
              <span>{DAY_LABELS[schedule.day_of_week]}</span>
            )}
            {schedule.day_of_month != null && (
              <span>Day {schedule.day_of_month}</span>
            )}
          </>
        )}
        {schedule.next_run_at && (
          <span className="flex items-center gap-1">
            <CalendarDays className="w-3 h-3" />
            Next: {new Date(schedule.next_run_at).toLocaleString()}
          </span>
        )}
        {schedule.last_run_at && (
          <span>Last: {new Date(schedule.last_run_at).toLocaleString()}</span>
        )}
      </div>

      {/* Workflow type */}
      {schedule.task_template?.template_id && (
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 dark:bg-indigo-900/20 self-start">
          {schedule.task_template.template_id}
        </span>
      )}
    </Card>
  );
}

// ── Create Schedule Modal ────────────────────────────────────────────────────

function CreateScheduleModal({ onClose, onCreated, workers }) {
  const [form, setForm] = useState({
    employeeId: workers[0]?.id || '',
    scheduleType: SCHEDULE_TYPES.DAILY,
    hour: 8,
    dayOfWeek: 1,
    dayOfMonth: 1,
    title: '',
    templateId: 'full_report',
    priority: 'medium',
  });
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const schedule = await createSchedule(
        form.employeeId,
        {
          schedule_type: form.scheduleType,
          hour: form.hour,
          day_of_week: form.scheduleType === SCHEDULE_TYPES.WEEKLY ? form.dayOfWeek : undefined,
          day_of_month: form.scheduleType === SCHEDULE_TYPES.MONTHLY ? form.dayOfMonth : undefined,
        },
        {
          title: form.title || `Scheduled ${form.templateId}`,
          template_id: form.templateId,
          priority: form.priority,
        },
      );
      onCreated(schedule);
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title="Create Schedule">
      <div className="p-4 space-y-4">
        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Worker</label>
          <select value={form.employeeId} onChange={e => setForm(p => ({ ...p, employeeId: e.target.value }))}
            className="w-full px-3 py-2 rounded-lg border text-sm"
            style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)', color: 'var(--text-primary)' }}>
            {workers.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Schedule Type</label>
          <select value={form.scheduleType} onChange={e => setForm(p => ({ ...p, scheduleType: e.target.value }))}
            className="w-full px-3 py-2 rounded-lg border text-sm"
            style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)', color: 'var(--text-primary)' }}>
            <option value={SCHEDULE_TYPES.DAILY}>Daily</option>
            <option value={SCHEDULE_TYPES.WEEKLY}>Weekly</option>
            <option value={SCHEDULE_TYPES.MONTHLY}>Monthly</option>
          </select>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Hour (UTC)</label>
            <input type="number" min={0} max={23} value={form.hour}
              onChange={e => setForm(p => ({ ...p, hour: parseInt(e.target.value, 10) }))}
              className="w-full px-3 py-2 rounded-lg border text-sm"
              style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)', color: 'var(--text-primary)' }} />
          </div>
          {form.scheduleType === SCHEDULE_TYPES.WEEKLY && (
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Day of Week</label>
              <select value={form.dayOfWeek} onChange={e => setForm(p => ({ ...p, dayOfWeek: parseInt(e.target.value, 10) }))}
                className="w-full px-3 py-2 rounded-lg border text-sm"
                style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)', color: 'var(--text-primary)' }}>
                {DAY_LABELS.map((d, i) => <option key={i} value={i}>{d}</option>)}
              </select>
            </div>
          )}
          {form.scheduleType === SCHEDULE_TYPES.MONTHLY && (
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Day of Month</label>
              <input type="number" min={1} max={28} value={form.dayOfMonth}
                onChange={e => setForm(p => ({ ...p, dayOfMonth: parseInt(e.target.value, 10) }))}
                className="w-full px-3 py-2 rounded-lg border text-sm"
                style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)', color: 'var(--text-primary)' }} />
            </div>
          )}
          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Priority</label>
            <select value={form.priority} onChange={e => setForm(p => ({ ...p, priority: e.target.value }))}
              className="w-full px-3 py-2 rounded-lg border text-sm"
              style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)', color: 'var(--text-primary)' }}>
              {['critical', 'high', 'medium', 'low'].map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Task Title</label>
          <input type="text" value={form.title}
            onChange={e => setForm(p => ({ ...p, title: e.target.value }))}
            className="w-full px-3 py-2 rounded-lg border text-sm"
            style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)', color: 'var(--text-primary)' }}
            placeholder="e.g. Daily MBR Report" />
        </div>

        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-muted)' }}>Workflow Template</label>
          <select value={form.templateId} onChange={e => setForm(p => ({ ...p, templateId: e.target.value }))}
            className="w-full px-3 py-2 rounded-lg border text-sm"
            style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-card)', color: 'var(--text-primary)' }}>
            <option value="full_report">Full Report</option>
            <option value="forecast_then_plan">Forecast + Plan</option>
            <option value="risk_aware_plan">Risk-Aware Plan</option>
            <option value="mbr_with_excel">MBR with Excel</option>
            <option value="full_report_with_publish">Report + Publish</option>
          </select>
        </div>

        <div className="flex gap-2 pt-2">
          <button onClick={handleCreate} disabled={creating || !form.employeeId}
            className="flex-1 px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors">
            {creating ? 'Creating...' : 'Create Schedule'}
          </button>
          <button onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-medium border transition-colors hover:bg-[var(--surface-subtle)]"
            style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ScheduleManagerPage() {
  const { user } = useAuth();
  const [schedules, setSchedules] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [dueCount, setDueCount] = useState(0);

  const load = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    try {
      const wk = await listEmployeesByManager(user.id);
      setWorkers(wk);
      const allSchedules = [];
      for (const w of wk) {
        const s = await getSchedules(w.id);
        allSchedules.push(...s);
      }
      setSchedules(allSchedules);

      // Count due tasks
      try {
        const due = await getDueTasks();
        setDueCount(due?.length || 0);
      } catch { /* best-effort */ }
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => { load(); }, [load]);

  const handlePause = async (id) => { await pauseSchedule(id); await load(); };
  const handleResume = async (id) => { await resumeSchedule(id); await load(); };
  const handleDelete = async (id) => {
    if (!confirm('Delete this schedule?')) return;
    await deleteSchedule(id);
    await load();
  };

  const handleFireNow = async (schedule) => {
    try {
      await instantiateScheduledTask(schedule, user.id);
      await load();
    } catch (err) {
      console.error('[ScheduleManager] Fire now failed:', err);
    }
  };

  return (
    <div className="h-full flex flex-col" style={{ backgroundColor: 'var(--surface-bg)' }}>
      {/* Header */}
      <div
        className="h-14 flex items-center justify-between px-6 flex-shrink-0 border-b"
        style={{ backgroundColor: 'var(--surface-card)', borderColor: 'var(--border-default)' }}
      >
        <div className="flex items-center gap-2.5">
          <Clock className="w-5 h-5 text-indigo-600" />
          <span className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>Schedule Manager</span>
          {schedules.length > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-600 dark:bg-indigo-900/20">
              {schedules.length}
            </span>
          )}
          {dueCount > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-600 dark:bg-amber-900/20">
              {dueCount} due
            </span>
          )}
        </div>
        <button
          onClick={() => setShowCreate(true)}
          disabled={workers.length === 0}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          New Schedule
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <div className="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <div className="max-w-3xl space-y-3">
            {schedules.map(s => (
              <ScheduleCard
                key={s.id}
                schedule={s}
                onPause={handlePause}
                onResume={handleResume}
                onDelete={handleDelete}
                onFireNow={handleFireNow}
              />
            ))}

            {schedules.length === 0 && (
              <div className="flex flex-col items-center justify-center h-48 gap-3">
                <Clock className="w-10 h-10 text-indigo-300" />
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  No schedules configured. Create one to automate recurring tasks.
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Create Modal */}
      {showCreate && (
        <CreateScheduleModal
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); load(); }}
          workers={workers}
        />
      )}
    </div>
  );
}
