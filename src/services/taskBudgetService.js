// @product: ai-employee
//
// taskBudgetService.js
// ─────────────────────────────────────────────────────────────────────────────
// Per-task spending limits for AI Employee execution.
//
// Budget is optional — tasks without a budget row run unlimited.
// When a budget exists, each model call checks remaining headroom
// before proceeding. If exceeded, a BudgetExceededError is thrown
// and the step is blocked instead of consuming more tokens.
//
// Flow:
//   createBudget(taskId, ...)    → set limits for a task
//   checkBudget(taskId)          → returns { allowed, remaining, budget }
//   consumeBudget(taskId, usage) → deduct tokens/cost after a call
//   getBudget(taskId)            → read current budget state
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from './supabaseClient';

// ── Constants ────────────────────────────────────────────────────────────────

const LOCAL_KEY = 'ai_employee_budgets_v1';

/** Default budget limits applied when creating a budget without explicit values. */
export const DEFAULT_LIMITS = {
  max_total_cost: 1.00,           // $1.00 per task
  max_total_tokens: 500000,       // 500K tokens
  max_premium_calls: 5,           // max 5 tier_a calls
  max_steps: 20,                  // max 20 loop steps (raised for dynamic decomposed tasks)
  max_dynamic_tool_calls: 3,      // max 3 dynamic tool generation calls per task
};

// ── Errors ───────────────────────────────────────────────────────────────────

export class BudgetExceededError extends Error {
  constructor(taskId, reason, budget) {
    super(`Budget exceeded for task ${taskId}: ${reason}`);
    this.name = 'BudgetExceededError';
    this.taskId = taskId;
    this.reason = reason;
    this.budget = budget;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function now() {
  return new Date().toISOString();
}

async function trySupabase(fn) {
  try {
    if (!supabase) return null;
    return await fn();
  } catch (err) {
    console.warn('[taskBudgetService] Supabase call failed:', err?.message || err);
    return null;
  }
}

function getLocalStore() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function setLocalStore(store) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(store));
  } catch { /* quota */ }
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Create or update a budget for a task.
 *
 * @param {string} taskId
 * @param {string} employeeId
 * @param {object} [limits] - Override default limits
 * @param {number} [limits.maxTotalCost]
 * @param {number} [limits.maxTotalTokens]
 * @param {number} [limits.maxPremiumCalls]
 * @param {number} [limits.maxSteps]
 * @returns {Promise<object>} The budget row
 */
export async function createBudget(taskId, employeeId, limits = {}) {
  const row = {
    task_id: taskId,
    employee_id: employeeId,
    max_total_cost: limits.maxTotalCost ?? DEFAULT_LIMITS.max_total_cost,
    max_total_tokens: limits.maxTotalTokens ?? DEFAULT_LIMITS.max_total_tokens,
    max_premium_calls: limits.maxPremiumCalls ?? DEFAULT_LIMITS.max_premium_calls,
    max_steps: limits.maxSteps ?? DEFAULT_LIMITS.max_steps,
    current_cost: 0,
    current_tokens: 0,
    premium_calls_used: 0,
    steps_used: 0,
    exceeded: false,
    exceeded_reason: null,
    exceeded_at: null,
    created_at: now(),
    updated_at: now(),
  };

  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('task_budgets')
      .upsert(row, { onConflict: 'task_id' })
      .select()
      .single();
    if (error) throw error;
    return data;
  });
  if (sbResult) return sbResult;

  // Local fallback
  const store = getLocalStore();
  const entry = { id: `local-budget-${Date.now()}`, ...row };
  store[taskId] = entry;
  setLocalStore(store);
  return entry;
}

/**
 * Get budget for a task. Returns null if no budget exists (unlimited).
 *
 * @param {string} taskId
 * @returns {Promise<object|null>}
 */
export async function getBudget(taskId) {
  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('task_budgets')
      .select('*')
      .eq('task_id', taskId)
      .single();
    if (error && error.code !== 'PGRST116') throw error; // PGRST116 = not found
    return data || null;
  });
  if (sbResult !== null) return sbResult;

  // Local fallback
  const store = getLocalStore();
  return store[taskId] || null;
}

// ── Budget Check ─────────────────────────────────────────────────────────────

/**
 * Check if a task has budget remaining.
 * Returns { allowed: true } if no budget exists (unlimited) or within limits.
 *
 * @param {string} taskId
 * @param {object} [planned] - Planned usage for the upcoming call
 * @param {number} [planned.estimatedTokens] - Estimated total tokens
 * @param {number} [planned.estimatedCost] - Estimated cost
 * @param {boolean} [planned.isPremium] - Whether this would be a tier_a call
 * @returns {Promise<{ allowed: boolean, reason: string|null, remaining: object|null, budget: object|null }>}
 */
