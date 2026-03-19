/**
 * Closed-Loop Pipeline Orchestrator v0
 *
 * Full pipeline: evaluate triggers → derive params → apply patch → submit plan → persist audit.
 * Feature-flagged, opt-in, with dry_run as default mode.
 *
 * Modes:
 *   - dry_run: evaluate + report only (no rerun)
 *   - auto_run: rerun enabled (feature-flagged)
 *   - manual_approve: generate recommendation, require user approval to run
 */

import { CLOSED_LOOP_CONFIG, CLOSED_LOOP_STATUS } from './closedLoopConfig.js';
import { derivePlanningParams } from './forecastToPlanParams.js';
import { evaluateTriggers, getDefaultCooldownManager } from './triggerEngine.js';
import { closedLoopStore } from './closedLoopStore.js';
import { processIntake, INTAKE_SOURCES } from '../taskIntakeService.js';

// ─── Feature flag ─────────────────────────────────────────────────────────────

/**
 * Check if closed loop is enabled via env var or settings.
 *
 * @param {Object} settings - Workflow settings
 * @returns {boolean}
 */
export function isClosedLoopEnabled(settings = {}) {
  // Check env var (Vite-style)
  let envEnabled = false;
  try {
    const raw = import.meta.env?.VITE_DI_CLOSED_LOOP;
    envEnabled = raw === 'true' || raw === '1' || raw === true;
  } catch {
    // import.meta.env not available (e.g. test environment)
  }

  // Check settings overrides
  const settingsEnabled =
    settings?.closed_loop === 'on' ||
    settings?.closed_loop === true ||
    settings?.plan?.closed_loop === 'on' ||
    settings?.plan?.closed_loop === true;

  return envEnabled || settingsEnabled;
}

/**
 * Resolve the closed-loop mode from settings.
 */
function resolveMode(settings = {}, fallback = CLOSED_LOOP_CONFIG.default_mode) {
  return settings?.plan?.closed_loop_mode
    || settings?.closed_loop_mode
    || fallback;
}

// ─── Main orchestrator ────────────────────────────────────────────────────────

/**
 * runClosedLoop
 *
 * Full pipeline: evaluate triggers → derive params → optionally submit plan → audit.
 *
 * @param {Object} params
 * @param {string}        params.userId
 * @param {Object}        params.datasetProfileRow    - { id, ... }
 * @param {string|number} params.forecastRunId         - Current forecast run
 * @param {Object}        params.forecastBundle        - { series: [...], metrics: {...} }
 * @param {Object}        params.calibrationMeta       - { calibration_passed, coverage_10_90 } (nullable)
 * @param {Object}        params.previousForecast      - Previous forecast bundle (nullable)
 * @param {Object}        params.riskBundle            - { riskScores: [...] } (nullable)
 * @param {Object}        params.settings              - Workflow settings
 * @param {string}        params.mode                  - 'dry_run' | 'auto_run' | 'manual_approve' (override)
 * @param {Object}        params.configOverrides       - CLOSED_LOOP_CONFIG overrides
 * @param {Function}      params.planRunner            - Injected plan runner for testability (optional)
 * @param {Function}      params.artifactSaver         - Injected artifact saver for testability (optional)
 * @param {Object}        params.store                 - Injected store instance (optional, for testing)
 * @param {Object}        params.cooldownManager       - Injected cooldown manager (optional, for testing)
 *
 * @returns {Promise<ClosedLoopResult>}
 */
