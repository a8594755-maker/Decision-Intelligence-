/**
 * mockStepRepo.js — In-memory mock for stepRepo.js.
 * Used when VITE_DI_MOCK_MODE=true. Zero external dependencies.
 */

import { STEP_STATES } from '../stepStateMachine.js';

const steps = new Map();  // stepId → step
let counter = 0;

function now() { return new Date().toISOString(); }

export function normalizeArtifactRefsForStorage(artifactRefs) {
  if (!Array.isArray(artifactRefs)) return [];
  return artifactRefs.filter(r => typeof r === 'string');
}

export async function createSteps(taskId, employeeId, stepsArr) {
  const ts = now();
  const created = stepsArr.map((step, index) => {
    const id = crypto.randomUUID();
    const row = {
      id,
      task_id: taskId,
      employee_id: employeeId,
      step_index: index,
      step_name: step.name,
      status: STEP_STATES.PENDING,
      retry_count: 0,
      max_retries: step.max_retries ?? 3,
      artifact_refs: [],
      summary: null,
      error_message: null,
      started_at: null,
      ended_at: null,
      di_run_id: null,
      _revision_instructions: null,
      created_at: ts,
      updated_at: ts,
    };
    steps.set(id, row);
    return { ...row };
  });
  console.info(`[MockStepRepo] createSteps: ${created.length} steps for task ${taskId}`);
  return created;
}

export async function updateStep(stepId, updates) {
  const step = steps.get(stepId);
  if (!step) throw new Error(`[MockStepRepo] step '${stepId}' not found`);

  if (updates.artifact_refs !== undefined) {
    updates.artifact_refs = normalizeArtifactRefsForStorage(updates.artifact_refs);
  }
  Object.assign(step, updates, { updated_at: now() });
  return { ...step };
}

export async function getSteps(taskId, { lite = false } = {}) {
  return [...steps.values()]
    .filter(s => s.task_id === taskId)
    .sort((a, b) => a.step_index - b.step_index)
    .map(s => ({ ...s }));
}

export async function getNextPendingStep(taskId) {
  const pending = [...steps.values()]
    .filter(s =>
      s.task_id === taskId &&
      [STEP_STATES.PENDING, STEP_STATES.RETRYING].includes(s.status)
    )
    .sort((a, b) => a.step_index - b.step_index);
  return pending.length > 0 ? { ...pending[0] } : null;
}

export async function markStepRetrying(stepId, currentRetryCount) {
  return updateStep(stepId, {
    status: STEP_STATES.RETRYING,
    retry_count: currentRetryCount + 1,
  });
}

export async function markStepSucceeded(stepId, { summary, artifactRefs = [] } = {}) {
  return updateStep(stepId, {
    status: STEP_STATES.SUCCEEDED,
    summary,
    artifact_refs: artifactRefs,
    ended_at: now(),
  });
}

export async function markStepFailed(stepId, errorMessage) {
  return updateStep(stepId, {
    status: STEP_STATES.FAILED,
    error_message: errorMessage,
    ended_at: now(),
  });
}
