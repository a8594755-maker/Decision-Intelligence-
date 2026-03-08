// ============================================
// usePlanExecutor — plan/risk-aware plan execution, approval flow
// Extracted from DecisionSupportView/index.jsx
// ============================================

import { useState, useCallback } from 'react';
import {
  runPlanFromDatasetProfile,
  buildPlanSummaryCardPayload,
  buildPlanTableCardPayload,
  buildInventoryProjectionCardPayload,
  buildPlanExceptionsCardPayload,
  buildBomBottlenecksCardPayload,
  buildPlanDownloadsPayload,
  buildRiskAwarePlanComparisonCardPayload,
} from '../../services/chatPlanningService';
import {
  requestPlanApproval,
  approvePlanApproval,
  rejectPlanApproval,
  isPlanGovernanceConfigured,
} from '../../services/planGovernanceService';
import {
  recordPlanApproved,
  recordPlanRejected,
} from '../../services/planAuditService';
import { writeApprovedPlanBaseline } from '../../services/planWritebackService';
import { checkNegotiationTrigger } from '../../services/negotiation/negotiationOrchestrator';
import {
  buildRuntimeWorkflowSettings,
  buildInventoryProjectionRowsFromCard,
  buildCostBreakdownRowsFromPlanSummary,
} from './helpers.js';

/**
 * Manages plan execution state and handlers.
 *
 * @param {Object}   deps
 * @param {Object}   deps.user
 * @param {string}   deps.currentConversationId
 * @param {Object}   deps.activeDatasetContext
 * @param {Function} deps.appendMessagesToCurrentConversation
 * @param {Function} deps.addNotification
 * @param {Function} deps.resolveDatasetProfileRow
 * @param {Function} deps.markCanvasRunStarted
 * @param {Function} deps.markCanvasRunFinished
 * @param {Function} deps.updateCanvasState
 * @param {Function} deps.setDomainContext
 */
