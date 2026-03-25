/**
 * Scenario Engine
 *
 * Orchestrates the execution of a What-If scenario:
 *   1. Load base run artifacts (validate they exist)
 *   2. Translate overrides → chatPlanningService parameters
 *   3. Execute plan via runPlanFromDatasetProfile with scenarioOverrides
 *   4. Build scenario_comparison artifact
 *   5. Persist artifact and update scenario record
 *
 * Override application is deterministic and fully described by
 * (base_run_id + overrides + engine_flags), matching the scenario_key.
 *
 * Documented override behaviors:
 *   budget_cap                  → constraints.budget_cap (hard cap on total order spend)
 *   service_target              → objective.service_level_target (penalty/constraint on stockouts)
 *   stockout_penalty_multiplier → objective.stockout_penalty × multiplier
 *   holding_cost_multiplier     → objective.holding_cost × multiplier
 *   safety_stock_alpha          → demand_eff[t] = p50 + α × max(0, p90 - p50)
 *   risk_mode='on'              → base stockout_penalty boosted 1.5× before multiplier
 *   expedite_mode='on'          → lead_time_days reduced by lead_time_buffer_days (default 3)
 *   expedite_cost_per_unit      → added to objective cost per expedited unit
 *   lead_time_buffer_days       → days to subtract from lead_time when expedite_mode='on'
 */

import { diRunsService } from './diRunsService';
import { datasetProfilesService } from '../data-prep/datasetProfilesService';
import { updateScenario } from './diScenariosService';
import { runPlanFromDatasetProfile } from './chatPlanningService';
import { saveJsonArtifact, loadArtifact } from '../../utils/artifactStore';
import { buildScenarioComparison } from '../../utils/buildScenarioComparison';
import { applyScenarioOverridesToPayload } from '../../utils/applyScenarioOverrides';

const ARTIFACT_SIZE_THRESHOLD = 200 * 1024;

// ============================================================
// Override application (pure, deterministic)
// ============================================================

/**
 * Build constraintsOverride from scenario overrides.
 * These are passed to the existing chatPlanningService constraint builder.
 */
export function buildConstraintsOverride(overrides = {}) {
  const result = {};

  if (overrides.budget_cap !== null && overrides.budget_cap !== undefined) {
    result.budget_cap = Number(overrides.budget_cap);
  }

  return result;
}

/**
 * Build objectiveOverride from scenario overrides.
 * stockout_penalty and holding_cost are base values that will be further
 * scaled by multipliers inside applyScenarioOverridesToPayload.
 */
export function buildObjectiveOverride(overrides = {}) {
  const result = {};

  if (overrides.service_target !== null && overrides.service_target !== undefined) {
    result.service_level_target = Number(overrides.service_target);
  }

  return result;
}

// Re-export for consumers that import from this module
export { applyScenarioOverridesToPayload } from '../../utils/applyScenarioOverrides';

// ============================================================
// Artifact loading helpers
// ============================================================

function getLatestArtifactByType(artifacts = [], type) {
  const matches = artifacts.filter((a) => a.artifact_type === type);
  if (matches.length === 0) return null;
  return [...matches].sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0];
}

async function loadArtifactByType(artifacts, type) {
  const record = getLatestArtifactByType(artifacts, type);
  if (!record) return null;
  return loadArtifact({ artifact_id: record.id, ...(record.artifact_json || {}) });
}

// ============================================================
// Main scenario execution
// ============================================================

/**
 * Execute a scenario plan run.
 *
 * Validates base run artifacts, applies overrides, runs the plan solver,
 * builds and persists the scenario_comparison artifact, and updates the
 * scenario record with the new run ID.
 *
 * @param {object} params
 * @param {string}  params.userId
 * @param {object}  params.scenario          - di_scenarios record
 * @param {object}  [params.onProgress]      - optional callback({ step, message })
 * @returns {object} { scenarioRunId, comparisonArtifact }
 */
