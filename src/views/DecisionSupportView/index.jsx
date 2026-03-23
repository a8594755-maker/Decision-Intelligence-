// ============================================
// Decision Support View - Chat + Canvas
// Single-screen digital worker interface with white-box execution
// ============================================

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { Activity, Bot, FileText } from 'lucide-react';
import { Card, Button } from '../../components/ui';
import { supabase, userFilesService } from '../../services/supabaseClient';
import { prepareChatUploadFromFile, prepareChatUploadFromFiles, buildDataSummaryCardPayload, MAX_UPLOAD_BYTES } from '../../services/chatDatasetProfilingService';
import { getRequiredMappingStatus } from '../../utils/requiredMappingStatus';
import { setLocalTableData, TABLE_REGISTRY } from '../../services/liveDataQueryService';
import { createDatasetProfileFromSheets } from '../../services/datasetProfilingService';
import { datasetProfilesService, registerLocalProfile } from '../../services/datasetProfilesService';
import { reuseMemoryService } from '../../services/reuseMemoryService';
import { streamChatWithAI, getLastUsedModel } from '../../services/geminiAPI';
import { runAgentLoop, ANALYSIS_AGENT_TOOL_IDS } from '../../services/chatAgentLoop';
import { detectDomain, buildChallengerInstruction } from '../../services/analysisDomainEnrichment';
import { registerTool, approveTool } from '../../services/toolRegistryService';
import { invalidateRegisteredToolsCache } from '../../services/chatToolAdapter';
import { diResetService } from '../../services/diResetService';
import {
  runPlanFromDatasetProfile,
  buildPlanSummaryCardPayload,
  buildPlanTableCardPayload,
  buildInventoryProjectionCardPayload,
  buildPlanDownloadsPayload,
} from '../../services/chatPlanningService';
import {
  generateTopologyGraphForRun,
  loadTopologyGraphForRun
} from '../../services/topology/topologyService';
import { buildSignature } from '../../utils/datasetSimilarity';
import { buildReusePlan, applyContractTemplateToProfile } from '../../utils/reusePlanner';
import { APP_NAME } from '../../config/branding';
import { isCommandEnabled, getDisabledMessage } from '../../config/featureGateService';
import { executeChatCanvasRun } from '../../services/chatCanvasWorkflowService';
import CanvasPanel from '../../components/chat/CanvasPanel';
import AgentExecutionPanel from '../../components/chat/AgentExecutionPanel';
import AIEmployeeChatShell from '../../components/chat/AIEmployeeChatShell';
import AIEmployeeConversationSidebar from '../../components/chat/AIEmployeeConversationSidebar';
import { useAgentSSE } from '../../hooks/useAgentSSE';
import { checkNegotiationTrigger, runNegotiation } from '../../services/negotiation/negotiationOrchestrator';
import { computePositionBucket } from '../../services/negotiation/cfr/negotiation-position-buckets.js';
import { computeSupplierTypePriors } from '../../services/negotiation/cfr/negotiation-types.js';
import { deriveSolverParamsFromStrategy } from '../../services/negotiation/cfr/cfr-solver-bridge.js';
import SplitShell from '../../components/chat/SplitShell';
import ConversationSidebar from '../../components/chat/ConversationSidebar';
import ChatThread from '../../components/chat/ChatThread';
import ChatComposer from '../../components/chat/ChatComposer';
import EmployeeProfilePanel from '../../components/ai-employee/EmployeeProfilePanel';
import useSessionContext from '../../hooks/useSessionContext';
import { parseIntent, routeIntent } from '../../services/chatIntentService';
import { buildChatSessionContext, buildContextSummaryForPrompt } from '../../services/chatSessionContextBuilder';
import { looksLikeScenario } from '../../services/scenarioIntentParser';
import { runScenarioFromChat } from '../../services/scenarioChatBridge';
import { resolveActionToIntent } from '../../services/chatActionRegistry';
import { handleParameterChange, handlePlanComparison, buildComparisonSummaryText } from '../../services/chatRefinementService';
import { generateAnalysisBlueprint, executeModule as executeBlueprintModule } from '../../services/analysisBlueprintService';
import { buildAgentPresentationPayload, resolveAgentAnswerContract } from '../../services/agentResponsePresentationService.js';
import { judgeAgentCandidates } from '../../services/agentCandidateJudgeService.js';
import { resolveAgentExecutionStrategy } from '../../services/agentExecutionStrategyService.js';
import { buildDirectAnalysisAgentPrompt, resolveDirectAnalysisRequest } from '../../services/directAnalysisService.js';
import { parseManualThinkingDirective, resolveChatThinkingPolicy } from '../../services/chatThinkingPolicyService.js';
import { handleDataQuery } from '../../services/sapQueryChatHandler.js';

import { createAlertMonitor, buildAlertChatMessage, isAlertMonitorEnabled } from '../../services/alertMonitorService';
import { batchApprove, batchReject } from '../../services/approvalWorkflowService';
import { decomposeTask } from '../../services/chatTaskDecomposer';
import { getEmployee, getOrCreateWorker } from '../../services/aiEmployee/queries.js';
// v2 orchestrator — single entry point for task lifecycle
import { submitPlan, approvePlan as orchestratorApprovePlan, isRalphLoopEnabled, abortAllRalphLoops, resolveReviewDecision } from '../../services/aiEmployee/index.js';
import { eventBus, EVENT_NAMES } from '../../services/eventBus.js';
import { processEmailIntake } from '../../services/emailIntakeService.js';
import { processTranscriptIntake } from '../../services/transcriptIntakeService.js';
import { processIntake, INTAKE_SOURCES } from '../../services/taskIntakeService.js';
import {
  buildAttachmentPromptText,
  buildSpreadsheetAttachmentPayloads,
  isSpreadsheetAttachment,
  materializeDocumentAttachments,
  preparePendingChatAttachments,
} from '../../services/chatAttachmentService.js';
import {
  SIDEBAR_COLLAPSED_KEY_PREFIX,
  CANVAS_SPLIT_RATIO_KEY_PREFIX,
  MAX_UPLOAD_MESSAGE,
  createDefaultCanvasState,
  QUICK_PROMPTS,
  AI_EMPLOYEE_QUICK_PROMPTS,
  clampSplitRatio,
  isApiKeyConfigError,
  getErrorMessage,
  buildFingerprintFromUpload,
  getWorkflowFromProfile,
  buildValidationPayload,
  buildDownloadsPayload,
  buildConfirmationPayload,
  applyContractOverrides,
  buildEvidenceSummaryText,
  deriveCanvasChartPatchFromCard,
  findLatestRunIdFromMessages,
  findLatestWorkflowRunIdFromMessages,
  loadDomainContext,
  buildSystemPrompt,
  isExecutionIntent,
  initTableAvailability,
  markTableUnavailable,
  toPositiveRunId,
} from './helpers.js';

// Extracted hooks and renderer
import useConversationManager from './useConversationManager.js';
import useForecastExecutor from './useForecastExecutor.js';
import usePlanExecutor from './usePlanExecutor.js';
import useWorkflowExecutor from './useWorkflowExecutor.js';
import MessageCardRenderer from './MessageCardRenderer.jsx';
import {
  consumeModelConfigNormalizationNotices,
  getModelConfigResolution,
} from '../../services/modelConfigService.js';

const tableAvailable = initTableAvailability();
const conversationsDb = tableAvailable ? supabase : null;

// Module-level cache for inline raw rows — survives HMR state resets
const _rawRowsCache = new Map();

function createLinkedAbortController(parentSignal) {
  const controller = new AbortController();
  if (!parentSignal) return controller;
  if (parentSignal.aborted) {
    controller.abort(parentSignal.reason);
    return controller;
  }
  const forwardAbort = () => controller.abort(parentSignal.reason);
  parentSignal.addEventListener('abort', forwardAbort, { once: true });
  return controller;
}

function resolveCandidateFailureStatus(error) {
  const message = getErrorMessage(error);
  return /timed?\s*out/i.test(message) ? 'timed_out' : 'failed';
}

function getCandidateFailureCategory(error) {
  return String(error?.failureCategory || '').trim() || 'tool_transport_failed';
}

function getCandidateFailureMessage(error) {
  return String(error?.failureMessage || getErrorMessage(error)).trim() || 'Unknown error';
}

function getCandidateRecoveryAttempts(error) {
  return Array.isArray(error?.recoveryAttempts) ? error.recoveryAttempts.filter(Boolean) : [];
}

function createMissingEvidenceError(result) {
  const error = new Error('No successful analysis evidence was produced.');
  error.name = 'AgentLoopError';
  error.failureCategory = 'missing_evidence';
  error.failureMessage = 'No successful analysis evidence was produced.';
  error.recoveryAttempts = Array.isArray(result?.recoveryAttempts) ? result.recoveryAttempts.filter(Boolean) : [];
  return error;
}

function buildFailedCandidate({
  candidateId,
  label,
  tone,
  provider,
  model,
  transport = null,
  status,
  failedReason,
  failureCategory = 'tool_transport_failed',
  failureMessage = null,
  recoveryAttempts = [],
  configNormalized = false,
  startedAt,
  finishedAt,
  durationMs,
}) {
  const normalizedReason = String(failedReason || failureMessage || 'Unknown error').trim() || 'Unknown error';
  const normalizedCategory = String(failureCategory || 'tool_transport_failed').trim() || 'tool_transport_failed';
  const categoryLabel = normalizedCategory.replace(/_/g, ' ');
  const summary = status === 'timed_out'
    ? `${label || candidateId || 'Candidate'} timed out (${categoryLabel}): ${normalizedReason}`
    : `${label || candidateId || 'Candidate'} failed (${categoryLabel}): ${normalizedReason}`;

  return {
    candidateId,
    label,
    tone,
    provider,
    model,
    transport,
    status,
    startedAt,
    finishedAt,
    durationMs,
    failedReason: normalizedReason,
    failureCategory: normalizedCategory,
    failureMessage: String(failureMessage || normalizedReason).trim() || normalizedReason,
    recoveryAttempts,
    configNormalized: Boolean(configNormalized),
    result: null,
    presentation: {
      brief: null,
      trace: {
        failed_attempts: [{
          id: `${candidateId || 'candidate'}-failure`,
          name: label || candidateId || 'Candidate',
          category: normalizedCategory,
          error: normalizedReason,
          summary,
        }],
        successful_queries: [],
        raw_narrative: '',
      },
      qa: null,
    },
  };
}

function hasSuccessfulAnalysisEvidence(result) {
  const toolCalls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
  return toolCalls.some((toolCall) => {
    if (!toolCall?.result?.success) return false;

    if (toolCall?.name === 'run_python_analysis' || toolCall?.name === 'generate_chart') {
      return true;
    }

    if (toolCall?.name === 'query_sap_data') {
      const rowCount = Number.isFinite(toolCall?.result?.result?.rowCount)
        ? toolCall.result.result.rowCount
        : (Array.isArray(toolCall?.result?.result?.rows) ? toolCall.result.result.rows.length : null);
      return Number.isFinite(rowCount) ? rowCount > 0 : false;
    }

    return false;
  });
}

function buildOrchestrationCandidateMeta(candidate) {
  if (!candidate) return null;
  return {
    candidateId: candidate.candidateId,
    provider: candidate.provider || null,
    model: candidate.model || null,
    transport: candidate.transport || null,
    status: candidate.status || 'completed',
    startedAt: candidate.startedAt || null,
    finishedAt: candidate.finishedAt || null,
    durationMs: Number.isFinite(candidate.durationMs) ? candidate.durationMs : null,
    failedReason: candidate.failedReason || null,
    failureCategory: candidate.failureCategory || null,
    failureMessage: candidate.failureMessage || null,
    recoveryAttempts: Array.isArray(candidate.recoveryAttempts) ? candidate.recoveryAttempts : [],
    configNormalized: Boolean(candidate.configNormalized),
  };
}

function buildBlockedAgentQa(candidates = []) {
  const issues = candidates
    .map((candidate) => {
      const reason = String(candidate?.failedReason || '').trim();
      if (!reason) return null;
      const category = String(candidate?.failureCategory || '').trim();
      return `${candidate?.label || candidate?.candidateId || 'Candidate'}${category ? ` [${category}]` : ''}: ${reason}`;
    })
    .filter(Boolean);

  return {
    status: 'warning',
    score: 0,
    pass_threshold: 8,
    blockers: ['No candidate produced a valid answer.'],
    issues: issues.length > 0 ? issues : ['Both candidate runs failed before producing a valid answer.'],
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
  };
}

function buildBlockedTrace(candidates = []) {
  return {
    failed_attempts: candidates
      .map((candidate, index) => {
        const reason = String(candidate?.failedReason || '').trim();
        if (!reason) return null;
        const category = String(candidate?.failureCategory || '').trim();
        return {
          id: `${candidate?.candidateId || 'candidate'}-${index}`,
          name: candidate?.label || candidate?.candidateId || 'Candidate',
          category: category || null,
          error: reason,
          summary: category ? `[${category}] ${reason}` : reason,
        };
      })
      .filter(Boolean),
    successful_queries: [],
    raw_narrative: '',
  };
}

