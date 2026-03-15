// @product: ai-employee
import { useState, useEffect, useCallback } from 'react';
import {
  Plus, RefreshCw, Play, ChevronRight, Clock, CheckCircle2,
  AlertTriangle, Loader2, FileText, CalendarDays, Tag, Bell,
  Calendar, Pause, PlayCircle, Trash2,
} from 'lucide-react';
import { Modal } from '../components/ui';
import { useAuth } from '../contexts/AuthContext';
import * as aiEmployeeService from '../services/aiEmployeeService';
import { TEMPLATE_OPTIONS } from '../services/agentLoopTemplates';
import { getNotifications, getUnreadCount, markAllRead } from '../services/notificationService';
import {
  createSchedule,
  deleteSchedule,
  getSchedules,
  pauseSchedule,
  resumeSchedule,
  SCHEDULE_TYPES,
} from '../services/scheduledTaskService';
import {
  getTaskStatus,
  runTask as runTaskAction,
  submitPlan,
} from '../services/aiEmployee/index.js';
import { buildPlanFromTemplateTask } from '../services/aiEmployee/templatePlanAdapter';
import { EXECUTION_MODES } from '../services/aiEmployee/executionPolicy.js';
import { createTaskDatasetContextFromFile } from '../services/aiEmployee/taskDatasetContextService.js';

// ── Constants ─────────────────────────────────────────────────────────────

const STATUS_FILTERS = [
  { value: '',               label: 'All' },
  { value: 'todo',           label: 'To Do' },
  { value: 'waiting_approval',label: 'Ready to Run' },
  { value: 'queued',         label: 'Queued' },
  { value: 'in_progress',   label: 'In Progress' },
  { value: 'waiting_review',label: 'Awaiting Review' },
  { value: 'review_hold',   label: 'Awaiting Review' },
  { value: 'blocked',       label: 'Blocked' },
  { value: 'failed',        label: 'Failed' },
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
  waiting_approval:'text-violet-600 bg-violet-50 dark:bg-violet-900/20',
  queued:         'text-indigo-600 bg-indigo-50 dark:bg-indigo-900/20',
  in_progress:   'text-blue-600   bg-blue-50    dark:bg-blue-900/20',
  waiting_review:'text-amber-600  bg-amber-50   dark:bg-amber-900/20',
  review_hold:   'text-amber-600  bg-amber-50   dark:bg-amber-900/20',
  blocked:       'text-red-600    bg-red-50     dark:bg-red-900/20',
  failed:        'text-red-600    bg-red-50     dark:bg-red-900/20',
  done:          'text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20',
};

const STATUS_LABEL = {
  todo: 'To Do',
  waiting_approval: 'Ready to Run',
  queued: 'Queued',
  in_progress: 'In Progress',
  waiting_review: 'Awaiting Review',
  review_hold: 'Awaiting Review',
  blocked: 'Blocked',
  failed: 'Failed',
  done: 'Done',
};

const PRIORITY_STYLE = {
  low:    'text-slate-500 bg-slate-100',
  medium: 'text-blue-600  bg-blue-50',
  high:   'text-orange-600 bg-orange-50',
  urgent: 'text-red-600   bg-red-50',
};

const EXECUTION_MODE_OPTIONS = [
  { value: EXECUTION_MODES.MANUAL_APPROVE, label: 'Manual Approval' },
  { value: EXECUTION_MODES.AUTO_RUN, label: 'Auto Run' },
];

const EXECUTION_MODE_STYLE = {
  [EXECUTION_MODES.MANUAL_APPROVE]: 'text-slate-600 bg-slate-100 dark:bg-slate-800',
  [EXECUTION_MODES.AUTO_RUN]: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20',
};

const EXECUTION_MODE_LABEL = {
  [EXECUTION_MODES.MANUAL_APPROVE]: 'Manual',
  [EXECUTION_MODES.AUTO_RUN]: 'Auto',
};

const SCHEDULE_TYPE_OPTIONS = [
  { value: SCHEDULE_TYPES.DAILY, label: 'Daily' },
  { value: SCHEDULE_TYPES.WEEKLY, label: 'Weekly' },
  { value: SCHEDULE_TYPES.MONTHLY, label: 'Monthly' },
];

