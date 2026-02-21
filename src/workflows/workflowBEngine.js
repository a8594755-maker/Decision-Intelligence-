import { datasetProfilesService } from '../services/datasetProfilesService';
import { diRunsService } from '../services/diRunsService';
import { reuseMemoryService } from '../services/reuseMemoryService';
import { buildDataSummaryCardPayload } from '../services/chatDatasetProfilingService';
import {
  computeRiskArtifactsFromDatasetProfile,
  buildRiskSummaryCardPayload,
  buildRiskDrilldownCardPayload,
  buildRiskExceptionsArtifacts,
  buildRiskExceptionsCardPayload,
  buildRiskReportJson,
  buildRiskDownloadsPayload
} from '../services/chatRiskService';
import { loadArtifact, saveCsvArtifact, saveJsonArtifact } from '../utils/artifactStore';

export const WORKFLOW_B_STEPS = ['profile', 'contract', 'validate', 'compute_risk', 'exceptions', 'report'];

const TERMINAL_STEP_STATUSES = new Set(['succeeded', 'failed', 'skipped']);
const RUN_TERMINAL_STATUSES = new Set(['succeeded', 'failed']);
const ARTIFACT_THRESHOLD = 200 * 1024;
const MAX_EXCEPTION_ROWS = 1000;

export const WORKFLOW_B_ERROR_CODES = {
  DATA_CONTRACT_MISSING_REQUIRED: 'DATA_CONTRACT_MISSING_REQUIRED',
  DATA_TYPE_VALIDATION_FAILED: 'DATA_TYPE_VALIDATION_FAILED',
  API_TIMEOUT: 'API_TIMEOUT',
  JSON_PARSE_FAILED: 'JSON_PARSE_FAILED',
  UNKNOWN: 'UNKNOWN'
};

const ERROR_ACTIONS = {
  [WORKFLOW_B_ERROR_CODES.DATA_CONTRACT_MISSING_REQUIRED]: [
    'Map required PO/receipt fields in the contract.',
    'Resume the workflow after saving mapping changes.'
  ],
  [WORKFLOW_B_ERROR_CODES.DATA_TYPE_VALIDATION_FAILED]: [
    'Fix invalid date/quantity types in mapped columns.',
    'Re-upload corrected data and rerun risk scan.'
  ],
  [WORKFLOW_B_ERROR_CODES.API_TIMEOUT]: [
    'Retry the run or resume from the failed step.',
    'Reduce data volume and retry if timeout persists.'
  ],
  [WORKFLOW_B_ERROR_CODES.JSON_PARSE_FAILED]: [
    'Continue using deterministic report output.',
    'Retry summary generation only if needed.'
  ],
  [WORKFLOW_B_ERROR_CODES.UNKNOWN]: [
    'Retry or resume from the failed step.',
    'Inspect run artifacts to diagnose the issue.'
  ]
};

class WorkflowBError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'WorkflowBError';
    this.code = code || WORKFLOW_B_ERROR_CODES.UNKNOWN;
    this.nextActions = Array.isArray(options.nextActions)
      ? options.nextActions.slice(0, 2)
      : (ERROR_ACTIONS[this.code] || ERROR_ACTIONS.UNKNOWN);
    this.blockingQuestions = Array.isArray(options.blockingQuestions)
      ? options.blockingQuestions.slice(0, 2)
      : [];
    this.details = options.details || null;
  }
}

const nowIso = () => new Date().toISOString();

const normalizeStatus = (value, fallback = 'queued') => {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || fallback;
};

const normalizeWorkflowName = (value) => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'workflow_B_risk_exceptions';
  if (raw === 'workflow_b') return 'workflow_B_risk_exceptions';
  if (raw === 'workflow_b_risk_exceptions') return 'workflow_B_risk_exceptions';
  return value;
};

