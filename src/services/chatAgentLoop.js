/**
 * chatAgentLoop.js
 * ─────────────────────────────────────────────────────────────────────────────
 * ReAct Agent Loop: the brain of the chat.
 *
 * Instead of a single LLM call that returns text, this module implements:
 *
 *   User message
 *     → LLM (with tool definitions)
 *       → If LLM wants to call a tool → execute it → feed result back → loop
 *       → If LLM returns text → stream to UI → done
 *
 * This gives the chat the ability to autonomously run forecasts, plans,
 * risk analyses, and any other tool in the builtinToolCatalog.
 *
 * Architecture:
 *   ┌─────────┐     ┌─────────┐     ┌──────────┐     ┌──────────┐
 *   │  User   │────►│  Agent  │────►│   LLM    │────►│  Tools   │
 *   │  Chat   │◄────│  Loop   │◄────│ DeepSeek │◄────│ Catalog  │
 *   └─────────┘     └─────────┘     └──────────┘     └──────────┘
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { getToolDefinitions, getToolSummaryForPrompt, executeTool } from './chatToolAdapter.js';
import { invokeAiProxy } from './aiProxyService.js';
import { trackLlmUsage } from '../utils/llmUsageTracker.js';

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_AGENT_ITERATIONS = 8; // Prevent infinite loops
const AGENT_TIMEOUT_MS = 300_000; // 5 minutes total for the full agent loop
const DEEPSEEK_BASE_URL = String(import.meta.env.VITE_DI_DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const DEEPSEEK_CHAT_MODEL = import.meta.env.VITE_DI_DEEPSEEK_MODEL || 'deepseek-chat';
const USE_EDGE_AI_PROXY = true;

// ── Agent Loop ──────────────────────────────────────────────────────────────

/**
 * Run the ReAct agent loop.
 *
 * @param {object} params
 * @param {string} params.message - User's message
 * @param {Array}  params.conversationHistory - Previous messages [{role, content}]
 * @param {string} params.systemPrompt - System context (domain state, capabilities)
 * @param {object} params.toolContext - Runtime context for tool execution (userId, datasetProfileRow)
 * @param {object} [params.callbacks] - UI callbacks
 * @param {function} [params.callbacks.onTextChunk] - Called with each text chunk (for streaming)
 * @param {function} [params.callbacks.onToolCall] - Called when a tool is about to execute
 * @param {function} [params.callbacks.onToolResult] - Called when a tool finishes
 * @param {function} [params.callbacks.onThinking] - Called when agent is reasoning
 * @param {AbortSignal} [params.signal] - Abort signal
 * @returns {Promise<AgentResult>}
 */
