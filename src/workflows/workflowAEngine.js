import { datasetProfilesService } from '../services/data-prep/datasetProfilesService';
import { diRunsService } from '../services/planning/diRunsService';
import { reuseMemoryService } from '../services/memory/reuseMemoryService';
import { buildDataSummaryCardPayload } from '../services/data-prep/chatDatasetProfilingService';
import { runForecastFromDatasetProfile, buildForecastCardPayload } from '../services/forecast/chatForecastService';
import {
  runPlanFromDatasetProfile,
  buildPlanSummaryCardPayload,
  buildPlanTableCardPayload,
  buildInventoryProjectionCardPayload,
  buildPlanExceptionsCardPayload,
  buildBomBottlenecksCardPayload,
  buildPlanDownloadsPayload,
  buildRiskAwarePlanComparisonCardPayload
} from '../services/planning/chatPlanningService';
import { generateTopologyGraphForRun } from '../services/topology/topologyService';
import { loadArtifact, saveJsonArtifact } from '../utils/artifactStore';
import { runClosedLoop, isClosedLoopEnabled } from '../services/closed_loop/index.js';
import { buildDecisionNarrative } from '../utils/buildDecisionNarrative';
import { recordPlanGenerated } from '../services/planning/planAuditService';
import { applyBlockingAnswerBindings } from './blockingAnswerUtils.js';

export const WORKFLOW_A_STEPS = ['profile', 'contract', 'validate', 'forecast', 'optimize', 'verify', 'topology', 'report'];

const TERMINAL_STEP_STATUSES = new Set(['succeeded', 'failed', 'skipped', 'blocked']);
const RUN_TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'waiting_user']);
const ARTIFACT_THRESHOLD = 200 * 1024;
const MAX_BLOCKING_QUESTIONS = 2;

export const WORKFLOW_ERROR_CODES = {
  DATA_CONTRACT_MISSING_REQUIRED: 'DATA_CONTRACT_MISSING_REQUIRED',
  DATA_TYPE_VALIDATION_FAILED: 'DATA_TYPE_VALIDATION_FAILED',
  API_TIMEOUT: 'API_TIMEOUT',
  OPTIMIZATION_INFEASIBLE: 'OPTIMIZATION_INFEASIBLE',
  CONSTRAINT_VIOLATION: 'CONSTRAINT_VIOLATION',
  JSON_PARSE_FAILED: 'JSON_PARSE_FAILED',
  UNKNOWN: 'UNKNOWN'
};

const ERROR_ACTIONS = {
  [WORKFLOW_ERROR_CODES.DATA_CONTRACT_MISSING_REQUIRED]: [
    'Map or confirm missing required fields in the contract.',
    'Resume the workflow after saving mapping changes.'
  ],
  [WORKFLOW_ERROR_CODES.DATA_TYPE_VALIDATION_FAILED]: [
    'Fix invalid data types in required columns.',
    'Re-upload or remap and resume the workflow.'
  ],
  [WORKFLOW_ERROR_CODES.API_TIMEOUT]: [
    'Retry the run or resume from the failed step.',
    'If repeated, reduce data scope and retry.'
  ],
  [WORKFLOW_ERROR_CODES.OPTIMIZATION_INFEASIBLE]: [
    'Adjust constraints (MOQ, pack size, budget cap) and rerun.',
    'Review solver infeasible reasons in exceptions card.'
  ],
  [WORKFLOW_ERROR_CODES.CONSTRAINT_VIOLATION]: [
    'Resolve hard constraint violations before execution.',
    'Replay after fixing constraint inputs.'
  ],
  [WORKFLOW_ERROR_CODES.JSON_PARSE_FAILED]: [
    'Continue with deterministic outputs only.',
    'Retry report summary if LLM parsing is needed.'
  ],
  [WORKFLOW_ERROR_CODES.UNKNOWN]: [
    'Retry or resume from the failed step.',
    'If issue persists, inspect run artifacts for details.'
  ]
};

const normalizeBlockingQuestions = (questions) => {
  const list = Array.isArray(questions) ? questions : [];
  return list
    .map((item) => {
      if (typeof item === 'string') {
        const q = item.trim();
        return q ? { id: null, question: q, answer_type: 'text', options: null, why_needed: null, bind_to: null } : null;
      }
      if (item && typeof item === 'object') {
        const q = String(item.question || '').trim();
        if (!q) return null;
        return {
          id: item.id || null,
          question: q,
          answer_type: item.answer_type || 'text',
          options: Array.isArray(item.options) ? item.options : null,
          why_needed: item.why_needed ? String(item.why_needed).trim() : null,
          bind_to: item.bind_to ? String(item.bind_to).trim() : null
        };
      }
      return null;
    })
    .filter(Boolean)
    .slice(0, MAX_BLOCKING_QUESTIONS);
};

class WorkflowAError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'WorkflowAError';
    this.code = code || WORKFLOW_ERROR_CODES.UNKNOWN;
    this.nextActions = Array.isArray(options.nextActions) ? options.nextActions.slice(0, 2) : (ERROR_ACTIONS[this.code] || ERROR_ACTIONS.UNKNOWN);
    this.blockingQuestions = normalizeBlockingQuestions(options.blockingQuestions);
    this.details = options.details || null;
  }
}

const nowIso = () => new Date().toISOString();

const normalizeStatus = (value, fallback = 'queued') => {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || fallback;
};

const getStepOrder = (step) => WORKFLOW_A_STEPS.indexOf(step);

const sortSteps = (steps = []) => {
  return [...steps].sort((a, b) => {
    const orderA = getStepOrder(a.step);
    const orderB = getStepOrder(b.step);
    if (orderA !== orderB) return orderA - orderB;
    return Number(a.id || 0) - Number(b.id || 0);
  });
};

const toStepMap = (steps = []) => {
  const map = new Map();
  sortSteps(steps).forEach((stepRow) => {
    map.set(stepRow.step, stepRow);
  });
  return map;
};

const classifyErrorCode = (error, step) => {
  if (error?.code && Object.values(WORKFLOW_ERROR_CODES).includes(error.code)) {
    return error.code;
  }

  const message = String(error?.message || '').toLowerCase();
  if (message.includes('timeout')) return WORKFLOW_ERROR_CODES.API_TIMEOUT;
  if (message.includes('json') && message.includes('parse')) return WORKFLOW_ERROR_CODES.JSON_PARSE_FAILED;
  if (message.includes('infeasible')) return WORKFLOW_ERROR_CODES.OPTIMIZATION_INFEASIBLE;
  if (message.includes('constraint')) return WORKFLOW_ERROR_CODES.CONSTRAINT_VIOLATION;
  if (message.includes('missing') && message.includes('required')) return WORKFLOW_ERROR_CODES.DATA_CONTRACT_MISSING_REQUIRED;
  if (message.includes('type') && message.includes('validation')) return WORKFLOW_ERROR_CODES.DATA_TYPE_VALIDATION_FAILED;

  if (step === 'validate' || step === 'contract') return WORKFLOW_ERROR_CODES.DATA_CONTRACT_MISSING_REQUIRED;
  if (step === 'verify') return WORKFLOW_ERROR_CODES.CONSTRAINT_VIOLATION;

  return WORKFLOW_ERROR_CODES.UNKNOWN;
};

const asWorkflowError = (error, step) => {
  if (error instanceof WorkflowAError) return error;

  const code = classifyErrorCode(error, step);
  return new WorkflowAError(code, error?.message || 'Workflow step failed', {
    nextActions: error?.nextActions,
    blockingQuestions: error?.blockingQuestions,
    details: error?.details || null
  });
};

const getLatestArtifactRecordByType = (artifacts = [], type) => {
  const matches = (Array.isArray(artifacts) ? artifacts : []).filter((item) => item.artifact_type === type);
  if (matches.length === 0) return null;
  return [...matches].sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0];
};

const toArtifactRef = (record) => {
  if (!record) return null;
  return {
    artifact_id: record.id,
    ...(record.artifact_json || {})
  };
};

const loadArtifactPayloadByType = async (runId, type) => {
  const artifacts = await diRunsService.getArtifactsForRun(runId);
  const record = getLatestArtifactRecordByType(artifacts, type);
  if (!record) return null;
  return loadArtifact({ artifact_id: record.id, ...(record.artifact_json || {}) });
};

