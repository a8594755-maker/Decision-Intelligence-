import { z } from 'zod';

export const PLANNING_CONTRACT_VERSION = '1.0';
export const PLANNING_STATUSES = ['OPTIMAL', 'FEASIBLE', 'INFEASIBLE', 'TIMEOUT', 'ERROR'];

export const planningStatusSchema = z.enum(PLANNING_STATUSES);

const planLineSchema = z.object({
  sku: z.string(),
  plant_id: z.string().nullable().optional(),
  order_date: z.string(),
  arrival_date: z.string(),
  order_qty: z.number()
}).passthrough();

const componentPlanLineSchema = z.object({
  component_sku: z.string(),
  plant_id: z.string().nullable().optional(),
  order_date: z.string(),
  arrival_date: z.string(),
  order_qty: z.number()
}).passthrough();

const proofSchema = z.object({
  objective_terms: z.array(z.object({
    name: z.string(),
    value: z.any().optional(),
    note: z.string().optional().nullable(),
    units: z.string().optional().nullable(),
    business_label: z.string().optional().nullable(),
    qty_driver: z.number().optional().nullable(),
    unit_cost_driver: z.number().optional().nullable()
  }).passthrough()).default([]),
  constraints_checked: z.array(z.object({
    name: z.string(),
    passed: z.boolean(),
    details: z.string().optional(),
    tag: z.string().optional(),
    tags: z.array(z.string()).optional(),
    binding: z.boolean().optional().nullable(),
    slack: z.number().optional().nullable(),
    slack_unit: z.string().optional().nullable(),
    shadow_price_approx: z.number().optional().nullable(),
    shadow_price_dual: z.number().optional().nullable(),
    shadow_price_unit: z.string().optional().nullable(),
    shadow_price_method: z.string().optional().nullable(),
    natural_language: z.string().optional().nullable()
  }).passthrough()).default([]),
  constraint_tags: z.array(z.object({}).passthrough()).default([]),
  infeasibility_analysis: z.object({
    categories: z.array(z.string()).default([]),
    top_offending_tags: z.array(z.string()).default([]),
    suggestions: z.array(z.string()).default([])
  }).passthrough().default({ categories: [], top_offending_tags: [], suggestions: [] }),
  relaxation_analysis: z.array(z.object({}).passthrough()).default([]),
  diagnose_mode: z.boolean().default(false)
}).passthrough();

const kpisSchema = z.object({
  estimated_service_level: z.number().nullable().optional(),
  estimated_stockout_units: z.number().nullable().optional(),
  estimated_holding_units: z.number().nullable().optional(),
  estimated_total_cost: z.number().nullable().optional()
}).passthrough();

const solverMetaSchema = z.object({
  engine: z.string(),
  solve_time_ms: z.number(),
  status: planningStatusSchema,
  termination_reason: z.string(),
  time_limit: z.number(),
  seed: z.number(),
  workers: z.number(),
  solver: z.string().optional(),
  objective_value: z.number().nullable().optional(),
  gap: z.number().nullable().optional()
}).passthrough();

const infeasibleReasonDetailSchema = z.object({
  category: z.string().default('capacity'),
  top_offending_tags: z.array(z.string()).default([]),
  suggested_actions: z.array(z.string()).default([])
}).passthrough();

const componentProjectionSchema = z.object({
  total_rows: z.number(),
  rows: z.array(z.object({}).passthrough()),
  truncated: z.boolean().default(false)
}).passthrough();

const bottlenecksSchema = z.object({
  generated_at: z.string().nullable().optional(),
  total_rows: z.number(),
  rows: z.array(z.object({}).passthrough()),
  items: z.array(z.object({}).passthrough()).optional().default([])
}).passthrough();

