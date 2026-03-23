// @product: ai-employee
//
// modelRoutingService.js
// ─────────────────────────────────────────────────────────────────────────────
// Multi-model routing for AI Employee tasks.
//
// Decides which capability tier / model to use for each task step based on:
//   1. Routing policies per task_type (preferred_tier + fallback_tier)
//   2. Escalation rules (on_failure, on_low_confidence, on_high_risk)
//   3. Memory context (prior success/failure patterns)
//
// Also tracks per-call token usage and estimated cost in task_model_runs.
//
// Flow:
//   resolveModel(taskType, context)  → { provider, model, tier }
//   recordModelRun(...)              → writes usage to task_model_runs
//   getTaskCostSummary(taskId)       → aggregates cost for a task
//   listModels(filter)               → returns available models
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from './supabaseClient';
import { DEFAULT_MODEL_REGISTRY } from './modelRegistryService.js';

// ── Constants ────────────────────────────────────────────────────────────────

export const CAPABILITY_TIERS = {
  TIER_A: 'tier_a', // High-reasoning: task decomposition, high-risk decisions, final review
  TIER_B: 'tier_b', // Specialist: complex analysis, code generation
  TIER_C: 'tier_c', // Low-cost utility: summaries, formatting, data cleaning
};

export const ESCALATION_TRIGGERS = {
  ON_FAILURE: 'on_failure',
  ON_LOW_CONFIDENCE: 'on_low_confidence',
  ON_HIGH_RISK: 'on_high_risk',
};

// ── In-memory defaults (used when Supabase is unavailable) ───────────────────

const DEFAULT_MODELS = DEFAULT_MODEL_REGISTRY;

// NOTE: All policies pinned to GPT-5.4 (tier_a) during development.
// TODO: Once stable, downgrade low-reasoning tasks (forecast, export, registered_tool) to tier_b/c.
const DEFAULT_POLICIES = {
  forecast:                { preferred_tier: 'tier_a', fallback_tier: 'tier_b', preferred_model: 'gpt-5.4', escalation_rules: {} },
  plan:                    { preferred_tier: 'tier_a', fallback_tier: 'tier_b', preferred_model: 'gpt-5.4', escalation_rules: {} },
  risk:                    { preferred_tier: 'tier_a', fallback_tier: 'tier_b', preferred_model: 'gpt-5.4', escalation_rules: {} },
  synthesis:               { preferred_tier: 'tier_a', fallback_tier: 'tier_b', preferred_model: 'gpt-5.4', escalation_rules: {} },
  synthesize:              { preferred_tier: 'tier_a', fallback_tier: 'tier_b', preferred_model: 'gpt-5.4', escalation_rules: {} },
  task_decomposition:      { preferred_tier: 'tier_a', fallback_tier: 'tier_b', preferred_model: 'gpt-5.4', escalation_rules: {} },
  review:                  { preferred_tier: 'tier_a', fallback_tier: 'tier_b', preferred_model: 'gpt-5.4', escalation_rules: {} },
  dynamic_tool_generation: { preferred_tier: 'tier_a', fallback_tier: 'tier_b', preferred_model: 'gpt-5.4', escalation_rules: {} },
  registered_tool:         { preferred_tier: 'tier_a', fallback_tier: 'tier_b', preferred_model: 'gpt-5.4', escalation_rules: {} },
  report:                  { preferred_tier: 'tier_a', fallback_tier: 'tier_b', preferred_model: 'gpt-5.4', escalation_rules: {} },
  export:                  { preferred_tier: 'tier_a', fallback_tier: 'tier_b', preferred_model: 'gpt-5.4', escalation_rules: {} },
  builtin_tool:            { preferred_tier: 'tier_a', fallback_tier: 'tier_b', preferred_model: 'gpt-5.4', escalation_rules: {} },
};

const LOCAL_RUNS_KEY = 'ai_employee_model_runs_v1';
const MAX_LOCAL_RUNS = 500;

// ── Helpers ──────────────────────────────────────────────────────────────────

function now() {
  return new Date().toISOString();
}

async function trySupabase(fn) {
  try {
    if (!supabase) return null;
    return await fn();
  } catch (err) {
    console.warn('[modelRoutingService] Supabase call failed:', err?.message || err);
    return null;
  }
}

