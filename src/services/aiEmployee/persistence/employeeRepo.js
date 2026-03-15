/**
 * employeeRepo.js — Supabase CRUD for ai_employees.
 *
 * Manages employee status. Maps logical states to DB values
 * via EMPLOYEE_STATE_TO_DB for backward compatibility.
 */

import { supabase } from '../../supabaseClient.js';
import { EMPLOYEE_STATE_TO_DB, DB_TO_EMPLOYEE_STATE } from '../employeeStateMachine.js';

/**
 * Update employee status using logical state names.
 * @param {string} employeeId
 * @param {string} logicalState - one of EMPLOYEE_STATES values
 */
export async function updateEmployeeStatus(employeeId, logicalState) {
  const dbStatus = EMPLOYEE_STATE_TO_DB[logicalState];
  if (!dbStatus) {
    throw new Error(`[EmployeeRepo] Unknown logical state: '${logicalState}'`);
  }

  const { error } = await supabase
    .from('ai_employees')
    .update({ status: dbStatus })
    .eq('id', employeeId);

  if (error) throw new Error(`[EmployeeRepo] updateStatus failed: ${error.message}`);
}

/**
 * Get employee by ID, returns with logical state.
 */
export async function getEmployee(employeeId) {
  const { data, error } = await supabase
    .from('ai_employees')
    .select('*')
    .eq('id', employeeId)
    .single();

  if (error) throw new Error(`[EmployeeRepo] getEmployee failed: ${error.message}`);

  // Attach logical state
  data._logicalState = DB_TO_EMPLOYEE_STATE[data.status] || data.status;
  return data;
}

/**
 * Get employee by manager user ID (for Aiden lookup).
 */
export async function getEmployeeByManager(userId) {
  const { data, error } = await supabase
    .from('ai_employees')
    .select('*')
    .eq('manager_user_id', userId)
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`[EmployeeRepo] getEmployeeByManager failed: ${error.message}`);
  if (data) data._logicalState = DB_TO_EMPLOYEE_STATE[data.status] || data.status;
  return data;
}
