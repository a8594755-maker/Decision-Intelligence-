/**
 * generalAgentLoop.js — JS General Agent Loop
 *
 * Same architecture as Python agent_entry.py, but can run ALL 63 tools:
 *   1. Tool Selection (LLM Call #1 — pick 3-8 tools)
 *   2. Execute tools (deterministic — via builtinToolExecutor or chatToolAdapter)
 *   3. Synthesize narrative (LLM Call #2 — facts → narrative)
 *
 * Uses existing infrastructure:
 *   - chatToolAdapter.executeTool() for dispatch (JS direct + Python HTTP)
 *   - invokeAiProxy for LLM calls (DeepSeek via Supabase)
 *   - builtinToolCatalog for tool metadata + dependency resolution
 */

import { BUILTIN_TOOLS, findToolsByQuery, resolveDependencies, isPythonApiTool } from '../ai-infra/builtinToolCatalog.js';
import { executeTool } from './chatToolAdapter.js';
import { invokeAiProxy } from '../ai-infra/aiProxyService.js';

// ── Tool Index (compact, for LLM selector prompt) ──────────────────────────

function buildToolIndex() {
  return BUILTIN_TOOLS.map(t => {
    const deps = t.depends_on.length ? ` Requires: ${t.depends_on.join(', ')}.` : '';
    return `${t.id}: ${t.description.slice(0, 100)}${deps}`;
  }).join('\n');
}

const TOOL_INDEX = buildToolIndex();

// ── LLM Call #1: Tool Selection ────────────────────────────────────────────

const SELECTOR_SYSTEM = 'You are a tool selector. Return ONLY valid JSON.';

const SELECTOR_PROMPT = `Select 3-8 analysis tools to answer the user's question.

## Available Tools
{tool_index}

## User's Data
{data_summary}

## User's Question
{query}

## Rules
1. Select ONLY tools whose required data exists
2. Dependencies are resolved automatically — just pick what you need
3. For MBR analysis with Excel data: prefer run_mbr_* tools
4. Do NOT mix overlapping tools: run_mbr_anomaly and run_anomaly_detection — pick ONE
5. Do NOT select run_eda or run_auto_insights when run_mbr_* tools are selected
6. Minimum 1 tool, maximum 8 tools

Return JSON: {"tools": ["tool_id_1", "tool_id_2", ...], "reasoning": "..."}`;


async function selectTools(query, dataSummary) {
  const prompt = SELECTOR_PROMPT
    .replace('{tool_index}', TOOL_INDEX)
    .replace('{data_summary}', dataSummary)
    .replace('{query}', query);

  try {
    const raw = await invokeAiProxy('deepseek_chat', {
      message: prompt,
      systemPrompt: SELECTOR_SYSTEM,
      temperature: 0.1,
      maxOutputTokens: 1000,
    });

    const text = (raw?.text || '').trim();
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    if (s < 0 || e <= s) return { tools: [], reasoning: 'No JSON in response' };

    const parsed = JSON.parse(text.slice(s, e + 1));
    const validIds = new Set(BUILTIN_TOOLS.map(t => t.id));
    const tools = (parsed.tools || []).filter(id => validIds.has(id));

    // Resolve dependencies
    const resolved = resolveDependencies(tools);
    return { tools: resolved.slice(0, 10), reasoning: parsed.reasoning || '' };
  } catch (err) {
    console.error('[GeneralAgent] Tool selection failed:', err);
    return { tools: [], reasoning: `Error: ${err.message}` };
  }
}

// ── Tool Execution ─────────────────────────────────────────────────────────

async function executeTools(toolIds, context, onStep) {
  const results = {};
  const findingsChain = [];
  const allArtifacts = [];
  const stepsLog = [];

  for (let i = 0; i < toolIds.length; i++) {
    const toolId = toolIds[i];

    if (onStep) onStep({ type: 'tool_start', tool_id: toolId, step_index: i, total_steps: toolIds.length });

    const t0 = Date.now();
    try {
      const result = await executeTool(toolId, context.args || {}, context);
      const durationMs = Date.now() - t0;

      results[toolId] = result;

      // Extract findings summary
      const summary = summarizeResult(toolId, result);
      findingsChain.push([toolId, summary]);

      // Collect artifacts
      if (result.result?.artifacts) {
        allArtifacts.push(...result.result.artifacts);
      }

      stepsLog.push({ tool: toolId, duration_ms: durationMs, status: result.success ? 'success' : 'error', summary: summary.slice(0, 200) });

      if (onStep) {
        if (summary) onStep({ type: 'tool_finding', tool_id: toolId, finding: summary.slice(0, 200) });
        onStep({ type: 'tool_done', tool_id: toolId, duration_ms: durationMs, status: result.success ? 'success' : 'error' });
      }
    } catch (err) {
      const durationMs = Date.now() - t0;
      stepsLog.push({ tool: toolId, duration_ms: durationMs, status: 'error', error: err.message });
      if (onStep) onStep({ type: 'tool_error', tool_id: toolId, error: err.message, duration_ms: durationMs });
    }
  }

  return { results, findingsChain, allArtifacts, stepsLog };
}

