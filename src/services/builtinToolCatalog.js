// @product: ai-employee
//
// builtinToolCatalog.js
// ─────────────────────────────────────────────────────────────────────────────
// Unified catalog of all built-in DI engines exposed as AI-callable tools.
//
// Each tool entry describes:
//   - What it does (name, description, keywords in EN/ZH)
//   - How to call it (module, method, input schema)
//   - What it produces (output artifacts, tier)
//   - What data it needs (required datasets, depends_on)
//
// The chatTaskDecomposer queries this catalog to match user intent → tool,
// and the aiEmployeeExecutor dispatches `builtin_tool` steps through it.
// ─────────────────────────────────────────────────────────────────────────────

// ── Tool Categories ─────────────────────────────────────────────────────────

export const TOOL_CATEGORY = {
  CORE_PLANNING:  'core_planning',
  RISK:           'risk',
  SCENARIO:       'scenario',
  NEGOTIATION:    'negotiation',
  COST_REVENUE:   'cost_revenue',
  BOM:            'bom',
  UTILITY:        'utility',
};

// ── Catalog ─────────────────────────────────────────────────────────────────

/**
 * @typedef {object} BuiltinTool
 * @property {string}   id              - Unique tool identifier
 * @property {string}   name            - Human-readable name
 * @property {string}   description     - What the tool does (used in LLM prompts)
 * @property {string}   category        - TOOL_CATEGORY value
 * @property {string[]} keywords_en     - English trigger keywords (lowercase)
 * @property {string[]} keywords_zh     - Chinese trigger keywords
 * @property {string}   module          - Import path relative to src/services/
 * @property {string}   method          - Exported function name
 * @property {string}   tier            - Preferred model tier: tier_a | tier_b | tier_c
 * @property {string[]} required_datasets - Dataset types needed (empty = none)
 * @property {string[]} output_artifacts  - Artifact types produced
 * @property {string[]} depends_on      - Other tool IDs that should run first
 * @property {boolean}  needs_dataset_profile - Whether it requires a dataset_profile_id
 * @property {object}   input_schema    - Simplified input parameter description
 */

