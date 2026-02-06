/**
 * Inventory Projection — Risk Dashboard 專用（唯一入口）
 *
 * 【單一入口】本檔為 loadInventoryProjectionForRisk / computeSeriesForKey / WARN|STOP 常數的
 * 唯一來源。Forecasts Inventory Tab 請用 inventoryProjectionService.js 的 loadInventoryProjection，
 * 禁止在此檔或該檔重複 export 同名 Risk loader，避免 import 錯、邏輯 drift。
 *
 * 介面契約：loadInventoryProjectionForRisk 回傳 mode/summaryByKey/cache/perf/kpis；
 * Details on-demand 使用 computeSeriesForKey(cache, key)。
 * Key 正規化：normalizeKey(material_code, plant_id)；bucket 順序用 run.parameters.time_buckets。
 */

import {
  forecastRunsService,
  componentDemandService,
  poOpenLinesService,
  inventorySnapshotsService
} from './supabaseClient.js';
import {
  projectInventorySummaryByBuckets,
  buildDemandByBucket,
  buildInboundByBucket,
  buildStartingInventory,
  computeSeriesForKey as computeSeriesForKeyFromDomain
} from '../domains/inventory/inventoryProjection.js';

// 效能護欄常數（UI 只讀不寫）
export const WARN_TOTAL_ROWS = 50_000;
export const STOP_TOTAL_ROWS = 150_000;

const EMPTY_RESULT = (mode, reason) => ({
  mode,
  reason,
  summaryByKey: new Map(),
  perf: {
    demandRows: 0,
    inboundRows: 0,
    snapshotRows: 0,
    totalRows: 0,
    fetchMs: 0,
    computeMs: 0,
    keys: 0
  },
  kpis: {
    itemsProjected: 0,
    atRiskItems: 0,
    earliestStockoutBucket: null,
    totalShortageQty: 0
  },
  diagnostics: {}
});

/**
 * 從 cache 算單一 key 的 series（Details on-demand）
 * @param {{ timeBuckets: string[], startingInventory: Map, demandByBucket: Map, inboundByBucket: Map }} cache
 * @param {string} key
 * @returns {Array<{ bucket: string, begin: number, inbound: number, demand: number, end: number, available: number, shortageFlag: boolean }>}
 */
export function computeSeriesForKey(cache, key) {
  return computeSeriesForKeyFromDomain(cache, key);
}

/**
 * Risk 專用：載入 projection，回傳契約格式。
 * FULL 模式保留 cache（maps）供 Details on-demand；STOP 時 DEGRADED 不帶 cache。
 *
 * @param {string} userId
 * @param {string} forecastRunId
 * @param {{ plantId?: string|null }} [options] - 可覆寫 run.parameters.plant_id
 * @returns {Promise<{
 *   mode: 'FULL' | 'DEGRADED',
 *   reason?: string,
 *   summaryByKey: Map<string, { stockoutBucket: string|null, shortageQty: number, minAvailable: number, startOnHand: number, safetyStock: number, totals: { demand: number, inbound: number } }>,
 *   cache?: { timeBuckets: string[], startingInventory: Map, demandByBucket: Map, inboundByBucket: Map },
 *   perf: { demandRows: number, inboundRows: number, snapshotRows: number, totalRows: number, fetchMs: number, computeMs: number, keys: number },
 *   kpis: { itemsProjected: number, atRiskItems: number, earliestStockoutBucket: string|null, totalShortageQty: number },
 *   diagnostics: Object
 * }>}
 */
export async function loadInventoryProjectionForRisk(userId, forecastRunId, options = {}) {
  if (!userId || !forecastRunId) {
    return { ...EMPTY_RESULT('DEGRADED', 'no_run'), cache: undefined };
  }

  const t0 = Date.now();
  let run;
  try {
    run = await forecastRunsService.getRun(forecastRunId);
  } catch {
    return { ...EMPTY_RESULT('DEGRADED', 'no_run'), cache: undefined };
  }

  if (!run) {
    return { ...EMPTY_RESULT('DEGRADED', 'no_run'), cache: undefined };
  }

  const timeBuckets = run?.parameters?.time_buckets;
  if (!Array.isArray(timeBuckets) || timeBuckets.length === 0) {
    return { ...EMPTY_RESULT('DEGRADED', 'no_time_buckets'), cache: undefined };
  }

  const plantId = options.plantId !== undefined ? options.plantId : (run?.parameters?.plant_id ?? null);

  let demandRows = [];
  let inboundRows = [];
  let snapshotRows = [];
  try {
    [demandRows, inboundRows, snapshotRows] = await Promise.all([
      componentDemandService.getComponentDemandsByForecastRun(userId, forecastRunId, { timeBuckets, plantId }),
      poOpenLinesService.getInboundByBuckets(userId, timeBuckets, plantId),
      inventorySnapshotsService.getLatestInventorySnapshots(userId, plantId)
    ]);
  } catch (e) {
    return {
      ...EMPTY_RESULT('DEGRADED', 'unknown'),
      perf: {
        ...EMPTY_RESULT('DEGRADED').perf,
        fetchMs: Date.now() - t0
      },
      cache: undefined
    };
  }

  demandRows = demandRows || [];
  inboundRows = inboundRows || [];
  snapshotRows = snapshotRows || [];

  const fetchMs = Date.now() - t0;
  const totalRows = demandRows.length + inboundRows.length + snapshotRows.length;

  if (totalRows > STOP_TOTAL_ROWS) {
    return {
      mode: 'DEGRADED',
      reason: 'rows_too_large',
      summaryByKey: new Map(),
      perf: {
        demandRows: demandRows.length,
        inboundRows: inboundRows.length,
        snapshotRows: snapshotRows.length,
        totalRows,
        fetchMs,
        computeMs: 0,
        keys: 0
      },
      kpis: { itemsProjected: 0, atRiskItems: 0, earliestStockoutBucket: null, totalShortageQty: 0 },
      diagnostics: {},
      cache: undefined
    };
  }

  const t1 = Date.now();
  const demandByBucket = buildDemandByBucket(demandRows);
  const inboundByBucket = buildInboundByBucket(inboundRows);
  const startingInventory = buildStartingInventory(snapshotRows);

  const summaryByKey = projectInventorySummaryByBuckets({
    timeBuckets,
    startingInventory,
    demandByBucket,
    inboundByBucket
  });
  const computeMs = Date.now() - t1;
  const keys = summaryByKey.size;

  let atRiskItems = 0;
  let totalShortageQty = 0;
  let earliestStockoutBucket = null;
  for (const [, s] of summaryByKey) {
    if (s.shortageQty > 0) atRiskItems++;
    totalShortageQty += s.shortageQty || 0;
    if (s.stockoutBucket) {
      const idx = timeBuckets.indexOf(s.stockoutBucket);
      if (idx >= 0 && (earliestStockoutBucket === null || timeBuckets.indexOf(earliestStockoutBucket) > idx)) {
        earliestStockoutBucket = s.stockoutBucket;
      }
    }
  }

  const kpis = {
    itemsProjected: keys,
    atRiskItems,
    earliestStockoutBucket,
    totalShortageQty
  };

  const perf = {
    demandRows: demandRows.length,
    inboundRows: inboundRows.length,
    snapshotRows: snapshotRows.length,
    totalRows,
    fetchMs,
    computeMs,
    keys
  };

  return {
    mode: 'FULL',
    summaryByKey,
    cache: {
      timeBuckets,
      startingInventory,
      demandByBucket,
      inboundByBucket
    },
    perf,
    kpis,
    diagnostics: {}
  };
}