export async function runAgentLoop({
  message,
  conversationHistory = [],
  systemPrompt = '',
  toolContext = {},
  callbacks = {},
  signal,
}) {
  const { onTextChunk, onToolCall, onToolResult, onThinking } = callbacks;

  // Build the tool definitions for the LLM
  const tools = getToolDefinitions();
  const toolSummary = getToolSummaryForPrompt();

  // Augment system prompt with tool awareness
  const agentSystemPrompt = [
    systemPrompt,
    '',
    '── Agent Capabilities ──',
    toolSummary,
    '',
    'IMPORTANT INSTRUCTIONS:',
    '- When the user asks to run an analysis, forecast, plan, or any tool, call the appropriate function.',
    '- Before calling a tool, briefly explain what you are going to do.',
    '- After a tool returns results, summarize the key findings for the user.',
    '- If a tool fails, explain the error and suggest alternatives.',
    '- You can chain multiple tools: e.g., run forecast first, then generate a plan.',
    '- If you need data that is not available, ask the user to upload it.',
    '- Always respond in the same language the user used.',
  ].join('\n');

  // Build initial messages array (OpenAI format)
  const messages = [];
  messages.push({ role: 'system', content: agentSystemPrompt });

  // Add conversation history (last 10 turns)
  const historyWindow = conversationHistory.slice(-10);
  for (const entry of historyWindow) {
    const role = entry.role === 'ai' || entry.role === 'assistant' ? 'assistant' : 'user';
    const content = entry.content || '';
    if (content) {
      messages.push({ role, content });
    }
  }

  // Add current user message
  messages.push({ role: 'user', content: message });

  // Track all tool calls for the final result
  const toolCalls = [];
  let finalText = '';
  let totalIterations = 0;

  // ── The Loop ────────────────────────────────────────────────────────────
  for (let i = 0; i < MAX_AGENT_ITERATIONS; i++) {
    if (signal?.aborted) {
      throw new Error('Agent loop aborted');
    }

    totalIterations = i + 1;
    onThinking?.(`Thinking... (step ${i + 1})`);

    const t0 = Date.now();
    let response;

    try {
      response = await callLLMWithTools(messages, tools, { signal });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      console.error('[agentLoop] LLM call failed:', err);
      finalText = `❌ AI service error: ${err.message}`;
      break;
    }

    const latencyMs = Date.now() - t0;

    // Case 1: LLM returns text (no tool calls) → we're done
    if (!response.tool_calls?.length) {
      const text = response.content || '';
      finalText = text;
      onTextChunk?.(text);

      trackLlmUsage({
        source: 'agent_loop',
        model: DEEPSEEK_CHAT_MODEL,
        provider: 'deepseek',
        status: 'success',
        latencyMs,
        workflow: 'agent_chat',
        promptTokens: response.usage?.prompt_tokens,
        completionTokens: response.usage?.completion_tokens,
      });
      break;
    }

    // Case 2: LLM wants to call tools → execute them
    // First, append the assistant message with tool_calls to the conversation
    messages.push({
      role: 'assistant',
      content: response.content || null,
      tool_calls: response.tool_calls,
    });

    // Stream any text that came with the tool call (e.g., "Let me run the forecast...")
    if (response.content) {
      onTextChunk?.(response.content + '\n\n');
      finalText += response.content + '\n\n';
    }

    // Execute each tool call
    for (const tc of response.tool_calls) {
      const toolName = tc.function?.name;
      let toolArgs = {};
      try {
        toolArgs = JSON.parse(tc.function?.arguments || '{}');
      } catch {
        toolArgs = {};
      }

      onToolCall?.({ id: tc.id, name: toolName, args: toolArgs });

      // Execute the tool
      const toolResult = await executeTool(toolName, toolArgs, toolContext);

      onToolResult?.({
        id: tc.id,
        name: toolName,
        success: toolResult.success,
        result: toolResult.result,
        error: toolResult.error,
        artifactTypes: toolResult.artifactTypes,
      });

      toolCalls.push({
        id: tc.id,
        name: toolName,
        args: toolArgs,
        result: toolResult,
      });

      // Feed the tool result back into the conversation
      const resultContent = toolResult.success
        ? JSON.stringify(summarizeToolResult(toolResult.result), null, 2)
        : JSON.stringify({ error: toolResult.error });

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: resultContent,
      });
    }

    trackLlmUsage({
      source: 'agent_loop',
      model: DEEPSEEK_CHAT_MODEL,
      provider: 'deepseek',
      status: 'success',
      latencyMs,
      workflow: 'agent_tool_call',
      promptTokens: response.usage?.prompt_tokens,
      completionTokens: response.usage?.completion_tokens,
    });

    // Loop continues — LLM will see the tool results and decide what to do next
  }

  if (totalIterations >= MAX_AGENT_ITERATIONS && !finalText) {
    finalText = '⚠️ Agent reached maximum iterations. The analysis may be incomplete. Please try a more specific request.';
    onTextChunk?.(finalText);
  }

  return {
    text: finalText,
    toolCalls,
    iterations: totalIterations,
    isAgentResponse: true,
  };
}

