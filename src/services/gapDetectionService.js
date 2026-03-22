/**
 * gapDetectionService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects when the agent loop hits a tool capability gap — e.g., a data format
 * mismatch, a missing adapter, or a broken tool chain — and produces a
 * structured gap description that can feed into the Tool Blueprint Generator.
 *
 * Integrated into chatAgentLoop.js: when a tool call fails, the agent loop
 * calls detectToolGap() to decide whether auto-tool-creation should kick in.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { SAP_TABLE_REGISTRY } from './sapDataQueryService.js';
import { BUILTIN_TOOLS } from './builtinToolCatalog.js';

// ── Gap Type Enum ───────────────────────────────────────────────────────────

export const GAP_TYPE = {
  FORMAT_MISMATCH: 'format_mismatch',  // Data exists but format doesn't match tool input
  MISSING_TOOL: 'missing_tool',        // No tool exists for the requested operation
  CHAIN_BREAK: 'chain_break',          // Tool chain has a gap between two steps
};

// ── Error Pattern Matchers ──────────────────────────────────────────────────

const FORMAT_MISMATCH_PATTERNS = [
  /format/i, /schema/i, /mismatch/i, /expected.*but.*got/i,
  /invalid.*input/i, /missing.*column/i, /missing.*field/i,
  /cannot.*convert/i, /incompatible/i, /transform/i,
  /demand_fg|material_code|plant_id|time_bucket/i,
  /dataset.*not.*compatible/i, /wrong.*format/i,
];

const MISSING_TOOL_PATTERNS = [
  /unknown tool/i, /not found/i, /no.*tool.*for/i,
  /not.*supported/i, /not.*available/i, /no.*adapter/i,
];

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Analyze a failed tool call and determine if it represents a capability gap
 * that could be solved by auto-creating a new tool.
 *
 * @param {object} params
 * @param {string} params.taskDescription - The user's original request
 * @param {object} params.toolCallResult  - The failed tool call result { success, error, toolId }
 * @param {string} params.toolName        - The tool that was called
 * @param {object} params.toolArgs        - The args passed to the tool
 * @param {Array}  params.availableTools  - Current tool definitions
 * @returns {{ hasGap: boolean, gapType: string|null, gapDescription: string|null, sourceSchema: object|null, targetSchema: object|null, suggestedToolName: string|null }}
 */
export function detectToolGap({ taskDescription, toolCallResult, toolName, toolArgs, availableTools }) {
  if (!toolCallResult || toolCallResult.success) {
    return { hasGap: false };
  }

  const error = toolCallResult.error || '';

  // ── Check for format mismatch ──
  if (FORMAT_MISMATCH_PATTERNS.some(p => p.test(error))) {
    const source = inferSourceSchema(toolArgs, taskDescription);
    const target = inferTargetSchema(toolName);

    return {
      hasGap: true,
      gapType: GAP_TYPE.FORMAT_MISMATCH,
      gapDescription: `Tool "${toolName}" failed because the input data format doesn't match. Error: ${error}`,
      sourceSchema: source,
      targetSchema: target,
      suggestedToolName: generateAdapterName(source, target, toolName),
      failedToolId: toolName,
      failedToolArgs: toolArgs,
      userIntent: taskDescription,
    };
  }

  // ── Check for missing tool ──
  if (MISSING_TOOL_PATTERNS.some(p => p.test(error))) {
    return {
      hasGap: true,
      gapType: GAP_TYPE.MISSING_TOOL,
      gapDescription: `No tool found for: ${error}. User request: "${taskDescription}"`,
      sourceSchema: null,
      targetSchema: null,
      suggestedToolName: null,
      failedToolId: toolName,
      failedToolArgs: toolArgs,
      userIntent: taskDescription,
    };
  }

  // ── Check for chain break (tool succeeded but output can't feed next step) ──
  // This is detected heuristically from the task description mentioning multi-step
  const chainKeywords = /then|然後|接著|再|pipe|chain|→|->|feed.*into|pass.*to/i;
  if (chainKeywords.test(taskDescription) && error) {
    return {
      hasGap: true,
      gapType: GAP_TYPE.CHAIN_BREAK,
      gapDescription: `Tool chain broken at "${toolName}": ${error}. User wanted a multi-step pipeline.`,
      sourceSchema: null,
      targetSchema: inferTargetSchema(toolName),
      suggestedToolName: null,
      failedToolId: toolName,
      failedToolArgs: toolArgs,
      userIntent: taskDescription,
    };
  }

  // Not a gap we can auto-fix
  return { hasGap: false };
}

