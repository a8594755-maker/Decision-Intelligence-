/**
 * datasetGate.js — Blocks steps that require a dataset when none is attached.
 *
 * Attempts lazy dataset resolution via context hints before blocking.
 * Steps with `data_optional: true` always pass.
 */

import { stepTransition, STEP_EVENTS } from '../stepStateMachine.js';
import { taskTransition, TASK_EVENTS } from '../taskStateMachine.js';
import * as stepRepo from '../persistence/stepRepo.js';
import * as taskRepo from '../persistence/taskRepo.js';
import { appendWorklog } from '../persistence/worklogRepo.js';
import { resolveContext } from '../lazyContextService.js';
import { eventBus, EVENT_NAMES } from '../../governance/eventBus.js';

/**
 * @param {import('./stepPipeline.js').StepContext} ctx
 * @returns {Promise<{pass: boolean, action?: string, error?: string, needs_input?: boolean}>}
 */
export async function datasetGate(ctx) {
  const { task, step, stepDef } = ctx;

  // Steps that don't require data always pass
  if (!stepDef.requires_dataset || stepDef.data_optional) {
    return { pass: true };
  }

  // Check if dataset is already available
  const hasDataset = Boolean(
    task.input_context?.inputData?.datasetProfileId ||
    task.input_context?.dataset_profile_id
  );
  if (hasDataset) {
    return { pass: true };
  }

  // Attempt lazy dataset resolution
  if (stepDef.context_hints?.dataset) {
    try {
      const resolved = await resolveContext(
        { source: stepDef.context_hints.dataset.source, params: stepDef.context_hints.dataset.params || {} },
        { taskId: task.id, employeeId: task.employee_id, inputData: task.input_context?.inputData || {} }
      );
      if (resolved.ok && resolved.data) {
        // Patch inputData with lazily resolved dataset
        if (!task.input_context.inputData) task.input_context.inputData = {};
        task.input_context.inputData.datasetProfileId = resolved.data.datasetProfileId || resolved.data.id;
        ctx.inputData.datasetProfileId = task.input_context.inputData.datasetProfileId;

        try {
          await appendWorklog(task.employee_id, task.id, step.id, 'step_progress', {
            action: 'lazy_dataset_acquired',
            detail: `Resolved dataset via lazy context for step "${step.step_name}"`,
          });
        } catch { /* worklog best-effort */ }

        return { pass: true };
      }
    } catch (err) {
      console.warn(`[DatasetGate] Lazy dataset resolution failed for step "${step.step_name}":`, err.message);
    }
  }

  // Block the step — requires user input
  console.warn(`[DatasetGate] Step "${step.step_name}" requires dataset but none attached — blocking.`);

  const waitingStatus = stepTransition(step.status, STEP_EVENTS.NEED_INPUT);
  await stepRepo.updateStep(step.id, {
    status: waitingStatus,
    error_message: `Step "${step.step_name}" requires a dataset. Please upload or attach one to continue.`,
  });

  try {
    const blockedStatus = taskTransition(task.status, TASK_EVENTS.BLOCK);
    await taskRepo.updateTaskStatus(task.id, blockedStatus, task.version);
    task.version += 1;
  } catch { /* task may already be blocked */ }

  const blockPayload = {
    taskId: task.id, stepIndex: step.step_index, stepName: step.step_name,
    reason: 'dataset_required',
    message: `Step "${step.step_name}" requires a dataset but none is available. Please upload a workbook or attach a dataset profile.`,
  };
  eventBus.emit(EVENT_NAMES.AGENT_STEP_BLOCKED, blockPayload);

  try {
    await appendWorklog(task.employee_id, task.id, step.id, 'step_progress', {
      event: 'dataset_required', step_name: step.step_name,
      detail: 'Step requires dataset but lazy context resolution failed. Blocked for user input.',
    });
  } catch { /* worklog best-effort */ }

  return { pass: false, action: 'blocked', error: blockPayload.message, needs_input: true, blockPayload };
}
