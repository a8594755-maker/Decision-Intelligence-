// @product: ai-employee
//
// discordApprovalBridge.js
// ─────────────────────────────────────────────────────────────────────────────
// Bridges the Vite app ↔ Discord approval flow via Supabase.
//
// Write side:  task created → insert into discord_approval_queue (pending)
// Read side:   poll for approved/denied → trigger approvePlan/cancelTask
//
// The Discord bot (separate Node.js process) polls for 'pending' rows,
// sends embeds with buttons, and updates status on button click.
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from '../infra/supabaseClient';
import { subscribe, NOTIFICATION_TYPES } from '../governance/notificationService';
import { approvePlan } from '../aiEmployee/index.js';

const POLL_INTERVAL_MS = 5000;
let _pollTimer = null;
let _unsubNotify = null;

// ── Queue a task for Discord approval ────────────────────────────────────────

/**
 * Insert a task into the discord_approval_queue.
 * Called after proactiveTaskGenerator creates a `waiting_approval` task.
 *
 * @param {object} opts
 * @param {string} opts.taskId
 * @param {string} opts.userId
 * @param {string} [opts.employeeId]
 * @param {string} opts.title
 * @param {string} [opts.description]
 * @param {string} [opts.priority]
 * @param {string} [opts.alertType]
 * @param {string} [opts.severity]
 * @param {string} [opts.notificationId]
 * @returns {Promise<object|null>}
 */
export async function queueForDiscordApproval({
  taskId,
  userId,
  employeeId,
  title,
  description,
  priority,
  alertType,
  severity,
  notificationId,
}) {
  if (!supabase) {
    console.warn('[discordApprovalBridge] No Supabase — skipping Discord queue');
    return null;
  }

  try {
    const { data, error } = await supabase
      .from('discord_approval_queue')
      .insert({
        task_id: taskId,
        user_id: userId,
        employee_id: employeeId || null,
        title,
        description: description || null,
        priority: priority || 'medium',
        alert_type: alertType || null,
        severity: severity || null,
        notification_id: notificationId || null,
      })
      .select()
      .single();

    if (error) throw error;
    console.log(`[discordApprovalBridge] 📤 Queued for Discord approval: ${title} (task=${taskId})`);
    return data;
  } catch (err) {
    console.warn('[discordApprovalBridge] queueForDiscordApproval failed:', err?.message);
    return null;
  }
}

// ── Poll for decisions ───────────────────────────────────────────────────────

/**
 * Poll the discord_approval_queue for decisions made via Discord.
 * - approved → approvePlan() → mark executed
 * - denied   → mark cancelled (task already cancelled by bot)
 */
export async function pollForDecisions(userId) {
  if (!supabase) return;

  try {
    // Handle approvals
    const { data: approved } = await supabase
      .from('discord_approval_queue')
      .select('*')
      .eq('status', 'approved')
      .eq('user_id', userId);

    for (const row of (approved || [])) {
      try {
        // The bot already set task status to 'queued', but we also call approvePlan
        // for full orchestrator side effects (event emissions, etc.)
        await approvePlan(row.task_id, userId);
        await supabase.from('discord_approval_queue')
          .update({ status: 'executed' })
          .eq('id', row.id);
        console.log(`[discordApprovalBridge] ✅ Executed approved task: ${row.task_id}`);
      } catch (err) {
        // If approvePlan fails (e.g. task already queued), just mark as executed
        console.warn('[discordApprovalBridge] approvePlan error (may be already queued):', err?.message);
        await supabase.from('discord_approval_queue')
          .update({ status: 'executed' })
          .eq('id', row.id);
      }
    }

    // Handle denials — just mark as processed (bot already cancelled the task)
    const { data: denied } = await supabase
      .from('discord_approval_queue')
      .select('*')
      .eq('status', 'denied')
      .eq('user_id', userId);

    for (const row of (denied || [])) {
      await supabase.from('discord_approval_queue')
        .update({ status: 'cancelled' })
        .eq('id', row.id);
      console.log(`[discordApprovalBridge] 🛑 Acknowledged denied task: ${row.task_id}`);
    }
  } catch (err) {
    console.warn('[discordApprovalBridge] pollForDecisions error:', err?.message);
  }
}

// ── Auto-init: listen for proactive task notifications ───────────────────────

/**
 * Start listening for PROACTIVE_TASK_CREATED notifications and auto-queue them.
 * Also starts the approval decision poller.
 *
 * @param {string} userId
 */
export function initDiscordBridge(userId) {
  if (_unsubNotify) return; // already initialized

  // Listen for proactive task creation → queue for Discord
  _unsubNotify = subscribe(NOTIFICATION_TYPES.PROACTIVE_TASK_CREATED, (notification) => {
    if (notification.task_id) {
      queueForDiscordApproval({
        taskId: notification.task_id,
        userId: notification.user_id,
        employeeId: notification.employee_id,
        title: notification.title,
        description: notification.body?.description || notification.body?.message || '',
        priority: notification.body?.priority || 'medium',
        alertType: notification.body?.alert_type || null,
        severity: notification.body?.severity || null,
        notificationId: notification.id,
      });
    }
  });

  // Start polling for Discord decisions
  _pollTimer = setInterval(() => pollForDecisions(userId), POLL_INTERVAL_MS);
  console.log(`[discordApprovalBridge] 🔄 Initialized — polling every ${POLL_INTERVAL_MS / 1000}s`);
}

/**
 * Stop the bridge (cleanup on unmount).
 */
export function stopDiscordBridge() {
  if (_unsubNotify) {
    _unsubNotify();
    _unsubNotify = null;
  }
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
  console.log('[discordApprovalBridge] 🛑 Stopped');
}

// ── Default export ───────────────────────────────────────────────────────────

export default {
  queueForDiscordApproval,
  pollForDecisions,
  initDiscordBridge,
  stopDiscordBridge,
};