export default function usePlanExecutor({
  user,
  currentConversationId,
  activeDatasetContext,
  appendMessagesToCurrentConversation,
  addNotification,
  resolveDatasetProfileRow,
  markCanvasRunStarted,
  markCanvasRunFinished,
  updateCanvasState,
  setDomainContext,
}) {
  const [runningPlanKeys, setRunningPlanKeys] = useState({});
  const [latestPlanRunId, setLatestPlanRunId] = useState(null);

  const setPlanRunningForKey = useCallback((key, isRunning) => {
    if (!key) return;
    setRunningPlanKeys((prev) => {
      const next = { ...prev };
      if (isRunning) next[key] = true;
      else delete next[key];
      return next;
    });
  }, []);

  // ── Plan execution ───────────────────────────────────────────────────────
  const executePlanFlow = useCallback(async ({
    datasetProfileId = null,
    forecastRunId = null,
    forecastCardPayload = null,
    riskMode = 'off',
  } = {}) => {
    if (!user?.id) {
      addNotification?.('Please sign in before running plan.', 'error');
      return;
    }
    if (!currentConversationId) {
      addNotification?.('Please start a conversation first.', 'error');
      return;
    }

    const resolvedProfileRow = await resolveDatasetProfileRow(
      datasetProfileId || forecastCardPayload?.dataset_profile_id || null
    );
    if (!resolvedProfileRow?.id) {
      appendMessagesToCurrentConversation([{
        role: 'ai',
        content: 'No dataset profile available. Upload data and run forecast before planning.',
        timestamp: new Date().toISOString(),
      }]);
      return;
    }

    const runKey = forecastRunId || `profile_${resolvedProfileRow.id}`;
    setPlanRunningForKey(runKey, true);
    markCanvasRunStarted(`Plan run (profile #${resolvedProfileRow.id})`);

    appendMessagesToCurrentConversation([{
      role: 'ai',
      content: `Running plan for dataset profile #${resolvedProfileRow.id}...`,
      timestamp: new Date().toISOString(),
    }]);

    try {
      const runtimeSettings = buildRuntimeWorkflowSettings(activeDatasetContext || {}, {});
      const requestedPlanHorizon = Number(runtimeSettings?.plan?.planning_horizon_days);
      const planResult = await runPlanFromDatasetProfile({
        userId: user.id,
        datasetProfileRow: resolvedProfileRow,
        forecastRunId: forecastRunId || forecastCardPayload?.run_id || null,
        forecastCardPayload,
        planningHorizonDays: Number.isFinite(requestedPlanHorizon) ? requestedPlanHorizon : null,
        constraintsOverride: runtimeSettings?.plan?.constraints || null,
        objectiveOverride: runtimeSettings?.plan?.objective || null,
        settings: runtimeSettings,
        riskMode,
      });

      const summaryPayload = buildPlanSummaryCardPayload(planResult, resolvedProfileRow);
      const tablePayload = buildPlanTableCardPayload(planResult);
      const projectionPayload = buildInventoryProjectionCardPayload(planResult);
      const exceptionsPayload = buildPlanExceptionsCardPayload(planResult);
      const bottlenecksPayload = buildBomBottlenecksCardPayload(planResult);
      const downloadsPayload = buildPlanDownloadsPayload(planResult);
      const riskComparisonPayload = buildRiskAwarePlanComparisonCardPayload(planResult);
      const decisionNarrative = planResult?.decision_narrative || null;
      const inventoryRows = buildInventoryProjectionRowsFromCard(projectionPayload);
      const costRows = buildCostBreakdownRowsFromPlanSummary(summaryPayload);

      appendMessagesToCurrentConversation([
        {
          role: 'ai',
          content: decisionNarrative?.summary_text || planResult.summary_text,
          timestamp: new Date().toISOString(),
        },
        ...(decisionNarrative ? [{
          role: 'ai',
          type: 'decision_narrative_card',
          payload: decisionNarrative,
          timestamp: new Date().toISOString(),
        }] : []),
        ...(decisionNarrative?.requires_approval ? [{
          role: 'ai',
          type: 'plan_approval_card',
          payload: {
            ...decisionNarrative,
            approval: null,
          },
          timestamp: new Date().toISOString(),
        }] : []),
        {
          role: 'ai',
          type: 'plan_summary_card',
          payload: summaryPayload,
          timestamp: new Date().toISOString(),
        },
        {
          role: 'ai',
          type: 'plan_table_card',
          payload: tablePayload,
          timestamp: new Date().toISOString(),
        },
        {
          role: 'ai',
          type: 'inventory_projection_card',
          payload: projectionPayload,
          timestamp: new Date().toISOString(),
        },
        {
          role: 'ai',
          type: 'plan_exceptions_card',
          payload: exceptionsPayload,
          timestamp: new Date().toISOString(),
        },
        ...(bottlenecksPayload.total_rows > 0
          ? [{
              role: 'ai',
              type: 'bom_bottlenecks_card',
              payload: bottlenecksPayload,
              timestamp: new Date().toISOString(),
            }]
          : []),
        {
          role: 'ai',
          type: 'downloads_card',
          payload: downloadsPayload,
          timestamp: new Date().toISOString(),
        },
        ...(riskComparisonPayload ? [{
          role: 'ai',
          type: 'risk_aware_plan_comparison_card',
          payload: riskComparisonPayload,
          timestamp: new Date().toISOString(),
        }] : []),
      ]);

      // --- Negotiation trigger detection ---
      try {
        const negTrigger = await checkNegotiationTrigger(planResult?.run?.id);
        if (negTrigger) {
          appendMessagesToCurrentConversation([
            {
              role: 'ai',
              content: negTrigger === 'infeasible'
                ? 'Solver returned INFEASIBLE. Negotiation options are available to resolve this.'
                : 'KPI shortfall detected. Negotiation options may improve the plan.',
              timestamp: new Date().toISOString(),
            },
            {
              role: 'ai',
              type: 'negotiation_card',
              payload: {
                planRunId: planResult?.run?.id,
                dataset_profile_id: resolvedProfileRow?.id || null,
                trigger: negTrigger,
                negotiation_options: null,
                negotiation_evaluation: null,
                negotiation_report: null,
                round: 1,
              },
              timestamp: new Date().toISOString(),
            },
          ]);
        }
      } catch (negErr) {
        console.warn('[DSV] Negotiation trigger check failed:', negErr?.message);
      }

      if (inventoryRows.length > 0 || costRows.length > 0) {
        updateCanvasState(currentConversationId, (prev) => ({
          ...prev,
          chartPayload: {
            ...(prev.chartPayload || {}),
            ...(inventoryRows.length > 0 ? { inventory_projection: inventoryRows } : {}),
            ...(costRows.length > 0 ? { cost_breakdown: costRows } : {}),
          },
          activeTab: 'charts',
        }));
      }

      markCanvasRunFinished('succeeded', '✅ Plan completed.', 'solver');
      addNotification?.(`Plan run #${planResult?.run?.id || ''} completed.`, 'success');
      // Track latest plan run for What-If Explorer
      if (planResult?.run?.id) setLatestPlanRunId(planResult.run.id);
      setDomainContext((prev) => ({
        ...(prev || {}),
        lastPlanSolverResult: planResult?.solver_result || null,
      }));
    } catch (error) {
      const constraintViolations = Array.isArray(error?.constraint_check?.violations)
        ? error.constraint_check.violations
        : [];
      appendMessagesToCurrentConversation([
        {
          role: 'ai',
          content: `Plan failed: ${error.message}`,
          timestamp: new Date().toISOString(),
        },
        {
          role: 'ai',
          type: 'plan_error_card',
          payload: {
            run_id: error?.run_id || null,
            message: error.message,
            blocking_questions: Array.isArray(error?.blockingQuestions) ? error.blockingQuestions : [],
            constraint_violations: constraintViolations,
          },
          timestamp: new Date().toISOString(),
        },
      ]);
      markCanvasRunFinished('failed', `❌ Plan failed: ${error.message}`, 'solver');
      addNotification?.(`Plan failed: ${error.message}`, 'error');
    } finally {
      setPlanRunningForKey(runKey, false);
    }
  }, [
    user?.id,
    currentConversationId,
    activeDatasetContext,
    resolveDatasetProfileRow,
    appendMessagesToCurrentConversation,
    addNotification,
    setPlanRunningForKey,
    markCanvasRunStarted,
    markCanvasRunFinished,
    updateCanvasState,
    setDomainContext,
  ]);

  // ── Risk-aware plan (convenience wrapper) ────────────────────────────────
  const executeRiskAwarePlanFlow = useCallback(async ({
    datasetProfileId = null,
    forecastRunId = null,
    forecastCardPayload = null,
  } = {}) => {
    return executePlanFlow({
      datasetProfileId,
      forecastRunId,
      forecastCardPayload,
      riskMode: 'on',
    });
  }, [executePlanFlow]);

  // ── Approval handlers ────────────────────────────────────────────────────
  const handleRequestPlanApproval = useCallback(async ({ runId, note = '', narrative }) => {
    if (!user?.id) throw new Error('Please sign in before requesting approval.');
    if (!runId) throw new Error('runId is required.');
    if (!isPlanGovernanceConfigured()) {
      throw new Error('VITE_ML_API_URL is not configured.');
    }

    const response = await requestPlanApproval({
      runId,
      userId: user.id,
      payload: {
        run_id: runId,
        solver_status: narrative?.solver_status || 'unknown',
        requires_approval: true,
        summary_text: narrative?.summary_text || '',
      },
      reason: 'Plan requires manual approval based on solver/narrative risk criteria.',
      note,
    });
    const approval = response?.approval || null;
    if (!approval) {
      throw new Error('Approval response missing approval record.');
    }

    appendMessagesToCurrentConversation([
      {
        role: 'ai',
        content: `Approval request submitted (${approval.approval_id}).`,
        timestamp: new Date().toISOString(),
      },
      {
        role: 'ai',
        type: 'plan_approval_card',
        payload: {
          ...(narrative || {}),
          run_id: runId,
          requires_approval: true,
          approval,
        },
        timestamp: new Date().toISOString(),
      },
    ]);
    addNotification?.(`Approval requested: ${approval.approval_id}`, 'success');
    return approval;
  }, [user?.id, appendMessagesToCurrentConversation, addNotification]);

  const handleApprovePlanApproval = useCallback(async ({ approvalId, note = '', runId, narrative = null }) => {
    if (!user?.id) throw new Error('Please sign in before approving.');
    if (!approvalId) throw new Error('approvalId is required.');
    if (!isPlanGovernanceConfigured()) {
      throw new Error('VITE_ML_API_URL is not configured.');
    }

    const response = await approvePlanApproval({
      approvalId,
      userId: user.id,
      note,
    });
    const approval = response?.approval || null;
    if (!approval) {
      throw new Error('Approval response missing approval record.');
    }

    recordPlanApproved({
      userId: user.id,
      runId,
      approvalId: approval.approval_id,
      note,
    }).catch((error) => {
      console.warn('[DecisionSupportView] recordPlanApproved failed:', error.message);
    });

    // Write approved plan orders + inventory targets to baseline tables
    writeApprovedPlanBaseline({
      userId: user.id,
      runId,
      approvalId: approval.approval_id,
    }).then((result) => {
      if (result?.success) {
        console.info(`[WriteBack] Baseline written: ${result.orders_inserted} orders, ${result.targets_inserted} targets`);
      }
    }).catch((err) => {
      console.warn('[WriteBack] non-fatal:', err.message);
    });

    appendMessagesToCurrentConversation([
      {
        role: 'ai',
        content: `Plan approved (${approval.approval_id}).`,
        timestamp: new Date().toISOString(),
      },
      {
        role: 'ai',
        type: 'plan_approval_card',
        payload: {
          ...(narrative || {}),
          run_id: runId,
          requires_approval: true,
          approval,
        },
        timestamp: new Date().toISOString(),
      },
    ]);
    addNotification?.('Plan approved.', 'success');
    return approval;
  }, [user?.id, appendMessagesToCurrentConversation, addNotification]);

  const handleRejectPlanApproval = useCallback(async ({ approvalId, note = '', runId, narrative = null }) => {
    if (!user?.id) throw new Error('Please sign in before rejecting.');
    if (!approvalId) throw new Error('approvalId is required.');
    if (!isPlanGovernanceConfigured()) {
      throw new Error('VITE_ML_API_URL is not configured.');
    }

    const response = await rejectPlanApproval({
      approvalId,
      userId: user.id,
      note,
    });
    const approval = response?.approval || null;
    if (!approval) {
      throw new Error('Approval response missing approval record.');
    }

    recordPlanRejected({
      userId: user.id,
      runId,
      approvalId: approval.approval_id,
      note,
    }).catch((error) => {
      console.warn('[DecisionSupportView] recordPlanRejected failed:', error.message);
    });

    appendMessagesToCurrentConversation([
      {
        role: 'ai',
        content: `Plan rejected (${approval.approval_id}).`,
        timestamp: new Date().toISOString(),
      },
      {
        role: 'ai',
        type: 'plan_approval_card',
        payload: {
          ...(narrative || {}),
          run_id: runId,
          requires_approval: true,
          approval,
        },
        timestamp: new Date().toISOString(),
      },
    ]);
    addNotification?.('Plan rejected.', 'warning');
    return approval;
  }, [user?.id, appendMessagesToCurrentConversation, addNotification]);

  // ── Risk replan decision ─────────────────────────────────────────────────
  const handleRiskReplanDecision = useCallback(async ({
    action,
    params = {},
    datasetProfileId,
  }) => {
    if (action === 'dismiss_risk_replan') {
      appendMessagesToCurrentConversation([{
        role: 'ai',
        content: 'Risk re-plan recommendation dismissed. Current plan retained.',
        timestamp: new Date().toISOString(),
      }]);
      return;
    }

    if (action === 'replan_with_risk_params') {
      const { safety_stock_alpha, stockout_penalty_multiplier, risk_mode } = params;

      appendMessagesToCurrentConversation([{
        role: 'ai',
        content: `Re-planning with safety_stock_alpha=${safety_stock_alpha}...`,
        timestamp: new Date().toISOString(),
      }]);

      try {
        const resolvedProfileRow = await resolveDatasetProfileRow(datasetProfileId);
        if (!resolvedProfileRow?.id) {
          throw new Error('Cannot find the corresponding dataset profile.');
        }

        const runtimeSettings = buildRuntimeWorkflowSettings(activeDatasetContext || {}, {});
        const planResult = await runPlanFromDatasetProfile({
          userId: user.id,
          datasetProfileRow: resolvedProfileRow,
          riskMode: risk_mode || 'on',
          riskConfigOverrides: {
            safety_stock_alpha,
            stockout_penalty_beta: stockout_penalty_multiplier - 1,
          },
          settings: {
            ...runtimeSettings,
            closed_loop: { mode: 'dry_run' }, // Prevent infinite loop
          },
        });

        const summaryPayload = buildPlanSummaryCardPayload(planResult, resolvedProfileRow);
        const tablePayload = buildPlanTableCardPayload(planResult);
        const projectionPayload = buildInventoryProjectionCardPayload(planResult);
        const downloadsPayload = buildPlanDownloadsPayload(planResult);
        const riskComparisonPayload = buildRiskAwarePlanComparisonCardPayload(planResult);
        const decisionNarrative = planResult?.decision_narrative || null;

        appendMessagesToCurrentConversation([
          {
            role: 'ai',
            content: decisionNarrative?.summary_text || `Risk-adjusted re-plan completed. Service level: ${
              ((planResult?.solver_result?.kpis?.estimated_service_level ?? 0) * 100).toFixed(1)
            }%`,
            timestamp: new Date().toISOString(),
          },
          ...(decisionNarrative ? [{
            role: 'ai',
            type: 'decision_narrative_card',
            payload: decisionNarrative,
            timestamp: new Date().toISOString(),
          }] : []),
          ...(decisionNarrative?.requires_approval ? [{
            role: 'ai',
            type: 'plan_approval_card',
            payload: {
              ...decisionNarrative,
              approval: null,
            },
            timestamp: new Date().toISOString(),
          }] : []),
          { role: 'ai', type: 'plan_summary_card', payload: summaryPayload, timestamp: new Date().toISOString() },
          { role: 'ai', type: 'plan_table_card', payload: tablePayload, timestamp: new Date().toISOString() },
          { role: 'ai', type: 'inventory_projection_card', payload: projectionPayload, timestamp: new Date().toISOString() },
          { role: 'ai', type: 'downloads_card', payload: downloadsPayload, timestamp: new Date().toISOString() },
          ...(riskComparisonPayload
            ? [{ role: 'ai', type: 'risk_aware_plan_comparison_card', payload: riskComparisonPayload, timestamp: new Date().toISOString() }]
            : []),
        ]);

        addNotification?.('Risk-adjusted re-plan completed.', 'success');
        if (planResult?.run?.id) setLatestPlanRunId(planResult.run.id);
      } catch (err) {
        appendMessagesToCurrentConversation([{
          role: 'ai',
          content: `Risk re-plan failed: ${err.message}`,
          timestamp: new Date().toISOString(),
        }]);
        addNotification?.(`Risk re-plan failed: ${err.message}`, 'error');
      }
    }
  }, [
    user,
    activeDatasetContext,
    resolveDatasetProfileRow,
    appendMessagesToCurrentConversation,
    addNotification,
  ]);

  return {
    // State
    runningPlanKeys,
    setRunningPlanKeys,
    latestPlanRunId,
    setLatestPlanRunId,

    // Handlers
    setPlanRunningForKey,
    executePlanFlow,
    executeRiskAwarePlanFlow,
    handleRequestPlanApproval,
    handleApprovePlanApproval,
    handleRejectPlanApproval,
    handleRiskReplanDecision,
  };
}
