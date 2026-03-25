/**
 * dataEditAuditService.js
 *
 * Field-level audit trail for inline edits made through Plan Studio Data tab.
 * Follows the planAuditService.js graceful-degradation pattern.
 */

import { supabase } from '../infra/supabaseClient';

const TABLE = 'di_data_edit_log';
let isTableUnavailable = false;
let hasWarned = false;

function isMissingTableError(error) {
  if (!error) return false;
  const code = String(error?.code || '').toUpperCase();
  const status = Number(error?.status || 0);
  const blob = [error?.message, error?.details, error?.hint]
    .filter(Boolean).join(' ').toLowerCase();

  return (
    code === '42P01' ||
    code === 'PGRST205' ||
    status === 404 ||
    blob.includes('does not exist') ||
    blob.includes('schema cache') ||
    blob.includes(TABLE)
  );
}

function markUnavailable(error) {
  isTableUnavailable = true;
  if (!hasWarned) {
    console.warn(
      '[dataEditAuditService] di_data_edit_log table unavailable. Run database/di_data_edit_log.sql.',
      error?.message || ''
    );
    hasWarned = true;
  }
}

/**
 * Record a field-level edit.
 */
export async function recordFieldEdit({
  userId,
  tableName,
  recordId,
  fieldName,
  oldValue,
  newValue,
  runId = null,
  conversationId = null,
  note = null
}) {
  if (!userId || isTableUnavailable) return null;

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .insert([{
        user_id: userId,
        table_name: tableName,
        record_id: String(recordId),
        field_name: fieldName,
        old_value: oldValue != null ? String(oldValue) : null,
        new_value: newValue != null ? String(newValue) : null,
        source: 'plan_studio',
        run_id: runId ? Number(runId) : null,
        conversation_id: conversationId || null,
        note: note || null,
      }])
      .select('*')
      .single();

    if (error) {
      if (isMissingTableError(error)) { markUnavailable(error); return null; }
      throw error;
    }
    return data;
  } catch (error) {
    console.warn('[dataEditAuditService] recordFieldEdit failed (non-fatal):', error.message);
    return null;
  }
}

/**
 * Get edit history for a specific record.
 */
export async function getEditHistoryForRecord(userId, tableName, recordId, limit = 20) {
  if (!userId || isTableUnavailable) return [];

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('user_id', userId)
      .eq('table_name', tableName)
      .eq('record_id', String(recordId))
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      if (isMissingTableError(error)) { markUnavailable(error); return []; }
      throw error;
    }
    return data || [];
  } catch (error) {
    console.warn('[dataEditAuditService] getEditHistoryForRecord failed:', error.message);
    return [];
  }
}

/**
 * Get recent edits across all tables for the current user.
 */
export async function getRecentEdits(userId, limit = 50) {
  if (!userId || isTableUnavailable) return [];

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      if (isMissingTableError(error)) { markUnavailable(error); return []; }
      throw error;
    }
    return data || [];
  } catch (error) {
    console.warn('[dataEditAuditService] getRecentEdits failed:', error.message);
    return [];
  }
}
