/**
 * builtinToolExecutor.js — Executes built-in DI engines from the catalog.
 *
 * Pure function: stepInput → { ok, artifacts, logs, error? }
 * No state mutation, no DB calls, no event emission.
 */

import { BUILTIN_TOOLS } from '../../builtinToolCatalog.js';

function toImportPath(modulePath) {
  const normalized = modulePath.replace(/^\.\//, '');
  return `../../${normalized}${normalized.endsWith('.js') ? '' : '.js'}`;
}

/**
 * @param {object} stepInput
 * @param {object} stepInput.step - { name, tool_hint, builtin_tool_id, tool_type }
 * @param {object} stepInput.inputData - { sheets, priorArtifacts, datasetProfileRow, userId }
 * @param {object} stepInput.llmConfig - { provider, model, temperature, max_tokens }
 * @returns {Promise<{ok: boolean, artifacts: any[], logs: string[], error?: string}>}
 */
export async function executeBuiltinTool(stepInput) {
  const { step, inputData } = stepInput;
  const logs = [];
  const toolId = step.builtin_tool_id;

  if (!toolId) {
    return { ok: false, artifacts: [], logs, error: 'No builtin_tool_id specified in step' };
  }

  const catalogEntry = BUILTIN_TOOLS.find(t => t.id === toolId);
  if (!catalogEntry) {
    return { ok: false, artifacts: [], logs, error: `Tool '${toolId}' not found in catalog` };
  }

  logs.push(`[BuiltinExecutor] Loading module: ${catalogEntry.module}`);

  try {
    // Dynamic import of the tool's module
    const mod = await import(/* @vite-ignore */ toImportPath(catalogEntry.module));
    const fn = mod[catalogEntry.method];

    if (typeof fn !== 'function') {
      return {
        ok: false, artifacts: [], logs,
        error: `Method '${catalogEntry.method}' not found in module '${catalogEntry.module}'`,
      };
    }

    logs.push(`[BuiltinExecutor] Calling ${catalogEntry.method}()`);

    // Build args from inputData — pass through what the method expects
    const args = {
      userId: inputData.userId,
      datasetProfileRow: inputData.datasetProfileRow,
      settings: inputData.settings || {},
      ...(inputData.priorArtifacts ? { priorArtifacts: inputData.priorArtifacts } : {}),
      ...(inputData.sheets ? { sheets: inputData.sheets } : {}),
      ...(step.input_args || {}),
    };

    const result = await fn(args);

    // Normalize result — DI engines return various shapes
    const artifacts = result?.artifacts || result?.artifact_refs || [];
    logs.push(`[BuiltinExecutor] Completed. Artifacts: ${artifacts.length}`);

    return { ok: true, artifacts, logs };
  } catch (err) {
    logs.push(`[BuiltinExecutor] Error: ${err.message}`);
    return { ok: false, artifacts: [], logs, error: err.message };
  }
}
