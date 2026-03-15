/**
 * worklogRepo.js — Supabase CRUD for ai_employee_worklogs.
 *
 * Replaces the worklog portion of aiEmployeeService.js.
 * No localStorage fallback.
 */

import { supabase } from '../../supabaseClient.js';

/**
 * Append a worklog entry.
 */
export async function appendWorklog(employeeId, taskId, runId, logType, content) {
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
