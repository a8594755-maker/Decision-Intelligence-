/**
 * worklogRepo.js — Supabase CRUD for ai_employee_worklogs.
 *
 * Replaces the worklog portion of aiEmployeeService.js.
 * No localStorage fallback.
 *
 * When VITE_DI_MOCK_MODE=true, all functions delegate to in-memory mock.
 */

import { supabase } from '../../supabaseClient.js';

const _MOCK = import.meta.env?.VITE_DI_MOCK_MODE === 'true';
const _m = _MOCK ? await import('../mock/mockWorklogRepo.js') : null;

/**
 * Append a worklog entry.
 */
export async function appendWorklog(employeeId, taskId, runId, logType, content) {
  if (_m) return _m.appendWorklog(employeeId, taskId, runId, logType, content);
  const { data, error } = await supabase
    .from('ai_employee_worklogs')
    .insert({
      employee_id: employeeId,
      task_id: taskId,
      run_id: runId,
      log_type: logType,
      content,
      created_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) throw new Error(`[WorklogRepo] appendWorklog failed: ${error.message}`);
  return data;
}

/**
 * List worklogs.
 * If userId is provided, queries across ALL employees for that user.
 * Falls back to single employeeId filter if userId is not given.
 */
export async function listWorklogs(employeeId, { limit = 50, taskId, userId } = {}) {
  if (_m) return _m.listWorklogs(employeeId, { limit, taskId, userId });
  let query;

  if (userId) {
    // Resolve all employee IDs for this user
    const { data: emps } = await supabase
      .from('ai_employees')
      .select('id')
      .eq('manager_user_id', userId);
    const empIds = (emps || []).map((e) => e.id);
    if (empIds.length === 0) return [];

    query = supabase
      .from('ai_employee_worklogs')
      .select('*')
      .in('employee_id', empIds)
      .order('created_at', { ascending: false })
      .limit(limit);
  } else {
    query = supabase
      .from('ai_employee_worklogs')
      .select('*')
      .eq('employee_id', employeeId)
      .order('created_at', { ascending: false })
      .limit(limit);
  }

  if (taskId) query = query.eq('task_id', taskId);

  const { data, error } = await query;
  if (error) throw new Error(`[WorklogRepo] listWorklogs failed: ${error.message}`);
  return data || [];
}
