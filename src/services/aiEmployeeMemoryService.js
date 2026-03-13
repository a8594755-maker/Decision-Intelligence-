// @product: ai-employee
//
// aiEmployeeMemoryService.js
// ─────────────────────────────────────────────────────────────────────────────
// Task memory: structured outcome storage + recall for cross-session learning.
//
// Write path:  after task completion → writeMemory() captures outcome, KPIs,
//              params, and execution metadata.
// Update path: after review → attachFeedback() adds manager decision + comments.
// Read path:   before execution → recall() finds relevant past memories by
//              dataset fingerprint or workflow type.
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from './supabaseClient';

const LOCAL_KEY = 'ai_employee_memory_v1';
const MAX_LOCAL_ENTRIES = 200;
const DEFAULT_RECALL_LIMIT = 5;

// ── Local store helpers ──────────────────────────────────────────────────────

function getLocalStore() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function setLocalStore(entries) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(entries.slice(-MAX_LOCAL_ENTRIES)));
  } catch { /* quota exceeded */ }
}

function localId() {
  return `local-mem-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function now() {
  return new Date().toISOString();
}

async function trySupabase(fn) {
  try {
    if (!supabase) return null;
    return await fn();
  } catch (err) {
    console.warn('[aiEmployeeMemoryService] Supabase call failed:', err?.message || err);
    return null;
  }
}

// ── KPI extraction helpers ───────────────────────────────────────────────────

/**
 * Extract structured KPIs from a DI engine result based on workflow type.
 */
export function extractOutcomeKpis(workflowType, result) {
  if (!result) return {};

  switch (workflowType) {
    case 'forecast': {
      const m = result.metrics;
      if (!m) return {};
      return {
        mape: m.mape ?? null,
        mae: m.mae ?? null,
        p90_coverage: m.p90_coverage ?? null,
        groups_processed: m.groups_processed ?? null,
        selected_model: m.selected_model_global ?? null,
      };
    }
    case 'plan': {
      const kpis = result.solver_result?.kpis || {};
      const meta = result.solver_result?.solver_meta || {};
      return {
        service_level: kpis.estimated_service_level ?? null,
        total_cost: kpis.estimated_total_cost ?? null,
        stockout_units: kpis.estimated_stockout_units ?? null,
        items_planned: meta.num_variables ?? result.plan_artifact?.total_rows ?? null,
        solver_status: result.solver_result?.status ?? null,
        solve_time_s: meta.solve_time_seconds ?? null,
      };
    }
    case 'risk': {
      const scores = result.risk_scores || [];
      const high = scores.filter((s) => s.risk_score >= 0.7).length;
      const medium = scores.filter((s) => s.risk_score >= 0.4 && s.risk_score < 0.7).length;
      return {
        total_assessed: scores.length,
        high_risk_count: high,
        medium_risk_count: medium,
        avg_risk_score: scores.length > 0
          ? Math.round((scores.reduce((s, r) => s + r.risk_score, 0) / scores.length) * 100) / 100
          : null,
      };
    }
    case 'synthesize': {
      const syn = result.synthesis || {};
      return {
        sources: syn.sources?.length ?? 0,
        total_artifacts: syn.total_artifacts ?? 0,
      };
    }
    default:
      return {};
  }
}

/**
 * Extract key input params worth remembering (strip internal/large fields).
 */
export function extractInputParams(inputContext) {
  if (!inputContext) return {};
  const { riskMode, horizonPeriods, scenario_overrides, settings, template_id } = inputContext;
  const params = {};
  if (riskMode) params.riskMode = riskMode;
  if (horizonPeriods != null) params.horizonPeriods = horizonPeriods;
  if (scenario_overrides) params.has_scenario_overrides = true;
  if (template_id) params.template_id = template_id;
  if (settings?.plan?.risk_mode) params.plan_risk_mode = settings.plan.risk_mode;
  return params;
}

// ── Write ────────────────────────────────────────────────────────────────────

/**
 * Write a memory entry after a task completes (success or failure).
 *
 * @param {object} opts
 * @param {string} opts.employeeId
 * @param {string} opts.taskId
 * @param {string} opts.runId
 * @param {string} opts.workflowType
 * @param {boolean} opts.success
 * @param {string} [opts.outcomeSummary] - Human-readable summary
 * @param {object} [opts.outcomeKpis] - Structured KPIs
 * @param {string} [opts.errorMessage]
 * @param {object} [opts.inputParams] - Key params used
 * @param {number} [opts.artifactsGenerated]
 * @param {number} [opts.executionTimeMs]
 * @param {number} [opts.retryCount]
 * @param {string} [opts.datasetFingerprint]
 * @param {string} [opts.datasetProfileId]
 * @param {string} [opts.templateId]
 * @returns {Promise<object>}
 */
export async function writeMemory({
  employeeId, taskId, runId, workflowType, success,
  outcomeSummary, outcomeKpis, errorMessage,
  inputParams, artifactsGenerated, executionTimeMs, retryCount,
  datasetFingerprint, datasetProfileId, templateId,
}) {
  const row = {
    employee_id: employeeId,
    task_id: taskId,
    run_id: runId,
    workflow_type: workflowType,
    success,
    outcome_summary: outcomeSummary || null,
    outcome_kpis: outcomeKpis || {},
    error_message: errorMessage || null,
    input_params: inputParams || {},
    artifacts_generated: artifactsGenerated ?? 0,
    execution_time_ms: executionTimeMs ?? null,
    retry_count: retryCount ?? 0,
    dataset_fingerprint: datasetFingerprint || null,
    dataset_profile_id: datasetProfileId || null,
    template_id: templateId || null,
    created_at: now(),
  };

  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('ai_employee_task_memory')
      .insert(row)
      .select()
      .single();
    if (error) throw error;
    return data;
  });
  if (sbResult) return sbResult;

  // Local fallback
  const entry = { id: localId(), ...row };
  const store = getLocalStore();
  store.push(entry);
  setLocalStore(store);
  return entry;
}

// ── Update (after review) ────────────────────────────────────────────────────

/**
 * Attach manager feedback to an existing memory entry.
 * Called after review decision is made.
 *
 * @param {string} taskId - Find memory by task_id
 * @param {string} decision - 'approved' | 'needs_revision' | 'rejected'
 * @param {string} [feedback] - Manager comments
 */
export async function attachFeedback(taskId, decision, feedback) {
  const patch = {
    manager_decision: decision,
    manager_feedback: feedback || null,
  };

  const sbResult = await trySupabase(async () => {
    // Find the most recent memory for this task
    const { data: rows } = await supabase
      .from('ai_employee_task_memory')
      .select('id')
      .eq('task_id', taskId)
      .order('created_at', { ascending: false })
      .limit(1);
    if (!rows?.length) return null;

    const { data, error } = await supabase
      .from('ai_employee_task_memory')
      .update(patch)
      .eq('id', rows[0].id)
      .select()
      .single();
    if (error) throw error;
    return data;
  });
  if (sbResult) return sbResult;

  // Local fallback
  const store = getLocalStore();
  const entry = [...store].reverse().find((e) => e.task_id === taskId);
  if (entry) Object.assign(entry, patch);
  setLocalStore(store);
  return entry || null;
}

// ── Recall ───────────────────────────────────────────────────────────────────

/**
 * Recall relevant past memories for a given context.
 * Returns most recent memories matching the query, ordered by relevance.
 *
 * @param {string} employeeId
 * @param {object} [query]
 * @param {string} [query.datasetFingerprint] - Match by dataset fingerprint (highest priority)
 * @param {string} [query.workflowType] - Match by workflow type
 * @param {boolean} [query.successOnly] - Only return successful memories
 * @param {number} [query.limit] - Max entries (default 5)
 * @returns {Promise<object[]>}
 */
export async function recall(employeeId, query = {}) {
  const { datasetFingerprint, workflowType, successOnly, limit = DEFAULT_RECALL_LIMIT } = query;

  const sbResult = await trySupabase(async () => {
    let q = supabase
      .from('ai_employee_task_memory')
      .select('*')
      .eq('employee_id', employeeId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (datasetFingerprint) q = q.eq('dataset_fingerprint', datasetFingerprint);
    if (workflowType) q = q.eq('workflow_type', workflowType);
    if (successOnly) q = q.eq('success', true);

    const { data, error } = await q;
    if (error) throw error;
    return data;
  });
  if (sbResult !== null) return sbResult;

  // Local fallback
  let results = getLocalStore().filter((e) => e.employee_id === employeeId);
  if (datasetFingerprint) results = results.filter((e) => e.dataset_fingerprint === datasetFingerprint);
  if (workflowType) results = results.filter((e) => e.workflow_type === workflowType);
  if (successOnly) results = results.filter((e) => e.success);
  return results
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit);
}

/**
 * Build a concise context summary from recalled memories.
 * Useful for injecting into task input_context before execution.
 *
 * @param {object[]} memories - From recall()
 * @returns {object} Summary with patterns and recommendations
 */
export function summarizeMemories(memories) {
  if (!memories?.length) return { has_prior_experience: false };

  const successes = memories.filter((m) => m.success);
  const failures = memories.filter((m) => !m.success);
  const reviewed = memories.filter((m) => m.manager_decision);
  const approved = reviewed.filter((m) => m.manager_decision === 'approved');

  // Extract common params from successful runs
  const successParams = successes.map((m) => m.input_params).filter(Boolean);
  const commonRiskMode = successParams.filter((p) => p.riskMode === 'on').length > successParams.length / 2
    ? 'on' : 'off';

  // Common error patterns
  const errorPatterns = failures
    .map((m) => m.error_message)
    .filter(Boolean)
    .reduce((acc, msg) => {
      // Simplify error to pattern
      const key = msg.slice(0, 60);
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

  // Manager feedback themes
  const feedbackNotes = reviewed
    .map((m) => m.manager_feedback)
    .filter(Boolean);

  return {
    has_prior_experience: true,
    total_prior_runs: memories.length,
    success_rate: memories.length > 0 ? Math.round((successes.length / memories.length) * 100) : 0,
    approval_rate: reviewed.length > 0 ? Math.round((approved.length / reviewed.length) * 100) : null,
    avg_execution_time_ms: successes.length > 0
      ? Math.round(successes.reduce((s, m) => s + (m.execution_time_ms || 0), 0) / successes.length)
      : null,
    recommended_risk_mode: commonRiskMode,
    common_error_patterns: Object.entries(errorPatterns)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([pattern, count]) => ({ pattern, count })),
    recent_feedback: feedbackNotes.slice(0, 3),
    last_successful_kpis: successes[0]?.outcome_kpis || null,
  };
}

export default {
  extractOutcomeKpis,
  extractInputParams,
  writeMemory,
  attachFeedback,
  recall,
  summarizeMemories,
};
