/**
 * toolBlueprintGenerator.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Given a gap description (from gapDetectionService), uses an LLM to generate
 * a tool blueprint: name, description, JS code, I/O schema, and test cases.
 *
 * The generated code is a pure function (no imports, no side effects, no DOM)
 * that transforms data from one format to another. It will be executed via
 * `new AsyncFunction()` in a sandboxed context.
 *
 * Flow:
 *   gapDetectionService.detectToolGap()
 *     → toolBlueprintGenerator.generateToolBlueprint()
 *       → ToolBlueprintCard (user reviews)
 *         → toolRegistryService.registerTool() (on approve)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { invokeAiProxy } from './aiProxyService.js';
import { BUILTIN_TOOLS } from './builtinToolCatalog.js';
import { SAP_TABLE_REGISTRY } from './sapDataQueryService.js';

// ── Constants ────────────────────────────────────────────────────────────────

const BLUEPRINT_MODEL = import.meta.env.VITE_DI_CHAT_MODEL || 'gpt-5.4';
const BLUEPRINT_PROVIDER = import.meta.env.VITE_DI_CHAT_PROVIDER || 'openai';

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Generate a tool blueprint from a detected gap.
 *
 * @param {object} gap - Output from detectToolGap() or detectProactiveGap()
 * @param {string} gap.gapType - 'format_mismatch' | 'missing_tool' | 'chain_break'
 * @param {string} gap.gapDescription - Human-readable gap description
 * @param {object} [gap.sourceSchema] - Source data schema
 * @param {object} [gap.targetSchema] - Target data schema
 * @param {string} [gap.suggestedToolName] - Suggested name for the tool
 * @param {string} [gap.userIntent] - The user's original request
 * @returns {Promise<ToolBlueprint>}
 */
export async function generateToolBlueprint(gap) {
  const systemPrompt = buildBlueprintSystemPrompt(gap);
  const userPrompt = buildBlueprintUserPrompt(gap);

  const toolsMode = BLUEPRINT_PROVIDER === 'openai' ? 'openai_chat'
    : BLUEPRINT_PROVIDER === 'anthropic' ? 'anthropic_chat'
    : 'deepseek_chat';

  const result = await invokeAiProxy(toolsMode, {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    model: BLUEPRINT_MODEL,
    temperature: 0.2,
    maxOutputTokens: 4096,
  });

  const rawText = result?.choices?.[0]?.message?.content || result?.text || '';

  // Parse the LLM's JSON response
  const blueprint = parseBlueprint(rawText, gap);

  return blueprint;
}

// ── Prompt Builders ─────────────────────────────────────────────────────────

function buildBlueprintSystemPrompt(gap) {
  const tableSchemas = Object.entries(SAP_TABLE_REGISTRY)
    .map(([name, entry]) => `  ${name}: [${entry.columns.join(', ')}]`)
    .join('\n');

  const existingTools = BUILTIN_TOOLS
    .filter(t => t.module !== '__python_api__')
    .map(t => `  ${t.id}: ${t.name} — input: ${JSON.stringify(t.input_schema)}`)
    .join('\n');

  return `You are a tool-building AI that creates JavaScript data transformation functions.

Your job is to generate a PURE FUNCTION that bridges a data format gap.

RULES FOR GENERATED CODE:
1. The function receives a single argument "input" (an object).
2. It must return a result object with { success: true, data: ... } or { success: false, error: "..." }.
3. It must be a PURE FUNCTION: no imports, no require, no fetch, no DOM, no eval, no global state.
4. Use only standard JS: Array methods, Object methods, Date, Math, JSON, String, RegExp.
5. Handle edge cases gracefully (empty arrays, missing fields, null values).
6. Include inline comments explaining the transformation logic.
7. The code must work as the body of: new AsyncFunction('input', CODE)

AVAILABLE DATA TABLES (SAP/Olist):
${tableSchemas}

EXISTING TOOLS:
${existingTools}

RESPONSE FORMAT — respond with ONLY valid JSON (no markdown fences):
{
  "name": "tool_name_snake_case",
  "description": "One-line description of what this tool does",
  "category": "transform",
  "code": "// JS code as a string\\nconst data = input.data;\\n...",
  "inputSchema": { "param_name": "type description" },
  "outputSchema": { "result_field": "type description" },
  "tags": ["tag1", "tag2"],
  "testCase": {
    "input": { "data": [{"example": "row"}] },
    "expectedFields": ["field1", "field2"]
  }
}`;
}

function buildBlueprintUserPrompt(gap) {
  const parts = [`GAP DETECTED: ${gap.gapDescription}`];

  if (gap.sourceSchema) {
    parts.push(`\nSOURCE DATA SCHEMA:\n${JSON.stringify(gap.sourceSchema, null, 2)}`);
  }
  if (gap.targetSchema) {
    parts.push(`\nTARGET FORMAT REQUIRED:\n${JSON.stringify(gap.targetSchema, null, 2)}`);
  }
  if (gap.suggestedToolName) {
    parts.push(`\nSUGGESTED TOOL NAME: ${gap.suggestedToolName}`);
  }
  if (gap.userIntent) {
    parts.push(`\nUSER'S ORIGINAL REQUEST: "${gap.userIntent}"`);
  }

  parts.push('\nGenerate a tool blueprint that bridges this gap. Return ONLY the JSON object.');

  return parts.join('\n');
}

// ── Response Parser ─────────────────────────────────────────────────────────

function parseBlueprint(rawText, gap) {
  // Try to extract JSON from the response (handle markdown fences)
  let jsonStr = rawText.trim();

  // Remove markdown code fences if present
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    // Fallback: try to find JSON object in the text
    const objMatch = rawText.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try {
        parsed = JSON.parse(objMatch[0]);
      } catch {
        // Give up — return a placeholder
        return buildFallbackBlueprint(gap);
      }
    } else {
      return buildFallbackBlueprint(gap);
    }
  }

  // Validate required fields
  if (!parsed.name || !parsed.code) {
    return buildFallbackBlueprint(gap);
  }

  return {
    name: sanitizeName(parsed.name),
    description: parsed.description || gap.gapDescription || 'Auto-generated data adapter',
    category: parsed.category || 'transform',
    code: parsed.code,
    inputSchema: parsed.inputSchema || {},
    outputSchema: parsed.outputSchema || {},
    tags: Array.isArray(parsed.tags) ? parsed.tags : ['auto-generated', 'adapter'],
    testCase: parsed.testCase || null,
    gapType: gap.gapType,
    gapDescription: gap.gapDescription,
    generatedAt: new Date().toISOString(),
  };
}

function buildFallbackBlueprint(gap) {
  return {
    name: gap.suggestedToolName || 'auto_adapter',
    description: gap.gapDescription || 'Auto-generated data adapter',
    category: 'transform',
    code: '// Auto-generation failed — please write the adapter code manually.\nreturn { success: false, error: "Blueprint generation failed. Please provide the transformation logic." };',
    inputSchema: {},
    outputSchema: {},
    tags: ['auto-generated', 'needs-manual-edit'],
    testCase: null,
    gapType: gap.gapType,
    gapDescription: gap.gapDescription,
    generatedAt: new Date().toISOString(),
    generationFailed: true,
  };
}

function sanitizeName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 64);
}
