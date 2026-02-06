/**
 * Inventory Projection Engine (Deterministic MVP)
 *
 * 按 time_bucket 推演庫存：Inv_end(b) = Inv_start(b) + Inbound(b) − Demand(b)
 *
 * 純函式，無副作用。供 Forecasts → Inventory Tab 使用。
 */

import { normalizeKey } from '../../utils/componentDemandAggregator.js';

/**
 * 單一 bucket 的推演結果
 * @typedef {Object} BucketRow
 * @property {string} bucket - time_bucket
 * @property {number} begin - 期初庫存
 * @property {number} inbound - 入庫
 * @property {number} demand - 需求
 * @property {number} end - 期末庫存
 * @property {number} available - 可用 (end - safetyStock)
 * @property {boolean} shortageFlag - 是否缺口 (available < 0)
 */

/**
 * 單一 key 的推演結果
 * @typedef {Object} ProjectionResult
 * @property {string} key - "MATERIAL|PLANT"
 * @property {BucketRow[]} series - 逐 bucket
 * @property {number} minAvailable - horizon 內最小 available
 * @property {string|null} stockoutBucket - 第一個 available < 0 的 bucket
 * @property {number} shortageQty - 缺口量 (abs(minAvailable) 若 minAvailable < 0 else 0)
 * @property {{ demand: number, inbound: number }} totals
 */

/**
 * 輸入結構
 * @typedef {Object} ProjectionInputs
 * @property {string[]} timeBuckets - 依序的 time_bucket
 * @property {Map<string, { onHand: number, safetyStock: number }>} startingInventory - key → 期初
 * @property {Map<string, Map<string, number>>} demandByBucket - key → (bucket → qty)
 * @property {Map<string, Map<string, number>>} inboundByBucket - key → (bucket → qty)
 */

/**
 * 單 key 推演
 * @param {string} key
 * @param {string[]} timeBuckets
 * @param {{ onHand: number, safetyStock: number }} start
 * @param {Map<string, number>} demandMap - bucket → qty
 * @param {Map<string, number>} inboundMap - bucket → qty
 * @returns {ProjectionResult}
 */
function projectOneKey(key, timeBuckets, start, demandMap, inboundMap) {
  const safetyStock = start.safetyStock != null && !Number.isNaN(Number(start.safetyStock)) ? Number(start.safetyStock) : 0;
  let begin = start.onHand != null && !Number.isNaN(Number(start.onHand)) ? Number(start.onHand) : 0;
  const series = [];
  let minAvailable = begin - safetyStock;
  let stockoutBucket = null;
  let totalDemand = 0;
  let totalInbound = 0;

  for (const bucket of timeBuckets) {
    const inbound = inboundMap.get(bucket) ?? 0;
    const demand = demandMap.get(bucket) ?? 0;
    totalInbound += inbound;
    totalDemand += demand;
    const end = begin + inbound - demand;
    const available = end - safetyStock;
    const shortageFlag = available < 0;
    series.push({
      bucket,
      begin,
      inbound,
      demand,
      end,
      available,
      shortageFlag
    });
    if (available < minAvailable) minAvailable = available;
    if (shortageFlag && stockoutBucket === null) stockoutBucket = bucket;
    begin = end;
  }

  const shortageQty = minAvailable < 0 ? Math.abs(minAvailable) : 0;
  return {
    key,
    series,
    minAvailable,
    stockoutBucket,
    shortageQty,
    totals: { demand: totalDemand, inbound: totalInbound }
  };
}

/**
 * 單 key 只算 summary（不產出 series，省記憶體）
 * @param {string} key
 * @param {string[]} timeBuckets
 * @param {{ onHand: number, safetyStock: number }} start
 * @param {Map<string, number>} demandMap
 * @param {Map<string, number>} inboundMap
 * @returns {{ stockoutBucket: string|null, shortageQty: number, minAvailable: number, startOnHand: number, safetyStock: number, totals: { demand: number, inbound: number } }}
 */
