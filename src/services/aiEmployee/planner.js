/**
 * planner.js — Thin wrapper around chatTaskDecomposer.
 *
 * Normalizes decomposition output into a TaskPlan object that
 * the orchestrator can consume directly.
 */

import { decomposeTask } from '../chat/chatTaskDecomposer.js';
import { BUILTIN_TOOLS } from '../ai-infra/builtinToolCatalog.js';

// Tool types that require a dataset to execute
const DATASET_REQUIRED_TOOL_IDS = new Set([
  'run_forecast', 'run_plan', 'run_risk_analysis', 'run_risk_aware_plan',
  'run_data_quality', 'run_scenario_analysis',
]);

/**
 * @typedef {object} TaskPlan
 * @property {string} title
 * @property {string} description
 * @property {Array<PlanStep>} steps
 * @property {object} inputData
 * @property {object} llmConfig
 */

/**
 * @typedef {object} PlanStep
 * @property {string} name
 * @property {string} tool_hint
 * @property {string} tool_type - builtin_tool | python_tool | llm_call | report | export | excel
 * @property {string} [builtin_tool_id]
 * @property {boolean} [review_checkpoint]
 */

/**
 * Decompose a user message into a normalized TaskPlan.
 *
 * @param {object} params
 * @param {string} params.userMessage
 * @param {object} [params.sessionContext]
 * @param {string} [params.employeeId]
 * @param {string} [params.userId]
 * @param {object} [params.inputData] - { sheets, datasetProfileRow }
 * @param {object} [params.llmConfig]
 * @returns {Promise<TaskPlan>}
 */
export async function createPlan({ userMessage, sessionContext, employeeId, userId, inputData, llmConfig }) {
  const decomposed = await decomposeTask({
    userMessage,
    sessionContext,
    employeeId,
    userId,
  });

  // Normalize steps — decomposer returns { steps: [{ name, tool_hint, builtin_tool_id, ... }] }
  const rawSteps = decomposed.steps || decomposed.plan?.steps || [];

  const steps = rawSteps.map((raw, i) => {
    // Determine tool_type
    let toolType = raw.tool_type || 'python_tool';
    if (raw.builtin_tool_id) {
      const catalogEntry = BUILTIN_TOOLS.find(t => t.id === raw.builtin_tool_id);
      if (catalogEntry) toolType = 'builtin_tool';
    }

    return {
      name: raw.name || raw.step_name || `step_${i}`,
      tool_hint: raw.tool_hint || raw.description || raw.name,
      tool_type: toolType,
      builtin_tool_id: raw.builtin_tool_id || null,
      requires_dataset: raw.requires_dataset ?? DATASET_REQUIRED_TOOL_IDS.has(raw.builtin_tool_id),
      review_checkpoint: raw.review_checkpoint || false,
      report_format: raw.report_format || null,
    };
  });

  return {
    title: decomposed.title || decomposed.plan?.title || userMessage.slice(0, 100),
    description: decomposed.description || decomposed.plan?.description || userMessage,
    steps,
    inputData: inputData || {},
    llmConfig: llmConfig || { provider: 'anthropic', model: 'claude-sonnet-4-6', temperature: 0.1, max_tokens: 4096 },
  };
}
