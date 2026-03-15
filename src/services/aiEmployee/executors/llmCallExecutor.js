/**
 * llmCallExecutor.js — Direct LLM calls (no code execution).
 *
 * Used for synthesis, summarization, and other text-only steps.
 * Routes through Supabase ai-proxy (same as reportGeneratorService).
 */

import { invokeAiProxy } from '../../aiProxyService.js';

/**
 * @param {object} stepInput
 * @param {object} stepInput.step - { name, tool_hint }
 * @param {object} stepInput.inputData - { priorArtifacts, context }
 * @param {object} stepInput.llmConfig - { provider, model, temperature, max_tokens }
 * @returns {Promise<{ok: boolean, artifacts: any[], logs: string[], error?: string}>}
 */
export async function executeLlmCall(stepInput) {
  const { step, inputData, llmConfig } = stepInput;
  const logs = [];

  logs.push(`[LLMCallExecutor] Calling LLM for step: ${step.name}`);

  try {
    const contextSummary = JSON.stringify(inputData.priorArtifacts || [])
      .slice(0, 4000);

    const prompt = [
      `Task: ${step.tool_hint}`,
      '',
      'Context from prior steps:',
      contextSummary,
      '',
      'Return your analysis as structured JSON with keys: summary, insights[], recommendations[].',
    ].join('\n');

    const result = await invokeAiProxy({
      model: llmConfig.model || 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: llmConfig.max_tokens || 4096,
      temperature: llmConfig.temperature ?? 0.2,
    });

    const content = result?.content?.[0]?.text || result?.text || '';
    logs.push(`[LLMCallExecutor] Response length: ${content.length} chars`);

    // Try to parse as JSON artifact
    let artifact;
    try {
      artifact = JSON.parse(content);
    } catch {
      artifact = { summary: content };
    }

    return {
      ok: true,
      artifacts: [{
        artifact_type: 'llm_analysis',
        label: step.name,
        payload: artifact,
      }],
      logs,
    };
  } catch (err) {
    logs.push(`[LLMCallExecutor] Error: ${err.message}`);
    return { ok: false, artifacts: [], logs, error: err.message };
  }
}
