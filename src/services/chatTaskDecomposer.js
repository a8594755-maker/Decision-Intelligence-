// @product: ai-employee
//
// chatTaskDecomposer.js
// ─────────────────────────────────────────────────────────────────────────────
// Takes a natural language instruction and decomposes it into a structured
// list of subtasks that can be executed by the AI Employee agent loop.
//
// Phase 6: LLM-first decomposition via callLLMJson() → ai-proxy.
// Falls back to keyword-based catalog matching if LLM is unavailable.
//
// Integration: called from DecisionSupportView when chatIntentService
// detects an ASSIGN_TASK intent.
// ─────────────────────────────────────────────────────────────────────────────

import { findToolByHint } from './toolRegistryService';
import { findToolsByQuery, getBuiltinTool, resolveDependencies, buildCatalogPromptSummary } from './builtinToolCatalog';
import { callLLMJson } from './aiEmployeeLLMService';

// ── Known workflow types ─────────────────────────────────────────────────────

const SUPABASE_URL = String(import.meta.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '');

const KNOWN_WORKFLOWS = new Set([
  'forecast', 'plan', 'risk', 'synthesize',
  'dynamic_tool', 'registered_tool', 'report', 'export',
  'builtin_tool',
]);

// ── Legacy keyword → workflow mappings (kept as fallback) ───────────────────

const LEGACY_KEYWORD_WORKFLOWS = [
  { keywords: ['report', 'summary', 'dashboard', '報告', '摘要', '報表'], workflow: 'report', name: 'report' },
  { keywords: ['excel', 'xlsx', 'export', 'powerbi', 'power bi', '匯出', '導出'], workflow: 'export', name: 'export' },
];

function hasStoredSupabaseAccessToken() {
  try {
    if (!SUPABASE_URL || typeof localStorage === 'undefined') return false;
    const match = SUPABASE_URL.match(/\/\/([^.]+)\./);
    if (!match) return false;
    const storageKey = `sb-${match[1]}-auth-token`;
    const raw = localStorage.getItem(storageKey);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return Boolean(parsed?.access_token);
  } catch {
    return false;
  }
}

// ── LLM Decomposition ────────────────────────────────────────────────────────

const DECOMPOSE_SYSTEM_PROMPT = `You are an AI task planner for business data analysis. Given a user instruction, decompose it into an ordered list of subtasks.

${buildCatalogPromptSummary()}

Additional workflow types (not in built-in catalog):
- report: Generate a summary report
- export: Export data to Excel/PowerBI
- dynamic_tool: AI generates custom code to handle novel tasks (data cleaning, KPI calculation, custom analysis, dashboards, etc.)
- registered_tool: Use a previously registered custom tool

CRITICAL RULES for choosing workflow_type:
1. Built-in tools are ONLY for specific supply chain operations (demand forecasting with time-series models, replenishment planning with MIP solvers, supplier risk scoring). Do NOT use them for general data analysis, cleaning, KPI calculation, or reporting.
2. For general tasks like: data cleaning, KPI/metrics calculation, pivot tables, trend analysis, data quality checks, dashboard creation, business review — ALWAYS use "dynamic_tool" with a detailed tool_hint.
3. Set builtin_tool_id for builtin_tool steps (must match a tool id from the list above).
4. Set depends_on to declare execution order (use step names).
5. If the user asks for Excel/XLSX output, add an "export" step and set report_format to "xlsx".
6. If the user asks for a report/summary, add a "report" step at the end.
7. Break complex analysis into logical steps: e.g. clean_data → calculate_kpis → analyze_trends → generate_report. Each step should have a specific, detailed tool_hint describing exactly what to compute.

8. If the user's request is vague or ambiguous (e.g. "分析資料", "analyze data", "generate report" without specifics), set needs_clarification=true and provide 2-4 short clarification questions. Criteria for vague: no specific metrics/KPIs mentioned, no output format specified, multiple possible approaches exist, less than 10 meaningful words.
9. Even when needs_clarification=true, STILL provide your best-guess subtasks so the user can skip clarification if they want.

Respond with ONLY a JSON object (no markdown, no explanation):
{
  "subtasks": [
    {
      "name": "step_name",
      "workflow_type": "builtin_tool|report|export|dynamic_tool|registered_tool",
      "description": "what this step does",
      "builtin_tool_id": "tool_id_or_null",
      "depends_on": ["prior_step_name"],
      "tool_hint": "description for dynamic_tool, or null",
      "estimated_tier": "tier_a|tier_b|tier_c"
    }
  ],
  "report_format": "xlsx|html|powerbi|null",
  "confidence": 0.0-1.0,
  "needs_clarification": false,
  "clarification_questions": []
}`;

