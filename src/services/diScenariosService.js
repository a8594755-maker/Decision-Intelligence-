/**
 * diScenariosService
 *
 * Supabase CRUD layer for the di_scenarios table.
 * Mirrors the REST-style API contract:
 *   POST   /scenarios         → createScenario
 *   GET    /scenarios/:id     → getScenario
 *   GET    /runs/:id/scenarios → listScenariosForBaseRun
 *   PATCH  /scenarios/:id     → updateScenario (internal)
 *
 * Caching / deduplication:
 *   createScenario checks for existing scenario_key before inserting.
 *   If key exists and status=succeeded, returns the existing record immediately.
 */

import { supabase } from './supabaseClient';
import { computeScenarioKey } from '../utils/scenarioKey';

const TABLE = 'di_scenarios';

/**
 * Create a scenario or return existing one if the scenario_key already succeeded.
 *
 * @param {object} params
 * @param {string} params.user_id
 * @param {number} params.base_run_id
 * @param {string} [params.name]
 * @param {object} params.overrides      - parameter overrides
 * @param {object} [params.engine_flags] - solver engine flags
 * @returns {{ scenario, isNew: boolean }}
 */
export async function createScenario({ user_id, base_run_id, name, overrides = {}, engine_flags = {} }) {
  if (!user_id) throw new Error('user_id is required');
  if (!base_run_id) throw new Error('base_run_id is required');

  const scenario_key = await computeScenarioKey(base_run_id, overrides, engine_flags);

  // Check for existing scenario with same key
  const { data: existing, error: lookupError } = await supabase
    .from(TABLE)
    .select('*')
    .eq('scenario_key', scenario_key)
    .maybeSingle();

  if (lookupError && !lookupError.message?.includes('Results contain 0 rows')) {
    throw new Error(`Scenario lookup failed: ${lookupError.message}`);
  }

  if (existing) {
    // If already succeeded, return immediately (cache hit)
    if (existing.status === 'succeeded') {
      return { scenario: existing, isNew: false, cached: true };
    }
    // If queued/running/failed, return existing record; caller can decide to retry
    return { scenario: existing, isNew: false, cached: false };
  }

  // Create new scenario
  const payload = {
    user_id,
    base_run_id: Number(base_run_id),
    scenario_key,
    name: name || null,
    overrides,
    engine_flags,
    status: 'queued',
    scenario_run_id: null,
    error_message: null
  };

  const { data, error } = await supabase
    .from(TABLE)
    .insert([payload])
    .select('*')
    .single();

  if (error) {
    // Handle race condition: another process may have inserted the same key
    if (error.code === '23505') {
      const { data: raceWinner } = await supabase
        .from(TABLE)
        .select('*')
        .eq('scenario_key', scenario_key)
        .maybeSingle();
      if (raceWinner) return { scenario: raceWinner, isNew: false, cached: raceWinner.status === 'succeeded' };
    }
    throw new Error(`Failed to create scenario: ${error.message}`);
  }

  return { scenario: data, isNew: true, cached: false };
}

/**
 * Get a single scenario by ID.
 */
export async function getScenario(user_id, scenario_id) {
  if (!user_id || !scenario_id) throw new Error('user_id and scenario_id are required');

  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('id', scenario_id)
    .eq('user_id', user_id)
    .maybeSingle();

  if (error) throw new Error(`getScenario failed: ${error.message}`);
  return data || null;
}

/**
 * List scenarios for a given base run (descending by created_at).
 */
export async function listScenariosForBaseRun(user_id, base_run_id, limit = 20) {
  if (!user_id || !base_run_id) throw new Error('user_id and base_run_id are required');

  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('user_id', user_id)
    .eq('base_run_id', Number(base_run_id))
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`listScenariosForBaseRun failed: ${error.message}`);
  return data || [];
}

/**
 * List recent scenarios for a user (across all base runs).
 */
export async function listRecentScenarios(user_id, limit = 30) {
  if (!user_id) throw new Error('user_id is required');

  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('user_id', user_id)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`listRecentScenarios failed: ${error.message}`);
  return data || [];
}

/**
 * Update scenario status and optional fields.
 * Internal use by the scenario engine.
 */
export async function updateScenario(scenario_id, updates = {}) {
  if (!scenario_id) throw new Error('scenario_id is required');

  const allowedFields = ['status', 'scenario_run_id', 'error_message', 'name'];
  const payload = {};
  allowedFields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(updates, field)) {
      payload[field] = updates[field];
    }
  });
  payload.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from(TABLE)
    .update(payload)
    .eq('id', scenario_id)
    .select('*')
    .single();

  if (error) throw new Error(`updateScenario failed: ${error.message}`);
  return data;
}

/**
 * Delete a scenario by ID (user-scoped).
 */
export async function deleteScenario(user_id, scenario_id) {
  if (!user_id || !scenario_id) throw new Error('user_id and scenario_id are required');

  const { error } = await supabase
    .from(TABLE)
    .delete()
    .eq('id', scenario_id)
    .eq('user_id', user_id);

  if (error) throw new Error(`deleteScenario failed: ${error.message}`);
}

export default {
  createScenario,
  getScenario,
  listScenariosForBaseRun,
  listRecentScenarios,
  updateScenario,
  deleteScenario
};
