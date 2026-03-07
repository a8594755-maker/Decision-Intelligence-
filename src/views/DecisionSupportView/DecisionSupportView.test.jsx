/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

// Mock all heavy service dependencies before importing component
vi.mock('../../services/supabaseClient', () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ order: () => ({ data: [], error: null }) }) }),
      insert: () => ({ data: null, error: null }),
      update: () => ({ eq: () => ({ data: null, error: null }) }),
      delete: () => ({ eq: () => ({ data: null, error: null }) }),
    }),
    channel: () => ({
      on: () => ({ subscribe: () => ({}) }),
    }),
    removeChannel: vi.fn(),
  },
  userFilesService: {
    listFiles: vi.fn().mockResolvedValue([]),
    uploadFile: vi.fn().mockResolvedValue({ id: '1' }),
  },
}));

vi.mock('../../services/geminiAPI', () => ({
  streamChatWithAI: vi.fn(),
}));

vi.mock('../../services/chatDatasetProfilingService', () => ({
  prepareChatUploadFromFile: vi.fn(),
  buildDataSummaryCardPayload: vi.fn(),
  MAX_UPLOAD_BYTES: 50_000_000,
}));

vi.mock('../../services/datasetProfilingService', () => ({
  createDatasetProfileFromSheets: vi.fn(),
}));

vi.mock('../../services/datasetProfilesService', () => ({
  datasetProfilesService: {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    getProfile: vi.fn().mockResolvedValue(null),
    getDatasetProfileById: vi.fn().mockResolvedValue(null),
    getLatestDatasetProfile: vi.fn().mockResolvedValue(null),
    createDatasetProfile: vi.fn().mockResolvedValue(null),
    updateDatasetProfile: vi.fn().mockResolvedValue(null),
  },
  registerLocalProfile: vi.fn(),
}));

