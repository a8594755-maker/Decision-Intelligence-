// @product: ai-employee
//
// aiEmployeeExecutor.js
// ─────────────────────────────────────────────────────────────────────────────
// Accepts a task row and drives it through the DI core engines.
// Pure async logic — no React, no UI dependencies.
//
// Execution flow:
//   1. Create run
//   2. Task → in_progress, employee → working
//   3. Dispatch to forecast / plan / risk engine
//   4. Run → succeeded, task → waiting_review, employee → waiting_review
//   5. Write worklog entry
//   [error] → run failed, task → blocked, employee → blocked, write escalation log
// ─────────────────────────────────────────────────────────────────────────────

import { runForecastFromDatasetProfile } from './chatForecastService';
import { runPlanFromDatasetProfile } from './chatPlanningService';
import { computeRiskArtifactsFromDatasetProfile } from './chatRiskService';
import { datasetProfilesService } from './datasetProfilesService';
import * as aiEmployeeService from './aiEmployeeService';

// ── Input context shape (documented for task creation forms) ────────────────
//
// task.input_context = {
//   workflow_type: 'forecast' | 'plan' | 'risk',
//   dataset_profile_id: string,       // required
//   riskMode: 'on' | 'off',           // plan only, default 'off'
//   scenario_overrides: object|null,  // plan only, default null
//   horizonPeriods: number|null,      // forecast only, default null
//   settings: object,                 // passed through to DI engines
// }

// ─────────────────────────────────────────────────────────────────────────────

function buildSummary(workflowType, result) {
  if (!result) return `${workflowType} run completed.`;

  switch (workflowType) {
    case 'forecast': {
      const metrics = result.metrics;
      if (metrics?.mae !== undefined) {
        return `Forecast completed. MAE: ${Number(metrics.mae).toFixed(2)}, MAPE: ${Number(metrics.mape ?? 0).toFixed(1)}%.`;
      }
      return 'Forecast completed.';
    }
    case 'plan': {
      const meta = result.solver_meta || result.run;
      if (meta?.items_planned !== undefined) {
        return `Replenishment plan completed. ${meta.items_planned} items planned.`;
      }
      return 'Replenishment plan completed.';
    }
    case 'risk': {
      const scores = result.risk_scores || [];
      const high = scores.filter((s) => s.risk_score >= 0.7).length;
      return `Risk analysis completed. ${scores.length} items assessed, ${high} high-risk.`;
    }
    default:
      return `${workflowType} run completed.`;
  }
}

function extractArtifactRefs(workflowType, result) {
  if (!result) return [];
  if (result.artifact_refs && Array.isArray(result.artifact_refs)) {
    return result.artifact_refs;
  }
  // risk service returns structured data but stores artifacts internally
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute a task end-to-end.
 *
 * @param {object} task  - Row from ai_employee_tasks
 * @param {string} userId - Authenticated user ID
 * @returns {Promise<{ run: object, result: object }>}
 */
export async function executeTask(task, userId) {
  const { workflow_type, dataset_profile_id, riskMode, scenario_overrides, horizonPeriods, settings } =
    task.input_context || {};

  if (!workflow_type) throw new Error('task.input_context.workflow_type is required');
  if (!dataset_profile_id) throw new Error('task.input_context.dataset_profile_id is required');

  // ── 1. Create run ──────────────────────────────────────────────────────────
  const run = await aiEmployeeService.createRun(task.id, task.employee_id);

  // ── 2. Transition: todo/blocked → in_progress ─────────────────────────────
  await aiEmployeeService.updateTaskStatus(task.id, 'in_progress', run.id);
  await aiEmployeeService.updateEmployeeStatus(task.employee_id, 'working');

  try {
    // ── 3. Resolve dataset profile ───────────────────────────────────────────
    const profileRow = await datasetProfilesService.getDatasetProfileById(userId, dataset_profile_id);
    if (!profileRow) {
      throw new Error(`Dataset profile not found: ${dataset_profile_id}`);
    }

    // ── 4. Dispatch to DI engine ─────────────────────────────────────────────
    let result;
    switch (workflow_type) {
      case 'forecast':
        result = await runForecastFromDatasetProfile({
          userId,
          datasetProfileRow: profileRow,
          horizonPeriods: horizonPeriods ?? null,
          settings: settings || {},
        });
        break;

      case 'plan':
        result = await runPlanFromDatasetProfile({
          userId,
          datasetProfileRow: profileRow,
          riskMode: riskMode || 'off',
          scenarioOverrides: scenario_overrides ?? null,
          settings: settings || {},
        });
        break;

      case 'risk':
        result = await computeRiskArtifactsFromDatasetProfile({
          userId,
          datasetProfileRow: profileRow,
        });
        break;

      default:
        throw new Error(`Unknown workflow_type: ${workflow_type}`);
    }

    // ── 5. Capture di_run_id for cross-product traceability ──────────────────
    const diRunId = result?.run?.id ?? null;

    // ── 6. Resolve artifact refs ─────────────────────────────────────────────
    const artifactRefs = extractArtifactRefs(workflow_type, result);

    // ── 7. Build human-readable summary ─────────────────────────────────────
    const summary = buildSummary(workflow_type, result);

    // ── 8. Update run → succeeded ────────────────────────────────────────────
    const updatedRun = await aiEmployeeService.updateRun(run.id, {
      status: 'succeeded',
      summary,
      artifact_refs: artifactRefs,
      ended_at: new Date().toISOString(),
      di_run_id: diRunId,
    });

    // ── 9. Transition: in_progress → waiting_review ──────────────────────────
    await aiEmployeeService.updateTaskStatus(task.id, 'waiting_review', run.id);
    await aiEmployeeService.updateEmployeeStatus(task.employee_id, 'waiting_review');

    // ── 10. Write worklog ────────────────────────────────────────────────────
    await aiEmployeeService.appendWorklog(
      task.employee_id,
      task.id,
      run.id,
      'task_update',
      {
        previous_status: 'in_progress',
        new_status: 'waiting_review',
        note: `Completed ${workflow_type} analysis. ${artifactRefs.length} artifact(s) generated.`,
        datasets_used: [dataset_profile_id],
        artifacts_generated: artifactRefs.length,
      }
    );

    return { run: updatedRun || { ...run, status: 'succeeded', summary, artifact_refs: artifactRefs }, result };

  } catch (err) {
    const errorMessage = err?.message || String(err);

    // Mark run failed
    await aiEmployeeService.updateRun(run.id, {
      status: 'failed',
      error_message: errorMessage,
      ended_at: new Date().toISOString(),
    });

    // Transition: in_progress → blocked
    await aiEmployeeService.updateTaskStatus(task.id, 'blocked', run.id);
    await aiEmployeeService.updateEmployeeStatus(task.employee_id, 'blocked');

    // Write escalation log
    await aiEmployeeService.appendWorklog(
      task.employee_id,
      task.id,
      run.id,
      'escalation',
      {
        issue: errorMessage,
        severity: 'high',
        workflow_type,
        dataset_profile_id,
      }
    );

    throw err;
  }
}

export default { executeTask };
