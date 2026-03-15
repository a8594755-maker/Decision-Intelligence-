// @product: ai-employee
//
// @deprecated — Use src/services/aiEmployee/orchestrator.js + executors/ instead.
// This file is kept for backward compatibility with agentLoopService.js.
// It will be removed once agentLoopService is fully retired.
//
// aiEmployeeExecutor.js
// ─────────────────────────────────────────────────────────────────────────────
// LEGACY executor. Accepts a task row and drives it through the DI core engines.
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
import { checkPermission } from './toolPermissionGuard';
import { writeMemory, extractOutcomeKpis, extractInputParams } from './aiEmployeeMemoryService';
import { resolveModel, recordModelRun } from './modelRoutingService';
import { checkBudget, consumeBudget, BudgetExceededError } from './taskBudgetService';
import { notify, NOTIFICATION_TYPES } from './notificationService';
import { generateAndExecuteTool, generateCodeAndExecute, executeRegisteredTool } from './dynamicToolExecutor';
import { generateReport } from './reportGeneratorService';
import { toPowerBIDataset } from './externalToolBridgeService';
import { getBuiltinTool } from './builtinToolCatalog';

function toServiceImportPath(modulePath) {
  return `${modulePath}${modulePath.endsWith('.js') ? '' : '.js'}`;
}

