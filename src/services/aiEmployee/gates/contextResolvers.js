/**
 * contextResolvers.js — Best-effort context enrichment for step execution.
 *
 * These resolvers never block execution. They enrich the StepContext with:
 *   - Prior artifacts from completed steps
 *   - Output profile / style context from style learning
 *   - Memory recall for context enrichment
 *   - Dataset profile row from DB
 *   - Lazy context acquisition for missing required data
 *
 * All resolvers follow the gate contract: return { pass: true } always.
 * Side effects are applied by mutating ctx.
 */

import * as stepRepo from '../persistence/stepRepo.js';
import { STEP_STATES } from '../stepStateMachine.js';
import { appendWorklog } from '../persistence/worklogRepo.js';
import { composeOutputProfileContext } from '../styleLearning/outputProfileService.js';
import { recall, summarizeMemories } from '../../memory/aiEmployeeMemoryService.js';
import { datasetProfilesService } from '../../data-prep/datasetProfilesService.js';
import { resolveContext, detectMissingContext } from '../lazyContextService.js';

/**
 * Gather artifacts from all prior completed steps.
 * Populates ctx.priorArtifacts and ctx.priorStepResults.
 */
export async function priorArtifactsResolver(ctx) {
  const { task, step } = ctx;

  const allSteps = await stepRepo.getSteps(task.id);
  const priorArtifacts = {};
  const priorStepResults = [];

  for (const s of allSteps) {
    if (s.step_index < step.step_index && s.status === STEP_STATES.SUCCEEDED) {
      const arts = s.artifact_refs || [];
      priorArtifacts[s.step_name] = arts;
      priorStepResults.push({ step_name: s.step_name, status: s.status, artifacts: arts });
    }
  }

  ctx.priorArtifacts = priorArtifacts;
  ctx.priorStepResults = priorStepResults;

  return { pass: true };
}

/**
 * Resolve output profile and style context from style learning.
 * Populates ctx.styleContext and ctx.outputProfile.
 */
export async function styleContextResolver(ctx) {
  const { task, step, stepDef } = ctx;

  const resolved = await composeOutputProfileContext({
    employeeId: task.employee_id,
    inputContext: task.input_context || {},
    step: { ...stepDef, name: step.step_name },
    mode: 'full',
    deliverableType: task.input_context?.deliverable_type || stepDef.tool_type,
    audience: task.input_context?.deliverable_audience || null,
  });

  if (resolved.styleContext) ctx.styleContext = resolved.styleContext;
  if (resolved.outputProfile) ctx.outputProfile = resolved.outputProfile;

  return { pass: true };
}

/**
 * Recall relevant memories from the employee memory service.
 * Populates ctx.memoryContext.
 */
export async function memoryRecallResolver(ctx) {
  const { task, step, stepDef } = ctx;

  const memories = await recall(task.employee_id, {
    workflowType: stepDef.tool_type || step.step_name,
    datasetFingerprint: task.input_context?.dataset_fingerprint || null,
    limit: 5,
  });

  if (memories?.length > 0) {
    ctx.memoryContext = summarizeMemories(memories);
  }

  return { pass: true };
}

/**
 * Resolve dataset profile row from DB when only an ID is available.
 * Populates ctx.inputData.datasetProfileRow.
 */
export async function datasetProfileResolver(ctx) {
  const { task, inputData } = ctx;

  if (inputData.datasetProfileRow || !inputData.datasetProfileId) {
    return { pass: true };
  }

  const profileRow = await datasetProfilesService.getDatasetProfileById(
    inputData.userId || task.input_context?.inputData?.userId,
    inputData.datasetProfileId
  );

  if (profileRow) {
    ctx.inputData.datasetProfileRow = profileRow;
  }

  return { pass: true };
}

/**
 * Lazy context acquisition: resolve missing data on-demand from context hints.
 * Populates ctx.inputData with resolved values.
 */
export async function lazyContextResolver(ctx) {
  const { task, step, stepDef, inputData } = ctx;

  if (!stepDef.required_context?.length) {
    return { pass: true };
  }

  const missing = detectMissingContext({ inputData }, stepDef.required_context);
  for (const key of missing) {
    const contextHint = stepDef.context_hints?.[key];
    if (!contextHint) continue;

    try {
      const resolved = await resolveContext(
        { source: contextHint.source, params: contextHint.params || {} },
        { taskId: task.id, employeeId: task.employee_id, inputData }
      );
      if (resolved.ok) {
        ctx.inputData[key] = resolved.data;
        try {
          await appendWorklog(task.employee_id, task.id, step.id, 'step_progress', {
            action: 'lazy_context_acquired',
            detail: `Resolved "${key}" from ${contextHint.source}`,
          });
        } catch { /* worklog best-effort */ }
      }
    } catch (err) {
      console.warn(`[LazyContextResolver] Lazy context "${key}" failed:`, err.message);
    }
  }

  return { pass: true };
}
