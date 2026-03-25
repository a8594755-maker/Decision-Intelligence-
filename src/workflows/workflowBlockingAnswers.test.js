import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  datasetProfilesServiceMock,
  diRunsServiceMock,
  reuseMemoryServiceMock,
  loadArtifactMock,
  saveJsonArtifactMock,
  saveCsvArtifactMock,
} = vi.hoisted(() => ({
  datasetProfilesServiceMock: {
    getDatasetProfileById: vi.fn(),
    updateDatasetProfile: vi.fn(),
    listByFingerprint: vi.fn(),
  },
  diRunsServiceMock: {
    getRunSnapshot: vi.fn(),
    updateRunStep: vi.fn(),
    updateRunStatus: vi.fn(),
    getArtifactsForRun: vi.fn(),
    createRunSteps: vi.fn(),
    getRunSteps: vi.fn(),
    getRun: vi.fn(),
    getLatestRunByStageForDatasetProfiles: vi.fn(),
    getLatestRunByStage: vi.fn(),
  },
  reuseMemoryServiceMock: {
    getRunSettingsTemplateByFingerprint: vi.fn(),
    upsertRunSettingsTemplate: vi.fn(),
  },
  loadArtifactMock: vi.fn(),
  saveJsonArtifactMock: vi.fn(),
  saveCsvArtifactMock: vi.fn(),
}));

vi.mock('../services/data-prep/datasetProfilesService', () => ({
  datasetProfilesService: datasetProfilesServiceMock,
}));

vi.mock('../services/planning/diRunsService', () => ({
  diRunsService: diRunsServiceMock,
}));

vi.mock('../services/memory/reuseMemoryService', () => ({
  reuseMemoryService: reuseMemoryServiceMock,
}));

vi.mock('../services/data-prep/chatDatasetProfilingService', () => ({
  buildDataSummaryCardPayload: vi.fn(() => ({})),
}));

vi.mock('../services/forecast/chatForecastService', () => ({
  runForecastFromDatasetProfile: vi.fn(),
  buildForecastCardPayload: vi.fn(() => ({})),
}));

vi.mock('../services/planning/chatPlanningService', () => ({
  runPlanFromDatasetProfile: vi.fn(),
  buildPlanSummaryCardPayload: vi.fn(() => ({})),
  buildPlanTableCardPayload: vi.fn(() => ({})),
  buildInventoryProjectionCardPayload: vi.fn(() => ({})),
  buildPlanExceptionsCardPayload: vi.fn(() => ({})),
  buildBomBottlenecksCardPayload: vi.fn(() => ({ total_rows: 0, rows: [] })),
  buildPlanDownloadsPayload: vi.fn(() => ({})),
  buildRiskAwarePlanComparisonCardPayload: vi.fn(() => ({})),
}));

vi.mock('../services/risk/chatRiskService', () => ({
  computeRiskArtifactsFromDatasetProfile: vi.fn(),
  buildRiskSummaryCardPayload: vi.fn(() => ({})),
  buildRiskDrilldownCardPayload: vi.fn(() => ({})),
  buildRiskExceptionsArtifacts: vi.fn(() => ({ exceptions: [], aggregates: {} })),
  buildRiskExceptionsCardPayload: vi.fn(() => ({})),
  buildPODelayAlertCardPayload: vi.fn(() => ({})),
  buildRiskReportJson: vi.fn(() => ({ summary: '', key_results: [], exceptions: [], recommended_actions: [] })),
  buildRiskDownloadsPayload: vi.fn(() => ({})),
}));

vi.mock('../services/topology/topologyService', () => ({
  generateTopologyGraphForRun: vi.fn(),
}));

vi.mock('../utils/artifactStore', () => ({
  loadArtifact: (...args) => loadArtifactMock(...args),
  saveJsonArtifact: (...args) => saveJsonArtifactMock(...args),
  saveCsvArtifact: (...args) => saveCsvArtifactMock(...args),
}));

vi.mock('../services/closed_loop/index.js', () => ({
  runClosedLoop: vi.fn(),
  isClosedLoopEnabled: vi.fn(() => false),
}));

vi.mock('../utils/buildDecisionNarrative', () => ({
  buildDecisionNarrative: vi.fn(() => null),
}));

vi.mock('../services/planning/planAuditService', () => ({
  recordPlanGenerated: vi.fn(),
}));

vi.mock('../services/risk/riskClosedLoopService', () => ({
  evaluateRiskReplanRecommendation: vi.fn(() => ({ shouldReplan: false, recommendationCard: null, analysis: { highRiskSkus: [] } })),
}));

vi.mock('../services/closed_loop/workflowBClosedLoopBridge.js', () => ({
  evaluateClosedLoopAfterWorkflowB: vi.fn(() => null),
}));

