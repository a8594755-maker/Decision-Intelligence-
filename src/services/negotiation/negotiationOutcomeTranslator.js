/**
 * Negotiation Outcome Translator
 *
 * Pure function: resolved negotiation case → planning constraint patches.
 *
 * Maps negotiation outcomes (agreed terms, applied options) into concrete
 * parameter overrides that the planning solver can consume. This is the
 * bridge between the negotiation subsystem and the closed-loop re-planning
 * pipeline.
 *
 * Pattern: mirrors forecastToPlanParams.js (deterministic, pure, same inputs → same output)
 */

// ── Option-to-patch mapping ─────────────────────────────────────────────────

/**
 * Known negotiation option IDs and their planning constraint translations.
 */
const OPTION_PATCH_MAP = {
  // opt_001: Increase budget cap by 10%
  opt_001: (outcome) => {
    const budgetCap = outcome?.agreed_terms?.budget_cap
      ?? outcome?.overrides?.constraints?.budget_cap;
    if (budgetCap != null && Number.isFinite(Number(budgetCap))) {
      return {
        patch: { constraints: { budget_cap: Number(budgetCap) } },
        explanation: `Budget cap adjusted to ${Number(budgetCap).toLocaleString()} per negotiation agreement.`,
        rule_id: 'NEG-R1_budget_adjustment',
      };
    }
    return null;
  },

  // opt_002: Relax MOQ enforcement
  opt_002: (outcome) => {
    const factor = outcome?.agreed_terms?.moq_relaxation_factor
      ?? outcome?.engine_flags?.moq_relaxation_factor
      ?? 0.80;
    return {
      patch: {
        engine_flags: { soft_moq: true, moq_relaxation_factor: Number(factor) },
      },
      explanation: `MOQ relaxed to factor ${factor} per negotiation agreement.`,
      rule_id: 'NEG-R2_moq_relaxation',
    };
  },

  // opt_003: Allow pack size rounding
  opt_003: () => ({
    patch: {
      engine_flags: { allow_pack_rounding: true },
    },
    explanation: 'Pack size rounding enabled per negotiation agreement.',
    rule_id: 'NEG-R3_pack_rounding',
  }),

  // opt_004: Enable expedite mode
  opt_004: (outcome) => {
    const reduction = outcome?.agreed_terms?.lead_time_reduction_periods
      ?? outcome?.engine_flags?.expedite_lead_time_reduction_periods
      ?? 1;
    return {
      patch: {
        engine_flags: {
          expedite_mode: true,
          expedite_lead_time_reduction_periods: Number(reduction),
        },
      },
      explanation: `Expedite mode enabled (lead time reduced by ${reduction} period(s)) per negotiation.`,
      rule_id: 'NEG-R4_expedite_mode',
    };
  },

  // opt_005: Increase safety stock buffer
  opt_005: (outcome) => {
    const multiplier = outcome?.agreed_terms?.safety_stock_multiplier
      ?? outcome?.engine_flags?.safety_stock_multiplier
      ?? 1.2;
    return {
      patch: {
        plan: { safety_stock_multiplier: Number(multiplier) },
        engine_flags: { safety_stock_multiplier: Number(multiplier) },
      },
      explanation: `Safety stock multiplier set to ${multiplier}x per negotiation agreement.`,
      rule_id: 'NEG-R5_safety_stock',
    };
  },

  // opt_006: Supplier-agreed price reduction
  opt_006: (outcome) => {
    const discount = outcome?.agreed_terms?.unit_cost_adjustment
      ?? outcome?.agreed_terms?.discount_pct;
    if (discount != null && Number.isFinite(Number(discount))) {
      return {
        patch: {
          objective: { unit_cost_adjustment: Number(discount) },
        },
        explanation: `Unit cost adjusted by ${(Number(discount) * 100).toFixed(1)}% per supplier agreement.`,
        rule_id: 'NEG-R6_price_adjustment',
      };
    }
    return null;
  },
};

// ── Core translation ────────────────────────────────────────────────────────

