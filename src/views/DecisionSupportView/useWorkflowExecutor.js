// ============================================
// useWorkflowExecutor — workflow A/B/DigitalTwin execution, async polling
// Extracted from DecisionSupportView/index.jsx
//
// ── TWO EXECUTION PATHS (both valid for V1) ──
//
// PATH 1 — Workflow Engine (this file):
//   User clicks "Run Workflow A/B" button → executeWorkflowFlow()
//   → workflowAEngine/workflowBEngine runs forecast→plan→risk→verify→topology→report
//   → Results appear as chat cards directly. No AI employee task lifecycle.
//   Use case: Quick analysis, power users, demo "show the engines work".
//
// PATH 2 — Digital Worker Orchestrator (DecisionSupportView index.jsx):
//   User sends chat message → task decomposition → submitPlan() → orchestrator.tick()
//   → Full task lifecycle: draft_plan → waiting_approval → in_progress → review → done
//   → Results appear via SSE + AgentExecutionPanel. Full audit trail.
//   Use case: Digital worker demo, task board, review/approve flow.
//
// For V1 demo: PATH 1 shows domain engine strength; PATH 2 shows digital worker vision.
// Both paths share the same underlying domain engines. They do NOT conflict.
// ============================================

import { useState, useRef, useEffect, useCallback } from 'react';
import {
  startWorkflow,
  runNextStep as runWorkflowNextStep,
  resumeRun as resumeWorkflowRun,
  replayRun as replayWorkflowRun,
  getRunSnapshot as getWorkflowRunSnapshot,
  submitBlockingAnswers as submitWorkflowBlockingAnswers,
  WORKFLOW_NAMES,
} from '../../workflows/workflowRegistry';
import asyncRunsApiClient, { isAsyncRunsConnectivityError } from '../../services/infra/asyncRunsApiClient';
import { loadTopologyGraphForRun } from '../../services/topology/topologyService';
import { datasetProfilesService } from '../../services/data-prep/datasetProfilesService';
import * as digitalTwinService from '../../services/planning/digitalTwinService';
import {
  ASYNC_JOB_POLL_INTERVAL_MS,
  ASYNC_JOB_MAX_POLLS,
  BIND_TO_ALLOWLIST,
  getWorkflowFromProfile,
  buildRuntimeWorkflowSettings,
  buildExecutionGateResult,
  buildValidationPayload,
  buildConfirmationPayload,
  deriveCanvasChartPatchFromCard,
  normalizeWorkflowUiError,
  toPositiveRunId,
} from './helpers.js';
import { buildDataSummaryCardPayload } from '../../services/data-prep/chatDatasetProfilingService';