const getWorkflowSettings = async (runId) => {
  const artifacts = await diRunsService.getArtifactsForRun(runId);
  const record = getLatestArtifactRecordByType(artifacts, 'workflow_settings');
  if (!record) return {};

  const payload = await loadArtifact({ artifact_id: record.id, ...(record.artifact_json || {}) });
  return payload?.settings || payload || {};
};

const persistWorkflowSettings = async (runId, userId, payload = {}) => {
  await saveJsonArtifact(runId, 'workflow_settings', payload, ARTIFACT_THRESHOLD, {
    user_id: userId,
    filename: `workflow_settings_run_${runId}.json`
  });
};

const findNextRunnableStep = (steps = []) => {
  const ordered = sortSteps(steps);
  return ordered.find((step) => {
    const status = normalizeStatus(step.status);
    return status !== 'succeeded' && status !== 'skipped';
  }) || null;
};

const runIsSucceeded = (steps = []) => {
  if (steps.length === 0) return false;
  return steps.every((step) => {
    const status = normalizeStatus(step.status);
    return status === 'succeeded' || status === 'skipped';
  });
};

const runHasFailedStep = (steps = []) => steps.some((step) => normalizeStatus(step.status) === 'failed');

const runHasBlockedStep = (steps = []) => steps.some((step) => normalizeStatus(step.status) === 'blocked');

const resetFailedAndDownstreamSteps = async (runId, steps = []) => {
  const ordered = sortSteps(steps);
  const firstFailed = ordered.find((step) => normalizeStatus(step.status) === 'failed');
  if (!firstFailed) {
    return {
      resetFromStep: null,
      resetStepCount: 0
    };
  }

  const firstFailedOrder = getStepOrder(firstFailed.step);
  const resetTargets = ordered.filter((step) => {
    const order = getStepOrder(step.step);
    return order >= firstFailedOrder;
  });

  for (const step of resetTargets) {
    await diRunsService.updateRunStep({
      run_id: runId,
      step: step.step,
      status: 'queued',
      started_at: null,
      finished_at: null,
      error_code: null,
      error_message: null,
      output_ref: null
    });
  }

  return {
    resetFromStep: firstFailed.step,
    resetStepCount: resetTargets.length
  };
};

const resetBlockedAndDownstreamSteps = async (runId, steps = []) => {
  const ordered = sortSteps(steps);
  const firstBlocked = ordered.find((step) => normalizeStatus(step.status) === 'blocked');
  if (!firstBlocked) {
    return {
      resetFromStep: null,
      resetStepCount: 0
    };
  }

  const firstBlockedOrder = getStepOrder(firstBlocked.step);
  const resetTargets = ordered.filter((step) => {
    const order = getStepOrder(step.step);
    return order >= firstBlockedOrder;
  });

  for (const step of resetTargets) {
    await diRunsService.updateRunStep({
      run_id: runId,
      step: step.step,
      status: 'queued',
      started_at: null,
      finished_at: null,
      error_code: null,
      error_message: null,
      output_ref: null
    });
  }

  return {
    resetFromStep: firstBlocked.step,
    resetStepCount: resetTargets.length
  };
};

const ensureRunInitialized = async (runId) => {
  await diRunsService.createRunSteps(runId, WORKFLOW_A_STEPS);
  const steps = await diRunsService.getRunSteps(runId);
  return sortSteps(steps);
};

const buildRunSnapshot = async (runId) => {
  const snapshot = await diRunsService.getRunSnapshot(runId);
  return {
    run: snapshot.run,
    steps: sortSteps(snapshot.steps || []),
    artifacts: snapshot.artifacts || []
  };
};

const getSourceCachedOutput = async (settings, stepName) => {
  const rawId = settings?.replay_of_run_id;
  const sourceRunId = String(rawId || '').startsWith('local-') ? rawId : Number(rawId);
  if (!sourceRunId || (typeof sourceRunId === 'number' && !Number.isFinite(sourceRunId))) return null;

  const sourceSteps = await diRunsService.getRunSteps(sourceRunId);
  const sourceStep = sourceSteps.find((row) => row.step === stepName);
  if (!sourceStep || !['succeeded', 'skipped'].includes(normalizeStatus(sourceStep.status))) {
    return null;
  }
  return sourceStep.output_ref || null;
};

const mergeSettings = (templateSettings = {}, explicitSettings = {}) => ({
  ...(templateSettings || {}),
  ...(explicitSettings || {}),
  forecast: {
    ...((templateSettings || {}).forecast || {}),
    ...((explicitSettings || {}).forecast || {})
  },
  plan: {
    ...((templateSettings || {}).plan || {}),
    ...((explicitSettings || {}).plan || {})
  }
});

const isReuseEnabled = (settings = {}) => settings?.reuse_enabled !== false;
const isForceRetrainEnabled = (settings = {}) => Boolean(settings?.force_retrain);

const getForecastHorizonFromSettings = (settings = {}) => {
  const fromNested = Number(settings?.forecast?.horizon_periods);
  if (Number.isFinite(fromNested) && fromNested > 0) return Math.floor(fromNested);
  const fromRoot = Number(settings?.forecast_horizon_periods);
  if (Number.isFinite(fromRoot) && fromRoot > 0) return Math.floor(fromRoot);
  return null;
};

const getPlanSettingsFromContext = (settings = {}) => {
  const plan = settings?.plan || {};
  const planningHorizon = Number(plan?.planning_horizon_days);
  // risk_mode: 'off' | 'on'. Reads from plan.risk_mode, then settings.risk_mode, then env flag.
  const rawRiskMode = plan?.risk_mode || settings?.risk_mode || 'off';
  const riskMode = rawRiskMode === 'on' ? 'on' : 'off';
  return {
    planning_horizon_days: Number.isFinite(planningHorizon) && planningHorizon > 0 ? Math.floor(planningHorizon) : null,
    objective: plan?.objective || null,
    constraints: plan?.constraints || null,
    risk_mode: riskMode,
    risk_run_id: plan?.risk_run_id || settings?.risk_run_id || null,
    risk_config_overrides: plan?.risk_config_overrides || settings?.risk_config_overrides || {}
  };
};

const findReusableForecastRun = async ({ userId, datasetProfileRow, requestedHorizon }) => {
  if (!userId || !datasetProfileRow?.fingerprint) return null;

  const profiles = await datasetProfilesService.listByFingerprint(userId, datasetProfileRow.fingerprint, 50);
  const profileIds = profiles
    .map((profile) => Number(profile.id))
    .filter((id) => Number.isFinite(id));
  if (profileIds.length === 0) return null;

  const latestRun = await diRunsService.getLatestRunByStageForDatasetProfiles(userId, {
    stage: 'forecast',
    status: 'succeeded',
    dataset_profile_ids: profileIds,
    limit: 80
  });
  if (!latestRun) return null;

  if (!Number.isFinite(requestedHorizon)) {
    return latestRun;
  }

  const metrics = await loadArtifactPayloadByType(latestRun.id, 'metrics');
  const actualHorizon = Number(metrics?.horizon_periods);
  if (!Number.isFinite(actualHorizon)) return null;
  return actualHorizon === requestedHorizon ? latestRun : null;
};

const loadForecastCardFromChildRun = async ({ childRunId, datasetProfileRow }) => {
  if (!childRunId) return null;

  const runRow = await diRunsService.getRun(Number(childRunId));
  if (!runRow) return null;

  const forecastSeries = await loadArtifactPayloadByType(childRunId, 'forecast_series');
  const metrics = await loadArtifactPayloadByType(childRunId, 'metrics');
  const reportJson = await loadArtifactPayloadByType(childRunId, 'report_json');
  // Prefer explicit forecast_csv; fallback to legacy csv for backward compatibility with old runs.
  const preferredCsvPayload = await loadArtifactPayloadByType(childRunId, 'forecast_csv');
  const legacyCsvPayload = preferredCsvPayload
    ? null
    : await loadArtifactPayloadByType(childRunId, 'csv');
  const csvPayload = preferredCsvPayload ?? legacyCsvPayload;
  const artifacts = await diRunsService.getArtifactsForRun(childRunId);
  const preferredCsvRef = toArtifactRef(getLatestArtifactRecordByType(artifacts, 'forecast_csv'));
  const legacyCsvRef = preferredCsvRef
    ? null
    : toArtifactRef(getLatestArtifactRecordByType(artifacts, 'csv'));
  const artifactRefs = {
    forecast_series: toArtifactRef(getLatestArtifactRecordByType(artifacts, 'forecast_series')),
    metrics: toArtifactRef(getLatestArtifactRecordByType(artifacts, 'metrics')),
    report_json: toArtifactRef(getLatestArtifactRecordByType(artifacts, 'report_json')),
    forecast_csv: preferredCsvRef || legacyCsvRef
  };

  return buildForecastCardPayload({
    run: runRow,
    forecast_series: forecastSeries || {},
    metrics: metrics || {},
    report_json: reportJson || {},
    csv: typeof csvPayload === 'string'
      ? csvPayload
      : (csvPayload?.content || ''),
    artifact_refs: artifactRefs,
    summary_text: 'Forecast loaded from cached artifacts.'
  }, datasetProfileRow);
};

