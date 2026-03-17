/**
 * delegationPersistence.js — Supabase persistence for multi-worker delegations
 *
 * Bridges multiWorkerService.js in-memory operations with Supabase
 * for durable storage and cross-session state.
 *
 * @module services/hardening/delegationPersistence
 */

import { supabase } from '../../lib/supabase.js';

// ── CRUD Operations ─────────────────────────────────────────────────────────

/**
 * Insert a delegation record into Supabase.
 */
export async function insertDelegation(delegation) {
  const row = {
    id: delegation.id,
    parent_task_id: delegation.parent_task_id,
    parent_worker_id: delegation.parent_worker_id,
    child_task_id: delegation.child_task_id || null,
    child_worker_id: delegation.child_worker_id,
    delegation_type: delegation.delegation_type,
    sequence_order: delegation.sequence_order ?? 0,
    context_json: delegation.context_json || {},
    status: delegation.status || 'pending',
    result_json: delegation.result_json || null,
    started_at: delegation.started_at || null,
    completed_at: delegation.completed_at || null,
  };

  const { data, error } = await supabase
    .from('task_delegations')
    .insert(row)
    .select()
    .single();

  if (error) {
    console.warn('[delegationPersistence] insert failed:', error.message);
    return { ok: false, error: error.message };
  }

  return { ok: true, data };
}

/**
 * Insert multiple delegations (e.g., a handoff chain or fan-out batch).
 */
export async function insertDelegations(delegations) {
  const rows = delegations.map(d => ({
    id: d.id,
    parent_task_id: d.parent_task_id,
    parent_worker_id: d.parent_worker_id,
    child_task_id: d.child_task_id || null,
    child_worker_id: d.child_worker_id,
    delegation_type: d.delegation_type,
    sequence_order: d.sequence_order ?? 0,
    context_json: d.context_json || {},
    status: d.status || 'pending',
    result_json: d.result_json || null,
    started_at: d.started_at || null,
    completed_at: d.completed_at || null,
  }));

  const { data, error } = await supabase
    .from('task_delegations')
    .insert(rows)
    .select();

  if (error) {
    console.warn('[delegationPersistence] batch insert failed:', error.message);
    return { ok: false, error: error.message };
  }

  return { ok: true, data, count: data?.length || 0 };
}

/**
 * Update a delegation's status, result, and timestamps.
 */
export async function updateDelegation(delegationId, updates) {
  const allowedFields = ['status', 'result_json', 'context_json', 'child_task_id', 'started_at', 'completed_at'];
  const patch = {};
  for (const key of allowedFields) {
    if (updates[key] !== undefined) {
      patch[key] = updates[key];
    }
  }

  const { data, error } = await supabase
    .from('task_delegations')
    .update(patch)
    .eq('id', delegationId)
    .select()
    .single();

  if (error) {
    console.warn('[delegationPersistence] update failed:', error.message);
    return { ok: false, error: error.message };
  }

  return { ok: true, data };
}

// ── Query Operations ────────────────────────────────────────────────────────

/**
 * Get all delegations for a parent task.
 */
export async function fetchDelegationsForTask(taskId) {
  const { data, error } = await supabase
    .from('task_delegations')
    .select('*')
    .eq('parent_task_id', taskId)
    .order('sequence_order', { ascending: true });

  if (error) {
    console.warn('[delegationPersistence] fetchForTask failed:', error.message);
    return [];
  }

  return data || [];
}

/**
 * Get all delegations involving a specific worker (as parent or child).
 */
export async function fetchDelegationsForWorker(workerId) {
  const { data, error } = await supabase
    .from('task_delegations')
    .select('*')
    .or(`parent_worker_id.eq.${workerId},child_worker_id.eq.${workerId}`)
    .order('created_at', { ascending: false });

  if (error) {
    console.warn('[delegationPersistence] fetchForWorker failed:', error.message);
    return [];
  }

  return data || [];
}

/**
 * Get delegations by type and status.
 */
export async function fetchDelegationsByTypeAndStatus(type, status) {
  const { data, error } = await supabase
    .from('task_delegations')
    .select('*')
    .eq('delegation_type', type)
    .eq('status', status)
    .order('created_at', { ascending: true });

  if (error) {
    console.warn('[delegationPersistence] fetchByTypeStatus failed:', error.message);
    return [];
  }

  return data || [];
}

/**
 * Get a single delegation by ID.
 */
export async function fetchDelegation(delegationId) {
  const { data, error } = await supabase
    .from('task_delegations')
    .select('*')
    .eq('id', delegationId)
    .single();

  if (error) return null;
  return data;
}

// ── Template Operations ─────────────────────────────────────────────────────

/**
 * Fetch all enabled delegation templates.
 */
export async function fetchDelegationTemplates() {
  const { data, error } = await supabase
    .from('delegation_templates')
    .select('*')
    .eq('enabled', true)
    .order('name', { ascending: true });

  if (error) {
    console.warn('[delegationPersistence] fetchTemplates failed:', error.message);
    return [];
  }

  return data || [];
}

// ── Stats ───────────────────────────────────────────────────────────────────

/**
 * Get delegation statistics.
 */
export async function fetchDelegationStats() {
  const { data, error } = await supabase
    .from('task_delegations')
    .select('delegation_type, status');

  if (error) return { total: 0, by_type: {}, by_status: {} };

  const byType = {};
  const byStatus = {};

  for (const row of (data || [])) {
    byType[row.delegation_type] = (byType[row.delegation_type] || 0) + 1;
    byStatus[row.status] = (byStatus[row.status] || 0) + 1;
  }

  return {
    total: data?.length || 0,
    by_type: byType,
    by_status: byStatus,
  };
}
