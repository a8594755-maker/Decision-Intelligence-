/**
 * AI Employee v2 — Public API
 *
 * Single entry point for the entire AI Employee subsystem.
 * All task lifecycle control goes through the orchestrator.
 *
 * Usage:
 *   import { submitPlan, approvePlan, getTaskStatus } from '@/services/aiEmployee';
 */

// ── Orchestrator (the main API) ──
export {
  submitPlan,
  approvePlan,
  cancelTask,
  retryTask,
  approveReview,
  tick,
  getTaskStatus,
} from './orchestrator.js';

// ── Planner ──
export { createPlan } from './planner.js';

// ── Router ──
export { routeModel } from './router.js';

// ── Review ──
export { reviewStep } from './review.js';
export { runTask, resolveReviewDecision } from './taskActionService.js';

// ── State machines (for UI display / guards) ──
export { TASK_STATES, TASK_EVENTS, taskTransition, canTaskTransition, isTaskTerminal } from './taskStateMachine.js';
export { STEP_STATES, STEP_EVENTS, stepTransition, isStepTerminal } from './stepStateMachine.js';
export { EMPLOYEE_STATES, EMPLOYEE_EVENTS, employeeTransition } from './employeeStateMachine.js';
