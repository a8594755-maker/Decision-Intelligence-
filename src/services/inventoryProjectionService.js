/**
 * Inventory Projection — Forecasts Inventory Tab only
 *
 * [Single entry point] This file only provides loadInventoryProjection (for Forecasts Tab).
 * Risk Dashboard's loadInventoryProjectionForRisk / computeSeriesForKey / WARN|STOP constants
 * must be imported from inventoryProjectionForRiskService.js. Do not export same-name Risk loader here.
 */

import {
  componentDemandService,
  poOpenLinesService,
  inventorySnapshotsService
} from './supabaseClient.js';
import { supplyForecastService } from './supplyForecastService.js';
import {
  projectInventoryByBuckets,
  buildDemandByBucket,
  buildInboundByBucket,
  buildStartingInventory,
  computeSeriesForKey as computeSeriesFromDomain
} from '../domains/inventory/inventoryProjection.js';

// Performance guardrail constants (Forecasts Inventory Tab only)
export const FORECAST_WARN_ROWS = parseInt(import.meta.env.VITE_PROJECTION_WARN_ROWS) || 30_000;
export const FORECAST_STOP_ROWS = parseInt(import.meta.env.VITE_PROJECTION_STOP_ROWS) || 100_000;
export const FORECAST_TOP_N = parseInt(import.meta.env.VITE_PROJECTION_TOP_N) || 500;

/**
 * Compute bucket series for a single key from cache (for expandable rows)
 * @param {{ timeBuckets: string[], startingInventory: Map, demandByBucket: Map, inboundByBucket: Map }} cache
 * @param {string} key
 * @returns {Array<{ bucket: string, begin: number, inbound: number, demand: number, end: number, available: number, shortageFlag: boolean }>}
 */
export function computeSeriesForKey(cache, key) {
  return computeSeriesFromDomain(cache, key);
}

/**
 * Load projection for Forecasts → Inventory Tab
 * Returns summaryRows (with KPI info), cache (for expandable rows), perf, meta, kpis
 *
 * @param {string} userId
 * @param {string} forecastRunId
 * @param {string[]} timeBuckets - run.parameters.time_buckets
 * @param {string|null} plantId - run.parameters.plant_id or null
 * @param {Object} options - Additional options
 * @param {string} options.inboundSource - 'raw_po' | 'supply_forecast', default 'raw_po'
 * @param {string|null} options.supplyForecastRunId - Used when inboundSource='supply_forecast'
 * @returns {Promise<{
 *   mode: 'FULL' | 'WARN' | 'STOP',
 *   reason?: string,
 *   summaryRows: Array<{ key: string, stockoutBucket: string|null, shortageQty: number, minAvailable: number, startOnHand: number, totalDemand: number, totalInbound: number }>,
 *   cache: { timeBuckets: string[], startingInventory: Map, demandByBucket: Map, inboundByBucket: Map },
 *   perf: { demandRows: number, inboundRows: number, snapshotRows: number, totalRows: number, fetchMs: number, computeMs: number, keys: number },
 *   kpis: { itemsProjected: number, atRiskItems: number, earliestStockoutBucket: string|null, totalShortageQty: number },
 *   meta: { noSnapshotKeys?: string[], inboundSource?: string, supplyForecastRunId?: string|null }
 * }>}
 */
