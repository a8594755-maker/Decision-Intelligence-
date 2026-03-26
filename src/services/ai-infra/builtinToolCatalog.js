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
  CORE_PLANNING:    'core_planning',
  RISK:             'risk',
  SCENARIO:         'scenario',
  NEGOTIATION:      'negotiation',
  COST_REVENUE:     'cost_revenue',
  BOM:              'bom',
  UTILITY:          'utility',
  ANALYTICS:        'analytics',
  GOVERNANCE:       'governance',
  DATA_ACCESS:      'data_access',
  MONITORING:       'monitoring',
  DATA_PREPARATION: 'data_preparation',
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
 * @property {string}   [ui_hint]       - Canvas widget hint: 'open_canvas:<widget_key>' (used by Tool-to-Widget Protocol)
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
    module: './forecast/chatForecastService',
    method: 'runForecastFromDatasetProfile',
    tier: 'tier_c',
    required_datasets: ['demand_fg'],
    output_artifacts: ['forecast_series', 'forecast_csv', 'metrics'],
    depends_on: [],
    needs_dataset_profile: true,
    ui_hint: 'open_canvas:forecast_series',
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
    module: './planning/chatPlanningService',
    method: 'runPlanFromDatasetProfile',
    tier: 'tier_c',
    required_datasets: ['demand_fg'],
    output_artifacts: ['plan_table', 'plan_csv', 'inventory_projection', 'solver_meta', 'constraint_check', 'replay_metrics'],
    depends_on: ['run_forecast'],
    needs_dataset_profile: true,
    ui_hint: 'open_canvas:plan_table',
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
    module: './risk/chatRiskService',
    method: 'computeRiskArtifactsFromDatasetProfile',
    tier: 'tier_c',
    required_datasets: ['po_open_lines'],
    output_artifacts: ['risk_scores', 'report_json'],
    depends_on: [],
    needs_dataset_profile: true,
    ui_hint: 'open_canvas:risk_scores',
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
    module: './risk/riskAdjustmentsService',
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
    module: './planning/chatPlanningService',
    method: 'runPlanFromDatasetProfile',
    tier: 'tier_c',
    required_datasets: ['demand_fg'],
    output_artifacts: ['risk_plan_table', 'risk_solver_meta', 'risk_replay_metrics', 'risk_inventory_projection', 'plan_comparison'],
    depends_on: ['run_forecast', 'run_risk_analysis'],
    needs_dataset_profile: true,
    ui_hint: 'open_canvas:risk_plan_table',
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
    module: './planning/scenarioEngine',
    method: 'runScenario',
    tier: 'tier_c',
    required_datasets: [],
    output_artifacts: ['scenario_comparison'],
    depends_on: ['run_plan'],
    needs_dataset_profile: false,
    ui_hint: 'open_canvas:scenario_comparison',
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
    module: './chat/chatScenarioBatchService',
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
    module: './planning/bomExplosionService',
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
    module: './forecast/costForecastService',
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
    module: './forecast/revenueForecastService',
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
    module: './forecast/costAnalysisService',
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
    module: './risk/riskScoreService',
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
    module: './forecast/supplyForecastService',
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
    module: './forecast/baselineCompareService',
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
  // ── Analytics ─────────────────────────────────────────────────────────────

  {
    id: 'run_stockout_causal_graph',
    name: 'Stockout Root Cause Analysis',
    description: 'Build a 5-Whys causal graph tracing stockout symptoms back to root causes (demand underforecast, late deliveries, stale data).',
    category: TOOL_CATEGORY.ANALYTICS,
    keywords_en: ['root cause', 'causal', 'why', 'stockout cause', '5 whys', 'diagnosis', 'explain stockout'],
    keywords_zh: ['根因分析', '因果', '五個為什麼', '缺貨原因', '診斷'],
    module: './risk/causalGraphService',
    method: 'buildStockoutCausalGraph',
    tier: 'tier_a',
    required_datasets: [],
    output_artifacts: ['causal_graph'],
    depends_on: ['run_plan'],
    needs_dataset_profile: false,
    input_schema: {
      stockoutItems: 'array (items with gap_qty, days_to_stockout)',
      replayMetrics: 'object|null',
      solverResult: 'object|null',
      riskScores: 'array',
      forecastMetrics: 'object|null',
      planRunId: 'string|null',
    },
  },

  {
    id: 'run_infeasibility_causal_graph',
    name: 'Infeasibility Root Cause Analysis',
    description: 'Build a causal graph explaining why the solver returned infeasible — conflicting constraints, capacity limits, budget too tight.',
    category: TOOL_CATEGORY.ANALYTICS,
    keywords_en: ['infeasible', 'infeasibility', 'why infeasible', 'constraint conflict', 'root cause infeasible'],
    keywords_zh: ['不可行', '不可行原因', '約束衝突', '根因'],
    module: './risk/causalGraphService',
    method: 'buildInfeasibilityCausalGraph',
    tier: 'tier_a',
    required_datasets: [],
    output_artifacts: ['causal_graph'],
    depends_on: ['run_plan'],
    needs_dataset_profile: false,
    input_schema: {
      constraintCheck: 'object (from constraintChecker)',
      solverResult: 'object',
      riskScores: 'array',
      planRunId: 'string|null',
    },
  },

  {
    id: 'get_supplier_kpi_summary',
    name: 'Supplier KPI Summary',
    description: 'Retrieve supplier performance metrics: on-time delivery, defect rate, price volatility, and overall score.',
    category: TOOL_CATEGORY.ANALYTICS,
    keywords_en: ['supplier kpi', 'supplier performance', 'on-time', 'defect rate', 'supplier score', 'vendor evaluation'],
    keywords_zh: ['供應商KPI', '供應商績效', '準時率', '缺陷率', '供應商評分'],
    module: './sap-erp/supplierKpiService',
    method: 'getSupplierKpiSummary',
    tier: 'tier_b',
    required_datasets: [],
    output_artifacts: ['supplier_kpi_summary'],
    depends_on: [],
    needs_dataset_profile: false,
    input_schema: {
      userId: 'string',
      supplierId: 'string|null (all suppliers if null)',
    },
  },

  {
    id: 'get_supplier_rankings',
    name: 'Supplier Rankings',
    description: 'Rank suppliers by composite score (delivery, quality, cost). Identify top/bottom performers.',
    category: TOOL_CATEGORY.ANALYTICS,
    keywords_en: ['supplier ranking', 'rank supplier', 'best supplier', 'worst supplier', 'supplier comparison'],
    keywords_zh: ['供應商排名', '供應商比較', '最佳供應商', '最差供應商'],
    module: './sap-erp/supplierKpiService',
    method: 'getSupplierRankings',
    tier: 'tier_b',
    required_datasets: [],
    output_artifacts: ['supplier_kpi_summary'],
    depends_on: [],
    needs_dataset_profile: false,
    input_schema: {
      userId: 'string',
      limit: 'number (default 10)',
    },
  },

  // ── Risk (additional) ────────────────────────────────────────────────────

  {
    id: 'analyze_risk_for_replan',
    name: 'Risk Replan Analysis',
    description: 'Evaluate whether risk scores warrant a re-plan. Identifies high/critical-risk SKUs and recommends solver parameter adjustments.',
    category: TOOL_CATEGORY.RISK,
    keywords_en: ['risk replan', 'replan', 'should replan', 'risk trigger', 'risk closed loop'],
    keywords_zh: ['風險重規劃', '是否重規劃', '風險觸發', '風險閉環'],
    module: './risk/riskClosedLoopService',
    method: 'analyzeRiskForReplan',
    tier: 'tier_a',
    required_datasets: [],
    output_artifacts: ['risk_replan_recommendation'],
    depends_on: ['run_risk_analysis'],
    needs_dataset_profile: false,
    input_schema: {
      riskScores: 'array (from risk analysis)',
      config: 'object|null (threshold overrides)',
    },
  },

  // ── Governance ────────────────────────────────────────────────────────────

  {
    id: 'run_war_room',
    name: 'War Room Collaborative Analysis',
    description: 'Multi-agent war room session: planner, risk analyst, negotiator, and approver agents analyze a plan collaboratively and produce findings/recommendations.',
    category: TOOL_CATEGORY.GOVERNANCE,
    keywords_en: ['war room', 'collaborative', 'multi-agent', 'joint analysis', 'cross-functional review'],
    keywords_zh: ['作戰室', '協作分析', '多智能體', '聯合分析', '跨職能審查'],
    module: './governance/warRoomOrchestrator',
    method: 'runWarRoom',
    tier: 'tier_a',
    required_datasets: [],
    output_artifacts: ['war_room_session'],
    depends_on: ['run_plan'],
    needs_dataset_profile: false,
    input_schema: {
      userId: 'string',
      planRunId: 'string',
      trigger: 'string (e.g. infeasible, high_risk, manual)',
      solverResult: 'object',
      constraintCheck: 'object',
      replayMetrics: 'object',
      riskScores: 'array',
    },
  },

  {
    id: 'request_plan_approval',
    name: 'Request Plan Approval',
    description: 'Submit a replenishment plan for governance approval. Creates an approval request with audit trail.',
    category: TOOL_CATEGORY.GOVERNANCE,
    keywords_en: ['approve', 'approval', 'governance', 'sign off', 'submit for approval', 'plan approval'],
    keywords_zh: ['審批', '核准', '治理', '提交審批', '計畫審批'],
    module: './planning/planGovernanceService',
    method: 'requestPlanApproval',
    tier: 'tier_b',
    required_datasets: [],
    output_artifacts: ['approval_request'],
    depends_on: ['run_plan'],
    needs_dataset_profile: false,
    input_schema: {
      runId: 'string',
      userId: 'string',
      payload: 'object (plan summary)',
      reason: 'string',
      note: 'string',
    },
  },

  {
    id: 'run_plan_commit',
    name: 'Commit Plan (Python)',
    description: 'Commit an approved replenishment plan to the system of record. Creates governance audit trail.',
    category: TOOL_CATEGORY.GOVERNANCE,
    keywords_en: ['commit', 'finalize', 'lock plan', 'execute plan', 'plan commit'],
    keywords_zh: ['提交', '確認', '鎖定計畫', '執行計畫', '計畫提交'],
    module: '__python_api__',
    method: 'POST /replenishment-plan/commit',
    tier: 'tier_b',
    required_datasets: [],
    output_artifacts: ['plan_commit_receipt'],
    depends_on: ['run_plan'],
    needs_dataset_profile: false,
    input_schema: {
      plan_id: 'string',
      approved_by: 'string',
      commit_note: 'string|null',
    },
  },

  // ── Data Access ───────────────────────────────────────────────────────────

  {
    id: 'query_live_data',
    name: 'Query Live ERP Data',
    description: 'Query real-time data from Supabase tables (suppliers, materials, inventory, POs). Supports filtering, sorting, pagination.',
    category: TOOL_CATEGORY.DATA_ACCESS,
    keywords_en: ['query', 'data', 'erp', 'live data', 'table', 'browse data', 'lookup', 'database'],
    keywords_zh: ['查詢', '數據', 'ERP', '即時資料', '表格', '瀏覽', '數據庫'],
    module: './data-prep/liveDataQueryService',
    method: 'queryTable',
    tier: 'tier_b',
    required_datasets: [],
    output_artifacts: [],
    depends_on: [],
    needs_dataset_profile: false,
    input_schema: {
      userId: 'string',
      tableName: 'string (suppliers|materials|inventory_snapshots|...)',
      filters: 'object|null',
      sort: 'object|null ({ column, ascending })',
      page: 'number (default 1)',
      pageSize: 'number (default 50)',
    },
  },

  {
    id: 'list_available_tables',
    name: 'List Available Data Tables',
    description: 'Get the list of all queryable ERP/DI tables with their columns and filter options.',
    category: TOOL_CATEGORY.DATA_ACCESS,
    keywords_en: ['tables', 'available data', 'data sources', 'schema', 'what data'],
    keywords_zh: ['表格', '可用資料', '數據源', '結構', '有什麼資料'],
    module: './data-prep/liveDataQueryService',
    method: 'getAvailableTables',
    tier: 'tier_a',
    required_datasets: [],
    output_artifacts: [],
    depends_on: [],
    needs_dataset_profile: false,
    input_schema: {},
  },

  // ── SAP Master Data (SQL) ────────────────────────────────────────────────

  {
    id: 'query_sap_data',
    name: 'Query SAP Master Data (SQL)',
    description: 'Execute SQL queries on enterprise data via DuckDB (PostgreSQL-compatible). Dataset A (Olist E-Commerce) is built-in: customers, orders, order_items, payments, reviews, products, sellers, geolocation, category_translation. Dataset B (DI Operations) is current-user scoped and may be empty unless this user has imported or synced operational data: suppliers, materials, inventory_snapshots, po_open_lines, goods_receipts. Supports CTEs (WITH ... AS), window functions (ROW_NUMBER, RANK, LAG, LEAD, OVER/PARTITION BY), QUANTILE_CONT (NOT PERCENTILE_CONT), MEDIAN, DATE_TRUNC, EXTRACT, and all standard SQL.',
    category: TOOL_CATEGORY.DATA_ACCESS,
    keywords_en: ['sql', 'sap', 'master data', 'query', 'select', 'customers', 'orders', 'products', 'sellers', 'payments', 'reviews', 'geolocation', 'suppliers', 'materials', 'inventory', 'purchase orders'],
    keywords_zh: ['SQL', 'SAP', '主檔', '查詢', '客戶', '訂單', '產品', '賣家', '付款', '評論', '供應商', '物料', '庫存', '採購單'],
    module: './sap-erp/sapDataQueryService',
    method: 'executeQuery',
    tier: 'tier_b',
    required_datasets: [],
    output_artifacts: [],
    depends_on: [],
    needs_dataset_profile: false,
    input_schema: {
      sql: 'string (SQL SELECT query to execute against SAP master data tables)',
    },
  },

  {
    id: 'list_sap_tables',
    name: 'List SAP Master Data Tables',
    description: 'Show all available SAP master data tables with their columns, row counts, and SAP transaction equivalents.',
    category: TOOL_CATEGORY.DATA_ACCESS,
    keywords_en: ['sap tables', 'sap schema', 'master data tables', 'sap structure'],
    keywords_zh: ['SAP表格', 'SAP結構', '主檔表格', 'SAP資料'],
    module: './sap-erp/sapDataQueryService',
    method: 'getSchema',
    tier: 'tier_a',
    required_datasets: [],
    output_artifacts: [],
    depends_on: [],
    needs_dataset_profile: false,
    input_schema: {},
  },

  {
    id: 'forecast_from_sap',
    name: 'Forecast from SAP Data',
    description: 'Run demand forecast from ANY data in SAP tables via DuckDB SQL. Provide a demand_sql that returns columns (material_code, plant_id, time_bucket, demand_qty) — the tool handles profiling, forecasting, and comparison. If no SQL given, defaults to Olist orders grouped by category. Works with any dataset loaded into DuckDB.',
    category: TOOL_CATEGORY.CORE_PLANNING,
    keywords_en: ['forecast', 'predict', 'olist', 'sap', 'demand', 'compare', 'actual', '2016', '2017', 'backtest', 'accuracy'],
    keywords_zh: ['預測', '預報', 'Olist', 'SAP', '需求', '比對', '實際', '準確度', '回測'],
    module: './forecast/sapForecastBridgeService',
    method: 'forecastFromSapData',
    tier: 'tier_b',
    required_datasets: [],
    output_artifacts: ['forecast_series', 'metrics'],
    depends_on: [],
    needs_dataset_profile: false,
    input_schema: {
      demand_sql: "string (optional SQL returning material_code, plant_id, time_bucket, demand_qty columns. If omitted, uses Olist default query)",
      actuals_sql: "string (optional SQL for actual data to compare against forecast)",
      training_start: "string (YYYY-MM start, for default SQL only, default '2017-01')",
      training_end: "string (YYYY-MM end, for default SQL only, default '2017-12')",
      forecast_months: 'number (months to forecast, default 6)',
      compare_actuals: 'boolean (compare with actual data, default true)',
      group_by: "string ('category' or 'seller_state', for default SQL only, default 'category')",
      top_n: 'number (top N groups by volume, default 15)',
      forecast_model: "string (ML model to use: 'auto', 'prophet', 'lightgbm', 'chronos', 'xgboost', 'ets', 'naive'. Default 'auto')",
    },
  },

  // ── Monitoring ────────────────────────────────────────────────────────────

  {
    id: 'generate_proactive_alerts',
    name: 'Proactive Alerts',
    description: 'Generate proactive supply chain alerts: stockout risk, expedite recommendations, dual-source suggestions from risk scores.',
    category: TOOL_CATEGORY.MONITORING,
    keywords_en: ['alert', 'proactive', 'early warning', 'notification', 'stockout alert', 'expedite'],
    keywords_zh: ['預警', '主動', '早期預警', '通知', '缺貨預警', '加急'],
    module: './governance/proactiveAlertService',
    method: 'generateAlerts',
    tier: 'tier_a',
    required_datasets: [],
    output_artifacts: ['proactive_alerts'],
    depends_on: ['run_risk_analysis'],
    needs_dataset_profile: false,
    input_schema: {
      riskScores: 'array',
      stockoutData: 'array',
      configOverrides: 'object|null',
    },
  },

  {
    id: 'generate_daily_summary',
    name: 'Daily Work Summary',
    description: 'Generate a daily summary of digital worker activity: tasks completed, failed, cost, KPIs.',
    category: TOOL_CATEGORY.MONITORING,
    keywords_en: ['daily summary', 'daily report', 'today summary', 'work summary', 'status report'],
    keywords_zh: ['每日摘要', '每日報告', '今日摘要', '工作摘要', '狀態報告'],
    module: './tasks/dailySummaryService',
    method: 'generateDailySummary',
    tier: 'tier_b',
    required_datasets: [],
    output_artifacts: ['daily_summary'],
    depends_on: [],
    needs_dataset_profile: false,
    input_schema: {
      employeeId: 'string',
      date: 'Date|null (default: today)',
    },
  },

  {
    id: 'fetch_external_signals',
    name: 'Macro-Oracle External Signals',
    description: 'Fetch external macro signals (GDELT geopolitical events, supply chain news, currency moves) or load demo scenarios.',
    category: TOOL_CATEGORY.MONITORING,
    keywords_en: ['macro', 'oracle', 'gdelt', 'geopolitical', 'external signal', 'news', 'currency', 'commodity'],
    keywords_zh: ['宏觀', '外部信號', '地緣政治', '新聞', '貨幣', '大宗商品'],
    module: './risk/externalSignalAdapters',
    method: 'fetchAllSignals',
    tier: 'tier_b',
    required_datasets: [],
    output_artifacts: ['macro_oracle_signals'],
    depends_on: [],
    needs_dataset_profile: false,
    input_schema: {
      enableGdelt: 'boolean (default false)',
      enableReddit: 'boolean (default false)',
      enableCurrency: 'boolean (default false)',
      enableLive: 'boolean (default false)',
      demoScenario: 'string|null (semiconductor_fire|suez_blockage|china_rare_earth|eu_steel_tariff)',
    },
  },

  {
    id: 'analyze_step_failure',
    name: 'Self-Healing Failure Diagnosis',
    description: 'Diagnose why an agent loop step failed and suggest healing strategy (retry, simplify, model escalation, skip).',
    category: TOOL_CATEGORY.MONITORING,
    keywords_en: ['self healing', 'diagnose', 'failure', 'error analysis', 'retry strategy', 'heal'],
    keywords_zh: ['自修復', '診斷', '故障', '錯誤分析', '重試策略'],
    module: './governance/selfHealingService',
    method: 'analyzeStepFailure',
    tier: 'tier_a',
    required_datasets: [],
    output_artifacts: [],
    depends_on: [],
    needs_dataset_profile: false,
    input_schema: {
      error: 'Error|string',
      step: 'object (step definition)',
      retryCount: 'number',
    },
  },

  // ── Scenario — Digital Twin ───────────────────────────────────────────────

  {
    id: 'run_digital_twin_simulation',
    name: 'Digital Twin Simulation',
    description: 'Run a supply chain digital twin simulation with configurable scenario and chaos intensity.',
    category: TOOL_CATEGORY.SCENARIO,
    keywords_en: ['digital twin', 'twin simulation', 'supply chain simulation', 'what if simulation'],
    keywords_zh: ['數位雙生模擬', '供應鏈模擬', '雙生模擬'],
    module: './planning/digitalTwinService',
    method: 'runSimulation',
    tier: 'tier_c',
    required_datasets: [],
    output_artifacts: ['simulation_results'],
    depends_on: [],
    needs_dataset_profile: false,
    input_schema: {
      scenario: 'string (default: normal)',
      seed: 'number (default: 42)',
      durationDays: 'number|null',
      chaosIntensity: 'number|null',
    },
  },

  {
    id: 'run_digital_twin_optimization',
    name: 'Digital Twin Parameter Optimization',
    description: 'Optimize supply chain parameters (reorder points, safety stock) using the digital twin simulator.',
    category: TOOL_CATEGORY.SCENARIO,
    keywords_en: ['optimize parameters', 'twin optimize', 'parameter search', 'auto-tune'],
    keywords_zh: ['參數最佳化', '雙生最佳化', '參數搜索', '自動調參'],
    module: './planning/digitalTwinService',
    method: 'runOptimization',
    tier: 'tier_c',
    required_datasets: [],
    output_artifacts: ['optimization_results'],
    depends_on: [],
    needs_dataset_profile: false,
    input_schema: {
      scenario: 'string (default: normal)',
      seed: 'number (default: 42)',
      nTrials: 'number (default: 30)',
      method: 'string (random)',
      minFillRate: 'number (default: 0.95)',
    },
  },

  {
    id: 'run_digital_twin_comparison',
    name: 'Digital Twin Strategy Comparison',
    description: 'Compare multiple supply chain strategies side-by-side using the digital twin simulator.',
    category: TOOL_CATEGORY.SCENARIO,
    keywords_en: ['strategy comparison', 'twin compare', 'compare strategies'],
    keywords_zh: ['策略比較', '雙生比較', '比較策略'],
    module: './planning/digitalTwinService',
    method: 'runComparison',
    tier: 'tier_c',
    required_datasets: [],
    output_artifacts: ['simulation_comparison'],
    depends_on: [],
    needs_dataset_profile: false,
    input_schema: {
      scenario: 'string (default: normal)',
      seed: 'number (default: 42)',
      strategies: 'array|null',
    },
  },

  {
    id: 'run_digital_twin_reoptimization',
    name: 'Simulation Re-Optimization',
    description: 'Analyze simulation results and derive constraint tightening for solver re-optimization.',
    category: TOOL_CATEGORY.SCENARIO,
    keywords_en: ['reoptimize', 'reoptimization', 'simulation feedback', 'constraint tightening'],
    keywords_zh: ['重新最佳化', '模擬回饋', '約束收緊'],
    module: './planning/digitalTwinService',
    method: 'runReoptimization',
    tier: 'tier_c',
    required_datasets: [],
    output_artifacts: ['reoptimization_results'],
    depends_on: ['run_digital_twin_simulation'],
    needs_dataset_profile: false,
    input_schema: {
      simResult: 'object (from runSimulation)',
      originalPlan: 'object|null',
      config: 'object|null',
    },
  },

  // ── Core Planning (additional) ────────────────────────────────────────────

  {
    id: 'run_inventory_projection',
    name: 'Inventory Level Projection',
    description: 'Project future inventory levels by material/plant using forecast demand, open POs, and current stock. Identifies stockout risks.',
    category: TOOL_CATEGORY.CORE_PLANNING,
    keywords_en: ['inventory projection', 'inventory level', 'stock level', 'days of supply', 'inventory forecast'],
    keywords_zh: ['庫存預測', '庫存水位', '存貨水準', '供應天數'],
    module: './forecast/inventoryProjectionService',
    method: 'loadInventoryProjection',
    tier: 'tier_b',
    required_datasets: ['demand_fg'],
    output_artifacts: ['inventory_projection'],
    depends_on: ['run_forecast'],
    needs_dataset_profile: false,
    input_schema: {
      userId: 'string',
      forecastRunId: 'string',
      timeBuckets: 'array (string[])',
      plantId: 'string|null',
    },
  },

  // ── Utility (additional) ──────────────────────────────────────────────────

  {
    id: 'generate_report',
    name: 'Generate Report',
    description: 'Generate an HTML/XLSX report from accumulated task artifacts with optional narrative and revision log.',
    category: TOOL_CATEGORY.UTILITY,
    keywords_en: ['report', 'generate report', 'html report', 'xlsx report', 'document'],
    keywords_zh: ['報告', '生成報告', 'HTML報告', 'XLSX報告', '文件'],
    module: './infra/reportGeneratorService',
    method: 'generateReport',
    tier: 'tier_b',
    required_datasets: [],
    output_artifacts: ['report_html'],
    depends_on: [],
    needs_dataset_profile: false,
    input_schema: {
      format: "'html'|'xlsx' (default 'html')",
      artifacts: 'object (prior step artifacts)',
      taskMeta: 'object ({ id, title })',
      narrative: 'string|null',
      revisionLog: 'array|null',
      runId: 'string',
    },
  },

  // ── Python API (additional) ───────────────────────────────────────────────

  {
    id: 'run_sku_analysis',
    name: 'Per-SKU Deep Analysis (Python)',
    description: 'Deep analysis for a single SKU: trend decomposition, seasonality, anomalies, forecast accuracy.',
    category: TOOL_CATEGORY.ANALYTICS,
    keywords_en: ['sku analysis', 'item analysis', 'deep dive', 'sku detail', 'material analysis'],
    keywords_zh: ['SKU分析', '單品分析', '深度分析', '物料分析'],
    module: '__python_api__',
    method: 'POST /analyze-sku',
    tier: 'tier_b',
    required_datasets: ['demand_fg'],
    output_artifacts: ['sku_analysis'],
    depends_on: [],
    needs_dataset_profile: true,
    input_schema: {
      sku_id: 'string',
      historical_data: 'array',
      options: 'object|null',
    },
  },

  {
    id: 'run_backtest',
    name: 'Forecast Backtest (Python)',
    description: 'Backtest forecast models against historical data to evaluate accuracy (MAE, MAPE, RMSE).',
    category: TOOL_CATEGORY.ANALYTICS,
    keywords_en: ['backtest', 'forecast accuracy', 'model evaluation', 'historical test', 'holdout test'],
    keywords_zh: ['回測', '預測準確度', '模型評估', '歷史測試'],
    module: '__python_api__',
    method: 'POST /backtest',
    tier: 'tier_b',
    required_datasets: ['demand_fg'],
    output_artifacts: ['backtest_results'],
    depends_on: [],
    needs_dataset_profile: true,
    input_schema: {
      historical_data: 'array',
      models: 'array|null',
      holdout_periods: 'number (default 3)',
    },
  },

  {
    id: 'run_model_training',
    name: 'Train Forecast Model (Python)',
    description: 'Train or retrain a forecast model (Prophet/LightGBM) on new data.',
    category: TOOL_CATEGORY.CORE_PLANNING,
    keywords_en: ['train', 'retrain', 'model training', 'fit model', 'learn'],
    keywords_zh: ['訓練', '重新訓練', '模型訓練', '擬合'],
    module: '__python_api__',
    method: 'POST /train-model',
    tier: 'tier_c',
    required_datasets: ['demand_fg'],
    output_artifacts: ['model_artifact'],
    depends_on: [],
    needs_dataset_profile: true,
    input_schema: {
      historical_data: 'array',
      model: "'prophet'|'lightgbm'|'auto'",
      hyperparameters: 'object|null',
    },
  },

  {
    id: 'run_feature_importance',
    name: 'Feature Importance (Python)',
    description: 'Compute feature importance scores for forecast model explainability.',
    category: TOOL_CATEGORY.ANALYTICS,
    keywords_en: ['feature importance', 'explainability', 'model explain', 'shap', 'important features'],
    keywords_zh: ['特徵重要性', '可解釋性', '模型解釋', '重要特徵'],
    module: '__python_api__',
    method: 'POST /feature-importance',
    tier: 'tier_b',
    required_datasets: ['demand_fg'],
    output_artifacts: ['feature_importance'],
    depends_on: ['run_ml_forecast'],
    needs_dataset_profile: true,
    input_schema: {
      historical_data: 'array',
      model: 'string',
      top_n: 'number (default 10)',
    },
  },

  {
    id: 'run_drift_check',
    name: 'Forecast Drift Detection (Python)',
    description: 'Detect distribution drift between training data and recent actuals. Flags when model retraining is needed.',
    category: TOOL_CATEGORY.MONITORING,
    keywords_en: ['drift', 'data drift', 'concept drift', 'model drift', 'distribution shift', 'retrain needed'],
    keywords_zh: ['漂移', '數據漂移', '概念漂移', '模型漂移', '分佈偏移'],
    module: '__python_api__',
    method: 'POST /drift-check',
    tier: 'tier_b',
    required_datasets: ['demand_fg'],
    output_artifacts: ['drift_report'],
    depends_on: [],
    needs_dataset_profile: true,
    input_schema: {
      reference_data: 'array',
      current_data: 'array',
      method: "'ks'|'psi'|'auto' (default 'auto')",
    },
  },

  {
    id: 'run_stress_test',
    name: 'Supply Chain Stress Test (Python)',
    description: 'Stress test the supply chain with extreme scenarios: demand spikes, supplier failures, lead time extensions.',
    category: TOOL_CATEGORY.SCENARIO,
    keywords_en: ['stress test', 'extreme scenario', 'worst case', 'resilience test', 'shock test'],
    keywords_zh: ['壓力測試', '極端情境', '最壞情況', '韌性測試', '衝擊測試'],
    module: '__python_api__',
    method: 'POST /stress-test',
    tier: 'tier_c',
    required_datasets: ['demand_fg'],
    output_artifacts: ['stress_test_results'],
    depends_on: ['run_ml_forecast'],
    needs_dataset_profile: true,
    input_schema: {
      base_forecast: 'array',
      stress_scenarios: 'array',
      options: 'object|null',
    },
  },

  // ── Chart Recipe Catalog ────────────────────────────────────────────────

  {
    id: 'generate_chart',
    name: 'Generate Predefined Chart',
    description: 'Generate a chart from the predefined recipe catalog (50 chart types). Call with recipe_id to run a pre-written analysis. Much faster than run_python_analysis (~2s vs ~15s). Use for: revenue trends, category analysis, delivery performance, payment distribution, customer segmentation, geographic analysis, correlations, Pareto, funnel, cohort, Lorenz, heatmaps, and more.',
    category: TOOL_CATEGORY.ANALYTICS,
    keywords_en: ['chart', 'graph', 'plot', 'visualization', 'visualize', 'generate chart', 'show chart',
      'trend chart', 'distribution chart', 'pie chart', 'bar chart', 'heatmap', 'scatter', 'pareto',
      'funnel', 'radar', 'sankey', 'treemap', 'lorenz', 'waterfall', 'cohort', 'rfm chart',
      'bubble chart', 'histogram', 'box plot'],
    keywords_zh: ['圖表', '圖形', '可視化', '視覺化', '生成圖表', '顯示圖表',
      '趨勢圖', '分布圖', '餅圖', '長條圖', '熱力圖', '散佈圖', '帕累托',
      '漏斗', '雷達', '桑基', '矩形樹', '洛倫茲', '瀑布', '同類群組'],
    module: './charts/chartRecipeExecutor',
    method: 'executeChartRecipe',
    tier: 'tier_b',
    required_datasets: [],
    output_artifacts: ['analysis_result'],
    depends_on: [],
    needs_dataset_profile: false,
    input_schema: {
      recipe_id: 'string (chart recipe ID from catalog — see system prompt for full list)',
      params: 'object|null (optional parameter overrides, e.g. { period: "Q" })',
      dataset: "string|null (default 'olist')",
    },
  },

  // ── Python Statistical Analysis ──────────────────────────────────────────

  {
    id: 'run_python_analysis',
    name: 'Python Statistical Analysis',
    description: 'Advanced statistical analysis in a restricted Python sandbox. AVAILABLE modules: pandas, numpy, scipy (scipy.stats, scipy.interpolate, scipy.optimize), statsmodels (seasonal_decompose, Holt-Winters, ADF test), sklearn (KMeans, LinearRegression, StandardScaler, PCA), calendar, statistics, collections, itertools, datetime, dateutil, math, json, re, copy, decimal, uuid, openpyxl, functools, operator, hashlib, base64, warnings, typing. NOT AVAILABLE: matplotlib, seaborn, plotly, os, sys, subprocess. For plotting return structured data — charts are rendered by the frontend. Supports Gini coefficient, Lorenz curves, correlation analysis, time series decomposition, customer segmentation (KMeans), regression, business-tier segmentation (pd.cut), cross-dimensional groupby, concentration metrics, and distribution analysis. Works on any loaded dataset with automatic column discovery.',
    category: TOOL_CATEGORY.ANALYTICS,
    keywords_en: ['analysis', 'gini', 'lorenz', 'correlation', 'distribution', 'concentration', 'statistical',
      'segmentation', 'tier analysis', 'cross-dimensional', 'pandas analysis', 'deep analysis',
      'comprehensive analysis', 'full analysis', 'panorama', 'seller analysis', 'customer analysis',
      'revenue analysis', 'performance analysis'],
    keywords_zh: ['分析', '基尼', '洛倫茲', '相關性', '分布', '集中度', '統計', '分層',
      '交叉分析', '全面分析', '深度分析', '完整分析', '全景分析', '賣家分析',
      '客戶分析', '營收分析', '表現分析'],
    module: '__python_api__',
    method: 'POST /execute-tool',
    tier: 'tier_b',
    required_datasets: [],
    output_artifacts: ['analysis_result'],
    depends_on: [],
    needs_dataset_profile: false,
    input_schema: {
      tool_hint: 'string (analysis task description)',
      analysis_mode: 'boolean (always true)',
      dataset: "'olist' (default)",
    },
  },

  {
    id: 'generate_analysis_workbook',
    name: 'Generate Analysis Excel Workbook',
    description: 'Generate a professional multi-sheet Excel workbook (.xlsx) from structured analysis results. Supports table sheets (with headers/rows), methodology/text sheets, and auto-styling. Used as the final step of recipe-driven analysis to produce downloadable reports.',
    category: TOOL_CATEGORY.ANALYTICS,
    keywords_en: ['excel', 'workbook', 'analysis report', 'export', 'spreadsheet', 'xlsx',
      'safety stock report', 'inventory report', 'sensitivity report'],
    keywords_zh: ['Excel', '報告', '分析報告', '匯出', '試算表', '工作簿',
      '安全庫存報告', '庫存報告', '敏感度報告'],
    module: '__python_api__',
    method: 'POST /generate-analysis-workbook',
    tier: 'tier_b',
    required_datasets: [],
    output_artifacts: ['analysis_workbook'],
    depends_on: ['run_python_analysis'],
    needs_dataset_profile: false,
    input_schema: {
      title: 'string (workbook title)',
      sheets: 'array of {name, sheet_type, headers?, rows?, text_content?, column_widths?}',
      methodology_notes: 'string|null (optional methodology notes)',
    },
  },

  // ── Excel Output ──────────────────────────────────────────────────────────

  {
    id: 'excel_mbr_workbook',
    name: 'Generate MBR Excel Workbook',
    description: 'Generate a formatted Monthly Business Review Excel workbook (.xlsx) from prior analysis artifacts. Creates 6 sheets: Cover, KPIs, Cleaned Data, Data Issues, Analysis, Dashboard. Opens the file in Excel and uploads to storage.',
    category: TOOL_CATEGORY.UTILITY,
    keywords_en: ['excel', 'workbook', 'xlsx', 'mbr', 'monthly report', 'spreadsheet', 'export excel'],
    keywords_zh: ['Excel', '工作簿', '月報', '匯出', '試算表', '報表匯出'],
    module: '__python_api__',
    method: 'POST /agent/generate-excel',
    tier: 'tier_c',
    required_datasets: [],
    output_artifacts: ['excel_workbook'],
    depends_on: [],
    needs_dataset_profile: false,
    input_schema: {
      task_id: 'string',
      step_results: 'array (prior step results with artifacts)',
      title: 'string|null (custom workbook title)',
      open_file: 'boolean (default true — opens in Excel desktop)',
    },
  },

  // ── General Data Analyst Tools ────────────────────────────────────────────

  {
    id: 'run_data_cleaning',
    name: 'Data Cleaning & Transformation',
    description: 'Clean and transform dataset: handle missing values, deduplicate, type conversion, outlier treatment, normalization.',
    category: TOOL_CATEGORY.DATA_PREPARATION,
    keywords_en: ['clean', 'cleaning', 'transform', 'missing values', 'deduplicate', 'outlier', 'normalize', 'standardize', 'impute', 'fill missing'],
    keywords_zh: ['清洗', '清理', '轉換', '缺失值', '去重', '離群值', '標準化', '正規化', '填補', '資料清洗'],
    module: './data-prep/dataCleaningService',
    method: 'cleanDataset',
    tier: 'tier_a',
    required_datasets: [],
    output_artifacts: ['cleaned_dataset'],
    depends_on: [],
    needs_dataset_profile: true,
    input_schema: {
      datasetId: 'string (dataset profile ID)',
      operations: 'array<{ type, column?, strategy?, ... }> (cleaning operations)',
      autoDetect: 'boolean (auto-detect and apply suggested ops)',
      userId: 'string',
    },
  },

  {
    id: 'run_eda',
    name: 'Exploratory Data Analysis',
    description: 'Run automated EDA: per-column statistics, distributions, correlations, missing value analysis, data quality scoring.',
    category: TOOL_CATEGORY.ANALYTICS,
    keywords_en: ['eda', 'exploratory', 'statistics', 'describe', 'profile', 'summary', 'overview', 'distribution', 'correlation matrix'],
    keywords_zh: ['探索性分析', '統計摘要', '描述', '概覽', '分布', '相關矩陣', '資料概覽', '資料剖析'],
    module: './forecast/edaService',
    method: 'runExploratoryAnalysis',
    tier: 'tier_a',
    required_datasets: [],
    output_artifacts: ['eda_report'],
    depends_on: [],
    needs_dataset_profile: true,
    input_schema: {
      datasetId: 'string (dataset profile ID)',
      columns: 'string[]|null (specific columns, default all)',
      sampleSize: 'number (max rows to analyze, default 10000)',
      userId: 'string',
    },
  },

  {
    id: 'run_auto_insights',
    name: 'Automated Insight Discovery',
    description: 'Auto-scan dataset for interesting patterns: trends, distribution anomalies, concentration, cross-group differences, temporal patterns. Ranked by interestingness.',
    category: TOOL_CATEGORY.ANALYTICS,
    keywords_en: ['insights', 'auto insights', 'discover', 'patterns', 'interesting', 'what stands out', 'key findings', 'automated analysis'],
    keywords_zh: ['自動洞察', '洞察', '發現', '模式', '有趣的', '重點發現', '自動分析', '關鍵發現'],
    module: './forecast/autoInsightService',
    method: 'discoverInsights',
    tier: 'tier_b',
    required_datasets: [],
    output_artifacts: ['auto_insights'],
    depends_on: [],
    needs_dataset_profile: true,
    input_schema: {
      datasetId: 'string (dataset profile ID)',
      maxInsights: 'number (max insights to return, default 10)',
      focusColumns: 'string[]|null (focus on specific columns)',
      userId: 'string',
    },
  },

  {
    id: 'run_anomaly_detection',
    name: 'Anomaly Detection',
    description: 'Detect outliers and anomalies in dataset columns using z-score, IQR, or isolation forest methods.',
    category: TOOL_CATEGORY.ANALYTICS,
    keywords_en: ['anomaly', 'outlier', 'detect anomaly', 'unusual', 'abnormal', 'deviation', 'spike', 'drop'],
    keywords_zh: ['異常偵測', '離群值', '異常值', '偏差', '突增', '驟降', '異常檢測'],
    module: './forecast/anomalyDetectionService',
    method: 'detectAnomalies',
    tier: 'tier_b',
    required_datasets: [],
    output_artifacts: ['anomaly_report'],
    depends_on: [],
    needs_dataset_profile: true,
    input_schema: {
      datasetId: 'string (dataset profile ID)',
      columns: 'string[]|null (columns to check)',
      method: 'string (zscore|iqr|isolation_forest)',
      groupBy: 'string|null (detect anomalies within groups)',
      timeColumn: 'string|null (for time-series anomaly detection)',
      userId: 'string',
    },
  },

  {
    id: 'run_dataset_join',
    name: 'Cross-Dataset Join',
    description: 'Join two datasets on matching keys. Supports inner/left/right/outer joins and auto-detection of join keys.',
    category: TOOL_CATEGORY.DATA_PREPARATION,
    keywords_en: ['join', 'merge', 'combine', 'link', 'match', 'cross dataset', 'enrich'],
    keywords_zh: ['合併', '連接', '結合', '配對', '跨資料集', '關聯', '合表'],
    module: './data-prep/datasetJoinService',
    method: 'joinDatasets',
    tier: 'tier_a',
    required_datasets: [],
    output_artifacts: ['joined_dataset'],
    depends_on: [],
    needs_dataset_profile: true,
    input_schema: {
      leftDatasetId: 'string (left dataset profile ID)',
      rightDatasetId: 'string (right dataset profile ID)',
      joinType: 'string (inner|left|right|outer)',
      leftKey: 'string (left join column)',
      rightKey: 'string (right join column)',
      userId: 'string',
    },
  },

  {
    id: 'run_ab_test',
    name: 'A/B Test Analysis',
    description: 'Statistical analysis of A/B test results: t-test, chi-square, effect size, confidence intervals, power analysis.',
    category: TOOL_CATEGORY.ANALYTICS,
    keywords_en: ['a/b test', 'ab test', 'experiment', 'significance', 'control', 'treatment', 'hypothesis', 'p-value', 'effect size'],
    keywords_zh: ['A/B測試', '實驗分析', '顯著性', '對照組', '實驗組', '假說檢定', 'p值', '效應量'],
    module: './agent-core/abTestService',
    method: 'analyzeExperiment',
    tier: 'tier_b',
    required_datasets: [],
    output_artifacts: ['ab_test_report'],
    depends_on: [],
    needs_dataset_profile: true,
    input_schema: {
      datasetId: 'string (dataset profile ID)',
      treatmentColumn: 'string (column containing group labels)',
      metricColumn: 'string (column containing the metric to compare)',
      controlValue: 'string (control group value)',
      treatmentValue: 'string (treatment group value)',
      alpha: 'number (significance level, default 0.05)',
      userId: 'string',
    },
  },

  {
    id: 'run_regression',
    name: 'Regression Analysis',
    description: 'Fit regression models (OLS, logistic, ridge) with feature importance, residual diagnostics, and multi-collinearity detection.',
    category: TOOL_CATEGORY.ANALYTICS,
    keywords_en: ['regression', 'linear model', 'predict', 'feature importance', 'coefficients', 'r-squared', 'ols', 'logistic'],
    keywords_zh: ['迴歸', '線性模型', '預測', '特徵重要性', '係數', 'R平方', '邏輯迴歸', '迴歸分析'],
    module: './forecast/regressionService',
    method: 'runRegression',
    tier: 'tier_b',
    required_datasets: [],
    output_artifacts: ['regression_report'],
    depends_on: [],
    needs_dataset_profile: true,
    input_schema: {
      datasetId: 'string (dataset profile ID)',
      target: 'string (target variable column)',
      features: 'string[] (feature columns)',
      method: 'string (ols|logistic|ridge)',
      userId: 'string',
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
