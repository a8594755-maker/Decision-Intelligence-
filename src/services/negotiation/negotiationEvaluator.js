/**
 * Negotiation Evaluator - Step 9 Agentic Negotiation Loop v0
 *
 * Evaluates each negotiation option by actually re-solving via
 * runPlanFromDatasetProfile with modified constraints/objective.
 *
 * Deterministic ranking:
 *   1. feasibility (feasible first)
 *   2. service_level_proxy delta (higher is better)
 *   3. cost delta (lower is better)
 *   4. constraint_violations count (fewer is better)
 *
 * LLM generates NO numbers here; all deltas are computed from solver outputs.
 */

import { runPlanFromDatasetProfile } from '../chatPlanningService';

const RANKING_METHOD =
  'lexicographic: feasibility -> service_delta -> cost_delta -> constraint_violations';

const toNumber = (value, fallback = null) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

// ---------------------------------------------------------------------------
// Build concrete constraint / objective overrides from option definition
// ---------------------------------------------------------------------------

/**
 * Translate an option's abstract overrides into concrete arguments for
 * runPlanFromDatasetProfile.
 *
 * @param {Object} option - one option from negotiation_options.options[]
 * @returns {{ constraintsOverride: Object, objectiveOverride: Object }}
 */
function buildRunOverrides(option) {
  const constraintsOverride = {};
  const objectiveOverride = {};
  const flags = option.engine_flags || {};
  const overrideConstraints = option.overrides?.constraints || {};
  const overrideObjective = option.overrides?.objective || {};

  // --- Constraints ---
  // budget_cap override (natively supported by buildConstraintsFromInventory)
  if (Number.isFinite(Number(overrideConstraints.budget_cap))) {
    constraintsOverride.budget_cap = Number(overrideConstraints.budget_cap);
  }

  // MOQ override: if concrete moq array was pre-computed by generator, use it
  if (
    Array.isArray(overrideConstraints.moq) &&
    overrideConstraints.moq.length > 0
  ) {
    constraintsOverride.moq = overrideConstraints.moq;
  }

  // pack_size override (if pre-computed)
  if (
    Array.isArray(overrideConstraints.pack_size) &&
    overrideConstraints.pack_size.length > 0
  ) {
    constraintsOverride.pack_size = overrideConstraints.pack_size;
  }

  // --- Objective ---
  if (Number.isFinite(Number(overrideObjective.service_level_target))) {
    objectiveOverride.service_level_target = Number(
      overrideObjective.service_level_target
    );
  }
  if (overrideObjective.optimize_for) {
    objectiveOverride.optimize_for = overrideObjective.optimize_for;
  }

  // Expedite mode: if solver supports it via objective
  if (flags.expedite_mode) {
    objectiveOverride.expedite_mode = true;
    objectiveOverride.expedite_lead_time_reduction_periods =
      flags.expedite_lead_time_reduction_periods || 1;
  }

  return { constraintsOverride, objectiveOverride };
}

// ---------------------------------------------------------------------------
// Deterministic rank score computation
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic rank score for an evaluated option.
 * Lower rank_score = better option.
 *
 * Decomposed as a tuple encoded into a single float for simple sorting:
 *   - feasibility penalty: 0 if feasible/succeeded, 1e9 if failed
 *   - service delta (negated, smaller = more improvement)
 *   - cost delta (smaller = cheaper)
 *   - violation count
 *
 * @param {Object} evalResult - single entry from ranked_options
 * @param {Object} baseKpis   - base run KPIs for delta computation
 * @returns {number}
 */
