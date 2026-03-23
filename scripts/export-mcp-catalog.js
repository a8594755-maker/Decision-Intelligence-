#!/usr/bin/env node
// @product: openclaw-integration
//
// export-mcp-catalog.js
// ─────────────────────────────────────────────────────────────────────────────
// Reads BUILTIN_TOOLS from builtinToolCatalog.js and exports an MCP-compatible
// JSON tool catalog for the Python MCP server to consume.
//
// Usage:
//   node scripts/export-mcp-catalog.js
//   → writes openclaw/mcp-tool-catalog.json
// ─────────────────────────────────────────────────────────────────────────────

import { BUILTIN_TOOLS, TOOL_CATEGORY } from '../src/services/builtinToolCatalog.js';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = resolve(__dirname, '..', 'openclaw', 'mcp-tool-catalog.json');

// ── Input schema type → JSON Schema type mapping ──────────────────────────

function inferJsonSchemaType(typeStr) {
  if (!typeStr || typeof typeStr !== 'string') return { type: 'string' };
  const lower = typeStr.toLowerCase();
  if (lower.startsWith('number'))  return { type: 'number' };
  if (lower.startsWith('boolean')) return { type: 'boolean' };
  if (lower.startsWith('array'))   return { type: 'array' };
  if (lower.startsWith('object'))  return { type: 'object' };
  if (lower.startsWith("'"))       return { type: 'string', description: typeStr };
  return { type: 'string', description: typeStr };
}

// ── Convert a single BuiltinTool → MCP tool definition ───────────────────

function toMcpTool(tool) {
  // Build JSON Schema properties from input_schema
  const properties = {};
  const required = [];

  for (const [key, typeDesc] of Object.entries(tool.input_schema || {})) {
    const schema = inferJsonSchemaType(typeDesc);
    schema.description = typeDesc;
    properties[key] = schema;

    // Fields without '|null', 'optional', or 'default' are required
    const isOptional = /null|optional|default/i.test(typeDesc);
    if (!isOptional) {
      required.push(key);
    }
  }

  // Determine routing target
  let routingTarget;
  if (tool.module === '__python_api__') {
    routingTarget = tool.method; // e.g. 'POST /demand-forecast'
  } else {
    routingTarget = 'mcp-intake'; // Route through orchestrator intake
  }

  return {
    name: `di_${tool.id}`,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    },
    // ── DI-specific metadata (not part of MCP spec, used by our MCP server) ──
    _di_meta: {
      tool_id: tool.id,
      category: tool.category,
      tier: tool.tier,
      module: tool.module,
      method: tool.method,
      routing_target: routingTarget,
      depends_on: tool.depends_on,
      output_artifacts: tool.output_artifacts,
      required_datasets: tool.required_datasets,
      needs_dataset_profile: tool.needs_dataset_profile,
      keywords_en: tool.keywords_en,
      keywords_zh: tool.keywords_zh,
    },
  };
}

// ── Main ──────────────────────────────────────────────────────────────────

const mcpTools = BUILTIN_TOOLS.map(toMcpTool);

const catalog = {
  _generated: new Date().toISOString(),
  _source: 'src/services/builtinToolCatalog.js',
  _description: 'Auto-generated MCP tool catalog for OpenClaw integration. Do not edit manually.',
  version: '1.0.0',
  tool_count: mcpTools.length,
  categories: Object.values(TOOL_CATEGORY),
  tools: mcpTools,
};

mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
writeFileSync(OUTPUT_PATH, JSON.stringify(catalog, null, 2), 'utf-8');

console.log(`✓ Exported ${mcpTools.length} tools to ${OUTPUT_PATH}`);

// ── Summary ───────────────────────────────────────────────────────────────
const byCat = {};
for (const t of BUILTIN_TOOLS) {
  byCat[t.category] = (byCat[t.category] || 0) + 1;
}
console.log('\nBy category:');
for (const [cat, count] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${cat}: ${count}`);
}

const pythonTools = BUILTIN_TOOLS.filter(t => t.module === '__python_api__');
const jsTools = BUILTIN_TOOLS.filter(t => t.module !== '__python_api__');
console.log(`\nRouting: ${pythonTools.length} → Python API direct, ${jsTools.length} → MCP intake`);
