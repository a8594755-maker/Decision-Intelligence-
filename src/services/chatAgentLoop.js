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
import { getModelConfig } from './modelConfigService.js';
import { detectRequestedSpecialChart, getStructuredAnswerCoverage } from './agentAnswerCoverageService.js';
import { buildEnrichedSchemaPrompt } from './sapDataQueryService.js';

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_AGENT_ITERATIONS = 8; // Prevent infinite loops
const AGENT_TIMEOUT_MS = 300_000; // 5 minutes total for the full agent loop
const DEEPSEEK_BASE_URL = String(import.meta.env.VITE_DI_DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const DEEPSEEK_CHAT_MODEL = import.meta.env.VITE_DI_DEEPSEEK_MODEL || 'deepseek-chat';
const USE_EDGE_AI_PROXY = true;

// ── DuckDB dialect guidance (shared between all prompt modes) ────────────────
const DUCKDB_DIALECT_PROMPT = [
  'query_sap_data SQL Dialect — DuckDB (PostgreSQL-compatible, in-browser WASM):',
  '- CTEs (WITH ... AS) fully supported — use them for readability',
  '- Window functions supported: ROW_NUMBER(), RANK(), DENSE_RANK(), NTILE(), LAG(), LEAD() with OVER(PARTITION BY ... ORDER BY ...)',
  '- Date functions: DATE_TRUNC(part, col), EXTRACT(part FROM col), col + INTERVAL, DATEDIFF(part, start, end)',
  '- Date arithmetic: use (date1 - date2) for intervals, DATEDIFF(\'day\', start, end) for integer days. Do NOT use JULIANDAY(), TIMESTAMPDIFF(), or any SQLite/MySQL-only date functions.',
  '- Date casting: DATE(col) to cast to date, STRFTIME(col, format) for formatting, EPOCH(col) for unix timestamp',
  '- Advanced aggregates: PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY col), MEDIAN(col), MODE(col), QUANTILE_DISC(0.9 ORDER BY col)',
  '- String: STRING_AGG(col, sep), REGEXP_MATCHES(), CONCAT()',
  '- Avoid reserved word aliases: "order", "group", "key", "value" → use descriptive names like "order_count"',
  '- Standard SQL: COUNT, SUM, AVG, MIN, MAX, ROUND, CASE WHEN, UNION ALL, HAVING, DISTINCT, LIKE, CROSS JOIN',
  '',
  'Available tables and column semantics (read column descriptions carefully to avoid wrong aggregations):',
  buildEnrichedSchemaPrompt(),
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
  if (provider === 'gemini') return 'gemini_chat_tools_stream';
  if (provider === 'deepseek') return 'deepseek_chat_tools_stream';
  return null;
}

export function getAgentToolMode(provider) {
  if (provider === 'openai') return 'openai_chat_tools';
  if (provider === 'anthropic') return 'anthropic_chat_tools';
  if (provider === 'gemini') return 'gemini_chat_tools';
  return 'deepseek_chat_tools';
}

export function getAgentProviderTransport(provider) {
  return provider === 'gemini' ? 'compat' : 'native';
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
  agentProvider = getModelConfig('primary').provider,
  agentModel = getModelConfig('primary').model,
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
        '- After generate_chart succeeds: the card already shows title, metrics, highlights, and chart. Do NOT repeat them in full. Only add a short (2-4 sentence) business insight or actionable recommendation that is NOT already in the card. **Exception**: for histogram+quantile requests, always state the core cut-point values (P25, P50, P75, P90) explicitly in your final answer, even if the chart card already shows them. If there is nothing else to add, just say "已產出圖表" or similar.',
        '- If a successful chart or analysis artifact already covers the answer contract, stop there. Do NOT call query_sap_data just to restate the same numbers.',
        '- A successful query_sap_data call with 0 rows is not a tool failure, but it provides ZERO evidence. Do NOT cite any numbers, statistics, or counts from a 0-row query. If another tool (e.g. generate_chart) provided data, attribute findings to that source only.',
        '- You may retry query_sap_data ONCE after a 0-row result. The retry must stay in the same dataset and only relax filters or fix joins. Do NOT silently switch datasets.',
        '- Never claim a SQL, worker, connection, or tool failure unless the execution trace actually contains a failed tool call.',
        '- After other tools return results, summarize the key findings clearly and concisely.',
        '- If query_sap_data fails before all required dimensions are covered, switch to run_python_analysis instead of ending with a partial answer.',
        '- If a tool fails, explain the error and suggest a narrower follow-up analysis.',
        '- Always respond in the same language the user used.',
        '',
        DUCKDB_DIALECT_PROMPT,
        '',
        '- CRITICAL DATE RANGE: Olist e-commerce data covers 2016-09 to 2018-10. When filtering by date, use dates within this range. Using 2024/2025/2026 dates in WHERE clauses will return 0 rows.',
        '- Dataset B tables (suppliers, materials, inventory_snapshots, po_open_lines, goods_receipts) may have 0 rows. Prefer Dataset A (Olist CSV tables) unless the user specifically asks about operational/supply chain data.',
        '',
        'Data Enrichment Rules:',
        '- When reporting metrics, always include both absolute and relative forms: alongside "revenue = R$50K", state "which is 3.2% of total" or "0.7x the category average". Use SQL evidence to compute ratios.',
        '- Before making recommendations based on historical averages, run at least one query grouping by time period. If the metric is growing or declining >10% across periods, note the trend and adjust the recommendation.',
        '- For SQL queries returning aggregated metrics, also query relative context (% of total, rank within category, vs overall average) in the same or follow-up query.',
        '',
        'Final Answer Rules:',
        '- You are a senior analyst. Write only the useful user-facing interpretation.',
        '- Keep the final answer under 500 words. Cover all requested dimensions with specific numbers, category-level breakdowns, and data-backed recommendations. Be thorough but not redundant with chart/table artifacts.',
        '- Do NOT output markdown tables, pseudo-tables, SQL, debug logs, tool transcripts, "thinking", or step-by-step execution details.',
        '- Do NOT list every tool you called. The UI renders execution trace separately.',
        '- For histogram-plus-quantiles requests, explicitly mention the core cut points P25, P50, P75, and P90 (or P95 if P90 is unavailable) when the evidence contains them.',
        '- Focus on concise interpretation, caveats, and the next best action.',
        '',
        answerContractBlock,
        recipeIndex,
      ]
    : [
        '- When the user asks about data (customers, orders, products, sellers, payments, etc.), ALWAYS call query_sap_data with a SQL query. NEVER just describe SQL — execute it.',
        '- You may retry query_sap_data ONCE after a 0-row result or SQL error, but the retry must stay in the same dataset and only relax filters or fix joins. Do NOT use test queries like "SELECT 1".',
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
  let coverageStopInstructionInjected = false;

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
      let pendingChunks = '';
      let flushTimer = null;
      const FLUSH_INTERVAL_MS = 200;

      const flushPending = () => {
        if (pendingChunks) {
          const flushed = pendingChunks;
          pendingChunks = '';
          onThinking?.({ step: i + 1, type: 'preamble', content: flushed, fullContent: thinkingBuffer });
        }
        flushTimer = null;
      };

      response = await callLLMWithToolsStream(messages, tools, {
        signal,
        provider: agentProvider,
        model: agentModel,
        onPreambleChunk: (chunk) => {
          thinkingBuffer += chunk;
          pendingChunks += chunk;
          if (!flushTimer) {
            flushTimer = setTimeout(flushPending, FLUSH_INTERVAL_MS);
          }
        },
      });
      // Flush any remaining buffered chunks after stream completes
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      flushPending();
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
          cacheHitTokens: response.usage?.prompt_cache_hit_tokens,
          cacheMissTokens: response.usage?.prompt_cache_miss_tokens,
        });
        break;
      }
    }

    // Case 2: LLM wants to call tools → execute them
    // First, append the assistant message with tool_calls to the conversation
    // Note: DeepSeek requires reasoning_content to be passed back in multi-turn tool calling
    const assistantMsg = {
      role: 'assistant',
      content: response.content || null,
      tool_calls: response.tool_calls,
    };
    if (response.reasoning_content) {
      assistantMsg.reasoning_content = response.reasoning_content;
    }
    messages.push(assistantMsg);

    // Stream any text that came with the tool call (e.g., "Let me run the forecast...")
    // Keep it out of the persisted final answer.
    if (response.content) {
      onTextChunk?.(response.content + '\n\n');
    }

    // Execute each tool call.
    // IMPORTANT: OpenAI requires ALL tool response messages to appear consecutively
    // after the assistant message with tool_calls. Any non-tool message (e.g. user
    // guidance) injected between tool responses causes a 400 error. So we collect
    // tool responses and deferred guidance messages separately, push all tool
    // responses first, then push guidance messages.
    const toolResponses = []; // { role: 'tool', tool_call_id, content }
    const deferredGuidance = []; // { role: 'user', content } — pushed after all tool responses
    let earlyReturn = null; // set if gap detection wants to return early

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
      if (!earlyReturn && !toolResult.success && i < MAX_AGENT_ITERATIONS - 2 && onToolBlueprint) {
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
            earlyReturn = {
              text: finalText || '',
              toolCalls,
              iterations: totalIterations,
              isAgentResponse: true,
              blueprint,
              gap,
            };
            // Don't return yet — finish pushing all tool responses first
          } catch (blueprintErr) {
            console.warn('[agentLoop] Blueprint generation failed:', blueprintErr?.message);
          }
        }
      }

      // Collect the tool response (pushed to messages after the loop)
      const resultContent = toolResult.success
        ? JSON.stringify(summarizeToolResult(toolResult.result), null, 2)
        : JSON.stringify({ error: toolResult.error });

      toolResponses.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: resultContent,
      });

      const rowCount = toolName === 'query_sap_data'
        ? Number.isFinite(toolResult?.result?.rowCount)
          ? toolResult.result.rowCount
          : (Array.isArray(toolResult?.result?.rows) ? toolResult.result.rows.length : null)
        : null;
      const zeroRowQueryAttempts = toolCalls.filter((call) => {
        if (call?.name !== 'query_sap_data' || !call?.result?.success) return false;
        const callRowCount = Number.isFinite(call?.result?.result?.rowCount)
          ? call.result.result.rowCount
          : (Array.isArray(call?.result?.result?.rows) ? call.result.result.rows.length : null);
        return callRowCount === 0;
      }).length;

      // Collect deferred guidance messages (pushed after all tool responses)
      if (toolName === 'query_sap_data' && toolResult.success && rowCount === 0) {
        const sqlText = toolArgs.sql || '';
        const tablesMentioned = Array.from(new Set((sqlText.match(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi) || [])
          .map((fragment) => fragment.replace(/\b(?:FROM|JOIN)\s+/i, '').trim())
          .filter(Boolean)));
        const mentionsModernDate = /202[3-9]|203\d/.test(sqlText);
        const dateHint = mentionsModernDate
          ? ' The SQL filters on dates outside the Olist data range (2016-09 to 2018-10). Rewrite it with dates in range.'
          : '';
        const tableHint = tablesMentioned.length > 0
          ? ` Stay in the same dataset and keep using these tables only: ${tablesMentioned.join(', ')}.`
          : ' Stay in the same dataset; do not silently switch tables from another dataset.';

        deferredGuidance.push({
          role: 'user',
          content: zeroRowQueryAttempts <= 1
            ? `The SQL returned 0 rows / no evidence.${dateHint}${tableHint} Retry query_sap_data once by loosening filters or fixing joins. Do NOT cite numbers from this empty result.`
            : `The SQL has already returned 0 rows after the allowed retry.${dateHint}${tableHint} Stop retrying, do NOT cite numbers from these empty results, and explain that no SQL evidence was found in this dataset.`,
        });
      }

      if (isAnalysisMode) {
        const coverageStatus = getStructuredCoverageStatus(answerContract, toolCalls, message);
        const unmetDimensions = getUnmetCoreDimensions(answerContract, toolCalls, message);
        const unmetStructuredOutputs = getUnmetStructuredOutputs(answerContract, toolCalls, message);

        if (toolName === 'query_sap_data' && toolResult.success && rowCount === 0) {
          const pendingCoverage = [...unmetDimensions, ...unmetStructuredOutputs];
          deferredGuidance.push({
            role: 'user',
            content: pendingCoverage.length > 0
              ? zeroRowQueryAttempts <= 1
                ? `The SQL returned 0 rows and these dimensions are still unmet: ${pendingCoverage.join(', ')}. Retry the SQL once in the same dataset first. If the retry is also empty, use run_python_analysis or provide a caveat instead of inventing numbers.`
                : `The SQL retry also returned 0 rows and these dimensions remain unmet: ${pendingCoverage.join(', ')}. Do NOT invent numbers. Use run_python_analysis next or give a caveated answer.`
              : 'The SQL returned 0 rows, but the required analysis may already be covered by successful artifacts. Use existing evidence and write the final answer now.',
          });
        }

        if (!coverageStopInstructionInjected && unmetDimensions.length === 0 && unmetStructuredOutputs.length === 0) {
          coverageStopInstructionInjected = true;
          const coveredDimensionsText = coverageStatus.coverage.coveredDimensions.join(', ') || 'none';
          const coveredOutputsText = coverageStatus.coverage.coveredOutputs.join(', ') || 'none';
          deferredGuidance.push({
            role: 'user',
            content: `Coverage rule: the existing successful artifacts already cover all required dimensions and structured outputs. Covered dimensions: ${coveredDimensionsText}. Covered outputs: ${coveredOutputsText}. Do NOT call query_sap_data or other retrieval tools again just to restate the same numbers. Use the current chart/artifact as the source of truth and write the final answer now.`,
          });
        }
      }

      if (isAnalysisMode && toolName === 'query_sap_data' && !toolResult.success) {
        const unmetDimensions = getUnmetCoreDimensions(answerContract, toolCalls, message);
        if (unmetDimensions.length > 0) {
          deferredGuidance.push({
            role: 'user',
            content: `Recovery rule: the SQL attempt failed and these required dimensions are still unmet: ${unmetDimensions.join(', ')}. Do NOT stop at the SQL error. Use run_python_analysis next to recover the missing analysis if possible. Only give a caveated final answer if that alternative also fails.`,
          });
        }
      }

      // ── Default mode: 0-row self-healing guidance ─────────────────────
      if (!isAnalysisMode && toolName === 'query_sap_data' && toolResult.success) {
        const defRowCount = toolResult.result?.rowCount ?? (Array.isArray(toolResult.result?.rows) ? toolResult.result.rows.length : null);
        if (defRowCount === 0) {
          const sqlText = toolArgs.sql || '';
          const mentionsModernDate = /202[3-9]|203\d/.test(sqlText);
          const dateHint = mentionsModernDate
            ? ' Your SQL filters on dates outside the data range (2016-09 to 2018-10). Rewrite with dates in that range.'
            : ' The table may be empty or WHERE conditions too restrictive. Try removing filters or querying a different table.';
          deferredGuidance.push({
            role: 'user',
            content: `query_sap_data returned 0 rows.${dateHint} Try a corrected query before giving a final answer.`,
          });
        }
      }

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

      if (consecutiveFailures.count >= 2) {
        deferredGuidance.push({
          role: 'user',
          content: `⚠️ ${consecutiveFailures.lastToolName} has failed ${consecutiveFailures.count} times in a row. Do NOT retry with similar parameters. Either use a completely different approach (e.g., generate_chart recipe, run_python_analysis) or provide your final answer with the data you already have.`,
        });
      }
    }

    // Push all tool responses first (OpenAI requires these to be contiguous)
    for (const tr of toolResponses) {
      messages.push(tr);
    }
    // Then push any deferred guidance messages
    for (const gm of deferredGuidance) {
      messages.push(gm);
    }

    // Handle early return from gap detection (after tool responses are properly pushed)
    if (earlyReturn) {
      return earlyReturn;
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
      cacheHitTokens: response.usage?.prompt_cache_hit_tokens,
      cacheMissTokens: response.usage?.prompt_cache_miss_tokens,
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
    transport: getAgentProviderTransport(agentProvider),
  };
}

