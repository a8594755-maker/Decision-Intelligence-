/**
 * workflowBClosedLoopBridge.js
 *
 * Bridge layer: Workflow B (risk workflow) completion → evaluate whether
 * Workflow A (replenishment) needs closed-loop re-parameterization.
 *
 * Gap 8D: closes the loop between the two workflow engines.
 *
 * Trigger strategies:
 *   'notify_only'   → Push chat notification only, no auto-rerun (default, conservative)
 *   'auto_run'      → Trigger runClosedLoop(mode='auto_run')
 *   'disabled'      → No-op
 *
 * Design:
 *   - Non-blocking: failures don't affect Workflow B completion
 *   - Cooldown: prevents same profile from triggering repeatedly
 *   - Degradable: if no forecast run exists, falls back to notify_only
 */

import { runClosedLoop, isClosedLoopEnabled } from './index.js';
import { diRunsService } from '../diRunsService';
// import { loadArtifact } from '../../utils/artifactStore';
import { runPlanFromDatasetProfile } from '../chatPlanningService';

// ── Constants ─────────────────────────────────────────────────────────────────

export const BRIDGE_MODES = {
  NOTIFY_ONLY: 'notify_only',
  AUTO_RUN:    'auto_run',
  DISABLED:    'disabled',
};

const BRIDGE_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

function isBridgeCooledDown(userId, profileId) {
  try {
    const key = `cl_bridge_cooldown_${userId}_${profileId}`;
    const last = Number(sessionStorage.getItem(key) || 0);
    return Date.now() - last < BRIDGE_COOLDOWN_MS;
  } catch {
    return false;
  }
}

