/**
 * planAuditService.js
 *
 * Persist planning audit trail events to Supabase for frontend-readable
 * decision history.
 */

import { supabase } from './supabaseClient';

const TABLE = 'di_plan_audit_log';
let isAuditTableUnavailable = false;
let hasWarnedAuditTableUnavailable = false;

function isMissingTableOrSchemaCacheError(error, tableName = TABLE) {
  if (!error) return false;

  const code = String(error?.code || '').toUpperCase();
  const status = Number(error?.status || 0);
  const blob = [
    error?.message,
    error?.details,
    error?.hint,
    error?.error_description
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const normalizedTable = String(tableName || '').toLowerCase();
  const tableReferenced = normalizedTable ? blob.includes(normalizedTable) : false;
  const missingSignal =
    blob.includes('schema cache') ||
    blob.includes('does not exist') ||
    blob.includes('relation') ||
    blob.includes('not found') ||
    blob.includes('could not find the table');

  return (
    code === '42P01' ||
    code === 'PGRST205' ||
    status === 404 ||
    (tableReferenced && missingSignal)
  );
}

function markAuditTableUnavailable(error) {
  isAuditTableUnavailable = true;
  if (!hasWarnedAuditTableUnavailable) {
    console.warn(
      '[planAuditService] di_plan_audit_log table unavailable. Run sql/migrations/di_plan_audit_log.sql, then NOTIFY pgrst, \'reload schema\'.',
      error?.message || ''
    );
    hasWarnedAuditTableUnavailable = true;
  }
}

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
  if (!userId || !runId || isAuditTableUnavailable) return [];

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('user_id', userId)
      .eq('run_id', Number(runId))
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      if (isMissingTableOrSchemaCacheError(error)) {
        markAuditTableUnavailable(error);
        return [];
      }
      throw error;
    }

    return data || [];
  } catch (error) {
    console.warn('[planAuditService] getAuditTrailForRun failed:', error.message);
    return [];
  }
}

export async function getRecentAuditTrail(userId, limit = 50) {
  if (!userId || isAuditTableUnavailable) return [];

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      if (isMissingTableOrSchemaCacheError(error)) {
        markAuditTableUnavailable(error);
        return [];
      }
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
  if (!userId || isAuditTableUnavailable) return null;

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
      if (isMissingTableOrSchemaCacheError(error)) {
        markAuditTableUnavailable(error);
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