/**
 * Try LLM-based decomposition. Returns null if LLM is unavailable.
 */
async function _tryLLMDecompose(userMessage, { employeeId, userId } = {}) {
  if (!hasStoredSupabaseAccessToken()) {
    return null;
  }

  try {
    const { data, model } = await callLLMJson({
      taskType: 'task_decomposition',
      prompt: `User instruction: "${userMessage}"`,
      systemPrompt: DECOMPOSE_SYSTEM_PROMPT,
      maxTokens: 4096,
      trackingMeta: {
        taskId: null, // No task yet at decomposition time
        employeeId,
        agentRole: 'decomposer',
      },
    });

    if (!data?.subtasks?.length) return null;

    console.info(`[chatTaskDecomposer] LLM decomposition via ${model}: ${data.subtasks.length} subtasks`);

    // Normalize LLM output
    const subtasks = data.subtasks.map((s) => ({
      name: s.name || 'unnamed',
      workflow_type: KNOWN_WORKFLOWS.has(s.workflow_type) ? s.workflow_type : 'dynamic_tool',
      description: s.description || '',
      requires_review: s.requires_review ?? false,
      tool_hint: s.tool_hint || null,
      tool_id: s.tool_id || null,
      builtin_tool_id: s.builtin_tool_id || null,
      depends_on: Array.isArray(s.depends_on) ? s.depends_on : [],
      estimated_tier: s.estimated_tier || 'tier_c',
      needs_dataset_profile: false,
    }));

    // Validate builtin_tool_ids against catalog
    for (const step of subtasks) {
      if (step.workflow_type === 'builtin_tool' && step.builtin_tool_id) {
        const tool = getBuiltinTool(step.builtin_tool_id);
        if (!tool) {
          // LLM hallucinated a tool ID — downgrade to dynamic_tool
          step.workflow_type = 'dynamic_tool';
          step.tool_hint = step.description;
          step.builtin_tool_id = null;
        } else {
          step.needs_dataset_profile = tool.needs_dataset_profile;
        }
      }
    }

    return {
      subtasks,
      report_format: data.report_format || null,
      confidence: typeof data.confidence === 'number' ? data.confidence : 0.8,
      needs_clarification: data.needs_clarification === true,
      clarification_questions: Array.isArray(data.clarification_questions) ? data.clarification_questions : [],
      _llm_model: model,
    };
  } catch (err) {
    console.warn('[chatTaskDecomposer] LLM decomposition failed, falling back to keyword:', err?.message);
    return null;
  }
}

// ── Decomposer ───────────────────────────────────────────────────────────────

/**
 * Decompose a user instruction into structured subtasks.
 *
 * Strategy: LLM-first, keyword-fallback.
 *
 * @param {object} opts
 * @param {string} opts.userMessage – Raw chat instruction
 * @param {object} [opts.sessionContext] – From chatSessionContextBuilder
 * @param {string} [opts.employeeId]
 * @param {string} [opts.userId]
 * @returns {Promise<TaskDecomposition>}
 */
