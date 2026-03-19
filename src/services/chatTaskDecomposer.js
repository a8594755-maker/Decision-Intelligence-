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
  'dynamic_tool', 'registered_tool', 'report', 'export', 'excel',
  'builtin_tool', 'python_tool', 'python_report',
]);

// ── Legacy keyword → workflow mappings (kept as fallback) ───────────────────

const LEGACY_KEYWORD_WORKFLOWS = [
  { keywords: ['report', 'summary', 'dashboard', '報告', '摘要', '報表'], workflow: 'report', name: 'report' },
  { keywords: ['excel', 'xlsx', 'export', 'powerbi', 'power bi', '匯出', '導出'], workflow: 'export', name: 'export' },
];

// ── General analysis detection ──────────────────────────────────────────────
// Signals that the user wants general data analysis (not DI engine operations).
// When detected, we skip the builtin tool catalog and generate python_tool steps.

const GENERAL_ANALYSIS_SIGNALS_EN = [
  'data cleaning', 'data quality', 'kpi', 'pivot', 'dashboard',
  'monthly review', 'business review', 'data issues', 'data log',
  'cleaned data', 'raw data', 'anomaly', 'duplicate', 'standardize',
  'gross margin', 'gross profit', 'return rate', 'discount rate',
  'average selling price', 'ticket volume', 'resolution time',
  'complaint rate', 'roas', 'campaign', 'support ticket',
  'data validation', 'conditional formatting',
];

const GENERAL_ANALYSIS_SIGNALS_ZH = [
  '資料整理', '資料清理', '資料品質', '月會', '月報',
  '數據清洗', '數據質量', '重複資料', '異常值', '缺值',
  '格式一致', '命名統一', '標準化', '數據問題',
  '毛利率', '退貨率', '折扣率', '客訴', '工單',
  '投放效率', '庫存積壓', '達標', '通路',
  '清洗資料', '清洗數據', '樞紐分析', '分析資料', '分析數據',
  '計算kpi', 'mbr', '月度報告', '商業報告',
  '整理後', '可分析', '管理層',
];

/**
 * Detect whether a user message is a general data analysis request
 * (as opposed to a specific supply chain DI engine operation).
 *
 * Heuristics:
 * 1. Message is long (>100 tokens) — detailed analysis briefs
 * 2. Contains multiple general analysis signals (data cleaning, KPI, dashboard, etc.)
 * 3. Mentions multiple business domains (sales + returns + inventory + marketing + support)
 */
function _isGeneralAnalysisRequest(msgLower) {
  const tokens = msgLower.split(/[\s,;:!?。，；：！？\n]+/).filter(Boolean);

  // Short messages with few signals are unlikely to be general analysis briefs.
  // Chinese text is denser (fewer tokens for more meaning), so use lower threshold.
  const hasChinese = /[\u4e00-\u9fff]/.test(msgLower);
  const minTokens = hasChinese ? 4 : 20;
  if (tokens.length < minTokens) return false;

  // Count general analysis signal matches
  let signalCount = 0;
  for (const signal of GENERAL_ANALYSIS_SIGNALS_EN) {
    if (msgLower.includes(signal)) signalCount++;
  }
  for (const signal of GENERAL_ANALYSIS_SIGNALS_ZH) {
    if (msgLower.includes(signal)) signalCount++;
  }

  // Count distinct business domain mentions
  const domains = [
    { keywords: ['sales', 'revenue', 'sell', '銷售', '營收', '銷量'], found: false },
    { keywords: ['return', 'refund', '退貨', '退款'], found: false },
    { keywords: ['inventory', 'stock', '庫存', '存貨'], found: false },
    { keywords: ['marketing', 'campaign', 'roas', '行銷', '投放', '廣告'], found: false },
    { keywords: ['support', 'ticket', 'complaint', '客服', '工單', '客訴'], found: false },
    { keywords: ['target', 'budget', '目標', '預算'], found: false },
  ];
  let domainCount = 0;
  for (const domain of domains) {
    if (domain.keywords.some(kw => msgLower.includes(kw))) {
      domainCount++;
    }
  }

  // Trigger: 3+ signals, or 2+ signals with 3+ domains, or 4+ domains with long message
  if (signalCount >= 3) return true;
  if (signalCount >= 2 && domainCount >= 3) return true;
  if (domainCount >= 4 && tokens.length >= 50) return true;

  return false;
}

/**
 * Build python_tool steps for a general data analysis request.
 * Creates a multi-step pipeline: clean → KPI → analysis → dashboard/report.
 */