export default function DecisionSupportView({ user, addNotification, mode = 'di', activeWorkerId = null, activeWorkerLabel = null }) {
  const isAIEmployeeMode = mode === 'ai_employee';
  const userStorageSuffix = user?.id || 'anon';
  const [input, setInput] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const [isTyping, setIsTyping] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [thinkingSteps, setThinkingSteps] = useState([]);
  const thinkingStepsRef = useRef([]);
  const thinkingAgentCountersRef = useRef({});
  const [domainContext, setDomainContext] = useState(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [isUploadingDataset, setIsUploadingDataset] = useState(false);
  const [isDragOverUpload, setIsDragOverUpload] = useState(false);
  const [uploadStatusText, setUploadStatusText] = useState('');

  const clearThinkingSteps = useCallback(() => {
    thinkingStepsRef.current = [];
    thinkingAgentCountersRef.current = {};
    setThinkingSteps([]);
  }, []);

  const appendThinkingStep = useCallback((data) => {
    if (!data || typeof data === 'string' || !data.content) return;

    setThinkingSteps((prev) => {
      const last = prev[prev.length - 1];
      let next;
      if (
        data.type === 'preamble'
        && last?.step === data.step
        && last?.type === 'preamble'
        && (last?.agentKey || 'default') === (data?.agentKey || 'default')
      ) {
        next = [...prev.slice(0, -1), { ...last, ...data, content: last.content + data.content }];
      } else {
        next = [...prev, { ...data, timestamp: Date.now() }];
      }
      thinkingStepsRef.current = next;
      return next;
    });
  }, []);

  const appendAgentThinkingNote = useCallback((meta, content) => {
    const normalized = String(content || '').trim();
    if (!normalized) return;
    const key = meta?.agentKey || 'default';
    const nextStep = (thinkingAgentCountersRef.current[key] || 0) + 1;
    thinkingAgentCountersRef.current[key] = nextStep;
    appendThinkingStep({
      step: nextStep,
      type: 'summary',
      content: normalized,
      ...meta,
    });
  }, [appendThinkingStep]);

  const buildThinkingTraceMessage = useCallback(() => {
    const steps = (thinkingStepsRef.current || [])
      .map((step) => ({
        ...step,
        content: typeof step?.content === 'string' ? step.content.trim() : '',
      }))
      .filter((step) => step.content);

    if (steps.length === 0) return null;

    return {
      role: 'ai',
      type: 'thinking_trace_card',
      payload: {
        steps,
        completed: true,
        defaultCollapsed: true,
      },
      timestamp: new Date().toISOString(),
    };
  }, []);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem(`${SIDEBAR_COLLAPSED_KEY_PREFIX}${userStorageSuffix}`) === '1';
    } catch {
      return false;
    }
  });
  const [splitRatio, setSplitRatio] = useState(() => {
    try {
      return clampSplitRatio(localStorage.getItem(`${CANVAS_SPLIT_RATIO_KEY_PREFIX}${userStorageSuffix}`) ?? 0.5);
    } catch {
      return 0.5;
    }
  });

  const [isCanvasDetached, setIsCanvasDetached] = useState(false);
  const [isNegotiationGenerating, setIsNegotiationGenerating] = useState(false);

  // ── Agent Execution Dashboard state ──────────────────────────────────────
  const [agentExecEvents, setAgentExecEvents] = useState([]);
  const [agentExecLoopState, setAgentExecLoopState] = useState(null);
  const [agentExecTaskTitle, setAgentExecTaskTitle] = useState('');
  const [agentExecPanelOpen, setAgentExecPanelOpen] = useState(false);
  const [agentExecSSETaskId, setAgentExecSSETaskId] = useState(null);
  const ralphAbortRef = useRef(null); // AbortController for Ralph Loop cancellation
  const agentExecEventsRef = useRef([]); // Mirror of agentExecEvents for use in event handlers
  const [aiEmployeeDrawer, setAiEmployeeDrawer] = useState(null);
  const [delegatedWorker, setDelegatedWorker] = useState(null);

  // ── Data Learning: profile + insights ─────────────────────────────────
  const [dataProfileDigest, setDataProfileDigest] = useState(null);
  const [dataInsights, setDataInsights] = useState(null);

  // Keep refs in sync with state — but never overwrite if ref is ahead (EventBus writes ref directly)
  useEffect(() => {
    if (agentExecEvents.length >= agentExecEventsRef.current.length) {
      agentExecEventsRef.current = agentExecEvents;
    }
  }, [agentExecEvents]);
  const agentExecTaskTitleRef = useRef('');
  useEffect(() => { agentExecTaskTitleRef.current = agentExecTaskTitle; }, [agentExecTaskTitle]);

  // SSE connection for real-time agent step events (supplements onStepComplete callbacks)
  const agentSSE = useAgentSSE(agentExecSSETaskId, {
    enabled: agentExecPanelOpen && !!agentExecSSETaskId,
    onStepEvent: (stepEvent) => {
      // Deduplicate against ref: skip if EventBus already recorded this step as completed
      const alreadyCompleted = agentExecEventsRef.current.some(e =>
        e.status === 'succeeded' && (e.step_name === stepEvent.step_name || e.step_index === stepEvent.step_index)
      );
      if (alreadyCompleted && stepEvent.status === 'succeeded') return;

      // Pipe SSE step events into the panel's event list (update existing or append)
      setAgentExecEvents(prev => {
        const idx = prev.findIndex(e => e.step_name === stepEvent.step_name);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = { ...updated[idx], ...stepEvent };
          return updated;
        }
        // Also check by step_index
        const idxByIndex = prev.findIndex(e => e.step_index != null && e.step_index === stepEvent.step_index);
        if (idxByIndex >= 0) {
          const updated = [...prev];
          updated[idxByIndex] = { ...updated[idxByIndex], ...stepEvent };
          return updated;
        }
        return [...prev, stepEvent];
      });
      // Update loop state: mark step as running/succeeded/failed
      setAgentExecLoopState(prevLoop => {
        if (!prevLoop?.steps) return prevLoop;
        const updatedSteps = prevLoop.steps.map(s => {
          if (s.name === stepEvent.step_name) {
            return {
              ...s,
              status: stepEvent.status || s.status,
              error: stepEvent.error || s.error,
              started_at: s.started_at || new Date().toISOString(),
              finished_at: ['succeeded', 'blocked', 'failed'].includes(stepEvent.status) ? new Date().toISOString() : s.finished_at,
              artifact_refs: stepEvent.artifacts || s.artifact_refs,
            };
          }
          return s;
        });
        return { ...prevLoop, steps: updatedSteps };
      });
    },
    onLoopDone: (data) => {
      appendMessagesToCurrentConversation([{
        role: 'ai',
        content: `All ${data.steps_completed || '?'}/${data.steps_total || '?'} step(s) completed on server. Data processed in-memory — no JSON round-trips.`,
        timestamp: new Date().toISOString(),
      }]);
    },
  });

  const alertMonitorRef = useRef(null);
  const chatAbortRef = useRef(null);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const topologyAutoLoadRef = useRef({});
  const prevAICanvasOpenRef = useRef(false);
  const prevAIExecOpenRef = useRef(false);

  // Abort any in-flight chat streaming on unmount
  useEffect(() => {
    return () => { chatAbortRef.current?.abort(); };
  }, []);

  // Stop generation handler — aborts current LLM call, keeps partial response
  const handleStopGeneration = useCallback(() => {
    chatAbortRef.current?.abort();
    chatAbortRef.current = null;
    setIsTyping(false);
  }, []);

  // Stable ref for canvas state updater used by useConversationManager
  const canvasStateByConversationRef = useRef(null);

  const sidebarCollapseStorageKey = useMemo(
    () => `${SIDEBAR_COLLAPSED_KEY_PREFIX}${user?.id || 'anon'}`,
    [user?.id]
  );
  const splitRatioStorageKey = useMemo(
    () => `${CANVAS_SPLIT_RATIO_KEY_PREFIX}${user?.id || 'anon'}`,
    [user?.id]
  );

  const resolveDelegatedWorker = useCallback(async () => {
    if (!user?.id) return null;
    if (activeWorkerId) {
      const selectedWorker = await getEmployee(activeWorkerId).catch(() => null);
      if (selectedWorker) return selectedWorker;
    }
    return getOrCreateWorker(user.id);
  }, [activeWorkerId, user?.id]);

  const getAssignedWorker = useCallback(async () => {
    if (delegatedWorker && (!activeWorkerId || delegatedWorker.id === activeWorkerId)) {
      return delegatedWorker;
    }
    const resolved = await resolveDelegatedWorker();
    if (resolved) setDelegatedWorker(resolved);
    return resolved;
  }, [delegatedWorker, activeWorkerId, resolveDelegatedWorker]);

  // ── Canvas state updater ────────────────────────────────────────────────
  const updateCanvasState = useCallback((conversationId, updater) => {
    if (!conversationId) return;
    const setter = canvasStateByConversationRef.current;
    if (!setter) return;
    setter((prev) => {
      const existing = prev[conversationId] || createDefaultCanvasState();
      const nextValue = typeof updater === 'function' ? updater(existing) : { ...existing, ...(updater || {}) };
      return {
        ...prev,
        [conversationId]: nextValue
      };
    });
  }, []);

  useEffect(() => {
    if (!isAIEmployeeMode || !user?.id) {
      setDelegatedWorker(null);
      return undefined;
    }

    let cancelled = false;

    resolveDelegatedWorker()
      .then((worker) => {
        if (!cancelled) setDelegatedWorker(worker);
      })
      .catch(() => {
        if (!cancelled) setDelegatedWorker(null);
      });

    return () => { cancelled = true; };
  }, [isAIEmployeeMode, user?.id, resolveDelegatedWorker]);

  // ── Conversation manager hook ──────────────────────────────────────────
  const convManager = useConversationManager({
    user,
    addNotification,
    updateCanvasState,
    mode,
  });

  // Wire the ref so updateCanvasState can access the setter
  canvasStateByConversationRef.current = convManager.setCanvasStateByConversation;

  const {
    conversations,
    setConversations,
    isConversationsLoading,
    conversationSearch,
    setConversationSearch,
    currentConversationId,
    setCurrentConversationId,
    showNewChatConfirm,
    setShowNewChatConfirm,
    conversationDatasetContext,
    setConversationDatasetContext,
    currentConversation,
    currentMessages,
    activeDatasetContext,
    activeCanvasState,
    appendMessagesToCurrentConversation,
    handleNewConversation,
    handleDeleteConversation,
  } = convManager;

  const currentConversationThinkingMode = currentConversationId
    ? (conversationDatasetContext[currentConversationId]?.manual_thinking_mode || null)
    : null;
  const isThinkingToggleEnabled = currentConversationThinkingMode === 'full';

  const handleToggleThinkingEnabled = useCallback(() => {
    if (!currentConversationId) return;
    setConversationDatasetContext((prev) => {
      const currentMode = prev[currentConversationId]?.manual_thinking_mode;
      return {
        ...prev,
        [currentConversationId]: {
          ...(prev[currentConversationId] || {}),
          manual_thinking_mode: currentMode === 'full' ? null : 'full',
        },
      };
    });
  }, [currentConversationId, setConversationDatasetContext]);

  const getDatasetProfileId = useCallback((datasetContext) => {
    const numericId = Number(datasetContext?.dataset_profile_id);
    return Number.isFinite(numericId) ? numericId : null;
  }, []);

  const buildTaskInputData = useCallback((datasetContext, attachments = []) => {
    const datasetProfileId = getDatasetProfileId(datasetContext);
    const rawRows = datasetProfileId != null
      ? (_rawRowsCache.get(String(datasetProfileId)) || datasetContext?.rawRowsForStorage)
      : null;

    const inputData = {
      userId: user?.id,
      datasetProfileId,
    };

    if (Array.isArray(rawRows) && rawRows.length > 0) {
      const sheetMap = {};
      rawRows.forEach((row) => {
        const sheetName = row.__sheet_name || 'Sheet1';
        if (!sheetMap[sheetName]) sheetMap[sheetName] = [];
        const clean = {};
        Object.entries(row).forEach(([key, value]) => {
          if (key !== '__rowNum' && key !== '__sheet_name') clean[key] = value;
        });
        sheetMap[sheetName].push(clean);
      });
      inputData.sheets = sheetMap;
      inputData.totalRows = rawRows.length;
    }

    if (Array.isArray(attachments) && attachments.length > 0) {
      inputData.attachments = attachments;
    }

    return inputData;
  }, [getDatasetProfileId, user?.id]);

  const buildMessageWithAttachmentContext = useCallback((messageText, attachments = [], heading = 'Attached Files Context') => {
    const attachmentBlock = buildAttachmentPromptText(attachments, { heading, includeExcerpts: true, maxExcerptChars: 450 });
    if (!attachmentBlock) return messageText;
    if (!messageText) return attachmentBlock;
    return `${messageText}\n\n${attachmentBlock}`;
  }, []);

  // ── v2 Orchestrator event listeners → UI state updates ──────────────────
  useEffect(() => {
    const unsubs = [
      eventBus.on(EVENT_NAMES.AGENT_STEP_STARTED, ({ stepIndex, stepName }) => {
        setAgentExecEvents(prev => [...prev, { step_name: stepName, status: 'running', step_index: stepIndex }]);
        setAgentExecLoopState(prev => {
          if (!prev?.steps) return prev;
          const steps = prev.steps.map((s, i) => i === stepIndex ? { ...s, status: 'running', started_at: new Date().toISOString() } : s);
          return { ...prev, steps };
        });
      }),
      eventBus.on(EVENT_NAMES.AGENT_STEP_COMPLETED, ({ stepIndex, stepName, artifacts, code, code_language, stdout, stderr }) => {
        // Deduplicate: skip if this step was already completed (by index OR name)
        const isDup = agentExecEventsRef.current.some(e =>
          e.status === 'succeeded' && (e.step_index === stepIndex || (stepName && e.step_name === stepName))
        );
        if (isDup) return;

        const newEvent = { step_name: stepName, status: 'succeeded', step_index: stepIndex, artifacts, code, code_language, stdout, stderr };
        agentExecEventsRef.current = [...agentExecEventsRef.current, newEvent]; // Sync ref immediately
        setAgentExecEvents(prev => {
          if (prev.some(e => e.status === 'succeeded' && (e.step_index === stepIndex || (stepName && e.step_name === stepName)))) return prev;
          return [...prev, newEvent];
        });
        setAgentExecLoopState(prev => {
          if (!prev?.steps) return prev;
          const steps = prev.steps.map((s, i) => i === stepIndex ? { ...s, status: 'succeeded', finished_at: new Date().toISOString() } : s);
          return { ...prev, steps };
        });
        if (stepName) {
          appendMessagesToCurrentConversation([{ role: 'ai', content: `Step "${stepName}": completed`, timestamp: new Date().toISOString() }]);
        }
      }),
      eventBus.on(EVENT_NAMES.AGENT_STEP_FAILED, ({ stepIndex, stepName, error, healing, willRetry }) => {
        if (!willRetry) {
          const failEvent = { step_name: stepName || `Step ${stepIndex}`, status: 'failed', step_index: stepIndex, error };
          agentExecEventsRef.current = [...agentExecEventsRef.current, failEvent];
        }
        const note = willRetry ? ` [retrying: ${healing?.healingStrategy}]` : '';
        setAgentExecLoopState(prev => {
          if (!prev?.steps) return prev;
          const steps = prev.steps.map((s, i) => i === stepIndex ? { ...s, status: willRetry ? 'retrying' : 'failed' } : s);
          return { ...prev, steps };
        });
        appendMessagesToCurrentConversation([{ role: 'ai', content: `Step ${stepIndex} failed: ${error?.slice(0, 200)}${note}`, timestamp: new Date().toISOString() }]);
      }),
      eventBus.on(EVENT_NAMES.AGENT_STEP_DIAGNOSED, ({ taskId, stepIndex, diagnosis }) => {
        if (diagnosis) {
          appendMessagesToCurrentConversation([{
            role: 'ai',
            type: 'error_diagnosis_card',
            payload: diagnosis,
            timestamp: new Date().toISOString(),
          }]);
        }
      }),
      eventBus.on(EVENT_NAMES.AGENT_STEP_BLOCKED, ({ stepIndex, stepName, reason, message: msg }) => {
        setAgentExecLoopState(prev => {
          if (!prev?.steps) return prev;
          const steps = prev.steps.map((s, i) => i === stepIndex ? { ...s, status: 'blocked' } : s);
          return { ...prev, steps };
        });
        appendMessagesToCurrentConversation([{
          role: 'ai',
          content: `Step "${stepName || stepIndex}" blocked: ${msg || reason || 'Requires user action'}`,
          timestamp: new Date().toISOString(),
        }]);
      }),
      eventBus.on(EVENT_NAMES.TASK_COMPLETED, ({ taskId } = {}) => {
        // Build result summary from collected step events
        // Deduplicate by BOTH step_name AND step_index (SSE vs EventBus may use different keys)
        const stepEvents = agentExecEventsRef.current || [];
        const seenNames = new Set();
        const seenIndexes = new Set();
        const completedSteps = stepEvents
          .filter(e => e.status === 'succeeded' || e.status === 'failed')
          .filter(e => {
            const name = e.step_name;
            const idx = e.step_index;
            // Skip if we've seen this exact name OR this exact index
            if (name && seenNames.has(name)) return false;
            if (idx != null && seenIndexes.has(idx)) return false;
            if (name) seenNames.add(name);
            if (idx != null) seenIndexes.add(idx);
            return true;
          });

        if (completedSteps.length > 0) {
          appendMessagesToCurrentConversation([{
            role: 'ai',
            type: 'task_result_summary',
            payload: {
              taskId,
              taskTitle: agentExecTaskTitleRef.current || '',
              steps: completedSteps,
            },
            timestamp: new Date().toISOString(),
          }]);
        } else {
          appendMessagesToCurrentConversation([{
            role: 'ai',
            content: 'All steps completed. You can view detailed results in the Review page.',
            timestamp: new Date().toISOString(),
          }]);
        }
      }),
      eventBus.on(EVENT_NAMES.TASK_FAILED, ({ error }) => {
        appendMessagesToCurrentConversation([{ role: 'ai', content: `Task failed: ${error || 'Unknown error'}`, timestamp: new Date().toISOString() }]);
      }),
    ];
    return () => unsubs.forEach(unsub => unsub());
  }, [appendMessagesToCurrentConversation]);

  // ── Synthetic ERP Sandbox → Planning bridge ────────────────────────────
  const location = useLocation();
  const synthInjectedRef = useRef(null);

  useEffect(() => {
    const synth = location.state?.syntheticDataset;
    if (!synth || !currentConversationId) return;
    // Prevent re-injection on same dataset
    if (synthInjectedRef.current === synth.descriptor?.dataset_id) return;
    synthInjectedRef.current = synth.descriptor?.dataset_id;

    // Build rawRows with __sheet_name markers (same format as file upload)
    const rawRows = [];
    for (const [sheetName, rows] of Object.entries(synth.sheets || {})) {
      rows.forEach(row => rawRows.push({ ...row, __sheet_name: sheetName }));
    }

    const profileId = `local-synth-${synth.descriptor?.dataset_id || 'unknown'}`;
    _rawRowsCache.set(profileId, rawRows);

    setConversationDatasetContext(prev => ({
      ...prev,
      [currentConversationId]: {
        dataset_profile_id: profileId,
        dataset_fingerprint: synth.descriptor?.dataset_id || null,
        user_file_id: null,
        profileJson: synth.profile_json || {},
        contractJson: synth.contract_json || {},
        rawRowsForStorage: rawRows,
        contractConfirmed: true,
        fileName: `synthetic-${synth.descriptor?.dataset_id || 'dataset'}.xlsx`,
        minimalQuestions: [],
        reuse_enabled: true,
      },
    }));

    const desc = synth.descriptor || {};
    const autoRun = location.state?.autoRun;
    const autoRunHint = autoRun === 'forecast'
      ? ' Auto-running demand forecast...'
      : autoRun === 'risk'
        ? ' Auto-running risk analysis...'
        : '';

    appendMessagesToCurrentConversation([{
      role: 'ai',
      content: `Synthetic dataset **${desc.dataset_id || 'unknown'}** loaded (${desc.n_materials || '?'} materials, ${desc.n_plants || '?'} plants, ${desc.n_days || '?'} days).${autoRunHint || ' You can now run /forecast, /plan, or /workflowa.'}`,
      timestamp: new Date().toISOString(),
    }]);

    // Auto-trigger workflow if handoff specified an intent
    if (autoRun === 'forecast') {
      setTimeout(() => {
        appendMessagesToCurrentConversation([{
          role: 'user',
          content: 'Run demand forecast on this synthetic dataset',
          timestamp: new Date().toISOString(),
        }]);
      }, 500);
    } else if (autoRun === 'risk') {
      setTimeout(() => {
        appendMessagesToCurrentConversation([{
          role: 'user',
          content: 'Run risk analysis workflow on this synthetic dataset',
          timestamp: new Date().toISOString(),
        }]);
      }, 500);
    }

    // Clear navigation state to prevent re-trigger on route changes
    window.history.replaceState({}, '');
  }, [location.state, currentConversationId, setConversationDatasetContext, appendMessagesToCurrentConversation]);

  // SmartOps 2.0: Session context for stateful conversations
  const sessionCtx = useSessionContext(user?.id, currentConversationId);

  // ── Supabase connectivity pre-flight check ────────────────────────────
  useEffect(() => {
    if (!user?.id) return;
    (async () => {
      try {
        const t0 = performance.now();
        const { error } = await supabase.from('di_dataset_profiles').select('id').limit(0);
        const ms = Math.round(performance.now() - t0);
        if (error) {
          console.warn(`[DSV] Supabase health check FAILED (${ms}ms):`, error.message, error.code, error.hint);
          addNotification?.(`Database tables may be inaccessible: ${error.message}. Offline fallback active.`, 'warning');
        } else {
          console.info(`[DSV] Supabase health check OK (${ms}ms)`);
        }
      } catch (err) {
        console.warn('[DSV] Supabase health check error:', err?.message);
      }
    })();
  }, [user?.id, addNotification]);

  useEffect(() => {
    if (!user?.id) return;
    setContextLoading(true);
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('context_load_timeout')), 30000)
    );
    Promise.race([loadDomainContext(user.id, supabase), timeout])
      .then((ctx) => setDomainContext(ctx))
      .catch(() => setDomainContext(null))
      .finally(() => setContextLoading(false));
  }, [user?.id]);

  // Data Learning: fetch profile + load insights on mount (non-blocking)
  useEffect(() => {
    // Load accumulated insights
    import('../../services/dataInsightService.js').then(({ getInsights }) => {
      const all = getInsights();
      if (all.length > 0) setDataInsights(all);
    }).catch(() => {});

    // Load data profile
    import('../../services/dataLearningService.js').then(({ fetchDataProfile, getCachedProfile, buildProfileDigest }) => {
      const cached = getCachedProfile();
      if (cached) {
        setDataProfileDigest(buildProfileDigest(cached));
        console.info('[DSV] Data profile loaded from cache');
      }
      // Always try fresh fetch in background
      fetchDataProfile().then(profile => {
        if (profile) setDataProfileDigest(buildProfileDigest(profile));
      });
    }).catch(err => console.warn('[DSV] Data profile load skipped:', err.message));
  }, []);

  // SmartOps 2.0: Proactive alert monitor
  useEffect(() => {
    if (!user?.id || !isAlertMonitorEnabled()) return;

    const monitor = createAlertMonitor({
      userId: user.id,
      loadRiskState: async (_userId) => {
        const ctx = domainContext || {};
        return {
          riskScores: ctx.riskItems || [],
          stockoutData: (ctx.riskItems || []).map((r) => ({
            material_code: r.material_code,
            plant_id: r.plant_id,
            p_stockout: r.p_stockout ?? 0,
            impact_usd: r.impact_usd ?? 0,
            days_to_stockout: r.days_to_stockout ?? Infinity,
          })),
        };
      },
      onAlertsBatch: (alertPayload) => {
        if (!currentConversationId) return;
        const dismissed = new Set(sessionCtx.context?.active_alerts?.dismissed_ids || []);
        const filtered = {
          ...alertPayload,
          alerts: alertPayload.alerts.filter((a) => !dismissed.has(a.alert_id)),
        };
        if (filtered.alerts.length === 0) return;
        appendMessagesToCurrentConversation([buildAlertChatMessage(filtered)]);
      },
    });

    alertMonitorRef.current = monitor;
    monitor.start();

    return () => monitor.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, currentConversationId, domainContext]);

  // ── Derived state from messages ─────────────────────────────────────────
  const forecastSeriesGroups = useMemo(() => {
    const msgs = currentMessages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m?.type !== 'forecast_result_card') continue;
      const p = m.payload || {};
      const fromDirect = Array.isArray(p.series_groups) && p.series_groups.length > 0 ? p.series_groups : null;
      const fromJson = Array.isArray(p.forecast_series_json?.groups) && p.forecast_series_json.groups.length > 0
        ? p.forecast_series_json.groups : null;
      const groups = fromDirect || fromJson || [];
      if (groups.length > 0) return groups;
    }
    return [];
  }, [currentMessages]);

  const derivedChartPayloadFromMessages = useMemo(() => {
    const seed = {
      actual_vs_forecast: [],
      inventory_projection: [],
      cost_breakdown: [],
      topology_graph: null
    };

    (currentMessages || []).forEach((message) => {
      if (!message?.type) return;
      const patch = deriveCanvasChartPatchFromCard(message.type, message.payload || {});
      if (!patch) return;
      if (Array.isArray(patch.actual_vs_forecast) && patch.actual_vs_forecast.length > 0) {
        seed.actual_vs_forecast = patch.actual_vs_forecast;
      }
      if (Array.isArray(patch.inventory_projection) && patch.inventory_projection.length > 0) {
        seed.inventory_projection = patch.inventory_projection;
      }
      if (Array.isArray(patch.cost_breakdown) && patch.cost_breakdown.length > 0) {
        seed.cost_breakdown = patch.cost_breakdown;
      }
      if (patch.topology_graph && typeof patch.topology_graph === 'object') {
        seed.topology_graph = patch.topology_graph;
      }
    });

    return seed;
  }, [currentMessages]);

  const effectiveCanvasChartPayload = useMemo(() => {
    const live = activeCanvasState?.chartPayload || {};
    const toArray = (value) => (Array.isArray(value) ? value : []);
    const liveActual = toArray(live.actual_vs_forecast);
    const liveInventory = toArray(live.inventory_projection);
    const liveCost = toArray(live.cost_breakdown);
    const liveTopology = live.topology_graph && typeof live.topology_graph === 'object' ? live.topology_graph : null;
    const liveGroups = toArray(live.series_groups);
    const derivedGroups = toArray(derivedChartPayloadFromMessages.series_groups);
    return {
      actual_vs_forecast: liveActual.length > 0 ? liveActual : derivedChartPayloadFromMessages.actual_vs_forecast,
      series_groups: liveGroups.length > 0 ? liveGroups : derivedGroups,
      inventory_projection: liveInventory.length > 0 ? liveInventory : derivedChartPayloadFromMessages.inventory_projection,
      cost_breakdown: liveCost.length > 0 ? liveCost : derivedChartPayloadFromMessages.cost_breakdown,
      topology_graph: liveTopology || derivedChartPayloadFromMessages.topology_graph || null
    };
  }, [activeCanvasState?.chartPayload, derivedChartPayloadFromMessages]);

  const topologyRunId = useMemo(() => {
    const rawGraphRunId = effectiveCanvasChartPayload?.topology_graph?.run_id
      || effectiveCanvasChartPayload?.topology_graph?.runId;
    const graphRunId = toPositiveRunId(rawGraphRunId);
    if (graphRunId) return graphRunId;
    const workflowRunId = findLatestWorkflowRunIdFromMessages(currentMessages);
    if (workflowRunId) return workflowRunId;
    const canvasRunId = toPositiveRunId(activeCanvasState?.run?.id || activeCanvasState?.run?.run_id);
    if (canvasRunId) return canvasRunId;
    const fallbackRunId = findLatestRunIdFromMessages(currentMessages);
    return fallbackRunId || null;
  }, [effectiveCanvasChartPayload?.topology_graph, currentMessages, activeCanvasState?.run]);

  // ── UI handlers ─────────────────────────────────────────────────────────
  const handleSidebarToggle = useCallback(() => {
    setIsSidebarCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem(sidebarCollapseStorageKey, next ? '1' : '0'); } catch { /* noop */ }
      return next;
    });
  }, [sidebarCollapseStorageKey]);

  const handleExpandSidebar = useCallback(() => {
    setIsSidebarCollapsed(false);
    try { localStorage.setItem(sidebarCollapseStorageKey, '0'); } catch { /* noop */ }
  }, [sidebarCollapseStorageKey]);

  const handleCloseSidebar = useCallback(() => {
    setIsSidebarCollapsed(true);
    try { localStorage.setItem(sidebarCollapseStorageKey, '1'); } catch { /* noop */ }
  }, [sidebarCollapseStorageKey]);

  const handleSplitRatioCommit = useCallback((nextRatio) => {
    const clamped = clampSplitRatio(nextRatio);
    setSplitRatio(clamped);
    try { localStorage.setItem(splitRatioStorageKey, String(clamped)); } catch { /* noop */ }
  }, [splitRatioStorageKey]);

  const openAIEmployeeProfile = useCallback(() => {
    setAiEmployeeDrawer('profile');
  }, []);

  const closeAIEmployeeProfile = useCallback(() => {
    setAiEmployeeDrawer((current) => (current === 'profile' ? null : current));
  }, []);

  const openAIEmployeeExecution = useCallback(() => {
    if (agentExecLoopState?.steps?.length || agentExecEvents.length > 0) {
      setAgentExecPanelOpen(true);
      setAiEmployeeDrawer('execution');
    }
  }, [agentExecEvents.length, agentExecLoopState]);

  const closeAIEmployeeExecution = useCallback(() => {
    setAgentExecPanelOpen(false);
    setAgentExecSSETaskId(null);
    setAiEmployeeDrawer((current) => (current === 'execution' ? null : current));
  }, []);

  const openAIEmployeeArtifacts = useCallback(() => {
    if (!currentConversationId) return;
    updateCanvasState(currentConversationId, (prev) => ({ ...prev, isOpen: true }));
    setAiEmployeeDrawer('artifacts');
  }, [currentConversationId, updateCanvasState]);

  const closeAIEmployeeArtifacts = useCallback(() => {
    if (currentConversationId) {
      updateCanvasState(currentConversationId, (prev) => ({ ...prev, isOpen: false }));
    }
    setAiEmployeeDrawer((current) => (current === 'artifacts' ? null : current));
  }, [currentConversationId, updateCanvasState]);

  const dismissAIEmployeeOverlays = useCallback(() => {
    handleCloseSidebar();
    if (aiEmployeeDrawer === 'profile') {
      closeAIEmployeeProfile();
    } else if (aiEmployeeDrawer === 'artifacts') {
      closeAIEmployeeArtifacts();
    } else if (aiEmployeeDrawer === 'execution') {
      closeAIEmployeeExecution();
    }
  }, [
    aiEmployeeDrawer,
    closeAIEmployeeArtifacts,
    closeAIEmployeeExecution,
    closeAIEmployeeProfile,
    handleCloseSidebar,
  ]);

  const handleSelectAIConversation = useCallback((conversationId) => {
    setCurrentConversationId(conversationId);
    handleCloseSidebar();
  }, [handleCloseSidebar, setCurrentConversationId]);

  const handleCanvasToggle = useCallback(() => {
    if (!currentConversationId) return;
    updateCanvasState(currentConversationId, (prev) => ({ ...prev, isOpen: !prev.isOpen }));
  }, [currentConversationId, updateCanvasState]);

  const systemPrompt = useMemo(() => {
    if (!domainContext) return '';
    return buildSystemPrompt(domainContext, activeDatasetContext, dataProfileDigest, dataInsights);
  }, [domainContext, activeDatasetContext, dataProfileDigest, dataInsights]);

  // ── Canvas run helpers ──────────────────────────────────────────────────
  const markCanvasRunStarted = useCallback((label) => {
    if (!currentConversationId) return;
    updateCanvasState(currentConversationId, (prev) => ({
      ...prev,
      isOpen: true,
      activeTab: 'logs',
      run: { ...(prev.run || {}), status: 'running', label, started_at: new Date().toISOString() },
      logs: [...(prev.logs || []), { id: `run_${Date.now()}`, step: 'profile', message: `✅ ${label} started`, timestamp: new Date().toISOString() }]
    }));
  }, [currentConversationId, updateCanvasState]);

  const markCanvasRunFinished = useCallback((status, message, step = 'report') => {
    if (!currentConversationId) return;
    updateCanvasState(currentConversationId, (prev) => ({
      ...prev,
      run: { ...(prev.run || {}), status },
      logs: message
        ? [...(prev.logs || []), { id: `${status}_${Date.now()}`, step, message, timestamp: new Date().toISOString() }]
        : (prev.logs || [])
    }));
  }, [currentConversationId, updateCanvasState]);

  // ── Profile resolution ──────────────────────────────────────────────────
  const resolveDatasetProfileRow = useCallback(async (profileId = null) => {
    if (!user?.id) return null;

    const profileIdStr = profileId != null ? String(profileId) : null;
    const isLocalId = profileIdStr && profileIdStr.startsWith('local-');
    const numericProfileId = Number.isFinite(Number(profileId)) ? Number(profileId) : null;
    const activeProfileIdRaw = activeDatasetContext?.dataset_profile_id;
    const activeProfileIdStr = activeProfileIdRaw != null ? String(activeProfileIdRaw) : null;
    const activeProfileId = Number.isFinite(Number(activeProfileIdRaw)) ? Number(activeProfileIdRaw) : null;
    const isActiveLocal = activeProfileIdStr && activeProfileIdStr.startsWith('local-');

    if (isLocalId && activeProfileIdStr === profileIdStr) {
      return {
        id: activeProfileIdStr, user_file_id: activeDatasetContext?.user_file_id || null,
        profile_json: activeDatasetContext?.profileJson || {}, contract_json: activeDatasetContext?.contractJson || {},
        _inlineRawRows: activeDatasetContext?.rawRowsForStorage || _rawRowsCache.get(activeProfileIdStr) || null, _local: true
      };
    }
    if (numericProfileId && activeProfileId && numericProfileId === activeProfileId) {
      return {
        id: activeProfileId, user_file_id: activeDatasetContext?.user_file_id || null,
        profile_json: activeDatasetContext?.profileJson || {}, contract_json: activeDatasetContext?.contractJson || {},
        _inlineRawRows: activeDatasetContext?.rawRowsForStorage || _rawRowsCache.get(activeProfileIdStr) || null
      };
    }
    if (numericProfileId) {
      const row = await datasetProfilesService.getDatasetProfileById(user.id, numericProfileId);
      if (row) {
        if (!row.user_file_id && numericProfileId === activeProfileId) {
          row._inlineRawRows = activeDatasetContext?.rawRowsForStorage || _rawRowsCache.get(activeProfileIdStr) || null;
        }
        return row;
      }
    }
    if (isActiveLocal) {
      return {
        id: activeProfileIdStr, user_file_id: activeDatasetContext?.user_file_id || null,
        profile_json: activeDatasetContext?.profileJson || {}, contract_json: activeDatasetContext?.contractJson || {},
        _inlineRawRows: activeDatasetContext?.rawRowsForStorage || _rawRowsCache.get(activeProfileIdStr) || null, _local: true
      };
    }
    if (activeProfileId) {
      return {
        id: activeProfileId, user_file_id: activeDatasetContext?.user_file_id || null,
        profile_json: activeDatasetContext?.profileJson || {}, contract_json: activeDatasetContext?.contractJson || {},
        _inlineRawRows: activeDatasetContext?.rawRowsForStorage || _rawRowsCache.get(activeProfileIdStr) || null
      };
    }
    return datasetProfilesService.getLatestDatasetProfile(user.id);
  }, [user?.id, activeDatasetContext]);

  // ── Extracted executor hooks ────────────────────────────────────────────
  const forecastExec = useForecastExecutor({
    user, currentConversationId, activeDatasetContext,
    appendMessagesToCurrentConversation, addNotification, resolveDatasetProfileRow,
    markCanvasRunStarted, markCanvasRunFinished, updateCanvasState, setConversationDatasetContext,
  });

  const planExec = usePlanExecutor({
    user, currentConversationId, activeDatasetContext,
    appendMessagesToCurrentConversation, addNotification, resolveDatasetProfileRow,
    markCanvasRunStarted, markCanvasRunFinished, updateCanvasState, setDomainContext,
  });

  const workflowExec = useWorkflowExecutor({
    user, currentConversationId, activeDatasetContext,
    appendMessagesToCurrentConversation, addNotification, resolveDatasetProfileRow,
    markCanvasRunStarted, markCanvasRunFinished, updateCanvasState, setConversationDatasetContext,
  });

  // Destructure commonly used values from hooks
  const { executeForecastFlow } = forecastExec;
  const { executePlanFlow, executeRiskAwarePlanFlow, latestPlanRunId, setLatestPlanRunId } = planExec;
  const {
    executeWorkflowFlow, executeWorkflowAFlow, executeWorkflowBFlow, executeDigitalTwinFlow,
    handleResumeWorkflowA, handleBlockingQuestionsSubmit, handleSubmitBlockingAnswers,
    handleReplayWorkflowA, handleCancelAsyncWorkflow,
  } = workflowExec;

  // ── Topology auto-load effect ──────────────────────────────────────────
  const topologyRunStatus = useMemo(() => {
    if (!topologyRunId) return '';
    const snapshot = workflowExec.workflowSnapshots[topologyRunId] || workflowExec.workflowSnapshots[String(topologyRunId)] || null;
    return String(snapshot?.run?.status || '').toLowerCase();
  }, [topologyRunId, workflowExec.workflowSnapshots]);

  useEffect(() => {
    if (!currentConversationId) return;
    const targetRunId = Number(topologyRunId);
    if (!Number.isFinite(targetRunId)) return;

    const existingGraphRunId = Number(
      activeCanvasState?.chartPayload?.topology_graph?.run_id
      || activeCanvasState?.chartPayload?.topology_graph?.runId
    );
    if (Number.isFinite(existingGraphRunId) && existingGraphRunId === targetRunId) return;

    const cacheKey = `${currentConversationId}:${targetRunId}`;
    const cacheEntry = topologyAutoLoadRef.current[cacheKey] || { loaded: false, inFlight: false, lastAttemptAt: 0 };
    if (cacheEntry.loaded || cacheEntry.inFlight) return;
    if ((Date.now() - Number(cacheEntry.lastAttemptAt || 0)) < 2000) return;
    topologyAutoLoadRef.current[cacheKey] = { ...cacheEntry, inFlight: true, lastAttemptAt: Date.now() };

    let cancelled = false;
    loadTopologyGraphForRun({ runId: targetRunId })
      .then((loaded) => {
        const current = topologyAutoLoadRef.current[cacheKey] || {};
        if (cancelled || !loaded?.graph) {
          topologyAutoLoadRef.current[cacheKey] = { ...current, inFlight: false };
          return;
        }
        updateCanvasState(currentConversationId, (prev) => ({
          ...prev,
          chartPayload: { ...(prev.chartPayload || {}), topology_graph: loaded.graph }
        }));
        topologyAutoLoadRef.current[cacheKey] = { ...current, loaded: true, inFlight: false };
      })
      .catch(() => {
        const current = topologyAutoLoadRef.current[cacheKey] || {};
        topologyAutoLoadRef.current[cacheKey] = { ...current, inFlight: false };
      });

    return () => { cancelled = true; };
  }, [currentConversationId, topologyRunId, topologyRunStatus, activeCanvasState?.chartPayload?.topology_graph, updateCanvasState]);

  // ── Dataset context handler ─────────────────────────────────────────────
  const handleUseDatasetContextFromCard = useCallback((cardPayload) => {
    if (!currentConversationId || !cardPayload?.dataset_profile_id) return;
    setConversationDatasetContext((prev) => ({
      ...prev,
      [currentConversationId]: {
        ...(prev[currentConversationId] || {}),
        dataset_profile_id: cardPayload.dataset_profile_id,
        dataset_fingerprint: cardPayload.fingerprint || prev[currentConversationId]?.dataset_fingerprint || null,
        user_file_id: cardPayload.user_file_id || prev[currentConversationId]?.user_file_id || null,
        summary: cardPayload.context_summary || '',
        profileJson: cardPayload.profile_json || {},
        contractJson: cardPayload.contract_json || {},
        contractConfirmed: String(cardPayload?.contract_json?.validation?.status || '').toLowerCase() === 'pass',
        minimalQuestions: cardPayload.minimal_questions || [],
        reuse_enabled: prev[currentConversationId]?.reuse_enabled !== false,
        force_retrain: Boolean(prev[currentConversationId]?.force_retrain),
        reused_settings_template: prev[currentConversationId]?.reused_settings_template || null
      }
    }));
    appendMessagesToCurrentConversation([{
      role: 'ai', content: `Dataset context attached: profile #${cardPayload.dataset_profile_id}.`, timestamp: new Date().toISOString()
    }]);
    addNotification?.('Dataset context attached to this conversation.', 'success');
  }, [currentConversationId, appendMessagesToCurrentConversation, addNotification, setConversationDatasetContext]);

  // ── Contract confirmation handler ───────────────────────────────────────
  const handleContractConfirmation = useCallback(async ({ dataset_profile_id, selections, mapping_selections }) => {
    if (!currentConversationId) return;
    const ctx = conversationDatasetContext[currentConversationId];
    if (!ctx) return;

    const draftContract = applyContractOverrides(ctx.contractJson || {}, ctx.profileJson || {}, selections || {}, mapping_selections || {});
    const applied = applyContractTemplateToProfile({ profile_json: ctx.profileJson || {}, contract_template_json: draftContract, sheetsRaw: ctx.sheetsRaw || [] });
    const nextProfileJson = applied?.profile_json || (ctx.profileJson || {});
    const updatedContract = applied?.contract_json || draftContract;
    const validationPassed = applied?.validation_passed === true;
    const validationPayload = {
      status: validationPassed ? 'pass' : 'fail',
      reasons: Array.isArray(updatedContract?.validation?.reasons) && updatedContract.validation.reasons.length > 0
        ? updatedContract.validation.reasons
        : (validationPassed ? [] : ['One or more sheets failed required field coverage'])
    };

    let nextProfileId = dataset_profile_id || ctx.dataset_profile_id;
    let persistedProfile = null;
    try {
      if (user?.id && ctx.dataset_fingerprint && ctx.profileJson) {
        const hasExistingProfileId = Number.isFinite(Number(nextProfileId));
        const stored = hasExistingProfileId
          ? await datasetProfilesService.updateDatasetProfile(user.id, Number(nextProfileId), {
              user_file_id: ctx.user_file_id || null, fingerprint: ctx.dataset_fingerprint,
              profile_json: nextProfileJson, contract_json: updatedContract
            })
          : await datasetProfilesService.createDatasetProfile({
              user_id: user.id, user_file_id: ctx.user_file_id || null, fingerprint: ctx.dataset_fingerprint,
              profile_json: nextProfileJson, contract_json: updatedContract
            });
        persistedProfile = stored;
        nextProfileId = stored?.id || nextProfileId;
      }
    } catch { /* Best effort persistence */ }

    if (validationPassed && user?.id && ctx.dataset_fingerprint) {
      reuseMemoryService.upsertContractTemplate({
        user_id: user.id, fingerprint: ctx.dataset_fingerprint,
        workflow: getWorkflowFromProfile(nextProfileJson || {}), contract_json: updatedContract, quality_delta: -0.05
      }).catch((error) => { console.warn('[DecisionSupportView] Failed to update contract template after correction:', error.message); });

      if (persistedProfile?.id) {
        const signature = buildSignature(nextProfileJson || {}, updatedContract || {});
        reuseMemoryService.upsertDatasetSimilarityIndex({
          user_id: user.id, dataset_profile_id: persistedProfile.id, fingerprint: ctx.dataset_fingerprint, signature_json: signature
        }).catch((error) => { console.warn('[DecisionSupportView] Failed to persist similarity index after correction:', error.message); });
      }
    }

    const mergedProfileRow = persistedProfile
      ? { ...persistedProfile, profile_json: nextProfileJson, contract_json: updatedContract }
      : { id: nextProfileId || null, user_file_id: ctx.user_file_id || null, fingerprint: ctx.dataset_fingerprint || null, profile_json: nextProfileJson, contract_json: updatedContract };
    const summaryPayload = buildDataSummaryCardPayload(mergedProfileRow);

    setConversationDatasetContext((prev) => ({
      ...prev,
      [currentConversationId]: {
        ...(prev[currentConversationId] || {}),
        dataset_profile_id: nextProfileId,
        user_file_id: mergedProfileRow.user_file_id || prev[currentConversationId]?.user_file_id || null,
        profileJson: nextProfileJson, contractJson: updatedContract,
        summary: summaryPayload.context_summary || prev[currentConversationId]?.summary || '',
        validationPayload, contractOverrides: selections || {}, contractConfirmed: validationPassed,
        minimalQuestions: nextProfileJson?.global?.minimal_questions || [], pending_reuse_plan: null
      }
    }));

    appendMessagesToCurrentConversation([
      { role: 'ai', content: validationPassed ? 'Contract confirmed and saved for fingerprint-based reuse.' : 'Contract draft saved, but required mapping is still incomplete. Please fix missing fields before running execution.', timestamp: new Date().toISOString() },
      { role: 'ai', type: 'dataset_summary_card', payload: summaryPayload, timestamp: new Date().toISOString() },
      { role: 'ai', type: 'validation_card', payload: validationPayload, timestamp: new Date().toISOString() }
    ]);
    addNotification?.(validationPassed ? 'Contract confirmed.' : 'Contract saved but still has missing required mappings.', validationPassed ? 'success' : 'error');
  }, [conversationDatasetContext, currentConversationId, user?.id, appendMessagesToCurrentConversation, addNotification, setConversationDatasetContext]);

  // ── Reuse handlers ──────────────────────────────────────────────────────
  const handleApplyReuseSuggestion = useCallback(async (reusePayload) => {
    if (!user?.id || !currentConversationId) return;
    const ctx = conversationDatasetContext[currentConversationId];
    if (!ctx?.dataset_profile_id) return;
    const effectivePayload = reusePayload || ctx.pending_reuse_plan || null;
    if (!effectivePayload) return;

    try {
      const profileRow = await resolveDatasetProfileRow(ctx.dataset_profile_id);
      if (!profileRow?.id) return;

      let nextProfileJson = profileRow.profile_json || ctx.profileJson || {};
      let nextContractJson = profileRow.contract_json || ctx.contractJson || {};
      let validationPassed = nextContractJson?.validation?.status === 'pass';

      if (effectivePayload.contract_template_id) {
        const template = await reuseMemoryService.getContractTemplateById(user.id, effectivePayload.contract_template_id);
        if (template?.contract_json) {
          const applied = applyContractTemplateToProfile({ profile_json: nextProfileJson, contract_template_json: template.contract_json, sheetsRaw: ctx.sheetsRaw || [] });
          nextProfileJson = applied.profile_json;
          nextContractJson = applied.contract_json;
          validationPassed = applied.validation_passed === true;
          await datasetProfilesService.updateDatasetProfile(user.id, profileRow.id, { profile_json: nextProfileJson, contract_json: nextContractJson });
          reuseMemoryService.upsertContractTemplate({
            user_id: user.id, fingerprint: ctx.dataset_fingerprint || profileRow.fingerprint,
            workflow: getWorkflowFromProfile(nextProfileJson), contract_json: nextContractJson,
            quality_delta: validationPassed ? 0.08 : -0.03
          }).catch((error) => { console.warn('[DecisionSupportView] Failed to update contract template after reuse apply:', error.message); });
        }
      }

      let reusedSettingsTemplate = ctx.reused_settings_template || null;
      if (effectivePayload.settings_template_id) {
        const settingsTemplate = await reuseMemoryService.getRunSettingsTemplateById(user.id, effectivePayload.settings_template_id);
        if (settingsTemplate?.settings_json) {
          reusedSettingsTemplate = settingsTemplate.settings_json;
          reuseMemoryService.upsertRunSettingsTemplate({
            user_id: user.id, fingerprint: ctx.dataset_fingerprint || profileRow.fingerprint,
            workflow: getWorkflowFromProfile(nextProfileJson), settings_json: settingsTemplate.settings_json, quality_delta: 0.02
          }).catch((error) => { console.warn('[DecisionSupportView] Failed to update run settings template after reuse apply:', error.message); });
        }
      }

      const mergedProfileRow = { ...profileRow, profile_json: nextProfileJson, contract_json: nextContractJson };
      const mergedFingerprint = ctx.dataset_fingerprint || profileRow.fingerprint || null;
      if (mergedFingerprint) {
        reuseMemoryService.upsertDatasetSimilarityIndex({
          user_id: user.id, dataset_profile_id: profileRow.id, fingerprint: mergedFingerprint,
          signature_json: buildSignature(nextProfileJson, nextContractJson)
        }).catch((error) => { console.warn('[DecisionSupportView] Failed to refresh similarity index after reuse apply:', error.message); });
      }
      const cardPayload = buildDataSummaryCardPayload(mergedProfileRow);
      const validationPayload = buildValidationPayload(mergedProfileRow);

      setConversationDatasetContext((prev) => ({
        ...prev,
        [currentConversationId]: {
          ...(prev[currentConversationId] || {}),
          profileJson: nextProfileJson, contractJson: nextContractJson,
          summary: cardPayload.context_summary || '', validationPayload, contractConfirmed: validationPassed,
          pending_reuse_plan: null, reused_settings_template: reusedSettingsTemplate
        }
      }));

      appendMessagesToCurrentConversation([
        { role: 'ai', content: 'Reused contract + settings successfully.', timestamp: new Date().toISOString() },
        { role: 'ai', type: 'dataset_summary_card', payload: cardPayload, timestamp: new Date().toISOString() },
        { role: 'ai', type: 'validation_card', payload: validationPayload, timestamp: new Date().toISOString() }
      ]);
      addNotification?.('Reuse applied successfully.', 'success');
    } catch (error) {
      appendMessagesToCurrentConversation([{ role: 'ai', content: `Reuse apply failed: ${error.message}`, timestamp: new Date().toISOString() }]);
      addNotification?.(`Reuse apply failed: ${error.message}`, 'error');
    }
  }, [user?.id, currentConversationId, conversationDatasetContext, resolveDatasetProfileRow, appendMessagesToCurrentConversation, addNotification, setConversationDatasetContext]);

  const handleReviewReuseSuggestion = useCallback(() => {
    if (!currentConversationId) return;
    const ctx = conversationDatasetContext[currentConversationId] || {};
    const validationStatus = String(ctx?.validationPayload?.status || '').toLowerCase();
    setConversationDatasetContext((prev) => ({
      ...prev,
      [currentConversationId]: { ...(prev[currentConversationId] || {}), pending_reuse_plan: null, contractConfirmed: validationStatus === 'pass' }
    }));
    appendMessagesToCurrentConversation([{
      role: 'ai',
      content: validationStatus === 'pass' ? 'Reuse skipped. Continuing with current validated mapping draft.' : 'Reuse skipped. Current draft needs mapping review before execution.',
      timestamp: new Date().toISOString()
    }]);
  }, [currentConversationId, conversationDatasetContext, appendMessagesToCurrentConversation, setConversationDatasetContext]);

  // ── Constraint relax handler ────────────────────────────────────────────
  const handleRequestRelax = useCallback((optionId) => {
    if (!optionId) return;
    appendMessagesToCurrentConversation([{
      role: 'ai', content: `Constraint relaxation requested: option ${optionId}. Use the Negotiation panel to evaluate and apply this option.`, timestamp: new Date().toISOString()
    }]);
  }, [appendMessagesToCurrentConversation]);

  // ── Negotiation handlers ────────────────────────────────────────────────
  const handleGenerateNegotiationOptions = useCallback(async (cardPayload) => {
    if (!user?.id || !cardPayload?.planRunId) return;
    setIsNegotiationGenerating(true);

    try {
      const profileId = activeDatasetContext?.dataset_profile_id || cardPayload?.dataset_profile_id;
      if (!profileId) {
        appendMessagesToCurrentConversation([{ role: 'ai', content: 'No dataset profile is linked to this session. Please upload a dataset first, then rerun forecast + plan.', timestamp: new Date().toISOString() }]);
        return;
      }

      const resolvedProfileRow = await resolveDatasetProfileRow(profileId);
      if (!resolvedProfileRow?.id) {
        appendMessagesToCurrentConversation([{ role: 'ai', content: 'Could not resolve dataset profile. Re-upload the dataset and rerun forecast + plan.', timestamp: new Date().toISOString() }]);
        return;
      }

      const result = await runNegotiation({ userId: user.id, planRunId: cardPayload.planRunId, datasetProfileRow: resolvedProfileRow, forecastRunId: sessionCtx.lastForecastRunId, config: {}, bypassFeatureFlag: true });

      if (result.triggered && result.negotiation_options) {
        sessionCtx.updateNegotiation(result, cardPayload.planRunId);
        appendMessagesToCurrentConversation([{
          role: 'ai', type: 'negotiation_card',
          payload: { planRunId: cardPayload.planRunId, dataset_profile_id: profileId, trigger: result.trigger, negotiation_options: result.negotiation_options, negotiation_evaluation: result.negotiation_evaluation, negotiation_report: result.negotiation_report, round: sessionCtx.context?.negotiation?.round || 1 },
          timestamp: new Date().toISOString()
        }]);
      } else {
        appendMessagesToCurrentConversation([{ role: 'ai', content: `Negotiation analysis complete but no actionable options found${result.suppressed_reason ? ` (${result.suppressed_reason})` : ''}.`, timestamp: new Date().toISOString() }]);
      }
    } catch (err) {
      appendMessagesToCurrentConversation([{ role: 'ai', content: `Negotiation option generation failed: ${err.message}`, timestamp: new Date().toISOString() }]);
    } finally {
      setIsNegotiationGenerating(false);
    }
  }, [user?.id, activeDatasetContext, sessionCtx, appendMessagesToCurrentConversation, resolveDatasetProfileRow]);

  const handleApplyNegotiationOption = useCallback(async (option, _evalResult, _cardPayload) => {
    if (!user?.id || !option?.option_id) return;
    const optionId = option.option_id;
    const overrides = option.overrides || {};

    appendMessagesToCurrentConversation([{ role: 'ai', content: `Applying negotiation option ${optionId}: "${option.title}"...`, timestamp: new Date().toISOString() }]);
    sessionCtx.rotatePlan();

    try {
      const profileId = activeDatasetContext?.dataset_profile_id || _cardPayload?.dataset_profile_id;
      if (!profileId) {
        appendMessagesToCurrentConversation([{ role: 'ai', content: 'No dataset profile is linked to this session. Please upload a dataset first, then rerun forecast + plan before applying negotiation options.', timestamp: new Date().toISOString() }]);
        return;
      }

      const resolvedProfileRow = await resolveDatasetProfileRow(profileId);
      if (!resolvedProfileRow?.id) {
        appendMessagesToCurrentConversation([{ role: 'ai', content: 'Could not resolve dataset profile. Re-upload the dataset and rerun forecast + plan.', timestamp: new Date().toISOString() }]);
        return;
      }

      const constraintsOverride = overrides.constraints && Object.keys(overrides.constraints).length > 0 ? overrides.constraints : null;
      const objectiveOverride = overrides.objective && Object.keys(overrides.objective).length > 0 ? overrides.objective : null;

      const planResult = await runPlanFromDatasetProfile({ userId: user.id, datasetProfileRow: resolvedProfileRow, forecastRunId: sessionCtx.lastForecastRunId, constraintsOverride, objectiveOverride });

      sessionCtx.updatePlan(planResult);
      const newKpis = planResult?.solver_result?.kpis || {};
      sessionCtx.recordNegOptionApplied(optionId, planResult?.run?.id, newKpis);

      const summaryPayload = buildPlanSummaryCardPayload(planResult, resolvedProfileRow);
      const tablePayload = buildPlanTableCardPayload(planResult);
      const projectionPayload = buildInventoryProjectionCardPayload(planResult);
      const downloadsPayload = buildPlanDownloadsPayload(planResult);
      const comparison = handlePlanComparison(sessionCtx.context);
      const comparisonText = comparison ? buildComparisonSummaryText(comparison) : '';

      const messages = [
        ...(comparison ? [{ role: 'ai', type: 'plan_comparison_card', payload: comparison, content: comparisonText, timestamp: new Date().toISOString() }] : []),
        { role: 'ai', type: 'plan_summary_card', payload: summaryPayload, timestamp: new Date().toISOString() },
        { role: 'ai', type: 'plan_table_card', payload: tablePayload, timestamp: new Date().toISOString() },
        { role: 'ai', type: 'inventory_projection_card', payload: projectionPayload, timestamp: new Date().toISOString() },
        { role: 'ai', type: 'downloads_card', payload: downloadsPayload, timestamp: new Date().toISOString() },
      ];
      appendMessagesToCurrentConversation(messages);

      try {
        const newTrigger = await checkNegotiationTrigger(planResult?.run?.id);
        if (newTrigger) {
          const nextRound = (sessionCtx.context?.negotiation?.round || 1) + 1;
          appendMessagesToCurrentConversation([
            { role: 'ai', content: `Plan still has issues (${newTrigger}). Starting negotiation round ${nextRound}...`, timestamp: new Date().toISOString() },
            { role: 'ai', type: 'negotiation_card', payload: { planRunId: planResult?.run?.id, dataset_profile_id: profileId, trigger: newTrigger, negotiation_options: null, negotiation_evaluation: null, negotiation_report: null, round: nextRound }, timestamp: new Date().toISOString() },
          ]);
        } else {
          appendMessagesToCurrentConversation([{ role: 'ai', content: 'Negotiation option applied successfully. The new plan is feasible.', timestamp: new Date().toISOString() }]);
          sessionCtx.clearNegotiation();
        }
      } catch (checkErr) {
        console.warn('[DSV] Post-negotiation trigger check failed:', checkErr?.message);
      }

      addNotification?.(`Plan re-run #${planResult?.run?.id || ''} with option ${optionId} completed.`, 'success');
      if (planResult?.run?.id) setLatestPlanRunId(planResult.run.id);
    } catch (err) {
      appendMessagesToCurrentConversation([{ role: 'ai', content: `Failed to apply option ${optionId}: ${err.message}`, timestamp: new Date().toISOString() }]);
    }
  }, [user?.id, activeDatasetContext, sessionCtx, appendMessagesToCurrentConversation, addNotification, setLatestPlanRunId, resolveDatasetProfileRow]);

  // ── Negotiation Action handler (sent/copy/skip from NegotiationActionCard) ──
  const handleNegotiationAction = useCallback(async (action, details, cardPayload) => {
    const caseId = details?.negotiation_id || cardPayload?.negotiation_id || null;
    const draft = details?.draft || null;

    if (action === 'copy') {
      // Copy to clipboard — no outbound logging needed
      if (draft?.body) {
        try { await navigator.clipboard.writeText(draft.body); } catch { /* noop */ }
      }
      appendMessagesToCurrentConversation([{
        role: 'ai',
        content: 'Draft copied to clipboard.',
        timestamp: new Date().toISOString(),
      }]);
      return;
    }

    // For 'sent' and 'skip' — log the outbound action
    try {
      const { logOutboundAction } = await import('../../services/supplierCommunicationService.js');
      await logOutboundAction({
        caseId,
        channel: action === 'sent' ? 'manual' : 'skip',
        draft,
        action,
        userId: user?.id,
        metadata: {
          wasEdited: details?.wasEdited || false,
          round: cardPayload?.negotiation_state?.current_round || 0,
          roundName: cardPayload?.negotiation_state?.current_round_name || 'UNKNOWN',
          planRunId: details?.planRunId,
          trigger: details?.trigger,
        },
      });
    } catch (err) {
      console.warn('[DSV] Outbound action logging failed:', err?.message);
    }

    // Advance negotiation state
    if (action === 'sent') {
      appendMessagesToCurrentConversation([{
        role: 'ai',
        content: `Negotiation draft (${draft?.tone || 'standard'} tone) marked as sent. Action recorded.`,
        timestamp: new Date().toISOString(),
      }]);
    } else if (action === 'skip') {
      appendMessagesToCurrentConversation([{
        role: 'ai',
        content: 'Round skipped — hold action recorded.',
        timestamp: new Date().toISOString(),
      }]);
    }
  }, [user?.id, appendMessagesToCurrentConversation]);

  // ── Macro-Oracle handler ─────────────────────────────────────────────────
  const handleMacroOracleCheck = useCallback(async ({ demoScenario = 'semiconductor_fire' } = {}) => {
    try {
      const { fetchAllSignals } = await import('../../services/externalSignalAdapters.js');
      const { processExternalSignals } = await import('../../services/macroSignalService.js');

      const isLive = !demoScenario || demoScenario === 'live';
      const externalData = await fetchAllSignals({
        demoScenario: isLive ? null : demoScenario,
        enableLive: isLive,
        enableGdelt: false, // GDELT has connectivity issues; Reddit is primary live source
      });
      const { signals, supplierEvents } = processExternalSignals({
        commodityPrices: externalData.commodityPrices,
        geopoliticalEvents: externalData.geopoliticalEvents,
        currencyMoves: externalData.currencyMoves,
      });

      if (signals.length === 0) {
        appendMessagesToCurrentConversation([{
          role: 'ai', content: 'Macro-Oracle scan complete. No significant external signals detected.',
          timestamp: new Date().toISOString(),
        }]);
        return;
      }

      // Compute risk delta (inline — mirrors supplierEventConnectorService)
      const baseDeltas = { delivery_delay: 15, quality_alert: 20, capacity_change: 10, force_majeure: 40, shipment_status: 8, price_change: 5 };
      const sevMult = { low: 0.5, medium: 1.0, high: 1.5, critical: 2.0 };
      const baseRiskScore = 45;
      const totalDelta = supplierEvents.reduce((sum, e) => {
        const base = baseDeltas[e.event_type] || 10;
        return sum + Math.round(base * (sevMult[e.severity] || 1.0) * 10) / 10;
      }, 0);
      const newRiskScore = Math.min(200, baseRiskScore + totalDelta);

      // CFR assessment
      const { bucket } = computePositionBucket({ risk_score: newRiskScore });
      const supplierKpis = sessionCtx.context?.risk?.supplier_kpis || { on_time_rate: 0.72, defect_rate: 0.03 };
      const priors = computeSupplierTypePriors(supplierKpis);
      const adjustment = deriveSolverParamsFromStrategy({
        cfrActionProbs: { accept: 0.3, reject: 0.4, counter: 0.3 },
        supplierTypePriors: priors,
        positionBucket: bucket,
      });

      const isTrigger = newRiskScore > 60;

      // Build recommendations
      const recommendations = [];
      if (adjustment.dual_source_flag) {
        recommendations.push({ text: 'Activate dual-source procurement for affected materials', action_id: 'run_negotiation' });
      }
      recommendations.push({
        text: `Adjust safety stock alpha: 0.50 → ${(0.50 * adjustment.safety_stock_alpha_multiplier).toFixed(2)}`,
      });
      if (isTrigger) {
        recommendations.push({ text: 'Re-run planning solver with updated parameters', action_id: 'rerun_plan', button_label: 'Replan' });
      }

      // Build evidence chain
      const evidenceChain = [
        { artifact_type: 'macro_signal', label: `${signals.length} external signal(s) detected` },
        { artifact_type: 'supplier_event', label: `${supplierEvents.length} supplier event(s) generated` },
        { artifact_type: 'risk_delta', label: `Risk Δ+${totalDelta.toFixed(1)} (${baseRiskScore} → ${newRiskScore.toFixed(0)})` },
        { artifact_type: 'cfr_assessment', label: `Supplier: ${adjustment.supplier_assessment}, alpha ×${adjustment.safety_stock_alpha_multiplier}` },
      ];

      appendMessagesToCurrentConversation([{
        role: 'ai',
        type: 'macro_oracle_alert',
        payload: {
          title: externalData.geopoliticalEvents?.[0]?.description || `${signals.length} external disruption signal(s) detected`,
          signals: signals.map(s => ({
            description: s.description,
            severity: s.severity,
            commodity: s.commodity,
            region: s.region,
            signal_type: s.signal_type,
          })),
          risk_delta: { total_delta: totalDelta, base_score: baseRiskScore, new_score: Math.round(newRiskScore) },
          cfr_assessment: {
            supplier_assessment: adjustment.supplier_assessment,
            safety_stock_alpha_multiplier: adjustment.safety_stock_alpha_multiplier,
            stockout_penalty_multiplier: adjustment.stockout_penalty_multiplier,
            dual_source_flag: adjustment.dual_source_flag,
            confidence: adjustment.confidence,
          },
          recommendations,
          evidence_chain: evidenceChain,
          trigger_status: isTrigger ? 'triggered' : 'monitoring',
          source: externalData.source,
        },
        timestamp: new Date().toISOString(),
      }]);
    } catch (err) {
      appendMessagesToCurrentConversation([{
        role: 'ai', content: `Macro-Oracle check failed: ${err.message}`,
        timestamp: new Date().toISOString(),
      }]);
    }
  }, [appendMessagesToCurrentConversation, sessionCtx]);

  // ── Topology handler ────────────────────────────────────────────────────
  const handleRunTopology = useCallback(async (requestedRunId = null) => {
    if (!user?.id) { addNotification?.('Please sign in before running topology.', 'error'); return; }
    if (!currentConversationId) { addNotification?.('Please start a conversation first.', 'error'); return; }

    const explicitRunId = Number(requestedRunId);
    const fallbackRunId = findLatestWorkflowRunIdFromMessages(currentMessages);
    const runId = Number.isFinite(explicitRunId) ? explicitRunId : fallbackRunId;
    if (!Number.isFinite(runId)) {
      appendMessagesToCurrentConversation([{ role: 'ai', content: 'No workflow run id found for topology. Run Workflow A/B first or use `/topology <run_id>`.', timestamp: new Date().toISOString() }]);
      addNotification?.('No workflow run id available for topology.', 'warning');
      return;
    }

    updateCanvasState(currentConversationId, (prev) => ({
      ...prev, isOpen: true, activeTab: 'topology', topologyRunning: true,
      logs: [...(prev.logs || []), { id: `topology_start_${Date.now()}`, step: 'topology', message: `Running topology graph build for run #${runId}...`, timestamp: new Date().toISOString() }]
    }));

    try {
      const result = await generateTopologyGraphForRun({ userId: user.id, runId, scope: {}, forceRebuild: false, reuse: true, manageRunStep: true });
      if (!result?.graph) throw new Error('Topology graph payload is empty.');

      const noticeText = result.reused
        ? `Topology graph ready for run #${runId} (reused from run #${result.reused_from_run_id}).`
        : `Topology graph generated for run #${runId}.`;

      appendMessagesToCurrentConversation([
        { role: 'ai', content: noticeText, timestamp: new Date().toISOString() },
        { role: 'ai', type: 'topology_graph_card', payload: { run_id: runId, graph: result.graph, ref: result.ref || null, reused: Boolean(result.reused), reused_from_run_id: result.reused_from_run_id || null }, timestamp: new Date().toISOString() }
      ]);

      updateCanvasState(currentConversationId, (prev) => ({
        ...prev, activeTab: 'topology', topologyRunning: false,
        chartPayload: { ...(prev.chartPayload || {}), topology_graph: result.graph },
        logs: [...(prev.logs || []), { id: `topology_done_${Date.now()}`, step: 'topology', message: `✅ Topology graph ready for run #${runId}.`, timestamp: new Date().toISOString() }]
      }));
      addNotification?.(`Topology graph ready for run #${runId}.`, 'success');
    } catch (error) {
      updateCanvasState(currentConversationId, (prev) => ({
        ...prev, topologyRunning: false,
        logs: [...(prev.logs || []), { id: `topology_failed_${Date.now()}`, step: 'topology', message: `❌ Topology generation failed: ${error.message}`, timestamp: new Date().toISOString() }]
      }));
      appendMessagesToCurrentConversation([{ role: 'ai', content: `Topology generation failed: ${error.message}`, timestamp: new Date().toISOString() }]);
      addNotification?.(`Topology generation failed: ${error.message}`, 'error');
    }
  }, [user?.id, currentConversationId, currentMessages, updateCanvasState, appendMessagesToCurrentConversation, addNotification]);

  // ── Spreadsheet attachment ingestion ────────────────────────────────────
  const processSpreadsheetAttachments = useCallback(async (attachments) => {
    const files = (attachments || []).map((attachment) => attachment?.file).filter(Boolean);
    if (files.length === 0) return { datasetContext: activeDatasetContext, followUpMessages: [], attachments: [] };
    if (!user?.id) throw new Error('Please sign in before uploading files.');
    if (!currentConversationId) throw new Error('Please start a conversation first.');

    const totalBytes = files.reduce((sum, file) => sum + Number(file?.size || 0), 0);
    if (totalBytes > MAX_UPLOAD_BYTES) {
      throw new Error(MAX_UPLOAD_MESSAGE);
    }

    const displayFileName = files.length === 1
      ? files[0].name
      : `${files[0].name} + ${files.length - 1} more`;

    setIsUploadingDataset(true);
    setIsDragOverUpload(false);
    setUploadStatusText(isAIEmployeeMode ? 'Processing attachments...' : 'Profiling attached spreadsheets...');

    try {
      console.time('[DSV] upload:total');
      console.time('[DSV] upload:parse');
      const uploadPreparation = files.length > 1
        ? await prepareChatUploadFromFiles(files)
        : await prepareChatUploadFromFile(files[0]);
      console.timeEnd('[DSV] upload:parse');
      const datasetFingerprint = buildFingerprintFromUpload(uploadPreparation.sheetsRaw, uploadPreparation.mappingPlans);

      setUploadStatusText('Saving file...');
      let fileRecord = null;
      try {
        fileRecord = await userFilesService.saveFile(user.id, displayFileName, uploadPreparation.rawRowsForStorage);
        console.log('[DSV] upload:saveFile OK, id:', fileRecord?.id);
      } catch (err) { console.warn('[DSV] Raw file save skipped:', err?.message); }

      setUploadStatusText('Building profile...');
      console.time('[DSV] upload:createProfile');
      const PROFILE_TIMEOUT_MS = 20000;
      let profileRecord = await Promise.race([
        createDatasetProfileFromSheets({ userId: user.id, userFileId: fileRecord?.id || null, fileName: displayFileName, sheetsRaw: uploadPreparation.sheetsRaw, mappingPlans: uploadPreparation.mappingPlans, allowLLM: false }),
        new Promise((resolve) => setTimeout(() => { console.warn('[DSV] createProfile DB timed out, using local-only profile'); resolve(null); }, PROFILE_TIMEOUT_MS))
      ]);
      console.timeEnd('[DSV] upload:createProfile');

      if (!profileRecord) {
        const mappingPlanMap = new Map((uploadPreparation.mappingPlans || []).map((p) => [String(p.sheet_name || '').toLowerCase(), p]));
        profileRecord = {
          id: `local-${Date.now()}`, user_id: user.id, fingerprint: datasetFingerprint,
          profile_json: {
            file_name: displayFileName,
            global: { workflow_guess: { label: 'A', confidence: 0.5, reason: 'default (offline)' }, time_range_guess: { start: null, end: null }, minimal_questions: [] },
            sheets: (uploadPreparation.sheetsRaw || []).map((s) => {
              const plan = mappingPlanMap.get(String(s.sheet_name || '').toLowerCase()) || {};
              return { sheet_name: s.sheet_name, likely_role: plan.upload_type || 'unknown', confidence: plan.confidence || 0, original_headers: s.columns || [], normalized_headers: (s.columns || []).map((c) => String(c).trim().toLowerCase()), grain_guess: { keys: [], time_column: null, granularity: 'unknown' }, column_semantics: [], quality_checks: { type_issues: [], null_rate: {}, outlier_rate: {} }, notes: [] };
            })
          },
          contract_json: (() => {
            const sheetsRawMap = new Map((uploadPreparation.sheetsRaw || []).map((s) => [String(s.sheet_name || '').toLowerCase(), s]));
            const datasets = (uploadPreparation.mappingPlans || []).map((p) => {
              const uploadType = p.upload_type || 'unknown';
              const rawSheet = sheetsRawMap.get(String(p.sheet_name || '').toLowerCase()) || {};
              const columns = rawSheet.columns || [];
              const status = (uploadType && uploadType !== 'unknown') ? getRequiredMappingStatus({ uploadType, columns, columnMapping: p.mapping || {} }) : { coverage: 0, missingRequired: [], isComplete: false };
              return { sheet_name: p.sheet_name, upload_type: uploadType, mapping: p.mapping || {}, requiredCoverage: Number((status.coverage || 0).toFixed(3)), missing_required_fields: status.missingRequired || [], validation: { status: status.isComplete ? 'pass' : 'fail', reasons: status.isComplete ? [] : [`Missing required fields: ${(status.missingRequired || []).join(', ')}`] } };
            });
            const allPass = datasets.length > 0 && datasets.every((d) => d.validation.status === 'pass');
            return { datasets, validation: { status: allPass ? 'pass' : 'fail', reasons: allPass ? [] : ['One or more sheets failed required field coverage'] } };
          })(),
          created_at: new Date().toISOString(), _local: true, _inlineRawRows: uploadPreparation.rawRowsForStorage || []
        };
        registerLocalProfile(profileRecord);
      }

      if (profileRecord?.id && Array.isArray(uploadPreparation.rawRowsForStorage) && uploadPreparation.rawRowsForStorage.length > 0) {
        _rawRowsCache.set(String(profileRecord.id), uploadPreparation.rawRowsForStorage);
      }

      const reuseEnabledForConversation = conversationDatasetContext[currentConversationId]?.reuse_enabled !== false;
      const workflow = getWorkflowFromProfile(profileRecord?.profile_json || {});
      let reusePlan = { contract_template_id: null, settings_template_id: null, confidence: 0, mode: 'no_reuse', explanation: 'Reuse skipped.' };
      let autoReused = false;
      let reusedSettingsTemplate = null;

      if (reuseEnabledForConversation) {
        try {
          const [contractTemplates, settingsTemplates, similarityIndexRows] = await Promise.race([
            Promise.all([reuseMemoryService.getContractTemplates(user.id, workflow, 60), reuseMemoryService.getRunSettingsTemplates(user.id, workflow, 60), reuseMemoryService.getRecentSimilarityIndex(user.id, 120)]),
            new Promise((_, reject) => setTimeout(() => reject(new Error('reuse lookup timeout')), 15000))
          ]);
          reusePlan = buildReusePlan({ dataset_profile: profileRecord, contract_templates: contractTemplates, settings_templates: settingsTemplates, similarity_index_rows: similarityIndexRows });
        } catch (error) { console.warn('[DSV] Reuse lookup skipped:', error.message); }
      }

      try {
        if (reusePlan.mode === 'auto_apply' && reusePlan.contract_template_id) {
          const template = await Promise.race([reuseMemoryService.getContractTemplateById(user.id, reusePlan.contract_template_id), new Promise((_, reject) => setTimeout(() => reject(new Error('reuse apply timeout')), 15000))]);
          if (template?.contract_json) {
            const applied = applyContractTemplateToProfile({ profile_json: profileRecord?.profile_json || {}, contract_template_json: template.contract_json, sheetsRaw: uploadPreparation.sheetsRaw });
            const updated = await datasetProfilesService.updateDatasetProfile(user.id, profileRecord.id, { profile_json: applied.profile_json, contract_json: applied.contract_json });
            profileRecord = updated || { ...profileRecord, profile_json: applied.profile_json, contract_json: applied.contract_json };
            autoReused = true;
          }
        }
        if (reusePlan.mode === 'auto_apply' && reusePlan.settings_template_id) {
          const settingsTemplate = await Promise.race([reuseMemoryService.getRunSettingsTemplateById(user.id, reusePlan.settings_template_id), new Promise((_, reject) => setTimeout(() => reject(new Error('settings template timeout')), 15000))]);
          if (settingsTemplate?.settings_json) { reusedSettingsTemplate = settingsTemplate.settings_json; }
        }
      } catch (reuseApplyErr) { console.warn('[DSV] Reuse auto-apply skipped:', reuseApplyErr?.message); }

      // Populate local data cache for Data tab (offline fallback)
      if (profileRecord?._local) {
        const UPLOAD_TO_TABLE = { inventory_snapshots: 'inventory_snapshots', po_open_lines: 'po_open_lines', supplier_master: 'suppliers' };
        const contractDatasets = profileRecord?.contract_json?.datasets || [];
        const sheetsRawMap = new Map((uploadPreparation.sheetsRaw || []).map((s) => [String(s.sheet_name || '').toLowerCase(), s]));
        const allMaterialCodes = new Set();

        for (const dataset of contractDatasets) {
          const uploadType = dataset.upload_type;
          if (!uploadType || uploadType === 'unknown') continue;
          const rawSheet = sheetsRawMap.get(String(dataset.sheet_name || '').toLowerCase());
          if (!rawSheet?.rows?.length) continue;
          const mapping = dataset.mapping || {};
          const targetToSource = {};
          Object.entries(mapping).forEach(([src, tgt]) => { if (tgt) targetToSource[tgt] = src; });
          const matCol = targetToSource['material_code'];
          if (matCol) { rawSheet.rows.forEach((row) => { const val = row[matCol]; if (val != null && val !== '') allMaterialCodes.add(String(val)); }); }
          const tableKey = UPLOAD_TO_TABLE[uploadType];
          if (!tableKey || !TABLE_REGISTRY[tableKey]) continue;
          const mappedRows = rawSheet.rows.map((row, idx) => {
            const mapped = { id: `local-${idx}`, user_id: user.id };
            Object.entries(targetToSource).forEach(([targetField, sourceCol]) => { mapped[targetField] = row[sourceCol] ?? null; });
            if (uploadType === 'supplier_master') { mapped.contact_info = mapped.contact_person || mapped.phone || mapped.email || null; mapped.status = mapped.status || 'active'; }
            return mapped;
          });
          setLocalTableData(tableKey, mappedRows);
        }
        if (allMaterialCodes.size > 0) {
          const materialRows = Array.from(allMaterialCodes).map((code, idx) => ({ id: `local-mat-${idx}`, user_id: user.id, material_code: code, material_name: code, category: null, uom: null }));
          setLocalTableData('materials', materialRows);
        }
      }

      const cardPayload = buildDataSummaryCardPayload(profileRecord);
      const validationPayload = buildValidationPayload(profileRecord);
      const downloadsPayload = buildDownloadsPayload({ profileJson: profileRecord?.profile_json, contractJson: profileRecord?.contract_json, profileId: profileRecord?.id });
      const hasReusePrompt = reusePlan.mode === 'ask_one_click' && reusePlan.contract_template_id;
      const confirmationPayload = (autoReused || hasReusePrompt) ? null : buildConfirmationPayload(cardPayload, uploadPreparation.mappingPlans);
      const contractConfirmed = autoReused ? validationPayload.status === 'pass' : (hasReusePrompt ? false : (validationPayload.status === 'pass' && !confirmationPayload));
      const nextDatasetContext = {
        ...(conversationDatasetContext[currentConversationId] || {}),
        dataset_profile_id: profileRecord?.id,
        dataset_fingerprint: datasetFingerprint,
        user_file_id: fileRecord?.id || null,
        summary: cardPayload.context_summary || '',
        profileJson: profileRecord?.profile_json || {},
        contractJson: profileRecord?.contract_json || {},
        validationPayload,
        sheetsRaw: uploadPreparation.sheetsRaw,
        rawRowsForStorage: uploadPreparation.rawRowsForStorage || null,
        fileName: displayFileName,
        source_file_names: files.map((item) => item.name),
        contractConfirmed,
        minimalQuestions: cardPayload.minimal_questions || [],
        reuse_enabled: reuseEnabledForConversation,
        force_retrain: Boolean(conversationDatasetContext[currentConversationId]?.force_retrain),
        reused_settings_template: reusedSettingsTemplate,
        pending_reuse_plan: hasReusePrompt ? { ...reusePlan, dataset_profile_id: profileRecord?.id, dataset_fingerprint: datasetFingerprint } : null,
      };

      setConversationDatasetContext((prev) => ({
        ...prev,
        [currentConversationId]: nextDatasetContext,
      }));

      const followUpMessages = [];
      if (isAIEmployeeMode) {
        // AI Employee mode: simple summary, no DI profiling cards
        const sheetCount = (profileRecord?.profile_json?.sheets || []).length;
        const totalRows = (uploadPreparation.sheetsRaw || []).reduce((sum, s) => sum + (s.rows?.length || 0), 0);
        followUpMessages.push({
          role: 'ai',
          content: `Got it — **${displayFileName}** loaded (${sheetCount} sheet${sheetCount !== 1 ? 's' : ''}, ${totalRows.toLocaleString()} rows).\n\nWhat should I do with it? You can say things like:\n- "Generate monthly report"\n- "Run forecast and plan"\n- "Analyze risks"\n\nOr just describe what you need in plain language.`,
          timestamp: new Date().toISOString(),
        });
      } else {
        // DI mode: full profiling cards
        const messages = [];
        if (autoReused) {
          messages.push({ role: 'ai', content: `Reused mapping from previous dataset (confidence ${(Number(reusePlan.confidence || 0) * 100).toFixed(0)}%).`, timestamp: new Date().toISOString() });
        } else if (hasReusePrompt) {
          messages.push({ role: 'ai', content: `I found a previous mapping for similar data (confidence ${(Number(reusePlan.confidence || 0) * 100).toFixed(0)}%). Apply it?`, timestamp: new Date().toISOString() });
          messages.push({ role: 'ai', type: 'reuse_decision_card', payload: { ...reusePlan, dataset_profile_id: profileRecord?.id, dataset_fingerprint: datasetFingerprint }, timestamp: new Date().toISOString() });
        } else {
          messages.push({ role: 'ai', content: 'Saved profile.', timestamp: new Date().toISOString() });
        }
        messages.push(
          { role: 'ai', type: 'dataset_summary_card', payload: cardPayload, timestamp: new Date().toISOString() },
          { role: 'ai', type: 'validation_card', payload: validationPayload, timestamp: new Date().toISOString() },
          { role: 'ai', type: 'downloads_card', payload: downloadsPayload, timestamp: new Date().toISOString() }
        );
        if (confirmationPayload) { messages.push({ role: 'ai', type: 'contract_confirmation_card', payload: confirmationPayload, timestamp: new Date().toISOString() }); }
        followUpMessages.push(...messages);
      }

      const finalSignature = buildSignature(profileRecord?.profile_json || {}, profileRecord?.contract_json || {});
      reuseMemoryService.upsertDatasetSimilarityIndex({ user_id: user.id, dataset_profile_id: profileRecord?.id, fingerprint: datasetFingerprint, signature_json: finalSignature }).catch((error) => { console.warn('[DecisionSupportView] Failed to persist similarity index:', error.message); });

      const validationPassed = profileRecord?.contract_json?.validation?.status === 'pass';
      if (validationPassed) {
        reuseMemoryService.upsertContractTemplate({ user_id: user.id, fingerprint: datasetFingerprint, workflow, contract_json: profileRecord?.contract_json || {}, quality_delta: 0.08 }).catch((error) => { console.warn('[DecisionSupportView] Failed to upsert contract template:', error.message); });
      }
      if (reusedSettingsTemplate) {
        reuseMemoryService.upsertRunSettingsTemplate({ user_id: user.id, fingerprint: datasetFingerprint, workflow, settings_json: reusedSettingsTemplate, quality_delta: 0.02 }).catch((error) => { console.warn('[DecisionSupportView] Failed to update settings template usage:', error.message); });
      }

      console.timeEnd('[DSV] upload:total');
      addNotification?.(`Attached spreadsheet${files.length > 1 ? 's' : ''} processed.`, 'success');

      return {
        datasetContext: nextDatasetContext,
        followUpMessages,
        attachments: buildSpreadsheetAttachmentPayloads({
          pendingAttachments: attachments,
          files,
          uploadPreparation,
          datasetProfileId: profileRecord?.id,
          userFileId: fileRecord?.id || null,
          fileName: displayFileName,
        }),
      };
    } catch (error) {
      console.timeEnd('[DSV] upload:total');
      const errorMessage = getErrorMessage(error, 'Unable to process attached spreadsheets.');
      console.error('[DSV] Spreadsheet attachment processing failed:', error?.message, error);
      addNotification?.(`Attachment processing failed: ${errorMessage}`, 'error');
      throw new Error(errorMessage);
    } finally {
      setIsUploadingDataset(false);
      setUploadStatusText('');
      if (fileInputRef.current) { fileInputRef.current.value = ''; }
    }
  }, [user?.id, currentConversationId, activeDatasetContext, conversationDatasetContext, addNotification, setConversationDatasetContext, isAIEmployeeMode]);

  const handlePendingAttachmentSelection = useCallback((rawFiles) => {
    const { accepted, rejected } = preparePendingChatAttachments(rawFiles, pendingAttachments);
    if (accepted.length > 0) {
      setPendingAttachments((prev) => [...prev, ...accepted]);
    }
    if (rejected.length > 0) {
      const message = rejected.map((item) => `${item.file_name}: ${item.reason}`).join('; ');
      addNotification?.(`Some files were skipped: ${message}`, 'warning');
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [pendingAttachments, addNotification]);

  const handleFileInputChange = useCallback((e) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) handlePendingAttachmentSelection(files);
  }, [handlePendingAttachmentSelection]);

  const handleDropUpload = useCallback((e) => {
    e.preventDefault(); e.stopPropagation(); setIsDragOverUpload(false);
    if (isUploadingDataset) return;
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length > 0) handlePendingAttachmentSelection(files);
  }, [handlePendingAttachmentSelection, isUploadingDataset]);

  const handleRemovePendingAttachment = useCallback((attachmentId) => {
    setPendingAttachments((prev) => prev.filter((attachment) => attachment.id !== attachmentId));
  }, []);

  const resolveAttachmentsForSend = useCallback(async (attachments) => {
    if (!Array.isArray(attachments) || attachments.length === 0) {
      return {
        attachments: [],
        followUpMessages: [],
        datasetContext: activeDatasetContext,
      };
    }

    const spreadsheetAttachments = attachments.filter(isSpreadsheetAttachment);
    const documentAttachments = attachments.filter((attachment) => !isSpreadsheetAttachment(attachment));

    let datasetContext = activeDatasetContext;
    const resolvedById = new Map();
    const followUpMessages = [];

    if (spreadsheetAttachments.length > 0) {
      const spreadsheetResult = await processSpreadsheetAttachments(spreadsheetAttachments);
      datasetContext = spreadsheetResult?.datasetContext || datasetContext;
      (spreadsheetResult?.attachments || []).forEach((attachment) => {
        resolvedById.set(attachment.id, attachment);
      });
      followUpMessages.push(...(spreadsheetResult?.followUpMessages || []));
    }

    if (documentAttachments.length > 0) {
      const resolvedDocuments = await materializeDocumentAttachments({
        userId: user?.id,
        attachments: documentAttachments,
      });
      resolvedDocuments.forEach((attachment) => {
        resolvedById.set(attachment.id, attachment);
      });
    }

    return {
      attachments: attachments
        .map((attachment) => resolvedById.get(attachment.id))
        .filter(Boolean),
      followUpMessages,
      datasetContext,
    };
  }, [activeDatasetContext, processSpreadsheetAttachments, user?.id]);

  // ── Canvas run handler ──────────────────────────────────────────────────
  const handleCanvasRun = useCallback(async (messageText, historyWithUserMessage, datasetContextOverride = null) => {
    const runtimeDatasetContext = datasetContextOverride || activeDatasetContext;
    if (!currentConversationId || !runtimeDatasetContext || !user?.id) return null;

    if (!runtimeDatasetContext.contractConfirmed) {
      appendMessagesToCurrentConversation([{ role: 'ai', content: 'Please confirm low-confidence contract mappings in the confirmation card before execution.', timestamp: new Date().toISOString() }]);
      addNotification?.('Please confirm contract mapping first.', 'warning');
      return null;
    }

    updateCanvasState(currentConversationId, (prev) => ({
      ...prev, isOpen: true, activeTab: 'logs', run: { ...(prev.run || {}), status: 'running' },
      logs: [], downloads: [], chartPayload: { actual_vs_forecast: [], inventory_projection: [], cost_breakdown: [], topology_graph: null }, topologyRunning: false
    }));

    try {
      const result = await executeChatCanvasRun({
        userId: user.id, prompt: messageText, datasetProfileId: runtimeDatasetContext.dataset_profile_id,
        datasetFingerprint: runtimeDatasetContext.dataset_fingerprint, profileJson: runtimeDatasetContext.profileJson,
        contractJson: runtimeDatasetContext.contractJson, sheetsRaw: runtimeDatasetContext.sheetsRaw || [],
        callbacks: {
          onLog: (logItem) => { updateCanvasState(currentConversationId, (prev) => ({ ...prev, logs: [...(prev.logs || []), logItem] })); },
          onStepChange: (stepStatuses) => { updateCanvasState(currentConversationId, (prev) => ({ ...prev, stepStatuses })); },
          onArtifact: ({ fileName, mimeType, content }) => {
            updateCanvasState(currentConversationId, (prev) => ({
              ...prev,
              downloads: [...(prev.downloads || []), { label: fileName, fileName, mimeType, content }],
              codeText: fileName === 'ml_code.py' ? String(content || '') : prev.codeText
            }));
          },
          onRunChange: (runModel) => { updateCanvasState(currentConversationId, (prev) => ({ ...prev, run: runModel })); }
        }
      });

      updateCanvasState(currentConversationId, (prev) => ({ ...prev, run: result.run, chartPayload: result.chartPayload, stepStatuses: result.stepStatuses, activeTab: 'charts' }));

      const summaryText = buildEvidenceSummaryText(result.summary);
      const reportFile = { label: 'run_report.json', fileName: 'run_report.json', mimeType: 'application/json', content: { summary: result.summary, evidence_pack: result.evidencePack, validation: result.validation, solver_used: result.solverUsed } };
      updateCanvasState(currentConversationId, (prev) => ({ ...prev, downloads: [...(prev.downloads || []), reportFile] }));

      const aiMessage = { role: 'ai', content: summaryText, timestamp: new Date().toISOString() };
      const finalMessages = [...historyWithUserMessage, aiMessage];
      const newTitle = currentMessages.length <= 1 ? messageText.slice(0, 50) : currentConversation.title;
      const updatedConversation = { ...currentConversation, title: newTitle, messages: finalMessages, updated_at: new Date().toISOString() };
      setConversations((prev) => prev.map((c) => c.id === currentConversationId ? updatedConversation : c));
      if (conversationsDb) { conversationsDb.from('conversations').update({ title: newTitle, messages: finalMessages, updated_at: new Date().toISOString() }).eq('id', currentConversationId).eq('user_id', user.id).then(({ error }) => { if (error) markTableUnavailable(); }); }
      return true;
    } catch (error) {
      console.error('Canvas execution failed:', error);
      updateCanvasState(currentConversationId, (prev) => ({
        ...prev, run: { ...(prev.run || {}), status: 'failed' }, activeTab: 'logs',
        logs: [...(prev.logs || []), { id: `err_${Date.now()}`, step: 'report', message: `❌ Execution failed: ${error.message}`, timestamp: new Date().toISOString() }]
      }));
      const aiMessage = { role: 'ai', content: `❌ Canvas execution failed: ${error.message}`, timestamp: new Date().toISOString() };
      const finalMessages = [...historyWithUserMessage, aiMessage];
      const updatedConversation = { ...currentConversation, messages: finalMessages, updated_at: new Date().toISOString() };
      setConversations((prev) => prev.map((c) => c.id === currentConversationId ? updatedConversation : c));
      if (conversationsDb) { conversationsDb.from('conversations').update({ messages: finalMessages, updated_at: new Date().toISOString() }).eq('id', currentConversationId).eq('user_id', user.id).then(({ error: updateError }) => { if (updateError) markTableUnavailable(); }); }
      return false;
    }
  }, [currentConversationId, activeDatasetContext, user?.id, updateCanvasState, appendMessagesToCurrentConversation, addNotification, currentConversation, currentMessages, setConversations]);

  const runDirectAnalysisAgent = useCallback(async ({ query, history = [], runtimeDatasetContext, attachments = [], modelMode: explicitModelMode }) => {
    chatAbortRef.current?.abort();
    chatAbortRef.current = new AbortController();
    // explicitModelMode is 'full' or null; resolved to 'single'|'dual' after strategy
    const baseDirectMode = explicitModelMode || null;

    const datasetProfileId = getDatasetProfileId(runtimeDatasetContext);
    let datasetProfileRow = null;
    if (datasetProfileId) {
      try { datasetProfileRow = await datasetProfilesService.getById(datasetProfileId); } catch { /* ok */ }
    }

    const runAgentCandidatePass = async ({
      candidateId,
      label,
      tone,
      provider,
      model,
      configNormalized = false,
      agentMessage,
      userMessage,
      conversationHistory,
      toolContext,
      answerContract,
      mode,
      signal,
      streamToUser = false,
    }) => {
      const agentMeta = {
        agentKey: candidateId,
        agentLabel: label,
        agentTone: tone,
        provider,
        model,
      };

      const result = await runAgentLoop({
        message: agentMessage,
        conversationHistory,
        systemPrompt,
        toolContext,
        answerContract,
        callbacks: {
          onTextChunk: streamToUser ? (chunk) => setStreamingContent((prev) => prev + chunk) : undefined,
          onToolCall: streamToUser ? ({ name }) => setStreamingContent((prev) => prev + `\n🔧 Running **${name}**...\n`) : undefined,
          onToolResult: streamToUser ? ({ name, success, error: err }) => {
            setStreamingContent((prev) => prev + (success ? `✅ **${name}** done\n` : `❌ **${name}** failed: ${err}\n`));
          } : undefined,
          onThinking: (data) => appendThinkingStep({ ...data, ...agentMeta }),
        },
        signal,
        mode,
        agentProvider: provider,
        agentModel: model,
      });

      if (mode === 'analysis' && !hasSuccessfulAnalysisEvidence(result)) {
        throw createMissingEvidenceError(result);
      }

      const presentation = await buildAgentPresentationPayload({
        userMessage,
        toolCalls: result.toolCalls || [],
        finalAnswerText: result.text || '',
        mode,
        answerContract,
        forceCrossReview: strategy.mustJudge,
      });

      appendAgentThinkingNote(
        { ...agentMeta, status: 'completed' },
        presentation?.brief?.summary || presentation?.brief?.headline || result.text || `${label} completed.`,
      );

      return {
        candidateId,
        label,
        tone,
        provider: result?.provider || provider,
        model: result?.model || model,
        transport: result?.transport || null,
        recoveryAttempts: Array.isArray(result?.recoveryAttempts) ? result.recoveryAttempts : [],
        configNormalized: Boolean(configNormalized),
        result,
        presentation,
      };
    };

    const runSettledCandidatePass = async (config) => {
      const startedAt = new Date().toISOString();
      const startedMs = Date.now();
      const candidateController = createLinkedAbortController(chatAbortRef.current?.signal);

      try {
        const candidate = await runAgentCandidatePass({
          ...config,
          signal: candidateController.signal,
        });
        const finishedAt = new Date().toISOString();
        return {
          ...candidate,
          status: 'completed',
          startedAt,
          finishedAt,
          durationMs: Date.now() - startedMs,
          failedReason: null,
          failureCategory: null,
          failureMessage: null,
        };
      } catch (error) {
        const finishedAt = new Date().toISOString();
        const status = resolveCandidateFailureStatus(error);
        const failedReason = getCandidateFailureMessage(error);
        const failureCandidate = buildFailedCandidate({
          candidateId: config.candidateId,
          label: config.label,
          tone: config.tone,
          provider: config.provider,
          model: config.model,
          transport: null,
          status,
          failedReason,
          failureCategory: getCandidateFailureCategory(error),
          failureMessage: getCandidateFailureMessage(error),
          recoveryAttempts: getCandidateRecoveryAttempts(error),
          configNormalized: config.configNormalized,
          startedAt,
          finishedAt,
          durationMs: Date.now() - startedMs,
        });

        appendAgentThinkingNote({
          agentKey: config.candidateId,
          agentLabel: config.label,
          agentTone: config.tone,
          provider: config.provider,
          model: config.model,
          status,
        }, failureCandidate.failedReason);

        return failureCandidate;
      }
    };

    const buildCompetitivePayload = ({
      winner = null,
      alternative = null,
      judgeDecision = null,
      answerContract,
      strategy,
      candidates = [],
    }) => {
      const payloadCandidates = candidates.length > 0
        ? (winner
            ? [winner, ...candidates.filter((candidate) => candidate?.candidateId !== winner?.candidateId)]
            : candidates)
        : [winner, alternative].filter(Boolean);
      const winnerTrace = winner?.presentation?.trace || null;
      const blockedTrace = buildBlockedTrace(payloadCandidates);
      const orchestrationMode = payloadCandidates.length > 1 || strategy?.dualGenerate
        ? 'parallel_dual'
        : 'single';
      return {
        toolCalls: winner?.result?.toolCalls || [],
        brief: winner?.presentation?.brief || null,
        trace: winnerTrace || blockedTrace,
        answerContract: winner?.presentation?.answerContract || answerContract || null,
        review: winner?.presentation?.review || null,
        qa: winner?.presentation?.qa || buildBlockedAgentQa(payloadCandidates),
        candidates: payloadCandidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          label: candidate.label,
          provider: candidate.provider,
          model: candidate.model,
          tone: candidate.tone,
          status: candidate.status || 'completed',
          startedAt: candidate.startedAt || null,
          finishedAt: candidate.finishedAt || null,
          durationMs: Number.isFinite(candidate.durationMs) ? candidate.durationMs : null,
          failedReason: candidate.failedReason || null,
          failureCategory: candidate.failureCategory || null,
          failureMessage: candidate.failureMessage || null,
          recoveryAttempts: Array.isArray(candidate.recoveryAttempts) ? candidate.recoveryAttempts : [],
          configNormalized: Boolean(candidate.configNormalized),
          brief: candidate.presentation?.brief || null,
          trace: candidate.presentation?.trace || null,
          qa: candidate.presentation?.qa || null,
        })),
        judgeDecision: judgeDecision ? {
          ...judgeDecision,
          winnerLabel: winner?.label || '',
          winnerProvider: winner?.provider || '',
          winnerModel: winner?.model || '',
          triggerReasons: strategy?.triggerReasons || [],
        } : null,
        orchestration: {
          mode: orchestrationMode,
          triggerReasons: strategy?.triggerReasons || [],
          candidates: payloadCandidates.map(buildOrchestrationCandidateMeta).filter(Boolean),
        },
      };
    };

    clearThinkingSteps();
    const answerContract = await resolveAgentAnswerContract({
      userMessage: query,
      mode: 'analysis',
    });
    const toolContext = {
      userId: user?.id,
      datasetProfileRow,
      datasetProfileId,
      datasetInputData: buildTaskInputData(runtimeDatasetContext, attachments),
    };
    const baseStrategy = resolveAgentExecutionStrategy({
      userMessage: query,
      answerContract,
      mode: 'analysis',
      hasAttachments: attachments.length > 0,
    });
    const strategy = baseDirectMode === 'full'
      ? {
          ...baseStrategy,
          dualGenerate: true,
          mustJudge: true,
          triggerReasons: [...baseStrategy.triggerReasons, 'forced_full_thinking'],
        }
      : baseStrategy;
    const directModelMode = baseDirectMode || (strategy.dualGenerate ? 'dual' : 'single');
    const resolveRoleConfig = (role, mode) => getModelConfigResolution(role, mode);
    const appendConfigNormalizationNotes = () => {
      consumeModelConfigNormalizationNotices().forEach((notice) => {
        appendAgentThinkingNote({
          agentKey: 'config',
          agentLabel: 'Model Config',
          agentTone: 'system',
          provider: '',
          model: '',
          status: 'completed',
        }, notice.message);
      });
    };

    let selectedCandidate;
    let alternativeCandidate = null;
    let judgeDecision = null;
    let candidatePool = [];

    if (strategy.dualGenerate) {
      setStreamingContent('🧠 Running primary agent...\n🧪 Running challenger agent...\n');
      const primaryModelConfig = resolveRoleConfig('primary', directModelMode);
      const secondaryModelConfig = resolveRoleConfig('secondary', directModelMode);
      appendConfigNormalizationNotes();
      const primaryConfig = {
        candidateId: 'primary',
        label: 'Primary Agent',
        tone: 'primary',
        provider: primaryModelConfig.provider,
        model: primaryModelConfig.model,
        configNormalized: primaryModelConfig.configNormalized,
        agentMessage: buildDirectAnalysisAgentPrompt(query),
        userMessage: query,
        conversationHistory: history.slice(-6),
        toolContext,
        answerContract,
        mode: 'analysis',
      };
      const secondaryConfig = {
        candidateId: 'secondary',
        label: 'Challenger Agent',
        tone: 'secondary',
        provider: secondaryModelConfig.provider,
        model: secondaryModelConfig.model,
        configNormalized: secondaryModelConfig.configNormalized,
        agentMessage: `${buildDirectAnalysisAgentPrompt(query)}\n\n${buildChallengerInstruction({ answerContract, domainKey: detectDomain(query).domainKey })}`,
        userMessage: query,
        conversationHistory: history.slice(-6),
        toolContext,
        answerContract,
        mode: 'analysis',
      };
      const [primarySettled, secondarySettled] = await Promise.allSettled([
        runSettledCandidatePass(primaryConfig),
        runSettledCandidatePass(secondaryConfig),
      ]);
      const primaryCandidate = primarySettled.status === 'fulfilled'
        ? primarySettled.value
        : buildFailedCandidate({
          candidateId: primaryConfig.candidateId,
          label: primaryConfig.label,
          tone: primaryConfig.tone,
          provider: primaryConfig.provider,
          model: primaryConfig.model,
          status: resolveCandidateFailureStatus(primarySettled.reason),
          failedReason: getCandidateFailureMessage(primarySettled.reason),
          failureCategory: getCandidateFailureCategory(primarySettled.reason),
          failureMessage: getCandidateFailureMessage(primarySettled.reason),
          recoveryAttempts: getCandidateRecoveryAttempts(primarySettled.reason),
          configNormalized: primaryConfig.configNormalized,
          startedAt: null,
          finishedAt: new Date().toISOString(),
          durationMs: null,
        });
      const secondaryCandidate = secondarySettled.status === 'fulfilled'
        ? secondarySettled.value
        : buildFailedCandidate({
          candidateId: secondaryConfig.candidateId,
          label: secondaryConfig.label,
          tone: secondaryConfig.tone,
          provider: secondaryConfig.provider,
          model: secondaryConfig.model,
          status: resolveCandidateFailureStatus(secondarySettled.reason),
          failedReason: getCandidateFailureMessage(secondarySettled.reason),
          failureCategory: getCandidateFailureCategory(secondarySettled.reason),
          failureMessage: getCandidateFailureMessage(secondarySettled.reason),
          recoveryAttempts: getCandidateRecoveryAttempts(secondarySettled.reason),
          configNormalized: secondaryConfig.configNormalized,
          startedAt: null,
          finishedAt: new Date().toISOString(),
          durationMs: null,
        });
      const settledCandidates = [primaryCandidate, secondaryCandidate];
      candidatePool = settledCandidates;

      setStreamingContent((prev) => `${prev}\n${primaryCandidate.status === 'completed' ? '✅' : '❌'} Primary agent ${primaryCandidate.status === 'completed' ? 'completed' : primaryCandidate.status === 'timed_out' ? 'timed out' : 'failed'}\n${secondaryCandidate.status === 'completed' ? '✅' : '❌'} Challenger agent ${secondaryCandidate.status === 'completed' ? 'completed' : secondaryCandidate.status === 'timed_out' ? 'timed out' : 'failed'}\n`);

      const completedCandidates = settledCandidates.filter((candidate) => candidate.status === 'completed');

      if (completedCandidates.length === 2) {
        setStreamingContent((prev) => prev + '\n⚖️ Running judge...\n');
        judgeDecision = await judgeAgentCandidates({
          userMessage: query,
          answerContract,
          primaryCandidate,
          secondaryCandidate,
          modelMode: directModelMode,
        });

        appendAgentThinkingNote({
          agentKey: 'judge',
          agentLabel: 'Judge',
          agentTone: 'judge',
          provider: judgeDecision?.reviewer?.provider || '',
          model: judgeDecision?.reviewer?.model || '',
          transport: judgeDecision?.reviewer?.transport || null,
          status: 'completed',
        }, [judgeDecision?.summary, ...(judgeDecision?.rationale || [])].filter(Boolean).join('\n'));

        const judgedWinner = settledCandidates.find((candidate) =>
          candidate?.candidateId === judgeDecision?.winnerCandidateId && candidate?.status === 'completed'
        );
        selectedCandidate = judgedWinner || completedCandidates[0];
        alternativeCandidate = settledCandidates.find((candidate) => candidate?.candidateId !== selectedCandidate?.candidateId) || null;
      } else if (completedCandidates.length === 1) {
        selectedCandidate = completedCandidates[0];
        alternativeCandidate = settledCandidates.find((candidate) => candidate?.candidateId !== selectedCandidate?.candidateId) || null;
        appendAgentThinkingNote({
          agentKey: 'judge',
          agentLabel: 'Judge',
          agentTone: 'judge',
          provider: 'orchestrator',
          model: 'skipped',
          transport: 'orchestrator',
          status: 'failed',
        }, 'Judge skipped because only one candidate produced usable evidence.');
      } else {
        judgeDecision = {
          winnerCandidateId: null,
          summary: 'Both candidate runs failed before producing a valid answer.',
          rationale: settledCandidates.map((candidate) => `${candidate.label}: ${candidate.failedReason || 'Unknown error'}`),
          loserIssues: [],
          confidence: 0,
          reviewer: {
            provider: 'orchestrator',
            model: 'parallel_dual',
            transport: 'orchestrator',
          },
          degraded: true,
        };
        appendAgentThinkingNote({
          agentKey: 'judge',
          agentLabel: 'Judge',
          agentTone: 'judge',
          provider: 'orchestrator',
          model: 'parallel_dual',
          transport: 'orchestrator',
          status: 'failed',
        }, judgeDecision.summary);
        selectedCandidate = null;
        alternativeCandidate = null;
      }
    } else {
      const primaryModelConfig = resolveRoleConfig('primary', directModelMode);
      appendConfigNormalizationNotes();
      selectedCandidate = await runSettledCandidatePass({
        candidateId: 'primary',
        label: 'Primary Agent',
        tone: 'primary',
        provider: primaryModelConfig.provider,
        model: primaryModelConfig.model,
        configNormalized: primaryModelConfig.configNormalized,
        agentMessage: buildDirectAnalysisAgentPrompt(query),
        userMessage: query,
        conversationHistory: history.slice(-6),
        toolContext,
        answerContract,
        mode: 'analysis',
        streamToUser: true,
      });
      candidatePool = [selectedCandidate];

      const dataToolNames = new Set(ANALYSIS_AGENT_TOOL_IDS);
      const usedDataTools = selectedCandidate?.status === 'completed' && (selectedCandidate?.result?.toolCalls || []).some(
        (toolCall) => dataToolNames.has(toolCall?.name)
      );

      if (usedDataTools && !chatAbortRef.current?.signal?.aborted) {
        setStreamingContent((prev) => prev + '\n🔄 Data tools detected — escalating to dual agent + judge...\n🧪 Running challenger agent...\n');
        appendAgentThinkingNote({
          agentKey: 'escalation',
          agentLabel: 'Auto-Escalation',
          agentTone: 'system',
          provider: '',
          model: '',
        }, 'Primary agent used data tools — launching challenger for quality verification.');

        const challengerModelConfig = resolveRoleConfig('secondary', 'dual');
        appendConfigNormalizationNotes();
        const challengerConfig = {
          candidateId: 'secondary',
          label: 'Challenger Agent',
          tone: 'secondary',
          provider: challengerModelConfig.provider,
          model: challengerModelConfig.model,
          configNormalized: challengerModelConfig.configNormalized,
          agentMessage: `${buildDirectAnalysisAgentPrompt(query)}\n\n${buildChallengerInstruction({ answerContract, domainKey: detectDomain(query).domainKey, primaryBrief: selectedCandidate?.presentation?.brief })}`,
          userMessage: query,
          conversationHistory: history.slice(-6),
          toolContext,
          answerContract,
          mode: 'analysis',
        };
        const challengerResult = await runSettledCandidatePass(challengerConfig);

        setStreamingContent((prev) => `${prev}${challengerResult.status === 'completed' ? '✅' : '❌'} Challenger agent ${challengerResult.status === 'completed' ? 'completed' : challengerResult.status === 'timed_out' ? 'timed out' : 'failed'}\n`);

        candidatePool = [selectedCandidate, challengerResult];

        const completedCandidates = candidatePool.filter((candidate) => candidate?.status === 'completed');

        if (completedCandidates.length === 2) {
          setStreamingContent((prev) => prev + '\n⚖️ Running judge...\n');
          judgeDecision = await judgeAgentCandidates({
            userMessage: query,
            answerContract,
            primaryCandidate: selectedCandidate,
            secondaryCandidate: challengerResult,
            modelMode: 'dual',
          });

          appendAgentThinkingNote({
            agentKey: 'judge',
            agentLabel: 'Judge',
            agentTone: 'judge',
            provider: judgeDecision?.reviewer?.provider || '',
            model: judgeDecision?.reviewer?.model || '',
            transport: judgeDecision?.reviewer?.transport || null,
            status: 'completed',
          }, [judgeDecision?.summary, ...(judgeDecision?.rationale || [])].filter(Boolean).join('\n'));

          const judgedWinner = candidatePool.find((candidate) =>
            candidate?.candidateId === judgeDecision?.winnerCandidateId && candidate?.status === 'completed'
          );
          selectedCandidate = judgedWinner || selectedCandidate;
          alternativeCandidate = candidatePool.find((candidate) => candidate?.candidateId !== selectedCandidate?.candidateId) || null;
        } else if (completedCandidates.length === 1) {
          selectedCandidate = completedCandidates[0];
          alternativeCandidate = candidatePool.find((candidate) => candidate?.candidateId !== selectedCandidate?.candidateId) || null;
          appendAgentThinkingNote({
            agentKey: 'judge',
            agentLabel: 'Judge',
            agentTone: 'judge',
            provider: 'orchestrator',
            model: 'skipped',
            transport: 'orchestrator',
            status: 'failed',
          }, 'Judge skipped because only one candidate produced usable evidence.');
        }
      }
    }

    const thinkingTraceMessage = buildThinkingTraceMessage();
    clearThinkingSteps();
    appendMessagesToCurrentConversation([
      ...(thinkingTraceMessage ? [thinkingTraceMessage] : []),
      {
        role: 'ai',
        type: 'agent_response',
        content: selectedCandidate?.result?.text || judgeDecision?.summary || selectedCandidate?.failedReason || '',
        payload: buildCompetitivePayload({
          winner: selectedCandidate,
          alternative: alternativeCandidate,
          judgeDecision,
          answerContract,
          strategy,
          candidates: candidatePool,
        }),
        timestamp: new Date().toISOString(),
      },
    ]);

    return selectedCandidate?.result || null;
  }, [appendAgentThinkingNote, appendMessagesToCurrentConversation, appendThinkingStep, buildTaskInputData, buildThinkingTraceMessage, clearThinkingSteps, getDatasetProfileId, systemPrompt, user?.id]);

  // ── Blueprint Execution Handlers ────────────────────────────────────────
  const handleRunBlueprintModule = useCallback(async (module) => {
    try {
      const result = await executeBlueprintModule(module);
      appendMessagesToCurrentConversation([{
        role: 'ai',
        type: 'analysis_result_card',
        payload: result,
        timestamp: new Date().toISOString()
      }]);
      // Optional: stream insight for single run
    } catch (err) {
      console.error('Blueprint module execution failed:', err);
      appendMessagesToCurrentConversation([{
        role: 'ai',
        content: `❌ Module "${module.title}" failed: ${err.message}`,
        timestamp: new Date().toISOString()
      }]);
      throw err; // Propagate to card to show error state
    }
  }, [appendMessagesToCurrentConversation]);

  const handleRunAllBlueprintModules = useCallback(async (modulesToRun) => {
    // Process in chunks of 3 to avoid overwhelming the browser/API
    const CHUNK_SIZE = 3;
    for (let i = 0; i < modulesToRun.length; i += CHUNK_SIZE) {
      const chunk = modulesToRun.slice(i, i + CHUNK_SIZE);
      await Promise.allSettled(chunk.map(m => handleRunBlueprintModule(m)));
    }
    appendMessagesToCurrentConversation([{
      role: 'ai',
      content: '✅ All planned analysis modules completed.',
      timestamp: new Date().toISOString()
    }]);
  }, [handleRunBlueprintModule, appendMessagesToCurrentConversation]);

  // ── Send handler ────────────────────────────────────────────────────────
  const handleSend = useCallback(async (eOrMessage) => {
    // Accept either an event (from form submit) or a string (from clarification callbacks)
    if (eOrMessage && typeof eOrMessage !== 'string' && eOrMessage.preventDefault) eOrMessage.preventDefault();
    const overrideMessage = typeof eOrMessage === 'string' ? eOrMessage : null;
    const visibleInput = String(overrideMessage || input || '');
    const trimmedVisibleInput = visibleInput.trim();
    const thinkingDirective = parseManualThinkingDirective(trimmedVisibleInput);
    const effectiveVisibleInput = thinkingDirective.cleanedMessage || '';
    const attachmentsToSend = overrideMessage ? [] : pendingAttachments;
    if ((thinkingDirective.isDirective && !effectiveVisibleInput && attachmentsToSend.length === 0)) {
      appendMessagesToCurrentConversation([{
        role: 'ai',
        content: 'Usage: `/think <question>` for full thinking, or `/think light <question>` for lightweight thinking.',
        timestamp: new Date().toISOString(),
      }]);
      return;
    }
    if ((!effectiveVisibleInput && attachmentsToSend.length === 0) || !currentConversationId) return;

    setIsTyping(true);
    setStreamingContent('');

    try {
      if (textareaRef.current) { textareaRef.current.style.height = 'auto'; }
      const attachmentFallbackText = attachmentsToSend.length > 0
        ? 'Please inspect the attached files and use them as context for this request.'
        : '';
      const messageText = effectiveVisibleInput || attachmentFallbackText;

      let runtimeDatasetContext = activeDatasetContext;
      let resolvedAttachments = [];
      let attachmentMessages = [];
      if (attachmentsToSend.length > 0) {
        const resolution = await resolveAttachmentsForSend(attachmentsToSend);
        runtimeDatasetContext = resolution.datasetContext || runtimeDatasetContext;
        resolvedAttachments = resolution.attachments || [];
        attachmentMessages = resolution.followUpMessages || [];
      }

      const userMessage = {
        role: 'user',
        content: effectiveVisibleInput,
        attachments: resolvedAttachments.length > 0 ? resolvedAttachments : undefined,
        timestamp: new Date().toISOString(),
      };

      if (!overrideMessage) {
        setInput('');
        setPendingAttachments([]);
      }

      const updatedMessages = [...currentMessages, userMessage];
      const stagedMessages = [...updatedMessages, ...attachmentMessages];
      setConversations((prev) => prev.map((conversation) =>
        conversation.id === currentConversationId
          ? { ...conversation, messages: stagedMessages, updated_at: new Date().toISOString() }
          : conversation
      ));

      const trimmed = String(effectiveVisibleInput || '').trim();
    const lower = trimmed.toLowerCase();
    const command = lower.split(/\s+/)[0];
    const messageTextWithAttachments = buildMessageWithAttachmentContext(messageText, resolvedAttachments);
    const effectiveThinkingMode = thinkingDirective.isDirective ? thinkingDirective.mode : currentConversationThinkingMode;
    const forceFullThinking = effectiveThinkingMode === 'full';
    // baseModelMode is refined to 'single'|'dual'|'full' after strategy is resolved
    const baseModelMode = forceFullThinking ? 'full' : null;

    // ── Feature gate for slash commands ──────────────────────────────────
    if (command.startsWith('/') && !isCommandEnabled(command)) {
      const featureName = command.replace(/^\//, '');
      appendMessagesToCurrentConversation([{
        role: 'ai',
        content: getDisabledMessage(featureName),
        timestamp: new Date().toISOString(),
        meta: { command, gated: true },
      }]);
      setIsTyping(false); setStreamingContent(''); return;
    }

    if (lower.startsWith('/reuse')) {
      const parts = trimmed.split(/\s+/);
      const mode = String(parts[1] || 'off').toLowerCase();
      const reuseEnabled = mode !== 'off';
      setConversationDatasetContext((prev) => ({ ...prev, [currentConversationId]: { ...(prev[currentConversationId] || {}), reuse_enabled: reuseEnabled, pending_reuse_plan: reuseEnabled ? prev[currentConversationId]?.pending_reuse_plan || null : null, reused_settings_template: reuseEnabled ? prev[currentConversationId]?.reused_settings_template || null : null } }));
      appendMessagesToCurrentConversation([{ role: 'ai', content: reuseEnabled ? 'Reuse is enabled for this conversation.' : 'Reuse is disabled for this conversation.', timestamp: new Date().toISOString() }]);
      setIsTyping(false); setStreamingContent(''); return;
    }

    if (lower.startsWith('/retrain')) {
      const parts = trimmed.split(/\s+/);
      const mode = String(parts[1] || 'on').toLowerCase();
      const forceRetrain = mode !== 'off';
      setConversationDatasetContext((prev) => ({ ...prev, [currentConversationId]: { ...(prev[currentConversationId] || {}), force_retrain: forceRetrain } }));
      appendMessagesToCurrentConversation([{ role: 'ai', content: forceRetrain ? 'Forecast retrain is forced for this conversation.' : 'Forecast retrain force is disabled.', timestamp: new Date().toISOString() }]);
      setIsTyping(false); setStreamingContent(''); return;
    }

    if (command === '/blueprint' || command === '/分析藍圖') {
      try {
        appendMessagesToCurrentConversation([{ role: 'ai', content: 'Generating analysis blueprint...', timestamp: new Date().toISOString() }]);
        const blueprint = await generateAnalysisBlueprint();
        appendMessagesToCurrentConversation([{
          role: 'ai',
          type: 'analysis_blueprint_card',
          payload: blueprint,
          timestamp: new Date().toISOString()
        }]);
      } catch (err) {
        appendMessagesToCurrentConversation([{ role: 'ai', content: `Blueprint generation failed: ${err.message}`, timestamp: new Date().toISOString() }]);
      }
      setIsTyping(false); setStreamingContent(''); return;
    }

    if (command === '/reset_data') {
      const parts = lower.split(/\s+/);
      if (parts[1] !== 'confirm') {
        appendMessagesToCurrentConversation([{ role: 'ai', content: 'Type /reset_data confirm to proceed.', timestamp: new Date().toISOString() }]);
        setIsTyping(false); setStreamingContent(''); return;
      }
      try {
        await diResetService.resetCurrentUserData();
        setConversationDatasetContext((prev) => {
          const next = {};
          Object.keys(prev || {}).forEach((cid) => { next[cid] = { ...(prev[cid] || {}), dataset_profile_id: null, dataset_fingerprint: null, user_file_id: null, summary: '', profileJson: {}, contractJson: {}, contractConfirmed: false, minimalQuestions: [], pending_reuse_plan: null, reused_settings_template: null }; });
          return next;
        });
        setLatestPlanRunId(null); forecastExec.setRunningForecastProfiles({}); planExec.setRunningPlanKeys({});
        workflowExec.setWorkflowSnapshots({}); workflowExec.setActiveWorkflowRuns({});
        convManager.setCanvasStateByConversation({}); topologyAutoLoadRef.current = {};
        appendMessagesToCurrentConversation([{ role: 'ai', content: '✅ Cleared old profiles/runs/artifacts for this user.', timestamp: new Date().toISOString() }]);
      } catch (error) {
        appendMessagesToCurrentConversation([{ role: 'ai', content: `❌ Failed to clear DI data: ${getErrorMessage(error, 'Unexpected error')}`, timestamp: new Date().toISOString() }]);
      }
      setIsTyping(false); setStreamingContent(''); return;
    }

    if (lower.startsWith('/forecast')) {
      const parts = trimmed.split(/\s+/);
      const profileId = parts.length > 1 ? Number(parts[1]) : null;
      await executeForecastFlow({ profileId: Number.isFinite(profileId) ? profileId : getDatasetProfileId(runtimeDatasetContext) });
      setIsTyping(false); setStreamingContent(''); return;
    }

    if (lower.startsWith('/plan')) {
      const parts = trimmed.split(/\s+/);
      const profileId = parts.length > 1 ? Number(parts[1]) : null;
      await executePlanFlow({ datasetProfileId: Number.isFinite(profileId) ? profileId : getDatasetProfileId(runtimeDatasetContext) });
      setIsTyping(false); setStreamingContent(''); return;
    }

    // ── /blueprint or /分析藍圖 — AI examines data and designs analysis plan ──
    if (lower.startsWith('/blueprint') || lower.startsWith('/分析藍圖') || /^(全面分析|分析這個資料|分析這份資料|analyze this data|comprehensive analysis)$/i.test(trimmed)) {
      appendMessagesToCurrentConversation([{ role: 'ai', content: 'AI is examining the data schema and designing an analysis blueprint...', timestamp: new Date().toISOString() }]);
      try {
        const bp = await generateAnalysisBlueprint({ datasetProfile: runtimeDatasetContext });
        appendMessagesToCurrentConversation([{ role: 'ai', type: 'analysis_blueprint_card', payload: bp, timestamp: new Date().toISOString() }]);
      } catch (err) {
        console.error('[Blueprint] Generation failed:', err);
        appendMessagesToCurrentConversation([{ role: 'ai', content: `Analysis blueprint generation failed: ${err?.message || 'Unknown error'}. Please check console for details.`, timestamp: new Date().toISOString() }]);
      }
      setIsTyping(false); setStreamingContent(''); return;
    }

    // ── /analyze [query] — Route to Python analysis engine ──
    if (lower.startsWith('/analyze') || lower.startsWith('/analysis') || lower.startsWith('/query')) {
      const subCmd = trimmed.split(/\s+/).slice(1).join(' ').trim();
      if (!subCmd) {
        appendMessagesToCurrentConversation([{
          role: 'ai',
          content: '**Usage:** `/analyze <your question>`\n\nExample: `/analyze seller performance`, `/analyze revenue trend by category`',
          timestamp: new Date().toISOString(),
        }]);
      } else {
        try {
          await runDirectAnalysisAgent({
            query: subCmd,
            history: updatedMessages,
            runtimeDatasetContext,
            modelMode: baseModelMode,
          });
        } catch (analysisErr) {
          appendMessagesToCurrentConversation([{ role: 'ai', content: `Analysis failed: ${analysisErr?.message || 'Unknown error'}`, timestamp: new Date().toISOString() }]);
        }
      }
      setIsTyping(false); setStreamingContent(''); return;
    }

    if (command === '/workflowa' || command === '/run-workflow-a') {
      const parts = trimmed.split(/\s+/);
      const profileId = parts.length > 1 ? Number(parts[1]) : null;
      await executeWorkflowAFlow({ datasetProfileId: Number.isFinite(profileId) ? profileId : getDatasetProfileId(runtimeDatasetContext) });
      setIsTyping(false); setStreamingContent(''); return;
    }

    if (command === '/workflow') {
      const parts = trimmed.split(/\s+/);
      const profileId = parts.length > 1 ? Number(parts[1]) : null;
      await executeWorkflowFlow({ datasetProfileId: Number.isFinite(profileId) ? profileId : getDatasetProfileId(runtimeDatasetContext) });
      setIsTyping(false); setStreamingContent(''); return;
    }

    if (command === '/workflowb' || command === '/run-workflow-b' || command === '/risk') {
      const parts = trimmed.split(/\s+/);
      const profileId = parts.length > 1 ? Number(parts[1]) : null;
      await executeWorkflowBFlow({ datasetProfileId: Number.isFinite(profileId) ? profileId : getDatasetProfileId(runtimeDatasetContext) });
      setIsTyping(false); setStreamingContent(''); return;
    }

    if (command === '/topology') {
      const parts = trimmed.split(/\s+/);
      const explicitRunId = parts.length > 1 ? Number(parts[1]) : null;
      await handleRunTopology(Number.isFinite(explicitRunId) ? explicitRunId : topologyRunId);
      setIsTyping(false); setStreamingContent(''); return;
    }

    if (command === '/macro-oracle' || command === '/oracle') {
      const parts = trimmed.split(/\s+/);
      const scenario = parts[1] || null; // e.g., /macro-oracle semiconductor_fire
      await handleMacroOracleCheck({ demoScenario: scenario });
      setIsTyping(false); setStreamingContent(''); return;
    }

    if (command === '/ralph-stop' || command === '/ralph-cancel') {
      const aborted = abortAllRalphLoops();
      if (aborted > 0) {
        ralphAbortRef.current = null;
        appendMessagesToCurrentConversation([{
          role: 'ai',
          content: `Ralph Loop **stopped** (${aborted} loop(s) cancelled). Partial results may be available in the Task Board.`,
          timestamp: new Date().toISOString(),
        }]);
      } else {
        appendMessagesToCurrentConversation([{
          role: 'ai',
          content: 'No Ralph Loop is currently running.',
          timestamp: new Date().toISOString(),
        }]);
      }
      setIsTyping(false); setStreamingContent(''); return;
    }

    if (command === '/ralph-loop' || command === '/ralph') {
      const taskDescription = trimmed.replace(/^\/ralph(-loop)?\s*/i, '').trim();
      const taskDescriptionWithAttachments = buildMessageWithAttachmentContext(taskDescription, resolvedAttachments);
      if (!taskDescription) {
        appendMessagesToCurrentConversation([{
          role: 'ai',
          content: [
            '**Ralph Loop — 自主 AI 代理迴圈**',
            '',
            'Usage: `/ralph-loop <任務描述>`',
            '',
            'Examples:',
            '- `/ralph-loop 幫我做一份本月補貨計畫`',
            '- `/ralph 分析最近三個月的預測準確率`',
            '- `/ralph run forecast and plan for dataset 42`',
            '',
            `Status: Ralph Loop is currently **${isRalphLoopEnabled() ? 'ON' : 'OFF'}**`,
            '',
            isRalphLoopEnabled()
              ? 'Ralph Loop 已啟用，所有任務都會自動使用 Ralph Loop 驅動。'
              : '要啟用全域 Ralph Loop，請在 `.env.local` 設定 `VITE_RALPH_LOOP_ENABLED=true`。\n使用 `/ralph-loop <任務>` 可以單次啟用。',
          ].join('\n'),
          timestamp: new Date().toISOString(),
        }]);
        setIsTyping(false); setStreamingContent(''); return;
      }

      try {
        const assignedWorker = await getAssignedWorker();
        if (!assignedWorker?.id) throw new Error('No digital worker available.');

        // ── Unified intake gate (dedup, routing, SLA) ──
        let intakeEmployeeId = assignedWorker.id;
        try {
          const intakeResult = await processIntake({
            source: INTAKE_SOURCES.CHAT,
            message: taskDescriptionWithAttachments,
            employeeId: assignedWorker.id,
            userId: user?.id,
            metadata: { source_ref: 'ralph_loop', ralph_loop: true, attachments: resolvedAttachments },
          });
          if (intakeResult?.status === 'duplicate') {
            appendMessagesToCurrentConversation([{
              role: 'ai',
              content: `A similar task already exists (${intakeResult.workOrder?.title || 'duplicate'}). Check the Task Board for details.`,
              timestamp: new Date().toISOString(),
            }]);
            setIsTyping(false); setStreamingContent(''); return;
          }
          // Use routed employee if intake routing picked a different worker
          if (intakeResult?.workOrder?.employee_id) {
            intakeEmployeeId = intakeResult.workOrder.employee_id;
          }
        } catch (intakeErr) {
          console.warn('[DSV] Ralph Loop intake normalization failed (non-blocking):', intakeErr?.message);
        }

        // Decompose the task
        const decomposition = await decomposeTask({
          userMessage: taskDescriptionWithAttachments,
          sessionContext: sessionCtx.context,
          userId: user?.id,
        });

        if (!decomposition?.subtasks?.length) {
          appendMessagesToCurrentConversation([{
            role: 'ai',
            content: 'Could not decompose this instruction into actionable tasks. Please try rephrasing.',
            timestamp: new Date().toISOString(),
          }]);
          setIsTyping(false); setStreamingContent(''); return;
        }

        // Build plan
        const inputData = buildTaskInputData(runtimeDatasetContext, resolvedAttachments);

        const steps = (decomposition.subtasks || []).map((s, i) => ({
          name: s.name || s.step_name || `step_${i}`,
          tool_hint: s.tool_hint || s.description || s.name,
          tool_type: s.workflow_type || s.tool_type || 'python_tool',
          builtin_tool_id: s.builtin_tool_id || null,
          review_checkpoint: s.review_checkpoint || false,
        }));

        const plan = {
          title: taskDescription.slice(0, 120),
          description: decomposition.original_instruction || taskDescriptionWithAttachments,
          steps,
          inputData,
          taskMeta: { source_type: 'chat', ralph_loop: true, attachments: resolvedAttachments },
          llmConfig: { provider: 'anthropic', model: 'claude-sonnet-4-6', temperature: 0.15, max_tokens: 4096 },
        };

        // Submit and start (use intake-routed employee)
        const { taskId } = await submitPlan(plan, intakeEmployeeId, user?.id);

        setAgentExecEvents([]);
        agentExecEventsRef.current = [];
        setAgentExecTaskTitle(`[Ralph] ${taskDescription.slice(0, 60)}`);
        setAgentExecPanelOpen(true);
        setAgentExecSSETaskId(taskId);

        const initLoopSteps = steps.map((s, i) => ({
          name: s.name, index: i, status: 'pending',
          workflow_type: s.tool_type, retry_count: 0,
        }));
        setAgentExecLoopState({ steps: initLoopSteps, started_at: new Date().toISOString() });

        appendMessagesToCurrentConversation([{
          role: 'ai',
          content: `**Ralph Loop** activated for: "${taskDescription}"\n\n${steps.length} step(s) planned. Running autonomously...\n\nType \`/ralph-stop\` to cancel.`,
          timestamp: new Date().toISOString(),
        }]);

        // Approve task — orchestrator detects ralph_loop flag and uses Ralph Loop
        await orchestratorApprovePlan(taskId, user?.id);
      } catch (err) {
        appendMessagesToCurrentConversation([{
          role: 'ai',
          content: `Ralph Loop failed: ${err?.message || 'Unknown error'}`,
          timestamp: new Date().toISOString(),
        }]);
      }
      setIsTyping(false); setStreamingContent(''); return;
    }

    if (command === '/email') {
      const emailContent = trimmed.slice('/email'.length).trim();
      if (!emailContent) {
        appendMessagesToCurrentConversation([{ role: 'ai', content: 'Usage: `/email <paste email content>` — I will extract action items and create work orders.', timestamp: new Date().toISOString() }]);
        setIsTyping(false); setStreamingContent(''); return;
      }
      try {
        const assignedWorker = await getAssignedWorker();
        if (!assignedWorker?.id) throw new Error('No worker available for email intake.');
        const lines = emailContent.split('\n');
        const subject = lines[0];
        const body = lines.slice(1).join('\n');
        const result = await processEmailIntake({
          rawHeaders: { subject, from: 'chat-paste', date: new Date().toISOString() },
          body,
          employeeId: assignedWorker.id,
          userId: user?.id,
        });
        const workOrders = result.work_orders || [];
        const actionItems = result.action_items || [];
        let summary = `Processed email intake: **${subject}**\n`;
        if (actionItems.length > 0) {
          summary += `\nDetected ${actionItems.length} action item(s):\n${actionItems.map((a, i) => `${i + 1}. ${a}`).join('\n')}`;
        }
        summary += `\n\nCreated ${workOrders.length} work order(s). Check the Task Board for details.`;
        appendMessagesToCurrentConversation([{ role: 'ai', content: summary, timestamp: new Date().toISOString() }]);
      } catch (err) {
        appendMessagesToCurrentConversation([{ role: 'ai', content: `Email intake failed: ${err?.message || 'Unknown error'}`, timestamp: new Date().toISOString() }]);
      }
      setIsTyping(false); setStreamingContent(''); return;
    }

    if (command === '/transcript') {
      const transcriptContent = trimmed.slice('/transcript'.length).trim();
      if (!transcriptContent) {
        appendMessagesToCurrentConversation([{ role: 'ai', content: 'Usage: `/transcript <paste meeting transcript>` — I will extract action items and create work orders.', timestamp: new Date().toISOString() }]);
        setIsTyping(false); setStreamingContent(''); return;
      }
      try {
        const assignedWorker = await getAssignedWorker();
        if (!assignedWorker?.id) throw new Error('No worker available for transcript intake.');
        const lines = transcriptContent.split('\n');
        const meetingTitle = lines[0];
        const transcript = lines.slice(1).join('\n') || lines[0];
        const result = await processTranscriptIntake({
          transcript,
          meetingTitle,
          employeeId: assignedWorker.id,
          userId: user?.id,
        });
        const workOrders = result.work_orders || [];
        const analysis = result.analysis || {};
        const actions = analysis.actions || [];
        const decisions = analysis.decisions || [];
        let summary = `Processed transcript: **${analysis.meeting_title || meetingTitle}**\n`;
        summary += `\nSpeakers: ${(analysis.speakers || []).join(', ') || 'Unknown'}`;
        if (actions.length > 0) {
          summary += `\n\nDetected ${actions.length} action item(s):\n${actions.map((a, i) => `${i + 1}. ${a.text}${a.owner ? ` (owner: ${a.owner})` : ''}${a.deadline ? ` [due: ${a.deadline}]` : ''}`).join('\n')}`;
        }
        if (decisions.length > 0) {
          summary += `\n\nDecisions:\n${decisions.map((d) => `- ${d.text}`).join('\n')}`;
        }
        summary += `\n\nCreated ${workOrders.length} work order(s). Check the Task Board for details.`;
        appendMessagesToCurrentConversation([{ role: 'ai', content: summary, timestamp: new Date().toISOString() }]);
      } catch (err) {
        appendMessagesToCurrentConversation([{ role: 'ai', content: `Transcript intake failed: ${err?.message || 'Unknown error'}`, timestamp: new Date().toISOString() }]);
      }
      setIsTyping(false); setStreamingContent(''); return;
    }

    // ── Build chat session context for copilot awareness ──
    const chatContext = buildChatSessionContext({
      pathname: location.pathname,
      sessionCtx: sessionCtx.context,
      canvasState: activeCanvasState,
      activeDataset: runtimeDatasetContext,
      baselineRunId: latestPlanRunId,
      userRole: 'planner',
    });

    // ── Text-to-Simulation: detect scenario descriptions → full bridge ──
    if (looksLikeScenario(messageText) && chatContext.baseline?.run_id) {
      try {
        const scenarioResult = await runScenarioFromChat({
          messageText,
          userId: user.id,
          baseRunId: chatContext.baseline.run_id,
          onProgress: ({ step, message }) => {
            console.log(`[DSV] Scenario ${step}: ${message}`);
          },
        });
        if (scenarioResult.messages.length > 0) {
          appendMessagesToCurrentConversation(scenarioResult.messages);
        }
        if (scenarioResult.scenarioRunId) {
          setLatestPlanRunId(scenarioResult.scenarioRunId);
        }
        setIsTyping(false); setStreamingContent(''); return;
      } catch (scenarioErr) {
        console.warn('[DSV] Scenario bridge failed, continuing to intent parser:', scenarioErr?.message);
      }
    }

    // ── Natural language analysis: intercept before AI Employee mode ─────
    // "analyze revenue trends", "分析營收" etc. should go through Olist analysis,
    // not the Digital Worker task decomposition pipeline.
    
    // 1. Check for Blueprint intent (broad/comprehensive)
    const BLUEPRINT_NL_RE = /\b(analyze this data|comprehensive analysis|full analysis|analysis plan|data blueprint|分析這份資料|全面分析|分析藍圖|數據分析規劃)\b/i;
    if (BLUEPRINT_NL_RE.test(trimmed)) {
      try {
        appendMessagesToCurrentConversation([{ role: 'ai', content: 'Generating analysis blueprint...', timestamp: new Date().toISOString() }]);
        const blueprint = await generateAnalysisBlueprint();
        appendMessagesToCurrentConversation([{
          role: 'ai',
          type: 'analysis_blueprint_card',
          payload: blueprint,
          timestamp: new Date().toISOString()
        }]);
      } catch (err) {
        appendMessagesToCurrentConversation([{ role: 'ai', content: `Blueprint generation failed: ${err.message}`, timestamp: new Date().toISOString() }]);
      }
      setIsTyping(false); setStreamingContent(''); return;
    }

    const directAnalysisInputData = buildTaskInputData(runtimeDatasetContext, resolvedAttachments);
    const hasUploadedAnalysisData = Boolean(
      directAnalysisInputData.sheets && Object.keys(directAnalysisInputData.sheets).length > 0
    );
    const directAnalysis = resolveDirectAnalysisRequest(trimmed, { hasUploadedData: hasUploadedAnalysisData });
    if (directAnalysis) {
      await runDirectAnalysisAgent({
        query: trimmed,
        history: updatedMessages,
        runtimeDatasetContext,
        attachments: resolvedAttachments,
        modelMode: baseModelMode,
      });
      setIsTyping(false); setStreamingContent(''); return;
    }

    // ── AI Employee mode: task decomposition is the PRIMARY path ──────────
    // All messages go through SmartOps intent parsing → agent loop (no AI Employee intercept).
    try {
      const parsedIntent = await parseIntent({ userMessage: messageTextWithAttachments, sessionContext: sessionCtx.context, domainContext: { ...domainContext, chatContext: buildContextSummaryForPrompt(chatContext) } });

      if (parsedIntent.intent !== 'GENERAL_CHAT' && parsedIntent.confidence > 0.7) {
        const intentHandlers = {
          executePlanFlow: (params) => executePlanFlow({ datasetProfileId: params.datasetProfileId || getDatasetProfileId(runtimeDatasetContext), constraintsOverride: params.constraintsOverride, objectiveOverride: params.objectiveOverride }),
          executeForecastFlow: (params) => executeForecastFlow({ datasetProfileId: params.datasetProfileId || getDatasetProfileId(runtimeDatasetContext) }),
          executeWorkflowAFlow: (params) => executeWorkflowAFlow({ datasetProfileId: params.datasetProfileId || getDatasetProfileId(runtimeDatasetContext) }),
          executeWorkflowBFlow: (params) => executeWorkflowBFlow({ datasetProfileId: params.datasetProfileId || getDatasetProfileId(runtimeDatasetContext) }),
          executeDigitalTwinFlow: (params) => executeDigitalTwinFlow({ scenario: params.scenario || 'normal', chaosIntensity: params.chaosIntensity || null }),
          handleParameterChange: async (intent, ctx) => {
            const result = await handleParameterChange({ parsedIntent: intent, sessionContext: ctx, userId: user?.id, conversationId: currentConversationId, rerunPlan: (params) => executePlanFlow({ datasetProfileId: getDatasetProfileId(runtimeDatasetContext), constraintsOverride: params.constraintsOverride, objectiveOverride: params.objectiveOverride }) });
            if (result?.comparison) { appendMessagesToCurrentConversation([{ role: 'ai', type: 'plan_comparison_card', payload: result.comparison, content: buildComparisonSummaryText(result.comparison), timestamp: new Date().toISOString() }]); }
          },
          comparePlans: (ctx) => {
            const comparison = handlePlanComparison(ctx);
            if (comparison) { appendMessagesToCurrentConversation([{ role: 'ai', type: 'plan_comparison_card', payload: comparison, content: buildComparisonSummaryText(comparison), timestamp: new Date().toISOString() }]); }
            else { appendMessagesToCurrentConversation([{ role: 'ai', content: 'No previous plan available for comparison. Run a plan first, then make changes to compare.', timestamp: new Date().toISOString() }]); }
          },
          queryData: async ({ userMessage }) => {
            const effectiveMessage = buildMessageWithAttachmentContext(userMessage || messageText, resolvedAttachments);
            const directInputData = buildTaskInputData(runtimeDatasetContext, resolvedAttachments);
            const hasUploadedQueryData = Boolean(
              directInputData?.sheets
              && Object.keys(directInputData.sheets).length > 0
            );

            if (hasUploadedQueryData) {
              await runDirectAnalysisAgent({
                query: effectiveMessage,
                history: updatedMessages,
                runtimeDatasetContext,
                attachments: resolvedAttachments,
                modelMode: baseModelMode,
              });
              return;
            }

            const sqlResult = await handleDataQuery(effectiveMessage);

            if (!sqlResult?.result?.success) {
              await runDirectAnalysisAgent({
                query: effectiveMessage,
                history: updatedMessages,
                runtimeDatasetContext,
                attachments: resolvedAttachments,
                modelMode: baseModelMode,
              });
              return;
            }

            appendMessagesToCurrentConversation([{
              role: 'ai',
              type: 'sql_query_result',
              payload: sqlResult,
              content: sqlResult.summary || '',
              timestamp: new Date().toISOString(),
            }]);
          },
          runWhatIf: () => { handleCanvasRun(messageTextWithAttachments, stagedMessages, runtimeDatasetContext); },
          handleApproval: async (action) => {
            const pending = (sessionCtx.context?.pending_approvals || []).filter((a) => a.status === 'PENDING');
            if (pending.length === 0) { appendMessagesToCurrentConversation([{ role: 'ai', content: 'No pending approvals found.', timestamp: new Date().toISOString() }]); return; }
            const approvalIds = pending.map((a) => a.approval_id);
            if (action === 'approve_all') {
              const results = await batchApprove({ approvalIds, userId: user?.id, note: 'Approved via chat' });
              const approved = (Array.isArray(results) ? results : []).filter((r) => r?.status === 'APPROVED');
              approved.forEach((result) => sessionCtx.resolveApproval(result.approval_id, 'APPROVED'));
              appendMessagesToCurrentConversation([{ role: 'ai', content: `Approved ${approved.length} pending approval(s).`, timestamp: new Date().toISOString() }]);
            }
            else if (action === 'reject_all') {
              const results = await batchReject({ approvalIds, userId: user?.id, note: 'Rejected via chat' });
              const rejected = (Array.isArray(results) ? results : []).filter((r) => r?.status === 'REJECTED');
              rejected.forEach((result) => sessionCtx.resolveApproval(result.approval_id, 'REJECTED'));
              appendMessagesToCurrentConversation([{ role: 'ai', content: `Rejected ${rejected.length} pending approval(s).`, timestamp: new Date().toISOString() }]);
            }
          },
          applyNegotiationOption: async ({ optionId, optionTitle }) => {
            const negCtx = sessionCtx.context?.negotiation;
            if (!negCtx || negCtx.round === 0 || !negCtx.options) { appendMessagesToCurrentConversation([{ role: 'ai', content: 'No active negotiation session. Please run a plan first to trigger negotiation options.', timestamp: new Date().toISOString() }]); return; }
            const optionDefs = negCtx.options?.options || [];
            let matchedOption = null;
            if (optionId) { const normalizedId = String(optionId).match(/^opt_\d+$/) ? optionId : `opt_${String(optionId).replace(/\D/g, '').padStart(3, '0')}`; matchedOption = optionDefs.find((o) => o.option_id === normalizedId); }
            if (!matchedOption && optionTitle) { const lowerTitle = optionTitle.toLowerCase(); matchedOption = optionDefs.find((o) => o.title.toLowerCase().includes(lowerTitle)); }
            if (!matchedOption && (optionTitle || '').toLowerCase().includes('recommend')) { const recommendedId = negCtx.report?.recommended_option_id; matchedOption = optionDefs.find((o) => o.option_id === recommendedId); }
            if (!matchedOption) { appendMessagesToCurrentConversation([{ role: 'ai', content: `Could not identify option "${optionId || optionTitle}". Available options: ${optionDefs.map((o) => `${o.option_id} ("${o.title}")`).join(', ')}`, timestamp: new Date().toISOString() }]); return; }
            const rankedOptions = negCtx.evaluation?.ranked_options || [];
            const evalResult = rankedOptions.find((r) => r.option_id === matchedOption.option_id) || null;
            await handleApplyNegotiationOption(matchedOption, evalResult, { planRunId: negCtx.active_plan_run_id });
          },
          assignTask: async ({ userMessage }) => {
            try {
              const effectiveMessage = buildMessageWithAttachmentContext(userMessage || messageText, resolvedAttachments);

              // ── Gate 1: Unified intake normalization ──
              const assignedWorker = await getAssignedWorker();
              if (!assignedWorker?.id) throw new Error('No worker available for task assignment.');
              let intakeWorkOrder = null;
              try {
                const intakeResult = await processIntake({
                  source: INTAKE_SOURCES.CHAT,
                  message: effectiveMessage,
                  employeeId: assignedWorker.id,
                  userId: user?.id,
                  metadata: { source_ref: 'assign_task_intent', attachments: resolvedAttachments },
                });
                intakeWorkOrder = intakeResult?.workOrder || null;
                if (intakeResult?.status === 'duplicate') {
                  appendMessagesToCurrentConversation([{ role: 'ai', content: `A similar task already exists (${intakeResult.workOrder?.title || 'duplicate'}). Check the Task Board for details.`, timestamp: new Date().toISOString() }]);
                  return;
                }
              } catch (intakeErr) {
                console.warn('[DSV] assignTask intake normalization failed (non-blocking):', intakeErr?.message);
              }

              // 1. Decompose user instruction into structured subtasks
              const decomposition = await decomposeTask({ userMessage: effectiveMessage, sessionContext: sessionCtx.context, userId: user?.id });

              if (!decomposition?.subtasks?.length) {
                appendMessagesToCurrentConversation([{ role: 'ai', content: 'Could not decompose this instruction into actionable tasks. Please try rephrasing.', timestamp: new Date().toISOString() }]);
                return;
              }

              // 2. Show TaskPlanCard for user approval
              appendMessagesToCurrentConversation([{
                role: 'ai',
                type: 'task_plan_card',
                payload: decomposition,
                content: `Task decomposed into ${decomposition.subtasks.length} step(s). Please review and approve.`,
                timestamp: new Date().toISOString(),
                _approveContext: {
                  title: intakeWorkOrder?.title || effectiveMessage.slice(0, 120),
                  description: decomposition.original_instruction || effectiveMessage,
                  source_type: intakeWorkOrder?.source || 'chat',
                  priority: intakeWorkOrder?.priority,
                  due_at: intakeWorkOrder?.sla?.due_at,
                  owner_hint: intakeWorkOrder?.owner_hint,
                  dedup_key: intakeWorkOrder?.dedup_key,
                },
                _onApprove: async (approvedDecomp) => {
                  try {
                    const inputData = buildTaskInputData(runtimeDatasetContext, resolvedAttachments);

                    const finalDecomp = approvedDecomp || decomposition;
                    const steps = (finalDecomp.subtasks || []).map((s, i) => ({
                      name: s.name || s.step_name || `step_${i}`,
                      tool_hint: s.tool_hint || s.description || s.name,
                      tool_type: s.workflow_type || s.tool_type || 'python_tool',
                      builtin_tool_id: s.builtin_tool_id || null,
                      input_args: s.input_args || {},
                      review_checkpoint: s.review_checkpoint || false,
                    }));

                    const plan = {
                      title: intakeWorkOrder?.title || effectiveMessage.slice(0, 120),
                      description: decomposition.original_instruction || effectiveMessage,
                      steps,
                      inputData,
                      taskMeta: intakeWorkOrder ? {
                        source_type: intakeWorkOrder.source,
                        priority: intakeWorkOrder.priority,
                        due_at: intakeWorkOrder.sla?.due_at,
                        owner_hint: intakeWorkOrder.owner_hint,
                        dedup_key: intakeWorkOrder.dedup_key,
                        attachments: resolvedAttachments,
                      } : { source_type: 'chat' },
                      llmConfig: { provider: 'anthropic', model: 'claude-sonnet-4-6', temperature: 0.15, max_tokens: 4096 },
                    };

                    const assignedWorker = await getAssignedWorker();
                    if (!assignedWorker?.id) {
                      throw new Error('No digital worker is available for this task.');
                    }

                    const { taskId } = await submitPlan(plan, assignedWorker.id, user?.id);

                    setAgentExecEvents([]);
                    agentExecEventsRef.current = [];
                    setAgentExecTaskTitle(effectiveMessage.slice(0, 80));
                    setAgentExecPanelOpen(true);
                    setAgentExecSSETaskId(taskId);

                    const initLoopSteps = steps.map((s, i) => ({
                      name: s.name, index: i, status: 'pending',
                      workflow_type: s.tool_type, retry_count: 0,
                    }));
                    setAgentExecLoopState({ steps: initLoopSteps, started_at: new Date().toISOString() });

                    appendMessagesToCurrentConversation([{
                      role: 'ai',
                      content: `Task created. Executing ${steps.length} steps via orchestrator...`,
                      timestamp: new Date().toISOString(),
                    }]);

                    await orchestratorApprovePlan(taskId, user?.id);
                  } catch (execErr) {
                    appendMessagesToCurrentConversation([{
                      role: 'ai',
                      content: `Task execution failed: ${execErr?.message || 'Unknown error'}`,
                      timestamp: new Date().toISOString(),
                    }]);
                  }
                },
              }]);
            } catch (decompErr) {
              appendMessagesToCurrentConversation([{
                role: 'ai',
                content: `Task decomposition failed: ${decompErr?.message || 'Unknown error'}`,
                timestamp: new Date().toISOString(),
              }]);
            }
          },
          appendMessage: (msg) => appendMessagesToCurrentConversation([msg]),
          onNoDataset: () => appendMessagesToCurrentConversation([{ role: 'ai', content: 'Please upload a dataset first. You can drag and drop a CSV or XLSX file into the chat.', timestamp: new Date().toISOString() }]),
        };

        const result = await routeIntent(parsedIntent, sessionCtx.context, intentHandlers, { userId: user?.id, conversationId: currentConversationId, datasetProfileId: getDatasetProfileId(runtimeDatasetContext) });
        if (result?.handled) { setIsTyping(false); setStreamingContent(''); return; }
      }
    } catch (intentError) { console.warn('[DSV] Intent parsing failed, falling through to chat:', intentError?.message); }

    // Fallback: legacy keyword-based execution intent
    const canExecute = Boolean(getDatasetProfileId(runtimeDatasetContext)) && isExecutionIntent(messageText);
    if (canExecute) {
      const handled = await handleCanvasRun(messageTextWithAttachments, stagedMessages, runtimeDatasetContext);
      setIsTyping(false); setStreamingContent('');
      if (handled) return;
    }

    const history = stagedMessages.slice(-10);
    let fullResult = '';
    let aiErrorPayload = null;
    let agentToolCalls = []; // track tool calls from agent loop
    let agentPayload = null;
    let completedThinkingTraceMessage = null;

    // --- "Still thinking" heartbeat: show dots every 12s if no chunks arrive ---
    let lastChunkAt = Date.now();
    const thinkingInterval = setInterval(() => {
      const silenceMs = Date.now() - lastChunkAt;
      if (silenceMs >= 12_000) {
        setStreamingContent((prev) => prev + (prev ? '\n' : '') + '💭 still thinking...');
        lastChunkAt = Date.now();
      }
    }, 4_000);

    // Decide: Agent mode (with tool calling) vs plain chat
    // Also use agent mode if recent conversation used tools (follow-up questions)
    const recentMessages = stagedMessages.slice(-5);
    const recentlyUsedTools = recentMessages.some((m) => m.type === 'agent_response');
    const agentCandidateInputData = buildTaskInputData(runtimeDatasetContext, resolvedAttachments);
    const thinkingPolicy = resolveChatThinkingPolicy(messageTextWithAttachments, {
      hasRecentToolUse: recentlyUsedTools,
      hasUploadedData: Boolean(
        agentCandidateInputData?.sheets
        && Object.keys(agentCandidateInputData.sheets).length > 0
      ),
      manualModeOverride: thinkingDirective.isDirective ? thinkingDirective.mode : currentConversationThinkingMode,
    });
    const useAgent = thinkingPolicy.mode === 'full';

    if (useAgent) {
      // ── Agent Loop: LLM can autonomously call DI tools ──
      chatAbortRef.current?.abort();
      chatAbortRef.current = new AbortController();
      clearThinkingSteps();
      try {
        const datasetProfileId = getDatasetProfileId(runtimeDatasetContext);
        let datasetProfileRow = null;
        if (datasetProfileId) {
          try { datasetProfileRow = await datasetProfilesService.getById(datasetProfileId); } catch { /* ok */ }
        }
        const answerContract = await resolveAgentAnswerContract({
          userMessage: messageTextWithAttachments,
          mode: 'default',
        });
        // Auto-promote to analysis mode when the answer contract indicates
        // a complex analysis need (comparison, diagnostic, trend, or multi-dimension)
        const effectiveMode = (
          answerContract?.task_type === 'comparison'
          || answerContract?.task_type === 'diagnostic'
          || answerContract?.task_type === 'trend'
          || (answerContract?.required_dimensions?.length >= 3)
          || (answerContract?.required_outputs?.some((o) => ['chart', 'table'].includes(o)))
        ) ? 'analysis' : 'default';
        const toolContext = {
          userId: user?.id,
          datasetProfileRow,
          datasetProfileId,
          datasetInputData: buildTaskInputData(runtimeDatasetContext, resolvedAttachments),
        };
        const baseStrategy = resolveAgentExecutionStrategy({
          userMessage: messageTextWithAttachments,
          answerContract,
          mode: effectiveMode,
          hasAttachments: resolvedAttachments.length > 0,
        });
        // When thinking is forced on, always run dual agent + judge
        const strategy = forceFullThinking
          ? { ...baseStrategy, dualGenerate: true, mustJudge: true, triggerReasons: [...baseStrategy.triggerReasons, 'forced_full_thinking'] }
          : baseStrategy;
        // Resolve modelMode: full > dual > single
        const modelMode = baseModelMode || (strategy.dualGenerate ? 'dual' : 'single');
        const resolveRoleConfig = (role, requestedMode) => getModelConfigResolution(role, requestedMode);
        const appendConfigNormalizationNotes = () => {
          consumeModelConfigNormalizationNotices().forEach((notice) => {
            appendAgentThinkingNote({
              agentKey: 'config',
              agentLabel: 'Model Config',
              agentTone: 'system',
              provider: '',
              model: '',
              status: 'completed',
            }, notice.message);
          });
        };

        const runAgentCandidatePass = async ({
          candidateId,
          label,
          tone,
          provider,
          model,
          configNormalized = false,
          agentMessage,
          userMessage,
          conversationHistory,
          toolContext,
          answerContract,
          mode,
          signal,
          streamToUser = false,
        }) => {
          const agentMeta = {
            agentKey: candidateId,
            agentLabel: label,
            agentTone: tone,
            provider,
            model,
          };

          const result = await runAgentLoop({
            message: agentMessage,
            conversationHistory,
            systemPrompt,
            toolContext,
            answerContract,
            callbacks: {
              onTextChunk: streamToUser ? (chunk) => {
                lastChunkAt = Date.now();
                setStreamingContent((prev) => prev + chunk);
              } : undefined,
              onToolCall: streamToUser ? ({ name }) => {
                lastChunkAt = Date.now();
                setStreamingContent((prev) => prev + `\n🔧 Calling tool: **${name}**...\n`);
              } : undefined,
              onToolResult: streamToUser ? ({ name, success, error }) => {
                lastChunkAt = Date.now();
                if (success) {
                  setStreamingContent((prev) => prev + `✅ **${name}** completed\n\n`);
                } else {
                  setStreamingContent((prev) => prev + `❌ **${name}** failed: ${error}\n\n`);
                }
              } : undefined,
              onThinking: (data) => {
                lastChunkAt = Date.now();
                appendThinkingStep({ ...data, ...agentMeta });
              },
            },
            signal,
            mode,
            agentProvider: provider,
            agentModel: model,
          });

          if (mode === 'analysis' && !hasSuccessfulAnalysisEvidence(result)) {
            throw createMissingEvidenceError(result);
          }

          const presentation = await buildAgentPresentationPayload({
            userMessage,
            toolCalls: result.toolCalls || [],
            finalAnswerText: result.text || '',
            mode,
            answerContract,
            forceCrossReview: strategy.mustJudge,
          });

          appendAgentThinkingNote(
            { ...agentMeta, status: 'completed' },
            presentation?.brief?.summary || presentation?.brief?.headline || result.text || `${label} completed.`,
          );

          return {
            candidateId,
            label,
            tone,
            provider: result?.provider || provider,
            model: result?.model || model,
            transport: result?.transport || null,
            recoveryAttempts: Array.isArray(result?.recoveryAttempts) ? result.recoveryAttempts : [],
            configNormalized: Boolean(configNormalized),
            result,
            presentation,
          };
        };

        const runSettledCandidatePass = async (config) => {
          const startedAt = new Date().toISOString();
          const startedMs = Date.now();
          const candidateController = createLinkedAbortController(chatAbortRef.current?.signal);

          try {
            const candidate = await runAgentCandidatePass({
              ...config,
              signal: candidateController.signal,
            });
            const finishedAt = new Date().toISOString();
            return {
              ...candidate,
              status: 'completed',
              startedAt,
              finishedAt,
              durationMs: Date.now() - startedMs,
              failedReason: null,
              failureCategory: null,
              failureMessage: null,
            };
          } catch (error) {
            const finishedAt = new Date().toISOString();
            const status = resolveCandidateFailureStatus(error);
            const failedReason = getCandidateFailureMessage(error);
            const failureCandidate = buildFailedCandidate({
              candidateId: config.candidateId,
              label: config.label,
              tone: config.tone,
              provider: config.provider,
              model: config.model,
              transport: null,
              status,
              failedReason,
              failureCategory: getCandidateFailureCategory(error),
              failureMessage: getCandidateFailureMessage(error),
              recoveryAttempts: getCandidateRecoveryAttempts(error),
              configNormalized: config.configNormalized,
              startedAt,
              finishedAt,
              durationMs: Date.now() - startedMs,
            });

            appendAgentThinkingNote({
              agentKey: config.candidateId,
              agentLabel: config.label,
              agentTone: config.tone,
              provider: config.provider,
              model: config.model,
              status,
            }, failureCandidate.failedReason);

            return failureCandidate;
          }
        };

        const buildCompetitivePayload = ({ winner = null, alternative = null, judgeDecision = null, candidates = [] }) => {
          const payloadCandidates = candidates.length > 0
            ? (winner
                ? [winner, ...candidates.filter((candidate) => candidate?.candidateId !== winner?.candidateId)]
                : candidates)
            : [winner, alternative].filter(Boolean);
          const winnerTrace = winner?.presentation?.trace || null;
          return {
            toolCalls: winner?.result?.toolCalls || [],
            brief: winner?.presentation?.brief || null,
            trace: winnerTrace || buildBlockedTrace(payloadCandidates),
            answerContract: winner?.presentation?.answerContract || answerContract || null,
            review: winner?.presentation?.review || null,
            qa: winner?.presentation?.qa || buildBlockedAgentQa(payloadCandidates),
            candidates: payloadCandidates.map((candidate) => ({
              candidateId: candidate.candidateId,
              label: candidate.label,
              provider: candidate.provider,
              model: candidate.model,
              tone: candidate.tone,
              status: candidate.status || 'completed',
              startedAt: candidate.startedAt || null,
              finishedAt: candidate.finishedAt || null,
              durationMs: Number.isFinite(candidate.durationMs) ? candidate.durationMs : null,
              failedReason: candidate.failedReason || null,
              failureCategory: candidate.failureCategory || null,
              failureMessage: candidate.failureMessage || null,
              recoveryAttempts: Array.isArray(candidate.recoveryAttempts) ? candidate.recoveryAttempts : [],
              configNormalized: Boolean(candidate.configNormalized),
              brief: candidate.presentation?.brief || null,
              trace: candidate.presentation?.trace || null,
              qa: candidate.presentation?.qa || null,
            })),
        judgeDecision: judgeDecision ? {
          ...judgeDecision,
          winnerLabel: winner?.label || '',
          winnerProvider: winner?.provider || '',
          winnerModel: winner?.model || '',
          triggerReasons: strategy?.triggerReasons || [],
        } : null,
        orchestration: {
          mode: (payloadCandidates.length > 1 || strategy?.dualGenerate) ? 'parallel_dual' : 'single',
          triggerReasons: strategy?.triggerReasons || [],
          candidates: payloadCandidates.map(buildOrchestrationCandidateMeta).filter(Boolean),
        },
      };
    };

        let selectedCandidate;
        let alternativeCandidate = null;
        let judgeDecision = null;
        let candidatePool = [];

        if (strategy.dualGenerate) {
          lastChunkAt = Date.now();
          setStreamingContent('🧠 Running primary agent...\n🧪 Running challenger agent...\n');
          const primaryModelConfig = resolveRoleConfig('primary', modelMode);
          const secondaryModelConfig = resolveRoleConfig('secondary', modelMode);
          appendConfigNormalizationNotes();
          const primaryConfig = {
            candidateId: 'primary',
            label: 'Primary Agent',
            tone: 'primary',
            provider: primaryModelConfig.provider,
            model: primaryModelConfig.model,
            configNormalized: primaryModelConfig.configNormalized,
            agentMessage: messageTextWithAttachments,
            userMessage: messageTextWithAttachments,
            conversationHistory: history,
            toolContext,
            answerContract,
            mode: effectiveMode,
          };
          const secondaryConfig = {
            candidateId: 'secondary',
            label: 'Challenger Agent',
            tone: 'secondary',
            provider: secondaryModelConfig.provider,
            model: secondaryModelConfig.model,
            configNormalized: secondaryModelConfig.configNormalized,
            agentMessage: `${messageTextWithAttachments}\n\n${buildChallengerInstruction({ answerContract, domainKey: detectDomain(messageTextWithAttachments).domainKey })}`,
            userMessage: messageTextWithAttachments,
            conversationHistory: history,
            toolContext,
            answerContract,
            mode: effectiveMode,
          };
          const [primarySettled, secondarySettled] = await Promise.allSettled([
            runSettledCandidatePass(primaryConfig),
            runSettledCandidatePass(secondaryConfig),
          ]);
          const primaryCandidate = primarySettled.status === 'fulfilled'
            ? primarySettled.value
            : buildFailedCandidate({
              candidateId: primaryConfig.candidateId,
              label: primaryConfig.label,
              tone: primaryConfig.tone,
              provider: primaryConfig.provider,
              model: primaryConfig.model,
              status: resolveCandidateFailureStatus(primarySettled.reason),
              failedReason: getCandidateFailureMessage(primarySettled.reason),
              failureCategory: getCandidateFailureCategory(primarySettled.reason),
              failureMessage: getCandidateFailureMessage(primarySettled.reason),
              recoveryAttempts: getCandidateRecoveryAttempts(primarySettled.reason),
              configNormalized: primaryConfig.configNormalized,
              startedAt: null,
              finishedAt: new Date().toISOString(),
              durationMs: null,
            });
          const secondaryCandidate = secondarySettled.status === 'fulfilled'
            ? secondarySettled.value
            : buildFailedCandidate({
              candidateId: secondaryConfig.candidateId,
              label: secondaryConfig.label,
              tone: secondaryConfig.tone,
              provider: secondaryConfig.provider,
              model: secondaryConfig.model,
              status: resolveCandidateFailureStatus(secondarySettled.reason),
              failedReason: getCandidateFailureMessage(secondarySettled.reason),
              failureCategory: getCandidateFailureCategory(secondarySettled.reason),
              failureMessage: getCandidateFailureMessage(secondarySettled.reason),
              recoveryAttempts: getCandidateRecoveryAttempts(secondarySettled.reason),
              configNormalized: secondaryConfig.configNormalized,
              startedAt: null,
              finishedAt: new Date().toISOString(),
              durationMs: null,
            });
          const settledCandidates = [primaryCandidate, secondaryCandidate];
          candidatePool = settledCandidates;

          lastChunkAt = Date.now();
          setStreamingContent((prev) => `${prev}\n${primaryCandidate.status === 'completed' ? '✅' : '❌'} Primary agent ${primaryCandidate.status === 'completed' ? 'completed' : primaryCandidate.status === 'timed_out' ? 'timed out' : 'failed'}\n${secondaryCandidate.status === 'completed' ? '✅' : '❌'} Challenger agent ${secondaryCandidate.status === 'completed' ? 'completed' : secondaryCandidate.status === 'timed_out' ? 'timed out' : 'failed'}\n`);

          const completedCandidates = settledCandidates.filter((candidate) => candidate.status === 'completed');

          if (completedCandidates.length === 2) {
            lastChunkAt = Date.now();
            setStreamingContent((prev) => prev + '\n⚖️ Running judge...\n');
            judgeDecision = await judgeAgentCandidates({
              userMessage: messageTextWithAttachments,
              answerContract,
              primaryCandidate,
              secondaryCandidate,
              modelMode,
            });

            appendAgentThinkingNote({
              agentKey: 'judge',
              agentLabel: 'Judge',
              agentTone: 'judge',
              provider: judgeDecision?.reviewer?.provider || '',
              model: judgeDecision?.reviewer?.model || '',
              transport: judgeDecision?.reviewer?.transport || null,
              status: 'completed',
            }, [judgeDecision?.summary, ...(judgeDecision?.rationale || [])].filter(Boolean).join('\n'));

            const judgedWinner = settledCandidates.find((candidate) =>
              candidate?.candidateId === judgeDecision?.winnerCandidateId && candidate?.status === 'completed'
            );
            selectedCandidate = judgedWinner || completedCandidates[0];
            alternativeCandidate = settledCandidates.find((candidate) => candidate?.candidateId !== selectedCandidate?.candidateId) || null;
          } else if (completedCandidates.length === 1) {
            selectedCandidate = completedCandidates[0];
            alternativeCandidate = settledCandidates.find((candidate) => candidate?.candidateId !== selectedCandidate?.candidateId) || null;
            appendAgentThinkingNote({
              agentKey: 'judge',
              agentLabel: 'Judge',
              agentTone: 'judge',
              provider: 'orchestrator',
              model: 'skipped',
              transport: 'orchestrator',
              status: 'failed',
            }, 'Judge skipped because only one candidate produced usable evidence.');
          } else {
            judgeDecision = {
              winnerCandidateId: null,
              summary: 'Both candidate runs failed before producing a valid answer.',
              rationale: settledCandidates.map((candidate) => `${candidate.label}: ${candidate.failedReason || 'Unknown error'}`),
              loserIssues: [],
              confidence: 0,
              reviewer: {
                provider: 'orchestrator',
                model: 'parallel_dual',
                transport: 'orchestrator',
              },
              degraded: true,
            };
            appendAgentThinkingNote({
              agentKey: 'judge',
              agentLabel: 'Judge',
              agentTone: 'judge',
              provider: 'orchestrator',
              model: 'parallel_dual',
              transport: 'orchestrator',
              status: 'failed',
            }, judgeDecision.summary);
            selectedCandidate = null;
            alternativeCandidate = null;
          }
        } else {
          // ── Single agent path (with auto-escalation to dual if data tools used) ──
          const primaryModelConfig = resolveRoleConfig('primary', modelMode);
          appendConfigNormalizationNotes();
          selectedCandidate = await runSettledCandidatePass({
            candidateId: 'primary',
            label: 'Primary Agent',
            tone: 'primary',
            provider: primaryModelConfig.provider,
            model: primaryModelConfig.model,
            configNormalized: primaryModelConfig.configNormalized,
            agentMessage: messageTextWithAttachments,
            userMessage: messageTextWithAttachments,
            conversationHistory: history,
            toolContext,
            answerContract,
            mode: effectiveMode,
            streamToUser: true,
          });
          candidatePool = [selectedCandidate];

          // ── Auto-escalation: if single agent used data/analysis tools, launch challenger + judge ──
          const dataToolNames = new Set(ANALYSIS_AGENT_TOOL_IDS);
          const usedDataTools = selectedCandidate?.status === 'completed' && (selectedCandidate?.result?.toolCalls || []).some(
            (tc) => dataToolNames.has(tc?.name)
          );

          if (usedDataTools && !chatAbortRef.current?.signal?.aborted) {
            lastChunkAt = Date.now();
            setStreamingContent((prev) => prev + '\n🔄 Data tools detected — escalating to dual agent + judge...\n🧪 Running challenger agent...\n');
            appendAgentThinkingNote({
              agentKey: 'escalation',
              agentLabel: 'Auto-Escalation',
              agentTone: 'system',
              provider: '',
              model: '',
            }, 'Primary agent used data tools — launching challenger for quality verification.');

            const dualModelMode = 'dual';
            const challengerModelConfig = resolveRoleConfig('secondary', dualModelMode);
            appendConfigNormalizationNotes();
            const challengerConfig = {
              candidateId: 'secondary',
              label: 'Challenger Agent',
              tone: 'secondary',
              provider: challengerModelConfig.provider,
              model: challengerModelConfig.model,
              configNormalized: challengerModelConfig.configNormalized,
              agentMessage: `${messageTextWithAttachments}\n\n${buildChallengerInstruction({ answerContract, domainKey: detectDomain(messageTextWithAttachments).domainKey, primaryBrief: selectedCandidate?.presentation?.brief })}`,
              userMessage: messageTextWithAttachments,
              conversationHistory: history,
              toolContext,
              answerContract,
              mode: effectiveMode,
            };
            const challengerResult = await runSettledCandidatePass(challengerConfig);

            lastChunkAt = Date.now();
            setStreamingContent((prev) => `${prev}${challengerResult.status === 'completed' ? '✅' : '❌'} Challenger agent ${challengerResult.status === 'completed' ? 'completed' : challengerResult.status === 'timed_out' ? 'timed out' : 'failed'}\n`);

            candidatePool = [selectedCandidate, challengerResult];

            const completedCandidates = candidatePool.filter((candidate) => candidate?.status === 'completed');

            if (completedCandidates.length === 2) {
              lastChunkAt = Date.now();
              setStreamingContent((prev) => prev + '\n⚖️ Running judge...\n');
              judgeDecision = await judgeAgentCandidates({
                userMessage: messageTextWithAttachments,
                answerContract,
                primaryCandidate: selectedCandidate,
                secondaryCandidate: challengerResult,
                modelMode: dualModelMode,
              });

              appendAgentThinkingNote({
                agentKey: 'judge',
                agentLabel: 'Judge',
                agentTone: 'judge',
                provider: judgeDecision?.reviewer?.provider || '',
                model: judgeDecision?.reviewer?.model || '',
              }, judgeDecision?.summary || 'Judge completed.');

              const judgedWinner = candidatePool.find((c) =>
                c?.candidateId === judgeDecision?.winnerCandidateId && c?.status === 'completed'
              );
              selectedCandidate = judgedWinner || selectedCandidate;
              alternativeCandidate = candidatePool.find((c) => c?.candidateId !== selectedCandidate?.candidateId) || null;
            } else if (completedCandidates.length === 1) {
              selectedCandidate = completedCandidates[0];
              alternativeCandidate = candidatePool.find((c) => c?.candidateId !== selectedCandidate?.candidateId) || null;
              appendAgentThinkingNote({
                agentKey: 'judge',
                agentLabel: 'Judge',
                agentTone: 'judge',
                provider: 'orchestrator',
                model: 'skipped',
                transport: 'orchestrator',
                status: 'failed',
              }, 'Judge skipped because only one candidate produced usable evidence.');
            }
          }
        }

        fullResult = selectedCandidate?.result?.text || judgeDecision?.summary || selectedCandidate?.failedReason || '';
        agentToolCalls = selectedCandidate?.result?.toolCalls || [];
        agentPayload = buildCompetitivePayload({
          winner: selectedCandidate,
          alternative: alternativeCandidate,
          judgeDecision,
          candidates: candidatePool,
        });
        completedThinkingTraceMessage = buildThinkingTraceMessage();
        clearThinkingSteps();

        // ── Auto-Tool-Creation: if agent detected a gap and generated a blueprint ──
        if (selectedCandidate?.result?.blueprint) {
          const blueprint = selectedCandidate.result.blueprint;
          const originalMsg = messageTextWithAttachments;

          // Add a tool_blueprint_card message for user approval
          const blueprintMessage = {
            role: 'ai',
            type: 'tool_blueprint_card',
            payload: blueprint,
            timestamp: new Date().toISOString(),
            _originalMessage: originalMsg,
            _onApprove: async (bp) => {
              try {
                // 1. Register the tool
                const tool = await registerTool({
                  name: bp.name,
                  description: bp.description,
                  category: bp.category || 'transform',
                  code: bp.code,
                  inputSchema: bp.inputSchema || {},
                  outputSchema: bp.outputSchema || {},
                  approvedBy: user?.id,
                  tags: bp.tags || [],
                });

                // 2. Approve it (sets quality_score so findToolByHint can find it)
                await approveTool(tool.id, user?.id, 0.85);

                // 3. Invalidate cache so the tool shows up in next agent loop
                await invalidateRegisteredToolsCache();

                // 4. Notify user
                appendMessagesToCurrentConversation([
                  {
                    role: 'ai',
                    content: `✅ Tool **${bp.name}** has been registered and approved. Retrying your original request...`,
                    timestamp: new Date().toISOString(),
                  },
                ]);

                // 5. Retry the original message (which will now find the registered tool)
                // Small delay to let the UI update
                setTimeout(() => {
                  const inputEl = document.querySelector('[data-chat-input]');
                  if (inputEl) {
                    // Trigger re-send via the input
                    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                      window.HTMLTextAreaElement.prototype, 'value'
                    )?.set;
                    nativeInputValueSetter?.call(inputEl, originalMsg);
                    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                  }
                }, 500);
              } catch (err) {
                console.error('[DSV] Tool registration failed:', err);
                appendMessagesToCurrentConversation([
                  {
                    role: 'ai',
                    content: `❌ Failed to register tool: ${err.message}`,
                    timestamp: new Date().toISOString(),
                  },
                ]);
              }
            },
            _onReject: () => {
              appendMessagesToCurrentConversation([
                {
                  role: 'ai',
                  content: '🚫 Tool blueprint rejected. You can ask me to try a different approach.',
                  timestamp: new Date().toISOString(),
                },
              ]);
            },
          };

          // Replace the normal AI message with the blueprint card
          clearInterval(thinkingInterval);
          setStreamingContent('');
          setIsTyping(false);
          const stagedWithBlueprint = [
            ...stagedMessages,
            ...(completedThinkingTraceMessage ? [completedThinkingTraceMessage] : []),
            // Include any partial agent text as a regular message
            ...(fullResult ? [{
              role: 'ai',
              type: 'agent_response',
              content: fullResult,
              payload: agentPayload || { toolCalls: agentToolCalls },
              timestamp: new Date().toISOString(),
            }] : []),
            blueprintMessage,
          ];
          const conversationTitleSeed = trimmedVisibleInput || messageTextWithAttachments;
          const newTitle = currentMessages.length <= 1 ? conversationTitleSeed.slice(0, 50) : currentConversation.title;
          const updatedConversation = { ...currentConversation, title: newTitle, messages: stagedWithBlueprint, updated_at: new Date().toISOString() };
          setConversations((prev) => prev.map((c) => c.id === currentConversationId ? updatedConversation : c));
          return; // Skip the normal message flow below
        }
      } catch (error) {
        console.error('[DSV] Agent loop failed:', error);
        if (isApiKeyConfigError(error?.message)) {
          aiErrorPayload = { title: 'AI service configuration required', message: 'Server-side AI keys are missing or invalid. Ask an admin to set Supabase Edge Function secrets.', ctaLabel: 'Show setup hint' };
        } else {
          fullResult = `❌ AI agent error: ${error.message}`;
        }
      } finally {
        clearInterval(thinkingInterval);
        // Refresh accumulated insights after agent loop (insights may have been added)
        import('../../services/dataInsightService.js')
          .then(({ getInsights }) => { const all = getInsights(); if (all.length > 0) setDataInsights(all); })
          .catch(() => {});
      }
    } else {
      // ── Plain chat: simple text-in, text-out ──
      if (thinkingPolicy.mode === 'light') {
        thinkingStepsRef.current = thinkingPolicy.steps || [];
        setThinkingSteps(thinkingPolicy.steps || []);
      } else {
        clearThinkingSteps();
      }

      const attemptChat = async (retryCount = 0) => {
        chatAbortRef.current?.abort();
        chatAbortRef.current = new AbortController();
        try {
          return await streamChatWithAI(messageTextWithAttachments, history, systemPrompt, (chunk) => {
            lastChunkAt = Date.now();
            setStreamingContent((prev) => prev + chunk);
          }, { signal: chatAbortRef.current.signal });
        } catch (error) {
          const isTimeout = error?.name === 'AbortError' || /timed?\s*out/i.test(error?.message);
          if (isTimeout && retryCount < 1) {
            console.warn('[DSV] Chat timed out, retrying once...');
            setStreamingContent((prev) => prev + '\n⏱️ Request timed out, retrying...\n');
            return attemptChat(retryCount + 1);
          }
          throw error;
        }
      };

      try {
        fullResult = await attemptChat();
      } catch (error) {
        console.error('AI call failed:', error);
        if (isApiKeyConfigError(error?.message)) { aiErrorPayload = { title: 'AI service configuration required', message: 'Server-side AI keys are missing or invalid. Ask an admin to set Supabase Edge Function secrets.', ctaLabel: 'Show setup hint' }; }
        else { fullResult = `❌ AI service temporarily unavailable\n\nError: ${error.message}`; }
      } finally {
        clearInterval(thinkingInterval);
      }
    }

    if (!aiErrorPayload && isApiKeyConfigError(fullResult)) {
      aiErrorPayload = { title: 'AI service configuration required', message: 'Server-side AI keys are missing or invalid. Ask an admin to set Supabase Edge Function secrets.', ctaLabel: 'Show setup hint' };
    }

    const _llmMeta = getLastUsedModel();
    const aiMessage = aiErrorPayload
      ? { role: 'ai', type: 'ai_error_card', payload: aiErrorPayload, timestamp: new Date().toISOString() }
      : agentToolCalls.length > 0
        ? { role: 'ai', type: 'agent_response', content: fullResult, payload: agentPayload || { toolCalls: agentToolCalls }, timestamp: new Date().toISOString(), meta: { model: _llmMeta.model, provider: _llmMeta.provider } }
        : { role: 'ai', content: fullResult, timestamp: new Date().toISOString(), meta: { model: _llmMeta.model, provider: _llmMeta.provider } };
    if (!completedThinkingTraceMessage) {
      completedThinkingTraceMessage = buildThinkingTraceMessage();
    }
    clearThinkingSteps();
    const finalMessages = [...stagedMessages, ...(completedThinkingTraceMessage ? [completedThinkingTraceMessage] : []), aiMessage];
    const conversationTitleSeed = trimmedVisibleInput || resolvedAttachments[0]?.file_name || messageText;
    const newTitle = currentMessages.length <= 1 ? conversationTitleSeed.slice(0, 50) : currentConversation.title;
    const updatedConversation = { ...currentConversation, title: newTitle, messages: finalMessages, updated_at: new Date().toISOString() };
    setConversations((prev) => prev.map((c) => c.id === currentConversationId ? updatedConversation : c));
    setStreamingContent(''); setIsTyping(false);

      if (conversationsDb) { conversationsDb.from('conversations').update({ title: newTitle, messages: finalMessages, updated_at: new Date().toISOString() }).eq('id', currentConversationId).eq('user_id', user.id).then(({ error }) => { if (error) markTableUnavailable(); }); }
    } catch (error) {
      console.error('[DSV] handleSend failed:', error);
      appendMessagesToCurrentConversation([{ role: 'ai', content: `❌ Request failed: ${getErrorMessage(error, 'Unexpected error')}`, timestamp: new Date().toISOString() }]);
    } finally {
      setIsTyping(false); setStreamingContent('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, pendingAttachments, currentConversationId, currentMessages, currentConversation, systemPrompt, user?.id, activeDatasetContext, handleCanvasRun, appendMessagesToCurrentConversation, executeForecastFlow, executePlanFlow, executeWorkflowFlow, executeWorkflowAFlow, executeWorkflowBFlow, executeDigitalTwinFlow, handleRunTopology, topologyRunId, setConversations, setConversationDatasetContext, setLatestPlanRunId, getAssignedWorker, getDatasetProfileId, buildTaskInputData, buildMessageWithAttachmentContext, resolveAttachmentsForSend, runDirectAnalysisAgent, appendThinkingStep, buildThinkingTraceMessage, clearThinkingSteps, currentConversationThinkingMode]);

  const handleKeyDown = useCallback((e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(e); } }, [handleSend]);

  const handleTextareaChange = useCallback((e) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, []);

  const formatTime = (timestamp) => {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
    return date.toLocaleDateString();
  };

  const runningWorkflowProfileIds = useMemo(() => {
    const index = {};
    Object.keys(workflowExec.activeWorkflowRuns || {}).forEach((runId) => {
      const numericRunId = Number(runId);
      const snapshot = workflowExec.workflowSnapshots[numericRunId] || workflowExec.workflowSnapshots[runId];
      const profileId = snapshot?.run?.dataset_profile_id;
      if (profileId) index[profileId] = true;
    });
    return index;
  }, [workflowExec.activeWorkflowRuns, workflowExec.workflowSnapshots]);

  const contextBadge = useMemo(() => {
    if (contextLoading) return { text: 'Loading context...', color: 'bg-yellow-100 text-yellow-700' };
    if (!domainContext) return { text: 'No context', color: 'bg-slate-100 text-slate-500' };
    const parts = [];
    if (domainContext.riskItems.length > 0) parts.push(`${domainContext.riskItems.length} risks`);
    if (domainContext.suppliers) parts.push(`${domainContext.suppliers} suppliers`);
    if (domainContext.materials) parts.push(`${domainContext.materials} materials`);
    if (activeDatasetContext?.dataset_profile_id) parts.push(`profile #${activeDatasetContext.dataset_profile_id}`);
    if (parts.length === 0) return { text: 'Context ready', color: 'bg-green-100 text-green-700' };
    return { text: parts.join(' | '), color: 'bg-green-100 text-green-700' };
  }, [domainContext, contextLoading, activeDatasetContext]);

  const aiEmployeeComposerStatus = useMemo(() => {
    if (!isAIEmployeeMode) return null;
    if (isUploadingDataset) {
      return {
        text: uploadStatusText || 'Processing workbook...',
        tone: 'info',
      };
    }
    if (agentExecPanelOpen && agentExecLoopState?.steps?.length) {
      const runningStep = agentExecLoopState.steps.find((step) => step.status === 'running');
      return {
        text: runningStep ? `Worker is running: ${runningStep.name}` : 'Worker is executing the current task',
        tone: 'warning',
      };
    }
    if (pendingAttachments.length > 0) {
      return {
        text: `${pendingAttachments.length} file${pendingAttachments.length !== 1 ? 's' : ''} ready to send`,
        tone: 'neutral',
      };
    }
    if (activeDatasetContext?.fileName) {
      return {
        text: `Attached dataset: ${activeDatasetContext.fileName}`,
        tone: 'neutral',
      };
    }
    if (contextLoading) {
      return {
        text: 'Loading workspace context...',
        tone: 'info',
      };
    }
    return {
      text: 'Upload a dataset or describe the task you want the worker to handle.',
      tone: 'neutral',
    };
  }, [
    isAIEmployeeMode,
    isUploadingDataset,
    uploadStatusText,
    agentExecPanelOpen,
    agentExecLoopState,
    pendingAttachments,
    activeDatasetContext,
    contextLoading,
  ]);

  useEffect(() => {
    if (!isAIEmployeeMode) return;
    const nextOpen = Boolean(agentExecPanelOpen);
    if (nextOpen && !prevAIExecOpenRef.current) {
      setAiEmployeeDrawer('execution');
    } else if (!nextOpen && prevAIExecOpenRef.current) {
      setAiEmployeeDrawer((current) => (current === 'execution' ? null : current));
    }
    prevAIExecOpenRef.current = nextOpen;
  }, [agentExecPanelOpen, isAIEmployeeMode]);

  useEffect(() => {
    if (!isAIEmployeeMode) return;
    const nextOpen = Boolean(activeCanvasState?.isOpen);
    if (nextOpen && !prevAICanvasOpenRef.current) {
      setAiEmployeeDrawer((current) => (current === 'execution' ? current : 'artifacts'));
    } else if (!nextOpen && prevAICanvasOpenRef.current) {
      setAiEmployeeDrawer((current) => (current === 'artifacts' ? null : current));
    }
    prevAICanvasOpenRef.current = nextOpen;
  }, [activeCanvasState?.isOpen, isAIEmployeeMode]);

  const handleConfigureApiKey = useCallback(() => {
    addNotification?.('AI keys are now managed in Supabase Edge Function secrets (GEMINI_API_KEY / DEEPSEEK_API_KEY).', 'info');
  }, [addNotification]);

  // ── Message card rendering via extracted component ──────────────────────
  const renderSpecialMessage = useCallback((message) => {
    const handlers = {
      handleUseDatasetContextFromCard, executeForecastFlow, executeWorkflowAFlow, executeWorkflowBFlow,
      executePlanFlow, executeRiskAwarePlanFlow, handleResumeWorkflowA, handleReplayWorkflowA,
      handleCancelAsyncWorkflow, handleBlockingQuestionsSubmit, handleSubmitBlockingAnswers,
      handleRequestRelax, handleRequestPlanApproval: planExec.handleRequestPlanApproval,
      handleApprovePlanApproval: planExec.handleApprovePlanApproval, handleRejectPlanApproval: planExec.handleRejectPlanApproval,
      handleContractConfirmation, handleApplyReuseSuggestion, handleReviewReuseSuggestion,
      handleRiskReplanDecision: planExec.handleRiskReplanDecision, handleConfigureApiKey,
      handleGenerateNegotiationOptions, handleApplyNegotiationOption, handleNegotiationAction, updateCanvasState, sessionCtx, batchApprove, batchReject,
      handleRunBlueprintModule, handleRunAllBlueprintModules,
      handleTaskPlanApprove: async (approvedDecomp, message) => {
        try {
          const ctx = message?._approveContext || {};
          const decomp = approvedDecomp || message?.payload;
          if (!decomp?.subtasks?.length) {
            addNotification?.('No task plan to approve.', 'error');
            return;
          }
          const inputData = buildTaskInputData(activeDatasetContext, []);
          const steps = (decomp.subtasks || []).map((s, i) => ({
            name: s.name || s.step_name || `step_${i}`,
            tool_hint: s.tool_hint || s.description || s.name,
            tool_type: s.workflow_type || s.tool_type || 'python_tool',
            builtin_tool_id: s.builtin_tool_id || null,
            input_args: s.input_args || {},
            review_checkpoint: s.review_checkpoint || false,
          }));
          const plan = {
            title: ctx.title || decomp.original_instruction?.slice(0, 120) || 'Untitled task',
            description: ctx.description || decomp.original_instruction || '',
            steps,
            inputData,
            taskMeta: {
              source_type: ctx.source_type || 'chat',
              ...(ctx.priority && { priority: ctx.priority }),
              ...(ctx.due_at && { due_at: ctx.due_at }),
              ...(ctx.owner_hint && { owner_hint: ctx.owner_hint }),
              ...(ctx.dedup_key && { dedup_key: ctx.dedup_key }),
            },
            llmConfig: { provider: 'anthropic', model: 'claude-sonnet-4-6', temperature: 0.15, max_tokens: 4096 },
          };
          const assignedWorker = await getAssignedWorker();
          if (!assignedWorker?.id) throw new Error('No digital worker is available for this task.');
          const { taskId } = await submitPlan(plan, assignedWorker.id, user?.id);
          setAgentExecEvents([]);
          agentExecEventsRef.current = [];
          setAgentExecTaskTitle((ctx.title || '').slice(0, 80));
          setAgentExecPanelOpen(true);
          setAgentExecSSETaskId(taskId);
          const initLoopSteps = steps.map((s, i) => ({
            name: s.name, index: i, status: 'pending',
            workflow_type: s.tool_type, retry_count: 0,
          }));
          setAgentExecLoopState({ steps: initLoopSteps, started_at: new Date().toISOString() });
          appendMessagesToCurrentConversation([{
            role: 'ai',
            content: `Task created. Executing ${steps.length} steps via orchestrator...`,
            timestamp: new Date().toISOString(),
          }]);
          await orchestratorApprovePlan(taskId, user?.id);
        } catch (execErr) {
          console.error('[DSV] Task plan approve from cache failed:', execErr);
          appendMessagesToCurrentConversation([{
            role: 'ai',
            content: `Task execution failed: ${execErr?.message || 'Unknown error'}`,
            timestamp: new Date().toISOString(),
          }]);
        }
      },
      handleSaveToToolLibrary: (tool) => {
        addNotification?.(`Tool "${tool?.name || tool?.id || 'unknown'}" saved to library.`, 'success');
      },
      handleDecisionReviewResolution: async (resolution) => {
        try {
          const task = { id: resolution.task_id, status: 'review_hold' };
          await resolveReviewDecision(task, {
            userId: user?.id || 'current_user',
            decision: resolution.decision,
            comment: resolution.review_notes || null,
          });
          addNotification?.(`Review decision "${resolution.decision}" submitted.`, 'success');
        } catch (err) {
          console.error('[DSV] Decision review resolution failed:', err);
          addNotification?.(`Review failed: ${err.message}`, 'error');
        }
      },
      onDeepDive: (deepDiveItem) => {
        // Deep dive button clicked — inject the query as user input
        if (deepDiveItem?.query) {
          setInput(deepDiveItem.query);
          // Auto-submit after a tick
          setTimeout(() => {
            const form = document.querySelector('[data-chat-form]');
            if (form) form.dispatchEvent(new Event('submit', { bubbles: true }));
          }, 100);
        }
      },
      handleDecisionBundleAction: (actionId) => {
        const intentMapping = resolveActionToIntent(actionId, buildChatSessionContext({ pathname: location.pathname, sessionCtx: sessionCtx?.context ?? null, canvasState: activeCanvasState, activeDataset: activeDatasetContext, baselineRunId: latestPlanRunId, userRole: 'planner' }));
        if (intentMapping) {
          const syntheticInput = `${intentMapping.intent} ${JSON.stringify(intentMapping.entities || {})}`;
          setInput(syntheticInput);
        }
      },
    };

    const state = {
      activeDatasetContext, currentConversationId, conversationDatasetContext,
      runningForecastProfiles: forecastExec.runningForecastProfiles, runningPlanKeys: planExec.runningPlanKeys,
      runningWorkflowProfileIds, workflowSnapshots: workflowExec.workflowSnapshots,
      isNegotiationGenerating, user, _rawRowsCache,
    };

    return <MessageCardRenderer message={message} handlers={handlers} state={state} />;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeDatasetContext, currentConversationId, handleConfigureApiKey,
    planExec.handleApprovePlanApproval, planExec.handleRejectPlanApproval, planExec.handleRequestPlanApproval,
    handleContractConfirmation, handleUseDatasetContextFromCard, updateCanvasState,
    executeForecastFlow, executePlanFlow, executeWorkflowAFlow, executeWorkflowBFlow,
    forecastExec.runningForecastProfiles, planExec.runningPlanKeys, runningWorkflowProfileIds,
    workflowExec.workflowSnapshots, handleResumeWorkflowA, handleReplayWorkflowA,
    handleBlockingQuestionsSubmit, handleSubmitBlockingAnswers, handleCancelAsyncWorkflow,
    handleApplyReuseSuggestion, handleReviewReuseSuggestion, executeRiskAwarePlanFlow,
    planExec.handleRiskReplanDecision, handleRequestRelax, isNegotiationGenerating,
    handleGenerateNegotiationOptions, handleApplyNegotiationOption, handleNegotiationAction
  ]);

  const aiEmployeeHasArtifacts = Boolean(
    activeCanvasState?.run
    || (activeCanvasState?.logs || []).length > 0
    || (activeCanvasState?.downloads || []).length > 0
    || activeCanvasState?.codeText
    || (effectiveCanvasChartPayload?.actual_vs_forecast || []).length > 0
    || (effectiveCanvasChartPayload?.inventory_projection || []).length > 0
    || (effectiveCanvasChartPayload?.cost_breakdown || []).length > 0
    || effectiveCanvasChartPayload?.topology_graph
  );

  const aiEmployeeTitle = currentConversation
    ? currentMessages.length <= 1 && currentConversation.title === 'New Conversation'
      ? 'Chat with your worker'
      : currentConversation.title
    : 'Digital Worker';

  const delegatedWorkerName = delegatedWorker?.name || activeWorkerLabel || (activeWorkerId ? 'Selected Worker' : 'Digital Worker');

  const aiEmployeeSubtitle = activeDatasetContext?.fileName
    ? `Delegating to ${delegatedWorkerName} · Dataset: ${activeDatasetContext.fileName}`
    : agentExecTaskTitle
      ? `Delegating to ${delegatedWorkerName} · Live task: ${agentExecTaskTitle}`
      : `Delegating to ${delegatedWorkerName}`;

  let aiEmployeeSecondaryPanel = null;
  if (isAIEmployeeMode && aiEmployeeDrawer === 'profile') {
    aiEmployeeSecondaryPanel = {
      title: 'Worker Profile',
      description: 'Skills, recent tasks, and current workload.',
      onClose: closeAIEmployeeProfile,
      content: (
        <div className="h-full overflow-y-auto">
          <EmployeeProfilePanel userId={user?.id} employeeId={delegatedWorker?.id || activeWorkerId || null} />
        </div>
      ),
    };
  } else if (isAIEmployeeMode && aiEmployeeDrawer === 'execution') {
    aiEmployeeSecondaryPanel = {
      title: 'Live Execution',
      description: agentExecTaskTitle || 'Current task orchestration and step trace.',
      onClose: closeAIEmployeeExecution,
      content: (
        <AgentExecutionPanel
          loopState={agentExecLoopState}
          stepEvents={agentExecEvents}
          taskTitle={agentExecTaskTitle}
          onClose={closeAIEmployeeExecution}
          sseConnected={agentSSE.connected}
        />
      ),
    };
  } else if (isAIEmployeeMode && aiEmployeeDrawer === 'artifacts') {
    aiEmployeeSecondaryPanel = {
      title: 'Artifacts',
      description: 'Logs, code, charts, topology, and downloadable outputs.',
      onClose: closeAIEmployeeArtifacts,
      content: (
        <CanvasPanel
          onToggleOpen={closeAIEmployeeArtifacts}
          activeTab={activeCanvasState.activeTab}
          onTabChange={(tabId) => {
            if (!currentConversationId) return;
            updateCanvasState(currentConversationId, (prev) => ({ ...prev, activeTab: tabId }));
          }}
          run={activeCanvasState.run}
          logs={activeCanvasState.logs}
          stepStatuses={activeCanvasState.stepStatuses}
          codeText={activeCanvasState.codeText}
          chartPayload={effectiveCanvasChartPayload}
          forecastSeriesGroups={forecastSeriesGroups}
          downloads={activeCanvasState.downloads}
          topologyGraph={effectiveCanvasChartPayload.topology_graph || null}
          topologyRunId={topologyRunId}
          onRunTopology={handleRunTopology}
          topologyRunning={Boolean(activeCanvasState.topologyRunning)}
          userId={user?.id || null}
          latestPlanRunId={latestPlanRunId}
          datasetProfileId={activeDatasetContext?.dataset_profile_id || null}
          datasetProfileRow={activeDatasetContext?.dataset_profile_id ? {
            id: activeDatasetContext.dataset_profile_id,
            user_file_id: activeDatasetContext.user_file_id || null,
            profile_json: activeDatasetContext.profileJson || {},
            contract_json: activeDatasetContext.contractJson || {},
          } : null}
          onPopout={null}
          isDetached={false}
        />
      ),
    };
  }

  return (
    <div className="h-full w-full flex flex-col p-2 md:p-3 animate-fade-in">
      {isAIEmployeeMode ? (
        <AIEmployeeChatShell
          title={aiEmployeeTitle}
          subtitle={aiEmployeeSubtitle}
          badge="Digital Worker"
          sidebarOpen={!isSidebarCollapsed}
          onSidebarToggle={handleSidebarToggle}
          onDismissOverlays={dismissAIEmployeeOverlays}
          onNewConversation={() => (conversations.length > 0 ? setShowNewChatConfirm(true) : handleNewConversation())}
          sidebar={(
            <AIEmployeeConversationSidebar
              title="Digital Worker"
              conversations={conversations}
              currentConversationId={currentConversationId}
              onSelectConversation={handleSelectAIConversation}
              onDeleteConversation={handleDeleteConversation}
              onNewConversation={() => (conversations.length > 0 ? setShowNewChatConfirm(true) : handleNewConversation())}
              formatTime={formatTime}
              searchQuery={conversationSearch}
              onSearchQueryChange={setConversationSearch}
              isLoading={isConversationsLoading}
              onClose={handleCloseSidebar}
            />
          )}
          actions={[
            {
              key: 'profile',
              label: 'Profile',
              icon: Bot,
              onClick: openAIEmployeeProfile,
              active: aiEmployeeDrawer === 'profile',
            },
            {
              key: 'steps',
              label: 'Steps',
              icon: Activity,
              onClick: openAIEmployeeExecution,
              active: aiEmployeeDrawer === 'execution',
              disabled: !agentExecLoopState?.steps?.length && agentExecEvents.length === 0,
            },
            {
              key: 'artifacts',
              label: 'Artifacts',
              icon: FileText,
              onClick: openAIEmployeeArtifacts,
              active: aiEmployeeDrawer === 'artifacts',
              disabled: !aiEmployeeHasArtifacts,
            },
          ]}
          thread={currentConversation ? (
            <ChatThread
              messages={currentMessages}
              isTyping={isTyping}
              streamingContent={streamingContent}
              thinkingSteps={thinkingSteps}
              formatTime={formatTime}
              renderSpecialMessage={renderSpecialMessage}
              quickPrompts={AI_EMPLOYEE_QUICK_PROMPTS}
              onSelectPrompt={(promptText) => {
                setInput(promptText);
                textareaRef.current?.focus();
              }}
              showInitialEmptyState={currentMessages.length <= 1 && !isTyping}
              isLoading={false}
              variant="ai_employee"
            />
          ) : (
            <div className="flex flex-1 items-center justify-center px-6">
              <div className="max-w-xl text-center">
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-[22px] bg-slate-900 text-white shadow-sm dark:bg-slate-100 dark:text-slate-900">
                  <Bot className="h-8 w-8" />
                </div>
                <h2 className="text-3xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
                  Start a chat with your worker
                </h2>
                <p className="mt-3 text-sm leading-6 text-slate-500 dark:text-slate-400">
                  Create a thread, upload a dataset, or assign a multi-step task and let the digital worker execute it transparently.
                </p>
                <button
                  type="button"
                  className="mt-6 rounded-full bg-slate-900 px-5 py-3 text-sm font-medium text-white transition hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200"
                  onClick={handleNewConversation}
                >
                  New chat
                </button>
              </div>
            </div>
          )}
          composer={currentConversation ? (
            <ChatComposer
              input={input}
              onInputChange={handleTextareaChange}
              onKeyDown={handleKeyDown}
              onSubmit={handleSend}
              textareaRef={textareaRef}
              fileInputRef={fileInputRef}
              onFileInputChange={handleFileInputChange}
              onFilePicker={() => fileInputRef.current?.click()}
              isTyping={isTyping}
              isUploading={isUploadingDataset}
              uploadStatusText={uploadStatusText}
              isDragOver={isDragOverUpload}
              onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); if (!isUploadingDataset) setIsDragOverUpload(true); }}
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); if (!isUploadingDataset) setIsDragOverUpload(true); }}
              onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); if (!e.currentTarget.contains(e.relatedTarget)) setIsDragOverUpload(false); }}
              onDrop={handleDropUpload}
              pendingAttachments={pendingAttachments}
              onRemoveAttachment={handleRemovePendingAttachment}
              status={aiEmployeeComposerStatus}
              thinkingEnabled={isThinkingToggleEnabled}
              onToggleThinkingEnabled={handleToggleThinkingEnabled}
              onStopGeneration={handleStopGeneration}
              variant="ai_employee"
            />
          ) : null}
          secondaryPanel={aiEmployeeSecondaryPanel}
        />
      ) : (
        <SplitShell
          sidebar={(
            <ConversationSidebar
              title={`${APP_NAME} Chat`}
              conversations={conversations}
              currentConversationId={currentConversationId}
              onSelectConversation={setCurrentConversationId}
              onDeleteConversation={handleDeleteConversation}
              onNewConversation={() => (conversations.length > 0 ? setShowNewChatConfirm(true) : handleNewConversation())}
              formatTime={formatTime}
              searchQuery={conversationSearch}
              onSearchQueryChange={setConversationSearch}
              isLoading={isConversationsLoading}
              collapsed={isSidebarCollapsed}
              onExpandFromCollapsed={handleExpandSidebar}
            />
          )}
          chat={(
            <div className="h-full bg-[var(--chat-surface)] dark:bg-slate-900/80 border border-[var(--chat-border)] dark:border-slate-700/60 rounded-2xl shadow-sm overflow-hidden flex flex-col">
              {currentConversation ? (
                <>
                  <div className="px-4 md:px-6 py-3 border-b border-[var(--chat-border)] dark:border-slate-700/60 bg-white/85 dark:bg-slate-900/75 backdrop-blur-sm flex items-center justify-between">
                    <div className="min-w-0">
                      <h3 className="text-base font-medium text-slate-800 dark:text-slate-100 truncate">
                        {currentConversation.title}
                      </h3>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-xs text-slate-500">{currentMessages.length} messages</span>
                        <span className={`text-xs px-2 py-0.5 rounded-full ${contextBadge.color}`}>{contextBadge.text}</span>
                      </div>
                    </div>
                    <button type="button" onClick={() => setShowNewChatConfirm(true)} className="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors" title="New conversation">
                      <FileText className="w-4 h-4 text-slate-500" />
                    </button>
                  </div>

                  <ChatThread
                    messages={currentMessages}
                    isTyping={isTyping}
                    streamingContent={streamingContent}
              thinkingSteps={thinkingSteps}
                    formatTime={formatTime}
                    renderSpecialMessage={renderSpecialMessage}
                    quickPrompts={QUICK_PROMPTS}
                    onSelectPrompt={(promptText) => { setInput(promptText); textareaRef.current?.focus(); }}
                    showInitialEmptyState={currentMessages.length <= 1 && !isTyping}
                    isLoading={false}
                  />

                  <ChatComposer
                    input={input}
                    onInputChange={handleTextareaChange}
                    onKeyDown={handleKeyDown}
                    onSubmit={handleSend}
                    textareaRef={textareaRef}
                    fileInputRef={fileInputRef}
                    onFileInputChange={handleFileInputChange}
                    onFilePicker={() => fileInputRef.current?.click()}
                    isTyping={isTyping}
                    isUploading={isUploadingDataset}
                    uploadStatusText={uploadStatusText}
                    isDragOver={isDragOverUpload}
                    onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); if (!isUploadingDataset) setIsDragOverUpload(true); }}
                    onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); if (!isUploadingDataset) setIsDragOverUpload(true); }}
                    onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); if (!e.currentTarget.contains(e.relatedTarget)) setIsDragOverUpload(false); }}
                    onDrop={handleDropUpload}
                    pendingAttachments={pendingAttachments}
                    onRemoveAttachment={handleRemovePendingAttachment}
                    thinkingEnabled={isThinkingToggleEnabled}
                    onToggleThinkingEnabled={handleToggleThinkingEnabled}
                    onStopGeneration={handleStopGeneration}
                  />
                </>
              ) : (
                <div className="h-full flex items-center justify-center text-slate-500 text-sm">
                  Select a conversation or start a new one.
                </div>
              )}
            </div>
          )}
          canvas={(
            <CanvasPanel
              onToggleOpen={isCanvasDetached ? () => { setIsCanvasDetached(false); handleCanvasToggle(); } : handleCanvasToggle}
              onPopout={isCanvasDetached ? () => setIsCanvasDetached(false) : () => setIsCanvasDetached(true)}
              isDetached={isCanvasDetached}
              activeTab={activeCanvasState.activeTab}
              onTabChange={(tabId) => { if (!currentConversationId) return; updateCanvasState(currentConversationId, (prev) => ({ ...prev, activeTab: tabId })); }}
              run={activeCanvasState.run} logs={activeCanvasState.logs} stepStatuses={activeCanvasState.stepStatuses}
              codeText={activeCanvasState.codeText} chartPayload={effectiveCanvasChartPayload}
              forecastSeriesGroups={forecastSeriesGroups} downloads={activeCanvasState.downloads}
              topologyGraph={effectiveCanvasChartPayload.topology_graph || null} topologyRunId={topologyRunId}
              onRunTopology={handleRunTopology} topologyRunning={Boolean(activeCanvasState.topologyRunning)}
              userId={user?.id || null} latestPlanRunId={latestPlanRunId}
              datasetProfileId={activeDatasetContext?.dataset_profile_id || null}
              datasetProfileRow={activeDatasetContext?.dataset_profile_id ? {
                id: activeDatasetContext.dataset_profile_id, user_file_id: activeDatasetContext.user_file_id || null,
                profile_json: activeDatasetContext.profileJson || {}, contract_json: activeDatasetContext.contractJson || {}
              } : null}
            />
          )}
          sidebarCollapsed={isSidebarCollapsed}
          onSidebarToggle={handleSidebarToggle}
          canvasOpen={Boolean(activeCanvasState.isOpen)}
          onCanvasToggle={handleCanvasToggle}
          initialSplitRatio={splitRatio}
          onSplitRatioCommit={handleSplitRatioCommit}
          canvasDetached={isCanvasDetached}
          hideCanvasButton={false}
        />
      )}

      {showNewChatConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <Card className="max-w-md w-full">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                <FileText className="w-6 h-6 text-blue-600" />
              </div>
              <div>
                <h3 className="text-lg font-semibold">Start New Conversation?</h3>
                <p className="text-sm text-slate-500">Current conversation will be saved</p>
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="secondary" onClick={() => setShowNewChatConfirm(false)}>Cancel</Button>
              <Button variant="primary" onClick={handleNewConversation}>New Conversation</Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
