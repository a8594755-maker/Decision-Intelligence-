/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom';

const {
  mockRunAgentLoop,
  mockBuildAgentPresentationPayload,
  mockResolveAgentAnswerContract,
  mockJudgeAgentCandidates,
} = vi.hoisted(() => ({
  mockRunAgentLoop: vi.fn(),
  mockBuildAgentPresentationPayload: vi.fn(),
  mockResolveAgentAnswerContract: vi.fn(),
  mockJudgeAgentCandidates: vi.fn(),
}));

// Mock broken ESM package (dist/index.js uses extensionless imports)
vi.mock('ralph-loop-agent', () => ({
  RalphLoopAgent: vi.fn(),
  iterationCountIs: vi.fn(() => () => false),
  costIs: vi.fn(() => () => false),
}));

// Mock all heavy service dependencies before importing component
vi.mock('../../services/supabaseClient', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({ order: () => ({ data: [], error: null }) }),
        limit: () => ({ error: null }),
      }),
      insert: () => Promise.resolve({ data: null, error: null }),
      update: () => ({
        eq: () => ({
          eq: () => Promise.resolve({ data: null, error: null }),
        }),
      }),
      delete: () => ({
        eq: () => ({
          eq: () => Promise.resolve({ data: null, error: null }),
        }),
      }),
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

vi.mock('../../services/chatAgentLoop', () => ({
  runAgentLoop: mockRunAgentLoop,
  ANALYSIS_AGENT_TOOL_IDS: ['query_sap_data', 'list_sap_tables', 'run_python_analysis', 'generate_chart'],
}));

vi.mock('../../services/agentResponsePresentationService.js', () => ({
  buildAgentPresentationPayload: mockBuildAgentPresentationPayload,
  resolveAgentAnswerContract: mockResolveAgentAnswerContract,
}));

vi.mock('../../services/agentCandidateJudgeService.js', () => ({
  judgeAgentCandidates: mockJudgeAgentCandidates,
}));