const DAY_OF_WEEK_OPTIONS = [
  { value: 0, label: 'Sunday' },
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
];

const DAY_OF_MONTH_OPTIONS = Array.from({ length: 31 }, (_, index) => ({
  value: index + 1,
  label: String(index + 1),
}));

const ORCHESTRATOR_ACTIVE_STATUSES = ['queued', 'in_progress'];

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

function isOrchestratorTask(task) {
  return Boolean(task?.plan_snapshot?.steps?.length);
}

function buildLoopState(task, stepRows = null) {
  if (task?.loop_state?.steps?.length) return task.loop_state;

  const rows = Array.isArray(stepRows)
    ? [...stepRows].sort((a, b) => (a.step_index ?? 0) - (b.step_index ?? 0))
    : null;

  if (rows?.length) {
    return {
      steps: rows.map((step) => ({
        index: step.step_index ?? 0,
        name: step.step_name || `step_${step.step_index ?? 0}`,
        workflow_type: step.tool_type || null,
        status: step.status || 'pending',
        retry_count: step.retry_count || 0,
        error: step.error_message || null,
      })),
    };
  }

  const planSteps = task?.plan_snapshot?.steps || [];
  if (!planSteps.length) return null;

  return {
    steps: planSteps.map((step, index) => ({
      index,
      name: step.name || `step_${index}`,
      workflow_type: step.tool_type || null,
      status: 'pending',
      retry_count: 0,
      error: null,
    })),
  };
}

function hydrateTaskForBoard(task, stepRows = null) {
  if (!task) return task;
  const loop_state = buildLoopState(task, stepRows);
  return loop_state ? { ...task, loop_state } : task;
}

// ── New Task Modal ────────────────────────────────────────────────────────

