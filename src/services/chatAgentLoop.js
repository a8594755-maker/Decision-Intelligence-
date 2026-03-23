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
import { invokeAiProxy, invokeAiProxyStream } from './aiProxyService.js';
import { trackLlmUsage } from '../utils/llmUsageTracker.js';
import { detectToolGap, detectProactiveGap } from './gapDetectionService.js';
import { generateToolBlueprint } from './toolBlueprintGenerator.js';
import { getRecipeIndexForPrompt } from './chartRecipeCatalog.js';

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_AGENT_ITERATIONS = 8; // Prevent infinite loops
const AGENT_TIMEOUT_MS = 300_000; // 5 minutes total for the full agent loop
const DEEPSEEK_BASE_URL = String(import.meta.env.VITE_DI_DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const DEEPSEEK_CHAT_MODEL = import.meta.env.VITE_DI_DEEPSEEK_MODEL || 'deepseek-chat';
const AGENT_CHAT_MODEL = import.meta.env.VITE_DI_CHAT_MODEL || 'gpt-5.4';
const AGENT_CHAT_PROVIDER = import.meta.env.VITE_DI_CHAT_PROVIDER || 'openai';
const USE_EDGE_AI_PROXY = true;

// ── DuckDB dialect guidance (shared between all prompt modes) ────────────────
const DUCKDB_DIALECT_PROMPT = [
  'query_sap_data SQL Dialect — DuckDB (PostgreSQL-compatible, in-browser WASM):',
  '- CTEs (WITH ... AS) fully supported — use them for readability',
  '- Window functions supported: ROW_NUMBER(), RANK(), DENSE_RANK(), NTILE(), LAG(), LEAD() with OVER(PARTITION BY ... ORDER BY ...)',
  '- Date functions: DATE_TRUNC(part, col), EXTRACT(part FROM col), col + INTERVAL',
  '- Advanced aggregates: PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY col), MEDIAN(col), MODE(col), QUANTILE_DISC(0.9 ORDER BY col)',
  '- String: STRING_AGG(col, sep), REGEXP_MATCHES(), CONCAT()',
  '- Avoid reserved word aliases: "order", "group", "key", "value" → use descriptive names like "order_count"',
  '- Standard SQL: COUNT, SUM, AVG, MIN, MAX, ROUND, CASE WHEN, UNION ALL, HAVING, DISTINCT, LIKE, CROSS JOIN',
].join('\n');

export const ANALYSIS_AGENT_TOOL_IDS = Object.freeze([
  'query_sap_data',
  'list_sap_tables',
  'run_python_analysis',
  'generate_chart',
]);

export function getAgentToolConfig(mode = 'default') {
  if (mode === 'analysis') {
    return {
      toolIds: ANALYSIS_AGENT_TOOL_IDS,
      excludePython: false,
      includeRegistered: false,
    };
  }
  return {
    excludePython: true,
    includeRegistered: true,
  };
}

export function getAgentToolStreamingMode(provider) {
  if (provider === 'openai') return 'openai_chat_tools_stream';
  if (provider === 'anthropic') return 'anthropic_chat_tools_stream';
  return null;
}

// ── Agent Loop ──────────────────────────────────────────────────────────────

/**
 * Run the ReAct agent loop.
 *
 * @param {object} params
 * @param {string} params.message - User's message
 * @param {Array}  params.conversationHistory - Previous messages [{role, content}]
 * @param {string} params.systemPrompt - System context (domain state, capabilities)
 * @param {object} params.toolContext - Runtime context for tool execution (userId, datasetProfileRow)
 * @param {object|null} [params.answerContract] - Structured contract for what the final answer must cover
 * @param {object} [params.callbacks] - UI callbacks
 * @param {function} [params.callbacks.onTextChunk] - Called with each text chunk (for streaming)
 * @param {function} [params.callbacks.onToolCall] - Called when a tool is about to execute
 * @param {function} [params.callbacks.onToolResult] - Called when a tool finishes
 * @param {function} [params.callbacks.onThinking] - Called when agent is reasoning
 * @param {function} [params.callbacks.onToolBlueprint] - Called when a tool gap is detected and a blueprint is generated
 * @param {AbortSignal} [params.signal] - Abort signal
 * @returns {Promise<AgentResult>}
 */
export async function runAgentLoop({
  message,
  conversationHistory = [],
  systemPrompt = '',
  toolContext = {},
  answerContract = null,
  callbacks = {},
  signal,
  mode = 'default',
  agentProvider = AGENT_CHAT_PROVIDER,
  agentModel = AGENT_CHAT_MODEL,
}) {
  const { onTextChunk, onToolCall, onToolResult, onThinking, onToolBlueprint } = callbacks;

  // Build the tool definitions for the LLM
  const toolConfig = getAgentToolConfig(mode);
  const tools = getToolDefinitions(toolConfig);
  const toolSummary = getToolSummaryForPrompt(toolConfig);
  const isAnalysisMode = mode === 'analysis';

  // Augment system prompt with tool awareness
  // Recipe catalog is ALWAYS injected so the LLM can autonomously decide when to use generate_chart.
  const recipeIndex = getRecipeIndexForPrompt();
  const answerContractBlock = formatAnswerContractForPrompt(answerContract);

  const importantInstructions = isAnalysisMode
    ? [
        '- This is a direct business analysis request.',
        '',
        'Tool Selection Rules (in priority order):',
        '1. generate_chart(recipe_id) — Use when user asks to show, plot, chart, or visualize data, OR when any recipe below matches the question. Pre-written Python, fast (~2s), deterministic.',
        '2. run_python_analysis — Use for custom/exploratory analysis NOT covered by any recipe, or when the user uploads their own dataset.',
        '3. query_sap_data — Use when user needs raw SQL lookups or specific data queries.',
        '',
        '- If uploaded dataset sheets are available, analyze that dataset with run_python_analysis instead of default Olist tables.',
        '- After generate_chart succeeds: the card already shows title, metrics, highlights, and chart. Do NOT repeat them. Only add a short (2-4 sentence) business insight or actionable recommendation that is NOT already in the card. If there is nothing to add, just say "已產出圖表" or similar.',
        '- After other tools return results, summarize the key findings clearly and concisely.',
        '- If a tool fails, explain the error and suggest a narrower follow-up analysis.',
        '- Always respond in the same language the user used.',
        '',
        DUCKDB_DIALECT_PROMPT,
        '',
        'Final Answer Rules:',
        '- You are a senior analyst. Write only the useful user-facing interpretation.',
        '- Keep the final answer under 160 words unless the evidence is blocked and needs a caveat.',
        '- Do NOT output markdown tables, pseudo-tables, SQL, debug logs, tool transcripts, "thinking", or step-by-step execution details.',
        '- Do NOT list every tool you called. The UI renders execution trace separately.',
        '- Focus on concise interpretation, caveats, and the next best action.',
        '',
        answerContractBlock,
        recipeIndex,
      ]
    : [
        '- When the user asks about data (customers, orders, products, sellers, payments, etc.), ALWAYS call query_sap_data with a SQL query. NEVER just describe SQL — execute it.',
        '- Call query_sap_data ONCE per question. Do NOT call it again with test queries like "SELECT 1".',
        DUCKDB_DIALECT_PROMPT,
        '- When the user asks to run an analysis, chart, visualization, forecast, plan, or any tool, call the appropriate function.',
        '- If the user asks for a chart, visualization, or any analysis that matches the recipe catalog below, use generate_chart(recipe_id). It runs pre-written Python (~2s) instead of LLM code generation (~15s).',
        '- After generate_chart succeeds: the card already shows title, metrics, highlights, and chart. Do NOT repeat them. Only add a short (2-4 sentence) business insight or actionable recommendation. If nothing to add, just say the chart is ready.',
        '- After other tools return results, summarize the key findings for the user.',
        '- If a tool fails, explain the error and suggest alternatives.',
        '- You can chain multiple tools: e.g., run forecast first, then generate a plan.',
        '- To forecast from SAP data, use forecast_from_sap (NOT run_forecast). It accepts a demand_sql parameter — write a SQL that returns (material_code, plant_id, time_bucket, demand_qty). If no SQL given, defaults to Olist orders. Olist data covers 2017-01 to 2018-08.',
        '- If you need data that is not available, try query_sap_data first before asking the user to upload.',
        '- Tools prefixed with "reg_" are user-approved registered tools. Use them when they match the task.',
        '- If a tool fails due to data format mismatch, the system may auto-generate an adapter tool for the user to approve.',
        '- Always respond in the same language the user used.',
        '',
        'Final Answer Rules:',
        '- You are a senior analyst. Write only the useful user-facing interpretation.',
        '- Keep the final answer under 160 words unless the evidence is blocked and needs a caveat.',
        '- Do NOT output markdown tables, pseudo-tables, SQL, debug logs, tool transcripts, "thinking", or step-by-step execution details.',
        '- Do NOT list every tool you called. The UI renders execution trace separately.',
        '- Focus on concise interpretation, caveats, and the next best action.',
        '',
        answerContractBlock,
        recipeIndex,
      ];
  const agentSystemPrompt = [
    systemPrompt,
    '',
    '── Agent Capabilities ──',
    toolSummary,
    '',
    'IMPORTANT INSTRUCTIONS:',
    ...importantInstructions,
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
  const consecutiveFailures = { count: 0, lastToolName: null };

  // ── The Loop ────────────────────────────────────────────────────────────
  for (let i = 0; i < MAX_AGENT_ITERATIONS; i++) {
    if (signal?.aborted) {
      throw new Error('Agent loop aborted');
    }

    totalIterations = i + 1;
    onThinking?.({ step: i + 1, type: 'step_start', content: '', fullContent: '' });

    const t0 = Date.now();
    let response;

    try {
      let thinkingBuffer = '';
      response = await callLLMWithToolsStream(messages, tools, {
        signal,
        provider: agentProvider,
        model: agentModel,
        onPreambleChunk: (chunk) => {
          thinkingBuffer += chunk;
          onThinking?.({ step: i + 1, type: 'preamble', content: chunk, fullContent: thinkingBuffer });
        },
      });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      // Fallback to non-streaming if stream mode fails
      console.warn('[agentLoop] Stream call failed, trying non-stream fallback:', err.message);
      try {
        response = await callLLMWithTools(messages, tools, {
          signal,
          provider: agentProvider,
          model: agentModel,
        });
      } catch (err2) {
        if (err2.name === 'AbortError') throw err2;
        console.error('[agentLoop] LLM call failed:', err2);
        finalText = `❌ AI service error: ${err2.message}`;
        break;
      }
    }

    const latencyMs = Date.now() - t0;

    // Case 1: LLM returns text (no tool calls)
    if (!response.tool_calls?.length) {
      const text = response.content || '';

      // Fallback A: some models emit tool calls as JSON text instead of structured tool_calls.
      const extracted = extractEmbeddedToolCall(text, tools);
      if (extracted) {
        console.info('[agentLoop] Extracted embedded tool call from text:', extracted.name);
        response.tool_calls = [{
          id: `embedded_${Date.now()}`,
          type: 'function',
          function: { name: extracted.name, arguments: JSON.stringify(extracted.args) },
        }];
        response.content = extracted.preamble || null;
        // Fall through to Case 2 below

      // Fallback B: LLM said "I'll query" but didn't actually call a tool.
      // Push its response back and nudge it to actually execute.
      } else if (i < 2 && looksLikeToolIntent(text)) {
        console.info('[agentLoop] LLM stated intent without calling tool, nudging (iteration', i, ')');
        // Stream the preamble text so user sees something
        onTextChunk?.(text + '\n');
        messages.push({ role: 'assistant', content: text });
        messages.push({
          role: 'user',
          content: `IMPORTANT: You MUST call the query_sap_data function right now. Do not explain what you will do — just call it. For example: query_sap_data({"sql":"SELECT ..."})`,
        });
        continue;

      } else {
        finalText = text;
        onTextChunk?.(text);

        trackLlmUsage({
          source: 'agent_loop',
          model: agentModel,
          provider: agentProvider,
          status: 'success',
          latencyMs,
          workflow: 'agent_chat',
          promptTokens: response.usage?.prompt_tokens,
          completionTokens: response.usage?.completion_tokens,
        });
        break;
      }
    }

    // Case 2: LLM wants to call tools → execute them
    // First, append the assistant message with tool_calls to the conversation
    messages.push({
      role: 'assistant',
      content: response.content || null,
      tool_calls: response.tool_calls,
    });

    // Stream any text that came with the tool call (e.g., "Let me run the forecast...")
    // Keep it out of the persisted final answer.
    if (response.content) {
      onTextChunk?.(response.content + '\n\n');
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

      // ── Data Learning: extract insights from successful SQL queries ──
      if (toolName === 'query_sap_data' && toolResult.success && toolResult.result?.rows) {
        try {
          import('./dataInsightService.js').then(({ extractInsightsFromQueryResult }) => {
            extractInsightsFromQueryResult(toolArgs.sql, toolResult.result.rows, toolResult.result.rowCount);
          });
        } catch { /* non-critical — never block agent loop */ }
      }

      // ── Gap Detection: if tool failed, check if we can auto-create a tool ──
      if (!toolResult.success && i < MAX_AGENT_ITERATIONS - 2 && onToolBlueprint) {
        const gap = detectToolGap({
          taskDescription: message,
          toolCallResult: toolResult,
          toolName,
          toolArgs,
          availableTools: tools,
        });

        if (gap.hasGap) {
          console.info('[agentLoop] Gap detected:', gap.gapType, gap.gapDescription);
          onTextChunk?.(`\n🔍 Detected capability gap: **${gap.gapType}**\n💡 Generating tool blueprint...\n\n`);

          try {
            const blueprint = await generateToolBlueprint(gap);
            console.info('[agentLoop] Blueprint generated:', blueprint.name);

            // Return early with blueprint — DSV will handle the approval flow
            return {
              text: finalText || '',
              toolCalls,
              iterations: totalIterations,
              isAgentResponse: true,
              blueprint, // ← DSV checks this to show ToolBlueprintCard
              gap,
            };
          } catch (blueprintErr) {
            console.warn('[agentLoop] Blueprint generation failed:', blueprintErr?.message);
            // Fall through — let the normal error flow handle it
          }
        }
      }

      // Feed the tool result back into the conversation
      const resultContent = toolResult.success
        ? JSON.stringify(summarizeToolResult(toolResult.result), null, 2)
        : JSON.stringify({ error: toolResult.error });

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: resultContent,
      });

      // ── Consecutive failure detection ──────────────────────────────────
      if (!toolResult.success) {
        if (toolName === consecutiveFailures.lastToolName) {
          consecutiveFailures.count++;
        } else {
          consecutiveFailures.count = 1;
          consecutiveFailures.lastToolName = toolName;
        }
      } else {
        consecutiveFailures.count = 0;
        consecutiveFailures.lastToolName = null;
      }

      // After 2+ consecutive failures on the same tool, nudge the LLM to switch strategy
      if (consecutiveFailures.count >= 2) {
        messages.push({
          role: 'user',
          content: `⚠️ ${consecutiveFailures.lastToolName} has failed ${consecutiveFailures.count} times in a row. Do NOT retry with similar parameters. Either use a completely different approach (e.g., generate_chart recipe, run_python_analysis) or provide your final answer with the data you already have.`,
        });
      }
    }

    trackLlmUsage({
      source: 'agent_loop',
      model: agentModel,
      provider: agentProvider,
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
    provider: agentProvider,
    model: agentModel,
  };
}

// ── LLM Call with Tools (Streaming) ─────────────────────────────────────────

/**
 * Call LLM with tools via SSE streaming.
 * Streams thinking/preamble content in real-time via onPreambleChunk callback.
 * Returns the same shape as callLLMWithTools: { content, tool_calls, usage }.
 */
async function callLLMWithToolsStream(messages, tools, { signal, onPreambleChunk, provider = AGENT_CHAT_PROVIDER, model = AGENT_CHAT_MODEL } = {}) {
  const toolsMode = getAgentToolStreamingMode(provider);

  if (!toolsMode) {
    // Providers without a streaming tool path fall back to non-streaming.
    return callLLMWithTools(messages, tools, { signal, provider, model });
  }

  let content = '';
  const toolCallsMap = []; // Accumulate tool_calls from deltas
  let usage = null;

  console.info(`[agentLoop] Calling LLM stream (${toolsMode}, model=${model}) with ${tools.length} tools`);

  await invokeAiProxyStream(toolsMode, {
    messages,
    tools,
    model,
    temperature: 0.3,
    maxOutputTokens: 4096,
  }, {
    signal,
    onDelta: (chunk) => {
      // Handle usage in final chunk
      if (chunk.usage) {
        usage = chunk.usage;
      }

      const delta = chunk.choices?.[0]?.delta;
      if (!delta) return;

      // Text content — preamble (before/with tool calls) or final answer
      if (delta.content) {
        content += delta.content;
        onPreambleChunk?.(delta.content);
      }

      // Tool calls are streamed incrementally — accumulate by index
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolCallsMap[idx]) {
            toolCallsMap[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
          }
          if (tc.id) toolCallsMap[idx].id = tc.id;
          if (tc.function?.name) toolCallsMap[idx].function.name += tc.function.name;
          if (tc.function?.arguments) toolCallsMap[idx].function.arguments += tc.function.arguments;
        }
      }
    },
  });

  const tool_calls = toolCallsMap.filter(Boolean);
  console.info(`[agentLoop] Stream complete — content=${content.length}chars, tool_calls=${tool_calls.length}`);

  return { content, tool_calls, usage };
}