function markBridgeCooldown(userId, profileId) {
  try {
    sessionStorage.setItem(`cl_bridge_cooldown_${userId}_${profileId}`, String(Date.now()));
  } catch {
    // ignore
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Load risk_scores from a Workflow B run's artifacts.
 */
async function loadRiskScoresFromWorkflowB(workflowBRunId) {
  if (!workflowBRunId) return null;
  try {
    const artifacts = await diRunsService.getArtifactsForRun(Number(workflowBRunId));
    const riskArt = (artifacts || []).find((a) => a.artifact_type === 'risk_scores');
    const rows = Array.isArray(riskArt?.artifact_json?.rows)
      ? riskArt.artifact_json.rows
      : [];
    if (rows.length === 0) return null;
    return { riskScores: rows };
  } catch (e) {
    console.warn('[workflowBClosedLoopBridge] Failed to load risk_scores:', e.message);
    return null;
  }
}

/**
 * Find the latest Workflow A forecast run for a given dataset profile.
 */
async function findLatestForecastRun(userId, datasetProfileId) {
  if (!userId || !datasetProfileId) return null;
  try {
    return await diRunsService.getLatestRunByStage(userId, {
      stage: 'forecast',
      status: 'succeeded',
      dataset_profile_id: datasetProfileId,
      workflow: 'workflow_A_replenishment',
      limit: 1,
    });
  } catch {
    return null;
  }
}

/**
 * Load forecast bundle from a run's artifacts.
 */
async function loadForecastBundle(forecastRunId) {
  if (!forecastRunId) return null;
  try {
    const artifacts = await diRunsService.getArtifactsForRun(Number(forecastRunId));
    const seriesArt  = (artifacts || []).find((a) => a.artifact_type === 'forecast_series');
    const metricsArt = (artifacts || []).find((a) => a.artifact_type === 'metrics');
    if (!seriesArt?.artifact_json) return null;
    return {
      series: seriesArt.artifact_json.series || [],
      metrics: metricsArt?.artifact_json || {},
    };
  } catch {
    return null;
  }
}

// ── Main entry ────────────────────────────────────────────────────────────────

/**
 * Evaluate whether Workflow A should be re-parameterized after Workflow B completes.
 *
 * @param {Object} params
 * @param {string}   params.userId
 * @param {number}   params.workflowBRunId     - Just-completed Workflow B run
 * @param {number}   params.datasetProfileId
 * @param {Object}   params.datasetProfileRow
 * @param {Object}   params.settings           - User settings (includes closed_loop_mode)
 * @param {string}   params.bridgeMode         - 'notify_only' | 'auto_run' | 'disabled'
 * @param {Function} params.onNotify           - (type, payload) => void  Chat notification callback
 *
 * @returns {Object} { triggered, closed_loop_status, param_patch, planning_run_id, error }
 */
export async function evaluateClosedLoopAfterWorkflowB({
  userId,
  workflowBRunId,
  datasetProfileId,
  datasetProfileRow,
  settings = {},
  bridgeMode = BRIDGE_MODES.NOTIFY_ONLY,
  onNotify = null,
}) {
  const result = {
    triggered: false,
    closed_loop_status: 'NOT_EVALUATED',
    param_patch: null,
    planning_run_id: null,
    error: null,
  };

  if (bridgeMode === BRIDGE_MODES.DISABLED) {
    return result;
  }

  if (!isClosedLoopEnabled(settings)) {
    return result;
  }

  if (isBridgeCooledDown(userId, datasetProfileId)) {
    result.closed_loop_status = 'COOLDOWN';
    return result;
  }

  try {
    // 1. Load Workflow B risk_scores
    const riskBundle = await loadRiskScoresFromWorkflowB(workflowBRunId);
    if (!riskBundle?.riskScores?.length) {
      result.closed_loop_status = 'NO_RISK_DATA';
      return result;
    }

    const highRiskCount = riskBundle.riskScores.filter(
      (r) => Number(r.risk_score ?? 0) > 60
    ).length;

    if (highRiskCount === 0) {
      result.closed_loop_status = 'NO_TRIGGER';
      return result;
    }

    // 2. Find latest forecast run
    const latestForecastRun = await findLatestForecastRun(userId, datasetProfileId);
    const forecastBundle = await loadForecastBundle(latestForecastRun?.id);

    if (!forecastBundle && !latestForecastRun) {
      // No forecast data — can only notify, can't re-plan
      if (onNotify) {
        onNotify('risk_alert', {
          type: 'risk_alert_no_forecast',
          high_risk_count: highRiskCount,
          message: `${highRiskCount} high-risk supplier(s) detected. Run a forecast first to enable automatic re-planning.`,
          risk_scores: riskBundle.riskScores.slice(0, 5),
        });
      }
      result.triggered = true;
      result.closed_loop_status = 'TRIGGERED_NO_FORECAST';
      return result;
    }

    // 3. Run closed-loop evaluation
    const effectiveMode = bridgeMode === BRIDGE_MODES.AUTO_RUN
      ? 'auto_run'
      : 'dry_run';

    const closedLoopResult = await runClosedLoop({
      userId,
      datasetProfileRow,
      forecastRunId: latestForecastRun?.id,
      forecastBundle: forecastBundle || { series: [], metrics: {} },
      calibrationMeta: forecastBundle?.metrics?.calibration_meta || null,
      previousForecast: null,
      riskBundle,
      settings,
      mode: effectiveMode,
      configOverrides: settings?.closed_loop_config || {},
      planRunner: effectiveMode === 'auto_run'
        ? async (plannerParams) => runPlanFromDatasetProfile({
            userId,
            datasetProfileRow,
            forecastRunId: latestForecastRun?.id,
            objectiveOverride: plannerParams.objectiveOverride,
            constraintsOverride: plannerParams.constraintsOverride,
            settings: plannerParams.settings,
          })
        : null,
    });

    result.triggered          = closedLoopResult.trigger_decision?.should_trigger || false;
    result.closed_loop_status = closedLoopResult.closed_loop_status;
    result.param_patch        = closedLoopResult.param_patch;
    result.planning_run_id    = closedLoopResult.planning_run_id;

    // 4. Mark cooldown
    if (result.triggered) {
      markBridgeCooldown(userId, datasetProfileId);
    }

    // 5. Push notification
    if (result.triggered && onNotify) {
      onNotify('risk_trigger', {
        closed_loop_status:  closedLoopResult.closed_loop_status,
        trigger_decision:    closedLoopResult.trigger_decision,
        param_patch:         closedLoopResult.param_patch,
        planning_run_id:     closedLoopResult.planning_run_id,
        requires_approval:   closedLoopResult.requires_approval || false,
        high_risk_count:     highRiskCount,
      });
    }

  } catch (err) {
    result.error = err.message;
    console.warn('[workflowBClosedLoopBridge] Error during evaluation:', err.message);
  }

  return result;
}
