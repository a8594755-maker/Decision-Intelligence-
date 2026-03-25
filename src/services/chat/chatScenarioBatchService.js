/**
 * chatScenarioBatchService.js
 *
 * Multi-scenario batch execution engine (Gap 6B core).
 *
 * - Accepts an array of scenario definitions (name + overrides)
 * - Creates & runs them sequentially (avoids DB race conditions)
 * - Uses existing scenario_key dedup in diScenariosService
 * - Returns batch_result with per-scenario comparison + multi-scenario summary
 */

import { createScenario } from '../planning/diScenariosService';
import { runScenario } from '../planning/scenarioEngine';
import { diRunsService } from '../planning/diRunsService';
import { loadArtifact } from '../../utils/artifactStore';
import { buildMultiScenarioSummary } from '../../utils/buildMultiScenarioSummary';
import { recordScenarioRun } from '../planning/planAuditService';

// ── Constants ─────────────────────────────────────────────────────────────────

export const BATCH_MAX_SCENARIOS = 6;
export const BATCH_SCENARIO_TIMEOUT_MS = 120_000; // 2 min per scenario

// ── Helpers ───────────────────────────────────────────────────────────────────

async function loadComparisonArtifact(scenarioRunId) {
  if (!scenarioRunId) return null;
  try {
    const artifacts = await diRunsService.getArtifactsForRun(Number(scenarioRunId));
    const compRecord = artifacts?.find((a) => a.artifact_type === 'scenario_comparison');
    if (!compRecord) return null;
    return await loadArtifact({
      artifact_id: compRecord.id,
      ...(compRecord.artifact_json || {}),
    });
  } catch (err) {
    console.warn('[chatScenarioBatchService] loadComparisonArtifact failed:', err.message);
    return null;
  }
}

