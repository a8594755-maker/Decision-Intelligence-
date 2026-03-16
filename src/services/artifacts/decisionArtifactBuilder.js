/**
 * decisionArtifactBuilder.js — Builds decision_brief artifacts
 *
 * Assembles a manager-facing decision brief from completed planning steps.
 * The brief contains: summary, recommended action, business impact,
 * risk flags, confidence score, and assumptions.
 *
 * @module services/artifacts/decisionArtifactBuilder
 */

/**
 * Build a decision_brief artifact from planning results.
 *
 * @param {Object} params
 * @param {Object} params.planArtifacts - Prior step artifacts keyed by step name
 * @param {Object} params.taskMeta - Task metadata (title, description, workflowType)
 * @param {Object} [params.riskArtifacts] - Risk assessment artifacts if available
 * @param {Object} [params.scenarioComparison] - Scenario comparison if available
 * @returns {Object} decision_brief artifact payload
 */
export function buildDecisionBrief({
  planArtifacts = {},
  taskMeta = {},
  riskArtifacts = null,
  scenarioComparison = null,
}) {
  // Extract data from prior artifacts
  const solverMeta = findArtifactPayload(planArtifacts, 'solver_meta');
  const planTable = findArtifactPayload(planArtifacts, 'plan_table');
  const replayMetrics = findArtifactPayload(planArtifacts, 'replay_metrics');
  const constraintCheck = findArtifactPayload(planArtifacts, 'constraint_check');
  const riskAdjustments = findArtifactPayload(planArtifacts, 'risk_adjustments');
  const forecastMetrics = findArtifactPayload(planArtifacts, 'metrics');

  // Build summary
  const summary = buildSummary(taskMeta, solverMeta, planTable);

  // Determine recommended action
  const { action, actionLabel } = determineRecommendedAction(
    solverMeta, planTable, constraintCheck
  );

  // Calculate business impact
  const businessImpact = calculateBusinessImpact(
    solverMeta, replayMetrics, planTable
  );

  // Collect risk flags
  const riskFlags = collectRiskFlags(
    constraintCheck, riskAdjustments, riskArtifacts, forecastMetrics
  );

  // Calculate confidence
  const confidence = calculateConfidence(
    solverMeta, forecastMetrics, constraintCheck, planTable
  );

  // List assumptions
  const assumptions = buildAssumptions(solverMeta, taskMeta);

  const brief = {
    summary,
    recommended_action: action,
    recommended_action_label: actionLabel,
    business_impact: businessImpact,
    risk_flags: riskFlags,
    confidence,
    assumptions,
    task_title: taskMeta.title || null,
    workflow_type: taskMeta.workflowType || null,
    generated_at: new Date().toISOString(),
  };

  // Add scenario comparison if available
  if (scenarioComparison) {
    brief.scenario_comparison = scenarioComparison;
  }

  return brief;
}

// ── Internal helpers ────────────────────────────────────────────────────────

function findArtifactPayload(artifacts, type) {
  // artifacts can be: { stepName: [{ artifact_type, payload }] } or flat array
  if (Array.isArray(artifacts)) {
    const match = artifacts.find(a => a.artifact_type === type);
    return match?.payload || null;
  }
  for (const stepArts of Object.values(artifacts)) {
    if (!Array.isArray(stepArts)) continue;
    const match = stepArts.find(a => a.artifact_type === type);
    if (match) return match.payload || null;
  }
  return null;
}

function buildSummary(taskMeta, solverMeta, planTable) {
  const parts = [];

  if (taskMeta.title) {
    parts.push(taskMeta.title);
  }

  if (solverMeta?.status === 'optimal') {
    parts.push('Solver found an optimal solution.');
  } else if (solverMeta?.status === 'feasible') {
    parts.push('Solver found a feasible (non-optimal) solution.');
  } else if (solverMeta?.status) {
    parts.push(`Solver status: ${solverMeta.status}.`);
  }

  if (planTable) {
    const rowCount = Array.isArray(planTable) ? planTable.length
      : planTable.rows?.length || 0;
    if (rowCount > 0) {
      parts.push(`Plan contains ${rowCount} order line(s).`);
    }
  }

  return parts.join(' ') || 'Decision brief generated from planning results.';
}

