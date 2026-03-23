/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

const stubPaths = [
  '../../components/chat/DataSummaryCard',
  '../../components/chat/ForecastCard',
  '../../components/chat/ForecastErrorCard',
  '../../components/chat/PlanSummaryCard',
  '../../components/chat/PlanTableCard',
  '../../components/chat/InventoryProjectionCard',
  '../../components/chat/PlanExceptionsCard',
  '../../components/chat/BomBottlenecksCard',
  '../../components/chat/RiskSummaryCard',
  '../../components/chat/RiskExceptionsCard',
  '../../components/chat/RiskDrilldownCard',
  '../../components/chat/PlanErrorCard',
  '../../components/chat/DecisionNarrativeCard',
  '../../components/chat/PlanApprovalCard',
  '../../components/chat/WorkflowProgressCard',
  '../../components/chat/WorkflowErrorCard',
  '../../components/chat/BlockingQuestionsCard',
  '../../components/chat/BlockingQuestionsInteractiveCard',
  '../../components/chat/WorkflowReportCard',
  '../../components/chat/ReuseDecisionCard',
  '../../components/chat/ValidationCard',
  '../../components/chat/DownloadsCard',
  '../../components/chat/ContractConfirmationCard',
  '../../components/chat/RiskAwarePlanComparisonCard',
  '../../components/risk/RiskReplanCard',
  '../../components/chat/PODelayAlertCard',
  '../../components/chat/DataQualityCard',
  '../../components/chat/RiskTriggerNotificationCard',
  '../../components/chat/ProactiveAlertCard',
  '../../components/chat/AIErrorCard',
  '../../components/chat/PlanComparisonCard',
  '../../components/chat/RetrainApprovalCard',
  '../../components/chat/DigitalTwinSimulationCard',
  '../../components/chat/NegotiationPanel',
  '../../components/chat/NegotiationActionCard',
  '../../components/chat/DecisionBundleCard',
  '../../components/chat/CausalGraphCard',
  '../../components/chat/WarRoomCard',
  '../../components/chat/MacroOracleAlertCard',
  '../../components/chat/TaskPlanCard',
  '../../components/chat/AIReviewCard',
  '../../components/chat/RevisionLogCard',
  '../../components/chat/ToolRegistryCard',
  '../../components/chat/AuditTimelineCard',
  '../../components/review/DecisionReviewPanel',
];

for (const path of stubPaths) {
  vi.doMock(path, () => ({ default: () => null }));
}

vi.doMock('../../components/chat/EnhancedPlanApprovalCard', () => ({
  default: ({ onApprove, onBatchApprove }) => (
    <div>
      <button onClick={() => onApprove?.('ap-enhanced')}>enhanced approve</button>
      <button onClick={() => onBatchApprove?.(['ap-enhanced', 'ap-batch'])}>enhanced batch approve</button>
    </div>
  ),
}));

vi.doMock('../../components/chat/ApprovalReminderCard', () => ({
  default: ({ onQuickApprove }) => (
    <button onClick={() => onQuickApprove?.('ap-reminder')}>reminder approve</button>
  ),
}));

vi.doMock('../../components/chat/UnifiedApprovalCard', () => ({
  default: ({ onDecision }) => (
    <button onClick={() => onDecision?.('ap-unified', 'approve')}>unified approve</button>
  ),
}));

vi.doMock('../../components/chat/AnalysisResultCard', () => ({
  default: ({ payload }) => <div data-testid="analysis-result-card">{`analysis-card:${payload?.title || payload?.analysisType}`}</div>,
}));

vi.doMock('../../components/chat/AgentBriefCard', () => ({
  default: ({ brief }) => <div data-testid="agent-brief-card">{`brief-card:${brief?.headline}`}</div>,
}));

vi.doMock('../../components/chat/AgentAlternativeCard', () => ({
  default: ({ candidate }) => <div data-testid="agent-alternative-card">{`alt-card:${candidate?.label}`}</div>,
}));

vi.doMock('../../components/chat/AgentQualityCard', () => ({
  default: ({ qa, judgeDecision }) => (
    <div data-testid="agent-quality-card">{`qa-card:${qa?.status}/${qa?.score}/${judgeDecision?.winnerLabel || 'no-judge'}`}</div>
  ),
}));

vi.doMock('../../components/chat/ExecutionTraceCard', () => ({
  default: ({ trace }) => (
    <div data-testid="execution-trace-card">
      {`trace-card:${trace?.failed_attempts?.length || 0}/${trace?.successful_queries?.length || 0}`}
    </div>
  ),
}));

