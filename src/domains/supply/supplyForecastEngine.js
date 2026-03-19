/**
 * Milestone 4: Supply Forecast Engine (WP2)
 * 
 * Pure functions for calculating supply forecasts:
 * - Step A: Build supplier stats (lead time distribution, on-time rate)
 * - Step B: PO-level forecast (arrival buckets, delay prob)
 * - Step C: Aggregate to inbound by bucket
 * - Step D: Build trace (explainability)
 */

import { dateToBucket } from '../../utils/timeBucket.js';

/**
 * Calculate percentile from an array of numbers
 */
function calculatePercentile(values, percentile) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

/**
 * Calculate median (p50)
 */
function calculateMedian(values) {
  return calculatePercentile(values, 50);
}

/**
 * Calculate days between two dates
 */
function daysBetween(date1, date2) {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  return Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
}

/**
 * Get date for a specific bucket (returns Monday of that week)
 */
function bucketToDate(bucket) {
  const match = bucket.match(/(\d{4})-W(\d{2})/);
  if (match) {
    const year = parseInt(match[1]);
    const week = parseInt(match[2]);
    // ISO 8601: find Monday of the given ISO week.
    // Jan 4 is always in ISO week 1. Find the Monday of week 1, then offset.
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const dayOfWeek = jan4.getUTCDay() || 7; // Mon=1 … Sun=7
    const week1Monday = new Date(Date.UTC(year, 0, 4 - dayOfWeek + 1));
    return new Date(week1Monday.getTime() + (week - 1) * 7 * 86400000);
  }
  return new Date();
}

/**
 * Step A: Build supplier stats from receipts/historical data
 * 
 * @param {Array} receipts - Receipt records with: { po_id, supplier_id, plant_id, order_date, promised_date, receipt_date, qty }
 * @param {Object} options - { fallbackLeadTimeDays, historyWindowDays }
 * @returns {Object} - { supplierStats[], metrics, fallbackCount }
 */
export function buildSupplierStats(receipts, options = {}) {
  const { 
    fallbackLeadTimeDays = 14, 
    historyWindowDays = 90,
    minSampleSize = 3 
  } = options;
  
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - historyWindowDays);
  
  // Group receipts by supplier (+ plant if available)
  const supplierData = {};
  let validReceiptsCount = 0;
  let fallbackCount = 0;
  
  (receipts || []).forEach(receipt => {
    const receiptDate = new Date(receipt.receipt_date);
    if (receiptDate < cutoffDate) return;
    
    const key = receipt.plant_id 
      ? `${receipt.supplier_id}|${receipt.plant_id}` 
      : receipt.supplier_id;
    
    if (!supplierData[key]) {
      supplierData[key] = {
        supplier_id: receipt.supplier_id,
        plant_id: receipt.plant_id || null,
        lead_times: [],
        on_time_results: [],
        short_ship_results: []
      };
    }
    
    // Calculate actual lead time
    if (receipt.order_date && receipt.receipt_date) {
      const leadTime = daysBetween(receipt.order_date, receipt.receipt_date);
      if (leadTime > 0) {
        supplierData[key].lead_times.push(leadTime);
        validReceiptsCount++;
      }
    }
    
    // On-time calculation
    if (receipt.promised_date && receipt.receipt_date) {
      const onTime = new Date(receipt.receipt_date) <= new Date(receipt.promised_date);
      supplierData[key].on_time_results.push(onTime ? 1 : 0);
    }
    
    // Short shipment (if order qty vs receipt qty available)
    if (receipt.order_qty && receipt.receipt_qty !== undefined) {
      const shortShip = receipt.receipt_qty < receipt.order_qty;
      supplierData[key].short_ship_results.push(shortShip ? 1 : 0);
    }
  });
  
  // Build stats for each supplier
  const supplierStats = Object.values(supplierData).map(data => {
    const n = data.lead_times.length;
    const hasEnoughData = n >= minSampleSize;
    
    let leadTimeP50, leadTimeP90, onTimeRate, shortShipRate;
    let fallbackReason = null;
    
    if (hasEnoughData) {
      leadTimeP50 = calculateMedian(data.lead_times);
      leadTimeP90 = calculatePercentile(data.lead_times, 90);
      onTimeRate = data.on_time_results.length > 0 
        ? data.on_time_results.reduce((a, b) => a + b, 0) / data.on_time_results.length 
        : 0.7; // default
      shortShipRate = data.short_ship_results.length > 0
        ? data.short_ship_results.reduce((a, b) => a + b, 0) / data.short_ship_results.length
        : 0.05;
    } else {
      // Fallback
      leadTimeP50 = fallbackLeadTimeDays;
      leadTimeP90 = Math.round(fallbackLeadTimeDays * 1.3);
      onTimeRate = 0.7;
      shortShipRate = 0.05;
      fallbackReason = n > 0 
        ? `Insufficient sample size (${n} < ${minSampleSize})`
        : 'No receipt history available';
      fallbackCount++;
    }
    
    return {
      supplier_id: data.supplier_id,
      plant_id: data.plant_id,
      sample_size: n,
      lead_time_p50_days: leadTimeP50,
      lead_time_p90_days: leadTimeP90,
      on_time_rate: onTimeRate,
      short_ship_rate: shortShipRate,
      metrics: {
        fallback_used: !!fallbackReason,
        fallback_reason: fallbackReason,
        history_window_days: historyWindowDays,
        median_abs_dev: hasEnoughData 
          ? calculateMedian(data.lead_times.map(lt => Math.abs(lt - leadTimeP50)))
          : null,
        min_lead_time: hasEnoughData ? Math.min(...data.lead_times) : null,
        max_lead_time: hasEnoughData ? Math.max(...data.lead_times) : null
      }
    };
  });
  
  return {
    supplierStats,
    metrics: {
      totalSuppliers: supplierStats.length,
      fallbackCount,
      validReceiptsCount,
      historyWindowDays
    }
  };
}