function getLocalRuns() {
  try {
    const raw = localStorage.getItem(LOCAL_RUNS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function setLocalRuns(runs) {
  try {
    localStorage.setItem(LOCAL_RUNS_KEY, JSON.stringify(runs.slice(-MAX_LOCAL_RUNS)));
  } catch { /* quota */ }
}

// ── Model Registry ───────────────────────────────────────────────────────────

let _cachedModels = null;
let _cacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * List available models, optionally filtered.
 * Caches for 5 minutes.
 *
 * @param {object} [filter]
 * @param {string} [filter.tier] - Filter by capability_tier
 * @param {string} [filter.provider] - Filter by provider
 * @param {boolean} [filter.activeOnly] - Only active models (default true)
 * @returns {Promise<object[]>}
 */
export async function listModels(filter = {}) {
  const { tier, provider, activeOnly = true } = filter;

  // Check cache
  if (_cachedModels && Date.now() - _cacheTime < CACHE_TTL_MS) {
    return applyModelFilter(_cachedModels, { tier, provider, activeOnly });
  }

  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('model_registry')
      .select('*')
      .order('capability_tier')
      .order('cost_per_1k_input');
    if (error) throw error;
    return data;
  });

  if (sbResult && sbResult.length > 0) {
    _cachedModels = sbResult;
    _cacheTime = Date.now();
    return applyModelFilter(sbResult, { tier, provider, activeOnly });
  }

  // Fallback — use defaults when Supabase is unavailable or model_registry is empty
  return applyModelFilter(DEFAULT_MODELS, { tier, provider, activeOnly });
}

function applyModelFilter(models, { tier, provider, activeOnly }) {
  let result = models;
  if (activeOnly) result = result.filter((m) => m.active !== false);
  if (tier) result = result.filter((m) => m.capability_tier === tier);
  if (provider) result = result.filter((m) => m.provider === provider);
  // Sort by cost (cheapest first) so selectModel picks the most cost-effective option
  result = [...result].sort((a, b) => (a.cost_per_1k_input || 0) - (b.cost_per_1k_input || 0));
  return result;
}

/** Invalidate the model cache (e.g. after admin changes). */
export function invalidateModelCache() {
  _cachedModels = null;
  _cacheTime = 0;
}

// ── Routing Policies ─────────────────────────────────────────────────────────

let _cachedPolicies = null;
let _policyCacheTime = 0;

/**
 * Get routing policy for a task type.
 *
 * @param {string} taskType - 'forecast' | 'plan' | 'risk' | 'synthesize' | etc.
 * @returns {Promise<object>} Policy with preferred_tier, fallback_tier, escalation_rules
 */
export async function getPolicy(taskType) {
  // Check cache
  if (_cachedPolicies && Date.now() - _policyCacheTime < CACHE_TTL_MS) {
    return _cachedPolicies[taskType] || DEFAULT_POLICIES[taskType] || { preferred_tier: 'tier_c', fallback_tier: null, escalation_rules: {} };
  }

  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('routing_policies')
      .select('*');
    if (error) throw error;
    return data;
  });

  if (sbResult) {
    const map = {};
    for (const row of sbResult) {
      map[row.task_type] = {
        preferred_tier: row.preferred_tier,
        fallback_tier: row.fallback_tier,
        escalation_rules: row.escalation_rules || {},
      };
    }
    _cachedPolicies = map;
    _policyCacheTime = Date.now();
    return map[taskType] || DEFAULT_POLICIES[taskType] || { preferred_tier: 'tier_c', fallback_tier: null, escalation_rules: {} };
  }

  return DEFAULT_POLICIES[taskType] || { preferred_tier: 'tier_c', fallback_tier: null, escalation_rules: {} };
}

// ── Core Routing ─────────────────────────────────────────────────────────────

/**
 * Resolve which model to use for a given task type and context.
 *
 * Strategy: "start cheap, escalate when needed"
 *   1. Look up routing policy for taskType
 *   2. Determine effective tier based on escalation context
 *   3. Pick the cheapest active model in that tier
 *
 * @param {string} taskType - 'forecast' | 'plan' | 'risk' | 'synthesize' | etc.
 * @param {object} [context]
 * @param {number} [context.retryCount] - Current retry count (>0 triggers on_failure escalation)
 * @param {boolean} [context.highRisk] - True if task/data is flagged high risk
 * @param {number} [context.confidence] - 0-1, if < 0.5 triggers on_low_confidence
 * @param {string} [context.preferredProvider] - Hint: prefer this provider if available
 * @param {object} [context.memoryContext] - From summarizeMemories(), informs routing
 * @returns {Promise<{ provider: string, model: string, tier: string, escalated: boolean, escalatedFrom: string|null }>}
 */
