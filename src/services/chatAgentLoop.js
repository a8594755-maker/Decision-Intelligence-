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
import { getRecipeIndexForPrompt, findRecipeByUserMessage } from './chartRecipeCatalog.js';
import { getModelConfig, resolveProviderFromModel } from './modelConfigService.js';
import { addDimensionHits, detectRequestedSpecialChart, getStructuredAnswerCoverage } from './agentAnswerCoverageService.js';
import { buildEnrichedSchemaPrompt } from './sapDataQueryService.js';
import { detectDomain, buildDomainEnrichmentPrompt, buildParameterSweepInstruction, isParameterOptimizationQuestion } from './analysisDomainEnrichment.js';
import { validateQueryResultData, formatWarningsForAgent, detectBusinessContext, PROXY_DISCLOSURE_PROMPT } from './preAnalysisDataValidator.js';
import { buildUserDatasetDigest, inferCrossSheetRelationships } from './datasetProfilingService.js';
import { selectRelevantContext } from './datasetContextSelector.js';
import {
  recallQueryPatterns,
  writeQueryPattern,
  writeFailurePattern,
  recallFailurePatterns,
  attachFailureResolution,
  classifyToolError,
  failureDedupeKey,
} from './aiEmployeeMemoryService.js';
import { classifyQueryIntent } from './queryIntentClassifier.js';
import { buildQueryPlan, formatQueryPlanForPrompt } from './queryPlannerService.js';

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_AGENT_ITERATIONS_BASE = 8; // Base iteration budget

/**
 * Dynamically resolve max iterations based on answer contract complexity.
 * More required dimensions/outputs → higher budget (up to 12).
 */
function resolveMaxIterations(answerContract) {
  const dims = Array.isArray(answerContract?.required_dimensions) ? answerContract.required_dimensions.length : 0;
  const outputs = Array.isArray(answerContract?.required_outputs) ? answerContract.required_outputs.length : 0;
  const bonus = Math.min(4, Math.floor((dims + outputs) / 2));
  return MAX_AGENT_ITERATIONS_BASE + bonus;
}

/**
 * Build a lightweight step outline injected into the system prompt.
 * Not mandatory — just a suggested path to help the agent avoid suboptimal tool sequencing.
 */