/**
 * Get or create supplier stats using fallback if supplier not found
 */
function getSupplierStats(supplierId, plantId, supplierStatsMap, options = {}) {
  const { fallbackLeadTimeDays = 14 } = options;
  
  // Try exact match (supplier + plant)
  let stats = supplierStatsMap[`${supplierId}|${plantId}`];
  
  // Try supplier-only match
  if (!stats) {
    stats = supplierStatsMap[supplierId];
  }
  
  // Create fallback stats
  if (!stats) {
    return {
      supplier_id: supplierId,
      plant_id: plantId,
      sample_size: 0,
      lead_time_p50_days: fallbackLeadTimeDays,
      lead_time_p90_days: Math.round(fallbackLeadTimeDays * 1.3),
      on_time_rate: 0.7,
      short_ship_rate: 0.05,
      metrics: {
        fallback_used: true,
        fallback_reason: 'Supplier not found in stats',
        global_fallback: true
      }
    };
  }
  
  return stats;
}

/**
 * Step B: Calculate PO-level forecasts
 * 
 * @param {Array} poLines - Open PO lines: { po_line_id, po_id, supplier_id, material_code, plant_id, open_qty, promised_date, order_date }
 * @param {Object} supplierStatsResult - Result from buildSupplierStats
 * @param {Array} timeBuckets - Target time buckets for forecast
 * @param {Object} options - { modelVersion, today }
 * @returns {Object} - { poForecasts[], metrics }
 */
