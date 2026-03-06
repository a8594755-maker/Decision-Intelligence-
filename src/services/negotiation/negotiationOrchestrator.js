/**
 * Negotiation Orchestrator - Step 9 Agentic Negotiation Loop v0
 *
 * Main entry point for the agentic negotiation loop. Orchestrates:
 *   1. Trigger detection
 *   2. Deterministic option generation
 *   3. Artifact persistence (negotiation_options)
 *   4. Scenario re-solve for each option (negotiation_evaluation)
 *   5. LLM explanation with evidence-first validation (negotiation_report)
 *
 * Backward compatible: called only when trigger conditions are met.
 * Normal workflow runs are unchanged.
 */

import { generateNegotiationOptions, detectTrigger } from './negotiationOptionsGenerator';
import { evaluateNegotiationOptions } from './negotiationEvaluator';
import { buildNegotiationReport } from './negotiationReportBuilder';
import { saveJsonArtifact, loadArtifact } from '../../utils/artifactStore';
import { diRunsService } from '../diRunsService';

const ARTIFACT_SIZE_THRESHOLD = 200 * 1024;
const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Cooldown & dedupe — mirrors Python retrain_triggers pattern
// ---------------------------------------------------------------------------

/** Default cooldown: suppress re-trigger within this window (ms) */
const NEGOTIATION_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * In-memory store of recent negotiation trigger events.
 * Key = `${planRunId}::${trigger}`, value = ISO timestamp.
 * Cleared on process restart (intentional — persistence via artifacts).
 */
const _recentTriggers = new Map();

/**
 * Returns true if this (planRunId, trigger) pair is within the cooldown window.
 */
function isCooldownActive(planRunId, trigger, cooldownMs = NEGOTIATION_COOLDOWN_MS) {
  const key = `${planRunId}::${trigger}`;
  const lastTs = _recentTriggers.get(key);
  if (!lastTs) return false;
  return Date.now() - new Date(lastTs).getTime() < cooldownMs;
}

/**
 * Record that a negotiation was triggered for this (planRunId, trigger).
 */
function recordTriggerEvent(planRunId, trigger) {
  const key = `${planRunId}::${trigger}`;
  _recentTriggers.set(key, nowIso());
}

/** Exported for testing */
export function _resetCooldownState() {
  _recentTriggers.clear();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const toNumber = (v, fallback = null) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const getLatestArtifactByType = (artifacts, type) => {
  const matches = (Array.isArray(artifacts) ? artifacts : []).filter(
    (a) => a.artifact_type === type
  );
  if (matches.length === 0) return null;
  return [...matches].sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0];
};

const loadArtifactByType = async (planRunId, type) => {
  const artifacts = await diRunsService.getArtifactsForRun(planRunId);
  const record = getLatestArtifactByType(artifacts, type);
  if (!record) return null;
  return loadArtifact({ artifact_id: record.id, ...(record.artifact_json || {}) });
};

/**
 * Extract user intent (service_target, budget_cap) from workflow settings.
 *
 * @param {Object} workflowSettings - from workflow_settings artifact
 * @returns {{ service_target: number|null, budget_cap: number|null }}
 */
function extractUserIntent(workflowSettings = {}) {
  const settings = workflowSettings?.settings || workflowSettings || {};
  const plan = settings?.plan || {};
  const objective = plan?.objective || settings?.objective || {};
  const constraints = plan?.constraints || settings?.constraints || {};

  return {
    service_target:
      toNumber(objective?.service_level_target) ??
      toNumber(settings?.service_level_target),
    budget_cap:
      toNumber(constraints?.budget_cap) ??
      toNumber(settings?.budget_cap)
  };
}

/**
 * Load the negotiation trigger state for a plan run.
 * Returns trigger if already stored in negotiation_options artifact,
 * otherwise recomputes from plan artifacts.
 *
 * @param {number} planRunId
 * @returns {Promise<'infeasible'|'kpi_shortfall'|null>}
 */
export async function checkNegotiationTrigger(planRunId) {
  if (!planRunId) return null;

  const [solverMeta, replayMetrics, existingOptions, workflowSettings] =
    await Promise.all([
      loadArtifactByType(planRunId, 'solver_meta'),
      loadArtifactByType(planRunId, 'replay_metrics'),
      loadArtifactByType(planRunId, 'negotiation_options'),
      loadArtifactByType(planRunId, 'workflow_settings')
    ]);

  // If options already generated, return stored trigger
  if (existingOptions?.trigger) return existingOptions.trigger;

  const userIntent = extractUserIntent(workflowSettings || {});
  return detectTrigger(solverMeta || {}, replayMetrics || {}, userIntent);
}

// ---------------------------------------------------------------------------
// Exported: runNegotiation
// ---------------------------------------------------------------------------

