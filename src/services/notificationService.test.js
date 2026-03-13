// @product: ai-employee
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock supabaseClient
vi.mock('./supabaseClient', () => ({ supabase: null }));

import {
  NOTIFICATION_TYPES,
  subscribe,
  unsubscribe,
  notify,
  getNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
  _clearListeners,
} from './notificationService';

beforeEach(() => {
  _clearListeners();
});

// ── NOTIFICATION_TYPES ───────────────────────────────────────────────────────

describe('NOTIFICATION_TYPES', () => {
  it('has all expected types', () => {
    expect(NOTIFICATION_TYPES.TASK_COMPLETED).toBe('task_completed');
    expect(NOTIFICATION_TYPES.TASK_FAILED).toBe('task_failed');
    expect(NOTIFICATION_TYPES.BUDGET_EXCEEDED).toBe('budget_exceeded');
    expect(NOTIFICATION_TYPES.DAILY_SUMMARY_READY).toBe('daily_summary_ready');
    expect(NOTIFICATION_TYPES.PROACTIVE_TASK_CREATED).toBe('proactive_task_created');
    expect(NOTIFICATION_TYPES.SCHEDULE_EXECUTED).toBe('schedule_executed');
  });
});

// ── Event bus ────────────────────────────────────────────────────────────────

describe('subscribe / unsubscribe', () => {
  it('calls handler when event is emitted via notify', async () => {
    const handler = vi.fn();
    subscribe('task_completed', handler);

    await notify({
      userId: 'user-1',
      type: 'task_completed',
      title: 'Task done',
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      type: 'task_completed',
      title: 'Task done',
    }));
  });

  it('does not call handler after unsubscribe', async () => {
    const handler = vi.fn();
    subscribe('task_failed', handler);
    unsubscribe('task_failed', handler);

    await notify({
      userId: 'user-1',
      type: 'task_failed',
      title: 'Task failed',
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('unsubscribe function returned by subscribe works', async () => {
    const handler = vi.fn();
    const unsub = subscribe('budget_exceeded', handler);
    unsub();

    await notify({
      userId: 'user-1',
      type: 'budget_exceeded',
      title: 'Budget exceeded',
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('handles multiple subscribers', async () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    subscribe('task_completed', h1);
    subscribe('task_completed', h2);

    await notify({
      userId: 'user-1',
      type: 'task_completed',
      title: 'Done',
    });

    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it('does not call handler for different event type', async () => {
    const handler = vi.fn();
    subscribe('task_completed', handler);

    await notify({
      userId: 'user-1',
      type: 'task_failed',
      title: 'Failed',
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('survives handler error', async () => {
    const badHandler = vi.fn(() => { throw new Error('boom'); });
    const goodHandler = vi.fn();
    subscribe('task_completed', badHandler);
    subscribe('task_completed', goodHandler);

    await notify({
      userId: 'user-1',
      type: 'task_completed',
      title: 'Done',
    });

    expect(badHandler).toHaveBeenCalled();
    expect(goodHandler).toHaveBeenCalled();
  });
});

// ── notify ───────────────────────────────────────────────────────────────────

describe('notify', () => {
  it('returns a notification record with id', async () => {
    const record = await notify({
      userId: 'user-1',
      employeeId: 'emp-1',
      type: 'task_completed',
      title: 'Forecast completed',
      body: { task_id: 'task-1' },
      taskId: 'task-1',
    });

    expect(record.id).toBeTruthy();
    expect(record.user_id).toBe('user-1');
    expect(record.employee_id).toBe('emp-1');
    expect(record.type).toBe('task_completed');
    expect(record.title).toBe('Forecast completed');
    expect(record.read).toBe(false);
    expect(record.task_id).toBe('task-1');
    expect(record.created_at).toBeTruthy();
  });

  it('defaults optional fields to null', async () => {
    const record = await notify({
      userId: 'user-1',
      type: 'daily_summary_ready',
      title: 'Daily summary',
    });

    expect(record.employee_id).toBeNull();
    expect(record.body).toBeNull();
    expect(record.task_id).toBeNull();
  });
});

// ── getNotifications / getUnreadCount ────────────────────────────────────────

describe('getNotifications', () => {
  it('returns empty array when no notifications exist (no Supabase, no localStorage)', async () => {
    const result = await getNotifications('nonexistent');
    expect(Array.isArray(result)).toBe(true);
  });
});

describe('getUnreadCount', () => {
  it('returns 0 for unknown user', async () => {
    const count = await getUnreadCount('nonexistent');
    expect(count).toBe(0);
  });
});

// ── markRead / markAllRead ───────────────────────────────────────────────────

describe('markRead', () => {
  it('returns null for nonexistent notification (no Supabase, no localStorage)', async () => {
    const result = await markRead('nonexistent-id');
    expect(result).toBeNull();
  });
});

describe('markAllRead', () => {
  it('returns true even with no notifications', async () => {
    const result = await markAllRead('user-1');
    expect(result).toBe(true);
  });
});