export async function decomposeTask({ userMessage, sessionContext = null, employeeId = null, userId = null }) {
  if (!userMessage || typeof userMessage !== 'string') {
    return _emptyDecomposition(userMessage);
  }

  // ── Try LLM-based decomposition first ──────────────────────────────────
  const llmResult = await _tryLLMDecompose(userMessage, { employeeId, userId });
  if (llmResult) {
    return _finalize(llmResult.subtasks, userMessage, llmResult.report_format, llmResult.confidence, {
      needs_clarification: llmResult.needs_clarification,
      clarification_questions: llmResult.clarification_questions,
    });
  }

  // ── Fallback: keyword-based decomposition ──────────────────────────────
  const msgLower = userMessage.toLowerCase();
  const subtasks = [];
  const usedToolIds = new Set();

  // ── Phase 1: Match against builtin tool catalog ─────────────────────────
  const catalogMatches = findToolsByQuery(userMessage, { maxResults: 5 });

  for (const tool of catalogMatches) {
    if (usedToolIds.has(tool.id)) continue;
    usedToolIds.add(tool.id);

    subtasks.push({
      name: tool.id,
      workflow_type: 'builtin_tool',
      description: tool.description,
      requires_review: false,
      tool_hint: null,
      tool_id: null,
      builtin_tool_id: tool.id,
      depends_on: [],
      estimated_tier: tool.tier,
      needs_dataset_profile: tool.needs_dataset_profile,
    });
  }

  // ── Phase 1b: Check for report/export (not in builtin catalog) ──────────
  const isReportRequest = LEGACY_KEYWORD_WORKFLOWS[0].keywords.some(kw => msgLower.includes(kw));
  const isExportRequest = LEGACY_KEYWORD_WORKFLOWS[1].keywords.some(kw => msgLower.includes(kw));

  // If "report" is requested but no analysis steps exist yet, auto-inject
  // a data analysis step so the report has real content.
  if (isReportRequest && subtasks.length === 0) {
    subtasks.push({
      name: 'analyze_data',
      workflow_type: 'dynamic_tool',
      description: 'Analyze uploaded dataset: compute KPIs, trends, and key insights for the report',
      requires_review: false,
      tool_hint: 'Analyze the uploaded data. Compute summary statistics, key metrics, trends over time, and notable insights. Return a structured JSON with sections: executive_summary, kpi_table, trends, risks, and recommendations.',
      tool_id: null,
      builtin_tool_id: null,
      depends_on: [],
      estimated_tier: 'tier_a',
      needs_dataset_profile: true,
    });
  }

  for (const mapping of LEGACY_KEYWORD_WORKFLOWS) {
    if (mapping.keywords.some(kw => msgLower.includes(kw))) {
      const alreadyAdded = subtasks.some(s => s.workflow_type === mapping.workflow);
      if (!alreadyAdded) {
        subtasks.push({
          name: mapping.name,
          workflow_type: mapping.workflow,
          description: `${mapping.name} step detected from instruction`,
          requires_review: false,
          tool_hint: null,
          tool_id: null,
          builtin_tool_id: null,
          depends_on: [],
          estimated_tier: 'tier_c',
          needs_dataset_profile: false,
        });
      }
    }
  }

  // ── Phase 2: If nothing detected, try registered tools → dynamic_tool ──
  if (subtasks.length === 0) {
    // Try registered tool registry first
    let foundRegistered = false;
    try {
      const existing = await findToolByHint(userMessage);
      if (existing) {
        subtasks.push({
          name: 'registered_analysis',
          workflow_type: 'registered_tool',
          description: `Using registered tool: ${existing.name}`,
          requires_review: false,
          tool_hint: null,
          tool_id: existing.id,
          builtin_tool_id: null,
          depends_on: [],
          estimated_tier: 'tier_c',
          needs_dataset_profile: false,
        });
        foundRegistered = true;
      }
    } catch { /* best-effort */ }

    if (!foundRegistered) {
      subtasks.push({
        name: 'custom_analysis',
        workflow_type: 'dynamic_tool',
        description: userMessage,
        requires_review: true,
        tool_hint: userMessage,
        tool_id: null,
        builtin_tool_id: null,
        depends_on: [],
        estimated_tier: 'tier_a',
        needs_dataset_profile: true,
      });
    }
  }

  // ── Phase 3: Check tool registry for dynamic_tool steps ─────────────────
  for (const step of subtasks) {
    if (step.workflow_type === 'dynamic_tool' && step.tool_hint) {
      try {
        const existing = await findToolByHint(step.tool_hint);
        if (existing) {
          step.workflow_type = 'registered_tool';
          step.tool_id = existing.id;
          step.tool_hint = null;
          step.estimated_tier = 'tier_c';
          step.requires_review = false;
        }
      } catch { /* best-effort */ }
    }
  }

  // ── Determine report format ────────────────────────────────────────────
  let reportFormat = null;
  if (msgLower.includes('excel') || msgLower.includes('xlsx')) reportFormat = 'xlsx';
  else if (msgLower.includes('powerbi') || msgLower.includes('power bi')) reportFormat = 'powerbi';
  else if (msgLower.includes('html')) reportFormat = 'html';
  else if (subtasks.some(s => s.name === 'export' || s.name === 'report')) reportFormat = 'xlsx';

  const confidence = subtasks.length > 1 ? 0.85 : 0.7;
  return _finalize(subtasks, userMessage, reportFormat, confidence);
}

// ── Finalize decomposition (shared by LLM + keyword paths) ──────────────────

