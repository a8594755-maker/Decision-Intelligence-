// @product: ai-employee
//
// @deprecated — Use src/services/aiEmployee/orchestrator.js instead.
// All capabilities (tick loop, review hold, AI review, self-healing, SSE,
// memory recall, budget check, worklog) have been ported to the orchestrator.
//
// This file is a thin stub. All public functions throw a deprecation error
// directing callers to the new orchestrator API.
// ─────────────────────────────────────────────────────────────────────────────

// ── Constants (still exported for backward compat with tests) ────────────────

export const MAX_RETRIES = 3;

export const STEP_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  BLOCKED: 'blocked',
  REVIEW_HOLD: 'review_hold',
  SKIPPED: 'skipped',
};

// ── Deprecated stubs ─────────────────────────────────────────────────────────

function _deprecated(fnName) {
  throw new Error(
    `Deprecated: ${fnName}() has been removed. Use orchestrator.js instead.\n` +
    `  - submitPlan() + approvePlan() replaces initAgentLoop + runAgentLoop\n` +
    `  - approveReview() replaces approveStepAndContinue\n` +
    `  - retryTask() replaces reviseStepAndRetry`
  );
}

export function initAgentLoop(/* taskId, userId */) {
  _deprecated('initAgentLoop');
}

export function tickAgentLoop(/* taskId, userId */) {
  _deprecated('tickAgentLoop');
}

export function runAgentLoop(/* taskId, userId, opts */) {
  _deprecated('runAgentLoop');
}

export function approveStepAndContinue(/* taskId, stepName */) {
  _deprecated('approveStepAndContinue');
}

export function reviseStepAndRetry(/* taskId, stepName */) {
  _deprecated('reviseStepAndRetry');
}

// ── Default export ───────────────────────────────────────────────────────────

export default {
  initAgentLoop,
  tickAgentLoop,
  runAgentLoop,
  approveStepAndContinue,
  reviseStepAndRetry,
  STEP_STATUS,
  MAX_RETRIES,
};
