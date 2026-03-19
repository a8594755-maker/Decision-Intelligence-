/**
 * Negotiation Orchestrator - Step 9 Agentic Negotiation Loop v1
 *
 * Main entry point for the agentic negotiation loop. Orchestrates:
 *   1. Trigger detection
 *   2. Deterministic option generation
 *   3. Artifact persistence (negotiation_options)
 *   3.5. CFR game-theory enrichment (GTO strategy weights)
 *   4. Scenario re-solve for each option (negotiation_evaluation)
 *   5. LLM explanation with evidence-first validation (negotiation_report)
 *
 * Backward compatible: called only when trigger conditions are met.
 * Normal workflow runs are unchanged.
 * CFR enrichment is additive: if unavailable, cfr_influence = 0 → pure fallback.
 */

import { generateNegotiationOptions, detectTrigger } from './negotiationOptionsGenerator';
import { evaluateNegotiationOptions } from './negotiationEvaluator';
import { buildNegotiationReport } from './negotiationReportBuilder';
import { saveJsonArtifact, loadArtifact } from '../../utils/artifactStore';
import { diRunsService } from '../diRunsService';
import { getLookupService } from './cfr/negotiation-lookup-service.js';
import { computePositionBucket } from './cfr/negotiation-position-buckets.js';
import { DEFAULT_CFR_INFLUENCE, computeSupplierTypePriors } from './cfr/negotiation-types.js';
import { deriveSolverParamsFromStrategy, applyCfrAdjustments, buildAdjustmentArtifact } from './cfr/cfr-solver-bridge.js';
import { generateAllDrafts, buildDraftContext } from './cfr/negotiation-draft-generator.js';
import { getStateTracker } from './cfr/negotiation-state-tracker.js';
import * as negotiationPersistence from '../negotiationPersistenceService.js';

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
 * Remove entries older than the cooldown period to prevent unbounded growth.
 */
function _pruneRecentTriggers(cooldownMs = NEGOTIATION_COOLDOWN_MS) {
  const now = Date.now();
  for (const [key, ts] of _recentTriggers) {
    if (now - new Date(ts).getTime() >= cooldownMs) {
      _recentTriggers.delete(key);
    }
  }
}

/**
 * Returns true if this (planRunId, trigger) pair is within the cooldown window.
 */
