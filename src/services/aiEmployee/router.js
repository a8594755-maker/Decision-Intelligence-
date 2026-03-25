/**
 * router.js — Model routing + budget check before execution.
 *
 * Wraps modelRoutingService.resolveModel() and taskBudgetService.checkBudget().
 * Fixes the model_name vs model field inconsistency.
 */

import { resolveModel } from '../ai-infra/modelRoutingService.js';
import { checkBudget } from '../tasks/taskBudgetService.js';

/**
 * Resolve the LLM config for a task, with budget check.
 *
 * @param {string} taskType - e.g. 'code_generation', 'synthesis', 'forecast'
 * @param {object} context - { priority, complexity, ... }
 * @param {string} [taskId] - for budget check
 * @returns {Promise<{provider: string, model: string, temperature: number, max_tokens: number}>}
 */
export async function routeModel(taskType, context = {}, taskId = null) {
  const resolved = await resolveModel(taskType, context);

  // Fix inconsistency: resolveModel returns { model: row.model_name }
  // but some consumers expect model_name. We normalize to `model`.
  const llmConfig = {
    provider: resolved.provider || 'anthropic',
    model: resolved.model || resolved.model_name || 'claude-sonnet-4-6',
    temperature: resolved.temperature ?? 0.1,
    max_tokens: resolved.max_tokens ?? 4096,
  };

  // Budget check (non-blocking — log warning but don't block execution)
  if (taskId) {
    try {
      const budget = await checkBudget(taskId, {
        estimated_tokens: llmConfig.max_tokens,
        model: llmConfig.model,
      });
      if (budget && !budget.ok) {
        console.warn(`[Router] Budget warning for task ${taskId}: ${budget.reason}`);
      }
    } catch (err) {
      console.warn(`[Router] Budget check failed (non-blocking): ${err.message}`);
    }
  }

  return llmConfig;
}
