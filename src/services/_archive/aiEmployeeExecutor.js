// @product: ai-employee
//
// ★ ARCHIVED — This file has ZERO production imports. ★
// All execution logic lives in orchestrator.js + executors/.
// This stub is kept only for test verification; it may be deleted in a future cleanup.
//
// @deprecated — Use src/services/aiEmployee/orchestrator.js + executors/ instead.
// This file is a thin stub. Both exported functions throw a deprecation error
// directing callers to the new orchestrator API.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @deprecated Use orchestrator.submitPlan() + orchestrator.approvePlan() instead.
 * The orchestrator handles task creation, step execution, error handling,
 * budget checks, memory, AI review, and worklog writing.
 */
export function executeTask(/* task, userId */) {
  throw new Error(
    'Deprecated: executeTask() has been removed. Use orchestrator.js instead.\n' +
    '  - orchestrator.submitPlan() creates a task with steps\n' +
    '  - orchestrator.approvePlan() starts execution\n' +
    '  - Step execution is handled by executors/executorRegistry.js'
  );
}

/**
 * @deprecated Use orchestrator.submitPlan() + orchestrator.approvePlan() instead.
 */
export function executeTaskWithLoop(/* task, userId, opts */) {
  throw new Error(
    'Deprecated: executeTaskWithLoop() has been removed. Use orchestrator.js instead.\n' +
    '  - orchestrator.submitPlan() creates a task with steps\n' +
    '  - orchestrator.approvePlan() starts the tick loop automatically'
  );
}

export default { executeTask, executeTaskWithLoop };
