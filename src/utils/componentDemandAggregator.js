/**
 * 將 component_demand 依 (material_code, plant_id) 彙總為 consumption / 日均需求
 * 供 Risk 計算 daysToStockout、P(stockout) 使用。
 *
 * 需求→日需求推導規則（見 docs/RISK_FORECAST_LINKAGE.md）：
 * - time_bucket 視為 week bucket（一 bucket = 7 天；若未來支援 date bucket 需另訂轉換規則）。
 * - horizon 長度依「run 參數」或「實際資料」推導，優先順序：
 *   1) options.timeBuckets（run.parameters.time_buckets）→ horizonDays = timeBuckets.length * daysPerBucket
 *   2) options.horizonBuckets → horizonDays = horizonBuckets * daysPerBucket
 *   3) fallback：從 rows 的 unique time_bucket 數量推導 → horizonDays = bucketCount * daysPerBucket（最少 1 天）
 */

export const DAYS_PER_BUCKET = 7;

/**
 * 正規化 (material_code, plant_id) 為單一 key，供全 pipeline 對齊使用。
 * @param {string} materialCode
 * @param {string} plantId
 * @returns {string} "MATERIAL_CODE|PLANT_ID"
 */
export function normalizeKey(materialCode, plantId) {
  const m = (materialCode || '').trim().toUpperCase();
  const p = (plantId || '').trim().toUpperCase();
  return `${m}|${p}`;
}

/**
 * @param {Array<{ material_code: string, plant_id: string, time_bucket: string, demand_qty: number }>} rows
 * @param {number} [horizonBuckets] - 風險評估時間窗（bucket 數），與 timeBuckets 二擇一
 * @param {{ timeBuckets?: string[], daysPerBucket?: number } | number} [options] - 若為 number 則視為 horizonBuckets（向後兼容）
 * @returns {Record<string, { dailyDemand: number, totalQty: number, bucketCount: number, horizonDays: number }>}
 *   key = "MATERIAL_CODE|PLANT_ID"
 */
export function aggregateComponentDemandToDaily(rows, horizonBuckets = 3, options = {}) {
  const opts = typeof options === 'number' ? { horizonBuckets: options } : options;
  const daysPerBucket = opts.daysPerBucket ?? DAYS_PER_BUCKET;

  const map = /** @type {Record<string, { totalQty: number, buckets: Set<string> }>} */ ({});
  const allBuckets = new Set();

  for (const row of rows || []) {
    const key = normalizeKey(row.material_code, row.plant_id);
    if (!key || key === '|') continue;
    const qty = parseFloat(row.demand_qty);
    if (isNaN(qty) || qty < 0) continue;

    if (!map[key]) {
      map[key] = { totalQty: 0, buckets: new Set() };
    }
    map[key].totalQty += qty;
    if (row.time_bucket) {
      const b = String(row.time_bucket).trim();
      map[key].buckets.add(b);
      allBuckets.add(b);
    }
  }

  // 推導 horizon 長度（天）：優先 run 參數，再 fallback 實際 bucket 數
  let horizonDays;
  if (opts.timeBuckets && Array.isArray(opts.timeBuckets) && opts.timeBuckets.length > 0) {
    horizonDays = opts.timeBuckets.length * daysPerBucket;
  } else if (opts.horizonBuckets != null && opts.horizonBuckets > 0) {
    horizonDays = opts.horizonBuckets * daysPerBucket;
  } else if (typeof horizonBuckets === 'number' && horizonBuckets > 0) {
    horizonDays = horizonBuckets * daysPerBucket;
  } else {
    const inferredBuckets = allBuckets.size || 1;
    horizonDays = Math.max(1, inferredBuckets * daysPerBucket);
  }
  horizonDays = Math.max(1, horizonDays);

  const result = /** @type {Record<string, { dailyDemand: number, totalQty: number, bucketCount: number, horizonDays: number }>} */ ({});
  for (const [key, val] of Object.entries(map)) {
    result[key] = {
      totalQty: val.totalQty,
      bucketCount: val.buckets.size,
      horizonDays,
      dailyDemand: val.totalQty / horizonDays
    };
  }
  return result;
}
