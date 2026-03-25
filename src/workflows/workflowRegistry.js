import { datasetProfilesService } from '../services/data-prep/datasetProfilesService';
import { diRunsService } from '../services/planning/diRunsService';
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

export const WORKFLOW_REGISTRY_ERROR_CODES = {
  INVALID_RUN_ID: 'INVALID_RUN_ID',
  RUN_NOT_FOUND: 'RUN_NOT_FOUND',
  UNSUPPORTED_WORKFLOW: 'UNSUPPORTED_WORKFLOW'
};

const DEFAULT_ERROR_ACTIONS = {
  [WORKFLOW_REGISTRY_ERROR_CODES.INVALID_RUN_ID]: [
    'Retry from the workflow card with a valid run id.',
    'Start a new workflow run if this card is stale.'
  ],
  [WORKFLOW_REGISTRY_ERROR_CODES.RUN_NOT_FOUND]: [
    'This workflow run is missing or no longer accessible.',
    'Start a new workflow run from the latest dataset card.'
  ],
  [WORKFLOW_REGISTRY_ERROR_CODES.UNSUPPORTED_WORKFLOW]: [
    'Choose Workflow A or Workflow B explicitly before starting the run.',
    'Update the dataset mapping or workflow guess if the inferred workflow is unsupported.'
  ]
};

export class WorkflowRegistryError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'WorkflowRegistryError';
    this.code = code || WORKFLOW_REGISTRY_ERROR_CODES.INVALID_RUN_ID;
    this.run_id = options.run_id ?? null;
    this.nextActions = Array.isArray(options.nextActions) && options.nextActions.length > 0
      ? options.nextActions.slice(0, 2)
      : (DEFAULT_ERROR_ACTIONS[this.code] || DEFAULT_ERROR_ACTIONS[WORKFLOW_REGISTRY_ERROR_CODES.INVALID_RUN_ID]);
  }
}

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
  if (!normalized) return null;
  return WORKFLOW_ALIASES[normalized] || null;
}

export function getWorkflowFromProfile(profileJson = {}) {
  const label = String(profileJson?.global?.workflow_guess?.label || '').trim().toUpperCase();
  if (label === 'A') return WORKFLOW_NAMES.A;
  if (label === 'B') return WORKFLOW_NAMES.B;
  return null;
}

const unsupportedWorkflowError = (workflowValue) => new WorkflowRegistryError(
  WORKFLOW_REGISTRY_ERROR_CODES.UNSUPPORTED_WORKFLOW,
  `Unsupported workflow "${String(workflowValue || 'unknown')}"`,
  {
    nextActions: DEFAULT_ERROR_ACTIONS[WORKFLOW_REGISTRY_ERROR_CODES.UNSUPPORTED_WORKFLOW]
  }
);

const resolveEngine = (workflowName) => {
  const normalized = normalizeWorkflowName(workflowName);
  if (!normalized || !ENGINES[normalized]) {
    throw unsupportedWorkflowError(workflowName);
  }
  return ENGINES[normalized];
};

const parseRunId = (run_id) => {
  // Accept local-* IDs from offline workflow runs
  if (typeof run_id === 'string' && run_id.startsWith('local-')) return run_id;
  const runId = Number(run_id);
  if (!Number.isInteger(runId) || runId <= 0) {
    throw new WorkflowRegistryError(
      WORKFLOW_REGISTRY_ERROR_CODES.INVALID_RUN_ID,
      'run_id must be a positive integer or local ID',
      { run_id }
    );
  }
  return runId;
};

const resolveEngineByRun = async (runId) => {
  const run = await diRunsService.getRun(runId);
  if (!run) {
    throw new WorkflowRegistryError(
      WORKFLOW_REGISTRY_ERROR_CODES.RUN_NOT_FOUND,
      `Run ${runId} not found`,
      { run_id: runId }
    );
  }
  const workflowName = normalizeWorkflowName(run.workflow);
  if (!workflowName) {
    throw unsupportedWorkflowError(run.workflow);
  }
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
  settings = {},
  profileRow: providedProfileRow = null
}) {
  if (!user_id) throw new Error('user_id is required');
  if (!dataset_profile_id) throw new Error('dataset_profile_id is required');

  let resolvedWorkflow = workflow ? normalizeWorkflowName(workflow) : null;
  if (workflow && !resolvedWorkflow) {
    throw unsupportedWorkflowError(workflow);
  }
  if (!resolvedWorkflow) {
    const profileRow = providedProfileRow || await datasetProfilesService.getDatasetProfileById(user_id, dataset_profile_id);
    resolvedWorkflow = getWorkflowFromProfile(profileRow?.profile_json || {});
    if (!resolvedWorkflow) {
      const guessedLabel = profileRow?.profile_json?.global?.workflow_guess?.label || 'unknown';
      throw unsupportedWorkflowError(guessedLabel);
    }
  }

  const engine = resolveEngine(resolvedWorkflow);
  return engine.start({
    user_id,
    dataset_profile_id,
    workflow: resolvedWorkflow,
    settings,
    profileRow: providedProfileRow
  });
}

export async function runNextStep(run_id) {
  const runId = parseRunId(run_id);
  const { engine } = await resolveEngineByRun(runId);
  return engine.runNextStep(runId);
}

export async function resumeRun(run_id, options = {}) {
  const runId = parseRunId(run_id);
  const { engine } = await resolveEngineByRun(runId);
  return engine.resumeRun(runId, options);
}

export async function replayRun(run_id, options = {}) {
  const runId = parseRunId(run_id);
  const { engine } = await resolveEngineByRun(runId);
  return engine.replayRun(runId, options);
}

export async function getRunSnapshot(run_id) {
  const runId = parseRunId(run_id);
  const { engine } = await resolveEngineByRun(runId);
  return engine.getRunSnapshot(runId);
}

export async function submitBlockingAnswers(run_id, answers = {}) {
  const runId = parseRunId(run_id);
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
