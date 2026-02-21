/**
 * Negotiation Options Generator - Step 9 Agentic Negotiation Loop v0
 *
 * Pure, deterministic function: same inputs always produce the same option set
 * in the same order. LLM must NOT generate numbers; only this module computes
 * candidate relaxations.
 *
 * Trigger conditions:
 *   1. solver_meta.status === 'INFEASIBLE'  => trigger 'infeasible'
 *   2. service_level < service_target - margin => trigger 'kpi_shortfall'
 *   3. stockout_units > threshold             => trigger 'kpi_shortfall'
 *
 * Candidate option ordering (fixed, deterministic):
 *   opt_001 – Increase budget cap +10% (if budget binding)
 *   opt_002 – Relax MOQ enforcement (if MOQ binding)
 *   opt_003 – Allow pack size rounding (if pack_size binding)
 *   opt_004 – Enable expedite mode (if lead-time risk high)
 *   opt_005 – Increase safety stock buffer (if service shortfall)
 *   opt_006 – Reduce service target by 5% (if target ambitious & shortfall)
 */

export const DEFAULT_NEGOTIATION_CONFIG = {
  /** Margin below service_target that triggers kpi_shortfall */
  service_target_margin: 0.05,
  /** Stockout units threshold; 0 means any stockout triggers */
  stockout_units_threshold: 0,
  /** Fractional budget increase for opt_001 */
  budget_increase_factor: 0.10,
  /** MOQ relaxation factor for opt_002 */
  moq_relaxation_factor: 0.80,
  /** Safety stock multiplier for opt_005 */
  safety_stock_multiplier: 1.20,
  /** Service target reduction factor for opt_006 */
  service_target_reduction_factor: 0.05,
  /** Max options to include in the output */
  max_options: 6
};

// ---------------------------------------------------------------------------
// Internal helpers (pure, no I/O)
// ---------------------------------------------------------------------------

const hasViolationOfRule = (violations, ruleSubstring) =>
  Array.isArray(violations) &&
  violations.some((v) =>
    String(v?.rule || '').toLowerCase().includes(ruleSubstring.toLowerCase())
  );

const mentionsKeyword = (reasons, keyword) =>
  Array.isArray(reasons) &&
  reasons.some((r) =>
    String(r || '').toLowerCase().includes(keyword.toLowerCase())
  );

const isFinitePositive = (v) =>
  typeof v === 'number' && Number.isFinite(v) && v > 0;

const roundTo = (value, decimals) => Number(Number(value).toFixed(decimals));

// ---------------------------------------------------------------------------
// Exported: detectTrigger
// ---------------------------------------------------------------------------

/**
 * Determine whether negotiation should be triggered, and why.
 *
 * @param {Object} solverMeta    - solver_meta artifact payload
 * @param {Object} replayMetrics - replay_metrics artifact payload
 * @param {Object} userIntent    - { service_target?, budget_cap? }
 * @param {Object} config        - optional threshold overrides
 * @returns {'infeasible'|'kpi_shortfall'|null}
 */
export function detectTrigger(
  solverMeta = {},
  replayMetrics = {},
  userIntent = {},
  config = {}
) {
  const cfg = { ...DEFAULT_NEGOTIATION_CONFIG, ...config };

  // Trigger 1: Solver declared infeasible
  const status = String(solverMeta?.status || '').toLowerCase();
  if (status === 'infeasible') return 'infeasible';

  // Trigger 2: Service level below target minus margin
  const serviceLevel = Number(replayMetrics?.with_plan?.service_level_proxy);
  const serviceTarget = Number(userIntent?.service_target);
  const margin = Number(cfg.service_target_margin);

  if (
    Number.isFinite(serviceLevel) &&
    Number.isFinite(serviceTarget) &&
    serviceTarget > 0 &&
    serviceLevel < serviceTarget - margin
  ) {
    return 'kpi_shortfall';
  }

  // Trigger 3: Stockout units above threshold
  const stockoutUnits = Number(replayMetrics?.with_plan?.stockout_units);
  const stockoutThreshold = Number(cfg.stockout_units_threshold);

  if (Number.isFinite(stockoutUnits) && stockoutUnits > stockoutThreshold) {
    return 'kpi_shortfall';
  }

  return null;
}

// ---------------------------------------------------------------------------
// Exported: generateNegotiationOptions
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic ordered set of candidate negotiation options.
 *
 * @param {Object} params
 * @param {Object}        params.solverMeta      - solver_meta payload
 * @param {Object}        params.constraintCheck - constraint_check payload
 * @param {Object}        params.replayMetrics   - replay_metrics payload
 * @param {Object}        params.userIntent      - { service_target?, budget_cap? }
 * @param {string|number} params.baseRunId       - plan child run ID
 * @param {Object}        params.baseConstraints - optional: original constraints
 *                                                 { moq:[{sku,min_qty}], pack_size:[...], ... }
 *                                                 If provided, concrete MOQ/pack overrides are built.
 * @param {Object}        params.config          - threshold overrides
 * @returns {Object|null} negotiation_options payload, or null if no trigger
 */