export async function runClosedLoop({
  userId,
  datasetProfileRow,
  forecastRunId,
  forecastBundle = {},
  calibrationMeta = null,
  previousForecast = null,
  riskBundle = null,
  settings = {},
  mode = null,
  configOverrides = {},
  // Dependency injection for testability
  planRunner = null,
  artifactSaver = null,
  store = null,
  cooldownManager = null
} = {}) {
  const effectiveStore = store || closedLoopStore;
  const effectiveMode = mode || resolveMode(settings);
  const config = { ...CLOSED_LOOP_CONFIG, ...configOverrides };

  // ── Step 0: Feature flag check ──────────────────────────────────────────────
  if (!isClosedLoopEnabled(settings)) {
    return {
      closed_loop_status: CLOSED_LOOP_STATUS.NOT_ENABLED,
      closed_loop_run_id: null,
      trigger_decision: null,
      param_patch: null,
      explanation: ['Closed loop is not enabled. Set VITE_DI_CLOSED_LOOP=true or settings.closed_loop="on".'],
      planning_run_id: null,
      planning_run_result: null,
      artifact_refs: {}
    };
  }

  // ── Step 1: Create audit record ─────────────────────────────────────────────
  const datasetId = datasetProfileRow?.id ?? null;
  const run = effectiveStore.createRun({
    dataset_id: datasetId,
    forecast_run_id: forecastRunId,
    mode: effectiveMode,
    trigger_facts: {
      calibration_meta: calibrationMeta,
      forecast_metrics: forecastBundle?.metrics ?? null,
      risk_summary: riskBundle
        ? { count: (riskBundle.riskScores || riskBundle.risk_scores || []).length }
        : null
    }
  });

  try {
    // ── Step 2: Evaluate triggers ───────────────────────────────────────────────
    const triggerDecision = evaluateTriggers({
      dataset_id: datasetId,
      forecast_run_id: forecastRunId,
      currentForecast: forecastBundle,
      previousForecast,
      calibrationMeta,
      riskBundle,
      configOverrides,
      cooldownManager: cooldownManager || getDefaultCooldownManager()
    });

    effectiveStore.updateRun(run.id, {
      trigger_decision: triggerDecision
    });

    // ── Step 3: No trigger → early return ───────────────────────────────────────
    if (!triggerDecision.should_trigger) {
      const status = triggerDecision.suppressed_by_cooldown
        ? CLOSED_LOOP_STATUS.COOLDOWN_SUPPRESSED
        : CLOSED_LOOP_STATUS.NO_TRIGGER;
      const explanation = triggerDecision.suppressed_by_cooldown
        ? ['Trigger detected but suppressed by cooldown window.']
        : ['No trigger conditions met. Planning parameters are stable.'];

      effectiveStore.updateRun(run.id, {
        status,
        finished_at: new Date().toISOString()
      });

      return {
        closed_loop_status: status,
        closed_loop_run_id: run.id,
        trigger_decision: triggerDecision,
        param_patch: null,
        explanation,
        planning_run_id: null,
        planning_run_result: null,
        artifact_refs: {}
      };
    }

    // ── Step 4: Derive planning parameter patch ─────────────────────────────────
    const paramPatch = derivePlanningParams({
      forecastBundle,
      calibrationMeta,
      riskBundle,
      previousForecast,
      policyConfig: configOverrides
    });

    effectiveStore.updateRun(run.id, {
      param_patch: paramPatch
    });

    // ── Step 5: Record cooldown ─────────────────────────────────────────────────
    const manager = cooldownManager || getDefaultCooldownManager();
    manager.record(triggerDecision.dedupe_key, config.default_cooldown_ms);

    effectiveStore.updateRun(run.id, {
      cooldown_key: triggerDecision.dedupe_key,
      cooldown_expires_at: new Date(Date.now() + config.default_cooldown_ms).toISOString()
    });

    // ── Step 6: Persist artifacts ───────────────────────────────────────────────
    const artifact_refs = {};
    if (artifactSaver && forecastRunId) {
      try {
        const auditRef = await artifactSaver(forecastRunId, 'closed_loop_audit', {
          version: 'v0',
          closed_loop_run_id: run.id,
          trigger_decision: triggerDecision,
          param_patch: paramPatch,
          mode: effectiveMode
        });
        if (auditRef) artifact_refs.closed_loop_audit = auditRef;

        const patchRef = await artifactSaver(forecastRunId, 'closed_loop_param_patch', paramPatch);
        if (patchRef) artifact_refs.closed_loop_param_patch = patchRef;
      } catch (saveErr) {
        // Non-fatal: audit trail in store is still valid
        console.warn('[closedLoopRunner] Artifact save failed:', saveErr.message);
      }
    }

    // ── Step 7: Mode-specific behavior ──────────────────────────────────────────
    if (effectiveMode === 'dry_run' || effectiveMode === 'manual_approve') {
      const status = CLOSED_LOOP_STATUS.TRIGGERED_DRY_RUN;
      effectiveStore.updateRun(run.id, {
        status,
        finished_at: new Date().toISOString()
      });

      return {
        closed_loop_status: status,
        closed_loop_run_id: run.id,
        trigger_decision: triggerDecision,
        param_patch: paramPatch,
        explanation: paramPatch.explanation || [],
        planning_run_id: null,
        planning_run_result: null,
        artifact_refs,
        requires_approval: effectiveMode === 'manual_approve'
      };
    }

    // ── Step 8: auto_run → submit planning rerun ────────────────────────────────
    if (effectiveMode === 'auto_run' && planRunner) {
      effectiveStore.updateRun(run.id, {
        status: CLOSED_LOOP_STATUS.RERUN_SUBMITTED
      });

      // ── Unified intake gate (dedup, routing, SLA) ──
      try {
        const intakeResult = await processIntake({
          source: INTAKE_SOURCES.CLOSED_LOOP,
          message: `Closed-loop auto-replan: ${(paramPatch.explanation || []).join('; ') || 'trigger conditions met'}`,
          employeeId: null,
          userId,
          metadata: {
            source_ref: 'closed_loop_auto_run',
            closed_loop_run_id: run.id,
            forecast_run_id: forecastRunId,
            param_patch: paramPatch,
          },
        });
        if (intakeResult?.status === 'duplicate') {
          effectiveStore.updateRun(run.id, {
            status: CLOSED_LOOP_STATUS.TRIGGERED_DRY_RUN,
            finished_at: new Date().toISOString()
          });
          return {
            closed_loop_status: CLOSED_LOOP_STATUS.TRIGGERED_DRY_RUN,
            closed_loop_run_id: run.id,
            trigger_decision: triggerDecision,
            param_patch: paramPatch,
            explanation: [...(paramPatch.explanation || []), 'Duplicate detected by intake pipeline; skipped rerun.'],
            planning_run_id: null,
            planning_run_result: null,
            artifact_refs
          };
        }
      } catch (intakeErr) {
        // Intake normalization is best-effort — proceed with planRunner
        console.warn('[ClosedLoop] Intake normalization failed (non-blocking):', intakeErr?.message);
      }

      const planResult = await planRunner({
        userId,
        datasetProfileRow,
        forecastRunId,
        objectiveOverride: paramPatch?.patch?.objective || null,
        settings: {
          ...settings,
          closed_loop_meta: {
            closed_loop_run_id: run.id,
            param_patch: paramPatch
          }
        }
      });

      const planningRunId = planResult?.run?.id ?? null;
      const planningStatus = planResult?.solver_result?.status ?? 'unknown';

      effectiveStore.updateRun(run.id, {
        status: CLOSED_LOOP_STATUS.RERUN_COMPLETED,
        planning_run_id: planningRunId,
        planning_run_status: planningStatus,
        outcome: {
          kpis: planResult?.solver_result?.kpis ?? null,
          status: planningStatus
        },
        finished_at: new Date().toISOString()
      });

      return {
        closed_loop_status: CLOSED_LOOP_STATUS.RERUN_COMPLETED,
        closed_loop_run_id: run.id,
        trigger_decision: triggerDecision,
        param_patch: paramPatch,
        explanation: paramPatch.explanation || [],
        planning_run_id: planningRunId,
        planning_run_result: planResult,
        artifact_refs
      };
    }

    // auto_run without planRunner → treat as dry_run
    effectiveStore.updateRun(run.id, {
      status: CLOSED_LOOP_STATUS.TRIGGERED_DRY_RUN,
      finished_at: new Date().toISOString()
    });

    return {
      closed_loop_status: CLOSED_LOOP_STATUS.TRIGGERED_DRY_RUN,
      closed_loop_run_id: run.id,
      trigger_decision: triggerDecision,
      param_patch: paramPatch,
      explanation: [
        ...paramPatch.explanation,
        'auto_run mode but no planRunner provided; reporting as dry_run.'
      ],
      planning_run_id: null,
      planning_run_result: null,
      artifact_refs
    };

  } catch (err) {
    effectiveStore.updateRun(run.id, {
      status: CLOSED_LOOP_STATUS.ERROR,
      error: err.message || String(err),
      finished_at: new Date().toISOString()
    });

    return {
      closed_loop_status: CLOSED_LOOP_STATUS.ERROR,
      closed_loop_run_id: run.id,
      trigger_decision: null,
      param_patch: null,
      explanation: [`Closed-loop evaluation error: ${err.message || err}`],
      planning_run_id: null,
      planning_run_result: null,
      artifact_refs: {}
    };
  }
}
