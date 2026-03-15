/**
 * executorRegistry.js — Maps tool_type → executor function.
 *
 * Each executor is a pure async function:
 *   async (stepInput) → { ok: boolean, artifacts: [], logs: [], error?: string }
 */

import { executeBuiltinTool } from './builtinToolExecutor.js';
import { executePythonTool } from './pythonToolExecutor.js';
import { executeLlmCall } from './llmCallExecutor.js';
import { executeReport } from './reportExecutor.js';
import { executeOpenCloud } from './opencloudExecutor.js';
import { executeExcelTool } from './excelExecutor.js';

const REGISTRY = {
  builtin_tool:  executeBuiltinTool,
  python_tool:   executePythonTool,
  python_report: executePythonTool,  // Reports via Python (charts/dashboards) — same sandbox
  llm_call:      executeLlmCall,
  report:        executeReport,
  export:        executeReport,      // Export steps use report executor
  opencloud:     executeOpenCloud,
  excel:         executeExcelTool,
};

/**
 * Resolve an executor function for the given tool type.
 * @param {string} toolType
 * @returns {Function} executor
 * @throws {Error} if tool type is unknown
 */
export function getExecutor(toolType) {
  const executor = REGISTRY[toolType];
  if (!executor) {
    throw new Error(`[ExecutorRegistry] Unknown tool_type: '${toolType}'. Known types: ${Object.keys(REGISTRY).join(', ')}`);
  }
  return executor;
}

/**
 * List all registered tool types.
 */
export function listToolTypes() {
  return Object.keys(REGISTRY);
}
