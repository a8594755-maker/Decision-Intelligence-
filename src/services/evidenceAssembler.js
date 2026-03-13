/**
 * evidenceAssembler.js
 *
 * Assembles evidence references from run artifacts so that every Chat
 * recommendation can cite its sources. This is the "trust layer" —
 * the thing that turns Chat from "it said so" into "here's the proof".
 *
 * Evidence refs are lightweight pointers to artifacts:
 *   { artifact_type, run_id, label, summary, path? }
 *
 * The assembler works with whatever artifacts are available for a given run.
 */

// ── Evidence ref factory ─────────────────────────────────────────────────────

/**
 * Create a single evidence reference.
 *
 * @param {Object} params
 * @param {string} params.artifact_type - Registered artifact type
 * @param {number|string} params.run_id - Run ID the artifact belongs to
 * @param {string} params.label - Display label
 * @param {string} [params.summary] - Short description of what this evidence shows
 * @param {string} [params.path] - Deep link path (e.g. "solver_meta.proof.constraints_checked")
 * @returns {Object} evidence_ref
 */
export function createEvidenceRef({ artifact_type, run_id, label, summary, path }) {
  return {
    artifact_type,
    run_id: run_id ?? null,
    label: label || artifact_type,
    summary: summary || '',
    path: path || null,
  };
}

// ── Assemblers for different contexts ────────────────────────────────────────

/**
 * Assemble evidence refs from a completed plan run.
 *
 * @param {Object} params
 * @param {number|string} params.runId
 * @param {Object} params.solverResult  - Solver output with kpis, proof, etc.
 * @param {Object} [params.replayMetrics]
 * @param {Object} [params.constraintCheck]
 * @param {boolean} [params.hasTopology]
 * @param {boolean} [params.isRiskAware]
 * @returns {Array<Object>} evidence_refs
 */
export function assemblePlanEvidence({
  runId,
  solverResult,
  replayMetrics,
  constraintCheck,
  hasTopology = false,
  isRiskAware = false,
}) {
  const refs = [];

  if (solverResult) {
    refs.push(createEvidenceRef({
      artifact_type: 'solver_meta',
      run_id: runId,
      label: 'Solver Result',
      summary: `Status: ${solverResult.status || '?'}, Cost: $${Number(solverResult.kpis?.estimated_total_cost || 0).toLocaleString()}`,
    }));

    if (solverResult.proof) {
      refs.push(createEvidenceRef({
        artifact_type: 'solver_meta',
        run_id: runId,
        label: 'Optimization Proof',
        summary: `${(solverResult.proof.constraints_checked || []).length} constraints verified, ${(solverResult.proof.objective_terms || []).length} objective terms`,
        path: 'proof',
      }));
    }
  }

  refs.push(createEvidenceRef({
    artifact_type: 'plan_table',
    run_id: runId,
    label: 'Replenishment Plan',
    summary: 'Order schedule with quantities and dates',
  }));

  refs.push(createEvidenceRef({
    artifact_type: 'inventory_projection',
    run_id: runId,
    label: 'Inventory Projection',
    summary: 'Day-by-day inventory levels with and without plan',
  }));

  if (replayMetrics) {
    const delta = replayMetrics.delta || {};
    refs.push(createEvidenceRef({
      artifact_type: 'replay_metrics',
      run_id: runId,
      label: 'Replay Simulation',
      summary: `SL delta: ${delta.service_level_proxy != null ? (delta.service_level_proxy * 100).toFixed(1) + ' pp' : '?'}, stockout delta: ${delta.stockout_units ?? '?'} units`,
    }));
  }

  if (constraintCheck) {
    refs.push(createEvidenceRef({
      artifact_type: 'constraint_check',
      run_id: runId,
      label: 'Constraint Verification',
      summary: constraintCheck.passed ? 'All constraints satisfied' : `${(constraintCheck.violations || []).length} violation(s)`,
    }));
  }

  if (hasTopology) {
    refs.push(createEvidenceRef({
      artifact_type: 'topology_graph',
      run_id: runId,
      label: 'Supply Network Graph',
      summary: 'Visual supply chain topology with flow quantities',
    }));
  }

  if (isRiskAware) {
    refs.push(createEvidenceRef({
      artifact_type: 'risk_adjustments',
      run_id: runId,
      label: 'Risk Adjustments',
      summary: 'Risk-driven parameter modifications applied to this plan',
    }));
  }

  return refs;
}