function computeRankScore(evalResult, baseKpis) {
  const isFeasible =
    evalResult.status === 'succeeded' &&
    evalResult.kpis?.scenario?.feasible !== false;

  const feasibilityPenalty = isFeasible ? 0 : 1e9;

  const baseService = toNumber(baseKpis?.service_level_proxy, 0);
  const scenService = toNumber(
    evalResult.kpis?.scenario?.service_level_proxy,
    0
  );
  // Negate delta so higher improvement = lower score (better rank)
  const servicePenalty = -(scenService - baseService);

  const baseCost = toNumber(baseKpis?.estimated_total_cost, 0);
  const scenCost = toNumber(
    evalResult.kpis?.scenario?.estimated_total_cost,
    0
  );
  const costPenalty = scenCost - baseCost;

  const violationCount = Number(
    evalResult.constraints_summary?.violations_delta ?? 0
  );

  // Weighted sum (weights keep contributions in meaningful ranges)
  return feasibilityPenalty + servicePenalty * 1000 + costPenalty * 0.001 + violationCount;
}

// ---------------------------------------------------------------------------
// Exported: evaluateNegotiationOptions
// ---------------------------------------------------------------------------

/**
 * Re-solve each candidate option and return a ranked evaluation payload.
 *
 * @param {Object} params
 * @param {string|number} params.baseRunId        - plan child run ID
 * @param {Object}        params.baseKpis         - base run KPIs (from solver_meta.kpis)
 * @param {Object}        params.baseConstraintCheck - base constraint_check payload
 * @param {Object}        params.baseReplayMetrics - base replay_metrics payload
 * @param {Object[]}      params.options           - options from negotiation_options
 * @param {Object}        params.datasetProfileRow - dataset profile for re-solve
 * @param {number|null}   params.forecastRunId     - forecast child run for re-solve
 * @param {string}        params.userId            - user ID
 * @param {Object|null}   params.cfrParamAdjustment - CFR solver parameter adjustments from cfr-solver-bridge
 * @returns {Object} negotiation_evaluation payload
 */
