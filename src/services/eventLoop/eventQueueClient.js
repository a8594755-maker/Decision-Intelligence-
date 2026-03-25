/**
 * eventQueueClient.js — Frontend client for event_queue operations.
 *
 * Provides CRUD for event_queue + event_rules via Supabase,
 * and HTTP methods for the Python event ingest/status APIs.
 *
 * @module services/eventLoop/eventQueueClient
 */

import { supabase } from '../infra/supabaseClient.js';

const ML_API = typeof import.meta !== 'undefined' && import.meta.env?.VITE_ML_API_URL
  ? import.meta.env.VITE_ML_API_URL
  : 'http://localhost:8000';

// ── Event Queue ─────────────────────────────────────────────────────────────

/**
 * Ingest an event via the Python API (with HMAC validation support).
 *
 * @param {Object} params
 * @param {string} params.event_type
 * @param {string} params.source_system
 * @param {Object} params.payload
 * @param {string} [params.signature]
 * @returns {Promise<{event_id: string, status: string}>}
 */
export async function ingestEvent({ event_type, source_system = 'frontend', payload = {}, signature = null }) {
  const res = await fetch(`${ML_API}/api/v1/events/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_type, source_system, payload, signature }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `Event ingest failed: HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Ingest an event directly via Supabase (bypass Python API).
 * Useful for frontend-originated synthetic events.
 */
export async function ingestEventDirect({ event_type, source_system = 'frontend', payload = {} }) {
  const { data, error } = await supabase
    .from('event_queue')
    .insert({
      event_type,
      source_system,
      payload,
      status: 'pending',
    })
    .select()
    .single();

  if (error) throw new Error(`Event ingest failed: ${error.message}`);
  return { event_id: data.id, status: 'accepted' };
}

/**
 * Get event processor status from Python API.
 */
export async function getEventProcessorStatus() {
  const res = await fetch(`${ML_API}/api/v1/events/status`);
  if (!res.ok) throw new Error(`Status check failed: HTTP ${res.status}`);
  return res.json();
}

/**
 * List recent events from the queue.
 */
export async function listEvents({ limit = 50, status = null, eventType = null } = {}) {
  let query = supabase
    .from('event_queue')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (status) query = query.eq('status', status);
  if (eventType) query = query.eq('event_type', eventType);

  const { data, error } = await query;
  if (error) throw new Error(`List events failed: ${error.message}`);
  return data || [];
}

/**
 * Get event queue stats.
 */
export async function getEventQueueStats() {
  const { data, error } = await supabase
    .from('event_queue')
    .select('status');

  if (error) throw new Error(`Queue stats failed: ${error.message}`);

  const stats = { pending: 0, matched: 0, processed: 0, ignored: 0, failed: 0, total: 0 };
  for (const row of data || []) {
    stats[row.status] = (stats[row.status] || 0) + 1;
    stats.total++;
  }
  return stats;
}

// ── Event Rules ─────────────────────────────────────────────────────────────

/**
 * List all event rules.
 */
export async function listEventRules({ enabledOnly = false } = {}) {
  let query = supabase
    .from('event_rules')
    .select('*')
    .order('priority', { ascending: false });

  if (enabledOnly) query = query.eq('enabled', true);

  const { data, error } = await query;
  if (error) throw new Error(`List rules failed: ${error.message}`);
  return data || [];
}

/**
 * Create an event rule.
 */
export async function createEventRule(rule) {
  const { data, error } = await supabase
    .from('event_rules')
    .insert(rule)
    .select()
    .single();

  if (error) throw new Error(`Create rule failed: ${error.message}`);
  return data;
}

/**
 * Update an event rule.
 */
export async function updateEventRule(ruleId, updates) {
  const { data, error } = await supabase
    .from('event_rules')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', ruleId)
    .select()
    .single();

  if (error) throw new Error(`Update rule failed: ${error.message}`);
  return data;
}

/**
 * Delete an event rule.
 */
export async function deleteEventRule(ruleId) {
  const { error } = await supabase
    .from('event_rules')
    .delete()
    .eq('id', ruleId);

  if (error) throw new Error(`Delete rule failed: ${error.message}`);
}

/**
 * Toggle an event rule's enabled status.
 */
export async function toggleEventRule(ruleId, enabled) {
  return updateEventRule(ruleId, { enabled });
}