vi.doMock('../../components/chat/SqlQueryBlock', () => ({
  default: ({ toolName }) => <div>{`sql-block:${toolName}`}</div>,
}));

vi.doMock('../../components/chat/SqlResultChartCard', () => ({
  default: ({ sql, charts }) => (
    <div>{`sql-chart-card:${charts?.length || 0} charts`}{sql && <span>{`sql:${sql.slice(0, 20)}`}</span>}</div>
  ),
}));

const { default: MessageCardRenderer } = await import('./MessageCardRenderer.jsx');

function buildHandlers(overrides = {}) {
  return {
    handleUseDatasetContextFromCard: vi.fn(),
    executeForecastFlow: vi.fn(),
    executeWorkflowAFlow: vi.fn(),
    executeWorkflowBFlow: vi.fn(),
    executePlanFlow: vi.fn(),
    executeRiskAwarePlanFlow: vi.fn(),
    handleResumeWorkflowA: vi.fn(),
    handleReplayWorkflowA: vi.fn(),
    handleCancelAsyncWorkflow: vi.fn(),
    handleBlockingQuestionsSubmit: vi.fn(),
    handleSubmitBlockingAnswers: vi.fn(),
    handleRequestRelax: vi.fn(),
    handleRequestPlanApproval: vi.fn(),
    handleApprovePlanApproval: vi.fn().mockResolvedValue({ approval_id: 'ap-default' }),
    handleRejectPlanApproval: vi.fn().mockResolvedValue({ approval_id: 'ap-default' }),
    handleContractConfirmation: vi.fn(),
    handleApplyReuseSuggestion: vi.fn(),
    handleReviewReuseSuggestion: vi.fn(),
    handleRiskReplanDecision: vi.fn(),
    handleConfigureApiKey: vi.fn(),
    handleGenerateNegotiationOptions: vi.fn(),
    handleApplyNegotiationOption: vi.fn(),
    handleNegotiationAction: vi.fn(),
    updateCanvasState: vi.fn(),
    sessionCtx: {
      resolveApproval: vi.fn(),
      dismissAlert: vi.fn(),
    },
    batchApprove: vi.fn().mockResolvedValue([
      { approval_id: 'ap-enhanced', status: 'APPROVED' },
      { approval_id: 'ap-batch', status: 'ERROR' },
    ]),
    batchReject: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function buildState(overrides = {}) {
  return {
    activeDatasetContext: null,
    currentConversationId: 'conv-1',
    conversationDatasetContext: {},
    runningForecastProfiles: [],
    runningPlanKeys: [],
    runningWorkflowProfileIds: [],
    workflowSnapshots: {},
    isNegotiationGenerating: false,
    user: { id: 'user-1' },
    _rawRowsCache: new Map(),
    ...overrides,
  };
}

describe('MessageCardRenderer approval dispatch', () => {
  it('passes structured approve payload for enhanced approval cards and resolves only successful batch items', async () => {
    const user = userEvent.setup();
    const handlers = buildHandlers();

    const { rerender } = render(
      <MessageCardRenderer
        message={{ type: 'enhanced_plan_approval_card', payload: { run_id: 42, approval: { run_id: 42 } } }}
        handlers={handlers}
        state={buildState()}
      />
    );

    await user.click(screen.getByRole('button', { name: 'enhanced approve' }));

    await waitFor(() => {
      expect(handlers.handleApprovePlanApproval).toHaveBeenCalledWith({
        approvalId: 'ap-enhanced',
        note: '',
        runId: 42,
        narrative: { run_id: 42, approval: { run_id: 42 } },
      });
      expect(handlers.sessionCtx.resolveApproval).toHaveBeenCalledWith('ap-default', 'APPROVED');
    });

    rerender(
      <MessageCardRenderer
        message={{ type: 'enhanced_plan_approval_card', payload: { run_id: 42, approval: { run_id: 42 } } }}
        handlers={handlers}
        state={buildState()}
      />
    );

    await user.click(screen.getByRole('button', { name: 'enhanced batch approve' }));

    await waitFor(() => {
      expect(handlers.batchApprove).toHaveBeenCalledWith({
        approvalIds: ['ap-enhanced', 'ap-batch'],
        userId: 'user-1',
        note: 'Batch approved via chat',
      });
      expect(handlers.sessionCtx.resolveApproval).toHaveBeenCalledWith('ap-enhanced', 'APPROVED');
    });

    expect(handlers.sessionCtx.resolveApproval).not.toHaveBeenCalledWith('ap-batch', 'APPROVED');
  });

  it('passes structured payload for reminder and unified approval actions', async () => {
    const user = userEvent.setup();
    const handlers = buildHandlers({
      handleApprovePlanApproval: vi.fn()
        .mockResolvedValueOnce({ approval_id: 'ap-reminder' })
        .mockResolvedValueOnce({ approval_id: 'ap-unified' }),
    });

    const { rerender } = render(
      <MessageCardRenderer
        message={{ type: 'approval_reminder_card', payload: { run_id: 7 } }}
        handlers={handlers}
        state={buildState()}
      />
    );

    await user.click(screen.getByRole('button', { name: 'reminder approve' }));

    await waitFor(() => {
      expect(handlers.handleApprovePlanApproval).toHaveBeenNthCalledWith(1, {
        approvalId: 'ap-reminder',
        note: '',
        runId: 7,
        narrative: { run_id: 7 },
      });
      expect(handlers.sessionCtx.resolveApproval).toHaveBeenCalledWith('ap-reminder', 'APPROVED');
    });

    rerender(
      <MessageCardRenderer
        message={{ type: 'unified_approval_card', payload: { run_id: 9 } }}
        handlers={handlers}
        state={buildState()}
      />
    );

    await user.click(screen.getByRole('button', { name: 'unified approve' }));

    await waitFor(() => {
      expect(handlers.handleApprovePlanApproval).toHaveBeenNthCalledWith(2, {
        approvalId: 'ap-unified',
        note: '',
        runId: 9,
        narrative: { run_id: 9 },
      });
      expect(handlers.sessionCtx.resolveApproval).toHaveBeenCalledWith('ap-unified', 'APPROVED');
    });
  });
});

describe('MessageCardRenderer agent response analysis rendering', () => {
  it('renders run_python_analysis results as analysis cards instead of generic tool summaries', () => {
    render(
      <MessageCardRenderer
        message={{
          type: 'agent_response',
          content: 'analysis complete',
          payload: {
            toolCalls: [{
              id: 'py-1',
              name: 'run_python_analysis',
              result: {
                success: true,
                result: { analysisType: 'seller', title: 'Seller Performance' },
                artifactTypes: ['analysis_result'],
              },
            }],
          },
        }}
        handlers={buildHandlers()}
        state={buildState()}
      />
    );

    expect(screen.getByText('analysis-card:Seller Performance')).toBeInTheDocument();
    expect(screen.queryByText(/Agent executed 1 tool/i)).not.toBeInTheDocument();
  });

  it('renders multiple analysis cards from _analysisCards payloads', () => {
    render(
      <MessageCardRenderer
        message={{
          type: 'agent_response',
          payload: {
            toolCalls: [{
              id: 'py-2',
              name: 'run_python_analysis',
              result: {
                success: true,
                result: { analyses: [] },
                _analysisCards: [
                  { analysisType: 'seller', title: 'Seller Overview' },
                  { analysisType: 'seller', title: 'Seller Correlation' },
                ],
              },
            }],
          },
        }}
        handlers={buildHandlers()}
        state={buildState()}
      />
    );

    expect(screen.getByText('analysis-card:Seller Overview')).toBeInTheDocument();
    expect(screen.getByText('analysis-card:Seller Correlation')).toBeInTheDocument();
  });

  it('renders generate_chart results from nested adapter envelope as analysis cards', () => {
    // generate_chart goes through chatToolAdapter dynamic-import path which wraps the
    // executor result in an extra { success, result } envelope. The actual _analysisCards
    // live at toolCall.result.result._analysisCards (two levels deep).
    render(
      <MessageCardRenderer
        message={{
          type: 'agent_response',
          content: 'Here is your chart',
          payload: {
            toolCalls: [{
              id: 'chart-1',
              name: 'generate_chart',
              args: { recipe_id: 'monthly_revenue_order_trend' },
              result: {
                success: true,
                result: {
                  success: true,
                  result: { analysisType: 'trend', title: 'Revenue Trend' },
                  _analysisCards: [
                    { analysisType: 'trend', title: 'Revenue Trend' },
                  ],
                  toolId: 'generate_chart',
                  artifactTypes: ['analysis_result'],
                },
                toolId: 'generate_chart',
                artifactTypes: ['analysis_result'],
              },
            }],
          },
        }}
        handlers={buildHandlers()}
        state={buildState()}
      />
    );

    expect(screen.getByText('analysis-card:Revenue Trend')).toBeInTheDocument();
    // Should NOT show generic "Agent executed 1 tool" badge
    expect(screen.queryByText(/Agent executed 1 tool/i)).not.toBeInTheDocument();
  });

  it('renders generate_chart single-result fallback (no _analysisCards) via inner.result', () => {
    render(
      <MessageCardRenderer
        message={{
          type: 'agent_response',
          payload: {
            toolCalls: [{
              id: 'chart-2',
              name: 'generate_chart',
              args: { recipe_id: 'hourly_order_distribution' },
              result: {
                success: true,
                result: {
                  success: true,
                  result: { analysisType: 'time_pattern', title: 'Hourly Orders' },
                  toolId: 'generate_chart',
                  artifactTypes: ['analysis_result'],
                },
                toolId: 'generate_chart',
                artifactTypes: ['analysis_result'],
              },
            }],
          },
        }}
        handlers={buildHandlers()}
        state={buildState()}
      />
    );

    expect(screen.getByText('analysis-card:Hourly Orders')).toBeInTheDocument();
  });

  it('renders structured brief and trace before falling back to legacy markdown content', () => {
    render(
      <MessageCardRenderer
        message={{
          type: 'agent_response',
          content: 'legacy markdown narrative that should stay inside trace only',
          payload: {
            brief: {
              headline: 'High-rated categories outperform on retention-sensitive metrics.',
              summary: 'Short summary',
              metric_pills: [],
              tables: [],
              key_findings: ['Finding'],
              implications: [],
              caveats: [],
              next_steps: [],
            },
            trace: {
              failed_attempts: [{ id: 'sql-fail-1' }],
              successful_queries: [{ id: 'sql-ok-1' }],
              raw_narrative: 'legacy markdown narrative that should stay inside trace only',
            },
            qa: {
              status: 'warning',
              score: 7.5,
              pass_threshold: 8,
              blockers: ['Missing caveat'],
              issues: ['Missing caveat'],
              repair_instructions: ['Add caveat'],
              dimension_scores: {
                correctness: 8,
                completeness: 8,
                evidence_alignment: 7,
                visualization_fit: 8,
                caveat_quality: 5,
                clarity: 8,
              },
              reviewers: [],
              repair_attempted: true,
            },
            candidates: [
              {
                candidateId: 'primary',
                label: 'Primary Agent',
                brief: { headline: 'High-rated categories outperform on retention-sensitive metrics.' },
                trace: { failed_attempts: [], successful_queries: [] },
              },
              {
                candidateId: 'secondary',
                label: 'Challenger Agent',
                brief: { headline: 'Alternative answer' },
                trace: { failed_attempts: [], successful_queries: [] },
              },
            ],
            judgeDecision: {
              winnerCandidateId: 'primary',
              winnerLabel: 'Primary Agent',
            },
            toolCalls: [{
              id: 'chart-3',
              name: 'generate_chart',
              result: {
                success: true,
                result: {
                  success: true,
                  result: { analysisType: 'trend', title: 'Revenue Trend' },
                  _analysisCards: [
                    { analysisType: 'trend', title: 'Revenue Trend' },
                  ],
                },
              },
            }],
          },
        }}
        handlers={buildHandlers()}
        state={buildState()}
      />
    );

    expect(screen.getByTestId('agent-brief-card')).toHaveTextContent('brief-card:High-rated categories outperform on retention-sensitive metrics.');
    expect(screen.getByTestId('analysis-result-card')).toHaveTextContent('analysis-card:Revenue Trend');
    expect(screen.getByTestId('agent-quality-card')).toHaveTextContent('qa-card:warning/7.5/Primary Agent');
    expect(screen.getByTestId('agent-alternative-card')).toHaveTextContent('alt-card:Challenger Agent');
    expect(screen.getAllByTestId('execution-trace-card')).toHaveLength(2);
    expect(screen.getAllByTestId('execution-trace-card')[0]).toHaveTextContent('trace-card:0/0');
    expect(screen.queryByText('legacy markdown narrative that should stay inside trace only')).not.toBeInTheDocument();
  });

  it('renders blocked warning state without an alternative winner when both candidates failed', () => {
    render(
      <MessageCardRenderer
        message={{
          type: 'agent_response',
          content: 'Both candidate runs failed before producing a valid answer.',
          payload: {
            brief: null,
            trace: {
              failed_attempts: [{ id: 'primary-fail' }, { id: 'secondary-fail' }],
              successful_queries: [],
              raw_narrative: '',
            },
            qa: {
              status: 'warning',
              score: 0,
              pass_threshold: 8,
              blockers: ['No candidate produced a valid answer.'],
              issues: ['Primary Agent: timeout', 'Challenger Agent: tool failure'],
              repair_instructions: [],
              dimension_scores: {
                correctness: 0,
                completeness: 0,
                evidence_alignment: 0,
                visualization_fit: 0,
                caveat_quality: 0,
                clarity: 0,
              },
              reviewers: [],
              repair_attempted: false,
            },
            candidates: [
              { candidateId: 'primary', label: 'Primary Agent', status: 'timed_out', failedReason: 'timeout', brief: null, trace: { failed_attempts: [{ id: 'p-1' }], successful_queries: [] }, qa: null },
              { candidateId: 'secondary', label: 'Challenger Agent', status: 'failed', failedReason: 'tool failure', brief: null, trace: { failed_attempts: [{ id: 's-1' }], successful_queries: [] }, qa: null },
            ],
            judgeDecision: {
              winnerCandidateId: null,
              summary: 'Both candidate runs failed before producing a valid answer.',
              degraded: true,
            },
          },
        }}
        handlers={buildHandlers()}
        state={buildState()}
      />
    );

    expect(screen.getByTestId('agent-quality-card')).toHaveTextContent('qa-card:warning/0/no-judge');
    expect(screen.getAllByTestId('execution-trace-card')).toHaveLength(2);
    expect(screen.getAllByTestId('execution-trace-card')[0]).toHaveTextContent('trace-card:1/0');
    expect(screen.queryByTestId('agent-alternative-card')).not.toBeInTheDocument();
  });

  it('renders completed thinking traces as collapsed cards that can be expanded', async () => {
    const user = userEvent.setup();

    render(
      <MessageCardRenderer
        message={{
          type: 'thinking_trace_card',
          payload: {
            completed: true,
            defaultCollapsed: true,
            steps: [
              { step: 1, type: 'preamble', content: '我先直接查詢客戶州別分布。' },
              { step: 2, type: 'preamble', content: '我再補一個集中度指標。' },
            ],
          },
        }}
        handlers={buildHandlers()}
        state={buildState()}
      />
    );

    expect(screen.getByText(/Reasoning complete/i)).toBeInTheDocument();
    expect(screen.queryByText('我先直接查詢客戶州別分布。')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /thinking/i }));

    expect(screen.getByText('我先直接查詢客戶州別分布。')).toBeInTheDocument();
    expect(screen.getByText('我再補一個集中度指標。')).toBeInTheDocument();
  });
});

