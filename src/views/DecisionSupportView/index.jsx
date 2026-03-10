// ============================================
// Decision Support View - Chat + Canvas
// Single-screen chat-first workflow with white-box execution
// ============================================

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
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
import { executeChatCanvasRun } from '../../services/chatCanvasWorkflowService';
import CanvasPanel from '../../components/chat/CanvasPanel';
import { checkNegotiationTrigger, runNegotiation } from '../../services/negotiation/negotiationOrchestrator';
import SplitShell from '../../components/chat/SplitShell';
import ConversationSidebar from '../../components/chat/ConversationSidebar';
import ChatThread from '../../components/chat/ChatThread';
import ChatComposer from '../../components/chat/ChatComposer';
import useSessionContext from '../../hooks/useSessionContext';
import { parseIntent, routeIntent } from '../../services/chatIntentService';
import { handleParameterChange, handlePlanComparison, buildComparisonSummaryText } from '../../services/chatRefinementService';
import { createAlertMonitor, buildAlertChatMessage, isAlertMonitorEnabled } from '../../services/alertMonitorService';
import { batchApprove, batchReject } from '../../services/approvalWorkflowService';
import {
  SIDEBAR_COLLAPSED_KEY_PREFIX,
  CANVAS_SPLIT_RATIO_KEY_PREFIX,
  MAX_UPLOAD_MESSAGE,
  DEFAULT_CANVAS_STATE,
  QUICK_PROMPTS,
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

const tableAvailable = initTableAvailability();
const conversationsDb = tableAvailable ? supabase : null;

// Module-level cache for inline raw rows — survives HMR state resets
const _rawRowsCache = new Map();

export default function DecisionSupportView({ user, addNotification }) {
  const userStorageSuffix = user?.id || 'anon';
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [domainContext, setDomainContext] = useState(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [isUploadingDataset, setIsUploadingDataset] = useState(false);
  const [isDragOverUpload, setIsDragOverUpload] = useState(false);
  const [uploadStatusText, setUploadStatusText] = useState('');
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

  const alertMonitorRef = useRef(null);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const topologyAutoLoadRef = useRef({});

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

  // ── Canvas state updater ────────────────────────────────────────────────
  const updateCanvasState = useCallback((conversationId, updater) => {
    if (!conversationId) return;
    const setter = canvasStateByConversationRef.current;
    if (!setter) return;
    setter((prev) => {
      const existing = prev[conversationId] || DEFAULT_CANVAS_STATE;
      const nextValue = typeof updater === 'function' ? updater(existing) : { ...existing, ...(updater || {}) };
      return {
        ...prev,
        [conversationId]: nextValue
      };
    });
  }, []);

  // ── Conversation manager hook ──────────────────────────────────────────
  const convManager = useConversationManager({
    user,
    addNotification,
    updateCanvasState,
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
    appendMessagesToCurrentConversation([{
      role: 'ai',
      content: `Synthetic dataset **${desc.dataset_id || 'unknown'}** loaded (${desc.n_materials || '?'} materials, ${desc.n_plants || '?'} plants, ${desc.n_days || '?'} days). You can now run /forecast, /plan, or /workflowa.`,
      timestamp: new Date().toISOString(),
    }]);

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

  const handleSplitRatioCommit = useCallback((nextRatio) => {
    const clamped = clampSplitRatio(nextRatio);
    setSplitRatio(clamped);
    try { localStorage.setItem(splitRatioStorageKey, String(clamped)); } catch { /* noop */ }
  }, [splitRatioStorageKey]);

  const handleCanvasToggle = useCallback(() => {
    if (!currentConversationId) return;
    updateCanvasState(currentConversationId, (prev) => ({ ...prev, isOpen: !prev.isOpen }));
  }, [currentConversationId, updateCanvasState]);

  const systemPrompt = useMemo(() => {
    if (!domainContext) return '';
    return buildSystemPrompt(domainContext, activeDatasetContext);
  }, [domainContext, activeDatasetContext]);

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

  // ── Dataset upload handler ──────────────────────────────────────────────
  const handleDatasetUpload = useCallback(async (file) => {
    if (!file) return;
    if (!user?.id) { addNotification?.('Please sign in before uploading files.', 'error'); return; }
    if (!currentConversationId) { addNotification?.('Please start a conversation first.', 'error'); return; }
    if (Number(file.size || 0) > MAX_UPLOAD_BYTES) {
      addNotification?.(MAX_UPLOAD_MESSAGE, 'error');
      appendMessagesToCurrentConversation([{ role: 'ai', content: `❌ ${MAX_UPLOAD_MESSAGE}`, timestamp: new Date().toISOString() }]);
      return;
    }

    setIsUploadingDataset(true);
    setIsDragOverUpload(false);
    setUploadStatusText('Uploaded. Profiling...');

    appendMessagesToCurrentConversation([
      { role: 'user', content: `📎 Uploaded file: ${file.name}`, timestamp: new Date().toISOString() },
      { role: 'ai', content: 'Uploaded. Profiling...', timestamp: new Date().toISOString() }
    ]);

    try {
      console.time('[DSV] upload:total');
      console.time('[DSV] upload:parse');
      const uploadPreparation = await prepareChatUploadFromFile(file);
      console.timeEnd('[DSV] upload:parse');
      const datasetFingerprint = buildFingerprintFromUpload(uploadPreparation.sheetsRaw, uploadPreparation.mappingPlans);

      setUploadStatusText('Saving file...');
      let fileRecord = null;
      try {
        fileRecord = await userFilesService.saveFile(user.id, file.name, uploadPreparation.rawRowsForStorage);
        console.log('[DSV] upload:saveFile OK, id:', fileRecord?.id);
      } catch (err) { console.warn('[DSV] Raw file save skipped:', err?.message); }

      setUploadStatusText('Building profile...');
      console.time('[DSV] upload:createProfile');
      const PROFILE_TIMEOUT_MS = 20000;
      let profileRecord = await Promise.race([
        createDatasetProfileFromSheets({ userId: user.id, userFileId: fileRecord?.id || null, fileName: file.name, sheetsRaw: uploadPreparation.sheetsRaw, mappingPlans: uploadPreparation.mappingPlans, allowLLM: false }),
        new Promise((resolve) => setTimeout(() => { console.warn('[DSV] createProfile DB timed out, using local-only profile'); resolve(null); }, PROFILE_TIMEOUT_MS))
      ]);
      console.timeEnd('[DSV] upload:createProfile');

      if (!profileRecord) {
        const mappingPlanMap = new Map((uploadPreparation.mappingPlans || []).map((p) => [String(p.sheet_name || '').toLowerCase(), p]));
        profileRecord = {
          id: `local-${Date.now()}`, user_id: user.id, fingerprint: datasetFingerprint,
          profile_json: {
            file_name: file.name,
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

      setConversationDatasetContext((prev) => ({
        ...prev,
        [currentConversationId]: {
          ...(prev[currentConversationId] || {}),
          dataset_profile_id: profileRecord?.id, dataset_fingerprint: datasetFingerprint, user_file_id: fileRecord?.id || null,
          summary: cardPayload.context_summary || '', profileJson: profileRecord?.profile_json || {}, contractJson: profileRecord?.contract_json || {},
          validationPayload, sheetsRaw: uploadPreparation.sheetsRaw, rawRowsForStorage: uploadPreparation.rawRowsForStorage || null,
          fileName: file.name, contractConfirmed, minimalQuestions: cardPayload.minimal_questions || [],
          reuse_enabled: reuseEnabledForConversation, force_retrain: Boolean(prev[currentConversationId]?.force_retrain),
          reused_settings_template: reusedSettingsTemplate,
          pending_reuse_plan: hasReusePrompt ? { ...reusePlan, dataset_profile_id: profileRecord?.id, dataset_fingerprint: datasetFingerprint } : null
        }
      }));

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
      appendMessagesToCurrentConversation(messages);

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
      addNotification?.('Upload complete: profile + contract + validation saved.', 'success');
    } catch (error) {
      console.timeEnd('[DSV] upload:total');
      const errorMessage = getErrorMessage(error, 'Unable to upload dataset.');
      console.error('[DSV] Dataset upload failed:', error?.message, error);
      appendMessagesToCurrentConversation([{ role: 'ai', content: `❌ Upload failed: ${errorMessage}`, timestamp: new Date().toISOString() }]);
      addNotification?.(`Upload failed: ${errorMessage}`, 'error');
    } finally {
      setIsUploadingDataset(false);
      setUploadStatusText('');
      if (fileInputRef.current) { fileInputRef.current.value = ''; }
    }
  }, [user?.id, currentConversationId, conversationDatasetContext, appendMessagesToCurrentConversation, addNotification, setConversationDatasetContext]);

  const handleFileInputChange = useCallback((e) => { const file = e.target.files?.[0]; if (file) handleDatasetUpload(file); }, [handleDatasetUpload]);

  const handleDropUpload = useCallback((e) => {
    e.preventDefault(); e.stopPropagation(); setIsDragOverUpload(false);
    if (isUploadingDataset) return;
    const file = e.dataTransfer?.files?.[0];
    if (file) handleDatasetUpload(file);
  }, [handleDatasetUpload, isUploadingDataset]);

  // ── Canvas run handler ──────────────────────────────────────────────────
  const handleCanvasRun = useCallback(async (messageText, historyWithUserMessage) => {
    if (!currentConversationId || !activeDatasetContext || !user?.id) return null;

    if (!activeDatasetContext.contractConfirmed) {
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
        userId: user.id, prompt: messageText, datasetProfileId: activeDatasetContext.dataset_profile_id,
        datasetFingerprint: activeDatasetContext.dataset_fingerprint, profileJson: activeDatasetContext.profileJson,
        contractJson: activeDatasetContext.contractJson, sheetsRaw: activeDatasetContext.sheetsRaw || [],
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

  // ── Send handler ────────────────────────────────────────────────────────
  const handleSend = useCallback(async (e) => {
    if (e) e.preventDefault();
    if (!input.trim() || !currentConversationId) return;

    const userMessage = { role: 'user', content: input, timestamp: new Date().toISOString() };
    const messageText = input;
    setInput('');
    setIsTyping(true);
    setStreamingContent('');

    try {
      if (textareaRef.current) { textareaRef.current.style.height = 'auto'; }

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
      await executeForecastFlow({ profileId: Number.isFinite(profileId) ? profileId : (Number.isFinite(Number(activeDatasetContext?.dataset_profile_id)) ? Number(activeDatasetContext.dataset_profile_id) : null) });
      setIsTyping(false); setStreamingContent(''); return;
    }

    if (lower.startsWith('/plan')) {
      const parts = trimmed.split(/\s+/);
      const profileId = parts.length > 1 ? Number(parts[1]) : null;
      await executePlanFlow({ datasetProfileId: Number.isFinite(profileId) ? profileId : (Number.isFinite(Number(activeDatasetContext?.dataset_profile_id)) ? Number(activeDatasetContext.dataset_profile_id) : null) });
      setIsTyping(false); setStreamingContent(''); return;
    }

    if (command === '/workflowa' || command === '/run-workflow-a') {
      const parts = trimmed.split(/\s+/);
      const profileId = parts.length > 1 ? Number(parts[1]) : null;
      await executeWorkflowAFlow({ datasetProfileId: Number.isFinite(profileId) ? profileId : (Number.isFinite(Number(activeDatasetContext?.dataset_profile_id)) ? Number(activeDatasetContext.dataset_profile_id) : null) });
      setIsTyping(false); setStreamingContent(''); return;
    }

    if (command === '/workflow') {
      const parts = trimmed.split(/\s+/);
      const profileId = parts.length > 1 ? Number(parts[1]) : null;
      await executeWorkflowFlow({ datasetProfileId: Number.isFinite(profileId) ? profileId : (Number.isFinite(Number(activeDatasetContext?.dataset_profile_id)) ? Number(activeDatasetContext.dataset_profile_id) : null) });
      setIsTyping(false); setStreamingContent(''); return;
    }

    if (command === '/workflowb' || command === '/run-workflow-b' || command === '/risk') {
      const parts = trimmed.split(/\s+/);
      const profileId = parts.length > 1 ? Number(parts[1]) : null;
      await executeWorkflowBFlow({ datasetProfileId: Number.isFinite(profileId) ? profileId : (Number.isFinite(Number(activeDatasetContext?.dataset_profile_id)) ? Number(activeDatasetContext.dataset_profile_id) : null) });
      setIsTyping(false); setStreamingContent(''); return;
    }

    if (command === '/topology') {
      const parts = trimmed.split(/\s+/);
      const explicitRunId = parts.length > 1 ? Number(parts[1]) : null;
      await handleRunTopology(Number.isFinite(explicitRunId) ? explicitRunId : topologyRunId);
      setIsTyping(false); setStreamingContent(''); return;
    }

    // SmartOps 2.0: LLM-powered intent parsing + action routing
    try {
      const parsedIntent = await parseIntent({ userMessage: messageText, sessionContext: sessionCtx.context, domainContext });

      if (parsedIntent.intent !== 'GENERAL_CHAT' && parsedIntent.confidence > 0.7) {
        const intentHandlers = {
          executePlanFlow: (params) => executePlanFlow({ datasetProfileId: params.datasetProfileId || (Number.isFinite(Number(activeDatasetContext?.dataset_profile_id)) ? Number(activeDatasetContext.dataset_profile_id) : null), constraintsOverride: params.constraintsOverride, objectiveOverride: params.objectiveOverride }),
          executeForecastFlow: (params) => executeForecastFlow({ datasetProfileId: params.datasetProfileId || (Number.isFinite(Number(activeDatasetContext?.dataset_profile_id)) ? Number(activeDatasetContext.dataset_profile_id) : null) }),
          executeWorkflowAFlow: (params) => executeWorkflowAFlow({ datasetProfileId: params.datasetProfileId || (Number.isFinite(Number(activeDatasetContext?.dataset_profile_id)) ? Number(activeDatasetContext.dataset_profile_id) : null) }),
          executeWorkflowBFlow: (params) => executeWorkflowBFlow({ datasetProfileId: params.datasetProfileId || (Number.isFinite(Number(activeDatasetContext?.dataset_profile_id)) ? Number(activeDatasetContext.dataset_profile_id) : null) }),
          executeDigitalTwinFlow: (params) => executeDigitalTwinFlow({ scenario: params.scenario || 'normal', chaosIntensity: params.chaosIntensity || null }),
          handleParameterChange: async (intent, ctx) => {
            const result = await handleParameterChange({ parsedIntent: intent, sessionContext: ctx, userId: user?.id, conversationId: currentConversationId, rerunPlan: (params) => executePlanFlow({ datasetProfileId: Number.isFinite(Number(activeDatasetContext?.dataset_profile_id)) ? Number(activeDatasetContext.dataset_profile_id) : null, constraintsOverride: params.constraintsOverride, objectiveOverride: params.objectiveOverride }) });
            if (result?.comparison) { appendMessagesToCurrentConversation([{ role: 'ai', type: 'plan_comparison_card', payload: result.comparison, content: buildComparisonSummaryText(result.comparison), timestamp: new Date().toISOString() }]); }
          },
          comparePlans: (ctx) => {
            const comparison = handlePlanComparison(ctx);
            if (comparison) { appendMessagesToCurrentConversation([{ role: 'ai', type: 'plan_comparison_card', payload: comparison, content: buildComparisonSummaryText(comparison), timestamp: new Date().toISOString() }]); }
            else { appendMessagesToCurrentConversation([{ role: 'ai', content: 'No previous plan available for comparison. Run a plan first, then make changes to compare.', timestamp: new Date().toISOString() }]); }
          },
          runWhatIf: () => { handleCanvasRun(messageText, updatedMessages); },
          handleApproval: async (action) => {
            const pending = (sessionCtx.context?.pending_approvals || []).filter((a) => a.status === 'PENDING');
            if (pending.length === 0) { appendMessagesToCurrentConversation([{ role: 'ai', content: 'No pending approvals found.', timestamp: new Date().toISOString() }]); return; }
            const approvalIds = pending.map((a) => a.approval_id);
            if (action === 'approve_all') { await batchApprove({ approvalIds, userId: user?.id, note: 'Approved via chat' }); approvalIds.forEach((id) => sessionCtx.resolveApproval(id, 'APPROVED')); appendMessagesToCurrentConversation([{ role: 'ai', content: `Approved ${approvalIds.length} pending approval(s).`, timestamp: new Date().toISOString() }]); }
            else if (action === 'reject_all') { await batchReject({ approvalIds, userId: user?.id, note: 'Rejected via chat' }); approvalIds.forEach((id) => sessionCtx.resolveApproval(id, 'REJECTED')); appendMessagesToCurrentConversation([{ role: 'ai', content: `Rejected ${approvalIds.length} pending approval(s).`, timestamp: new Date().toISOString() }]); }
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
          appendMessage: (msg) => appendMessagesToCurrentConversation([msg]),
          onNoDataset: () => appendMessagesToCurrentConversation([{ role: 'ai', content: 'Please upload a dataset first. You can drag and drop a CSV or XLSX file into the chat.', timestamp: new Date().toISOString() }]),
        };

        const result = await routeIntent(parsedIntent, sessionCtx.context, intentHandlers, { userId: user?.id, conversationId: currentConversationId, datasetProfileId: Number.isFinite(Number(activeDatasetContext?.dataset_profile_id)) ? Number(activeDatasetContext.dataset_profile_id) : null });
        if (result?.handled) { setIsTyping(false); setStreamingContent(''); return; }
      }
    } catch (intentError) { console.warn('[DSV] Intent parsing failed, falling through to chat:', intentError?.message); }

    // Fallback: legacy keyword-based execution intent
    const canExecute = Boolean(activeDatasetContext?.dataset_profile_id) && isExecutionIntent(messageText);
    if (canExecute) {
      const handled = await handleCanvasRun(messageText, updatedMessages);
      setIsTyping(false); setStreamingContent('');
      if (handled) return;
    }

    const history = updatedMessages.slice(-10);
    let fullResult = '';
    let aiErrorPayload = null;
    try {
      fullResult = await streamChatWithAI(messageText, history, systemPrompt, (chunk) => { setStreamingContent((prev) => prev + chunk); });
    } catch (error) {
      console.error('AI call failed:', error);
      if (isApiKeyConfigError(error?.message)) { aiErrorPayload = { title: 'AI service configuration required', message: 'Server-side AI keys are missing or invalid. Ask an admin to set Supabase Edge Function secrets.', ctaLabel: 'Show setup hint' }; }
      else { fullResult = `❌ AI service temporarily unavailable\n\nError: ${error.message}`; }
    }

    if (!aiErrorPayload && isApiKeyConfigError(fullResult)) {
      aiErrorPayload = { title: 'AI service configuration required', message: 'Server-side AI keys are missing or invalid. Ask an admin to set Supabase Edge Function secrets.', ctaLabel: 'Show setup hint' };
    }

    const aiMessage = aiErrorPayload
      ? { role: 'ai', type: 'ai_error_card', payload: aiErrorPayload, timestamp: new Date().toISOString() }
      : { role: 'ai', content: fullResult, timestamp: new Date().toISOString() };
    const finalMessages = [...updatedMessages, aiMessage];
    const newTitle = currentMessages.length <= 1 ? messageText.slice(0, 50) : currentConversation.title;
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
  }, [input, currentConversationId, currentMessages, currentConversation, systemPrompt, user?.id, activeDatasetContext, handleCanvasRun, appendMessagesToCurrentConversation, executeForecastFlow, executePlanFlow, executeWorkflowFlow, executeWorkflowAFlow, executeWorkflowBFlow, executeDigitalTwinFlow, handleRunTopology, topologyRunId, setConversations, setConversationDatasetContext, setLatestPlanRunId]);

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
      handleGenerateNegotiationOptions, handleApplyNegotiationOption, updateCanvasState, sessionCtx, batchApprove, batchReject,
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
    handleGenerateNegotiationOptions, handleApplyNegotiationOption
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
                  <button type="button" onClick={() => setShowNewChatConfirm(true)} className="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors" title="New conversation">
                    <FileText className="w-4 h-4 text-slate-500" />
                  </button>
                </div>

                <ChatThread
                  messages={currentMessages} isTyping={isTyping} streamingContent={streamingContent}
                  formatTime={formatTime} renderSpecialMessage={renderSpecialMessage} quickPrompts={QUICK_PROMPTS}
                  onSelectPrompt={(promptText) => { setInput(promptText); textareaRef.current?.focus(); }}
                  showInitialEmptyState={currentMessages.length <= 1 && !isTyping} isLoading={false}
                />

                <ChatComposer
                  input={input} onInputChange={handleTextareaChange} onKeyDown={handleKeyDown} onSubmit={handleSend}
                  textareaRef={textareaRef} fileInputRef={fileInputRef} onFileInputChange={handleFileInputChange}
                  onFilePicker={() => fileInputRef.current?.click()} isTyping={isTyping} isUploading={isUploadingDataset}
                  uploadStatusText={uploadStatusText} isDragOver={isDragOverUpload}
                  onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); if (!isUploadingDataset) setIsDragOverUpload(true); }}
                  onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); if (!isUploadingDataset) setIsDragOverUpload(true); }}
                  onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); if (!e.currentTarget.contains(e.relatedTarget)) setIsDragOverUpload(false); }}
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
        sidebarCollapsed={isSidebarCollapsed} onSidebarToggle={handleSidebarToggle}
        canvasOpen={Boolean(activeCanvasState.isOpen)} onCanvasToggle={handleCanvasToggle}
        initialSplitRatio={splitRatio} onSplitRatioCommit={handleSplitRatioCommit} canvasDetached={isCanvasDetached}
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
              <Button variant="secondary" onClick={() => setShowNewChatConfirm(false)}>Cancel</Button>
              <Button variant="primary" onClick={handleNewConversation}>New Conversation</Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
