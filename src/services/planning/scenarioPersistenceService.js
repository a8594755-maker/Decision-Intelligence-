/**
 * Scenario Persistence Service
 *
 * Durable storage for Digital Twin scenarios and what-if simulations.
 * Supports save, load, compare, and share operations.
 *
 * Table: di_scenarios
 * Fallback: localStorage when Supabase is unavailable.
 */

import { supabase } from '../infra/supabaseClient';

const TABLE = 'di_scenarios';
const LOCAL_KEY = 'di_scenarios_local';

// ── Helpers ─────────────────────────────────────────────────────────────────

const nowIso = () => new Date().toISOString();

async function trySupabase(fn) {
  try {
    return await fn();
  } catch {
    return null;
  }
}

function getLocal() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]');
  } catch {
    return [];
  }
}

function setLocal(items) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(items.slice(0, 100)));
  } catch { /* quota */ }
}

function generateId() {
  return `scn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Save Scenario ───────────────────────────────────────────────────────────

/**
 * Save a simulation scenario for later retrieval or comparison.
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} params.name           - User-friendly scenario name
 * @param {string} [params.description]  - Optional description
 * @param {string} params.type           - 'what_if' | 'strategy_comparison' | 'chaos_test' | 'parameter_sweep'
 * @param {Object} params.parameters     - Scenario input parameters
 * @param {Object} params.results        - Simulation output/results
 * @param {Object} [params.kpis]         - Key KPIs from the simulation
 * @param {string} [params.baselineId]   - Reference scenario ID for comparison
 * @param {Array}  [params.tags]         - Searchable tags
 * @returns {Promise<Object>} Saved scenario
 */
export async function saveScenario({
  userId,
  name,
  description = '',
  type = 'what_if',
  parameters = {},
  results = {},
  kpis = {},
  baselineId = null,
  tags = [],
}) {
  const row = {
    id: generateId(),
    user_id: userId,
    name,
    description,
    type,
    parameters: JSON.parse(JSON.stringify(parameters)),
    results: JSON.parse(JSON.stringify(results)),
    kpis: JSON.parse(JSON.stringify(kpis)),
    baseline_id: baselineId,
    tags,
    is_shared: false,
    shared_with: [],
    created_at: nowIso(),
    updated_at: nowIso(),
  };

  const result = await trySupabase(async () => {
    const { data, error } = await supabase.from(TABLE).insert([row]).select('*').single();
    if (error) throw error;
    return data;
  });

  if (result) return result;

  // Fallback
  const local = getLocal();
  local.unshift(row);
  setLocal(local);
  return row;
}

// ── Load Scenarios ──────────────────────────────────────────────────────────

/**
 * List saved scenarios for a user.
 */
export async function listScenarios(userId, { type, tags, limit = 50 } = {}) {
  const result = await trySupabase(async () => {
    let query = supabase
      .from(TABLE)
      .select('id, name, description, type, kpis, tags, is_shared, created_at, updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(limit);

    if (type) query = query.eq('type', type);
    if (tags?.length) query = query.contains('tags', tags);

    const { data, error } = await query;
    if (error) throw error;
    return data;
  });

  if (result) return result;

  // Fallback
  let local = getLocal().filter(s => s.user_id === userId);
  if (type) local = local.filter(s => s.type === type);
  if (tags?.length) {
    local = local.filter(s => tags.some(t => (s.tags || []).includes(t)));
  }
  return local.slice(0, limit);
}

/**
 * Get full scenario with parameters and results.
 */
export async function getScenario(scenarioId) {
  const result = await trySupabase(async () => {
    const { data, error } = await supabase.from(TABLE).select('*').eq('id', scenarioId).maybeSingle();
    if (error) throw error;
    return data;
  });

  if (result) return result;

  return getLocal().find(s => s.id === scenarioId) || null;
}

// ── Update Scenario ─────────────────────────────────────────────────────────

/**
 * Update a scenario's name, description, or tags.
 */
export async function updateScenario(scenarioId, updates) {
  const patch = { ...updates, updated_at: nowIso() };

  const result = await trySupabase(async () => {
    const { data, error } = await supabase
      .from(TABLE)
      .update(patch)
      .eq('id', scenarioId)
      .select('*')
      .single();
    if (error) throw error;
    return data;
  });

  if (result) return result;

  const local = getLocal();
  const idx = local.findIndex(s => s.id === scenarioId);
  if (idx >= 0) {
    Object.assign(local[idx], patch);
    setLocal(local);
    return local[idx];
  }
  return null;
}

// ── Delete Scenario ─────────────────────────────────────────────────────────

/**
 * Delete a scenario.
 */
export async function deleteScenario(scenarioId) {
  await trySupabase(async () => {
    const { error } = await supabase.from(TABLE).delete().eq('id', scenarioId);
    if (error) throw error;
  });

  const local = getLocal().filter(s => s.id !== scenarioId);
  setLocal(local);
}

// ── Compare Scenarios ───────────────────────────────────────────────────────

/**
 * Compare two or more scenarios side by side.
 *
 * @param {string[]} scenarioIds - IDs of scenarios to compare
 * @returns {{ scenarios, comparison, winner }}
 */
export async function compareScenarios(scenarioIds) {
  const scenarios = await Promise.all(scenarioIds.map(id => getScenario(id)));
  const valid = scenarios.filter(Boolean);

  if (valid.length < 2) {
    return { scenarios: valid, comparison: null, winner: null };
  }

  // Build comparison matrix
  const kpiKeys = new Set();
  valid.forEach(s => Object.keys(s.kpis || {}).forEach(k => kpiKeys.add(k)));

  const comparison = {};
  for (const key of kpiKeys) {
    comparison[key] = valid.map(s => ({
      scenario_id: s.id,
      scenario_name: s.name,
      value: s.kpis?.[key] ?? null,
    }));
  }

  // Determine winner by total KPI score (higher is better for most metrics)
  const HIGHER_IS_BETTER = ['service_level', 'fill_rate', 'on_time_rate', 'revenue', 'profit'];
  const LOWER_IS_BETTER = ['total_cost', 'stockout_count', 'excess_inventory', 'lead_time'];

  let bestIdx = 0;
  let bestScore = -Infinity;

  valid.forEach((s, idx) => {
    let score = 0;
    for (const key of kpiKeys) {
      const val = Number(s.kpis?.[key] ?? 0);
      if (HIGHER_IS_BETTER.some(k => key.includes(k))) score += val;
      else if (LOWER_IS_BETTER.some(k => key.includes(k))) score -= val;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIdx = idx;
    }
  });

  return {
    scenarios: valid,
    comparison,
    winner: {
      scenario_id: valid[bestIdx].id,
      scenario_name: valid[bestIdx].name,
      score: bestScore,
    },
  };
}

// ── Share Scenario ──────────────────────────────────────────────────────────

/**
 * Share a scenario with other users.
 */
export async function shareScenario(scenarioId, { sharedWith = [] } = {}) {
  return updateScenario(scenarioId, {
    is_shared: true,
    shared_with: sharedWith,
  });
}

/**
 * List scenarios shared with a user.
 */
export async function listSharedScenarios(userId, { limit = 50 } = {}) {
  const result = await trySupabase(async () => {
    const { data, error } = await supabase
      .from(TABLE)
      .select('id, name, description, type, kpis, tags, user_id, created_at')
      .eq('is_shared', true)
      .contains('shared_with', [userId])
      .order('updated_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data;
  });

  return result || [];
}

// ── Scenario Templates ──────────────────────────────────────────────────────

/**
 * Get predefined scenario templates for quick setup.
 */
export function getScenarioTemplates() {
  return [
    {
      id: 'template_conservative',
      name: 'Conservative Safety Stock',
      type: 'strategy_comparison',
      description: 'Higher safety stock levels with lower stockout risk',
      parameters: {
        safety_stock_alpha: 1.5,
        service_level_target: 0.99,
        stockout_penalty_multiplier: 2.0,
      },
      tags: ['conservative', 'safety-stock', 'risk-averse'],
    },
    {
      id: 'template_balanced',
      name: 'Balanced Approach',
      type: 'strategy_comparison',
      description: 'Balanced cost vs service level tradeoff',
      parameters: {
        safety_stock_alpha: 1.0,
        service_level_target: 0.95,
        stockout_penalty_multiplier: 1.3,
      },
      tags: ['balanced', 'default'],
    },
    {
      id: 'template_aggressive',
      name: 'Lean / Aggressive',
      type: 'strategy_comparison',
      description: 'Minimize inventory holding cost, accept higher stockout risk',
      parameters: {
        safety_stock_alpha: 0.5,
        service_level_target: 0.90,
        stockout_penalty_multiplier: 1.0,
      },
      tags: ['aggressive', 'lean', 'cost-optimized'],
    },
    {
      id: 'template_supplier_disruption',
      name: 'Supplier Disruption',
      type: 'chaos_test',
      description: 'Simulate primary supplier going offline for 2 weeks',
      parameters: {
        chaos_type: 'supplier_disruption',
        disrupted_supplier_pct: 1.0,
        disruption_duration_days: 14,
        recovery_rate: 0.5,
      },
      tags: ['chaos', 'supplier', 'disruption', 'bcp'],
    },
    {
      id: 'template_demand_surge',
      name: 'Demand Surge (+50%)',
      type: 'chaos_test',
      description: 'Simulate sudden 50% demand increase across all SKUs',
      parameters: {
        chaos_type: 'demand_surge',
        demand_multiplier: 1.5,
        surge_duration_days: 30,
        affected_sku_pct: 1.0,
      },
      tags: ['chaos', 'demand', 'surge'],
    },
  ];
}