function _buildGeneralAnalysisSteps(_userMessage) {
  return [
    {
      name: 'clean_data',
      workflow_type: 'python_tool',
      description: 'Clean and standardize raw data: fix date formats, unify naming, handle duplicates/nulls/anomalies, produce Data_Issues_Log',
      requires_review: false,
      tool_hint: `Data Cleaning & Standardization Task:
The user uploaded a multi-sheet business data file. Your job:
1. Load ALL sheets from input_data["sheets"]
2. For each sheet: standardize column names, fix date formats (→ YYYY-MM-DD), unify categorical values (regions, products, channels, SKUs), handle nulls/blanks/negatives/errors
3. Remove obvious duplicates (explain your logic)
4. Separate returns from sales if mixed
5. Produce these artifacts:
   - "cleaned_data" (type: "data"): The cleaned master dataset (all sheets merged or kept separate as appropriate)
   - "data_issues_log" (type: "data"): Log of every issue found — columns: issue_type, affected_field, row_count, treatment, risk_remaining
6. In the result dict, include counts: total_rows_processed, issues_found, duplicates_removed`,
      tool_id: null,
      builtin_tool_id: null,
      depends_on: [],
      estimated_tier: 'tier_a',
      needs_dataset_profile: true,
    },
    {
      name: 'calculate_kpis',
      workflow_type: 'python_tool',
      description: 'Calculate all KPI metrics from cleaned data: revenue, margin, return rate, inventory, marketing ROAS, support metrics',
      requires_review: false,
      tool_hint: `KPI Calculation Task:
Using cleaned data from the prior step (prior_artifacts["clean_data"]), calculate business KPIs.

IMPORTANT: Keep code SHORT. Use helper functions. Build artifacts list incrementally.

Steps:
1. Load cleaned data: df = pd.DataFrame(prior_artifacts["clean_data"][0]["data"])
2. Discover columns dynamically: cols = df.columns.tolist()
3. Calculate available KPIs based on columns found (revenue, units, margin, etc.)
4. Build breakdowns by available dimensions (month, region, product, channel)

Produce exactly 2 artifacts:
- "kpi_summary" (type: "data"): All KPIs in one table with columns: category, metric_name, value, unit
- "breakdowns" (type: "data"): Revenue/units breakdown by all available dimensions (month, region, product, channel) in long format with columns: dimension, dimension_value, metric, value`,
      tool_id: null,
      builtin_tool_id: null,
      depends_on: ['clean_data'],
      estimated_tier: 'tier_a',
      needs_dataset_profile: false,
    },
    {
      name: 'analyze_insights',
      workflow_type: 'python_tool',
      description: 'Deep analysis: performance vs targets, problem areas, risk identification, top 3-5 management insights',
      requires_review: false,
      tool_hint: `Business Analysis & Insights Task:
Using KPI data from prior steps (prior_artifacts["calculate_kpis"]), produce management insights.

IMPORTANT: Keep code SHORT. Use df.columns.tolist() to discover columns. Do NOT hardcode column names.

Steps:
1. Load KPI summary: kpis = pd.DataFrame(prior_artifacts["calculate_kpis"][0]["data"])
2. Load breakdowns if available: breakdowns = pd.DataFrame(prior_artifacts["calculate_kpis"][1]["data"]) if len(prior_artifacts["calculate_kpis"]) > 1 else pd.DataFrame()
3. Identify top/bottom performers, outliers, and notable patterns
4. Produce 3-5 key management insights

Produce exactly 2 artifacts:
- "analysis_summary" (type: "data"): Table with columns: dimension, metric, top_performer, bottom_performer, gap, observation
- "management_insights" (type: "data"): Table with columns: priority, insight, evidence, recommendation`,
      tool_id: null,
      builtin_tool_id: null,
      depends_on: ['calculate_kpis'],
      estimated_tier: 'tier_a',
      needs_dataset_profile: false,
    },
  ];
}

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
- python_tool: Data processing with Python (pandas/numpy). Use for data cleaning, KPI calculation, pivot analysis, trend analysis — anything data-intensive. Runs server-side with full pandas capability.
- python_report: PDF/HTML dashboard generation with charts (matplotlib). Use for the final visualization/report step when charts or PDF output are needed.
- report: Generate a summary report (HTML/XLSX, no charts)
- export: Export data to Excel/PowerBI
- dynamic_tool: AI generates custom JS code for simple calculations (fallback — use python_tool for data-intensive work)
- registered_tool: Use a previously registered custom tool

