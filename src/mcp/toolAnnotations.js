// @product: mcp-server
//
// toolAnnotations.js
// Maps tool categories to MCP tool annotations (spec 2025-03-26+).
// Annotations help AI clients understand tool behavior without executing them.

import { TOOL_CATEGORY } from '../services/ai-infra/builtinToolCatalog.js';

// Categories whose tools only read data and never mutate state
const READ_ONLY_CATEGORIES = new Set([
  TOOL_CATEGORY.DATA_ACCESS,
  TOOL_CATEGORY.ANALYTICS,
  TOOL_CATEGORY.MONITORING,
  TOOL_CATEGORY.UTILITY,
]);

// Categories whose tools commit state changes (approvals, exports, etc.)
const DESTRUCTIVE_CATEGORIES = new Set([
  TOOL_CATEGORY.GOVERNANCE,
]);

// Categories whose tools interact with external systems (Python API, ERP, etc.)
const OPEN_WORLD_CATEGORIES = new Set([
  // None by default — Python tools are flagged individually via isPython
]);

/**
 * Derive MCP tool annotations from a catalog tool entry.
 *
 * @param {{ category: string, isPython?: boolean }} tool
 * @returns {{ readOnlyHint: boolean, destructiveHint: boolean, idempotentHint: boolean, openWorldHint: boolean }}
 */
export function getToolAnnotations(tool) {
  const cat = tool.category;

  return {
    readOnlyHint: READ_ONLY_CATEGORIES.has(cat),
    destructiveHint: DESTRUCTIVE_CATEGORIES.has(cat),
    idempotentHint: !DESTRUCTIVE_CATEGORIES.has(cat),
    openWorldHint: tool.isPython === true,
  };
}
