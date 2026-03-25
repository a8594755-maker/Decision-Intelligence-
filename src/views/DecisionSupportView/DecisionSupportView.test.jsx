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
  mockJudgeOptimizedCandidate,
  mockSummarizeToolCallsForPrompt,
} = vi.hoisted(() => ({
  mockRunAgentLoop: vi.fn(),
  mockBuildAgentPresentationPayload: vi.fn(),
  mockResolveAgentAnswerContract: vi.fn(),
  mockJudgeAgentCandidates: vi.fn(),
  mockJudgeOptimizedCandidate: vi.fn(),
  mockSummarizeToolCallsForPrompt: vi.fn().mockReturnValue([]),
}));

// Mock broken ESM package (dist/index.js uses extensionless imports)
vi.mock('ralph-loop-agent', () => ({
  RalphLoopAgent: vi.fn(),
  iterationCountIs: vi.fn(() => () => false),
  costIs: vi.fn(() => () => false),
}));

// Mock all heavy service dependencies before importing component
vi.mock('../../services/infra/supabaseClient', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({ order: () => ({ data: [], error: null }) }),
        limit: () => ({ error: null }),
      }),
      insert: () => Promise.resolve({ data: null, error: null }),
      upsert: () => Promise.resolve({ data: null, error: null }),
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

vi.mock('../../services/ai-infra/geminiAPI', () => ({
  streamChatWithAI: vi.fn(),
}));

vi.mock('../../services/agent-core/chatAgentLoop', () => ({
  runAgentLoop: mockRunAgentLoop,
  ANALYSIS_AGENT_TOOL_IDS: ['query_sap_data', 'list_sap_tables', 'run_python_analysis', 'generate_chart'],
}));

vi.mock('../../services/agent-core/agentResponsePresentationService.js', () => ({
  buildAgentPresentationPayload: mockBuildAgentPresentationPayload,
  resolveAgentAnswerContract: mockResolveAgentAnswerContract,
  summarizeToolCallsForPrompt: mockSummarizeToolCallsForPrompt,
}));

vi.mock('../../services/agent-core/agentCandidateJudgeService.js', () => ({
  judgeAgentCandidates: mockJudgeAgentCandidates,
  judgeOptimizedCandidate: mockJudgeOptimizedCandidate,
}));

vi.mock('../../services/data-prep/chatDatasetProfilingService', () => ({
  prepareChatUploadFromFile: vi.fn(),
  prepareChatUploadFromFiles: vi.fn(),
  buildDataSummaryCardPayload: vi.fn(),
  MAX_UPLOAD_BYTES: 50_000_000,
}));

vi.mock('../../services/data-prep/datasetProfilingService', () => ({
  createDatasetProfileFromSheets: vi.fn(),
}));