// ── Input context shape (documented for task creation forms) ────────────────
//
// task.input_context = {
//   workflow_type: 'forecast' | 'plan' | 'risk' | 'synthesize',
//   dataset_profile_id: string,       // required (except synthesize)
//   riskMode: 'on' | 'off',           // plan only, default 'off'
//   scenario_overrides: object|null,  // plan only, default null
//   horizonPeriods: number|null,      // forecast only, default null
//   settings: object,                 // passed through to DI engines
//   _prior_step_artifacts: object,    // injected by agent loop: { step_name: artifact_refs[] }
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
    case 'synthesize': {
      const syn = result.synthesis || {};
      return `Synthesis completed. ${syn.total_artifacts || 0} artifact(s) from ${(syn.sources || []).length} step(s).`;
    }
    case 'dynamic_tool': {
      const dtool = result?.dynamic_tool;
      return `Dynamic tool executed. ${dtool?.artifact_refs?.length || 0} artifact(s) generated.`;
    }
    case 'registered_tool': {
      const rtool = result?.registered_tool;
      return `Registered tool executed. ${rtool?.artifact_refs?.length || 0} artifact(s) generated.`;
    }
    case 'python_tool': {
      const pt = result?.python_tool;
      const artCount = pt?.artifacts?.length || result?.artifact_refs?.length || 0;
      const totalRows = pt?.metadata?.total_rows || 0;
      return `Python tool executed. ${artCount} artifact(s), ${totalRows} total rows. ${pt?.metadata?.description || ''}`.trim();
    }
    case 'python_report': {
      const pr = result?.python_report;
      const hasPdf = !!pr?.pdf_base64;
      const hasHtml = !!pr?.html_preview;
      return `Report generated (${[hasPdf && 'PDF', hasHtml && 'HTML'].filter(Boolean).join('+') || 'unknown'} format).`;
    }
    case 'report':
      return `Report generated (${result?.report?.format || 'unknown'} format).`;
    case 'export':
      return `Export completed (${result?.export?.format || 'unknown'} format).`;
    case 'builtin_tool':
      return `Built-in tool completed. ${result?.artifact_refs?.length || 0} artifact(s) generated.`;
    case 'excel_ops': {
      const eo = result?.excel_ops;
      return `Excel workbook built: ${eo?.count || 0} operations across ${eo?.sheets?.length || 0} sheets. Batch: ${eo?.batch_id || 'unknown'}.`;
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
  const NO_DATASET_TYPES = ['synthesize', 'dynamic_tool', 'registered_tool', 'report', 'export', 'builtin_tool', 'python_tool', 'python_report', 'excel_ops'];
  if (!dataset_profile_id && !NO_DATASET_TYPES.includes(workflow_type)) {
    throw new Error('task.input_context.dataset_profile_id is required');
  }

  // ── 0. Permission check ─────────────────────────────────────────────────
  const employee = await aiEmployeeService.getEmployee(task.employee_id);
  checkPermission(employee, workflow_type);

  const _execStartMs = Date.now();

  // ── 0.5. Resolve model routing (best-effort, informational) ────────────────
  let _routingDecision = null;
  try {
    const memCtx = task.input_context?._memory_context || null;
    _routingDecision = await resolveModel(workflow_type, {
      retryCount: task._retry_count || 0,
      highRisk: riskMode === 'on',
      memoryContext: memCtx,
    });
  } catch { /* routing is advisory, not blocking */ }

  // ── 0.7. Budget check ──────────────────────────────────────────────────────
  const _budgetCheck = await checkBudget(task.id, {
    isPremium: _routingDecision?.tier === 'tier_a',
  });
  if (!_budgetCheck.allowed) {
    throw new BudgetExceededError(task.id, _budgetCheck.reason, _budgetCheck.budget);
  }

  // ── 1. Create run ──────────────────────────────────────────────────────────
  const run = await aiEmployeeService.createRun(task.id, task.employee_id, {
    step_index: task._step_index,
    step_name: task._step_name,
  });

  // ── 2. Transition: todo/blocked → in_progress ─────────────────────────────
  await aiEmployeeService.updateTaskStatus(task.id, 'in_progress', run.id);
  await aiEmployeeService.updateEmployeeStatus(task.employee_id, 'working');

  try {
    // ── 3. Resolve dataset profile (not needed for synthesize/dynamic/report/export) ──
    let profileRow = null;
    if (!NO_DATASET_TYPES.includes(workflow_type)) {
      profileRow = await datasetProfilesService.getDatasetProfileById(userId, dataset_profile_id);
      if (!profileRow) {
        throw new Error(`Dataset profile not found: ${dataset_profile_id}`);
      }
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
        // Auto-run forecast first if plan requires it
        try {
          result = await runPlanFromDatasetProfile({
            userId,
            datasetProfileRow: profileRow,
            riskMode: riskMode || 'off',
            scenarioOverrides: scenario_overrides ?? null,
            settings: settings || {},
          });
        } catch (planErr) {
          if (planErr?.message?.includes('No forecast artifacts')) {
            // Run forecast silently, then retry plan
            await runForecastFromDatasetProfile({
              userId,
              datasetProfileRow: profileRow,
              horizonPeriods: null,
              settings: settings || {},
            });
            result = await runPlanFromDatasetProfile({
              userId,
              datasetProfileRow: profileRow,
              riskMode: riskMode || 'off',
              scenarioOverrides: scenario_overrides ?? null,
              settings: settings || {},
            });
          } else {
            throw planErr;
          }
        }
        break;

      case 'risk':
        result = await computeRiskArtifactsFromDatasetProfile({
          userId,
          datasetProfileRow: profileRow,
        });
        break;

      case 'synthesize': {
        // Aggregate artifact refs from prior agent loop steps (no LLM, deterministic)
        const priorArtifacts = task.input_context?._prior_step_artifacts || {};
        const allRefs = Object.values(priorArtifacts).flat();
        result = {
          synthesis: {
            sources: Object.keys(priorArtifacts),
            total_artifacts: allRefs.length,
            generated_at: new Date().toISOString(),
          },
          artifact_refs: allRefs,
        };
        break;
      }

      case 'dynamic_tool': {
        const existingCode = task.input_context?._tool_code || null;
        const toolArgs = {
          toolHint: task.input_context?._tool_hint || null,
          inputData: task.input_context?._input_data || {},
          priorArtifacts: task.input_context?._prior_step_artifacts || {},
          revisionInstructions: task.input_context?._revision_instructions || [],
          datasetProfile: task.input_context?._dataset_profile || null,
          // Self-healing context
          modelOverride: task.input_context?._model_override || null,
          simplifiedHint: task.input_context?._simplified_hint || null,
        };
        // If code is pre-generated, execute directly; otherwise generate via LLM first
        const toolResult = existingCode
          ? await generateAndExecuteTool({ ...toolArgs, code: existingCode })
          : await generateCodeAndExecute({ ...toolArgs, trackingMeta: { taskId: task.id, employeeId: task.employee_id, agentRole: 'dynamic_tool' } });
        result = {
          dynamic_tool: toolResult,
          artifact_refs: toolResult.artifact_refs || [],
        };
        break;
      }

      case 'registered_tool': {
        const toolId = task.input_context?._tool_id;
        if (!toolId) throw new Error('registered_tool requires _tool_id in input_context');
        const regResult = await executeRegisteredTool(toolId, task.input_context || {});
        result = {
          registered_tool: regResult,
          artifact_refs: regResult.artifact_refs || [],
        };
        break;
      }

      case 'report': {
        const priorArtifactsForReport = task.input_context?._prior_step_artifacts || {};
        const reportResult = await generateReport({
          format: task.input_context?.report_format || 'html',
          artifacts: priorArtifactsForReport,
          taskMeta: { id: task.id, title: task.title },
          narrative: task.input_context?._narrative || null,
          revisionLog: task.input_context?._revision_log || null,
          runId: task.id,
        });
        result = {
          report: reportResult,
          artifact_refs: reportResult.artifact_ref ? [reportResult.artifact_ref] : [],
        };
        break;
      }

      case 'export': {
        const exportFormat = task.input_context?.export_format || 'powerbi';
        const priorArtifactsForExport = task.input_context?._prior_step_artifacts || {};
        if (exportFormat === 'powerbi') {
          const pbiResult = toPowerBIDataset(priorArtifactsForExport);
          result = {
            export: pbiResult,
            artifact_refs: pbiResult.artifact_ref ? [pbiResult.artifact_ref] : [],
          };
        } else {
          // Default: pass through to report generator with xlsx format
          const xlsxResult = await generateReport({
            format: 'xlsx',
            artifacts: priorArtifactsForExport,
            taskMeta: { id: task.id, title: task.title },
            runId: task.id,
          });
          result = {
            export: xlsxResult,
            artifact_refs: xlsxResult.artifact_ref ? [xlsxResult.artifact_ref] : [],
          };
        }
        break;
      }

      case 'python_tool': {
        const ML_API_URL = import.meta.env.VITE_ML_API_URL || 'http://localhost:8000';
        // Build llm_config from routing decision
        const ptLlmConfig = _routingDecision ? {
          provider: _routingDecision.provider || 'gemini',
          model: _routingDecision.model_name || null,
          ...((_routingDecision.provider === 'openai' && /^(gpt-5|o[34])/.test(_routingDecision.model_name || ''))
            ? { reasoning_effort: 'medium' }
            : {}),
        } : undefined;
        const ptResponse = await fetch(`${ML_API_URL}/execute-tool`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tool_hint: task.input_context?._tool_hint || task.title || '',
            input_data: task.input_context?._input_data || {},
            prior_artifacts: task.input_context?._prior_step_artifacts || {},
            dataset_profile: task.input_context?._dataset_profile || null,
            revision_instructions: task.input_context?._revision_instructions || null,
            llm_config: ptLlmConfig,
          }),
        });
        if (!ptResponse.ok) {
          const errText = await ptResponse.text().catch(() => 'Unknown error');
          throw new Error(`Python execute-tool failed (${ptResponse.status}): ${errText}`);
        }
        const ptData = await ptResponse.json();
        if (!ptData.ok) {
          throw new Error(`Python tool execution failed: ${ptData.error || 'Unknown error'}`);
        }
        result = {
          python_tool: ptData,
          artifact_refs: (ptData.artifacts || []).map((a) => ({
            type: a.type,
            label: a.label,
            data: a.data,
          })),
        };
        break;
      }

      case 'python_report': {
        const ML_API_URL_R = import.meta.env.VITE_ML_API_URL || 'http://localhost:8000';
        const prResponse = await fetch(`${ML_API_URL_R}/generate-report`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            artifacts: task.input_context?._prior_step_artifacts || {},
            report_format: task.input_context?.report_format || 'pdf',
            task_title: task.title || 'Business Report',
            insights: task.input_context?._insights || null,
            kpis: task.input_context?._kpis || null,
            narrative: task.input_context?._narrative || null,
          }),
        });
        if (!prResponse.ok) {
          const errText = await prResponse.text().catch(() => 'Unknown error');
          throw new Error(`Python generate-report failed (${prResponse.status}): ${errText}`);
        }
        const prData = await prResponse.json();
        if (!prData.ok) {
          throw new Error(`Report generation failed: ${prData.error || 'Unknown error'}`);
        }
        result = {
          python_report: prData,
          artifact_refs: (prData.artifacts || []).map((a) => ({
            type: a.type,
            label: a.label,
            data: a.data,
          })),
        };
        break;
      }

      case 'builtin_tool': {
        // Generic dispatch through the builtin tool catalog.
        // The catalog entry tells us which module/method to call.
        const builtinToolId = task.input_context?._builtin_tool_id;
        if (!builtinToolId) throw new Error('builtin_tool requires _builtin_tool_id in input_context');

        const catalogEntry = getBuiltinTool(builtinToolId);
        if (!catalogEntry) throw new Error(`Unknown builtin tool: ${builtinToolId}`);

        // Resolve dataset profile if the tool needs one
        let builtinProfileRow = profileRow;
        if (catalogEntry.needs_dataset_profile && !builtinProfileRow) {
          if (!dataset_profile_id) {
            throw new Error(`Builtin tool "${builtinToolId}" requires a dataset profile, but no dataset has been uploaded or selected.`);
          }
          builtinProfileRow = await datasetProfilesService.getDatasetProfileById(userId, dataset_profile_id);
          if (!builtinProfileRow) {
            throw new Error(`Dataset profile not found: ${dataset_profile_id}`);
          }
        }

        // Dynamically import the module and call the method
        const mod = await import(/* @vite-ignore */ toServiceImportPath(catalogEntry.module));
        const fn = mod[catalogEntry.method];
        if (typeof fn !== 'function') {
          throw new Error(`Builtin tool ${builtinToolId}: method "${catalogEntry.method}" not found in ${catalogEntry.module}`);
        }

        // Build args based on what the tool expects
        const builtinArgs = {
          userId,
          datasetProfileRow: builtinProfileRow,
          settings: settings || {},
          ...(task.input_context?._tool_params || {}),
          _prior_step_artifacts: task.input_context?._prior_step_artifacts || {},
        };

        // Add common optional params
        if (riskMode) builtinArgs.riskMode = riskMode;
        if (scenario_overrides) builtinArgs.scenarioOverrides = scenario_overrides;
        if (horizonPeriods) builtinArgs.horizonPeriods = horizonPeriods;

        result = await fn(builtinArgs);
        break;
      }

      case 'excel_ops': {
        // Build Excel operation commands from prior step artifacts and push to queue.
        // The Excel Add-in polls for these ops and executes them via Office.js.
        const { buildMbrOps } = await import('./excelOpsTemplates');
        const { pushExcelOps } = await import('./excelOpsService');
        const priorArtifactsForExcel = task.input_context?._prior_step_artifacts || {};
        const excelMeta = {
          title: task.title || 'Monthly Business Review',
          period: task.input_context?.period || new Date().toISOString().slice(0, 7),
        };
        const excelOps = buildMbrOps(task.id, userId, priorArtifactsForExcel, excelMeta);
        const pushResult = await pushExcelOps(task.id, userId, excelOps);
        result = {
          excel_ops: {
            batch_id: pushResult.batch_id,
            count: pushResult.count,
            sheets: ['MBR_Cover', 'MBR_KPIs', 'MBR_Cleaned_Data', 'MBR_Data_Issues',
                     'MBR_Forecast', 'MBR_Plan', 'MBR_Risk', 'MBR_Analysis', 'MBR_Dashboard'],
          },
          artifact_refs: [],
        };
        break;
      }

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

    // ── 8.5. Record model routing (best-effort) ───────────────────────────────
    if (_routingDecision) {
      try {
        await recordModelRun({
          taskId: task.id,
          runId: run.id,
          employeeId: task.employee_id,
          agentRole: 'executor',
          provider: _routingDecision.provider,
          modelName: _routingDecision.model,
          tier: _routingDecision.tier,
          inputTokens: result?.usage?.input_tokens || 0,
          outputTokens: result?.usage?.output_tokens || 0,
          latencyMs: Date.now() - _execStartMs,
          stepName: task._step_name || null,
          escalatedFrom: _routingDecision.escalatedFrom,
        });
      } catch { /* model run tracking is best-effort */ }
    }

    // ── 8.7. Consume budget (best-effort) ────────────────────────────────────
    try {
      await consumeBudget(task.id, {
        cost: result?.usage?.estimated_cost || 0,
        tokens: (result?.usage?.input_tokens || 0) + (result?.usage?.output_tokens || 0),
        isPremium: _routingDecision?.tier === 'tier_a',
        isStep: true,
      });
    } catch { /* budget tracking is best-effort */ }

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

    // ── 11. Write task memory (best-effort) ──────────────────────────────────
    try {
      await writeMemory({
        employeeId: task.employee_id,
        taskId: task.id,
        runId: run.id,
        workflowType: workflow_type,
        success: true,
        outcomeSummary: summary,
        outcomeKpis: extractOutcomeKpis(workflow_type, result),
        inputParams: extractInputParams(task.input_context),
        artifactsGenerated: artifactRefs.length,
        executionTimeMs: Date.now() - _execStartMs,
        retryCount: 0,
        datasetFingerprint: profileRow?.fingerprint || null,
        datasetProfileId: dataset_profile_id,
        templateId: task.input_context?.template_id || null,
      });
    } catch (memErr) { console.warn('[aiEmployeeExecutor] writeMemory failed:', memErr?.message); }

    // ── 11.5. OpenCloud auto-sync (best-effort) ──────────────────────────
    try {
      const { AUTO_SYNC_ENABLED, isOpenCloudConfigured } = await import('../config/opencloudConfig');
      if (AUTO_SYNC_ENABLED && isOpenCloudConfigured()) {
        const { syncTaskOutputsToOpenCloud, getDefaultDriveId } = await import('./opencloudArtifactSync');
        const driveId = await getDefaultDriveId();
        if (driveId) {
          await syncTaskOutputsToOpenCloud(task.id, driveId, { artifactRefs });
        }
      }
    } catch (ocErr) { console.warn('[aiEmployeeExecutor] OpenCloud sync failed:', ocErr?.message); }

    // ── 12. Notify: task completed (best-effort) ──────────────────────────
    try {
      const emp = await aiEmployeeService.getEmployee(task.employee_id);
      if (emp?.manager_user_id) {
        await notify({
          userId: emp.manager_user_id,
          employeeId: task.employee_id,
          type: NOTIFICATION_TYPES.TASK_COMPLETED,
          title: `Task completed: ${task.title || workflow_type}`,
          body: { summary, artifact_count: artifactRefs.length },
          taskId: task.id,
        });
      }
    } catch { /* notification is best-effort */ }

    return { run: updatedRun || { ...run, status: 'succeeded', summary, artifact_refs: artifactRefs }, result };

  } catch (err) {
    const errorMessage = err?.message || String(err);
    console.error('[aiEmployeeExecutor] Task failed:', errorMessage);

    // Mark run failed — each step is wrapped individually so one failure doesn't block the rest
    try {
      await aiEmployeeService.updateRun(run.id, {
        status: 'failed',
        error_message: errorMessage,
        ended_at: new Date().toISOString(),
      });
    } catch (e) { console.error('[aiEmployeeExecutor] updateRun failed:', e?.message); }

    // Transition: in_progress → blocked
    try {
      const updatedTask = await aiEmployeeService.updateTaskStatus(task.id, 'blocked', run.id);
      console.log('[aiEmployeeExecutor] Task status set to blocked:', updatedTask?.status);
    } catch (e) { console.error('[aiEmployeeExecutor] updateTaskStatus failed:', e?.message); }

    try {
      await aiEmployeeService.updateEmployeeStatus(task.employee_id, 'blocked');
    } catch (e) { console.error('[aiEmployeeExecutor] updateEmployeeStatus failed:', e?.message); }

    // Write escalation log
    try {
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
    } catch (e) { console.error('[aiEmployeeExecutor] appendWorklog failed:', e?.message); }

    // Write failure memory (best-effort)
    try {
      await writeMemory({
        employeeId: task.employee_id,
        taskId: task.id,
        runId: run.id,
        workflowType: workflow_type,
        success: false,
        errorMessage: errorMessage,
        inputParams: extractInputParams(task.input_context),
        executionTimeMs: Date.now() - _execStartMs,
        datasetProfileId: dataset_profile_id,
        templateId: task.input_context?.template_id || null,
      });
    } catch (memErr) { console.warn('[aiEmployeeExecutor] writeMemory (failure) failed:', memErr?.message); }

    // Notify: task failed (best-effort)
    try {
      const emp = await aiEmployeeService.getEmployee(task.employee_id);
      if (emp?.manager_user_id) {
        await notify({
          userId: emp.manager_user_id,
          employeeId: task.employee_id,
          type: NOTIFICATION_TYPES.TASK_FAILED,
          title: `Task failed: ${task.title || workflow_type}`,
          body: { error: errorMessage },
          taskId: task.id,
        });
      }
    } catch { /* notification is best-effort */ }

    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent Loop wrapper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute a task using the agent loop if it has a template,
 * or fall back to single-step execution.
 *
 * @param {object} task - Row from ai_employee_tasks
 * @param {string} userId
 * @param {object} [opts] - { onStepComplete, signal }
 * @returns {Promise<object>}
 */
/**
 * @deprecated Use orchestrator.submitPlan() + orchestrator.approvePlan() instead.
 * This shim delegates to the v2 orchestrator when possible, falling back to
 * the legacy agentLoopService path for tasks that already have loop_state.
 */
export async function executeTaskWithLoop(task, userId, opts = {}) {
  console.warn('[executeTaskWithLoop] DEPRECATED — use orchestrator.submitPlan() + approvePlan() instead');

  const templateId = task.template_id || task.input_context?.template_id;

  // Legacy path for tasks that already have loop_state (in-progress resumption)
  if (task.loop_state || !templateId) {
    if (!templateId) {
      return executeTask(task, userId);
    }
    const { initAgentLoop, runAgentLoop } = await import('./agentLoopService');
    if (!task.loop_state) {
      await initAgentLoop(task.id, userId);
    }
    return runAgentLoop(task.id, userId, opts);
  }

  // v2 path: delegate to orchestrator
  try {
    const { submitPlan, approvePlan } = await import('./aiEmployee/index.js');

    const dynamicTemplate = task.input_context?._dynamic_template;
    const steps = (dynamicTemplate?.steps || []).map((s, i) => ({
      name: s.name || s.step_name || `step_${i}`,
      tool_hint: s.tool_hint || s.description || s.name,
      tool_type: s.workflow_type || 'python_tool',
      builtin_tool_id: s.builtin_tool_id || null,
    }));

    const plan = {
      title: task.title || 'Untitled task',
      description: task.description || '',
      steps,
      inputData: task.input_context?._input_data || {},
      llmConfig: { provider: 'anthropic', model: 'claude-sonnet-4-6', temperature: 0.15, max_tokens: 4096 },
    };

    const { taskId } = await submitPlan(plan, task.employee_id, userId);
    await approvePlan(taskId, userId);

    return { task: { id: taskId }, completed_steps: steps.map(s => s.name) };
  } catch (err) {
    console.error('[executeTaskWithLoop] v2 orchestrator fallback failed, trying legacy:', err);
    // Final fallback to legacy
    const { initAgentLoop, runAgentLoop } = await import('./agentLoopService');
    if (!task.loop_state) {
      await initAgentLoop(task.id, userId);
    }
    return runAgentLoop(task.id, userId, opts);
  }
}

export default { executeTask, executeTaskWithLoop };