/**
 * Assemble evidence refs from a forecast run.
 *
 * @param {Object} params
 * @param {number|string} params.runId
 * @param {Object} params.metrics - Forecast metrics
 * @returns {Array<Object>} evidence_refs
 */
export function assembleForecastEvidence({ runId, metrics }) {
  const refs = [];

  refs.push(createEvidenceRef({
    artifact_type: 'forecast_series',
    run_id: runId,
    label: 'Forecast Series',
    summary: `${metrics?.groups_processed || '?'} groups, ${metrics?.horizon_periods || '?'} periods ahead`,
  }));

  if (metrics) {
    refs.push(createEvidenceRef({
      artifact_type: 'metrics',
      run_id: runId,
      label: 'Forecast Accuracy',
      summary: `MAPE: ${metrics.mape != null ? metrics.mape.toFixed(2) + '%' : '?'}, model: ${metrics.selected_model_global || '?'}`,
    }));
  }

  return refs;
}

/**
 * Assemble evidence refs from a scenario comparison.
 *
 * @param {Object} params
 * @param {Object} params.comparison - scenario_comparison artifact payload
 * @returns {Array<Object>} evidence_refs
 */
export function assembleScenarioEvidence({ comparison }) {
  const refs = [];

  if (!comparison) return refs;

  refs.push(createEvidenceRef({
    artifact_type: 'scenario_comparison',
    run_id: comparison.scenario_run_id,
    label: 'Scenario Comparison',
    summary: `Base run ${comparison.base_run_id} vs scenario run ${comparison.scenario_run_id}`,
  }));

  if (comparison.base_run_id) {
    refs.push(createEvidenceRef({
      artifact_type: 'solver_meta',
      run_id: comparison.base_run_id,
      label: 'Base Plan',
      summary: 'Original plan before scenario adjustments',
    }));
  }

  if (comparison.scenario_run_id) {
    refs.push(createEvidenceRef({
      artifact_type: 'solver_meta',
      run_id: comparison.scenario_run_id,
      label: 'Scenario Plan',
      summary: `Plan with overrides: ${Object.keys(comparison.overrides || {}).join(', ')}`,
    }));
  }

  return refs;
}

/**
 * Assemble evidence refs from a negotiation evaluation.
 *
 * @param {Object} params
 * @param {Object} params.evaluation - negotiation_evaluation artifact payload
 * @param {Object} params.report - negotiation_report artifact payload
 * @returns {Array<Object>} evidence_refs
 */
export function assembleNegotiationEvidence({ evaluation, report }) {
  const refs = [];

  if (evaluation) {
    refs.push(createEvidenceRef({
      artifact_type: 'negotiation_evaluation',
      run_id: evaluation.base_run_id,
      label: 'Option Evaluation',
      summary: `${(evaluation.ranked_options || []).length} options evaluated, ranked by ${evaluation.ranking_method || '?'}`,
    }));
  }

  if (report) {
    refs.push(createEvidenceRef({
      artifact_type: 'negotiation_report',
      run_id: report.base_run_id,
      label: 'Negotiation Report',
      summary: report.summary ? report.summary.slice(0, 100) : 'AI-generated trade-off analysis',
    }));

    // Include the report's own evidence refs
    if (Array.isArray(report.evidence_refs)) {
      for (const ref of report.evidence_refs) {
        refs.push(createEvidenceRef({
          artifact_type: ref.artifact_type || 'evidence_pack',
          run_id: ref.run_id || report.base_run_id,
          label: ref.label || 'Supporting Evidence',
          summary: ref.summary || '',
        }));
      }
    }
  }

  return refs;
}

/**
 * Assemble evidence refs from risk analysis artifacts.
 *
 * @param {Object} params
 * @param {Object} [params.riskDelta] - risk_delta_summary payload
 * @param {Object} [params.proactiveAlerts] - proactive_alerts payload
 * @param {number|string} [params.runId]
 * @returns {Array<Object>} evidence_refs
 */
