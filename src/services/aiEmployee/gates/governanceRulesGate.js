/**
 * governanceRulesGate.js — Evaluates user-configurable governance rules.
 *
 * Three possible outcomes:
 *   1. Hard block: rule disallows the action entirely → skip step
 *   2. Requires approval: rule demands review → hold step
 *   3. Requires review: flag for post-execution review (sets ctx flag)
 *
 * Best-effort: if the rule service is unavailable, the step proceeds.
 */

import { stepTransition, STEP_EVENTS } from '../stepStateMachine.js';
import { taskTransition, TASK_EVENTS } from '../taskStateMachine.js';
import * as stepRepo from '../persistence/stepRepo.js';
import * as taskRepo from '../persistence/taskRepo.js';
import { appendWorklog } from '../persistence/worklogRepo.js';
import { resolveCapabilityClass } from '../../ai-infra/capabilityModelService.js';
import { evaluateRules } from '../../governance/policyRuleService.js';
import { getLatestMetrics } from '../styleLearning/trustMetricsService.js';
import { eventBus, EVENT_NAMES } from '../../governance/eventBus.js';

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
export async function governanceRulesGate(ctx) {
  const { task, step, stepDef } = ctx;

  const capClass = resolveCapabilityClass({
    tool_type: stepDef.tool_type || 'python_tool',
    builtin_tool_id: stepDef.builtin_tool_id,
  });
  const autonomyLevel = await getAutonomyLevel(task.employee_id);

  const ruleResult = await evaluateRules({
    capability_class: capClass,
    worker_template_id: task.input_context?.worker_template_id || null,
    autonomy_level: autonomyLevel,
    action_type: stepDef.tool_type || 'builtin_tool',
    cost_delta: task.input_context?.estimated_cost || 0,
  });

  // Sub-check 1: Hard block
  if (!ruleResult.allowed) {
    const blockMsg = `Blocked by governance rule: ${ruleResult.reasons.join('; ')}`;
    const gateStatus = stepTransition(step.status, STEP_EVENTS.SKIP);
    await stepRepo.updateStep(step.id, {
      status: gateStatus,
      error_message: blockMsg,
      ended_at: new Date().toISOString(),
    });

    try {
      await appendWorklog(task.employee_id, task.id, step.id, 'step_progress', {
        event: 'governance_blocked', reasons: ruleResult.reasons, triggered_rules: ruleResult.triggered_rules,
      });
    } catch { /* worklog best-effort */ }

    return { pass: false, action: 'skipped', error: blockMsg };
  }

  // Sub-check 2: Requires approval
  if (ruleResult.require_approval && !step._governance_approved) {
    const holdMsg = `Governance rule requires approval: ${ruleResult.reasons.join('; ')}`;
    const holdStatus = stepTransition(step.status, STEP_EVENTS.HOLD);
    await stepRepo.updateStep(step.id, { status: holdStatus, error_message: holdMsg });

    try {
      const nextTaskStatus = taskTransition(task.status, TASK_EVENTS.REVIEW_NEEDED);
      await taskRepo.updateTaskStatus(task.id, nextTaskStatus, task.version);
      task.version += 1;
    } catch { /* may already be in review */ }

    eventBus.emit(EVENT_NAMES.AGENT_STEP_BLOCKED, {
      taskId: task.id, stepIndex: step.step_index, stepName: step.step_name,
      reason: 'governance_rule_hold', message: holdMsg,
    });

    return { pass: false, action: 'review_hold', error: holdMsg };
  }

  // Sub-check 3: Requires post-execution review (flag only, doesn't block)
  if (ruleResult.require_review) {
    step._governance_require_review = true;
  }

  return { pass: true };
}
