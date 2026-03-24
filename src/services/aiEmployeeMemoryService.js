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

let _memoryTableWarned = false;
async function trySupabase(fn) {
  try {
    if (!supabase) return null;
    return await fn();
  } catch (err) {
    if (!_memoryTableWarned) {
      console.warn('[aiEmployeeMemoryService] Supabase call failed, using localStorage fallback:', err?.message || err);
      _memoryTableWarned = true;
    }
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

// ═══════════════════════════════════════════════════════════════════════════
// Knowledge Vault — Style / Policy / Exemplar Memory (P1-3)
//
// Three core memory types beyond execution outcomes:
//   1. Company Policy Memory — "how this org operates"
//   2. Approved Exemplars    — "what good output looks like"
//   3. Style Retrieval       — "how to deliver for this manager"
// ═══════════════════════════════════════════════════════════════════════════

const VAULT_LOCAL_KEY = 'ai_employee_knowledge_vault_v1';

function getVaultStore() {
  try {
    const raw = localStorage.getItem(VAULT_LOCAL_KEY);
    return raw ? JSON.parse(raw) : { policies: [], exemplars: [], styles: [] };
  } catch {
    return { policies: [], exemplars: [], styles: [] };
  }
}

function setVaultStore(store) {
  try {
    const trimmed = {
      policies: (store.policies || []).slice(-100),
      exemplars: (store.exemplars || []).slice(-100),
      styles: (store.styles || []).slice(-50),
    };
    localStorage.setItem(VAULT_LOCAL_KEY, JSON.stringify(trimmed));
  } catch { /* quota */ }
}

// ── Policy Memory ──────────────────────────────────────────────────────────

/**
 * Store a company/org policy that governs how the AI employee operates.
 *
 * @param {Object} params
 * @param {string} params.employeeId
 * @param {string} params.category     - 'naming_convention'|'approval_rule'|'data_handling'|'reporting'|'communication'
 * @param {string} params.rule         - The policy rule text
 * @param {string} [params.scope]      - 'global'|'workflow_type'|'dataset'
 * @param {string} [params.scopeValue] - e.g. 'forecast', 'plan'
 * @param {string} [params.createdBy]  - Manager user ID
 * @returns {Promise<Object>}
 */
export async function writePolicy({ employeeId, category, rule, scope = 'global', scopeValue = null, createdBy = null }) {
  const entry = {
    id: `pol_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    employee_id: employeeId,
    type: 'policy',
    category,
    rule,
    scope,
    scope_value: scopeValue,
    is_active: true,
    created_by: createdBy,
    created_at: now(),
  };

  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('ai_employee_knowledge_vault')
      .insert(entry)
      .select()
      .single();
    if (error) throw error;
    return data;
  });
  if (sbResult) return sbResult;

  const store = getVaultStore();
  store.policies.push(entry);
  setVaultStore(store);
  return entry;
}

/**
 * Retrieve active policies for an employee, optionally filtered by scope.
 */
export async function recallPolicies(employeeId, { category, scope, scopeValue } = {}) {
  const sbResult = await trySupabase(async () => {
    let q = supabase
      .from('ai_employee_knowledge_vault')
      .select('*')
      .eq('employee_id', employeeId)
      .eq('type', 'policy')
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (category) q = q.eq('category', category);
    if (scope) q = q.eq('scope', scope);
    if (scopeValue) q = q.eq('scope_value', scopeValue);

    const { data, error } = await q;
    if (error) throw error;
    return data;
  });
  if (sbResult !== null) return sbResult;

  let results = getVaultStore().policies.filter((p) => p.employee_id === employeeId && p.is_active);
  if (category) results = results.filter((p) => p.category === category);
  if (scope) results = results.filter((p) => p.scope === scope);
  if (scopeValue) results = results.filter((p) => p.scope_value === scopeValue);
  return results;
}

// ── Approved Exemplars ─────────────────────────────────────────────────────

/**
 * Store an approved exemplar — a reference output that was explicitly approved
 * by the manager. Used for future output comparison and style matching.
 *
 * @param {Object} params
 * @param {string} params.employeeId
 * @param {string} params.workflowType   - 'forecast'|'plan'|'risk'|'report'
 * @param {string} params.taskId         - Source task
 * @param {Object} params.outputSnapshot - Snapshot of the approved output
 * @param {Object} [params.kpis]         - KPIs at time of approval
 * @param {string} [params.managerNotes] - Why this was approved/exemplary
 * @param {string[]} [params.tags]       - Searchable tags
 * @returns {Promise<Object>}
 */
export async function writeExemplar({ employeeId, workflowType, taskId, outputSnapshot, kpis = {}, managerNotes = '', tags = [] }) {
  const entry = {
    id: `exm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    employee_id: employeeId,
    type: 'exemplar',
    workflow_type: workflowType,
    task_id: taskId,
    output_snapshot: outputSnapshot,
    kpis,
    manager_notes: managerNotes,
    tags,
    is_active: true,
    created_at: now(),
  };

  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('ai_employee_knowledge_vault')
      .insert(entry)
      .select()
      .single();
    if (error) throw error;
    return data;
  });
  if (sbResult) return sbResult;

  const store = getVaultStore();
  store.exemplars.push(entry);
  setVaultStore(store);
  return entry;
}