export async function evaluateNegotiationOptions({
  baseRunId,
  baseKpis = {},
  baseConstraintCheck = {},
  baseReplayMetrics = {},
  options = [],
  datasetProfileRow,
  forecastRunId = null,
  userId,
  cfrParamAdjustment = null,
}) {
  if (!userId) throw new Error('userId is required for evaluateNegotiationOptions');
  if (!datasetProfileRow?.id)
    throw new Error('datasetProfileRow is required for evaluateNegotiationOptions');

  const baseViolationCount = Array.isArray(baseConstraintCheck?.violations)
    ? baseConstraintCheck.violations.length
    : 0;

  const evaluatedOptions = [];

  for (const option of options) {
    const { constraintsOverride, objectiveOverride } = buildRunOverrides(option);

    let evalEntry = {
      option_id: option.option_id,
      scenario_id: `${baseRunId}_${option.option_id}`,
      scenario_run_id: null,
      status: 'failed',
      kpis: {
        base: { ...baseKpis },
        scenario: {},
        delta: {}
      },
      constraints_summary: {
        base_violations: baseViolationCount,
        scenario_violations: null,
        violations_delta: null
      },
      rank_score: 1e12,
      notes: [],
      evidence_refs: Array.isArray(option.evidence_refs) ? option.evidence_refs : []
    };

    try {
      // Merge CFR solver parameter adjustments into objectiveOverride if available
      const mergedObjective = { ...objectiveOverride };
      if (cfrParamAdjustment) {
        if (cfrParamAdjustment.safety_stock_alpha_multiplier != null) {
          mergedObjective.safety_stock_alpha_multiplier = cfrParamAdjustment.safety_stock_alpha_multiplier;
        }
        if (cfrParamAdjustment.stockout_penalty_multiplier != null) {
          mergedObjective.stockout_penalty_multiplier = cfrParamAdjustment.stockout_penalty_multiplier;
        }
        if (cfrParamAdjustment.dual_source_flag) {
          mergedObjective.dual_source = true;
        }
      }

      const planResult = await runPlanFromDatasetProfile({
        userId,
        datasetProfileRow,
        forecastRunId,
        constraintsOverride:
          Object.keys(constraintsOverride).length > 0
            ? constraintsOverride
            : null,
        objectiveOverride:
          Object.keys(mergedObjective).length > 0 ? mergedObjective : null
      });

      const scenRunId = planResult?.run?.id ?? null;
      const scenSolverMeta = planResult?.solver_result || {};
      const scenConstraint = planResult?.constraint_check || {};
      const scenReplay = planResult?.replay_metrics || {};

      const scenKpis = {
        status: scenSolverMeta.status || 'unknown',
        feasible: scenSolverMeta.status !== 'INFEASIBLE',
        service_level_proxy: toNumber(
          scenReplay?.with_plan?.service_level_proxy
        ),
        stockout_units: toNumber(scenReplay?.with_plan?.stockout_units),
        estimated_total_cost: toNumber(
          scenSolverMeta?.kpis?.estimated_total_cost
        )
      };

      const baseService = toNumber(baseReplayMetrics?.with_plan?.service_level_proxy, null);
      const baseStockout = toNumber(baseReplayMetrics?.with_plan?.stockout_units, null);
      const baseCost = toNumber(baseKpis?.estimated_total_cost, null);

      const delta = {
        service_level_proxy:
          scenKpis.service_level_proxy !== null && baseService !== null
            ? Number(
                (scenKpis.service_level_proxy - baseService).toFixed(6)
              )
            : null,
        stockout_units:
          scenKpis.stockout_units !== null && baseStockout !== null
            ? Number(
                (scenKpis.stockout_units - baseStockout).toFixed(4)
              )
            : null,
        estimated_total_cost:
          scenKpis.estimated_total_cost !== null && baseCost !== null
            ? Number(
                (scenKpis.estimated_total_cost - baseCost).toFixed(4)
              )
            : null
      };

      const scenViolationCount = Array.isArray(scenConstraint?.violations)
        ? scenConstraint.violations.length
        : 0;

      evalEntry = {
        ...evalEntry,
        scenario_run_id: scenRunId,
        status: 'succeeded',
        kpis: {
          base: {
            status: String(baseKpis?.status || 'unknown'),
            service_level_proxy: toNumber(baseReplayMetrics?.with_plan?.service_level_proxy),
            stockout_units: toNumber(baseReplayMetrics?.with_plan?.stockout_units),
            estimated_total_cost: toNumber(baseKpis?.estimated_total_cost)
          },
          scenario: scenKpis,
          delta
        },
        constraints_summary: {
          base_violations: baseViolationCount,
          scenario_violations: scenViolationCount,
          violations_delta: scenViolationCount - baseViolationCount
        }
      };

      if (!scenKpis.feasible) {
        evalEntry.notes.push('Scenario solver returned INFEASIBLE.');
      }
      if (scenConstraint?.passed === false) {
        evalEntry.notes.push(
          `Scenario constraint check failed (${scenViolationCount} violations).`
        );
      }
    } catch (err) {
      evalEntry.notes.push(`Re-solve failed: ${err?.message || 'unknown error'}`);
    }

    evalEntry.rank_score = computeRankScore(evalEntry, {
      service_level_proxy: toNumber(
        baseReplayMetrics?.with_plan?.service_level_proxy
      ),
      estimated_total_cost: toNumber(baseKpis?.estimated_total_cost)
    });

    evaluatedOptions.push(evalEntry);
  }

  // Deterministic sort: rank_score ascending (lower = better)
  // Break ties by option_id lexicographic order
  const ranked = [...evaluatedOptions].sort((a, b) => {
    const diff = a.rank_score - b.rank_score;
    if (Math.abs(diff) > 1e-9) return diff;
    return String(a.option_id).localeCompare(String(b.option_id));
  });

  return {
    base_run_id: baseRunId,
    ranked_options: ranked,
    ranking_method: RANKING_METHOD
  };
}

export default { evaluateNegotiationOptions };
