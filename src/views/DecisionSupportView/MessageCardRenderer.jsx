// ============================================
// MessageCardRenderer — renders special message cards by type
// Extracted from DecisionSupportView/index.jsx (renderSpecialMessage)
// ============================================

import React from 'react';
import { Card, Button } from '../../components/ui';
import DataSummaryCard from '../../components/chat/DataSummaryCard';
import ForecastCard from '../../components/chat/ForecastCard';
import ForecastErrorCard from '../../components/chat/ForecastErrorCard';
import PlanSummaryCard from '../../components/chat/PlanSummaryCard';
import PlanTableCard from '../../components/chat/PlanTableCard';
import InventoryProjectionCard from '../../components/chat/InventoryProjectionCard';
import PlanExceptionsCard from '../../components/chat/PlanExceptionsCard';
import BomBottlenecksCard from '../../components/chat/BomBottlenecksCard';
import RiskSummaryCard from '../../components/chat/RiskSummaryCard';
import RiskExceptionsCard from '../../components/chat/RiskExceptionsCard';
import RiskDrilldownCard from '../../components/chat/RiskDrilldownCard';
import PlanErrorCard from '../../components/chat/PlanErrorCard';
import DecisionNarrativeCard from '../../components/chat/DecisionNarrativeCard';
import PlanApprovalCard from '../../components/chat/PlanApprovalCard';
import WorkflowProgressCard from '../../components/chat/WorkflowProgressCard';
import WorkflowErrorCard from '../../components/chat/WorkflowErrorCard';
import BlockingQuestionsCard from '../../components/chat/BlockingQuestionsCard';
import BlockingQuestionsInteractiveCard from '../../components/chat/BlockingQuestionsInteractiveCard';
import WorkflowReportCard from '../../components/chat/WorkflowReportCard';
import ReuseDecisionCard from '../../components/chat/ReuseDecisionCard';
import ValidationCard from '../../components/chat/ValidationCard';
import DownloadsCard from '../../components/chat/DownloadsCard';
import ContractConfirmationCard from '../../components/chat/ContractConfirmationCard';
import RiskAwarePlanComparisonCard from '../../components/chat/RiskAwarePlanComparisonCard';
import RiskReplanCard from '../../components/risk/RiskReplanCard';
import PODelayAlertCard from '../../components/chat/PODelayAlertCard';
import DataQualityCard from '../../components/chat/DataQualityCard';
import RiskTriggerNotificationCard from '../../components/chat/RiskTriggerNotificationCard';
import ProactiveAlertCard from '../../components/chat/ProactiveAlertCard';
import AIErrorCard from '../../components/chat/AIErrorCard';
import PlanComparisonCard from '../../components/chat/PlanComparisonCard';
import EnhancedPlanApprovalCard from '../../components/chat/EnhancedPlanApprovalCard';
import RetrainApprovalCard from '../../components/chat/RetrainApprovalCard';
import ApprovalReminderCard from '../../components/chat/ApprovalReminderCard';
import DigitalTwinSimulationCard from '../../components/chat/DigitalTwinSimulationCard';
import NegotiationPanel from '../../components/chat/NegotiationPanel';
import NegotiationActionCard from '../../components/chat/NegotiationActionCard';
import DecisionBundleCard from '../../components/chat/DecisionBundleCard';
import CausalGraphCard from '../../components/chat/CausalGraphCard';
import WarRoomCard from '../../components/chat/WarRoomCard';
import MacroOracleAlertCard from '../../components/chat/MacroOracleAlertCard';
import TaskPlanCard from '../../components/chat/TaskPlanCard';
import ClarificationCard from '../../components/chat/ClarificationCard';
import AIReviewCard from '../../components/chat/AIReviewCard';
import RevisionLogCard from '../../components/chat/RevisionLogCard';
import ToolRegistryCard from '../../components/chat/ToolRegistryCard';
import OpenCloudPublishCard from '../../components/chat/OpenCloudPublishCard';
import UnifiedApprovalCard from '../../components/chat/UnifiedApprovalCard';
import { toPositiveRunId } from './helpers.js';

/**
 * Renders a single special (typed) chat message card.
 *
 * All callback props come from the main component which composes the hooks.
 *
 * @param {Object} props
 * @param {Object} props.message                        - the message object (has .type, .payload)
 * @param {Object} props.handlers                       - bag of callback handlers
 * @param {Object} props.state                          - bag of state slices needed by cards
 */
