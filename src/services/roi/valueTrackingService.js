/**
 * valueTrackingService.js — Persists ROI value events to Supabase
 *
 * Called by orchestrator._completeTask() after decision artifacts are built.
 * Extracts value events from artifacts and inserts them into value_events table.
 *
 * @module services/roi/valueTrackingService
 */

import { supabase } from '../supabaseClient.js';
import { extractValueEvents, summarizeValueEvents } from './roiCalculators.js';

// ── Record values on task completion ────────────────────────────────────────

/**
 * Record value events for a completed task.
 *
 * @param {Object} params
 * @param {Object} params.decisionBrief - decision_brief artifact
 * @param {Object} params.writebackPayload - writeback_payload artifact
 * @param {Object} params.taskMeta - { id, title, workflowType }
 * @param {string} [params.workerId]
 * @returns {Promise<{ events_created: number, total_value: number }>}
 */
export async function recordTaskValue({
  decisionBrief,
  writebackPayload,
  taskMeta,
  workerId = null,
}) {
  const events = extractValueEvents({ decisionBrief, writebackPayload, taskMeta, workerId });

  if (events.length === 0) {
    return { events_created: 0, total_value: 0 };
  }

  // Insert all value events
  const rows = events.map(e => ({
    task_id: e.task_id,
    worker_id: e.worker_id,
    value_type: e.value_type,
    value_amount: e.value_amount,
    confidence: e.confidence,
    calculation_method: e.calculation_method,
    baseline_reference: e.baseline_reference,
    evidence_refs: [],
    workflow_type: e.workflow_type,
  }));

  const { error } = await supabase
    .from('value_events')
    .insert(rows);

  if (error) {
    console.warn('[ValueTracking] Failed to insert value events:', error.message);
    return { events_created: 0, total_value: 0, error: error.message };
  }

  const summary = summarizeValueEvents(events);
  return { events_created: events.length, total_value: summary.total_value };
}

// ── Query API ───────────────────────────────────────────────────────────────

/**
 * Get value events for a specific task.
 */
export async function getTaskValueEvents(taskId) {
  const { data, error } = await supabase
    .from('value_events')
    .select('*')
    .eq('task_id', taskId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Failed to get value events: ${error.message}`);
  return data || [];
}

/**
 * Get value events for a worker within a date range.
 */
export async function getWorkerValueEvents(workerId, { from, to } = {}) {
  let query = supabase
    .from('value_events')
    .select('*')
    .eq('worker_id', workerId)
    .order('created_at', { ascending: false });

  if (from) query = query.gte('created_at', from);
  if (to) query = query.lte('created_at', to);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to get worker value events: ${error.message}`);
  return data || [];
}

/**
 * Get aggregate ROI summary for a worker.
 *
 * @param {string} workerId
 * @param {Object} [opts]
 * @param {string} [opts.period] - 'mtd' | 'ytd' | 'all'
 * @returns {Promise<Object>}
 */
export async function getWorkerROISummary(workerId, { period = 'mtd' } = {}) {
  const now = new Date();
  let from = null;

  if (period === 'mtd') {
    from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  } else if (period === 'ytd') {
    from = new Date(now.getFullYear(), 0, 1).toISOString();
  }

  const events = await getWorkerValueEvents(workerId, { from });
  const summary = summarizeValueEvents(events);

  return {
    ...summary,
    period,
    worker_id: workerId,
    from,
    to: now.toISOString(),
  };
}

/**
 * Get global ROI summary across all workers.
 */
export async function getGlobalROISummary({ period = 'mtd' } = {}) {
  const now = new Date();
  let from = null;

  if (period === 'mtd') {
    from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  } else if (period === 'ytd') {
    from = new Date(now.getFullYear(), 0, 1).toISOString();
  }

  let query = supabase
    .from('value_events')
    .select('*')
    .order('created_at', { ascending: false });

  if (from) query = query.gte('created_at', from);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to get global ROI: ${error.message}`);

  const events = data || [];
  const summary = summarizeValueEvents(events);

  // Group by worker
  const byWorker = {};
  for (const e of events) {
    const wid = e.worker_id || 'unknown';
    if (!byWorker[wid]) byWorker[wid] = [];
    byWorker[wid].push(e);
  }

  const workerSummaries = {};
  for (const [wid, workerEvents] of Object.entries(byWorker)) {
    workerSummaries[wid] = summarizeValueEvents(workerEvents);
  }

  return {
    ...summary,
    period,
    from,
    to: now.toISOString(),
    by_worker: workerSummaries,
  };
}
