/**
 * toolPermissionGate.js — Checks tool permissions, tier restrictions,
 * and capability policies via the unified toolPermissionGuard.
 *
 * Best-effort: if the permission service is unavailable, the step proceeds.
 */

import { stepTransition, STEP_EVENTS } from '../stepStateMachine.js';
import * as stepRepo from '../persistence/stepRepo.js';
import * as employeeRepo from '../persistence/employeeRepo.js';
import { appendWorklog } from '../persistence/worklogRepo.js';
import { checkCapabilityPolicy } from '../../toolPermissionGuard.js';
import { getLatestMetrics } from '../styleLearning/trustMetricsService.js';

async function getAutonomyLevel(employeeId) {
  try {
    const metrics = await getLatestMetrics(employeeId);
    return metrics?.autonomy_level || 'A1';
  } catch {
    return 'A1';
  }
}

/**
 * @param {import('./stepPipeline.js').StepContext} ctx
 */
export async function toolPermissionGate(ctx) {
  const { task, step, stepDef } = ctx;

  const employee = await employeeRepo.getEmployee(task.employee_id);
  const toolType = stepDef.tool_type || 'builtin_tool';
  const toolTier = stepDef.tier || null;
  const autonomyLevel = await getAutonomyLevel(task.employee_id);

  const policyCheck = await checkCapabilityPolicy(employee, toolType, {
    builtin_tool_id: stepDef.builtin_tool_id,
    tool_type: toolType,
    toolTier,
  }, autonomyLevel);

  if (!policyCheck.allowed) {
    const reason = policyCheck.capabilityBlocked
      ? `Capability policy blocked: ${policyCheck.reason}`
      : policyCheck.tierBlocked
      ? `Tool tier restricted: ${policyCheck.reason}`
      : `Permission denied: missing ${policyCheck.missing.join(', ')}`;

    const gateStatus = stepTransition(step.status, STEP_EVENTS.SKIP);
    await stepRepo.updateStep(step.id, {
      status: gateStatus,
      error_message: reason,
      ended_at: new Date().toISOString(),
    });

    try {
      await appendWorklog(task.employee_id, task.id, step.id, 'step_progress', {
        event: 'permission_denied', reason, tool_type: toolType, tool_tier: toolTier,
        capability_blocked: policyCheck.capabilityBlocked || false,
      });
    } catch { /* worklog best-effort */ }

    return { pass: false, action: 'skipped', error: reason };
  }

  return { pass: true };
}
