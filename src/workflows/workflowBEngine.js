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
  buildPODelayAlertCardPayload,
  buildRiskReportJson,
  buildRiskDownloadsPayload
} from '../services/chatRiskService';
import { generateTopologyGraphForRun } from '../services/topology/topologyService';
import { loadArtifact, saveCsvArtifact, saveJsonArtifact } from '../utils/artifactStore';
import { evaluateRiskReplanRecommendation } from '../services/riskClosedLoopService';
import { evaluateClosedLoopAfterWorkflowB } from '../services/closed_loop/workflowBClosedLoopBridge.js';
import { generateAlerts } from '../services/proactiveAlertService.js';
import { applyBlockingAnswerBindings } from './blockingAnswerUtils.js';

export const WORKFLOW_B_STEPS = ['profile', 'contract', 'validate', 'compute_risk', 'exceptions', 'topology', 'report'];

const TERMINAL_STEP_STATUSES = new Set(['succeeded', 'failed', 'skipped', 'blocked']);
const RUN_TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'waiting_user']);
const ARTIFACT_THRESHOLD = 200 * 1024;
const MAX_EXCEPTION_ROWS = 1000;
const MAX_BLOCKING_QUESTIONS = 2;

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

class WorkflowBError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'WorkflowBError';
    this.code = code || WORKFLOW_B_ERROR_CODES.UNKNOWN;
    this.nextActions = Array.isArray(options.nextActions)
      ? options.nextActions.slice(0, 2)
      : (ERROR_ACTIONS[this.code] || ERROR_ACTIONS.UNKNOWN);
    this.blockingQuestions = normalizeBlockingQuestions(options.blockingQuestions);
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
      const blockingQuestions = normalizeBlockingQuestions(
        ctx.datasetProfileRow?.profile_json?.global?.minimal_questions
      );

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

    // Save PO delay signals artifact
    const poDelayResult = riskArtifacts.po_delay_result || {};
    const poDelayPayload = {
      po_delay_signals: (poDelayResult.po_delay_signals || []).slice(0, 200),
      high_risk_pos: (poDelayResult.high_risk_pos || []).slice(0, 50),
      critical_risk_pos: (poDelayResult.critical_risk_pos || []).slice(0, 20),
      summary: poDelayResult.summary || {},
    };
    const poDelaySaved = await saveJsonArtifact(ctx.run.id, 'po_delay_signals', poDelayPayload, ARTIFACT_THRESHOLD, {
      user_id: ctx.run.user_id,
      filename: `po_delay_signals_run_${ctx.run.id}.json`
    });

    const artifactRefs = {
      risk_scores: riskScoresSaved.ref,
      supporting_metrics: supportingSaved.ref,
      risk_scores_csv: riskCsvSaved.ref,
      po_delay_signals: poDelaySaved.ref
    };

    // Build result cards
    const resultCards = [
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
    ];

    // Add PO delay alert card if high-risk POs detected
    const highRiskPos = poDelayResult.high_risk_pos || [];
    if (highRiskPos.length > 0) {
      resultCards.push({
        type: 'po_delay_alert_card',
        payload: buildPODelayAlertCardPayload({
          run: ctx.run,
          poDelayResult,
          supplierStats: riskArtifacts.supplier_stats || []
        })
      });
    }

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
        po_delay_signals_ref: poDelaySaved.ref,
        total_entities: riskArtifacts.risk_scores.length
      },
      result_cards: resultCards
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

    // ── Risk Replan evaluation (non-blocking) ─────────────────────────────────
    let riskReplanCard = null;
    try {
      const latestPlanRun = await diRunsService.getLatestRunByStage(ctx.run.user_id, {
        stage: 'report',
        status: 'succeeded',
        dataset_profile_id: ctx.datasetProfileRow.id,
        workflow: 'workflow_A_replenishment',
        limit: 1
      }).catch(() => null);

      const evaluation = evaluateRiskReplanRecommendation({
        userId: ctx.run.user_id,
        datasetProfileId: ctx.datasetProfileRow.id,
        riskRunId: ctx.run.id,
        riskScores: riskScores,
        planRunId: latestPlanRun?.id ?? null,
      });

      if (evaluation.shouldReplan && evaluation.recommendationCard) {
        riskReplanCard = evaluation.recommendationCard;
        console.info(
          `[workflowBEngine] Risk replan recommended: ${evaluation.analysis.highRiskSkus.length} high-risk SKUs`
        );
      }
    } catch (err) {
      console.warn('[workflowBEngine] Risk replan evaluation failed (non-blocking):', err.message);
    }

    // ── Gap 8D: Closed-loop bridge — evaluate whether Workflow A needs re-parameterization ──
    let closedLoopBridgeResult = null;
    try {
      const bridgeMode = ctx.settings?.closed_loop_bridge_mode || 'notify_only';
      closedLoopBridgeResult = await evaluateClosedLoopAfterWorkflowB({
        userId: ctx.run.user_id,
        workflowBRunId: ctx.run.id,
        datasetProfileId: ctx.datasetProfileRow.id,
        datasetProfileRow: ctx.datasetProfileRow,
        settings: ctx.settings,
        bridgeMode,
      });
    } catch (bridgeErr) {
      console.warn('[workflowBEngine] Closed-loop bridge evaluation failed (non-blocking):', bridgeErr.message);
    }

    // ── Gap 8E: Proactive alerts — generate prioritized risk alerts ──────────
    let proactiveAlertCard = null;
    try {
      const stockoutData = riskScores
        .filter((r) => r.entity_type === 'supplier_material' && (r.impact_usd || r.p_stockout))
        .map((r) => ({
          material_code: r.material_code,
          plant_id: r.plant_id,
          p_stockout: Number(r.p_stockout ?? r.metrics?.p_stockout ?? 0),
          impact_usd: Number(r.impact_usd ?? 0),
          days_to_stockout: Number(r.days_to_stockout ?? Infinity),
        }));

      const alertResult = generateAlerts({ riskScores, stockoutData });
      if (alertResult.alerts.length > 0) {
        proactiveAlertCard = {
          type: 'proactive_alert_card',
          payload: alertResult,
        };
      }
    } catch (alertErr) {
      console.warn('[workflowBEngine] Proactive alerts generation failed (non-blocking):', alertErr.message);
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
        summary: reportPayload.summary || '',
        closed_loop_bridge: closedLoopBridgeResult ? {
          triggered: closedLoopBridgeResult.triggered,
          status: closedLoopBridgeResult.closed_loop_status,
          planning_run_id: closedLoopBridgeResult.planning_run_id,
        } : null
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
        },
        ...(riskReplanCard ? [riskReplanCard] : []),
        ...(closedLoopBridgeResult?.triggered && closedLoopBridgeResult?.param_patch
          ? [{
              type: 'risk_trigger_notification_card',
              payload: {
                closed_loop_status: closedLoopBridgeResult.closed_loop_status,
                trigger_decision: { should_trigger: true, reasons: [] },
                param_patch: closedLoopBridgeResult.param_patch,
                planning_run_id: closedLoopBridgeResult.planning_run_id,
                requires_approval: true,
              }
            }]
          : []),
        ...(proactiveAlertCard ? [proactiveAlertCard] : [])
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
  const runId = String(run_id || '').startsWith('local-') ? run_id : Number(run_id);
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
    : WORKFLOW_B_STEPS.length;

  const safeRunId = String(run_id || '').startsWith('local-') ? run_id : Number(run_id);
  const events = [];
  let latest = await buildRunSnapshot(safeRunId);

  const currentStatus = normalizeStatus(latest.run?.status);
  if (currentStatus === 'failed') {
    const resetResult = await resetFailedAndDownstreamSteps(safeRunId, latest.steps || []);
    await diRunsService.updateRunStatus({
      run_id: safeRunId,
      status: 'running',
      stage: resetResult.resetFromStep || latest.run?.stage || WORKFLOW_B_STEPS[0],
      finished_at: null,
      error: null
    });
    latest = await buildRunSnapshot(safeRunId);
  } else if (currentStatus === 'waiting_user') {
    const resetResult = await resetBlockedAndDownstreamSteps(safeRunId, latest.steps || []);
    await diRunsService.updateRunStatus({
      run_id: safeRunId,
      status: 'running',
      stage: resetResult.resetFromStep || latest.run?.stage || WORKFLOW_B_STEPS[0],
      finished_at: null,
      error: null
    });
    latest = await buildRunSnapshot(safeRunId);
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