const loadPlanResultFromChildRun = async ({ childRunId }) => {
  if (!childRunId) return null;

  const runRow = await diRunsService.getRun(Number(childRunId));
  if (!runRow) return null;

  const solverMeta = await loadArtifactPayloadByType(childRunId, 'solver_meta');
  const constraint = await loadArtifactPayloadByType(childRunId, 'constraint_check');
  const planTable = await loadArtifactPayloadByType(childRunId, 'plan_table');
  const replayMetrics = await loadArtifactPayloadByType(childRunId, 'replay_metrics');
  const projection = await loadArtifactPayloadByType(childRunId, 'inventory_projection');
  const componentPlanTable = await loadArtifactPayloadByType(childRunId, 'component_plan_table');
  const componentProjection = await loadArtifactPayloadByType(childRunId, 'component_inventory_projection');
  const bomExplosion = await loadArtifactPayloadByType(childRunId, 'bom_explosion');
  const bottlenecks = await loadArtifactPayloadByType(childRunId, 'bottlenecks');
  const report = await loadArtifactPayloadByType(childRunId, 'report_json');
  const decisionNarrative = await loadArtifactPayloadByType(childRunId, 'decision_narrative');
  const evidencePack = await loadArtifactPayloadByType(childRunId, 'evidence_pack');
  const riskAdjustments = await loadArtifactPayloadByType(childRunId, 'risk_adjustments');
  const riskSolverMeta = await loadArtifactPayloadByType(childRunId, 'risk_solver_meta');
  const riskPlanTable = await loadArtifactPayloadByType(childRunId, 'risk_plan_table');
  const riskReplayMetrics = await loadArtifactPayloadByType(childRunId, 'risk_replay_metrics');
  const riskInventoryProjection = await loadArtifactPayloadByType(childRunId, 'risk_inventory_projection');
  const planComparison = await loadArtifactPayloadByType(childRunId, 'plan_comparison');
  // Prefer explicit plan_csv; fallback to legacy csv for backward compatibility with old runs.
  const preferredCsvPayload = await loadArtifactPayloadByType(childRunId, 'plan_csv');
  const componentCsvPayload = await loadArtifactPayloadByType(childRunId, 'component_plan_csv');
  const riskPlanCsvPayload = await loadArtifactPayloadByType(childRunId, 'risk_plan_csv');
  const legacyCsvPayload = preferredCsvPayload
    ? null
    : await loadArtifactPayloadByType(childRunId, 'csv');
  const csvPayload = preferredCsvPayload ?? legacyCsvPayload;

  const artifacts = await diRunsService.getArtifactsForRun(childRunId);
  const preferredCsvRef = toArtifactRef(getLatestArtifactRecordByType(artifacts, 'plan_csv'));
  const legacyCsvRef = preferredCsvRef
    ? null
    : toArtifactRef(getLatestArtifactRecordByType(artifacts, 'csv'));
  const artifactRefs = {
    solver_meta: toArtifactRef(getLatestArtifactRecordByType(artifacts, 'solver_meta')),
    constraint_check: toArtifactRef(getLatestArtifactRecordByType(artifacts, 'constraint_check')),
    plan_table: toArtifactRef(getLatestArtifactRecordByType(artifacts, 'plan_table')),
    replay_metrics: toArtifactRef(getLatestArtifactRecordByType(artifacts, 'replay_metrics')),
    inventory_projection: toArtifactRef(getLatestArtifactRecordByType(artifacts, 'inventory_projection')),
    component_plan_table: toArtifactRef(getLatestArtifactRecordByType(artifacts, 'component_plan_table')),
    component_plan_csv: toArtifactRef(getLatestArtifactRecordByType(artifacts, 'component_plan_csv')),
    component_inventory_projection: toArtifactRef(getLatestArtifactRecordByType(artifacts, 'component_inventory_projection')),
    bom_explosion: toArtifactRef(getLatestArtifactRecordByType(artifacts, 'bom_explosion')),
    bottlenecks: toArtifactRef(getLatestArtifactRecordByType(artifacts, 'bottlenecks')),
    evidence_pack: toArtifactRef(getLatestArtifactRecordByType(artifacts, 'evidence_pack')),
    decision_narrative: toArtifactRef(getLatestArtifactRecordByType(artifacts, 'decision_narrative')),
    report_json: toArtifactRef(getLatestArtifactRecordByType(artifacts, 'report_json')),
    risk_adjustments: toArtifactRef(getLatestArtifactRecordByType(artifacts, 'risk_adjustments')),
    risk_solver_meta: toArtifactRef(getLatestArtifactRecordByType(artifacts, 'risk_solver_meta')),
    risk_plan_table: toArtifactRef(getLatestArtifactRecordByType(artifacts, 'risk_plan_table')),
    risk_replay_metrics: toArtifactRef(getLatestArtifactRecordByType(artifacts, 'risk_replay_metrics')),
    risk_inventory_projection: toArtifactRef(getLatestArtifactRecordByType(artifacts, 'risk_inventory_projection')),
    plan_comparison: toArtifactRef(getLatestArtifactRecordByType(artifacts, 'plan_comparison')),
    risk_plan_csv: toArtifactRef(getLatestArtifactRecordByType(artifacts, 'risk_plan_csv')),
    plan_csv: preferredCsvRef || legacyCsvRef
  };

  const normalizedPlanRows = Array.isArray(planTable?.rows) ? planTable.rows : [];
  const normalizedRiskPlanRows = Array.isArray(riskPlanTable?.rows) ? riskPlanTable.rows : [];
  const riskAware = (riskAdjustments || planComparison || riskPlanTable)
    ? {
        risk_adjustments: riskAdjustments || null,
        risk_solver_meta: riskSolverMeta || null,
        risk_plan: normalizedRiskPlanRows,
        risk_plan_artifact: riskPlanTable || { total_rows: normalizedRiskPlanRows.length, rows: normalizedRiskPlanRows, truncated: false },
        risk_replay_metrics: riskReplayMetrics || {},
        risk_inventory_projection: riskInventoryProjection || { total_rows: 0, rows: [], truncated: false },
        plan_comparison: planComparison || {},
        risk_plan_csv: typeof riskPlanCsvPayload === 'string'
          ? riskPlanCsvPayload
          : (riskPlanCsvPayload?.content || ''),
        artifact_refs: {
          risk_adjustments: artifactRefs.risk_adjustments || null,
          risk_solver_meta: artifactRefs.risk_solver_meta || null,
          risk_plan_table: artifactRefs.risk_plan_table || null,
          risk_replay_metrics: artifactRefs.risk_replay_metrics || null,
          risk_inventory_projection: artifactRefs.risk_inventory_projection || null,
          plan_comparison: artifactRefs.plan_comparison || null,
          risk_plan_csv: artifactRefs.risk_plan_csv || null,
        }
      }
    : null;

  return {
    run: runRow,
    forecast_run_id: null,
    solver_result: {
      status: solverMeta?.status || 'unknown',
      kpis: solverMeta?.kpis || {},
      solver_meta: solverMeta?.solver_meta || {},
      infeasible_reasons: solverMeta?.infeasible_reasons || [],
      proof: solverMeta?.proof || {},
      plan: normalizedPlanRows
    },
    plan_artifact: planTable || { total_rows: normalizedPlanRows.length, rows: normalizedPlanRows, truncated: false },
    constraint_check: constraint || { passed: false, violations: [] },
    replay_metrics: replayMetrics || {},
    inventory_projection: projection || { total_rows: 0, rows: [], truncated: false },
    component_plan_table: componentPlanTable || { total_rows: 0, rows: [], truncated: false },
    component_inventory_projection: componentProjection || { total_rows: 0, rows: [], truncated: false },
    bom_explosion: bomExplosion || null,
    bottlenecks: bottlenecks || { total_rows: 0, rows: [] },
    final_report: report || { summary: 'Report unavailable', key_results: [], exceptions: [], recommended_actions: [] },
    decision_narrative: decisionNarrative || null,
    evidence_pack: evidencePack || {},
    plan_csv: typeof csvPayload === 'string' ? csvPayload : (csvPayload?.content || ''),
    component_plan_csv: typeof componentCsvPayload === 'string'
      ? componentCsvPayload
      : (componentCsvPayload?.content || ''),
    artifact_refs: artifactRefs,
    summary_text: decisionNarrative?.summary_text || report?.summary || 'Plan loaded from cached artifacts.',
    risk_mode: riskAware ? 'on' : 'off',
    risk_aware: riskAware
  };
};

