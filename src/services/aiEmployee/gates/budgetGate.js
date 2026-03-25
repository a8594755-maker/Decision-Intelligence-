/**
 * budgetGate.js — Skips steps when the task budget is exceeded.
 *
 * Best-effort: if the budget service is unavailable, the step proceeds.
 */

import { stepTransition, STEP_EVENTS } from '../stepStateMachine.js';
import * as stepRepo from '../persistence/stepRepo.js';
import { checkBudget } from '../../tasks/taskBudgetService.js';

/**
 * @param {import('./stepPipeline.js').StepContext} ctx
 * @returns {Promise<{pass: boolean, action?: string, error?: string}>}
 */
export async function budgetGate(ctx) {
  const { task, step } = ctx;

  const budgetResult = await checkBudget(task.id);
  if (!budgetResult.allowed) {
    const gateStatus = stepTransition(step.status, STEP_EVENTS.SKIP);
    await stepRepo.updateStep(step.id, {
      status: gateStatus,
      error_message: `Budget exceeded: ${budgetResult.reason}`,
      ended_at: new Date().toISOString(),
    });
    return { pass: false, action: 'skipped', error: `Budget exceeded: ${budgetResult.reason}` };
  }

  return { pass: true };
}