vi.mock('../../services/data-prep/datasetProfilesService', () => ({
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

vi.mock('../../services/memory/reuseMemoryService', () => ({
  reuseMemoryService: {
    findSimilar: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../services/infra/diResetService', () => ({
  diResetService: { reset: vi.fn() },
}));

vi.mock('../../services/forecast/chatForecastService', () => ({
  runForecastFromDatasetProfile: vi.fn(),
  buildForecastCardPayload: vi.fn(),
}));

vi.mock('../../services/planning/chatPlanningService', () => ({
  runPlanFromDatasetProfile: vi.fn(),
  buildPlanSummaryCardPayload: vi.fn(),
  buildPlanTableCardPayload: vi.fn(),
  buildInventoryProjectionCardPayload: vi.fn(),
  buildPlanExceptionsCardPayload: vi.fn(),
  buildBomBottlenecksCardPayload: vi.fn(),
  buildPlanDownloadsPayload: vi.fn(),
  buildRiskAwarePlanComparisonCardPayload: vi.fn(),
}));

vi.mock('../../services/planning/planGovernanceService', () => ({
  requestPlanApproval: vi.fn(),
  approvePlanApproval: vi.fn(),
  rejectPlanApproval: vi.fn(),
  isPlanGovernanceConfigured: vi.fn().mockReturnValue(false),
}));

vi.mock('../../services/planning/planAuditService', () => ({
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

vi.mock('../../services/planning/digitalTwinService', () => ({
  runSimulation: vi.fn().mockResolvedValue({ success: false }),
  buildDigitalTwinCardPayload: vi.fn().mockReturnValue({}),
}));

vi.mock('../../services/planning/planWritebackService', () => ({
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

vi.mock('../../services/infra/asyncRunsApiClient', () => ({
  default: {
    submitRun: vi.fn(),
    pollStatus: vi.fn(),
    cancelRun: vi.fn(),
  },
  isAsyncRunsConnectivityError: vi.fn().mockReturnValue(false),
}));

vi.mock('../../services/canvas/chatCanvasWorkflowService', () => ({
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

vi.mock('../../services/chat/chatIntentService', () => ({
  parseUserIntent: vi.fn().mockResolvedValue({ intent: 'chat', entities: {} }),
  parseIntent: vi.fn().mockResolvedValue({ intent: 'GENERAL_CHAT', confidence: 0.5 }),
  routeIntent: vi.fn().mockResolvedValue({ handled: false }),
  isExecutionType: vi.fn().mockReturnValue(false),
  buildActionParams: vi.fn().mockReturnValue({}),
}));

vi.mock('../../services/chat/chatRefinementService', () => ({
  detectRefinement: vi.fn().mockReturnValue(null),
  handleParameterChange: vi.fn().mockResolvedValue(null),
  handlePlanComparison: vi.fn().mockReturnValue(null),
  buildComparisonSummaryText: vi.fn().mockReturnValue(''),
}));

vi.mock('../../services/governance/evidenceResponseService', () => ({
  generateEvidenceResponse: vi.fn(),
}));

vi.mock('../../services/governance/alertMonitorService', () => ({
  createAlertMonitor: vi.fn().mockReturnValue({ start: vi.fn(), stop: vi.fn() }),
  buildAlertChatMessage: vi.fn(),
  isAlertMonitorEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock('../../services/planning/approvalWorkflowService', () => ({
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

  it('auto-escalates to optimizer and judge when primary QA score is below threshold', async () => {
    const user = userEvent.setup();
    mockRunAgentLoop
      .mockResolvedValueOnce({
        text: 'Primary answer with issues',
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
        text: 'Optimizer improved answer',
        toolCalls: [{
          id: 'tool-optimizer',
          name: 'query_sap_data',
          result: { success: true, result: { rowCount: 8, rows: [{ revenue: 1 }] } },
        }],
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        transport: 'native',
      });

    // Primary QA score < 8.0 triggers optimizer escalation
    mockBuildAgentPresentationPayload
      .mockResolvedValueOnce({
        brief: { headline: 'Primary', summary: 'Incomplete', metric_pills: [], tables: [], charts: [], key_findings: [], caveats: [] },
        qa: { score: 5.2, status: 'warning', issues: ['Missing dimension'], blockers: ['missing required dimensions: revenue, cost'] },
        trace: { successful_queries: [{ name: 'run_python_analysis' }], failed_attempts: [] },
        answerContract: {},
      })
      .mockResolvedValueOnce({
        brief: { headline: 'Optimized', summary: 'Complete', metric_pills: [], tables: [], charts: [], key_findings: [], caveats: [] },
        qa: { score: 8.5, status: 'pass', issues: [], blockers: [] },
        trace: { successful_queries: [{ name: 'query_sap_data' }], failed_attempts: [] },
        answerContract: {},
      });
    mockJudgeOptimizedCandidate.mockResolvedValueOnce({
      approved: true,
      winnerCandidateId: 'secondary',
      reason: 'Optimizer improved QA score from 5.2 to 8.5.',
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
    expect(mockRunAgentLoop.mock.calls[1][0].message).toContain('OPTIMIZER agent');
    await waitFor(() => expect(mockJudgeOptimizedCandidate).toHaveBeenCalledTimes(1));
  });

  it('auto-escalates to optimizer when primary has hard methodology blockers even with a passing score', async () => {
    const user = userEvent.setup();
    mockRunAgentLoop
      .mockResolvedValueOnce({
        text: 'Primary answer with invalid growth method',
        toolCalls: [{
          id: 'tool-primary',
          name: 'query_sap_data',
          result: {
            success: true,
            result: {
              rowCount: 1,
              rows: [{ revenue: 1 }],
            },
          },
        }],
        provider: 'openai',
        model: 'gpt-5.4',
        transport: 'native',
      })
      .mockResolvedValueOnce({
        text: 'Optimizer corrected the methodology',
        toolCalls: [{
          id: 'tool-optimizer',
          name: 'query_sap_data',
          result: {
            success: true,
            result: {
              rowCount: 1,
              rows: [{ revenue: 2 }],
            },
          },
        }],
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        transport: 'native',
      });

    mockBuildAgentPresentationPayload
      .mockResolvedValueOnce({
        brief: { headline: 'Primary', summary: 'Uses an invalid growth basis', metric_pills: [], tables: [], charts: [], key_findings: [], caveats: [] },
        qa: {
          score: 8.6,
          status: 'warning',
          issues: ['Replace the current growth metric with a comparable full-coverage or aligned same-period comparison.'],
          blockers: ['The brief uses normalized growth with base period 2016, but the base period has only 1 month(s) of coverage.'],
          hard_blockers: ['The brief uses normalized growth with base period 2016, but the base period has only 1 month(s) of coverage.'],
          soft_blockers: [],
        },
        trace: { successful_queries: [{ name: 'query_sap_data' }], failed_attempts: [] },
        answerContract: {},
      })
      .mockResolvedValueOnce({
        brief: { headline: 'Optimized', summary: 'Uses a comparable same-period growth basis', metric_pills: [], tables: [], charts: [], key_findings: [], caveats: [] },
        qa: { score: 9.0, status: 'pass', issues: [], blockers: [], hard_blockers: [], soft_blockers: [] },
        trace: { successful_queries: [{ name: 'query_sap_data' }], failed_attempts: [] },
        answerContract: {},
      });
    mockJudgeOptimizedCandidate.mockResolvedValueOnce({
      approved: true,
      winnerCandidateId: 'secondary',
      reason: 'Optimizer fixed the invalid growth methodology.',
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
    expect(mockRunAgentLoop.mock.calls[1][0].message).toContain('OPTIMIZER agent');
    await waitFor(() => expect(mockJudgeOptimizedCandidate).toHaveBeenCalledTimes(1));
  });

  it('forces optimizer escalation when thinking mode is on even if QA passes', async () => {
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
        text: 'Optimizer answer',
        toolCalls: [{
          id: 'tool-optimizer',
          name: 'query_sap_data',
          result: { success: true, result: { rowCount: 12 } },
        }],
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        transport: 'native',
      });

    // Even with QA pass (8.5), forceFullThinking triggers optimizer
    mockBuildAgentPresentationPayload
      .mockResolvedValueOnce({
        brief: { headline: 'Primary', summary: 'Good', metric_pills: [], tables: [], charts: [], key_findings: [], caveats: [] },
        qa: { score: 8.5, status: 'pass', issues: [], blockers: [] },
        trace: { successful_queries: [{ name: 'run_python_analysis' }], failed_attempts: [] },
        answerContract: {},
      })
      .mockResolvedValueOnce({
        brief: { headline: 'Optimized', summary: 'Better', metric_pills: [], tables: [], charts: [], key_findings: [], caveats: [] },
        qa: { score: 9.0, status: 'pass', issues: [], blockers: [] },
        trace: { successful_queries: [{ name: 'query_sap_data' }], failed_attempts: [] },
        answerContract: {},
      });
    mockJudgeOptimizedCandidate.mockResolvedValueOnce({
      approved: true,
      winnerCandidateId: 'secondary',
      reason: 'Optimizer improved score.',
    });

    render(
      <MemoryRouter>
        <DecisionSupportView user={mockUser} addNotification={mockAddNotification} />
      </MemoryRouter>
    );

    await startConversation(user);
    await user.click(screen.getByRole('button', { name: /^auto$/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /deep verify/i })).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText(/message decision-intelligence/i), directAnalysisPrompt);
    await user.click(screen.getByTitle(/send/i));

    await waitFor(() => expect(mockRunAgentLoop).toHaveBeenCalledTimes(2));
    expect(mockRunAgentLoop.mock.calls[0][0].message).toContain('Run a direct business data analysis');
    expect(mockRunAgentLoop.mock.calls[1][0].message).toContain('OPTIMIZER agent');
    await waitFor(() => expect(mockJudgeOptimizedCandidate).toHaveBeenCalledTimes(1));
  });

  it('skips optimizer when primary QA passes', async () => {
    const user = userEvent.setup();
    mockRunAgentLoop.mockResolvedValueOnce({
      text: 'Primary answer — good quality',
      toolCalls: [{
        id: 'tool-primary',
        name: 'run_python_analysis',
        result: { success: true },
      }],
      provider: 'openai',
      model: 'gpt-5.4',
      transport: 'native',
    });

    // QA passes → no escalation
    mockBuildAgentPresentationPayload.mockResolvedValueOnce({
      brief: { headline: 'Good Analysis', summary: 'Complete', metric_pills: [], tables: [], charts: [], key_findings: [], caveats: [] },
      qa: { score: 8.5, status: 'pass', issues: [], blockers: [] },
      trace: { successful_queries: [{ name: 'run_python_analysis' }], failed_attempts: [] },
      answerContract: {},
    });

    render(
      <MemoryRouter>
        <DecisionSupportView user={mockUser} addNotification={mockAddNotification} />
      </MemoryRouter>
    );

    await startConversation(user);
    await user.type(screen.getByPlaceholderText(/message decision-intelligence/i), directAnalysisPrompt);
    await user.click(screen.getByTitle(/send/i));

    await waitFor(() => expect(mockRunAgentLoop).toHaveBeenCalledTimes(1));
    expect(mockJudgeOptimizedCandidate).not.toHaveBeenCalled();
    expect(mockJudgeAgentCandidates).not.toHaveBeenCalled();
  });

  it('does not escalate to optimizer when primary has no tool calls (no QA to check)', async () => {
    const user = userEvent.setup();
    mockRunAgentLoop.mockResolvedValueOnce({
      text: 'Generic answer with no evidence.',
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

    await waitFor(() => expect(mockRunAgentLoop).toHaveBeenCalledTimes(1));
    expect(mockJudgeOptimizedCandidate).not.toHaveBeenCalled();
  });
});
