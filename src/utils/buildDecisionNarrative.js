/**
 * buildDecisionNarrative.js
 *
 * Pure function: from solver proof + replay metrics, build a structured decision narrative.
 *
 * Design principles:
 *   1. Pure function, no side effects, deterministic output
 *   2. All numbers MUST come from inputs (no fabrication)
 *   3. Output serves two purposes:
 *      a. Direct display in Chat (DecisionNarrativeCard.jsx)
 *      b. Precise context for LLM (buildDecisionIntelligenceReportPrompt)
 *
 * Sections:
 *   situation     - Current state description (shortage risk, plan status)
 *   driver        - Primary driving factor (which constraint is most impactful)
 *   recommendation - Recommended action (evidence-based)
 *   trade_offs[]  - Alternative options with cost/service delta
 *   constraint_binding_summary[] - Each constraint's binding status + marginal impact evidence
 *   evidence_refs[] - Provenance reference for every claim
 */

export const NARRATIVE_VERSION = 'v1';

const SL_THRESHOLDS = {
  EXCELLENT: 0.98,
  GOOD: 0.95,
  ACCEPTABLE: 0.90,
  POOR: 0.80
};

const CONSTRAINT_PRIORITY = {
  budget_cap: 5,
  moq: 4,
  capacity: 4,
  storage_capacity: 3,
  pack_size_multiple: 2,
  max_order_qty: 2,
  order_qty_non_negative: 1
};

