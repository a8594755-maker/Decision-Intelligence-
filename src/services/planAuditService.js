/**
 * planAuditService.js
 *
 * Persist planning audit trail events to Supabase for frontend-readable
 * decision history.
 */

import { supabase } from './supabaseClient';

const TABLE = 'di_plan_audit_log';

export async function recordPlanGenerated({
  userId,
  runId,
  kpiSnapshot = {},
  narrativeSummary = '',
  metadata = {}
}) {
  return appendAuditEvent({
    userId,
    runId,
    action: 'plan_generated',
    actor: userId,
    kpiSnapshot,
    narrativeSummary: String(narrativeSummary || '').slice(0, 500),
    metadata
  });
}

export async function recordPlanApproved({
  userId,
  runId,
  approvalId,
  note = '',
  kpiSnapshot = {}
}) {
  return appendAuditEvent({
    userId,
    runId,
    action: 'plan_approved',
    actor: userId,
    approvalId,
    note,
    kpiSnapshot,
    metadata: { approval_id: approvalId }
  });
}

export async function recordPlanRejected({
  userId,
  runId,
  approvalId,
  note = ''
}) {
  return appendAuditEvent({
    userId,
    runId,
    action: 'plan_rejected',
    actor: userId,
    approvalId,
    note,
    metadata: { approval_id: approvalId, rejection_reason: note }
  });
}

export async function recordScenarioRun({
  userId,
  runId,
  scenarioId,
  overrides = {},
  kpiSnapshot = {},
  narrativeSummary = ''
}) {
  return appendAuditEvent({
    userId,
    runId,
    action: 'scenario_run',
    actor: userId,
    kpiSnapshot,
    narrativeSummary: String(narrativeSummary || '').slice(0, 500),
    metadata: { scenario_id: scenarioId, overrides }
  });
}

export async function getAuditTrailForRun(userId, runId, limit = 20) {
  if (!userId || !runId) return [];

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('user_id', userId)
      .eq('run_id', Number(runId))
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      const msg = error.message || '';
      if (msg.includes('does not exist') || msg.includes('42P01')) return [];
      throw error;
    }

    return data || [];
  } catch (error) {
    console.warn('[planAuditService] getAuditTrailForRun failed:', error.message);
    return [];
  }
}

export async function getRecentAuditTrail(userId, limit = 50) {
  if (!userId) return [];

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      const msg = error.message || '';
      if (msg.includes('does not exist') || msg.includes('42P01')) return [];
      throw error;
    }

    return data || [];
  } catch (error) {
    console.warn('[planAuditService] getRecentAuditTrail failed:', error.message);
    return [];
  }
}

async function appendAuditEvent({
  userId,
  runId,
  action,
  actor,
  kpiSnapshot = {},
  narrativeSummary = '',
  approvalId = null,
  note = '',
  metadata = {}
}) {
  if (!userId) return null;

  const payload = {
    user_id: userId,
    run_id: runId ? Number(runId) : null,
    action,
    actor: actor || userId,
    kpi_snapshot: kpiSnapshot,
    narrative_summary: narrativeSummary || null,
    approval_id: approvalId || null,
    note: note || null,
    metadata,
    created_at: new Date().toISOString()
  };

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .insert([payload])
      .select('*')
      .single();

    if (error) {
      const msg = error.message || '';
      if (msg.includes('does not exist') || msg.includes('42P01')) {
        console.warn('[planAuditService] di_plan_audit_log table not found. Run migration first.');
        return null;
      }
      throw error;
    }

    return data;
  } catch (error) {
    console.warn('[planAuditService] appendAuditEvent failed (non-fatal):', error.message);
    return null;
  }
}
