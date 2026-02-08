// ============================================
// BOM Explosion Edge Function - Type Definitions
// ============================================

export interface BomExplosionRequest {
  plantId?: string;
  timeBuckets?: string[];
  demandSource: 'demand_fg' | 'demand_forecast';
  demandForecastRunId?: string;
  inboundSource?: string;
  supplyForecastRunId?: string;
  scenarioName?: string;
  metadata?: Record<string, any>;
  // v1 新增: 强制新建 run（不重用 completed job）
  forceNewRun?: boolean;
  // v1 新增: 启用分片
  enableSharding?: boolean;
  // Logic Control Center: 指定配置版本 ID（用于 sandbox/draft 测试）
  logicVersionId?: string;
}

export interface BomExplosionResponse {
  success: boolean;
  batchId: string;
  forecastRunId: string;
  jobKey: string;
  status: 'running' | 'completed' | 'failed' | 'reused';
  progress: number;
  message?: string;
  // 如果是 reused completed job
  reusedFromBatchId?: string;
  completedAt?: string;
  resultSummary?: {
    componentDemandCount: number;
    traceCount: number;
    errorsCount: number;
  };
}

export interface BomExplosionResult {
  success: boolean;
  batchId: string;
  forecastRunId: string;
  componentDemandCount: number;
  traceCount: number;
  errors: BomExplosionError[];
}

export interface BomExplosionError {
  type: string;
  message: string;
  details?: any;
  material?: string;
  path?: string[];
}

// Database Types
export interface FGDemand {
  id?: string;
  material_code: string;
  plant_id: string;
  time_bucket: string;
  demand_qty: number;
  source_type?: string | null;
  source_id?: string | null;
}

export interface BOMEdge {
  id?: string;
  parent_material: string;
  child_material: string;
  plant_id?: string | null;
  qty_per: number;
  scrap_rate?: number | null;
  yield_rate?: number | null;
  valid_from?: string | null;
  valid_to?: string | null;
  priority?: number | null;
  created_at?: string;
}

export interface ComponentDemand {
  id: string;
  user_id: string;
  batch_id: string;
  forecast_run_id: string;
  material_code: string;
  plant_id: string;
  time_bucket: string;
  demand_qty: number;
  uom: string;
  notes?: string | null;
}

export interface ComponentDemandTrace {
  id?: string;
  user_id: string;
  batch_id: string;
  forecast_run_id: string;
  component_demand_id: string;
  fg_demand_id?: string | null;
  bom_edge_id?: string | null;
  qty_multiplier: number;
  bom_level: number;
  trace_meta: TraceMeta;
}

export interface TraceMeta {
  path: string[];
  fg_material_code: string | null;
  component_material_code: string | null;
  plant_id: string | null;
  time_bucket: string | null;
  fg_qty: number | null;
  component_qty: number | null;
  source_type: string | null;
  source_id: string | null;
  source_fg_demand_id: string | null;
}

export interface ImportBatch {
  id: string;
  user_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'undone' | 'canceled';
  upload_type: string;
  filename: string;
  metadata?: Record<string, any>;
  error_message?: string | null;
  // v1 新增
  job_key?: string | null;
  heartbeat_at?: string | null;
  progress?: number;
  parent_job_id?: string | null;
  job_type?: string;
  started_at?: string | null;
  completed_at?: string | null;
  failed_at?: string | null;
  result_summary?: Record<string, any>;
  // Logic Control Center: 配置版本 ID
  logic_version_id?: string | null;
}

export interface ForecastRun {
  id: string;
  user_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  scenario_name: string;
  parameters: Record<string, any>;
  metadata?: Record<string, any>;
  // v1 新增
  job_key?: string | null;
  heartbeat_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  failed_at?: string | null;
  // Logic Control Center: 配置版本 ID
  logic_version_id?: string | null;
}

