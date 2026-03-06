/**
 * chatRefinementService.js
 *
 * Handles iterative refinement of plans — parameter changes and re-runs.
 * Enables conversations like:
 *   "Change budget to 500K and re-run"
 *   "Compare with last plan"
 *   "What changed?"
 */

import {
  rotatePlanContext,
  applyParameterOverride,
  getEffectiveConstraints,
  getEffectiveObjective,
  canCompareWithPrevious,
  getLastForecastRunId,
} from './sessionContextService';

// ── Parameter Change → Re-run ────────────────────────────────────────────────

/**
 * Handle a CHANGE_PARAM intent: apply overrides to session context, then re-run plan.
 *
 * @param {Object} params
 * @param {Object} params.parsedIntent - from chatIntentService.parseIntent()
 * @param {Object} params.sessionContext - current session context
 * @param {string} params.userId
 * @param {string} params.conversationId
 * @param {Function} params.rerunPlan - async ({ constraintsOverride, objectiveOverride, forecastRunId, planningHorizonDays, riskMode }) => planResult
 * @returns {Promise<Object>} { planResult, comparison, changedParams }
 */
export async function handleParameterChange({
  parsedIntent,
  sessionContext,
  userId,
  conversationId,
  rerunPlan,
}) {
  const entities = parsedIntent?.entities || {};
  const changedParams = [];

  // 1. Rotate current plan to previous_plan for comparison
  if (sessionContext?.plan?.run_id) {
    rotatePlanContext(userId, conversationId);
  }

  // 2. Apply each extracted entity as an override
  const overrideMap = {
    budget_cap: entities.budget_cap,
    service_level_target: entities.service_level_target,
    planning_horizon_days: entities.planning_horizon_days,
    'risk_settings.risk_mode': entities.risk_mode,
  };

  for (const [key, value] of Object.entries(overrideMap)) {
    if (value != null) {
      applyParameterOverride(userId, conversationId, key, value);
      changedParams.push({ key, value });
    }
  }

  // Handle lead time overrides (apply delta to all or specific materials)
  if (entities.lead_time_delta_days != null) {
    const delta = entities.lead_time_delta_days;
    const materialCodes = entities.material_codes?.length > 0
      ? entities.material_codes
      : ['__all__'];
    const ltOverrides = {};
    materialCodes.forEach((mc) => { ltOverrides[mc] = delta; });
    applyParameterOverride(userId, conversationId, 'lead_time_overrides', ltOverrides);
    changedParams.push({ key: 'lead_time_delta_days', value: delta, materials: materialCodes });
  }

  // Handle safety stock overrides
  if (entities.safety_stock_override != null) {
    const materialCodes = entities.material_codes?.length > 0
      ? entities.material_codes
      : ['__all__'];
    const ssOverrides = {};
    materialCodes.forEach((mc) => { ssOverrides[mc] = entities.safety_stock_override; });
    applyParameterOverride(userId, conversationId, 'safety_stock_overrides', ssOverrides);
    changedParams.push({ key: 'safety_stock_override', value: entities.safety_stock_override });
  }

  // 3. Build effective constraints and objective from session context + overrides
  // Re-read context after applying overrides
  const { getSessionContext } = await import('./sessionContextService');
  const updatedCtx = getSessionContext(userId, conversationId);
  const effectiveConstraints = getEffectiveConstraints(updatedCtx);
  const effectiveObjective = getEffectiveObjective(updatedCtx);

  // 4. Re-run plan with merged params
  const forecastRunId = getLastForecastRunId(updatedCtx);
  const planResult = await rerunPlan({
    constraintsOverride: effectiveConstraints,
    objectiveOverride: effectiveObjective.result || null,
    forecastRunId,
    planningHorizonDays: entities.planning_horizon_days || updatedCtx.overrides?.planning_horizon_days || null,
    riskMode: effectiveObjective.risk_mode || null,
  });

  // 5. Build comparison if previous plan exists
  let comparison = null;
  if (canCompareWithPrevious(updatedCtx)) {
    comparison = buildPlanComparisonPayload(updatedCtx.previous_plan, planResult);
  }

  return { planResult, comparison, changedParams };
}

// ── Plan Comparison ──────────────────────────────────────────────────────────

/**
 * Build a plan comparison card payload from session context.
 *
 * @param {Object} sessionContext - current session context (must have plan + previous_plan)
 * @returns {Object|null} comparison payload for PlanComparisonCard, or null if no comparison available
 */
