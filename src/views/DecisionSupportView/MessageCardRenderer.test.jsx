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
  '../../components/chat/ClarificationCard',
  '../../components/chat/AIReviewCard',
  '../../components/chat/RevisionLogCard',
  '../../components/chat/ToolRegistryCard',
  '../../components/chat/WorkOrderDraftCard',
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
