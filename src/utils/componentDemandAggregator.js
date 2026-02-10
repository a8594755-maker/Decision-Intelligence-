/**
 * Aggregate component_demand by (material_code, plant_id) into consumption / daily demand
 * Used by Risk to calculate daysToStockout, P(stockout).
 *
 * Demand → daily demand derivation rules (see docs/RISK_FORECAST_LINKAGE.md):
 * - time_bucket is treated as week bucket (1 bucket = 7 days; if date bucket support is added, conversion rules need updating).
 * - horizon length derived from "run parameters" or "actual data", priority order:
 *   1) options.timeBuckets (run.parameters.time_buckets) → horizonDays = timeBuckets.length * daysPerBucket
 *   2) options.horizonBuckets → horizonDays = horizonBuckets * daysPerBucket
 *   3) fallback: infer from rows' unique time_bucket count → horizonDays = bucketCount * daysPerBucket (minimum 1 day)
 */

export const DAYS_PER_BUCKET = 7;

/**
 * Normalize (material_code, plant_id) into a single key for pipeline-wide alignment.
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
 * @param {number} [horizonBuckets] - Risk assessment time window (bucket count), mutually exclusive with timeBuckets
 * @param {{ timeBuckets?: string[], daysPerBucket?: number } | number} [options] - If number, treated as horizonBuckets (backward compatible)
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

  // Derive horizon length (days): prioritize run parameters, then fallback to actual bucket count
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