const getStepOrder = (step) => WORKFLOW_B_STEPS.indexOf(step);

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
  if (error?.code && Object.values(WORKFLOW_B_ERROR_CODES).includes(error.code)) {
    return error.code;
  }

  const message = String(error?.message || '').toLowerCase();
  if (message.includes('timeout')) return WORKFLOW_B_ERROR_CODES.API_TIMEOUT;
  if (message.includes('json') && message.includes('parse')) return WORKFLOW_B_ERROR_CODES.JSON_PARSE_FAILED;
  if (message.includes('missing') && message.includes('required')) return WORKFLOW_B_ERROR_CODES.DATA_CONTRACT_MISSING_REQUIRED;
  if (message.includes('type') && message.includes('validation')) return WORKFLOW_B_ERROR_CODES.DATA_TYPE_VALIDATION_FAILED;

  if (step === 'validate' || step === 'contract') return WORKFLOW_B_ERROR_CODES.DATA_CONTRACT_MISSING_REQUIRED;
  return WORKFLOW_B_ERROR_CODES.UNKNOWN;
};

const asWorkflowError = (error, step) => {
  if (error instanceof WorkflowBError) return error;

  const code = classifyErrorCode(error, step);
  return new WorkflowBError(code, error?.message || 'Workflow step failed', {
    nextActions: error?.nextActions,
    blockingQuestions: error?.blockingQuestions,
    details: error?.details || null
  });
};

const runIsSucceeded = (steps = []) => {
  if (steps.length === 0) return false;
  return steps.every((step) => {
    const status = normalizeStatus(step.status);
    return status === 'succeeded' || status === 'skipped';
  });
};

const runHasFailedStep = (steps = []) => steps.some((step) => normalizeStatus(step.status) === 'failed');

const findNextRunnableStep = (steps = []) => {
  const ordered = sortSteps(steps);
  return ordered.find((step) => {
    const status = normalizeStatus(step.status);
    return status !== 'succeeded' && status !== 'skipped';
  }) || null;
};

const ensureRunInitialized = async (runId) => {
  await diRunsService.createRunSteps(runId, WORKFLOW_B_STEPS);
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

const persistWorkflowSettings = async (runId, userId, payload = {}) => {
  await saveJsonArtifact(runId, 'workflow_settings', payload, ARTIFACT_THRESHOLD, {
    user_id: userId,
    filename: `workflow_b_settings_run_${runId}.json`
  });
};

const getWorkflowSettings = async (runId) => {
  const artifacts = await diRunsService.getArtifactsForRun(runId);
  const settingsRecord = artifacts
    .filter((item) => item.artifact_type === 'workflow_settings')
    .sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0];

  if (!settingsRecord) return {};
  const payload = await loadArtifact({ artifact_id: settingsRecord.id, ...(settingsRecord.artifact_json || {}) });
  return payload?.settings || payload || {};
};

const mergeSettings = (templateSettings = {}, explicitSettings = {}) => ({
  ...(templateSettings || {}),
  ...(explicitSettings || {}),
  risk: {
    ...((templateSettings || {}).risk || {}),
    ...((explicitSettings || {}).risk || {})
  }
});

const isReuseEnabled = (settings = {}) => settings?.reuse_enabled !== false;

const buildValidationPayload = (profileRow) => {
  const validation = profileRow?.contract_json?.validation || {};
  return {
    status: validation.status || 'fail',
    reasons: Array.isArray(validation.reasons) && validation.reasons.length > 0
      ? validation.reasons
      : ['Validation reasons unavailable']
  };
};

const flattenRiskRowsForCsv = (riskScores = []) => {
  return (Array.isArray(riskScores) ? riskScores : []).map((item) => ({
    entity_type: item.entity_type,
    entity_id: item.entity_id,
    supplier: item.supplier || '',
    material_code: item.material_code || '',
    plant_id: item.plant_id || '',
    risk_score: item.risk_score,
    on_time_rate: item.metrics?.on_time_rate ?? '',
    avg_delay_days: item.metrics?.avg_delay_days ?? '',
    p90_delay_days: item.metrics?.p90_delay_days ?? '',
    lead_time_variability: item.metrics?.lead_time_variability ?? '',
    open_backlog_qty: item.metrics?.open_backlog_qty ?? '',
    overdue_open_qty: item.metrics?.overdue_open_qty ?? '',
    overdue_ratio: item.metrics?.overdue_ratio ?? '',
    recent_trend: item.metrics?.recent_trend ?? ''
  }));
};