const stepHandlers = {
  async profile(ctx) {
    const cardPayload = buildDataSummaryCardPayload(ctx.datasetProfileRow);
    return {
      status: 'succeeded',
      input_ref: {
        dataset_profile_id: ctx.datasetProfileRow.id
      },
      output_ref: {
        dataset_profile_id: ctx.datasetProfileRow.id,
        workflow_guess: ctx.datasetProfileRow?.profile_json?.global?.workflow_guess || {},
        time_range_guess: ctx.datasetProfileRow?.profile_json?.global?.time_range_guess || {}
      },
      result_cards: [{ type: 'dataset_summary_card', payload: cardPayload }]
    };
  },

  async contract(ctx) {
    const datasets = Array.isArray(ctx.datasetProfileRow?.contract_json?.datasets)
      ? ctx.datasetProfileRow.contract_json.datasets
      : [];

    if (datasets.length === 0) {
      throw new WorkflowAError(
        WORKFLOW_ERROR_CODES.DATA_CONTRACT_MISSING_REQUIRED,
        'Contract step failed: no datasets found in contract_json.',
        {
          blockingQuestions: ['Please upload and map at least one dataset sheet.']
        }
      );
    }

    return {
      status: 'succeeded',
      input_ref: {
        dataset_profile_id: ctx.datasetProfileRow.id
      },
      output_ref: {
        dataset_count: datasets.length,
        upload_types: datasets.map((item) => item.upload_type).filter(Boolean)
      },
      result_cards: []
    };
  },

  async validate(ctx) {
    const contractValidation = ctx.datasetProfileRow?.contract_json?.validation || {};
    const status = normalizeStatus(contractValidation.status, 'fail');
    const reasons = Array.isArray(contractValidation.reasons) && contractValidation.reasons.length > 0
      ? contractValidation.reasons
      : ['Contract validation reasons unavailable.'];

    if (status !== 'pass') {
      const blockingQuestions = normalizeBlockingQuestions(
        ctx.datasetProfileRow?.profile_json?.global?.minimal_questions
      );

      throw new WorkflowAError(
        WORKFLOW_ERROR_CODES.DATA_CONTRACT_MISSING_REQUIRED,
        `Validation failed: ${reasons[0] || 'missing required fields.'}`,
        { blockingQuestions }
      );
    }

    return {
      status: 'succeeded',
      input_ref: {
        contract_status: status
      },
      output_ref: {
        validation_status: status,
        reasons
      },
      result_cards: [
        {
          type: 'validation_card',
          payload: {
            status: 'pass',
            reasons
          }
        }
      ]
    };
  },

  async forecast(ctx) {
    const requestedHorizon = getForecastHorizonFromSettings(ctx.settings);
    const allowAutomaticReuse = isReuseEnabled(ctx.settings) && !isForceRetrainEnabled(ctx.settings);
    const reuseCachedForecast = Boolean(ctx.settings?.use_cached_forecast);
    if (reuseCachedForecast) {
      const cached = await getSourceCachedOutput(ctx.settings, 'forecast');
      if (cached?.child_run_id) {
        const forecastCard = await loadForecastCardFromChildRun({
          childRunId: cached.child_run_id,
          datasetProfileRow: ctx.datasetProfileRow
        });
        if (forecastCard) {
          return {
            status: 'skipped',
            notice_text: 'Reused cached forecast from replay settings.',
            input_ref: {
              reuse_cached_forecast: true,
              replay_of_run_id: Number(ctx.settings?.replay_of_run_id)
            },
            output_ref: {
              cached_from_run_id: Number(ctx.settings?.replay_of_run_id),
              child_run_id: cached.child_run_id,
              reused: true
            },
            result_cards: [{ type: 'forecast_result_card', payload: forecastCard }]
          };
        }
      }
    }

    if (!reuseCachedForecast && allowAutomaticReuse) {
      const reusableRun = await findReusableForecastRun({
        userId: ctx.run.user_id,
        datasetProfileRow: ctx.datasetProfileRow,
        requestedHorizon
      });
      if (reusableRun?.id) {
        const forecastCard = await loadForecastCardFromChildRun({
          childRunId: reusableRun.id,
          datasetProfileRow: ctx.datasetProfileRow
        });
        if (forecastCard) {
          return {
            status: 'skipped',
            notice_text: 'Reused cached forecast (same dataset and settings).',
            input_ref: {
              reuse_cached_forecast: true,
              fingerprint: ctx.datasetProfileRow.fingerprint || null,
              requested_horizon_periods: requestedHorizon
            },
            output_ref: {
              cached_from_run_id: reusableRun.id,
              child_run_id: reusableRun.id,
              reused: true,
              reuse_reason: 'exact_fingerprint_and_settings_match'
            },
            result_cards: [{ type: 'forecast_result_card', payload: forecastCard }]
          };
        }
      }
    }

    const forecastResult = await runForecastFromDatasetProfile({
      userId: ctx.run.user_id,
      datasetProfileRow: ctx.datasetProfileRow,
      horizonPeriods: requestedHorizon,
      settings: ctx.settings
    });
    const forecastCard = buildForecastCardPayload(forecastResult, ctx.datasetProfileRow);

    return {
      status: 'succeeded',
      input_ref: {
        dataset_profile_id: ctx.datasetProfileRow.id
      },
      output_ref: {
        child_run_id: forecastResult?.run?.id || null,
        reused: false,
        metrics: {
          mape: forecastResult?.metrics?.mape ?? null,
          mae: forecastResult?.metrics?.mae ?? null,
          selected_model_global: forecastResult?.metrics?.selected_model_global ?? null,
          horizon_periods: forecastResult?.metrics?.horizon_periods ?? null,
          groups_processed: forecastResult?.metrics?.groups_processed ?? null
        }
      },
      result_cards: [{ type: 'forecast_result_card', payload: forecastCard }]
    };
  },

  async optimize(ctx) {
    const forecastStep = ctx.stepMap.get('forecast');
    const forecastRunId = Number(forecastStep?.output_ref?.child_run_id || NaN);
    const planSettings = getPlanSettingsFromContext(ctx.settings);

    const reuseCachedPlan = Boolean(ctx.settings?.use_cached_plan);
    if (reuseCachedPlan) {
      const cached = await getSourceCachedOutput(ctx.settings, 'optimize');
      if (cached?.child_run_id) {
        const cachedPlanResult = await loadPlanResultFromChildRun({
          childRunId: cached.child_run_id
        });
        if (cachedPlanResult) {
          return {
            status: 'skipped',
            notice_text: cachedPlanResult?.decision_narrative?.summary_text
              ? `Reused cached plan from replay settings. ${cachedPlanResult.decision_narrative.summary_text}`
              : 'Reused cached plan from replay settings.',
            input_ref: {
              reuse_cached_plan: true,
              replay_of_run_id: Number(ctx.settings?.replay_of_run_id)
            },
            output_ref: {
              cached_from_run_id: Number(ctx.settings?.replay_of_run_id),
              child_run_id: cached.child_run_id,
              reused: true,
              constraint_passed: cachedPlanResult?.constraint_check?.passed === true,
              artifact_refs: cachedPlanResult?.artifact_refs || {},
              risk_mode: cachedPlanResult?.risk_mode || 'off',
              risk_aware: cachedPlanResult?.risk_aware ? {
                num_impacted_skus: cachedPlanResult.risk_aware.risk_adjustments?.summary?.num_impacted_skus || 0,
                plan_comparison_ref: cachedPlanResult.artifact_refs?.plan_comparison || null
              } : null
            },
            result_cards: (() => {
              const cachedRiskPayload = (cachedPlanResult?.risk_mode === 'on' && cachedPlanResult?.risk_aware)
                ? buildRiskAwarePlanComparisonCardPayload(cachedPlanResult)
                : null;
              const cachedDecisionNarrative = cachedPlanResult?.decision_narrative || null;
              return [
                ...(cachedDecisionNarrative ? [{ type: 'decision_narrative_card', payload: cachedDecisionNarrative }] : []),
                ...(cachedDecisionNarrative?.requires_approval
                  ? [{ type: 'plan_approval_card', payload: { ...cachedDecisionNarrative, approval: null } }]
                  : []),
                { type: 'plan_summary_card', payload: buildPlanSummaryCardPayload(cachedPlanResult, ctx.datasetProfileRow) },
                { type: 'plan_table_card', payload: buildPlanTableCardPayload(cachedPlanResult) },
                { type: 'inventory_projection_card', payload: buildInventoryProjectionCardPayload(cachedPlanResult) },
                { type: 'plan_exceptions_card', payload: buildPlanExceptionsCardPayload(cachedPlanResult) },
                ...(buildBomBottlenecksCardPayload(cachedPlanResult).total_rows > 0
                  ? [{ type: 'bom_bottlenecks_card', payload: buildBomBottlenecksCardPayload(cachedPlanResult) }]
                  : []),
                { type: 'downloads_card', payload: buildPlanDownloadsPayload(cachedPlanResult) },
                ...(cachedRiskPayload
                  ? [{ type: 'risk_aware_plan_comparison_card', payload: cachedRiskPayload }]
                  : [])
              ];
            })()
          };
        }
      }
    }

    if (!Number.isFinite(forecastRunId)) {
      throw new WorkflowAError(
        WORKFLOW_ERROR_CODES.DATA_CONTRACT_MISSING_REQUIRED,
        'Optimize step requires a completed forecast run.',
        {
          nextActions: ['Run forecast step successfully first.', 'Then resume workflow from optimize step.']
        }
      );
    }

    const planResult = await runPlanFromDatasetProfile({
      userId: ctx.run.user_id,
      datasetProfileRow: ctx.datasetProfileRow,
      forecastRunId,
      planningHorizonDays: planSettings.planning_horizon_days,
      objectiveOverride: planSettings.objective,
      constraintsOverride: planSettings.constraints,
      settings: ctx.settings,
      // Risk-aware planning (opt-in via settings.plan.risk_mode='on' or settings.risk_mode='on')
      riskMode: planSettings.risk_mode,
      riskRunId: planSettings.risk_run_id,
      riskConfigOverrides: planSettings.risk_config_overrides,
      // Cross-pipeline trace ID propagation
      parentTraceId: ctx.settings?.import_trace_id || null
    });

    // ── Closed-loop evaluation (non-blocking, feature-flagged) ──────────────────
    let closedLoopResult = null;
    if (isClosedLoopEnabled(ctx.settings)) {
      try {
        // Load forecast series from the forecast step output for closed-loop analysis
        const forecastArtifacts = forecastRunId
          ? await diRunsService.getArtifactsForRun(forecastRunId).catch(() => [])
          : [];
        const forecastSeriesArt = forecastArtifacts.find(a => a.artifact_type === 'forecast_series');
        const forecastMetricsArt = forecastArtifacts.find(a => a.artifact_type === 'metrics');
        const forecastBundle = {
          series: forecastSeriesArt?.artifact_json?.series || [],
          metrics: forecastMetricsArt?.artifact_json || {}
        };
        // Calibration metadata (from PR-C, may not exist yet)
        const calibrationMeta = forecastMetricsArt?.artifact_json?.calibration_meta || null;

        // ── Load risk scores for T-RISK trigger evaluation ──────────────────
        let riskBundle = null;
        // 1. Try loading from risk_scan step in this run (if workflow included it)
        const riskScanStep = ctx.stepMap?.get('risk_scan');
        if (riskScanStep?.output_ref?.risk_scores_ref) {
          try {
            const riskPayload = await loadArtifact(riskScanStep.output_ref.risk_scores_ref);
            const riskRows = Array.isArray(riskPayload?.rows)
              ? riskPayload.rows
              : (Array.isArray(riskPayload) ? riskPayload : []);
            if (riskRows.length > 0) {
              riskBundle = { riskScores: riskRows };
            }
          } catch (riskErr) {
            console.warn('[workflowAEngine] Could not load risk scores from risk_scan step:', riskErr.message);
          }
        }
        // 2. Fallback: load from latest Workflow B run for this dataset profile
        if (!riskBundle && ctx.run?.user_id && ctx.datasetProfileRow?.id) {
          try {
            const latestRiskRun = await diRunsService.getLatestRunByStage(ctx.run.user_id, {
              stage: 'compute_risk',
              status: 'succeeded',
              dataset_profile_id: ctx.datasetProfileRow.id,
              workflow: 'workflow_B_risk_exceptions',
              limit: 1
            }).catch(() => null);
            if (latestRiskRun?.id) {
              const riskArtifacts = await diRunsService.getArtifactsForRun(latestRiskRun.id).catch(() => []);
              const riskScoresArt = riskArtifacts.find(a => a.artifact_type === 'risk_scores');
              const riskRows = Array.isArray(riskScoresArt?.artifact_json?.rows)
                ? riskScoresArt.artifact_json.rows
                : [];
              if (riskRows.length > 0) {
                riskBundle = { riskScores: riskRows };
                console.info(`[workflowAEngine] Loaded ${riskRows.length} risk scores from latest Workflow B run.`);
              }
            }
          } catch (riskErr) {
            console.warn('[workflowAEngine] Could not load risk scores from Workflow B:', riskErr.message);
          }
        }

        // ── Gap 8B: Load previousForecast for T-UNCERT / T-P50 trigger comparison ──
        let previousForecastForClosedLoop = null;
        try {
          const profileId = ctx.datasetProfileRow?.id;
          if (profileId && ctx.run?.user_id) {
            const prevRun = await diRunsService.getLatestRunByStage(ctx.run.user_id, {
              stage: 'forecast',
              status: 'succeeded',
              dataset_profile_id: profileId,
              workflow: 'workflow_A_replenishment',
              limit: 1
            }).catch(() => null);
            if (prevRun?.id && prevRun.id !== forecastRunId) {
              const prevArtifacts = await diRunsService.getArtifactsForRun(prevRun.id).catch(() => []);
              const prevSeriesArt = prevArtifacts.find(a => a.artifact_type === 'forecast_series');
              const prevMetricsArt = prevArtifacts.find(a => a.artifact_type === 'metrics');
              if (prevSeriesArt?.artifact_json) {
                previousForecastForClosedLoop = {
                  series: prevSeriesArt.artifact_json.series || [],
                  metrics: prevMetricsArt?.artifact_json || {}
                };
              }
            }
          }
        } catch (prevErr) {
          console.warn('[workflowAEngine] Failed to load previousForecast for closed-loop:', prevErr.message);
        }

        closedLoopResult = await runClosedLoop({
          userId: ctx.run.user_id,
          datasetProfileRow: ctx.datasetProfileRow,
          forecastRunId,
          forecastBundle,
          calibrationMeta,
          previousForecast: previousForecastForClosedLoop,
          riskBundle,
          settings: ctx.settings,
          mode: ctx.settings?.plan?.closed_loop_mode || 'manual_approve',
          configOverrides: ctx.settings?.plan?.closed_loop_config || {},
          planRunner: async (plannerParams) => {
            return runPlanFromDatasetProfile({
              userId: ctx.run.user_id,
              datasetProfileRow: ctx.datasetProfileRow,
              forecastRunId: plannerParams.forecastRunId || forecastRunId,
              objectiveOverride: plannerParams.objectiveOverride,
              constraintsOverride: plannerParams.constraintsOverride,
              settings: plannerParams.settings || ctx.settings,
              riskMode: planSettings.risk_mode,
            });
          },
          artifactSaver: (runId, type, payload) => saveJsonArtifact(runId, type, payload, ARTIFACT_THRESHOLD)
        });
      } catch (clError) {
        // Non-fatal: base plan result is always preserved
        console.warn('[workflowAEngine] Closed-loop evaluation failed (base plan unaffected):', clError.message);
      }
    }

    return {
      status: 'succeeded',
      notice_text: planResult?.decision_narrative?.summary_text || planResult?.summary_text || '',
      input_ref: {
        dataset_profile_id: ctx.datasetProfileRow.id,
        forecast_run_id: forecastRunId
      },
      output_ref: {
        child_run_id: planResult?.run?.id || null,
        reused: false,
        solver_status: planResult?.solver_result?.status || 'unknown',
        constraint_passed: planResult?.constraint_check?.passed === true,
        artifact_refs: planResult?.artifact_refs || {},
        risk_mode: planResult?.risk_mode || 'off',
        risk_aware: planResult?.risk_aware ? {
          num_impacted_skus: planResult.risk_aware.risk_adjustments?.summary?.num_impacted_skus || 0,
          plan_comparison_ref: planResult.artifact_refs?.plan_comparison || null
        } : null,
        closed_loop: closedLoopResult ? {
          status: closedLoopResult.closed_loop_status,
          run_id: closedLoopResult.closed_loop_run_id,
          triggered: closedLoopResult.trigger_decision?.should_trigger || false,
          rerun_submitted: closedLoopResult.planning_run_id != null
        } : null
      },
      result_cards: (() => {
        const riskComparisonPayload = (planResult?.risk_mode === 'on' && planResult?.risk_aware)
          ? buildRiskAwarePlanComparisonCardPayload(planResult)
          : null;
        const decisionNarrative = planResult?.decision_narrative || null;
        return [
          ...(decisionNarrative ? [{ type: 'decision_narrative_card', payload: decisionNarrative }] : []),
          ...(decisionNarrative?.requires_approval
            ? [{ type: 'plan_approval_card', payload: { ...decisionNarrative, approval: null } }]
            : []),
          { type: 'plan_summary_card', payload: buildPlanSummaryCardPayload(planResult, ctx.datasetProfileRow) },
          { type: 'plan_table_card', payload: buildPlanTableCardPayload(planResult) },
          { type: 'inventory_projection_card', payload: buildInventoryProjectionCardPayload(planResult) },
          { type: 'plan_exceptions_card', payload: buildPlanExceptionsCardPayload(planResult) },
          ...(buildBomBottlenecksCardPayload(planResult).total_rows > 0
            ? [{ type: 'bom_bottlenecks_card', payload: buildBomBottlenecksCardPayload(planResult) }]
            : []),
          { type: 'downloads_card', payload: buildPlanDownloadsPayload(planResult) },
          ...(riskComparisonPayload
            ? [{ type: 'risk_aware_plan_comparison_card', payload: riskComparisonPayload }]
            : []),
          ...(closedLoopResult?.trigger_decision?.should_trigger
            ? [{
                type: 'risk_trigger_notification_card',
                payload: {
                  closed_loop_status: closedLoopResult.closed_loop_status,
                  trigger_decision: closedLoopResult.trigger_decision,
                  param_patch: closedLoopResult.param_patch,
                  planning_run_id: closedLoopResult.planning_run_id || null,
                  requires_approval: closedLoopResult.requires_approval || false,
                }
              }]
            : [])
        ];
      })()
    };
  },

  async verify(ctx) {
    const optimizeStep = ctx.stepMap.get('optimize');
    const childRunId = Number(optimizeStep?.output_ref?.child_run_id || NaN);
    if (!Number.isFinite(childRunId)) {
      throw new WorkflowAError(
        WORKFLOW_ERROR_CODES.CONSTRAINT_VIOLATION,
        'Verify step requires optimize output run reference.'
      );
    }

    const constraint = await loadArtifactPayloadByType(childRunId, 'constraint_check');
    const replayMetrics = await loadArtifactPayloadByType(childRunId, 'replay_metrics');

    if (!constraint || constraint.passed !== true) {
      throw new WorkflowAError(
        WORKFLOW_ERROR_CODES.CONSTRAINT_VIOLATION,
        'Constraint check failed in optimize output.',
        {
          details: constraint || null
        }
      );
    }

    const serviceLevel = replayMetrics?.with_plan?.service_level_proxy;
    const reasons = [
      'Constraint checker passed all hard-gate rules.',
      Number.isFinite(serviceLevel)
        ? `Replay service-level proxy: ${(serviceLevel * 100).toFixed(2)}%`
        : 'Replay service-level proxy unavailable.'
    ];

    return {
      status: 'succeeded',
      input_ref: {
        optimize_run_id: childRunId
      },
      output_ref: {
        constraint_passed: true,
        service_level_proxy: Number.isFinite(serviceLevel) ? serviceLevel : null
      },
      result_cards: [{
        type: 'validation_card',
        payload: {
          status: 'pass',
          reasons
        }
      }]
    };
  },

  async topology(ctx) {
    const topologyScope = {
      ...(ctx.settings?.topology || {})
    };

    const topologyResult = await generateTopologyGraphForRun({
      userId: ctx.run.user_id,
      runId: ctx.run.id,
      scope: topologyScope,
      forceRebuild: Boolean(ctx.settings?.topology?.force_rebuild),
      reuse: isReuseEnabled(ctx.settings),
      manageRunStep: false
    });

    return {
      status: 'succeeded',
      notice_text: topologyResult?.reused
        ? `Topology graph reused from run #${topologyResult.reused_from_run_id}.`
        : 'Topology graph generated successfully.',
      input_ref: {
        scope: topologyScope
      },
      output_ref: {
        topology_graph_ref: topologyResult?.ref || null,
        settings_hash: topologyResult?.settings_hash || null,
        reused: Boolean(topologyResult?.reused),
        reused_from_run_id: topologyResult?.reused_from_run_id || null,
        node_count: Array.isArray(topologyResult?.graph?.nodes) ? topologyResult.graph.nodes.length : 0,
        edge_count: Array.isArray(topologyResult?.graph?.edges) ? topologyResult.graph.edges.length : 0
      },
      result_cards: []
    };
  },

  async report(ctx) {
    const optimizeStep = ctx.stepMap.get('optimize');
    const childRunId = Number(optimizeStep?.output_ref?.child_run_id || NaN);
    if (!Number.isFinite(childRunId)) {
      throw new WorkflowAError(WORKFLOW_ERROR_CODES.UNKNOWN, 'Report step missing optimize child run reference.');
    }

    const reportPayload = await loadArtifactPayloadByType(childRunId, 'report_json')
      || {
        summary: 'Report artifact unavailable.',
        key_results: [],
        exceptions: [],
        recommended_actions: []
      };

    const reportArtifact = await saveJsonArtifact(ctx.run.id, 'workflow_report_summary', reportPayload, ARTIFACT_THRESHOLD, {
      user_id: ctx.run.user_id,
      filename: `workflow_report_run_${ctx.run.id}.json`
    });

    // ── Decision Narrative (Gap 7A/7B/7E) ──────────────────────────────────
    let narrative = null;
    let narrativeRef = null;
    try {
      const [solverMeta, replayMetrics, negotiationOpts] = await Promise.all([
        loadArtifactPayloadByType(childRunId, 'solver_meta'),
        loadArtifactPayloadByType(childRunId, 'replay_metrics'),
        loadArtifactPayloadByType(childRunId, 'negotiation_options'),
      ]);

      if (solverMeta) {
        narrative = buildDecisionNarrative({
          solverStatus: solverMeta.status || 'FEASIBLE',
          solverKpis: solverMeta.kpis || {},
          proof: solverMeta.proof || {},
          infeasibleReasons: solverMeta.infeasible_reasons || [],
          infeasibleReasonDetails: solverMeta.infeasible_reason_details || [],
          replayMetrics: replayMetrics || {},
          negotiationOptions: negotiationOpts,
          runId: childRunId,
        });

        const saved = await saveJsonArtifact(ctx.run.id, 'decision_narrative', narrative, ARTIFACT_THRESHOLD, {
          user_id: ctx.run.user_id,
          filename: `decision_narrative_run_${ctx.run.id}.json`
        });
        narrativeRef = saved.ref;
      }
    } catch (err) {
      console.warn('[workflowAEngine] Decision narrative generation skipped:', err.message);
    }

    // ── Audit trail (Gap 7C) ────────────────────────────────────────────────
    try {
      recordPlanGenerated({
        userId: ctx.run.user_id,
        runId: childRunId,
        kpiSnapshot: {
          service_level: narrative?.situation?.service_level ?? null,
          total_cost: narrative?.situation?.total_cost ?? null,
          stockout_units: narrative?.situation?.stockout_units ?? null,
        },
        narrativeSummary: narrative?.summary_text || reportPayload.summary || '',
      }).catch(() => {}); // fire-and-forget
    } catch {
      // non-critical
    }

    // ── Result cards ────────────────────────────────────────────────────────
    const resultCards = [{
      type: 'workflow_report_card',
      payload: {
        summary: reportPayload.summary || '',
        key_results: Array.isArray(reportPayload.key_results) ? reportPayload.key_results : [],
        exceptions: Array.isArray(reportPayload.exceptions) ? reportPayload.exceptions : [],
        recommended_actions: Array.isArray(reportPayload.recommended_actions) ? reportPayload.recommended_actions : []
      }
    }];

    if (narrative) {
      resultCards.push({
        type: 'decision_narrative_card',
        payload: narrative
      });

      if (narrative.requires_approval) {
        resultCards.push({
          type: 'plan_approval_card',
          payload: {
            run_id: childRunId,
            narrative_summary: narrative.summary_text || '',
            solver_status: narrative.solver_status,
            kpi_snapshot: {
              service_level: narrative.situation?.service_level ?? null,
              total_cost: narrative.situation?.total_cost ?? null,
              stockout_units: narrative.situation?.stockout_units ?? null,
            },
            requires_approval: true,
          }
        });
      }
    }

    return {
      status: 'succeeded',
      input_ref: {
        optimize_run_id: childRunId
      },
      output_ref: {
        report_ref: reportArtifact.ref,
        decision_narrative_ref: narrativeRef,
        summary: reportPayload.summary || ''
      },
      result_cards: resultCards
    };
  }
};