function summarizeResult(toolId, result) {
  if (!result.success) return `${toolId}: error — ${result.error || 'unknown'}`;
  const r = result.result || {};
  // Try common result shapes
  if (r.result && typeof r.result === 'object') {
    const keys = Object.entries(r.result).slice(0, 5).map(([k, v]) => `${k}: ${v}`).join(' | ');
    return keys || `${toolId}: completed`;
  }
  if (r.artifacts?.length) return `${toolId}: ${r.artifacts.length} artifacts`;
  return `${toolId}: completed`;
}

// ── LLM Call #2: Synthesis ─────────────────────────────────────────────────

const SYNTH_SYSTEM = `You are a senior business analyst writing an executive summary.
Rules:
1. ONLY state facts from the findings below — do NOT invent numbers
2. Structure: Summary → Key Metrics → Issues Found → Recommendations
3. If multiple currencies detected, write "mixed currency"
4. Keep it concise — max 500 words
5. Write in English`;

async function synthesize(findingsChain) {
  let factsText = '';
  for (const [toolId, facts] of findingsChain) {
    if (facts && facts.trim()) factsText += `\n### ${toolId}\n${facts}\n`;
  }

  if (!factsText.trim()) return 'No analysis results were produced.';

  try {
    const raw = await invokeAiProxy('deepseek_chat', {
      message: `## Analysis Findings\n${factsText}\n\nWrite the executive summary now.`,
      systemPrompt: SYNTH_SYSTEM,
      temperature: 0.3,
      maxOutputTokens: 2000,
    });
    return (raw?.text || '').trim() || 'Synthesis failed — no response from LLM.';
  } catch (err) {
    console.error('[GeneralAgent] Synthesis failed:', err);
    // Fallback: concatenate facts
    return `## Analysis Summary (LLM synthesis failed)\n\n${factsText}`;
  }
}

// ── Main Entry Point ───────────────────────────────────────────────────────

/**
 * Run the JS General Agent Loop.
 *
 * @param {object} params
 * @param {string} params.query - User's natural language question
 * @param {object} params.context - Runtime context (userId, datasetProfileRow, sheets, etc.)
 * @param {function} [params.onStep] - Callback for progress events
 * @returns {Promise<object>} - { narrative, tools_used, steps_log, all_artifacts }
 */
export async function runGeneralAgent({ query, context = {}, onStep }) {
  const t0 = Date.now();

  // Build data summary for tool selector
  const dataSummary = buildDataSummary(context);

  // ── Step 1: LLM Call #1 — Select tools ──
  if (onStep) onStep({ type: 'plan_start', detail: 'Selecting analysis tools...' });
  const { tools, reasoning } = await selectTools(query, dataSummary);
  if (onStep) onStep({ type: 'plan_done', tools, reasoning });

  if (tools.length === 0) {
    return {
      narrative: 'No suitable tools found for your query. Please provide more specific data or question.',
      tools_used: [],
      steps_log: [],
      all_artifacts: [],
      reasoning,
      total_duration_ms: Date.now() - t0,
    };
  }

  // ── Step 2: Execute tools ──
  const execution = await executeTools(tools, context, onStep);

  // ── Step 3: LLM Call #2 — Synthesize ──
  if (onStep) onStep({ type: 'synthesize_start' });
  const narrative = await synthesize(execution.findingsChain);
  if (onStep) {
    onStep({ type: 'synthesize_chunk', text: narrative });
    onStep({ type: 'synthesize_done', word_count: narrative.split(/\s+/).length });
  }

  return {
    narrative,
    tools_used: tools,
    steps_log: execution.stepsLog,
    all_artifacts: execution.allArtifacts,
    reasoning,
    total_duration_ms: Date.now() - t0,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildDataSummary(context) {
  const sheets = context.datasetInputData?.sheets || context.sheets || {};
  const profile = context.datasetProfileRow?.profile_json;

  if (Object.keys(sheets).length > 0) {
    return Object.entries(sheets)
      .map(([name, rows]) => {
        const cols = rows?.[0] ? Object.keys(rows[0]).join(', ') : 'no columns';
        return `- ${name}: ${Array.isArray(rows) ? rows.length : '?'} rows, columns=[${cols}]`;
      })
      .join('\n');
  }

  if (profile) {
    return `Dataset: ${profile.file_name || 'uploaded'}, ${profile.total_rows || '?'} rows`;
  }

  return 'No data uploaded.';
}

export default { runGeneralAgent };
