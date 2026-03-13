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

// ── Provider → ai-proxy mode mapping ─────────────────────────────────────────

const PROVIDER_MODE_MAP = {
  anthropic: 'anthropic_chat',
  openai:    'openai_chat',
  deepseek:  'deepseek_chat',
  gemini:    'gemini_generate',
};

// For structured DI prompts (JSON output), use di_prompt mode which supports
// all providers with provider-specific routing.
const DI_PROMPT_PROVIDERS = new Set(['gemini', 'deepseek', 'anthropic', 'openai']);

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
}) {
  // 1. Resolve model via routing policy
  const routing = await resolveModel(taskType, routingContext);
  const { provider, model, tier, escalated, escalatedFrom } = routing;

  // 2. Determine default temperature by task type
  const effectiveTemp = temperature ?? _defaultTemperature(taskType);

  // 3. Call ai-proxy
  const t0 = performance.now();
  let result;

  if (jsonMode && DI_PROMPT_PROVIDERS.has(provider)) {
    // Use di_prompt mode for structured JSON output
    result = await invokeAiProxy('di_prompt', {
      provider,
      model,
      prompt: systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt,
      temperature: effectiveTemp,
      maxOutputTokens: maxTokens,
    });
  } else {
    // Use provider-specific chat mode
    const mode = PROVIDER_MODE_MAP[provider];
    if (!mode) {
      throw new Error(`[aiEmployeeLLM] No ai-proxy mode for provider "${provider}"`);
    }

    if (provider === 'gemini') {
      result = await invokeAiProxy(mode, {
        prompt,
        systemContext: systemPrompt,
        options: { model, temperature: effectiveTemp, maxOutputTokens: maxTokens },
      });
    } else {
      // anthropic, openai, deepseek all use the same chat payload shape
      result = await invokeAiProxy(mode, {
        message: prompt,
        systemPrompt,
        model,
        temperature: effectiveTemp,
        maxOutputTokens: maxTokens,
      });
    }
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
  const data = _parseJsonFromText(result.text);
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

/**
 * Extract JSON from LLM text that may include markdown fences or preamble.
 */
function _parseJsonFromText(text) {
  if (!text) return null;

  // Try direct parse first
  try {
    return JSON.parse(text);
  } catch { /* continue */ }

  // Strip markdown code fences
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch { /* continue */ }
  }

  // Find first { or [ and try to parse from there
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  const start = firstBrace === -1 ? firstBracket
    : firstBracket === -1 ? firstBrace
    : Math.min(firstBrace, firstBracket);

  if (start !== -1) {
    try {
      return JSON.parse(text.slice(start));
    } catch { /* continue */ }

    // Try finding matching closing brace/bracket
    const opener = text[start];
    const closer = opener === '{' ? '}' : ']';
    const lastClose = text.lastIndexOf(closer);
    if (lastClose > start) {
      try {
        return JSON.parse(text.slice(start, lastClose + 1));
      } catch { /* ignore */ }
    }
  }

  return null;
}

export default {
  callLLM,
  callLLMJson,
};
