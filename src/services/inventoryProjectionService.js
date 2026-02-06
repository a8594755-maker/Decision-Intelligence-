/**
 * Inventory Projection — Forecasts Inventory Tab 專用
 *
 * 【單一入口分工】本檔只提供 loadInventoryProjection（Forecasts Tab 用）。
 * Risk Dashboard 的 loadInventoryProjectionForRisk / computeSeriesForKey / WARN|STOP 常數
 * 一律從 inventoryProjectionForRiskService.js 引用，禁止在此檔 export 同名 Risk loader。
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

// 效能護欄常數（Forecasts Inventory Tab 專用）
export const FORECAST_WARN_ROWS = parseInt(import.meta.env.VITE_PROJECTION_WARN_ROWS) || 30_000;
export const FORECAST_STOP_ROWS = parseInt(import.meta.env.VITE_PROJECTION_STOP_ROWS) || 100_000;
export const FORECAST_TOP_N = parseInt(import.meta.env.VITE_PROJECTION_TOP_N) || 500;

/**
 * 從 cache 計算單一 key 的 bucket series（供展開列使用）
 * @param {{ timeBuckets: string[], startingInventory: Map, demandByBucket: Map, inboundByBucket: Map }} cache
 * @param {string} key
 * @returns {Array<{ bucket: string, begin: number, inbound: number, demand: number, end: number, available: number, shortageFlag: boolean }>}
 */
export function computeSeriesForKey(cache, key) {
  return computeSeriesFromDomain(cache, key);
}

/**
 * 載入 projection 供 Forecasts → Inventory Tab 使用
 * 回傳 summaryRows（含 KPI 資訊）、cache（供展開列使用）、perf、meta、kpis
 *
 * @param {string} userId
 * @param {string} forecastRunId
 * @param {string[]} timeBuckets - run.parameters.time_buckets
 * @param {string|null} plantId - run.parameters.plant_id 或 null
 * @param {Object} options - 額外選項
 * @param {string} options.inboundSource - 'raw_po' | 'supply_forecast'，預設 'raw_po'
 * @param {string|null} options.supplyForecastRunId - 當 inboundSource='supply_forecast' 時使用
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

  // 效能護欄檢查
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

  // 計算 KPIs
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

  // 排序：有缺口的優先，再按 shortageQty 降序
  summaryRows.sort((a, b) => {
    if (a.shortageQty > 0 && b.shortageQty === 0) return -1;
    if (b.shortageQty > 0 && a.shortageQty === 0) return 1;
    return b.shortageQty - a.shortageQty;
  });

  // 構建 meta
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