// ── LLM Call with Tools (Streaming) ─────────────────────────────────────────

/**
 * Call LLM with tools via SSE streaming.
 * Streams thinking/preamble content in real-time via onPreambleChunk callback.
 * Returns the same shape as callLLMWithTools: { content, tool_calls, usage }.
 */
async function callLLMWithToolsStream(messages, tools, { signal, onPreambleChunk, provider = getModelConfig('primary').provider, model = getModelConfig('primary').model } = {}) {
  const toolsMode = getAgentToolStreamingMode(provider);

  if (!toolsMode) {
    // Providers without a streaming tool path fall back to non-streaming.
    return callLLMWithTools(messages, tools, { signal, provider, model });
  }

  let content = '';
  let reasoningContent = '';
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

      // DeepSeek reasoning_content — chain-of-thought thinking tokens
      if (delta.reasoning_content) {
        reasoningContent += delta.reasoning_content;
        onPreambleChunk?.(delta.reasoning_content);
      }

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

  // Guard: if streaming dropped a tool_call id, assign a synthetic one to prevent
  // OpenAI "tool_calls must be followed by tool messages" errors downstream.
  for (let idx = 0; idx < tool_calls.length; idx++) {
    if (!tool_calls[idx].id) {
      tool_calls[idx].id = `call_synthetic_${idx}_${Date.now()}`;
      console.warn(`[agentLoop] Streaming dropped tool_call id at index ${idx}, assigned synthetic id: ${tool_calls[idx].id}`);
    }
  }

  console.info(`[agentLoop] Stream complete — content=${content.length}chars, reasoning=${reasoningContent.length}chars, tool_calls=${tool_calls.length}`);

  return {
    content,
    tool_calls,
    usage,
    reasoning_content: reasoningContent || undefined,
    transport: getAgentProviderTransport(provider),
  };
}