// ── LLM Call with Tools ──────────────────────────────────────────────────────

/**
 * Call DeepSeek with function-calling tools.
 * Returns the parsed assistant message including any tool_calls.
 */
async function callLLMWithTools(messages, tools, { signal } = {}) {
  // Try Edge Function (ai-proxy) first
  if (USE_EDGE_AI_PROXY) {
    try {
      const result = await invokeAiProxy('deepseek_chat_tools', {
        messages,
        tools,
        model: DEEPSEEK_CHAT_MODEL,
        temperature: 0.3, // Lower temperature for tool calls — more deterministic
        maxOutputTokens: 4096,
      }, { signal });

      // The ai-proxy should return the full OpenAI-format response
      if (result?.choices?.[0]?.message) {
        return {
          ...result.choices[0].message,
          usage: result.usage,
        };
      }
      // Fallback: ai-proxy returned text only
      if (result?.text) {
        return { content: result.text, tool_calls: [], usage: result.usage };
      }

      throw new Error('Unexpected ai-proxy response format');
    } catch (err) {
      console.warn('[agentLoop] ai-proxy failed, falling back to direct API:', err.message);
    }
  }

  // Direct DeepSeek API call
  const deepSeekApiKey = getDeepSeekApiKey();
  if (!deepSeekApiKey) {
    throw new Error('No DeepSeek API key configured. Set VITE_DEEPSEEK_API_KEY in environment or local settings.');
  }

  const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${deepSeekApiKey}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_CHAT_MODEL,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: 'auto',
      temperature: 0.3,
      max_tokens: 4096,
    }),
    signal,
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData?.error?.message || `DeepSeek API error (${response.status})`);
  }

  const data = await response.json();
  const msg = data.choices?.[0]?.message;

  if (!msg) {
    throw new Error('No message in DeepSeek response');
  }

  return { ...msg, usage: data.usage };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Get DeepSeek API key from environment or localStorage.
 */
function getDeepSeekApiKey() {
  const envKey = import.meta.env.VITE_DEEPSEEK_API_KEY || '';
  if (envKey) return envKey;
  try {
    return localStorage.getItem('deepseek_api_key') || '';
  } catch {
    return '';
  }
}

/**
 * Summarize a tool result to a reasonable size for feeding back to the LLM.
 * Large arrays get truncated to avoid blowing the context window.
 */
function summarizeToolResult(result, maxItems = 20, maxDepth = 3) {
  if (!result || typeof result !== 'object') return result;

  function truncate(obj, depth) {
    if (depth <= 0) return '[...]';
    if (Array.isArray(obj)) {
      const truncated = obj.slice(0, maxItems).map((item) => truncate(item, depth - 1));
      if (obj.length > maxItems) {
        truncated.push(`... (${obj.length - maxItems} more items, ${obj.length} total)`);
      }
      return truncated;
    }
    if (typeof obj === 'object' && obj !== null) {
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        out[k] = truncate(v, depth - 1);
      }
      return out;
    }
    return obj;
  }

  return truncate(result, maxDepth);
}

/**
 * Check if agent mode should be used for this message.
 * Agent mode activates when:
 *   1. The message looks like a tool-worthy request (not just conversation)
 *   2. There are tools available
 *   3. The feature is enabled
 */
export function shouldUseAgentMode(message) {
  if (!message || typeof message !== 'string') return false;
  const lower = message.toLowerCase();

  // Strong signals: explicit requests to run something
  const strongSignals = [
    /\b(run|execute|generate|compute|analyze|forecast|plan|simulate|比較|預測|計畫|分析|模擬|執行|產生)\b/i,
    /\b(what.?if|scenario|risk|negotiate|cost|revenue|bom|closed.?loop|supply)\b/i,
    /\b(幫我|請|跑一下|做一個|建立|檢查)\b/,
  ];

  return strongSignals.some((re) => re.test(lower));
}