/**
 * Proactively detect gaps BEFORE a tool call fails.
 * Called by the agent loop when the LLM's plan mentions data transformation
 * that no existing tool handles.
 *
 * @param {string} userMessage - The user's request
 * @param {Array}  toolDefs    - Available tool definitions
 * @returns {{ hasGap: boolean, gapType: string|null, gapDescription: string|null }}
 */
export function detectProactiveGap(userMessage, toolDefs) {
  if (!userMessage) return { hasGap: false };

  const lower = userMessage.toLowerCase();
  const toolIds = new Set((toolDefs || []).map(t => t.function?.name).filter(Boolean));

  // Detect: user wants to use Olist data for forecasting
  const wantsOlistForecast =
    (/olist|order_items|orders/i.test(lower)) &&
    (/forecast|predict|預測/i.test(lower));

  if (wantsOlistForecast && !toolIds.has('olist_to_demand_fg')) {
    return {
      hasGap: true,
      gapType: GAP_TYPE.FORMAT_MISMATCH,
      gapDescription: 'User wants to use Olist e-commerce order data for forecasting, but no adapter exists to convert Olist orders into the demand_fg format required by the forecast engine.',
      sourceSchema: {
        name: 'Olist order_items + orders',
        tables: ['order_items', 'orders', 'products'],
        columns: SAP_TABLE_REGISTRY.order_items?.columns || [],
      },
      targetSchema: {
        name: 'demand_fg (forecast engine input)',
        columns: ['material_code', 'plant_id', 'time_bucket', 'demand_qty'],
        description: 'Monthly aggregated demand by product and location',
      },
      suggestedToolName: 'olist_to_demand_fg',
      userIntent: userMessage,
    };
  }

  return { hasGap: false };
}

// ── Internal Helpers ────────────────────────────────────────────────────────

function inferSourceSchema(toolArgs, taskDescription) {
  // Try to figure out what data source the user is working with
  const lower = (taskDescription || '').toLowerCase();

  if (/olist|order_items|orders|customers|products|sellers/i.test(lower)) {
    const tables = Object.keys(SAP_TABLE_REGISTRY).filter(t =>
      lower.includes(t) || lower.includes(t.replace(/_/g, ' '))
    );
    return {
      name: 'SAP/Olist tables',
      tables: tables.length ? tables : ['orders', 'order_items'],
      columns: tables.length
        ? tables.flatMap(t => SAP_TABLE_REGISTRY[t]?.columns || [])
        : [...(SAP_TABLE_REGISTRY.orders?.columns || []), ...(SAP_TABLE_REGISTRY.order_items?.columns || [])],
    };
  }

  return { name: 'unknown', tables: [], columns: [] };
}

function inferTargetSchema(toolName) {
  const entry = BUILTIN_TOOLS.find(t => t.id === toolName);
  if (!entry) return null;

  return {
    name: entry.name,
    toolId: entry.id,
    inputSchema: entry.input_schema,
    description: entry.description,
  };
}

function generateAdapterName(source, target, toolName) {
  if (!source || !target) return null;

  const sourceName = (source.tables?.[0] || 'data').replace(/[^a-z0-9]/gi, '_');
  const targetName = (toolName || 'output').replace(/[^a-z0-9]/gi, '_');
  return `${sourceName}_to_${targetName}_adapter`;
}