function buildStepOutline(answerContract, userMessage) {
  const dims = Array.isArray(answerContract?.required_dimensions) ? answerContract.required_dimensions : [];
  const outputs = Array.isArray(answerContract?.required_outputs) ? answerContract.required_outputs : [];
  if (dims.length === 0 && outputs.length === 0) return '';

  const steps = [];
  const recipeMatch = userMessage ? findRecipeByUserMessage(userMessage) : null;

  // Step 1: if a recipe matches, start with generate_chart
  if (recipeMatch) {
    const coveredText = recipeMatch.coveredDimensions.length > 0
      ? ` — covers: ${recipeMatch.coveredDimensions.join(', ')}`
      : '';
    steps.push(`1. generate_chart("${recipeMatch.id}")${coveredText}`);
  }

  // Step 2: uncovered dimensions → query_sap_data or run_python_analysis
  const coveredByRecipe = new Set(recipeMatch?.coveredDimensions || []);
  const uncovered = dims.filter(d => !coveredByRecipe.has(d.toLowerCase()));
  if (uncovered.length > 0) {
    steps.push(`${steps.length + 1}. query_sap_data or run_python_analysis — remaining dimensions: ${uncovered.join(', ')}`);
  }

  // Step 3: custom computation for complex outputs
  const needsComputation = outputs.some(o => ['comparison', 'diagnostic', 'recommendation'].includes(o));
  if (needsComputation && !uncovered.length) {
    steps.push(`${steps.length + 1}. run_python_analysis — custom computation for ${outputs.join(', ')}`);
  }

  // Cross-verification step for multi-dimension requests
  if (steps.length >= 2 || dims.length >= 2 || outputs.length >= 2) {
    steps.push(`${steps.length + 1}. Cross-verify: run a quick SQL or Python check to confirm key numbers from prior steps`);
  }

  if (steps.length === 0) return '';
  return [
    '',
    'Suggested step outline (not mandatory, adapt as needed):',
    ...steps,
    '',
  ].join('\n');
}
const AGENT_TIMEOUT_MS = 300_000; // 5 minutes total for the full agent loop
const DEEPSEEK_BASE_URL = String(import.meta.env.VITE_DI_DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const DEEPSEEK_CHAT_MODEL = import.meta.env.VITE_DI_DEEPSEEK_MODEL || 'deepseek-chat';
const USE_EDGE_AI_PROXY = true;

// ── DuckDB dialect guidance (shared between all prompt modes) ────────────────
const DUCKDB_DIALECT_CORE = [
  'query_sap_data SQL Dialect — DuckDB (PostgreSQL-compatible, in-browser WASM):',
  '- CTEs (WITH ... AS) fully supported — use them for readability',
  '- Window functions supported: ROW_NUMBER(), RANK(), DENSE_RANK(), NTILE(), LAG(), LEAD() with OVER(PARTITION BY ... ORDER BY ...)',
  '- Window functions cannot be nested. Do NOT place a window function inside another window/aggregate expression, e.g. `SUM(x / SUM(x) OVER ()) OVER (...)`.',
  '- For cumulative share / Pareto logic, stage the computation across CTEs: first compute totals or shares in one SELECT, then compute the running cumulative sum in an outer SELECT.',
  '- Date functions: DATE_TRUNC(part, col), EXTRACT(part FROM col), col + INTERVAL, DATEDIFF(part, start, end)',
  '- Date arithmetic: use (date1 - date2) for intervals, DATEDIFF(\'day\', start, end) for integer days. Do NOT use JULIANDAY(), TIMESTAMPDIFF(), or any SQLite/MySQL-only date functions.',
  '- Date casting: DATE(col) to cast to date, STRFTIME(col, format) for formatting, EPOCH(col) for unix timestamp',
  '- Advanced aggregates: PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY col), MEDIAN(col), MODE(col), QUANTILE_DISC(0.9 ORDER BY col)',
  '- String: STRING_AGG(col, sep), REGEXP_MATCHES(), CONCAT()',
  '- Avoid reserved word aliases: "order", "group", "key", "value" → use descriptive names like "order_count"',
  '- Standard SQL: COUNT, SUM, AVG, MIN, MAX, ROUND, CASE WHEN, UNION ALL, HAVING, DISTINCT, LIKE, CROSS JOIN',
  '- LATERAL JOIN does NOT support aggregate functions (COUNT, SUM, AVG, etc.) — rewrite as CTE with GROUP BY instead',
  '',
  'TIME AGGREGATION GUARD:',
  '- When computing "monthly", "per month", "月均", or any periodic metric, ALWAYS use DATE_TRUNC(\'month\', timestamp_col) in GROUP BY or as a denominator.',
  '- A bare SUM() across a multi-month dataset will be Nx the actual monthly value. Never present an all-time SUM as a monthly figure.',
  '- For monthly averages, use: SUM(val) / COUNT(DISTINCT DATE_TRUNC(\'month\', date_col)).',
];

const DUCKDB_OLIST_ADDENDUM = [
  '',
  'Available tables and column semantics (read column descriptions carefully to avoid wrong aggregations):',
  buildEnrichedSchemaPrompt(),
];

function buildDuckDbDialectPrompt({ hasUserData = false } = {}) {
  if (hasUserData) return DUCKDB_DIALECT_CORE.join('\n');
  return [...DUCKDB_DIALECT_CORE, ...DUCKDB_OLIST_ADDENDUM].join('\n');
}

// Legacy compat: module-level const for non-conditional usage
const DUCKDB_DIALECT_PROMPT = buildDuckDbDialectPrompt({ hasUserData: false });

export const ANALYSIS_AGENT_TOOL_IDS = Object.freeze([
  'query_sap_data',
  'list_sap_tables',
  'run_python_analysis',
  'generate_chart',
  'generate_analysis_workbook',
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

// ── Centralized Provider Registry ────────────────────────────────────────────
// Single source of truth for provider→mode mapping.
// To add a new provider, add ONE entry here instead of updating 3+ if-else chains.
const PROVIDER_REGISTRY = {
  openai:    { toolMode: 'openai_chat_tools',    streamMode: 'openai_chat_tools_stream',    transport: 'native', supportsRequiredToolChoiceWithThinking: true },
  anthropic: { toolMode: 'anthropic_chat_tools', streamMode: 'anthropic_chat_tools_stream', transport: 'native', supportsRequiredToolChoiceWithThinking: true },
  gemini:    { toolMode: 'gemini_chat_tools',    streamMode: 'gemini_chat_tools_stream',    transport: 'compat', supportsRequiredToolChoiceWithThinking: false },
  deepseek:  { toolMode: 'deepseek_chat_tools',  streamMode: 'deepseek_chat_tools_stream',  transport: 'native', supportsRequiredToolChoiceWithThinking: true },
  kimi:      { toolMode: 'kimi_chat_tools',      streamMode: null,                          transport: 'native', supportsRequiredToolChoiceWithThinking: false },
};

export function getAgentToolStreamingMode(provider) {
  return PROVIDER_REGISTRY[provider]?.streamMode ?? null;
}

export function getAgentToolMode(provider) {
  const entry = PROVIDER_REGISTRY[provider];
  if (!entry) {
    console.warn(`[agentLoop] Unknown provider "${provider}", falling back to deepseek`);
    return PROVIDER_REGISTRY.deepseek.toolMode;
  }
  return entry.toolMode;
}

export function getAgentProviderTransport(provider) {
  return PROVIDER_REGISTRY[provider]?.transport ?? 'native';
}

function buildGeminiThinkingGoogleOptions() {
  return {
    thinkingConfig: {
      include_thoughts: true,
    },
  };
}

/**
 * Last-resort non-streaming call for Gemini/compat providers.
 * Drops thinkingConfig so tool_choice:"required" actually works.
 * Returns the parsed message or null if it still fails.
 */
async function callLLMWithToolsNoThinking(messages, tools, { signal, provider, model } = {}) {
  const toolsMode = getAgentToolMode(provider);
  console.info(`[agentLoop] Evidence recovery: calling ${toolsMode} WITHOUT thinkingConfig, toolChoice=required`);
  try {
    const result = await invokeAiProxy(toolsMode, {
      messages,
      tools,
      model,
      toolChoice: 'required',
      temperature: 0.2,
      maxOutputTokens: 4096,
      // Deliberately omitting googleOptions/thinkingConfig
    }, { signal });
    if (result?.choices?.[0]?.message) {
      const msg = result.choices[0].message;
      return {
        ...msg,
        usage: result.usage,
        transport: result.transport || getAgentProviderTransport(provider),
      };
    }
    return null;
  } catch (err) {
    console.warn('[agentLoop] Evidence recovery call failed:', err.message);
    return null;
  }
}

function isThinkingEnabledForToolChoice(provider) {
  // Kimi and Gemini send thinking config with tool calls.
  // Gemini's OpenAI-compat layer passes thinkingConfig via extra_body which
  // silently breaks tool_choice:"required" (returns prose, 0 reasoning chars).
  return provider === 'kimi' || provider === 'gemini';
}

function normalizeRequestedToolChoice(toolChoice) {
  return String(toolChoice || '').trim().toLowerCase() === 'required' ? 'required' : 'auto';
}

function normalizeToolChoiceForProvider(provider, requestedToolChoice, { model } = {}) {
  const normalizedRequested = normalizeRequestedToolChoice(requestedToolChoice);
  const providerConfig = PROVIDER_REGISTRY[provider];

  if (!providerConfig || normalizedRequested !== 'required') {
    return {
      requestedToolChoice: normalizedRequested,
      effectiveToolChoice: normalizedRequested,
      downgraded: false,
      reason: null,
    };
  }

  const thinkingEnabled = isThinkingEnabledForToolChoice(provider, model);
  const supportsRequiredToolChoice = thinkingEnabled
    ? providerConfig.supportsRequiredToolChoiceWithThinking !== false
    : providerConfig.supportsRequiredToolChoice !== false;

  if (supportsRequiredToolChoice) {
    return {
      requestedToolChoice: normalizedRequested,
      effectiveToolChoice: normalizedRequested,
      downgraded: false,
      reason: null,
    };
  }

  return {
    requestedToolChoice: normalizedRequested,
    effectiveToolChoice: 'auto',
    downgraded: true,
    reason: thinkingEnabled
      ? 'required_tool_choice_incompatible_with_thinking'
      : 'required_tool_choice_unsupported',
  };
}

function answerContractNeedsAnalysisEvidence(answerContract) {
  if (!answerContract || typeof answerContract !== 'object') return false;

  const requiredDimensions = Array.isArray(answerContract.required_dimensions)
    ? answerContract.required_dimensions.filter(Boolean)
    : [];
  const requiredOutputs = Array.isArray(answerContract.required_outputs)
    ? answerContract.required_outputs.filter(Boolean)
    : [];
  const taskType = String(answerContract.task_type || '').trim().toLowerCase();

  return (
    requiredDimensions.length > 0
    || requiredOutputs.length > 0
    || ['recommendation', 'comparison', 'diagnostic', 'ranking', 'trend', 'forecast'].includes(taskType)
  );
}

function buildForcedEvidenceInstruction(answerContract, attempt = 0) {
  const requiredDimensions = Array.isArray(answerContract?.required_dimensions) && answerContract.required_dimensions.length > 0
    ? answerContract.required_dimensions.join(', ')
    : 'the required analysis dimensions';
  const requiredOutputs = Array.isArray(answerContract?.required_outputs) && answerContract.required_outputs.length > 0
    ? answerContract.required_outputs.join(', ')
    : 'the required outputs';

  if (attempt >= 1) {
    // Escalated: be very explicit with a concrete example
    const sqlHint = buildSqlHintFromContract(answerContract);
    return [
      'You MUST respond with ONLY a function call. No prose. No explanation.',
      `Call query_sap_data now. Example: query_sap_data({"sql": "${sqlHint}"})`,
      'If query_sap_data is not available, call run_python_analysis or generate_chart instead.',
      'Emit the tool call and nothing else.',
    ].join(' ');
  }

  // Gentle first attempt
  return [
    'Evidence rule: your previous reply contained prose but no tool call.',
    'In analysis mode, you MUST gather evidence before giving the final answer.',
    'Call exactly one evidence-producing tool right now: query_sap_data, run_python_analysis, or generate_chart.',
    `Target these dimensions first: ${requiredDimensions}.`,
    `Target these outputs first: ${requiredOutputs}.`,
    'Do NOT answer in prose yet. Emit the tool call only.',
  ].join(' ');
}

function buildInitialEvidenceInstruction(answerContract, userMessage) {
  const requiredDimensions = Array.isArray(answerContract?.required_dimensions) && answerContract.required_dimensions.length > 0
    ? answerContract.required_dimensions.join(', ')
    : 'the required analysis dimensions';
  const requiredOutputs = Array.isArray(answerContract?.required_outputs) && answerContract.required_outputs.length > 0
    ? answerContract.required_outputs.join(', ')
    : 'the required outputs';

  // Check if a chart recipe matches — if so, hint the agent
  const recipeMatch = userMessage ? findRecipeByUserMessage(userMessage) : null;
  const recipeHint = recipeMatch
    ? ` A matching chart recipe exists: generate_chart({"recipe_id":"${recipeMatch.id}"}). Prefer this for fast, deterministic results.`
    : '';

  return [
    'Evidence-first rule: this task requires tool-backed evidence before any final answer.',
    `Call exactly one evidence-producing tool right now: query_sap_data, run_python_analysis, or generate_chart.${recipeHint}`,
    `Prioritize these dimensions first: ${requiredDimensions}.`,
    `Prioritize these outputs first: ${requiredOutputs}.`,
    'Do NOT answer in prose yet. Emit the tool call only.',
  ].join(' ');
}

function buildSqlHintFromContract(answerContract) {
  const dims = Array.isArray(answerContract?.required_dimensions) ? answerContract.required_dimensions : [];
  if (dims.length === 0) return 'SELECT * FROM orders LIMIT 20';
  const col = dims[0].replace(/[^a-zA-Z0-9_\u4e00-\u9fff]/g, '_').toLowerCase();
  return `SELECT ${col}, COUNT(*) as cnt FROM orders GROUP BY ${col} ORDER BY cnt DESC LIMIT 20`;
}

function suggestPrimaryTool(answerContract, tools, userMessage) {
  const toolNames = (tools || []).map((t) => t.function?.name).filter(Boolean);
  const outputs = Array.isArray(answerContract?.required_outputs) ? answerContract.required_outputs : [];

  // Recipe-aware: if a chart recipe matches the user message, prefer generate_chart
  if (userMessage && toolNames.includes('generate_chart')) {
    const recipeMatch = findRecipeByUserMessage(userMessage);
    if (recipeMatch) return `generate_chart (hint: recipe_id="${recipeMatch.id}")`;
  }

  if (outputs.includes('chart') && toolNames.includes('generate_chart')) return 'generate_chart';
  if (outputs.includes('workbook') && toolNames.includes('generate_analysis_workbook')) return 'generate_analysis_workbook';
  if (toolNames.includes('run_python_analysis') && outputs.some((o) => ['comparison', 'diagnostic', 'forecast'].includes(o))) return 'run_python_analysis';
  if (toolNames.includes('query_sap_data')) return 'query_sap_data';
  return toolNames[0] || 'query_sap_data';
}

function createAgentLoopError(category, message, options = {}) {
  const error = new Error(message);
  error.name = 'AgentLoopError';
  error.failureCategory = category;
  error.failureMessage = message;
  error.recoveryAttempts = Array.isArray(options.recoveryAttempts) ? [...options.recoveryAttempts] : [];
  error.provider = options.provider || null;
  error.model = options.model || null;
  error.transport = options.transport || null;
  return error;
}

function classifyAgentLoopError(error) {
  const message = String(error?.failureMessage || error?.message || error || '').trim();

  if (/engine.+overloaded|currently overloaded|provider.+overloaded|service.+overloaded|server.+busy/i.test(message)) {
    return 'provider_overloaded';
  }
  if (/unsupported provider|provider not available/i.test(message)) return 'provider_unsupported';
  if (/model not exist|model.+not found|unknown model|does not exist/i.test(message)) return 'model_not_found';
  if (/empty response|no text, no tool calls/i.test(message)) return 'empty_response';
  if (/no successful analysis evidence|missing evidence/i.test(message)) return 'missing_evidence';
  if (/tool transport|stream call failed|edge function|api service error|unexpected ai-proxy response format/i.test(message)) {
    return 'tool_transport_failed';
  }
  return 'tool_transport_failed';
}

function coerceAgentLoopError(error, fallbackCategory, options = {}) {
  if (error?.failureCategory) {
    if (Array.isArray(options.recoveryAttempts) && !error.recoveryAttempts?.length) {
      error.recoveryAttempts = [...options.recoveryAttempts];
    }
    if (options.provider && !error.provider) error.provider = options.provider;
    if (options.model && !error.model) error.model = options.model;
    if (options.transport && !error.transport) error.transport = options.transport;
    return error;
  }

  return createAgentLoopError(
    classifyAgentLoopError(error) || fallbackCategory,
    String(error?.message || error || 'Unknown agent loop error'),
    options,
  );
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

  // Strip thinking suffix — thinking models add 3-5x latency per tool call and risk timeouts.
  // The agent loop needs fast tool-calling, not extended reasoning per turn.
  agentModel = String(agentModel || '').replace(/-thinking$/i, '') || agentModel;

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
        '- After a tool succeeds, CHECK which answer contract dimensions are still uncovered. If uncovered dimensions remain, call additional tools (query_sap_data or run_python_analysis) to fill the gaps. Only stop when ALL required_dimensions and required_outputs are addressed.',
        '- VERIFICATION STEP: After your primary analysis tool returns results, consider whether a quick cross-check query (e.g. a brief SQL aggregation confirming totals) would strengthen confidence. This is encouraged but not mandatory.',
        '- Do NOT call query_sap_data just to restate numbers already in a chart artifact.',
        '- A successful query_sap_data call with 0 rows is not a tool failure, but it provides ZERO evidence. Do NOT cite any numbers, statistics, or counts from a 0-row query. If another tool (e.g. generate_chart) provided data, attribute findings to that source only.',
        '- You may retry query_sap_data ONCE after a 0-row result. The retry must stay in the same dataset and only relax filters or fix joins. Do NOT silently switch datasets.',
        '- Never claim a SQL, worker, connection, or tool failure unless the execution trace actually contains a failed tool call.',
        '- After other tools return results, summarize the key findings clearly and concisely.',
        '- If query_sap_data fails before all required dimensions are covered, switch to run_python_analysis instead of ending with a partial answer.',
        '- If a tool fails, explain the error and suggest a narrower follow-up analysis.',
        '- Always respond in the same language the user used.',
        '',
        buildDuckDbDialectPrompt({ hasUserData: Boolean(toolContext.datasetProfileRow?.profile_json) }),
        '',
        ...(toolContext.datasetProfileRow?.profile_json
          ? [
            '- The user has uploaded their own dataset. Focus on THEIR data, not demo data. Ignore all Olist/Dataset A table names and schemas.',
            '- Use run_python_analysis for the user\'s data. Use query_sap_data only if the user explicitly asks about the demo/Olist dataset.',
          ]
          : [
            '- CRITICAL DATE RANGE: Olist e-commerce data covers 2016-09 to 2018-10. When filtering by date, use dates within this range. Using 2024/2025/2026 dates in WHERE clauses will return 0 rows.',
            '- Dataset B tables (suppliers, materials, inventory_snapshots, po_open_lines, goods_receipts) may have 0 rows. Prefer Dataset A (Olist CSV tables) unless the user specifically asks about operational/supply chain data.',
          ]
        ),
        '',
        'Data Enrichment Rules:',
        '- When reporting metrics, always include both absolute and relative forms: alongside "revenue = R$50K", state "which is 3.2% of total" or "0.7x the category average". Use SQL evidence to compute ratios.',
        '- Before making recommendations based on historical averages, run at least one query grouping by time period. If the metric is growing or declining >10% across periods, note the trend and adjust the recommendation.',
        '- For SQL queries returning aggregated metrics, also query relative context (% of total, rank within category, vs overall average) in the same or follow-up query.',
        '',
        'Data Provenance Rules:',
        '- CRITICAL: Only report numbers that come directly from query results or chart artifacts. If a number is an assumption or industry benchmark (e.g., DSO, marketing budget, warehouse cost, inventory holding cost %), you MUST explicitly label it as "假設" / "assumption" — never present assumptions as data-backed findings.',
        '- Do NOT fabricate financial projections (capital requirements, marketing costs, system costs, headcount) unless the dataset contains those fields. If the dataset lacks the data, state "需業務方提供" / "requires business input" instead of inventing numbers.',
        '- Every number in your answer must be traceable: either (a) directly from a SQL result row, (b) computed from SQL results with formula shown, or (c) clearly marked as an assumption with rationale.',
        '- NUMBER FIDELITY: COPY exact numeric values from tool results. Do NOT round, approximate, or paraphrase numbers. If you must round for readability, prefix with "~" (e.g., "~R$210") and always state the precise value at least once. When citing a specific metric, match the value exactly as returned by the tool.',
        '',
        'Final Answer Rules:',
        '- You are a senior analyst.',
        '- Your FINAL message MUST be a valid JSON object (no markdown fences, no prose before/after the JSON).',
        '- Follow this exact schema:',
        '  {',
        '    "headline": "one-sentence conclusion",',
        '    "executive_summary": "one sentence with 1-2 key numbers",',
        '    "summary": "markdown narrative — the main answer (under 500 words)",',
        '    "metric_pills": [{"label": "string", "value": "string", "source": "string"}],',
        '    "data_lineage": [{"metric": "string", "sql_ref": "string", "row_count": 0, "confidence": "high"}],',
        '    "tables": [{"title": "string", "columns": ["string"], "rows": [["value"]]}],',
        '    "charts": [{"type": "bar", "title": "string", "xKey": "string", "yKey": "string", "series": ["string"], "data": [{}]}],',
        '    "key_findings": ["string"],',
        '    "implications": ["string"],',
        '    "caveats": ["string"],',
        '    "next_steps": ["string"],',
        '    "methodology_note": "string"',
        '  }',
        '- CRITICAL: yKey must be a SINGLE column name. For multi-series, put extra keys in the "series" array.',
        '- CRITICAL: metric_pills are NUMERIC KPIs only. Max 6 pills. Every pill value MUST be traceable to a tool call result.',
        '- FORMATTING: Format numbers for business readability. Use K/M/B suffixes for large numbers (e.g., "R$1.01M" not "1010271.37"). Round to at most 2 decimal places. Order counts should be integers (e.g., "7,451" not "7451.00"). Percentages should show 1 decimal (e.g., "+23.5%").',
        '- CRITICAL: Do NOT include debug logs, SQL text, or tool execution details in the JSON.',
        '- CRITICAL: charts — either include real data rows in "data" or omit the chart entirely. NEVER output a chart with an empty data array "data": []. The UI will render a blank chart.',
        '- CRITICAL: Every conclusion and key finding MUST cite at least one specific number from tool results (e.g., "revenue grew 23% from R$150K to R$185K"). Vague statements like "revenue increased significantly" are not acceptable.',
        '- TABLE DATA ACCURACY: When including tables in your JSON brief, values MUST be copied exactly from SQL query results. NEVER round, estimate, or mentally calculate table values. If SQL returned 750.42, show 750.42, not 750 or ~750. Tables are fact-checked against SQL results — mismatched values are flagged as correctness failures.',
        '- SCOPE CONSISTENCY (CRITICAL): When your SQL uses a WHERE filter (e.g., order_status = "delivered"), ALL numbers in the brief must come from the same filtered scope. Do NOT mix filtered SQL results with unfiltered chart/artifact totals. If the chart covers all orders but your SQL filters to delivered-only, you must EITHER: (a) re-query without the filter to match the chart scope, OR (b) explicitly state both scopes with separate numbers (e.g., "R$13.59M total across all orders; R$13.22M for delivered orders only"). Never claim "delivered orders only" while citing all-order totals.',
        '- DERIVED VALUE AUDIT: Before outputting the final JSON, mentally verify every derived value (averages, percentages, growth rates). Check: (a) numerator and denominator are from the same scope and time range, (b) the denominator matches the count you cite elsewhere (e.g., if you say "24 actual months" then the monthly average must use 24 as divisor, not 25). (c) If you cite X months in one place and Y months in another, explicitly reconcile the discrepancy (e.g., "25 calendar months, 24 with data, 1 missing").',
        '- EXTREME VALUE HANDLING: MoM growth from near-zero to large values produces extreme percentages (e.g., +1,103,687%). Either omit these from tables, replace with "N/A (startup period)", or add a footnote explaining the base is near zero. Never present extreme percentages without context.',
        '- CRITICAL PANDAS COMPAT: df.fillna(method="ffill") WILL FAIL. Use df.ffill() instead. df.fillna(method="bfill") WILL FAIL. Use df.bfill() instead. resample("M") WILL FAIL. Use resample("ME") instead. resample("Q") → resample("QE"). resample("Y") → resample("YE").',
        '- TOOL CALL DISCIPLINE: Issue at most 3 tool calls per turn. Before calling a tool, check if the information is already available from a previous tool result. Prefer one well-crafted SQL query over multiple narrow queries.',
        '- Cover all requested dimensions with specific numbers, category-level breakdowns, and data-backed recommendations.',
        '- For histogram-plus-quantiles requests, explicitly mention the core cut points P25, P50, P75, and P90 (or P95 if P90 is unavailable) when the evidence contains them.',
        '- Focus on concise interpretation, caveats, and the next best action.',
        '',
        answerContractBlock,
        recipeIndex,
        buildStepOutline(answerContract, message),
        formatQueryPlanForPrompt(buildQueryPlan({ userMessage: message, answerContract })),
      ]
    : [
        '- When the user asks about data (customers, orders, products, sellers, payments, etc.), ALWAYS call query_sap_data with a SQL query. NEVER just describe SQL — execute it.',
        '- You may retry query_sap_data ONCE after a 0-row result or SQL error, but the retry must stay in the same dataset and only relax filters or fix joins. Do NOT use test queries like "SELECT 1".',
        buildDuckDbDialectPrompt({ hasUserData: Boolean(toolContext.datasetProfileRow?.profile_json) }),
        '- When the user asks to run an analysis, chart, visualization, forecast, plan, or any tool, call the appropriate function.',
        '- If the user asks for a chart, visualization, or any analysis that matches the recipe catalog below, use generate_chart(recipe_id). It runs pre-written Python (~2s) instead of LLM code generation (~15s).',
        '- After generate_chart succeeds: the card already shows title, metrics, highlights, and chart. Do NOT repeat them. Only add a short (2-4 sentence) business insight or actionable recommendation. If nothing to add, just say the chart is ready.',
        '- After a tool succeeds, check if the user\'s question has remaining uncovered aspects. If so, call additional tools to address them before writing your final answer.',
        '- After other tools return results, summarize the key findings for the user.',
        '- If a tool fails, explain the error and suggest alternatives.',
        '- You can chain multiple tools: e.g., run forecast first, then generate a plan.',
        `- To forecast from SAP data, use forecast_from_sap (NOT run_forecast). It accepts a demand_sql parameter — write a SQL that returns (material_code, plant_id, time_bucket, demand_qty).${toolContext.datasetProfileRow?.profile_json ? '' : ' If no SQL given, defaults to Olist orders. Olist data covers 2017-01 to 2018-08.'}`,
        '- If you need data that is not available, try query_sap_data first before asking the user to upload.',
        '- Tools prefixed with "reg_" are user-approved registered tools. Use them when they match the task.',
        '- If a tool fails due to data format mismatch, the system may auto-generate an adapter tool for the user to approve.',
        '- Always respond in the same language the user used.',
        '- For multi-step statistical analysis (classification, stationarity testing, sensitivity analysis, ABC-XYZ), use run_python_analysis (Python/pandas/numpy). SQL (query_sap_data) is for data retrieval only — Python is for computation.',
        '- run_python_analysis sandbox: Available libraries: pandas, numpy, scipy (scipy.stats, scipy.interpolate, scipy.optimize), statsmodels (seasonal_decompose, Holt-Winters, ADF test), sklearn (KMeans, LinearRegression, StandardScaler), calendar, statistics, collections, itertools, datetime, dateutil, math, json, re, copy, decimal, uuid, openpyxl. Do NOT attempt to import matplotlib, seaborn, plotly, os, sys, or subprocess — they will fail. Use generate_chart for visualization.',
        '- After completing a multi-step analysis, use generate_analysis_workbook to produce a professional Excel report with methodology notes, parameter tables, and sensitivity tables.',
        '',
        'THINKING PROTOCOL (analysis mode only):',
        'Before writing your final JSON answer, reason through these questions internally:',
        '1. What is the user REALLY asking? (surface question vs underlying need)',
        '2. What did the data actually show? Any surprises or contradictions?',
        '3. Are there confounding factors the user should know about?',
        '4. What would a skeptical senior analyst challenge about this analysis?',
        '5. Is there a "so what" — a concrete action the user can take?',
        '',
        'Wrap your reasoning in <thinking>...</thinking> tags before the JSON output.',
        'The thinking block will be stripped before the user sees the result.',
        'Take 200-400 words to reason. Do NOT skip this step.',
        '',
        'Final Answer Rules:',
        '- You are a senior analyst. Write only the useful user-facing interpretation.',
        '- For brevity="short": keep the final answer under 160 words.',
        '- For brevity="analysis": use 300-500 words. Include: (a) what the data shows, (b) why it matters (causal reasoning), (c) what the user should do next. Depth is more valuable than brevity for analysis.',
        '- Do NOT output markdown tables, pseudo-tables, SQL, debug logs, tool transcripts, "thinking", or step-by-step execution details.',
        '- Do NOT list every tool you called. The UI renders execution trace separately.',
        '- Focus on concise interpretation, caveats, and the next best action.',
        '',
        answerContractBlock,
        recipeIndex,
        formatQueryPlanForPrompt(buildQueryPlan({ userMessage: message, answerContract })),
      ];
  // ── Domain enrichment: inject domain-specific formulas and parameter guidance ──
  const domain = detectDomain(message);
  const domainEnrichmentBlock = domain.domainKey
    ? buildDomainEnrichmentPrompt(domain.domainKey, domain.matchedConcepts, answerContract?.task_type)
    : '';
  const paramSweepBlock = !domainEnrichmentBlock && domain.domainKey
    && isParameterOptimizationQuestion(message, answerContract?.task_type)
    ? buildParameterSweepInstruction(domain.domainKey)
    : '';

  // ── Query intent classification ──
  // Classify intent BEFORE evidence enforcement so meta/greeting queries skip evidence rules.
  const queryTier = classifyQueryIntent(message, conversationHistory);

  // ── Provider-specific evidence enforcement ──
  // When a provider cannot use tool_choice:"required" (e.g. Gemini with thinkingConfig),
  // inject a hard-coded evidence-first mandate directly into the system prompt so the model
  // sees it on every turn — not just as a retry nudge.
  // Skipped for meta-tier queries (greetings, capability questions) that don't need evidence.
  const resolvedProvider = resolveProviderFromModel(agentModel, agentProvider);
  const providerNeedsEvidencePrompt = queryTier.tier !== 'meta'
    && isAnalysisMode
    && PROVIDER_REGISTRY[resolvedProvider]
    && !PROVIDER_REGISTRY[resolvedProvider].supportsRequiredToolChoiceWithThinking;
  const evidencePromptBlock = providerNeedsEvidencePrompt
    ? [
        '',
        '⚠️ MANDATORY EVIDENCE-FIRST RULE (applies to EVERY response):',
        'You MUST call at least one evidence-producing tool (query_sap_data, run_python_analysis, or generate_chart) BEFORE writing ANY prose answer.',
        'If you respond with text without having called a tool first, your response will be REJECTED and you will be asked again.',
        'Do NOT describe what you plan to do — just call the tool immediately.',
        'Do NOT output analysis, recommendations, or commentary until you have tool-backed evidence.',
        '',
      ]
    : [];

  // ── User-uploaded dataset schema digest (with query-time context selection) ──
  let userDatasetDigestBlock = '';
  if (toolContext.datasetProfileRow?.profile_json) {
    const focusedProfile = selectRelevantContext(
      toolContext.datasetProfileRow.profile_json,
      message
    );
    userDatasetDigestBlock = buildUserDatasetDigest({
      ...toolContext.datasetProfileRow,
      profile_json: focusedProfile,
    });
  }

  // ── Execution memory: recall past successful query patterns ──
  let patternBlock = [];
  try {
    const fingerprint = toolContext.datasetProfileRow?.profile_json?.global?.fingerprint;
    if (fingerprint) {
      const pastPatterns = await recallQueryPatterns({ datasetFingerprint: fingerprint, limit: 3 });
      if (pastPatterns.length > 0) {
        patternBlock = [
          '── Past Successful Queries for This Dataset ──',
          ...pastPatterns.map((p, i) =>
            `${i + 1}. Q: "${p.user_question}" → Tool: ${p.tool_used}, Result: ${p.result_summary}`
          ),
          'Use these as reference patterns. Adapt them to the current question.',
          '',
        ];
      }
    }
  } catch { /* non-critical */ }

  // ── Execution memory: recall past FAILURE patterns ──
  let failureBlock = [];
  try {
    const fp = toolContext.datasetProfileRow?.profile_json?.global?.fingerprint;
    const pastFailures = await recallFailurePatterns({ datasetFingerprint: fp, limit: 5 });
    if (pastFailures.length > 0) {
      failureBlock = [
        '── KNOWN FAILURE PATTERNS (DO NOT REPEAT) ──',
        ...pastFailures.map((f, i) => {
          const resolution = f.resolution ? ` → INSTEAD: ${f.resolution}` : '';
          return `${i + 1}. ❌ ${f.tool_used}: ${f.error_type} — "${f.error_message}"${resolution} (seen ${f.occurrence_count}x)`;
        }),
        'CRITICAL: Do NOT attempt any of the above patterns. Use the suggested alternatives.',
        '',
      ];
    }
  } catch { /* non-critical */ }

  const agentSystemPrompt = [
    systemPrompt,
    '',
    '── Agent Capabilities ──',
    toolSummary,
    '',
    ...(toolContext.datasetProfileLoadError
      ? [`⚠️ Dataset profile failed to load: ${toolContext.datasetProfileLoadError}. Some data-related questions may not work correctly.`, '']
      : []),
    ...(userDatasetDigestBlock
      ? [
        '── User-Uploaded Dataset Schema ──',
        userDatasetDigestBlock,
        '',
        '⚠️ USER DATA ROUTING RULES:',
        '1. When the user asks about THIS uploaded dataset, ALWAYS use run_python_analysis. NEVER use query_sap_data.',
        '2. The uploaded data is NOT in the SQL database. query_sap_data cannot access it.',
        '3. If run_python_analysis returns an error about missing data, tell the user to re-upload the file.',
        '4. IGNORE all Olist table references when answering questions about user data.',
        '',
      ]
      : []),
    ...patternBlock,
    ...failureBlock,
    ...(domainEnrichmentBlock ? [domainEnrichmentBlock, ''] : []),
    ...(paramSweepBlock ? [paramSweepBlock, ''] : []),
    ...(isAnalysisMode ? [PROXY_DISCLOSURE_PROMPT, ''] : []),
    ...evidencePromptBlock,
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
  let businessContextDetected = false;
  let forcedEvidenceTurns = 0;
  const recoveryAttempts = [];
  const requiresAnalysisEvidence = queryTier.tier !== 'meta'
    && (isAnalysisMode || answerContractNeedsAnalysisEvidence(answerContract));
  const resolvedAgentProvider = resolveProviderFromModel(agentModel, agentProvider);
  const agentTransport = getAgentProviderTransport(resolvedAgentProvider);
  const providerSupportsStreaming = Boolean(getAgentToolStreamingMode(resolvedAgentProvider));
  let toolChoiceCompatibilityNoted = false;
  let initialEvidenceInstructionInjected = false;

  // ── The Loop ────────────────────────────────────────────────────────────
  const maxIterations = resolveMaxIterations(answerContract);
  for (let i = 0; i < maxIterations; i++) {
    if (signal?.aborted) {
      throw new Error('Agent loop aborted');
    }

    totalIterations = i + 1;
    onThinking?.({ step: i + 1, type: 'step_start', content: `Step ${i + 1} — Reasoning…`, fullContent: '' });

    const t0 = Date.now();
    let response;
    const requestedToolChoice = requiresAnalysisEvidence && toolCalls.length === 0 ? 'required' : 'auto';
    const {
      effectiveToolChoice: toolChoice,
      downgraded: toolChoiceDowngraded,
    } = normalizeToolChoiceForProvider(resolvedAgentProvider, requestedToolChoice, { model: agentModel });

    if (toolChoiceDowngraded && !toolChoiceCompatibilityNoted) {
      toolChoiceCompatibilityNoted = true;
      recoveryAttempts.push('tool_choice_provider_compat_fallback');
      console.warn(
        `[agentLoop] ${resolvedAgentProvider}/${agentModel} cannot use toolChoice="${requestedToolChoice}" with current thinking settings; using "auto" and enforcing evidence via prompt policy.`,
      );
    }
    if (
      toolChoiceDowngraded
      && requestedToolChoice === 'required'
      && toolCalls.length === 0
      && !initialEvidenceInstructionInjected
    ) {
      initialEvidenceInstructionInjected = true;
      recoveryAttempts.push('provider_tool_choice_compat_nudge');
      messages.push({
        role: 'user',
        content: buildInitialEvidenceInstruction(answerContract, message),
      });
    }

    // Preamble callback shared by streaming and non-streaming paths
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

    const preambleChunk = (chunk) => {
      thinkingBuffer += chunk;
      pendingChunks += chunk;
      if (!flushTimer) {
        flushTimer = setTimeout(flushPending, FLUSH_INTERVAL_MS);
      }
    };

    // ── Compat-transport first-call fast path ────────────────────────────────
    // For compat-transport providers (Gemini) in analysis mode, the first call
    // with thinkingConfig almost always returns prose instead of tool_calls.
    // Skip directly to no-thinking + toolChoice:"required" to save round trips.
    const useNoThinkingFastPath = (
      i === 0
      && requiresAnalysisEvidence
      && toolCalls.length === 0
      && agentTransport === 'compat'
    );

    if (useNoThinkingFastPath) {
      console.info(`[agentLoop] ${resolvedAgentProvider}: using no-thinking fast path for first evidence call`);
      recoveryAttempts.push('compat_first_call_fast_path');
      const fastResponse = await callLLMWithToolsNoThinking(messages, tools, {
        signal,
        provider: resolvedAgentProvider,
        model: agentModel,
      });
      if (fastResponse?.tool_calls?.length) {
        response = fastResponse;
      } else {
        // Fast path returned prose — push context and let normal streaming take over
        if (fastResponse?.content?.trim()) {
          onTextChunk?.(fastResponse.content + '\n');
          messages.push({ role: 'assistant', content: fastResponse.content });
        }
        continue;
      }
    } else {
      try {
        response = await callLLMWithToolsStream(messages, tools, {
          signal,
          provider: resolvedAgentProvider,
          model: agentModel,
          toolChoice,
          onPreambleChunk: preambleChunk,
        });
        // Flush any remaining buffered chunks after stream completes
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        flushPending();
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        if (!providerSupportsStreaming) {
          console.error('[agentLoop] Non-streaming provider call failed:', err);
          throw coerceAgentLoopError(err, 'tool_transport_failed', {
            provider: resolvedAgentProvider,
            model: agentModel,
            transport: agentTransport,
            recoveryAttempts,
          });
        }
        // Fallback to non-streaming if stream mode fails
        console.warn('[agentLoop] Stream call failed, trying non-stream fallback:', err.message);
        recoveryAttempts.push('stream_to_non_stream_fallback');
        try {
          response = await callLLMWithTools(messages, tools, {
            signal,
            provider: resolvedAgentProvider,
            model: agentModel,
            toolChoice,
            onPreambleChunk: preambleChunk,
          });
        } catch (err2) {
          if (err2.name === 'AbortError') throw err2;
          console.error('[agentLoop] LLM call failed:', err2);
          throw coerceAgentLoopError(err2, 'tool_transport_failed', {
            provider: resolvedAgentProvider,
            model: agentModel,
            transport: agentTransport,
            recoveryAttempts,
          });
        }
      }
    }
    // Flush any reasoning from non-streaming fallback path
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flushPending();

    if (Array.isArray(response?.recovery_attempts) && response.recovery_attempts.length > 0) {
      recoveryAttempts.push(...response.recovery_attempts);
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
        const nudgeTool = suggestPrimaryTool(answerContract, tools, message);
        messages.push({
          role: 'user',
          content: `IMPORTANT: You MUST call the ${nudgeTool} function right now. Do not explain what you will do — just call it.${nudgeTool === 'query_sap_data' ? ' For example: query_sap_data({"sql":"SELECT ..."})' : ''}`,
        });
        continue;

      } else if (
        requiresAnalysisEvidence
        && toolCalls.length === 0
        && text.trim()
        && forcedEvidenceTurns < (agentTransport === 'compat' ? 1 : 2)
      ) {
        // For compat-transport providers (Gemini), limit to 1 prompt nudge instead of 2.
        // Gemini rarely complies with prompt-based evidence mandates, so we save an LLM
        // call and fall through to no-thinking recovery faster.
        const attempt = forcedEvidenceTurns;
        forcedEvidenceTurns += 1;
        recoveryAttempts.push(`forced_evidence_turn_${attempt}`);
        console.warn(`[agentLoop] ${resolvedAgentProvider} returned prose without tool_calls in evidence-required mode; forcing evidence tool turn (attempt ${attempt + 1}/${agentTransport === 'compat' ? 1 : 2}).`);
        messages.push({ role: 'assistant', content: text });
        messages.push({
          role: 'user',
          content: buildForcedEvidenceInstruction(answerContract, attempt),
        });
        continue;

      } else {
        if (!text.trim()) {
          throw createAgentLoopError(
            'empty_response',
            `${resolvedAgentProvider}/${agentModel} returned an empty response (no text, no tool calls).`,
            {
              provider: resolvedAgentProvider,
              model: agentModel,
              transport: response?.transport || agentTransport,
              recoveryAttempts,
            },
          );
        }
        if (requiresAnalysisEvidence && toolCalls.length === 0) {
          // ── Last-resort recovery: non-streaming call without thinkingConfig ──
          // For compat-transport providers (Gemini), thinkingConfig silently breaks
          // tool_choice:"required". Try one final call with thinking disabled so
          // the model is truly forced to emit a tool call.
          if (
            agentTransport === 'compat'
            && !recoveryAttempts.includes('no_thinking_evidence_recovery')
          ) {
            recoveryAttempts.push('no_thinking_evidence_recovery');
            console.warn(`[agentLoop] ${resolvedAgentProvider}: attempting evidence recovery without thinkingConfig`);
            messages.push({ role: 'assistant', content: text });
            messages.push({
              role: 'user',
              content: buildForcedEvidenceInstruction(answerContract, 2),
            });
            const recoveryResponse = await callLLMWithToolsNoThinking(messages, tools, {
              signal,
              provider: resolvedAgentProvider,
              model: agentModel,
            });
            // Also try embedded tool call extraction on recovery text
            if (!recoveryResponse?.tool_calls?.length && recoveryResponse?.content) {
              const extractedRecovery = extractEmbeddedToolCall(recoveryResponse.content, tools);
              if (extractedRecovery) {
                console.info('[agentLoop] Extracted embedded tool call from recovery text:', extractedRecovery.name);
                recoveryResponse.tool_calls = [{
                  id: `recovery_embedded_${Date.now()}`,
                  type: 'function',
                  function: { name: extractedRecovery.name, arguments: JSON.stringify(extractedRecovery.args) },
                }];
              }
            }
            if (recoveryResponse?.tool_calls?.length) {
              // Success — inject tool calls back into the loop by re-assigning response
              // and falling through to the tool execution path (Case 2).
              response = recoveryResponse;
              // Remove the last two messages we just pushed (they served their purpose)
              // and let the loop's Case 2 handler process the tool calls.
              // We need to continue from the tool execution path, so we re-enter the
              // relevant code path by NOT breaking here.
              // However the current control flow is inside the "no tool_calls" branch.
              // The cleanest approach: push the recovery result into toolCalls manually.
              for (const tc of recoveryResponse.tool_calls) {
                const toolName = tc.function?.name;
                let toolArgs = {};
                try { toolArgs = JSON.parse(tc.function?.arguments || '{}'); } catch { /* ignore */ }
                onToolCall?.({ name: toolName, args: toolArgs });
                const toolResult = await executeTool(toolName, toolArgs, toolContext);
                onToolResult?.({ name: toolName, result: toolResult });
                toolCalls.push({ name: toolName, args: toolArgs, result: toolResult });
              }
              // Now continue the loop — next iteration will see toolCalls.length > 0
              continue;
            }
            console.warn('[agentLoop] Evidence recovery without thinkingConfig also returned no tool calls.');
          }

          throw createAgentLoopError(
            'missing_evidence',
            `${resolvedAgentProvider}/${agentModel} returned prose without producing any successful analysis evidence.`,
            {
              provider: resolvedAgentProvider,
              model: agentModel,
              transport: response?.transport || agentTransport,
              recoveryAttempts,
            },
          );
        }
        finalText = text;
        onTextChunk?.(text);

        trackLlmUsage({
          source: 'agent_loop',
          model: agentModel,
          provider: resolvedAgentProvider,
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

      // ── Optimizer deduplication: return cached primary result if same tool+args ──
      let toolResult;
      const primaryCalls = toolContext._primaryToolCalls;
      const duplicatePrimaryCall = primaryCalls
        ? primaryCalls.find(ptc => {
            if (ptc.name !== toolName || !ptc.result?.success) return false;
            // Normalize SQL for comparison
            if (toolName === 'query_sap_data') {
              const normSql = s => {
                let q = (s || '').toLowerCase().trim();
                q = q.replace(/\s*;\s*$/, '');
                q = q.replace(/\s+/g, ' ');
                q = q.replace(/\b(from|join)\s+(\w+)\s+(?:as\s+)?\w+\b/gi, '$1 $2');
                q = q.replace(/\b(\w+(?:\.\w+)?)\s+as\s+\w+\b/gi, '$1');
                q = q.replace(/\b\w+\.(\w+)/g, '$1');
                q = q.replace(/[`"]/g, '');
                return q.trim();
              };
              return normSql(ptc.args?.sql) === normSql(toolArgs?.sql);
            }
            return JSON.stringify(ptc.args) === JSON.stringify(toolArgs);
          })
        : null;

      if (duplicatePrimaryCall) {
        console.info(`[agentLoop] Optimizer: returning cached primary result for ${toolName}`);
        toolResult = duplicatePrimaryCall.result;
        deferredGuidance.push({
          role: 'user',
          content: `ℹ️ This ${toolName} call is identical to Primary Agent's call. Returning cached result. Do NOT re-query the same data — use different parameters or a different tool.`,
        });
      } else {
        toolResult = await executeTool(toolName, toolArgs, toolContext);
      }

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

      // ── Pre-analysis data validation: detect statistical issues in query results ──
      if (toolName === 'query_sap_data' && toolResult.success && toolResult.result?.rows?.length > 0) {
        try {
          const validationColumns = toolResult.result.columns || Object.keys(toolResult.result.rows[0] || {});
          const { warnings } = validateQueryResultData(toolResult.result.rows, validationColumns, toolArgs.sql);
          if (warnings.length > 0) {
            toolCalls[toolCalls.length - 1]._dataValidationWarnings = warnings;
            deferredGuidance.push({
              role: 'user',
              content: `⚠️ DATA QUALITY WARNINGS for the previous query result:\n${formatWarningsForAgent(warnings)}\nYou MUST address these in your analysis. If computing statistics from this data, apply the suggested corrections.`,
            });
          }
          // Business context detection (first successful query only)
          if (!businessContextDetected) {
            const contextClues = detectBusinessContext(toolResult.result.rows);
            if (contextClues.length > 0) {
              businessContextDetected = true;
              toolCalls[toolCalls.length - 1]._businessContextClues = contextClues;
              deferredGuidance.push({
                role: 'user',
                content: `📋 BUSINESS CONTEXT DETECTED:\n${contextClues.map((c) => `- ${c.message}`).join('\n')}\nFactor these into your analysis and recommendations.`,
              });
            }
          }
        } catch { /* non-critical — never block agent loop */ }
      }

      // ── Gap Detection: if tool failed, check if we can auto-create a tool ──
      if (!earlyReturn && !toolResult.success && i < maxIterations - 2 && onToolBlueprint) {
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
        const hasUserData = Boolean(toolContext.datasetProfileRow?.profile_json);
        const mentionsModernDate = /202[3-9]|203\d/.test(sqlText);
        const dateHint = (mentionsModernDate && !hasUserData)
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
        } else if (!coverageStopInstructionInjected && unmetDimensions.length > 0 && toolResult.success) {
          // Proactive mid-loop nudge: tell agent what's still missing after each successful tool call
          const coveredSoFar = [...(coverageStatus.coverage.coveredDimensions || [])];
          deferredGuidance.push({
            role: 'user',
            content: `Progress update: covered dimensions so far: ${coveredSoFar.join(', ') || 'none'}. Still uncovered: ${unmetDimensions.join(', ')}${unmetStructuredOutputs.length > 0 ? `. Missing outputs: ${unmetStructuredOutputs.join(', ')}` : ''}. Continue calling tools to address the uncovered dimensions before writing your final answer.`,
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

      // ── Failure Memory: record failure patterns for cross-session learning ──
      if (!toolResult.success) {
        try {
          const errorMsg = toolResult.error || '';
          const errorType = classifyToolError(errorMsg);
          const failedInput = toolName === 'query_sap_data'
            ? (toolArgs.sql || '').slice(0, 200)
            : toolName === 'run_python_analysis'
              ? (toolArgs.tool_hint || '').slice(0, 200)
              : toolName === 'generate_chart'
                ? (toolArgs.recipe_id || '')
                : JSON.stringify(toolArgs).slice(0, 200);

          const fingerprint = toolContext.datasetProfileRow?.profile_json?.global?.fingerprint;

          writeFailurePattern({
            datasetFingerprint: fingerprint,
            toolUsed: toolName,
            failedInput,
            errorType,
            errorMessage: errorMsg.slice(0, 200),
          }).catch(() => {}); // fire-and-forget, never block agent loop

          // Track dedupeKey for potential resolution attachment
          toolCalls[toolCalls.length - 1]._failureDedupeKey = failureDedupeKey({
            toolUsed: toolName,
            errorType,
            errorMessage: errorMsg,
          });
        } catch { /* non-critical — never block agent loop */ }
      }

      // ── Failure Resolution: if this tool succeeded after a prior same-tool failure, record resolution ──
      if (toolResult.success && toolName) {
        try {
          const priorFailure = [...toolCalls].reverse().find(
            tc => tc.name === toolName && !tc.result?.success && tc._failureDedupeKey
          );
          if (priorFailure) {
            const resolution = toolName === 'run_python_analysis'
              ? `Succeeded with hint: "${(toolArgs.tool_hint || '').slice(0, 150)}"`
              : toolName === 'query_sap_data'
                ? `Succeeded with SQL: "${(toolArgs.sql || '').slice(0, 150)}"`
                : `Succeeded with: ${JSON.stringify(toolArgs).slice(0, 150)}`;
            attachFailureResolution(priorFailure._failureDedupeKey, resolution);
          }
        } catch { /* non-critical */ }
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

    // Iteration budget awareness: tell agent how many turns remain
    const remaining = maxIterations - (i + 1);
    if (remaining <= 2 && remaining > 0) {
      messages.push({
        role: 'user',
        content: `⏱ You have ${remaining} iteration${remaining === 1 ? '' : 's'} remaining. If uncovered dimensions remain, prioritize them now. Otherwise, write your final answer.`,
      });
    } else if (remaining === 0) {
      messages.push({
        role: 'user',
        content: '⏱ This is your LAST iteration. Write your final answer now using the evidence collected so far. Do not call more tools.',
      });
    }

    // Handle early return from gap detection (after tool responses are properly pushed)
    if (earlyReturn) {
      return earlyReturn;
    }

    trackLlmUsage({
      source: 'agent_loop',
      model: agentModel,
      provider: resolvedAgentProvider,
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

  if (totalIterations >= maxIterations && !finalText) {
    if (requiresAnalysisEvidence) {
      throw createAgentLoopError(
        'tool_transport_failed',
        'Agent reached maximum iterations before producing a final answer.',
        {
          provider: resolvedAgentProvider,
          model: agentModel,
          transport: agentTransport,
          recoveryAttempts,
        },
      );
    }
    finalText = '⚠️ Agent reached maximum iterations. The analysis may be incomplete. Please try a more specific request.';
    onTextChunk?.(finalText);
  }

  return {
    text: finalText,
    toolCalls,
    iterations: totalIterations,
    isAgentResponse: true,
    provider: resolvedAgentProvider,
    model: agentModel,
    transport: agentTransport,
    recoveryAttempts,
    queryTier,
  };
}

// ── LLM Call with Tools (Streaming) ─────────────────────────────────────────

/**
 * Call LLM with tools via SSE streaming.
 * Streams thinking/preamble content in real-time via onPreambleChunk callback.
 * Returns the same shape as callLLMWithTools: { content, tool_calls, usage }.
 */
async function callLLMWithToolsStream(messages, tools, { signal, onPreambleChunk, provider: rawProvider = getModelConfig('primary').provider, model = getModelConfig('primary').model, toolChoice = 'auto' } = {}) {
  const provider = resolveProviderFromModel(model, rawProvider);
  const { effectiveToolChoice } = normalizeToolChoiceForProvider(provider, toolChoice, { model });
  if (!PROVIDER_REGISTRY[provider]) {
    throw createAgentLoopError(
      'provider_unsupported',
      `Unsupported provider "${provider}" for agent tools streaming.`,
      { provider, model, transport: null },
    );
  }
  const toolsMode = getAgentToolStreamingMode(provider);

  if (!toolsMode) {
    // Providers without a streaming tool path fall back to non-streaming.
    return callLLMWithTools(messages, tools, { signal, provider, model, toolChoice: effectiveToolChoice, onPreambleChunk });
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
    toolChoice: effectiveToolChoice,
    temperature: 0.3,
    maxOutputTokens: 4096,
    ...(provider === 'gemini' ? { googleOptions: buildGeminiThinkingGoogleOptions() } : {}),
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

  if (!content.trim() && tool_calls.length === 0) {
    console.warn(`[agentLoop] ${provider} streaming returned no content/tool_calls; retrying once via non-streaming tools API.`);
    const fallback = await callLLMWithTools(messages, tools, { signal, provider, model, toolChoice: effectiveToolChoice });
    return {
      ...fallback,
      recovery_attempts: ['stream_empty_to_non_stream_fallback'],
    };
  }

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
async function callLLMWithTools(messages, tools, { signal, provider: rawProvider = getModelConfig('primary').provider, model = getModelConfig('primary').model, toolChoice = 'auto', onPreambleChunk } = {}) {
  const provider = resolveProviderFromModel(model, rawProvider);
  const { effectiveToolChoice } = normalizeToolChoiceForProvider(provider, toolChoice, { model });
  if (!PROVIDER_REGISTRY[provider]) {
    throw createAgentLoopError(
      'provider_unsupported',
      `Unsupported provider "${provider}" for agent tools.`,
      { provider, model, transport: null },
    );
  }
  // Try Edge Function (ai-proxy) first
  if (USE_EDGE_AI_PROXY) {
    const toolsMode = getAgentToolMode(provider);
    console.info(`[agentLoop] Calling LLM (${toolsMode}, model=${model}) with ${tools.length} tools:`, tools.map(t => t.function?.name));
    const result = await invokeAiProxy(toolsMode, {
      messages,
      tools,
      model,
      toolChoice: effectiveToolChoice,
      temperature: 0.3, // Lower temperature for tool calls — more deterministic
      maxOutputTokens: 4096,
      ...(provider === 'gemini' ? { googleOptions: buildGeminiThinkingGoogleOptions() } : {}),
    }, { signal });

    console.info('[agentLoop] LLM raw response keys:', Object.keys(result || {}));
    console.info('[agentLoop] LLM choices[0].message:', JSON.stringify(result?.choices?.[0]?.message || result?.text || '(no choices)').slice(0, 500));

    // The ai-proxy should return the full OpenAI-format response
    if (result?.choices?.[0]?.message) {
      const msg = result.choices[0].message;
      console.info('[agentLoop] tool_calls in response:', msg.tool_calls?.length ?? 0, msg.tool_calls ? JSON.stringify(msg.tool_calls).slice(0, 300) : '');
      // Push reasoning_content to UI for non-streaming providers (e.g. Kimi)
      if (msg.reasoning_content && onPreambleChunk) {
        onPreambleChunk(msg.reasoning_content);
      }
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
    // Exact match
    if (coveredDimensions.has(normalized)) return false;
    // Pattern-based match: run required dimension through the same DIMENSION_PATTERNS
    // so compound phrases like "seller revenue" match covered labels "revenue"/"sellers"
    const matchedLabels = new Set();
    addDimensionHits(normalized, matchedLabels);
    for (const label of matchedLabels) {
      if (coveredDimensions.has(label)) return false;
    }
    return true;
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