function projectOneKeySummaryOnly(key, timeBuckets, start, demandMap, inboundMap) {
  const safetyStock = start.safetyStock != null && !Number.isNaN(Number(start.safetyStock)) ? Number(start.safetyStock) : 0;
  const startOnHand = start.onHand != null && !Number.isNaN(Number(start.onHand)) ? Number(start.onHand) : 0;
  let begin = startOnHand;
  let minAvailable = begin - safetyStock;
  let stockoutBucket = null;
  let totalDemand = 0;
  let totalInbound = 0;

  for (const bucket of timeBuckets) {
    const inbound = inboundMap.get(bucket) ?? 0;
    const demand = demandMap.get(bucket) ?? 0;
    totalInbound += inbound;
    totalDemand += demand;
    const end = begin + inbound - demand;
    const available = end - safetyStock;
    if (available < minAvailable) minAvailable = available;
    if (available < 0 && stockoutBucket === null) stockoutBucket = bucket;
    begin = end;
  }

  const shortageQty = minAvailable < 0 ? Math.abs(minAvailable) : 0;
  return {
    stockoutBucket,
    shortageQty,
    minAvailable,
    startOnHand: startOnHand,
    safetyStock,
    totals: { demand: totalDemand, inbound: totalInbound }
  };
}

/**
 * 只算 summary 的推演（不產出 series，供 Risk / 大資料用）
 * @param {ProjectionInputs} inputs
 * @returns {Map<string, { stockoutBucket: string|null, shortageQty: number, minAvailable: number, startOnHand: number, safetyStock: number, totals: { demand: number, inbound: number } }>>}
 */
export function projectInventorySummaryByBuckets(inputs) {
  const { timeBuckets, startingInventory, demandByBucket, inboundByBucket } = inputs;
  if (!Array.isArray(timeBuckets) || timeBuckets.length === 0) {
    return new Map();
  }

  const keys = new Set();
  startingInventory.forEach((_, k) => keys.add(k));
  demandByBucket.forEach((_, k) => keys.add(k));
  inboundByBucket.forEach((_, k) => keys.add(k));

  const results = new Map();
  for (const key of keys) {
    const start = startingInventory.get(key) ?? { onHand: 0, safetyStock: 0 };
    const demandMap = demandByBucket.get(key) ?? new Map();
    const inboundMap = inboundByBucket.get(key) ?? new Map();
    results.set(key, projectOneKeySummaryOnly(key, timeBuckets, start, demandMap, inboundMap));
  }
  return results;
}

/**
 * 只算單一 key 的 series（給 Risk Details on-demand 用）
 * 欄位與 Forecasts Inventory drawer 一致：bucket, begin, inbound, demand, end, available, shortageFlag
 * @param {{ timeBuckets: string[], startingInventory: Map<string, { onHand: number, safetyStock: number }>, demandByBucket: Map<string, Map<string, number>>, inboundByBucket: Map<string, Map<string, number>>, key: string }} params
 * @returns {Array<{ bucket: string, begin: number, inbound: number, demand: number, end: number, available: number, shortageFlag: boolean }>}
 */
export function projectInventorySeriesForKey(params) {
  const { timeBuckets, startingInventory, demandByBucket, inboundByBucket, key } = params;
  if (!Array.isArray(timeBuckets) || timeBuckets.length === 0 || !key) {
    return [];
  }
  const start = startingInventory.get(key) ?? { onHand: 0, safetyStock: 0 };
  const demandMap = demandByBucket.get(key) ?? new Map();
  const inboundMap = inboundByBucket.get(key) ?? new Map();
  const full = projectOneKey(key, timeBuckets, start, demandMap, inboundMap);
  return full.series;
}

/**
 * 從 loadInventoryProjectionForRisk 的 cache 取單一 key 的 series（供 Details on-demand）
 * @param {{ timeBuckets: string[], startingInventory: Map, demandByBucket: Map, inboundByBucket: Map }} cache
 * @param {string} key
 * @returns {Array<{ bucket: string, begin: number, inbound: number, demand: number, end: number, available: number, shortageFlag: boolean }>}
 */
export function computeSeriesForKey(cache, key) {
  if (!cache || !key) return [];
  return projectInventorySeriesForKey({
    timeBuckets: cache.timeBuckets,
    startingInventory: cache.startingInventory,
    demandByBucket: cache.demandByBucket,
    inboundByBucket: cache.inboundByBucket,
    key
  });
}