function runScenarioWithTimeout(userId, scenario, onProgress, timeoutMs) {
  return Promise.race([
    runScenario(userId, scenario, onProgress),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Scenario timeout after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);
}

function buildScenarioKpiSnapshot(comparison) {
  return {
    service_level: comparison?.kpis?.scenario?.service_level_proxy ?? null,
    total_cost: comparison?.kpis?.scenario?.estimated_total_cost ?? null,
    stockout_units: comparison?.kpis?.scenario?.stockout_units ?? null
  };
}

function buildScenarioNarrativeSummary(comparison) {
  return Array.isArray(comparison?.notes)
    ? comparison.notes.slice(0, 3).join(' | ')
    : '';
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * Run multiple What-If scenarios in sequence.
 *
 * @param {object}   params
 * @param {string}   params.userId
 * @param {number}   params.baseRunId
 * @param {Array}    params.scenarios - [{ name, overrides, engine_flags? }]
 * @param {Function} [params.onProgress] - ({ batchId, scenarioIndex, total, step, message })
 * @param {object}   [params.config]     - { maxScenarios?, timeoutMs? }
 * @returns {Promise<object>} batch result
 */
export async function batchRunScenarios({
  userId,
  baseRunId,
  scenarios = [],
  onProgress = null,
  config = {},
}) {
  if (!userId) throw new Error('userId is required');
  if (!baseRunId) throw new Error('baseRunId is required');

  const maxScenarios = config.maxScenarios ?? BATCH_MAX_SCENARIOS;
  const timeoutMs = config.timeoutMs ?? BATCH_SCENARIO_TIMEOUT_MS;

  const scenariosToRun = scenarios.slice(0, maxScenarios);
  const total = scenariosToRun.length;
  const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const notify = (scenarioIndex, step, message) => {
    onProgress?.({ batchId, scenarioIndex, total, step, message });
  };

  const results = [];

  for (let i = 0; i < scenariosToRun.length; i++) {
    const def = scenariosToRun[i];
    const startTime = Date.now();

    notify(i, 'create', `Creating scenario "${def.name}"\u2026`);

    const result = {
      index: i,
      name: def.name || `Scenario ${i + 1}`,
      overrides: def.overrides || {},
      engine_flags: def.engine_flags || {},
      status: 'failed',
      scenario_id: null,
      scenario_run_id: null,
      comparison: null,
      error: null,
      duration_ms: 0,
    };

    try {
      // Create (dedup by scenario_key)
      const { scenario } = await createScenario({
        user_id: userId,
        base_run_id: baseRunId,
        name: def.name || null,
        overrides: def.overrides || {},
        engine_flags: def.engine_flags || {},
      });

      result.scenario_id = scenario.id;

      // Cache hit — load existing comparison
      if (scenario.status === 'succeeded' && scenario.scenario_run_id) {
        notify(i, 'cached', `Scenario "${def.name}" loaded from cache.`);
        result.scenario_run_id = scenario.scenario_run_id;
        result.comparison = await loadComparisonArtifact(scenario.scenario_run_id);
        result.status = 'cached';
        if (result.comparison) {
          recordScenarioRun({
            userId,
            runId: baseRunId,
            scenarioId: scenario.id,
            overrides: def.overrides || {},
            kpiSnapshot: buildScenarioKpiSnapshot(result.comparison),
            narrativeSummary: buildScenarioNarrativeSummary(result.comparison)
          }).catch((err) => {
            console.warn('[chatScenarioBatchService] recordScenarioRun failed:', err.message);
          });
        }
        result.duration_ms = Date.now() - startTime;
        results.push(result);
        continue;
      }

      // Need execution (queued or previously failed)
      notify(i, 'optimize', `Running scenario "${def.name}"\u2026`);

      const updated = await runScenarioWithTimeout(
        userId,
        scenario,
        ({ step, message }) => notify(i, step, message),
        timeoutMs,
      );

      result.scenario_run_id = updated?.scenario_run_id ?? scenario.scenario_run_id;

      if (result.scenario_run_id) {
        notify(i, 'loading', `Loading comparison for "${def.name}"\u2026`);
        result.comparison = await loadComparisonArtifact(result.scenario_run_id);
      }

      result.status = updated?.status === 'succeeded' ? 'succeeded' : 'failed';
      if (updated?.error_message) result.error = updated.error_message;
    } catch (err) {
      result.status = 'failed';
      result.error = err.message;
      console.warn(`[chatScenarioBatchService] Scenario ${i} ("${def.name}") failed:`, err.message);
    }

    result.duration_ms = Date.now() - startTime;
    results.push(result);
    if ((result.status === 'succeeded' || result.status === 'cached') && result.comparison) {
      recordScenarioRun({
        userId,
        runId: baseRunId,
        scenarioId: result.scenario_id,
        overrides: result.overrides || {},
        kpiSnapshot: buildScenarioKpiSnapshot(result.comparison),
        narrativeSummary: buildScenarioNarrativeSummary(result.comparison)
      }).catch((err) => {
        console.warn('[chatScenarioBatchService] recordScenarioRun failed:', err.message);
      });
    }
    notify(i, 'done', `Scenario "${def.name}" ${result.status}.`);
  }

  // ── Multi-scenario summary ──────────────────────────────────────────────────
  const succeededResults = results.filter(
    (r) => (r.status === 'succeeded' || r.status === 'cached') && r.comparison,
  );

  const multiScenarioSummary = buildMultiScenarioSummary({
    baseRunId,
    results: succeededResults,
  });

  return {
    batch_id: batchId,
    base_run_id: baseRunId,
    total,
    succeeded: succeededResults.length,
    failed: results.filter((r) => r.status === 'failed').length,
    results,
    multi_scenario_summary: multiScenarioSummary,
    generated_at: new Date().toISOString(),
  };
}

// ── Intent → Scenario definitions ─────────────────────────────────────────────

/**
 * Convert a parsed LLM intent into concrete scenario definitions.
 *
 * @param {{ type: string, params: object }} intent
 * @returns {Array<{ name: string, overrides: object }>}
 */
export function buildScenariosFromIntent(intent = {}) {
  const { type, params = {} } = intent;

  switch (type) {
    case 'budget_comparison': {
      const budgets = Array.isArray(params.budgets) ? params.budgets : [];
      return budgets.map((b) => ({
        name: b == null ? 'No Budget Cap' : `Budget Cap $${Number(b).toLocaleString()}`,
        overrides: { budget_cap: b },
      }));
    }

    case 'service_level_comparison': {
      const targets = Array.isArray(params.targets) ? params.targets : [0.90, 0.95, 0.99];
      return targets.map((t) => ({
        name: `Service Target ${(t * 100).toFixed(0)}%`,
        overrides: { service_target: t },
      }));
    }

    case 'risk_comparison':
      return [
        { name: 'Base Plan', overrides: {} },
        { name: 'Risk-Aware Mode', overrides: { risk_mode: 'on' } },
        { name: 'Expedite Mode', overrides: { risk_mode: 'on', expedite_mode: 'on' } },
      ];

    case 'safety_stock_comparison': {
      const alphas = Array.isArray(params.alphas) ? params.alphas : [0, 0.5, 1.0];
      return alphas.map((a) => ({
        name: `Safety Stock \u03B1=${a}`,
        overrides: { safety_stock_alpha: a },
      }));
    }

    default:
      return [];
  }
}