export function calculatePOForecasts(poLines, supplierStatsResult, timeBuckets, options = {}) {
  const { 
    modelVersion = 'supply_v1', 
    today = new Date(),
    fallbackLeadTimeDays = 14
  } = options;
  
  // Build supplier stats map for quick lookup
  const supplierStatsMap = {};
  (supplierStatsResult.supplierStats || []).forEach(stats => {
    const key = stats.plant_id 
      ? `${stats.supplier_id}|${stats.plant_id}` 
      : stats.supplier_id;
    supplierStatsMap[key] = stats;
  });
  
  const poForecasts = [];
  let fallbackCount = 0;
  let withPromisedDate = 0;
  let withoutPromisedDate = 0;
  
  (poLines || []).forEach(poLine => {
    const supplierStats = getSupplierStats(
      poLine.supplier_id, 
      poLine.plant_id, 
      supplierStatsMap,
      { fallbackLeadTimeDays }
    );
    
    if (supplierStats.metrics?.fallback_used) {
      fallbackCount++;
    }
    
    // Determine base date for arrival calculation
    let baseDate;
    let arrivalMethod;
    
    if (poLine.promised_date) {
      baseDate = new Date(poLine.promised_date);
      arrivalMethod = 'promised_date';
      withPromisedDate++;
    } else if (poLine.order_date) {
      baseDate = new Date(poLine.order_date);
      baseDate.setDate(baseDate.getDate() + supplierStats.lead_time_p50_days);
      arrivalMethod = 'order_date_plus_lead_time';
      withoutPromisedDate++;
    } else {
      // No dates available, use today + lead time
      baseDate = new Date(today);
      baseDate.setDate(baseDate.getDate() + supplierStats.lead_time_p50_days);
      arrivalMethod = 'today_plus_lead_time_fallback';
      withoutPromisedDate++;
    }
    
    // Calculate arrival buckets
    const arrivalP50Bucket = dateToBucket(baseDate);
    
    // P90 arrival: add lead time variance
    const leadTimeVariance = supplierStats.lead_time_p90_days - supplierStats.lead_time_p50_days;
    const p90Date = new Date(baseDate);
    p90Date.setDate(p90Date.getDate() + Math.max(leadTimeVariance, 7)); // at least 7 days buffer
    const arrivalP90Bucket = dateToBucket(p90Date);
    
    // Delay probability
    const delayProb = 1 - (supplierStats.on_time_rate || 0.7);
    
    // Short shipment probability
    const shortShipProb = supplierStats.short_ship_rate || 0.05;
    
    poForecasts.push({
      po_line_id: poLine.po_line_id,
      po_id: poLine.po_id,
      supplier_id: poLine.supplier_id,
      material_code: poLine.material_code,
      plant_id: poLine.plant_id,
      open_qty: poLine.open_qty,
      promised_date: poLine.promised_date,
      arrival_p50_bucket: arrivalP50Bucket,
      arrival_p90_bucket: arrivalP90Bucket,
      delay_prob: delayProb,
      short_ship_prob: shortShipProb,
      model_version: modelVersion,
      metrics: {
        supplier_stats_used: {
          supplier_id: supplierStats.supplier_id,
          plant_id: supplierStats.plant_id,
          lead_time_p50_days: supplierStats.lead_time_p50_days,
          on_time_rate: supplierStats.on_time_rate,
          sample_size: supplierStats.sample_size,
          fallback_used: supplierStats.metrics?.fallback_used || false,
          fallback_reason: supplierStats.metrics?.fallback_reason || null
        },
        arrival_method: arrivalMethod,
        base_date: baseDate.toISOString().split('T')[0],
        lead_time_variance_days: leadTimeVariance
      }
    });
  });
  
  return {
    poForecasts,
    metrics: {
      totalPOs: poForecasts.length,
      fallbackCount,
      withPromisedDate,
      withoutPromisedDate
    }
  };
}

/**
 * Step C: Aggregate PO forecasts to inbound by bucket
 * 
 * @param {Array} poForecasts - Result from calculatePOForecasts
 * @param {Array} timeBuckets - Target time buckets (optional, will use all unique buckets if not provided)
 * @returns {Object} - { inboundByBucket[], metrics }
 */
