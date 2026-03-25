import { beforeEach, describe, expect, it, vi } from 'vitest';

const { datasetProfilesServiceMock, diRunsServiceMock, startWorkflowAMock, startWorkflowBMock } = vi.hoisted(() => ({
  datasetProfilesServiceMock: {
    getDatasetProfileById: vi.fn(),
  },
  diRunsServiceMock: {
    getRun: vi.fn(),
  },
  startWorkflowAMock: vi.fn(),
  startWorkflowBMock: vi.fn(),
}));

vi.mock('../services/data-prep/datasetProfilesService', () => ({
  datasetProfilesService: datasetProfilesServiceMock,
}));

vi.mock('../services/planning/diRunsService', () => ({
  diRunsService: diRunsServiceMock,
}));

vi.mock('./workflowAEngine', () => ({
  startWorkflowA: (...args) => startWorkflowAMock(...args),
  runNextStep: vi.fn(),
  resumeRun: vi.fn(),
  replayRun: vi.fn(),
  getWorkflowARunSnapshot: vi.fn(),
  submitBlockingAnswers: vi.fn(),
}));

vi.mock('./workflowBEngine', () => ({
  startWorkflowB: (...args) => startWorkflowBMock(...args),
  runNextStep: vi.fn(),
  resumeRun: vi.fn(),
  replayRun: vi.fn(),
  getWorkflowBRunSnapshot: vi.fn(),
  submitBlockingAnswers: vi.fn(),
}));

import {
  getWorkflowFromProfile,
  normalizeWorkflowName,
  startWorkflow,
  WORKFLOW_REGISTRY_ERROR_CODES,
  WorkflowRegistryError,
} from './workflowRegistry.js';

describe('workflowRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    startWorkflowAMock.mockResolvedValue({ run: { id: 1 } });
    startWorkflowBMock.mockResolvedValue({ run: { id: 2 } });
  });

  it('returns null for unsupported inferred workflow labels', () => {
    expect(getWorkflowFromProfile({ global: { workflow_guess: { label: 'C' } } })).toBeNull();
    expect(getWorkflowFromProfile({ global: { workflow_guess: { label: 'unknown' } } })).toBeNull();
    expect(getWorkflowFromProfile({ global: { workflow_guess: { label: 'A' } } })).toBe('workflow_A_replenishment');
    expect(getWorkflowFromProfile({ global: { workflow_guess: { label: 'B' } } })).toBe('workflow_B_risk_exceptions');
  });

  it('does not normalize unsupported workflow names to workflow A', () => {
    expect(normalizeWorkflowName('workflow_A')).toBe('workflow_A_replenishment');
    expect(normalizeWorkflowName('workflow_B')).toBe('workflow_B_risk_exceptions');
    expect(normalizeWorkflowName('workflow_C')).toBeNull();
    expect(normalizeWorkflowName('unknown')).toBeNull();
  });

  it('throws an explicit unsupported-workflow error when profile inference is not executable', async () => {
    datasetProfilesServiceMock.getDatasetProfileById.mockResolvedValue({
      id: 77,
      profile_json: {
        global: {
          workflow_guess: { label: 'C', confidence: 0.82 },
        },
      },
    });

    await expect(startWorkflow({
      user_id: 'user-1',
      dataset_profile_id: 77,
    })).rejects.toMatchObject({
      name: WorkflowRegistryError.name,
      code: WORKFLOW_REGISTRY_ERROR_CODES.UNSUPPORTED_WORKFLOW,
    });

    expect(startWorkflowAMock).not.toHaveBeenCalled();
    expect(startWorkflowBMock).not.toHaveBeenCalled();
  });
});