function isCooldownActive(planRunId, trigger, cooldownMs = NEGOTIATION_COOLDOWN_MS) {
  _pruneRecentTriggers(cooldownMs);
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
  // Try to get MOQ from solver_meta proof if available
  const solverProofConstraints = Array.isArray(solverMeta?.proof?.constraints_checked)
    ? solverMeta.proof.constraints_checked
    : [];

  const optionsPayload = generateNegotiationOptions({
    solverMeta: solverMeta || {},
    constraintCheck: constraintCheck || {},
    replayMetrics: replayMetrics || {},
    userIntent,
    baseRunId: runId,
    baseConstraints: { moq: null, proof_constraints: solverProofConstraints },
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
  // Step 3.5: CFR Game-Theory Enrichment (additive, zero-regression)
  // -------------------------------------------------------------------------
  let cfrEnrichment = null;
  try {
    const lookupService = getLookupService();
    if (lookupService.isLoaded) {
      // Derive buyer position bucket from risk signals
      const riskScore = datasetProfileRow?.risk_score ?? null;
      const { bucket: buyerBucket } = computePositionBucket({
        risk_score: riskScore,
      });

      // Auto-detect nearest scenario from supplier KPIs
      const supplierKpis = datasetProfileRow?.supplier_kpis || {};
      const scenarioId = lookupService.findNearestScenario(supplierKpis);

      if (scenarioId) {
        // Build the buyer's OPENING info key for initial strategy lookup
        const openingInfoKey = `B|${buyerBucket}|OPENING|`;

        const cfrResult = lookupService.computeOptionWeights({
          scenarioId,
          buyerBucket,
          infoKey: openingInfoKey,
          options: optionsPayload.options,
          kpis: supplierKpis,
        });

        if (cfrResult.available) {
          // Attach CFR weights to each option for display/artifact persistence.
          // Note: cfr_weight is informational — the actual solver adjustments flow
          // through cfrParamAdjustment → evaluateNegotiationOptions → objectiveOverride.
          for (const option of optionsPayload.options) {
            option.cfr_weight = cfrResult.cfr_weights[option.option_id] ?? null;
          }

          cfrEnrichment = {
            scenario_id: scenarioId,
            buyer_bucket: buyerBucket,
            cfr_action_probs: cfrResult.cfr_action_probs,
            cfr_influence: DEFAULT_CFR_INFLUENCE,
            source: cfrResult.source,
          };

          optionsPayload.cfr_enrichment = cfrEnrichment;
        }
      }
    }
  } catch (cfrErr) {
    // CFR enrichment is non-critical — log and continue
    console.warn(
      '[negotiationOrchestrator] CFR enrichment failed (non-critical):',
      cfrErr?.message
    );
  }

  // -------------------------------------------------------------------------
  // Step 3.5b: CFR → Solver Parameter Bridge (derives solver adjustments)
  // -------------------------------------------------------------------------
  let cfrParamAdjustment = null;
  if (cfrEnrichment) {
    try {
      const supplierKpis = datasetProfileRow?.supplier_kpis || {};
      const supplierPriors = computeSupplierTypePriors(supplierKpis);

      const adjustment = deriveSolverParamsFromStrategy({
        cfrActionProbs: cfrEnrichment.cfr_action_probs,
        supplierTypePriors: supplierPriors,
        positionBucket: cfrEnrichment.buyer_bucket,
      });

      if (adjustment.safety_stock_alpha_multiplier !== 1.0 ||
          adjustment.stockout_penalty_multiplier !== 1.0) {
        cfrParamAdjustment = adjustment;
        optionsPayload.cfr_param_adjustment = {
          supplier_assessment: adjustment.supplier_assessment,
          safety_stock_alpha_multiplier: adjustment.safety_stock_alpha_multiplier,
          stockout_penalty_multiplier: adjustment.stockout_penalty_multiplier,
          dual_source_flag: adjustment.dual_source_flag,
          confidence: adjustment.confidence,
          reason: adjustment.adjustment_reason,
        };
      }
    } catch (bridgeErr) {
      console.warn(
        '[negotiationOrchestrator] CFR solver bridge failed (non-critical):',
        bridgeErr?.message
      );
    }
  }

  // -------------------------------------------------------------------------
  // Step 3.6: Initialize negotiation state tracker (multi-round tracking)
  // -------------------------------------------------------------------------
  let negotiationId = null;
  try {
    const stateTracker = getStateTracker();
    const riskScore = datasetProfileRow?.risk_score ?? null;
    const supplierKpis = datasetProfileRow?.supplier_kpis || {};

    const negState = stateTracker.startNegotiation({
      planRunId: runId,
      trigger,
      riskScore: riskScore ?? 100,
      supplierKpis,
      scenarioId: cfrEnrichment?.scenario_id || null,
    });

    negotiationId = negState.negotiation_id;
  } catch (stateErr) {
    console.warn(
      '[negotiationOrchestrator] State tracker init failed (non-critical):',
      stateErr?.message
    );
  }

  // -------------------------------------------------------------------------
  // Step 3.7: Persist negotiation case to Supabase (durable storage)
  // -------------------------------------------------------------------------
  let persistedCaseId = null;
  try {
    const riskScore = datasetProfileRow?.risk_score ?? null;
    const supplierKpis = datasetProfileRow?.supplier_kpis || {};
    const { bucket: buyerBucket, name: bucketName } = computePositionBucket({
      risk_score: riskScore,
    });

    const persistedCase = await negotiationPersistence.createCase(userId, {
      planRunId: runId,
      trigger,
      buyerPosition: { bucket: buyerBucket, name: bucketName, risk_score: riskScore },
      scenarioId: cfrEnrichment?.scenario_id || null,
      supplierKpis,
    });
    persistedCaseId = persistedCase?.id || null;
  } catch (persistErr) {
    console.warn(
      '[negotiationOrchestrator] Case persistence failed (non-critical):',
      persistErr?.message
    );
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
      userId,
      cfrParamAdjustment: cfrParamAdjustment || null,
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

  // -------------------------------------------------------------------------
  // Step 9: Generate email drafts for negotiation action card (non-blocking)
  // -------------------------------------------------------------------------
  let negotiationDrafts = [];
  let actionCardPayload = null;
  try {
    const supplierKpis = datasetProfileRow?.supplier_kpis || {};
    const draftContext = buildDraftContext({
      cfrEnrichment,
      solverMeta: solverMeta || {},
      replayMetrics: replayMetrics || {},
      supplierKpis,
      userIntent,
      datasetProfileRow: datasetProfileRow || {},
      trigger,
    });

    negotiationDrafts = await generateAllDrafts(draftContext);

    // Build action card payload for UI rendering
    const posLabels = ['VERY_WEAK', 'WEAK', 'NEUTRAL', 'STRONG', 'VERY_STRONG'];
    const posStrength = cfrEnrichment
      ? posLabels[Math.max(0, Math.min(cfrEnrichment.buyer_bucket, posLabels.length - 1))] || 'NEUTRAL'
      : null;

    actionCardPayload = {
      negotiation_id: negotiationId,
      cfr_strategy: cfrEnrichment ? {
        cfr_action_probs: cfrEnrichment.cfr_action_probs,
        position_strength: posStrength,
        exploitability: null, // available via cfr_negotiation_strategy artifact
        scenario_id: cfrEnrichment.scenario_id,
        source: cfrEnrichment.source,
      } : null,
      drafts: negotiationDrafts,
      options: optionsPayload.options,
      trigger,
      planRunId: runId,
    };
  } catch (draftErr) {
    console.warn(
      '[negotiationOrchestrator] Draft generation failed (non-critical):',
      draftErr?.message
    );
  }

  // -------------------------------------------------------------------------
  // Step 10: Persist negotiation state artifact (multi-round tracking)
  // -------------------------------------------------------------------------
  if (negotiationId) {
    try {
      const stateTracker = getStateTracker();
      const stateArtifact = stateTracker.exportAsArtifact(negotiationId);
      if (stateArtifact) {
        const stateSaved = await saveJsonArtifact(
          runId,
          'cfr_negotiation_state',
          stateArtifact,
          ARTIFACT_SIZE_THRESHOLD,
          {
            user_id: userId,
            filename: `cfr_negotiation_state_run_${runId}.json`,
          }
        );
        artifactRefs.cfr_negotiation_state = stateSaved.ref;
      }
    } catch (stateErr) {
      console.warn(
        '[negotiationOrchestrator] State artifact persist failed (non-critical):',
        stateErr?.message
      );
    }
  }

  // -------------------------------------------------------------------------
  // Step 10b: Persist CFR parameter adjustment artifact (audit trail)
  // -------------------------------------------------------------------------
  if (cfrParamAdjustment) {
    try {
      const baseParams = {
        safety_stock_alpha: solverMeta?.solver_meta?.safety_stock_alpha ?? 0.5,
        stockout_penalty_base: solverMeta?.solver_meta?.stockout_penalty_base ?? 10.0,
      };
      const adjustedParams = applyCfrAdjustments(baseParams, cfrParamAdjustment);
      const adjustmentArtifact = buildAdjustmentArtifact({
        adjustment: cfrParamAdjustment,
        baseParams,
        adjustedParams,
        cfrEnrichment,
        planRunId: runId,
      });

      const adjSaved = await saveJsonArtifact(
        runId,
        'cfr_param_adjustment',
        adjustmentArtifact,
        ARTIFACT_SIZE_THRESHOLD,
        {
          user_id: userId,
          filename: `cfr_param_adjustment_run_${runId}.json`,
        }
      );
      artifactRefs.cfr_param_adjustment = adjSaved.ref;
    } catch (adjErr) {
      console.warn(
        '[negotiationOrchestrator] CFR param adjustment artifact persist failed (non-critical):',
        adjErr?.message
      );
    }
  }

  // Record trigger for cooldown/dedupe
  recordTriggerEvent(runId, trigger);

  return {
    triggered: true,
    trigger,
    negotiation_options: optionsPayload,
    negotiation_evaluation: evaluationPayload,
    negotiation_report: reportPayload,
    cfr_enrichment: cfrEnrichment,
    negotiation_action_card: actionCardPayload,
    persisted_case_id: persistedCaseId,
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

// ---------------------------------------------------------------------------
// Exported: onNegotiationResolved
// ---------------------------------------------------------------------------

/**
 * Handle a resolved negotiation case: derive constraint patches, create
 * scenario re-run, and emit the negotiation_outcome_applied artifact.
 *
 * This is the closed-loop bridge between negotiation outcomes and planning.
 *
 * @param {Object} params
 * @param {string}        params.caseId             - resolved case ID
 * @param {string}        params.userId             - authenticated user ID
 * @param {Object}        [params.datasetProfileRow] - dataset profile for re-solve
 * @param {string|number} [params.forecastRunId]     - forecast run for re-solve
 * @param {string}        [params.appliedOptionId]   - which negotiation option was applied
 * @param {Object}        [params.optionOverrides]   - snapshot of option overrides
 * @param {Object}        [params.optionEngineFlags] - snapshot of option engine_flags
 * @returns {Promise<{
 *   success: boolean,
 *   patches: Object,
 *   explanations: string[],
 *   should_replan: boolean,
 *   scenario_run_id: string|number|null,
 *   artifact_ref: Object|null,
 *   error: string|null
 * }>}
 */
export async function onNegotiationResolved({
  caseId,
  userId,
  datasetProfileRow = null,
  forecastRunId = null,
  appliedOptionId = null,
  optionOverrides = null,
  optionEngineFlags = null,
} = {}) {
  if (!caseId) throw new Error('caseId is required');
  if (!userId) throw new Error('userId is required');
  if (appliedOptionId && !optionOverrides) {
    console.warn(`[negotiationOrchestrator] onNegotiationResolved called with appliedOptionId="${appliedOptionId}" but no optionOverrides — patch derivation will use fallback defaults`);
  }

  try {
    // Step 1: Load resolved case with events
    const caseData = await negotiationPersistence.getCaseWithEvents(caseId);
    if (!caseData) {
      return {
        success: false, patches: {}, explanations: [],
        should_replan: false, scenario_run_id: null,
        artifact_ref: null, error: `Case ${caseId} not found`,
      };
    }

    // Step 2: Derive constraint patches
    const { deriveConstraintPatch } = await import('./negotiationOutcomeTranslator.js');
    const patchResult = deriveConstraintPatch({
      status: caseData.status,
      outcome: caseData.outcome || {},
      applied_option_id: appliedOptionId,
      option_overrides: optionOverrides,
      option_engine_flags: optionEngineFlags,
      events: caseData.events || [],
      trigger: caseData.trigger,
    });

    // Step 3: Persist the negotiation_outcome_applied artifact
    let artifactRef = null;
    const planRunId = caseData.plan_run_id;
    if (planRunId) {
      const artifactPayload = {
        version: 'v0',
        generated_at: nowIso(),
        case_id: caseId,
        plan_run_id: planRunId,
        status: caseData.status,
        trigger: caseData.trigger,
        applied_option_id: appliedOptionId,
        applied_patches: patchResult.patches,
        explanations: patchResult.explanations,
        rules: patchResult.rules,
        should_replan: patchResult.should_replan,
        replan_reason: patchResult.replan_reason,
      };

      try {
        const saved = await saveJsonArtifact(
          planRunId,
          'negotiation_outcome_applied',
          artifactPayload,
          ARTIFACT_SIZE_THRESHOLD,
          { user_id: userId, filename: `negotiation_outcome_applied_run_${planRunId}.json` }
        );
        artifactRef = saved.ref;
      } catch (saveErr) {
        console.warn('[negotiationOrchestrator] Outcome artifact save failed:', saveErr?.message);
      }
    }

    // Step 4: Trigger scenario re-run if patches warrant it
    let scenarioRunId = null;
    if (patchResult.should_replan && planRunId && datasetProfileRow) {
      try {
        const { executeScenario } = await import('../scenarioEngine.js');
        const scenarioResult = await executeScenario({
          userId,
          baseRunId: planRunId,
          overrides: {
            ...patchResult.patches.constraints,
            ...patchResult.patches.objective,
          },
          engineFlags: patchResult.patches.engine_flags || {},
          datasetProfileRow,
          forecastRunId,
          scenarioLabel: `Negotiation outcome (${caseData.trigger})`,
          source: 'negotiation_outcome',
        });
        scenarioRunId = scenarioResult?.scenario_run_id ?? null;
      } catch (scenErr) {
        console.warn('[negotiationOrchestrator] Scenario re-run failed (non-critical):', scenErr?.message);
      }
    }

    return {
      success: true,
      patches: patchResult.patches,
      explanations: patchResult.explanations,
      should_replan: patchResult.should_replan,
      scenario_run_id: scenarioRunId,
      artifact_ref: artifactRef,
      error: null,
    };
  } catch (err) {
    console.error('[negotiationOrchestrator] onNegotiationResolved failed:', err);
    return {
      success: false,
      patches: {},
      explanations: [],
      should_replan: false,
      scenario_run_id: null,
      artifact_ref: null,
      error: err?.message || String(err),
    };
  }
}

export default {
  runNegotiation,
  loadNegotiationResults,
  checkNegotiationTrigger,
  onNegotiationResolved,
  _resetCooldownState
};
