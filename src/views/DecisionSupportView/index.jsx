// ============================================
// Decision Support View - Chat + Canvas
// Single-screen chat-first workflow with white-box execution
// ============================================

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { FileText } from 'lucide-react';
import { Card, Button } from '../../components/ui';
import { supabase, userFilesService } from '../../services/supabaseClient';
import { prepareChatUploadFromFile, buildDataSummaryCardPayload, MAX_UPLOAD_BYTES } from '../../services/chatDatasetProfilingService';
import { createDatasetProfileFromSheets } from '../../services/datasetProfilingService';
import { datasetProfilesService } from '../../services/datasetProfilesService';
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
import { buildDatasetFingerprint } from '../../utils/datasetFingerprint';
import { buildSignature } from '../../utils/datasetSimilarity';
import { buildReusePlan, applyContractTemplateToProfile } from '../../utils/reusePlanner';
import { buildActualVsForecastSeries } from '../../utils/charts/buildActualVsForecastSeries';
import UPLOAD_SCHEMAS from '../../utils/uploadSchemas';
import { getRequiredMappingStatus } from '../../utils/requiredMappingStatus';
import { ruleBasedMapping } from '../../utils/aiMappingHelper';
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
import AIErrorCard from '../../components/chat/AIErrorCard';
import SplitShell from '../../components/chat/SplitShell';
import ConversationSidebar from '../../components/chat/ConversationSidebar';
import ChatThread from '../../components/chat/ChatThread';
import ChatComposer from '../../components/chat/ChatComposer';

const STORAGE_KEY = 'decision_intelligence_conversations';
const TABLE_UNAVAILABLE_KEY = 'decision_intelligence_conversations_table_unavailable';
const SIDEBAR_COLLAPSED_KEY_PREFIX = 'decision_intelligence_sidebar_collapsed_';
const CANVAS_SPLIT_RATIO_KEY_PREFIX = 'decision_intelligence_canvas_split_ratio_';
const MAX_UPLOAD_MESSAGE = 'Please upload aggregated data (e.g., SKU-store-day/week). Maximum 50MB.';

const tableUnavailableAtLoad = sessionStorage.getItem(TABLE_UNAVAILABLE_KEY) === '1';
const conversationsDb = tableUnavailableAtLoad ? null : supabase;

const isTableUnavailable = () => !conversationsDb || sessionStorage.getItem(TABLE_UNAVAILABLE_KEY) === '1';
const markTableUnavailable = () => {
  sessionStorage.setItem(TABLE_UNAVAILABLE_KEY, '1');
};

const DEFAULT_CANVAS_STATE = {
  isOpen: false,
  activeTab: 'logs',
  run: null,
  logs: [],
  stepStatuses: RUN_STEP_ORDER.reduce((acc, step) => ({
    ...acc,
    [step]: { status: 'queued', updated_at: new Date().toISOString(), notes: '' }
  }), {}),
  codeText: '',
  chartPayload: {
    actual_vs_forecast: [],
    inventory_projection: [],
    cost_breakdown: [],
    topology_graph: null
  },
  downloads: [],
  topologyRunning: false
};

const EXECUTION_KEYWORDS = [
  'plan',
  'forecast',
  'replenishment',
  'order quantity',
  'stock',
  'optimize',
  'schedule',
  'allocation',
  'inventory'
];

const SPLIT_RATIO_MIN = 0.25;
const SPLIT_RATIO_MAX = 0.75;
const ASYNC_JOB_POLL_INTERVAL_MS = 2000;
const ASYNC_JOB_MAX_POLLS = 1200;

function clampSplitRatio(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0.5;
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, numeric));
}

function isApiKeyConfigError(message = '') {
  const text = String(message || '').toLowerCase();
  if (!text) return false;
  const mentionsKey = text.includes('api key') || text.includes('apikey');
  const keyStateError = text.includes('not valid')
    || text.includes('invalid')
    || text.includes('missing')
    || text.includes('no api key');
  return (
    text.includes('warning: no api key found')
    || text.includes('missing_server_keys')
    || text.includes('not configured on server')
    || (mentionsKey && text.includes('(400)'))
    || (mentionsKey && keyStateError)
  );
}

function getErrorMessage(error, fallback = 'Unexpected error') {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error?.message === 'string' && error.message) {
    return error.message;
  }
  if (typeof error?.details === 'string' && error.details) {
    return error.details;
  }
  if (typeof error?.hint === 'string' && error.hint) {
    return error.hint;
  }
  if (typeof error?.error_description === 'string' && error.error_description) {
    return error.error_description;
  }
  return fallback;
}

// Allowlisted bind_to prefixes for blocking-question answers (PR-5)
const BIND_TO_ALLOWLIST = ['mapping.', 'settings.'];

