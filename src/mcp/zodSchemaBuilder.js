// @product: mcp-server
//
// zodSchemaBuilder.js
// Converts catalog input_schema informal type strings to Zod schemas.
// Used by McpServer.registerTool() which requires Zod input schemas.

import { z } from 'zod';

/**
 * Convert a single catalog type string (e.g. 'string', 'number|null') to a Zod schema.
 * Returns null for function types (callbacks like onProgress) which should be skipped.
 *
 * @param {string} typeStr - Informal type string from catalog input_schema
 * @returns {import('zod').ZodType | null}
 */
function catalogTypeToZod(typeStr) {
  if (!typeStr || typeof typeStr !== 'string') return z.string().optional();

  const lower = typeStr.toLowerCase();

  // Skip function/callback params — not callable via MCP
  if (lower.startsWith('function')) return null;

  // Handle nullable types: 'number|null (forecast horizon)'
  if (lower.includes('|null')) {
    const base = lower.split('|')[0].trim();
    const inner = catalogTypeToZod(base);
    if (!inner) return null;
    return inner.nullable().optional().describe(typeStr);
  }

  // Enum-like: "'on'|'off' (default 'off')"
  if (typeStr.includes("'")) {
    const matches = typeStr.match(/'([^']+)'/g);
    if (matches && matches.length >= 2) {
      const values = matches.map(m => m.replace(/'/g, ''));
      return z.enum(values).optional().describe(typeStr);
    }
  }

  if (lower.startsWith('array'))   return z.array(z.unknown()).optional().describe(typeStr);
  if (lower.startsWith('object'))  return z.record(z.string(), z.unknown()).optional().describe(typeStr);
  if (lower.startsWith('number'))  return z.number().optional().describe(typeStr);
  if (lower.startsWith('boolean')) return z.boolean().optional().describe(typeStr);

  // Default: string
  return z.string().optional().describe(typeStr);
}

/**
 * Build a Zod object schema from a catalog tool's input_schema.
 *
 * @param {Object} inputSchema - The tool's input_schema object (key → type string)
 * @returns {import('zod').ZodObject}
 */
export function buildZodSchema(inputSchema) {
  if (!inputSchema || typeof inputSchema !== 'object') {
    return z.object({});
  }

  const shape = {};
  for (const [key, typeStr] of Object.entries(inputSchema)) {
    const zodType = catalogTypeToZod(typeStr);
    if (!zodType) continue; // skip function params
    shape[key] = zodType;
  }

  return z.object(shape);
}
