/**
 * chatToolAdapter.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Converts builtinToolCatalog entries into OpenAI/DeepSeek function-calling
 * tool definitions, and provides a dispatcher that executes tool calls.
 *
 * This is the bridge between the LLM's tool_use decisions and our existing
 * DI engine catalog.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { BUILTIN_TOOLS } from '../ai-infra/builtinToolCatalog.js';
import { getToolById, listTools, incrementUsage } from '../ai-infra/toolRegistryService.js';
import { createScenario } from '../planning/diScenariosService.js';
import { resolveToolGroups } from './toolGroupRegistry.js';

// ── Convert catalog → LLM tool definitions ──────────────────────────────────

/**
 * Convert a single BuiltinTool entry into an OpenAI-compatible function tool.
 * The input_schema in the catalog is descriptive text; we convert it to a
 * real JSON Schema so the LLM can generate valid arguments.
 */
function catalogEntryToToolDef(entry) {
  // Build a JSON Schema from the descriptive input_schema
  const properties = {};
  const required = [];

  if (entry.input_schema) {
    for (const [key, desc] of Object.entries(entry.input_schema)) {
      const descStr = String(desc);
      const prop = { type: 'string', description: descStr };

      // Infer JSON Schema type from the description
      if (/^number/.test(descStr) || /number\|null/.test(descStr)) {
        prop.type = 'number';
      } else if (/^array/.test(descStr)) {
        prop.type = 'array';
        prop.items = { type: 'object' };
      } else if (/^object/.test(descStr)) {
        prop.type = 'object';
      } else if (/^boolean/.test(descStr)) {
        prop.type = 'boolean';
      } else if (/^'on'\|'off'/.test(descStr) || /^'/.test(descStr)) {
        prop.type = 'string';
      }

      // If description doesn't mention "null" or "optional", it's required
      if (!/null|optional/i.test(descStr) && !/function/.test(descStr)) {
        required.push(key);
      }

      properties[key] = prop;
    }
  }

  return {
    type: 'function',
    function: {
      name: entry.id,
      description: `${entry.name}: ${entry.description}`,
      parameters: {
        type: 'object',
        properties,
        required,
      },
    },
  };
}

function selectBuiltinTools(opts = {}) {
  const { categories, toolIds, groups, excludePython = true } = opts;

  let tools = BUILTIN_TOOLS;

  if (excludePython) {
    tools = tools.filter((t) => t.module !== '__python_api__');
  }
  if (categories?.length) {
    tools = tools.filter((t) => categories.includes(t.category));
  }
  // groups: resolve group names to tool IDs, then filter
  if (Array.isArray(groups) && groups.length > 0) {
    const groupToolIds = resolveToolGroups(groups);
    tools = tools.filter((t) => groupToolIds.includes(t.id));
  } else if (toolIds?.length) {
    tools = tools.filter((t) => toolIds.includes(t.id));
  }

  return tools;
}

/**
 * Get all tool definitions suitable for LLM function calling.
 * Includes both builtin tools AND approved registered tools from the registry.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.categories] - Only include tools from these categories
 * @param {string[]} [opts.toolIds] - Only include these tool IDs
 * @param {string[]} [opts.groups] - Tool groups from toolGroupRegistry (e.g. ['analysis_core']). Takes precedence over toolIds.
 * @param {boolean}  [opts.excludePython] - Skip Python API tools (default: true)
 * @param {boolean}  [opts.includeRegistered] - Include registered tools (default: true)
 * @returns {Array} OpenAI-format tool definitions
 */
export function getToolDefinitions(opts = {}) {
  const { categories, toolIds, groups, excludePython = true, includeRegistered = true } = opts;
  const tools = selectBuiltinTools({ categories, toolIds, groups, excludePython });

  const defs = tools.map(catalogEntryToToolDef);

  // Also include registered (user-approved) tools
  if (includeRegistered) {
    const registeredDefs = getRegisteredToolDefinitions();
    defs.push(...registeredDefs);
  }

  return defs;
}