async function executeStep({ run, datasetProfileRow, settings, stepRow, stepMap }) {
  const stepName = stepRow.step;
  const handler = stepHandlers[stepName];
  if (!handler) {
    throw new WorkflowAError(WORKFLOW_ERROR_CODES.UNKNOWN, `Unknown workflow step: ${stepName}`);
  }

  return handler({
    run,
    datasetProfileRow,
    settings,
    stepMap
  });
}

// Module-level cache for dataset profile rows (survives across steps within a run)
const _profileRowCache = new Map();
const _PROFILE_ROW_CACHE_MAX = 200;

function _evictProfileRowCache() {
  if (_profileRowCache.size <= _PROFILE_ROW_CACHE_MAX) return;
  // Delete oldest entries (Map iterates in insertion order)
  const excess = _profileRowCache.size - _PROFILE_ROW_CACHE_MAX;
  const keys = _profileRowCache.keys();
  for (let i = 0; i < excess; i++) {
    _profileRowCache.delete(keys.next().value);
  }
}

export async function startWorkflowA({ user_id, dataset_profile_id, settings = {}, profileRow: providedProfileRow = null }) {
  if (!user_id) throw new Error('user_id is required');
  if (!dataset_profile_id) throw new Error('dataset_profile_id is required');

  const profileRow = providedProfileRow || await datasetProfilesService.getDatasetProfileById(user_id, dataset_profile_id);
  if (!profileRow) {
    throw new WorkflowAError(WORKFLOW_ERROR_CODES.DATA_CONTRACT_MISSING_REQUIRED, `Dataset profile ${dataset_profile_id} not found.`);
  }
  // Cache for subsequent steps (runNextStep)
  _profileRowCache.set(String(dataset_profile_id), profileRow);
  _evictProfileRowCache();

  const run = await diRunsService.createRun({
    user_id,
    dataset_profile_id,
    workflow: 'workflow_A_replenishment',
    stage: 'profile'
  });

  await diRunsService.updateRunStatus({
    run_id: run.id,
    status: 'running',
    stage: 'profile',
    started_at: nowIso(),
    error: null
  });

  await ensureRunInitialized(run.id);
  await persistWorkflowSettings(run.id, user_id, {
    user_id,
    dataset_profile_id,
    settings: {
      ...settings
    },
    created_at: nowIso()
  });

  return buildRunSnapshot(run.id);
}

