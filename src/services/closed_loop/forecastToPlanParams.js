/**
 * Forecast-to-Planning Parameterization Layer v0
 *
 * Deterministic adapter: maps forecast outputs (quantiles, calibration, risk)
 * into planning parameter patches. Given the same inputs, always produces
 * identical JSON (no randomness).
 *
 * Pattern: mirrors computeRiskAdjustments in riskAdjustmentsService.js
 */

import { CLOSED_LOOP_CONFIG } from './closedLoopConfig.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const toNumber = (value, fallback = NaN) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeText = (value) => String(value || '').trim();

const toSkuKey = (sku, plantId) =>
  `${normalizeText(sku)}|${normalizeText(plantId)}`;

const sortedObject = (obj) => {
  if (!obj || typeof obj !== 'object') return obj;
  return Object.fromEntries(
    Object.entries(obj).sort(([a], [b]) => a.localeCompare(b))
  );
};

// ─── Aggregate helpers ────────────────────────────────────────────────────────

/**
 * Compute per-SKU aggregates from forecast series.
 * Returns Map<skuKey, { avg_p50, avg_p90, avg_p10, count, sum_width }>
 */
function aggregateBySkuKey(series) {
  const map = new Map();
  if (!Array.isArray(series)) return map;

  series.forEach((pt) => {
    const key = toSkuKey(pt.sku || pt.material_code, pt.plant_id);
    const entry = map.get(key) || { sum_p50: 0, sum_p90: 0, sum_p10: 0, count: 0, sum_width: 0 };
    const p50 = toNumber(pt.p50, 0);
    const p90 = toNumber(pt.p90, p50);
    const p10 = toNumber(pt.p10, p50);
    entry.sum_p50 += p50;
    entry.sum_p90 += p90;
    entry.sum_p10 += p10;
    entry.sum_width += Math.max(0, p90 - p10);
    entry.count += 1;
    map.set(key, entry);
  });

  // Convert sums to averages
  for (const [key, entry] of map) {
    if (entry.count > 0) {
      entry.avg_p50 = entry.sum_p50 / entry.count;
      entry.avg_p90 = entry.sum_p90 / entry.count;
      entry.avg_p10 = entry.sum_p10 / entry.count;
    } else {
      entry.avg_p50 = 0;
      entry.avg_p90 = 0;
      entry.avg_p10 = 0;
    }
    map.set(key, entry);
  }

  return map;
}

/**
 * Compute aggregate uncertainty width across all series points.
 * Returns sum(p90 - p10) across all points.
 */
function aggregateUncertaintyWidth(series) {
  if (!Array.isArray(series) || series.length === 0) return 0;
  return series.reduce((acc, pt) => {
    const p90 = toNumber(pt.p90, toNumber(pt.p50, 0));
    const p10 = toNumber(pt.p10, toNumber(pt.p50, 0));
    return acc + Math.max(0, p90 - p10);
  }, 0);
}

/**
 * Compute aggregate p50 across all series points.
 */
function aggregateP50(series) {
  if (!Array.isArray(series) || series.length === 0) return 0;
  return series.reduce((acc, pt) => acc + toNumber(pt.p50, 0), 0);
}

// ─── Core transformation ──────────────────────────────────────────────────────

/**
 * derivePlanningParams
 *
 * Pure function: forecast bundle + calibration + risk → planning parameter patch.
 *
 * @param {Object} params
 * @param {Object} params.forecastBundle    - { series: [{sku, plant_id, date, p10, p50, p90}], metrics: {...} }
 * @param {Object} params.calibrationMeta   - { calibration_passed, coverage_10_90, uncertainty_method } (nullable)
 * @param {Object} params.riskBundle        - { riskScores: [{material_code, plant_id, risk_score, metrics}] } (nullable)
 * @param {Object} params.previousForecast  - Previous forecast bundle for delta comparison (nullable)
 * @param {Object} params.policyConfig      - Override for CLOSED_LOOP_CONFIG thresholds
 *
 * @returns {{ patch: Object, explanation: string[], derived_values: Object }}
 */