/** @type {BuiltinTool[]} */
export const BUILTIN_TOOLS = [
  // ── Core Planning ───────────────────────────────────────────────────────

  {
    id: 'run_forecast',
    name: 'Demand Forecast',
    description: 'Run time-series demand forecast with P10/P50/P90 quantiles from historical demand data.',
    category: TOOL_CATEGORY.CORE_PLANNING,
    keywords_en: ['forecast', 'predict', 'demand', 'projection', 'trend'],
    keywords_zh: ['預測', '需求', '趨勢', '預估'],
    module: './chatForecastService',
    method: 'runForecastFromDatasetProfile',
    tier: 'tier_c',
    required_datasets: ['demand_fg'],
    output_artifacts: ['forecast_series', 'forecast_csv', 'metrics'],
    depends_on: [],
    needs_dataset_profile: true,
    input_schema: {
      userId: 'string',
      datasetProfileRow: 'object (from datasetProfilesService)',
      horizonPeriods: 'number|null (forecast horizon)',
      settings: 'object (optional overrides)',
    },
  },

  {
    id: 'run_plan',
    name: 'Replenishment Plan',
    description: 'Generate optimized replenishment/procurement plan using MIP solver or heuristic. Requires forecast.',
    category: TOOL_CATEGORY.CORE_PLANNING,
    keywords_en: ['plan', 'replenish', 'reorder', 'procurement', 'order', 'optimize', 'restock'],
    keywords_zh: ['計畫', '補貨', '訂單', '採購', '補充', '最佳化'],
    module: './chatPlanningService',
    method: 'runPlanFromDatasetProfile',
    tier: 'tier_c',
    required_datasets: ['demand_fg'],
    output_artifacts: ['plan_table', 'plan_csv', 'inventory_projection', 'solver_meta', 'constraint_check', 'replay_metrics'],
    depends_on: ['run_forecast'],
    needs_dataset_profile: true,
    input_schema: {
      userId: 'string',
      datasetProfileRow: 'object',
      riskMode: "'on'|'off' (default 'off')",
      scenarioOverrides: 'object|null',
      settings: 'object (optional)',
    },
  },

  {
    id: 'run_risk_analysis',
    name: 'Supplier Risk Analysis',
    description: 'Compute supplier risk scores from PO and receipt data. Identifies high-risk materials/suppliers.',
    category: TOOL_CATEGORY.RISK,
    keywords_en: ['risk', 'assess', 'threat', 'supplier risk', 'delay', 'overdue'],
    keywords_zh: ['風險', '評估', '威脅', '供應商風險', '延遲'],
    module: './chatRiskService',
    method: 'computeRiskArtifactsFromDatasetProfile',
    tier: 'tier_c',
    required_datasets: ['po_open_lines'],
    output_artifacts: ['risk_scores', 'report_json'],
    depends_on: [],
    needs_dataset_profile: true,
    input_schema: {
      userId: 'string',
      datasetProfileRow: 'object',
    },
  },

  // ── Risk-Aware Planning ─────────────────────────────────────────────────

  {
    id: 'run_risk_adjustments',
    name: 'Risk-Adjusted Parameters',
    description: 'Transform risk scores into solver parameter adjustments (lead time extensions, dual sourcing, demand uplift).',
    category: TOOL_CATEGORY.RISK,
    keywords_en: ['risk adjust', 'risk aware', 'safety stock', 'lead time buffer', 'dual source'],
    keywords_zh: ['風險調整', '安全庫存', '前置時間緩衝', '雙源'],
    module: './riskAdjustmentsService',
    method: 'computeRiskAdjustments',
    tier: 'tier_c',
    required_datasets: [],
    output_artifacts: ['risk_adjustments'],
    depends_on: ['run_risk_analysis'],
    needs_dataset_profile: false,
    input_schema: {
      riskScores: 'array (from risk analysis)',
      supplierKpis: 'object|null',
      inventory: 'array|null',
    },
  },

  {
    id: 'run_risk_aware_plan',
    name: 'Risk-Aware Replenishment Plan',
    description: 'Run replenishment plan with risk mode enabled — extends lead times, increases safety stock for high-risk items.',
    category: TOOL_CATEGORY.CORE_PLANNING,
    keywords_en: ['risk plan', 'risk aware plan', 'safe plan', 'conservative plan'],
    keywords_zh: ['風險計畫', '保守計畫', '安全計畫'],
    module: './chatPlanningService',
    method: 'runPlanFromDatasetProfile',
    tier: 'tier_c',
    required_datasets: ['demand_fg'],
    output_artifacts: ['risk_plan_table', 'risk_solver_meta', 'risk_replay_metrics', 'risk_inventory_projection', 'plan_comparison'],
    depends_on: ['run_forecast', 'run_risk_analysis'],
    needs_dataset_profile: true,
    input_schema: {
      userId: 'string',
      datasetProfileRow: 'object',
      riskMode: "'on' (forced)",
      settings: 'object',
    },
  },

  // ── Scenario & What-If ──────────────────────────────────────────────────

  {
    id: 'run_scenario',
    name: 'What-If Scenario',
    description: 'Execute a what-if scenario with parameter overrides (budget, service level, demand multiplier, lead time delta).',
    category: TOOL_CATEGORY.SCENARIO,
    keywords_en: ['scenario', 'what if', 'what-if', 'simulate', 'sensitivity', 'stress test'],
    keywords_zh: ['情境', '假設', '模擬', '壓力測試', '敏感度'],
    module: './scenarioEngine',
    method: 'runScenario',
    tier: 'tier_c',
    required_datasets: [],
    output_artifacts: ['scenario_comparison'],
    depends_on: ['run_plan'],
    needs_dataset_profile: false,
    input_schema: {
      userId: 'string',
      scenario: 'object ({ base_run_id, overrides })',
      onProgress: 'function|null',
    },
  },

  {
    id: 'run_batch_scenarios',
    name: 'Batch Scenario Comparison',
    description: 'Run up to 6 what-if scenarios in parallel and compare results side by side.',
    category: TOOL_CATEGORY.SCENARIO,
    keywords_en: ['batch scenario', 'compare scenarios', 'multiple scenarios', 'scenario matrix'],
    keywords_zh: ['批量情境', '情境比較', '多情境'],
    module: './chatScenarioBatchService',
    method: 'batchRunScenarios',
    tier: 'tier_c',
    required_datasets: [],
    output_artifacts: ['scenario_comparison'],
    depends_on: ['run_plan'],
    needs_dataset_profile: false,
    input_schema: {
      userId: 'string',
      baseRunId: 'number|string',
      scenarios: 'array (max 6)',
    },
  },

  // ── Negotiation ─────────────────────────────────────────────────────────

  {
    id: 'run_negotiation',
    name: 'Agentic Negotiation',
    description: 'Run full negotiation loop: generate options, CFR game theory enrichment, evaluate & rank, produce recommendation.',
    category: TOOL_CATEGORY.NEGOTIATION,
    keywords_en: ['negotiate', 'negotiation', 'bargain', 'supplier negotiation', 'infeasible', 'trade-off'],
    keywords_zh: ['談判', '協商', '供應商談判', '不可行', '權衡'],
    module: './negotiation/negotiationOrchestrator',
    method: 'runNegotiation',
    tier: 'tier_b',
    required_datasets: [],
    output_artifacts: ['negotiation_options', 'negotiation_evaluation', 'negotiation_report', 'cfr_param_adjustment'],
    depends_on: ['run_plan'],
    needs_dataset_profile: true,
    input_schema: {
      userId: 'string',
      planRunId: 'number|string',
      datasetProfileRow: 'object',
    },
  },

  // ── BOM & Multi-Echelon ─────────────────────────────────────────────────

  {
    id: 'run_bom_explosion',
    name: 'BOM Explosion',
    description: 'Explode Bill of Materials to compute component-level demand from finished goods demand.',
    category: TOOL_CATEGORY.BOM,
    keywords_en: ['bom', 'bill of materials', 'explosion', 'component', 'multi-echelon', 'sub-assembly'],
    keywords_zh: ['物料清單', 'BOM', '展開', '零件', '子裝配', '多階'],
    module: './bomExplosionService',
    method: 'executeBomExplosion',
    tier: 'tier_c',
    required_datasets: ['bom'],
    output_artifacts: ['bom_explosion', 'component_plan_table', 'component_plan_csv', 'bottlenecks'],
    depends_on: ['run_forecast'],
    needs_dataset_profile: true,
    input_schema: {
      demandFgRows: 'array (finished goods demand)',
      bomEdgesRows: 'array (BOM structure)',
      options: 'object (config)',
    },
  },

  // ── Cost & Revenue ──────────────────────────────────────────────────────

  {
    id: 'run_cost_forecast',
    name: 'Cost Forecast',
    description: 'Project procurement costs based on plan quantities and cost rules (margin markup, landed cost, etc.).',
    category: TOOL_CATEGORY.COST_REVENUE,
    keywords_en: ['cost', 'cost forecast', 'procurement cost', 'spend', 'budget forecast'],
    keywords_zh: ['成本', '成本預測', '採購成本', '支出', '預算'],
    module: './costForecastService',
    method: 'runCostForecast',
    tier: 'tier_c',
    required_datasets: [],
    output_artifacts: ['cost_forecast'],
    depends_on: ['run_plan'],
    needs_dataset_profile: false,
    input_schema: {
      userId: 'string',
      sourceRunId: 'number|string (plan run ID)',
      options: 'object',
    },
  },

  {
    id: 'run_revenue_forecast',
    name: 'Revenue & Margin Forecast',
    description: 'Forecast revenue and margin-at-risk from BOM plan and revenue rules.',
    category: TOOL_CATEGORY.COST_REVENUE,
    keywords_en: ['revenue', 'margin', 'profit', 'p&l', 'margin at risk', 'revenue forecast'],
    keywords_zh: ['營收', '毛利', '利潤', '損益', '營收預測'],
    module: './revenueForecastService',
    method: 'runRevenueForecast',
    tier: 'tier_c',
    required_datasets: [],
    output_artifacts: ['revenue_forecast'],
    depends_on: ['run_bom_explosion'],
    needs_dataset_profile: false,
    input_schema: {
      userId: 'string',
      sourceBomRunId: 'number|string',
      options: 'object',
    },
  },

  {
    id: 'run_cost_analysis',
    name: 'Cost Structure Analysis',
    description: 'Analyze operational cost breakdown and detect cost anomalies from historical cost data.',
    category: TOOL_CATEGORY.COST_REVENUE,
    keywords_en: ['cost analysis', 'cost breakdown', 'anomaly', 'cost structure', 'spend analysis'],
    keywords_zh: ['成本分析', '成本結構', '異常', '支出分析'],
    module: './costAnalysisService',
    method: 'analyzeCostStructure',
    tier: 'tier_c',
    required_datasets: [],
    output_artifacts: [],
    depends_on: [],
    needs_dataset_profile: false,
    input_schema: {
      userId: 'string',
      date: 'string|null (YYYY-MM-DD)',
    },
  },

  // ── Verification & Closed Loop ──────────────────────────────────────────

  {
    id: 'run_closed_loop',
    name: 'Closed-Loop Re-Plan',
    description: 'Re-forecast and re-plan after actual consumption data arrives. Continuous improvement loop.',
    category: TOOL_CATEGORY.CORE_PLANNING,
    keywords_en: ['closed loop', 're-plan', 'replan', 'feedback', 'actual vs forecast', 'recalibrate'],
    keywords_zh: ['閉環', '重新計畫', '回饋', '校準', '實際對比'],
    module: './closed_loop/closedLoopRunner',
    method: 'runClosedLoop',
    tier: 'tier_c',
    required_datasets: ['demand_fg'],
    output_artifacts: ['forecast_series', 'plan_table', 'replay_metrics'],
    depends_on: ['run_forecast', 'run_plan'],
    needs_dataset_profile: true,
    input_schema: {
      userId: 'string',
      datasetProfileRow: 'object',
      forecastRunId: 'number|string',
      forecastBundle: 'object',
    },
  },

  {
    id: 'run_risk_score',
    name: 'Risk Score Calculation',
    description: 'Compute quantitative risk scores per material/supplier from forecast and historical data.',
    category: TOOL_CATEGORY.RISK,
    keywords_en: ['risk score', 'score risk', 'quantify risk', 'risk metric'],
    keywords_zh: ['風險分數', '風險量化', '風險指標'],
    module: './riskScoreService',
    method: 'runRiskScoreCalculation',
    tier: 'tier_c',
    required_datasets: [],
    output_artifacts: ['risk_scores'],
    depends_on: ['run_forecast'],
    needs_dataset_profile: false,
    input_schema: {
      userId: 'string',
      forecastRunId: 'number|string',
      options: 'object',
    },
  },

  {
    id: 'run_supply_forecast',
    name: 'Supply Forecast',
    description: 'Predict supplier delivery quantities, lead time distributions, and capacity constraints.',
    category: TOOL_CATEGORY.CORE_PLANNING,
    keywords_en: ['supply forecast', 'supplier forecast', 'delivery prediction', 'capacity', 'lead time forecast'],
    keywords_zh: ['供應預測', '供應商預測', '交貨預測', '產能', '前置時間預測'],
    module: './supplyForecastService',
    method: 'runSupplyForecast',
    tier: 'tier_c',
    required_datasets: ['po_open_lines'],
    output_artifacts: ['supply_forecast'],
    depends_on: [],
    needs_dataset_profile: true,
    input_schema: {
      params: 'object (supplier data)',
      services: 'object',
    },
  },

  // ── Baseline & Comparison ───────────────────────────────────────────────

  {
    id: 'run_plan_comparison',
    name: 'Plan Baseline Comparison',
    description: 'Compare current plan against approved baseline — detect KPI drift, added/removed SKUs, quantity changes.',
    category: TOOL_CATEGORY.UTILITY,
    keywords_en: ['compare', 'baseline', 'drift', 'plan comparison', 'delta', 'difference'],
    keywords_zh: ['比較', '基線', '偏移', '計畫比較', '差異'],
    module: './baselineCompareService',
    method: 'buildBaselineComparison',
    tier: 'tier_c',
    required_datasets: [],
    output_artifacts: ['plan_baseline_comparison'],
    depends_on: [],
    needs_dataset_profile: false,
    input_schema: {
      baselineKpis: 'object',
      currentKpis: 'object',
      baselineRunId: 'number|string',
      currentRunId: 'number|string',
    },
  },

  // ── Python ML API ───────────────────────────────────────────────────────

  {
    id: 'run_ml_forecast',
    name: 'ML Demand Forecast (Python)',
    description: 'Advanced ML forecast using Prophet/LightGBM/Chronos models via Python API.',
    category: TOOL_CATEGORY.CORE_PLANNING,
    keywords_en: ['ml forecast', 'machine learning', 'prophet', 'lightgbm', 'chronos', 'advanced forecast'],
    keywords_zh: ['機器學習預測', '進階預測', 'ML預測'],
    module: '__python_api__',
    method: 'POST /demand-forecast',
    tier: 'tier_b',
    required_datasets: ['demand_fg'],
    output_artifacts: ['forecast_series', 'metrics'],
    depends_on: [],
    needs_dataset_profile: true,
    input_schema: {
      historical_data: 'array',
      horizon: 'number',
      model: "'prophet'|'lightgbm'|'chronos'|'auto'",
    },
  },

  {
    id: 'run_lp_solver',
    name: 'LP/MIP Solver (Python)',
    description: 'Linear programming / mixed-integer solver for replenishment optimization via Python API.',
    category: TOOL_CATEGORY.CORE_PLANNING,
    keywords_en: ['solver', 'linear programming', 'lp', 'mip', 'optimization', 'mathematical programming'],
    keywords_zh: ['求解器', '線性規劃', '數學規劃', '最佳化'],
    module: '__python_api__',
    method: 'POST /replenishment-plan',
    tier: 'tier_b',
    required_datasets: [],
    output_artifacts: ['plan_table', 'solver_meta'],
    depends_on: ['run_forecast'],
    needs_dataset_profile: false,
    input_schema: {
      demand_rows: 'array',
      inventory_rows: 'array',
      constraints: 'object',
      objective: 'object',
    },
  },

  {
    id: 'run_simulation',
    name: 'Supply Chain Simulation',
    description: 'Monte Carlo simulation of supply chain scenarios with stochastic demand and lead times.',
    category: TOOL_CATEGORY.SCENARIO,
    keywords_en: ['simulation', 'monte carlo', 'digital twin', 'stochastic', 'probabilistic'],
    keywords_zh: ['模擬', '蒙特卡洛', '數位雙生', '隨機', '機率'],
    module: '__python_api__',
    method: 'POST /run-simulation',
    tier: 'tier_b',
    required_datasets: [],
    output_artifacts: ['simulation_results'],
    depends_on: ['run_plan'],
    needs_dataset_profile: false,
    input_schema: {
      plan_data: 'object',
      scenarios: 'number (iterations)',
      chaos_intensity: 'number|null',
    },
  },
  // ── OpenCloud EU Integration ───────────────────────────────────────────

  {
    id: 'opencloud_import_dataset',
    name: 'Import Dataset from OpenCloud',
    description: 'Download a file from OpenCloud drive and create a dataset profile for DI analysis.',
    category: TOOL_CATEGORY.UTILITY,
    keywords_en: ['opencloud', 'import', 'cloud file', 'drive', 'download dataset', 'cloud import'],
    keywords_zh: ['雲端匯入', '雲端檔案', '下載資料', '雲端導入', '開放雲'],
    module: './opencloudArtifactSync',
    method: 'importDatasetFromOpenCloud',
    tier: 'tier_c',
    required_datasets: [],
    output_artifacts: ['data_quality_report'],
    depends_on: [],
    needs_dataset_profile: false,
    input_schema: {
      driveId: 'string',
      itemId: 'string',
      userId: 'string',
      itemMeta: 'object|null (optional: name, size, mimeType)',
    },
  },

  {
    id: 'opencloud_publish_report',
    name: 'Publish Report to OpenCloud',
    description: 'Upload all task artifacts and reports to an OpenCloud drive space for team access.',
    category: TOOL_CATEGORY.UTILITY,
    keywords_en: ['publish', 'upload', 'share report', 'opencloud', 'distribute', 'cloud publish'],
    keywords_zh: ['發布', '上傳', '分享報告', '雲端發布', '雲端上傳'],
    module: './opencloudArtifactSync',
    method: 'syncTaskOutputsToOpenCloud',
    tier: 'tier_c',
    required_datasets: [],
    output_artifacts: ['opencloud_file_ref'],
    depends_on: [],
    needs_dataset_profile: false,
    input_schema: {
      taskId: 'string',
      driveId: 'string',
      opts: 'object|null (optional: employeeName, loopState, artifactRefs)',
    },
  },

  {
    id: 'opencloud_share',
    name: 'Share via OpenCloud',
    description: 'Send a share invitation for a file or folder to a team member via OpenCloud.',
    category: TOOL_CATEGORY.UTILITY,
    keywords_en: ['share', 'send', 'invite', 'collaborate', 'permission', 'opencloud share'],
    keywords_zh: ['分享', '邀請', '協作', '權限', '共享'],
    module: './opencloudClientService',
    method: 'sendShareInvitation',
    tier: 'tier_c',
    required_datasets: [],
    output_artifacts: ['opencloud_file_ref'],
    depends_on: [],
    needs_dataset_profile: false,
    input_schema: {
      driveId: 'string',
      itemId: 'string',
      recipientEmail: 'string',
      role: 'string (viewer|editor)',
    },
  },

  {
    id: 'opencloud_list_files',
    name: 'Browse OpenCloud Files',
    description: 'List files and folders in an OpenCloud drive for browsing or selection.',
    category: TOOL_CATEGORY.UTILITY,
    keywords_en: ['list files', 'browse', 'opencloud files', 'drive contents', 'cloud browse'],
    keywords_zh: ['瀏覽檔案', '列出檔案', '雲端檔案', '檔案清單'],
    module: './opencloudArtifactSync',
    method: 'browseFiles',
    tier: 'tier_c',
    required_datasets: [],
    output_artifacts: [],
    depends_on: [],
    needs_dataset_profile: false,
    input_schema: {
      driveId: 'string',
      folderId: 'string|null',
      opts: 'object|null (optional: filter)',
    },
  },
];