function determineRecommendedAction(solverMeta, planTable, constraintCheck) {
  const violations = constraintCheck?.violations || [];
  const hasViolations = violations.length > 0;
  const rows = Array.isArray(planTable) ? planTable : planTable?.rows || [];

  if (rows.length === 0) {
    return { action: 'no_action', actionLabel: 'No action needed — current inventory sufficient' };
  }

  if (hasViolations) {
    return { action: 'replenish_with_constraints', actionLabel: `Replenish (${violations.length} constraint warning(s))` };
  }

  if (solverMeta?.status === 'optimal') {
    return { action: 'replenish_now', actionLabel: 'Execute replenishment plan' };
  }

  return { action: 'review_and_decide', actionLabel: 'Review plan before execution' };
}

function calculateBusinessImpact(solverMeta, replayMetrics, planTable) {
  const impact = {};

  // Cost from solver
  if (solverMeta?.kpis) {
    const kpis = solverMeta.kpis;
    if (kpis.total_cost !== undefined) impact.total_cost = kpis.total_cost;
    if (kpis.total_order_qty !== undefined) impact.total_order_qty = kpis.total_order_qty;
    if (kpis.num_orders !== undefined) impact.num_orders = kpis.num_orders;
  }

  // Service level from replay
  if (replayMetrics) {
    const withPlan = replayMetrics.with_plan || {};
    const withoutPlan = replayMetrics.without_plan || {};

    if (withPlan.service_level_proxy !== undefined && withoutPlan.service_level_proxy !== undefined) {
      const delta = withPlan.service_level_proxy - withoutPlan.service_level_proxy;
      impact.service_level_impact = `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}%`;
    }

    if (withPlan.stockout_units !== undefined && withoutPlan.stockout_units !== undefined) {
      impact.stockouts_prevented = Math.max(0, withoutPlan.stockout_units - withPlan.stockout_units);
    }
  }

  // Units from plan table
  const rows = Array.isArray(planTable) ? planTable : planTable?.rows || [];
  if (rows.length > 0) {
    impact.units_affected = rows.reduce((sum, r) => sum + (r.order_qty || 0), 0);
  }

  return impact;
}

function collectRiskFlags(constraintCheck, riskAdjustments, riskArtifacts, forecastMetrics) {
  const flags = [];

  // Constraint violations
  if (constraintCheck?.violations?.length > 0) {
    for (const v of constraintCheck.violations.slice(0, 5)) {
      flags.push({
        level: 'medium',
        category: 'constraint',
        description: `${v.rule || 'Constraint'}: ${v.details || v.sku || 'violation detected'}`,
      });
    }
  }

  // Risk adjustments
  if (riskAdjustments?.adjustments?.length > 0) {
    flags.push({
      level: 'high',
      category: 'risk_adjusted',
      description: `Risk-adjusted plan: ${riskAdjustments.adjustments.length} parameter(s) modified`,
    });
  }

  // Forecast accuracy
  if (forecastMetrics?.mape !== undefined && forecastMetrics.mape > 0.25) {
    flags.push({
      level: forecastMetrics.mape > 0.4 ? 'high' : 'medium',
      category: 'forecast_accuracy',
      description: `Forecast MAPE is ${(forecastMetrics.mape * 100).toFixed(1)}% — consider reviewing demand assumptions`,
    });
  }

  return flags;
}

function calculateConfidence(solverMeta, forecastMetrics, constraintCheck, planTable) {
  let score = 0.5; // base

  // Solver status
  if (solverMeta?.status === 'optimal') score += 0.2;
  else if (solverMeta?.status === 'feasible') score += 0.1;

  // Forecast accuracy
  if (forecastMetrics?.mape !== undefined) {
    if (forecastMetrics.mape < 0.15) score += 0.15;
    else if (forecastMetrics.mape < 0.25) score += 0.1;
    else if (forecastMetrics.mape > 0.4) score -= 0.1;
  }

  // Constraint violations
  const violations = constraintCheck?.violations?.length || 0;
  if (violations === 0) score += 0.1;
  else if (violations > 3) score -= 0.1;

  // Plan exists
  const rows = Array.isArray(planTable) ? planTable : planTable?.rows || [];
  if (rows.length > 0) score += 0.05;

  return Math.max(0.1, Math.min(0.99, score));
}

function buildAssumptions(solverMeta, taskMeta) {
  const assumptions = [];

  assumptions.push('Demand forecast is based on historical data and may not reflect sudden changes');
  assumptions.push('Lead times are assumed to remain at current averages');

  if (solverMeta?.constraints_checked) {
    assumptions.push('All business constraints (MOQ, lot size, capacity) have been validated');
  }

  if (taskMeta.workflowType === 'risk_plan' || taskMeta.workflowType === 'risk_aware') {
    assumptions.push('Risk adjustments applied based on supplier reliability scores');
  }

  return assumptions;
}