vi.mock('../services/governance/proactiveAlertService.js', () => ({
  generateAlerts: vi.fn(() => ({ alerts: [] })),
}));

import {
  runNextStep as runWorkflowANextStep,
  submitBlockingAnswers as submitWorkflowABlockingAnswers,
} from './workflowAEngine.js';
import { submitBlockingAnswers as submitWorkflowBBlockingAnswers } from './workflowBEngine.js';

describe('workflow blocking answer submission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    datasetProfilesServiceMock.getDatasetProfileById.mockResolvedValue({
      id: 77,
      contract_json: {
        datasets: [{ mapping: { sku: 'sku_code' } }],
      },
    });
    datasetProfilesServiceMock.updateDatasetProfile.mockResolvedValue({});
    diRunsServiceMock.updateRunStep.mockResolvedValue({});
    diRunsServiceMock.updateRunStatus.mockResolvedValue({});
    diRunsServiceMock.getArtifactsForRun.mockResolvedValue([
      { id: 901, artifact_type: 'workflow_settings', artifact_json: {} },
    ]);
    loadArtifactMock.mockResolvedValue({
      settings: {
        plan: {
          constraints: {
            service_level_target: 0.95,
          },
        },
        risk: {
          top_entity_threshold: 70,
        },
      },
    });
    saveJsonArtifactMock.mockResolvedValue({ ref: { artifact_id: 444 } });
    saveCsvArtifactMock.mockResolvedValue({ ref: { artifact_id: 445 } });
    reuseMemoryServiceMock.getRunSettingsTemplateByFingerprint.mockResolvedValue(null);
    diRunsServiceMock.createRunSteps.mockResolvedValue([]);
    diRunsServiceMock.getRunSteps.mockResolvedValue([]);
    diRunsServiceMock.getRun.mockResolvedValue(null);
    diRunsServiceMock.getLatestRunByStageForDatasetProfiles.mockResolvedValue(null);
    diRunsServiceMock.getLatestRunByStage.mockResolvedValue(null);
  });

  it('workflow A applies blocking answers into settings and contract before resuming', async () => {
    diRunsServiceMock.getRunSnapshot
      .mockResolvedValueOnce({
        run: { id: 11, status: 'waiting_user', user_id: 'user-1', dataset_profile_id: 77 },
        steps: [
          {
            step: 'validate',
            status: 'blocked',
            output_ref: {
              blocking_questions: [
                {
                  id: 'Q1',
                  question: 'Lead time days?',
                  answer_type: 'number',
                  bind_to: 'settings.plan.constraints.lead_time_days',
                },
                {
                  id: 'Q2',
                  question: 'Which column contains quantity?',
                  answer_type: 'text',
                  bind_to: 'contract.datasets.0.mapping.qty',
                },
              ],
            },
          },
          { step: 'forecast', status: 'queued', output_ref: null },
        ],
        artifacts: [],
      })
      .mockResolvedValueOnce({
        run: { id: 11, status: 'waiting_user', user_id: 'user-1', dataset_profile_id: 77 },
        steps: [
          {
            step: 'validate',
            status: 'blocked',
            output_ref: {
              blocking_questions: [
                {
                  id: 'Q1',
                  question: 'Lead time days?',
                  answer_type: 'number',
                  bind_to: 'settings.plan.constraints.lead_time_days',
                },
                {
                  id: 'Q2',
                  question: 'Which column contains quantity?',
                  answer_type: 'text',
                  bind_to: 'contract.datasets.0.mapping.qty',
                },
              ],
            },
          },
          { step: 'forecast', status: 'queued', output_ref: null },
        ],
        artifacts: [],
      })
      .mockResolvedValueOnce({
        run: { id: 11, status: 'succeeded', user_id: 'user-1', dataset_profile_id: 77 },
        steps: [
          { step: 'validate', status: 'succeeded', output_ref: null },
          { step: 'forecast', status: 'succeeded', output_ref: null },
        ],
        artifacts: [],
      });

    const result = await submitWorkflowABlockingAnswers(11, {
      0: '21',
      1: 'required_qty',
    });

    expect(datasetProfilesServiceMock.updateDatasetProfile).toHaveBeenCalledWith('user-1', 77, {
      contract_json: {
        datasets: [{ mapping: { sku: 'sku_code', qty: 'required_qty' } }],
      },
    });
    expect(saveJsonArtifactMock).toHaveBeenCalledWith(
      11,
      'workflow_settings',
      expect.objectContaining({
        user_id: 'user-1',
        dataset_profile_id: 77,
        settings: expect.objectContaining({
          plan: {
            constraints: {
              service_level_target: 0.95,
              lead_time_days: 21,
            },
          },
          last_blocking_step: 'validate',
          blocking_answers: {
            0: '21',
            1: 'required_qty',
          },
        }),
      }),
      200 * 1024,
      expect.objectContaining({ user_id: 'user-1' }),
    );
    expect(result.done).toBe(true);
  });

  it('workflow B applies settings-only blocking answers without mutating the contract', async () => {
    diRunsServiceMock.getRunSnapshot
      .mockResolvedValueOnce({
        run: { id: 22, status: 'waiting_user', user_id: 'user-2', dataset_profile_id: 88 },
        steps: [
          {
            step: 'validate',
            status: 'blocked',
            output_ref: {
              blocking_questions: [
                {
                  id: 'RiskThreshold',
                  question: 'What should the high-risk threshold be?',
                  answer_type: 'number',
                  bind_to: 'settings.risk.top_entity_threshold',
                },
              ],
            },
          },
        ],
        artifacts: [],
      })
      .mockResolvedValueOnce({
        run: { id: 22, status: 'waiting_user', user_id: 'user-2', dataset_profile_id: 88 },
        steps: [
          {
            step: 'validate',
            status: 'blocked',
            output_ref: {
              blocking_questions: [
                {
                  id: 'RiskThreshold',
                  question: 'What should the high-risk threshold be?',
                  answer_type: 'number',
                  bind_to: 'settings.risk.top_entity_threshold',
                },
              ],
            },
          },
        ],
        artifacts: [],
      })
      .mockResolvedValueOnce({
        run: { id: 22, status: 'succeeded', user_id: 'user-2', dataset_profile_id: 88 },
        steps: [{ step: 'validate', status: 'succeeded', output_ref: null }],
        artifacts: [],
      });

    const result = await submitWorkflowBBlockingAnswers(22, {
      RiskThreshold: '80',
    });

    expect(datasetProfilesServiceMock.updateDatasetProfile).not.toHaveBeenCalled();
    expect(saveJsonArtifactMock).toHaveBeenCalledWith(
      22,
      'workflow_settings',
      expect.objectContaining({
        user_id: 'user-2',
        dataset_profile_id: 88,
        settings: expect.objectContaining({
          risk: {
            top_entity_threshold: 80,
          },
          last_blocking_step: 'validate',
          blocking_answers: {
            RiskThreshold: '80',
          },
        }),
      }),
      200 * 1024,
      expect.objectContaining({ user_id: 'user-2' }),
    );
    expect(result.done).toBe(true);
  });

  it('workflow A cached plan replay preserves risk-aware context in the reused optimize step', async () => {
    const runId = 33;
    const sourceRunId = 501;
    const childRunId = 777;

    const artifactPayloads = new Map([
      [301, { settings: { use_cached_plan: true, replay_of_run_id: sourceRunId } }],
      [401, { status: 'optimal', kpis: { estimated_total_cost: 123 } }],
      [402, { passed: true, violations: [] }],
      [403, { total_rows: 1, rows: [{ sku: 'SKU-1', qty: 10 }], truncated: false }],
      [404, { with_plan: { service_level_proxy: 0.98 } }],
      [405, { total_rows: 1, rows: [{ sku: 'SKU-1', projected_inventory: 8 }], truncated: false }],
      [406, { total_rows: 0, rows: [], truncated: false }],
      [407, { total_rows: 0, rows: [], truncated: false }],
      [408, null],
      [409, { total_rows: 0, rows: [] }],
      [410, { summary: 'Cached risk-aware plan', key_results: [], exceptions: [], recommended_actions: [] }],
      [411, { summary_text: 'Risk-aware cached plan summary', requires_approval: false }],
      [412, { evidence: [] }],
      [413, 'sku,qty\nSKU-1,10'],
      [414, { summary: { num_impacted_skus: 3 }, rules: [] }],
      [415, { status: 'optimal' }],
      [416, { total_rows: 1, rows: [{ sku: 'SKU-1', qty: 9 }], truncated: false }],
      [417, { risk_service_level: 0.97 }],
      [418, { total_rows: 1, rows: [{ sku: 'SKU-1', projected_inventory: 7 }], truncated: false }],
      [419, { kpis: { delta: { total_cost: 10 } }, key_changes: [{ sku: 'SKU-1', reason: 'supplier risk' }] }],
      [420, 'sku,qty\nSKU-1,9'],
    ]);

    const cachedArtifacts = [
      { id: 401, artifact_type: 'solver_meta', artifact_json: {} },
      { id: 402, artifact_type: 'constraint_check', artifact_json: {} },
      { id: 403, artifact_type: 'plan_table', artifact_json: {} },
      { id: 404, artifact_type: 'replay_metrics', artifact_json: {} },
      { id: 405, artifact_type: 'inventory_projection', artifact_json: {} },
      { id: 406, artifact_type: 'component_plan_table', artifact_json: {} },
      { id: 407, artifact_type: 'component_inventory_projection', artifact_json: {} },
      { id: 409, artifact_type: 'bottlenecks', artifact_json: {} },
      { id: 410, artifact_type: 'report_json', artifact_json: {} },
      { id: 411, artifact_type: 'decision_narrative', artifact_json: {} },
      { id: 412, artifact_type: 'evidence_pack', artifact_json: {} },
      { id: 413, artifact_type: 'plan_csv', artifact_json: {} },
      { id: 414, artifact_type: 'risk_adjustments', artifact_json: {} },
      { id: 415, artifact_type: 'risk_solver_meta', artifact_json: {} },
      { id: 416, artifact_type: 'risk_plan_table', artifact_json: {} },
      { id: 417, artifact_type: 'risk_replay_metrics', artifact_json: {} },
      { id: 418, artifact_type: 'risk_inventory_projection', artifact_json: {} },
      { id: 419, artifact_type: 'plan_comparison', artifact_json: {} },
      { id: 420, artifact_type: 'risk_plan_csv', artifact_json: {} },
    ];

    diRunsServiceMock.getRunSnapshot
      .mockResolvedValueOnce({
        run: { id: runId, status: 'running', user_id: 'user-3', dataset_profile_id: 99, workflow: 'workflow_A_replenishment' },
        steps: [
          { step: 'profile', status: 'succeeded', output_ref: null },
          { step: 'contract', status: 'succeeded', output_ref: null },
          { step: 'validate', status: 'succeeded', output_ref: null },
          { step: 'forecast', status: 'succeeded', output_ref: { child_run_id: 55 } },
          { step: 'optimize', status: 'queued', output_ref: null },
          { step: 'verify', status: 'queued', output_ref: null },
          { step: 'topology', status: 'queued', output_ref: null },
          { step: 'report', status: 'queued', output_ref: null },
        ],
        artifacts: [],
      })
      .mockResolvedValueOnce({
        run: { id: runId, status: 'running', user_id: 'user-3', dataset_profile_id: 99, workflow: 'workflow_A_replenishment' },
        steps: [
          { step: 'profile', status: 'succeeded', output_ref: null },
          { step: 'contract', status: 'succeeded', output_ref: null },
          { step: 'validate', status: 'succeeded', output_ref: null },
          { step: 'forecast', status: 'succeeded', output_ref: { child_run_id: 55 } },
          {
            step: 'optimize',
            status: 'skipped',
            output_ref: {
              risk_mode: 'on',
              risk_aware: { num_impacted_skus: 3, plan_comparison_ref: { artifact_id: 419 } },
            },
          },
          { step: 'verify', status: 'queued', output_ref: null },
          { step: 'topology', status: 'queued', output_ref: null },
          { step: 'report', status: 'queued', output_ref: null },
        ],
        artifacts: [],
      });

    diRunsServiceMock.getArtifactsForRun.mockImplementation(async (requestedRunId) => {
      if (requestedRunId === runId) {
        return [{ id: 301, artifact_type: 'workflow_settings', artifact_json: {} }];
      }
      if (requestedRunId === childRunId) {
        return cachedArtifacts;
      }
      return [];
    });
    diRunsServiceMock.getRunSteps.mockImplementation(async (requestedRunId) => {
      if (requestedRunId === sourceRunId) {
        return [
          {
            step: 'optimize',
            status: 'succeeded',
            output_ref: { child_run_id: childRunId },
          },
        ];
      }
      if (requestedRunId === runId) {
        return [
          { step: 'profile', status: 'succeeded' },
          { step: 'contract', status: 'succeeded' },
          { step: 'validate', status: 'succeeded' },
          { step: 'forecast', status: 'succeeded' },
          { step: 'optimize', status: 'skipped' },
          { step: 'verify', status: 'queued' },
        ];
      }
      return [];
    });
    diRunsServiceMock.getRun.mockImplementation(async (requestedRunId) => {
      if (requestedRunId === childRunId) {
        return { id: childRunId, workflow: 'workflow_A_replenishment' };
      }
      return null;
    });
    datasetProfilesServiceMock.getDatasetProfileById.mockResolvedValue({
      id: 99,
      fingerprint: 'fp-99',
      profile_json: {},
      contract_json: {},
    });
    loadArtifactMock.mockImplementation(async (ref) => artifactPayloads.get(ref.artifact_id) ?? null);

    const result = await runWorkflowANextStep(runId);

    expect(diRunsServiceMock.updateRunStep).toHaveBeenCalledWith(expect.objectContaining({
      run_id: runId,
      step: 'optimize',
      status: 'skipped',
      output_ref: expect.objectContaining({
        reused: true,
        risk_mode: 'on',
        risk_aware: expect.objectContaining({
          num_impacted_skus: 3,
        }),
      }),
    }));
    expect(result.step_event.status).toBe('skipped');
    expect(result.step_event.result_cards.some((card) => card.type === 'risk_aware_plan_comparison_card')).toBe(true);
  });
});
