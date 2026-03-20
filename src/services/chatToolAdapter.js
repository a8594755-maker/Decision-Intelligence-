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

import { BUILTIN_TOOLS } from './builtinToolCatalog.js';

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

/**
 * Get all tool definitions suitable for LLM function calling.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.categories] - Only include tools from these categories
 * @param {string[]} [opts.toolIds] - Only include these tool IDs
 * @param {boolean}  [opts.excludePython] - Skip Python API tools (default: true)
 * @returns {Array} OpenAI-format tool definitions
 */
export function getToolDefinitions(opts = {}) {
  const { categories, toolIds, excludePython = true } = opts;

  let tools = BUILTIN_TOOLS;

  if (excludePython) {
    tools = tools.filter((t) => t.module !== '__python_api__');
  }
  if (categories?.length) {
    tools = tools.filter((t) => categories.includes(t.category));
  }
  if (toolIds?.length) {
    tools = tools.filter((t) => toolIds.includes(t.id));
  }

  return tools.map(catalogEntryToToolDef);
}

/**
 * Get a lightweight summary of available tools for the system prompt.
 * This helps the LLM understand what it can do without sending full schemas.
 */
export function getToolSummaryForPrompt() {
  const lines = BUILTIN_TOOLS
    .filter((t) => t.module !== '__python_api__')
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
  const entry = BUILTIN_TOOLS.find((t) => t.id === toolName);
  if (!entry) {
    return { success: false, error: `Unknown tool: ${toolName}` };
  }

  // Python API tools need special handling
  if (entry.module === '__python_api__') {
    return { success: false, error: `Python API tool "${toolName}" is not supported in chat agent mode yet.` };
  }

  try {
    // Dynamic import of the tool's module
    let mod = _moduleCache.get(entry.module);
    if (!mod) {
      mod = await import(/* @vite-ignore */ entry.module);
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