/**
 * Get a lightweight summary of available tools for the system prompt.
 * This helps the LLM understand what it can do without sending full schemas.
 */
export function getToolSummaryForPrompt(opts = {}) {
  const { categories, toolIds, groups, excludePython = true } = opts;
  const lines = selectBuiltinTools({ categories, toolIds, groups, excludePython })
    .map((t) => `- ${t.id}: ${t.name} — ${t.description}`);

  return [
    'You have access to the following supply chain analysis tools.',
    'Call them when the user asks you to run analyses, forecasts, plans, or simulations.',
    'Always explain what you are doing before calling a tool.',
    '',
    ...lines,
    '',
    'When calling a tool, use the exact tool ID as the function name.',
    'If a tool requires a dataset_profile_id and none is available, ask the user to upload data first.',
  ].join('\n');
}

// ── Tool Executor ───────────────────────────────────────────────────────────

/** Cache for dynamically imported modules */
const _moduleCache = new Map();

/**
 * Execute a tool call by dispatching to the catalog entry's module/method.
 *
 * @param {string} toolName - The tool ID (e.g. 'run_forecast')
 * @param {object} args - Arguments from the LLM
 * @param {object} context - Runtime context (userId, datasetProfileRow, etc.)
 * @returns {Promise<{ success: boolean, result?: any, error?: string }>}
 */
export async function executeTool(toolName, args, context = {}) {
  // Handle registered tools (prefixed with "reg_")
  if (toolName.startsWith('reg_')) {
    const registeredId = toolName.slice(4); // Remove "reg_" prefix
    return executeRegisteredTool(registeredId, args);
  }

  const entry = BUILTIN_TOOLS.find((t) => t.id === toolName);
  if (!entry) {
    return { success: false, error: `Unknown tool: ${toolName}` };
  }

  // Python API tools need special handling
  if (entry.module === '__python_api__') {
    // Allow run_python_analysis — calls /execute-tool with analysis_mode
    if (entry.id === 'run_python_analysis') {
      return callPythonAnalysisTool(entry, args, context);
    }
    // Allow generate_analysis_workbook — calls /generate-analysis-workbook
    if (entry.id === 'generate_analysis_workbook') {
      return callAnalysisWorkbookTool(entry, args, context);
    }
    return { success: false, error: `Python API tool "${toolName}" is not supported in chat agent mode yet.` };
  }

  try {
    // Dynamic import of the tool's module
    // Catalog module paths are relative to src/services/ (e.g. './forecast/chatForecastService')
    // but this file lives in src/services/agent-core/, so we prepend '../' to resolve correctly.
    let mod = _moduleCache.get(entry.module);
    if (!mod) {
      const resolvedPath = entry.module.startsWith('./')
        ? '../' + entry.module.slice(2)
        : entry.module;
      mod = await import(/* @vite-ignore */ resolvedPath);
      _moduleCache.set(entry.module, mod);
    }

    const fn = mod[entry.method];
    if (typeof fn !== 'function') {
      return { success: false, error: `Method "${entry.method}" not found in module "${entry.module}"` };
    }

    // Merge LLM args with runtime context
    const mergedArgs = { ...args };
    if (context.userId && !mergedArgs.userId) mergedArgs.userId = context.userId;
    if (context.datasetProfileRow && !mergedArgs.datasetProfileRow && entry.needs_dataset_profile) {
      mergedArgs.datasetProfileRow = context.datasetProfileRow;
    }

    // ── run_scenario needs special handling ──────────────────────────────
    // runScenario(userId, scenario, onProgress) expects positional args and
    // a scenario record with a DB-assigned `id`.  The agent loop only passes
    // a flat mergedArgs object, so we must:
    //   1. Create a scenario record via diScenariosService (gives us `id`)
    //   2. Call runScenario with positional args instead of a single object
    if (toolName === 'run_scenario') {
      const userId = mergedArgs.userId;
      const scenarioInput = mergedArgs.scenario || {};

      if (!scenarioInput.base_run_id) {
        return { success: false, error: 'run_scenario requires scenario.base_run_id', toolId: toolName };
      }

      // Ensure the scenario has a DB record with an id
      let scenarioRecord = scenarioInput;
      if (!scenarioInput.id) {
        const { scenario: created, tableNotFound } = await createScenario({
          user_id: userId,
          base_run_id: scenarioInput.base_run_id,
          name: scenarioInput.name || null,
          overrides: scenarioInput.overrides || {},
          engine_flags: scenarioInput.engine_flags || {},
        });
        if (tableNotFound || !created) {
          return { success: false, error: 'Failed to create scenario record (di_scenarios table may not exist)', toolId: toolName };
        }
        scenarioRecord = created;
      }

      const result = await fn(userId, scenarioRecord, mergedArgs.onProgress || null);
      return {
        success: true,
        result: typeof result === 'object' ? result : { value: result },
        toolId: toolName,
        artifactTypes: entry.output_artifacts,
      };
    }

    const result = await fn(mergedArgs);

    return {
      success: true,
      result: typeof result === 'object' ? result : { value: result },
      toolId: toolName,
      artifactTypes: entry.output_artifacts,
    };
  } catch (err) {
    console.error(`[chatToolAdapter] Tool execution failed for ${toolName}:`, err);
    return {
      success: false,
      error: `Tool "${toolName}" failed: ${err.message}`,
      toolId: toolName,
    };
  }
}

