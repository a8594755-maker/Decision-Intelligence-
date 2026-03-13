// @product: ai-employee
//
// aiEmployeeService.js
// ─────────────────────────────────────────────────────────────────────────────
// Data layer for the AI Employee product surface.
// All five tables + KPI view are accessed here; nothing else touches Supabase
// for this product.
//
// Follows the trySupabase + localStorage fallback pattern from
// negotiationPersistenceService.js so the UI works without Supabase configured.
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from './supabaseClient';

const LOCAL_KEY = 'ai_employee_local_v1';
const MAX_LOCAL_ENTRIES = 500;

// ── Local store helpers ────────────────────────────────────────────────────

function getLocalStore() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return { employees: [], tasks: [], runs: [], reviews: [], worklogs: [] };
    return JSON.parse(raw);
  } catch {
    return { employees: [], tasks: [], runs: [], reviews: [], worklogs: [] };
  }
}

function setLocalStore(store) {
  try {
    // Trim each collection to avoid unbounded growth
    const trimmed = {
      employees: (store.employees || []).slice(-50),
      tasks: (store.tasks || []).slice(-MAX_LOCAL_ENTRIES),
      runs: (store.runs || []).slice(-MAX_LOCAL_ENTRIES),
      reviews: (store.reviews || []).slice(-MAX_LOCAL_ENTRIES),
      worklogs: (store.worklogs || []).slice(-MAX_LOCAL_ENTRIES),
    };
    localStorage.setItem(LOCAL_KEY, JSON.stringify(trimmed));
  } catch {
    // Quota exceeded — silently ignore
  }
}

