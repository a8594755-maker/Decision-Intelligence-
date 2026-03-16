/**
 * metricEvaluators.js — Pure-function KPI metric evaluators
 *
 * Each evaluator takes dataset rows and returns a metric value.
 * Used by the KPI monitor daemon to check watch rules.
 *
 * All evaluators are deterministic pure functions (no DB, no side effects).
 *
 * @module services/kpiMonitor/metricEvaluators
 */

// ── Metric Type Registry ────────────────────────────────────────────────────

export const METRIC_TYPES = Object.freeze({
  INVENTORY_DAYS_ON_HAND:  'inventory_days_on_hand',
  OPEN_PO_AGING:           'open_po_aging_days',
  SUPPLIER_ON_TIME_RATE:   'supplier_on_time_rate',
  FORECAST_ACCURACY:       'forecast_accuracy',
  STOCKOUT_RISK:           'stockout_risk',
  SERVICE_LEVEL:           'service_level',
});

/**
 * Evaluate inventory days on hand.
 *
 * Formula: current_stock / avg_daily_demand
 *
 * @param {Object[]} rows - inventory rows with { material_code, plant_id, current_stock, avg_daily_demand }
 * @param {Object} [filter] - { material_code, plant_id } optional filter
 * @returns {{ value: number, detail: Object }}
 */
export function evaluateInventoryDaysOnHand(rows, filter = {}) {
  const filtered = applyFilter(rows, filter);
  if (filtered.length === 0) return { value: null, detail: { count: 0 } };

  let totalStock = 0;
  let totalDemand = 0;

  for (const r of filtered) {
    const stock = r.current_stock ?? r.stock_qty ?? 0;
    const demand = r.avg_daily_demand ?? r.daily_demand ?? 0;
    totalStock += stock;
    totalDemand += demand;
  }

  const doh = totalDemand > 0 ? totalStock / totalDemand : Infinity;

  return {
    value: Math.round(doh * 10) / 10,
    detail: {
      total_stock: totalStock,
      total_daily_demand: Math.round(totalDemand * 100) / 100,
      items_evaluated: filtered.length,
    },
  };
}

/**
 * Evaluate open PO aging (average days since order).
 *
 * @param {Object[]} rows - PO rows with { po_date, status }
 * @param {Object} [filter]
 * @returns {{ value: number, detail: Object }}
 */
export function evaluateOpenPoAging(rows, filter = {}) {
  const now = new Date();
  const filtered = applyFilter(rows, filter)
    .filter(r => (r.status || '').toLowerCase() === 'open' || (r.status || '').toLowerCase() === 'pending');

  if (filtered.length === 0) return { value: 0, detail: { open_pos: 0 } };

  let totalDays = 0;
  for (const r of filtered) {
    const poDate = new Date(r.po_date || r.order_date || r.created_at);
    const ageDays = (now - poDate) / (1000 * 60 * 60 * 24);
    totalDays += Math.max(0, ageDays);
  }

  const avgDays = totalDays / filtered.length;

  return {
    value: Math.round(avgDays * 10) / 10,
    detail: {
      open_pos: filtered.length,
      total_aging_days: Math.round(totalDays),
      max_aging_days: Math.round(Math.max(...filtered.map(r => {
        const d = new Date(r.po_date || r.order_date || r.created_at);
        return (now - d) / (1000 * 60 * 60 * 24);
      }))),
    },
  };
}

/**
 * Evaluate supplier on-time delivery rate.
 *
 * @param {Object[]} rows - delivery rows with { supplier_id, on_time } (boolean) or { promised_date, actual_date }
 * @param {Object} [filter]
 * @returns {{ value: number, detail: Object }}
 */
export function evaluateSupplierOnTimeRate(rows, filter = {}) {
  const filtered = applyFilter(rows, filter);
  if (filtered.length === 0) return { value: null, detail: { deliveries: 0 } };

  let onTime = 0;
  for (const r of filtered) {
    if (r.on_time === true || r.on_time === 1) {
      onTime++;
    } else if (r.promised_date && r.actual_date) {
      if (new Date(r.actual_date) <= new Date(r.promised_date)) {
        onTime++;
      }
    }
  }

  const rate = onTime / filtered.length;

  return {
    value: Math.round(rate * 1000) / 1000,
    detail: {
      on_time_count: onTime,
      total_deliveries: filtered.length,
      late_count: filtered.length - onTime,
    },
  };
}