export async function resolveModel(taskType, context = {}) {
  const { retryCount = 0, highRisk = false, confidence, preferredProvider, memoryContext } = context;

  const policy = await getPolicy(taskType);
  let effectiveTier = policy.preferred_tier;
  let escalated = false;
  let escalatedFrom = null;

  // ── Escalation logic ────────────────────────────────────────────────────

  // Retry escalation: if previous attempts failed, escalate
  if (retryCount > 0 && policy.escalation_rules.on_failure) {
    escalatedFrom = effectiveTier;
    effectiveTier = policy.escalation_rules.on_failure;
    escalated = true;
  }

  // High risk escalation
  if (highRisk && policy.escalation_rules.on_high_risk) {
    if (tierRank(policy.escalation_rules.on_high_risk) < tierRank(effectiveTier)) {
      escalatedFrom = escalatedFrom || effectiveTier;
      effectiveTier = policy.escalation_rules.on_high_risk;
      escalated = true;
    }
  }

  // Low confidence escalation
  if (confidence !== undefined && confidence < 0.5 && policy.escalation_rules.on_low_confidence) {
    if (tierRank(policy.escalation_rules.on_low_confidence) < tierRank(effectiveTier)) {
      escalatedFrom = escalatedFrom || effectiveTier;
      effectiveTier = policy.escalation_rules.on_low_confidence;
      escalated = true;
    }
  }

  // Memory-informed escalation: if prior runs had high failure rate, escalate
  if (memoryContext?.has_prior_experience && memoryContext.success_rate < 50) {
    const escTier = policy.escalation_rules.on_failure || policy.fallback_tier;
    if (escTier && tierRank(escTier) < tierRank(effectiveTier)) {
      escalatedFrom = escalatedFrom || effectiveTier;
      effectiveTier = escTier;
      escalated = true;
    }
  }

  // ── Model selection ─────────────────────────────────────────────────────

  // If policy specifies a preferred_model, try to use it directly
  const policyPreferredModel = policy.preferred_model;
  if (policyPreferredModel) {
    const allModels = await listModels({});
    const pinned = allModels.find((m) => m.model_name === policyPreferredModel);
    if (pinned) {
      return { provider: pinned.provider, model: pinned.model_name, tier: pinned.capability_tier, escalated, escalatedFrom };
    }
    // preferred_model not found/active — fall through to tier-based selection
  }

  const candidates = await listModels({ tier: effectiveTier });

  if (candidates.length === 0) {
    // Fallback: try fallback tier
    if (policy.fallback_tier) {
      const fallbackCandidates = await listModels({ tier: policy.fallback_tier });
      if (fallbackCandidates.length > 0) {
        const model = selectModel(fallbackCandidates, preferredProvider);
        return { provider: model.provider, model: model.model_name, tier: policy.fallback_tier, escalated, escalatedFrom };
      }
    }
    // Last resort: any active model
    const allModels = await listModels({});
    if (allModels.length === 0) {
      throw new Error('No active models available in model_registry');
    }
    const model = selectModel(allModels, preferredProvider);
    return { provider: model.provider, model: model.model_name, tier: model.capability_tier, escalated, escalatedFrom };
  }

  const model = selectModel(candidates, preferredProvider);
  return { provider: model.provider, model: model.model_name, tier: effectiveTier, escalated, escalatedFrom };
}

/**
 * Select the best model from candidates.
 * Prefers the cheapest, but respects provider hint.
 */
function selectModel(candidates, preferredProvider) {
  if (preferredProvider) {
    const preferred = candidates.filter((m) => m.provider === preferredProvider);
    if (preferred.length > 0) return preferred[0]; // already sorted by cost
  }
  return candidates[0]; // cheapest (sorted by cost_per_1k_input)
}

/**
 * Rank tiers: tier_a=1 (highest), tier_b=2, tier_c=3 (lowest).
 * Lower rank = more capable.
 */
function tierRank(tier) {
  switch (tier) {
    case 'tier_a': return 1;
    case 'tier_b': return 2;
    case 'tier_c': return 3;
    default: return 4;
  }
}

// ── Cost Tracking ────────────────────────────────────────────────────────────

/**
 * Record a model call for cost tracking and observability.
 *
 * @param {object} opts
 * @param {string} opts.taskId
 * @param {string} [opts.runId]
 * @param {string} opts.employeeId
 * @param {string} [opts.agentRole] - 'executor' | 'reviewer' | 'decomposer' | 'summarizer'
 * @param {string} opts.provider
 * @param {string} opts.modelName
 * @param {string} opts.tier
 * @param {number} [opts.inputTokens]
 * @param {number} [opts.outputTokens]
 * @param {number} [opts.latencyMs]
 * @param {string} [opts.stepName]
 * @param {string} [opts.escalatedFrom]
 * @returns {Promise<object>}
 */
