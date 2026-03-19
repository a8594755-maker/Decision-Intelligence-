/**
 * applyScenarioOverrides
 *
 * Pure utility: applies scenario overrides to an optimization payload.
 * No circular dependencies — imported by both chatPlanningService and scenarioEngine.
 *
 * Documented override behaviors:
 *   risk_mode='on'              → base stockout_penalty × 1.5 (before multiplier)
 *   stockout_penalty_multiplier → objective.stockout_penalty × multiplier (overrides win)
 *   holding_cost_multiplier     → objective.holding_cost × multiplier
 *   service_target              → objective.service_level_target (already in objectiveOverride)
 *   safety_stock_alpha          → demand_eff[t] = p50 + α × max(0, p90 - p50)
 *   expedite_mode='on'          → lead_time_days -= lead_time_buffer_days (min 1)
 *   expedite_cost_per_unit      → objective.expedite_cost_per_unit
 *   budget_cap                  → constraints.budget_cap (already in constraintsOverride)
 *   lead_time_buffer_days       → days subtracted from lead_time when expedite_mode='on'
 */

/**
 * Apply scenario overrides to the optimization payload (mutates in place).
 * Call this AFTER assembling the payload and BEFORE calling the solver.
 *
 * @param {object} payload       - optimization payload (will be mutated)
 * @param {object} overrides     - scenario overrides
 * @param {object} engineFlags   - solver engine flags
 * @returns {{ payload, effectiveParams }} mutated payload + audit trail
 */
export function applyScenarioOverridesToPayload(payload, overrides = {}, engineFlags = {}) {
  if (!payload || !overrides) return { payload, effectiveParams: {} };

  // Idempotency guard: prevent double-application when called from both
  // scenarioEngine and chatPlanningService in the same pipeline.
  if (payload._scenario_overrides_applied) {
    return { payload, effectiveParams: {} };
  }

  const effectiveParams = {};

  // ─── risk_mode: boost baseline stockout_penalty before multiplier ───
  // risk_mode can come from overrides or engineFlags; overrides win for explicit multiplier
  const riskModeOn = overrides.risk_mode === 'on' || engineFlags.risk_mode === 'on';
  if (riskModeOn && payload.objective) {
    const baseStockout = payload.objective.stockout_penalty ?? 1;
    const boosted = Number((baseStockout * 1.5).toFixed(6));
    payload.objective.stockout_penalty = boosted;
    effectiveParams.risk_mode_base_stockout_penalty = boosted;
  }

  // ─── stockout_penalty_multiplier (overrides win over risk_mode boost) ───
  if (overrides.stockout_penalty_multiplier != null) {
    const mult = Number(overrides.stockout_penalty_multiplier);
    if (Number.isFinite(mult) && mult > 0 && payload.objective) {
      const newPenalty = Number(((payload.objective.stockout_penalty ?? 1) * mult).toFixed(6));
      payload.objective.stockout_penalty = newPenalty;
      effectiveParams.stockout_penalty_final = newPenalty;
    }
  }

  // ─── holding_cost_multiplier ───
  if (overrides.holding_cost_multiplier != null) {
    const mult = Number(overrides.holding_cost_multiplier);
    if (Number.isFinite(mult) && mult >= 0 && payload.objective) {
      const newHolding = Number(((payload.objective.holding_cost ?? 0) * mult).toFixed(6));
      payload.objective.holding_cost = newHolding;
      effectiveParams.holding_cost_final = newHolding;
    }
  }

  // ─── safety_stock_alpha: demand_eff[t] = p50 + α × max(0, p90 - p50) ───
  if (overrides.safety_stock_alpha != null) {
    const alpha = Number(overrides.safety_stock_alpha);
    if (Number.isFinite(alpha) && alpha >= 0 && Array.isArray(payload.demand_forecast?.series)) {
      payload.demand_forecast.series = payload.demand_forecast.series.map((row) => {
        const p50 = Number(row.p50 ?? 0);
        const p90 = Number(row.p90 ?? p50);
        const uplift = alpha * Math.max(0, p90 - p50);
        return { ...row, p50: Number((p50 + uplift).toFixed(4)) };
      });
      effectiveParams.safety_stock_alpha = alpha;
    }
  }

  // ─── expedite_mode: reduce lead_time_days ───
  if (overrides.expedite_mode === 'on') {
    const bufferDays = Number(overrides.lead_time_buffer_days ?? 3);
    const costPerUnit = Number(overrides.expedite_cost_per_unit ?? 0);

    if (Array.isArray(payload.inventory)) {
      payload.inventory = payload.inventory.map((row) => ({
        ...row,
        lead_time_days: Math.max(1, (Number(row.lead_time_days) || 7) - bufferDays)
      }));
    }
    effectiveParams.expedite_lead_time_buffer_days = bufferDays;

    if (costPerUnit > 0 && payload.objective) {
      payload.objective.expedite_cost_per_unit = costPerUnit;
      effectiveParams.expedite_cost_per_unit = costPerUnit;
    }
  }

  // ─── per-supplier overrides: adjust lead_time / cost per supplier ───
  if (overrides.supplier_overrides && typeof overrides.supplier_overrides === 'object') {
    const supplierMap = overrides.supplier_overrides;
    const appliedSuppliers = [];

    if (Array.isArray(payload.inventory)) {
      payload.inventory = payload.inventory.map((row) => {
        const supplierId = row.supplier_id || row.supplier || row.vendor_id;
        if (!supplierId || !supplierMap[supplierId]) return row;

        const overrideSpec = supplierMap[supplierId];
        const updated = { ...row };

        // Per-supplier lead_time_buffer_days
        if (overrideSpec.lead_time_buffer_days != null) {
          const buffer = Number(overrideSpec.lead_time_buffer_days);
          if (Number.isFinite(buffer) && buffer > 0) {
            updated.lead_time_days = Math.max(1, (Number(row.lead_time_days) || 7) - buffer);
          }
        }

        // Per-supplier cost_multiplier
        if (overrideSpec.cost_multiplier != null) {
          const mult = Number(overrideSpec.cost_multiplier);
          if (Number.isFinite(mult) && mult > 0) {
            updated.unit_cost = Number(((Number(row.unit_cost) || 0) * mult).toFixed(4));
          }
        }

        appliedSuppliers.push(supplierId);
        return updated;
      });
    }

    if (appliedSuppliers.length > 0) {
      effectiveParams.supplier_overrides_applied = [...new Set(appliedSuppliers)];
    }
  }

  // ─── budget_cap echo (already set in constraints via constraintsOverride) ───
  if (overrides.budget_cap != null) {
    effectiveParams.budget_cap = Number(overrides.budget_cap);
  }
  if (overrides.service_target != null) {
    effectiveParams.service_level_target = Number(overrides.service_target);
  }

  // Mark payload so subsequent calls are no-ops (idempotency).
  payload._scenario_overrides_applied = true;

  return { payload, effectiveParams };
}

export default { applyScenarioOverridesToPayload };
