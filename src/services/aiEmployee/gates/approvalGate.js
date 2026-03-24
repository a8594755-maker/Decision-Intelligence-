/**
 * approvalGate.js — Blocks publish-phase steps until explicitly approved.
 *
 * Only applies to steps classified as PIPELINE_PHASES.PUBLISH.
 * Best-effort: if the approval service is unavailable, the step proceeds.
 */

import { taskTransition, TASK_EVENTS } from '../taskStateMachine.js';
import * as taskRepo from '../persistence/taskRepo.js';
import { classifyStepPhase, PIPELINE_PHASES } from '../decisionPipelineService.js';
import { enforceApprovalGate } from '../../approvalGateService.js';
import { getLatestMetrics } from '../styleLearning/trustMetricsService.js';

async function getAutonomyLevel(employeeId) {
  try {
    const metrics = await getLatestMetrics(employeeId);
    return metrics?.autonomy_level || 'A1';
  } catch {
    return 'A1';
  }
}

function inferActionType(stepDef) {
  const name = (stepDef.name || stepDef.step_name || '').toLowerCase();
  const toolType = (stepDef.tool_type || stepDef.builtin_tool_id || '').toLowerCase();
  const combined = `${name} ${toolType}`;

  if (combined.includes('writeback') || combined.includes('erp') || combined.includes('sap')) return 'writeback';
  if (combined.includes('notify') || combined.includes('email') || combined.includes('send') || combined.includes('slack')) return 'notify';
  return 'export';
}

/**
 * @param {import('./stepPipeline.js').StepContext} ctx
 */
export async function publishApprovalGate(ctx) {
  const { task, step, stepDef } = ctx;

  const stepPhase = classifyStepPhase(stepDef);
  if (stepPhase !== PIPELINE_PHASES.PUBLISH) {
    return { pass: true };
  }

  const actionType = inferActionType(stepDef);
  const autonomyLevel = await getAutonomyLevel(task.employee_id);
  const gate = enforceApprovalGate({
    taskId: task.id,
    actionType,
    workerTemplateId: task.input_context?.worker_template_id,
    autonomyLevel,
  });

  if (!gate.allowed) {
    try {
      const awaitingStatus = taskTransition(task.status, TASK_EVENTS.REVIEW_NEEDED);
      await taskRepo.updateTaskStatus(task.id, awaitingStatus, task.version);
      task.version += 1;
    } catch { /* may already be in review */ }

    return { pass: false, action: 'needs_approval', error: `Approval required: ${gate.reason}` };
  }

  return { pass: true };
}
