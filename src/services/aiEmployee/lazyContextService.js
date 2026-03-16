/**
 * lazyContextService.js — Lazy Context Acquisition for step execution
 *
 * Allows executor steps to request additional context mid-run instead of
 * requiring all data upfront. This enables a "task-first" workflow where
 * the user describes what they want, and data is fetched on demand.
 *
 * Supported context sources:
 *   - dataset: Fetch dataset from Supabase by profile ID
 *   - artifact: Fetch artifact from a prior step
 *   - opencloud: Fetch file from OpenCloud
 *   - cache: Fetch from in-memory raw rows cache
 */

import { supabase } from '../supabaseClient.js';

// ── Context Resolution Registry ─────────────────────────────────────────

const RESOLVERS = {};

/**
 * Register a context resolver.
 * @param {string} sourceType
 * @param {(request: object) => Promise<object>} resolver
 */
export function registerResolver(sourceType, resolver) {
  RESOLVERS[sourceType] = resolver;
}

/**
 * Resolve a context request.
 * Returns { ok: true, data } or { ok: false, error, waiting_input: true }
 *
 * @param {object} request - { source, params }
 * @param {object} taskContext - { taskId, employeeId, inputData }
 * @returns {Promise<object>}
 */
export async function resolveContext(request, taskContext = {}) {
  const { source, params } = request;
  const resolver = RESOLVERS[source];
  if (!resolver) {
    return { ok: false, error: `Unknown context source: ${source}` };
  }
  try {
    const data = await resolver({ ...params, _taskContext: taskContext });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Check if a step's input data has required fields populated.
 * Returns list of missing context keys.
 */
export function detectMissingContext(stepInput, requiredKeys = []) {
  const inputData = stepInput?.inputData || {};
  const missing = [];
  for (const key of requiredKeys) {
    if (inputData[key] === undefined || inputData[key] === null) {
      missing.push(key);
    }
  }
  return missing;
}

// ── Built-in Resolvers ──────────────────────────────────────────────────

// Dataset resolver: fetch profile + raw data from Supabase
registerResolver('dataset', async ({ profileId, _taskContext }) => {
  if (!profileId) throw new Error('profileId is required for dataset context');

  const { data: profile, error } = await supabase
    .from('dataset_profiles')
    .select('id, profile_json, contract_json, user_file_id')
    .eq('id', profileId)
    .single();

  if (error) throw new Error(`Failed to fetch dataset profile: ${error.message}`);
  return { profile, profileId };
});

// Artifact resolver: fetch output from a prior step
registerResolver('artifact', async ({ stepName, artifactType, _taskContext }) => {
  if (!_taskContext?.taskId) throw new Error('taskId required for artifact context');

  const { data: steps, error } = await supabase
    .from('ai_employee_task_steps')
    .select('step_name, artifact_refs')
    .eq('task_id', _taskContext.taskId)
    .eq('status', 'succeeded');

  if (error) throw new Error(`Failed to fetch steps: ${error.message}`);

  const targetStep = steps?.find(s => s.step_name === stepName);
  if (!targetStep) return { found: false, artifacts: [] };

  const artifacts = targetStep.artifact_refs || [];
  if (artifactType) {
    return { found: true, artifacts: artifacts.filter(a => a.type === artifactType) };
  }
  return { found: true, artifacts };
});

// OpenCloud resolver: placeholder for file fetch
registerResolver('opencloud', async ({ path, _taskContext }) => {
  // OpenCloud integration would fetch file content here
  // For now, return metadata
  return { source: 'opencloud', path, status: 'placeholder' };
});

export default { resolveContext, registerResolver, detectMissingContext };