/**
 * Run the full agentic negotiation loop for a plan run.
 *
 * @param {Object} params
 * @param {string}        params.userId            - authenticated user ID
 * @param {string|number} params.planRunId         - the plan/optimize child run ID
 * @param {Object}        params.datasetProfileRow - dataset profile row
 * @param {number|null}   params.forecastRunId     - forecast child run ID
 * @param {Object}        params.config            - optional threshold config overrides
 * @returns {Promise<{
 *   triggered: boolean,
 *   trigger: string|null,
 *   negotiation_options: Object|null,
 *   negotiation_evaluation: Object|null,
 *   negotiation_report: Object|null,
 *   artifact_refs: Object
 * }>}
 */
export async function runNegotiation({
  userId,
  planRunId,
  datasetProfileRow,
  forecastRunId = null,
  config = {},
  bypassFeatureFlag = false
}) {
  if (!userId) throw new Error('userId is required');
  if (!planRunId) throw new Error('planRunId is required');

  // Feature flag: auto-rerun gated by env var (default OFF)
  // Bypass when explicitly triggered from UI (user clicked "Generate Options")
  if (!bypassFeatureFlag) {
    const autoRerunEnabled =
      typeof import.meta?.env?.VITE_DI_ENABLE_AUTO_RERUN === 'string'
        ? import.meta.env.VITE_DI_ENABLE_AUTO_RERUN === 'true'
        // eslint-disable-next-line no-undef
        : typeof process !== 'undefined' && process.env?.DI_ENABLE_AUTO_RERUN === 'true';

    if (!autoRerunEnabled) {
      return {
        triggered: false,
        trigger: null,
        negotiation_options: null,
        negotiation_evaluation: null,
        negotiation_report: null,
        artifact_refs: {},
        suppressed_reason: 'feature_flag_off'
      };
    }
  }

  const runId = Number(planRunId);
  const artifactRefs = {};

  // -------------------------------------------------------------------------
  // Step 1: Load base run artifacts
  // -------------------------------------------------------------------------
  const [
    solverMeta,
    constraintCheck,
    replayMetrics,
    workflowSettings
  ] = await Promise.all([
    loadArtifactByType(runId, 'solver_meta'),
    loadArtifactByType(runId, 'constraint_check'),
    loadArtifactByType(runId, 'replay_metrics'),
    loadArtifactByType(runId, 'workflow_settings')
  ]);

  const userIntent = extractUserIntent(workflowSettings || {});

  // -------------------------------------------------------------------------
  // Step 2: Detect trigger
  // -------------------------------------------------------------------------
  const trigger = detectTrigger(
    solverMeta || {},
    replayMetrics || {},
    userIntent,
    config
  );

  if (!trigger) {
    return {
      triggered: false,
      trigger: null,
      negotiation_options: null,
      negotiation_evaluation: null,
      negotiation_report: null,
      artifact_refs: {}
    };
  }

  // Cooldown guard: suppress re-trigger within the cooldown window
  if (isCooldownActive(runId, trigger)) {
    return {
      triggered: false,
      trigger,
      negotiation_options: null,
      negotiation_evaluation: null,
      negotiation_report: null,
      artifact_refs: {},
      suppressed_reason: 'cooldown'
    };
  }

  // -------------------------------------------------------------------------
  // Step 3: Generate candidate options (deterministic, pure)
  // -------------------------------------------------------------------------
  // Extract base MOQ constraints for concrete override computation
  const baseMoqRows = Array.isArray(constraintCheck?.violations)
    ? null  // We don't have original constraints from constraint_check
    : null;

  // Try to get MOQ from solver_meta proof if available
  const solverProofConstraints = Array.isArray(solverMeta?.proof?.constraints_checked)
    ? solverMeta.proof.constraints_checked
    : [];

  const baseConstraints = {
    moq: null,  // Cannot reliably reconstruct from artifacts; engine_flags path used
    proof_constraints: solverProofConstraints
  };

  const optionsPayload = generateNegotiationOptions({
    solverMeta: solverMeta || {},
    constraintCheck: constraintCheck || {},
    replayMetrics: replayMetrics || {},
    userIntent,
    baseRunId: runId,
    baseConstraints,
    config
  });

  if (!optionsPayload || optionsPayload.options.length === 0) {
    return {
      triggered: true,
      trigger,
      negotiation_options: null,
      negotiation_evaluation: null,
      negotiation_report: null,
      artifact_refs: {}
    };
  }

  // -------------------------------------------------------------------------
  // Step 4: Persist negotiation_options artifact
  // -------------------------------------------------------------------------
  const optionsSaved = await saveJsonArtifact(
    runId,
    'negotiation_options',
    optionsPayload,
    ARTIFACT_SIZE_THRESHOLD,
    {
      user_id: userId,
      filename: `negotiation_options_run_${runId}.json`
    }
  );
  artifactRefs.negotiation_options = optionsSaved.ref;

  // -------------------------------------------------------------------------
  // Step 5: Evaluate each option by re-solving
  // -------------------------------------------------------------------------
  const baseKpis = solverMeta?.kpis || {};

  let evaluationPayload;
  try {
    evaluationPayload = await evaluateNegotiationOptions({
      baseRunId: runId,
      baseKpis,
      baseConstraintCheck: constraintCheck || {},
      baseReplayMetrics: replayMetrics || {},
      options: optionsPayload.options,
      datasetProfileRow,
      forecastRunId,
      userId
    });
  } catch (evalErr) {
    console.error(
      '[negotiationOrchestrator] Evaluation failed:',
      evalErr?.message
    );
    evaluationPayload = {
      base_run_id: runId,
      ranked_options: optionsPayload.options.map((opt) => ({
        option_id: opt.option_id,
        scenario_run_id: null,
        status: 'failed',
        kpis: { base: baseKpis, scenario: {}, delta: {} },
        constraints_summary: { violations_delta: null },
        rank_score: 1e12,
        notes: [`Evaluation error: ${evalErr?.message || 'unknown'}`],
        evidence_refs: opt.evidence_refs || []
      })),
      ranking_method:
        'lexicographic: feasibility -> service_delta -> cost_delta -> constraint_violations'
    };
  }

  // -------------------------------------------------------------------------
  // Step 6: Persist negotiation_evaluation artifact
  // -------------------------------------------------------------------------
  const evaluationSaved = await saveJsonArtifact(
    runId,
    'negotiation_evaluation',
    evaluationPayload,
    ARTIFACT_SIZE_THRESHOLD,
    {
      user_id: userId,
      filename: `negotiation_evaluation_run_${runId}.json`
    }
  );
  artifactRefs.negotiation_evaluation = evaluationSaved.ref;

  // -------------------------------------------------------------------------
  // Step 7: Build LLM negotiation report (evidence-first)
  // -------------------------------------------------------------------------
  const allEvidenceRefs = [
    ...new Set(
      optionsPayload.options.flatMap((o) => o.evidence_refs || [])
    )
  ];

  let reportPayload;
  try {
    reportPayload = await buildNegotiationReport({
      baseRunId: runId,
      rankedOptions: evaluationPayload.ranked_options || [],
      intent: userIntent,
      evidenceRefs: allEvidenceRefs
    });
  } catch (reportErr) {
    console.warn(
      '[negotiationOrchestrator] Report generation failed:',
      reportErr?.message
    );
    reportPayload = {
      version: 'v0',
      generated_at: nowIso(),
      base_run_id: runId,
      summary: `Negotiation analysis completed. Trigger: ${trigger}. See ranked options for details.`,
      recommended_option_id:
        evaluationPayload.ranked_options?.[0]?.option_id || null,
      bullet_reasons: ['See negotiation_evaluation artifact for computed details.'],
      generated_by: 'emergency_fallback',
      evidence_validated: false,
      evidence_refs: allEvidenceRefs
    };
  }

  // -------------------------------------------------------------------------
  // Step 8: Persist negotiation_report artifact
  // -------------------------------------------------------------------------
  const reportSaved = await saveJsonArtifact(
    runId,
    'negotiation_report',
    reportPayload,
    ARTIFACT_SIZE_THRESHOLD,
    {
      user_id: userId,
      filename: `negotiation_report_run_${runId}.json`
    }
  );
  artifactRefs.negotiation_report = reportSaved.ref;

  // Record trigger for cooldown/dedupe
  recordTriggerEvent(runId, trigger);

  return {
    triggered: true,
    trigger,
    negotiation_options: optionsPayload,
    negotiation_evaluation: evaluationPayload,
    negotiation_report: reportPayload,
    artifact_refs: artifactRefs
  };
}

// ---------------------------------------------------------------------------
// Exported: loadNegotiationResults
// ---------------------------------------------------------------------------

/**
 * Load existing negotiation artifacts for a plan run (if already computed).
 *
 * @param {number} planRunId
 * @returns {Promise<{
 *   negotiation_options: Object|null,
 *   negotiation_evaluation: Object|null,
 *   negotiation_report: Object|null
 * }>}
 */
export async function loadNegotiationResults(planRunId) {
  if (!planRunId) {
    return {
      negotiation_options: null,
      negotiation_evaluation: null,
      negotiation_report: null
    };
  }

  const [optionsPayload, evaluationPayload, reportPayload] = await Promise.all([
    loadArtifactByType(planRunId, 'negotiation_options'),
    loadArtifactByType(planRunId, 'negotiation_evaluation'),
    loadArtifactByType(planRunId, 'negotiation_report')
  ]);

  return {
    negotiation_options: optionsPayload || null,
    negotiation_evaluation: evaluationPayload || null,
    negotiation_report: reportPayload || null
  };
}

export default {
  runNegotiation,
  loadNegotiationResults,
  checkNegotiationTrigger,
  _resetCooldownState
};