/**
 * Find a catalog entry by tool ID.
 */
export function getToolEntry(toolId) {
  return BUILTIN_TOOLS.find((t) => t.id === toolId) || null;
}

// ── Python Analysis Tool Support ────────────────────────────────────────────
// Calls the Python /execute-tool endpoint with analysis_mode for advanced
// statistical analysis (Gini, Lorenz, cross-dimensional groupby, etc.)

const ML_API_BASE = String(import.meta.env.VITE_ML_API_BASE || 'http://localhost:8000');

async function callPythonAnalysisTool(entry, args, context) {
  try {
    const inputData = {
      ...(context.datasetInputData || context.inputData || {}),
      ...(args.input_data || {}),
    };
    const hasInputSheets = Boolean(inputData.sheets && Object.keys(inputData.sheets || {}).length > 0);
    const hasUserProfile = Boolean(context.datasetProfileRow?.profile_json || inputData.datasetProfileId || context.datasetProfileId);
    const datasetProfile = buildPythonDatasetProfile(context, args);
    const dataset = args.dataset || (!hasInputSheets && !hasUserProfile ? 'olist' : null);

    // If user has a profile but no sheets data loaded, warn — analysis may be incomplete
    if (hasUserProfile && !hasInputSheets && !args.dataset) {
      console.warn(
        '[chatToolAdapter] User has dataset profile but no sheet data in context. ' +
        'Raw data may not have been loaded. The analysis may use incomplete data.'
      );
    }
    const body = {
      tool_hint: args.tool_hint || args.query || 'Analyze the dataset',
      analysis_mode: true,
      input_data: inputData,
      prior_artifacts: args.prior_artifacts || {},
      ...(dataset ? { dataset } : {}),
      ...(datasetProfile ? { dataset_profile: datasetProfile } : {}),
    };

    const resp = await fetch(`${ML_API_BASE}/execute-tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(180_000) : undefined,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return { success: false, error: `Python analysis failed (${resp.status}): ${text.slice(0, 500)}`, toolId: entry.id };
    }

    const data = await resp.json();
    if (!data.ok) {
      return { success: false, error: data.error || 'Python analysis returned not ok', toolId: entry.id };
    }

    // Format artifacts as analysis_result_card messages
    const artifacts = data.artifacts || [];
    const dataSourceLabel = context.datasetProfileRow?.profile_json?.file_name
      || dataset
      || null;
    const analysisResults = artifacts
      .filter(a => a.type === 'analysis_result')
      .map(a => {
        const card = a.data;
        if (card && typeof card === 'object') {
          // Attach data source label so the card shows which dataset this is about
          if (dataSourceLabel) card._dataSource = dataSourceLabel;
          // Attach Python execution metadata for transparency
          if (data.code) {
            card._executionMeta = {
              code: data.code,
              execution_ms: data.execution_ms,
              llm_model: data.llm_model,
              engine: 'Python (pandas/numpy/scipy)',
            };
          }
        }
        return card;
      });

    return {
      success: true,
      result: analysisResults.length === 1 ? analysisResults[0] : { analyses: analysisResults, count: analysisResults.length },
      toolId: entry.id,
      artifactTypes: ['analysis_result'],
      _analysisCards: analysisResults, // DSV can render these as cards
    };
  } catch (err) {
    console.error('[chatToolAdapter] Python analysis tool failed:', err);
    return {
      success: false,
      error: `Python analysis failed: ${err.message}`,
      toolId: entry.id,
    };
  }
}

function buildPythonDatasetProfile(context, args) {
  if (args.dataset_profile && typeof args.dataset_profile === 'object') {
    return args.dataset_profile;
  }

  const row = context.datasetProfileRow;
  const profileJson = row?.profile_json || row?.profileJson || context.datasetProfileSummary;
  if (profileJson && typeof profileJson === 'object') {
    return {
      ...(Number.isFinite(Number(row?.id || context.datasetProfileId)) ? { id: Number(row?.id || context.datasetProfileId) } : {}),
      ...(row?.user_file_id || row?.userFileId ? { user_file_id: row?.user_file_id || row?.userFileId } : {}),
      ...profileJson,
    };
  }

  return null;
}

// ── Analysis Workbook Tool Support ──────────────────────────────────────────
// Calls the Python /generate-analysis-workbook endpoint to produce multi-sheet
// Excel workbooks from structured analysis results.

async function callAnalysisWorkbookTool(entry, args, _context) {
  try {
    const body = {
      title: args.title || 'Analysis Report',
      sheets: args.sheets || [],
      methodology_notes: args.methodology_notes || null,
    };

    const resp = await fetch(`${ML_API_BASE}/generate-analysis-workbook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(120_000) : undefined,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return { success: false, error: `Workbook generation failed (${resp.status}): ${text.slice(0, 500)}`, toolId: entry.id };
    }

    // Response is binary xlsx — convert to blob URL for download
    const blob = await resp.blob();
    const filename = args.title
      ? `${args.title.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_')}.xlsx`
      : 'analysis_report.xlsx';
    const url = URL.createObjectURL(blob);

    return {
      success: true,
      result: {
        type: 'analysis_workbook',
        filename,
        download_url: url,
        sheet_count: (args.sheets || []).length,
        message: `Excel workbook "${filename}" generated with ${(args.sheets || []).length} sheets.`,
      },
      toolId: entry.id,
      artifactTypes: ['analysis_workbook'],
    };
  } catch (err) {
    console.error('[chatToolAdapter] Analysis workbook tool failed:', err);
    return {
      success: false,
      error: `Workbook generation failed: ${err.message}`,
      toolId: entry.id,
    };
  }
}