/**
 * 彙總所有 keys（union of startingInventory, demandByBucket, inboundByBucket）
 * @param {ProjectionInputs} inputs
 * @returns {Map<string, ProjectionResult>} key → result
 */
export function projectInventoryByBuckets(inputs) {
  const { timeBuckets, startingInventory, demandByBucket, inboundByBucket } = inputs;
  if (!Array.isArray(timeBuckets) || timeBuckets.length === 0) {
    return new Map();
  }

  const keys = new Set();
  startingInventory.forEach((_, k) => keys.add(k));
  demandByBucket.forEach((_, k) => keys.add(k));
  inboundByBucket.forEach((_, k) => keys.add(k));

  const results = new Map();
  for (const key of keys) {
    const start = startingInventory.get(key) ?? { onHand: 0, safetyStock: 0 };
    const demandMap = demandByBucket.get(key) ?? new Map();
    const inboundMap = inboundByBucket.get(key) ?? new Map();
    results.set(key, projectOneKey(key, timeBuckets, start, demandMap, inboundMap));
  }
  return results;
}

/**
 * 從 component_demand rows 建 demandByBucket: Map<key, Map<bucket, qty>>
 * @param {Array<{ material_code: string, plant_id: string, time_bucket: string, demand_qty: number }>} rows
 * @returns {Map<string, Map<string, number>>}
 */
export function buildDemandByBucket(rows) {
  const out = new Map();
  for (const r of rows || []) {
    const key = normalizeKey(r.material_code, r.plant_id);
    if (!key || key === '|') continue;
    if (!out.has(key)) out.set(key, new Map());
    const bucket = String(r.time_bucket).trim();
    const qty = parseFloat(r.demand_qty);
    if (isNaN(qty) || qty < 0) continue;
    out.get(key).set(bucket, (out.get(key).get(bucket) ?? 0) + qty);
  }
  return out;
}

/**
 * 從 po_open_lines 風格 rows 建 inboundByBucket: Map<key, Map<bucket, qty>>
 * @param {Array<{ material_code?: string, plant_id?: string, time_bucket?: string, open_qty?: number }>} rows
 * @returns {Map<string, Map<string, number>>}
 */
export function buildInboundByBucket(rows) {
  const out = new Map();
  const pickInboundQty = r => Number(
    r.open_qty ??
    r.qty_open ??
    r.inbound_qty ??
    r.order_qty ??
    r.qty ??
    r.quantity ??
    0
  );

  for (const r of rows || []) {
    const key = normalizeKey(r.material_code ?? r.item, r.plant_id ?? r.factory);
    if (!key || key === '|') continue;
    if (!out.has(key)) out.set(key, new Map());
    const bucket = String(r.time_bucket || r.timeBucket || r.bucket || '').trim();
    if (!bucket) continue;
    const qty = pickInboundQty(r);
    if (!Number.isFinite(qty) || qty < 0) continue;
    out.get(key).set(bucket, (out.get(key).get(bucket) ?? 0) + qty);
  }
  return out;
}

/**
 * 從 inventory snapshot rows（已取 latest per key）建 startingInventory
 * @param {Array<{ material_code: string, plant_id: string, on_hand_qty?: number, safety_stock?: number }>} rows
 * @returns {Map<string, { onHand: number, safetyStock: number }>}
 */
export function buildStartingInventory(rows) {
  const out = new Map();
  for (const r of rows || []) {
    const key = normalizeKey(r.material_code, r.plant_id);
    if (!key || key === '|') continue;
    const onHand = parseFloat(r.on_hand_qty ?? r.onhand_qty ?? r.on_hand ?? r.onhand ?? 0);
    const safetyStock = parseFloat(r.safety_stock ?? r.safetyStock ?? r.safety ?? 0);
    out.set(key, {
      onHand: isNaN(onHand) ? 0 : onHand,
      safetyStock: isNaN(safetyStock) ? 0 : Math.max(0, safetyStock)
    });
  }
  return out;
}
