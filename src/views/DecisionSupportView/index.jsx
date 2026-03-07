// ============================================
// Decision Support View - Chat + Canvas
// Single-screen chat-first workflow with white-box execution
// ============================================

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { FileText } from 'lucide-react';
import { Card, Button } from '../../components/ui';
import { supabase, userFilesService } from '../../services/supabaseClient';
import { prepareChatUploadFromFile, buildDataSummaryCardPayload, MAX_UPLOAD_BYTES } from '../../services/chatDatasetProfilingService';
import { getRequiredMappingStatus } from '../../utils/requiredMappingStatus';
import { setLocalTableData, TABLE_REGISTRY } from '../../services/liveDataQueryService';
import { createDatasetProfileFromSheets } from '../../services/datasetProfilingService';
import { datasetProfilesService, registerLocalProfile } from '../../services/datasetProfilesService';
import { reuseMemoryService } from '../../services/reuseMemoryService';
import { streamChatWithAI } from '../../services/geminiAPI';
import { diResetService } from '../../services/diResetService';
import { runForecastFromDatasetProfile, buildForecastCardPayload } from '../../services/chatForecastService';
import {
  runPlanFromDatasetProfile,
  buildPlanSummaryCardPayload,
  buildPlanTableCardPayload,
  buildInventoryProjectionCardPayload,
  buildPlanExceptionsCardPayload,
  buildBomBottlenecksCardPayload,
  buildPlanDownloadsPayload,
  buildRiskAwarePlanComparisonCardPayload
} from '../../services/chatPlanningService';
import {
  requestPlanApproval,
  approvePlanApproval,
  rejectPlanApproval,
  isPlanGovernanceConfigured
} from '../../services/planGovernanceService';
import {
  recordPlanApproved,
  recordPlanRejected
} from '../../services/planAuditService';
import { writeApprovedPlanBaseline } from '../../services/planWritebackService';
import {
  generateTopologyGraphForRun,
  loadTopologyGraphForRun
} from '../../services/topology/topologyService';
import {
  startWorkflow,
  runNextStep as runWorkflowNextStep,
  resumeRun as resumeWorkflowRun,
  replayRun as replayWorkflowRun,
  getRunSnapshot as getWorkflowRunSnapshot,
  submitBlockingAnswers as submitWorkflowBlockingAnswers,
  WORKFLOW_NAMES
} from '../../workflows/workflowRegistry';
import asyncRunsApiClient, { isAsyncRunsConnectivityError } from '../../services/asyncRunsApiClient';
import { buildSignature } from '../../utils/datasetSimilarity';
import { buildReusePlan, applyContractTemplateToProfile } from '../../utils/reusePlanner';
import { APP_NAME, ASSISTANT_NAME } from '../../config/branding';
import { executeChatCanvasRun, RUN_STEP_ORDER } from '../../services/chatCanvasWorkflowService';
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
import CanvasPanel from '../../components/chat/CanvasPanel';
import RiskAwarePlanComparisonCard from '../../components/chat/RiskAwarePlanComparisonCard';
import RiskReplanCard from '../../components/risk/RiskReplanCard';
import PODelayAlertCard from '../../components/chat/PODelayAlertCard';
import RiskTriggerNotificationCard from '../../components/chat/RiskTriggerNotificationCard';
import ProactiveAlertCard from '../../components/chat/ProactiveAlertCard';
import AIErrorCard from '../../components/chat/AIErrorCard';
import PlanComparisonCard from '../../components/chat/PlanComparisonCard';
import EnhancedPlanApprovalCard from '../../components/chat/EnhancedPlanApprovalCard';
import RetrainApprovalCard from '../../components/chat/RetrainApprovalCard';
import ApprovalReminderCard from '../../components/chat/ApprovalReminderCard';
import DigitalTwinSimulationCard from '../../components/chat/DigitalTwinSimulationCard';
import NegotiationPanel from '../../components/chat/NegotiationPanel';
import * as digitalTwinService from '../../services/digitalTwinService';
import { runNegotiation, checkNegotiationTrigger } from '../../services/negotiation/negotiationOrchestrator';
import SplitShell from '../../components/chat/SplitShell';
import ConversationSidebar from '../../components/chat/ConversationSidebar';
import ChatThread from '../../components/chat/ChatThread';
import ChatComposer from '../../components/chat/ChatComposer';
import useSessionContext from '../../hooks/useSessionContext';
import { parseIntent, routeIntent } from '../../services/chatIntentService';
import { handleParameterChange, handlePlanComparison, buildComparisonSummaryText } from '../../services/chatRefinementService';
import { createAlertMonitor, buildAlertChatMessage, isAlertMonitorEnabled } from '../../services/alertMonitorService';
import { batchApprove, batchReject } from '../../services/approvalWorkflowService';
import { buildEvidenceResponse } from '../../services/evidenceResponseService';
import {
  STORAGE_KEY,
  SIDEBAR_COLLAPSED_KEY_PREFIX,
  CANVAS_SPLIT_RATIO_KEY_PREFIX,
  MAX_UPLOAD_MESSAGE,
  DEFAULT_CANVAS_STATE,
  SPLIT_RATIO_MIN,
  SPLIT_RATIO_MAX,
  ASYNC_JOB_POLL_INTERVAL_MS,
  ASYNC_JOB_MAX_POLLS,
  BIND_TO_ALLOWLIST,
  QUICK_PROMPTS,
  REQUIRED_UPLOAD_TYPES_BY_EXECUTION,
  clampSplitRatio,
  isApiKeyConfigError,
  getErrorMessage,
  loadLocalConversations,
  saveLocalConversations,
  buildFingerprintFromUpload,
  getWorkflowFromProfile,
  buildRuntimeWorkflowSettings,
  buildValidationPayload,
  buildDownloadsPayload,
  buildConfirmationPayload,
  applyContractOverrides,
  buildExecutionGateResult,
  buildEvidenceSummaryText,
  deriveCanvasChartPatchFromCard,
  findLatestRunIdFromMessages,
  findLatestWorkflowRunIdFromMessages,
  normalizeWorkflowUiError,
  loadDomainContext,
  buildSystemPrompt,
  isExecutionIntent,
  initTableAvailability,
  isTableUnavailable,
  markTableUnavailable,
  toPositiveRunId,
  buildActualVsForecastRowsFromForecastCard,
} from './helpers.js';

const tableAvailable = initTableAvailability();
const conversationsDb = tableAvailable ? supabase : null;

// Module-level cache for inline raw rows — survives HMR state resets
const _rawRowsCache = new Map();