// ── Registered Tool Support ─────────────────────────────────────────────────
// Registered tools are user-approved tools created by the auto-tool-creation
// system. They're stored in toolRegistryService and executed via sandboxed
// AsyncFunction. Tool IDs are prefixed with "reg_" to avoid collisions.

/** Cache of registered tool entries, refreshed periodically */
let _registeredToolsCache = [];
let _registeredToolsCacheTime = 0;
const REGISTERED_CACHE_TTL_MS = 30_000; // 30s

/**
 * Load active registered tools and convert to LLM tool definitions.
 * Uses a short cache to avoid hitting Supabase on every agent loop iteration.
 */
function getRegisteredToolDefinitions() {
  // Synchronous cache check — async loading happens on first call
  if (Date.now() - _registeredToolsCacheTime < REGISTERED_CACHE_TTL_MS) {
    return _registeredToolsCache;
  }

  // Trigger async refresh (non-blocking)
  refreshRegisteredToolsCache();

  return _registeredToolsCache;
}

async function refreshRegisteredToolsCache() {
  try {
    const tools = await listTools({ status: 'active' });
    _registeredToolsCache = (tools || [])
      .filter(t => t.quality_score >= 0.7 && t.code)
      .map(registeredEntryToToolDef);
    _registeredToolsCacheTime = Date.now();
  } catch (err) {
    console.warn('[chatToolAdapter] Failed to load registered tools:', err?.message);
  }
}