vi.mock('../../services/chatDatasetProfilingService', () => ({
  prepareChatUploadFromFile: vi.fn(),
  prepareChatUploadFromFiles: vi.fn(),
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
  generateTopologyGraphForRun: vi.fn().mockResolvedValue(null),
  loadTopologyGraphForRun: vi.fn().mockResolvedValue(null),
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
  const directAnalysisPrompt = '假設 Olist 明年需求成長 20%，我的補貨策略、庫存水位、和資金需求分別要怎麼調整？給我具體建議和風險分析。';

  beforeEach(() => {
    vi.clearAllMocks();
    localStorageMock.clear();
    mockResolveAgentAnswerContract.mockResolvedValue({
      task_type: 'recommendation',
      required_dimensions: ['replenishment', 'inventory', 'capital', 'risk'],
      required_outputs: ['recommendation', 'caveat', 'table'],
    });
    mockBuildAgentPresentationPayload.mockImplementation(async ({ finalAnswerText = '', answerContract }) => ({
      brief: {
        headline: finalAnswerText || 'Analysis complete.',
        summary: finalAnswerText || 'Analysis complete.',
        key_findings: [],
        implications: [],
        caveats: [],
        next_steps: [],
      },
      trace: {
        failed_attempts: [],
        successful_queries: [{
          id: `trace-${finalAnswerText || 'analysis'}`,
          name: 'analysis',
          summary: 'Completed successfully',
          rowCount: 1,
        }],
        raw_narrative: '',
      },
      review: null,
      qa: {
        status: 'pass',
        score: 9.2,
        pass_threshold: 8,
        blockers: [],
        issues: [],
        repair_instructions: [],
        dimension_scores: {
          correctness: 9.5,
          completeness: 9.1,
          evidence_alignment: 9.0,
          visualization_fit: 9.0,
          caveat_quality: 9.2,
          clarity: 9.1,
        },
        reviewers: [],
        repair_attempted: false,
      },
      answerContract,
    }));
    mockJudgeAgentCandidates.mockResolvedValue({
      winnerCandidateId: 'primary',
      summary: 'Primary agent selected.',
      rationale: ['Primary provided stronger evidence.'],
      confidence: 0.86,
      reviewer: {
        provider: 'gemini',
        model: 'gemini-3.1-pro-preview',
        transport: 'compat',
      },
    });
  });

  async function startConversation(user) {
    await user.click(screen.getByRole('button', { name: /new/i }));
    await screen.findByText(/upload a csv\/xlsx/i);
  }

  it('renders without crashing', async () => {
    const { container } = render(
      <MemoryRouter>
        <DecisionSupportView user={mockUser} addNotification={mockAddNotification} />
      </MemoryRouter>
    );
    await waitFor(() => expect(container).toBeTruthy());
    expect(container).toBeTruthy();
  });

  it('shows empty state when no conversation is selected', async () => {
    render(
      <MemoryRouter>
        <DecisionSupportView user={mockUser} addNotification={mockAddNotification} />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getAllByText(/select a conversation|start a new/i).length).toBeGreaterThan(0));
    const matches = screen.getAllByText(/select a conversation|start a new/i);
    expect(matches.length).toBeGreaterThan(0);
  });

  it('renders the new chat button', async () => {
    render(
      <MemoryRouter>
        <DecisionSupportView user={mockUser} addNotification={mockAddNotification} />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByRole('button', { name: /new/i })).toBeInTheDocument());
    const newChatBtn = screen.getByRole('button', { name: /new/i });
    expect(newChatBtn).toBeInTheDocument();
  });

  it('renders the digital worker chat shell without the legacy canvas workspace', async () => {
    render(
      <MemoryRouter>
        <DecisionSupportView user={mockUser} addNotification={mockAddNotification} mode="ai_employee" />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText(/start a chat with your worker/i)).toBeInTheDocument());
    expect(screen.getByText(/start a chat with your worker/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /profile/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /steps/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /artifacts/i })).toBeInTheDocument();
    expect(screen.queryByTitle(/open canvas/i)).not.toBeInTheDocument();
  });

  it('auto-escalates direct analysis to challenger and judge after data-tool usage', async () => {
    const user = userEvent.setup();
    mockRunAgentLoop
      .mockResolvedValueOnce({
        text: 'Primary answer',
        toolCalls: [{
          id: 'tool-primary',
          name: 'run_python_analysis',
          result: { success: true },
        }],
        provider: 'openai',
        model: 'gpt-5.4',
        transport: 'native',
      })
      .mockResolvedValueOnce({
        text: 'Challenger answer',
        toolCalls: [{
          id: 'tool-secondary',
          name: 'query_sap_data',
          result: { success: true, result: { rowCount: 8, rows: [{ revenue: 1 }] } },
        }],
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        transport: 'native',
      });

    render(
      <MemoryRouter>
        <DecisionSupportView user={mockUser} addNotification={mockAddNotification} />
      </MemoryRouter>
    );

    await startConversation(user);
    await user.type(screen.getByPlaceholderText(/message decision-intelligence/i), directAnalysisPrompt);
    await user.click(screen.getByTitle(/send/i));

    await waitFor(() => expect(mockRunAgentLoop).toHaveBeenCalledTimes(2));
    expect(mockRunAgentLoop.mock.calls[1][0].message).toContain('CHALLENGER analyst');
    await waitFor(() => expect(mockJudgeAgentCandidates).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/Alternative Answer/i)).toBeInTheDocument());
  });

  it('forces dual direct-analysis generation when thinking mode is on', async () => {
    const user = userEvent.setup();
    mockRunAgentLoop
      .mockResolvedValueOnce({
        text: 'Primary answer',
        toolCalls: [{
          id: 'tool-primary',
          name: 'run_python_analysis',
          result: { success: true },
        }],
        provider: 'openai',
        model: 'gpt-5.4',
        transport: 'native',
      })
      .mockResolvedValueOnce({
        text: 'Challenger answer',
        toolCalls: [{
          id: 'tool-secondary',
          name: 'query_sap_data',
          result: { success: true, result: { rowCount: 12 } },
        }],
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        transport: 'native',
      });

    render(
      <MemoryRouter>
        <DecisionSupportView user={mockUser} addNotification={mockAddNotification} />
      </MemoryRouter>
    );

    await startConversation(user);
    await user.click(screen.getByRole('button', { name: /thinking auto/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /thinking on/i })).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText(/message decision-intelligence/i), directAnalysisPrompt);
    await user.click(screen.getByTitle(/send/i));

    await waitFor(() => expect(mockRunAgentLoop).toHaveBeenCalledTimes(2));
    expect(mockRunAgentLoop.mock.calls[0][0].message).toContain('Run a direct business data analysis');
    expect(mockRunAgentLoop.mock.calls[1][0].message).toContain('CHALLENGER analyst');
    await waitFor(() => expect(mockJudgeAgentCandidates).toHaveBeenCalledTimes(1));
  });

  it('skips judge when only one analysis candidate produces usable evidence but still keeps the failed candidate trace', async () => {
    const user = userEvent.setup();
    mockRunAgentLoop
      .mockResolvedValueOnce({
        text: 'Primary answer',
        toolCalls: [{
          id: 'tool-primary',
          name: 'run_python_analysis',
          result: { success: true },
        }],
        provider: 'openai',
        model: 'gpt-5.4',
        transport: 'native',
      })
      .mockRejectedValueOnce(Object.assign(new Error('Model Not Exist'), {
        failureCategory: 'model_not_found',
        failureMessage: 'Model Not Exist',
        recoveryAttempts: ['stream_to_non_stream_fallback'],
      }));

    render(
      <MemoryRouter>
        <DecisionSupportView user={mockUser} addNotification={mockAddNotification} />
      </MemoryRouter>
    );

    await startConversation(user);
    await user.type(screen.getByPlaceholderText(/message decision-intelligence/i), directAnalysisPrompt);
    await user.click(screen.getByTitle(/send/i));

    await waitFor(() => expect(mockRunAgentLoop).toHaveBeenCalledTimes(2));
    expect(mockJudgeAgentCandidates).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getAllByText(/Execution Trace/i).length).toBeGreaterThanOrEqual(2));
  });

  it('marks evidence-free analysis candidates as failed instead of completed', async () => {
    const user = userEvent.setup();
    mockRunAgentLoop
      .mockResolvedValueOnce({
        text: 'Generic answer with no evidence.',
        toolCalls: [],
        provider: 'gemini',
        model: 'gemini-3.1-pro-preview',
        transport: 'compat',
      })
      .mockResolvedValueOnce({
        text: 'Another generic answer with no evidence.',
        toolCalls: [],
        provider: 'gemini',
        model: 'gemini-3.1-pro-preview',
        transport: 'compat',
      });

    render(
      <MemoryRouter>
        <DecisionSupportView user={mockUser} addNotification={mockAddNotification} />
      </MemoryRouter>
    );

    await startConversation(user);
    await user.type(screen.getByPlaceholderText(/message decision-intelligence/i), directAnalysisPrompt);
    await user.click(screen.getByTitle(/send/i));

    await waitFor(() => expect(mockRunAgentLoop).toHaveBeenCalledTimes(2));
    expect(mockJudgeAgentCandidates).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText(/Both candidate runs failed before producing a valid answer\./i)).toBeInTheDocument());
  });
});