export function assembleRiskEvidence({ riskDelta, proactiveAlerts, runId }) {
  const refs = [];

  if (riskDelta) {
    refs.push(createEvidenceRef({
      artifact_type: 'risk_delta_summary',
      run_id: runId,
      label: 'Risk Delta',
      summary: `${riskDelta.total_deltas || 0} risk score changes detected`,
    }));
  }

  if (proactiveAlerts) {
    const alertCount = proactiveAlerts.alerts?.length || 0;
    const criticalCount = (proactiveAlerts.alerts || []).filter(a => a.severity === 'critical').length;
    refs.push(createEvidenceRef({
      artifact_type: 'proactive_alerts',
      run_id: runId,
      label: 'Proactive Alerts',
      summary: `${alertCount} alert(s), ${criticalCount} critical`,
    }));
  }

  return refs;
}

/**
 * Merge multiple evidence ref arrays, deduplicating by (artifact_type + run_id + path).
 *
 * @param  {...Array} refArrays
 * @returns {Array<Object>}
 */
/**
 * Assemble evidence refs from macro-oracle signal chain.
 *
 * @param {Object} params
 * @param {Object[]} [params.signals] - MacroSignal[] from processExternalSignals
 * @param {Object}   [params.cfrAssessment] - from deriveSolverParamsFromStrategy
 * @param {Object}   [params.riskDelta] - { total_delta, base_score, new_score }
 * @param {number|string} [params.runId]
 * @returns {Array<Object>} evidence_refs
 */
export function assembleMacroOracleEvidence({ signals, cfrAssessment, riskDelta, runId }) {
  const refs = [];

  if (signals?.length) {
    refs.push(createEvidenceRef({
      artifact_type: 'macro_signal',
      run_id: runId,
      label: 'External Signals',
      summary: `${signals.length} signal(s) detected`,
    }));
  }

  if (riskDelta) {
    refs.push(createEvidenceRef({
      artifact_type: 'risk_delta_summary',
      run_id: runId,
      label: 'Risk Impact',
      summary: `risk +${riskDelta.total_delta?.toFixed?.(1) || '?'} (${riskDelta.base_score} → ${riskDelta.new_score})`,
    }));
  }

  if (cfrAssessment) {
    refs.push(createEvidenceRef({
      artifact_type: 'cfr_param_adjustment',
      run_id: runId,
      label: 'CFR Assessment',
      summary: `${cfrAssessment.supplier_assessment}, alpha ×${cfrAssessment.safety_stock_alpha_multiplier}`,
    }));
  }

  return refs;
}

export function mergeEvidenceRefs(...refArrays) {
  const seen = new Set();
  const result = [];

  for (const arr of refArrays) {
    if (!Array.isArray(arr)) continue;
    for (const ref of arr) {
      const key = `${ref.artifact_type}:${ref.run_id}:${ref.path || ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(ref);
      }
    }
  }

  return result;
}

/**
 * Build a compact evidence summary string for display.
 *
 * @param {Array<Object>} evidenceRefs
 * @returns {string}
 */
export function buildEvidenceSummaryText(evidenceRefs) {
  if (!evidenceRefs?.length) return 'No supporting evidence available.';

  const grouped = {};
  for (const ref of evidenceRefs) {
    const cat = categorizRef(ref.artifact_type);
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(ref);
  }

  return Object.entries(grouped)
    .map(([cat, refs]) => `${cat}: ${refs.map(r => r.label).join(', ')}`)
    .join(' | ');
}

function categorizRef(artifactType) {
  if (['solver_meta', 'plan_table', 'constraint_check', 'replay_metrics', 'inventory_projection'].includes(artifactType)) return 'Planning';
  if (['forecast_series', 'metrics'].includes(artifactType)) return 'Forecast';
  if (['scenario_comparison'].includes(artifactType)) return 'Scenario';
  if (['negotiation_evaluation', 'negotiation_report', 'negotiation_options'].includes(artifactType)) return 'Negotiation';
  if (['risk_delta_summary', 'proactive_alerts', 'risk_adjustments', 'macro_signal'].includes(artifactType)) return 'Risk';
  if (['cfr_param_adjustment', 'cfr_negotiation_strategy'].includes(artifactType)) return 'Negotiation';
  if (['topology_graph', 'bottlenecks'].includes(artifactType)) return 'Topology';
  if (['evidence_pack', 'decision_narrative'].includes(artifactType)) return 'Evidence';
  return 'Other';
}

export default {
  createEvidenceRef,
  assemblePlanEvidence,
  assembleForecastEvidence,
  assembleScenarioEvidence,
  assembleNegotiationEvidence,
  assembleRiskEvidence,
  assembleMacroOracleEvidence,
  mergeEvidenceRefs,
  buildEvidenceSummaryText,
};
