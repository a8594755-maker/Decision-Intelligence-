// ============================================
// useForecastExecutor — forecast execution flow
// Extracted from DecisionSupportView/index.jsx
// ============================================

import { useState, useCallback } from 'react';
import { runForecastFromDatasetProfile, buildForecastCardPayload } from '../../services/forecast/chatForecastService';
import { buildDataSummaryCardPayload } from '../../services/data-prep/chatDatasetProfilingService';
import { buildDecisionBundle } from '../../services/tasks/decisionTaskService';
import { assembleForecastEvidence } from '../../services/governance/evidenceAssembler';
import {
  buildRuntimeWorkflowSettings,
  buildExecutionGateResult,
  buildValidationPayload,
  buildConfirmationPayload,
  buildActualVsForecastRowsFromForecastCard,
} from './helpers.js';

/**
 * Manages forecast execution state and handler.
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
 * @param {Function} deps.setConversationDatasetContext
 */
export default function useForecastExecutor({
  user,
  currentConversationId,
  activeDatasetContext,
  appendMessagesToCurrentConversation,
  addNotification,
  resolveDatasetProfileRow,
  markCanvasRunStarted,
  markCanvasRunFinished,
  updateCanvasState,
  setConversationDatasetContext,
}) {
  const [runningForecastProfiles, setRunningForecastProfiles] = useState({});

  const setForecastRunningForProfile = useCallback((profileId, isRunning) => {
    if (!profileId) return;
    setRunningForecastProfiles((prev) => {
      const next = { ...prev };
      if (isRunning) next[profileId] = true;
      else delete next[profileId];
      return next;
    });
  }, []);

  // ── Forecast execution ───────────────────────────────────────────────────
  const executeForecastFlow = useCallback(async ({ profileId = null, fallbackProfileRow = null } = {}) => {
    if (!user?.id) {
      addNotification?.('Please sign in before running forecast.', 'error');
      return;
    }
    if (!currentConversationId) {
      addNotification?.('Please start a conversation first.', 'error');
      return;
    }

    const resolvedProfileRow = fallbackProfileRow || await resolveDatasetProfileRow(profileId);
    if (!resolvedProfileRow?.id) {
      appendMessagesToCurrentConversation([{
        role: 'ai',
        content: 'No dataset profile available. Upload a dataset first, then run forecast.',
        timestamp: new Date().toISOString(),
      }]);
      return;
    }

    const forecastGate = buildExecutionGateResult(resolvedProfileRow, 'forecast');
    if (!forecastGate.isValid) {
      const dataSummaryPayload = buildDataSummaryCardPayload(resolvedProfileRow);
      const confirmationPayload = buildConfirmationPayload(dataSummaryPayload);
      const validationPayload = buildValidationPayload(resolvedProfileRow);
      const blockingQuestions = forecastGate.issues.map((issue) => {
        const text = issue.reason === 'missing_dataset'
          ? `Missing required dataset mapping for "${issue.upload_type}".`
          : `${issue.sheet_name || issue.upload_type}: map missing required fields (${
              Array.isArray(issue.missing_required_fields) && issue.missing_required_fields.length > 0
                ? issue.missing_required_fields.join(', ')
                : 'required fields'
            }).`;
        return { id: null, question: text, answer_type: 'text', options: null, why_needed: null, bind_to: null };
      }).slice(0, 2);

      const messages = [
        {
          role: 'ai',
          content: 'Forecast is blocked because contract validation is incomplete.',
          timestamp: new Date().toISOString(),
        },
        {
          role: 'ai',
          type: 'validation_card',
          payload: validationPayload,
          timestamp: new Date().toISOString(),
        },
        {
          role: 'ai',
          type: 'blocking_questions_card',
          payload: { questions: blockingQuestions, dataset_profile_id: resolvedProfileRow.id, run_id: null },
          timestamp: new Date().toISOString(),
        },
      ];
      if (confirmationPayload) {
        messages.push({
          role: 'ai',
          type: 'contract_confirmation_card',
          payload: confirmationPayload,
          timestamp: new Date().toISOString(),
        });
      }
      appendMessagesToCurrentConversation(messages);
      setConversationDatasetContext((prev) => ({
        ...prev,
        [currentConversationId]: {
          ...(prev[currentConversationId] || {}),
          contractConfirmed: false,
          validationPayload,
        },
      }));
      addNotification?.('Forecast blocked: fix required mapping first.', 'error');
      return;
    }

    const targetProfileId = resolvedProfileRow.id;
    setForecastRunningForProfile(targetProfileId, true);
    markCanvasRunStarted(`Forecast run (profile #${targetProfileId})`);

    appendMessagesToCurrentConversation([{
      role: 'ai',
      content: `Running forecast for dataset profile #${targetProfileId}...`,
      timestamp: new Date().toISOString(),
    }]);

    try {
      const runtimeSettings = buildRuntimeWorkflowSettings(activeDatasetContext || {}, {});
      const requestedHorizon = Number(runtimeSettings?.forecast?.horizon_periods);
      const forecastResult = await runForecastFromDatasetProfile({
        userId: user.id,
        datasetProfileRow: resolvedProfileRow,
        horizonPeriods: Number.isFinite(requestedHorizon) ? requestedHorizon : null,
        settings: runtimeSettings,
      });
      const cardPayload = buildForecastCardPayload(forecastResult, resolvedProfileRow);
      const actualVsForecastRows = buildActualVsForecastRowsFromForecastCard(cardPayload);

      appendMessagesToCurrentConversation([
        {
          role: 'ai',
          content: forecastResult.summary_text,
          timestamp: new Date().toISOString(),
        },
        {
          role: 'ai',
          type: 'forecast_result_card',
          payload: cardPayload,
          timestamp: new Date().toISOString(),
        },
      ]);

      // --- Decision Bundle Card for forecast ---
      try {
        const metrics = forecastResult?.metrics || cardPayload?.metrics || {};
        const forecastEvidence = assembleForecastEvidence({
          runId: forecastResult?.run?.id,
          metrics,
        });
        const mapeValue = metrics.mape != null ? `${Number(metrics.mape).toFixed(1)}%` : 'N/A';
        const modelName = metrics.selected_model_global || 'auto';
        const forecastBundle = buildDecisionBundle({
          summary: `Forecast completed with MAPE ${mapeValue} using ${modelName} model. ${metrics.groups_processed || 0} group(s) processed over ${metrics.horizon_periods || 0} periods.`,
          recommendation: {
            text: 'Proceed with plan optimization using this forecast.',
            action_type: 'run_plan',
            confidence: metrics.mape != null && metrics.mape < 20 ? 0.85 : 0.6,
          },
          drivers: [
            { label: 'MAPE', value: mapeValue, direction: metrics.mape != null && metrics.mape < 15 ? 'positive' : metrics.mape > 25 ? 'negative' : 'neutral' },
            { label: 'Model', value: modelName, direction: 'neutral' },
            { label: 'Horizon', value: `${metrics.horizon_periods || 0}p`, direction: 'neutral' },
          ],
          evidence_refs: forecastEvidence,
          next_actions: [
            { action_id: 'run_plan', label: 'Run Plan', priority: 1 },
            { action_id: 'run_risk_plan', label: 'Risk-Aware Plan', priority: 2 },
            { action_id: 'run_what_if', label: 'What-If Scenario', priority: 3 },
          ],
        });
        appendMessagesToCurrentConversation([{
          role: 'ai',
          type: 'decision_bundle_card',
          payload: forecastBundle,
          timestamp: new Date().toISOString(),
        }]);
      } catch (bundleErr) {
        console.warn('[useForecastExecutor] Decision bundle generation failed:', bundleErr?.message);
      }

      if (actualVsForecastRows.length > 0) {
        const forecastSeriesGroups = Array.isArray(cardPayload.series_groups) ? cardPayload.series_groups : [];
        updateCanvasState(currentConversationId, (prev) => ({
          ...prev,
          chartPayload: {
            ...(prev.chartPayload || {}),
            actual_vs_forecast: actualVsForecastRows,
            ...(forecastSeriesGroups.length > 0 ? { series_groups: forecastSeriesGroups } : {}),
          },
          activeTab: 'charts',
        }));
      }

      markCanvasRunFinished('succeeded', '✅ Forecast completed.', 'ml');
      addNotification?.(`Forecast run #${forecastResult?.run?.id || ''} completed.`, 'success');
    } catch (error) {
      appendMessagesToCurrentConversation([
        {
          role: 'ai',
          content: `Forecast failed: ${error.message}`,
          timestamp: new Date().toISOString(),
        },
        {
          role: 'ai',
          type: 'forecast_error_card',
          payload: {
            run_id: error?.run_id || null,
            message: error.message,
            blocking_questions: Array.isArray(error?.blockingQuestions) ? error.blockingQuestions : [],
          },
          timestamp: new Date().toISOString(),
        },
      ]);
      markCanvasRunFinished('failed', `❌ Forecast failed: ${error.message}`, 'ml');
      addNotification?.(`Forecast failed: ${error.message}`, 'error');
    } finally {
      setForecastRunningForProfile(targetProfileId, false);
    }
  }, [
    user?.id,
    currentConversationId,
    activeDatasetContext,
    appendMessagesToCurrentConversation,
    addNotification,
    resolveDatasetProfileRow,
    setForecastRunningForProfile,
    markCanvasRunStarted,
    markCanvasRunFinished,
    updateCanvasState,
    setConversationDatasetContext,
  ]);

  return {
    // State
    runningForecastProfiles,
    setRunningForecastProfiles,

    // Handlers
    setForecastRunningForProfile,
    executeForecastFlow,
  };
}