/**
 * Manages workflow execution state and handlers.
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
export default function useWorkflowExecutor({
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
  const [workflowSnapshots, setWorkflowSnapshots] = useState({});
  const [activeWorkflowRuns, setActiveWorkflowRuns] = useState({});
  const asyncJobByRunRef = useRef({});

  // ── Snapshot management ──────────────────────────────────────────────────
  const upsertWorkflowSnapshot = useCallback((snapshot) => {
    const runId = snapshot?.run?.id;
    if (!runId) return;
    setWorkflowSnapshots((prev) => ({
      ...prev,
      [runId]: snapshot,
    }));
  }, []);

  const setWorkflowRunActive = useCallback((runId, isActive) => {
    if (!runId) return;
    setActiveWorkflowRuns((prev) => {
      const next = { ...prev };
      if (isActive) next[runId] = true;
      else delete next[runId];
      return next;
    });
  }, []);

  // ── Polling for active workflow runs ─────────────────────────────────────
  useEffect(() => {
    const runIds = Object.keys(activeWorkflowRuns || {})
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id));
    if (runIds.length === 0) return undefined;

    let cancelled = false;
    const intervalId = setInterval(async () => {
      if (cancelled) return;
      await Promise.all(runIds.map(async (runId) => {
        try {
          const snapshot = await getWorkflowRunSnapshot(runId);
          if (!snapshot?.run) return;
          upsertWorkflowSnapshot(snapshot);
          const status = String(snapshot.run.status || '').toLowerCase();
          if (status === 'succeeded' || status === 'failed') {
            setWorkflowRunActive(runId, false);
          }
        } catch {
          // best effort polling
        }
      }));
    }, 2000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [activeWorkflowRuns, upsertWorkflowSnapshot, setWorkflowRunActive]);

  // ── Step event → chat messages + canvas patches ──────────────────────────
  const appendWorkflowStepEventMessages = useCallback((runId, stepEvent, profileId = null) => {
    if (!stepEvent) return;

    const timestamp = new Date().toISOString();
    const messages = [];
    let chartPatch = null;

    if (stepEvent.notice_text) {
      messages.push({
        role: 'ai',
        content: stepEvent.notice_text,
        timestamp,
      });
    }

    if (Array.isArray(stepEvent.result_cards) && stepEvent.result_cards.length > 0) {
      stepEvent.result_cards.forEach((card) => {
        if (!card?.type) return;
        messages.push({
          role: 'ai',
          type: card.type,
          payload: card.payload || {},
          timestamp,
        });

        const patch = deriveCanvasChartPatchFromCard(card.type, card.payload || {});
        if (patch) {
          chartPatch = {
            ...(chartPatch || {}),
            ...patch,
          };
        }
      });
    }

    if (stepEvent.status === 'blocked' && stepEvent.error) {
      messages.push({
        role: 'ai',
        type: 'blocking_questions_interactive_card',
        payload: {
          run_id: runId || null,
          step: stepEvent.step,
          questions: Array.isArray(stepEvent.error.blocking_questions) ? stepEvent.error.blocking_questions : [],
        },
        timestamp,
      });
    } else if (stepEvent.status === 'failed' && stepEvent.error) {
      messages.push({
        role: 'ai',
        type: 'workflow_error_card',
        payload: {
          step: stepEvent.step,
          error_code: stepEvent.error.code,
          error_message: stepEvent.error.message,
          next_actions: stepEvent.error.next_actions || [],
        },
        timestamp,
      });

      if (Array.isArray(stepEvent.error.blocking_questions) && stepEvent.error.blocking_questions.length > 0) {
        messages.push({
          role: 'ai',
          type: 'blocking_questions_card',
          payload: {
            questions: stepEvent.error.blocking_questions,
            run_id: runId || null,
            dataset_profile_id: profileId || null,
          },
          timestamp,
        });
      }
    }

    if (messages.length > 0) {
      appendMessagesToCurrentConversation(messages);
    }

    if (chartPatch && currentConversationId) {
      updateCanvasState(currentConversationId, (prev) => ({
        ...prev,
        chartPayload: {
          ...(prev.chartPayload || {}),
          ...chartPatch,
        },
        activeTab: 'charts',
      }));
    }

    if (stepEvent?.step === 'topology' && stepEvent?.status === 'succeeded' && currentConversationId) {
      const safeRunId = toPositiveRunId(runId);
      if (safeRunId) {
        loadTopologyGraphForRun({ runId: safeRunId })
          .then((loaded) => {
            if (!loaded?.graph) return;
            updateCanvasState(currentConversationId, (prev) => ({
              ...prev,
              chartPayload: {
                ...(prev.chartPayload || {}),
                topology_graph: loaded.graph,
              },
              topologyRunning: false,
            }));
          })
          .catch(() => {
            // best effort graph hydration for topology step
          });
      }
    }
  }, [appendMessagesToCurrentConversation, currentConversationId, updateCanvasState]);

  // ── Sleep helper ─────────────────────────────────────────────────────────
  const sleepMs = useCallback((ms) => new Promise((resolve) => setTimeout(resolve, ms)), []);

  // ── Async job polling loop ───────────────────────────────────────────────
  const processAsyncWorkflowJob = useCallback(async ({ jobId, runId }) => {
    if (!jobId || !runId) return null;
    let latestSnapshot = null;

    setWorkflowRunActive(runId, true);
    try {
      for (let i = 0; i < ASYNC_JOB_MAX_POLLS; i += 1) {
        const jobStatus = await asyncRunsApiClient.getJob(jobId);
        const runStatus = String(jobStatus?.run_status || jobStatus?.status || 'queued').toLowerCase();
        const runMeta = jobStatus?.run_meta && typeof jobStatus.run_meta === 'object'
          ? jobStatus.run_meta
          : {};

        latestSnapshot = {
          run: {
            id: runId,
            workflow: jobStatus?.workflow || null,
            stage: jobStatus?.run_stage || jobStatus?.current_step || null,
            status: runStatus,
            job_id: jobId,
            meta: {
              ...runMeta,
              job_id: runMeta.job_id || jobId,
              async_job_id: runMeta.async_job_id || jobId,
              async_mode: true,
            },
          },
          steps: Array.isArray(jobStatus?.step_summary) ? jobStatus.step_summary : [],
          artifacts: [],
        };
        upsertWorkflowSnapshot(latestSnapshot);

        const jobStatusNorm = String(jobStatus?.status || '').toLowerCase();
        if (['succeeded', 'failed', 'canceled'].includes(jobStatusNorm) || runStatus === 'waiting_user') {
          break;
        }
        await sleepMs(ASYNC_JOB_POLL_INTERVAL_MS);
      }
    } finally {
      setWorkflowRunActive(runId, false);
    }
    return latestSnapshot;
  }, [setWorkflowRunActive, sleepMs, upsertWorkflowSnapshot]);

  // ── Run workflow steps until completion ───────────────────────────────────
  const processWorkflowRun = useCallback(async (runId) => {
    if (!runId) return null;
    let snapshot = null;
    const maxIterations = 24;

    setWorkflowRunActive(runId, true);
    try {
      for (let i = 0; i < maxIterations; i += 1) {
        const next = await runWorkflowNextStep(runId);
        snapshot = {
          run: next.run,
          steps: next.steps,
          artifacts: next.artifacts,
        };
        upsertWorkflowSnapshot(snapshot);
        appendWorkflowStepEventMessages(runId, next.step_event, next.run?.dataset_profile_id || null);

        const runStatus = String(next?.run?.status || '').toLowerCase();
        if (runStatus === 'succeeded' || runStatus === 'failed') {
          break;
        }
        if (!next.progressed_step) {
          break;
        }
      }
    } catch (error) {
      const uiError = normalizeWorkflowUiError(error, {
        fallbackMessage: 'Workflow execution failed.',
        fallbackActions: [
          'Retry the workflow run.',
          'If the issue persists, review run artifacts and mappings.',
        ],
      });
      appendMessagesToCurrentConversation([
        {
          role: 'ai',
          content: `Workflow execution failed: ${uiError.message}`,
          timestamp: new Date().toISOString(),
        },
        {
          role: 'ai',
          type: 'workflow_error_card',
          payload: {
            step: 'workflow',
            error_code: uiError.code,
            error_message: uiError.message,
            next_actions: uiError.nextActions,
          },
          timestamp: new Date().toISOString(),
        },
      ]);
      addNotification?.(`Workflow run failed: ${uiError.message}`, 'error');
    } finally {
      setWorkflowRunActive(runId, false);
    }
    return snapshot;
  }, [
    appendWorkflowStepEventMessages,
    appendMessagesToCurrentConversation,
    addNotification,
    setWorkflowRunActive,
    upsertWorkflowSnapshot,
  ]);

  // ── Main workflow execution entry point ──────────────────────────────────
  const executeWorkflowFlow = useCallback(async ({
    datasetProfileId = null,
    settings = {},
    workflowName = null,
  } = {}) => {
    if (!user?.id) {
      addNotification?.('Please sign in before running workflow.', 'error');
      return;
    }
    if (!currentConversationId) {
      addNotification?.('Please start a conversation first.', 'error');
      return;
    }

    const profileRow = await resolveDatasetProfileRow(datasetProfileId);
    if (!profileRow?.id) {
      appendMessagesToCurrentConversation([{
        role: 'ai',
        content: 'No dataset profile available. Upload data first.',
        timestamp: new Date().toISOString(),
      }]);
      return;
    }

    const guessedWorkflowLabel = String(profileRow?.profile_json?.global?.workflow_guess?.label || '').trim().toUpperCase();
    if (!workflowName && guessedWorkflowLabel && guessedWorkflowLabel !== 'A' && guessedWorkflowLabel !== 'B') {
      appendMessagesToCurrentConversation([{
        role: 'ai',
        content: `Workflow guess "${guessedWorkflowLabel}" is not executable here. Choose Workflow A or Workflow B explicitly, or fix the dataset mapping first.`,
        timestamp: new Date().toISOString(),
      }]);
      addNotification?.(`Unsupported workflow guess: ${guessedWorkflowLabel}`, 'error');
      return;
    }

    const selectedWorkflow = workflowName || getWorkflowFromProfile(profileRow?.profile_json || {});
    const workflowLabel = selectedWorkflow === WORKFLOW_NAMES.B ? 'Workflow B' : 'Workflow A';
    const workflowGate = buildExecutionGateResult(profileRow, selectedWorkflow);
    if (!workflowGate.isValid) {
      const dataSummaryPayload = buildDataSummaryCardPayload(profileRow);
      const confirmationPayload = buildConfirmationPayload(dataSummaryPayload);
      const validationPayload = buildValidationPayload(profileRow);
      const blockingQuestions = workflowGate.issues.map((issue) => {
        const text = issue.reason === 'missing_dataset'
          ? `${workflowLabel} requires dataset "${issue.upload_type}". Please map a sheet to this upload type.`
          : `${issue.sheet_name || issue.upload_type}: missing required fields (${
              Array.isArray(issue.missing_required_fields) && issue.missing_required_fields.length > 0
                ? issue.missing_required_fields.join(', ')
                : 'required fields'
            }).`;
        return { id: null, question: text, answer_type: 'text', options: null, why_needed: null, bind_to: null };
      }).slice(0, 2);

      const messages = [
        {
          role: 'ai',
          content: `${workflowLabel} is blocked because contract validation is incomplete.`,
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
          payload: { questions: blockingQuestions, dataset_profile_id: profileRow.id, run_id: null },
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
      addNotification?.(`${workflowLabel} blocked: fix required mapping first.`, 'error');
      return;
    }

    try {
      const runtimeSettings = buildRuntimeWorkflowSettings(activeDatasetContext || {}, settings || {});

      const isLocalProfile = String(profileRow.id || '').startsWith('local-');
      if (asyncRunsApiClient.isConfigured() && !isLocalProfile) {
        try {
          const submitResponse = await asyncRunsApiClient.submitRun({
            user_id: user.id,
            dataset_profile_id: profileRow.id,
            dataset_fingerprint: profileRow?.fingerprint || `profile_${profileRow.id}`,
            contract_template_id: activeDatasetContext?.contract_template_id || null,
            workflow: selectedWorkflow,
            engine_flags: {
              solver_engine: runtimeSettings?.plan?.solver_engine || 'heuristic',
              risk_mode: runtimeSettings?.risk?.mode || null,
              multi_echelon_mode: Boolean(runtimeSettings?.plan?.multi_echelon_mode),
            },
            settings: runtimeSettings,
            horizon: Number(runtimeSettings?.forecast?.horizon_periods || runtimeSettings?.forecast_horizon_periods || null) || null,
            granularity: profileRow?.profile_json?.global?.time_range_guess?.granularity || null,
            workload: {
              rows_per_sheet: Number(profileRow?.profile_json?.global?.rows_per_sheet || 0) || null,
              skus: Number(profileRow?.profile_json?.global?.sku_count || 0) || null,
            },
            async_mode: true,
          });

          const runId = Number(submitResponse?.run_id);
          const jobId = submitResponse?.job_id;
          if (!Number.isFinite(runId) || !jobId) {
            throw new Error('Async run submit did not return job_id/run_id');
          }
          asyncJobByRunRef.current[runId] = jobId;

          markCanvasRunStarted(`${workflowLabel} run (profile #${profileRow.id})`);
          updateCanvasState(currentConversationId, (prev) => ({
            ...prev,
            run: {
              ...(prev.run || {}),
              id: runId,
              run_id: runId,
              workflow: selectedWorkflow,
            },
          }));
          appendMessagesToCurrentConversation([
            {
              role: 'ai',
              content: `${workflowLabel} started (run #${runId}, job ${jobId}).`,
              timestamp: new Date().toISOString(),
            },
            {
              role: 'ai',
              type: 'workflow_progress_card',
              payload: {
                run_id: runId,
                job_id: jobId,
                workflow: selectedWorkflow,
                status: 'queued',
              },
              timestamp: new Date().toISOString(),
            },
          ]);

          const finalSnapshot = await processAsyncWorkflowJob({ jobId, runId });
          const finalStatus = String(finalSnapshot?.run?.status || '').toLowerCase();
          if (finalStatus === 'succeeded') {
            markCanvasRunFinished('succeeded', `✅ ${workflowLabel} run #${runId} completed.`, 'report');
            addNotification?.(`${workflowLabel} run #${runId} completed.`, 'success');
          } else if (finalStatus === 'failed' || finalStatus === 'canceled') {
            const label = finalStatus === 'canceled' ? 'canceled' : 'failed';
            markCanvasRunFinished('failed', `❌ ${workflowLabel} run #${runId} ${label}.`, 'report');
            addNotification?.(`${workflowLabel} run #${runId} ${label}.`, 'error');
          }
          return;
        } catch (asyncError) {
          if (!isAsyncRunsConnectivityError(asyncError)) {
            throw asyncError;
          }
          console.warn('[DecisionSupportView] Async run API unavailable, fallback to in-app workflow engine.', asyncError);
          addNotification?.('Async ML API unavailable. Falling back to local workflow engine.', 'warning');
        }
      }

      // Local profiles proceed with in-memory fallback
      if (isLocalProfile) {
        console.info(`[DSV] Running ${workflowLabel} with local profile ${profileRow.id} — Supabase calls will fallback to in-memory store`);
      }

      const startSnapshot = await startWorkflow({
        user_id: user.id,
        dataset_profile_id: profileRow.id,
        workflow: selectedWorkflow,
        settings: runtimeSettings,
        profileRow,
      });
      markCanvasRunStarted(`${workflowLabel} run (profile #${profileRow.id})`);
      upsertWorkflowSnapshot(startSnapshot);
      const runId = startSnapshot?.run?.id;

      if (!runId) {
        addNotification?.('Unable to start workflow run.', 'error');
        return;
      }

      updateCanvasState(currentConversationId, (prev) => ({
        ...prev,
        run: {
          ...(prev.run || {}),
          id: runId,
          run_id: runId,
          workflow: selectedWorkflow,
        },
      }));

      appendMessagesToCurrentConversation([
        {
          role: 'ai',
          content: `${workflowLabel} started (run #${runId}).`,
          timestamp: new Date().toISOString(),
        },
        {
          role: 'ai',
          type: 'workflow_progress_card',
          payload: {
            run_id: runId,
          },
          timestamp: new Date().toISOString(),
        },
      ]);

      const finalSnapshot = await processWorkflowRun(runId);
      const finalStatus = String(finalSnapshot?.run?.status || '').toLowerCase();
      if (finalStatus === 'succeeded') {
        markCanvasRunFinished('succeeded', `✅ ${workflowLabel} run #${runId} completed.`, 'report');
        addNotification?.(`${workflowLabel} run #${runId} completed.`, 'success');
      } else if (finalStatus === 'failed') {
        markCanvasRunFinished('failed', `❌ ${workflowLabel} run #${runId} failed.`, 'report');
        addNotification?.(`${workflowLabel} run #${runId} failed.`, 'error');
      }
    } catch (error) {
      markCanvasRunFinished('failed', `❌ Workflow start failed: ${error.message}`, 'profile');
      appendMessagesToCurrentConversation([
        {
          role: 'ai',
          content: `Workflow start failed: ${error.message}`,
          timestamp: new Date().toISOString(),
        },
        {
          role: 'ai',
          type: 'workflow_error_card',
          payload: {
            step: 'profile',
            error_code: 'UNKNOWN',
            error_message: error.message || 'Unable to start workflow.',
            next_actions: [
              'Retry starting the workflow.',
              'Verify dataset profile and contract are available.',
            ],
          },
          timestamp: new Date().toISOString(),
        },
      ]);
      addNotification?.(`Workflow start failed: ${error.message}`, 'error');
    }
  }, [
    user?.id,
    currentConversationId,
    activeDatasetContext,
    resolveDatasetProfileRow,
    appendMessagesToCurrentConversation,
    addNotification,
    upsertWorkflowSnapshot,
    processAsyncWorkflowJob,
    processWorkflowRun,
    markCanvasRunStarted,
    markCanvasRunFinished,
    updateCanvasState,
    setConversationDatasetContext,
  ]);

  // ── Convenience wrappers ─────────────────────────────────────────────────
  const executeWorkflowAFlow = useCallback((params = {}) => {
    return executeWorkflowFlow({
      ...params,
      workflowName: WORKFLOW_NAMES.A,
    });
  }, [executeWorkflowFlow]);

  const executeWorkflowBFlow = useCallback((params = {}) => {
    return executeWorkflowFlow({
      ...params,
      workflowName: WORKFLOW_NAMES.B,
    });
  }, [executeWorkflowFlow]);

  // ── Digital Twin ─────────────────────────────────────────────────────────
  const executeDigitalTwinFlow = useCallback(async ({ scenario = 'normal', chaosIntensity = null } = {}) => {
    appendMessagesToCurrentConversation([{
      role: 'ai',
      content: `Running Digital Twin simulation with **${scenario}** scenario...`,
      timestamp: new Date().toISOString(),
    }]);

    try {
      const result = await digitalTwinService.runSimulation({
        scenario,
        seed: 42,
        chaosIntensity: chaosIntensity || undefined,
      });

      if (!result.success) throw new Error(result.error || 'Simulation failed');

      const cardPayload = digitalTwinService.buildDigitalTwinCardPayload(result);

      appendMessagesToCurrentConversation([{
        role: 'ai',
        type: 'digital_twin_simulation_card',
        payload: cardPayload,
        timestamp: new Date().toISOString(),
      }]);
    } catch (err) {
      appendMessagesToCurrentConversation([{
        role: 'ai',
        content: `Digital Twin simulation failed: ${err.message}`,
        timestamp: new Date().toISOString(),
      }]);
    }
  }, [appendMessagesToCurrentConversation]);

  // ── Resume workflow ──────────────────────────────────────────────────────
  const handleResumeWorkflowA = useCallback(async (runId, explicitJobId = null) => {
    const numericRunId = toPositiveRunId(runId);
    if (!numericRunId) return;
    const snapshot = workflowSnapshots[numericRunId] || workflowSnapshots[String(numericRunId)] || null;
    const asyncJobId = explicitJobId
      || asyncJobByRunRef.current[numericRunId]
      || snapshot?.run?.job_id
      || snapshot?.run?.meta?.job_id
      || snapshot?.run?.meta?.async_job_id
      || null;
    try {
      if (asyncJobId) {
        const asyncError = new Error(`Run #${numericRunId} is managed by async job ${asyncJobId} and cannot be resumed from this card.`);
        asyncError.code = 'ASYNC_RUN_UNSUPPORTED';
        asyncError.nextActions = [
          'Wait for the async job to finish or cancel it.',
          'Start a new workflow run from the latest dataset card.',
        ];
        throw asyncError;
      }

      const resumed = await resumeWorkflowRun(numericRunId, { maxSteps: 1 });
      upsertWorkflowSnapshot(resumed);
      if (Array.isArray(resumed.events)) {
        resumed.events.forEach((event) => appendWorkflowStepEventMessages(numericRunId, event));
      }
      if (String(resumed?.run?.status || '').toLowerCase() === 'running') {
        await processWorkflowRun(numericRunId);
      }
    } catch (error) {
      const uiError = normalizeWorkflowUiError(error, {
        fallbackMessage: 'Unable to resume workflow.',
        fallbackActions: ['Retry resume.', 'Start a new workflow run from the latest dataset card.'],
      });
      appendMessagesToCurrentConversation([{
        role: 'ai',
        type: 'workflow_error_card',
        payload: {
          step: 'resume',
          error_code: uiError.code,
          error_message: uiError.message,
          next_actions: uiError.nextActions,
        },
        timestamp: new Date().toISOString(),
      }]);
      addNotification?.(`Workflow resume failed: ${uiError.message}`, 'error');
    }
  }, [
    workflowSnapshots,
    appendWorkflowStepEventMessages,
    appendMessagesToCurrentConversation,
    addNotification,
    processWorkflowRun,
    upsertWorkflowSnapshot,
  ]);

  // ── Blocking questions submit ────────────────────────────────────────────
  const handleBlockingQuestionsSubmit = useCallback(async ({ answersById = {}, questions = [], runId = null, profileId = null }) => {
    if (!user?.id) return;

    if (profileId && questions.length > 0) {
      try {
        const profileRow = await datasetProfilesService.getDatasetProfileById(user.id, Number(profileId));
        const contractJson = profileRow?.contract_json;
        if (contractJson && typeof contractJson === 'object') {
          let updated = JSON.parse(JSON.stringify(contractJson));

          questions.forEach((q) => {
            const bindTo = q.bind_to ? String(q.bind_to).trim() : null;
            const answerId = q.id || null;
            const value = answerId ? answersById[answerId] : null;

            if (!bindTo || value == null) return;

            const isAllowed = BIND_TO_ALLOWLIST.some((prefix) => bindTo.startsWith(prefix));
            if (!isAllowed) return;

            if (Array.isArray(q.options) && q.options.length > 0 && !q.options.includes(value)) return;

            const [section, ...rest] = bindTo.split('.');
            const key = rest.join('.');
            if (!section || !key) return;
            if (typeof updated[section] !== 'object' || updated[section] === null) {
              updated[section] = {};
            }
            updated[section][key] = value;
          });

          await datasetProfilesService.updateDatasetProfile(user.id, Number(profileId), {
            contract_json: updated,
          });
        }
      } catch (err) {
        appendMessagesToCurrentConversation([{
          role: 'ai',
          content: `Failed to apply answers to contract: ${err.message}`,
          timestamp: new Date().toISOString(),
        }]);
        return;
      }
    }

    if (runId) {
      await handleResumeWorkflowA(runId);
    }
  }, [user?.id, appendMessagesToCurrentConversation, handleResumeWorkflowA]);

  // ── Submit interactive blocking answers ──────────────────────────────────
  const handleSubmitBlockingAnswers = useCallback(async (runId, answers = {}) => {
    const numericRunId = toPositiveRunId(runId);
    if (!numericRunId || !user?.id) return;
    try {
      const result = await submitWorkflowBlockingAnswers(numericRunId, answers);
      upsertWorkflowSnapshot(result);
      if (Array.isArray(result.events)) {
        result.events.forEach((event) => appendWorkflowStepEventMessages(numericRunId, event));
      }
      if (String(result?.run?.status || '').toLowerCase() === 'running') {
        await processWorkflowRun(numericRunId);
      }
    } catch (error) {
      const uiError = normalizeWorkflowUiError(error, {
        fallbackMessage: 'Unable to resume after answering.',
        fallbackActions: ['Retry or use the Resume button.', 'Start a new workflow run if this card is stale.'],
      });
      appendMessagesToCurrentConversation([{
        role: 'ai',
        type: 'workflow_error_card',
        payload: {
          step: 'resume',
          error_code: uiError.code,
          error_message: uiError.message,
          next_actions: uiError.nextActions,
        },
        timestamp: new Date().toISOString(),
      }]);
      addNotification?.(`Failed to submit answers: ${uiError.message}`, 'error');
    }
  }, [
    user?.id,
    appendWorkflowStepEventMessages,
    appendMessagesToCurrentConversation,
    addNotification,
    processWorkflowRun,
    upsertWorkflowSnapshot,
  ]);

  // ── Replay workflow ──────────────────────────────────────────────────────
  const handleReplayWorkflowA = useCallback(async (runId, options = {}, explicitJobId = null) => {
    const numericRunId = toPositiveRunId(runId);
    if (!numericRunId) return;
    if (!user?.id) {
      addNotification?.('Please sign in before replay.', 'error');
      return;
    }

    try {
      const snapshot = workflowSnapshots[numericRunId] || workflowSnapshots[String(numericRunId)] || null;
      const asyncJobId = explicitJobId
        || asyncJobByRunRef.current[numericRunId]
        || snapshot?.run?.job_id
        || snapshot?.run?.meta?.job_id
        || snapshot?.run?.meta?.async_job_id
        || null;
      if (asyncJobId) {
        const asyncError = new Error(`Run #${numericRunId} is managed by async job ${asyncJobId} and cannot be replayed from this card.`);
        asyncError.code = 'ASYNC_RUN_UNSUPPORTED';
        asyncError.nextActions = [
          'Start a new workflow run from the latest dataset card.',
          'Keep this run card for audit history only.',
        ];
        throw asyncError;
      }

      const replaySnapshot = await replayWorkflowRun(numericRunId, {
        use_cached_forecast: Boolean(options?.use_cached_forecast),
        use_cached_plan: Boolean(options?.use_cached_plan),
      });
      upsertWorkflowSnapshot(replaySnapshot);
      const newRunId = replaySnapshot?.run?.id;
      if (!newRunId) return;

      appendMessagesToCurrentConversation([
        {
          role: 'ai',
          content: `Replay started from run #${numericRunId} (new run #${newRunId}).`,
          timestamp: new Date().toISOString(),
        },
        {
          role: 'ai',
          type: 'workflow_progress_card',
          payload: {
            run_id: newRunId,
          },
          timestamp: new Date().toISOString(),
        },
      ]);

      await processWorkflowRun(newRunId);
    } catch (error) {
      const uiError = normalizeWorkflowUiError(error, {
        fallbackMessage: 'Unable to replay workflow.',
        fallbackActions: ['Retry replay.', 'Run the workflow again from the latest dataset card.'],
      });
      appendMessagesToCurrentConversation([{
        role: 'ai',
        type: 'workflow_error_card',
        payload: {
          step: 'replay',
          error_code: uiError.code,
          error_message: uiError.message,
          next_actions: uiError.nextActions,
        },
        timestamp: new Date().toISOString(),
      }]);
      addNotification?.(`Workflow replay failed: ${uiError.message}`, 'error');
    }
  }, [
    user?.id,
    workflowSnapshots,
    addNotification,
    appendMessagesToCurrentConversation,
    upsertWorkflowSnapshot,
    processWorkflowRun,
  ]);

  // ── Cancel async workflow ────────────────────────────────────────────────
  const handleCancelAsyncWorkflow = useCallback(async (runId, explicitJobId = null) => {
    const numericRunId = Number(runId);
    if (!Number.isFinite(numericRunId)) return;
    const jobId = explicitJobId || asyncJobByRunRef.current[numericRunId];
    if (!jobId) {
      addNotification?.(`No async job found for run #${numericRunId}.`, 'error');
      return;
    }

    try {
      await asyncRunsApiClient.cancelJob(jobId);
      addNotification?.(`Cancel requested for run #${numericRunId}.`, 'info');
    } catch (error) {
      addNotification?.(`Cancel failed for run #${numericRunId}: ${error.message}`, 'error');
    }
  }, [addNotification]);

  return {
    // State
    workflowSnapshots,
    setWorkflowSnapshots,
    activeWorkflowRuns,
    setActiveWorkflowRuns,
    asyncJobByRunRef,

    // Handlers
    upsertWorkflowSnapshot,
    setWorkflowRunActive,
    executeWorkflowFlow,
    executeWorkflowAFlow,
    executeWorkflowBFlow,
    executeDigitalTwinFlow,
    handleResumeWorkflowA,
    handleReplayWorkflowA,
    handleBlockingQuestionsSubmit,
    handleSubmitBlockingAnswers,
    handleCancelAsyncWorkflow,
    appendWorkflowStepEventMessages,
  };
}