const QUICK_PROMPTS = [
  { label: 'Top risk items', prompt: 'What are my top 5 highest-risk materials right now? Show their risk scores and recommended actions.' },
  { label: 'Stockout forecast', prompt: 'Which materials are most likely to stockout in the next 2 weeks? What actions should I take?' },
  { label: 'Replenishment plan', prompt: 'Plan replenishment for Warehouse A next month and show constraints/exceptions.' }
];

const REQUIRED_UPLOAD_TYPES_BY_EXECUTION = {
  forecast: ['demand_fg'],
  [WORKFLOW_NAMES.A]: ['demand_fg', 'inventory_snapshots', 'po_open_lines', 'bom_edge'],
  [WORKFLOW_NAMES.B]: ['po_open_lines', 'goods_receipt']
};

function loadLocalConversations(userId) {
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY}_${userId}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveLocalConversations(userId, conversations) {
  try {
    localStorage.setItem(`${STORAGE_KEY}_${userId}`, JSON.stringify(conversations));
  } catch {
    // Ignore localStorage quota errors.
  }
}

const normalizeHeader = (value) => String(value || '').trim().toLowerCase().replace(/[\s\-./]+/g, '_');

function inferTimeGuess(columns = []) {
  const normalized = columns.map(normalizeHeader);
  const timeColumn = normalized.find((col) => /(date|week|month|time|bucket|snapshot)/.test(col)) || '';
  let granularity = 'unknown';
  if (timeColumn.includes('week')) granularity = 'week';
  else if (timeColumn.includes('month')) granularity = 'month';
  else if (timeColumn.includes('date') || timeColumn.includes('snapshot')) granularity = 'day';

  return { timeColumn, granularity };
}

function buildFingerprintFromUpload(sheetsRaw = [], mappingPlans = []) {
  const planBySheet = new Map((mappingPlans || []).map((plan) => [String(plan.sheet_name || '').toLowerCase(), plan]));

  return buildDatasetFingerprint({
    sheets: (sheetsRaw || []).map((sheet) => {
      const sheetName = String(sheet.sheet_name || sheet.sheetName || 'Sheet');
      const matchedPlan = planBySheet.get(sheetName.toLowerCase()) || {};
      const guess = inferTimeGuess(sheet.columns || []);
      return {
        sheet_name: sheetName,
        columns: sheet.columns || Object.keys((sheet.rows || [])[0] || {}),
        inferred_type: matchedPlan.upload_type || 'unknown',
        time_column_guess: guess.timeColumn,
        time_granularity_guess: guess.granularity
      };
    })
  });
}

function getWorkflowFromProfile(profileJson = {}) {
  const label = String(profileJson?.global?.workflow_guess?.label || 'A').trim().toUpperCase();
  if (label === 'A') return WORKFLOW_NAMES.A;
  if (label === 'B') return WORKFLOW_NAMES.B;
  if (label === 'C') return WORKFLOW_NAMES.A;
  return WORKFLOW_NAMES.A;
}

function buildRuntimeWorkflowSettings(context = {}, explicitSettings = {}) {
  const templateSettings = context?.reused_settings_template || {};
  return {
    ...templateSettings,
    ...explicitSettings,
    reuse_enabled: context?.reuse_enabled !== false,
    force_retrain: Boolean(context?.force_retrain)
  };
}

function buildValidationPayload(profileRow) {
  const validation = profileRow?.contract_json?.validation || {};
  return {
    status: validation.status || 'fail',
    reasons: Array.isArray(validation.reasons) && validation.reasons.length > 0
      ? validation.reasons
      : ['Validation reasons unavailable']
  };
}

function buildDownloadsPayload({ profileJson, contractJson, profileId }) {
  return {
    files: [
      {
        label: 'profile.json',
        fileName: `profile_${profileId || 'latest'}.json`,
        mimeType: 'application/json',
        content: profileJson || {}
      },
      {
        label: 'contract.json',
        fileName: `contract_${profileId || 'latest'}.json`,
        mimeType: 'application/json',
        content: contractJson || {}
      }
    ]
  };
}