/**
 * Retrieve exemplars for an employee by workflow type.
 */
export async function recallExemplars(employeeId, { workflowType, tags, limit = 5 } = {}) {
  const sbResult = await trySupabase(async () => {
    let q = supabase
      .from('ai_employee_knowledge_vault')
      .select('*')
      .eq('employee_id', employeeId)
      .eq('type', 'exemplar')
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (workflowType) q = q.eq('workflow_type', workflowType);
    if (tags?.length) q = q.contains('tags', tags);

    const { data, error } = await q;
    if (error) throw error;
    return data;
  });
  if (sbResult !== null) return sbResult;

  let results = getVaultStore().exemplars.filter((e) => e.employee_id === employeeId && e.is_active);
  if (workflowType) results = results.filter((e) => e.workflow_type === workflowType);
  if (tags?.length) results = results.filter((e) => tags.some((t) => (e.tags || []).includes(t)));
  return results.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
}

// ── Style Retrieval ──────────────────────────────────────────────────────────

/**
 * Store a style preference for this employee (learned from manager feedback).
 *
 * @param {Object} params
 * @param {string} params.employeeId
 * @param {string} params.dimension     - 'tone'|'detail_level'|'format'|'terminology'|'visual_style'
 * @param {string} params.preference    - The style preference value
 * @param {string} [params.context]     - When to apply (e.g. 'reporting', 'email', 'all')
 * @param {number} [params.confidence]  - 0-1 confidence in this preference
 * @param {string} [params.learnedFrom] - Task ID where this was learned
 * @returns {Promise<Object>}
 */