export default function MessageCardRenderer({ message, handlers, state }) {
  const {
    handleUseDatasetContextFromCard,
    executeForecastFlow,
    executeWorkflowAFlow,
    executeWorkflowBFlow,
    executePlanFlow,
    executeRiskAwarePlanFlow,
    handleResumeWorkflowA,
    handleReplayWorkflowA,
    handleCancelAsyncWorkflow,
    handleBlockingQuestionsSubmit,
    handleSubmitBlockingAnswers,
    handleRequestRelax,
    handleRequestPlanApproval,
    handleApprovePlanApproval,
    handleRejectPlanApproval,
    handleContractConfirmation,
    handleApplyReuseSuggestion,
    handleReviewReuseSuggestion,
    handleRiskReplanDecision,
    handleConfigureApiKey,
    handleGenerateNegotiationOptions,
    handleApplyNegotiationOption,
    handleNegotiationAction,
    updateCanvasState,
    sessionCtx,
    batchApprove,
    batchReject,
  } = handlers;

  const {
    activeDatasetContext,
    currentConversationId,
    conversationDatasetContext,
    runningForecastProfiles,
    runningPlanKeys,
    runningWorkflowProfileIds,
    workflowSnapshots,
    isNegotiationGenerating,
    user,
    _rawRowsCache,
  } = state;

  if (message.type === 'dataset_summary_card') {
    return (
      <DataSummaryCard
        payload={message.payload}
        onUseContext={handleUseDatasetContextFromCard}
        onRunForecast={(cardPayload) => {
          const ctx = conversationDatasetContext[currentConversationId] || {};
          const profileIdStr = String(cardPayload?.dataset_profile_id || '');
          return executeForecastFlow({
            profileId: cardPayload?.dataset_profile_id,
            fallbackProfileRow: {
              id: cardPayload?.dataset_profile_id,
              user_file_id: cardPayload?.user_file_id || ctx.user_file_id || null,
              profile_json: cardPayload?.profile_json || {},
              contract_json: cardPayload?.contract_json || {},
              _inlineRawRows: ctx.rawRowsForStorage || _rawRowsCache.get(profileIdStr) || null,
            },
          });
        }}
        onRunWorkflow={(cardPayload) => executeWorkflowAFlow({
          datasetProfileId: cardPayload?.dataset_profile_id || null,
        })}
        onRunRisk={(cardPayload) => executeWorkflowBFlow({
          datasetProfileId: cardPayload?.dataset_profile_id || null,
        })}
        isContextSelected={activeDatasetContext?.dataset_profile_id === message.payload?.dataset_profile_id}
        isForecastRunning={Boolean(runningForecastProfiles[message.payload?.dataset_profile_id])}
        isWorkflowRunning={Boolean(runningWorkflowProfileIds[message.payload?.dataset_profile_id])}
        isRiskRunning={Boolean(runningWorkflowProfileIds[message.payload?.dataset_profile_id])}
      />
    );
  }
  if (message.type === 'workflow_progress_card') {
    const runId = toPositiveRunId(message.payload?.run_id);
    const snapshot = runId ? (workflowSnapshots[runId] || workflowSnapshots[String(runId)] || null) : null;
    return (
      <WorkflowProgressCard
        payload={message.payload}
        snapshot={snapshot}
        onResume={handleResumeWorkflowA}
        onReplay={handleReplayWorkflowA}
        onCancel={handleCancelAsyncWorkflow}
      />
    );
  }
  if (message.type === 'workflow_error_card') {
    return <WorkflowErrorCard payload={message.payload} />;
  }
  if (message.type === 'blocking_questions_card') {
    return <BlockingQuestionsCard payload={message.payload} onSubmit={handleBlockingQuestionsSubmit} />;
  }
  if (message.type === 'blocking_questions_interactive_card') {
    const runId = message.payload?.run_id;
    return (
      <BlockingQuestionsInteractiveCard
        payload={message.payload}
        onSubmit={(answers) => handleSubmitBlockingAnswers(runId, answers)}
      />
    );
  }
  if (message.type === 'workflow_report_card') {
    return <WorkflowReportCard payload={message.payload} />;
  }
  if (message.type === 'decision_narrative_card') {
    return <DecisionNarrativeCard payload={message.payload} onRequestRelax={handleRequestRelax} />;
  }
  if (message.type === 'plan_approval_card') {
    return (
      <PlanApprovalCard
        payload={message.payload}
        onRequestApproval={handleRequestPlanApproval}
        onApprove={handleApprovePlanApproval}
        onReject={handleRejectPlanApproval}
      />
    );
  }
  if (message.type === 'retrain_approval_card') {
    return (
      <RetrainApprovalCard
        payload={message.payload}
        onApprove={async (details) => {
          try {
            const mlApiUrl = import.meta.env.VITE_ML_API_URL || 'http://127.0.0.1:8000';
            await fetch(`${mlApiUrl}/ml/retrain/run`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ series_id: details.series_id, approved_by: 'ui_user', note: details.note }),
            });
          } catch (e) { console.error('Retrain approve error:', e); }
        }}
        onReject={async (details) => {
          console.log('Retrain rejected:', details);
        }}
      />
    );
  }
  if (message.type === 'topology_graph_card') {
    const runId = toPositiveRunId(message?.payload?.run_id)
      || toPositiveRunId(message?.payload?.graph?.run_id);
    return (
      <Card className="w-full border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-900/30">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Topology Graph Ready</p>
            <p className="text-xs text-slate-500">
              {Number.isFinite(runId)
                ? `Run #${runId} topology artifact is available in Canvas.`
                : 'Topology artifact is available in Canvas.'}
            </p>
          </div>
          <Button
            variant="secondary"
            className="text-xs"
            onClick={() => {
              if (!currentConversationId) return;
              updateCanvasState(currentConversationId, (prev) => ({
                ...prev,
                isOpen: true,
                activeTab: 'topology',
              }));
            }}
          >
            Open Topology
          </Button>
        </div>
      </Card>
    );
  }
  if (message.type === 'reuse_decision_card') {
    return (
      <ReuseDecisionCard
        payload={message.payload}
        onApply={handleApplyReuseSuggestion}
        onReview={handleReviewReuseSuggestion}
      />
    );
  }
  if (message.type === 'forecast_result_card') {
    return (
      <ForecastCard
        payload={message.payload}
        onRunPlan={(forecastPayload) => executePlanFlow({
          datasetProfileId: forecastPayload?.dataset_profile_id || null,
          forecastRunId: forecastPayload?.run_id || null,
          forecastCardPayload: forecastPayload,
        })}
        onRunRiskAwarePlan={() => executeRiskAwarePlanFlow({
          datasetProfileId: message.payload?.dataset_profile_id,
          forecastRunId: message.payload?.run_id,
          forecastCardPayload: message.payload,
        })}
        isPlanRunning={Boolean(runningPlanKeys[message.payload?.run_id || `profile_${message.payload?.dataset_profile_id}`])}
      />
    );
  }
  if (message.type === 'forecast_error_card') {
    return <ForecastErrorCard payload={message.payload} />;
  }
  if (message.type === 'data_quality_card') {
    return <DataQualityCard payload={message.payload} />;
  }
  if (message.type === 'plan_summary_card') {
    return <PlanSummaryCard payload={message.payload} />;
  }
  if (message.type === 'plan_table_card') {
    return <PlanTableCard payload={message.payload} />;
  }
  if (message.type === 'inventory_projection_card') {
    return <InventoryProjectionCard payload={message.payload} />;
  }
  if (message.type === 'plan_exceptions_card') {
    return <PlanExceptionsCard payload={message.payload} />;
  }
  if (message.type === 'bom_bottlenecks_card') {
    return <BomBottlenecksCard payload={message.payload} />;
  }
  if (message.type === 'plan_error_card') {
    return <PlanErrorCard payload={message.payload} />;
  }
  if (message.type === 'risk_summary_card') {
    return <RiskSummaryCard payload={message.payload} />;
  }
  if (message.type === 'risk_exceptions_card') {
    return <RiskExceptionsCard payload={message.payload} />;
  }
  if (message.type === 'risk_drilldown_card') {
    return <RiskDrilldownCard payload={message.payload} />;
  }
  if (message.type === 'po_delay_alert_card') {
    return <PODelayAlertCard payload={message.payload} />;
  }
  if (message.type === 'validation_card') {
    return <ValidationCard payload={message.payload} />;
  }
  if (message.type === 'downloads_card') {
    return <DownloadsCard payload={message.payload} />;
  }
  if (message.type === 'contract_confirmation_card') {
    return (
      <ContractConfirmationCard
        payload={message.payload}
        onConfirm={handleContractConfirmation}
      />
    );
  }
  if (message.type === 'risk_aware_plan_comparison_card') {
    return <RiskAwarePlanComparisonCard payload={message.payload} />;
  }
  if (message.type === 'risk_replan_recommendation_card') {
    return (
      <RiskReplanCard
        payload={message.payload}
        onDecision={handleRiskReplanDecision}
      />
    );
  }
  if (message.type === 'risk_trigger_notification_card') {
    return (
      <RiskTriggerNotificationCard
        payload={message.payload}
      />
    );
  }
  if (message.type === 'proactive_alert_card') {
    return (
      <ProactiveAlertCard
        payload={message.payload}
      />
    );
  }
  if (message.type === 'plan_comparison_card') {
    return <PlanComparisonCard payload={message.payload} />;
  }
  if (message.type === 'enhanced_plan_approval_card') {
    return (
      <EnhancedPlanApprovalCard
        payload={message.payload}
        onApprove={(approvalId) => {
          handleApprovePlanApproval(approvalId);
          sessionCtx.resolveApproval(approvalId, 'APPROVED');
        }}
        onReject={(approvalId) => {
          handleRejectPlanApproval(approvalId);
          sessionCtx.resolveApproval(approvalId, 'REJECTED');
        }}
        onBatchApprove={async (ids) => {
          await batchApprove({ approvalIds: ids, userId: user?.id, note: 'Batch approved via chat' });
          ids.forEach((id) => sessionCtx.resolveApproval(id, 'APPROVED'));
        }}
        onBatchReject={async (ids) => {
          await batchReject({ approvalIds: ids, userId: user?.id, note: 'Batch rejected via chat' });
          ids.forEach((id) => sessionCtx.resolveApproval(id, 'REJECTED'));
        }}
      />
    );
  }
  if (message.type === 'approval_reminder_card') {
    return (
      <ApprovalReminderCard
        payload={message.payload}
        onQuickApprove={(approvalId) => {
          handleApprovePlanApproval(approvalId);
          sessionCtx.resolveApproval(approvalId, 'APPROVED');
        }}
        onDismiss={(approvalId) => sessionCtx.dismissAlert(approvalId)}
      />
    );
  }
  if (message.type === 'digital_twin_simulation_card') {
    return <DigitalTwinSimulationCard payload={message.payload} />;
  }
  if (message.type === 'ai_error_card') {
    return (
      <AIErrorCard
        payload={message.payload}
        onConfigure={handleConfigureApiKey}
      />
    );
  }
  if (message.type === 'negotiation_action_card') {
    return (
      <NegotiationActionCard
        payload={message.payload}
        onAction={handleNegotiationAction
          ? (action, details) => handleNegotiationAction(action, details, message.payload)
          : undefined}
      />
    );
  }
  if (message.type === 'decision_bundle_card') {
    return (
      <DecisionBundleCard
        payload={message.payload}
        onActionClick={handlers.handleDecisionBundleAction}
      />
    );
  }
  if (message.type === 'negotiation_card') {
    return (
      <NegotiationPanel
        planRunId={message.payload?.planRunId}
        trigger={message.payload?.trigger}
        isGenerating={isNegotiationGenerating}
        negotiationOptions={message.payload?.negotiation_options}
        negotiationEval={message.payload?.negotiation_evaluation}
        negotiationReport={message.payload?.negotiation_report}
        onGenerateOptions={() => handleGenerateNegotiationOptions(message.payload)}
        onApplyOption={(option, evalResult) => handleApplyNegotiationOption(option, evalResult, message.payload)}
      />
    );
  }
  if (message.type === 'causal_graph_card') {
    return (
      <CausalGraphCard
        payload={message.payload}
        onActionClick={handlers.handleDecisionBundleAction}
      />
    );
  }
  if (message.type === 'war_room_card') {
    return (
      <WarRoomCard
        payload={message.payload}
        onActionClick={handlers.handleDecisionBundleAction}
      />
    );
  }
  if (message.type === 'negotiation_approval_card') {
    return (
      <DecisionBundleCard
        payload={message.payload}
        onActionClick={handlers.handleDecisionBundleAction}
      />
    );
  }
  if (message.type === 'macro_oracle_alert') {
    return (
      <MacroOracleAlertCard
        payload={message.payload}
        onAction={handlers.handleDecisionBundleAction}
      />
    );
  }
  if (message.type === 'clarification_card') {
    return (
      <ClarificationCard
        payload={message.payload}
        onSubmit={message._onSubmit}
        onSkip={message._onSkip}
      />
    );
  }
  if (message.type === 'task_plan_card') {
    return (
      <TaskPlanCard
        decomposition={message.payload}
        onApprove={message._onApprove}
        onCancel={() => {}}
      />
    );
  }
  if (message.type === 'ai_review_card') {
    return <AIReviewCard review={message.payload} stepName={message.stepName} />;
  }
  if (message.type === 'revision_log_card') {
    return <RevisionLogCard revisionLog={message.payload} stepName={message.stepName} />;
  }
  if (message.type === 'tool_registry_card') {
    return <ToolRegistryCard tool={message.payload} onSave={handlers.handleSaveToToolLibrary} />;
  }
  if (message.type === 'opencloud_file_ref' || message.type === 'opencloud_publish_card') {
    return <OpenCloudPublishCard artifact={message} />;
  }
  if (message.type === 'unified_approval_card') {
    return (
      <UnifiedApprovalCard
        payload={message.payload}
        onDecision={(approvalId, decision) => {
          if (decision === 'approve' || decision === 'approve_conservative') {
            handleApprovePlanApproval(approvalId);
            sessionCtx.resolveApproval(approvalId, 'APPROVED');
          } else {
            handleRejectPlanApproval(approvalId);
            sessionCtx.resolveApproval(approvalId, 'REJECTED');
          }
        }}
      />
    );
  }
  return null;
}