export function handlePlanComparison(sessionContext) {
  if (!canCompareWithPrevious(sessionContext)) {
    return null;
  }

  const prev = sessionContext.previous_plan;
  const curr = sessionContext.plan;

  return {
    type: 'plan_comparison_card',
    previous: {
      run_id: prev.run_id,
      kpis: prev.kpis || {},
      constraints: prev.constraints || {},
      objective: prev.objective,
    },
    current: {
      run_id: curr.run_id,
      kpis: curr.kpis || {},
      constraints: curr.constraints || {},
      objective: curr.objective,
      solver_status: curr.solver_status,
      risk_mode: curr.risk_mode,
    },
    deltas: computeKpiDeltas(prev.kpis || {}, curr.kpis || {}),
  };
}

/**
 * Build a comparison payload from previous plan context and a new plan result.
 *
 * @param {Object} previousPlan - { run_id, kpis, constraints, objective }
 * @param {Object} newPlanResult - result from chatPlanningService
 * @returns {Object} comparison payload
 */
function buildPlanComparisonPayload(previousPlan, newPlanResult) {
  const newKpis = newPlanResult?.solver_result?.kpis || {};
  const prevKpis = previousPlan?.kpis || {};

  return {
    type: 'plan_comparison_card',
    previous: {
      run_id: previousPlan?.run_id,
      kpis: prevKpis,
    },
    current: {
      run_id: newPlanResult?.run?.id ?? null,
      kpis: newKpis,
      solver_status: newPlanResult?.solver_result?.status ?? null,
      risk_mode: newPlanResult?.risk_mode ?? null,
    },
    deltas: computeKpiDeltas(prevKpis, newKpis),
  };
}

/**
 * Compute KPI deltas between two plan snapshots.
 *
 * @param {Object} prevKpis
 * @param {Object} currKpis
 * @returns {Object} deltas with absolute and percentage changes
 */
function computeKpiDeltas(prevKpis, currKpis) {
  const delta = (prev, curr) => {
    if (prev == null || curr == null) return { absolute: null, percent: null };
    const abs = curr - prev;
    const pct = prev !== 0 ? (abs / prev) * 100 : null;
    return { absolute: abs, percent: pct != null ? Math.round(pct * 10) / 10 : null };
  };

  return {
    estimated_total_cost: delta(prevKpis.estimated_total_cost, currKpis.estimated_total_cost),
    estimated_service_level: delta(prevKpis.estimated_service_level, currKpis.estimated_service_level),
    estimated_stockout_units: delta(prevKpis.estimated_stockout_units, currKpis.estimated_stockout_units),
    estimated_holding_units: delta(prevKpis.estimated_holding_units, currKpis.estimated_holding_units),
  };
}

/**
 * Build a summary text describing what changed between two plans.
 *
 * @param {Object} comparison - from handlePlanComparison
 * @returns {string}
 */
export function buildComparisonSummaryText(comparison) {
  if (!comparison?.deltas) return '';

  const parts = [];
  const d = comparison.deltas;

  if (d.estimated_total_cost?.absolute != null) {
    const dir = d.estimated_total_cost.absolute > 0 ? 'increased' : 'decreased';
    parts.push(`Total cost ${dir} by $${Math.abs(d.estimated_total_cost.absolute).toLocaleString()} (${d.estimated_total_cost.percent > 0 ? '+' : ''}${d.estimated_total_cost.percent}%)`);
  }

  if (d.estimated_service_level?.absolute != null) {
    const dir = d.estimated_service_level.absolute > 0 ? 'improved' : 'declined';
    const absVal = Math.abs(d.estimated_service_level.absolute * 100);
    parts.push(`Service level ${dir} by ${absVal.toFixed(1)} pp`);
  }

  if (d.estimated_stockout_units?.absolute != null) {
    const dir = d.estimated_stockout_units.absolute > 0 ? 'increased' : 'decreased';
    parts.push(`Stockout units ${dir} by ${Math.abs(d.estimated_stockout_units.absolute).toLocaleString()}`);
  }

  return parts.length > 0
    ? `Compared to previous plan (run #${comparison.previous?.run_id ?? '?'}): ${parts.join('; ')}.`
    : 'No significant changes detected.';
}

export default {
  handleParameterChange,
  handlePlanComparison,
  buildComparisonSummaryText,
};