function buildConfirmationPayload(cardPayload, mappingPlans = []) {
  const profileBySheet = new Map(
    (cardPayload?.profile_json?.sheets || []).map((sheet) => [
      String(sheet?.sheet_name || ''),
      sheet
    ])
  );
  const contractBySheet = new Map(
    (cardPayload?.contract_json?.datasets || []).map((dataset) => [
      String(dataset?.sheet_name || ''),
      dataset
    ])
  );
  const planBySheet = new Map((mappingPlans || []).map((plan) => [String(plan.sheet_name || ''), plan]));
  const lowConfidenceSheets = (cardPayload?.sheets || []).filter((sheet) => {
    const missingRequired = (sheet.missing_required_fields || []).length > 0;
    return Number(sheet.confidence || 0) < 0.7 || missingRequired;
  });

  if (lowConfidenceSheets.length === 0) return null;

  const questions = lowConfidenceSheets.map((sheet) => {
    const plan = planBySheet.get(sheet.sheet_name) || {};
    const candidates = Array.isArray(plan.candidates) ? plan.candidates : [];
    const deduped = new Map();
    const profileSheet = profileBySheet.get(sheet.sheet_name) || {};
    const contractSheet = contractBySheet.get(sheet.sheet_name) || {};

    [
      { upload_type: sheet.upload_type || 'unknown', confidence: sheet.confidence || 0 },
      ...candidates
    ].forEach((candidate) => {
      const key = String(candidate.upload_type || 'unknown');
      if (!deduped.has(key)) {
        deduped.set(key, {
          upload_type: key,
          confidence: Number(candidate.confidence || 0)
        });
      }
    });

    return {
      sheet_name: sheet.sheet_name,
      current_type: sheet.upload_type || 'unknown',
      confidence: Number(sheet.confidence || 0),
      missing_required_fields: Array.isArray(sheet.missing_required_fields) ? sheet.missing_required_fields : [],
      available_columns: Array.isArray(profileSheet.original_headers) ? profileSheet.original_headers : [],
      current_mapping: (contractSheet && typeof contractSheet.mapping === 'object') ? contractSheet.mapping : {},
      options: Array.from(deduped.values())
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 5)
    };
  });

  return {
    dataset_profile_id: cardPayload.dataset_profile_id,
    questions
  };
}

function toSourceToTargetMapping(targetToSource = {}) {
  const mapping = {};
  Object.entries(targetToSource || {}).forEach(([targetField, sourceColumn]) => {
    if (!targetField || !sourceColumn) return;
    mapping[String(sourceColumn)] = String(targetField);
  });
  return mapping;
}

function toTargetToSourceMapping(sourceToTarget = {}) {
  const mapping = {};
  Object.entries(sourceToTarget || {}).forEach(([sourceColumn, targetField]) => {
    if (!sourceColumn || !targetField) return;
    mapping[String(targetField)] = String(sourceColumn);
  });
  return mapping;
}

function normalizeMappingToken(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s\-./]+/g, '_');
}

function resolveHeaderCandidate(sourceCandidate, headers = []) {
  const candidate = String(sourceCandidate || '').trim();
  if (!candidate) return null;

  const exact = (headers || []).find((header) => String(header) === candidate);
  if (exact) return String(exact);

  const byNormalized = new Map();
  (headers || []).forEach((header) => {
    const normalized = normalizeMappingToken(header);
    if (!normalized || byNormalized.has(normalized)) return;
    byNormalized.set(normalized, String(header));
  });
  return byNormalized.get(normalizeMappingToken(candidate)) || null;
}

function inferMappingForRole(uploadType, headers = [], existingTargetToSource = {}) {
  const schema = UPLOAD_SCHEMAS[uploadType];
  if (!schema || !Array.isArray(headers) || headers.length === 0) {
    return existingTargetToSource || {};
  }

  const sourceToTarget = {
    ...toSourceToTargetMapping(existingTargetToSource || {})
  };

  const usedTargets = new Set(Object.values(sourceToTarget));
  const usedSourceColumns = new Set(Object.keys(sourceToTarget));

  // First pass: exact normalized header <-> field key mapping.
  const headerByNormalized = new Map();
  headers.forEach((header) => {
    const normalized = normalizeMappingToken(header);
    if (!normalized || headerByNormalized.has(normalized)) return;
    headerByNormalized.set(normalized, header);
  });
  (schema.fields || []).forEach((field) => {
    const target = String(field?.key || '');
    if (!target || usedTargets.has(target)) return;
    const directHeader = headerByNormalized.get(normalizeMappingToken(target));
    if (!directHeader || usedSourceColumns.has(directHeader)) return;
    sourceToTarget[directHeader] = target;
    usedSourceColumns.add(directHeader);
    usedTargets.add(target);
  });

  const suggestions = ruleBasedMapping(headers, uploadType, schema.fields)
    .filter((item) => item?.source && item?.target && Number(item?.confidence || 0) >= 0.6)
    .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0));

  suggestions.forEach(({ source, target }) => {
    if (!source || !target) return;
    if (sourceToTarget[source]) return;
    if (usedSourceColumns.has(source)) return;
    if (usedTargets.has(target)) return;
    sourceToTarget[source] = target;
    usedSourceColumns.add(source);
    usedTargets.add(target);
  });

  const status = getRequiredMappingStatus({
    uploadType,
    columns: headers,
    columnMapping: sourceToTarget
  });
  const missing = Array.isArray(status.missingRequired) ? status.missingRequired : [];

  if (missing.length > 0) {
    // Secondary permissive pass for required fields only.
    suggestions.forEach(({ source, target }) => {
      if (!missing.includes(target)) return;
      if (sourceToTarget[source]) return;
      if (usedSourceColumns.has(source)) return;
      if (usedTargets.has(target)) return;
      sourceToTarget[source] = target;
      usedSourceColumns.add(source);
      usedTargets.add(target);
    });
  }

  return toTargetToSourceMapping(sourceToTarget);
}

