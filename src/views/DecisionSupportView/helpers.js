/**
 * DecisionSupportView helper functions and constants.
 * Pure, stateless utilities extracted from index.jsx for maintainability.
 */

import { buildDatasetFingerprint } from '../../utils/datasetFingerprint';
import { buildActualVsForecastSeries } from '../../utils/charts/buildActualVsForecastSeries';
import { buildProofInlineBlock } from '../../utils/proofFormatter';
import UPLOAD_SCHEMAS from '../../utils/uploadSchemas';
import { getRequiredMappingStatus } from '../../utils/requiredMappingStatus';
import { ruleBasedMapping } from '../../utils/aiMappingHelper';
import { ASSISTANT_NAME } from '../../config/branding';
import { WORKFLOW_NAMES } from '../../workflows/workflowRegistry';
import { RUN_STEP_ORDER } from '../../services/chatCanvasWorkflowService';

// ── Storage & config constants ──────────────────────────────────────
export const STORAGE_KEY = 'decision_intelligence_conversations';
export const TABLE_UNAVAILABLE_KEY = 'decision_intelligence_conversations_table_unavailable';
export const SIDEBAR_COLLAPSED_KEY_PREFIX = 'decision_intelligence_sidebar_collapsed_';
export const CANVAS_SPLIT_RATIO_KEY_PREFIX = 'decision_intelligence_canvas_split_ratio_';
export const MAX_UPLOAD_MESSAGE = 'Please upload aggregated data (e.g., SKU-store-day/week). Maximum 50MB.';

export function createDefaultCanvasState() {
  return {
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
}

/** @deprecated Use createDefaultCanvasState() for a fresh copy with current timestamp */
export const DEFAULT_CANVAS_STATE = createDefaultCanvasState();

export const EXECUTION_KEYWORDS = [
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

export const SPLIT_RATIO_MIN = 0.25;
export const SPLIT_RATIO_MAX = 0.75;
export const ASYNC_JOB_POLL_INTERVAL_MS = 2000;
export const ASYNC_JOB_MAX_POLLS = 1200;

export const BIND_TO_ALLOWLIST = ['mapping.', 'settings.'];

export const QUICK_PROMPTS = [
  { label: 'Top risk items', prompt: 'What are my top 5 highest-risk materials right now? Show their risk scores and recommended actions.' },
  { label: 'Stockout forecast', prompt: 'Which materials are most likely to stockout in the next 2 weeks? What actions should I take?' },
  { label: 'Replenishment plan', prompt: 'Plan replenishment for Warehouse A next month and show constraints/exceptions.' }
];

export const AI_EMPLOYEE_QUICK_PROMPTS = [
  { label: 'Monthly report', prompt: 'Generate the monthly meeting report with forecast, plan, and risk analysis.' },
  { label: 'Analyze my data', prompt: 'Analyze the uploaded data and give me a summary with key insights.' },
  { label: 'Risk assessment', prompt: 'Run a full risk assessment and flag the top issues I should address.' },
  { label: 'Forecast + Plan', prompt: 'Run demand forecast then generate a replenishment plan based on the results.' },
];

export const REQUIRED_UPLOAD_TYPES_BY_EXECUTION = {
  forecast: ['demand_fg'],
  [WORKFLOW_NAMES.A]: ['demand_fg', 'inventory_snapshots', 'po_open_lines', 'bom_edge'],
  [WORKFLOW_NAMES.B]: ['po_open_lines', 'goods_receipt']
};

// ── Pure helper functions ───────────────────────────────────────────

export function clampSplitRatio(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0.5;
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, numeric));
}