export function derivePlanningParams({
  forecastBundle = {},
  calibrationMeta = null,
  riskBundle = null,
  previousForecast = null,
  policyConfig = {}
} = {}) {
  const config = { ...CLOSED_LOOP_CONFIG, ...policyConfig };
  const generatedAt = new Date().toISOString();

  const series = Array.isArray(forecastBundle.series) ? forecastBundle.series : [];
  const explanation = [];
  const rules = [];

  // ── R-CL1: Alpha selection based on calibration quality ─────────────────────
  const calibrationPassed = calibrationMeta?.calibration_passed;
  const coverage = toNumber(calibrationMeta?.coverage_10_90, NaN);
  const hasCoverage = Number.isFinite(coverage);

  let effectiveAlpha;
  if (hasCoverage && coverage > config.coverage_upper_band) {
    // Wide uncertainty → most conservative
    effectiveAlpha = config.safety_stock_alpha_wide_uncertainty;
    explanation.push(
      `R-CL1: coverage_10_90=${coverage.toFixed(4)} > upper_band=${config.coverage_upper_band}; ` +
      `raised safety_stock_alpha to ${effectiveAlpha} (wide uncertainty)`
    );
    rules.push({
      rule_id: 'R-CL1_alpha_wide_uncertainty',
      description: 'Wide uncertainty band detected; using maximum safety stock alpha.',
      evidence_refs: [`coverage_10_90=${coverage.toFixed(4)}`, `upper_band=${config.coverage_upper_band}`],
      params_delta: { safety_stock_alpha: effectiveAlpha }
    });
  } else if (calibrationPassed === true && hasCoverage && coverage >= config.coverage_lower_band) {
    // Good calibration
    effectiveAlpha = config.safety_stock_alpha_calibrated;
    explanation.push(
      `R-CL1: Calibration passed, coverage_10_90=${coverage.toFixed(4)} in band; ` +
      `using safety_stock_alpha=${effectiveAlpha}`
    );
  } else {
    // Uncalibrated or metadata absent
    effectiveAlpha = config.safety_stock_alpha_uncalibrated;
    const reason = calibrationPassed === false
      ? 'calibration failed'
      : 'calibration metadata absent';
    explanation.push(
      `R-CL1: ${reason}; raised safety_stock_alpha to ${effectiveAlpha} (conservative)`
    );
    rules.push({
      rule_id: 'R-CL1_alpha_uncalibrated',
      description: 'Calibration not passed or absent; using conservative safety stock alpha.',
      evidence_refs: [
        `calibration_passed=${calibrationPassed ?? 'null'}`,
        hasCoverage ? `coverage_10_90=${coverage.toFixed(4)}` : 'coverage_10_90=null'
      ],
      params_delta: { safety_stock_alpha: effectiveAlpha }
    });
  }

  // ── R-CL2: Stockout penalty adjustment when uncertainty widens ──────────────
  let effectiveStockoutPenalty = config.stockout_penalty_base;
  let stockoutPenaltyBase = config.stockout_penalty_base;
  let uncertaintyWidthDeltaPct = null;

  if (previousForecast && Array.isArray(previousForecast.series) && previousForecast.series.length > 0) {
    const currentWidth = aggregateUncertaintyWidth(series);
    const previousWidth = aggregateUncertaintyWidth(previousForecast.series);

    if (previousWidth > 0) {
      uncertaintyWidthDeltaPct = (currentWidth - previousWidth) / previousWidth;

      if (uncertaintyWidthDeltaPct > config.uncertainty_width_change_pct) {
        const uplift = config.stockout_penalty_uncertainty_uplift;
        effectiveStockoutPenalty = Number((stockoutPenaltyBase * (1 + uplift)).toFixed(6));
        explanation.push(
          `R-CL2: Uncertainty width increased ${(uncertaintyWidthDeltaPct * 100).toFixed(1)}% ` +
          `> threshold ${(config.uncertainty_width_change_pct * 100).toFixed(1)}%; ` +
          `increased stockout_penalty from ${stockoutPenaltyBase} to ${effectiveStockoutPenalty}`
        );
        rules.push({
          rule_id: 'R-CL2_stockout_penalty_uplift',
          description: 'Uncertainty width increased beyond threshold; raised stockout penalty.',
          evidence_refs: [
            `delta_pct=${uncertaintyWidthDeltaPct.toFixed(4)}`,
            `threshold=${config.uncertainty_width_change_pct}`
          ],
          params_delta: {
            stockout_penalty: effectiveStockoutPenalty,
            stockout_penalty_base: stockoutPenaltyBase
          }
        });
      }
    }
  }

  // ── R-CL3: Lead time buffer from risk ───────────────────────────────────────
  const leadTimeBufferByKey = {};
  const riskScores = riskBundle?.riskScores || riskBundle?.risk_scores || [];
  let riskEntitiesAboveThreshold = 0;

  if (Array.isArray(riskScores) && riskScores.length > 0) {
    const sortedRiskRows = [...riskScores].sort((a, b) => {
      const ka = toSkuKey(a.material_code || a.entity_id, a.plant_id);
      const kb = toSkuKey(b.material_code || b.entity_id, b.plant_id);
      return ka.localeCompare(kb);
    });

    sortedRiskRows.forEach((entity) => {
      const riskScore = toNumber(entity.risk_score, 0);
      if (riskScore > config.risk_severity_trigger) {
        const materialCode = normalizeText(entity.material_code || entity.entity_id);
        const plantId = normalizeText(entity.plant_id);
        const key = toSkuKey(materialCode, plantId);
        leadTimeBufferByKey[key] = config.lead_time_buffer_high_risk_days;
        riskEntitiesAboveThreshold += 1;
      }
    });

    if (riskEntitiesAboveThreshold > 0) {
      explanation.push(
        `R-CL3: ${riskEntitiesAboveThreshold} entity(ies) with risk_score > ${config.risk_severity_trigger}; ` +
        `added ${config.lead_time_buffer_high_risk_days}-day lead time buffer`
      );
      rules.push({
        rule_id: 'R-CL3_lead_time_buffer',
        description: 'High supplier risk detected; added lead time buffer days.',
        evidence_refs: [
          `entities_above_threshold=${riskEntitiesAboveThreshold}`,
          `buffer_days=${config.lead_time_buffer_high_risk_days}`
        ],
        params_delta: { lead_time_buffer_by_key: sortedObject(leadTimeBufferByKey) }
      });
    }
  }

  // ── R-CL4: Per-SKU safety stock computation ────────────────────────────────
  const safetyStockByKey = {};
  const skuAggregates = aggregateBySkuKey(series);

  const sortedSkuKeys = Array.from(skuAggregates.keys()).sort();
  sortedSkuKeys.forEach((key) => {
    const agg = skuAggregates.get(key);
    const spread = Math.max(0, agg.avg_p90 - agg.avg_p50);
    const safetyStock = Number((agg.avg_p50 + effectiveAlpha * spread).toFixed(6));
    safetyStockByKey[key] = safetyStock;
  });

  if (sortedSkuKeys.length > 0) {
    explanation.push(
      `R-CL4: Computed safety_stock for ${sortedSkuKeys.length} SKU(s) ` +
      `with alpha=${effectiveAlpha}`
    );
  }

  // ── Build output ────────────────────────────────────────────────────────────
  return {
    version: 'v0',
    generated_at: generatedAt,
    patch: {
      safety_stock_by_key: sortedObject(safetyStockByKey),
      objective: {
        stockout_penalty: effectiveStockoutPenalty,
        stockout_penalty_base: stockoutPenaltyBase
      },
      lead_time_buffer_by_key: sortedObject(leadTimeBufferByKey),
      safety_stock_alpha: effectiveAlpha
    },
    explanation,
    rules,
    derived_values: {
      calibration_passed: calibrationPassed ?? null,
      coverage_10_90: hasCoverage ? Number(coverage.toFixed(6)) : null,
      effective_alpha: effectiveAlpha,
      uncertainty_width_delta_pct: uncertaintyWidthDeltaPct !== null
        ? Number(uncertaintyWidthDeltaPct.toFixed(6))
        : null,
      risk_entities_above_threshold: riskEntitiesAboveThreshold
    }
  };
}

// Also export aggregate helpers for use by trigger engine
export { aggregateUncertaintyWidth, aggregateP50 };