function NewTaskModal({ onClose, onCreated, employeeId, userId }) {
  const [form, setForm] = useState({
    title: '',
    description: '',
    priority: 'medium',
    template_id: 'plan',
    execution_mode: EXECUTION_MODES.MANUAL_APPROVE,
    due_at: '',
  });
  const [sourceFile, setSourceFile] = useState(null);
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
    if (!sourceFile) { setError('Attach a source file for the task.'); return; }

    setSaving(true);
    setError(null);
    try {
      const datasetContext = await createTaskDatasetContextFromFile({
        userId,
        file: sourceFile,
      });

      const plan = await buildPlanFromTemplateTask({
        templateId: form.template_id,
        title: form.title.trim(),
        description: form.description.trim() || '',
        priority: form.priority,
        dueAt: form.due_at ? new Date(form.due_at).toISOString() : null,
        executionMode: form.execution_mode,
        datasetProfileId: datasetContext.datasetProfileId,
        datasetProfileRow: datasetContext.datasetProfileRow,
        userId,
      });
      plan.taskMeta = {
        ...(plan.taskMeta || {}),
        source_file_name: datasetContext.summary.fileName,
        source_file_size: datasetContext.summary.fileSize,
        source_sheet_count: datasetContext.summary.sheetCount,
        source_row_count: datasetContext.summary.totalRows,
      };

      const { task } = await submitPlan(plan, employeeId, userId);
      console.log('[NewTask] submitPlan result:', task);
      onCreated(task);
    } catch (err) {
      console.error('[NewTask] submitPlan error:', err);
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
            rows={3}
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder="Describe the outcome you want, the audience, and any formatting expectations."
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
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Execution Mode</label>
          <select
            className={inputCls}
            style={inputStyle}
            value={form.execution_mode}
            onChange={(e) => set('execution_mode', e.target.value)}
          >
            {EXECUTION_MODE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Source File *</label>
          <input
            type="file"
            accept=".xlsx,.xls,.csv"
            className={inputCls}
            style={inputStyle}
            onChange={(e) => {
              setSourceFile(e.target.files?.[0] || null);
              setError(null);
            }}
          />
          <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            Upload the workbook or CSV Aiden should use. The system will create the data context internally.
          </p>
          {sourceFile && (
            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
              Attached: <span className="font-medium">{sourceFile.name}</span> · {(Number(sourceFile.size || 0) / 1024).toFixed(1)} KB
            </p>
          )}
        </div>

        <div className="rounded-lg border px-3 py-2 text-[11px]" style={{ borderColor: 'var(--border-default)', color: 'var(--text-muted)' }}>
          Aiden task example:
          {' '}
          <span style={{ color: 'var(--text-secondary)' }}>
            "Use the attached workbook to produce a weekly supply chain report with forecast summary, replenishment recommendations, supplier risk highlights, and action items for the ops manager."
          </span>
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

function NewScheduleModal({ onClose, onCreated, employeeId, userId }) {
  const [form, setForm] = useState({
    title: '',
    description: '',
    priority: 'medium',
    template_id: 'forecast',
    execution_mode: EXECUTION_MODES.MANUAL_APPROVE,
    schedule_type: SCHEDULE_TYPES.DAILY,
    hour: '8',
    day_of_week: '1',
    day_of_month: '1',
  });
  const [sourceFile, setSourceFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  function set(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!employeeId) { setError('Employee not loaded yet — please wait a moment and try again.'); return; }
    if (!form.title.trim()) { setError('Title is required.'); return; }
    if (!sourceFile) { setError('Attach a source file for the scheduled task.'); return; }

    setSaving(true);
    setError(null);
    try {
      const datasetContext = await createTaskDatasetContextFromFile({
        userId,
        file: sourceFile,
      });
      if (!datasetContext.datasetProfileId) {
        throw new Error('Failed to create a reusable dataset context for this schedule.');
      }

      const schedule = await createSchedule(
        employeeId,
        {
          schedule_type: form.schedule_type,
          hour: Number(form.hour),
          day_of_week: form.schedule_type === SCHEDULE_TYPES.WEEKLY ? Number(form.day_of_week) : null,
          day_of_month: form.schedule_type === SCHEDULE_TYPES.MONTHLY ? Number(form.day_of_month) : null,
        },
        {
          title: form.title.trim(),
          description: form.description.trim() || '',
          priority: form.priority,
          template_id: form.template_id,
          dataset_profile_id: datasetContext.datasetProfileId,
          execution_mode: form.execution_mode,
          source_file_name: datasetContext.summary.fileName,
          source_file_size: datasetContext.summary.fileSize,
          source_sheet_count: datasetContext.summary.sheetCount,
          source_row_count: datasetContext.summary.totalRows,
          input_context: {
            dataset_profile_id: datasetContext.datasetProfileId,
            execution_mode: form.execution_mode,
            source_file_name: datasetContext.summary.fileName,
            source_file_size: datasetContext.summary.fileSize,
            source_sheet_count: datasetContext.summary.sheetCount,
            source_row_count: datasetContext.summary.totalRows,
          },
        },
        userId
      );

      onCreated(schedule);
    } catch (err) {
      setError(err?.message || 'Failed to create schedule.');
    } finally {
      setSaving(false);
    }
  }

  const inputCls = 'w-full px-3 py-2 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500';
  const inputStyle = { borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-bg)', color: 'var(--text-primary)' };

  return (
    <Modal isOpen onClose={onClose} title="New Schedule">
      <form onSubmit={handleSubmit} className="space-y-4 p-1">
        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Title *</label>
          <input
            className={inputCls}
            style={inputStyle}
            value={form.title}
            onChange={(e) => set('title', e.target.value)}
            placeholder="e.g. Monday forecast refresh"
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
            placeholder="What should run on this schedule?"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
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
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Schedule</label>
            <select
              className={inputCls}
              style={inputStyle}
              value={form.schedule_type}
              onChange={(e) => set('schedule_type', e.target.value)}
            >
              {SCHEDULE_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Execution Mode</label>
            <select
              className={inputCls}
              style={inputStyle}
              value={form.execution_mode}
              onChange={(e) => set('execution_mode', e.target.value)}
            >
              {EXECUTION_MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Hour (UTC)</label>
            <select
              className={inputCls}
              style={inputStyle}
              value={form.hour}
              onChange={(e) => set('hour', e.target.value)}
            >
              {Array.from({ length: 24 }, (_, hour) => (
                <option key={hour} value={hour}>{String(hour).padStart(2, '0')}:00</option>
              ))}
            </select>
          </div>
          {form.schedule_type === SCHEDULE_TYPES.WEEKLY && (
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Day of Week</label>
              <select
                className={inputCls}
                style={inputStyle}
                value={form.day_of_week}
                onChange={(e) => set('day_of_week', e.target.value)}
              >
                {DAY_OF_WEEK_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
          )}
          {form.schedule_type === SCHEDULE_TYPES.MONTHLY && (
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Day of Month</label>
              <select
                className={inputCls}
                style={inputStyle}
                value={form.day_of_month}
                onChange={(e) => set('day_of_month', e.target.value)}
              >
                {DAY_OF_MONTH_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Source File *</label>
          <input
            type="file"
            accept=".xlsx,.xls,.csv"
            className={inputCls}
            style={inputStyle}
            onChange={(e) => {
              setSourceFile(e.target.files?.[0] || null);
              setError(null);
            }}
          />
          <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            Upload the workbook or CSV this schedule should reuse on every run. The system stores the dataset context internally.
          </p>
          {sourceFile && (
            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
              Attached: <span className="font-medium">{sourceFile.name}</span> · {(Number(sourceFile.size || 0) / 1024).toFixed(1)} KB
            </p>
          )}
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
            {saving ? 'Creating…' : 'Create Schedule'}
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
          {task.input_context?.execution_mode && (
            <Badge
              label={EXECUTION_MODE_LABEL[task.input_context.execution_mode] || task.input_context.execution_mode}
              className={EXECUTION_MODE_STYLE[task.input_context.execution_mode] || ''}
            />
          )}
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
  retrying:    'text-blue-600   bg-blue-50    dark:bg-blue-900/20',
  succeeded:   'text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20',
  failed:      'text-red-600    bg-red-50     dark:bg-red-900/20',
  blocked:     'text-red-600    bg-red-50     dark:bg-red-900/20',
  review_hold: 'text-amber-600  bg-amber-50   dark:bg-amber-900/20',
  skipped:     'text-slate-400  bg-slate-50   dark:bg-slate-800',
};

const STEP_STATUS_ICON = {
  pending:     <Clock className="w-3 h-3" />,
  running:     <Loader2 className="w-3 h-3 animate-spin" />,
  retrying:    <Loader2 className="w-3 h-3 animate-spin" />,
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
  const canRun = isOrchestratorTask(task)
    ? ['waiting_approval', 'failed'].includes(task.status)
    : ['todo', 'blocked'].includes(task.status);
  const ctx = task.input_context || {};
  const runLabel = task.status === 'waiting_approval'
    ? 'Approve & Run'
    : task.status === 'failed'
    ? 'Retry'
    : 'Run Now';

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
          {ctx.execution_mode && (
            <Badge
              label={EXECUTION_MODE_LABEL[ctx.execution_mode] || ctx.execution_mode}
              className={EXECUTION_MODE_STYLE[ctx.execution_mode] || ''}
            />
          )}
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
        {ctx.source_file_name ? (
          <div className="flex items-center gap-1.5">
            <FileText className="w-3.5 h-3.5" />
            <span className="truncate">{ctx.source_file_name}</span>
          </div>
        ) : ctx.dataset_profile_id && (
          <div className="flex items-center gap-1.5">
            <Tag className="w-3.5 h-3.5" />
            <span className="truncate font-mono">context {ctx.dataset_profile_id}</span>
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
              : <><Play className="w-4 h-4" /> {runLabel}</>
            }
          </button>
        </div>
      )}

      {/* Waiting review notice */}
      {(task.status === 'waiting_review' || task.status === 'review_hold') && (
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
  const [showNewSchedule, setShowNewSchedule] = useState(false);

  const selectedTask = tasks.find((t) => t.id === selectedTaskId) || null;

  const refreshTaskRuntime = useCallback(async (taskId) => {
    if (!taskId) return;
    try {
      const snapshot = await getTaskStatus(taskId);
      if (!snapshot?.task) return;
      const hydrated = hydrateTaskForBoard(snapshot.task, snapshot.steps);
      setTasks((prev) => prev.map((task) => task.id === hydrated.id ? hydrated : task));
    } catch {
      // Legacy task or no orchestrator state — ignore.
    }
  }, []);

  // Load employee + tasks
  const loadTasks = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    try {
      const emp = await aiEmployeeService.getOrCreateAiden(user.id);
      setEmployee(emp);
      const rawTasks = await aiEmployeeService.listTasksByUser(user.id, { status: statusFilter || undefined });
      const ts = rawTasks.map((task) => hydrateTaskForBoard(task));
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

  useEffect(() => {
    if (!selectedTaskId) return;
    refreshTaskRuntime(selectedTaskId);
  }, [selectedTaskId, refreshTaskRuntime]);

  useEffect(() => {
    const activeTaskIds = tasks
      .filter((task) => isOrchestratorTask(task) && ORCHESTRATOR_ACTIVE_STATUSES.includes(task.status))
      .map((task) => task.id);

    if (activeTaskIds.length === 0) return undefined;

    let cancelled = false;

    const pollActiveTasks = async () => {
      const snapshots = await Promise.all(
        activeTaskIds.map(async (taskId) => {
          try {
            return await getTaskStatus(taskId);
          } catch {
            return null;
          }
        })
      );

      if (cancelled) return;

      const hydratedSnapshots = snapshots
        .filter((snapshot) => snapshot?.task?.id)
        .map((snapshot) => hydrateTaskForBoard(snapshot.task, snapshot.steps));

      if (hydratedSnapshots.length === 0) return;

      const hydratedById = new Map(hydratedSnapshots.map((task) => [task.id, task]));
      const shouldRefreshList = hydratedSnapshots.some((task) => !ORCHESTRATOR_ACTIVE_STATUSES.includes(task.status));

      setTasks((prev) => prev.map((task) => hydratedById.get(task.id) || task));

      if (shouldRefreshList) {
        await loadTasks();
      }
    };

    pollActiveTasks();
    const intervalId = setInterval(pollActiveTasks, 2000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [tasks, loadTasks]);

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

    try {
      await runTaskAction(task, user.id);
    } catch (err) {
      setRunError(err?.message || 'Task execution failed.');
    } finally {
      setRunningId(null);
      await loadTasks();
    }
  }

  function handleTaskCreated(task) {
    console.log('[TaskBoard] handleTaskCreated:', task);
    const hydrated = hydrateTaskForBoard(task);
    setShowNewTask(false);
    setTasks((prev) => [hydrated, ...prev]);
    setSelectedTaskId(task.id);
  }

  function handleScheduleCreated(schedule) {
    setShowNewSchedule(false);
    setSchedules((prev) => [schedule, ...prev]);
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
            <button
              onClick={() => setShowNewSchedule(true)}
              className="text-xs text-indigo-600 hover:underline"
            >
              New Schedule
            </button>
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
                  <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                    <Badge
                      label={EXECUTION_MODE_LABEL[s.task_template?.execution_mode] || s.task_template?.execution_mode || 'Manual'}
                      className={EXECUTION_MODE_STYLE[s.task_template?.execution_mode || EXECUTION_MODES.MANUAL_APPROVE] || ''}
                    />
                    {s.task_template?.source_file_name && (
                      <span className="text-[11px] truncate max-w-[160px]" style={{ color: 'var(--text-secondary)' }}>
                        {s.task_template.source_file_name}
                      </span>
                    )}
                    <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      {s.schedule_type}
                    </span>
                    {s.next_run_at && (
                      <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        Next {fmtTime(s.next_run_at)}
                      </span>
                    )}
                    {s.status === 'paused' && (
                      <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>(paused)</span>
                    )}
                  </div>
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
      {showNewSchedule && (
        <NewScheduleModal
          onClose={() => setShowNewSchedule(false)}
          onCreated={handleScheduleCreated}
          employeeId={employee?.id ?? null}
          userId={user?.id}
        />
      )}
    </div>
  );
}