export default function DecisionSupportView({ user, addNotification }) {
  const userStorageSuffix = user?.id || 'anon';
  const sidebarKey = `${SIDEBAR_COLLAPSED_KEY_PREFIX}${userStorageSuffix}`;
  const splitRatioKey = `${CANVAS_SPLIT_RATIO_KEY_PREFIX}${userStorageSuffix}`;
  const [input, setInput] = useState('');
  const [conversations, setConversations] = useState([]);
  const [isConversationsLoading, setIsConversationsLoading] = useState(false);
  const [conversationSearch, setConversationSearch] = useState('');
  const [currentConversationId, setCurrentConversationId] = useState(null);
  const [isTyping, setIsTyping] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [showNewChatConfirm, setShowNewChatConfirm] = useState(false);
  const [domainContext, setDomainContext] = useState(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [conversationDatasetContext, setConversationDatasetContext] = useState({});
  const [canvasStateByConversation, setCanvasStateByConversation] = useState({});
  const [isUploadingDataset, setIsUploadingDataset] = useState(false);
  const [isDragOverUpload, setIsDragOverUpload] = useState(false);
  const [uploadStatusText, setUploadStatusText] = useState('');
  const [runningForecastProfiles, setRunningForecastProfiles] = useState({});
  const [runningPlanKeys, setRunningPlanKeys] = useState({});
  const [workflowSnapshots, setWorkflowSnapshots] = useState({});
  const [activeWorkflowRuns, setActiveWorkflowRuns] = useState({});
  // What-If Explorer: tracks the last succeeded plan run ID for the active conversation
  const [latestPlanRunId, setLatestPlanRunId] = useState(null);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem(sidebarKey) === '1';
    } catch {
      return false;
    }
  });
  const [splitRatio, setSplitRatio] = useState(() => {
    try {
      return clampSplitRatio(localStorage.getItem(splitRatioKey) ?? 0.5);
    } catch {
      return 0.5;
    }
  });

  const [isCanvasDetached, setIsCanvasDetached] = useState(false);
  const [isNegotiationGenerating, setIsNegotiationGenerating] = useState(false);

  // SmartOps 2.0: Session context for stateful conversations
  const sessionCtx = useSessionContext(user?.id, currentConversationId);
  const alertMonitorRef = useRef(null);

  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const asyncJobByRunRef = useRef({});
  const topologyAutoLoadRef = useRef({});

  const sidebarCollapseStorageKey = useMemo(
    () => `${SIDEBAR_COLLAPSED_KEY_PREFIX}${user?.id || 'anon'}`,
    [user?.id]
  );
  const splitRatioStorageKey = useMemo(
    () => `${CANVAS_SPLIT_RATIO_KEY_PREFIX}${user?.id || 'anon'}`,
    [user?.id]
  );

  const updateCanvasState = useCallback((conversationId, updater) => {
    if (!conversationId) return;
    setCanvasStateByConversation((prev) => {
      const existing = prev[conversationId] || DEFAULT_CANVAS_STATE;
      const nextValue = typeof updater === 'function' ? updater(existing) : { ...existing, ...(updater || {}) };
      return {
        ...prev,
        [conversationId]: nextValue
      };
    });
  }, []);

  // ── Supabase connectivity pre-flight check ────────────────────────────────
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

  // SmartOps 2.0: Proactive alert monitor
  useEffect(() => {
    if (!user?.id || !isAlertMonitorEnabled()) return;

    const monitor = createAlertMonitor({
      userId: user.id,
      loadRiskState: async (userId) => {
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
  }, [user?.id, currentConversationId, domainContext]);

  useEffect(() => {
    if (!user?.id) return;
    let active = true;
    setIsConversationsLoading(true);

    const load = async () => {
      if (isTableUnavailable()) {
        const local = loadLocalConversations(user.id);
        if (active) {
          setConversations(local);
          setIsConversationsLoading(false);
        }
        return;
      }

      const { data, error } = await conversationsDb
        .from('conversations')
        .select('*')
        .eq('user_id', user.id)
        .order('updated_at', { ascending: false });

      if (!active) return;
      if (!error && data) {
        setConversations(data);
        saveLocalConversations(user.id, data);
        setIsConversationsLoading(false);
        return;
      }

      console.warn('[DSV] conversations table unavailable, falling back to localStorage:', error?.message);
      markTableUnavailable();
      const local = loadLocalConversations(user.id);
      setConversations(local);
      setIsConversationsLoading(false);
    };

    load();
    return () => {
      active = false;
    };
  }, [user?.id]);

  useEffect(() => {
    if (!Array.isArray(conversations)) return;

    if (conversations.length === 0) {
      if (currentConversationId !== null) {
        setCurrentConversationId(null);
      }
      return;
    }

    const hasCurrentConversation = conversations.some(
      (conversation) => conversation.id === currentConversationId
    );
    if (!hasCurrentConversation) {
      setCurrentConversationId(conversations[0].id);
    }
  }, [conversations, currentConversationId]);

  useEffect(() => {
    if (user?.id && conversations.length > 0) {
      saveLocalConversations(user.id, conversations);
    }
  }, [conversations, user?.id]);

  const currentConversation = conversations.find((conversation) => conversation.id === currentConversationId);
  const currentMessages = useMemo(
    () => currentConversation?.messages || [],
    [currentConversation?.messages]
  );

  // Directly extract series groups from the latest forecast card in messages.
  // This bypasses canvas state persistence and works even after hot-reload.
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

  const persistConversation = useCallback((conversationId, payload) => {
    if (!conversationsDb || !user?.id || !conversationId || !payload) return;
    conversationsDb
      .from('conversations')
      .update({
        title: payload.title,
        messages: payload.messages,
        updated_at: payload.updated_at
      })
      .eq('id', conversationId)
      .eq('user_id', user.id)
      .then(({ error }) => {
        if (error) markTableUnavailable();
      });
  }, [user?.id]);

  const appendMessagesToCurrentConversation = useCallback((messages) => {
    if (!currentConversationId || !Array.isArray(messages) || messages.length === 0) return;

    let updatedConversation = null;
    const updatedAt = new Date().toISOString();
    setConversations((prev) => prev.map((conversation) => {
      if (conversation.id !== currentConversationId) return conversation;
      updatedConversation = {
        ...conversation,
        messages: [...(conversation.messages || []), ...messages],
        updated_at: updatedAt
      };
      return updatedConversation;
    }));

    if (updatedConversation) {
      persistConversation(currentConversationId, updatedConversation);
    }
  }, [currentConversationId, persistConversation]);

  const activeDatasetContext = conversationDatasetContext[currentConversationId] || null;
  const activeCanvasState = canvasStateByConversation[currentConversationId] || DEFAULT_CANVAS_STATE;
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
    const liveTopology = live.topology_graph && typeof live.topology_graph === 'object'
      ? live.topology_graph
      : null;

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
  const topologyRunStatus = useMemo(() => {
    if (!topologyRunId) return '';
    const snapshot = workflowSnapshots[topologyRunId] || workflowSnapshots[String(topologyRunId)] || null;
    return String(snapshot?.run?.status || '').toLowerCase();
  }, [topologyRunId, workflowSnapshots]);

  const handleSidebarToggle = useCallback(() => {
    setIsSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(sidebarCollapseStorageKey, next ? '1' : '0');
      } catch {
        // Ignore storage write failures.
      }
      return next;
    });
  }, [sidebarCollapseStorageKey]);

  const handleExpandSidebar = useCallback(() => {
    setIsSidebarCollapsed(false);
    try {
      localStorage.setItem(sidebarCollapseStorageKey, '0');
    } catch {
      // Ignore storage write failures.
    }
  }, [sidebarCollapseStorageKey]);

  const handleSplitRatioCommit = useCallback((nextRatio) => {
    const clamped = clampSplitRatio(nextRatio);
    setSplitRatio(clamped);
    try {
      localStorage.setItem(splitRatioStorageKey, String(clamped));
    } catch {
      // Ignore storage write failures.
    }
  }, [splitRatioStorageKey]);

  const handleCanvasToggle = useCallback(() => {
    if (!currentConversationId) return;
    updateCanvasState(currentConversationId, (prev) => ({
      ...prev,
      isOpen: !prev.isOpen
    }));
  }, [currentConversationId, updateCanvasState]);

  const systemPrompt = useMemo(() => {
    if (!domainContext) return '';
    return buildSystemPrompt(domainContext, activeDatasetContext);
  }, [domainContext, activeDatasetContext]);

  const upsertWorkflowSnapshot = useCallback((snapshot) => {
    const runId = snapshot?.run?.id;
    if (!runId) return;
    setWorkflowSnapshots((prev) => ({
      ...prev,
      [runId]: snapshot
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
    const cacheEntry = topologyAutoLoadRef.current[cacheKey] || {
      loaded: false,
      inFlight: false,
      lastAttemptAt: 0
    };
    if (cacheEntry.loaded || cacheEntry.inFlight) return;
    if ((Date.now() - Number(cacheEntry.lastAttemptAt || 0)) < 2000) return;
    topologyAutoLoadRef.current[cacheKey] = {
      ...cacheEntry,
      inFlight: true,
      lastAttemptAt: Date.now()
    };

    let cancelled = false;
    loadTopologyGraphForRun({ runId: targetRunId })
      .then((loaded) => {
        const current = topologyAutoLoadRef.current[cacheKey] || {};
        if (cancelled || !loaded?.graph) {
          topologyAutoLoadRef.current[cacheKey] = {
            ...current,
            inFlight: false
          };
          return;
        }
        updateCanvasState(currentConversationId, (prev) => ({
          ...prev,
          chartPayload: {
            ...(prev.chartPayload || {}),
            topology_graph: loaded.graph
          }
        }));
        topologyAutoLoadRef.current[cacheKey] = {
          ...current,
          loaded: true,
          inFlight: false
        };
      })
      .catch(() => {
        const current = topologyAutoLoadRef.current[cacheKey] || {};
        topologyAutoLoadRef.current[cacheKey] = {
          ...current,
          inFlight: false
        };
        // topology artifact may not exist yet for this run
      });

    return () => {
      cancelled = true;
    };
  }, [
    currentConversationId,
    topologyRunId,
    topologyRunStatus,
    activeCanvasState?.chartPayload?.topology_graph,
    updateCanvasState
  ]);

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
      role: 'ai',
      content: `Dataset context attached: profile #${cardPayload.dataset_profile_id}.`,
      timestamp: new Date().toISOString()
    }]);

    addNotification?.('Dataset context attached to this conversation.', 'success');
  }, [currentConversationId, appendMessagesToCurrentConversation, addNotification]);

  const handleContractConfirmation = useCallback(async ({
    dataset_profile_id,
    selections,
    mapping_selections
  }) => {
    if (!currentConversationId) return;
    const ctx = conversationDatasetContext[currentConversationId];
    if (!ctx) return;

    const draftContract = applyContractOverrides(
      ctx.contractJson || {},
      ctx.profileJson || {},
      selections || {},
      mapping_selections || {}
    );
    const applied = applyContractTemplateToProfile({
      profile_json: ctx.profileJson || {},
      contract_template_json: draftContract,
      sheetsRaw: ctx.sheetsRaw || []
    });
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
              user_file_id: ctx.user_file_id || null,
              fingerprint: ctx.dataset_fingerprint,
              profile_json: nextProfileJson,
              contract_json: updatedContract
            })
          : await datasetProfilesService.createDatasetProfile({
              user_id: user.id,
              user_file_id: ctx.user_file_id || null,
              fingerprint: ctx.dataset_fingerprint,
              profile_json: nextProfileJson,
              contract_json: updatedContract
            });
        persistedProfile = stored;
        nextProfileId = stored?.id || nextProfileId;
      }
    } catch {
      // Best effort persistence; continue with local confirmation state.
    }

    if (validationPassed && user?.id && ctx.dataset_fingerprint) {
      reuseMemoryService.upsertContractTemplate({
        user_id: user.id,
        fingerprint: ctx.dataset_fingerprint,
        workflow: getWorkflowFromProfile(nextProfileJson || {}),
        contract_json: updatedContract,
        quality_delta: -0.05
      }).catch((error) => {
        console.warn('[DecisionSupportView] Failed to update contract template after correction:', error.message);
      });

      if (persistedProfile?.id) {
        const signature = buildSignature(nextProfileJson || {}, updatedContract || {});
        reuseMemoryService.upsertDatasetSimilarityIndex({
          user_id: user.id,
          dataset_profile_id: persistedProfile.id,
          fingerprint: ctx.dataset_fingerprint,
          signature_json: signature
        }).catch((error) => {
          console.warn('[DecisionSupportView] Failed to persist similarity index after correction:', error.message);
        });
      }
    }

    const mergedProfileRow = persistedProfile
      ? {
          ...persistedProfile,
          profile_json: nextProfileJson,
          contract_json: updatedContract
        }
      : {
          id: nextProfileId || null,
          user_file_id: ctx.user_file_id || null,
          fingerprint: ctx.dataset_fingerprint || null,
          profile_json: nextProfileJson,
          contract_json: updatedContract
        };
    const summaryPayload = buildDataSummaryCardPayload(mergedProfileRow);

    setConversationDatasetContext((prev) => ({
      ...prev,
      [currentConversationId]: {
        ...(prev[currentConversationId] || {}),
        dataset_profile_id: nextProfileId,
        user_file_id: mergedProfileRow.user_file_id || prev[currentConversationId]?.user_file_id || null,
        profileJson: nextProfileJson,
        contractJson: updatedContract,
        summary: summaryPayload.context_summary || prev[currentConversationId]?.summary || '',
        validationPayload,
        contractOverrides: selections || {},
        contractConfirmed: validationPassed,
        minimalQuestions: nextProfileJson?.global?.minimal_questions || [],
        pending_reuse_plan: null
      }
    }));

    appendMessagesToCurrentConversation([
      {
        role: 'ai',
        content: validationPassed
          ? 'Contract confirmed and saved for fingerprint-based reuse.'
          : 'Contract draft saved, but required mapping is still incomplete. Please fix missing fields before running execution.',
        timestamp: new Date().toISOString()
      },
      {
        role: 'ai',
        type: 'dataset_summary_card',
        payload: summaryPayload,
        timestamp: new Date().toISOString()
      },
      {
        role: 'ai',
        type: 'validation_card',
        payload: validationPayload,
        timestamp: new Date().toISOString()
      }
    ]);

    addNotification?.(
      validationPassed ? 'Contract confirmed.' : 'Contract saved but still has missing required mappings.',
      validationPassed ? 'success' : 'error'
    );
  }, [conversationDatasetContext, currentConversationId, user?.id, appendMessagesToCurrentConversation, addNotification]);

  const setForecastRunningForProfile = useCallback((profileId, isRunning) => {
    if (!profileId) return;
    setRunningForecastProfiles((prev) => {
      const next = { ...prev };
      if (isRunning) next[profileId] = true;
      else delete next[profileId];
      return next;
    });
  }, []);

  const setPlanRunningForKey = useCallback((key, isRunning) => {
    if (!key) return;
    setRunningPlanKeys((prev) => {
      const next = { ...prev };
      if (isRunning) next[key] = true;
      else delete next[key];
      return next;
    });
  }, []);

  const markCanvasRunStarted = useCallback((label) => {
    if (!currentConversationId) return;
    updateCanvasState(currentConversationId, (prev) => ({
      ...prev,
      isOpen: true,
      activeTab: 'logs',
      run: {
        ...(prev.run || {}),
        status: 'running',
        label,
        started_at: new Date().toISOString()
      },
      logs: [
        ...(prev.logs || []),
        {
          id: `run_${Date.now()}`,
          step: 'profile',
          message: `✅ ${label} started`,
          timestamp: new Date().toISOString()
        }
      ]
    }));
  }, [currentConversationId, updateCanvasState]);

  const markCanvasRunFinished = useCallback((status, message, step = 'report') => {
    if (!currentConversationId) return;
    updateCanvasState(currentConversationId, (prev) => ({
      ...prev,
      run: {
        ...(prev.run || {}),
        status
      },
      logs: message
        ? [
            ...(prev.logs || []),
            {
              id: `${status}_${Date.now()}`,
              step,
              message,
              timestamp: new Date().toISOString()
            }
          ]
        : (prev.logs || [])
    }));
  }, [currentConversationId, updateCanvasState]);

  const resolveDatasetProfileRow = useCallback(async (profileId = null) => {
    if (!user?.id) return null;

    const profileIdStr = profileId != null ? String(profileId) : null;
    const isLocalId = profileIdStr && profileIdStr.startsWith('local-');
    const numericProfileId = Number.isFinite(Number(profileId)) ? Number(profileId) : null;
    const activeProfileIdRaw = activeDatasetContext?.dataset_profile_id;
    const activeProfileIdStr = activeProfileIdRaw != null ? String(activeProfileIdRaw) : null;
    const activeProfileId = Number.isFinite(Number(activeProfileIdRaw))
      ? Number(activeProfileIdRaw)
      : null;
    const isActiveLocal = activeProfileIdStr && activeProfileIdStr.startsWith('local-');

    // Match local profile ID against active context
    if (isLocalId && activeProfileIdStr === profileIdStr) {
      return {
        id: activeProfileIdStr,
        user_file_id: activeDatasetContext?.user_file_id || null,
        profile_json: activeDatasetContext?.profileJson || {},
        contract_json: activeDatasetContext?.contractJson || {},
        _inlineRawRows: activeDatasetContext?.rawRowsForStorage || _rawRowsCache.get(activeProfileIdStr) || null,
        _local: true
      };
    }

    // Match numeric profile ID against active context
    if (numericProfileId && activeProfileId && numericProfileId === activeProfileId) {
      return {
        id: activeProfileId,
        user_file_id: activeDatasetContext?.user_file_id || null,
        profile_json: activeDatasetContext?.profileJson || {},
        contract_json: activeDatasetContext?.contractJson || {}
      };
    }

    if (numericProfileId) {
      const row = await datasetProfilesService.getDatasetProfileById(user.id, numericProfileId);
      if (row) return row;
    }

    // Fallback: return active context (local or numeric)
    if (isActiveLocal) {
      return {
        id: activeProfileIdStr,
        user_file_id: activeDatasetContext?.user_file_id || null,
        profile_json: activeDatasetContext?.profileJson || {},
        contract_json: activeDatasetContext?.contractJson || {},
        _inlineRawRows: activeDatasetContext?.rawRowsForStorage || _rawRowsCache.get(activeProfileIdStr) || null,
        _local: true
      };
    }

    if (activeProfileId) {
      return {
        id: activeProfileId,
        user_file_id: activeDatasetContext?.user_file_id || null,
        profile_json: activeDatasetContext?.profileJson || {},
        contract_json: activeDatasetContext?.contractJson || {}
      };
    }

    return datasetProfilesService.getLatestDatasetProfile(user.id);
  }, [user?.id, activeDatasetContext]);

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
          const applied = applyContractTemplateToProfile({
            profile_json: nextProfileJson,
            contract_template_json: template.contract_json,
            sheetsRaw: ctx.sheetsRaw || []
          });
          nextProfileJson = applied.profile_json;
          nextContractJson = applied.contract_json;
          validationPassed = applied.validation_passed === true;

          await datasetProfilesService.updateDatasetProfile(user.id, profileRow.id, {
            profile_json: nextProfileJson,
            contract_json: nextContractJson
          });

          reuseMemoryService.upsertContractTemplate({
            user_id: user.id,
            fingerprint: ctx.dataset_fingerprint || profileRow.fingerprint,
            workflow: getWorkflowFromProfile(nextProfileJson),
            contract_json: nextContractJson,
            quality_delta: validationPassed ? 0.08 : -0.03
          }).catch((error) => {
            console.warn('[DecisionSupportView] Failed to update contract template after reuse apply:', error.message);
          });
        }
      }

      let reusedSettingsTemplate = ctx.reused_settings_template || null;
      if (effectivePayload.settings_template_id) {
        const settingsTemplate = await reuseMemoryService.getRunSettingsTemplateById(user.id, effectivePayload.settings_template_id);
        if (settingsTemplate?.settings_json) {
          reusedSettingsTemplate = settingsTemplate.settings_json;
          reuseMemoryService.upsertRunSettingsTemplate({
            user_id: user.id,
            fingerprint: ctx.dataset_fingerprint || profileRow.fingerprint,
            workflow: getWorkflowFromProfile(nextProfileJson),
            settings_json: settingsTemplate.settings_json,
            quality_delta: 0.02
          }).catch((error) => {
            console.warn('[DecisionSupportView] Failed to update run settings template after reuse apply:', error.message);
          });
        }
      }

      const mergedProfileRow = {
        ...profileRow,
        profile_json: nextProfileJson,
        contract_json: nextContractJson
      };
      const mergedFingerprint = ctx.dataset_fingerprint || profileRow.fingerprint || null;
      if (mergedFingerprint) {
        reuseMemoryService.upsertDatasetSimilarityIndex({
          user_id: user.id,
          dataset_profile_id: profileRow.id,
          fingerprint: mergedFingerprint,
          signature_json: buildSignature(nextProfileJson, nextContractJson)
        }).catch((error) => {
          console.warn('[DecisionSupportView] Failed to refresh similarity index after reuse apply:', error.message);
        });
      }
      const cardPayload = buildDataSummaryCardPayload(mergedProfileRow);
      const validationPayload = buildValidationPayload(mergedProfileRow);

      setConversationDatasetContext((prev) => ({
        ...prev,
        [currentConversationId]: {
          ...(prev[currentConversationId] || {}),
          profileJson: nextProfileJson,
          contractJson: nextContractJson,
          summary: cardPayload.context_summary || '',
          validationPayload,
          contractConfirmed: validationPassed,
          pending_reuse_plan: null,
          reused_settings_template: reusedSettingsTemplate
        }
      }));

      appendMessagesToCurrentConversation([
        {
          role: 'ai',
          content: 'Reused contract + settings successfully.',
          timestamp: new Date().toISOString()
        },
        {
          role: 'ai',
          type: 'dataset_summary_card',
          payload: cardPayload,
          timestamp: new Date().toISOString()
        },
        {
          role: 'ai',
          type: 'validation_card',
          payload: validationPayload,
          timestamp: new Date().toISOString()
        }
      ]);
      addNotification?.('Reuse applied successfully.', 'success');
    } catch (error) {
      appendMessagesToCurrentConversation([{
        role: 'ai',
        content: `Reuse apply failed: ${error.message}`,
        timestamp: new Date().toISOString()
      }]);
      addNotification?.(`Reuse apply failed: ${error.message}`, 'error');
    }
  }, [
    user?.id,
    currentConversationId,
    conversationDatasetContext,
    resolveDatasetProfileRow,
    appendMessagesToCurrentConversation,
    addNotification
  ]);

  const handleReviewReuseSuggestion = useCallback(() => {
    if (!currentConversationId) return;
    const ctx = conversationDatasetContext[currentConversationId] || {};
    const validationStatus = String(ctx?.validationPayload?.status || '').toLowerCase();
    setConversationDatasetContext((prev) => ({
      ...prev,
      [currentConversationId]: {
        ...(prev[currentConversationId] || {}),
        pending_reuse_plan: null,
        contractConfirmed: validationStatus === 'pass'
      }
    }));
    appendMessagesToCurrentConversation([{
      role: 'ai',
      content: validationStatus === 'pass'
        ? 'Reuse skipped. Continuing with current validated mapping draft.'
        : 'Reuse skipped. Current draft needs mapping review before execution.',
      timestamp: new Date().toISOString()
    }]);
  }, [currentConversationId, conversationDatasetContext, appendMessagesToCurrentConversation]);

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
        timestamp: new Date().toISOString()
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
          timestamp: new Date().toISOString()
        },
        {
          role: 'ai',
          type: 'validation_card',
          payload: validationPayload,
          timestamp: new Date().toISOString()
        },
        {
          role: 'ai',
          type: 'blocking_questions_card',
          payload: { questions: blockingQuestions, dataset_profile_id: resolvedProfileRow.id, run_id: null },
          timestamp: new Date().toISOString()
        }
      ];
      if (confirmationPayload) {
        messages.push({
          role: 'ai',
          type: 'contract_confirmation_card',
          payload: confirmationPayload,
          timestamp: new Date().toISOString()
        });
      }
      appendMessagesToCurrentConversation(messages);
      setConversationDatasetContext((prev) => ({
        ...prev,
        [currentConversationId]: {
          ...(prev[currentConversationId] || {}),
          contractConfirmed: false,
          validationPayload
        }
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
      timestamp: new Date().toISOString()
    }]);

    try {
      const runtimeSettings = buildRuntimeWorkflowSettings(activeDatasetContext || {}, {});
      const requestedHorizon = Number(runtimeSettings?.forecast?.horizon_periods);
      const forecastResult = await runForecastFromDatasetProfile({
        userId: user.id,
        datasetProfileRow: resolvedProfileRow,
        horizonPeriods: Number.isFinite(requestedHorizon) ? requestedHorizon : null,
        settings: runtimeSettings
      });
      const cardPayload = buildForecastCardPayload(forecastResult, resolvedProfileRow);
      const actualVsForecastRows = buildActualVsForecastRowsFromForecastCard(cardPayload);

      appendMessagesToCurrentConversation([
        {
          role: 'ai',
          content: forecastResult.summary_text,
          timestamp: new Date().toISOString()
        },
        {
          role: 'ai',
          type: 'forecast_result_card',
          payload: cardPayload,
          timestamp: new Date().toISOString()
        }
      ]);

      if (actualVsForecastRows.length > 0) {
        const forecastSeriesGroups = Array.isArray(cardPayload.series_groups) ? cardPayload.series_groups : [];
        updateCanvasState(currentConversationId, (prev) => ({
          ...prev,
          chartPayload: {
            ...(prev.chartPayload || {}),
            actual_vs_forecast: actualVsForecastRows,
            ...(forecastSeriesGroups.length > 0 ? { series_groups: forecastSeriesGroups } : {})
          },
          activeTab: 'charts'
        }));
      }

      markCanvasRunFinished('succeeded', '✅ Forecast completed.', 'ml');
      addNotification?.(`Forecast run #${forecastResult?.run?.id || ''} completed.`, 'success');
    } catch (error) {
      appendMessagesToCurrentConversation([
        {
          role: 'ai',
          content: `Forecast failed: ${error.message}`,
          timestamp: new Date().toISOString()
        },
        {
          role: 'ai',
          type: 'forecast_error_card',
          payload: {
            run_id: error?.run_id || null,
            message: error.message,
            blocking_questions: Array.isArray(error?.blockingQuestions) ? error.blockingQuestions : []
          },
          timestamp: new Date().toISOString()
        }
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
    updateCanvasState
  ]);

  const executePlanFlow = useCallback(async ({
    datasetProfileId = null,
    forecastRunId = null,
    forecastCardPayload = null,
    riskMode = 'off'
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
        timestamp: new Date().toISOString()
      }]);
      return;
    }

    const runKey = forecastRunId || `profile_${resolvedProfileRow.id}`;
    setPlanRunningForKey(runKey, true);
    markCanvasRunStarted(`Plan run (profile #${resolvedProfileRow.id})`);

    appendMessagesToCurrentConversation([{
      role: 'ai',
      content: `Running plan for dataset profile #${resolvedProfileRow.id}...`,
      timestamp: new Date().toISOString()
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
        riskMode
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
          timestamp: new Date().toISOString()
        },
        ...(decisionNarrative ? [{
          role: 'ai',
          type: 'decision_narrative_card',
          payload: decisionNarrative,
          timestamp: new Date().toISOString()
        }] : []),
        ...(decisionNarrative?.requires_approval ? [{
          role: 'ai',
          type: 'plan_approval_card',
          payload: {
            ...decisionNarrative,
            approval: null
          },
          timestamp: new Date().toISOString()
        }] : []),
        {
          role: 'ai',
          type: 'plan_summary_card',
          payload: summaryPayload,
          timestamp: new Date().toISOString()
        },
        {
          role: 'ai',
          type: 'plan_table_card',
          payload: tablePayload,
          timestamp: new Date().toISOString()
        },
        {
          role: 'ai',
          type: 'inventory_projection_card',
          payload: projectionPayload,
          timestamp: new Date().toISOString()
        },
        {
          role: 'ai',
          type: 'plan_exceptions_card',
          payload: exceptionsPayload,
          timestamp: new Date().toISOString()
        },
        ...(bottlenecksPayload.total_rows > 0
          ? [{
              role: 'ai',
              type: 'bom_bottlenecks_card',
              payload: bottlenecksPayload,
              timestamp: new Date().toISOString()
            }]
          : []),
        {
          role: 'ai',
          type: 'downloads_card',
          payload: downloadsPayload,
          timestamp: new Date().toISOString()
        },
        ...(riskComparisonPayload ? [{
          role: 'ai',
          type: 'risk_aware_plan_comparison_card',
          payload: riskComparisonPayload,
          timestamp: new Date().toISOString()
        }] : [])
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
            ...(costRows.length > 0 ? { cost_breakdown: costRows } : {})
          },
          activeTab: 'charts'
        }));
      }

      markCanvasRunFinished('succeeded', '✅ Plan completed.', 'solver');
      addNotification?.(`Plan run #${planResult?.run?.id || ''} completed.`, 'success');
      // Track latest plan run for What-If Explorer
      if (planResult?.run?.id) setLatestPlanRunId(planResult.run.id);
      setDomainContext((prev) => ({
        ...(prev || {}),
        lastPlanSolverResult: planResult?.solver_result || null
      }));
    } catch (error) {
      const constraintViolations = Array.isArray(error?.constraint_check?.violations)
        ? error.constraint_check.violations
        : [];
      appendMessagesToCurrentConversation([
        {
          role: 'ai',
          content: `Plan failed: ${error.message}`,
          timestamp: new Date().toISOString()
        },
        {
          role: 'ai',
          type: 'plan_error_card',
          payload: {
            run_id: error?.run_id || null,
            message: error.message,
            blocking_questions: Array.isArray(error?.blockingQuestions) ? error.blockingQuestions : [],
            constraint_violations: constraintViolations
          },
          timestamp: new Date().toISOString()
        }
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
    updateCanvasState
  ]);

  const executeRiskAwarePlanFlow = useCallback(async ({
    datasetProfileId = null,
    forecastRunId = null,
    forecastCardPayload = null
  } = {}) => {
    return executePlanFlow({
      datasetProfileId,
      forecastRunId,
      forecastCardPayload,
      riskMode: 'on'
    });
  }, [executePlanFlow]);

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
        summary_text: narrative?.summary_text || ''
      },
      reason: 'Plan requires manual approval based on solver/narrative risk criteria.',
      note
    });
    const approval = response?.approval || null;
    if (!approval) {
      throw new Error('Approval response missing approval record.');
    }

    appendMessagesToCurrentConversation([
      {
        role: 'ai',
        content: `Approval request submitted (${approval.approval_id}).`,
        timestamp: new Date().toISOString()
      },
      {
        role: 'ai',
        type: 'plan_approval_card',
        payload: {
          ...(narrative || {}),
          run_id: runId,
          requires_approval: true,
          approval
        },
        timestamp: new Date().toISOString()
      }
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
      note
    });
    const approval = response?.approval || null;
    if (!approval) {
      throw new Error('Approval response missing approval record.');
    }

    recordPlanApproved({
      userId: user.id,
      runId,
      approvalId: approval.approval_id,
      note
    }).catch((error) => {
      console.warn('[DecisionSupportView] recordPlanApproved failed:', error.message);
    });

    // Write approved plan orders + inventory targets to baseline tables
    writeApprovedPlanBaseline({
      userId: user.id,
      runId,
      approvalId: approval.approval_id
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
        timestamp: new Date().toISOString()
      },
      {
        role: 'ai',
        type: 'plan_approval_card',
        payload: {
          ...(narrative || {}),
          run_id: runId,
          requires_approval: true,
          approval
        },
        timestamp: new Date().toISOString()
      }
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
      note
    });
    const approval = response?.approval || null;
    if (!approval) {
      throw new Error('Approval response missing approval record.');
    }

    recordPlanRejected({
      userId: user.id,
      runId,
      approvalId: approval.approval_id,
      note
    }).catch((error) => {
      console.warn('[DecisionSupportView] recordPlanRejected failed:', error.message);
    });

    appendMessagesToCurrentConversation([
      {
        role: 'ai',
        content: `Plan rejected (${approval.approval_id}).`,
        timestamp: new Date().toISOString()
      },
      {
        role: 'ai',
        type: 'plan_approval_card',
        payload: {
          ...(narrative || {}),
          run_id: runId,
          requires_approval: true,
          approval
        },
        timestamp: new Date().toISOString()
      }
    ]);
    addNotification?.('Plan rejected.', 'warning');
    return approval;
  }, [user?.id, appendMessagesToCurrentConversation, addNotification]);

  const handleRiskReplanDecision = useCallback(async ({
    action,
    params = {},
    datasetProfileId
  }) => {
    if (action === 'dismiss_risk_replan') {
      appendMessagesToCurrentConversation([{
        role: 'ai',
        content: 'Risk re-plan recommendation dismissed. Current plan retained.',
        timestamp: new Date().toISOString()
      }]);
      return;
    }

    if (action === 'replan_with_risk_params') {
      const { safety_stock_alpha, stockout_penalty_multiplier, risk_mode } = params;

      appendMessagesToCurrentConversation([{
        role: 'ai',
        content: `Re-planning with safety_stock_alpha=${safety_stock_alpha}...`,
        timestamp: new Date().toISOString()
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
            stockout_penalty_beta: stockout_penalty_multiplier - 1
          },
          settings: {
            ...runtimeSettings,
            closed_loop: { mode: 'dry_run' } // Prevent infinite loop
          }
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
            timestamp: new Date().toISOString()
          },
          ...(decisionNarrative ? [{
            role: 'ai',
            type: 'decision_narrative_card',
            payload: decisionNarrative,
            timestamp: new Date().toISOString()
          }] : []),
          ...(decisionNarrative?.requires_approval ? [{
            role: 'ai',
            type: 'plan_approval_card',
            payload: {
              ...decisionNarrative,
              approval: null
            },
            timestamp: new Date().toISOString()
          }] : []),
          { role: 'ai', type: 'plan_summary_card', payload: summaryPayload, timestamp: new Date().toISOString() },
          { role: 'ai', type: 'plan_table_card', payload: tablePayload, timestamp: new Date().toISOString() },
          { role: 'ai', type: 'inventory_projection_card', payload: projectionPayload, timestamp: new Date().toISOString() },
          { role: 'ai', type: 'downloads_card', payload: downloadsPayload, timestamp: new Date().toISOString() },
          ...(riskComparisonPayload
            ? [{ role: 'ai', type: 'risk_aware_plan_comparison_card', payload: riskComparisonPayload, timestamp: new Date().toISOString() }]
            : [])
        ]);

        addNotification?.(`Risk-adjusted re-plan completed.`, 'success');
        if (planResult?.run?.id) setLatestPlanRunId(planResult.run.id);
      } catch (err) {
        appendMessagesToCurrentConversation([{
          role: 'ai',
          content: `Risk re-plan failed: ${err.message}`,
          timestamp: new Date().toISOString()
        }]);
        addNotification?.(`Risk re-plan failed: ${err.message}`, 'error');
      }
    }
  }, [
    user,
    activeDatasetContext,
    resolveDatasetProfileRow,
    appendMessagesToCurrentConversation,
    addNotification
  ]);

  const appendWorkflowStepEventMessages = useCallback((runId, stepEvent, profileId = null) => {
    if (!stepEvent) return;

    const timestamp = new Date().toISOString();
    const messages = [];
    let chartPatch = null;

    if (stepEvent.notice_text) {
      messages.push({
        role: 'ai',
        content: stepEvent.notice_text,
        timestamp
      });
    }

    if (Array.isArray(stepEvent.result_cards) && stepEvent.result_cards.length > 0) {
      stepEvent.result_cards.forEach((card) => {
        if (!card?.type) return;
        messages.push({
          role: 'ai',
          type: card.type,
          payload: card.payload || {},
          timestamp
        });

        const patch = deriveCanvasChartPatchFromCard(card.type, card.payload || {});
        if (patch) {
          chartPatch = {
            ...(chartPatch || {}),
            ...patch
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
          questions: Array.isArray(stepEvent.error.blocking_questions) ? stepEvent.error.blocking_questions : []
        },
        timestamp
      });
    } else if (stepEvent.status === 'failed' && stepEvent.error) {
      messages.push({
        role: 'ai',
        type: 'workflow_error_card',
        payload: {
          step: stepEvent.step,
          error_code: stepEvent.error.code,
          error_message: stepEvent.error.message,
          next_actions: stepEvent.error.next_actions || []
        },
        timestamp
      });

      if (Array.isArray(stepEvent.error.blocking_questions) && stepEvent.error.blocking_questions.length > 0) {
        messages.push({
          role: 'ai',
          type: 'blocking_questions_card',
          payload: {
            questions: stepEvent.error.blocking_questions,
            run_id: runId || null,
            dataset_profile_id: profileId || null
          },
          timestamp
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
          ...chartPatch
        },
        activeTab: 'charts'
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
                topology_graph: loaded.graph
              },
              topologyRunning: false
            }));
          })
          .catch(() => {
            // best effort graph hydration for topology step
          });
      }
    }
  }, [appendMessagesToCurrentConversation, currentConversationId, updateCanvasState]);

  const sleepMs = useCallback((ms) => new Promise((resolve) => setTimeout(resolve, ms)), []);

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
              async_mode: true
            }
          },
          steps: Array.isArray(jobStatus?.step_summary) ? jobStatus.step_summary : [],
          artifacts: []
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
          artifacts: next.artifacts
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
          'If the issue persists, review run artifacts and mappings.'
        ]
      });
      appendMessagesToCurrentConversation([
        {
          role: 'ai',
          content: `Workflow execution failed: ${uiError.message}`,
          timestamp: new Date().toISOString()
        },
        {
          role: 'ai',
          type: 'workflow_error_card',
          payload: {
            step: 'workflow',
            error_code: uiError.code,
            error_message: uiError.message,
            next_actions: uiError.nextActions
          },
          timestamp: new Date().toISOString()
        }
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
    upsertWorkflowSnapshot
  ]);

  const executeWorkflowFlow = useCallback(async ({
    datasetProfileId = null,
    settings = {},
    workflowName = null
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
        timestamp: new Date().toISOString()
      }]);
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
          timestamp: new Date().toISOString()
        },
        {
          role: 'ai',
          type: 'validation_card',
          payload: validationPayload,
          timestamp: new Date().toISOString()
        },
        {
          role: 'ai',
          type: 'blocking_questions_card',
          payload: { questions: blockingQuestions, dataset_profile_id: profileRow.id, run_id: null },
          timestamp: new Date().toISOString()
        }
      ];
      if (confirmationPayload) {
        messages.push({
          role: 'ai',
          type: 'contract_confirmation_card',
          payload: confirmationPayload,
          timestamp: new Date().toISOString()
        });
      }
      appendMessagesToCurrentConversation(messages);
      setConversationDatasetContext((prev) => ({
        ...prev,
        [currentConversationId]: {
          ...(prev[currentConversationId] || {}),
          contractConfirmed: false,
          validationPayload
        }
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
              multi_echelon_mode: Boolean(runtimeSettings?.plan?.multi_echelon_mode)
            },
            settings: runtimeSettings,
            horizon: Number(runtimeSettings?.forecast?.horizon_periods || runtimeSettings?.forecast_horizon_periods || null) || null,
            granularity: profileRow?.profile_json?.global?.time_range_guess?.granularity || null,
            workload: {
              rows_per_sheet: Number(profileRow?.profile_json?.global?.rows_per_sheet || 0) || null,
              skus: Number(profileRow?.profile_json?.global?.sku_count || 0) || null
            },
            async_mode: true
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
              workflow: selectedWorkflow
            }
          }));
          appendMessagesToCurrentConversation([
            {
              role: 'ai',
              content: `${workflowLabel} started (run #${runId}, job ${jobId}).`,
              timestamp: new Date().toISOString()
            },
            {
              role: 'ai',
              type: 'workflow_progress_card',
              payload: {
                run_id: runId,
                job_id: jobId,
                workflow: selectedWorkflow,
                status: 'queued'
              },
              timestamp: new Date().toISOString()
            }
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

      // Local profiles proceed with in-memory fallback (diRunsService handles offline gracefully)
      if (isLocalProfile) {
        console.info(`[DSV] Running ${workflowLabel} with local profile ${profileRow.id} — Supabase calls will fallback to in-memory store`);
      }

      const startSnapshot = await startWorkflow({
        user_id: user.id,
        dataset_profile_id: profileRow.id,
        workflow: selectedWorkflow,
        settings: runtimeSettings,
        profileRow
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
          workflow: selectedWorkflow
        }
      }));

      appendMessagesToCurrentConversation([
        {
          role: 'ai',
          content: `${workflowLabel} started (run #${runId}).`,
          timestamp: new Date().toISOString()
        },
        {
          role: 'ai',
          type: 'workflow_progress_card',
          payload: {
            run_id: runId
          },
          timestamp: new Date().toISOString()
        }
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
          timestamp: new Date().toISOString()
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
              'Verify dataset profile and contract are available.'
            ]
          },
          timestamp: new Date().toISOString()
        }
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
    updateCanvasState
  ]);

  const executeWorkflowAFlow = useCallback((params = {}) => {
    return executeWorkflowFlow({
      ...params,
      workflowName: WORKFLOW_NAMES.A
    });
  }, [executeWorkflowFlow]);

  const executeWorkflowBFlow = useCallback((params = {}) => {
    return executeWorkflowFlow({
      ...params,
      workflowName: WORKFLOW_NAMES.B
    });
  }, [executeWorkflowFlow]);

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

  const handleRunTopology = useCallback(async (requestedRunId = null) => {
    if (!user?.id) {
      addNotification?.('Please sign in before running topology.', 'error');
      return;
    }
    if (!currentConversationId) {
      addNotification?.('Please start a conversation first.', 'error');
      return;
    }

    const explicitRunId = Number(requestedRunId);
    const fallbackRunId = findLatestWorkflowRunIdFromMessages(currentMessages);
    const runId = Number.isFinite(explicitRunId) ? explicitRunId : fallbackRunId;
    if (!Number.isFinite(runId)) {
      appendMessagesToCurrentConversation([{
        role: 'ai',
        content: 'No workflow run id found for topology. Run Workflow A/B first or use `/topology <run_id>`.',
        timestamp: new Date().toISOString()
      }]);
      addNotification?.('No workflow run id available for topology.', 'warning');
      return;
    }

    updateCanvasState(currentConversationId, (prev) => ({
      ...prev,
      isOpen: true,
      activeTab: 'topology',
      topologyRunning: true,
      logs: [
        ...(prev.logs || []),
        {
          id: `topology_start_${Date.now()}`,
          step: 'topology',
          message: `Running topology graph build for run #${runId}...`,
          timestamp: new Date().toISOString()
        }
      ]
    }));

    try {
      const result = await generateTopologyGraphForRun({
        userId: user.id,
        runId,
        scope: {},
        forceRebuild: false,
        reuse: true,
        manageRunStep: true
      });

      if (!result?.graph) {
        throw new Error('Topology graph payload is empty.');
      }

      const noticeText = result.reused
        ? `Topology graph ready for run #${runId} (reused from run #${result.reused_from_run_id}).`
        : `Topology graph generated for run #${runId}.`;

      appendMessagesToCurrentConversation([
        {
          role: 'ai',
          content: noticeText,
          timestamp: new Date().toISOString()
        },
        {
          role: 'ai',
          type: 'topology_graph_card',
          payload: {
            run_id: runId,
            graph: result.graph,
            ref: result.ref || null,
            reused: Boolean(result.reused),
            reused_from_run_id: result.reused_from_run_id || null
          },
          timestamp: new Date().toISOString()
        }
      ]);

      updateCanvasState(currentConversationId, (prev) => ({
        ...prev,
        activeTab: 'topology',
        topologyRunning: false,
        chartPayload: {
          ...(prev.chartPayload || {}),
          topology_graph: result.graph
        },
        logs: [
          ...(prev.logs || []),
          {
            id: `topology_done_${Date.now()}`,
            step: 'topology',
            message: `✅ Topology graph ready for run #${runId}.`,
            timestamp: new Date().toISOString()
          }
        ]
      }));

      addNotification?.(`Topology graph ready for run #${runId}.`, 'success');
    } catch (error) {
      updateCanvasState(currentConversationId, (prev) => ({
        ...prev,
        topologyRunning: false,
        logs: [
          ...(prev.logs || []),
          {
            id: `topology_failed_${Date.now()}`,
            step: 'topology',
            message: `❌ Topology generation failed: ${error.message}`,
            timestamp: new Date().toISOString()
          }
        ]
      }));
      appendMessagesToCurrentConversation([{
        role: 'ai',
        content: `Topology generation failed: ${error.message}`,
        timestamp: new Date().toISOString()
      }]);
      addNotification?.(`Topology generation failed: ${error.message}`, 'error');
    }
  }, [
    user?.id,
    currentConversationId,
    currentMessages,
    updateCanvasState,
    appendMessagesToCurrentConversation,
    addNotification
  ]);

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
          'Start a new workflow run from the latest dataset card.'
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
        fallbackActions: ['Retry resume.', 'Start a new workflow run from the latest dataset card.']
      });
      appendMessagesToCurrentConversation([{
        role: 'ai',
        type: 'workflow_error_card',
        payload: {
          step: 'resume',
          error_code: uiError.code,
          error_message: uiError.message,
          next_actions: uiError.nextActions
        },
        timestamp: new Date().toISOString()
      }]);
      addNotification?.(`Workflow resume failed: ${uiError.message}`, 'error');
    }
  }, [
    workflowSnapshots,
    appendWorkflowStepEventMessages,
    appendMessagesToCurrentConversation,
    addNotification,
    processWorkflowRun,
    upsertWorkflowSnapshot
  ]);

  // PR-5: Apply blocking-question answers to contract_json then resume the run.
  const handleBlockingQuestionsSubmit = useCallback(async ({ answersById = {}, questions = [], runId = null, profileId = null }) => {
    if (!user?.id) return;

    // Apply answers to contract_json if we have a profile to update
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

            // Enforce allowlist
            const isAllowed = BIND_TO_ALLOWLIST.some((prefix) => bindTo.startsWith(prefix));
            if (!isAllowed) return;

            // Validate value is within declared options (if any)
            if (Array.isArray(q.options) && q.options.length > 0 && !q.options.includes(value)) return;

            // Apply: split "section.key" and write into contract
            const [section, ...rest] = bindTo.split('.');
            const key = rest.join('.');
            if (!section || !key) return;
            if (typeof updated[section] !== 'object' || updated[section] === null) {
              updated[section] = {};
            }
            updated[section][key] = value;
          });

          await datasetProfilesService.updateDatasetProfile(user.id, Number(profileId), {
            contract_json: updated
          });
        }
      } catch (err) {
        appendMessagesToCurrentConversation([{
          role: 'ai',
          content: `Failed to apply answers to contract: ${err.message}`,
          timestamp: new Date().toISOString()
        }]);
        return;
      }
    }

    // Resume run if we have one
    if (runId) {
      await handleResumeWorkflowA(runId);
    }
  }, [user?.id, appendMessagesToCurrentConversation, handleResumeWorkflowA]);

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
        fallbackActions: ['Retry or use the Resume button.', 'Start a new workflow run if this card is stale.']
      });
      appendMessagesToCurrentConversation([{
        role: 'ai',
        type: 'workflow_error_card',
        payload: {
          step: 'resume',
          error_code: uiError.code,
          error_message: uiError.message,
          next_actions: uiError.nextActions
        },
        timestamp: new Date().toISOString()
      }]);
      addNotification?.(`Failed to submit answers: ${uiError.message}`, 'error');
    }
  }, [
    user?.id,
    appendWorkflowStepEventMessages,
    appendMessagesToCurrentConversation,
    addNotification,
    processWorkflowRun,
    upsertWorkflowSnapshot
  ]);

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
          'Keep this run card for audit history only.'
        ];
        throw asyncError;
      }

      const replaySnapshot = await replayWorkflowRun(numericRunId, {
        use_cached_forecast: Boolean(options?.use_cached_forecast),
        use_cached_plan: Boolean(options?.use_cached_plan)
      });
      upsertWorkflowSnapshot(replaySnapshot);
      const newRunId = replaySnapshot?.run?.id;
      if (!newRunId) return;

      appendMessagesToCurrentConversation([
        {
          role: 'ai',
          content: `Replay started from run #${numericRunId} (new run #${newRunId}).`,
          timestamp: new Date().toISOString()
        },
        {
          role: 'ai',
          type: 'workflow_progress_card',
          payload: {
            run_id: newRunId
          },
          timestamp: new Date().toISOString()
        }
      ]);

      await processWorkflowRun(newRunId);
    } catch (error) {
      const uiError = normalizeWorkflowUiError(error, {
        fallbackMessage: 'Unable to replay workflow.',
        fallbackActions: ['Retry replay.', 'Run the workflow again from the latest dataset card.']
      });
      appendMessagesToCurrentConversation([{
        role: 'ai',
        type: 'workflow_error_card',
        payload: {
          step: 'replay',
          error_code: uiError.code,
          error_message: uiError.message,
          next_actions: uiError.nextActions
        },
        timestamp: new Date().toISOString()
      }]);
      addNotification?.(`Workflow replay failed: ${uiError.message}`, 'error');
    }
  }, [
    user?.id,
    workflowSnapshots,
    addNotification,
    appendMessagesToCurrentConversation,
    upsertWorkflowSnapshot,
    processWorkflowRun
  ]);

  const handleRequestRelax = useCallback((optionId) => {
    if (!optionId) return;
    appendMessagesToCurrentConversation([{
      role: 'ai',
      content: `Constraint relaxation requested: option ${optionId}. Use the Negotiation panel to evaluate and apply this option.`,
      timestamp: new Date().toISOString()
    }]);
  }, [appendMessagesToCurrentConversation]);

  // ---------------------------------------------------------------------------
  // Negotiation handlers (multi-round infeasibility resolution)
  // ---------------------------------------------------------------------------

  const handleGenerateNegotiationOptions = useCallback(async (cardPayload) => {
    if (!user?.id || !cardPayload?.planRunId) return;

    setIsNegotiationGenerating(true);

    try {
      const profileId = activeDatasetContext?.dataset_profile_id;
      if (!profileId) {
        appendMessagesToCurrentConversation([{
          role: 'ai',
          content: 'No dataset profile is linked to this session. Please upload a dataset first, then rerun forecast + plan.',
          timestamp: new Date().toISOString(),
        }]);
        return;
      }

      let resolvedProfileRow = null;
      try {
        resolvedProfileRow = await datasetProfilesService.getProfile(profileId);
      } catch (profileErr) {
        console.error('[DSV] Failed to load dataset profile for negotiation:', profileErr?.message);
      }

      if (!resolvedProfileRow?.user_file_id) {
        appendMessagesToCurrentConversation([{
          role: 'ai',
          content: 'Dataset profile has no linked source file. Re-upload the dataset from chat and rerun forecast + plan.',
          timestamp: new Date().toISOString(),
        }]);
        return;
      }

      const result = await runNegotiation({
        userId: user.id,
        planRunId: cardPayload.planRunId,
        datasetProfileRow: resolvedProfileRow,
        forecastRunId: sessionCtx.lastForecastRunId,
        config: {},
        bypassFeatureFlag: true,
      });

      if (result.triggered && result.negotiation_options) {
        sessionCtx.updateNegotiation(result, cardPayload.planRunId);

        appendMessagesToCurrentConversation([{
          role: 'ai',
          type: 'negotiation_card',
          payload: {
            planRunId: cardPayload.planRunId,
            trigger: result.trigger,
            negotiation_options: result.negotiation_options,
            negotiation_evaluation: result.negotiation_evaluation,
            negotiation_report: result.negotiation_report,
            round: sessionCtx.context?.negotiation?.round || 1,
          },
          timestamp: new Date().toISOString(),
        }]);
      } else {
        appendMessagesToCurrentConversation([{
          role: 'ai',
          content: `Negotiation analysis complete but no actionable options found${result.suppressed_reason ? ` (${result.suppressed_reason})` : ''}.`,
          timestamp: new Date().toISOString(),
        }]);
      }
    } catch (err) {
      appendMessagesToCurrentConversation([{
        role: 'ai',
        content: `Negotiation option generation failed: ${err.message}`,
        timestamp: new Date().toISOString(),
      }]);
    } finally {
      setIsNegotiationGenerating(false);
    }
  }, [user?.id, activeDatasetContext, sessionCtx, appendMessagesToCurrentConversation]);

  const handleApplyNegotiationOption = useCallback(async (option, evalResult, cardPayload) => {
    if (!user?.id || !option?.option_id) return;

    const optionId = option.option_id;
    const overrides = option.overrides || {};

    appendMessagesToCurrentConversation([{
      role: 'ai',
      content: `Applying negotiation option ${optionId}: "${option.title}"...`,
      timestamp: new Date().toISOString(),
    }]);

    // Rotate current plan to previous for comparison
    sessionCtx.rotatePlan();

    try {
      const profileId = activeDatasetContext?.dataset_profile_id;
      if (!profileId) {
        appendMessagesToCurrentConversation([{
          role: 'ai',
          content: 'No dataset profile is linked to this session. Please upload a dataset first, then rerun forecast + plan before applying negotiation options.',
          timestamp: new Date().toISOString(),
        }]);
        return;
      }

      let resolvedProfileRow = null;
      try {
        resolvedProfileRow = await datasetProfilesService.getProfile(profileId);
      } catch (profileErr) {
        console.error('[DSV] Failed to load dataset profile for negotiation apply:', profileErr?.message);
      }

      if (!resolvedProfileRow?.user_file_id) {
        appendMessagesToCurrentConversation([{
          role: 'ai',
          content: 'Dataset profile has no linked source file. Re-upload the dataset from chat and rerun forecast + plan before applying negotiation options.',
          timestamp: new Date().toISOString(),
        }]);
        return;
      }

      const constraintsOverride = overrides.constraints && Object.keys(overrides.constraints).length > 0
        ? overrides.constraints : null;
      const objectiveOverride = overrides.objective && Object.keys(overrides.objective).length > 0
        ? overrides.objective : null;

      const planResult = await runPlanFromDatasetProfile({
        userId: user.id,
        datasetProfileRow: resolvedProfileRow,
        forecastRunId: sessionCtx.lastForecastRunId,
        constraintsOverride,
        objectiveOverride,
      });

      // Update plan context
      sessionCtx.updatePlan(planResult);

      // Record negotiation option applied
      const newKpis = planResult?.solver_result?.kpis || {};
      sessionCtx.recordNegOptionApplied(optionId, planResult?.run?.id, newKpis);

      // Build plan cards
      const summaryPayload = buildPlanSummaryCardPayload(planResult, resolvedProfileRow);
      const tablePayload = buildPlanTableCardPayload(planResult);
      const projectionPayload = buildInventoryProjectionCardPayload(planResult);
      const downloadsPayload = buildPlanDownloadsPayload(planResult);

      // Build comparison
      const comparison = handlePlanComparison(sessionCtx.context);
      const comparisonText = comparison ? buildComparisonSummaryText(comparison) : '';

      const messages = [
        ...(comparison ? [{
          role: 'ai',
          type: 'plan_comparison_card',
          payload: comparison,
          content: comparisonText,
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
          type: 'downloads_card',
          payload: downloadsPayload,
          timestamp: new Date().toISOString(),
        },
      ];

      appendMessagesToCurrentConversation(messages);

      // Check if the new plan is STILL infeasible -- if so, trigger another round
      try {
        const newTrigger = await checkNegotiationTrigger(planResult?.run?.id);
        if (newTrigger) {
          const nextRound = (sessionCtx.context?.negotiation?.round || 1) + 1;
          appendMessagesToCurrentConversation([
            {
              role: 'ai',
              content: `Plan still has issues (${newTrigger}). Starting negotiation round ${nextRound}...`,
              timestamp: new Date().toISOString(),
            },
            {
              role: 'ai',
              type: 'negotiation_card',
              payload: {
                planRunId: planResult?.run?.id,
                trigger: newTrigger,
                negotiation_options: null,
                negotiation_evaluation: null,
                negotiation_report: null,
                round: nextRound,
              },
              timestamp: new Date().toISOString(),
            },
          ]);
        } else {
          appendMessagesToCurrentConversation([{
            role: 'ai',
            content: 'Negotiation option applied successfully. The new plan is feasible.',
            timestamp: new Date().toISOString(),
          }]);
          sessionCtx.clearNegotiation();
        }
      } catch (checkErr) {
        console.warn('[DSV] Post-negotiation trigger check failed:', checkErr?.message);
      }

      addNotification?.(`Plan re-run #${planResult?.run?.id || ''} with option ${optionId} completed.`, 'success');
      if (planResult?.run?.id) setLatestPlanRunId(planResult.run.id);
    } catch (err) {
      appendMessagesToCurrentConversation([{
        role: 'ai',
        content: `Failed to apply option ${optionId}: ${err.message}`,
        timestamp: new Date().toISOString(),
      }]);
    }
  }, [user?.id, activeDatasetContext, sessionCtx, appendMessagesToCurrentConversation, addNotification]);

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

  const handleDatasetUpload = useCallback(async (file) => {
    if (!file) return;
    if (!user?.id) {
      addNotification?.('Please sign in before uploading files.', 'error');
      return;
    }
    if (!currentConversationId) {
      addNotification?.('Please start a conversation first.', 'error');
      return;
    }
    if (Number(file.size || 0) > MAX_UPLOAD_BYTES) {
      addNotification?.(MAX_UPLOAD_MESSAGE, 'error');
      appendMessagesToCurrentConversation([{
        role: 'ai',
        content: `❌ ${MAX_UPLOAD_MESSAGE}`,
        timestamp: new Date().toISOString()
      }]);
      return;
    }

    setIsUploadingDataset(true);
    setIsDragOverUpload(false);
    setUploadStatusText('Uploaded. Profiling...');

    appendMessagesToCurrentConversation([
      {
        role: 'user',
        content: `📎 Uploaded file: ${file.name}`,
        timestamp: new Date().toISOString()
      },
      {
        role: 'ai',
        content: 'Uploaded. Profiling...',
        timestamp: new Date().toISOString()
      }
    ]);

    try {
      console.time('[DSV] upload:total');
      console.time('[DSV] upload:parse');
      const uploadPreparation = await prepareChatUploadFromFile(file);
      console.timeEnd('[DSV] upload:parse');
      const datasetFingerprint = buildFingerprintFromUpload(uploadPreparation.sheetsRaw, uploadPreparation.mappingPlans);

      // Fire-and-forget: save raw file in background (do NOT block upload)
      setUploadStatusText('Building profile...');
      let fileRecord = null;
      userFilesService.saveFile(user.id, file.name, uploadPreparation.rawRowsForStorage)
        .then((rec) => { fileRecord = rec; console.log('[DSV] upload:saveFile OK'); })
        .catch((err) => console.warn('[DSV] Raw file save skipped:', err?.message));

      console.time('[DSV] upload:createProfile');
      const PROFILE_TIMEOUT_MS = 20000;
      let profileRecord = await Promise.race([
        createDatasetProfileFromSheets({
          userId: user.id,
          userFileId: null,
          fileName: file.name,
          sheetsRaw: uploadPreparation.sheetsRaw,
          mappingPlans: uploadPreparation.mappingPlans,
          allowLLM: false
        }),
        new Promise((resolve) => setTimeout(() => {
          console.warn('[DSV] createProfile DB timed out, using local-only profile');
          resolve(null);
        }, PROFILE_TIMEOUT_MS))
      ]);
      console.timeEnd('[DSV] upload:createProfile');
      // If DB timed out, build a minimal local-only profile from the parsed data
      if (!profileRecord) {
        const mappingPlanMap = new Map(
          (uploadPreparation.mappingPlans || []).map((p) => [String(p.sheet_name || '').toLowerCase(), p])
        );
        profileRecord = {
          id: `local-${Date.now()}`,
          user_id: user.id,
          fingerprint: datasetFingerprint,
          profile_json: {
            file_name: file.name,
            global: {
              workflow_guess: { label: 'A', confidence: 0.5, reason: 'default (offline)' },
              time_range_guess: { start: null, end: null },
              minimal_questions: []
            },
            sheets: (uploadPreparation.sheetsRaw || []).map((s) => {
              const plan = mappingPlanMap.get(String(s.sheet_name || '').toLowerCase()) || {};
              return {
                sheet_name: s.sheet_name,
                likely_role: plan.upload_type || 'unknown',
                confidence: plan.confidence || 0,
                original_headers: s.columns || [],
                normalized_headers: (s.columns || []).map((c) => String(c).trim().toLowerCase()),
                grain_guess: { keys: [], time_column: null, granularity: 'unknown' },
                column_semantics: [],
                quality_checks: { type_issues: [], null_rate: {}, outlier_rate: {} },
                notes: []
              };
            })
          },
          contract_json: (() => {
            const sheetsRawMap = new Map(
              (uploadPreparation.sheetsRaw || []).map((s) => [String(s.sheet_name || '').toLowerCase(), s])
            );
            const datasets = (uploadPreparation.mappingPlans || []).map((p) => {
              const uploadType = p.upload_type || 'unknown';
              const rawSheet = sheetsRawMap.get(String(p.sheet_name || '').toLowerCase()) || {};
              const columns = rawSheet.columns || [];
              const status = (uploadType && uploadType !== 'unknown')
                ? getRequiredMappingStatus({ uploadType, columns, columnMapping: p.mapping || {} })
                : { coverage: 0, missingRequired: [], isComplete: false };
              return {
                sheet_name: p.sheet_name,
                upload_type: uploadType,
                mapping: p.mapping || {},
                requiredCoverage: Number((status.coverage || 0).toFixed(3)),
                missing_required_fields: status.missingRequired || [],
                validation: {
                  status: status.isComplete ? 'pass' : 'fail',
                  reasons: status.isComplete ? [] : [`Missing required fields: ${(status.missingRequired || []).join(', ')}`]
                }
              };
            });
            const allPass = datasets.length > 0 && datasets.every((d) => d.validation.status === 'pass');
            return {
              datasets,
              validation: {
                status: allPass ? 'pass' : 'fail',
                reasons: allPass ? [] : ['One or more sheets failed required field coverage']
              }
            };
          })(),
          created_at: new Date().toISOString(),
          _local: true,
          _inlineRawRows: uploadPreparation.rawRowsForStorage || []
        };
        // Register in service-level cache so getDatasetProfileById can find it
        registerLocalProfile(profileRecord);
      }

      // Persist raw rows in module-level cache (survives HMR/state resets)
      if (profileRecord?.id && Array.isArray(uploadPreparation.rawRowsForStorage) && uploadPreparation.rawRowsForStorage.length > 0) {
        _rawRowsCache.set(String(profileRecord.id), uploadPreparation.rawRowsForStorage);
      }

      // Reuse lookups — all non-blocking with 3s timeout
      const reuseEnabledForConversation = conversationDatasetContext[currentConversationId]?.reuse_enabled !== false;
      const workflow = getWorkflowFromProfile(profileRecord?.profile_json || {});
      let reusePlan = {
        contract_template_id: null,
        settings_template_id: null,
        confidence: 0,
        mode: 'no_reuse',
        explanation: 'Reuse skipped.'
      };
      let autoReused = false;
      let reusedSettingsTemplate = null;

      if (reuseEnabledForConversation) {
        try {
          const [contractTemplates, settingsTemplates, similarityIndexRows] = await Promise.race([
            Promise.all([
              reuseMemoryService.getContractTemplates(user.id, workflow, 60),
              reuseMemoryService.getRunSettingsTemplates(user.id, workflow, 60),
              reuseMemoryService.getRecentSimilarityIndex(user.id, 120)
            ]),
            new Promise((_, reject) => setTimeout(() => reject(new Error('reuse lookup timeout')), 15000))
          ]);

          reusePlan = buildReusePlan({
            dataset_profile: profileRecord,
            contract_templates: contractTemplates,
            settings_templates: settingsTemplates,
            similarity_index_rows: similarityIndexRows
          });
        } catch (error) {
          console.warn('[DSV] Reuse lookup skipped:', error.message);
        }
      }

      try {
        if (reusePlan.mode === 'auto_apply' && reusePlan.contract_template_id) {
          const template = await Promise.race([
            reuseMemoryService.getContractTemplateById(user.id, reusePlan.contract_template_id),
            new Promise((_, reject) => setTimeout(() => reject(new Error('reuse apply timeout')), 15000))
          ]);
          if (template?.contract_json) {
            const applied = applyContractTemplateToProfile({
              profile_json: profileRecord?.profile_json || {},
              contract_template_json: template.contract_json,
              sheetsRaw: uploadPreparation.sheetsRaw
            });
            const updated = await datasetProfilesService.updateDatasetProfile(user.id, profileRecord.id, {
              profile_json: applied.profile_json,
              contract_json: applied.contract_json
            });
            profileRecord = updated || {
              ...profileRecord,
              profile_json: applied.profile_json,
              contract_json: applied.contract_json
            };
            autoReused = true;
          }
        }

        if (reusePlan.mode === 'auto_apply' && reusePlan.settings_template_id) {
          const settingsTemplate = await Promise.race([
            reuseMemoryService.getRunSettingsTemplateById(user.id, reusePlan.settings_template_id),
            new Promise((_, reject) => setTimeout(() => reject(new Error('settings template timeout')), 15000))
          ]);
          if (settingsTemplate?.settings_json) {
            reusedSettingsTemplate = settingsTemplate.settings_json;
          }
        }
      } catch (reuseApplyErr) {
        console.warn('[DSV] Reuse auto-apply skipped:', reuseApplyErr?.message);
      }

      // Populate local data cache for Data tab (offline fallback)
      if (profileRecord?._local) {
        const UPLOAD_TO_TABLE = {
          inventory_snapshots: 'inventory_snapshots',
          po_open_lines: 'po_open_lines',
          supplier_master: 'suppliers',
        };
        const contractDatasets = profileRecord?.contract_json?.datasets || [];
        const sheetsRawMap = new Map(
          (uploadPreparation.sheetsRaw || []).map((s) => [String(s.sheet_name || '').toLowerCase(), s])
        );
        const allMaterialCodes = new Set();

        for (const dataset of contractDatasets) {
          const uploadType = dataset.upload_type;
          if (!uploadType || uploadType === 'unknown') continue;
          const rawSheet = sheetsRawMap.get(String(dataset.sheet_name || '').toLowerCase());
          if (!rawSheet?.rows?.length) continue;
          const mapping = dataset.mapping || {};
          // mapping is source→target: { excelCol: schemaField }
          const targetToSource = {};
          Object.entries(mapping).forEach(([src, tgt]) => { if (tgt) targetToSource[tgt] = src; });

          // Collect material codes for the Materials table
          const matCol = targetToSource['material_code'];
          if (matCol) {
            rawSheet.rows.forEach((row) => {
              const val = row[matCol];
              if (val != null && val !== '') allMaterialCodes.add(String(val));
            });
          }

          const tableKey = UPLOAD_TO_TABLE[uploadType];
          if (!tableKey || !TABLE_REGISTRY[tableKey]) continue;

          const mappedRows = rawSheet.rows.map((row, idx) => {
            const mapped = { id: `local-${idx}`, user_id: user.id };
            Object.entries(targetToSource).forEach(([targetField, sourceCol]) => {
              mapped[targetField] = row[sourceCol] ?? null;
            });
            // Map supplier_master fields to suppliers table columns
            if (uploadType === 'supplier_master') {
              mapped.contact_info = mapped.contact_person || mapped.phone || mapped.email || null;
              mapped.status = mapped.status || 'active';
            }
            return mapped;
          });
          setLocalTableData(tableKey, mappedRows);
        }

        // Populate materials table from unique material codes across all sheets
        if (allMaterialCodes.size > 0) {
          const materialRows = Array.from(allMaterialCodes).map((code, idx) => ({
            id: `local-mat-${idx}`,
            user_id: user.id,
            material_code: code,
            material_name: code,
            category: null,
            uom: null,
          }));
          setLocalTableData('materials', materialRows);
        }
      }

      const cardPayload = buildDataSummaryCardPayload(profileRecord);
      const validationPayload = buildValidationPayload(profileRecord);
      const downloadsPayload = buildDownloadsPayload({
        profileJson: profileRecord?.profile_json,
        contractJson: profileRecord?.contract_json,
        profileId: profileRecord?.id
      });
      const hasReusePrompt = reusePlan.mode === 'ask_one_click' && reusePlan.contract_template_id;
      const confirmationPayload = (autoReused || hasReusePrompt)
        ? null
        : buildConfirmationPayload(cardPayload, uploadPreparation.mappingPlans);
      const contractConfirmed = autoReused
        ? validationPayload.status === 'pass'
        : (hasReusePrompt ? false : (validationPayload.status === 'pass' && !confirmationPayload));

      setConversationDatasetContext((prev) => ({
        ...prev,
        [currentConversationId]: {
          ...(prev[currentConversationId] || {}),
          dataset_profile_id: profileRecord?.id,
          dataset_fingerprint: datasetFingerprint,
          user_file_id: fileRecord?.id || null,
          summary: cardPayload.context_summary || '',
          profileJson: profileRecord?.profile_json || {},
          contractJson: profileRecord?.contract_json || {},
          validationPayload,
          sheetsRaw: uploadPreparation.sheetsRaw,
          rawRowsForStorage: profileRecord?._local ? (uploadPreparation.rawRowsForStorage || []) : null,
          fileName: file.name,
          contractConfirmed,
          minimalQuestions: cardPayload.minimal_questions || [],
          reuse_enabled: reuseEnabledForConversation,
          force_retrain: Boolean(prev[currentConversationId]?.force_retrain),
          reused_settings_template: reusedSettingsTemplate,
          pending_reuse_plan: hasReusePrompt
            ? {
                ...reusePlan,
                dataset_profile_id: profileRecord?.id,
                dataset_fingerprint: datasetFingerprint
              }
            : null
        }
      }));

      const messages = [];
      if (autoReused) {
        messages.push({
          role: 'ai',
          content: `Reused mapping from previous dataset (confidence ${(Number(reusePlan.confidence || 0) * 100).toFixed(0)}%).`,
          timestamp: new Date().toISOString()
        });
      } else if (hasReusePrompt) {
        messages.push({
          role: 'ai',
          content: `I found a previous mapping for similar data (confidence ${(Number(reusePlan.confidence || 0) * 100).toFixed(0)}%). Apply it?`,
          timestamp: new Date().toISOString()
        });
        messages.push({
          role: 'ai',
          type: 'reuse_decision_card',
          payload: {
            ...reusePlan,
            dataset_profile_id: profileRecord?.id,
            dataset_fingerprint: datasetFingerprint
          },
          timestamp: new Date().toISOString()
        });
      } else {
        messages.push({
          role: 'ai',
          content: 'Saved profile.',
          timestamp: new Date().toISOString()
        });
      }
      messages.push(
        {
          role: 'ai',
          type: 'dataset_summary_card',
          payload: cardPayload,
          timestamp: new Date().toISOString()
        },
        {
          role: 'ai',
          type: 'validation_card',
          payload: validationPayload,
          timestamp: new Date().toISOString()
        },
        {
          role: 'ai',
          type: 'downloads_card',
          payload: downloadsPayload,
          timestamp: new Date().toISOString()
        }
      );

      if (confirmationPayload) {
        messages.push({
          role: 'ai',
          type: 'contract_confirmation_card',
          payload: confirmationPayload,
          timestamp: new Date().toISOString()
        });
      }

      appendMessagesToCurrentConversation(messages);

      const finalSignature = buildSignature(profileRecord?.profile_json || {}, profileRecord?.contract_json || {});
      reuseMemoryService.upsertDatasetSimilarityIndex({
        user_id: user.id,
        dataset_profile_id: profileRecord?.id,
        fingerprint: datasetFingerprint,
        signature_json: finalSignature
      }).catch((error) => {
        console.warn('[DecisionSupportView] Failed to persist similarity index:', error.message);
      });

      const validationPassed = profileRecord?.contract_json?.validation?.status === 'pass';
      if (validationPassed) {
        reuseMemoryService.upsertContractTemplate({
          user_id: user.id,
          fingerprint: datasetFingerprint,
          workflow,
          contract_json: profileRecord?.contract_json || {},
          quality_delta: 0.08
        }).catch((error) => {
          console.warn('[DecisionSupportView] Failed to upsert contract template:', error.message);
        });
      }

      if (reusedSettingsTemplate) {
        reuseMemoryService.upsertRunSettingsTemplate({
          user_id: user.id,
          fingerprint: datasetFingerprint,
          workflow,
          settings_json: reusedSettingsTemplate,
          quality_delta: 0.02
        }).catch((error) => {
          console.warn('[DecisionSupportView] Failed to update settings template usage:', error.message);
        });
      }

      console.timeEnd('[DSV] upload:total');
      addNotification?.('Upload complete: profile + contract + validation saved.', 'success');
    } catch (error) {
      console.timeEnd('[DSV] upload:total');
      const errorMessage = getErrorMessage(error, 'Unable to upload dataset.');
      console.error('[DSV] Dataset upload failed:', error?.message, error);
      appendMessagesToCurrentConversation([{
        role: 'ai',
        content: `❌ Upload failed: ${errorMessage}`,
        timestamp: new Date().toISOString()
      }]);
      addNotification?.(`Upload failed: ${errorMessage}`, 'error');
    } finally {
      setIsUploadingDataset(false);
      setUploadStatusText('');
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }, [user?.id, currentConversationId, conversationDatasetContext, appendMessagesToCurrentConversation, addNotification]);

  const handleFileInputChange = useCallback((e) => {
    const file = e.target.files?.[0];
    if (file) {
      handleDatasetUpload(file);
    }
  }, [handleDatasetUpload]);

  const handleDropUpload = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOverUpload(false);
    if (isUploadingDataset) return;
    const file = e.dataTransfer?.files?.[0];
    if (file) {
      handleDatasetUpload(file);
    }
  }, [handleDatasetUpload, isUploadingDataset]);

  const handleNewConversation = useCallback(async () => {
    if (!user?.id) {
      addNotification?.('Please sign in before starting a new conversation.', 'error');
      return;
    }

    setShowNewChatConfirm(false);

    const newConversation = {
      id: Date.now().toString(),
      user_id: user.id,
      title: 'New Conversation',
      messages: [{
        role: 'ai',
        content: `Hello! I'm your **${ASSISTANT_NAME}**. Upload a CSV/XLSX (max 50MB) and ask for a plan or forecast.\n\nI will show deterministic execution artifacts in Canvas.`
      }],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    setConversations((prev) => [newConversation, ...prev]);
    setCurrentConversationId(newConversation.id);
    updateCanvasState(newConversation.id, DEFAULT_CANVAS_STATE);

    if (conversationsDb) {
      conversationsDb.from('conversations').insert([newConversation]).then(({ error }) => {
        if (error) markTableUnavailable();
      });
    }

    addNotification?.('New conversation ready.', 'success');
  }, [user?.id, addNotification, updateCanvasState]);

  const handleDeleteConversation = useCallback(async (conversationId) => {
    if (!user?.id) return;

    setConversationDatasetContext((prev) => {
      const next = { ...prev };
      delete next[conversationId];
      return next;
    });
    setCanvasStateByConversation((prev) => {
      const next = { ...prev };
      delete next[conversationId];
      return next;
    });

    setConversations((prev) => {
      const updated = prev.filter((conversation) => conversation.id !== conversationId);
      if (conversationId === currentConversationId) {
        setCurrentConversationId(updated.length > 0 ? updated[0].id : null);
      }
      return updated;
    });

    if (conversationsDb) {
      conversationsDb.from('conversations').delete().eq('id', conversationId).eq('user_id', user.id).then(() => {});
    }
  }, [user?.id, currentConversationId]);

  const handleCanvasRun = useCallback(async (messageText, historyWithUserMessage) => {
    if (!currentConversationId || !activeDatasetContext || !user?.id) return null;

    if (!activeDatasetContext.contractConfirmed) {
      const warnText = 'Please confirm low-confidence contract mappings in the confirmation card before execution.';
      appendMessagesToCurrentConversation([{ role: 'ai', content: warnText, timestamp: new Date().toISOString() }]);
      addNotification?.('Please confirm contract mapping first.', 'warning');
      return null;
    }

    updateCanvasState(currentConversationId, (prev) => ({
      ...prev,
      isOpen: true,
      activeTab: 'logs',
      run: {
        ...(prev.run || {}),
        status: 'running'
      },
      logs: [],
      downloads: [],
      chartPayload: {
        actual_vs_forecast: [],
        inventory_projection: [],
        cost_breakdown: [],
        topology_graph: null
      },
      topologyRunning: false
    }));

    try {
      const result = await executeChatCanvasRun({
        userId: user.id,
        prompt: messageText,
        datasetProfileId: activeDatasetContext.dataset_profile_id,
        datasetFingerprint: activeDatasetContext.dataset_fingerprint,
        profileJson: activeDatasetContext.profileJson,
        contractJson: activeDatasetContext.contractJson,
        sheetsRaw: activeDatasetContext.sheetsRaw || [],
        callbacks: {
          onLog: (logItem) => {
            updateCanvasState(currentConversationId, (prev) => ({
              ...prev,
              logs: [...(prev.logs || []), logItem]
            }));
          },
          onStepChange: (stepStatuses) => {
            updateCanvasState(currentConversationId, (prev) => ({
              ...prev,
              stepStatuses
            }));
          },
          onArtifact: ({ fileName, mimeType, content }) => {
            updateCanvasState(currentConversationId, (prev) => {
              const nextDownloads = [
                ...(prev.downloads || []),
                {
                  label: fileName,
                  fileName,
                  mimeType,
                  content
                }
              ];
              return {
                ...prev,
                downloads: nextDownloads,
                codeText: fileName === 'ml_code.py' ? String(content || '') : prev.codeText
              };
            });
          },
          onRunChange: (runModel) => {
            updateCanvasState(currentConversationId, (prev) => ({
              ...prev,
              run: runModel
            }));
          }
        }
      });

      updateCanvasState(currentConversationId, (prev) => ({
        ...prev,
        run: result.run,
        chartPayload: result.chartPayload,
        stepStatuses: result.stepStatuses,
        activeTab: 'charts'
      }));

      const summaryText = buildEvidenceSummaryText(result.summary);
      const reportFile = {
        label: 'run_report.json',
        fileName: 'run_report.json',
        mimeType: 'application/json',
        content: {
          summary: result.summary,
          evidence_pack: result.evidencePack,
          validation: result.validation,
          solver_used: result.solverUsed
        }
      };

      updateCanvasState(currentConversationId, (prev) => ({
        ...prev,
        downloads: [...(prev.downloads || []), reportFile]
      }));

      const aiMessage = {
        role: 'ai',
        content: summaryText,
        timestamp: new Date().toISOString()
      };

      const finalMessages = [...historyWithUserMessage, aiMessage];
      const newTitle = currentMessages.length <= 1 ? messageText.slice(0, 50) : currentConversation.title;

      const updatedConversation = {
        ...currentConversation,
        title: newTitle,
        messages: finalMessages,
        updated_at: new Date().toISOString()
      };

      setConversations((prev) => prev.map((conversation) =>
        conversation.id === currentConversationId ? updatedConversation : conversation
      ));

      if (conversationsDb) {
        conversationsDb
          .from('conversations')
          .update({
            title: newTitle,
            messages: finalMessages,
            updated_at: new Date().toISOString()
          })
          .eq('id', currentConversationId)
          .eq('user_id', user.id)
          .then(({ error }) => {
            if (error) markTableUnavailable();
          });
      }

      return true;
    } catch (error) {
      console.error('Canvas execution failed:', error);
      updateCanvasState(currentConversationId, (prev) => ({
        ...prev,
        run: {
          ...(prev.run || {}),
          status: 'failed'
        },
        activeTab: 'logs',
        logs: [
          ...(prev.logs || []),
          {
            id: `err_${Date.now()}`,
            step: 'report',
            message: `❌ Execution failed: ${error.message}`,
            timestamp: new Date().toISOString()
          }
        ]
      }));

      const aiMessage = {
        role: 'ai',
        content: `❌ Canvas execution failed: ${error.message}`,
        timestamp: new Date().toISOString()
      };
      const finalMessages = [...historyWithUserMessage, aiMessage];
      const updatedConversation = {
        ...currentConversation,
        messages: finalMessages,
        updated_at: new Date().toISOString()
      };
      setConversations((prev) => prev.map((conversation) =>
        conversation.id === currentConversationId ? updatedConversation : conversation
      ));

      if (conversationsDb) {
        conversationsDb
          .from('conversations')
          .update({
            messages: finalMessages,
            updated_at: new Date().toISOString()
          })
          .eq('id', currentConversationId)
          .eq('user_id', user.id)
          .then(({ error: updateError }) => {
            if (updateError) markTableUnavailable();
          });
      }
      return false;
    }
  }, [
    currentConversationId,
    activeDatasetContext,
    user?.id,
    updateCanvasState,
    appendMessagesToCurrentConversation,
    addNotification,
    currentConversation,
    currentMessages
  ]);

  const handleSend = useCallback(async (e) => {
    if (e) e.preventDefault();
    if (!input.trim() || !currentConversationId) return;

    const userMessage = {
      role: 'user',
      content: input,
      timestamp: new Date().toISOString()
    };

    const messageText = input;
    setInput('');
    setIsTyping(true);
    setStreamingContent('');

    try {
      if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      }

    const updatedMessages = [...currentMessages, userMessage];
    setConversations((prev) => prev.map((conversation) =>
      conversation.id === currentConversationId
        ? { ...conversation, messages: updatedMessages, updated_at: new Date().toISOString() }
        : conversation
    ));

    const trimmed = String(messageText || '').trim();
    const lower = trimmed.toLowerCase();
    const command = lower.split(/\s+/)[0];

    if (lower.startsWith('/reuse')) {
      const parts = trimmed.split(/\s+/);
      const mode = String(parts[1] || 'off').toLowerCase();
      const reuseEnabled = mode !== 'off';
      setConversationDatasetContext((prev) => ({
        ...prev,
        [currentConversationId]: {
          ...(prev[currentConversationId] || {}),
          reuse_enabled: reuseEnabled,
          pending_reuse_plan: reuseEnabled ? prev[currentConversationId]?.pending_reuse_plan || null : null,
          reused_settings_template: reuseEnabled ? prev[currentConversationId]?.reused_settings_template || null : null
        }
      }));
      appendMessagesToCurrentConversation([{
        role: 'ai',
        content: reuseEnabled
          ? 'Reuse is enabled for this conversation.'
          : 'Reuse is disabled for this conversation.',
        timestamp: new Date().toISOString()
      }]);
      setIsTyping(false);
      setStreamingContent('');
      return;
    }

    if (lower.startsWith('/retrain')) {
      const parts = trimmed.split(/\s+/);
      const mode = String(parts[1] || 'on').toLowerCase();
      const forceRetrain = mode !== 'off';
      setConversationDatasetContext((prev) => ({
        ...prev,
        [currentConversationId]: {
          ...(prev[currentConversationId] || {}),
          force_retrain: forceRetrain
        }
      }));
      appendMessagesToCurrentConversation([{
        role: 'ai',
        content: forceRetrain
          ? 'Forecast retrain is forced for this conversation.'
          : 'Forecast retrain force is disabled.',
        timestamp: new Date().toISOString()
      }]);
      setIsTyping(false);
      setStreamingContent('');
      return;
    }

    if (command === '/reset_data') {
      const parts = lower.split(/\s+/);
      const confirmed = parts[1] === 'confirm';

      if (!confirmed) {
        appendMessagesToCurrentConversation([{
          role: 'ai',
          content: 'Type /reset_data confirm to proceed.',
          timestamp: new Date().toISOString()
        }]);
        setIsTyping(false);
        setStreamingContent('');
        return;
      }

      try {
        await diResetService.resetCurrentUserData();

        setConversationDatasetContext((prev) => {
          const next = {};
          Object.keys(prev || {}).forEach((conversationId) => {
            next[conversationId] = {
              ...(prev[conversationId] || {}),
              dataset_profile_id: null,
              dataset_fingerprint: null,
              user_file_id: null,
              summary: '',
              profileJson: {},
              contractJson: {},
              contractConfirmed: false,
              minimalQuestions: [],
              pending_reuse_plan: null,
              reused_settings_template: null
            };
          });
          return next;
        });

        setLatestPlanRunId(null);
        setRunningForecastProfiles({});
        setRunningPlanKeys({});
        setWorkflowSnapshots({});
        setActiveWorkflowRuns({});
        setCanvasStateByConversation({});
        topologyAutoLoadRef.current = {};

        appendMessagesToCurrentConversation([{
          role: 'ai',
          content: '✅ Cleared old profiles/runs/artifacts for this user.',
          timestamp: new Date().toISOString()
        }]);
      } catch (error) {
        appendMessagesToCurrentConversation([{
          role: 'ai',
          content: `❌ Failed to clear DI data: ${getErrorMessage(error, 'Unexpected error')}`,
          timestamp: new Date().toISOString()
        }]);
      }

      setIsTyping(false);
      setStreamingContent('');
      return;
    }

    if (lower.startsWith('/forecast')) {
      const parts = trimmed.split(/\s+/);
      const profileId = parts.length > 1 ? Number(parts[1]) : null;
      await executeForecastFlow({
        profileId: Number.isFinite(profileId)
          ? profileId
          : (Number.isFinite(Number(activeDatasetContext?.dataset_profile_id))
              ? Number(activeDatasetContext.dataset_profile_id)
              : null)
      });
      setIsTyping(false);
      setStreamingContent('');
      return;
    }

    if (lower.startsWith('/plan')) {
      const parts = trimmed.split(/\s+/);
      const profileId = parts.length > 1 ? Number(parts[1]) : null;
      await executePlanFlow({
        datasetProfileId: Number.isFinite(profileId)
          ? profileId
          : (Number.isFinite(Number(activeDatasetContext?.dataset_profile_id))
              ? Number(activeDatasetContext.dataset_profile_id)
              : null)
      });
      setIsTyping(false);
      setStreamingContent('');
      return;
    }

    if (command === '/workflowa' || command === '/run-workflow-a') {
      const parts = trimmed.split(/\s+/);
      const profileId = parts.length > 1 ? Number(parts[1]) : null;
      await executeWorkflowAFlow({
        datasetProfileId: Number.isFinite(profileId)
          ? profileId
          : (Number.isFinite(Number(activeDatasetContext?.dataset_profile_id))
              ? Number(activeDatasetContext.dataset_profile_id)
              : null)
      });
      setIsTyping(false);
      setStreamingContent('');
      return;
    }

    if (command === '/workflow') {
      const parts = trimmed.split(/\s+/);
      const profileId = parts.length > 1 ? Number(parts[1]) : null;
      await executeWorkflowFlow({
        datasetProfileId: Number.isFinite(profileId)
          ? profileId
          : (Number.isFinite(Number(activeDatasetContext?.dataset_profile_id))
              ? Number(activeDatasetContext.dataset_profile_id)
              : null)
      });
      setIsTyping(false);
      setStreamingContent('');
      return;
    }

    if (command === '/workflowb' || command === '/run-workflow-b' || command === '/risk') {
      const parts = trimmed.split(/\s+/);
      const profileId = parts.length > 1 ? Number(parts[1]) : null;
      await executeWorkflowBFlow({
        datasetProfileId: Number.isFinite(profileId)
          ? profileId
          : (Number.isFinite(Number(activeDatasetContext?.dataset_profile_id))
              ? Number(activeDatasetContext.dataset_profile_id)
              : null)
      });
      setIsTyping(false);
      setStreamingContent('');
      return;
    }

    if (command === '/topology') {
      const parts = trimmed.split(/\s+/);
      const explicitRunId = parts.length > 1 ? Number(parts[1]) : null;
      await handleRunTopology(Number.isFinite(explicitRunId) ? explicitRunId : topologyRunId);
      setIsTyping(false);
      setStreamingContent('');
      return;
    }

    // SmartOps 2.0: LLM-powered intent parsing + action routing
    try {
      const parsedIntent = await parseIntent({
        userMessage: messageText,
        sessionContext: sessionCtx.context,
        domainContext,
      });

      if (parsedIntent.intent !== 'GENERAL_CHAT' && parsedIntent.confidence > 0.7) {
        const intentHandlers = {
          executePlanFlow: (params) => executePlanFlow({
            datasetProfileId: params.datasetProfileId || (Number.isFinite(Number(activeDatasetContext?.dataset_profile_id)) ? Number(activeDatasetContext.dataset_profile_id) : null),
            constraintsOverride: params.constraintsOverride,
            objectiveOverride: params.objectiveOverride,
          }),
          executeForecastFlow: (params) => executeForecastFlow({
            datasetProfileId: params.datasetProfileId || (Number.isFinite(Number(activeDatasetContext?.dataset_profile_id)) ? Number(activeDatasetContext.dataset_profile_id) : null),
          }),
          executeWorkflowAFlow: (params) => executeWorkflowAFlow({
            datasetProfileId: params.datasetProfileId || (Number.isFinite(Number(activeDatasetContext?.dataset_profile_id)) ? Number(activeDatasetContext.dataset_profile_id) : null),
          }),
          executeWorkflowBFlow: (params) => executeWorkflowBFlow({
            datasetProfileId: params.datasetProfileId || (Number.isFinite(Number(activeDatasetContext?.dataset_profile_id)) ? Number(activeDatasetContext.dataset_profile_id) : null),
          }),
          executeDigitalTwinFlow: (params) => executeDigitalTwinFlow({
            scenario: params.scenario || 'normal',
            chaosIntensity: params.chaosIntensity || null,
          }),
          handleParameterChange: async (intent, ctx) => {
            const result = await handleParameterChange({
              parsedIntent: intent,
              sessionContext: ctx,
              userId: user?.id,
              conversationId: currentConversationId,
              rerunPlan: (params) => executePlanFlow({
                datasetProfileId: Number.isFinite(Number(activeDatasetContext?.dataset_profile_id)) ? Number(activeDatasetContext.dataset_profile_id) : null,
                constraintsOverride: params.constraintsOverride,
                objectiveOverride: params.objectiveOverride,
              }),
            });
            if (result?.comparison) {
              appendMessagesToCurrentConversation([{
                role: 'ai',
                type: 'plan_comparison_card',
                payload: result.comparison,
                content: buildComparisonSummaryText(result.comparison),
                timestamp: new Date().toISOString(),
              }]);
            }
          },
          comparePlans: (ctx) => {
            const comparison = handlePlanComparison(ctx);
            if (comparison) {
              appendMessagesToCurrentConversation([{
                role: 'ai',
                type: 'plan_comparison_card',
                payload: comparison,
                content: buildComparisonSummaryText(comparison),
                timestamp: new Date().toISOString(),
              }]);
            } else {
              appendMessagesToCurrentConversation([{
                role: 'ai',
                content: 'No previous plan available for comparison. Run a plan first, then make changes to compare.',
                timestamp: new Date().toISOString(),
              }]);
            }
          },
          runWhatIf: (scenarioOverrides) => {
            // Delegate to existing what-if flow via canvas run
            handleCanvasRun(messageText, updatedMessages);
          },
          handleApproval: async (action) => {
            const pending = (sessionCtx.context?.pending_approvals || []).filter((a) => a.status === 'PENDING');
            if (pending.length === 0) {
              appendMessagesToCurrentConversation([{
                role: 'ai',
                content: 'No pending approvals found.',
                timestamp: new Date().toISOString(),
              }]);
              return;
            }
            const approvalIds = pending.map((a) => a.approval_id);
            if (action === 'approve_all') {
              await batchApprove({ approvalIds, userId: user?.id, note: 'Approved via chat' });
              approvalIds.forEach((id) => sessionCtx.resolveApproval(id, 'APPROVED'));
              appendMessagesToCurrentConversation([{
                role: 'ai',
                content: `Approved ${approvalIds.length} pending approval(s).`,
                timestamp: new Date().toISOString(),
              }]);
            } else if (action === 'reject_all') {
              await batchReject({ approvalIds, userId: user?.id, note: 'Rejected via chat' });
              approvalIds.forEach((id) => sessionCtx.resolveApproval(id, 'REJECTED'));
              appendMessagesToCurrentConversation([{
                role: 'ai',
                content: `Rejected ${approvalIds.length} pending approval(s).`,
                timestamp: new Date().toISOString(),
              }]);
            }
          },
          applyNegotiationOption: async ({ optionId, optionTitle }) => {
            const negCtx = sessionCtx.context?.negotiation;
            if (!negCtx || negCtx.round === 0 || !negCtx.options) {
              appendMessagesToCurrentConversation([{
                role: 'ai',
                content: 'No active negotiation session. Please run a plan first to trigger negotiation options.',
                timestamp: new Date().toISOString(),
              }]);
              return;
            }

            const optionDefs = negCtx.options?.options || [];
            let matchedOption = null;

            if (optionId) {
              const normalizedId = String(optionId).match(/^opt_\d+$/)
                ? optionId
                : `opt_${String(optionId).replace(/\D/g, '').padStart(3, '0')}`;
              matchedOption = optionDefs.find((o) => o.option_id === normalizedId);
            }

            if (!matchedOption && optionTitle) {
              const lowerTitle = optionTitle.toLowerCase();
              matchedOption = optionDefs.find((o) =>
                o.title.toLowerCase().includes(lowerTitle)
              );
            }

            if (!matchedOption && (optionTitle || '').toLowerCase().includes('recommend')) {
              const recommendedId = negCtx.report?.recommended_option_id;
              matchedOption = optionDefs.find((o) => o.option_id === recommendedId);
            }

            if (!matchedOption) {
              appendMessagesToCurrentConversation([{
                role: 'ai',
                content: `Could not identify option "${optionId || optionTitle}". Available options: ${optionDefs.map((o) => `${o.option_id} ("${o.title}")`).join(', ')}`,
                timestamp: new Date().toISOString(),
              }]);
              return;
            }

            const rankedOptions = negCtx.evaluation?.ranked_options || [];
            const evalResult = rankedOptions.find((r) => r.option_id === matchedOption.option_id) || null;

            await handleApplyNegotiationOption(
              matchedOption,
              evalResult,
              { planRunId: negCtx.active_plan_run_id }
            );
          },
          appendMessage: (msg) => appendMessagesToCurrentConversation([msg]),
          onNoDataset: () => appendMessagesToCurrentConversation([{
            role: 'ai',
            content: 'Please upload a dataset first. You can drag and drop a CSV or XLSX file into the chat.',
            timestamp: new Date().toISOString(),
          }]),
        };

        const result = await routeIntent(parsedIntent, sessionCtx.context, intentHandlers, {
          userId: user?.id,
          conversationId: currentConversationId,
          datasetProfileId: Number.isFinite(Number(activeDatasetContext?.dataset_profile_id)) ? Number(activeDatasetContext.dataset_profile_id) : null,
        });

        if (result?.handled) {
          setIsTyping(false);
          setStreamingContent('');
          return;
        }
      }
    } catch (intentError) {
      console.warn('[DSV] Intent parsing failed, falling through to chat:', intentError?.message);
    }

    // Fallback: legacy keyword-based execution intent
    const canExecute = Boolean(activeDatasetContext?.dataset_profile_id) && isExecutionIntent(messageText);
    if (canExecute) {
      const handled = await handleCanvasRun(messageText, updatedMessages);
      setIsTyping(false);
      setStreamingContent('');
      if (handled) {
        return;
      }
    }

    const history = updatedMessages.slice(-10);

    let fullResult = '';
    let aiErrorPayload = null;
    try {
      fullResult = await streamChatWithAI(
        messageText,
        history,
        systemPrompt,
        (chunk) => {
          setStreamingContent((prev) => prev + chunk);
        }
      );
    } catch (error) {
      console.error('AI call failed:', error);
      if (isApiKeyConfigError(error?.message)) {
        aiErrorPayload = {
          title: 'AI service configuration required',
          message: 'Server-side AI keys are missing or invalid. Ask an admin to set Supabase Edge Function secrets.',
          ctaLabel: 'Show setup hint'
        };
      } else {
        fullResult = `❌ AI service temporarily unavailable\n\nError: ${error.message}`;
      }
    }

    if (!aiErrorPayload && isApiKeyConfigError(fullResult)) {
      aiErrorPayload = {
        title: 'AI service configuration required',
        message: 'Server-side AI keys are missing or invalid. Ask an admin to set Supabase Edge Function secrets.',
        ctaLabel: 'Show setup hint'
      };
    }

    const aiMessage = aiErrorPayload
      ? {
          role: 'ai',
          type: 'ai_error_card',
          payload: aiErrorPayload,
          timestamp: new Date().toISOString()
        }
      : {
          role: 'ai',
          content: fullResult,
          timestamp: new Date().toISOString()
        };

    const finalMessages = [...updatedMessages, aiMessage];
    const newTitle = currentMessages.length <= 1 ? messageText.slice(0, 50) : currentConversation.title;

    const updatedConversation = {
      ...currentConversation,
      title: newTitle,
      messages: finalMessages,
      updated_at: new Date().toISOString()
    };

    setConversations((prev) => prev.map((conversation) =>
      conversation.id === currentConversationId ? updatedConversation : conversation
    ));

    setStreamingContent('');
    setIsTyping(false);

      if (conversationsDb) {
        conversationsDb
          .from('conversations')
          .update({
            title: newTitle,
            messages: finalMessages,
            updated_at: new Date().toISOString()
          })
          .eq('id', currentConversationId)
          .eq('user_id', user.id)
          .then(({ error }) => {
            if (error) markTableUnavailable();
          });
      }
    } catch (error) {
      console.error('[DSV] handleSend failed:', error);
      appendMessagesToCurrentConversation([{
        role: 'ai',
        content: `❌ Request failed: ${getErrorMessage(error, 'Unexpected error')}`,
        timestamp: new Date().toISOString()
      }]);
    } finally {
      setIsTyping(false);
      setStreamingContent('');
    }
  }, [
    input,
    currentConversationId,
    currentMessages,
    currentConversation,
    systemPrompt,
    user?.id,
    activeDatasetContext,
    handleCanvasRun,
    appendMessagesToCurrentConversation,
    executeForecastFlow,
    executePlanFlow,
    executeWorkflowFlow,
    executeWorkflowAFlow,
    executeWorkflowBFlow,
    executeDigitalTwinFlow,
    handleRunTopology,
    topologyRunId,
    setActiveWorkflowRuns
  ]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend(e);
    }
  }, [handleSend]);

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
    Object.keys(activeWorkflowRuns || {}).forEach((runId) => {
      const numericRunId = Number(runId);
      const snapshot = workflowSnapshots[numericRunId] || workflowSnapshots[runId];
      const profileId = snapshot?.run?.dataset_profile_id;
      if (profileId) {
        index[profileId] = true;
      }
    });
    return index;
  }, [activeWorkflowRuns, workflowSnapshots]);

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

  const handleConfigureApiKey = useCallback(() => {
    addNotification?.(
      'AI keys are now managed in Supabase Edge Function secrets (GEMINI_API_KEY / DEEPSEEK_API_KEY).',
      'info'
    );
  }, [addNotification]);

  const renderSpecialMessage = useCallback((message) => {
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
                _inlineRawRows: ctx.rawRowsForStorage || _rawRowsCache.get(profileIdStr) || null
              }
            });
          }}
          onRunWorkflow={(cardPayload) => executeWorkflowAFlow({
            datasetProfileId: cardPayload?.dataset_profile_id || null
          })}
          onRunRisk={(cardPayload) => executeWorkflowBFlow({
            datasetProfileId: cardPayload?.dataset_profile_id || null
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
                  activeTab: 'topology'
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
            forecastCardPayload: forecastPayload
          })}
          onRunRiskAwarePlan={() => executeRiskAwarePlanFlow({
            datasetProfileId: message.payload?.dataset_profile_id,
            forecastRunId: message.payload?.run_id,
            forecastCardPayload: message.payload
          })}
          isPlanRunning={Boolean(runningPlanKeys[message.payload?.run_id || `profile_${message.payload?.dataset_profile_id}`])}
        />
      );
    }
    if (message.type === 'forecast_error_card') {
      return <ForecastErrorCard payload={message.payload} />;
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
    return null;
  }, [
    activeDatasetContext,
    currentConversationId,
    handleConfigureApiKey,
    handleApprovePlanApproval,
    handleRejectPlanApproval,
    handleRequestPlanApproval,
    handleContractConfirmation,
    handleUseDatasetContextFromCard,
    updateCanvasState,
    executeForecastFlow,
    executePlanFlow,
    executeWorkflowAFlow,
    executeWorkflowBFlow,
    runningForecastProfiles,
    runningPlanKeys,
    runningWorkflowProfileIds,
    workflowSnapshots,
    handleResumeWorkflowA,
    handleReplayWorkflowA,
    handleBlockingQuestionsSubmit,
    handleSubmitBlockingAnswers,
    handleCancelAsyncWorkflow,
    handleApplyReuseSuggestion,
    handleReviewReuseSuggestion,
    executeRiskAwarePlanFlow,
    handleRiskReplanDecision,
    handleRequestRelax,
    isNegotiationGenerating,
    handleGenerateNegotiationOptions,
    handleApplyNegotiationOption
  ]);

  return (
    <div className="h-full w-full flex flex-col p-2 md:p-3 animate-fade-in">
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
                    <h3 className="text-base font-medium text-slate-800 dark:text-slate-100 truncate">{currentConversation.title}</h3>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-slate-500">{currentMessages.length} messages</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${contextBadge.color}`}>{contextBadge.text}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowNewChatConfirm(true)}
                    className="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                    title="New conversation"
                  >
                    <FileText className="w-4 h-4 text-slate-500" />
                  </button>
                </div>

                <ChatThread
                  messages={currentMessages}
                  isTyping={isTyping}
                  streamingContent={streamingContent}
                  formatTime={formatTime}
                  renderSpecialMessage={renderSpecialMessage}
                  quickPrompts={QUICK_PROMPTS}
                  onSelectPrompt={(promptText) => {
                    setInput(promptText);
                    textareaRef.current?.focus();
                  }}
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
                  onDragEnter={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!isUploadingDataset) setIsDragOverUpload(true);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!isUploadingDataset) setIsDragOverUpload(true);
                  }}
                  onDragLeave={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!e.currentTarget.contains(e.relatedTarget)) {
                      setIsDragOverUpload(false);
                    }
                  }}
                  onDrop={handleDropUpload}
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
            onToggleOpen={isCanvasDetached
              ? () => { setIsCanvasDetached(false); handleCanvasToggle(); }
              : handleCanvasToggle}
            onPopout={isCanvasDetached
              ? () => setIsCanvasDetached(false)
              : () => setIsCanvasDetached(true)}
            isDetached={isCanvasDetached}
            activeTab={activeCanvasState.activeTab}
            onTabChange={(tabId) => {
              if (!currentConversationId) return;
              updateCanvasState(currentConversationId, (prev) => ({
                ...prev,
                activeTab: tabId
              }));
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
              contract_json: activeDatasetContext.contractJson || {}
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
      />

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
              <Button variant="secondary" onClick={() => setShowNewChatConfirm(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={handleNewConversation}>
                New Conversation
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