export async function executeScenarioPlan({ userId, scenario, onProgress }) {
  const notify = (step, message) => {
    onProgress?.({ step, message });
  };

  const { base_run_id, overrides = {}, engine_flags = {} } = scenario;

  notify('validate', `Validating base run ${base_run_id}…`);

  // 1. Load base run
  const baseRun = await diRunsService.getRun(Number(base_run_id));
  if (!baseRun) {
    throw new Error(`Base run ${base_run_id} not found. Cannot run scenario.`);
  }

  // 2. Load base run artifacts
  const baseArtifacts = await diRunsService.getArtifactsForRun(Number(base_run_id));

  const basePlanTable = await loadArtifactByType(baseArtifacts, 'plan_table');
  if (!basePlanTable) {
    throw new Error(
      `Base run ${base_run_id} has no plan_table artifact. ` +
      'Ensure the base plan completed successfully before running a scenario.'
    );
  }

  const baseReplayMetrics = await loadArtifactByType(baseArtifacts, 'replay_metrics');
  const baseSolverMeta = await loadArtifactByType(baseArtifacts, 'solver_meta');
  const baseEvidencePack = await loadArtifactByType(baseArtifacts, 'evidence_pack');

  // 3. Resolve forecast run ID from evidence_pack
  const forecastRunId = baseEvidencePack?.forecast_run_id ?? null;

  // 4. Load dataset profile
  notify('profile', `Loading dataset profile ${baseRun.dataset_profile_id}…`);
  const profileRow = await datasetProfilesService.getDatasetProfileById(
    userId,
    baseRun.dataset_profile_id
  );
  if (!profileRow) {
    throw new Error(
      `Dataset profile ${baseRun.dataset_profile_id} not found for base run ${base_run_id}.`
    );
  }

  // 5. Build override-translated params for chatPlanningService
  const constraintsOverride = buildConstraintsOverride(overrides);
  const objectiveOverride = buildObjectiveOverride(overrides);

  // 6. Execute scenario plan (calls chatPlanningService.runPlanFromDatasetProfile
  //    with scenarioOverrides, which will apply payload-level overrides after assembly)
  notify('optimize', 'Running scenario optimizer…');

  const planResult = await runPlanFromDatasetProfile({
    userId,
    datasetProfileRow: profileRow,
    forecastRunId: Number.isFinite(Number(forecastRunId)) ? Number(forecastRunId) : null,
    constraintsOverride,
    objectiveOverride,
    settings: {
      scenario_id: scenario.id,
      base_run_id: Number(base_run_id)
    },
    scenarioOverrides: overrides,
    scenarioEngineFlags: engine_flags
  });

  const scenarioRunId = planResult.run?.id;
  if (!scenarioRunId) {
    throw new Error('Scenario plan run did not produce a run ID.');
  }

  // 7. Load scenario run artifacts for comparison
  notify('compare', 'Building comparison artifact…');
  const scenarioArtifacts = await diRunsService.getArtifactsForRun(Number(scenarioRunId));
  const scenarioReplayMetrics = await loadArtifactByType(scenarioArtifacts, 'replay_metrics');
  const scenarioSolverMeta = await loadArtifactByType(scenarioArtifacts, 'solver_meta');
  const scenarioPlanTable = await loadArtifactByType(scenarioArtifacts, 'plan_table');

  // 8. Build and persist scenario_comparison artifact
  const comparisonPayload = buildScenarioComparison({
    baseRunId: Number(base_run_id),
    scenarioRunId: Number(scenarioRunId),
    overrides,
    baseReplayMetrics,
    baseSolverMeta,
    basePlanTable,
    scenarioReplayMetrics,
    scenarioSolverMeta,
    scenarioPlanTable
  });

  // Persist comparison artifact on the scenario run
  await saveJsonArtifact(
    scenarioRunId,
    'scenario_comparison',
    comparisonPayload,
    ARTIFACT_SIZE_THRESHOLD,
    { user_id: userId, filename: `scenario_comparison_run_${scenarioRunId}.json` }
  );

  notify('done', `Scenario completed (run #${scenarioRunId})`);

  return {
    scenarioRunId,
    comparisonPayload
  };
}

/**
 * Run a scenario end-to-end, updating the scenario record status.
 *
 * This is the public entry point called by the UI on "Run Scenario".
 *
 * @param {string} userId
 * @param {object} scenario  - di_scenarios record (must be in 'queued' status)
 * @param {Function} [onProgress]
 * @returns {object} updated scenario record
 */
export async function runScenario(userId, scenario, onProgress) {
  // Mark running
  await updateScenario(scenario.id, { status: 'running' });

  try {
    const { scenarioRunId } = await executeScenarioPlan({ userId, scenario, onProgress });

    const updated = await updateScenario(scenario.id, {
      status: 'succeeded',
      scenario_run_id: scenarioRunId,
      error_message: null
    });

    return updated;
  } catch (error) {
    const _updated = await updateScenario(scenario.id, {
      status: 'failed',
      error_message: error.message || 'Scenario execution failed'
    });
    throw error;
  }
}

export default {
  applyScenarioOverridesToPayload,
  buildConstraintsOverride,
  buildObjectiveOverride,
  executeScenarioPlan,
  runScenario
};
