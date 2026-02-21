import { datasetProfilesService } from '../services/datasetProfilesService';
import { diRunsService } from '../services/diRunsService';
import {
  startWorkflowA,
  runNextStep as runNextWorkflowAStep,
  resumeRun as resumeWorkflowARun,
  replayRun as replayWorkflowARun,
  getWorkflowARunSnapshot,
  submitBlockingAnswers as submitBlockingAnswersA
} from './workflowAEngine';
import {
  startWorkflowB,
  runNextStep as runNextWorkflowBStep,
  resumeRun as resumeWorkflowBRun,
  replayRun as replayWorkflowBRun,
  getWorkflowBRunSnapshot,
  submitBlockingAnswers as submitBlockingAnswersB
} from './workflowBEngine';

export const WORKFLOW_NAMES = {
  A: 'workflow_A_replenishment',
  B: 'workflow_B_risk_exceptions'
};

const WORKFLOW_ALIASES = {
  workflow_a: WORKFLOW_NAMES.A,
  workflow_a_replenishment: WORKFLOW_NAMES.A,
  workflow_b: WORKFLOW_NAMES.B,
  workflow_b_risk_exceptions: WORKFLOW_NAMES.B
};

const ENGINES = {
  [WORKFLOW_NAMES.A]: {
    start: startWorkflowA,
    runNextStep: runNextWorkflowAStep,
    resumeRun: resumeWorkflowARun,
    replayRun: replayWorkflowARun,
    getRunSnapshot: getWorkflowARunSnapshot,
    submitBlockingAnswers: submitBlockingAnswersA
  },
  [WORKFLOW_NAMES.B]: {
    start: startWorkflowB,
    runNextStep: runNextWorkflowBStep,
    resumeRun: resumeWorkflowBRun,
    replayRun: replayWorkflowBRun,
    getRunSnapshot: getWorkflowBRunSnapshot,
    submitBlockingAnswers: submitBlockingAnswersB
  }
};

export function normalizeWorkflowName(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return WORKFLOW_NAMES.A;
  return WORKFLOW_ALIASES[normalized] || value;
}

export function getWorkflowFromProfile(profileJson = {}) {
  const label = String(profileJson?.global?.workflow_guess?.label || '').trim().toUpperCase();
  if (label === 'B') return WORKFLOW_NAMES.B;
  return WORKFLOW_NAMES.A;
}

const resolveEngine = (workflowName) => {
  const normalized = normalizeWorkflowName(workflowName);
  return ENGINES[normalized] || ENGINES[WORKFLOW_NAMES.A];
};

const resolveEngineByRun = async (runId) => {
  const run = await diRunsService.getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  const workflowName = normalizeWorkflowName(run.workflow);
  return {
    run,
    workflowName,
    engine: resolveEngine(workflowName)
  };
};

export async function startWorkflow({
  user_id,
  dataset_profile_id,
  workflow = null,
  settings = {}
}) {
  if (!user_id) throw new Error('user_id is required');
  if (!dataset_profile_id) throw new Error('dataset_profile_id is required');

  let resolvedWorkflow = workflow ? normalizeWorkflowName(workflow) : null;
  if (!resolvedWorkflow) {
    const profileRow = await datasetProfilesService.getDatasetProfileById(user_id, dataset_profile_id);
    resolvedWorkflow = getWorkflowFromProfile(profileRow?.profile_json || {});
  }

  const engine = resolveEngine(resolvedWorkflow);
  return engine.start({
    user_id,
    dataset_profile_id,
    workflow: resolvedWorkflow,
    settings
  });
}

export async function runNextStep(run_id) {
  const runId = Number(run_id);
  if (!Number.isFinite(runId)) throw new Error('run_id must be numeric');
  const { engine } = await resolveEngineByRun(runId);
  return engine.runNextStep(runId);
}

export async function resumeRun(run_id, options = {}) {
  const runId = Number(run_id);
  if (!Number.isFinite(runId)) throw new Error('run_id must be numeric');
  const { engine } = await resolveEngineByRun(runId);
  return engine.resumeRun(runId, options);
}

export async function replayRun(run_id, options = {}) {
  const runId = Number(run_id);
  if (!Number.isFinite(runId)) throw new Error('run_id must be numeric');
  const { engine } = await resolveEngineByRun(runId);
  return engine.replayRun(runId, options);
}

export async function getRunSnapshot(run_id) {
  const runId = Number(run_id);
  if (!Number.isFinite(runId)) throw new Error('run_id must be numeric');
  const { engine } = await resolveEngineByRun(runId);
  return engine.getRunSnapshot(runId);
}

export async function submitBlockingAnswers(run_id, answers = {}) {
  const runId = Number(run_id);
  if (!Number.isFinite(runId)) throw new Error('run_id must be numeric');
  const { engine } = await resolveEngineByRun(runId);
  return engine.submitBlockingAnswers(runId, answers);
}

export default {
  WORKFLOW_NAMES,
  normalizeWorkflowName,
  getWorkflowFromProfile,
  startWorkflow,
  runNextStep,
  resumeRun,
  replayRun,
  getRunSnapshot,
  submitBlockingAnswers
};
