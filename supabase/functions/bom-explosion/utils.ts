// ============================================
// BOM Explosion Edge Function - Utilities
// ============================================

import type { ComponentDemandRow, TraceRow, BomExplosionError } from './types.ts';
import { DEFAULTS, ERROR_MESSAGES } from './types.ts';

/**
 * Generate UUID v4
 */
export function generateUUID(): string {
  return crypto.randomUUID();
}

/**
 * Batch insert helper - splits large arrays into chunks
 */
export async function batchInsert<T>(
  insertFn: (chunk: T[]) => Promise<{ error: Error | null }>,
  rows: T[],
  chunkSize: number
): Promise<{ success: boolean; error?: Error }> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await insertFn(chunk);
    if (error) {
      return { success: false, error };
    }
  }
  return { success: true };
}

/**
 * Round to specified decimal places
 */
export function roundTo(value: number, decimals: number = DEFAULTS.QUANTITY_DECIMALS): number {
  if (typeof value !== 'number' || isNaN(value)) {
    throw new Error(ERROR_MESSAGES.INVALID_NUMBER('value'));
  }
  if (typeof decimals !== 'number' || decimals < 0) {
    throw new Error(ERROR_MESSAGES.INVALID_NUMBER('decimals'));
  }
  return Math.round(value * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

/**
 * Generate aggregation key for Map indexing
 */
export function getAggregationKey(plantId: string, timeBucket: string, materialCode: string): string {
  if (!plantId || typeof plantId !== 'string') {
    throw new Error(ERROR_MESSAGES.MISSING_FIELD('plantId'));
  }
  if (!timeBucket || typeof timeBucket !== 'string') {
    throw new Error(ERROR_MESSAGES.MISSING_FIELD('timeBucket'));
  }
  if (!materialCode || typeof materialCode !== 'string') {
    throw new Error(ERROR_MESSAGES.MISSING_FIELD('materialCode'));
  }
  return `${plantId}|${timeBucket}|${materialCode}`;
}

/**
 * Parse aggregation key
 */
export function parseAggregationKey(key: string): { plantId: string; timeBucket: string; materialCode: string } {
  const [plantId, timeBucket, materialCode] = key.split('|');
  return { plantId, timeBucket, materialCode };
}

/**
 * Convert time_bucket string to Date
 * Supports YYYY-MM-DD and YYYY-W## formats
 */
export function timeBucketToDate(timeBucket: string): Date | null {
  if (!timeBucket) return null;

  // YYYY-MM-DD format
  if (/^\d{4}-\d{2}-\d{2}$/.test(timeBucket)) {
    return new Date(timeBucket);
  }

  // YYYY-W## format (ISO week)
  const weekMatch = timeBucket.match(/^(\d{4})-W(\d{2})$/);
  if (weekMatch) {
    const year = parseInt(weekMatch[1], 10);
    const week = parseInt(weekMatch[2], 10);

    // ISO 8601: Week 1 contains January 4
    const jan4 = new Date(year, 0, 4);
    const dayOfWeek = jan4.getDay(); // 0=Sunday, 1=Monday, ...
    const daysToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const firstMonday = new Date(jan4);
    firstMonday.setDate(jan4.getDate() + daysToMonday);

    const targetMonday = new Date(firstMonday);
    targetMonday.setDate(firstMonday.getDate() + (week - 1) * 7);

    return targetMonday;
  }

  return null;
}

/**
 * Build lookup map for component_demand IDs
 * Key format: plantId|timeBucket|materialCode
 */
export function buildDemandIdMap(componentDemandRows: ComponentDemandRow[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of componentDemandRows) {
    const key = getAggregationKey(row.plant_id, row.time_bucket, row.material_code);
    map.set(key, row.id!);
  }
  return map;
}

/**
 * Format error for consistent response structure
 */
export function formatError(
  type: string,
  message: string,
  details?: any,
  material?: string,
  path?: string[]
): BomExplosionError {
  return {
    type,
    message,
    details,
    material,
    path,
  };
}

/**
 * Validate request payload
 */
export function validateRequest(body: any): { valid: boolean; error?: string } {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Request body must be an object' };
  }

  if (!body.demandSource) {
    return { valid: false, error: 'demandSource is required' };
  }

  const validSources = ['demand_fg', 'demand_forecast'];
  if (!validSources.includes(body.demandSource)) {
    return { valid: false, error: `demandSource must be one of: ${validSources.join(', ')}` };
  }

  if (body.demandSource === 'demand_forecast' && !body.demandForecastRunId) {
    return { valid: false, error: 'demandForecastRunId is required when demandSource is demand_forecast' };
  }

  return { valid: true };
}

/**
 * Check if value is within valid range
 */
export function isInRange(value: number, min: number, max: number): boolean {
  return typeof value === 'number' && !isNaN(value) && value >= min && value <= max;
}

/**
 * Generate job key for idempotency
 * Format: hash(userId + params)
 */
export function generateJobKey(
  userId: string,
  params: {
    plantId?: string;
    timeBuckets?: string[];
    demandForecastRunId?: string;
    supplyForecastRunId?: string;
    scenarioName?: string;
  }
): string {
  const keyData = {
    u: userId,
    p: params.plantId || 'all',
    t: (params.timeBuckets || []).sort().join(','),
    d: params.demandForecastRunId || 'none',
    s: params.supplyForecastRunId || 'none',
    sc: params.scenarioName || 'baseline',
  };
  
  // Simple hash function for deterministic key generation
  const str = JSON.stringify(keyData);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  
  // Convert to positive hex string
  return Math.abs(hash).toString(16).padStart(16, '0');
}