export const planningResponseSchema = z.object({
  contract_version: z.string(),
  status: planningStatusSchema,
  plan_lines: z.array(planLineSchema),
  plan: z.array(planLineSchema),
  component_plan: z.array(componentPlanLineSchema),
  component_inventory_projection: componentProjectionSchema,
  bottlenecks: bottlenecksSchema,
  kpis: kpisSchema,
  shared_kpis: z.object({}).passthrough().default({}),
  solver_meta: solverMetaSchema,
  infeasible_reasons: z.array(z.string()),
  infeasible_reason_details: z.array(infeasibleReasonDetailSchema).default([]),
  diagnostics: z.object({}).passthrough().default({}),
  proof: proofSchema,
  explain_summary: z.object({
    headline: z.string().default(''),
    top_binding_constraint: z.string().nullable().optional(),
    key_relaxation: z.object({
      constraint: z.string(),
      relax_by: z.number().nullable().optional(),
      relax_unit: z.string().nullable().optional(),
      estimated_saving: z.number().nullable().optional(),
      saving_unit: z.string().nullable().optional(),
      nl_text: z.string().nullable().optional()
    }).passthrough().nullable().optional(),
    confidence: z.string().default('medium')
  }).passthrough().nullable().optional()
}).passthrough();

const forecastPointSchema = z.object({
  sku: z.string(),
  plant_id: z.string().nullable().optional(),
  date: z.string(),
  p10: z.number().nullable().optional(),
  p50: z.number(),
  p90: z.number().nullable().optional()
}).passthrough();

const periodCapacitySchema = z.object({
  date: z.string(),
  capacity: z.number()
}).passthrough();

const capacityValueSchema = z.union([
  z.number(),
  z.array(periodCapacitySchema),
  z.record(z.string(), z.any())
]);

const skuQtySchema = z.object({
  sku: z.string(),
  min_qty: z.number().optional().nullable(),
  pack_qty: z.number().optional().nullable(),
  max_qty: z.number().optional().nullable()
}).passthrough();

const constraintsSchema = z.object({
  moq: z.array(skuQtySchema).default([]),
  pack_size: z.array(skuQtySchema).default([]),
  budget_cap: z.number().nullable().optional(),
  max_order_qty: z.array(skuQtySchema).default([]),
  unit_costs: z.array(z.object({
    sku: z.string(),
    unit_cost: z.number().nullable().optional()
  }).passthrough()).default([]),
  inventory_capacity_per_period: capacityValueSchema.optional().nullable(),
  production_capacity_per_period: capacityValueSchema.optional().nullable()
}).passthrough();

const sharedConstraintsSchema = z.object({
  budget_cap: z.number().nullable().optional(),
  budget_mode: z.string().optional(),
  production_capacity_per_period: capacityValueSchema.optional().nullable(),
  inventory_capacity_per_period: capacityValueSchema.optional().nullable(),
  priority_weights: z.record(z.string(), z.number()).optional()
}).passthrough();

const solverOptionsSchema = z.object({
  time_limit_seconds: z.number().nullable().optional(),
  seed: z.number().nullable().optional(),
  workers: z.number().nullable().optional(),
  random_seed: z.number().nullable().optional(),
  num_search_workers: z.number().nullable().optional(),
  deterministic_mode: z.boolean().nullable().optional(),
  force_timeout: z.boolean().nullable().optional()
}).passthrough();

const itemDemandPointSchema = z.object({
  date: z.string(),
  plant_id: z.string().nullable().optional(),
  p10: z.number().nullable().optional(),
  p50: z.number().nullable().optional(),
  p90: z.number().nullable().optional(),
  demand: z.number().nullable().optional()
}).passthrough();

const planningItemSchema = z.object({
  sku: z.string(),
  plant_id: z.string().nullable().optional(),
  priority_weight: z.number().nullable().optional(),
  service_level_weight: z.number().nullable().optional(),
  on_hand: z.number().nullable().optional(),
  safety_stock: z.number().nullable().optional(),
  lead_time_days: z.number().nullable().optional(),
  demand: z.array(itemDemandPointSchema).optional(),
  demand_series: z.array(itemDemandPointSchema).optional(),
  series: z.array(itemDemandPointSchema).optional(),
  demand_forecast: z.object({
    series: z.array(itemDemandPointSchema).optional().default([]),
    granularity: z.string().optional()
  }).passthrough().optional(),
  costs: z.object({
    unit_cost: z.number().nullable().optional()
  }).passthrough().optional(),
  constraints: z.object({
    moq: z.number().nullable().optional(),
    pack_size: z.number().nullable().optional(),
    max_order_qty: z.number().nullable().optional()
  }).passthrough().optional()
}).passthrough();