/**
 * Convert a registered tool entry into an OpenAI-compatible function definition.
 */
function registeredEntryToToolDef(tool) {
  const properties = {};
  const required = [];

  if (tool.input_schema && typeof tool.input_schema === 'object') {
    for (const [key, desc] of Object.entries(tool.input_schema)) {
      const descStr = String(desc);
      const prop = { type: 'string', description: descStr };

      if (/number/i.test(descStr)) prop.type = 'number';
      else if (/array/i.test(descStr)) { prop.type = 'array'; prop.items = { type: 'object' }; }
      else if (/object/i.test(descStr)) prop.type = 'object';
      else if (/boolean/i.test(descStr)) prop.type = 'boolean';

      if (!/optional|null/i.test(descStr)) required.push(key);
      properties[key] = prop;
    }
  }

  return {
    type: 'function',
    function: {
      name: `reg_${tool.id}`,
      description: `[Registered Tool] ${tool.name}: ${tool.description}`,
      parameters: {
        type: 'object',
        properties,
        required,
      },
    },
  };
}

/**
 * Execute a registered tool by loading its code and running in a sandboxed
 * AsyncFunction. Only approved, active tools can be executed.
 *
 * Security: The code runs via `new AsyncFunction('input', code)` which creates
 * a function scope without access to imports, require, fetch, or DOM.
 *
 * @param {string} toolId - The registered tool ID (without "reg_" prefix)
 * @param {object} args - Arguments from the LLM
 * @returns {Promise<{ success: boolean, result?: any, error?: string }>}
 */
async function executeRegisteredTool(toolId, args) {
  const tool = await getToolById(toolId);

  if (!tool) {
    return { success: false, error: `Registered tool "${toolId}" not found` };
  }
  if (tool.status !== 'active') {
    return { success: false, error: `Registered tool "${toolId}" is not active (status: ${tool.status})` };
  }
  if (!tool.code) {
    return { success: false, error: `Registered tool "${toolId}" has no code` };
  }

  // Validate code doesn't contain dangerous patterns
  const dangerousPatterns = [
    /\bimport\s*\(/,        // dynamic import
    /\brequire\s*\(/,       // CommonJS require
    /\bfetch\s*\(/,         // network access
    /\beval\s*\(/,          // eval
    /\bFunction\s*\(/,      // Function constructor
    /\bdocument\b/,         // DOM access
    /\bwindow\b/,           // window access
    /\blocalStorage\b/,     // storage access
    /\bsessionStorage\b/,
    /\bglobalThis\b/,
    /\bprocess\b/,          // Node.js process
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(tool.code)) {
      return {
        success: false,
        error: `Registered tool "${toolId}" contains forbidden code pattern: ${pattern}`,
      };
    }
  }

  try {
    // Create sandboxed async function
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction('input', tool.code);

    const result = await fn(args);

    // Track usage
    incrementUsage(toolId).catch(() => {});

    return {
      success: true,
      result: typeof result === 'object' ? result : { value: result },
      toolId: `reg_${toolId}`,
      artifactTypes: [],
    };
  } catch (err) {
    console.error(`[chatToolAdapter] Registered tool execution failed for ${toolId}:`, err);
    return {
      success: false,
      error: `Registered tool "${toolId}" failed: ${err.message}`,
      toolId: `reg_${toolId}`,
    };
  }
}

/**
 * Force-refresh the registered tools cache (e.g., after approving a new tool).
 */
export async function invalidateRegisteredToolsCache() {
  _registeredToolsCacheTime = 0;
  await refreshRegisteredToolsCache();
}
