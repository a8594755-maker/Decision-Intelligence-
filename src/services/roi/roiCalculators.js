/**
 * roiCalculators.js — Pure-function ROI value calculators
 *
 * Each calculator produces a value_event record from task artifacts.
 * All functions are deterministic and side-effect-free.
 *
 * @module services/roi/roiCalculators
 */

// ── Value Types ─────────────────────────────────────────────────────────────

export const VALUE_TYPES = Object.freeze({
  STOCKOUT_PREVENTED:         'stockout_prevented',
  COST_SAVED:                 'cost_saved',
  TIME_SAVED_HOURS:           'time_saved_hours',
  REVENUE_PROTECTED:          'revenue_protected',
  EXPEDITE_AVOIDED:           'expedite_avoided',
  SERVICE_LEVEL_IMPROVEMENT:  'service_level_improvement',
  MANUAL_TASK_AUTOMATED:      'manual_task_automated',
});

// ── Default assumptions ─────────────────────────────────────────────────────

export const ROI_DEFAULTS = Object.freeze({
  avg_unit_margin:        25,     // $ per unit
  avg_stockout_cost:      50,     // $ per unit per day
  expedite_premium_pct:   0.35,   // 35% premium over normal cost
  manual_hours_by_workflow: {
    replenishment:        4,
    risk_plan:            6,
    risk_aware:           6,
    forecast:             2,
    negotiation:          8,
    mbr_report:           3,
    default:              3,
  },
  hourly_analyst_cost:    75,     // $ per hour
});

// ── Calculators ─────────────────────────────────────────────────────────────

/**
 * Estimate value of stockouts prevented.
 *
 * @param {Object} params
 * @param {number} params.atRiskUnits - Units at risk of stockout
 * @param {number} [params.margin] - $ margin per unit
 * @param {number} [params.probability] - P(stockout) 0-1
 * @param {number} [params.avoidedDays] - Days of stockout avoided
 * @returns {{ value_type, value_amount, confidence, calculation_method, baseline_reference }}
 */
export function estimateStockoutPreventionValue({
  atRiskUnits,
  margin = ROI_DEFAULTS.avg_unit_margin,
  probability = 1.0,
  avoidedDays = 1,
}) {
  if (!atRiskUnits || atRiskUnits <= 0) {
    return null;
  }

  const rawValue = atRiskUnits * margin * probability * avoidedDays;
  const confidence = Math.min(0.95, probability * 0.8 + 0.1);

  return {
    value_type: VALUE_TYPES.STOCKOUT_PREVENTED,
    value_amount: Math.round(rawValue * 100) / 100,
    confidence: Math.round(confidence * 100) / 100,
    calculation_method: `stockout_prevention: ${atRiskUnits} units × $${margin} margin × P(${probability}) × ${avoidedDays} days`,
    baseline_reference: {
      at_risk_units: atRiskUnits,
      unit_margin: margin,
      probability,
      avoided_days: avoidedDays,
    },
  };
}

/**
 * Estimate cost savings from optimization.
 *
 * @param {Object} params
 * @param {number} params.optimizedCost - Cost after optimization
 * @param {number} params.baselineCost - Cost before optimization (or naive plan)
 * @returns {{ value_type, value_amount, confidence, calculation_method, baseline_reference }}
 */
export function estimateCostSavings({
  optimizedCost,
  baselineCost,
}) {
  if (baselineCost == null || optimizedCost == null) return null;
  if (baselineCost <= 0) return null;

  const savings = baselineCost - optimizedCost;
  if (savings <= 0) return null; // No savings = no value event

  const pctSaved = savings / baselineCost;
  // Confidence scales with savings magnitude — tiny savings are more uncertain
  const confidence = Math.min(0.9, 0.5 + pctSaved * 2);

  return {
    value_type: VALUE_TYPES.COST_SAVED,
    value_amount: Math.round(savings * 100) / 100,
    confidence: Math.round(confidence * 100) / 100,
    calculation_method: `cost_savings: $${baselineCost} baseline - $${optimizedCost} optimized = $${savings.toFixed(2)} saved (${(pctSaved * 100).toFixed(1)}%)`,
    baseline_reference: {
      baseline_cost: baselineCost,
      optimized_cost: optimizedCost,
      pct_saved: Math.round(pctSaved * 1000) / 1000,
    },
  };
}

/**
 * Estimate time saved by automation.
 *
 * @param {Object} params
 * @param {string} [params.workflowType] - Workflow type for lookup
 * @param {number} [params.standardManualHours] - Override manual hours
 * @param {number} [params.completionConfidence] - Task completion confidence (0-1)
 * @param {number} [params.hourlyCost] - Analyst hourly cost
 * @returns {{ value_type, value_amount, confidence, calculation_method, baseline_reference }}
 */