/**
 * Derive planning constraint patches from a resolved negotiation case.
 *
 * @param {Object} resolvedCase - The resolved negotiation case
 * @param {string}   resolvedCase.status          - 'resolved_agreement' | 'resolved_walkaway'
 * @param {Object}   [resolvedCase.outcome]       - Agreed terms (price, lead_time, etc.)
 * @param {string}   [resolvedCase.applied_option_id] - Which negotiation option was applied
 * @param {Object}   [resolvedCase.option_overrides]  - The option's overrides snapshot
 * @param {Object}   [resolvedCase.option_engine_flags] - The option's engine_flags
 * @param {Object[]} [resolvedCase.events]        - Action history events
 * @param {string}   resolvedCase.trigger         - Original trigger ('infeasible' | 'kpi_shortfall')
 *
 * @returns {{
 *   patches: Object,
 *   explanations: string[],
 *   rules: Object[],
 *   should_replan: boolean,
 *   replan_reason: string
 * }}
 */
export function deriveConstraintPatch(resolvedCase) {
  const {
    status,
    outcome = {},
    applied_option_id,
    option_overrides,
    option_engine_flags,
    trigger,
  } = resolvedCase || {};

  const explanations = [];
  const rules = [];
  const mergedPatch = {
    constraints: {},
    objective: {},
    plan: {},
    engine_flags: {},
  };

  // Walk-away: no constraint changes, but may trigger alternative sourcing
  if (status === 'resolved_walkaway') {
    return {
      patches: mergedPatch,
      explanations: ['Negotiation ended with walk-away. No constraint patches applied.'],
      rules: [{
        rule_id: 'NEG-R0_walkaway',
        description: 'Walk-away resolution: no planning parameter changes.',
        evidence_refs: [`status=${status}`, `trigger=${trigger}`],
        params_delta: {},
      }],
      should_replan: false,
      replan_reason: 'walkaway',
    };
  }

  // Not a resolution → no patches
  if (status !== 'resolved_agreement') {
    return {
      patches: mergedPatch,
      explanations: [`Case status "${status}" is not a resolution. No patches applied.`],
      rules: [],
      should_replan: false,
      replan_reason: 'not_resolved',
    };
  }

  // ── Apply option-specific patches ──────────────────────────────────────────

  if (applied_option_id && OPTION_PATCH_MAP[applied_option_id]) {
    const patchFn = OPTION_PATCH_MAP[applied_option_id];
    const result = patchFn({
      agreed_terms: outcome,
      overrides: option_overrides,
      engine_flags: option_engine_flags,
    });

    if (result) {
      deepMerge(mergedPatch, result.patch);
      explanations.push(result.explanation);
      rules.push({
        rule_id: result.rule_id,
        description: result.explanation,
        evidence_refs: [
          `applied_option=${applied_option_id}`,
          `trigger=${trigger}`,
        ],
        params_delta: result.patch,
      });
    }
  }

  // ── Apply direct outcome terms (override option defaults) ──────────────────

  if (outcome.budget_cap != null && Number.isFinite(Number(outcome.budget_cap))) {
    mergedPatch.constraints.budget_cap = Number(outcome.budget_cap);
    explanations.push(`Direct budget cap from outcome: ${outcome.budget_cap}`);
  }

  if (outcome.lead_time_days != null && Number.isFinite(Number(outcome.lead_time_days))) {
    mergedPatch.engine_flags.negotiated_lead_time_days = Number(outcome.lead_time_days);
    explanations.push(`Negotiated lead time: ${outcome.lead_time_days} days`);
  }

  if (outcome.unit_price != null && Number.isFinite(Number(outcome.unit_price))) {
    mergedPatch.objective.negotiated_unit_price = Number(outcome.unit_price);
    explanations.push(`Negotiated unit price: ${outcome.unit_price}`);
  }

  return {
    patches: mergedPatch,
    explanations,
    rules,
    should_replan: explanations.length > 0,
    replan_reason: explanations.length > 0 ? 'negotiation_agreement' : 'no_changes',
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Deep merge source into target (mutates target). Simple 1-level deep merge.
 */
function deepMerge(target, source) {
  if (!source || typeof source !== 'object') return;
  for (const [key, val] of Object.entries(source)) {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      if (!target[key] || typeof target[key] !== 'object') {
        target[key] = {};
      }
      Object.assign(target[key], val);
    } else {
      target[key] = val;
    }
  }
}