CRITICAL RULES for choosing workflow_type:
1. Built-in tools are ONLY for specific supply chain operations (demand forecasting with time-series models, replenishment planning with MIP solvers, supplier risk scoring). Do NOT use them for general data analysis, cleaning, KPI calculation, reporting, or Excel generation. For Excel/workbook generation, use "python_tool" or "export".
2. For data-intensive tasks like: data cleaning, KPI/metrics calculation, pivot tables, trend analysis, data quality checks — ALWAYS use "python_tool" with a detailed tool_hint. Python has pandas, numpy, and full data processing capability.
3. For dashboard/chart generation or PDF reports — use "python_report". It has matplotlib for charts and fpdf2 for PDF generation.
4. Only use "dynamic_tool" for very simple calculations that don't need pandas. Prefer "python_tool" for anything data-related.
5. Set builtin_tool_id for builtin_tool steps (must match a tool id from the list above). NEVER set builtin_tool_id for non-builtin workflow types.
6. Set depends_on to declare execution order (use step names).
7. If the user asks for Excel/XLSX output, add an "export" step (workflow_type: "export") and set report_format to "xlsx". Do NOT use "builtin_tool" for Excel generation.
8. If the user asks for a report/summary with charts, add a "python_report" step at the end. For text-only summary, use "report".
9. Break complex analysis into logical steps: e.g. clean_data (python_tool) → calculate_kpis (python_tool) → analyze_trends (python_tool) → generate_dashboard (python_report). Each step should have a specific, detailed tool_hint describing exactly what to compute.

TOOL_HINT RULES (for python_tool steps):
- Each tool_hint should request AT MOST 3 artifacts. Keep the generated code short (<100 lines).
- Tell the code to discover column names dynamically using df.columns.tolist() — NEVER hardcode column names.
- Tell the code to build artifacts incrementally: artifacts = [] then artifacts.append(...).
- Tell the code to ALWAYS end with: return {"result": {...}, "artifacts": artifacts}.

10. If the user's request is vague or ambiguous (e.g. "分析資料", "analyze data", "generate report" without specifics), set needs_clarification=true and provide 2-4 short clarification questions. Criteria for vague: no specific metrics/KPIs mentioned, no output format specified, multiple possible approaches exist, less than 10 meaningful words.
11. Even when needs_clarification=true, STILL provide your best-guess subtasks so the user can skip clarification if they want.

Respond with ONLY a JSON object (no markdown, no explanation):
{
  "subtasks": [
    {
      "name": "step_name",
      "workflow_type": "python_tool|python_report|builtin_tool|report|export|dynamic_tool|registered_tool",
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
async function _tryLLMDecompose(userMessage, { employeeId } = {}) {
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
export async function decomposeTask({ userMessage, sessionContext: _sessionContext = null, employeeId = null, userId: _userId = null }) {
  if (!userMessage || typeof userMessage !== 'string') {
    return _emptyDecomposition(userMessage);
  }

  // ── Try LLM-based decomposition first ──────────────────────────────────
  const llmResult = await _tryLLMDecompose(userMessage, { employeeId });
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

  // ── Phase 0: Detect general analysis requests ───────────────────────────
  // Long, multi-domain analysis briefs should NOT be matched against the
  // builtin supply chain tool catalog. Route to python_tool instead.
  const isGeneralAnalysis = _isGeneralAnalysisRequest(msgLower);

  if (isGeneralAnalysis) {
    console.info('[chatTaskDecomposer] Detected general analysis request — using python_tool pipeline');
    const analysisSteps = _buildGeneralAnalysisSteps(userMessage);
    subtasks.push(...analysisSteps);

    // Check if report/export is also needed
    const isReportRequest = LEGACY_KEYWORD_WORKFLOWS[0].keywords.some(kw => msgLower.includes(kw));
    // Add python_report step for dashboard generation
    if (isReportRequest || msgLower.includes('dashboard') || msgLower.includes('圖表') || msgLower.includes('視覺化')) {
      subtasks.push({
        name: 'generate_dashboard',
        workflow_type: 'python_report',
        description: 'Generate management dashboard with KPI cards, trend charts, and key insights',
        requires_review: false,
        tool_hint: null,
        tool_id: null,
        builtin_tool_id: null,
        depends_on: ['analyze_insights'],
        estimated_tier: 'tier_b',
        needs_dataset_profile: false,
      });
    }

    // Add Excel generation step — general analysis always produces Excel output
    // Uses excelExecutor → /agent/generate-excel (Opus 4.6 generates openpyxl code)
    const priorStepNames = subtasks.map(s => s.name);
    subtasks.push({
      name: 'generate_excel',
      workflow_type: 'excel',
      description: 'Generate MBR Excel workbook with formatted sheets, charts, and analysis results',
      requires_review: false,
      tool_hint: 'MBR Monthly Business Review Excel Report',
      tool_id: null,
      builtin_tool_id: null,
      depends_on: priorStepNames,
      estimated_tier: 'tier_c',
      needs_dataset_profile: false,
    });
  } else {
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
  // If "report" is requested but no analysis steps exist yet, auto-inject
  // a data analysis step so the report has real content.
  if (isReportRequest && subtasks.length === 0) {
    subtasks.push({
      name: 'analyze_data',
      workflow_type: 'python_tool',
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
  } // end else (not general analysis)

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
      // Prefer python_tool (server-side pandas) over dynamic_tool (JS sandbox)
      // for any data-analysis task — dynamic_tool is only for trivial JS calculations
      subtasks.push({
        name: 'custom_analysis',
        workflow_type: 'python_tool',
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
      if (bi === -1) return -1;
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