export async function runNextStep(run_id) {
  // Accept both numeric and local string IDs
  const runId = String(run_id || '').startsWith('local-') ? run_id : Number(run_id);
  if (!runId) throw new Error('run_id is required');
  if (typeof runId === 'number' && !Number.isFinite(runId)) throw new Error('run_id must be numeric or a local ID');

  const snapshotBefore = await buildRunSnapshot(runId);
  const run = snapshotBefore.run;
  if (!run) throw new Error(`Run ${run_id} not found`);

  if (RUN_TERMINAL_STATUSES.has(normalizeStatus(run.status))) {
    return {
      ...snapshotBefore,
      progressed_step: null,
      step_event: null,
      done: true
    };
  }

  const steps = snapshotBefore.steps.length > 0 ? snapshotBefore.steps : await ensureRunInitialized(runId);
  const stepMap = toStepMap(steps);
  const nextStep = findNextRunnableStep(steps);

  if (!nextStep) {
    const isWaiting = runHasBlockedStep(steps);
    const nextRunStatus = runIsSucceeded(steps) ? 'succeeded'
      : isWaiting ? 'waiting_user'
      : runHasFailedStep(steps) ? 'failed'
      : 'succeeded';
    const finalizedRun = await diRunsService.updateRunStatus({
      run_id: runId,
      status: nextRunStatus,
      finished_at: isWaiting ? null : nowIso(),
      error: nextRunStatus === 'failed' ? (run.error || 'Workflow failed') : null
    });

    // Clean up profile cache for completed/failed runs
    if (run.dataset_profile_id && !isWaiting) {
      _profileRowCache.delete(String(run.dataset_profile_id));
    }

    return {
      run: finalizedRun,
      steps,
      artifacts: snapshotBefore.artifacts,
      progressed_step: null,
      step_event: null,
      done: true
    };
  }

  const stepName = nextStep.step;

  await diRunsService.updateRunStep({
    run_id: runId,
    step: stepName,
    status: 'running',
    started_at: nowIso(),
    finished_at: null,
    error_code: null,
    error_message: null
  });

  await diRunsService.updateRunStatus({
    run_id: runId,
    status: 'running',
    stage: stepName,
    error: null
  });

  const settingsWrapper = await getWorkflowSettings(runId);
  let settings = settingsWrapper?.settings || settingsWrapper || {};
  const datasetProfileRow = _profileRowCache.get(String(run.dataset_profile_id))
    || await datasetProfilesService.getDatasetProfileById(run.user_id, run.dataset_profile_id);

  if (!datasetProfileRow) {
    const wfError = new WorkflowAError(
      WORKFLOW_ERROR_CODES.DATA_CONTRACT_MISSING_REQUIRED,
      `Dataset profile ${run.dataset_profile_id} not found for run ${runId}.`
    );

    await diRunsService.updateRunStep({
      run_id: runId,
      step: stepName,
      status: 'failed',
      finished_at: nowIso(),
      error_code: wfError.code,
      error_message: wfError.message,
      output_ref: {
        next_actions: wfError.nextActions,
        blocking_questions: wfError.blockingQuestions
      }
    });

    await diRunsService.updateRunStatus({
      run_id: runId,
      status: 'failed',
      finished_at: nowIso(),
      error: wfError.message
    });

    const finalSnapshot = await buildRunSnapshot(runId);
    return {
      ...finalSnapshot,
      progressed_step: stepName,
      step_event: {
        step: stepName,
        status: 'failed',
        error: {
          code: wfError.code,
          message: wfError.message,
          next_actions: wfError.nextActions,
          blocking_questions: wfError.blockingQuestions
        },
        result_cards: []
      },
      done: true
    };
  }

  if (isReuseEnabled(settings) && datasetProfileRow?.fingerprint) {
    try {
      const settingsTemplate = await reuseMemoryService.getRunSettingsTemplateByFingerprint(
        run.user_id,
        run.workflow || 'workflow_A_replenishment',
        datasetProfileRow.fingerprint
      );
      if (settingsTemplate?.settings_json) {
        settings = mergeSettings(settingsTemplate.settings_json, settings);
        settings.reused_settings_template_id = settingsTemplate.id;
      }
    } catch (error) {
      console.warn('[workflowAEngine] Failed to load settings template:', error.message);
    }
  }

  try {
    const stepResult = await executeStep({
      run,
      datasetProfileRow,
      settings,
      stepRow: nextStep,
      stepMap
    });

    const stepStatus = normalizeStatus(stepResult?.status, 'succeeded');
    await diRunsService.updateRunStep({
      run_id: runId,
      step: stepName,
      status: stepStatus,
      finished_at: nowIso(),
      error_code: null,
      error_message: null,
      input_ref: stepResult?.input_ref || null,
      output_ref: stepResult?.output_ref || null
    });

    const updatedSteps = await diRunsService.getRunSteps(runId);
    if (runIsSucceeded(updatedSteps)) {
      await diRunsService.updateRunStatus({
        run_id: runId,
        status: 'succeeded',
        finished_at: nowIso(),
        error: null,
        stage: 'report'
      });
    }

    const finalSnapshot = await buildRunSnapshot(runId);
    return {
      ...finalSnapshot,
      progressed_step: stepName,
      step_event: {
        step: stepName,
        status: stepStatus,
        error: null,
        notice_text: stepResult?.notice_text || null,
        result_cards: Array.isArray(stepResult?.result_cards) ? stepResult.result_cards : []
      },
      done: RUN_TERMINAL_STATUSES.has(normalizeStatus(finalSnapshot.run?.status))
    };
  } catch (error) {
    const wfError = asWorkflowError(error, stepName);
    const isBlocking = wfError.blockingQuestions.length > 0;
    const stepStatus = isBlocking ? 'blocked' : 'failed';
    const runStatus = isBlocking ? 'waiting_user' : 'failed';

    await diRunsService.updateRunStep({
      run_id: runId,
      step: stepName,
      status: stepStatus,
      finished_at: isBlocking ? null : nowIso(),
      error_code: wfError.code,
      error_message: wfError.message,
      output_ref: {
        next_actions: wfError.nextActions,
        blocking_questions: wfError.blockingQuestions,
        details: wfError.details || null
      }
    });

    await diRunsService.updateRunStatus({
      run_id: runId,
      status: runStatus,
      finished_at: isBlocking ? null : nowIso(),
      error: isBlocking ? null : `[${wfError.code}] ${wfError.message}`
    });

    const finalSnapshot = await buildRunSnapshot(runId);
    return {
      ...finalSnapshot,
      progressed_step: stepName,
      step_event: {
        step: stepName,
        status: stepStatus,
        error: {
          code: wfError.code,
          message: wfError.message,
          next_actions: wfError.nextActions,
          blocking_questions: wfError.blockingQuestions,
          details: wfError.details || null
        },
        result_cards: []
      },
      done: true
    };
  }
}

