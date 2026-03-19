// @product: ai-employee
//
// notificationService.js
// ─────────────────────────────────────────────────────────────────────────────
// Lightweight event bus + persistent notifications for AI Employee system.
//
// Two layers:
//   1. In-memory pub/sub (subscribe/notify) — for real-time UI updates
//   2. Persistent notifications (Supabase + localStorage) — for bell icon
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from './supabaseClient';

// ── Constants ────────────────────────────────────────────────────────────────

export const NOTIFICATION_TYPES = {
  TASK_COMPLETED: 'task_completed',
  TASK_FAILED: 'task_failed',
  BUDGET_EXCEEDED: 'budget_exceeded',
  DAILY_SUMMARY_READY: 'daily_summary_ready',
  PROACTIVE_TASK_CREATED: 'proactive_task_created',
  SCHEDULE_EXECUTED: 'schedule_executed',
};

const LOCAL_KEY = 'ai_employee_notifications_v1';
const MAX_LOCAL = 200;

// ── In-memory event bus ──────────────────────────────────────────────────────

const _listeners = new Map(); // type → Set<handler>

/**
 * Subscribe to a notification type.
 * Returns an unsubscribe function.
 */
export function subscribe(type, handler) {
  if (!_listeners.has(type)) _listeners.set(type, new Set());
  _listeners.get(type).add(handler);
  return () => _listeners.get(type)?.delete(handler);
}

/**
 * Unsubscribe a specific handler from a notification type.
 */
export function unsubscribe(type, handler) {
  _listeners.get(type)?.delete(handler);
}

/**
 * Emit to in-memory listeners.
 */
function emit(type, payload) {
  const handlers = _listeners.get(type);
  if (!handlers) return;
  for (const handler of handlers) {
    try { handler(payload); } catch (e) {
      console.warn('[notificationService] Handler error:', e?.message);
    }
  }
}

// For testing: clear all listeners
export function _clearListeners() {
  _listeners.clear();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function now() { return new Date().toISOString(); }
function uuid() { return `local-notif-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`; }

async function trySupabase(fn) {
  try {
    if (!supabase) return null;
    return await fn();
  } catch (err) {
    console.warn('[notificationService] Supabase call failed:', err?.message || err);
    return null;
  }
}

function getLocal() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function setLocal(items) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(items.slice(-MAX_LOCAL)));
  } catch { /* quota */ }
}

// ── Core API ─────────────────────────────────────────────────────────────────

/**
 * Send a notification: persist + emit to in-memory listeners.
 *
 * @param {object} opts
 * @param {string} opts.userId - Recipient user ID
 * @param {string} [opts.employeeId] - Related AI employee
 * @param {string} opts.type - One of NOTIFICATION_TYPES
 * @param {string} opts.title - Human-readable title
 * @param {object} [opts.body] - Extra data (JSON)
 * @param {string} [opts.taskId] - Related task ID
 * @returns {Promise<object>} The notification record
 */
export async function notify({ userId, employeeId, type, title, body, taskId }) {
  const row = {
    user_id: userId,
    employee_id: employeeId || null,
    type,
    title,
    body: body || null,
    read: false,
    task_id: taskId || null,
    created_at: now(),
  };

  // Persist
  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('ai_employee_notifications')
      .insert(row)
      .select()
      .single();
    if (error) throw error;
    return data;
  });

  const record = sbResult || (() => {
    const entry = { id: uuid(), ...row };
    const items = getLocal();
    items.push(entry);
    setLocal(items);
    return entry;
  })();

  // Emit
  emit(type, record);

  return record;
}

/**
 * Get notifications for a user.
 *
 * @param {string} userId
 * @param {object} [opts]
 * @param {boolean} [opts.unreadOnly] - Only unread (default false)
 * @param {number} [opts.limit] - Max results (default 50)
 * @returns {Promise<object[]>}
 */
export async function getNotifications(userId, { unreadOnly = false, limit = 50 } = {}) {
  const sbResult = await trySupabase(async () => {
    let q = supabase
      .from('ai_employee_notifications')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (unreadOnly) q = q.eq('read', false);
    const { data, error } = await q;
    if (error) throw error;
    return data;
  });
  if (sbResult) return sbResult;

  let items = getLocal().filter((n) => n.user_id === userId);
  if (unreadOnly) items = items.filter((n) => !n.read);
  return items.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
}

/**
 * Get unread notification count.
 */
export async function getUnreadCount(userId) {
  const sbResult = await trySupabase(async () => {
    const { count, error } = await supabase
      .from('ai_employee_notifications')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('read', false);
    if (error) throw error;
    return count;
  });
  if (sbResult !== null) return sbResult;

  return getLocal().filter((n) => n.user_id === userId && !n.read).length;
}

/**
 * Mark a notification as read.
 */
export async function markRead(notificationId) {
  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('ai_employee_notifications')
      .update({ read: true })
      .eq('id', notificationId)
      .select()
      .single();
    if (error) throw error;
    return data;
  });
  if (sbResult) return sbResult;

  const items = getLocal();
  const idx = items.findIndex((n) => n.id === notificationId);
  if (idx >= 0) {
    items[idx].read = true;
    setLocal(items);
    return items[idx];
  }
  return null;
}

/**
 * Mark all notifications as read for a user.
 */
export async function markAllRead(userId) {
  const sbResult = await trySupabase(async () => {
    const { error } = await supabase
      .from('ai_employee_notifications')
      .update({ read: true })
      .eq('user_id', userId)
      .eq('read', false);
    if (error) throw error;
    return true;
  });
  if (sbResult) return true;

  const items = getLocal();
  for (const n of items) {
    if (n.user_id === userId) n.read = true;
  }
  setLocal(items);
  return true;
}

// ── Default export ───────────────────────────────────────────────────────────

export default {
  NOTIFICATION_TYPES,
  subscribe,
  unsubscribe,
  notify,
  getNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
  _clearListeners,
};