const safeNum = (v, fallback = null) => {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const pct = (v) => (v != null ? `${(v * 100).toFixed(1)}%` : '-');
const money = (v) => (v != null
  ? `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
  : '-');
const units = (v) => (v != null
  ? Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })
  : '-');

function classifyServiceLevel(sl) {
  if (sl == null) return 'unknown';
  if (sl >= SL_THRESHOLDS.EXCELLENT) return 'excellent';
  if (sl >= SL_THRESHOLDS.GOOD) return 'good';
  if (sl >= SL_THRESHOLDS.ACCEPTABLE) return 'acceptable';
  if (sl >= SL_THRESHOLDS.POOR) return 'poor';
  return 'critical';
}

/**
 * Build a replay-based fallback marginal impact for a binding constraint.
 * Solver-provided LP dual shadow prices (if present) take precedence elsewhere.
 */
function estimateMarginalImpact({
  constraintName,
  solverKpis = {},
  replayMetrics = {}
}) {
  const withPlan = replayMetrics?.with_plan || {};
  const withoutPlan = replayMetrics?.without_plan || {};

  const slWith = safeNum(withPlan.service_level_proxy);
  const slWithout = safeNum(withoutPlan.service_level_proxy, 0);
  const slDelta = slWith != null ? slWith - slWithout : null;
  const stockoutWith = safeNum(withPlan.stockout_units);
  const totalCost = safeNum(solverKpis?.estimated_total_cost);

  if (constraintName === 'budget_cap' && totalCost != null && slDelta != null) {
    const slImprovementPer1Pct = slDelta > 0 ? slDelta * 0.05 : 0.005;
    return {
      metric: 'service_level_proxy',
      direction: 'up',
      approximate: true,
      description: `Relaxing budget by 10% may improve service level by ~${pct(slImprovementPer1Pct * 10)}`,
      per_unit_cost: totalCost * 0.01,
      evidence_basis: 'kpi_delta_estimate'
    };
  }

  if (constraintName === 'moq' && stockoutWith != null) {
    return {
      metric: 'stockout_units',
      direction: 'down',
      approximate: true,
      description: `Relaxing MOQ may reduce stockout exposure (current: ${units(stockoutWith)} units)`,
      evidence_basis: 'replay_metrics.stockout_units'
    };
  }

  if (constraintName.includes('capacity') && slWith != null) {
    return {
      metric: 'service_level_proxy',
      direction: 'up',
      approximate: true,
      description: `Increasing capacity allocation may improve service from ${pct(slWith)}`,
      evidence_basis: 'replay_metrics.service_level_proxy'
    };
  }

  return null;
}

function buildConstraintBindingSummary({
  constraintsChecked = [],
  solverKpis = {},
  replayMetrics = {}
}) {
  return constraintsChecked
    .map((constraint) => {
      const isBinding = constraint.binding === true || constraint.passed === false;
      const marginalImpact = isBinding
        ? estimateMarginalImpact({
            constraintName: constraint.name,
            solverKpis,
            replayMetrics
          })
        : null;

      return {
        name: constraint.name,
        passed: constraint.passed ?? true,
        binding: isBinding,
        violations: constraint.violations ?? 0,
        details: constraint.details || '',
        slack: safeNum(constraint.slack),
        slack_unit: constraint.slack_unit || null,
        shadow_price_dual: safeNum(constraint.shadow_price_dual),
        shadow_price_approx: safeNum(constraint.shadow_price_approx),
        shadow_price_unit: constraint.shadow_price_unit || null,
        shadow_price_method: constraint.shadow_price_method || null,
        natural_language: constraint.natural_language || null,
        marginal_impact: marginalImpact,
        priority: CONSTRAINT_PRIORITY[constraint.name] ?? 0,
        evidence_ref: `proof.constraints_checked[name=${constraint.name}]`
      };
    })
    .sort((a, b) => b.priority - a.priority);
}

function buildSituation({ solverStatus, solverKpis, replayMetrics, riskAdjustments }) {
  const withPlan = replayMetrics?.with_plan || {};
  const withoutPlan = replayMetrics?.without_plan || {};

  const sl = safeNum(withPlan.service_level_proxy);
  const slNoPlan = safeNum(withoutPlan.service_level_proxy);
  const stockout = safeNum(withPlan.stockout_units);
  const cost = safeNum(solverKpis?.estimated_total_cost);

  const slClass = classifyServiceLevel(sl);
  const isRiskMode = riskAdjustments?.triggered === true;

  const parts = [];
  const evidenceRefs = [];

  if (solverStatus === 'INFEASIBLE') {
    parts.push('The solver could not find a feasible plan under current constraints.');
    evidenceRefs.push('solver_meta.status=INFEASIBLE');
  } else if (solverStatus === 'TIMEOUT') {
    parts.push('The solver reached its time limit; the plan shown is the best feasible solution found.');
    evidenceRefs.push('solver_meta.status=TIMEOUT');
  } else {
    if (sl != null) {
      parts.push(`The plan achieves a projected service level of ${pct(sl)} (${slClass}).`);
      evidenceRefs.push('replay_metrics.with_plan.service_level_proxy');
    }
    if (slNoPlan != null && sl != null) {
      const delta = sl - slNoPlan;
      const sign = delta >= 0 ? '+' : '';
      parts.push(`This is ${sign}${pct(delta)} vs. the no-plan baseline.`);
      evidenceRefs.push('replay_metrics.delta.service_level_proxy');
    }
    if (stockout != null && stockout > 0) {
      parts.push(`Projected stockout exposure: ${units(stockout)} units remain unfilled.`);
      evidenceRefs.push('replay_metrics.with_plan.stockout_units');
    }
    if (cost != null) {
      parts.push(`Estimated total procurement and holding cost: ${money(cost)}.`);
      evidenceRefs.push('solver_meta.kpis.estimated_total_cost');
    }
    if (isRiskMode) {
      parts.push('Risk-aware mode is active: safety stock and lead-time buffers are elevated based on supplier risk scores.');
      evidenceRefs.push('risk_adjustments.triggered');
    }
  }

  return {
    text: parts.join(' '),
    service_level: sl,
    service_level_class: slClass,
    stockout_units: stockout,
    total_cost: cost,
    evidence_refs: evidenceRefs
  };
}

const formatSlack = (slack, slackUnit) => {
  if (slack == null) return '-';
  const formatted = Number(slack).toLocaleString(undefined, { maximumFractionDigits: 1 });
  return slackUnit ? `${formatted} ${slackUnit}` : formatted;
};

function buildDriver({
  bindingConstraints = [],
  objectiveTerms = [],
  infeasibleReasons = [],
  infeasibleReasonDetails = [],
  solverStatus
}) {
  const evidenceRefs = [];
  let text = '';

  if (solverStatus === 'INFEASIBLE') {
    const topDetail = infeasibleReasonDetails[0] || null;
    const topReason = infeasibleReasons[0] || 'Unknown infeasibility cause';

    if (topDetail) {
      const actions = (topDetail.suggested_actions || []).slice(0, 1).join(' ');
      text = `Infeasibility root cause: ${topDetail.category} constraints.`
        + (topDetail.top_offending_tags?.length > 0
          ? ` Top offending tags: ${topDetail.top_offending_tags.slice(0, 3).join(', ')}.`
          : '')
        + (actions ? ` Suggested: ${actions}` : '');
      evidenceRefs.push('solver_meta.infeasible_reason_details[0]');
    } else {
      text = `Infeasibility reason: ${topReason}`;
      evidenceRefs.push('solver_meta.infeasible_reasons[0]');
    }

    return { text, category: 'infeasibility', evidence_refs: evidenceRefs };
  }

  const topBinding = bindingConstraints[0];
  if (topBinding) {
    const nl = topBinding.natural_language;
    const slack = safeNum(topBinding.slack);
    const spDual = safeNum(topBinding.shadow_price_dual);
    const spApprox = safeNum(topBinding.shadow_price_approx);
    const sp = spDual ?? spApprox;
    const slackUnit = topBinding.slack_unit || '';

    // Prefer solver-provided natural_language, fall back to template
    text = nl || `The primary binding constraint is "${topBinding.name}".`;
    evidenceRefs.push(topBinding.evidence_ref);

    // Append slack and shadow price details when available
    if (sp != null && slack != null) {
      text += ` (remaining slack: ${formatSlack(slack, slackUnit)}, marginal value: ${money(sp)}/unit relaxed)`;
      evidenceRefs.push(
        spDual != null
          ? `proof.constraints_checked[name=${topBinding.name}].shadow_price_dual`
          : `proof.constraints_checked[name=${topBinding.name}].shadow_price_approx`
      );
    } else if (slack != null) {
      text += ` (remaining slack: ${formatSlack(slack, slackUnit)})`;
    }

    // Fall back to marginal_impact description if no solver-level shadow price
    if (sp == null && topBinding.marginal_impact?.description) {
      text += ` ${topBinding.marginal_impact.description}.`;
      evidenceRefs.push(`marginal_impact.${topBinding.name}`);
    }

    return {
      text,
      category: 'binding_constraint',
      binding_constraint: topBinding.name,
      slack,
      shadow_price: sp,
      evidence_refs: evidenceRefs
    };
  }

  const topObjective = objectiveTerms
    .filter((term) => safeNum(term.value) != null && safeNum(term.value) > 0)
    .sort((a, b) => (safeNum(b.value) || 0) - (safeNum(a.value) || 0))[0];

  if (topObjective) {
    const label = topObjective.business_label || topObjective.name;
    text = `The plan is unconstrained. The dominant cost driver is "${label}" at ${money(safeNum(topObjective.value))}.`;
    evidenceRefs.push(`proof.objective_terms[name=${topObjective.name}]`);
    return { text, category: 'cost_driver', evidence_refs: evidenceRefs };
  }

  return {
    text: 'No significant binding constraints detected. The plan is at or near the optimal solution.',
    category: 'optimal',
    evidence_refs: ['solver_meta.status']
  };
}

function buildRecommendation({
  solverStatus,
  bindingConstraints = [],
  negotiationOptions = null,
  replayMetrics = {}
}) {
  const withPlan = replayMetrics?.with_plan || {};
  const sl = safeNum(withPlan.service_level_proxy);
  const evidenceRefs = [];

  if (solverStatus === 'INFEASIBLE') {
    const topOption = negotiationOptions?.options?.[0];
    if (topOption) {
      evidenceRefs.push(`negotiation_options.options[0].option_id=${topOption.option_id}`);
      return {
        text: `Recommended action: ${topOption.title}. ${(topOption.why || []).join(' ')}`,
        action_type: 'relax_constraint',
        action_id: topOption.option_id,
        evidence_refs: evidenceRefs
      };
    }
    return {
      text: 'No feasible plan found. Review and relax one or more constraints (budget, MOQ, capacity) to find a solution.',
      action_type: 'relax_constraint',
      evidence_refs: ['solver_meta.status=INFEASIBLE']
    };
  }

  if (sl != null && sl < SL_THRESHOLDS.ACCEPTABLE) {
    const topOption = negotiationOptions?.options?.find(
      (option) => option.option_id === 'opt_004' || option.option_id === 'opt_005'
    );
    evidenceRefs.push('replay_metrics.with_plan.service_level_proxy');

    if (topOption) {
      evidenceRefs.push(`negotiation_options.options[option_id=${topOption.option_id}]`);
      return {
        text: `Service level ${pct(sl)} is below target. Recommended: ${topOption.title}.`,
        action_type: 'improve_service_level',
        action_id: topOption.option_id,
        evidence_refs: evidenceRefs
      };
    }

    return {
      text: `Service level ${pct(sl)} is below the acceptable threshold (${pct(SL_THRESHOLDS.ACCEPTABLE)}). Consider increasing safety stock or enabling expedite mode.`,
      action_type: 'improve_service_level',
      evidence_refs: evidenceRefs
    };
  }

  const topBinding = bindingConstraints[0];
  if (topBinding?.marginal_impact) {
    evidenceRefs.push(topBinding.evidence_ref);
    return {
      text: `Plan is ${classifyServiceLevel(sl)}. ${topBinding.marginal_impact.description}. Review and approve if this trade-off is acceptable.`,
      action_type: 'approve_plan',
      evidence_refs: evidenceRefs
    };
  }

  return {
    text: `Plan is at service level ${pct(sl)}. Review the plan details and approve to commit the procurement orders.`,
    action_type: 'approve_plan',
    evidence_refs: ['replay_metrics.with_plan.service_level_proxy']
  };
}

function buildTradeOffs({ negotiationOptions = null, explainSummary = null }) {
  const result = [];

  // Insert key relaxation from explain_summary as the first trade-off if available
  const relaxation = explainSummary?.key_relaxation;
  if (relaxation?.nl_text) {
    const relaxBy = safeNum(relaxation.relax_by);
    const estimatedSaving = safeNum(relaxation.estimated_saving);
    const roi = (relaxBy && estimatedSaving && relaxBy > 0)
      ? `${(estimatedSaving / relaxBy).toFixed(1)}x`
      : null;

    result.push({
      option_id: `relax_${relaxation.constraint}`,
      title: `Relax ${relaxation.constraint}`,
      constraint: relaxation.constraint,
      overrides: {},
      why: relaxation.nl_text,
      cost: relaxBy != null ? `${money(relaxBy)} ${relaxation.relax_unit || ''}`.trim() : null,
      benefit: estimatedSaving != null ? `${money(estimatedSaving)} ${relaxation.saving_unit || ''}`.trim() : null,
      roi_text: roi,
      nl_text: relaxation.nl_text,
      estimated_sl_delta: null,
      estimated_cost_delta: estimatedSaving != null ? -estimatedSaving : null,
      evidence_refs: ['explain_summary.key_relaxation']
    });
  }

  // Append negotiation options (up to 4 total)
  const options = negotiationOptions?.options || [];
  const remaining = 4 - result.length;
  for (const option of options.slice(0, remaining)) {
    result.push({
      option_id: option.option_id,
      title: option.title,
      overrides: option.overrides || {},
      why: (option.why || []).join(' '),
      estimated_sl_delta: null,
      estimated_cost_delta: null,
      evidence_refs: option.evidence_refs || []
    });
  }

  return result;
}

export function buildDecisionNarrative({
  solverStatus = 'FEASIBLE',
  solverKpis = {},
  proof = {},
  infeasibleReasons = [],
  infeasibleReasonDetails = [],
  replayMetrics = {},
  riskAdjustments = null,
  negotiationOptions = null,
  explainSummary = null,
  runId = null,
  generatedAt = null
} = {}) {
  const constraintsChecked = Array.isArray(proof?.constraints_checked) ? proof.constraints_checked : [];
  const objectiveTerms = Array.isArray(proof?.objective_terms) ? proof.objective_terms : [];

  const constraintBindingSummary = buildConstraintBindingSummary({
    constraintsChecked,
    solverKpis,
    replayMetrics
  });
  const bindingConstraints = constraintBindingSummary.filter((constraint) => constraint.binding);

  const situation = buildSituation({
    solverStatus,
    solverKpis,
    replayMetrics,
    riskAdjustments
  });

  const driver = buildDriver({
    bindingConstraints,
    objectiveTerms,
    infeasibleReasons,
    infeasibleReasonDetails,
    solverStatus
  });

  const recommendation = buildRecommendation({
    solverStatus,
    bindingConstraints,
    negotiationOptions,
    replayMetrics
  });

  const tradeOffs = buildTradeOffs({ negotiationOptions, explainSummary });

  const allEvidenceRefs = [
    ...new Set([
      ...situation.evidence_refs,
      ...driver.evidence_refs,
      ...recommendation.evidence_refs,
      ...tradeOffs.flatMap((tradeOff) => tradeOff.evidence_refs)
    ])
  ];

  const requiresApproval = (
    solverStatus === 'INFEASIBLE'
    || (situation.service_level != null && situation.service_level < SL_THRESHOLDS.POOR)
    || (riskAdjustments?.triggered === true && (situation.total_cost ?? 0) > 50000)
  );

  return {
    version: NARRATIVE_VERSION,
    generated_at: generatedAt || new Date().toISOString(),
    run_id: runId,
    solver_status: solverStatus,
    situation,
    driver,
    recommendation,
    trade_offs: tradeOffs,
    constraint_binding_summary: constraintBindingSummary,
    explain_summary: explainSummary || null,
    requires_approval: requiresApproval,
    all_evidence_refs: allEvidenceRefs,
    summary_text: [situation.text, driver.text, recommendation.text]
      .filter(Boolean)
      .join(' ')
  };
}

export function buildDecisionNarrativeFromPlanResult(planResult) {
  const solverResult = planResult?.solver_result || planResult?.solverResult || {};
  const proof = solverResult?.proof || {};
  const explainSummary = solverResult?.explain_summary || planResult?.explain_summary || null;

  return buildDecisionNarrative({
    solverStatus: solverResult?.status || 'FEASIBLE',
    solverKpis: solverResult?.kpis || {},
    proof,
    infeasibleReasons: solverResult?.infeasible_reasons || [],
    infeasibleReasonDetails: solverResult?.infeasible_reason_details || [],
    replayMetrics: planResult?.replay_metrics || {},
    riskAdjustments: planResult?.risk_adjustments || null,
    negotiationOptions: planResult?.negotiation_options || null,
    explainSummary,
    runId: planResult?.run?.id || null
  });
}