export async function writeStylePreference({ employeeId, dimension, preference, context = 'all', confidence = 0.5, learnedFrom = null }) {
  const entry = {
    id: `sty_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    employee_id: employeeId,
    type: 'style',
    dimension,
    preference,
    context,
    confidence,
    learned_from: learnedFrom,
    is_active: true,
    created_at: now(),
    updated_at: now(),
  };

  // Upsert: if same dimension+context exists, update instead of insert
  const sbResult = await trySupabase(async () => {
    // Check for existing
    const { data: existing } = await supabase
      .from('ai_employee_knowledge_vault')
      .select('id')
      .eq('employee_id', employeeId)
      .eq('type', 'style')
      .eq('dimension', dimension)
      .eq('context', context)
      .eq('is_active', true)
      .maybeSingle();

    if (existing) {
      const { data, error } = await supabase
        .from('ai_employee_knowledge_vault')
        .update({ preference, confidence, learned_from: learnedFrom, updated_at: now() })
        .eq('id', existing.id)
        .select()
        .single();
      if (error) throw error;
      return data;
    }

    const { data, error } = await supabase
      .from('ai_employee_knowledge_vault')
      .insert(entry)
      .select()
      .single();
    if (error) throw error;
    return data;
  });
  if (sbResult) return sbResult;

  const store = getVaultStore();
  const idx = store.styles.findIndex(
    (s) => s.employee_id === employeeId && s.dimension === dimension && s.context === context
  );
  if (idx >= 0) {
    Object.assign(store.styles[idx], { preference, confidence, learned_from: learnedFrom, updated_at: now() });
  } else {
    store.styles.push(entry);
  }
  setVaultStore(store);
  return idx >= 0 ? store.styles[idx] : entry;
}

/**
 * Retrieve all style preferences for an employee.
 * Returns a style profile object keyed by dimension.
 */
export async function recallStyleProfile(employeeId, { context } = {}) {
  const sbResult = await trySupabase(async () => {
    let q = supabase
      .from('ai_employee_knowledge_vault')
      .select('*')
      .eq('employee_id', employeeId)
      .eq('type', 'style')
      .eq('is_active', true)
      .order('confidence', { ascending: false });

    if (context) q = q.in('context', [context, 'all']);

    const { data, error } = await q;
    if (error) throw error;
    return data;
  });

  const styles = sbResult ?? getVaultStore().styles.filter(
    (s) => s.employee_id === employeeId && s.is_active && (!context || s.context === context || s.context === 'all')
  );

  // Build profile object
  const profile = {};
  for (const s of styles) {
    if (!profile[s.dimension] || s.confidence > (profile[s.dimension].confidence || 0)) {
      profile[s.dimension] = {
        preference: s.preference,
        confidence: s.confidence,
        context: s.context,
        learned_from: s.learned_from,
      };
    }
  }
  return profile;
}

/**
 * Build a full knowledge context for task execution.
 * Combines execution memory, policies, exemplars, and style preferences.
 *
 * @param {string} employeeId
 * @param {Object} [query] - Recall query (workflowType, datasetFingerprint, etc.)
 * @returns {Promise<Object>} Combined knowledge context
 */
export async function buildKnowledgeContext(employeeId, query = {}) {
  const [memories, policies, exemplars, styleProfile] = await Promise.all([
    recall(employeeId, { workflowType: query.workflowType, limit: 3 }),
    recallPolicies(employeeId, { scopeValue: query.workflowType }),
    recallExemplars(employeeId, { workflowType: query.workflowType, limit: 2 }),
    recallStyleProfile(employeeId),
  ]);

  return {
    execution_memory: summarizeMemories(memories),
    active_policies: policies.map((p) => ({
      category: p.category,
      rule: p.rule,
      scope: p.scope,
    })),
    exemplars: exemplars.map((e) => ({
      workflow_type: e.workflow_type,
      output_snapshot: e.output_snapshot,
      kpis: e.kpis,
      notes: e.manager_notes,
    })),
    style_profile: styleProfile,
    has_knowledge: policies.length > 0 || exemplars.length > 0 || Object.keys(styleProfile).length > 0,
  };
}

// ── Query Pattern Memory (cross-session learning for data queries) ──────────

/**
 * Record a successful query pattern for a dataset, so future similar questions
 * can reference it.
 */
export async function writeQueryPattern({
  datasetFingerprint,
  userQuestion,
  toolUsed,       // 'query_sap_data' | 'run_python_analysis'
  queryOrHint,    // SQL statement or tool_hint
  success,
  resultSummary,  // Short description of the result
  projectId = null,
  userId = null,
}) {
  // Build a pattern_key for deduplication
  const patternKey = `query::${toolUsed || 'unknown'}::${(userQuestion || '').slice(0, 80)}`;

  // Supabase record aligned with ai_employee_memory schema
  const sbEntry = {
    memory_type: 'query_pattern',
    project_id: projectId,
    user_id: userId,
    pattern_key: patternKey,
    tool_name: toolUsed,
    category: 'query',
    error_context: {
      dataset_fingerprint: datasetFingerprint,
      user_question: userQuestion?.slice(0, 200),
      query_or_hint: queryOrHint?.slice(0, 500),
      success: Boolean(success),
    },
    resolution: resultSummary?.slice(0, 200),
  };

  // Local fallback entry retains original flat shape for localStorage reads
  const localEntry = {
    id: localId(),
    memory_type: 'query_pattern',
    dataset_fingerprint: datasetFingerprint,
    user_question: userQuestion?.slice(0, 200),
    tool_used: toolUsed,
    query_or_hint: queryOrHint?.slice(0, 500),
    success: Boolean(success),
    result_summary: resultSummary?.slice(0, 200),
    created_at: now(),
  };

  const sbResult = await trySupabase(async () => {
    const { error } = await supabase
      .from('ai_employee_memory')
      .upsert(sbEntry, { onConflict: 'project_id,pattern_key' });
    if (error) throw error;
    return true;
  });

  if (!sbResult) {
    const store = getLocalStore();
    store.push(localEntry);
    setLocalStore(store);
  }
}

/**
 * Recall past successful query patterns for a given dataset fingerprint.
 */
export async function recallQueryPatterns({
  datasetFingerprint,
  limit = 3,
}) {
  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('ai_employee_memory')
      .select('*')
      .eq('memory_type', 'query_pattern')
      .eq('dataset_fingerprint', datasetFingerprint)
      .eq('success', true)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data;
  });

  if (sbResult?.length > 0) return sbResult;

  // localStorage fallback
  const store = getLocalStore();
  return store
    .filter(e =>
      (e.memory_type || e.type) === 'query_pattern' &&
      e.dataset_fingerprint === datasetFingerprint &&
      e.success
    )
    .slice(-limit);
}

// ── Failure Pattern Memory (cross-session learning from mistakes) ─────────

const FAILURE_LOCAL_KEY = 'ai_failure_patterns_v1';
const MAX_FAILURE_ENTRIES = 100;

function getFailureStore() {
  try {
    const raw = localStorage.getItem(FAILURE_LOCAL_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function setFailureStore(entries) {
  try {
    localStorage.setItem(FAILURE_LOCAL_KEY, JSON.stringify(entries.slice(-MAX_FAILURE_ENTRIES)));
  } catch { /* quota exceeded */ }
}

/**
 * Deduplicate key: toolUsed + errorType + first 80 chars of errorMessage.
 */
export function failureDedupeKey({ toolUsed, errorType, errorMessage }) {
  return `${toolUsed}::${errorType}::${(errorMessage || '').slice(0, 80)}`;
}

/**
 * Classify an error message into an error type.
 */
export function classifyToolError(errorMessage) {
  const msg = String(errorMessage || '');
  if (/Import.*not allowed|ImportError/i.test(msg)) return 'ImportError';
  if (/ValueError|truth value.*DataFrame|ambiguous/i.test(msg)) return 'ValueError';
  if (/TypeError/i.test(msg)) return 'TypeError';
  if (/timeout|timed out/i.test(msg)) return 'Timeout';
  if (/0 rows|zero rows|no.*rows/i.test(msg)) return 'ZeroRows';
  if (/SyntaxError/i.test(msg)) return 'SyntaxError';
  return 'Other';
}

/**
 * Record a tool call failure pattern for future avoidance.
 */
export async function writeFailurePattern({
  datasetFingerprint,
  toolUsed,
  failedInput,
  errorType,
  errorMessage,
  resolution,
}) {
  const key = failureDedupeKey({ toolUsed, errorType, errorMessage });

  // Check for existing entry (deduplicate)
  const store = getFailureStore();
  const existing = store.find(e => e._dedupeKey === key);

  if (existing) {
    existing.occurrence_count = (existing.occurrence_count || 1) + 1;
    existing.last_seen = now();
    if (resolution && !existing.resolution) {
      existing.resolution = resolution;
    }
    setFailureStore(store);
    return existing;
  }

  // Local entry retains flat shape for localStorage deduplication
  const localEntry = {
    id: localId(),
    memory_type: 'failure_pattern',
    _dedupeKey: key,
    dataset_fingerprint: datasetFingerprint || null,
    tool_used: toolUsed,
    failed_input: (failedInput || '').slice(0, 300),
    error_type: errorType,
    error_message: (errorMessage || '').slice(0, 200),
    resolution: resolution || null,
    occurrence_count: 1,
    last_seen: now(),
    created_at: now(),
  };

  // Supabase entry aligned with ai_employee_memory schema
  const sbEntry = {
    memory_type: 'failure_pattern',
    pattern_key: key,
    tool_name: toolUsed,
    error_message: (errorMessage || '').slice(0, 200),
    error_context: {
      dataset_fingerprint: datasetFingerprint || null,
      failed_input: (failedInput || '').slice(0, 300),
      error_type: errorType,
    },
    resolution: resolution || null,
    category: 'failure',
  };

  const sbResult = await trySupabase(async () => {
    const { error } = await supabase
      .from('ai_employee_memory')
      .upsert(sbEntry, { onConflict: 'project_id,pattern_key' });
    if (error) throw error;
    return true;
  });

  if (!sbResult) {
    store.push(localEntry);
    setFailureStore(store);
  }

  return localEntry;
}

/**
 * Attach a resolution to an existing failure pattern.
 * Called when a subsequent tool call succeeds after a failure.
 */
export function attachFailureResolution(dedupeKey, resolution) {
  const store = getFailureStore();
  const entry = store.find(e => e._dedupeKey === dedupeKey);
  if (entry && !entry.resolution) {
    entry.resolution = (resolution || '').slice(0, 300);
    setFailureStore(store);
  }
}

/**
 * Recall past failure patterns for injection into system prompt.
 * Returns failures sorted by occurrence_count descending.
 */
export async function recallFailurePatterns({
  datasetFingerprint,
  limit = 5,
} = {}) {
  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('ai_employee_memory')
      .select('*')
      .eq('memory_type', 'failure_pattern')
      .order('occurrence_count', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data;
  });

  if (sbResult?.length > 0) return sbResult;

  // localStorage fallback
  const store = getFailureStore();
  return store
    .filter(e => (e.memory_type || e.type) === 'failure_pattern')
    .sort((a, b) => (b.occurrence_count || 1) - (a.occurrence_count || 1))
    .slice(0, limit);
}

export default {
  extractOutcomeKpis,
  extractInputParams,
  writeMemory,
  attachFeedback,
  recall,
  summarizeMemories,
  // Knowledge Vault
  writePolicy,
  recallPolicies,
  writeExemplar,
  recallExemplars,
  writeStylePreference,
  recallStyleProfile,
  buildKnowledgeContext,
  // Query Pattern Memory
  writeQueryPattern,
  recallQueryPatterns,
  // Failure Pattern Memory
  writeFailurePattern,
  recallFailurePatterns,
  attachFailureResolution,
  classifyToolError,
  failureDedupeKey,
};