function applyContractOverrides(contractJson = {}, profileJson = {}, overrides = {}, mappingOverrides = {}) {
  if (!contractJson || typeof contractJson !== 'object') return contractJson;
  const updates = Object.entries(overrides || {});
  const mappingUpdates = Object.entries(mappingOverrides || {});
  if (updates.length === 0 && mappingUpdates.length === 0) return contractJson;

  const bySheet = new Map(updates.map(([sheet, role]) => [String(sheet).toLowerCase(), String(role)]));
  const mappingBySheet = new Map(mappingUpdates.map(([sheet, mapping]) => [String(sheet).toLowerCase(), mapping || {}]));
  const sheets = Array.isArray(profileJson?.sheets) ? profileJson.sheets : [];
  const headersBySheet = new Map(
    sheets.map((sheet) => [
      String(sheet?.sheet_name || '').toLowerCase(),
      Array.isArray(sheet?.original_headers) ? sheet.original_headers : []
    ])
  );

  return {
    ...contractJson,
    datasets: (contractJson.datasets || []).map((dataset) => {
      const sheetKey = String(dataset.sheet_name || '').toLowerCase();
      const headers = headersBySheet.get(sheetKey) || [];
      const role = bySheet.get(sheetKey) || dataset.upload_type;
      const manualMapping = mappingBySheet.get(sheetKey) || {};
      let inferredMapping = inferMappingForRole(role, headers, dataset.mapping || {});

      Object.entries(manualMapping).forEach(([targetField, sourceCandidate]) => {
        if (!targetField) return;
        const resolved = resolveHeaderCandidate(sourceCandidate, headers);
        if (!resolved) return;
        inferredMapping[String(targetField)] = resolved;
      });

      return {
        ...dataset,
        upload_type: role,
        mapping: inferredMapping
      };
    })
  };
}

function buildExecutionGateResult(profileRow = {}, executionKey = 'forecast') {
  const requiredTypes = REQUIRED_UPLOAD_TYPES_BY_EXECUTION[executionKey] || [];
  const datasets = Array.isArray(profileRow?.contract_json?.datasets) ? profileRow.contract_json.datasets : [];
  const issues = [];

  requiredTypes.forEach((uploadType) => {
    const candidates = datasets
      .filter((dataset) => String(dataset?.upload_type || '').toLowerCase() === String(uploadType).toLowerCase())
      .sort((a, b) => Number(b?.requiredCoverage || 0) - Number(a?.requiredCoverage || 0));

    if (candidates.length === 0) {
      issues.push({
        upload_type: uploadType,
        reason: 'missing_dataset',
        missing_required_fields: []
      });
      return;
    }

    const best = candidates[0];
    const coverage = Number(best?.requiredCoverage || 0);
    const missingRequired = Array.isArray(best?.missing_required_fields) ? best.missing_required_fields : [];
    const validationStatus = String(best?.validation?.status || '').toLowerCase();
    if (coverage < 1 || missingRequired.length > 0 || validationStatus !== 'pass') {
      issues.push({
        upload_type: uploadType,
        sheet_name: best?.sheet_name || '',
        reason: 'insufficient_required_coverage',
        requiredCoverage: coverage,
        missing_required_fields: missingRequired
      });
    }
  });

  return {
    requiredTypes,
    issues,
    isValid: issues.length === 0
  };
}

function buildEvidenceSummaryText(summary = {}) {
  const keyResults = Array.isArray(summary.key_results) ? summary.key_results : [];
  const exceptions = Array.isArray(summary.exceptions) ? summary.exceptions : [];
  const actions = Array.isArray(summary.recommended_actions) ? summary.recommended_actions : [];

  const lines = [];
  lines.push('### Evidence-only Summary');
  lines.push(summary.summary || 'Summary unavailable.');

  if (keyResults.length > 0) {
    lines.push('');
    lines.push('**Key results**');
    keyResults.forEach((item) => {
      lines.push(`- ${item.claim} _(evidence: ${(item.evidence_ids || []).join(', ') || 'none'})_`);
    });
  }

  if (exceptions.length > 0) {
    lines.push('');
    lines.push('**Exceptions**');
    exceptions.forEach((item) => {
      lines.push(`- ${item.issue || item.claim} _(evidence: ${(item.evidence_ids || []).join(', ') || 'none'})_`);
    });
  }

  if (actions.length > 0) {
    lines.push('');
    lines.push('**Recommended actions**');
    actions.forEach((item) => lines.push(`- ${item}`));
  }

  return lines.join('\n');
}

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function buildActualVsForecastRowsFromForecastCard(payload = {}) {
  const built = buildActualVsForecastSeries(payload);
  return built.series.length > 0 ? built.rows : [];
}