export function generateNegotiationOptions({
  solverMeta = {},
  constraintCheck = {},
  replayMetrics = {},
  userIntent = {},
  baseRunId,
  baseConstraints = null,
  config = {}
}) {
  const cfg = { ...DEFAULT_NEGOTIATION_CONFIG, ...config };

  const trigger = detectTrigger(solverMeta, replayMetrics, userIntent, cfg);
  if (!trigger) return null;

  const violations = Array.isArray(constraintCheck?.violations)
    ? constraintCheck.violations
    : [];
  const infeasibleReasons = Array.isArray(solverMeta?.infeasible_reasons)
    ? solverMeta.infeasible_reasons
    : [];
  const constraintsChecked = Array.isArray(solverMeta?.proof?.constraints_checked)
    ? solverMeta.proof.constraints_checked
    : [];

  const serviceLevel = Number(replayMetrics?.with_plan?.service_level_proxy);
  const stockoutUnits = Number(replayMetrics?.with_plan?.stockout_units);
  const budgetCap = userIntent?.budget_cap;
  const serviceTarget = userIntent?.service_target;

  const options = [];

  // -----------------------------------------------------------------------
  // opt_001: Increase budget cap by +10%
  // Include when: budget constraint is binding or caused infeasibility AND
  //               user has a defined budget_cap
  // -----------------------------------------------------------------------
  const budgetBinding =
    hasViolationOfRule(violations, 'budget_cap') ||
    mentionsKeyword(infeasibleReasons, 'budget') ||
    constraintsChecked.some(
      (c) =>
        String(c?.name || '').toLowerCase().includes('budget') &&
        c?.binding === true
    );

  if (budgetBinding && isFinitePositive(Number(budgetCap))) {
    const newBudget = roundTo(
      Number(budgetCap) * (1 + cfg.budget_increase_factor),
      4
    );
    options.push({
      option_id: 'opt_001',
      title: `Increase budget cap by ${Math.round(cfg.budget_increase_factor * 100)}%`,
      overrides: {
        constraints: { budget_cap: newBudget }
      },
      engine_flags: {},
      why: [
        'Budget constraint was identified as binding in the base run.',
        'Relaxing budget cap gives the solver more purchasing flexibility.'
      ],
      evidence_refs: [
        'constraint_check.violations[rule=budget_cap]',
        'solver_meta.infeasible_reasons',
        'solver_meta.proof.constraints_checked'
      ]
    });
  }

  // -----------------------------------------------------------------------
  // opt_002: Relax MOQ enforcement (factor 0.8 → soft MOQ)
  // Include when: MOQ caused violations or infeasibility
  // -----------------------------------------------------------------------
  const moqBinding =
    hasViolationOfRule(violations, 'moq') ||
    mentionsKeyword(infeasibleReasons, 'moq') ||
    mentionsKeyword(infeasibleReasons, 'minimum order') ||
    constraintsChecked.some(
      (c) =>
        String(c?.name || '').toLowerCase().includes('moq') &&
        c?.binding === true
    );

  if (moqBinding) {
    // If caller provided original MOQ rows, build concrete relaxed override
    const baseMoqRows = Array.isArray(baseConstraints?.moq)
      ? baseConstraints.moq
      : null;

    const moqConstraintOverride = baseMoqRows
      ? {
          moq: baseMoqRows
            .map((row) => ({
              sku: row.sku,
              min_qty: roundTo(
                Math.max(0, Number(row.min_qty) * cfg.moq_relaxation_factor),
                4
              )
            }))
            .filter((row) => row.sku)
        }
      : {};

    options.push({
      option_id: 'opt_002',
      title: `Relax MOQ enforcement (factor ${cfg.moq_relaxation_factor})`,
      overrides: {
        constraints: moqConstraintOverride
      },
      engine_flags: {
        soft_moq: true,
        moq_relaxation_factor: cfg.moq_relaxation_factor
      },
      why: [
        'MOQ constraints were binding or caused infeasibility in the base run.',
        'Applying a soft-MOQ relaxation factor allows partial compliance.'
      ],
      evidence_refs: [
        'constraint_check.violations[rule=moq]',
        'solver_meta.infeasible_reasons',
        'solver_meta.proof.constraints_checked'
      ]
    });
  }

  // -----------------------------------------------------------------------
  // opt_003: Allow pack size rounding
  // Include when: pack_size constraints caused violations
  // -----------------------------------------------------------------------
  const packBinding =
    hasViolationOfRule(violations, 'pack_size') ||
    mentionsKeyword(infeasibleReasons, 'pack') ||
    constraintsChecked.some(
      (c) =>
        String(c?.name || '').toLowerCase().includes('pack') &&
        c?.binding === true
    );

  if (packBinding) {
    options.push({
      option_id: 'opt_003',
      title: 'Allow pack size rounding (nearest multiple)',
      overrides: {},
      engine_flags: {
        allow_pack_rounding: true
      },
      why: [
        'Pack size constraints caused violations in the base run.',
        'Allowing rounding to nearest pack multiple reduces constraint failures.'
      ],
      evidence_refs: [
        'constraint_check.violations[rule=pack_size_multiple]',
        'solver_meta.infeasible_reasons'
      ]
    });
  }

  // -----------------------------------------------------------------------
  // opt_004: Enable expedite mode (reduce lead time by 1 period)
  // Include when: lead-time risk is high (service shortfall or stockout events)
  // -----------------------------------------------------------------------
  const leadTimeRiskHigh =
    mentionsKeyword(infeasibleReasons, 'lead_time') ||
    mentionsKeyword(infeasibleReasons, 'lead time') ||
    (Number.isFinite(serviceLevel) &&
      Number.isFinite(serviceTarget) &&
      serviceLevel < serviceTarget - 0.10) ||
    (Number.isFinite(stockoutUnits) &&
      stockoutUnits > 0 &&
      trigger === 'kpi_shortfall');

  if (leadTimeRiskHigh) {
    options.push({
      option_id: 'opt_004',
      title: 'Enable expedite mode for bottleneck SKUs (-1 period lead time)',
      overrides: {},
      engine_flags: {
        expedite_mode: true,
        expedite_lead_time_reduction_periods: 1
      },
      why: [
        'Service level shortfall or stockout risk detected in the base run.',
        'Expediting top bottleneck SKUs reduces effective lead time.'
      ],
      evidence_refs: [
        'replay_metrics.with_plan.service_level_proxy',
        'replay_metrics.with_plan.stockout_units',
        'solver_meta.infeasible_reasons'
      ]
    });
  }

  // -----------------------------------------------------------------------
  // opt_005: Increase safety stock buffer (multiplier 1.2x)
  // Include when: service is below acceptable or stockouts present
  // -----------------------------------------------------------------------
  const serviceBelowAcceptable =
    (Number.isFinite(serviceLevel) && serviceLevel < 0.90) ||
    (Number.isFinite(stockoutUnits) && stockoutUnits > 0);

  if (serviceBelowAcceptable || trigger === 'kpi_shortfall') {
    options.push({
      option_id: 'opt_005',
      title: `Increase safety stock buffer (${cfg.safety_stock_multiplier}x multiplier)`,
      overrides: {
        plan: {
          safety_stock_multiplier: cfg.safety_stock_multiplier
        }
      },
      engine_flags: {
        safety_stock_multiplier: cfg.safety_stock_multiplier
      },
      why: [
        'Service level below acceptable threshold in the base run.',
        'Increasing safety stock reduces stockout probability.'
      ],
      evidence_refs: [
        'replay_metrics.with_plan.service_level_proxy',
        'replay_metrics.with_plan.stockout_units',
        'solver_meta.kpis'
      ]
    });
  }

  // -----------------------------------------------------------------------
  // opt_006: Reduce service level target by 5%
  // Include when: target is ambitious (> 0.90), shortfall exists, other
  //               options already present (indicates constraints are real)
  // -----------------------------------------------------------------------
  const manyOptionsPresent = options.length >= 2;
  const serviceTargetAmbitious =
    Number.isFinite(Number(serviceTarget)) &&
    Number(serviceTarget) > 0.90 &&
    trigger === 'kpi_shortfall';

  if (manyOptionsPresent && serviceTargetAmbitious) {
    const reducedTarget = roundTo(
      Number(serviceTarget) * (1 - cfg.service_target_reduction_factor),
      4
    );
    options.push({
      option_id: 'opt_006',
      title: `Reduce service level target by ${Math.round(cfg.service_target_reduction_factor * 100)}%`,
      overrides: {
        objective: { service_level_target: reducedTarget }
      },
      engine_flags: {},
      why: [
        'Service target may be overly ambitious given current supply constraints.',
        'Slightly reducing target allows a more balanced cost/service trade-off.'
      ],
      evidence_refs: [
        'replay_metrics.with_plan.service_level_proxy',
        'solver_meta.kpis.estimated_total_cost'
      ]
    });
  }

  // Limit to max_options (ordering is already deterministic)
  const finalOptions = options.slice(0, cfg.max_options);
  if (finalOptions.length === 0) return null;

  return {
    version: 'v0',
    generated_at: new Date().toISOString(),
    base_run_id: baseRunId,
    trigger,
    intent: {
      service_target: userIntent?.service_target ?? null,
      budget_cap: userIntent?.budget_cap ?? null
    },
    options: finalOptions
  };
}

export default {
  generateNegotiationOptions,
  detectTrigger,
  DEFAULT_NEGOTIATION_CONFIG
};