function _finalize(subtasks, userMessage, reportFormat, confidence, clarification = {}) {
  // Resolve dependency chain from catalog
  const builtinSteps = subtasks.filter(s => s.builtin_tool_id);
  if (builtinSteps.length > 0) {
    const requestedIds = builtinSteps.map(s => s.builtin_tool_id);
    const orderedIds = resolveDependencies(requestedIds);
    const usedIds = new Set(subtasks.map(s => s.name));

    // Add missing dependency steps
    for (const depId of orderedIds) {
      if (!usedIds.has(depId)) {
        const depTool = getBuiltinTool(depId);
        if (depTool) {
          usedIds.add(depId);
          subtasks.push({
            name: depId,
            workflow_type: 'builtin_tool',
            description: `[auto-dependency] ${depTool.description}`,
            requires_review: false,
            tool_hint: null,
            tool_id: null,
            builtin_tool_id: depId,
            depends_on: [],
            estimated_tier: depTool.tier,
            needs_dataset_profile: depTool.needs_dataset_profile,
          });
        }
      }
    }

    // Set depends_on from catalog dependency graph
    for (const step of subtasks) {
      if (step.builtin_tool_id) {
        const tool = getBuiltinTool(step.builtin_tool_id);
        if (tool) {
          step.depends_on = tool.depends_on.filter(depId =>
            subtasks.some(s => s.name === depId)
          );
        }
      }
    }

    // Sort: dependencies first
    subtasks.sort((a, b) => {
      const ai = orderedIds.indexOf(a.name);
      const bi = orderedIds.indexOf(b.name);
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return 1;
      return ai - bi;
    });
  }

  // Legacy dependency wiring for report/export
  const names = new Set(subtasks.map(s => s.name));
  if (names.has('report')) {
    const reportStep = subtasks.find(s => s.name === 'report');
    if (reportStep && reportStep.depends_on.length === 0) {
      reportStep.depends_on = subtasks
        .filter(s => s.name !== 'report' && s.name !== 'export')
        .map(s => s.name);
    }
  }
  if (names.has('export')) {
    const exportStep = subtasks.find(s => s.name === 'export');
    if (exportStep && exportStep.depends_on.length === 0) {
      exportStep.depends_on = names.has('report')
        ? ['report']
        : subtasks.filter(s => s.name !== 'export').map(s => s.name);
    }
  }

  // Estimate cost
  let estimatedCost = 0;
  for (const step of subtasks) {
    if (step.estimated_tier === 'tier_a') estimatedCost += 0.05;
    else if (step.estimated_tier === 'tier_b') estimatedCost += 0.01;
    else estimatedCost += 0.002;
  }

  return {
    original_instruction: userMessage,
    subtasks,
    confidence,
    needs_dynamic_tool: subtasks.some(s => s.workflow_type === 'dynamic_tool'),
    estimated_cost: Math.round(estimatedCost * 10000) / 10000,
    report_format: reportFormat,
    needs_clarification: clarification.needs_clarification || false,
    clarification_questions: clarification.clarification_questions || [],
  };
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Validate a TaskDecomposition for correctness.
 */
export function validateDecomposition(decomposition) {
  const errors = [];

  if (!decomposition?.subtasks?.length) {
    errors.push('No subtasks in decomposition');
    return { valid: false, errors };
  }

  const names = new Set();
  for (const step of decomposition.subtasks) {
    if (!step.name) errors.push('Step missing name');
    if (!step.workflow_type) errors.push(`Step "${step.name}" missing workflow_type`);
    if (!KNOWN_WORKFLOWS.has(step.workflow_type)) {
      errors.push(`Step "${step.name}" has unknown workflow_type: ${step.workflow_type}`);
    }
    if (names.has(step.name)) errors.push(`Duplicate step name: ${step.name}`);
    names.add(step.name);

    // Check dependency references
    for (const dep of step.depends_on || []) {
      if (!names.has(dep) && !decomposition.subtasks.some(s => s.name === dep)) {
        errors.push(`Step "${step.name}" depends on unknown step "${dep}"`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Topologically sort subtasks by depends_on.
 */
export function topologicalSort(subtasks) {
  const nameToStep = new Map(subtasks.map(s => [s.name, s]));
  const visited = new Set();
  const sorted = [];

  function visit(name) {
    if (visited.has(name)) return;
    visited.add(name);
    const step = nameToStep.get(name);
    if (step) {
      for (const dep of step.depends_on || []) {
        visit(dep);
      }
      sorted.push(step);
    }
  }

  for (const step of subtasks) {
    visit(step.name);
  }

  return sorted;
}

/**
 * Get the catalog summary for use in LLM prompts.
 * @returns {string}
 */
export function getCatalogSummary() {
  return buildCatalogPromptSummary();
}

// ── Helper ───────────────────────────────────────────────────────────────────

function _emptyDecomposition(msg) {
  return {
    original_instruction: msg || '',
    subtasks: [],
    confidence: 0,
    needs_dynamic_tool: false,
    estimated_cost: 0,
    report_format: null,
  };
}