// Calculation Types
export interface ExplosionOptions {
  maxDepth?: number;
  ignoreScrap?: boolean;
  userId?: string | null;
  batchId?: string | null;
  forecastRunId?: string | null;
  // v1: Stream flush callbacks
  onTraceChunk?: (traces: TraceRow[]) => Promise<void> | void;
  onDemandChunk?: (demands: ComponentDemandRow[]) => Promise<void> | void;
  traceFlushThreshold?: number;
  demandFlushThreshold?: number;
  // v1: Runtime stats callback
  onProgress?: (stage: string, count: number) => void;
  // Logic Control Center: Configuration for explosion rules
  logicConfig?: import('./logicConfig.ts').LogicConfig;
}

export interface ExplosionResult {
  componentDemandRows: ComponentDemandRow[];
  traceRows: TraceRow[];
  errors: BomExplosionError[];
  // v1: Stats for streaming mode
  stats?: {
    totalTracesGenerated: number;
    totalTracesFlushed: number;
    flushCount: number;
  };
}

export interface ComponentDemandRow {
  material_code: string;
  plant_id: string;
  time_bucket: string;
  demand_qty: number;
  id?: string; // Pre-generated UUID
}

export interface TraceRow {
  fg_material_code: string;
  component_material_code: string;
  plant_id: string;
  time_bucket: string;
  fg_qty: number;
  component_qty: number;
  source_type: string | null;
  source_id: string | null;
  fg_demand_id: string | null;
  bom_edge_id: string | null;
  bom_level: number;
  qty_multiplier: number;
  path: string[];
}

// Constants
export const DEFAULTS = {
  MAX_BOM_DEPTH: 50,
  DEFAULT_SCRAP_RATE: 0,
  DEFAULT_YIELD_RATE: 1,
  DEFAULT_QTY_PER: 1,
  QUANTITY_DECIMALS: 4,
  MIN_SCRAP_RATE: 0,
  MAX_SCRAP_RATE: 0.99,
  MIN_YIELD_RATE: 0.01,
  MAX_YIELD_RATE: 1,
  MIN_QTY_PER: 0,
  DEFAULT_UOM: 'pcs',
  // v1 新增: 心跳间隔秒数
  HEARTBEAT_INTERVAL_SECONDS: 30,
};

export const LIMITS = {
  MAX_FG_DEMAND_ROWS: 10000,
  MAX_BOM_EDGES_ROWS: 50000,
  MAX_BOM_DEPTH: 50,
  MAX_TRACE_ROWS_PER_RUN: 500000,
  INSERT_CHUNK_SIZE_DEMAND: 1000,
  INSERT_CHUNK_SIZE_TRACE: 5000,
};

// Progress 阶段定义
export const PROGRESS_STAGES = {
  VALIDATED: 5,
  FETCHED_DEMAND: 15,
  BUILT_INDEX: 25,
  EXPLODED: 70,
  AGGREGATED: 90,
  PERSISTED: 98,
  COMPLETED: 100,
} as const;

export const ERROR_MESSAGES = {
  INVALID_ARRAY: (name: string) => `${name} must be an array`,
  EMPTY_ARRAY: (name: string) => `${name} cannot be empty`,
  INVALID_NUMBER: (name: string) => `${name} must be a valid number`,
  NEGATIVE_NUMBER: (name: string) => `${name} cannot be negative`,
  OUT_OF_RANGE: (name: string, min: number, max: number) => `${name} must be between ${min} and ${max}`,
  MISSING_FIELD: (field: string) => `Missing required field: ${field}`,
  CIRCULAR_BOM: 'Circular BOM reference detected',
  MAX_DEPTH: (depth: number) => `BOM explosion depth exceeded maximum limit (${depth})`,
  MISSING_BOM_DEFINITION: (material: string) => `No BOM definition found for ${material}`,
  INVALID_TIME_BUCKET: (bucket: string) => `Cannot parse time_bucket: ${bucket}`,
};