export async function resumeRun(run_id, options = {}) {
  const maxSteps = Number.isFinite(Number(options.maxSteps))
    ? Math.max(1, Number(options.maxSteps))
    : WORKFLOW_A_STEPS.length;

  const events = [];
  let latest = await buildRunSnapshot(run_id);

  const currentStatus = normalizeStatus(latest.run?.status);
  if (currentStatus === 'failed') {
    const safeRunId = String(run_id || '').startsWith('local-') ? run_id : Number(run_id);
    const resetResult = await resetFailedAndDownstreamSteps(safeRunId, latest.steps || []);
    await diRunsService.updateRunStatus({
      run_id: safeRunId,
      status: 'running',
      stage: resetResult.resetFromStep || latest.run?.stage || WORKFLOW_A_STEPS[0],
      finished_at: null,
      error: null
    });
    latest = await buildRunSnapshot(run_id);
  } else if (currentStatus === 'waiting_user') {
    const safeRunIdW = String(run_id || '').startsWith('local-') ? run_id : Number(run_id);
    const resetResult = await resetBlockedAndDownstreamSteps(safeRunIdW, latest.steps || []);
    await diRunsService.updateRunStatus({
      run_id: safeRunIdW,
      status: 'running',
      stage: resetResult.resetFromStep || latest.run?.stage || WORKFLOW_A_STEPS[0],
      finished_at: null,
      error: null
    });
    latest = await buildRunSnapshot(run_id);
  }

  for (let i = 0; i < maxSteps; i += 1) {
    if (RUN_TERMINAL_STATUSES.has(normalizeStatus(latest.run?.status))) {
      break;
    }

    const next = await runNextStep(run_id);
    latest = {
      run: next.run,
      steps: next.steps,
      artifacts: next.artifacts
    };

    if (next.step_event) {
      events.push(next.step_event);
    }

    if (RUN_TERMINAL_STATUSES.has(normalizeStatus(next.run?.status))) {
      break;
    }
  }

  return {
    ...latest,
    events,
    done: RUN_TERMINAL_STATUSES.has(normalizeStatus(latest.run?.status))
  };
}