describe('MessageCardRenderer sql_query_result with charts', () => {
  it('renders sql_query_result using SqlResultChartCard with chart data', () => {
    render(
      <MessageCardRenderer
        message={{
          type: 'sql_query_result',
          payload: {
            sql: 'SELECT state, COUNT(*) AS cnt FROM customers GROUP BY state',
            result: { success: true, rows: [{ state: 'SP', cnt: 41746 }], rowCount: 1 },
            summary: '| state | cnt |\n| --- | --- |\n| SP | 41746 |',
            charts: [{ type: 'horizontal_bar', xKey: 'state', yKey: 'cnt', data: [{ state: 'SP', cnt: 41746 }] }],
          },
        }}
        handlers={buildHandlers()}
        state={buildState()}
      />
    );

    expect(screen.getByText('sql-chart-card:1 charts')).toBeInTheDocument();
    expect(screen.getByText(/sql:SELECT state/)).toBeInTheDocument();
  });

  it('renders sql_query_result with no charts gracefully', () => {
    render(
      <MessageCardRenderer
        message={{
          type: 'sql_query_result',
          payload: {
            sql: 'SELECT COUNT(*) AS total FROM orders',
            result: { success: true, rows: [{ total: 99441 }], rowCount: 1 },
            summary: '| total |\n| --- |\n| 99441 |',
            charts: [],
          },
        }}
        handlers={buildHandlers()}
        state={buildState()}
      />
    );

    expect(screen.getByText('sql-chart-card:0 charts')).toBeInTheDocument();
  });
});