function localId(prefix) {
  return `local-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function now() {
  return new Date().toISOString();
}

// ── Supabase guard ────────────────────────────────────────────────────────

async function trySupabase(fn) {
  try {
    if (!supabase) return null;
    return await fn();
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EMPLOYEES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the Aiden employee row, creating it if it doesn't exist.
 * Sets manager_user_id to userId on first creation so RLS policies work.
 */
export async function getOrCreateAiden(userId) {
  const sbResult = await trySupabase(async () => {
    // Try to find existing Aiden belonging to this manager
    // Use limit(1) instead of maybeSingle() to handle duplicate rows gracefully
    const { data: rows } = await supabase
      .from('ai_employees')
      .select('*')
      .eq('name', 'Aiden')
      .eq('manager_user_id', userId)
      .order('created_at', { ascending: true })
      .limit(1);

    const existing = rows?.[0] ?? null;
    if (existing) return existing;

    // Create Aiden with the calling user as manager
    const { data: created, error } = await supabase
      .from('ai_employees')
      .insert({
        name: 'Aiden',
        role: 'supply_chain_reporting_employee',
        status: 'idle',
        manager_user_id: userId,
        description: 'AI supply chain analyst. Runs forecasts, replenishment plans, and risk assessments on demand.',
        permissions: {
          can_run_forecast: true,
          can_run_plan: true,
          can_run_risk: true,
          can_write_worklog: true,
          can_submit_review: true,
        },
      })
      .select()
      .single();

    if (error) throw error;
    return created;
  });

  if (sbResult) return sbResult;

  // Local fallback
  const store = getLocalStore();
  let aiden = store.employees.find((e) => e.name === 'Aiden');
  if (!aiden) {
    aiden = {
      id: localId('emp'),
      name: 'Aiden',
      role: 'supply_chain_reporting_employee',
      status: 'idle',
      manager_user_id: userId,
      description: 'AI supply chain analyst.',
      permissions: { can_run_forecast: true, can_run_plan: true, can_run_risk: true },
      created_at: now(),
      updated_at: now(),
    };
    store.employees.push(aiden);
    setLocalStore(store);
  }
  return aiden;
}

export async function getEmployee(employeeId) {
  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('ai_employees')
      .select('*')
      .eq('id', employeeId)
      .single();
    if (error) throw error;
    return data;
  });
  if (sbResult) return sbResult;

  const store = getLocalStore();
  return store.employees.find((e) => e.id === employeeId) || null;
}

export async function updateEmployeeStatus(employeeId, status) {
  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('ai_employees')
      .update({ status, updated_at: now() })
      .eq('id', employeeId)
      .select()
      .single();
    if (error) throw error;
    return data;
  });
  if (sbResult) return sbResult;

  const store = getLocalStore();
  const emp = store.employees.find((e) => e.id === employeeId);
  if (emp) { emp.status = status; emp.updated_at = now(); }
  setLocalStore(store);
  return emp || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// TASKS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List all tasks across ALL employees belonging to a user.
 * Handles the case where multiple Aiden rows exist (from legacy bugs).
 */
export async function listTasksByUser(userId, { status } = {}) {
  const store = getLocalStore();
  let localTasks = store.tasks;
  if (status) localTasks = localTasks.filter((t) => t.status === status);

  const sbResult = await trySupabase(async () => {
    // Get all employee IDs for this user
    const { data: emps } = await supabase
      .from('ai_employees')
      .select('id')
      .eq('manager_user_id', userId);
    const empIds = (emps || []).map((e) => e.id);
    if (empIds.length === 0) return [];

    let q = supabase
      .from('ai_employee_tasks')
      .select('*')
      .in('employee_id', empIds)
      .order('created_at', { ascending: false });
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw error;
    return data;
  });

  if (sbResult !== null) {
    const sbIds = new Set(sbResult.map((t) => t.id));
    const localOnly = localTasks.filter((t) => !sbIds.has(t.id));
    return [...sbResult, ...localOnly].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  return localTasks.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function listTasks(employeeId, { status } = {}) {
  // Always load local tasks first — acts as fallback and catches tasks saved locally
  const store = getLocalStore();
  let localTasks = store.tasks.filter((t) => t.employee_id === employeeId);
  if (status) localTasks = localTasks.filter((t) => t.status === status);

  const sbResult = await trySupabase(async () => {
    let q = supabase
      .from('ai_employee_tasks')
      .select('*')
      .eq('employee_id', employeeId)
      .order('created_at', { ascending: false });
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw error;
    return data;
  });

  if (sbResult !== null) {
    const sbIds = new Set(sbResult.map((t) => t.id));
    const localOnly = localTasks.filter((t) => !sbIds.has(t.id));
    return [...sbResult, ...localOnly].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  return localTasks.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function getTask(taskId) {
  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('ai_employee_tasks')
      .select('*')
      .eq('id', taskId)
      .single();
    if (error) throw error;
    return data;
  });
  if (sbResult) return sbResult;

  const store = getLocalStore();
  return store.tasks.find((t) => t.id === taskId) || null;
}

export async function createTask(employeeId, {
  title,
  description = null,
  priority = 'medium',
  input_context = {},
  expected_output = null,
  due_at = null,
  assigned_by_user_id = null,
  source_type = 'manual',
}) {
  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('ai_employee_tasks')
      .insert({
        employee_id: employeeId,
        title,
        description,
        priority,
        status: 'todo',
        source_type,
        assigned_by_user_id,
        due_at,
        input_context,
        expected_output,
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  });
  if (sbResult) return sbResult;

  const task = {
    id: localId('task'),
    employee_id: employeeId,
    title,
    description,
    priority,
    status: 'todo',
    source_type,
    assigned_by_user_id,
    due_at,
    input_context,
    expected_output,
    latest_run_id: null,
    created_at: now(),
    updated_at: now(),
  };
  const store = getLocalStore();
  store.tasks.push(task);
  setLocalStore(store);
  return task;
}

/**
 * Update task status. Optionally sets latest_run_id in the same call.
 * Handles the deferred FK by updating both fields together.
 */
export async function updateTaskStatus(taskId, status, latestRunId = undefined) {
  const patch = { status, updated_at: now() };
  if (latestRunId !== undefined) patch.latest_run_id = latestRunId;

  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('ai_employee_tasks')
      .update(patch)
      .eq('id', taskId)
      .select()
      .single();
    if (error) throw error;
    return data;
  });
  if (sbResult) return sbResult;

  const store = getLocalStore();
  const task = store.tasks.find((t) => t.id === taskId);
  if (task) { Object.assign(task, patch); }
  setLocalStore(store);
  return task || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// RUNS
// ─────────────────────────────────────────────────────────────────────────────

export async function createRun(taskId, employeeId) {
  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('ai_employee_runs')
      .insert({
        task_id: taskId,
        employee_id: employeeId,
        status: 'running',
        artifact_refs: [],
        started_at: now(),
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  });
  if (sbResult) return sbResult;

  const run = {
    id: localId('run'),
    task_id: taskId,
    employee_id: employeeId,
    status: 'running',
    di_run_id: null,
    artifact_refs: [],
    summary: null,
    error_message: null,
    started_at: now(),
    ended_at: null,
  };
  const store = getLocalStore();
  store.runs.push(run);
  setLocalStore(store);
  return run;
}

export async function updateRun(runId, { status, summary, error_message, artifact_refs, ended_at, di_run_id } = {}) {
  const patch = {};
  if (status !== undefined) patch.status = status;
  if (summary !== undefined) patch.summary = summary;
  if (error_message !== undefined) patch.error_message = error_message;
  if (artifact_refs !== undefined) patch.artifact_refs = artifact_refs;
  if (ended_at !== undefined) patch.ended_at = ended_at;
  if (di_run_id !== undefined) patch.di_run_id = di_run_id;

  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('ai_employee_runs')
      .update(patch)
      .eq('id', runId)
      .select()
      .single();
    if (error) throw error;
    return data;
  });
  if (sbResult) return sbResult;

  const store = getLocalStore();
  const run = store.runs.find((r) => r.id === runId);
  if (run) { Object.assign(run, patch); }
  setLocalStore(store);
  return run || null;
}

export async function getRun(runId) {
  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('ai_employee_runs')
      .select('*')
      .eq('id', runId)
      .single();
    if (error) throw error;
    return data;
  });
  if (sbResult) return sbResult;

  const store = getLocalStore();
  return store.runs.find((r) => r.id === runId) || null;
}

export async function listRunsForTask(taskId) {
  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('ai_employee_runs')
      .select('*')
      .eq('task_id', taskId)
      .order('started_at', { ascending: false });
    if (error) throw error;
    return data;
  });
  if (sbResult) return sbResult;

  const store = getLocalStore();
  return store.runs
    .filter((r) => r.task_id === taskId)
    .sort((a, b) => b.started_at.localeCompare(a.started_at));
}

// ─────────────────────────────────────────────────────────────────────────────
// REVIEWS
// ─────────────────────────────────────────────────────────────────────────────

export async function createReview(taskId, runId, { decision, comments = null, created_by = null }) {
  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('ai_employee_reviews')
      .insert({
        task_id: taskId,
        run_id: runId,
        reviewer_type: 'human_manager',
        decision,
        comments,
        created_by,
        created_at: now(),
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  });
  if (sbResult) return sbResult;

  const review = {
    id: localId('rev'),
    task_id: taskId,
    run_id: runId,
    reviewer_type: 'human_manager',
    decision,
    comments,
    created_by,
    created_at: now(),
  };
  const store = getLocalStore();
  store.reviews.push(review);
  setLocalStore(store);
  return review;
}

export async function listReviewsForTask(taskId) {
  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('ai_employee_reviews')
      .select('*')
      .eq('task_id', taskId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  });
  if (sbResult) return sbResult;

  const store = getLocalStore();
  return store.reviews
    .filter((r) => r.task_id === taskId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/**
 * Returns tasks in 'waiting_review' status for any employee managed by userId.
 * Used by the Manager Review page.
 */
export async function listPendingReviews(userId) {
  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('ai_employee_tasks')
      .select(`
        *,
        ai_employees!inner(id, name, manager_user_id),
        ai_employee_runs(id, status, summary, artifact_refs, ended_at, started_at)
      `)
      .eq('status', 'waiting_review')
      .eq('ai_employees.manager_user_id', userId)
      .order('updated_at', { ascending: false });
    if (error) throw error;
    return data;
  });
  if (sbResult) return sbResult;

  // Local fallback: join manually
  const store = getLocalStore();
  return store.tasks
    .filter((t) => t.status === 'waiting_review')
    .map((t) => ({
      ...t,
      ai_employee_runs: store.runs
        .filter((r) => r.task_id === t.id)
        .sort((a, b) => b.started_at.localeCompare(a.started_at)),
    }))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

// ─────────────────────────────────────────────────────────────────────────────
// WORKLOGS
// ─────────────────────────────────────────────────────────────────────────────

export async function appendWorklog(employeeId, taskId, runId, logType, content) {
  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('ai_employee_worklogs')
      .insert({
        employee_id: employeeId,
        task_id: taskId,
        run_id: runId,
        log_type: logType,
        content,
        created_at: now(),
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  });
  if (sbResult) return sbResult;

  const entry = {
    id: localId('log'),
    employee_id: employeeId,
    task_id: taskId,
    run_id: runId,
    log_type: logType,
    content,
    created_at: now(),
  };
  const store = getLocalStore();
  store.worklogs.push(entry);
  setLocalStore(store);
  return entry;
}

export async function listWorklogs(employeeId, { limit = 50, taskId } = {}) {
  const sbResult = await trySupabase(async () => {
    let q = supabase
      .from('ai_employee_worklogs')
      .select('*')
      .eq('employee_id', employeeId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (taskId) q = q.eq('task_id', taskId);
    const { data, error } = await q;
    if (error) throw error;
    return data;
  });
  if (sbResult) return sbResult;

  const store = getLocalStore();
  let logs = store.worklogs.filter((l) => l.employee_id === employeeId);
  if (taskId) logs = logs.filter((l) => l.task_id === taskId);
  return logs
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit);
}

// ─────────────────────────────────────────────────────────────────────────────
// KPIs
// ─────────────────────────────────────────────────────────────────────────────

export async function getKpis(employeeId) {
  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('ai_employee_kpis')
      .select('*')
      .eq('employee_id', employeeId)
      .maybeSingle();
    if (error) throw error;
    return data;
  });
  if (sbResult) return sbResult;

  // Compute from local store
  const store = getLocalStore();
  const tasks = store.tasks.filter((t) => t.employee_id === employeeId);
  const reviews = store.reviews.filter((r) =>
    tasks.some((t) => t.id === r.task_id) && r.reviewer_type === 'human_manager'
  );
  const done = tasks.filter((t) => t.status === 'done');
  const approved = reviews.filter((r) => r.decision === 'approved');

  return {
    employee_id: employeeId,
    tasks_completed: done.length,
    tasks_open: tasks.filter((t) => t.status !== 'done').length,
    tasks_overdue: tasks.filter((t) => t.due_at && new Date(t.due_at) < new Date() && t.status !== 'done').length,
    on_time_rate_pct: done.length > 0
      ? Math.round((done.filter((t) => !t.due_at || new Date(t.updated_at) <= new Date(t.due_at)).length / done.length) * 100)
      : null,
    reviews_approved: approved.length,
    reviews_revised: reviews.filter((r) => r.decision === 'needs_revision').length,
    review_pass_rate_pct: reviews.length > 0
      ? Math.round((approved.length / reviews.length) * 100)
      : null,
  };
}

export default {
  getOrCreateAiden,
  getEmployee,
  updateEmployeeStatus,
  listTasks,
  listTasksByUser,
  getTask,
  createTask,
  updateTaskStatus,
  createRun,
  updateRun,
  getRun,
  listRunsForTask,
  createReview,
  listReviewsForTask,
  listPendingReviews,
  appendWorklog,
  listWorklogs,
  getKpis,
};
