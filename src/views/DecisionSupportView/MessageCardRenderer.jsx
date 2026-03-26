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
import SqlQueryBlock from '../../components/chat/SqlQueryBlock';
import SqlResultChartCard from '../../components/chat/SqlResultChartCard';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import RiskSummaryCard from '../../components/chat/RiskSummaryCard';
import RiskExceptionsCard from '../../components/chat/RiskExceptionsCard';
import RiskDrilldownCard from '../../components/chat/RiskDrilldownCard';
import PlanErrorCard from '../../components/chat/PlanErrorCard';
import DecisionNarrativeCard from '../../components/chat/DecisionNarrativeCard';
import PlanApprovalCard from '../../components/chat/PlanApprovalCard';
import WorkflowProgressCard from '../../components/chat/WorkflowProgressCard';
import WorkflowErrorCard from '../../components/chat/WorkflowErrorCard';
import FailureReportCard from '../../components/chat/FailureReportCard';
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
import EdaReportCard from '../../components/chat/EdaReportCard';
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
import AIReviewCard from '../../components/chat/AIReviewCard';
import RevisionLogCard from '../../components/chat/RevisionLogCard';
import ToolRegistryCard from '../../components/chat/ToolRegistryCard';
import UnifiedApprovalCard from '../../components/chat/UnifiedApprovalCard';
import SupplierEventCard from '../../components/chat/SupplierEventCard';
import AuditTimelineCard from '../../components/chat/AuditTimelineCard';
import DecisionReviewPanel from '../../components/review/DecisionReviewPanel';
import ToolBlueprintCard from '../../components/chat/ToolBlueprintCard';
import TaskResultSummaryCard from '../../components/chat/TaskResultSummaryCard';
import AnalysisResultCard from '../../components/chat/AnalysisResultCard';
import AnalysisBlueprintCard from '../../components/chat/AnalysisBlueprintCard';
import AnalysisInsightCard from '../../components/chat/AnalysisInsightCard';
import AgentBriefCard from '../../components/chat/AgentBriefCard';
import AgentAlternativeCard from '../../components/chat/AgentAlternativeCard';
import AgentQualityCard from '../../components/chat/AgentQualityCard';
import StepInputCard from '../../components/chat/StepInputCard';
import ExecutionTraceCard from '../../components/chat/ExecutionTraceCard';
import ThinkingStepsDisplay from '../../components/chat/ThinkingStepsDisplay';
import CopyAllButton from '../../components/chat/CopyAllButton';
import { serializeAgentResponseToText } from '../../utils/serializeMessageToText';
import { extractAnalysisPayloadsFromToolCall, isRenderableAnalysisToolCall } from '../../services/data-prep/analysisToolResultService.js';
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
    handleProvideStepInput,
    handleSkipWaitingStep,
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

  const resolveSessionApproval = async ({ approvalId, decision, runId = null, narrative = null, note = '' }) => {
    if (!approvalId) return null;
    const mutation = decision === 'approve' || decision === 'approve_conservative'
      ? handleApprovePlanApproval
      : handleRejectPlanApproval;
    if (typeof mutation !== 'function') return null;

    const record = await mutation({
      approvalId,
      note,
      runId,
      narrative,
    });

    sessionCtx?.resolveApproval?.(
      record?.approval_id || approvalId,
      decision === 'approve' || decision === 'approve_conservative' ? 'APPROVED' : 'REJECTED'
    );
    return record;
  };

  const resolveBatchApprovals = async ({ approvalIds = [], decision, note = '' }) => {
    const ids = Array.isArray(approvalIds) ? approvalIds.filter(Boolean) : [];
    if (ids.length === 0) return [];

    const mutation = decision === 'approve' ? batchApprove : batchReject;
    if (typeof mutation !== 'function') return [];

    const results = await mutation({
      approvalIds: ids,
      userId: user?.id,
      note,
    });

    (Array.isArray(results) ? results : []).forEach((result) => {
      if (result?.status === 'APPROVED' || result?.status === 'REJECTED') {
        sessionCtx?.resolveApproval?.(result.approval_id, result.status);
      }
    });

    return results;
  };

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
  if (message.type === 'error_diagnosis_card') {
    return <FailureReportCard payload={message.payload} />;
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
  if (message.type === 'step_input_card') {
    return (
      <StepInputCard
        taskId={message.payload?.taskId}
        stepName={message.payload?.stepName}
        stepIndex={message.payload?.stepIndex ?? 0}
        reason={message.payload?.reason}
        message={message.payload?.message}
        datasets={message.payload?.datasets || []}
        onProvideInput={(input) => handleProvideStepInput?.(message.payload?.taskId, input)}
        onSkip={() => handleSkipWaitingStep?.(message.payload?.taskId)}
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
      <Card className="w-full border border-[var(--border-default)] bg-slate-50/70 dark:bg-slate-900/30">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-[var(--text-primary)]">Topology Graph Ready</p>
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
  if (message.type === 'eda_report_card') {
    return <EdaReportCard payload={message.payload} />;
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
  if (message.type === 'scenario_comparison_card') {
    return <PlanComparisonCard payload={message.payload} />;
  }
  if (message.type === 'supplier_event_card') {
    return <SupplierEventCard payload={message.payload} />;
  }
  if (message.type === 'enhanced_plan_approval_card') {
    return (
      <EnhancedPlanApprovalCard
        payload={message.payload}
        onApprove={(approvalId) => resolveSessionApproval({
          approvalId,
          decision: 'approve',
          runId: toPositiveRunId(message.payload?.approval?.run_id || message.payload?.run_id),
          narrative: message.payload,
        })}
        onReject={(approvalId) => resolveSessionApproval({
          approvalId,
          decision: 'reject',
          runId: toPositiveRunId(message.payload?.approval?.run_id || message.payload?.run_id),
          narrative: message.payload,
        })}
        onBatchApprove={(ids) => resolveBatchApprovals({
          approvalIds: ids,
          decision: 'approve',
          note: 'Batch approved via chat',
        })}
        onBatchReject={(ids) => resolveBatchApprovals({
          approvalIds: ids,
          decision: 'reject',
          note: 'Batch rejected via chat',
        })}
      />
    );
  }
  if (message.type === 'approval_reminder_card') {
    return (
      <ApprovalReminderCard
        payload={message.payload}
        onQuickApprove={(approvalId) => resolveSessionApproval({
          approvalId,
          decision: 'approve',
          runId: toPositiveRunId(message.payload?.run_id),
          narrative: message.payload,
        })}
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
  if (message.type === 'thinking_trace_card') {
    return (
      <ThinkingStepsDisplay
        steps={message.payload?.steps || []}
        defaultCollapsed={message.payload?.defaultCollapsed !== false}
        completed={message.payload?.completed !== false}
      />
    );
  }
  if (message.type === 'agent_response') {
    const toolCalls = message.payload?.toolCalls || [];
    const brief = message.payload?.brief || null;
    const qa = message.payload?.qa || null;
    const judgeDecision = message.payload?.judgeDecision || null;
    const candidates = Array.isArray(message.payload?.candidates) ? message.payload.candidates : [];
    const alternativeCandidate = judgeDecision?.winnerCandidateId && candidates.length > 1
      ? (candidates.find((candidate) => candidate?.candidateId !== judgeDecision?.winnerCandidateId) || null)
      : null;
    const winnerCandidate = judgeDecision?.winnerCandidateId
      ? candidates.find((candidate) => candidate?.candidateId === judgeDecision.winnerCandidateId) || null
      : (candidates[0] || null);
    const briefAttribution = {
      label: judgeDecision?.winnerLabel || winnerCandidate?.label || '',
      provider: winnerCandidate?.provider || judgeDecision?.winnerProvider || message.meta?.provider || '',
      model: winnerCandidate?.model || judgeDecision?.winnerModel || message.meta?.model || '',
    };
    const trace = message.payload?.trace || null;
    const sqlCalls = toolCalls.filter((tc) => tc.name === 'query_sap_data' || tc.name === 'list_sap_tables');
    const analysisPayloads = toolCalls.flatMap((tc, toolIdx) =>
      extractAnalysisPayloadsFromToolCall(tc).map((payload, payloadIdx) => ({
        key: `${tc.id || tc.name || toolIdx}-${payloadIdx}`,
        payload,
      }))
    );
    const otherCalls = toolCalls.filter((tc) =>
      tc.name !== 'query_sap_data'
      && tc.name !== 'list_sap_tables'
      && !isRenderableAnalysisToolCall(tc)
    );

    if (brief || trace) {
      const normalizedTrace = trace || {
        failed_attempts: [],
        successful_queries: [],
        raw_narrative: message.content || '',
      };

      // In multi-agent mode, show each candidate's trace with agent label
      const hasMultipleCandidates = candidates.length > 1;
      const candidateTraces = hasMultipleCandidates
        ? candidates
            .filter((c) => c?.trace)
            .map((c) => ({
              key: c.candidateId || c.label,
              label: [c.label, c.provider, c.model].filter(Boolean).join(' · '),
              trace: c.trace,
            }))
        : [];

      return (
        <div className="space-y-3 min-w-0 overflow-hidden">
          <div className="flex justify-end">
            <CopyAllButton getText={() => serializeAgentResponseToText(message)} />
          </div>
          {brief ? <AgentBriefCard brief={brief} attribution={briefAttribution} dataSource={analysisPayloads[0]?.payload?._dataSource || null} /> : null}
          {analysisPayloads.map(({ key, payload }) => (
            <AnalysisResultCard key={key} payload={payload} />
          ))}
          {qa ? <AgentQualityCard qa={qa} judgeDecision={judgeDecision} /> : null}
          {alternativeCandidate ? <AgentAlternativeCard candidate={alternativeCandidate} /> : null}
          {candidateTraces.length > 0
            ? candidateTraces.map(({ key, label, trace: cTrace }) => (
                <ExecutionTraceCard key={key} trace={cTrace} agentLabel={label} />
              ))
            : <ExecutionTraceCard
                trace={normalizedTrace}
                agentLabel={winnerCandidate ? [winnerCandidate.label, winnerCandidate.provider, winnerCandidate.model].filter(Boolean).join(' · ') : ''}
              />
          }
        </div>
      );
    }

    return (
      <div className="space-y-3">
        <div className="flex justify-end">
          <CopyAllButton getText={() => serializeAgentResponseToText(message)} />
        </div>
        {analysisPayloads.map(({ key, payload }) => (
          <AnalysisResultCard key={key} payload={payload} />
        ))}
        {sqlCalls.map((tc, i) => (
          <SqlQueryBlock
            key={tc.id || `sql-${i}`}
            sql={tc.args?.sql}
            result={tc.result}
            toolName={tc.name === 'list_sap_tables' ? 'List SAP Tables' : 'SQL Query'}
          />
        ))}
        {otherCalls.length > 0 && (
          <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700/50">
            <div className="text-xs font-medium text-slate-400 mb-2">Agent executed {otherCalls.length} tool{otherCalls.length > 1 ? 's' : ''}:</div>
            <div className="space-y-1.5">
              {otherCalls.map((tc, i) => (
                <div key={tc.id || i} className="flex items-center gap-2 text-xs">
                  <span className={tc.result?.success ? 'text-green-400' : 'text-red-400'}>
                    {tc.result?.success ? '✅' : '❌'}
                  </span>
                  <span className="font-mono text-slate-300">{tc.name}</span>
                  {tc.result?.artifactTypes?.length > 0 && (
                    <span className="text-slate-500">→ {tc.result.artifactTypes.join(', ')}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        {message.content && (
          <div className={`prose prose-sm max-w-none dark:prose-invert text-sm text-[var(--text-primary)]
            prose-table:border-collapse prose-table:w-full prose-table:text-xs
            prose-th:bg-slate-100 prose-th:dark:bg-slate-700/60 prose-th:px-3 prose-th:py-2 prose-th:text-left prose-th:font-semibold prose-th:text-slate-600 prose-th:dark:text-slate-300 prose-th:border prose-th:border-slate-200 prose-th:dark:border-slate-600
            prose-td:px-3 prose-td:py-1.5 prose-td:border prose-td:border-slate-200 prose-td:dark:border-slate-700 prose-td:text-slate-700 prose-td:dark:text-slate-300
            prose-tr:even:bg-slate-50 prose-tr:even:dark:bg-slate-800/30
            ${analysisPayloads.length > 0
              ? 'bg-slate-50 dark:bg-slate-800/40 rounded-xl px-4 py-3 border border-slate-100 dark:border-slate-700/50'
              : ''
            }`}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
          </div>
        )}
      </div>
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
  if (message.type === 'task_plan_card') {
    return (
      <TaskPlanCard
        decomposition={message.payload}
        onApprove={message._onApprove || ((approvedDecomp) => handlers.handleTaskPlanApprove?.(approvedDecomp, message))}
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
  if (message.type === 'tool_blueprint_card') {
    return (
      <ToolBlueprintCard
        blueprint={message.payload}
        onApprove={message._onApprove}
        onReject={message._onReject}
      />
    );
  }
  if (message.type === 'task_result_summary') {
    return <TaskResultSummaryCard payload={message.payload} />;
  }
  if (message.type === 'audit_timeline_card') {
    return (
      <AuditTimelineCard
        events={message.payload.events}
        taskTitle={message.payload.task_title}
        taskId={message.payload.task_id}
        compact={message.payload.compact}
      />
    );
  }
  if (message.type === 'decision_review_card') {
    return (
      <DecisionReviewPanel
        decisionBrief={message.payload?.decision_brief}
        evidencePack={message.payload?.evidence_pack}
        writebackPayload={message.payload?.writeback_payload}
        taskMeta={message.payload?.task_meta}
        onResolve={(resolution) => handlers.handleDecisionReviewResolution?.(resolution)}
      />
    );
  }
  if (message.type === 'sql_query_result') {
    return <SqlResultChartCard {...(message.payload || {})} />;
  }
  if (message.type === 'analysis_result_card') {
    const p = message.payload || {};
    const hasInsights = p.key_findings?.length || p.recommendations?.length || p.deep_dive_suggestions?.length;
    if (hasInsights) {
      // Composite: AnalysisResultCard (metrics/charts) + AnalysisInsightCard (findings/deep-dive)
      // Map Python analysis output shape → AnalysisInsightCard expected shape
      const insightPayload = {
        sections: {
          key_findings: p.key_findings?.map(f => `**${f.finding}** — ${f.implication || ''} _(${f.severity || 'info'})_`).join('\n\n'),
          recommendations: p.recommendations?.map(r => `**[${r.priority || 'P2'}]** ${r.action}`).join('\n\n'),
          risk_alerts: p.anomalies?.map(a => `**${a.dimension}/${a.value}**: ${a.metric} = ${a.actual} ${a.context ? `(${a.context})` : ''}`).join('\n\n'),
        },
        deepDives: p.deep_dive_suggestions || [],
      };
      return (
        <div className="space-y-3">
          <AnalysisResultCard payload={p} />
          <AnalysisInsightCard payload={insightPayload} onDeepDive={handlers?.onDeepDive} />
        </div>
      );
    }
    return <AnalysisResultCard payload={p} />;
  }
  if (message.type === 'analysis_blueprint_card') {
    return (
      <AnalysisBlueprintCard
        blueprint={message.payload}
        onRunModule={handlers.handleRunBlueprintModule}
        onRunAll={handlers.handleRunAllBlueprintModules}
      />
    );
  }
  if (message.type === 'analysis_insight') {
    return <AnalysisInsightCard payload={message.payload} onDeepDive={handlers?.onDeepDive} />;
  }
  if (message.type === 'unified_approval_card') {
    return (
      <UnifiedApprovalCard
        payload={message.payload}
        onDecision={(approvalId, decision) => resolveSessionApproval({
          approvalId,
          decision,
          runId: toPositiveRunId(message.payload?.run_id),
          narrative: message.payload,
        })}
      />
    );
  }
  return null;
}
