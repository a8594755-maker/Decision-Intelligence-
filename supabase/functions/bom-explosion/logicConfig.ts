// ============================================
// Logic Configuration Utility
// Phase 1: Backend - Config Resolution
// ============================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { DEFAULTS, LIMITS } from './types.ts';

// Extended configuration interface including Logic Control Center settings
export interface LogicConfig {
  schema_version: string;
  limits: {
    MAX_FG_DEMAND_ROWS: number;
    MAX_BOM_EDGES_ROWS: number;
    MAX_BOM_DEPTH: number;
    MAX_TRACE_ROWS_PER_RUN: number;
    INSERT_CHUNK_SIZE_DEMAND: number;
    INSERT_CHUNK_SIZE_TRACE: number;
    ZOMBIE_AFTER_SECONDS: number;
    MAX_CONCURRENT_JOBS_PER_USER: number;
  };
  rules: {
    edge_selection: {
      plant_match_strategy: 'exact_first_then_null' | 'exact_only' | 'null_only';
      validity_enforced: boolean;
      priority_strategy: 'min_priority' | 'max_priority' | 'first_match';
      tie_breaker: 'latest_created_at' | 'earliest_created_at' | 'random';
    };
    scrap_yield: {
      default_scrap_rate: number;
      default_yield_rate: number;
      min_scrap_rate: number;
      max_scrap_rate: number;
      min_yield_rate: number;
      max_yield_rate: number;
    };
    rounding: {
      decimal_places: number;
    };
    cycle_policy: 'warn_and_cut' | 'fail';
    max_depth_policy: 'warn_and_cut' | 'fail';
  };
  sharding: {
    strategy: 'none' | 'by_time_bucket' | 'by_fg_batch';
    shard_size_weeks: number;
    merge_policy: 'sum' | 'dedupe' | 'sum_and_dedupe';
  };
  staging: {
    commit_mode: 'all_or_nothing' | 'best_effort';
    auto_cleanup_on_fail: boolean;
  };
}

export interface LogicVersionInfo {
  version_id: string;
  config: LogicConfig;
  schema_version: string;
  published_at: string;
  scope_level: string;
  scope_id: string | null;
}

// Default configuration (fallback when no DB version exists)
const DEFAULT_LOGIC_CONFIG: LogicConfig = {
  schema_version: '1.0',
  limits: {
    MAX_FG_DEMAND_ROWS: LIMITS.MAX_FG_DEMAND_ROWS,
    MAX_BOM_EDGES_ROWS: LIMITS.MAX_BOM_EDGES_ROWS,
    MAX_BOM_DEPTH: LIMITS.MAX_BOM_DEPTH,
    MAX_TRACE_ROWS_PER_RUN: LIMITS.MAX_TRACE_ROWS_PER_RUN,
    INSERT_CHUNK_SIZE_DEMAND: LIMITS.INSERT_CHUNK_SIZE_DEMAND,
    INSERT_CHUNK_SIZE_TRACE: LIMITS.INSERT_CHUNK_SIZE_TRACE,
    ZOMBIE_AFTER_SECONDS: DEFAULTS.HEARTBEAT_INTERVAL_SECONDS * 4,
    MAX_CONCURRENT_JOBS_PER_USER: 3,
  },
  rules: {
    edge_selection: {
      plant_match_strategy: 'exact_first_then_null',
      validity_enforced: true,
      priority_strategy: 'min_priority',
      tie_breaker: 'latest_created_at',
    },
    scrap_yield: {
      default_scrap_rate: DEFAULTS.DEFAULT_SCRAP_RATE,
      default_yield_rate: DEFAULTS.DEFAULT_YIELD_RATE,
      min_scrap_rate: DEFAULTS.MIN_SCRAP_RATE,
      max_scrap_rate: DEFAULTS.MAX_SCRAP_RATE,
      min_yield_rate: DEFAULTS.MIN_YIELD_RATE,
      max_yield_rate: DEFAULTS.MAX_YIELD_RATE,
    },
    rounding: {
      decimal_places: DEFAULTS.QUANTITY_DECIMALS,
    },
    cycle_policy: 'warn_and_cut',
    max_depth_policy: 'fail',
  },
  sharding: {
    strategy: 'none',
    shard_size_weeks: 4,
    merge_policy: 'sum_and_dedupe',
  },
  staging: {
    commit_mode: 'all_or_nothing',
    auto_cleanup_on_fail: true,
  },
};

