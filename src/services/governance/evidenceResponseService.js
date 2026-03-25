/**
 * evidenceResponseService.js
 *
 * Builds evidence-enhanced responses for the SmartOps 2.0 Chat.
 * Every answer includes traceable evidence chains, not just conclusions.
 *
 * Pattern:
 *   Conclusion → Evidence Chain → Quantified Trade-offs → Suggested Actions
 */

// ── Evidence Response Builder ────────────────────────────────────────────────

/**
 * Build an evidence-enhanced response from plan results.
 *
 * @param {Object} params
 * @param {Object} params.planResult - from chatPlanningService.runPlanFromDatasetProfile
 * @param {Object} [params.comparison] - from chatRefinementService (if available)
 * @param {Object} [params.riskScores] - current risk score data
 * @param {Object} [params.forecastMetrics] - forecast evaluation metrics
 * @param {string} [params.userQuery] - what the user asked
 * @returns {Object} { conclusion, evidence_chain, trade_offs, suggested_actions, markdown_text }
 */
export function buildEvidenceResponse({
  planResult,
  comparison,
  riskScores,
  forecastMetrics,
  _userQuery,
}) {
  const evidence = [];
  const tradeOffs = [];
  const suggestedActions = [];

  // Extract solver data
  const solver = planResult?.solver_result || {};
  const kpis = solver.kpis || {};
  const proof = solver.proof || {};
  const constraintCheck = planResult?.constraint_check || {};
  const replayMetrics = planResult?.replay_metrics || {};

  // 1. Solver status evidence
  if (solver.status) {
    evidence.push({
      source: 'solver',
      fact: `Solver returned "${solver.status}" status`,
      detail: solver.solver_meta
        ? `Engine: ${solver.solver_meta.solver || '?'}, solve time: ${solver.solver_meta.solve_time_ms || '?'}ms`
        : null,
    });
  }

  // 2. Binding constraints evidence (from proof)
  if (proof.constraints_checked?.length > 0) {
    const binding = proof.constraints_checked.filter((c) => c.passed === false || c.binding);
    if (binding.length > 0) {
      evidence.push({
        source: 'constraints',
        fact: `${binding.length} binding constraint(s)`,
        detail: binding.map((c) => `${c.name}: ${c.details || (c.passed ? 'passed' : 'binding')}`).join('; '),
      });
    }
  }

  // 3. Objective terms evidence
  if (proof.objective_terms?.length > 0) {
    evidence.push({
      source: 'objective',
      fact: 'Objective function breakdown',
      detail: proof.objective_terms.map((t) => `${t.name}=${t.value}${t.note ? ` (${t.note})` : ''}`).join('; '),
    });
  }

  // 4. Constraint check evidence
  if (constraintCheck.passed != null) {
    evidence.push({
      source: 'constraint_check',
      fact: constraintCheck.passed ? 'All hard constraints passed' : 'Hard constraint violations detected',
      detail: constraintCheck.violations?.length > 0
        ? constraintCheck.violations.map((v) => v.message || v).join('; ')
        : null,
    });
  }

  // 5. Replay metrics evidence
  if (replayMetrics.with_plan?.service_level_proxy != null) {
    evidence.push({
      source: 'replay_simulation',
      fact: `Simulated service level: ${(replayMetrics.with_plan.service_level_proxy * 100).toFixed(1)}%`,
      detail: replayMetrics.without_plan?.service_level_proxy != null
        ? `Without plan: ${(replayMetrics.without_plan.service_level_proxy * 100).toFixed(1)}% → Improvement: ${((replayMetrics.delta?.service_level_proxy || 0) * 100).toFixed(1)} pp`
        : null,
    });
  }

  // 6. Risk score evidence (if available)
  if (riskScores?.length > 0) {
    const highRisk = riskScores.filter((r) => (r.risk_score || 0) > 60);
    if (highRisk.length > 0) {
      evidence.push({
        source: 'risk_scores',
        fact: `${highRisk.length} high-risk supplier-material pair(s)`,
        detail: highRisk.slice(0, 3).map((r) =>
          `${r.material_code || '?'}@${r.plant_id || '?'}: score=${r.risk_score?.toFixed(0)}, on_time=${((r.metrics?.on_time_rate || 0) * 100).toFixed(0)}%`
        ).join('; '),
      });
    }
  }

  // 7. Forecast quality evidence
  if (forecastMetrics) {
    evidence.push({
      source: 'forecast_quality',
      fact: `Forecast MAPE: ${forecastMetrics.mape != null ? (forecastMetrics.mape * 100).toFixed(1) + '%' : '?'}`,
      detail: forecastMetrics.model_used ? `Model: ${forecastMetrics.model_used}` : null,
    });
  }

  // Build trade-offs
  if (kpis.estimated_total_cost != null && kpis.estimated_service_level != null) {
    tradeOffs.push({
      metric_a: 'Total Cost',
      value_a: `$${kpis.estimated_total_cost.toLocaleString()}`,
      metric_b: 'Service Level',
      value_b: `${(kpis.estimated_service_level * 100).toFixed(1)}%`,
    });
  }

  if (comparison?.deltas) {
    const d = comparison.deltas;
    if (d.estimated_total_cost?.absolute != null && d.estimated_service_level?.absolute != null) {
      const costDir = d.estimated_total_cost.absolute > 0 ? 'increases' : 'decreases';
      const slDir = d.estimated_service_level.absolute > 0 ? 'improves' : 'declines';
      tradeOffs.push({
        description: `Cost ${costDir} by $${Math.abs(d.estimated_total_cost.absolute).toLocaleString()} while service level ${slDir} by ${(Math.abs(d.estimated_service_level.absolute) * 100).toFixed(1)} pp`,
      });
    }
  }

  // Build suggested actions
  if (solver.status === 'infeasible') {
    suggestedActions.push(
      { label: 'Relax budget constraint', intent: 'CHANGE_PARAM', params: { budget_cap: 'increase' } },
      { label: 'Lower service level target', intent: 'CHANGE_PARAM', params: { service_level_target: 'decrease' } },
    );
  } else if (solver.status === 'optimal' || solver.status === 'feasible') {
    if (planResult?.risk_mode !== 'on') {
      suggestedActions.push(
        { label: 'Run with risk adjustments', intent: 'RUN_PLAN', params: { risk_mode: 'on' } },
      );
    }
    if (!comparison) {
      suggestedActions.push(
        { label: 'Run a what-if scenario', intent: 'WHAT_IF', params: {} },
      );
    }
    suggestedActions.push(
      { label: 'Approve this plan', intent: 'APPROVE', params: {} },
    );
  }

  // Build conclusion
  const conclusion = buildConclusionText({ solver, kpis, constraintCheck, planResult });

  // Build markdown text
  const markdownText = buildMarkdownResponse({
    conclusion,
    evidence,
    tradeOffs,
    suggestedActions,
  });

  return {
    conclusion,
    evidence_chain: evidence,
    trade_offs: tradeOffs,
    suggested_actions: suggestedActions,
    markdown_text: markdownText,
  };
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

function buildConclusionText({ solver, kpis, constraintCheck, planResult }) {
  const parts = [];

  if (solver.status === 'optimal') {
    parts.push('Plan optimization completed successfully with an optimal solution.');
  } else if (solver.status === 'feasible') {
    parts.push('Plan generated with a feasible (non-optimal) solution.');
  } else if (solver.status === 'infeasible') {
    parts.push('Plan is infeasible — constraints cannot all be satisfied simultaneously.');
    if (solver.infeasible_reasons?.length > 0) {
      parts.push(`Reasons: ${solver.infeasible_reasons.join('; ')}.`);
    }
    return parts.join(' ');
  }

  if (kpis.estimated_total_cost != null) {
    parts.push(`Estimated total cost: $${kpis.estimated_total_cost.toLocaleString()}.`);
  }
  if (kpis.estimated_service_level != null) {
    parts.push(`Service level: ${(kpis.estimated_service_level * 100).toFixed(1)}%.`);
  }

  if (constraintCheck?.passed === false && constraintCheck.violations?.length > 0) {
    parts.push(`Warning: ${constraintCheck.violations.length} constraint violation(s) detected.`);
  }

  if (planResult?.risk_mode === 'on') {
    parts.push('Risk-aware adjustments were applied.');
  }

  return parts.join(' ');
}

function buildMarkdownResponse({ conclusion, evidence, tradeOffs, suggestedActions }) {
  const lines = [];

  lines.push(conclusion);
  lines.push('');

  if (evidence.length > 0) {
    lines.push('**Evidence:**');
    evidence.forEach((e) => {
      lines.push(`- **${e.source}**: ${e.fact}${e.detail ? ` — ${e.detail}` : ''}`);
    });
    lines.push('');
  }

  if (tradeOffs.length > 0) {
    lines.push('**Trade-offs:**');
    tradeOffs.forEach((t) => {
      if (t.description) {
        lines.push(`- ${t.description}`);
      } else {
        lines.push(`- ${t.metric_a}: ${t.value_a} vs ${t.metric_b}: ${t.value_b}`);
      }
    });
    lines.push('');
  }

  if (suggestedActions.length > 0) {
    lines.push('**Suggested next steps:**');
    suggestedActions.forEach((a) => {
      lines.push(`- ${a.label}`);
    });
  }

  return lines.join('\n');
}

/**
 * Build a concise evidence summary for inline use in chat messages.
 *
 * @param {Object} planResult
 * @returns {string} short evidence text
 */
export function buildInlineEvidenceSummary(planResult) {
  const solver = planResult?.solver_result || {};
  const kpis = solver.kpis || {};
  const proof = solver.proof || {};

  const parts = [];

  if (solver.status) {
    parts.push(`Status: ${solver.status}`);
  }
  if (kpis.estimated_total_cost != null) {
    parts.push(`Cost: $${kpis.estimated_total_cost.toLocaleString()}`);
  }
  if (kpis.estimated_service_level != null) {
    parts.push(`SL: ${(kpis.estimated_service_level * 100).toFixed(1)}%`);
  }

  const bindingCount = (proof.constraints_checked || []).filter((c) => !c.passed || c.binding).length;
  if (bindingCount > 0) {
    parts.push(`Binding constraints: ${bindingCount}`);
  }

  return parts.join(' | ');
}

export default {
  buildEvidenceResponse,
  buildInlineEvidenceSummary,
};