// ── LLM Call with Tools (Non-Streaming) ─────────────────────────────────────

/**
 * Call LLM with function-calling tools (non-streaming fallback).
 * Returns the parsed assistant message including any tool_calls.
 */
async function callLLMWithTools(messages, tools, { signal, provider = getModelConfig('primary').provider, model = getModelConfig('primary').model } = {}) {
  // Try Edge Function (ai-proxy) first
  if (USE_EDGE_AI_PROXY) {
    const toolsMode = getAgentToolMode(provider);
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
        transport: result.transport || getAgentProviderTransport(provider),
      };
    }
    // Fallback: ai-proxy returned text only
    if (result?.text) {
      console.warn('[agentLoop] ai-proxy returned text-only (no choices). text:', result.text.slice(0, 200));
      return {
        content: result.text,
        tool_calls: [],
        usage: result.usage,
        transport: result.transport || getAgentProviderTransport(provider),
      };
    }

    throw new Error('Unexpected ai-proxy response format');
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
/**
 * Determine whether a message should use agent mode (with tool access).
 *
 * Design: default to agent mode (true). Only trivial messages that clearly
 * need no tools are excluded. This avoids the keyword-whack-a-mole problem
 * where valid analytical questions fall through because a keyword was missing.
 */
export function shouldUseAgentMode(message) {
  if (!message || typeof message !== 'string') return false;
  const normalized = message.trim();

  // Very short messages (≤4 chars) are almost always greetings
  if (normalized.length <= 4) return false;

  // Explicit plain-chat patterns: greetings, meta, identity questions
  const plainChatOnly = [
    /^(hi|hello|hey|yo|sup|thanks|thank you|ok|okay|sure|got it|good|nice|cool)\s*[.!?]?$/i,
    /^(你好|嗨|哈囉|謝謝|好的|了解|收到|知道了|不錯|可以)\s*[.!?]?$/,
    /\b(who\s+are\s+you|what\s+are\s+you|your\s+name)\b/i,
    /(你是誰|你叫什麼)/,
  ];

  if (plainChatOnly.some((re) => re.test(normalized))) return false;

  // Everything else gets agent mode — let the LLM decide if it needs tools
  return true;
}