/**
 * Evaluate forecast accuracy (1 - MAPE).
 *
 * @param {Object[]} rows - forecast vs actual rows with { forecast, actual }
 * @param {Object} [filter]
 * @returns {{ value: number, detail: Object }}
 */
export function evaluateForecastAccuracy(rows, filter = {}) {
  const filtered = applyFilter(rows, filter)
    .filter(r => r.actual != null && r.actual !== 0);

  if (filtered.length === 0) return { value: null, detail: { data_points: 0 } };

  let sumApe = 0;
  for (const r of filtered) {
    const forecast = r.forecast ?? r.predicted ?? 0;
    const actual = r.actual;
    sumApe += Math.abs(forecast - actual) / Math.abs(actual);
  }

  const mape = sumApe / filtered.length;
  const accuracy = Math.max(0, 1 - mape);

  return {
    value: Math.round(accuracy * 1000) / 1000,
    detail: {
      mape: Math.round(mape * 1000) / 1000,
      data_points: filtered.length,
    },
  };
}

// ── Evaluator Registry ──────────────────────────────────────────────────────

const EVALUATOR_MAP = {
  [METRIC_TYPES.INVENTORY_DAYS_ON_HAND]: evaluateInventoryDaysOnHand,
  [METRIC_TYPES.OPEN_PO_AGING]:          evaluateOpenPoAging,
  [METRIC_TYPES.SUPPLIER_ON_TIME_RATE]:  evaluateSupplierOnTimeRate,
  [METRIC_TYPES.FORECAST_ACCURACY]:      evaluateForecastAccuracy,
};

/**
 * Get evaluator function by metric type.
 * @param {string} metricType
 * @returns {Function|null}
 */
export function getEvaluator(metricType) {
  return EVALUATOR_MAP[metricType] || null;
}

/**
 * List all registered metric types.
 * @returns {string[]}
 */
export function listMetricTypes() {
  return Object.values(METRIC_TYPES);
}

// ── Threshold checking ──────────────────────────────────────────────────────

/**
 * Check if a metric value breaches a threshold.
 *
 * @param {number} value - current metric value
 * @param {string} thresholdType - 'below' | 'above' | 'drift' | 'outside_range'
 * @param {number} thresholdValue - threshold value
 * @param {number} [thresholdUpper] - upper bound for outside_range
 * @returns {{ breached: boolean, reason: string }}
 */
export function checkThreshold(value, thresholdType, thresholdValue, thresholdUpper = null) {
  if (value === null || value === undefined) {
    return { breached: false, reason: 'No data available' };
  }

  switch (thresholdType) {
    case 'below':
      return value < thresholdValue
        ? { breached: true, reason: `${value} is below threshold ${thresholdValue}` }
        : { breached: false, reason: `${value} is above threshold ${thresholdValue}` };

    case 'above':
      return value > thresholdValue
        ? { breached: true, reason: `${value} exceeds threshold ${thresholdValue}` }
        : { breached: false, reason: `${value} is within threshold ${thresholdValue}` };

    case 'drift': {
      const drift = Math.abs(value - thresholdValue) / (thresholdValue || 1);
      return drift > 0.2 // 20% drift tolerance
        ? { breached: true, reason: `${value} drifted ${(drift * 100).toFixed(1)}% from baseline ${thresholdValue}` }
        : { breached: false, reason: `${value} within drift tolerance of baseline ${thresholdValue}` };
    }

    case 'outside_range':
      if (thresholdUpper == null) {
        return { breached: false, reason: 'No upper bound defined for outside_range' };
      }
      return (value < thresholdValue || value > thresholdUpper)
        ? { breached: true, reason: `${value} is outside range [${thresholdValue}, ${thresholdUpper}]` }
        : { breached: false, reason: `${value} is within range [${thresholdValue}, ${thresholdUpper}]` };

    default:
      return { breached: false, reason: `Unknown threshold type: ${thresholdType}` };
  }
}

// ── Internal helpers ────────────────────────────────────────────────────────

function applyFilter(rows, filter) {
  if (!filter || Object.keys(filter).length === 0) return rows;

  return rows.filter(row => {
    for (const [key, val] of Object.entries(filter)) {
      if (val === undefined || val === null) continue;
      if (Array.isArray(val)) {
        if (!val.includes(row[key])) return false;
      } else {
        if (row[key] !== val) return false;
      }
    }
    return true;
  });
}