function buildInventoryProjectionRowsFromCard(payload = {}) {
  const groups = Array.isArray(payload?.groups) ? payload.groups : [];
  const selected = groups.find((group) => Array.isArray(group?.points) && group.points.length > 0);
  if (!selected) return [];

  return selected.points
    .map((point, index) => ({
      date: point?.date || point?.time_bucket || `t_${index + 1}`,
      with_plan: toFiniteNumber(point?.with_plan),
      without_plan: toFiniteNumber(point?.without_plan),
      demand: toFiniteNumber(point?.demand)
    }))
    .filter((row) => row.with_plan !== null || row.without_plan !== null || row.demand !== null);
}

function buildCostBreakdownRowsFromPlanSummary(payload = {}) {
  const kpis = payload?.kpis || {};
  const serviceLevel = toFiniteNumber(kpis?.estimated_service_level);
  const primary = [
    { label: 'Estimated Total Cost', value: toFiniteNumber(kpis?.estimated_total_cost) },
    { label: 'Stockout Units', value: toFiniteNumber(kpis?.estimated_stockout_units) },
    { label: 'Holding Units', value: toFiniteNumber(kpis?.estimated_holding_units) },
    { label: 'Service Level (%)', value: serviceLevel === null ? null : Number((serviceLevel * 100).toFixed(2)) }
  ].filter((item) => item.value !== null);

  if (primary.length > 0) {
    return primary;
  }

  const withPlan = payload?.replay_metrics?.with_plan || {};
  const fallback = [
    { label: 'Service Level (%)', value: toFiniteNumber(withPlan?.service_level_proxy) },
    { label: 'Stockout Units', value: toFiniteNumber(withPlan?.stockout_units) },
    { label: 'Avg Inventory', value: toFiniteNumber(withPlan?.average_inventory) }
  ]
    .filter((item) => item.value !== null)
    .map((item) => (
      item.label === 'Service Level (%)'
        ? { ...item, value: Number((Number(item.value) * 100).toFixed(2)) }
        : item
    ));

  return fallback;
}

function deriveCanvasChartPatchFromCard(cardType, payload = {}) {
  if (cardType === 'forecast_result_card') {
    const rows = buildActualVsForecastRowsFromForecastCard(payload);
    if (rows.length === 0) return null;
    const groups = Array.isArray(payload.series_groups) ? payload.series_groups : [];
    return { actual_vs_forecast: rows, ...(groups.length > 0 ? { series_groups: groups } : {}) };
  }
  if (cardType === 'inventory_projection_card') {
    const rows = buildInventoryProjectionRowsFromCard(payload);
    return rows.length > 0 ? { inventory_projection: rows } : null;
  }
  if (cardType === 'plan_summary_card') {
    const rows = buildCostBreakdownRowsFromPlanSummary(payload);
    return rows.length > 0 ? { cost_breakdown: rows } : null;
  }
  if (cardType === 'topology_graph_card') {
    if (payload?.graph && typeof payload.graph === 'object') {
      return { topology_graph: payload.graph };
    }
  }
  if (cardType === 'risk_aware_plan_comparison_card') {
    if (payload?.kpis) {
      return { plan_comparison: { kpis: payload.kpis, key_changes: payload.key_changes || [] } };
    }
    return null;
  }
  return null;
}

function extractRunIdFromMessage(message) {
  if (!message) return null;
  const payload = message.payload || {};
  const fields = [payload.run_id, payload.runId, payload.forecast_run_id];
  for (const field of fields) {
    const numeric = Number(field);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function findLatestRunIdFromMessages(messages = []) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const runId = extractRunIdFromMessage(messages[i]);
    if (Number.isFinite(runId)) return runId;
  }
  return null;
}

function findLatestWorkflowRunIdFromMessages(messages = []) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message) continue;
    const type = String(message.type || '').trim();
    if (type && type !== 'workflow_progress_card' && type !== 'topology_graph_card') {
      continue;
    }
    const runId = extractRunIdFromMessage(message);
    if (Number.isFinite(runId)) return runId;
  }
  return null;
}