export const planningRequestSchema = z.object({
  contract_version: z.string().optional(),
  dataset_profile_id: z.number().optional(),
  planning_horizon_days: z.number().int().positive(),
  demand_forecast: z.object({
    series: z.array(forecastPointSchema),
    granularity: z.string().optional().default('daily')
  }).passthrough().default({ series: [], granularity: 'daily' }),
  inventory: z.array(z.object({
    sku: z.string(),
    plant_id: z.string().nullable().optional(),
    as_of_date: z.string(),
    on_hand: z.number(),
    safety_stock: z.number().nullable().optional(),
    lead_time_days: z.number().nullable().optional()
  }).passthrough()).default([]),
  open_pos: z.array(z.object({
    sku: z.string(),
    plant_id: z.string().nullable().optional(),
    eta_date: z.string(),
    qty: z.number()
  }).passthrough()).default([]),
  constraints: constraintsSchema.default({
    moq: [],
    pack_size: [],
    max_order_qty: [],
    unit_costs: []
  }),
  objective: z.object({
    optimize_for: z.string().optional(),
    stockout_penalty: z.number().nullable().optional(),
    holding_cost: z.number().nullable().optional(),
    service_level_target: z.number().nullable().optional()
  }).passthrough().default({}),
  shared_constraints: sharedConstraintsSchema.optional().default({}),
  solver: solverOptionsSchema.optional().default({}),
  settings: z.object({
    solver: solverOptionsSchema.optional()
  }).passthrough().optional(),
  items: z.array(planningItemSchema).default([]),
  diagnose_mode: z.boolean().optional(),
  multi_echelon: z.object({
    mode: z.string().optional().default('off'),
    max_bom_depth: z.number().nullable().optional(),
    lot_sizing_mode: z.string().nullable().optional(),
    bom_explosion_used: z.boolean().nullable().optional(),
    bom_explosion_reused: z.boolean().nullable().optional(),
    production_capacity_per_period: capacityValueSchema.nullable().optional(),
    inventory_capacity_per_period: capacityValueSchema.nullable().optional(),
    component_stockout_penalty: z.number().nullable().optional(),
    fg_to_components_scope: z.object({}).passthrough().optional(),
    mapping_rules: z.object({}).passthrough().optional()
  }).passthrough().default({ mode: 'off' }),
  bom_usage: z.array(z.object({
    fg_sku: z.string(),
    component_sku: z.string(),
    plant_id: z.string().nullable().optional(),
    usage_qty: z.number(),
    level: z.number().nullable().optional(),
    path_count: z.number().nullable().optional()
  }).passthrough()).default([])
}).passthrough();

function normalizeStatus(status) {
  const raw = String(status ?? '').trim().toUpperCase();
  if (PLANNING_STATUSES.includes(raw)) return raw;
  if (raw === 'UNKNOWN') return 'TIMEOUT';
  if (raw === 'MODEL_INVALID') return 'ERROR';

  const lower = String(status ?? '').trim().toLowerCase();
  if (lower === 'optimal') return 'OPTIMAL';
  if (lower === 'feasible') return 'FEASIBLE';
  if (lower === 'infeasible') return 'INFEASIBLE';
  if (lower === 'timeout') return 'TIMEOUT';
  if (lower === 'error') return 'ERROR';
  return 'ERROR';
}

export function validatePlanningRequest(payload = {}) {
  const candidate = {
    ...payload,
    contract_version: String(payload?.contract_version || PLANNING_CONTRACT_VERSION)
  };
  return planningRequestSchema.parse(candidate);
}

