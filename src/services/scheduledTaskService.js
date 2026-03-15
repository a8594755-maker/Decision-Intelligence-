// @product: ai-employee
//
// scheduledTaskService.js
// ─────────────────────────────────────────────────────────────────────────────
// CRUD + scheduling logic for recurring AI Employee tasks.
//
// Schedules live in `ai_employee_schedules` (Supabase) with localStorage
// fallback. Each schedule carries a `task_template` that gets stamped into
// a real task via `aiEmployeeService.createTask()` when the schedule fires.
//
// `getDueTasks()` returns schedules whose `next_run_at <= now()` — the
// edge-function scheduler (or a manual trigger) calls this periodically.
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from './supabaseClient';

// ── Constants ────────────────────────────────────────────────────────────────

const LOCAL_SCHEDULES_KEY = 'ai_employee_schedules_v1';

export const SCHEDULE_TYPES = {
  DAILY: 'daily',
  WEEKLY: 'weekly',
  MONTHLY: 'monthly',
  CRON: 'cron',
  // Event-based triggers (OpenCloud file events)
  ON_FILE_UPLOADED: 'on_file_uploaded',
  ON_FILE_MODIFIED: 'on_file_modified',
  ON_FILE_DETECTED: 'on_file_detected',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function now() {
  return new Date().toISOString();
}

function uuid() {
  return `local-sched-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function trySupabase(fn) {
  try {
    if (!supabase) return null;
    return await fn();
  } catch (err) {
    console.warn('[scheduledTaskService] Supabase call failed:', err?.message || err);
    return null;
  }
}

function getLocal() {
  try {
    const raw = localStorage.getItem(LOCAL_SCHEDULES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function setLocal(items) {
  try {
    localStorage.setItem(LOCAL_SCHEDULES_KEY, JSON.stringify(items));
  } catch { /* quota */ }
}

// ── Next-run computation ────────────────────────────────────────────────────

/**
 * Compute the next run time from now, based on schedule parameters.
 * Returns ISO string.
 */
export function computeNextRun(scheduleType, { hour = 8, dayOfWeek, dayOfMonth } = {}) {
  const base = new Date();
  // Shift to next occurrence
  switch (scheduleType) {
    case 'daily': {
      const next = new Date(base);
      next.setUTCHours(hour, 0, 0, 0);
      if (next <= base) next.setUTCDate(next.getUTCDate() + 1);
      return next.toISOString();
    }
    case 'weekly': {
      const dow = dayOfWeek ?? 1; // default Monday
      const next = new Date(base);
      next.setUTCHours(hour, 0, 0, 0);
      const diff = (dow - next.getUTCDay() + 7) % 7 || 7;
      next.setUTCDate(next.getUTCDate() + diff);
      return next.toISOString();
    }
    case 'monthly': {
      const dom = dayOfMonth ?? 1;
      const next = new Date(base);
      next.setUTCHours(hour, 0, 0, 0);
      next.setUTCDate(dom);
      if (next <= base) next.setUTCMonth(next.getUTCMonth() + 1);
      return next.toISOString();
    }
    default: {
      // cron or unknown — default to 1 day from now
      const next = new Date(base.getTime() + 86400000);
      next.setUTCHours(hour, 0, 0, 0);
      return next.toISOString();
    }
  }
}

/**
 * Advance next_run_at after execution.
 */
export function advanceNextRun(schedule) {
  return computeNextRun(schedule.schedule_type, {
    hour: schedule.hour ?? 8,
    dayOfWeek: schedule.day_of_week,
    dayOfMonth: schedule.day_of_month,
  });
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Create a recurring schedule.
 *
 * @param {string} employeeId
 * @param {object} schedule - { schedule_type, hour?, day_of_week?, day_of_month?, cron_expression? }
 * @param {object} taskTemplate - { title, template_id|workflow_type, input_context, priority }
 * @param {string} [createdBy] - user ID
 * @returns {Promise<object>}
 */
export async function createSchedule(employeeId, schedule, taskTemplate, createdBy = null) {
  const nextRun = computeNextRun(schedule.schedule_type, {
    hour: schedule.hour,
    dayOfWeek: schedule.day_of_week,
    dayOfMonth: schedule.day_of_month,
  });

  const row = {
    employee_id: employeeId,
    schedule_type: schedule.schedule_type || 'daily',
    cron_expression: schedule.cron_expression || null,
    hour: schedule.hour ?? 8,
    day_of_week: schedule.day_of_week ?? null,
    day_of_month: schedule.day_of_month ?? null,
    task_template: taskTemplate,
    last_run_at: null,
    next_run_at: nextRun,
    status: 'active',
    created_by: createdBy,
    created_at: now(),
  };

  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('ai_employee_schedules')
      .insert(row)
      .select()
      .single();
    if (error) throw error;
    return data;
  });
  if (sbResult) return sbResult;

  // localStorage fallback
  const entry = { id: uuid(), ...row };
  const items = getLocal();
  items.push(entry);
  setLocal(items);
  return entry;
}

/**
 * List schedules for an employee.
 */
export async function getSchedules(employeeId) {
  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('ai_employee_schedules')
      .select('*')
      .eq('employee_id', employeeId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  });
  if (sbResult) return sbResult;

  return getLocal().filter((s) => s.employee_id === employeeId);
}

/**
 * Get a single schedule by ID.
 */
export async function getSchedule(scheduleId) {
  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('ai_employee_schedules')
      .select('*')
      .eq('id', scheduleId)
      .single();
    if (error) throw error;
    return data;
  });
  if (sbResult) return sbResult;

  return getLocal().find((s) => s.id === scheduleId) || null;
}

/**
 * Get all active schedules that are due (next_run_at <= now).
 */
export async function getDueTasks() {
  const currentTime = now();

  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('ai_employee_schedules')
      .select('*')
      .eq('status', 'active')
      .lte('next_run_at', currentTime)
      .order('next_run_at');
    if (error) throw error;
    return data;
  });
  if (sbResult) return sbResult;

  return getLocal().filter(
    (s) => s.status === 'active' && s.next_run_at && s.next_run_at <= currentTime
  );
}

/**
 * Mark a schedule as executed: update last_run_at + advance next_run_at.
 */
export async function markExecuted(scheduleId, taskId = null) {
  const schedule = await getSchedule(scheduleId);
  if (!schedule) return null;

  const updates = {
    last_run_at: now(),
    next_run_at: advanceNextRun(schedule),
  };

  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('ai_employee_schedules')
      .update(updates)
      .eq('id', scheduleId)
      .select()
      .single();
    if (error) throw error;
    return data;
  });
  if (sbResult) return sbResult;

  // localStorage fallback
  const items = getLocal();
  const idx = items.findIndex((s) => s.id === scheduleId);
  if (idx >= 0) {
    items[idx] = { ...items[idx], ...updates };
    setLocal(items);
    return items[idx];
  }
  return null;
}

/**
 * Pause a schedule.
 */
export async function pauseSchedule(scheduleId) {
  return updateScheduleStatus(scheduleId, 'paused');
}

/**
 * Resume a paused schedule.
 */
export async function resumeSchedule(scheduleId) {
  return updateScheduleStatus(scheduleId, 'active');
}

/**
 * Delete a schedule.
 */
export async function deleteSchedule(scheduleId) {
  const sbResult = await trySupabase(async () => {
    const { error } = await supabase
      .from('ai_employee_schedules')
      .delete()
      .eq('id', scheduleId);
    if (error) throw error;
    return true;
  });
  if (sbResult) return true;

  const items = getLocal().filter((s) => s.id !== scheduleId);
  setLocal(items);
  return true;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

async function updateScheduleStatus(scheduleId, status) {
  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('ai_employee_schedules')
      .update({ status })
      .eq('id', scheduleId)
      .select()
      .single();
    if (error) throw error;
    return data;
  });
  if (sbResult) return sbResult;

  const items = getLocal();
  const idx = items.findIndex((s) => s.id === scheduleId);
  if (idx >= 0) {
    items[idx].status = status;
    setLocal(items);
    return items[idx];
  }
  return null;
}

// ── Event-based triggers (OpenCloud file events) ─────────────────────────────
// These allow schedules to fire when an OpenCloud file event occurs
// (e.g. "run forecast when a new .xlsx is uploaded to /Imports").

const _eventUnsubscribers = new Map(); // scheduleId → unsubscribe fn

/**
 * Register an event-based trigger schedule.
 * When the specified event fires, the schedule's task_template is executed.
 *
 * @param {string} employeeId
 * @param {'on_file_uploaded'|'on_file_modified'|'on_file_detected'} triggerType
 * @param {object} triggerConfig - { driveId?, folderId?, filter?: string[], debounceMs?: number }
 * @param {object} taskTemplate - { title, template_id|workflow_type, input_context, priority }
 * @param {string} [createdBy]
 * @returns {Promise<object>} Created schedule
 */
export async function createEventTrigger(employeeId, triggerType, triggerConfig, taskTemplate, createdBy = null) {
  const schedule = await createSchedule(employeeId, {
    schedule_type: triggerType,
    trigger_config: triggerConfig,
  }, taskTemplate, createdBy);

  // Wire up the event listener
  activateEventTrigger(schedule);

  return schedule;
}

/**
 * Activate an event-based trigger by subscribing to the matching eventBus event.
 * @param {object} schedule
 */
export function activateEventTrigger(schedule) {
  const type = schedule.schedule_type;
  if (!type?.startsWith('on_file_')) return;

  // Lazy import to avoid circular dependencies
  const doActivate = async () => {
    const { eventBus, EVENT_NAMES } = await import('./eventBus');

    const eventMap = {
      on_file_uploaded: EVENT_NAMES.OPENCLOUD_FILE_UPLOADED,
      on_file_modified: EVENT_NAMES.OPENCLOUD_FILE_MODIFIED,
      on_file_detected: EVENT_NAMES.OPENCLOUD_FILE_DETECTED,
    };

    const eventName = eventMap[type];
    if (!eventName) return;

    const config = schedule.trigger_config || schedule.task_template?.trigger_config || {};
    let debounceTimer = null;

    const handler = (payload) => {
      // Filter by drive
      if (config.driveId && payload.driveId !== config.driveId) return;

      // Filter by folder
      if (config.folderId && payload.item?.parentReference?.id !== config.folderId) return;

      // Filter by file extension
      if (config.filter?.length) {
        const name = payload.item?.name || '';
        if (!config.filter.some((ext) => name.toLowerCase().endsWith(ext))) return;
      }

      // Debounce rapid events
      const debounceMs = config.debounceMs || 5000;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        eventBus.emit(EVENT_NAMES.TRIGGER_FIRED, {
          scheduleId: schedule.id,
          triggerType: type,
          taskTemplate: schedule.task_template,
          triggerPayload: payload,
          firedAt: new Date().toISOString(),
        });
      }, debounceMs);
    };

    const unsub = eventBus.on(eventName, handler);
    _eventUnsubscribers.set(schedule.id, unsub);
  };

  doActivate().catch((err) => {
    console.warn('[scheduledTaskService] Failed to activate event trigger:', err?.message);
  });
}

/**
 * Deactivate an event-based trigger.
 * @param {string} scheduleId
 */
export function deactivateEventTrigger(scheduleId) {
  const unsub = _eventUnsubscribers.get(scheduleId);
  if (unsub) {
    unsub();
    _eventUnsubscribers.delete(scheduleId);
  }
}

/**
 * List all active event triggers.
 * @returns {{ scheduleId: string, type: string }[]}
 */
export function listEventTriggers() {
  return Array.from(_eventUnsubscribers.keys()).map((id) => ({
    scheduleId: id,
    active: true,
  }));
}

// ── Default export ───────────────────────────────────────────────────────────

export default {
  SCHEDULE_TYPES,
  computeNextRun,
  advanceNextRun,
  createSchedule,
  getSchedules,
  getSchedule,
  getDueTasks,
  markExecuted,
  pauseSchedule,
  resumeSchedule,
  deleteSchedule,
  createEventTrigger,
  activateEventTrigger,
  deactivateEventTrigger,
  listEventTriggers,
};
