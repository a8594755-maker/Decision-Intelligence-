/**
 * executorRegistry.js — Maps tool_type → executor function.
 *
 * Each executor is a pure async function:
 *   async (stepInput) → { ok: boolean, artifacts: [], logs: [], error?: string }
 *
 * When VITE_DI_MOCK_MODE=true, all executors are replaced with canned mocks.
 */

import { executeBuiltinTool } from './builtinToolExecutor.js';
import { executePythonTool } from './pythonToolExecutor.js';
import { executeLlmCall } from './llmCallExecutor.js';
import { executeReport } from './reportExecutor.js';
import { executeExcelTool } from './excelExecutor.js';

const _MOCK = import.meta.env?.VITE_DI_MOCK_MODE === 'true';

let REGISTRY;
if (_MOCK) {
  const m = await import('../mock/mockExecutors.js');
  REGISTRY = {
    builtin_tool:  m.mockExecuteBuiltinTool,
    python_tool:   m.mockExecutePythonTool,
    python_report: m.mockExecutePythonTool,
    dynamic_tool:  m.mockExecutePythonTool,
    llm_call:      m.mockExecuteLlmCall,
    report:        m.mockExecuteReport,
    export:        m.mockExecuteReport,
    excel:         m.mockExecuteExcel,
  };
  console.info('[ExecutorRegistry] Mock mode active — all executors replaced with canned mocks');
} else {
  REGISTRY = {
    builtin_tool:  executeBuiltinTool,
    python_tool:   executePythonTool,
    python_report: executePythonTool,
    dynamic_tool:  executePythonTool,
    llm_call:      executeLlmCall,
    report:        executeReport,
    export:        executeReport,
    excel:         executeExcelTool,
  };
}

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
