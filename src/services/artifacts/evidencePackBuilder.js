/**
 * evidencePackBuilder.js — Builds evidence_pack_v2 artifacts
 *
 * Assembles an audit-ready evidence pack from all artifacts produced
 * during a task's execution. Contains source datasets, timestamps,
 * engine versions, calculation logic, and evidence references.
 *
 * @module services/artifacts/evidencePackBuilder
 */

/**
 * Build an evidence_pack_v2 artifact from task execution results.
 *
 * @param {Object} params
 * @param {Object} params.priorArtifacts - All artifacts from prior steps { stepName: [artifacts] }
 * @param {Object} params.taskMeta - Task metadata
 * @param {Object} params.inputData - Task input data (sheets, datasetProfileRow, etc.)
 * @param {Object[]} [params.priorStepResults] - Array of { step_name, status, artifacts }
 * @returns {Object} evidence_pack_v2 artifact payload
 */
export function buildEvidencePack({
  priorArtifacts = {},
  taskMeta = {},
  inputData = {},
  priorStepResults = [],
}) {
  const now = new Date().toISOString();

  return {
    source_datasets: buildSourceDatasets(inputData),
    timestamps: buildTimestamps(taskMeta, priorStepResults, now),
    referenced_tables: buildReferencedTables(inputData),
    engine_versions: buildEngineVersions(priorArtifacts),
    calculation_logic: buildCalculationLogic(priorStepResults, priorArtifacts),
    scenario_comparison: extractScenarioComparison(priorArtifacts),
    assumptions: extractAssumptions(priorArtifacts),
    evidence_refs: buildEvidenceRefs(priorArtifacts, priorStepResults),
    artifact_inventory: buildArtifactInventory(priorStepResults),
    generated_at: now,
  };
}

// ── Internal helpers ────────────────────────────────────────────────────────

function buildSourceDatasets(inputData) {
  const datasets = [];

  if (inputData.datasetProfileId || inputData.datasetProfileRow) {
    const profile = inputData.datasetProfileRow || {};
    datasets.push({
      dataset_id: inputData.datasetProfileId || profile.id || 'unknown',
      name: profile.file_name || profile.name || 'Primary dataset',
      row_count: profile.row_count || null,
      loaded_at: profile.created_at || profile.uploaded_at || new Date().toISOString(),
    });
  }

  if (inputData.sheets) {
    for (const [sheetName, rows] of Object.entries(inputData.sheets)) {
      if (Array.isArray(rows) && rows.length > 0) {
        datasets.push({
          dataset_id: `sheet:${sheetName}`,
          name: sheetName,
          row_count: rows.length,
          loaded_at: new Date().toISOString(),
        });
      }
    }
  }

  // Ensure at least one entry
  if (datasets.length === 0) {
    datasets.push({
      dataset_id: 'inline',
      name: 'Inline task context',
      row_count: null,
      loaded_at: new Date().toISOString(),
    });
  }

  return datasets;
}

function buildTimestamps(taskMeta, priorStepResults, now) {
  const timestamps = {
    analysis_started_at: null,
    analysis_completed_at: now,
    data_as_of: now,
  };

  // Find earliest step start
  if (priorStepResults.length > 0) {
    const firstStep = priorStepResults[0];
    timestamps.analysis_started_at = firstStep.started_at || taskMeta.created_at || now;
  } else {
    timestamps.analysis_started_at = taskMeta.created_at || now;
  }

  return timestamps;
}

function buildReferencedTables(inputData) {
  const tables = [];

  if (inputData.sheets) {
    for (const [sheetName, rows] of Object.entries(inputData.sheets)) {
      if (Array.isArray(rows) && rows.length > 0) {
        const fields = Object.keys(rows[0] || {});
        tables.push({
          table_name: sheetName,
          fields_used: fields.slice(0, 20), // cap at 20
          row_range: `1-${rows.length}`,
        });
      }
    }
  }

  return tables;
}

function buildEngineVersions(priorArtifacts) {
  const versions = {
    platform: 'decision-intelligence-v2',
  };

  // Extract from solver_meta
  const solverMeta = findArtifact(priorArtifacts, 'solver_meta');
  if (solverMeta) {
    versions.solver = solverMeta.solver_version || solverMeta.engine || 'heuristic-v1';
  }

  // Check for forecast
  if (findArtifact(priorArtifacts, 'forecast_series')) {
    versions.forecaster = 'quantile-v2';
  }

  // Check for risk
  if (findArtifact(priorArtifacts, 'risk_adjustments')) {
    versions.risk_engine = 'risk-adjustments-v1';
  }

  // Check for CFR
  if (findArtifact(priorArtifacts, 'cfr_negotiation_strategy')) {
    versions.cfr_engine = 'cfr-v3';
  }

  return versions;
}

function buildCalculationLogic(priorStepResults, priorArtifacts) {
  const steps = priorStepResults
    .filter(s => s.status === 'succeeded')
    .map(s => s.step_name);

  if (steps.length === 0) {
    return 'No analysis steps completed.';
  }

  const parts = [`Pipeline executed ${steps.length} step(s): ${steps.join(' → ')}.`];

  const solverMeta = findArtifact(priorArtifacts, 'solver_meta');
  if (solverMeta) {
    parts.push(`Solver: ${solverMeta.status || 'unknown'} (objective: ${solverMeta.objective_value || 'N/A'}).`);
  }

  const constraintCheck = findArtifact(priorArtifacts, 'constraint_check');
  if (constraintCheck) {
    const violations = constraintCheck.violations?.length || 0;
    parts.push(`Constraints: ${violations} violation(s).`);
  }

  return parts.join(' ');
}

function extractScenarioComparison(priorArtifacts) {
  const comparison = findArtifact(priorArtifacts, 'scenario_comparison');
  if (!comparison) return null;

  return {
    scenario_id: comparison.scenario_run_id || null,
    label: comparison.label || 'Scenario comparison',
    kpis: comparison.kpis || {},
  };
}

function extractAssumptions(priorArtifacts) {
  const assumptions = [];
  const solverMeta = findArtifact(priorArtifacts, 'solver_meta');

  if (solverMeta?.constraints_checked) {
    assumptions.push('Business constraints validated by constraint checker');
  }

  assumptions.push('Results based on data available at analysis time');

  return assumptions;
}

function buildEvidenceRefs(priorArtifacts, priorStepResults) {
  const refs = [];

  for (const step of priorStepResults) {
    if (step.status !== 'succeeded') continue;
    for (const art of step.artifacts || []) {
      refs.push({
        artifact_type: art.artifact_type || art.type || 'unknown',
        step_name: step.step_name,
        label: art.label || art.artifact_type || 'artifact',
      });
    }
  }

  return refs;
}

function buildArtifactInventory(priorStepResults) {
  const inventory = {};
  for (const step of priorStepResults) {
    const types = (step.artifacts || []).map(a => a.artifact_type || a.type).filter(Boolean);
    if (types.length > 0) {
      inventory[step.step_name] = types;
    }
  }
  return inventory;
}

function findArtifact(artifacts, type) {
  if (Array.isArray(artifacts)) {
    const match = artifacts.find(a => a.artifact_type === type);
    return match?.payload || match || null;
  }
  for (const stepArts of Object.values(artifacts || {})) {
    if (!Array.isArray(stepArts)) continue;
    const match = stepArts.find(a => a.artifact_type === type);
    if (match) return match.payload || match;
  }
  return null;
}