export function estimateTimeSaved({
  workflowType = 'default',
  standardManualHours = null,
  completionConfidence = 0.8,
  hourlyCost = ROI_DEFAULTS.hourly_analyst_cost,
}) {
  const manualHours = standardManualHours
    || ROI_DEFAULTS.manual_hours_by_workflow[workflowType]
    || ROI_DEFAULTS.manual_hours_by_workflow.default;

  const effectiveHours = manualHours * completionConfidence;
  const dollarValue = effectiveHours * hourlyCost;

  return {
    value_type: VALUE_TYPES.TIME_SAVED_HOURS,
    value_amount: Math.round(dollarValue * 100) / 100,
    confidence: Math.round(completionConfidence * 100) / 100,
    calculation_method: `time_saved: ${manualHours}h manual × ${completionConfidence} confidence × $${hourlyCost}/h = $${dollarValue.toFixed(2)}`,
    baseline_reference: {
      manual_hours: manualHours,
      effective_hours: Math.round(effectiveHours * 100) / 100,
      hourly_cost: hourlyCost,
      workflow_type: workflowType,
    },
  };
}

/**
 * Estimate revenue protected by service level improvement.
 *
 * @param {Object} params
 * @param {number} params.serviceLevelDelta - Service level improvement (e.g., 0.05 for +5%)
 * @param {number} params.totalRevenue - Total revenue at stake
 * @returns {{ value_type, value_amount, confidence, calculation_method, baseline_reference }}
 */
export function estimateRevenueProtected({
  serviceLevelDelta,
  totalRevenue,
}) {
  if (!serviceLevelDelta || serviceLevelDelta <= 0 || !totalRevenue) return null;

  const protectedRevenue = totalRevenue * serviceLevelDelta;
  const confidence = Math.min(0.85, 0.4 + serviceLevelDelta * 4);

  return {
    value_type: VALUE_TYPES.REVENUE_PROTECTED,
    value_amount: Math.round(protectedRevenue * 100) / 100,
    confidence: Math.round(confidence * 100) / 100,
    calculation_method: `revenue_protected: $${totalRevenue} × ${(serviceLevelDelta * 100).toFixed(1)}% SL improvement`,
    baseline_reference: {
      service_level_delta: serviceLevelDelta,
      total_revenue: totalRevenue,
    },
  };
}

// ── Aggregate calculator ────────────────────────────────────────────────────

/**
 * Extract all applicable value events from task artifacts.
 *
 * @param {Object} params
 * @param {Object} params.decisionBrief - decision_brief artifact
 * @param {Object} params.writebackPayload - writeback_payload artifact
 * @param {Object} params.taskMeta - { id, title, workflowType }
 * @param {string} [params.workerId]
 * @returns {Object[]} Array of value_event records (ready for DB insert)
 */
export function extractValueEvents({
  decisionBrief = {},
  writebackPayload = {},
  taskMeta = {},
  workerId = null,
}) {
  const events = [];
  const impact = decisionBrief.business_impact || {};
  const confidence = decisionBrief.confidence || 0.5;

  // 1. Stockout prevention (from replay metrics)
  if (impact.stockouts_prevented > 0) {
    const ve = estimateStockoutPreventionValue({
      atRiskUnits: impact.stockouts_prevented,
      probability: confidence,
    });
    if (ve) events.push({ ...ve, task_id: taskMeta.id, worker_id: workerId, workflow_type: taskMeta.workflowType });
  }

  // 2. Cost savings (from solver KPIs)
  if (impact.total_cost !== undefined && impact.total_cost > 0) {
    // Estimate baseline as 15% higher than optimized (conservative)
    const baselineCost = impact.total_cost * 1.15;
    const ve = estimateCostSavings({ optimizedCost: impact.total_cost, baselineCost });
    if (ve) events.push({ ...ve, task_id: taskMeta.id, worker_id: workerId, workflow_type: taskMeta.workflowType });
  }

  // 3. Time saved (always applicable for completed tasks)
  const timeSaved = estimateTimeSaved({
    workflowType: taskMeta.workflowType || 'default',
    completionConfidence: confidence,
  });
  if (timeSaved) events.push({ ...timeSaved, task_id: taskMeta.id, worker_id: workerId, workflow_type: taskMeta.workflowType });

  // 4. Revenue protected (from service level impact)
  if (impact.service_level_impact) {
    const deltaStr = impact.service_level_impact.replace('%', '').replace('+', '');
    const delta = parseFloat(deltaStr) / 100;
    if (delta > 0 && impact.units_affected) {
      const ve = estimateRevenueProtected({
        serviceLevelDelta: delta,
        totalRevenue: impact.units_affected * ROI_DEFAULTS.avg_unit_margin,
      });
      if (ve) events.push({ ...ve, task_id: taskMeta.id, worker_id: workerId, workflow_type: taskMeta.workflowType });
    }
  }

  return events;
}

// ── Summary ─────────────────────────────────────────────────────────────────

/**
 * Summarize value events into aggregate metrics.
 *
 * @param {Object[]} events - Array of value_event records
 * @returns {{ total_value, by_type, event_count, avg_confidence }}
 */
export function summarizeValueEvents(events) {
  if (!events || events.length === 0) {
    return { total_value: 0, by_type: {}, event_count: 0, avg_confidence: 0 };
  }

  const byType = {};
  let totalValue = 0;
  let totalConfidence = 0;

  for (const e of events) {
    totalValue += e.value_amount || 0;
    totalConfidence += e.confidence || 0;
    if (!byType[e.value_type]) byType[e.value_type] = 0;
    byType[e.value_type] += e.value_amount || 0;
  }

  return {
    total_value: Math.round(totalValue * 100) / 100,
    by_type: byType,
    event_count: events.length,
    avg_confidence: Math.round((totalConfidence / events.length) * 100) / 100,
  };
}