const flattenExceptionsForCsv = (exceptions = []) => {
  return (Array.isArray(exceptions) ? exceptions : []).map((item) => ({
    severity: item.severity,
    risk_score: item.risk_score,
    entity_type: item.entity?.entity_type || '',
    entity_id: item.entity?.entity_id || '',
    supplier: item.entity?.supplier || '',
    material_code: item.entity?.material_code || '',
    plant_id: item.entity?.plant_id || '',
    description: item.description || '',
    recommended_actions: Array.isArray(item.recommended_actions)
      ? item.recommended_actions.join(' | ')
      : '',
    evidence_refs: Array.isArray(item.evidence_refs)
      ? item.evidence_refs.join(' | ')
      : ''
  }));
};

const loadArtifactFromStepRef = async (stepMap, stepName, refKey) => {
  const step = stepMap.get(stepName);
  const ref = step?.output_ref?.[refKey];
  if (!ref) return null;
  return loadArtifact(ref);
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
        workflow_guess: ctx.datasetProfileRow?.profile_json?.global?.workflow_guess || {}
      },
      result_cards: [{ type: 'dataset_summary_card', payload: cardPayload }]
    };
  },

  async contract(ctx) {
    const datasets = Array.isArray(ctx.datasetProfileRow?.contract_json?.datasets)
      ? ctx.datasetProfileRow.contract_json.datasets
      : [];

    if (datasets.length === 0) {
      throw new WorkflowBError(
        WORKFLOW_B_ERROR_CODES.DATA_CONTRACT_MISSING_REQUIRED,
        'Contract step failed: no datasets found in contract_json.',
        {
          blockingQuestions: ['Please upload and map po_open_lines and goods_receipt sheets.']
        }
      );
    }

    const hasPo = datasets.some((dataset) => String(dataset.upload_type || '').toLowerCase() === 'po_open_lines');
    const hasReceipt = datasets.some((dataset) => String(dataset.upload_type || '').toLowerCase() === 'goods_receipt');
    if (!hasPo || !hasReceipt) {
      throw new WorkflowBError(
        WORKFLOW_B_ERROR_CODES.DATA_CONTRACT_MISSING_REQUIRED,
        'Workflow B requires both po_open_lines and goods_receipt datasets.',
        {
          blockingQuestions: [
            !hasPo ? 'Please map at least one sheet to po_open_lines.' : null,
            !hasReceipt ? 'Please map at least one sheet to goods_receipt.' : null
          ].filter(Boolean)
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
    const validationPayload = buildValidationPayload(ctx.datasetProfileRow);
    const status = normalizeStatus(validationPayload.status, 'fail');
    if (status !== 'pass') {
      const blockingQuestions = Array.isArray(ctx.datasetProfileRow?.profile_json?.global?.minimal_questions)
        ? ctx.datasetProfileRow.profile_json.global.minimal_questions.slice(0, 2)
        : [];

      throw new WorkflowBError(
        WORKFLOW_B_ERROR_CODES.DATA_CONTRACT_MISSING_REQUIRED,
        `Validation failed: ${validationPayload.reasons[0] || 'missing required fields.'}`,
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
        reasons: validationPayload.reasons
      },
      result_cards: [{
        type: 'validation_card',
        payload: validationPayload
      }]
    };
  },

  async compute_risk(ctx) {
    const riskArtifacts = await computeRiskArtifactsFromDatasetProfile({
      userId: ctx.run.user_id,
      datasetProfileRow: ctx.datasetProfileRow
    });

    const riskScoresPayload = {
      total_rows: riskArtifacts.risk_scores.length,
      rows: riskArtifacts.risk_scores
    };
    const supportingPayload = riskArtifacts.supporting_metrics || {};

    const riskScoresSaved = await saveJsonArtifact(ctx.run.id, 'risk_scores', riskScoresPayload, ARTIFACT_THRESHOLD, {
      user_id: ctx.run.user_id,
      filename: `risk_scores_run_${ctx.run.id}.json`
    });
    const supportingSaved = await saveJsonArtifact(ctx.run.id, 'supporting_metrics', supportingPayload, ARTIFACT_THRESHOLD, {
      user_id: ctx.run.user_id,
      filename: `supporting_metrics_run_${ctx.run.id}.json`
    });
    const riskCsvSaved = await saveCsvArtifact(
      ctx.run.id,
      'risk_scores_csv',
      flattenRiskRowsForCsv(riskArtifacts.risk_scores),
      `risk_scores_run_${ctx.run.id}.csv`,
      ARTIFACT_THRESHOLD,
      { user_id: ctx.run.user_id }
    );

    const artifactRefs = {
      risk_scores: riskScoresSaved.ref,
      supporting_metrics: supportingSaved.ref,
      risk_scores_csv: riskCsvSaved.ref
    };

    return {
      status: 'succeeded',
      input_ref: {
        dataset_profile_id: ctx.datasetProfileRow.id
      },
      output_ref: {
        artifact_refs: artifactRefs,
        risk_scores_ref: riskScoresSaved.ref,
        supporting_metrics_ref: supportingSaved.ref,
        risk_scores_csv_ref: riskCsvSaved.ref,
        total_entities: riskArtifacts.risk_scores.length
      },
      result_cards: [
        {
          type: 'risk_summary_card',
          payload: buildRiskSummaryCardPayload({
            run: ctx.run,
            datasetProfileRow: ctx.datasetProfileRow,
            risk_scores: riskArtifacts.risk_scores,
            supporting_metrics: supportingPayload
          })
        },
        {
          type: 'risk_drilldown_card',
          payload: buildRiskDrilldownCardPayload({
            run: ctx.run,
            risk_scores: riskArtifacts.risk_scores,
            supporting_metrics: supportingPayload
          })
        }
      ]
    };
  },

  async exceptions(ctx) {
    const riskScoresPayload = await loadArtifactFromStepRef(ctx.stepMap, 'compute_risk', 'risk_scores_ref');
    const riskScores = Array.isArray(riskScoresPayload?.rows)
      ? riskScoresPayload.rows
      : (Array.isArray(riskScoresPayload) ? riskScoresPayload : []);

    if (riskScores.length === 0) {
      throw new WorkflowBError(
        WORKFLOW_B_ERROR_CODES.DATA_TYPE_VALIDATION_FAILED,
        'Exceptions step requires non-empty risk_scores artifact.'
      );
    }

    const exceptionsArtifact = buildRiskExceptionsArtifacts({
      risk_scores: riskScores
    });

    const trimmedExceptions = (exceptionsArtifact.exceptions || []).slice(0, MAX_EXCEPTION_ROWS);
    const savedExceptions = await saveJsonArtifact(
      ctx.run.id,
      'exceptions',
      {
        exceptions: trimmedExceptions,
        aggregates: exceptionsArtifact.aggregates || {},
        truncated: trimmedExceptions.length < (exceptionsArtifact.exceptions || []).length
      },
      ARTIFACT_THRESHOLD,
      {
        user_id: ctx.run.user_id,
        filename: `exceptions_run_${ctx.run.id}.json`
      }
    );
    const exceptionsCsvSaved = await saveCsvArtifact(
      ctx.run.id,
      'exceptions_csv',
      flattenExceptionsForCsv(trimmedExceptions),
      `exceptions_run_${ctx.run.id}.csv`,
      ARTIFACT_THRESHOLD,
      { user_id: ctx.run.user_id }
    );

    const previousRefs = ctx.stepMap.get('compute_risk')?.output_ref?.artifact_refs || {};
    const artifactRefs = {
      ...previousRefs,
      exceptions: savedExceptions.ref,
      exceptions_csv: exceptionsCsvSaved.ref
    };

    return {
      status: 'succeeded',
      input_ref: {
        risk_scores_ref: ctx.stepMap.get('compute_risk')?.output_ref?.risk_scores_ref || null
      },
      output_ref: {
        artifact_refs: artifactRefs,
        exceptions_ref: savedExceptions.ref,
        exceptions_csv_ref: exceptionsCsvSaved.ref,
        total_exceptions: trimmedExceptions.length,
        aggregates: exceptionsArtifact.aggregates || {}
      },
      result_cards: [{
        type: 'risk_exceptions_card',
        payload: buildRiskExceptionsCardPayload({
          run: ctx.run,
          exceptionsArtifact: {
            exceptions: trimmedExceptions,
            aggregates: exceptionsArtifact.aggregates || {}
          }
        })
      }]
    };
  },

  async report(ctx) {
    const riskScoresPayload = await loadArtifactFromStepRef(ctx.stepMap, 'compute_risk', 'risk_scores_ref');
    const supportingPayload = await loadArtifactFromStepRef(ctx.stepMap, 'compute_risk', 'supporting_metrics_ref');
    const exceptionsPayload = await loadArtifactFromStepRef(ctx.stepMap, 'exceptions', 'exceptions_ref');

    const riskScores = Array.isArray(riskScoresPayload?.rows)
      ? riskScoresPayload.rows
      : (Array.isArray(riskScoresPayload) ? riskScoresPayload : []);
    const exceptionsArtifact = {
      exceptions: Array.isArray(exceptionsPayload?.exceptions) ? exceptionsPayload.exceptions : [],
      aggregates: exceptionsPayload?.aggregates || {}
    };

    const reportPayload = buildRiskReportJson({
      risk_scores: riskScores,
      exceptions: exceptionsArtifact.exceptions,
      supporting_metrics: supportingPayload || {}
    });

    const reportSaved = await saveJsonArtifact(ctx.run.id, 'report_json', reportPayload, ARTIFACT_THRESHOLD, {
      user_id: ctx.run.user_id,
      filename: `workflow_b_report_run_${ctx.run.id}.json`
    });

    const computeRefs = ctx.stepMap.get('compute_risk')?.output_ref?.artifact_refs || {};
    const exceptionRefs = ctx.stepMap.get('exceptions')?.output_ref?.artifact_refs || {};
    const artifactRefs = {
      ...computeRefs,
      ...exceptionRefs,
      report_json: reportSaved.ref
    };

    const riskCsv = await loadArtifact(ctx.stepMap.get('compute_risk')?.output_ref?.risk_scores_csv_ref || null);
    const exceptionsCsv = await loadArtifact(ctx.stepMap.get('exceptions')?.output_ref?.exceptions_csv_ref || null);

    if (ctx.datasetProfileRow?.fingerprint) {
      const settingsPayload = {
        risk: {
          top_entity_threshold: 70,
          medium_entity_threshold: 55
        },
        reuse_enabled: ctx.settings?.reuse_enabled !== false
      };
      reuseMemoryService.upsertRunSettingsTemplate({
        user_id: ctx.run.user_id,
        fingerprint: ctx.datasetProfileRow.fingerprint,
        workflow: 'workflow_B_risk_exceptions',
        settings_json: settingsPayload,
        quality_delta: (exceptionsArtifact.aggregates?.high || 0) > 0 ? 0.03 : 0.06
      }).catch((error) => {
        console.warn('[workflowBEngine] Failed to upsert risk settings template:', error.message);
      });
    }

    return {
      status: 'succeeded',
      input_ref: {
        risk_scores_ref: ctx.stepMap.get('compute_risk')?.output_ref?.risk_scores_ref || null,
        exceptions_ref: ctx.stepMap.get('exceptions')?.output_ref?.exceptions_ref || null
      },
      output_ref: {
        artifact_refs: artifactRefs,
        report_ref: reportSaved.ref,
        summary: reportPayload.summary || ''
      },
      result_cards: [
        {
          type: 'workflow_report_card',
          payload: {
            summary: reportPayload.summary || '',
            key_results: Array.isArray(reportPayload.key_results) ? reportPayload.key_results : [],
            exceptions: Array.isArray(reportPayload.exceptions) ? reportPayload.exceptions : [],
            recommended_actions: Array.isArray(reportPayload.recommended_actions)
              ? reportPayload.recommended_actions
              : []
          }
        },
        {
          type: 'downloads_card',
          payload: buildRiskDownloadsPayload({
            run: ctx.run,
            risk_scores: riskScores,
            supporting_metrics: supportingPayload || {},
            exceptionsArtifact,
            report_json: reportPayload,
            artifact_refs: artifactRefs,
            risk_scores_csv: typeof riskCsv === 'string' ? riskCsv : (riskCsv?.content || ''),
            exceptions_csv: typeof exceptionsCsv === 'string' ? exceptionsCsv : (exceptionsCsv?.content || '')
          })
        }
      ]
    };
  }
};

async function executeStep({ run, datasetProfileRow, settings, stepRow, stepMap }) {
  const stepName = stepRow.step;
  const handler = stepHandlers[stepName];
  if (!handler) {
    throw new WorkflowBError(WORKFLOW_B_ERROR_CODES.UNKNOWN, `Unknown workflow step: ${stepName}`);
  }

  return handler({
    run,
    datasetProfileRow,
    settings,
    stepMap
  });
}

export async function startWorkflowB({ user_id, dataset_profile_id, settings = {}, workflow = 'workflow_B_risk_exceptions' }) {
  if (!user_id) throw new Error('user_id is required');
  if (!dataset_profile_id) throw new Error('dataset_profile_id is required');

  const profileRow = await datasetProfilesService.getDatasetProfileById(user_id, dataset_profile_id);
  if (!profileRow) {
    throw new WorkflowBError(
      WORKFLOW_B_ERROR_CODES.DATA_CONTRACT_MISSING_REQUIRED,
      `Dataset profile ${dataset_profile_id} not found.`
    );
  }

  const run = await diRunsService.createRun({
    user_id,
    dataset_profile_id,
    workflow: normalizeWorkflowName(workflow),
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
  const runId = Number(run_id);
  if (!Number.isFinite(runId)) throw new Error('run_id must be numeric');

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
    const nextRunStatus = runIsSucceeded(steps) ? 'succeeded' : (runHasFailedStep(steps) ? 'failed' : 'succeeded');
    const finalizedRun = await diRunsService.updateRunStatus({
      run_id: runId,
      status: nextRunStatus,
      finished_at: nowIso(),
      error: nextRunStatus === 'failed' ? (run.error || 'Workflow failed') : null
    });

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
  const datasetProfileRow = await datasetProfilesService.getDatasetProfileById(run.user_id, run.dataset_profile_id);

  if (!datasetProfileRow) {
    const wfError = new WorkflowBError(
      WORKFLOW_B_ERROR_CODES.DATA_CONTRACT_MISSING_REQUIRED,
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
        normalizeWorkflowName(run.workflow),
        datasetProfileRow.fingerprint
      );
      if (settingsTemplate?.settings_json) {
        settings = mergeSettings(settingsTemplate.settings_json, settings);
        settings.reused_settings_template_id = settingsTemplate.id;
      }
    } catch (error) {
      console.warn('[workflowBEngine] Failed to load settings template:', error.message);
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

    await diRunsService.updateRunStep({
      run_id: runId,
      step: stepName,
      status: 'failed',
      finished_at: nowIso(),
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
      status: 'failed',
      finished_at: nowIso(),
      error: `[${wfError.code}] ${wfError.message}`
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
    : WORKFLOW_B_STEPS.length;

  const events = [];
  let latest = await buildRunSnapshot(run_id);

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

export async function replayRun(run_id, options = {}) {
  const sourceRun = await diRunsService.getRun(run_id);
  if (!sourceRun) throw new Error(`Run ${run_id} not found`);

  const sourceSettingsWrapper = await getWorkflowSettings(run_id);
  const sourceSettings = sourceSettingsWrapper?.settings || sourceSettingsWrapper || {};

  return startWorkflowB({
    user_id: sourceRun.user_id,
    dataset_profile_id: sourceRun.dataset_profile_id,
    workflow: normalizeWorkflowName(sourceRun.workflow),
    settings: {
      ...sourceSettings,
      ...options
    }
  });
}

export async function getWorkflowBRunSnapshot(run_id) {
  return buildRunSnapshot(run_id);
}

export default {
  WORKFLOW_B_STEPS,
  WORKFLOW_B_ERROR_CODES,
  startWorkflowB,
  runNextStep,
  resumeRun,
  replayRun,
  getWorkflowBRunSnapshot
};
