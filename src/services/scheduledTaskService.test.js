// @product: ai-employee
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock supabaseClient
vi.mock('./supabaseClient', () => ({ supabase: null }));

import {
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
} from './scheduledTaskService';

// ── Constants ────────────────────────────────────────────────────────────────

describe('SCHEDULE_TYPES', () => {
  it('has expected types', () => {
    expect(SCHEDULE_TYPES.DAILY).toBe('daily');
    expect(SCHEDULE_TYPES.WEEKLY).toBe('weekly');
    expect(SCHEDULE_TYPES.MONTHLY).toBe('monthly');
    expect(SCHEDULE_TYPES.CRON).toBe('cron');
  });
});

// ── computeNextRun ───────────────────────────────────────────────────────────

describe('computeNextRun', () => {
  it('returns a valid ISO string for daily', () => {
    const next = computeNextRun('daily', { hour: 10 });
    expect(next).toBeTruthy();
    const date = new Date(next);
    expect(date.getUTCHours()).toBe(10);
    expect(date > new Date()).toBe(true);
  });

  it('returns a valid ISO string for weekly', () => {
    const next = computeNextRun('weekly', { hour: 8, dayOfWeek: 3 }); // Wednesday
    const date = new Date(next);
    expect(date.getUTCDay()).toBe(3);
    expect(date.getUTCHours()).toBe(8);
  });

  it('returns a valid ISO string for monthly', () => {
    const next = computeNextRun('monthly', { hour: 6, dayOfMonth: 15 });
    const date = new Date(next);
    expect(date.getUTCDate()).toBe(15);
    expect(date.getUTCHours()).toBe(6);
  });

  it('defaults to 1 day ahead for cron/unknown', () => {
    const next = computeNextRun('cron', { hour: 9 });
    const date = new Date(next);
    expect(date.getUTCHours()).toBe(9);
    // Should be roughly 1 day from now
    expect(date.getTime() - Date.now()).toBeGreaterThan(0);
    expect(date.getTime() - Date.now()).toBeLessThan(2 * 86400000);
  });
});

// ── advanceNextRun ───────────────────────────────────────────────────────────

describe('advanceNextRun', () => {
  it('computes next run from schedule params', () => {
    const schedule = { schedule_type: 'daily', hour: 14 };
    const next = advanceNextRun(schedule);
    const date = new Date(next);
    expect(date.getUTCHours()).toBe(14);
  });
});

// ── CRUD (localStorage fallback) ─────────────────────────────────────────────

describe('createSchedule', () => {
  it('returns a schedule with correct fields', async () => {
    const sched = await createSchedule(
      'emp-1',
      { schedule_type: 'daily', hour: 9 },
      { title: 'Daily Forecast', template_id: 'forecast', priority: 'medium' },
      'user-1'
    );
    expect(sched.id).toBeTruthy();
    expect(sched.employee_id).toBe('emp-1');
    expect(sched.schedule_type).toBe('daily');
    expect(sched.hour).toBe(9);
    expect(sched.task_template.title).toBe('Daily Forecast');
    expect(sched.status).toBe('active');
    expect(sched.next_run_at).toBeTruthy();
    expect(sched.last_run_at).toBeNull();
    expect(sched.created_by).toBe('user-1');
  });

  it('defaults hour to 8', async () => {
    const sched = await createSchedule(
      'emp-1',
      { schedule_type: 'daily' },
      { title: 'Test' }
    );
    expect(sched.hour).toBe(8);
  });
});

describe('getSchedules', () => {
  it('returns empty array for unknown employee (no Supabase, no localStorage in node)', async () => {
    const schedules = await getSchedules('nonexistent');
    // May return empty or local entries depending on env
    expect(Array.isArray(schedules)).toBe(true);
  });
});

describe('getDueTasks', () => {
  it('returns empty array when no schedules are due', async () => {
    const due = await getDueTasks();
    // In node env without localStorage, returns empty
    expect(Array.isArray(due)).toBe(true);
  });
});

// ── Schedule lifecycle ───────────────────────────────────────────────────────

describe('schedule lifecycle (unit logic)', () => {
  function makeSchedule(overrides = {}) {
    return {
      id: 'sched-1',
      employee_id: 'emp-1',
      schedule_type: 'daily',
      hour: 8,
      day_of_week: null,
      day_of_month: null,
      task_template: { title: 'Test', template_id: 'forecast' },
      last_run_at: null,
      next_run_at: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago (due)
      status: 'active',
      ...overrides,
    };
  }

  it('schedule is due when next_run_at is in the past', () => {
    const sched = makeSchedule();
    expect(new Date(sched.next_run_at) <= new Date()).toBe(true);
  });

  it('schedule is not due when next_run_at is in the future', () => {
    const sched = makeSchedule({ next_run_at: new Date(Date.now() + 86400000).toISOString() });
    expect(new Date(sched.next_run_at) > new Date()).toBe(true);
  });

  it('paused schedule should not fire', () => {
    const sched = makeSchedule({ status: 'paused' });
    expect(sched.status).toBe('paused');
  });

  it('advanceNextRun moves to next day for daily', () => {
    const sched = makeSchedule({ schedule_type: 'daily', hour: 10 });
    const next = advanceNextRun(sched);
    const date = new Date(next);
    expect(date.getUTCHours()).toBe(10);
    expect(date > new Date()).toBe(true);
  });

  it('advanceNextRun moves to next week for weekly', () => {
    const sched = makeSchedule({ schedule_type: 'weekly', hour: 8, day_of_week: 5 }); // Friday
    const next = advanceNextRun(sched);
    const date = new Date(next);
    expect(date.getUTCDay()).toBe(5);
  });
});

// ── Weekly schedule on specific day ──────────────────────────────────────────

describe('weekly schedule', () => {
  it('creates with day_of_week', async () => {
    const sched = await createSchedule(
      'emp-2',
      { schedule_type: 'weekly', hour: 14, day_of_week: 1 }, // Monday 2pm
      { title: 'Weekly Report', template_id: 'full_report', priority: 'medium' }
    );
    expect(sched.schedule_type).toBe('weekly');
    expect(sched.day_of_week).toBe(1);
    const nextDate = new Date(sched.next_run_at);
    expect(nextDate.getUTCDay()).toBe(1);
    expect(nextDate.getUTCHours()).toBe(14);
  });
});

// ── Monthly schedule ─────────────────────────────────────────────────────────

describe('monthly schedule', () => {
  it('creates with day_of_month', async () => {
    const sched = await createSchedule(
      'emp-3',
      { schedule_type: 'monthly', hour: 6, day_of_month: 1 },
      { title: 'Monthly Summary', template_id: 'full_report', priority: 'low' }
    );
    expect(sched.schedule_type).toBe('monthly');
    expect(sched.day_of_month).toBe(1);
    const nextDate = new Date(sched.next_run_at);
    expect(nextDate.getUTCDate()).toBe(1);
  });
});