vi.mock('../../services/reuseMemoryService', () => ({
  reuseMemoryService: {
    findSimilar: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../services/diResetService', () => ({
  diResetService: { reset: vi.fn() },
}));

vi.mock('../../services/chatForecastService', () => ({
  runForecastFromDatasetProfile: vi.fn(),
  buildForecastCardPayload: vi.fn(),
}));

vi.mock('../../services/chatPlanningService', () => ({
  runPlanFromDatasetProfile: vi.fn(),
  buildPlanSummaryCardPayload: vi.fn(),
  buildPlanTableCardPayload: vi.fn(),
  buildInventoryProjectionCardPayload: vi.fn(),
  buildPlanExceptionsCardPayload: vi.fn(),
  buildBomBottlenecksCardPayload: vi.fn(),
  buildPlanDownloadsPayload: vi.fn(),
  buildRiskAwarePlanComparisonCardPayload: vi.fn(),
}));

vi.mock('../../services/planGovernanceService', () => ({
  requestPlanApproval: vi.fn(),
  approvePlanApproval: vi.fn(),
  rejectPlanApproval: vi.fn(),
  isPlanGovernanceConfigured: vi.fn().mockReturnValue(false),
}));

vi.mock('../../services/planAuditService', () => ({
  recordPlanApproved: vi.fn(),
  recordPlanRejected: vi.fn(),
}));

vi.mock('../../services/topology/topologyService', () => ({
  generateTopologyGraphForRun: vi.fn(),
  loadTopologyGraphForRun: vi.fn(),
}));

vi.mock('../../services/negotiation/negotiationOrchestrator', () => ({
  runNegotiation: vi.fn().mockResolvedValue({ triggered: false }),
  checkNegotiationTrigger: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../services/digitalTwinService', () => ({
  runSimulation: vi.fn().mockResolvedValue({ success: false }),
  buildDigitalTwinCardPayload: vi.fn().mockReturnValue({}),
}));

vi.mock('../../services/planWritebackService', () => ({
  writeApprovedPlanBaseline: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../workflows/workflowRegistry', () => ({
  startWorkflow: vi.fn(),
  runNextStep: vi.fn(),
  resumeRun: vi.fn(),
  replayRun: vi.fn(),
  getRunSnapshot: vi.fn(),
  submitBlockingAnswers: vi.fn(),
  WORKFLOW_NAMES: { A: 'workflowA', B: 'workflowB' },
}));

vi.mock('../../services/asyncRunsApiClient', () => ({
  default: {
    submitRun: vi.fn(),
    pollStatus: vi.fn(),
    cancelRun: vi.fn(),
  },
  isAsyncRunsConnectivityError: vi.fn().mockReturnValue(false),
}));

vi.mock('../../services/chatCanvasWorkflowService', () => ({
  executeChatCanvasRun: vi.fn(),
  RUN_STEP_ORDER: [],
}));

vi.mock('../../hooks/useSessionContext', () => ({
  default: () => ({
    context: {},
    ctx: {},
    lastForecastRunId: null,
    updateDataset: vi.fn(),
    updateForecast: vi.fn(),
    updatePlan: vi.fn(),
    rotatePlan: vi.fn(),
    updateRiskScan: vi.fn(),
    applyParameterOverride: vi.fn(),
    recordIntent: vi.fn(),
    addPendingApproval: vi.fn(),
    resolvePendingApproval: vi.fn(),
    resolveApproval: vi.fn(),
    dismissAlert: vi.fn(),
    updateNegotiation: vi.fn(),
    recordNegOptionApplied: vi.fn(),
    clearNegotiation: vi.fn(),
  }),
}));

vi.mock('../../services/chatIntentService', () => ({
  parseUserIntent: vi.fn().mockResolvedValue({ intent: 'chat', entities: {} }),
  parseIntent: vi.fn().mockResolvedValue({ intent: 'GENERAL_CHAT', confidence: 0.5 }),
  routeIntent: vi.fn().mockResolvedValue({ handled: false }),
  isExecutionType: vi.fn().mockReturnValue(false),
  buildActionParams: vi.fn().mockReturnValue({}),
}));

vi.mock('../../services/chatRefinementService', () => ({
  detectRefinement: vi.fn().mockReturnValue(null),
  handleParameterChange: vi.fn().mockResolvedValue(null),
  handlePlanComparison: vi.fn().mockReturnValue(null),
  buildComparisonSummaryText: vi.fn().mockReturnValue(''),
}));

vi.mock('../../services/evidenceResponseService', () => ({
  generateEvidenceResponse: vi.fn(),
}));

vi.mock('../../services/alertMonitorService', () => ({
  createAlertMonitor: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
  buildAlertChatMessage: vi.fn(),
  isAlertMonitorEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock('../../services/approvalWorkflowService', () => ({
  default: {
    getStatus: vi.fn().mockReturnValue(null),
    request: vi.fn(),
  },
  batchApprove: vi.fn().mockResolvedValue({}),
  batchReject: vi.fn().mockResolvedValue({}),
}));

// Mock localStorage
const localStorageMock = (() => {
  let store = {};
  return {
    getItem: vi.fn((key) => store[key] || null),
    setItem: vi.fn((key, value) => { store[key] = value; }),
    removeItem: vi.fn((key) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
  };
})();
Object.defineProperty(window, 'localStorage', { value: localStorageMock });

import DecisionSupportView from './index.jsx';

describe('DecisionSupportView', () => {
  const mockUser = { id: 'test-user-123' };
  const mockAddNotification = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    localStorageMock.clear();
  });

  it('renders without crashing', () => {
    const { container } = render(
      <DecisionSupportView user={mockUser} addNotification={mockAddNotification} />
    );
    expect(container).toBeTruthy();
  });

  it('shows empty state when no conversation is selected', () => {
    render(
      <DecisionSupportView user={mockUser} addNotification={mockAddNotification} />
    );
    const matches = screen.getAllByText(/select a conversation|start a new/i);
    expect(matches.length).toBeGreaterThan(0);
  });

  it('renders the new chat button', () => {
    render(
      <DecisionSupportView user={mockUser} addNotification={mockAddNotification} />
    );
    const newChatBtn = screen.getByRole('button', { name: /new/i });
    expect(newChatBtn).toBeInTheDocument();
  });
});