function getStructuredCoverageStatus(answerContract, toolCalls = [], userMessage = '') {
  const requestedChart = detectRequestedSpecialChart(userMessage);
  const coverage = getStructuredAnswerCoverage({
    toolCalls,
    requestedChart,
    userMessage,
  });
  const coveredDimensions = new Set((coverage.coveredDimensions || []).map((dimension) => String(dimension || '').toLowerCase()));
  const coveredOutputs = new Set((coverage.coveredOutputs || []).map((output) => String(output || '').toLowerCase()));

  return {
    requestedChart,
    coverage,
    coveredDimensions,
    coveredOutputs,
  };
}

function isQuantilesDimensionCovered(coverageStatus) {
  const quantileCoverage = coverageStatus?.coverage?.quantileCoverage || {};
  const hasCoreQuantiles = Boolean(
    quantileCoverage.p25
    && quantileCoverage.p50
    && quantileCoverage.p75
    && (quantileCoverage.p90 || quantileCoverage.p95)
  );

  if (coverageStatus?.requestedChart === 'histogram') {
    return hasCoreQuantiles && Boolean(coverageStatus?.coverage?.hasHistogramQuantileAnnotations);
  }

  return hasCoreQuantiles;
}

export function getUnmetCoreDimensions(answerContract, toolCalls = [], userMessage = '') {
  const requiredDimensions = Array.isArray(answerContract?.required_dimensions)
    ? answerContract.required_dimensions.filter(Boolean)
    : [];
  if (requiredDimensions.length === 0) return [];

  const coverageStatus = getStructuredCoverageStatus(answerContract, toolCalls, userMessage);
  const { coveredDimensions } = coverageStatus;

  return requiredDimensions.filter((dimension) => {
    const normalized = String(dimension || '').trim().toLowerCase();
    if (/quantiles?|percentiles?/.test(normalized)) {
      return !isQuantilesDimensionCovered(coverageStatus);
    }
    return !coveredDimensions.has(normalized);
  });
}

export function getUnmetStructuredOutputs(answerContract, toolCalls = [], userMessage = '') {
  const requiredOutputs = Array.isArray(answerContract?.required_outputs)
    ? answerContract.required_outputs.filter((output) => ['chart', 'table'].includes(String(output || '').trim().toLowerCase()))
    : [];
  if (requiredOutputs.length === 0) return [];

  const { coveredOutputs } = getStructuredCoverageStatus(answerContract, toolCalls, userMessage);
  return requiredOutputs.filter((output) => !coveredOutputs.has(String(output || '').trim().toLowerCase()));
}

export function shouldStopAfterStructuredCoverage(answerContract, toolCalls = [], userMessage = '') {
  return (
    getUnmetCoreDimensions(answerContract, toolCalls, userMessage).length === 0
    && getUnmetStructuredOutputs(answerContract, toolCalls, userMessage).length === 0
  );
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