export async function loadInventoryProjection(userId, forecastRunId, timeBuckets, plantId = null, options = {}) {
  const { inboundSource = 'raw_po', supplyForecastRunId = null } = options;
  const emptyResult = (mode, reason) => ({
    mode,
    reason,
    summaryRows: [],
    cache: { timeBuckets: [], startingInventory: new Map(), demandByBucket: new Map(), inboundByBucket: new Map() },
    perf: { demandRows: 0, inboundRows: 0, snapshotRows: 0, totalRows: 0, fetchMs: 0, computeMs: 0, keys: 0 },
    kpis: { itemsProjected: 0, atRiskItems: 0, earliestStockoutBucket: null, totalShortageQty: 0 },
    meta: { inboundSource, supplyForecastRunId }
  });

  if (!userId || !forecastRunId || !Array.isArray(timeBuckets) || timeBuckets.length === 0) {
    return emptyResult('STOP', 'invalid_params');
  }

  const t0 = Date.now();
  let demandRows = [];
  let inboundRows = [];
  let snapshotRows = [];
  
  try {
    // Fetch demand and snapshots regardless of inbound source
    const demandPromise = componentDemandService.getComponentDemandsByForecastRun(userId, forecastRunId, { timeBuckets, plantId });
    const snapshotPromise = inventorySnapshotsService.getLatestInventorySnapshots(userId, plantId);
    
    // Fetch inbound based on source
    let inboundPromise;
    if (inboundSource === 'supply_forecast' && supplyForecastRunId) {
      // Fetch from supply forecast
      inboundPromise = supplyForecastService.getInboundByRun(userId, supplyForecastRunId, { plantId })
        .then(data => data.map(row => ({
          material_code: row.material_code,
          plant_id: row.plant_id,
          time_bucket: row.time_bucket,
          open_qty: row.p50_qty, // Use p50 as the inbound quantity
          p90_qty: row.p90_qty,
          avg_delay_prob: row.avg_delay_prob,
          supplier_count: row.supplier_count,
          source: 'supply_forecast'
        })));
    } else {
      // Default: fetch from raw PO open lines
      inboundPromise = poOpenLinesService.getInboundByBuckets(userId, timeBuckets, plantId);
    }
    
    [demandRows, inboundRows, snapshotRows] = await Promise.all([
      demandPromise,
      inboundPromise,
      snapshotPromise
    ]);
  } catch (err) {
    console.error('[loadInventoryProjection] fetch error:', err);
    const reason = err?.message || err?.details || 'fetch_error';
    const wrapped = new Error(reason);
    wrapped.cause = err;
    throw wrapped;
  }

  demandRows = demandRows || [];
  inboundRows = inboundRows || [];
  snapshotRows = snapshotRows || [];

  const fetchMs = Date.now() - t0;
  const totalRows = demandRows.length + inboundRows.length + snapshotRows.length;

  // Performance guardrail check
  let mode = 'FULL';
  if (totalRows > FORECAST_STOP_ROWS) {
    return {
      ...emptyResult('STOP', 'rows_too_large'),
      perf: { demandRows: demandRows.length, inboundRows: inboundRows.length, snapshotRows: snapshotRows.length, totalRows, fetchMs, computeMs: 0, keys: 0 }
    };
  } else if (totalRows > FORECAST_WARN_ROWS) {
    mode = 'WARN';
  }

  const t1 = Date.now();
  const demandByBucket = buildDemandByBucket(demandRows);
  const inboundByBucket = buildInboundByBucket(inboundRows);
  const startingInventory = buildStartingInventory(snapshotRows);

  const results = projectInventoryByBuckets({
    timeBuckets,
    startingInventory,
    demandByBucket,
    inboundByBucket
  });
  const computeMs = Date.now() - t1;
  const keys = results.size;

  // Calculate KPIs
  let atRiskItems = 0;
  let totalShortageQty = 0;
  let earliestStockoutBucket = null;
  const summaryRows = [];

  for (const [key, result] of results) {
    const summary = {
      key,
      stockoutBucket: result.stockoutBucket,
      shortageQty: result.shortageQty,
      minAvailable: result.minAvailable,
      startOnHand: result.series[0]?.begin ?? 0,
      totalDemand: result.totals.demand,
      totalInbound: result.totals.inbound
    };
    summaryRows.push(summary);

    if (result.shortageQty > 0) atRiskItems++;
    totalShortageQty += result.shortageQty || 0;
    if (result.stockoutBucket) {
      const idx = timeBuckets.indexOf(result.stockoutBucket);
      if (idx >= 0 && (earliestStockoutBucket === null || timeBuckets.indexOf(earliestStockoutBucket) > idx)) {
        earliestStockoutBucket = result.stockoutBucket;
      }
    }
  }

  // Sort: items with shortage first, then by shortageQty descending
  summaryRows.sort((a, b) => {
    if (a.shortageQty > 0 && b.shortageQty === 0) return -1;
    if (b.shortageQty > 0 && a.shortageQty === 0) return 1;
    return b.shortageQty - a.shortageQty;
  });

  // Build meta
  const noSnapshotKeys = [];
  results.forEach((_, key) => {
    if (!startingInventory.has(key)) noSnapshotKeys.push(key);
  });
  const meta = {
    noSnapshotKeys: noSnapshotKeys.length ? noSnapshotKeys : undefined,
    inboundSource,
    supplyForecastRunId: inboundSource === 'supply_forecast' ? supplyForecastRunId : null
  };

  return {
    mode,
    summaryRows,
    cache: {
      timeBuckets,
      startingInventory,
      demandByBucket,
      inboundByBucket
    },
    perf: {
      demandRows: demandRows.length,
      inboundRows: inboundRows.length,
      snapshotRows: snapshotRows.length,
      totalRows,
      fetchMs,
      computeMs,
      keys
    },
    kpis: {
      itemsProjected: keys,
      atRiskItems,
      earliestStockoutBucket,
      totalShortageQty
    },
    meta
  };
}