// ── LLM Call with Tools (Non-Streaming) ─────────────────────────────────────

/**
 * Call LLM with function-calling tools (non-streaming fallback).
 * Returns the parsed assistant message including any tool_calls.
 */
async function callLLMWithTools(messages, tools, { signal, provider = AGENT_CHAT_PROVIDER, model = AGENT_CHAT_MODEL } = {}) {
  // Try Edge Function (ai-proxy) first
  if (USE_EDGE_AI_PROXY) {
    try {
      const toolsMode = provider === 'openai' ? 'openai_chat_tools'
        : provider === 'anthropic' ? 'anthropic_chat_tools'
        : 'deepseek_chat_tools';
      console.info(`[agentLoop] Calling LLM (${toolsMode}, model=${model}) with ${tools.length} tools:`, tools.map(t => t.function?.name));
      const result = await invokeAiProxy(toolsMode, {
        messages,
        tools,
        model,
        temperature: 0.3, // Lower temperature for tool calls — more deterministic
        maxOutputTokens: 4096,
      }, { signal });

      console.info('[agentLoop] LLM raw response keys:', Object.keys(result || {}));
      console.info('[agentLoop] LLM choices[0].message:', JSON.stringify(result?.choices?.[0]?.message || result?.text || '(no choices)').slice(0, 500));

      // The ai-proxy should return the full OpenAI-format response
      if (result?.choices?.[0]?.message) {
        const msg = result.choices[0].message;
        console.info('[agentLoop] tool_calls in response:', msg.tool_calls?.length ?? 0, msg.tool_calls ? JSON.stringify(msg.tool_calls).slice(0, 300) : '');
        return {
          ...msg,
          usage: result.usage,
        };
      }
      // Fallback: ai-proxy returned text only
      if (result?.text) {
        console.warn('[agentLoop] ai-proxy returned text-only (no choices). text:', result.text.slice(0, 200));
        return { content: result.text, tool_calls: [], usage: result.usage };
      }

      throw new Error('Unexpected ai-proxy response format');
    } catch (err) {
      // NO FALLBACK: surface the error
      throw err;
    }
  }

  throw new Error('[callLLMWithTools] USE_EDGE_AI_PROXY is off and no direct API fallback is enabled.');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Check if the LLM's text response indicates it *intended* to call a tool
 * but didn't actually invoke one (e.g., "I'll query the data now", "讓我查詢").
 */
function looksLikeToolIntent(text) {
  if (!text || typeof text !== 'string') return false;
  const patterns = [
    /正在查詢|我先查詢|讓我查|幫你查|我來查|先查一下/,
    /let me (query|check|look up|run|fetch|search)/i,
    /i('ll| will) (query|check|look up|run|fetch|search)/i,
    /querying|looking up|searching|fetching/i,
  ];
  return patterns.some((re) => re.test(text));
}

/**
 * Extract an embedded tool call from LLM text output.
 * Some models output tool calls as JSON in text instead of structured tool_calls.
 * Matches patterns like: {"tool":"query_sap_data","arguments":{...}}
 */
function extractEmbeddedToolCall(text, tools) {
  if (!text || typeof text !== 'string') return null;

  // Build a set of valid tool names for validation
  const validNames = new Set(tools.map((t) => t.function?.name).filter(Boolean));

  // Pattern 1: {"tool":"name","arguments":{...}}
  const toolJsonPattern = /\{[^{}]*"tool"\s*:\s*"([^"]+)"[^{}]*"arguments"\s*:\s*(\{[^]*?\})\s*\}/;
  const match1 = text.match(toolJsonPattern);
  if (match1) {
    const name = match1[1];
    if (validNames.has(name)) {
      try {
        const args = JSON.parse(match1[2]);
        const preamble = text.slice(0, match1.index).trim();
        return { name, args, preamble };
      } catch { /* parse failed, try next pattern */ }
    }
  }

  // Pattern 2: function call notation — query_sap_data({"sql":"..."})
  const funcPattern = /([a-z_]+)\s*\(\s*(\{[^]*?\})\s*\)/;
  const match2 = text.match(funcPattern);
  if (match2) {
    const name = match2[1];
    if (validNames.has(name)) {
      try {
        const args = JSON.parse(match2[2]);
        const preamble = text.slice(0, match2.index).trim();
        return { name, args, preamble };
      } catch { /* parse failed */ }
    }
  }

  return null;
}

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
function summarizeToolResult(result, maxItems = 20, maxDepth = 5) {
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
  // NOTE: \b does NOT work with CJK characters — use separate patterns for Chinese
  const strongSignals = [
    /\b(run|execute|generate|compute|analyze|forecast|plan|simulate)\b/i,
    /\b(what.?if|scenario|risk|negotiate|cost|revenue|bom|closed.?loop|supply)\b/i,
    /\b(SELECT|SQL|query|sap|master\s*data)\b/i,
    /\btop\s*\d+/i,
    // Chinese signals (no \b — word boundaries don't work with CJK)
    /(比較|預測|計畫|分析|模擬|執行|產生)/,
    /(幫我|請|跑一下|做一個|建立|檢查)/,
    /(客戶|訂單|產品|賣家|付款|查詢|有哪些|列出|多少|統計|哪個)/,
    /(供應商|物料|庫存|採購單|收貨|評論)/,
  ];

  return strongSignals.some((re) => re.test(lower));
}

function formatAnswerContractForPrompt(answerContract) {
  if (!answerContract || typeof answerContract !== 'object') return '';

  const requiredDimensions = Array.isArray(answerContract.required_dimensions) && answerContract.required_dimensions.length > 0
    ? answerContract.required_dimensions.join(', ')
    : 'none specified';
  const requiredOutputs = Array.isArray(answerContract.required_outputs) && answerContract.required_outputs.length > 0
    ? answerContract.required_outputs.join(', ')
    : 'none specified';

  return [
    'Answer Contract:',
    `- Task type: ${answerContract.task_type || 'mixed'}`,
    `- Required dimensions: ${requiredDimensions}`,
    `- Required outputs: ${requiredOutputs}`,
    `- Audience language: ${answerContract.audience_language || 'same as user'}`,
    '- Explicitly cover every required dimension that the evidence supports.',
  ].join('\n');
}