export async function recordModelRun({
  taskId, runId, employeeId, agentRole,
  provider, modelName, tier,
  inputTokens = 0, outputTokens = 0, latencyMs,
  stepName, escalatedFrom,
}) {
  // Estimate cost from registry
  const models = await listModels({ provider });
  const modelEntry = models.find((m) => m.model_name === modelName);
  const costIn = modelEntry ? (inputTokens / 1000) * modelEntry.cost_per_1k_input : 0;
  const costOut = modelEntry ? (outputTokens / 1000) * modelEntry.cost_per_1k_output : 0;
  const estimatedCost = Math.round((costIn + costOut) * 1000000) / 1000000; // 6 decimal places

  const row = {
    task_id: taskId,
    run_id: runId || null,
    employee_id: employeeId,
    agent_role: agentRole || null,
    model_provider: provider,
    model_name: modelName,
    capability_tier: tier,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    estimated_cost: estimatedCost,
    latency_ms: latencyMs ?? null,
    step_name: stepName || null,
    escalated_from: escalatedFrom || null,
    created_at: now(),
  };

  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('task_model_runs')
      .insert(row)
      .select()
      .single();
    if (error) throw error;
    return data;
  });
  if (sbResult) return sbResult;

  // Local fallback
  const entry = { id: `local-mr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ...row };
  const runs = getLocalRuns();
  runs.push(entry);
  setLocalRuns(runs);
  return entry;
}

/**
 * Get aggregated cost summary for a task.
 *
 * @param {string} taskId
 * @returns {Promise<{ total_cost: number, total_input_tokens: number, total_output_tokens: number, calls: number, by_tier: object }>}
 */
export async function getTaskCostSummary(taskId) {
  let runs = null;

  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('task_model_runs')
      .select('*')
      .eq('task_id', taskId);
    if (error) throw error;
    return data;
  });

  runs = sbResult || getLocalRuns().filter((r) => r.task_id === taskId);

  if (!runs || runs.length === 0) {
    return { total_cost: 0, total_input_tokens: 0, total_output_tokens: 0, calls: 0, by_tier: {} };
  }

  const byTier = {};
  let totalCost = 0;
  let totalIn = 0;
  let totalOut = 0;

  for (const run of runs) {
    totalCost += Number(run.estimated_cost) || 0;
    totalIn += run.input_tokens || 0;
    totalOut += run.output_tokens || 0;

    const tier = run.capability_tier;
    if (!byTier[tier]) byTier[tier] = { cost: 0, calls: 0 };
    byTier[tier].cost += Number(run.estimated_cost) || 0;
    byTier[tier].calls += 1;
  }

  // Round costs
  totalCost = Math.round(totalCost * 1000000) / 1000000;
  for (const t of Object.values(byTier)) {
    t.cost = Math.round(t.cost * 1000000) / 1000000;
  }

  return {
    total_cost: totalCost,
    total_input_tokens: totalIn,
    total_output_tokens: totalOut,
    calls: runs.length,
    by_tier: byTier,
  };
}

/**
 * Get cost summary across all tasks for an employee.
 *
 * @param {string} employeeId
 * @param {object} [opts]
 * @param {number} [opts.days] - Lookback window in days (default 30)
 * @returns {Promise<{ total_cost: number, total_calls: number, by_tier: object, by_task_type: object }>}
 */
export async function getEmployeeCostSummary(employeeId, opts = {}) {
  const { days = 30 } = opts;
  const since = new Date(Date.now() - days * 86400000).toISOString();

  let runs = null;

  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('task_model_runs')
      .select('*')
      .eq('employee_id', employeeId)
      .gte('created_at', since)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  });

  runs = sbResult || getLocalRuns().filter((r) => r.employee_id === employeeId);

  if (!runs || runs.length === 0) {
    return { total_cost: 0, total_calls: 0, by_tier: {}, by_task_type: {} };
  }

  let totalCost = 0;
  const byTier = {};

  for (const run of runs) {
    totalCost += Number(run.estimated_cost) || 0;
    const tier = run.capability_tier;
    if (!byTier[tier]) byTier[tier] = { cost: 0, calls: 0 };
    byTier[tier].cost += Number(run.estimated_cost) || 0;
    byTier[tier].calls += 1;
  }

  totalCost = Math.round(totalCost * 1000000) / 1000000;
  for (const t of Object.values(byTier)) {
    t.cost = Math.round(t.cost * 1000000) / 1000000;
  }

  return { total_cost: totalCost, total_calls: runs.length, by_tier: byTier };
}

// ── Exports ──────────────────────────────────────────────────────────────────

export default {
  CAPABILITY_TIERS,
  ESCALATION_TRIGGERS,
  resolveModel,
  recordModelRun,
  getTaskCostSummary,
  getEmployeeCostSummary,
  listModels,
  getPolicy,
  invalidateModelCache,
};
