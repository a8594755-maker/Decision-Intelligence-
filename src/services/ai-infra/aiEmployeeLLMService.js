// @product: ai-employee
//
// aiEmployeeLLMService.js
// ─────────────────────────────────────────────────────────────────────────────
// Bridge between modelRoutingService (tier/provider resolution) and ai-proxy
// Edge Function (actual LLM call).
//
// Usage:
//   const { text, provider, model, usage } = await callLLM({
//     taskType: 'task_decomposition',
//     prompt: '...',
//     systemPrompt: '...',
//   });
//
// Flow:
//   1. resolveModel(taskType, context) → { provider, model, tier }
//   2. Map provider → ai-proxy mode
//   3. invokeAiProxy(mode, payload) → { text, provider, model }
//   4. recordModelRun() for cost tracking
// ─────────────────────────────────────────────────────────────────────────────

import { resolveModel, recordModelRun } from './modelRoutingService';
import { invokeAiProxy } from './aiProxyService';
import { extractAiJson } from '../../utils/aiMappingHelper';

// ── Provider → ai-proxy mode mapping ─────────────────────────────────────────

const PROVIDER_MODE_MAP = {
  anthropic: 'anthropic_chat',
  openai:    'openai_chat',
  deepseek:  'deepseek_chat',
  gemini:    'gemini_chat',
  kimi:      'kimi_chat',
};

// For structured DI prompts (JSON output), use di_prompt mode which supports
// all providers with provider-specific routing.
const DI_PROMPT_PROVIDERS = new Set(['gemini', 'deepseek', 'anthropic', 'openai', 'kimi']);

// ── Core LLM call ────────────────────────────────────────────────────────────

/**
 * Call an LLM through the ai-proxy Edge Function with automatic model routing.
 *
 * @param {object} opts
 * @param {string} opts.taskType       – Routing policy key (e.g. 'task_decomposition', 'review')
 * @param {string} opts.prompt         – User/task prompt
 * @param {string} [opts.systemPrompt] – System instruction
 * @param {number} [opts.temperature]  – 0-1 (default based on task type)
 * @param {number} [opts.maxTokens]    – Max output tokens (default 8192)
 * @param {boolean} [opts.jsonMode]    – If true, uses di_prompt mode for structured output
 * @param {object} [opts.routingContext] – Extra context for resolveModel (retryCount, highRisk, etc.)
 * @param {object} [opts.trackingMeta]  – For recordModelRun (taskId, employeeId, etc.)
 * @returns {Promise<{ text: string, provider: string, model: string, tier: string, usage: object|null }>}
 */
export async function callLLM({
  taskType,
  prompt,
  systemPrompt = '',
  temperature,
  maxTokens = 8192,
  jsonMode = false,
  routingContext = {},
  trackingMeta = {},
  modelOverride = null,
}) {
  // 1. Resolve model via routing policy (or use override from self-healing)
  let provider, model, tier, escalated, escalatedFrom;
  if (modelOverride?.provider && modelOverride?.model_name) {
    provider = modelOverride.provider;
    model = modelOverride.model_name;
    tier = 'override';
    escalated = true;
    escalatedFrom = 'self_healing';
  } else {
    const routing = await resolveModel(taskType, routingContext);
    ({ provider, model, tier, escalated, escalatedFrom } = routing);
  }

  // 2. Determine default temperature by task type
  const effectiveTemp = temperature ?? _defaultTemperature(taskType);

  // 3. Call ai-proxy
  const t0 = performance.now();
  let result;

  // DeepSeek reasoner mode: suppress temperature (API rejects it)
  const isDeepSeekReasoner = provider === 'deepseek' && /deepseek-reasoner/i.test(model);
  const finalTemp = isDeepSeekReasoner ? undefined : effectiveTemp;

  if (jsonMode && DI_PROMPT_PROVIDERS.has(provider)) {
    // Use di_prompt mode for structured JSON output
    const payload = {
      provider,
      model,
      prompt: systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt,
      maxOutputTokens: maxTokens,
      responseMimeType: 'application/json',
      ...(finalTemp !== undefined ? { temperature: finalTemp } : {}),
      ...(isDeepSeekReasoner ? { thinking: true } : {}),
    };
    result = await invokeAiProxy('di_prompt', payload);
  } else {
    // Use provider-specific chat mode
    const mode = PROVIDER_MODE_MAP[provider];
    if (!mode) {
      throw new Error(`[aiEmployeeLLM] No ai-proxy mode for provider "${provider}"`);
    }

    const payload = {
      message: prompt,
      systemPrompt,
      model,
      maxOutputTokens: maxTokens,
      ...(finalTemp !== undefined ? { temperature: finalTemp } : {}),
      ...(isDeepSeekReasoner ? { thinking: true } : {}),
      ...(jsonMode && provider === 'deepseek' ? { response_format: { type: 'json_object' } } : {}),
    };
    result = await invokeAiProxy(mode, payload);
  }

  const latencyMs = Math.round(performance.now() - t0);

  // 4. Record model run for cost tracking (fire-and-forget)
  if (trackingMeta.taskId && trackingMeta.employeeId) {
    recordModelRun({
      taskId: trackingMeta.taskId,
      runId: trackingMeta.runId || null,
      employeeId: trackingMeta.employeeId,
      agentRole: trackingMeta.agentRole || taskType,
      provider,
      modelName: result.model || model,
      tier,
      inputTokens: result.usage?.input_tokens || result.usage?.prompt_tokens || 0,
      outputTokens: result.usage?.output_tokens || result.usage?.completion_tokens || 0,
      latencyMs,
      stepName: trackingMeta.stepName || null,
      escalatedFrom: escalatedFrom || null,
    }).catch((err) => console.warn('[aiEmployeeLLM] recordModelRun failed:', err?.message));
  }

  return {
    text: result.text || '',
    provider: result.provider || provider,
    model: result.model || model,
    tier,
    escalated,
    usage: result.usage || null,
    transport: result.transport || (provider === 'gemini' ? 'compat' : 'native'),
  };
}

/**
 * Call LLM and parse the result as JSON.
 * Strips markdown code fences and extracts the first JSON object/array.
 *
 * @param {object} opts – Same as callLLM
 * @returns {Promise<{ data: any, text: string, provider: string, model: string, tier: string }>}
 */
export async function callLLMJson(opts) {
  const result = await callLLM({ ...opts, jsonMode: true });
  const data = extractAiJson(result.text);
  return { ...result, data };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _defaultTemperature(taskType) {
  switch (taskType) {
    case 'task_decomposition': return 0.3;  // Structured output needs low temp
    case 'review':             return 0.2;  // Consistent scoring
    case 'dynamic_tool_generation': return 0.4; // Code generation
    case 'report':             return 0.5;
    default:                   return 0.7;
  }
}


export default {
  callLLM,
  callLLMJson,
};