export async function submitBlockingAnswers(run_id, answers = {}) {
  const runId = String(run_id || '').startsWith('local-') ? run_id : Number(run_id);
  if (typeof runId === 'number' && !Number.isFinite(runId)) throw new Error('run_id must be numeric or a local ID');

  const snapshot = await buildRunSnapshot(runId);
  const currentStatus = normalizeStatus(snapshot.run?.status);
  if (currentStatus !== 'waiting_user') {
    throw new Error(`Run ${runId} is not waiting_user (status: ${currentStatus})`);
  }

  const blockedStep = sortSteps(snapshot.steps || []).find((step) => normalizeStatus(step.status) === 'blocked') || null;
  const blockingQuestions = Array.isArray(blockedStep?.output_ref?.blocking_questions)
    ? blockedStep.output_ref.blocking_questions
    : [];
  const existingSettings = await getWorkflowSettings(runId);
  const profileRow = snapshot.run?.dataset_profile_id
    ? await datasetProfilesService.getDatasetProfileById(snapshot.run.user_id, snapshot.run.dataset_profile_id)
    : null;
  const {
    nextSettings,
    nextContractJson,
    answeredQuestions,
    appliedBindings,
    validationErrors,
  } = applyBlockingAnswerBindings({
    questions: blockingQuestions,
    answers,
    settings: existingSettings,
    contractJson: profileRow?.contract_json || {},
  });

  if (validationErrors.length > 0) {
    const summary = validationErrors
      .map((item) => item.question || item.id || item.reason)
      .filter(Boolean)
      .join(', ');
    throw new Error(`Invalid blocking answers for run ${runId}: ${summary}`);
  }

  const needsContractUpdate = appliedBindings.some((item) => item.target === 'contract');
  if (needsContractUpdate && !profileRow) {
    throw new Error(`Dataset profile ${snapshot.run?.dataset_profile_id} not found for run ${runId}`);
  }
  if (needsContractUpdate) {
    await datasetProfilesService.updateDatasetProfile(snapshot.run.user_id, snapshot.run.dataset_profile_id, {
      contract_json: nextContractJson,
    });
  }

  const merged = {
    ...nextSettings,
    blocking_answers: {
      ...(nextSettings.blocking_answers || {}),
      ...answers
    },
    last_blocking_step: blockedStep?.step || null,
    last_blocking_submission_at: nowIso(),
    last_blocking_submission: {
      step: blockedStep?.step || null,
      answered_questions: answeredQuestions,
      applied_bindings: appliedBindings,
    },
  };
  await persistWorkflowSettings(runId, snapshot.run.user_id, {
    user_id: snapshot.run.user_id,
    dataset_profile_id: snapshot.run.dataset_profile_id,
    settings: merged,
    updated_at: nowIso()
  });

  return resumeRun(runId);
}

export async function replayRun(run_id, { use_cached_forecast = false, use_cached_plan = false } = {}) {
  const sourceRun = await diRunsService.getRun(run_id);
  if (!sourceRun) throw new Error(`Run ${run_id} not found`);

  const sourceSettingsWrapper = await getWorkflowSettings(run_id);
  const sourceSettings = sourceSettingsWrapper?.settings || sourceSettingsWrapper || {};

  return startWorkflowA({
    user_id: sourceRun.user_id,
    dataset_profile_id: sourceRun.dataset_profile_id,
    settings: {
      ...sourceSettings,
      replay_of_run_id: String(run_id || '').startsWith('local-') ? run_id : Number(run_id),
      use_cached_forecast: Boolean(use_cached_forecast),
      use_cached_plan: Boolean(use_cached_plan)
    }
  });
}

export async function getWorkflowARunSnapshot(run_id) {
  return buildRunSnapshot(run_id);
}

export default {
  WORKFLOW_A_STEPS,
  WORKFLOW_ERROR_CODES,
  startWorkflowA,
  runNextStep,
  resumeRun,
  replayRun,
  getWorkflowARunSnapshot
};