export function isApiKeyConfigError(message = '') {
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

export function getErrorMessage(error, fallback = 'Unexpected error') {
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

export function loadLocalConversations(userId) {
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY}_${userId}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveLocalConversations(userId, conversations) {
  try {
    localStorage.setItem(`${STORAGE_KEY}_${userId}`, JSON.stringify(conversations));
  } catch {
    // Ignore localStorage quota errors.
  }
}

export const normalizeHeader = (value) => String(value || '').trim().toLowerCase().replace(/[\s\-./]+/g, '_');

export function inferTimeGuess(columns = []) {
  const normalized = columns.map(normalizeHeader);
  const timeColumn = normalized.find((col) => /(date|week|month|time|bucket|snapshot)/.test(col)) || '';
  let granularity = 'unknown';
  if (timeColumn.includes('week')) granularity = 'week';
  else if (timeColumn.includes('month')) granularity = 'month';
  else if (timeColumn.includes('date') || timeColumn.includes('snapshot')) granularity = 'day';

  return { timeColumn, granularity };
}

export function buildFingerprintFromUpload(sheetsRaw = [], mappingPlans = []) {
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

export function getWorkflowFromProfile(profileJson = {}) {
  const label = String(profileJson?.global?.workflow_guess?.label || 'A').trim().toUpperCase();
  if (label === 'A') return WORKFLOW_NAMES.A;
  if (label === 'B') return WORKFLOW_NAMES.B;
  if (label === 'C') return WORKFLOW_NAMES.A;
  return WORKFLOW_NAMES.A;
}

export function buildRuntimeWorkflowSettings(context = {}, explicitSettings = {}) {
  const templateSettings = context?.reused_settings_template || {};
  return {
    ...templateSettings,
    ...explicitSettings,
    reuse_enabled: context?.reuse_enabled !== false,
    force_retrain: Boolean(context?.force_retrain)
  };
}

export function buildValidationPayload(profileRow) {
  const validation = profileRow?.contract_json?.validation || {};
  return {
    status: validation.status || 'fail',
    reasons: Array.isArray(validation.reasons) && validation.reasons.length > 0
      ? validation.reasons
      : ['Validation reasons unavailable']
  };
}

export function buildDownloadsPayload({ profileJson, contractJson, profileId }) {
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

export function buildConfirmationPayload(cardPayload, mappingPlans = []) {
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
    const validationPassed = sheet.validation_status === 'pass';
    // Only prompt confirmation when validation fails OR confidence is very low (<50%)
    // Sheets that pass validation with moderate confidence (≥50%) don't need confirmation
    return missingRequired || (!validationPassed && Number(sheet.confidence || 0) < 0.7) || Number(sheet.confidence || 0) < 0.5;
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

export function toSourceToTargetMapping(targetToSource = {}) {
  const mapping = {};
  Object.entries(targetToSource || {}).forEach(([targetField, sourceColumn]) => {
    if (!targetField || !sourceColumn) return;
    mapping[String(sourceColumn)] = String(targetField);
  });
  return mapping;
}

export function toTargetToSourceMapping(sourceToTarget = {}) {
  const mapping = {};
  Object.entries(sourceToTarget || {}).forEach(([sourceColumn, targetField]) => {
    if (!sourceColumn || !targetField) return;
    mapping[String(targetField)] = String(sourceColumn);
  });
  return mapping;
}

export function normalizeMappingToken(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s\-./]+/g, '_');
}

export function resolveHeaderCandidate(sourceCandidate, headers = []) {
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

export function inferMappingForRole(uploadType, headers = [], existingTargetToSource = {}) {
  const schema = UPLOAD_SCHEMAS[uploadType];
  if (!schema || !Array.isArray(headers) || headers.length === 0) {
    return existingTargetToSource || {};
  }

  const sourceToTarget = {
    ...toSourceToTargetMapping(existingTargetToSource || {})
  };

  const usedTargets = new Set(Object.values(sourceToTarget));
  const usedSourceColumns = new Set(Object.keys(sourceToTarget));

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

export function applyContractOverrides(contractJson = {}, profileJson = {}, overrides = {}, mappingOverrides = {}) {
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

export function buildExecutionGateResult(profileRow = {}, executionKey = 'forecast') {
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

export function buildEvidenceSummaryText(summary = {}) {
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

export function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function buildActualVsForecastRowsFromForecastCard(payload = {}) {
  const built = buildActualVsForecastSeries(payload);
  return built.series.length > 0 ? built.rows : [];
}

export function buildInventoryProjectionRowsFromCard(payload = {}) {
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

export function buildCostBreakdownRowsFromPlanSummary(payload = {}) {
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

export function deriveCanvasChartPatchFromCard(cardType, payload = {}) {
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

export function toPositiveRunId(value) {
  // Accept local-* IDs from offline workflow runs
  if (typeof value === 'string' && value.startsWith('local-')) return value;
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) return null;
  return numeric;
}

export function extractRunIdFromMessage(message) {
  if (!message) return null;
  const payload = message.payload || {};
  const fields = [payload.run_id, payload.runId, payload.forecast_run_id];
  for (const field of fields) {
    const runId = toPositiveRunId(field);
    if (runId !== null) return runId;
  }
  return null;
}

export function findLatestRunIdFromMessages(messages = []) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const runId = extractRunIdFromMessage(messages[i]);
    if (Number.isFinite(runId)) return runId;
  }
  return null;
}

export function findLatestWorkflowRunIdFromMessages(messages = []) {
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

export function normalizeWorkflowUiError(error, { fallbackCode = 'UNKNOWN', fallbackMessage = 'Workflow step failed', fallbackActions = [] } = {}) {
  const code = String(error?.code || '').trim() || fallbackCode;
  const message = String(error?.message || '').trim() || fallbackMessage;
  const nextActions = Array.isArray(error?.nextActions) && error.nextActions.length > 0
    ? error.nextActions.slice(0, 2)
    : fallbackActions;
  return {
    code,
    message,
    nextActions
  };
}

export async function loadDomainContext(userId, supabase) {
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

export function buildSystemPrompt(domainCtx, activeDatasetContext, dataProfile = null, insights = null) {
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

  const proofBlock = buildProofInlineBlock(domainCtx?.lastPlanSolverResult);
  if (proofBlock) {
    prompt += `\n### Last Plan: Solver Proof\n${proofBlock}\n`;
    prompt += '\nWhen answering plan questions, reference these binding constraints and objective terms explicitly.\n';
  }

  // ── Enterprise Data section ──
  prompt += '\n## Enterprise Data via SQL\n';
  prompt += 'You have direct access to enterprise data via the **query_sap_data** tool. Two datasets are available, but they do NOT have the same availability guarantees:\n\n';

  // Dataset A: Use dynamic profile digest if available, otherwise fall back to static.
  // dataProfile should already be a pre-built digest string (from buildProfileDigest()).
  if (dataProfile) {
    prompt += '### Dataset A: Olist E-Commerce (Brazilian market — CSV)\n';
    prompt += (typeof dataProfile === 'string' ? dataProfile : JSON.stringify(dataProfile));
    prompt += '\n';
  } else {
    prompt += `### Dataset A: Olist E-Commerce (Brazilian market — CSV)
| Table | SAP Equiv | Key Columns | Rows |
|-------|-----------|-------------|------|
| customers | KNA1 | customer_id, customer_city, customer_state | ~99K |
| orders | VBAK | order_id, customer_id, order_status, timestamps | ~99K |
| order_items | VBAP | order_id, product_id, seller_id, price, freight_value | ~112K |
| payments | BSEG | order_id, payment_type, payment_installments, payment_value | ~103K |
| reviews | QM | order_id, review_score, review_comment_message | ~104K |
| products | MARA | product_id, product_category_name, weight, dimensions | ~32K |
| sellers | LFA1 | seller_id, seller_city, seller_state | ~3K |
| geolocation | ADRC | zip_code_prefix, lat, lng, city, state | ~1M |
| category_translation | T023T | product_category_name, product_category_name_english | 71 |
`;
  }

  prompt += `\n### Dataset B: DI Operations (Supply chain — Supabase; current-user scoped, may be empty)
| Table | SAP Equiv | Key Columns |
|-------|-----------|-------------|
| suppliers | LFA1 | supplier_code, supplier_name, status |
| materials | MARA | material_code, material_name, category, uom |
| inventory_snapshots | MARD | material_code, plant_id, onhand_qty, safety_stock |
| po_open_lines | EKPO | po_number, material_code, plant_id, open_qty, status |
| goods_receipts | MKPF | supplier_name, material_code, qty, is_on_time |
`;

  // Accumulated data insights — helps Agent write better SQL, NOT skip queries
  if (insights?.length > 0) {
    prompt += '\n### Data Hints (from previous queries — use these to write better SQL, but ALWAYS re-query for exact numbers)\n';
    prompt += insights.map(i => `- ${i.fact}`).join('\n');
    prompt += '\n';
  }

  prompt += `\n**CRITICAL**: When the user asks about ANY data, you MUST call **query_sap_data** with a SQL SELECT query. NEVER just describe SQL — execute it directly.
Use **list_sap_tables** to show table schemas if the user asks what data is available.
Dataset A is built-in. Dataset B depends on the current user having imported or synced operational data.
You can JOIN across both datasets. Always clarify which dataset the results come from.
`;

  prompt += '\nWhite-box rule: never invent numeric outputs. If exact values are unavailable, use query_sap_data to look them up.';
  return prompt;
}

export function isExecutionIntent(text = '') {
  const lowered = String(text || '').toLowerCase();
  return EXECUTION_KEYWORDS.some((keyword) => lowered.includes(keyword));
}

/**
 * Check if a message looks like a data query that should use the SAP fast-path.
 * Matches: SQL keywords, data entity names (EN/ZH), "how many", "list", "show me", etc.
 */
export function looksLikeDataQuery(text = '') {
  if (!text) return false;
  const lower = text.toLowerCase();
  const patterns = [
    /\bSELECT\b/i,
    /\b(客戶|訂單|產品|賣家|供應商|物料|庫存|採購|付款|評論|收貨)\b/,
    /\b(有哪些|列出|多少|幾個|查詢|統計|排名|top\s*\d+)\b/,
    /\b(customers?|orders?|products?|sellers?|suppliers?|materials?|inventory|payments?|reviews?)\b/i,
    /\b(how many|list all|show me|count|which|what are|query)\b/i,
  ];
  return patterns.some((re) => re.test(lower));
}

// ── Session storage helpers ─────────────────────────────────────────

export function initTableAvailability() {
  const tableUnavailableAtLoad = sessionStorage.getItem(TABLE_UNAVAILABLE_KEY) === '1';
  return !tableUnavailableAtLoad;
}

export function isTableUnavailable() {
  return sessionStorage.getItem(TABLE_UNAVAILABLE_KEY) === '1';
}

export function markTableUnavailable() {
  sessionStorage.setItem(TABLE_UNAVAILABLE_KEY, '1');
}