export function aggregateInboundByBucket(poForecasts, _timeBuckets = null) {
  const inboundMap = {};
  
  // Collect all unique buckets if timeBuckets not provided
  const allBuckets = new Set();
  poForecasts.forEach(pf => {
    allBuckets.add(pf.arrival_p50_bucket);
    if (pf.arrival_p90_bucket) {
      allBuckets.add(pf.arrival_p90_bucket);
    }
  });
  
  // Aggregate P50 quantities
  poForecasts.forEach(pf => {
    const key = `${pf.material_code}|${pf.plant_id}|${pf.arrival_p50_bucket}`;
    
    if (!inboundMap[key]) {
      inboundMap[key] = {
        material_code: pf.material_code,
        plant_id: pf.plant_id,
        time_bucket: pf.arrival_p50_bucket,
        p50_qty: 0,
        p90_qty: 0,
        po_lines: [],
        avg_delay_prob: [],
        suppliers: new Set()
      };
    }
    
    inboundMap[key].p50_qty += pf.open_qty;
    inboundMap[key].po_lines.push({
      po_line_id: pf.po_line_id,
      po_id: pf.po_id,
      qty: pf.open_qty,
      delay_prob: pf.delay_prob
    });
    inboundMap[key].avg_delay_prob.push(pf.delay_prob);
    inboundMap[key].suppliers.add(pf.supplier_id);
  });
  
  // Aggregate P90 quantities (for delayed arrivals)
  poForecasts.forEach(pf => {
    if (pf.arrival_p90_bucket && pf.arrival_p90_bucket !== pf.arrival_p50_bucket) {
      const key = `${pf.material_code}|${pf.plant_id}|${pf.arrival_p90_bucket}`;
      
      if (!inboundMap[key]) {
        inboundMap[key] = {
          material_code: pf.material_code,
          plant_id: pf.plant_id,
          time_bucket: pf.arrival_p90_bucket,
          p50_qty: 0,
          p90_qty: 0,
          po_lines: [],
          avg_delay_prob: [],
          suppliers: new Set()
        };
      }
      
      // P90 qty represents the "at risk" portion
      const riskQty = pf.open_qty * pf.delay_prob;
      inboundMap[key].p90_qty += riskQty;
    }
  });
  
  // Convert to array and calculate weighted averages
  const inboundByBucket = Object.values(inboundMap).map(item => {
    const avgDelayProb = item.avg_delay_prob.length > 0
      ? item.avg_delay_prob.reduce((a, b) => a + b, 0) / item.avg_delay_prob.length
      : 0;
    
    return {
      material_code: item.material_code,
      plant_id: item.plant_id,
      time_bucket: item.time_bucket,
      p50_qty: Math.round(item.p50_qty * 100) / 100,
      p90_qty: Math.round(item.p90_qty * 100) / 100,
      avg_delay_prob: Math.round(avgDelayProb * 100) / 100,
      supplier_count: item.suppliers.size,
      po_line_count: item.po_lines.length,
      po_lines: item.po_lines // For trace building
    };
  });
  
  return {
    inboundByBucket,
    metrics: {
      totalInboundBuckets: inboundByBucket.length,
      totalP50Qty: inboundByBucket.reduce((sum, i) => sum + i.p50_qty, 0),
      totalP90Qty: inboundByBucket.reduce((sum, i) => sum + i.p90_qty, 0),
      avgDelayProb: inboundByBucket.length > 0
        ? inboundByBucket.reduce((sum, i) => sum + i.avg_delay_prob, 0) / inboundByBucket.length
        : 0
    }
  };
}

/**
 * Step D: Build trace records for explainability
 * 
 * @param {Array} inboundByBucket - Result from aggregateInboundByBucket
 * @param {Array} poForecasts - Original PO forecasts with full details
 * @param {Object} supplierStatsMap - Map of supplier_id -> stats
 * @returns {Array} - Trace records
 */
export function buildInboundTrace(inboundByBucket, poForecasts, supplierStatsMap = {}) {
  const traces = [];
  
  // Build lookup map for PO forecasts
  const poForecastMap = {};
  poForecasts.forEach(pf => {
    poForecastMap[pf.po_line_id] = pf;
  });
  
  inboundByBucket.forEach(inbound => {
    inbound.po_lines.forEach(poLineRef => {
      const poForecast = poForecastMap[poLineRef.po_line_id];
      if (!poForecast) return;
      
      const supplierStats = supplierStatsMap[poForecast.supplier_id] || 
                           supplierStatsMap[`${poForecast.supplier_id}|${poForecast.plant_id}`];
      
      traces.push({
        material_code: inbound.material_code,
        plant_id: inbound.plant_id,
        time_bucket: inbound.time_bucket,
        po_line_id: poLineRef.po_line_id,
        po_id: poForecast.po_id,
        contrib_qty: poLineRef.qty,
        arrival_p50_bucket: poForecast.arrival_p50_bucket,
        arrival_p90_bucket: poForecast.arrival_p90_bucket,
        delay_prob: poForecast.delay_prob,
        supplier_id: poForecast.supplier_id,
        supplier_stats: supplierStats ? {
          lead_time_p50_days: supplierStats.lead_time_p50_days,
          lead_time_p90_days: supplierStats.lead_time_p90_days,
          on_time_rate: supplierStats.on_time_rate,
          sample_size: supplierStats.sample_size,
          fallback_used: supplierStats.metrics?.fallback_used || false,
          fallback_reason: supplierStats.metrics?.fallback_reason || null
        } : null,
        trace_meta: {
          arrival_method: poForecast.metrics?.arrival_method,
          base_date: poForecast.metrics?.base_date,
          lead_time_variance_days: poForecast.metrics?.lead_time_variance_days
        }
      });
    });
  });
  
  return traces;
}