export async function checkBudget(taskId, planned = {}) {
  const budget = await getBudget(taskId);

  // No budget = unlimited
  if (!budget) {
    return { allowed: true, reason: null, remaining: null, budget: null };
  }

  // Already exceeded
  if (budget.exceeded) {
    return { allowed: false, reason: budget.exceeded_reason || 'Budget previously exceeded', remaining: computeRemaining(budget), budget };
  }

  const { estimatedTokens = 0, estimatedCost = 0, isPremium = false } = planned;

  // Check each dimension
  if (budget.max_total_cost != null) {
    const projected = Number(budget.current_cost) + estimatedCost;
    if (projected > budget.max_total_cost) {
      return { allowed: false, reason: `Cost limit: projected $${projected.toFixed(4)} > max $${budget.max_total_cost}`, remaining: computeRemaining(budget), budget };
    }
  }

  if (budget.max_total_tokens != null) {
    const projected = budget.current_tokens + estimatedTokens;
    if (projected > budget.max_total_tokens) {
      return { allowed: false, reason: `Token limit: projected ${projected} > max ${budget.max_total_tokens}`, remaining: computeRemaining(budget), budget };
    }
  }

  if (budget.max_premium_calls != null && isPremium) {
    if (budget.premium_calls_used + 1 > budget.max_premium_calls) {
      return { allowed: false, reason: `Premium call limit: ${budget.premium_calls_used}/${budget.max_premium_calls} used`, remaining: computeRemaining(budget), budget };
    }
  }

  if (budget.max_steps != null) {
    if (budget.steps_used >= budget.max_steps) {
      return { allowed: false, reason: `Step limit: ${budget.steps_used}/${budget.max_steps} used`, remaining: computeRemaining(budget), budget };
    }
  }

  return { allowed: true, reason: null, remaining: computeRemaining(budget), budget };
}

function computeRemaining(budget) {
  return {
    cost: budget.max_total_cost != null ? Math.max(0, budget.max_total_cost - Number(budget.current_cost)) : null,
    tokens: budget.max_total_tokens != null ? Math.max(0, budget.max_total_tokens - budget.current_tokens) : null,
    premium_calls: budget.max_premium_calls != null ? Math.max(0, budget.max_premium_calls - budget.premium_calls_used) : null,
    steps: budget.max_steps != null ? Math.max(0, budget.max_steps - budget.steps_used) : null,
  };
}

// ── Budget Consumption ───────────────────────────────────────────────────────

/**
 * Deduct usage from a task's budget after a model call completes.
 * Automatically marks the budget as exceeded if any limit is hit.
 *
 * @param {string} taskId
 * @param {object} usage
 * @param {number} [usage.cost] - Actual cost of the call
 * @param {number} [usage.tokens] - Actual tokens used (input + output)
 * @param {boolean} [usage.isPremium] - Was this a tier_a call
 * @param {boolean} [usage.isStep] - Count as a loop step
 * @returns {Promise<object>} Updated budget
 */
export async function consumeBudget(taskId, usage = {}) {
  const budget = await getBudget(taskId);
  if (!budget) return null; // No budget = unlimited, nothing to consume

  const { cost = 0, tokens = 0, isPremium = false, isStep = false } = usage;

  // Update running totals
  budget.current_cost = Math.round((Number(budget.current_cost) + cost) * 1000000) / 1000000;
  budget.current_tokens += tokens;
  if (isPremium) budget.premium_calls_used += 1;
  if (isStep) budget.steps_used += 1;
  budget.updated_at = now();

  // Check if any limit is now exceeded
  const exceededReason = checkExceeded(budget);
  if (exceededReason && !budget.exceeded) {
    budget.exceeded = true;
    budget.exceeded_reason = exceededReason;
    budget.exceeded_at = now();
  }

  // Persist
  const sbResult = await trySupabase(async () => {
    const { data, error } = await supabase
      .from('task_budgets')
      .update({
        current_cost: budget.current_cost,
        current_tokens: budget.current_tokens,
        premium_calls_used: budget.premium_calls_used,
        steps_used: budget.steps_used,
        exceeded: budget.exceeded,
        exceeded_reason: budget.exceeded_reason,
        exceeded_at: budget.exceeded_at,
        updated_at: budget.updated_at,
      })
      .eq('task_id', taskId)
      .select()
      .single();
    if (error) throw error;
    return data;
  });
  if (sbResult) return sbResult;

  // Local fallback
  const store = getLocalStore();
  store[taskId] = budget;
  setLocalStore(store);
  return budget;
}

function checkExceeded(budget) {
  if (budget.max_total_cost != null && Number(budget.current_cost) > budget.max_total_cost) {
    return `Cost exceeded: $${Number(budget.current_cost).toFixed(4)} > $${budget.max_total_cost}`;
  }
  if (budget.max_total_tokens != null && budget.current_tokens > budget.max_total_tokens) {
    return `Tokens exceeded: ${budget.current_tokens} > ${budget.max_total_tokens}`;
  }
  if (budget.max_premium_calls != null && budget.premium_calls_used > budget.max_premium_calls) {
    return `Premium calls exceeded: ${budget.premium_calls_used} > ${budget.max_premium_calls}`;
  }
  if (budget.max_steps != null && budget.steps_used > budget.max_steps) {
    return `Steps exceeded: ${budget.steps_used} > ${budget.max_steps}`;
  }
  return null;
}

// ── Exports ──────────────────────────────────────────────────────────────────

export default {
  DEFAULT_LIMITS,
  BudgetExceededError,
  createBudget,
  getBudget,
  checkBudget,
  consumeBudget,
};