/**
 * Fetch the published logic configuration for a given scope
 * Implements scope hierarchy: PLANT -> GLOBAL fallback
 */
export async function fetchPublishedLogic(
  supabase: SupabaseClient,
  logicId: string,
  scopeLevel: 'GLOBAL' | 'PLANT' = 'GLOBAL',
  scopeId?: string
): Promise<LogicVersionInfo | null> {
  // First, try to get the exact scope match using the RPC function
  const { data, error } = await supabase.rpc('get_published_logic_version', {
    p_logic_id: logicId,
    p_scope_level: scopeLevel,
    p_scope_id: scopeId || null,
  });

  if (error) {
    console.error('Error fetching published logic:', error);
    return null;
  }

  if (!data || data.length === 0) {
    // No published version found for this exact scope
    // If we were looking for PLANT, try GLOBAL fallback
    if (scopeLevel === 'PLANT') {
      return fetchPublishedLogic(supabase, logicId, 'GLOBAL');
    }
    return null;
  }

  const row = data[0];
  const config = mergeWithDefaults(row.config_json);

  return {
    version_id: row.version_id,
    config,
    schema_version: row.schema_version,
    published_at: row.published_at,
    scope_level: scopeLevel,
    scope_id: scopeId || null,
  };
}

/**
 * Fetch a specific logic version by ID (for draft/sandbox testing)
 */
export async function fetchLogicVersionById(
  supabase: SupabaseClient,
  versionId: string
): Promise<LogicVersionInfo | null> {
  const { data, error } = await supabase
    .from('logic_versions')
    .select('id, config_json, schema_version, published_at, scope_level, scope_id, status')
    .eq('id', versionId)
    .single();

  if (error || !data) {
    console.error('Error fetching logic version:', error);
    return null;
  }

  const config = mergeWithDefaults(data.config_json);

  return {
    version_id: data.id,
    config,
    schema_version: data.schema_version,
    published_at: data.published_at,
    scope_level: data.scope_level,
    scope_id: data.scope_id,
  };
}

/**
 * Merge database config with hardcoded defaults
 * Ensures all required fields exist even if not in DB
 */
export function mergeWithDefaults(dbConfig: Record<string, unknown>): LogicConfig {
  const merged: LogicConfig = {
    ...DEFAULT_LOGIC_CONFIG,
  };

  if (!dbConfig || typeof dbConfig !== 'object') {
    return merged;
  }

  // Merge limits
  if (dbConfig.limits && typeof dbConfig.limits === 'object') {
    merged.limits = {
      ...merged.limits,
      ...dbConfig.limits as Partial<LogicConfig['limits']>,
    };
  }

  // Merge rules
  if (dbConfig.rules && typeof dbConfig.rules === 'object') {
    const dbRules = dbConfig.rules as Record<string, unknown>;
    
    merged.rules = {
      ...merged.rules,
    };

    if (dbRules.edge_selection && typeof dbRules.edge_selection === 'object') {
      merged.rules.edge_selection = {
        ...merged.rules.edge_selection,
        ...dbRules.edge_selection as Partial<LogicConfig['rules']['edge_selection']>,
      };
    }

    if (dbRules.scrap_yield && typeof dbRules.scrap_yield === 'object') {
      merged.rules.scrap_yield = {
        ...merged.rules.scrap_yield,
        ...dbRules.scrap_yield as Partial<LogicConfig['rules']['scrap_yield']>,
      };
    }

    if (dbRules.rounding && typeof dbRules.rounding === 'object') {
      merged.rules.rounding = {
        ...merged.rules.rounding,
        ...dbRules.rounding as Partial<LogicConfig['rules']['rounding']>,
      };
    }

    if (dbRules.cycle_policy) {
      merged.rules.cycle_policy = dbRules.cycle_policy as LogicConfig['rules']['cycle_policy'];
    }

    if (dbRules.max_depth_policy) {
      merged.rules.max_depth_policy = dbRules.max_depth_policy as LogicConfig['rules']['max_depth_policy'];
    }
  }

  // Merge sharding
  if (dbConfig.sharding && typeof dbConfig.sharding === 'object') {
    merged.sharding = {
      ...merged.sharding,
      ...dbConfig.sharding as Partial<LogicConfig['sharding']>,
    };
  }

  // Merge staging
  if (dbConfig.staging && typeof dbConfig.staging === 'object') {
    merged.staging = {
      ...merged.staging,
      ...dbConfig.staging as Partial<LogicConfig['staging']>,
    };
  }

  return merged;
}