export function validatePlanningResponse(payload = {}, options = {}) {
  const defaultEngine = String(options?.defaultEngine || 'heuristic');
  const root = { ...(payload || {}) };

  root.contract_version = String(root.contract_version || PLANNING_CONTRACT_VERSION);
  root.status = normalizeStatus(root.status);

  if (!Array.isArray(root.plan_lines) && Array.isArray(root.plan)) {
    root.plan_lines = root.plan;
  }
  if (!Array.isArray(root.plan_lines)) root.plan_lines = [];
  if (!Array.isArray(root.plan)) root.plan = root.plan_lines;

  if (!Array.isArray(root.component_plan)) root.component_plan = [];
  if (!root.component_inventory_projection || typeof root.component_inventory_projection !== 'object') {
    root.component_inventory_projection = { total_rows: 0, rows: [], truncated: false };
  }
  if (!Array.isArray(root.component_inventory_projection.rows)) {
    root.component_inventory_projection.rows = [];
  }
  if (!Number.isFinite(Number(root.component_inventory_projection.total_rows))) {
    root.component_inventory_projection.total_rows = root.component_inventory_projection.rows.length;
  }
  if (typeof root.component_inventory_projection.truncated !== 'boolean') {
    root.component_inventory_projection.truncated = false;
  }

  if (!root.bottlenecks || typeof root.bottlenecks !== 'object') {
    root.bottlenecks = { generated_at: null, total_rows: 0, rows: [], items: [] };
  }
  if (!Array.isArray(root.bottlenecks.rows)) root.bottlenecks.rows = [];
  if (!Array.isArray(root.bottlenecks.items)) root.bottlenecks.items = root.bottlenecks.rows;
  if (!Number.isFinite(Number(root.bottlenecks.total_rows))) root.bottlenecks.total_rows = root.bottlenecks.rows.length;

  if (!root.kpis || typeof root.kpis !== 'object') {
    root.kpis = {
      estimated_service_level: null,
      estimated_stockout_units: null,
      estimated_holding_units: null,
      estimated_total_cost: null
    };
  }
  if (!root.shared_kpis || typeof root.shared_kpis !== 'object') root.shared_kpis = {};

  if (!Array.isArray(root.infeasible_reasons)) root.infeasible_reasons = [];
  if (!Array.isArray(root.infeasible_reason_details)) {
    root.infeasible_reason_details = Array.isArray(root.infeasible_reasons_detailed)
      ? root.infeasible_reasons_detailed
      : [];
  }
  if (!root.diagnostics || typeof root.diagnostics !== 'object') root.diagnostics = {};

  if (!root.proof || typeof root.proof !== 'object') {
    root.proof = { objective_terms: [], constraints_checked: [] };
  }
  if (!Array.isArray(root.proof.objective_terms)) root.proof.objective_terms = [];
  if (!Array.isArray(root.proof.constraints_checked)) root.proof.constraints_checked = [];
  if (!Array.isArray(root.proof.constraint_tags)) root.proof.constraint_tags = [];
  if (!root.proof.infeasibility_analysis || typeof root.proof.infeasibility_analysis !== 'object') {
    root.proof.infeasibility_analysis = { categories: [], top_offending_tags: [], suggestions: [] };
  }
  if (!Array.isArray(root.proof.relaxation_analysis)) root.proof.relaxation_analysis = [];
  if (typeof root.proof.diagnose_mode !== 'boolean') {
    root.proof.diagnose_mode = root.diagnostics?.mode === 'progressive_relaxation';
  }

  const solverMeta = (root.solver_meta && typeof root.solver_meta === 'object') ? root.solver_meta : {};
  const engine = String(solverMeta.engine || solverMeta.solver || defaultEngine);
  root.solver_meta = {
    ...solverMeta,
    engine,
    solver: String(solverMeta.solver || engine),
    solve_time_ms: Number.isFinite(Number(solverMeta.solve_time_ms)) ? Number(solverMeta.solve_time_ms) : 0,
    termination_reason: String(solverMeta.termination_reason || 'unspecified'),
    time_limit: Number.isFinite(Number(solverMeta.time_limit)) ? Number(solverMeta.time_limit) : 0,
    seed: Number.isFinite(Number(solverMeta.seed)) ? Number(solverMeta.seed) : 0,
    workers: Number.isFinite(Number(solverMeta.workers)) ? Math.max(1, Number(solverMeta.workers)) : 1,
    status: root.status
  };

  return planningResponseSchema.parse(root);
}