// ── Lookup indexes ──────────────────────────────────────────────────────────

const _byId = new Map(BUILTIN_TOOLS.map(t => [t.id, t]));
const _allKeywords = buildKeywordIndex();

function buildKeywordIndex() {
  const index = [];
  for (const tool of BUILTIN_TOOLS) {
    const allKw = [...tool.keywords_en, ...tool.keywords_zh].map(k => k.toLowerCase());
    index.push({ tool, keywords: allKw });
  }
  return index;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Get a tool by its ID.
 * @param {string} toolId
 * @returns {BuiltinTool|null}
 */
export function getBuiltinTool(toolId) {
  return _byId.get(toolId) || null;
}

/**
 * List all builtin tools, optionally filtered by category.
 * @param {{ category?: string }} [filter]
 * @returns {BuiltinTool[]}
 */
export function listBuiltinTools(filter = {}) {
  let result = BUILTIN_TOOLS;
  if (filter.category) {
    result = result.filter(t => t.category === filter.category);
  }
  return result;
}

/**
 * Find the best-matching builtin tool(s) for a natural language query.
 * Returns tools sorted by relevance (keyword match count).
 *
 * @param {string} query - User message or decomposed step description
 * @param {{ maxResults?: number, category?: string }} [opts]
 * @returns {BuiltinTool[]}
 */
export function findToolsByQuery(query, opts = {}) {
  const { maxResults = 3, category } = opts;
  if (!query || typeof query !== 'string') return [];

  const tokens = query.toLowerCase().split(/[\s,;:!?。，；：！？]+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const scored = [];
  for (const { tool, keywords } of _allKeywords) {
    if (category && tool.category !== category) continue;

    let score = 0;
    for (const token of tokens) {
      for (const kw of keywords) {
        if (kw === token) {
          score += 3; // exact match
        } else if (kw.includes(token) || token.includes(kw)) {
          score += 1; // partial match
        }
      }
    }
    // Require stronger signal for longer messages to avoid false positives.
    // Short messages (< 15 tokens): score >= 2 is fine.
    // Medium messages (15-50 tokens): score >= 5 (multiple exact keyword matches).
    // Long messages (50-100 tokens): score >= 10 (strong match required).
    // Very long messages (100+ tokens): score >= 20 (very strong match — long
    //   messages are usually general analysis requests that incidentally contain
    //   supply chain keywords like "forecast", "revenue", "risk", "plan").
    const minScore = tokens.length > 100 ? 20 : tokens.length > 50 ? 10 : tokens.length > 15 ? 5 : 2;
    if (score >= minScore) {
      scored.push({ tool, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults).map(s => s.tool);
}

/**
 * Build a concise tool catalog summary for LLM prompts.
 * @returns {string}
 */
export function buildCatalogPromptSummary() {
  const lines = ['Available built-in tools:'];
  for (const tool of BUILTIN_TOOLS) {
    const deps = tool.depends_on.length > 0 ? ` [requires: ${tool.depends_on.join(', ')}]` : '';
    lines.push(`- ${tool.id}: ${tool.description}${deps}`);
  }
  return lines.join('\n');
}

/**
 * Resolve dependency chain for a set of tool IDs.
 * Returns a topologically sorted list including all transitive dependencies.
 *
 * @param {string[]} toolIds - Tool IDs the user wants to run
 * @returns {string[]} Ordered tool IDs including dependencies
 */
export function resolveDependencies(toolIds) {
  const visited = new Set();
  const order = [];

  function visit(id) {
    if (visited.has(id)) return;
    visited.add(id);
    const tool = _byId.get(id);
    if (!tool) return;
    for (const dep of tool.depends_on) {
      visit(dep);
    }
    order.push(id);
  }

  for (const id of toolIds) {
    visit(id);
  }

  return order;
}

/**
 * Check if a tool ID is a Python API tool (needs HTTP call instead of JS import).
 * @param {string} toolId
 * @returns {boolean}
 */
export function isPythonApiTool(toolId) {
  const tool = _byId.get(toolId);
  return tool?.module === '__python_api__';
}

export default {
  BUILTIN_TOOLS,
  TOOL_CATEGORY,
  getBuiltinTool,
  listBuiltinTools,
  findToolsByQuery,
  buildCatalogPromptSummary,
  resolveDependencies,
  isPythonApiTool,
};