/**
 * Validate configuration at runtime
 * Returns validation result with any errors
 */
export function validateConfig(config: LogicConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Validate limits ranges
  if (config.limits.MAX_BOM_DEPTH > 100) {
    errors.push('MAX_BOM_DEPTH cannot exceed 100');
  }
  if (config.limits.MAX_BOM_DEPTH < 1) {
    errors.push('MAX_BOM_DEPTH must be at least 1');
  }
  if (config.limits.ZOMBIE_AFTER_SECONDS < 30) {
    errors.push('ZOMBIE_AFTER_SECONDS must be at least 30');
  }
  if (config.limits.MAX_TRACE_ROWS_PER_RUN > 2000000) {
    errors.push('MAX_TRACE_ROWS_PER_RUN cannot exceed 2,000,000');
  }

  // Validate scrap/yield ranges
  const sy = config.rules.scrap_yield;
  if (sy.min_scrap_rate < 0 || sy.min_scrap_rate > 1) {
    errors.push('min_scrap_rate must be between 0 and 1');
  }
  if (sy.max_scrap_rate < 0 || sy.max_scrap_rate > 1) {
    errors.push('max_scrap_rate must be between 0 and 1');
  }
  if (sy.min_scrap_rate >= sy.max_scrap_rate) {
    errors.push('min_scrap_rate must be less than max_scrap_rate');
  }
  if (sy.min_yield_rate < 0 || sy.min_yield_rate > 1) {
    errors.push('min_yield_rate must be between 0 and 1');
  }
  if (sy.max_yield_rate < 0 || sy.max_yield_rate > 1) {
    errors.push('max_yield_rate must be between 0 and 1');
  }
  if (sy.min_yield_rate >= sy.max_yield_rate) {
    errors.push('min_yield_rate must be less than max_yield_rate');
  }

  // Validate enums
  const validStrategies = ['none', 'by_time_bucket', 'by_fg_batch'];
  if (!validStrategies.includes(config.sharding.strategy)) {
    errors.push(`sharding.strategy must be one of: ${validStrategies.join(', ')}`);
  }

  const validCommitModes = ['all_or_nothing', 'best_effort'];
  if (!validCommitModes.includes(config.staging.commit_mode)) {
    errors.push(`staging.commit_mode must be one of: ${validCommitModes.join(', ')}`);
  }

  const validCyclePolicies = ['warn_and_cut', 'fail'];
  if (!validCyclePolicies.includes(config.rules.cycle_policy)) {
    errors.push(`rules.cycle_policy must be one of: ${validCyclePolicies.join(', ')}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Clamp a value within the allowed scrap/yield range
 */
export function clampScrapRate(config: LogicConfig, value: number): number {
  const { min_scrap_rate, max_scrap_rate } = config.rules.scrap_yield;
  return Math.max(min_scrap_rate, Math.min(max_scrap_rate, value));
}

export function clampYieldRate(config: LogicConfig, value: number): number {
  const { min_yield_rate, max_yield_rate } = config.rules.scrap_yield;
  return Math.max(min_yield_rate, Math.min(max_yield_rate, value));
}

/**
 * Get heartbeat threshold in milliseconds based on config
 */
export function getHeartbeatThresholdMs(config: LogicConfig): number {
  return config.limits.ZOMBIE_AFTER_SECONDS * 1000;
}

/**
 * Check if sharding is enabled for this configuration
 */
export function isShardingEnabled(config: LogicConfig): boolean {
  return config.sharding.strategy !== 'none';
}

/**
 * Get chunk size for demand inserts
 */
export function getDemandChunkSize(config: LogicConfig): number {
  return config.limits.INSERT_CHUNK_SIZE_DEMAND;
}

/**
 * Get chunk size for trace inserts
 */
export function getTraceChunkSize(config: LogicConfig): number {
  return config.limits.INSERT_CHUNK_SIZE_TRACE;
}