async function loadDomainContext(userId) {
  const ctx = { riskItems: [], suppliers: null, materials: null, whatIfRuns: [], deliveryStats: null };

  try {
    const { data } = await supabase
      .from('risk_score_results')
      .select('material_code, plant_id, p_stockout, impact_usd, score')
      .eq('user_id', userId)
      .order('score', { ascending: false })
      .limit(10);
    if (data) ctx.riskItems = data;
  } catch {
    // Optional table.
  }

  try {
    const [{ count: sCount }, { count: mCount }] = await Promise.all([
      supabase.from('suppliers').select('*', { count: 'exact', head: true }),
      supabase.from('materials').select('*', { count: 'exact', head: true }).eq('user_id', userId)
    ]);
    ctx.suppliers = sCount;
    ctx.materials = mCount;
  } catch {
    // Optional tables.
  }

  try {
    const { data } = await supabase
      .from('what_if_runs')
      .select('material_code, plant_id, action_type, delta_p_stockout, delta_impact_usd, cost_usd, roi, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(5);
    if (data) ctx.whatIfRuns = data;
  } catch {
    // Optional table.
  }

  try {
    const since = new Date();
    since.setDate(since.getDate() - 30);
    const { data } = await supabase
      .from('goods_receipts')
      .select('is_on_time')
      .eq('user_id', userId)
      .gte('actual_delivery_date', since.toISOString().split('T')[0]);
    if (data && data.length > 0) {
      const onTime = data.filter((row) => row.is_on_time === true).length;
      ctx.deliveryStats = {
        total: data.length,
        onTimeRate: ((onTime / data.length) * 100).toFixed(1)
      };
    }
  } catch {
    // Optional table.
  }

  return ctx;
}

function buildSystemPrompt(domainCtx, activeDatasetContext) {
  let prompt = `You are **${ASSISTANT_NAME}**, an expert supply-chain AI.
Answer in the same language the user writes in. Use Markdown formatting (tables, bold, lists) for clarity.
Be concise, data-driven, and actionable.\n\n`;

  prompt += '## Current Supply Chain State\n';

  if (domainCtx?.suppliers != null || domainCtx?.materials != null) {
    prompt += `- **Suppliers**: ${domainCtx.suppliers ?? 'unknown'} | **Materials**: ${domainCtx.materials ?? 'unknown'}\n`;
  }

  if (domainCtx?.deliveryStats) {
    prompt += `- **Delivery performance (30d)**: ${domainCtx.deliveryStats.total} receipts, ${domainCtx.deliveryStats.onTimeRate}% on-time\n`;
  }

  if (domainCtx?.riskItems?.length > 0) {
    prompt += '\n### Top Risk Items (by score)\n';
    prompt += '| Material | Plant | P(stockout) | Impact USD | Score |\n|---|---|---|---|---|\n';
    domainCtx.riskItems.forEach((r) => {
      prompt += `| ${r.material_code} | ${r.plant_id} | ${(r.p_stockout * 100).toFixed(0)}% | $${Number(r.impact_usd).toLocaleString()} | ${Number(r.score).toFixed(0)} |\n`;
    });
  }

  if (activeDatasetContext?.summary) {
    prompt += `\n### Selected Dataset Context\n${activeDatasetContext.summary}\n`;
  }

  prompt += '\nWhite-box rule: never invent numeric outputs. If exact values are unavailable, say what evidence is missing.';
  return prompt;
}

function isExecutionIntent(text = '') {
  const lowered = String(text || '').toLowerCase();
  return EXECUTION_KEYWORDS.some((keyword) => lowered.includes(keyword));
}

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

  useEffect(() => {
    if (!user?.id) return;
    setContextLoading(true);
    loadDomainContext(user.id)
      .then((ctx) => setDomainContext(ctx))
      .catch(() => setDomainContext(null))
      .finally(() => setContextLoading(false));
  }, [user?.id]);

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

      markTableUnavailable();
      setIsConversationsLoading(false);
      window.location.reload();
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
    const graphRunId = Number(
      effectiveCanvasChartPayload?.topology_graph?.run_id
      || effectiveCanvasChartPayload?.topology_graph?.runId
    );
    if (Number.isFinite(graphRunId)) return graphRunId;

    const workflowRunId = findLatestWorkflowRunIdFromMessages(currentMessages);
    if (Number.isFinite(workflowRunId)) return workflowRunId;

    const canvasRunId = Number(activeCanvasState?.run?.id || activeCanvasState?.run?.run_id);
    if (Number.isFinite(canvasRunId)) return canvasRunId;

    const fallbackRunId = findLatestRunIdFromMessages(currentMessages);
    return Number.isFinite(fallbackRunId) ? fallbackRunId : null;
  }, [effectiveCanvasChartPayload?.topology_graph, currentMessages, activeCanvasState?.run]);
  const topologyRunStatus = useMemo(() => {
    const numericRunId = Number(topologyRunId);
    if (!Number.isFinite(numericRunId)) return '';
    const snapshot = workflowSnapshots[numericRunId] || workflowSnapshots[String(numericRunId)] || null;
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

    const numericProfileId = Number.isFinite(Number(profileId)) ? Number(profileId) : null;
    const activeProfileId = Number.isFinite(Number(activeDatasetContext?.dataset_profile_id))
      ? Number(activeDatasetContext.dataset_profile_id)
      : null;

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
      const inventoryRows = buildInventoryProjectionRowsFromCard(projectionPayload);
      const costRows = buildCostBreakdownRowsFromPlanSummary(summaryPayload);

      appendMessagesToCurrentConversation([
        {
          role: 'ai',
          content: planResult.summary_text,
          timestamp: new Date().toISOString()
        },
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
      const numericRunId = Number(runId);
      if (Number.isFinite(numericRunId)) {
        loadTopologyGraphForRun({ runId: numericRunId })
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

        latestSnapshot = {
          run: {
            id: runId,
            workflow: jobStatus?.workflow || null,
            stage: jobStatus?.run_stage || jobStatus?.current_step || null,
            status: runStatus,
            meta: jobStatus?.run_meta || {}
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
      appendMessagesToCurrentConversation([
        {
          role: 'ai',
          content: `Workflow execution failed: ${error.message}`,
          timestamp: new Date().toISOString()
        },
        {
          role: 'ai',
          type: 'workflow_error_card',
          payload: {
            step: 'workflow',
            error_code: 'UNKNOWN',
            error_message: error.message || 'Workflow execution failed.',
            next_actions: [
              'Retry the workflow run.',
              'If the issue persists, review run artifacts and mappings.'
            ]
          },
          timestamp: new Date().toISOString()
        }
      ]);
      addNotification?.(`Workflow run failed: ${error.message}`, 'error');
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

      if (asyncRunsApiClient.isConfigured()) {
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

      const startSnapshot = await startWorkflow({
        user_id: user.id,
        dataset_profile_id: profileRow.id,
        workflow: selectedWorkflow,
        settings: runtimeSettings
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

  const handleResumeWorkflowA = useCallback(async (runId) => {
    if (!runId) return;
    try {
      const resumed = await resumeWorkflowRun(runId, { maxSteps: 1 });
      upsertWorkflowSnapshot(resumed);
      if (Array.isArray(resumed.events)) {
        resumed.events.forEach((event) => appendWorkflowStepEventMessages(runId, event));
      }
      if (String(resumed?.run?.status || '').toLowerCase() === 'running') {
        await processWorkflowRun(runId);
      }
    } catch (error) {
      appendMessagesToCurrentConversation([{
        role: 'ai',
        type: 'workflow_error_card',
        payload: {
          step: 'resume',
          error_code: 'UNKNOWN',
          error_message: error.message || 'Unable to resume workflow.',
          next_actions: ['Retry resume.', 'Replay the workflow if resume keeps failing.']
        },
        timestamp: new Date().toISOString()
      }]);
      addNotification?.(`Workflow resume failed: ${error.message}`, 'error');
    }
  }, [
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
    if (!runId || !user?.id) return;
    try {
      const result = await submitWorkflowBlockingAnswers(Number(runId), answers);
      upsertWorkflowSnapshot(result);
      if (Array.isArray(result.events)) {
        result.events.forEach((event) => appendWorkflowStepEventMessages(runId, event));
      }
      if (String(result?.run?.status || '').toLowerCase() === 'running') {
        await processWorkflowRun(runId);
      }
    } catch (error) {
      appendMessagesToCurrentConversation([{
        role: 'ai',
        type: 'workflow_error_card',
        payload: {
          step: 'resume',
          error_code: 'UNKNOWN',
          error_message: error.message || 'Unable to resume after answering.',
          next_actions: ['Retry or use the Resume button.']
        },
        timestamp: new Date().toISOString()
      }]);
      addNotification?.(`Failed to submit answers: ${error.message}`, 'error');
    }
  }, [
    user?.id,
    appendWorkflowStepEventMessages,
    appendMessagesToCurrentConversation,
    addNotification,
    processWorkflowRun,
    upsertWorkflowSnapshot
  ]);

  const handleReplayWorkflowA = useCallback(async (runId, options = {}) => {
    if (!runId) return;
    if (!user?.id) {
      addNotification?.('Please sign in before replay.', 'error');
      return;
    }

    try {
      const replaySnapshot = await replayWorkflowRun(runId, {
        use_cached_forecast: Boolean(options?.use_cached_forecast),
        use_cached_plan: Boolean(options?.use_cached_plan)
      });
      upsertWorkflowSnapshot(replaySnapshot);
      const newRunId = replaySnapshot?.run?.id;
      if (!newRunId) return;

      appendMessagesToCurrentConversation([
        {
          role: 'ai',
          content: `Replay started from run #${runId} (new run #${newRunId}).`,
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
      appendMessagesToCurrentConversation([{
        role: 'ai',
        type: 'workflow_error_card',
        payload: {
          step: 'replay',
          error_code: 'UNKNOWN',
          error_message: error.message || 'Unable to replay workflow.',
          next_actions: ['Retry replay.', 'Run the workflow again from the latest dataset card.']
        },
        timestamp: new Date().toISOString()
      }]);
      addNotification?.(`Workflow replay failed: ${error.message}`, 'error');
    }
  }, [
    user?.id,
    addNotification,
    appendMessagesToCurrentConversation,
    upsertWorkflowSnapshot,
    processWorkflowRun
  ]);

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
      const uploadPreparation = await prepareChatUploadFromFile(file);
      const datasetFingerprint = buildFingerprintFromUpload(uploadPreparation.sheetsRaw, uploadPreparation.mappingPlans);

      setUploadStatusText('Saving raw file...');
      const fileRecord = await userFilesService.saveFile(user.id, file.name, uploadPreparation.rawRowsForStorage);

      setUploadStatusText('Validating contract...');
      let profileRecord = await createDatasetProfileFromSheets({
        userId: user.id,
        userFileId: fileRecord?.id || null,
        fileName: file.name,
        sheetsRaw: uploadPreparation.sheetsRaw,
        mappingPlans: uploadPreparation.mappingPlans,
        allowLLM: false
      });

      const reuseEnabledForConversation = conversationDatasetContext[currentConversationId]?.reuse_enabled !== false;
      const workflow = getWorkflowFromProfile(profileRecord?.profile_json || {});
      let reusePlan = {
        contract_template_id: null,
        settings_template_id: null,
        confidence: 0,
        mode: 'no_reuse',
        explanation: 'Reuse is disabled for this conversation.'
      };

      if (reuseEnabledForConversation) {
        try {
          const [contractTemplates, settingsTemplates, similarityIndexRows] = await Promise.all([
            reuseMemoryService.getContractTemplates(user.id, workflow, 60),
            reuseMemoryService.getRunSettingsTemplates(user.id, workflow, 60),
            reuseMemoryService.getRecentSimilarityIndex(user.id, 120)
          ]);

          reusePlan = buildReusePlan({
            dataset_profile: profileRecord,
            contract_templates: contractTemplates,
            settings_templates: settingsTemplates,
            similarity_index_rows: similarityIndexRows
          });
        } catch (error) {
          reusePlan = {
            contract_template_id: null,
            settings_template_id: null,
            confidence: 0,
            mode: 'no_reuse',
            explanation: 'Reuse memory is unavailable; continuing with deterministic mapping.'
          };
          console.warn('[DecisionSupportView] Reuse lookup skipped:', error.message);
        }
      }

      let autoReused = false;
      let reusedSettingsTemplate = null;
      if (reusePlan.mode === 'auto_apply' && reusePlan.contract_template_id) {
        const template = await reuseMemoryService.getContractTemplateById(user.id, reusePlan.contract_template_id);
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
        const settingsTemplate = await reuseMemoryService.getRunSettingsTemplateById(user.id, reusePlan.settings_template_id);
        if (settingsTemplate?.settings_json) {
          reusedSettingsTemplate = settingsTemplate.settings_json;
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

      addNotification?.('Upload complete: profile + contract + validation saved.', 'success');
    } catch (error) {
      const errorMessage = getErrorMessage(error, 'Unable to upload dataset.');
      console.error('Dataset upload failed:', error);
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
          onRunForecast={(cardPayload) => executeForecastFlow({
            profileId: cardPayload?.dataset_profile_id,
            fallbackProfileRow: {
              id: cardPayload?.dataset_profile_id,
              user_file_id: cardPayload?.user_file_id || null,
              profile_json: cardPayload?.profile_json || {},
              contract_json: cardPayload?.contract_json || {}
            }
          })}
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
      const runId = Number(message.payload?.run_id);
      const snapshot = workflowSnapshots[runId] || null;
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
    if (message.type === 'topology_graph_card') {
      const runId = Number(message?.payload?.run_id || message?.payload?.graph?.run_id || NaN);
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
    if (message.type === 'ai_error_card') {
      return (
        <AIErrorCard
          payload={message.payload}
          onConfigure={handleConfigureApiKey}
        />
      );
    }
    return null;
  }, [
    activeDatasetContext,
    currentConversationId,
    handleConfigureApiKey,
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
    executeRiskAwarePlanFlow
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