/**
 * Main execution: Run complete supply forecast pipeline
 * 
 * @param {Object} inputs - { receipts, poLines, timeBuckets }
 * @param {Object} options - Configuration options
 * @returns {Object} - Complete forecast result
 */
export function executeSupplyForecast(inputs, options = {}) {
  const startTime = Date.now();
  const { receipts, poLines, timeBuckets } = inputs;
  
  const {
    modelVersion = 'supply_v1',
    fallbackLeadTimeDays = 14,
    historyWindowDays = 90,
    today = new Date(),
    minSampleSize = 3
  } = options;
  
  try {
    // Step A: Build supplier stats
    const stepAStart = Date.now();
    const supplierStatsResult = buildSupplierStats(receipts, {
      fallbackLeadTimeDays,
      historyWindowDays,
      minSampleSize
    });
    const stepADuration = Date.now() - stepAStart;
    
    // Step B: Calculate PO forecasts
    const stepBStart = Date.now();
    const poForecastsResult = calculatePOForecasts(
      poLines, 
      supplierStatsResult, 
      timeBuckets, 
      { modelVersion, today, fallbackLeadTimeDays }
    );
    const stepBDuration = Date.now() - stepBStart;
    
    // Step C: Aggregate to inbound by bucket
    const stepCStart = Date.now();
    const inboundResult = aggregateInboundByBucket(
      poForecastsResult.poForecasts, 
      timeBuckets
    );
    const stepCDuration = Date.now() - stepCStart;
    
    // Build supplier stats map for trace
    const supplierStatsMap = {};
    supplierStatsResult.supplierStats.forEach(stats => {
      const key = stats.plant_id 
        ? `${stats.supplier_id}|${stats.plant_id}` 
        : stats.supplier_id;
      supplierStatsMap[key] = stats;
    });
    
    // Step D: Build trace
    const stepDStart = Date.now();
    const traces = buildInboundTrace(
      inboundResult.inboundByBucket,
      poForecastsResult.poForecasts,
      supplierStatsMap
    );
    const stepDDuration = Date.now() - stepDStart;
    
    const totalDuration = Date.now() - startTime;
    
    return {
      success: true,
      supplierStats: supplierStatsResult.supplierStats,
      poForecasts: poForecastsResult.poForecasts,
      inboundByBucket: inboundResult.inboundByBucket,
      traces,
      metrics: {
        modelVersion,
        totalDurationMs: totalDuration,
        stepTimings: {
          supplierStatsMs: stepADuration,
          poForecastMs: stepBDuration,
          aggregateMs: stepCDuration,
          traceMs: stepDDuration
        },
        supplierStatsMetrics: supplierStatsResult.metrics,
        poForecastMetrics: poForecastsResult.metrics,
        inboundMetrics: inboundResult.metrics,
        traceCount: traces.length
      }
    };
    
  } catch (error) {
    return {
      success: false,
      error: error.message,
      stack: error.stack
    };
  }
}

// Export all functions for testing
export default {
  executeSupplyForecast,
  buildSupplierStats,
  calculatePOForecasts,
  aggregateInboundByBucket,
  buildInboundTrace,
  calculatePercentile,
  calculateMedian,
  dateToBucket,
  bucketToDate,
  daysBetween
};
