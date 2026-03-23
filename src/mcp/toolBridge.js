// @product: mcp-server
//
// toolBridge.js
// ─────────────────────────────────────────────────────────────────────────────
// Converts builtinToolCatalog entries into MCP-compatible tool definitions.
// Each catalog tool becomes an MCP tool with a proper JSON Schema input.
// ─────────────────────────────────────────────────────────────────────────────

import { BUILTIN_TOOLS, isPythonApiTool } from '../services/builtinToolCatalog.js';

// ── Schema type mapping ────────────────────────────────────────────────────
// The catalog uses informal type strings like 'string', 'number|null',
// 'object (from datasetProfilesService)'. We convert these to JSON Schema.

function catalogTypeToJsonSchema(typeStr) {
  if (!typeStr || typeof typeStr !== 'string') return { type: 'string' };

  const lower = typeStr.toLowerCase();

  if (lower.startsWith('array'))  return { type: 'array', description: typeStr };
  if (lower.startsWith('object')) return { type: 'object', description: typeStr };
  if (lower.startsWith('number')) return { type: 'number', description: typeStr };
  if (lower.startsWith('boolean')) return { type: 'boolean' };
  if (lower.startsWith('function')) return null; // skip callbacks
  if (lower.includes('|null')) {
    const base = lower.split('|')[0].trim();
    const inner = catalogTypeToJsonSchema(base);
    if (!inner) return null;
    return { ...inner, description: typeStr };
  }
  // Enum-like: "'on'|'off' (default 'off')"
  if (lower.includes("'")) {
    const matches = typeStr.match(/'([^']+)'/g);
    if (matches) {
      return { type: 'string', enum: matches.map(m => m.replace(/'/g, '')), description: typeStr };
    }
  }
  return { type: 'string', description: typeStr };
}

function buildInputSchema(tool) {
  const properties = {};
  const required = [];

  if (!tool.input_schema) return { type: 'object', properties: {} };

  for (const [key, typeStr] of Object.entries(tool.input_schema)) {
    const schema = catalogTypeToJsonSchema(typeStr);
    if (!schema) continue; // skip function params
    properties[key] = schema;
    // userId is always required; others with 'null' or 'optional' are optional
    const lower = (typeStr || '').toLowerCase();
    if (key === 'userId' || (!lower.includes('null') && !lower.includes('optional') && !lower.includes('default'))) {
      required.push(key);
    }
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

// ── Convert catalog → MCP tool list ────────────────────────────────────────

export function catalogToMcpTools() {
  return BUILTIN_TOOLS.map(tool => ({
    name: tool.id,
    description: buildToolDescription(tool),
    inputSchema: buildInputSchema(tool),
  }));
}

function buildToolDescription(tool) {
  const parts = [tool.description];
  if (tool.depends_on.length > 0) {
    parts.push(`Requires: ${tool.depends_on.join(', ')}.`);
  }
  if (tool.output_artifacts.length > 0) {
    parts.push(`Produces: ${tool.output_artifacts.join(', ')}.`);
  }
  parts.push(`Category: ${tool.category}.`);
  return parts.join(' ');
}

// ── Resolve a catalog tool for execution ───────────────────────────────────

export function getToolMeta(toolId) {
  const tool = BUILTIN_TOOLS.find(t => t.id === toolId);
  if (!tool) return null;
  return {
    ...tool,
    isPython: isPythonApiTool(toolId),
  };
}

export default { catalogToMcpTools, getToolMeta };
