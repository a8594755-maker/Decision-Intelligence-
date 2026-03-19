import { userFilesService } from './supabaseClient';
import { diRunsService } from './diRunsService';
import { reuseMemoryService } from './reuseMemoryService';
import optimizationApiClient from './optimizationApiClient';
import { constraintChecker } from '../utils/constraintChecker';
import { replaySimulator } from '../utils/replaySimulator';
import { saveJsonArtifact, saveCsvArtifact } from '../utils/artifactStore';
import { DI_PROMPT_IDS, runDiPrompt } from './diModelRouterService';
import { buildDecisionNarrativeFromPlanResult } from '../utils/buildDecisionNarrative';
import { recordPlanGenerated } from './planAuditService';
import {
  MULTI_ECHELON_MODES,
  resolveMultiEchelonConfig,
  normalizeSkuKey,
  explodeBomForRun
} from './multiEchelonBomService';
import {
  computeRiskAdjustments,
  applyRiskAdjustmentsToInventory,
  applyRiskAdjustmentsToObjective,
  applyRiskAdjustmentsToSafetyStockPenalty,
  applyDemandUplift,
  buildPlanComparison
} from './riskAdjustmentsService';
import { applyScenarioOverridesToPayload } from '../utils/applyScenarioOverrides';
import { createFallbackAudit } from '../config/fallbackPolicies';
import { buildDataQualityReport } from '../utils/dataQualityReport';
import { evaluateCapabilities } from '../config/capabilityMatrix';
import {
  logger, createSpan,
  recordPlanningAttempt, recordPlanningSuccess, recordPlanningFailure,
  recordFallbackUsed, recordDegradedCapability, recordZeroResultPlan
} from './observability';
import {
  normalizeText, createBlockingError, toNumber,
  parseDateValue, toIsoDay, normalizeRowsFromUserFile, getRowsForSheet,
  normalizeTargetMapping, chooseDatasetByType
} from '../utils/dataServiceHelpers';

const MAX_PLAN_ROWS_IN_CARD = 50;
const MAX_PLAN_ROWS_IN_ARTIFACT = 2000;
const MAX_PROJECTION_ROWS_IN_ARTIFACT = 4000;
const MAX_COMPONENT_PLAN_ROWS_IN_ARTIFACT = 4000;
const MAX_COMPONENT_PROJECTION_ROWS_IN_ARTIFACT = 6000;
const MAX_BLOCKING_QUESTIONS = 2;
const MAX_DOWNLOADABLE_CSV_BYTES = 150000;
const ARTIFACT_SIZE_THRESHOLD = 200 * 1024;

const parseEnvBoolean = (value, defaultValue = false) => {
  if (value === undefined || value === null || value === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return defaultValue;
};

// Defaults are enabled for chat planning because inventory schema does not require
// lead_time_days/safety_stock for every upload and strict blocking caused false stops.
const ALLOW_PLAN_DEFAULTS = parseEnvBoolean(import.meta.env.VITE_DI_ALLOW_PLAN_DEFAULTS, true);

// DI_RISK_AWARE env flag: set VITE_DI_RISK_AWARE=true to enable risk-aware planning globally.
// Callers can also enable per-run via riskMode='on' parameter.
const ENV_RISK_AWARE = parseEnvBoolean(import.meta.env.VITE_DI_RISK_AWARE, false);
const DEFAULT_LEAD_TIME_DAYS = Math.max(0, Number(import.meta.env.VITE_DI_DEFAULT_LEAD_TIME_DAYS || 7));
const DEFAULT_SAFETY_STOCK = Math.max(0, Number(import.meta.env.VITE_DI_DEFAULT_SAFETY_STOCK || 0));

// Shared helpers imported from ../utils/dataServiceHelpers.js
// (normalizeText, normalizeSheetName, createBlockingError, toNumber,
//  parseDateValue, toIsoDay, normalizeRowsFromUserFile, getRowsForSheet,
//  normalizeTargetMapping, chooseDatasetByType)

const getMappedTimeField = (mapping = {}, candidates = []) => {
  for (const targetField of candidates) {
    if (mapping[targetField]) return mapping[targetField];
  }
  return null;
};

const findNumericByHeaderHint = (row, hints = []) => {
  if (!row || typeof row !== 'object') return null;
  const entries = Object.entries(row);
  for (const [key, value] of entries) {
    const normalizedKey = normalizeText(key).toLowerCase();
    if (!hints.some((hint) => hint.test(normalizedKey))) continue;
    const parsed = toNumber(value, NaN);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const mapInventoryRows = ({ rows, sheetName, mapping }) => {
  const relevantRows = getRowsForSheet(rows, sheetName);

  const mapped = [];
  let dropped = 0;

  relevantRows.forEach((row) => {
    const sku = normalizeText(row[mapping.material_code]);
    const plant = normalizeText(row[mapping.plant_id]);
    const snapshotRaw = row[getMappedTimeField(mapping, ['snapshot_date', 'date', 'time_bucket', 'week_bucket'])];
    const snapshotDateObj = parseDateValue(snapshotRaw);
    const snapshotDate = snapshotDateObj ? toIsoDay(snapshotDateObj) : null;

    const onHand = toNumber(row[mapping.onhand_qty], NaN);
    if (!sku || !snapshotDate || !Number.isFinite(onHand)) {
      dropped += 1;
      return;
    }

    const mappedSafety = mapping.safety_stock ? toNumber(row[mapping.safety_stock], NaN) : NaN;
    const mappedLead = mapping.lead_time_days ? toNumber(row[mapping.lead_time_days], NaN) : NaN;

    const safetyStock = Number.isFinite(mappedSafety)
      ? Math.max(0, mappedSafety)
      : (() => {
          const inferred = findNumericByHeaderHint(row, [/safety[_\s-]?stock/, /ss\b/]);
          return Number.isFinite(inferred) ? Math.max(0, inferred) : null;
        })();

    const leadTime = Number.isFinite(mappedLead)
      ? Math.max(0, Math.round(mappedLead))
      : (() => {
          const inferred = findNumericByHeaderHint(row, [/lead[_\s-]?time/, /lt[_\s-]?days?/]);
          return Number.isFinite(inferred) ? Math.max(0, Math.round(inferred)) : null;
        })();

    const moq = (() => {
      const mappedValue = mapping.moq ? toNumber(row[mapping.moq], NaN) : NaN;
      if (Number.isFinite(mappedValue)) return Math.max(0, mappedValue);
      const inferred = findNumericByHeaderHint(row, [/\bmoq\b/, /min[_\s-]?order/, /min[_\s-]?qty/]);
      return Number.isFinite(inferred) ? Math.max(0, inferred) : null;
    })();

    const packSize = (() => {
      const mappedValue = mapping.pack_size ? toNumber(row[mapping.pack_size], NaN) : NaN;
      if (Number.isFinite(mappedValue)) return Math.max(0, mappedValue);
      const inferred = findNumericByHeaderHint(row, [/pack[_\s-]?size/, /pack[_\s-]?qty/, /case[_\s-]?pack/]);
      return Number.isFinite(inferred) ? Math.max(0, inferred) : null;
    })();

    const maxOrderQty = (() => {
      const mappedValue = mapping.max_order_qty ? toNumber(row[mapping.max_order_qty], NaN) : NaN;
      if (Number.isFinite(mappedValue)) return Math.max(0, mappedValue);
      const inferred = findNumericByHeaderHint(row, [/max[_\s-]?order/, /max[_\s-]?qty/]);
      return Number.isFinite(inferred) ? Math.max(0, inferred) : null;
    })();

    const unitCost = (() => {
      const explicit = mapping.unit_cost ? toNumber(row[mapping.unit_cost], NaN) : NaN;
      if (Number.isFinite(explicit)) return Math.max(0, explicit);

      const price = mapping.unit_price ? toNumber(row[mapping.unit_price], NaN) : NaN;
      if (Number.isFinite(price)) return Math.max(0, price);

      const inferred = findNumericByHeaderHint(row, [/unit[_\s-]?cost/, /unit[_\s-]?price/, /\bcost\b/, /\bprice\b/]);
      return Number.isFinite(inferred) ? Math.max(0, inferred) : null;
    })();

    mapped.push({
      sku,
      plant_id: plant || null,
      as_of_date: snapshotDate,
      on_hand: Number(onHand),
      safety_stock: safetyStock,
      lead_time_days: leadTime,
      moq,
      pack_size: packSize,
      max_order_qty: maxOrderQty,
      unit_cost: unitCost
    });
  });

  return {
    rows: mapped,
    dropped
  };
};

const mapOpenPoRows = ({ rows, sheetName, mapping }) => {
  const relevantRows = getRowsForSheet(rows, sheetName);

  const mapped = [];
  let dropped = 0;

  const timeField = getMappedTimeField(mapping, ['date', 'time_bucket', 'week_bucket']);

  relevantRows.forEach((row) => {
    const sku = normalizeText(row[mapping.material_code]);
    const plant = normalizeText(row[mapping.plant_id]);

    const etaDateObj = parseDateValue(row[timeField]);
    const etaDate = etaDateObj ? toIsoDay(etaDateObj) : null;
    const qty = toNumber(row[mapping.open_qty], NaN);

    if (!sku || !etaDate || !Number.isFinite(qty)) {
      dropped += 1;
      return;
    }

    if (qty <= 0) {
      return;
    }

    mapped.push({
      sku,
      plant_id: plant || null,
      eta_date: etaDate,
      qty: Number(qty)
    });
  });

  return {
    rows: mapped,
    dropped
  };
};

const normalizeBomValue = (value, mappingRules = {}) => normalizeSkuKey(value, mappingRules);

const mapBomEdgeRows = ({ rows, sheetName, mapping, mappingRules }) => {
  const relevantRows = getRowsForSheet(rows, sheetName);
  const mapped = [];
  let dropped = 0;

  relevantRows.forEach((row) => {
    const parentRaw = mapping.parent_material ? row[mapping.parent_material] : row.parent_material;
    const childRaw = mapping.child_material ? row[mapping.child_material] : row.child_material;

    const parentMaterial = normalizeBomValue(parentRaw, mappingRules);
    const childMaterial = normalizeBomValue(childRaw, mappingRules);

    const qtyMapped = mapping.qty_per ? toNumber(row[mapping.qty_per], NaN) : NaN;
    const qtyPer = Number.isFinite(qtyMapped)
      ? qtyMapped
      : findNumericByHeaderHint(row, [/qty[_\s-]?per/, /quantity[_\s-]?per/, /usage[_\s-]?qty/, /^usage$/, /^qty$/]);

    if (!parentMaterial || !childMaterial || !Number.isFinite(qtyPer) || qtyPer <= 0) {
      dropped += 1;
      return;
    }

    const plantRaw = mapping.plant_id ? row[mapping.plant_id] : row.plant_id;
    const plantId = normalizeText(plantRaw) || null;

    const validFromObj = parseDateValue(mapping.valid_from ? row[mapping.valid_from] : row.valid_from);
    const validToObj = parseDateValue(mapping.valid_to ? row[mapping.valid_to] : row.valid_to);

    const scrapRateCandidate = mapping.scrap_rate ? toNumber(row[mapping.scrap_rate], NaN) : toNumber(row.scrap_rate, NaN);
    const yieldRateCandidate = mapping.yield_rate ? toNumber(row[mapping.yield_rate], NaN) : toNumber(row.yield_rate, NaN);
    const priorityCandidate = mapping.priority ? toNumber(row[mapping.priority], NaN) : toNumber(row.priority, NaN);

    mapped.push({
      id: normalizeText(row.id) || null,
      parent_material: parentMaterial,
      child_material: childMaterial,
      qty_per: Number(qtyPer),
      plant_id: plantId,
      valid_from: validFromObj ? toIsoDay(validFromObj) : null,
      valid_to: validToObj ? toIsoDay(validToObj) : null,
      scrap_rate: Number.isFinite(scrapRateCandidate) ? Number(scrapRateCandidate) : null,
      yield_rate: Number.isFinite(yieldRateCandidate) ? Number(yieldRateCandidate) : null,
      priority: Number.isFinite(priorityCandidate) ? Number(priorityCandidate) : null,
      created_at: toIsoDay(parseDateValue(row.created_at)) || null
    });
  });

  mapped.sort((a, b) => {
    if (a.parent_material !== b.parent_material) return a.parent_material.localeCompare(b.parent_material);
    if (a.child_material !== b.child_material) return a.child_material.localeCompare(b.child_material);
    if ((a.plant_id || '') !== (b.plant_id || '')) return (a.plant_id || '').localeCompare(b.plant_id || '');
    if ((a.valid_from || '') !== (b.valid_from || '')) return (a.valid_from || '').localeCompare(b.valid_from || '');
    if ((a.valid_to || '') !== (b.valid_to || '')) return (a.valid_to || '').localeCompare(b.valid_to || '');
    return String(a.id || '').localeCompare(String(b.id || ''));
  });

  return {
    rows: mapped,
    dropped
  };
};

const toForecastDemandSeries = (forecastArtifact = {}) => {
  const groups = Array.isArray(forecastArtifact.groups)
    ? forecastArtifact.groups
    : Array.isArray(forecastArtifact.series_groups)
      ? forecastArtifact.series_groups
      : [];

  const rows = [];
  groups.forEach((group) => {
    const sku = normalizeText(group.material_code || group.sku);
    const plant = normalizeText(group.plant_id);
    if (!sku) return;

    const points = Array.isArray(group.points) ? group.points : [];
    points.forEach((point) => {
      // Guard: null/undefined must not be coerced to 0 via Number(null)===0
      const rawP50 = point.p50 ?? point.forecast;
      const p50Candidate = (rawP50 === null || rawP50 === undefined)
        ? NaN
        : toNumber(rawP50, NaN);
      const isForecastPoint = point.is_forecast === true || Number.isFinite(p50Candidate);
      if (!isForecastPoint) return;

      const bucket = point.time_bucket || point.date;
      const dateObj = parseDateValue(bucket);
      const date = dateObj ? toIsoDay(dateObj) : null;
      if (!date) return;

      const p50 = p50Candidate;
      if (!Number.isFinite(p50)) return;

      const p90Candidate = toNumber(point.p90 ?? point.upper, NaN);
      const p10Candidate = toNumber(point.p10 ?? point.lower, NaN);
      rows.push({
        sku,
        plant_id: plant || null,
        date,
        p10: Number.isFinite(p10Candidate) ? Math.max(0, Number(p10Candidate)) : null,
        p50: Math.max(0, Number(p50)),
        p90: Number.isFinite(p90Candidate) ? Math.max(0, Number(p90Candidate)) : null
      });
    });
  });

  rows.sort((a, b) => {
    if (a.sku !== b.sku) return a.sku.localeCompare(b.sku);
    if ((a.plant_id || '') !== (b.plant_id || '')) return (a.plant_id || '').localeCompare(b.plant_id || '');
    return a.date.localeCompare(b.date);
  });

  return rows;
};

const derivePlanningHorizonDays = (forecastSeries = [], fallback = 30) => {
  if (!Array.isArray(forecastSeries) || forecastSeries.length === 0) return fallback;

  const uniqueDates = Array.from(new Set(forecastSeries.map((row) => row.date))).sort((a, b) => a.localeCompare(b));
  if (uniqueDates.length <= 1) return fallback;

  const first = parseDateValue(uniqueDates[0]);
  const last = parseDateValue(uniqueDates[uniqueDates.length - 1]);
  if (!first || !last) return fallback;

  const diffDays = Math.max(1, Math.round((last.getTime() - first.getTime()) / (24 * 60 * 60 * 1000)) + 1);
  return Math.max(7, diffDays);
};

const buildConstraintsFromInventory = ({ inventoryRows = [], constraintsOverride = {} }) => {
  const bySku = new Map();

  inventoryRows.forEach((row) => {
    const sku = normalizeText(row.sku);
    if (!sku) return;

    if (!bySku.has(sku)) {
      bySku.set(sku, {
        moq: null,
        pack_size: null,
        max_order_qty: null,
        unit_cost: null
      });
    }

    const target = bySku.get(sku);
    if (target.moq === null && Number.isFinite(toNumber(row.moq, NaN)) && row.moq > 0) target.moq = Number(row.moq);
    if (target.pack_size === null && Number.isFinite(toNumber(row.pack_size, NaN)) && row.pack_size > 0) target.pack_size = Number(row.pack_size);
    if (target.max_order_qty === null && Number.isFinite(toNumber(row.max_order_qty, NaN)) && row.max_order_qty > 0) target.max_order_qty = Number(row.max_order_qty);
    if (target.unit_cost === null && Number.isFinite(toNumber(row.unit_cost, NaN)) && row.unit_cost >= 0) target.unit_cost = Number(row.unit_cost);
  });

  const constraints = {
    moq: [],
    pack_size: [],
    max_order_qty: [],
    budget_cap: null,
    unit_costs: []
  };

  Array.from(bySku.entries()).sort((a, b) => a[0].localeCompare(b[0])).forEach(([sku, values]) => {
    if (Number.isFinite(toNumber(values.moq, NaN)) && values.moq > 0) {
      constraints.moq.push({ sku, min_qty: Number(values.moq) });
    }
    if (Number.isFinite(toNumber(values.pack_size, NaN)) && values.pack_size > 0) {
      constraints.pack_size.push({ sku, pack_qty: Number(values.pack_size) });
    }
    if (Number.isFinite(toNumber(values.max_order_qty, NaN)) && values.max_order_qty > 0) {
      constraints.max_order_qty.push({ sku, max_qty: Number(values.max_order_qty) });
    }
    if (Number.isFinite(toNumber(values.unit_cost, NaN)) && values.unit_cost >= 0) {
      constraints.unit_costs.push({ sku, unit_cost: Number(values.unit_cost) });
    }
  });

  const override = constraintsOverride || {};
  if (Number.isFinite(toNumber(override.budget_cap, NaN))) {
    constraints.budget_cap = Math.max(0, Number(override.budget_cap));
  }

  if (Array.isArray(override.moq) && override.moq.length > 0) {
    constraints.moq = override.moq;
  }
  if (Array.isArray(override.pack_size) && override.pack_size.length > 0) {
    constraints.pack_size = override.pack_size;
  }
  if (Array.isArray(override.max_order_qty) && override.max_order_qty.length > 0) {
    constraints.max_order_qty = override.max_order_qty;
  }
  if (Array.isArray(override.unit_costs) && override.unit_costs.length > 0) {
    constraints.unit_costs = override.unit_costs;
  }

  return constraints;
};

const buildObjective = (objectiveOverride = {}) => ({
  optimize_for: objectiveOverride.optimize_for || 'balanced',
  stockout_penalty: Number.isFinite(toNumber(objectiveOverride.stockout_penalty, NaN))
    ? Number(objectiveOverride.stockout_penalty)
    : 1,
  holding_cost: Number.isFinite(toNumber(objectiveOverride.holding_cost, NaN))
    ? Number(objectiveOverride.holding_cost)
    : 0,
  service_level_target: Number.isFinite(toNumber(objectiveOverride.service_level_target, NaN))
    ? Number(objectiveOverride.service_level_target)
    : null,
  ...(Number.isFinite(toNumber(objectiveOverride.safety_stock_alpha, NaN))
    ? { safety_stock_alpha: Number(objectiveOverride.safety_stock_alpha) }
    : {}),
  ...(objectiveOverride.use_p90_for_safety_stock === true || objectiveOverride.use_p90_for_safety_stock === false
    ? { use_p90_for_safety_stock: objectiveOverride.use_p90_for_safety_stock }
    : {}),
  ...(objectiveOverride.use_p90_for_service_level === true || objectiveOverride.use_p90_for_service_level === false
    ? { use_p90_for_service_level: objectiveOverride.use_p90_for_service_level }
    : {})
});

const mergeProjectionForChart = (withPlanProjection = [], withoutPlanProjection = []) => {
  const withoutMap = new Map();
  withoutPlanProjection.forEach((row) => {
    withoutMap.set(`${row.sku}|${row.plant_id || ''}|${row.date}`, row);
  });

  const merged = withPlanProjection.map((row) => {
    const key = `${row.sku}|${row.plant_id || ''}|${row.date}`;
    const baseline = withoutMap.get(key);
    return {
      sku: row.sku,
      plant_id: row.plant_id || null,
      date: row.date,
      with_plan: Number(row.on_hand_end || 0),
      without_plan: baseline ? Number(baseline.on_hand_end || 0) : null,
      demand: Number(row.demand || 0),
      stockout_units: Number(row.stockout_units || 0),
      inbound_plan: Number(row.inbound_plan || 0),
      inbound_open_pos: Number(row.inbound_open_pos || 0)
    };
  });

  merged.sort((a, b) => {
    if (a.sku !== b.sku) return a.sku.localeCompare(b.sku);
    if ((a.plant_id || '') !== (b.plant_id || '')) return (a.plant_id || '').localeCompare(b.plant_id || '');
    return a.date.localeCompare(b.date);
  });

  return merged;
};

const buildEvidencePack = ({
  runId,
  datasetProfileId,
  forecastRunId,
  solverResult,
  constraintResult,
  replayMetrics,
  artifactRefs,
  readiness,
  decisionNarrative,
  multiEchelon = null,
  componentPlan = null,
  bottlenecks = null,
  traceId = null
}) => ({
  generated_at: new Date().toISOString(),
  run_id: runId,
  ...(traceId ? { _traceId: traceId } : {}),
  dataset_profile_id: datasetProfileId,
  forecast_run_id: forecastRunId,
  solver_status: solverResult?.status || 'unknown',
  refs: artifactRefs || {},
  evidence: {
    readiness_check: readiness || null,
    solver_meta: solverResult?.solver_meta || {},
    kpis: solverResult?.kpis || {},
    constraint_check: constraintResult || {},
    replay_metrics: replayMetrics || {},
    decision_narrative: decisionNarrative || null,
    multi_echelon: multiEchelon || null,
    component_plan_summary: componentPlan
      ? {
          total_rows: componentPlan.total_rows || 0,
          truncated: Boolean(componentPlan.truncated)
        }
      : null,
    bottlenecks: bottlenecks || null
  }
});

const buildRuleBasedFinalReport = ({
  solverResult,
  constraintResult,
  replayMetrics,
  forecastMetrics,
  componentPlanRows = [],
  bottlenecks = null,
  multiEchelon = null
}) => {
  const serviceLevel = replayMetrics?.with_plan?.service_level_proxy;
  const baselineServiceLevel = replayMetrics?.without_plan?.service_level_proxy;
  const serviceDelta = Number.isFinite(serviceLevel) && Number.isFinite(baselineServiceLevel)
    ? Number((serviceLevel - baselineServiceLevel).toFixed(6))
    : null;

  const keyResults = [];
  if (Number.isFinite(serviceLevel)) {
    keyResults.push(`Service level proxy: ${(serviceLevel * 100).toFixed(2)}%`);
  }
  if (Number.isFinite(serviceDelta)) {
    const sign = serviceDelta >= 0 ? '+' : '';
    keyResults.push(`Service level delta vs no-plan replay: ${sign}${(serviceDelta * 100).toFixed(2)} pp`);
  }
  if (Number.isFinite(solverResult?.kpis?.estimated_total_cost)) {
    keyResults.push(`Estimated total cost proxy: ${solverResult.kpis.estimated_total_cost.toFixed(2)}`);
  }
  if (Number.isFinite(forecastMetrics?.mape)) {
    keyResults.push(`Forecast MAPE evidence: ${forecastMetrics.mape.toFixed(2)}%`);
  }

  const bottleneckRows = Array.isArray(bottlenecks?.rows) ? bottlenecks.rows : [];
  const uniqueComponentsPlanned = new Set(
    (Array.isArray(componentPlanRows) ? componentPlanRows : [])
      .map((row) => normalizeText(row.component_sku))
      .filter(Boolean)
  );
  const topBottlenecks = bottleneckRows.slice(0, 3).map((row) => ({
    component_sku: row.component_sku,
    missing_qty: Number(toNumber(row.missing_qty, 0).toFixed(6)),
    affected_fg_skus: Array.isArray(row.affected_fg_skus) ? row.affected_fg_skus.slice(0, 3) : []
  }));

  const bomAwareFeasibility = {
    mode: multiEchelon?.mode || MULTI_ECHELON_MODES.OFF,
    components_planned: uniqueComponentsPlanned.size,
    shortages_forced_fg_plan_changes: Boolean(
      solverResult?.solver_meta?.bom_shortages_impacted_fg
      || (topBottlenecks.length > 0 && Array.isArray(solverResult?.infeasible_reasons) && solverResult.infeasible_reasons.length > 0)
    ),
    top_bottlenecks: topBottlenecks
  };

  const exceptions = [];
  if (Array.isArray(solverResult?.infeasible_reasons) && solverResult.infeasible_reasons.length > 0) {
    exceptions.push(...solverResult.infeasible_reasons.slice(0, 5));
  }
  if (Array.isArray(constraintResult?.violations) && constraintResult.violations.length > 0) {
    exceptions.push(...constraintResult.violations.slice(0, 5).map((item) => `${item.rule}: ${item.details}`));
  }

  const recommendedActions = [];
  if (!constraintResult?.passed) {
    recommendedActions.push('Resolve hard constraint violations before execution.');
  }
  if (Number.isFinite(serviceLevel) && serviceLevel < 0.95) {
    recommendedActions.push('Review safety stock and lead-time assumptions for low-service SKUs.');
  }
  if (recommendedActions.length === 0) {
    recommendedActions.push('Proceed to planner review and approval with downloaded evidence pack.');
  }

  return {
    summary: constraintResult?.passed
      ? 'Plan solved and verified with deterministic constraint and replay checks.'
      : 'Plan failed hard constraint checks; review violations before using the plan.',
    key_results: keyResults,
    exceptions,
    recommended_actions: recommendedActions,
    bom_aware_feasibility: bomAwareFeasibility
  };
};

// String-only version – kept for normalizeReadinessPayload (minimal_questions display)
const normalizeBlockingQuestions = (questions = []) => (
  (Array.isArray(questions) ? questions : [])
    .map((item) => (typeof item === 'string' ? item : item?.question))
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .slice(0, MAX_BLOCKING_QUESTIONS)
);

// Structured version – preserves id / answer_type / options / why_needed / bind_to
// from Prompt 5 (BLOCKING_QUESTIONS). Strings are wrapped into minimal objects.
const normalizeBlockingQuestionsStructured = (questions = []) => (
  (Array.isArray(questions) ? questions : [])
    .map((item) => {
      if (typeof item === 'string') {
        const q = item.trim();
        return q ? { id: null, question: q, answer_type: 'text', options: null, why_needed: null, bind_to: null } : null;
      }
      if (item && typeof item === 'object') {
        const q = String(item.question || '').trim();
        if (!q) return null;
        return {
          id: item.id || null,
          question: q,
          answer_type: item.answer_type || 'text',
          options: Array.isArray(item.options) ? item.options : null,
          why_needed: item.why_needed ? String(item.why_needed).trim() : null,
          bind_to: item.bind_to ? String(item.bind_to).trim() : null
        };
      }
      return null;
    })
    .filter(Boolean)
    .slice(0, MAX_BLOCKING_QUESTIONS)
);

const normalizeReadinessPayload = (candidate) => {
  if (!candidate || typeof candidate !== 'object') return null;

  const blockingItems = Array.isArray(candidate.blocking_items)
    ? candidate.blocking_items
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
          item: String(item.item || '').trim(),
          why: String(item.why || '').trim()
        }))
        .filter((item) => item.item || item.why)
    : [];

  return {
    can_run_forecast: candidate.can_run_forecast !== false,
    can_run_optimization: candidate.can_run_optimization !== false,
    blocking_items: blockingItems,
    minimal_questions: normalizeBlockingQuestions(candidate.minimal_questions || [])
  };
};

const buildReadinessPromptInput = ({ datasetProfileRow, contractJson, objective, constraints }) => {
  const globalRange = datasetProfileRow?.profile_json?.global?.time_range_guess || {};
  const datasets = (Array.isArray(contractJson?.datasets) ? contractJson.datasets : []).map((dataset) => {
    const targetMapping = normalizeTargetMapping(dataset.mapping || {});
    const mappedTargets = Object.keys(targetMapping);
    return {
      name: String(dataset.upload_type || 'unknown'),
      columns: mappedTargets,
      time_range: {
        start: globalRange.start || null,
        end: globalRange.end || null
      }
    };
  });

  return {
    available_datasets: datasets,
    user_preferences: {
      service_level: Number.isFinite(toNumber(objective?.service_level_target, NaN))
        ? Number(objective.service_level_target)
        : null,
      budget_cap: Number.isFinite(toNumber(constraints?.budget_cap, NaN))
        ? Number(constraints.budget_cap)
        : null,
      optimize_for: objective?.optimize_for || null
    },
    allowed_defaults: {
      lead_time_days: ALLOW_PLAN_DEFAULTS ? DEFAULT_LEAD_TIME_DAYS : null,
      pack_size: null,
      moq: null
    }
  };
};

const getProofConstraints = (solverResult) => (
  Array.isArray(solverResult?.proof?.constraints_checked) ? solverResult.proof.constraints_checked : []
);

const getProofObjectiveTerms = (solverResult) => (
  Array.isArray(solverResult?.proof?.objective_terms) ? solverResult.proof.objective_terms : []
);

const getInfeasibleReasonDetails = (solverResult) => (
  Array.isArray(solverResult?.infeasible_reason_details)
    ? solverResult.infeasible_reason_details
    : (Array.isArray(solverResult?.infeasible_reasons_detailed) ? solverResult.infeasible_reasons_detailed : [])
);

const extractBindingConstraints = (constraintsChecked = []) => (
  (Array.isArray(constraintsChecked) ? constraintsChecked : []).filter(
    (constraint) => constraint?.passed === false || constraint?.binding === true
  )
);

const uniqueNonEmptyStrings = (values = []) => {
  const seen = new Set();
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .filter((value) => {
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    });
};

const extractSuggestedActions = (solverResult, limit = 6) => {
  const details = getInfeasibleReasonDetails(solverResult);
  const actions = details.flatMap((item) => (Array.isArray(item?.suggested_actions) ? item.suggested_actions : []));
  return uniqueNonEmptyStrings(actions).slice(0, Math.max(0, limit));
};

const buildEvidencePromptInput = ({
  solverResult,
  constraintResult,
  replayMetrics,
  forecastMetrics,
  runId,
  readiness,
  decisionNarrative = null
}) => {
  const evidence = [];
  const pushEvidence = (type, payload) => {
    evidence.push({
      evidence_id: `E${evidence.length + 1}`,
      type,
      payload
    });
  };

  const constraintsChecked = getProofConstraints(solverResult);
  const bindingConstraints = extractBindingConstraints(constraintsChecked);
  const objectiveTerms = getProofObjectiveTerms(solverResult);

  pushEvidence('solver_result', {
    run_id: runId,
    status: solverResult?.status || 'unknown',
    kpis: solverResult?.kpis || {},
    solver_meta: {
      ...(solverResult?.solver_meta || {}),
      gap: solverResult?.solver_meta?.gap ?? null,
      solve_time_ms: solverResult?.solver_meta?.solve_time_ms ?? null
    },
    proof_summary: {
      binding_constraints: bindingConstraints.slice(0, 20).map((constraint) => ({
        name: constraint?.name || '',
        tag: constraint?.tag || null,
        details: constraint?.details ? String(constraint.details) : '',
        description: constraint?.description ? String(constraint.description) : '',
        severity: constraint?.severity || 'hard',
        scope: constraint?.scope || null,
        sku: constraint?.sku || null,
        period: constraint?.period || null
      })),
      objective_terms: objectiveTerms.slice(0, 30).map((term) => ({
        name: term?.name || '',
        value: term?.value ?? null,
        note: term?.note ? String(term.note) : ''
      })),
      total_constraints_checked: constraintsChecked.length,
      total_binding: bindingConstraints.length
    },
    infeasible_reasons: Array.isArray(solverResult?.infeasible_reasons) ? solverResult.infeasible_reasons.slice(0, 5) : [],
    suggested_actions: extractSuggestedActions(solverResult, 4)
  });
  pushEvidence('constraint_check', constraintResult || {});
  pushEvidence('replay', replayMetrics || {});
  pushEvidence('forecast_metrics', forecastMetrics || {});
  if (decisionNarrative && typeof decisionNarrative === 'object') {
    pushEvidence('decision_narrative', decisionNarrative);
  }
  if (readiness) {
    pushEvidence('validation', readiness);
  }

  return { evidence };
};

const normalizeReportFromPrompt = (candidate) => {
  if (!candidate || typeof candidate !== 'object') return null;

  const summary = String(candidate.summary || '').trim();
  if (!summary) return null;

  const keyResults = Array.isArray(candidate.key_results)
    ? candidate.key_results
        .filter((item) => item && typeof item === 'object')
        .map((item) => String(item.claim || '').trim())
        .filter(Boolean)
    : [];

  const exceptions = Array.isArray(candidate.exceptions_and_constraints)
    ? candidate.exceptions_and_constraints
        .filter((item) => item && typeof item === 'object')
        .map((item) => {
          const issue = String(item.issue || '').trim();
          const impact = String(item.impact || '').trim();
          return [issue, impact].filter(Boolean).join(': ');
        })
        .filter(Boolean)
    : [];

  const recommendedActions = Array.isArray(candidate.recommended_actions)
    ? candidate.recommended_actions
        .filter((item) => item && typeof item === 'object')
        .map((item) => String(item.action || '').trim())
        .filter(Boolean)
    : [];

  return {
    summary,
    key_results: keyResults,
    exceptions,
    recommended_actions: recommendedActions
  };
};

const enrichBlockingQuestionsWithPrompt = async ({
  message,
  existingQuestions = [],
  contextInput = {}
}) => {
  const fallback = normalizeBlockingQuestionsStructured(existingQuestions);
  try {
    const result = await runDiPrompt({
      promptId: DI_PROMPT_IDS.BLOCKING_QUESTIONS,
      input: {
        stage: 'workflow_a_blocker',
        error_message: message,
        ...contextInput
      },
      temperature: 0.1,
      maxOutputTokens: 1200
    });
    const promptQuestions = normalizeBlockingQuestionsStructured(result?.parsed?.questions || []);
    return promptQuestions.length > 0 ? promptQuestions : fallback;
  } catch (error) {
    logger.warn('planning-pipeline', `Prompt 5 blocking question fallback: ${error.message}`);
    return fallback;
  }
};

const getPlanningTemplateQualityDelta = ({ constraintResult, replayMetrics }) => {
  if (!constraintResult?.passed) return -0.05;
  const serviceLevel = Number(replayMetrics?.with_plan?.service_level_proxy);
  if (Number.isFinite(serviceLevel)) {
    if (serviceLevel >= 0.98) return 0.1;
    if (serviceLevel >= 0.95) return 0.08;
    if (serviceLevel >= 0.9) return 0.05;
    return 0.03;
  }
  return 0.04;
};

const toCsv = (rows = []) => {
  if (!Array.isArray(rows) || rows.length === 0) return '';

  const headers = ['sku', 'plant_id', 'order_date', 'arrival_date', 'order_qty'];
  const escapeCell = (value) => {
    const raw = String(value ?? '');
    if (/[",\n]/.test(raw)) {
      return `"${raw.replace(/"/g, '""')}"`;
    }
    return raw;
  };

  const lines = [headers.join(',')];
  rows.forEach((row) => {
    lines.push(headers.map((header) => escapeCell(row[header])).join(','));
  });
  return lines.join('\n');
};

const toComponentPlanCsv = (rows = []) => {
  if (!Array.isArray(rows) || rows.length === 0) return '';

  const headers = ['component_sku', 'plant_id', 'order_date', 'arrival_date', 'order_qty'];
  const escapeCell = (value) => {
    const raw = String(value ?? '');
    if (/[",\n]/.test(raw)) {
      return `"${raw.replace(/"/g, '""')}"`;
    }
    return raw;
  };

  const lines = [headers.join(',')];
  rows.forEach((row) => {
    lines.push(headers.map((header) => escapeCell(row[header])).join(','));
  });
  return lines.join('\n');
};

const normalizeComponentPlanRows = (rows = []) => {
  if (!Array.isArray(rows)) return [];

  return rows
    .map((row) => ({
      component_sku: normalizeText(row?.component_sku || row?.sku),
      plant_id: normalizeText(row?.plant_id) || null,
      order_date: toIsoDay(parseDateValue(row?.order_date)),
      arrival_date: toIsoDay(parseDateValue(row?.arrival_date)),
      order_qty: Math.max(0, toNumber(row?.order_qty, 0))
    }))
    .filter((row) => row.component_sku && row.order_date && row.arrival_date && Number.isFinite(row.order_qty))
    .sort((a, b) => {
      if (a.component_sku !== b.component_sku) return a.component_sku.localeCompare(b.component_sku);
      if ((a.plant_id || '') !== (b.plant_id || '')) return (a.plant_id || '').localeCompare(b.plant_id || '');
      if (a.order_date !== b.order_date) return a.order_date.localeCompare(b.order_date);
      return a.arrival_date.localeCompare(b.arrival_date);
    });
};

const normalizeComponentProjectionRows = (rows = []) => {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => ({
      component_sku: normalizeText(row?.component_sku || row?.sku),
      plant_id: normalizeText(row?.plant_id) || null,
      date: toIsoDay(parseDateValue(row?.date)),
      on_hand_end: Math.max(0, toNumber(row?.on_hand_end, 0)),
      backlog: Math.max(0, toNumber(row?.backlog ?? row?.backorder, 0)),
      demand_dependent: Math.max(0, toNumber(row?.demand_dependent ?? row?.demand, 0)),
      inbound_plan: Math.max(0, toNumber(row?.inbound_plan, 0)),
      inbound_open_pos: Math.max(0, toNumber(row?.inbound_open_pos, 0))
    }))
    .filter((row) => row.component_sku && row.date)
    .sort((a, b) => {
      if (a.component_sku !== b.component_sku) return a.component_sku.localeCompare(b.component_sku);
      if ((a.plant_id || '') !== (b.plant_id || '')) return (a.plant_id || '').localeCompare(b.plant_id || '');
      return a.date.localeCompare(b.date);
    });
};

const normalizeBottlenecks = (payload = {}) => {
  const rows = Array.isArray(payload?.rows)
    ? payload.rows
    : Array.isArray(payload?.items)
      ? payload.items
      : [];

  const normalizedRows = rows
    .map((row) => ({
      component_sku: normalizeText(row?.component_sku || row?.sku),
      plant_id: normalizeText(row?.plant_id) || null,
      missing_qty: Math.max(0, toNumber(row?.missing_qty ?? row?.max_missing_qty, 0)),
      periods_impacted: Array.isArray(row?.periods_impacted)
        ? row.periods_impacted.map((day) => toIsoDay(parseDateValue(day))).filter(Boolean)
        : [],
      affected_fg_skus: Array.isArray(row?.affected_fg_skus)
        ? row.affected_fg_skus.map((sku) => normalizeText(sku)).filter(Boolean)
        : [],
      evidence_refs: Array.isArray(row?.evidence_refs) ? row.evidence_refs.map((ref) => String(ref)) : []
    }))
    .filter((row) => row.component_sku)
    .sort((a, b) => {
      if (b.missing_qty !== a.missing_qty) return b.missing_qty - a.missing_qty;
      if (a.component_sku !== b.component_sku) return a.component_sku.localeCompare(b.component_sku);
      return (a.plant_id || '').localeCompare(b.plant_id || '');
    });

  return {
    generated_at: payload?.generated_at || new Date().toISOString(),
    total_rows: normalizedRows.length,
    rows: normalizedRows
  };
};

const buildSkuConstraintMap = (rows = [], key) => {
  const map = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const sku = normalizeText(row?.sku);
    const value = toNumber(row?.[key], NaN);
    if (!sku || !Number.isFinite(value) || value < 0) return;
    map.set(sku, value);
  });
  return map;
};

const inferPeriodDays = (dates = []) => {
  const sorted = Array.from(new Set((Array.isArray(dates) ? dates : []).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  if (sorted.length <= 1) return 1;
  const deltas = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = parseDateValue(sorted[i - 1]);
    const curr = parseDateValue(sorted[i]);
    if (!prev || !curr) continue;
    const days = Math.round((curr.getTime() - prev.getTime()) / (24 * 60 * 60 * 1000));
    if (days > 0) deltas.push(days);
  }
  if (deltas.length === 0) return 1;
  deltas.sort((a, b) => a - b);
  return Math.max(1, deltas[Math.floor(deltas.length / 2)]);
};

const applyLotSizingForComponent = ({ sku, rawQty, constraints }) => {
  if (!Number.isFinite(rawQty) || rawQty <= 0) return 0;

  const moqMap = buildSkuConstraintMap(constraints?.moq, 'min_qty');
  const packMap = buildSkuConstraintMap(constraints?.pack_size, 'pack_qty');
  const maxMap = buildSkuConstraintMap(constraints?.max_order_qty, 'max_qty');

  let qty = Math.max(0, rawQty);
  const maxQty = maxMap.get(sku) || 0;
  const moq = moqMap.get(sku) || 0;
  const pack = packMap.get(sku) || 0;

  if (maxQty > 0 && qty > maxQty) {
    qty = maxQty;
  }
  if (moq > 0 && qty > 0 && qty < moq) {
    qty = moq;
  }
  if (pack > 1 && qty > 0) {
    qty = Math.ceil(qty / pack) * pack;
  }

  return Number(qty.toFixed(6));
};

const deriveComponentPlanFallback = ({
  fgPlanRows = [],
  usageRows = [],
  inventoryRows = [],
  openPoRows = [],
  constraints = {},
  demandSeries = []
}) => {
  const horizonDates = Array.from(new Set((Array.isArray(demandSeries) ? demandSeries : [])
    .map((row) => toIsoDay(parseDateValue(row?.date)))
    .filter(Boolean)))
    .sort((a, b) => a.localeCompare(b));

  if (horizonDates.length === 0 || !Array.isArray(usageRows) || usageRows.length === 0) {
    return {
      component_plan_rows: [],
      component_projection_rows: [],
      bottlenecks: { generated_at: new Date().toISOString(), total_rows: 0, rows: [] }
    };
  }

  const periodDays = inferPeriodDays(horizonDates);
  const usageByFg = new Map();
  const usageByComponent = new Map();

  usageRows.forEach((usage) => {
    const fgSku = normalizeText(usage.fg_sku);
    const componentSku = normalizeText(usage.component_sku);
    const fgPlant = normalizeText(usage.plant_id) || null;
    const usageQty = Math.max(0, toNumber(usage.usage_qty, 0));
    if (!fgSku || !componentSku || usageQty <= 0) return;

    const fgKey = `${fgSku}|${fgPlant || ''}`;
    if (!usageByFg.has(fgKey)) usageByFg.set(fgKey, []);
    usageByFg.get(fgKey).push({
      fg_sku: fgSku,
      component_sku: componentSku,
      plant_id: fgPlant,
      usage_qty: usageQty
    });

    const compKey = `${componentSku}|${fgPlant || ''}`;
    if (!usageByComponent.has(compKey)) {
      usageByComponent.set(compKey, {
        component_sku: componentSku,
        plant_id: fgPlant,
        affected_fg_skus: new Set()
      });
    }
    usageByComponent.get(compKey).affected_fg_skus.add(fgSku);
  });

  const dependentDemandByComponentDate = new Map();
  (Array.isArray(fgPlanRows) ? fgPlanRows : []).forEach((row) => {
    const fgSku = normalizeText(row?.sku);
    const fgPlant = normalizeText(row?.plant_id) || null;
    const arrivalDate = toIsoDay(parseDateValue(row?.arrival_date));
    const qty = Math.max(0, toNumber(row?.order_qty, 0));
    if (!fgSku || !arrivalDate || qty <= 0) return;

    const candidates = [
      ...(usageByFg.get(`${fgSku}|${fgPlant || ''}`) || []),
      ...(fgPlant ? [] : (usageByFg.get(`${fgSku}|`) || []))
    ];

    candidates.forEach((usage) => {
      const componentPlant = usage.plant_id || fgPlant;
      const compKey = `${usage.component_sku}|${componentPlant || ''}`;
      if (!dependentDemandByComponentDate.has(compKey)) {
        dependentDemandByComponentDate.set(compKey, new Map());
      }
      const dateMap = dependentDemandByComponentDate.get(compKey);
      const demandQty = qty * usage.usage_qty;
      dateMap.set(arrivalDate, Number((toNumber(dateMap.get(arrivalDate), 0) + demandQty).toFixed(6)));
    });
  });

  const inventoryByComponent = new Map();
  (Array.isArray(inventoryRows) ? inventoryRows : []).forEach((row) => {
    const sku = normalizeText(row?.sku);
    if (!sku) return;
    const plant = normalizeText(row?.plant_id) || null;
    const asOfDate = parseDateValue(row?.as_of_date);
    if (!asOfDate) return;
    const key = `${sku}|${plant || ''}`;
    const current = inventoryByComponent.get(key);
    if (!current || asOfDate > current.asOfDate) {
      inventoryByComponent.set(key, {
        asOfDate,
        on_hand: Math.max(0, toNumber(row?.on_hand, 0)),
        safety_stock: Math.max(0, toNumber(row?.safety_stock, 0)),
        lead_time_days: Math.max(0, Math.round(toNumber(row?.lead_time_days, 0)))
      });
    }
  });

  const openPoByComponentDate = new Map();
  (Array.isArray(openPoRows) ? openPoRows : []).forEach((row) => {
    const sku = normalizeText(row?.sku);
    const plant = normalizeText(row?.plant_id) || null;
    const date = toIsoDay(parseDateValue(row?.eta_date));
    const qty = Math.max(0, toNumber(row?.qty, 0));
    if (!sku || !date || qty <= 0) return;
    const key = `${sku}|${plant || ''}`;
    if (!openPoByComponentDate.has(key)) openPoByComponentDate.set(key, new Map());
    const dateMap = openPoByComponentDate.get(key);
    dateMap.set(date, Number((toNumber(dateMap.get(date), 0) + qty).toFixed(6)));
  });

  const componentPlanRows = [];
  const projectionRows = [];
  const bottleneckMap = new Map();

  const componentKeys = Array.from(new Set([
    ...Array.from(usageByComponent.keys()),
    ...Array.from(dependentDemandByComponentDate.keys()),
    ...Array.from(inventoryByComponent.keys())
  ])).sort((a, b) => a.localeCompare(b));

  componentKeys.forEach((componentKey) => {
    const [componentSku, plantRaw] = componentKey.split('|');
    const plantId = normalizeText(plantRaw) || null;
    const demandByDate = dependentDemandByComponentDate.get(componentKey) || new Map();
    const openByDate = openPoByComponentDate.get(componentKey) || new Map();
    const inv = inventoryByComponent.get(componentKey) || { on_hand: 0, safety_stock: 0, lead_time_days: 0 };
    const leadOffset = Math.max(0, Math.ceil(toNumber(inv.lead_time_days, 0) / periodDays));
    const plannedArrivals = new Map();

    let onHand = Math.max(0, toNumber(inv.on_hand, 0));
    const safetyStock = Math.max(0, toNumber(inv.safety_stock, 0));

    horizonDates.forEach((date, idx) => {
      const inboundOpenPos = Math.max(0, toNumber(openByDate.get(date), 0));
      const inboundPlan = Math.max(0, toNumber(plannedArrivals.get(date), 0));
      onHand += inboundOpenPos + inboundPlan;

      const dependentDemand = Math.max(0, toNumber(demandByDate.get(date), 0));
      const available = onHand;
      const fulfilled = Math.min(available, dependentDemand);
      const shortage = Math.max(0, dependentDemand - fulfilled);
      const onHandEnd = available - dependentDemand;

      if (shortage > 0) {
        const bottleneckKey = `${componentSku}|${plantId || ''}`;
        if (!bottleneckMap.has(bottleneckKey)) {
          bottleneckMap.set(bottleneckKey, {
            component_sku: componentSku,
            plant_id: plantId,
            missing_qty: 0,
            periods_impacted: new Set(),
            affected_fg_skus: new Set(),
            evidence_refs: new Set()
          });
        }
        const bucket = bottleneckMap.get(bottleneckKey);
        bucket.missing_qty += shortage;
        bucket.periods_impacted.add(date);
        const usageEntry = usageByComponent.get(componentKey);
        if (usageEntry) {
          usageEntry.affected_fg_skus.forEach((fgSku) => bucket.affected_fg_skus.add(fgSku));
        }
        bucket.evidence_refs.add(`component_balance:${componentSku}:${date}`);
      }

      const refillTarget = Math.max(0, safetyStock - onHandEnd);
      if (refillTarget > 0) {
        const arrivalIdx = idx + leadOffset;
        if (arrivalIdx < horizonDates.length) {
          const orderQty = applyLotSizingForComponent({
            sku: componentSku,
            rawQty: refillTarget,
            constraints
          });

          if (orderQty > 0) {
            const orderDate = horizonDates[idx];
            const arrivalDate = horizonDates[arrivalIdx];
            componentPlanRows.push({
              component_sku: componentSku,
              plant_id: plantId,
              order_date: orderDate,
              arrival_date: arrivalDate,
              order_qty: orderQty
            });
            plannedArrivals.set(arrivalDate, Number((toNumber(plannedArrivals.get(arrivalDate), 0) + orderQty).toFixed(6)));
          }
        }
      }

      projectionRows.push({
        component_sku: componentSku,
        plant_id: plantId,
        date,
        on_hand_end: Number(onHandEnd.toFixed(6)),
        backlog: Number(shortage.toFixed(6)),
        demand_dependent: Number(dependentDemand.toFixed(6)),
        inbound_plan: Number(inboundPlan.toFixed(6)),
        inbound_open_pos: Number(inboundOpenPos.toFixed(6))
      });

      onHand = onHandEnd;
    });
  });

  componentPlanRows.sort((a, b) => {
    if (a.component_sku !== b.component_sku) return a.component_sku.localeCompare(b.component_sku);
    if ((a.plant_id || '') !== (b.plant_id || '')) return (a.plant_id || '').localeCompare(b.plant_id || '');
    if (a.order_date !== b.order_date) return a.order_date.localeCompare(b.order_date);
    return a.arrival_date.localeCompare(b.arrival_date);
  });

  const bottlenecks = {
    generated_at: new Date().toISOString(),
    total_rows: bottleneckMap.size,
    rows: Array.from(bottleneckMap.values())
      .map((row) => ({
        component_sku: row.component_sku,
        plant_id: row.plant_id,
        missing_qty: Number(row.missing_qty.toFixed(6)),
        periods_impacted: Array.from(row.periods_impacted).sort((a, b) => a.localeCompare(b)),
        affected_fg_skus: Array.from(row.affected_fg_skus).sort((a, b) => a.localeCompare(b)),
        evidence_refs: Array.from(row.evidence_refs).sort((a, b) => a.localeCompare(b))
      }))
      .sort((a, b) => {
        if (b.missing_qty !== a.missing_qty) return b.missing_qty - a.missing_qty;
        if (a.component_sku !== b.component_sku) return a.component_sku.localeCompare(b.component_sku);
        return (a.plant_id || '').localeCompare(b.plant_id || '');
      })
  };

  return {
    component_plan_rows: componentPlanRows,
    component_projection_rows: projectionRows,
    bottlenecks
  };
};

const getArtifactMap = (artifacts = []) => {
  const map = new Map();
  artifacts.forEach((artifact) => {
    if (!artifact?.artifact_type) return;
    map.set(artifact.artifact_type, artifact.artifact_json || {});
  });
  return map;
};

const extractForecastArtifactFromCard = (forecastCardPayload = {}) => {
  if (!forecastCardPayload) return null;
  if (forecastCardPayload.forecast_series_json && Object.keys(forecastCardPayload.forecast_series_json).length > 0) {
    return forecastCardPayload.forecast_series_json;
  }
  if (Array.isArray(forecastCardPayload.series_groups)) {
    return {
      groups: forecastCardPayload.series_groups,
      total_groups: forecastCardPayload.total_groups || forecastCardPayload.series_groups.length,
      granularity: forecastCardPayload.metrics?.granularity || 'unknown'
    };
  }
  return null;
};

const findForecastRunContext = async ({ userId, datasetProfileId, forecastRunId = null, forecastCardPayload = null }) => {
  if (Number.isFinite(Number(forecastRunId))) {
    const run = await diRunsService.getRunById(userId, Number(forecastRunId));
    if (run && run.stage === 'forecast') {
      const artifacts = await diRunsService.getArtifactsForRun(run.id);
      return { run, artifacts };
    }
  }

  const latest = await diRunsService.getLatestRunByStage(userId, {
    stage: 'forecast',
    status: 'succeeded',
    dataset_profile_id: datasetProfileId,
    limit: 40
  });

  if (latest) {
    const artifacts = await diRunsService.getArtifactsForRun(latest.id);
    return { run: latest, artifacts };
  }

  // fallback: no persisted forecast run, but card payload can still be used
  const cardForecast = extractForecastArtifactFromCard(forecastCardPayload);
  if (cardForecast) {
    return {
      run: null,
      artifacts: [{ artifact_type: 'forecast_series', artifact_json: cardForecast }]
    };
  }

  return { run: null, artifacts: [] };
};

const makeWorkflowLabel = (datasetProfileRow) => {
  const workflowLabel = datasetProfileRow?.profile_json?.global?.workflow_guess?.label;
  return workflowLabel === 'A'
    ? 'workflow_A_replenishment'
    : `workflow_${workflowLabel || 'unknown'}`;
};

/**
 * Load risk_scores from a completed Workflow B run for this dataset profile.
 * Returns [] if no run is found or risk mode is not active.
 */
const loadRiskScoresForProfile = async (userId, datasetProfileId, riskRunId = null) => {
  try {
    let riskRun = null;
    if (Number.isFinite(Number(riskRunId))) {
      riskRun = await diRunsService.getRun(Number(riskRunId));
    }
    if (!riskRun) {
      riskRun = await diRunsService.getLatestRunByStage(userId, {
        stage: 'report',
        status: 'succeeded',
        dataset_profile_id: datasetProfileId,
        workflow: 'workflow_B_risk_exceptions',
        limit: 10
      }).catch(() => null);
    }
    if (!riskRun) return { rows: [], runId: null };

    const artifacts = await diRunsService.getArtifactsForRun(riskRun.id);
    const riskScoresRecord = (Array.isArray(artifacts) ? artifacts : [])
      .filter((a) => a.artifact_type === 'risk_scores')
      .sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0];

    if (!riskScoresRecord) return { rows: [], runId: riskRun.id };

    const { loadArtifact } = await import('../utils/artifactStore');
    const payload = await loadArtifact({ artifact_id: riskScoresRecord.id, ...(riskScoresRecord.artifact_json || {}) });
    const rows = Array.isArray(payload?.rows) ? payload.rows : (Array.isArray(payload) ? payload : []);
    return { rows, runId: riskRun.id };
  } catch (err) {
    logger.warn('planning-pipeline', `Failed to load risk scores: ${err.message}`);
    return { rows: [], runId: null };
  }
};

export async function runPlanFromDatasetProfile({
  userId,
  datasetProfileRow,
  forecastRunId = null,
  forecastCardPayload = null,
  planningHorizonDays = null,
  constraintsOverride = null,
  objectiveOverride = null,
  settings = {},
  // Risk-aware planning parameters (opt-in; default off for backward compatibility)
  riskMode = 'off',      // 'off' | 'on'
  riskRunId = null,      // optional: specific Workflow B run to source risk scores from
  riskConfigOverrides = {},  // optional overrides for RISK_ADJ_CONFIG thresholds
  // What-If scenario overrides (opt-in; null = regular plan run, no changes)
  scenarioOverrides = null,  // object | null
  scenarioEngineFlags = {},  // engine flags from di_scenarios.engine_flags
  // Import quality metadata (opt-in; passed from import pipeline)
  importQuality = null,      // { totalRejected, totalWarnings, totalQuarantined, bySheet }
  parentTraceId = null        // trace id from import pipeline for cross-pipeline tracing
}) {
  if (!userId) throw new Error('userId is required');
  if (!datasetProfileRow?.id) throw new Error('datasetProfileRow is required');

  const planSpan = createSpan('planning', 'full-pipeline', parentTraceId);
  recordPlanningAttempt();
  logger.info('planning-pipeline', 'Planning started', {
    _traceId: planSpan.traceId, datasetProfileId: datasetProfileRow.id, riskMode,
  });

  const workflow = makeWorkflowLabel(datasetProfileRow);

  const run = await diRunsService.createRun({
    user_id: userId,
    dataset_profile_id: datasetProfileRow.id,
    workflow,
    stage: 'optimize'
  });

  await diRunsService.updateRunStatus({
    run_id: run.id,
    status: 'running',
    started_at: new Date().toISOString()
  });

  let readinessPromptArtifact = null;

  try {
    const forecastContext = await findForecastRunContext({
      userId,
      datasetProfileId: datasetProfileRow.id,
      forecastRunId,
      forecastCardPayload
    });

    const forecastArtifacts = getArtifactMap(forecastContext.artifacts || []);
    const forecastArtifact = forecastArtifacts.get('forecast_series')
      || forecastArtifacts.get('forecast_series_json')
      || extractForecastArtifactFromCard(forecastCardPayload);
    const forecastMetricsArtifact = forecastArtifacts.get('metrics')
      || forecastArtifacts.get('metrics_json')
      || forecastCardPayload?.metrics_json
      || forecastCardPayload?.metrics
      || {};

    if (!forecastArtifact) {
      throw createBlockingError('No forecast artifacts found. Run forecast before planning.', [
        'Run `/forecast` first to generate forecast_series.',
        'Then click "Run Plan" from the Forecast card.'
      ]);
    }

    // Validate forecast artifact has actual content — not just an empty shell.
    // Prevents the plan solver from proceeding with invalid/empty forecast data.
    const forecastSeries = forecastArtifact?.series || forecastArtifact?.data?.series;
    if (Array.isArray(forecastSeries) && forecastSeries.length === 0) {
      throw createBlockingError('Forecast artifact exists but contains no forecast series data.', [
        'The forecast may have run with insufficient data.',
        'Re-upload demand data with at least 8 clean rows and rerun forecast.',
      ]);
    }

    let rawRows = [];
    if (datasetProfileRow.user_file_id) {
      const fileRecord = await userFilesService.getFileById(userId, datasetProfileRow.user_file_id);
      rawRows = normalizeRowsFromUserFile(fileRecord);
    } else if (Array.isArray(datasetProfileRow._inlineRawRows) && datasetProfileRow._inlineRawRows.length > 0) {
      rawRows = datasetProfileRow._inlineRawRows;
    }
    if (rawRows.length === 0) {
      throw createBlockingError('Dataset profile has no linked source file or inline rows.', [
        'Re-upload the dataset from chat and rerun forecast + plan.'
      ]);
    }

    const contractJson = datasetProfileRow.contract_json || {};
    const inventoryDataset = chooseDatasetByType(contractJson, 'inventory_snapshots');

    if (!inventoryDataset) {
      throw createBlockingError('No inventory_snapshots dataset found in schema contract.', [
        'Upload/map an inventory_snapshots sheet.',
        'Then rerun profile and plan.'
      ]);
    }

    const inventoryMapping = normalizeTargetMapping(inventoryDataset.mapping || {});
    const missingInventoryMap = ['material_code', 'plant_id', 'onhand_qty']
      .filter((field) => !inventoryMapping[field]);

    const hasInventoryTime = Boolean(getMappedTimeField(inventoryMapping, ['snapshot_date', 'date', 'time_bucket', 'week_bucket']));
    if (missingInventoryMap.length > 0 || !hasInventoryTime) {
      throw createBlockingError('Inventory mapping is incomplete for planning.', [
        `Map required fields: ${[...missingInventoryMap, !hasInventoryTime ? 'snapshot_date/date/time_bucket' : null].filter(Boolean).join(', ')}.`,
        'Then rerun plan.'
      ]);
    }

    const inventoryResult = mapInventoryRows({
      rows: rawRows,
      sheetName: inventoryDataset.sheet_name,
      mapping: inventoryMapping
    });

    if (inventoryResult.rows.length === 0) {
      throw createBlockingError('No clean inventory rows available after mapping validation.', [
        'Check inventory sheet mappings and date/quantity formats.'
      ]);
    }

    const fallbackAudit = createFallbackAudit();
    logger.info('planning-pipeline', 'Fallback audit initialized', { _traceId: planSpan.traceId });

    const openPoDataset = chooseDatasetByType(contractJson, 'po_open_lines');
    const openPoResult = openPoDataset
      ? mapOpenPoRows({
          rows: rawRows,
          sheetName: openPoDataset.sheet_name,
          mapping: normalizeTargetMapping(openPoDataset.mapping || {})
        })
      : { rows: [], dropped: 0 };

    if (!openPoDataset) {
      fallbackAudit.addDatasetFallback('open_pos');
    }

    const financialsDataset = chooseDatasetByType(contractJson, 'fg_financials');
    if (!financialsDataset) {
      fallbackAudit.addDatasetFallback('financials');
    }

    const missingLeadRows = inventoryResult.rows.filter((row) => row.lead_time_days === null || row.lead_time_days === undefined);
    const missingSafetyRows = inventoryResult.rows.filter((row) => row.safety_stock === null || row.safety_stock === undefined);

    if ((missingLeadRows.length > 0 || missingSafetyRows.length > 0) && !ALLOW_PLAN_DEFAULTS) {
      const questions = [];
      if (missingLeadRows.length > 0) {
        questions.push('Please provide/map lead_time_days for inventory rows.');
      }
      if (missingSafetyRows.length > 0) {
        questions.push('Please provide/map safety_stock for inventory rows.');
      }
      throw createBlockingError('Critical planning fields are missing (lead_time_days or safety_stock).', questions);
    }

    // Build per-row lineage map during fallback application
    const rowLineageMap = new Map(); // key: `sku|plant_id` -> { fallback_fields, datasets_used, confidence }

    const inventoryRowsForPlanning = inventoryResult.rows.map((row, i) => {
      const rowKey = `${normalizeText(row.sku || row.material_code)}|${normalizeText(row.plant_id) || ''}`;
      const lt = fallbackAudit.apply('lead_time_days', row.lead_time_days, { _rowKey: rowKey }, i);
      const ss = fallbackAudit.apply('safety_stock', row.safety_stock, { _rowKey: rowKey }, i);

      const fallback_fields = [];
      if (lt.isFallback) fallback_fields.push({ field: 'lead_time_days', source: lt.source, value: lt.value });
      if (ss.isFallback) fallback_fields.push({ field: 'safety_stock', source: ss.source, value: ss.value });

      rowLineageMap.set(rowKey, {
        fallback_fields,
        datasets_used: ['demand_fg', 'inventory_snapshots'],
        confidence: fallback_fields.length === 0 ? 1.0 : Math.max(0.3, 1.0 - fallback_fields.length * 0.15),
      });

      return {
        ...row,
        lead_time_days: lt.value,
        safety_stock: ss.value,
      };
    });

    const demandForecastSeries = toForecastDemandSeries(forecastArtifact);
    if (demandForecastSeries.length === 0) {
      throw createBlockingError('No forecast horizon points found in forecast artifact.', [
        'Run forecast again and ensure forecast points exist.'
      ]);
    }

    const horizonDays = Number.isFinite(toNumber(planningHorizonDays, NaN))
      ? Math.max(1, Math.floor(Number(planningHorizonDays)))
      : derivePlanningHorizonDays(demandForecastSeries, 30);

    const constraints = buildConstraintsFromInventory({
      inventoryRows: inventoryRowsForPlanning,
      constraintsOverride: constraintsOverride || {}
    });

    const objective = buildObjective(objectiveOverride || {});

    const requestedMultiEchelonConfig = resolveMultiEchelonConfig({
      planSettings: {
        ...(settings || {}),
        ...((settings || {}).plan || {})
      },
      env: import.meta.env
    });

    const bomDataset = chooseDatasetByType(contractJson, 'bom_edge');
    const bomMapping = normalizeTargetMapping(bomDataset?.mapping || {});
    const bomRequiredMappingMissing = ['parent_material', 'child_material', 'qty_per']
      .filter((field) => !bomMapping[field]);

    if (!bomDataset || bomRequiredMappingMissing.length > 0) {
      fallbackAudit.addDatasetFallback('bom_edge');
    }

    const bomEdgeResult = (bomDataset && bomRequiredMappingMissing.length === 0)
      ? mapBomEdgeRows({
          rows: rawRows,
          sheetName: bomDataset.sheet_name,
          mapping: bomMapping,
          mappingRules: requestedMultiEchelonConfig.mapping_rules
        })
      : { rows: [], dropped: 0 };

    const requestedBomMode = requestedMultiEchelonConfig.mode === MULTI_ECHELON_MODES.BOM_V0;
    let bomExplosionResult = {
      used: false,
      reused: false,
      cache_key: null,
      config: requestedMultiEchelonConfig,
      requirements: [],
      usage_rows: [],
      artifact: null,
      errors: []
    };

    if (requestedBomMode && bomEdgeResult.rows.length > 0) {
      bomExplosionResult = explodeBomForRun({
        datasetFingerprint: datasetProfileRow?.fingerprint || null,
        demandSeries: demandForecastSeries,
        bomEdges: bomEdgeResult.rows,
        config: requestedMultiEchelonConfig
      });
    }

    const multiEchelonMode = bomExplosionResult.used
      ? MULTI_ECHELON_MODES.BOM_V0
      : MULTI_ECHELON_MODES.OFF;

    const multiEchelonDiagnostics = {
      requested_mode: requestedMultiEchelonConfig.mode,
      mode: multiEchelonMode,
      max_bom_depth: requestedMultiEchelonConfig.max_bom_depth,
      fg_to_components_scope: requestedMultiEchelonConfig.fg_to_components_scope,
      lot_sizing_mode: requestedMultiEchelonConfig.lot_sizing_mode,
      mapping_rules: requestedMultiEchelonConfig.mapping_rules,
      bom_edges_rows: bomEdgeResult.rows.length,
      bom_edges_dropped: bomEdgeResult.dropped || 0,
      bom_explosion_used: Boolean(bomExplosionResult.used),
      bom_explosion_reused: Boolean(bomExplosionResult.reused),
      bom_explosion_cache_key: bomExplosionResult.cache_key || null,
      bom_required_mapping_missing: bomRequiredMappingMissing,
      warnings: [
        ...(requestedBomMode && !bomDataset ? ['BOM mode requested but no bom_edge dataset is mapped.'] : []),
        ...(requestedBomMode && bomRequiredMappingMissing.length > 0
          ? [`BOM mode requested but mapping is missing: ${bomRequiredMappingMissing.join(', ')}`]
          : []),
        ...(requestedBomMode && bomDataset && bomEdgeResult.rows.length === 0
          ? ['BOM mode requested but no valid bom_edge rows were parsed.']
          : []),
        ...(requestedBomMode && !bomExplosionResult.used && bomEdgeResult.rows.length > 0
          ? ['BOM explosion produced no scoped requirements; solver ran in single-echelon mode.']
          : [])
      ]
    };

    if (requestedBomMode && !bomExplosionResult.artifact) {
      bomExplosionResult.artifact = {
        version: 'v0',
        generated_at: new Date().toISOString(),
        max_depth: requestedMultiEchelonConfig.max_bom_depth,
        totals: {
          num_fg: 0,
          num_components: 0,
          num_edges: bomEdgeResult.rows.length,
          num_rows: 0
        },
        total_rows: 0,
        truncated: false,
        requirements: [],
        trace_index: {
          components: [],
          total_components: 0
        },
        warnings: multiEchelonDiagnostics.warnings
      };
    }

    try {
      const readinessPromptInput = buildReadinessPromptInput({
        datasetProfileRow,
        contractJson,
        objective,
        constraints
      });
      const readinessPromptResult = await runDiPrompt({
        promptId: DI_PROMPT_IDS.WORKFLOW_A_READINESS,
        input: readinessPromptInput,
        temperature: 0.1,
        maxOutputTokens: 2400
      });

      const normalizedReadiness = normalizeReadinessPayload(readinessPromptResult.parsed);
      if (normalizedReadiness) {
        readinessPromptArtifact = {
          provider: readinessPromptResult.provider,
          model: readinessPromptResult.model,
          generated_at: new Date().toISOString(),
          input: readinessPromptInput,
          output: normalizedReadiness
        };
      }
    } catch (error) {
      logger.warn('planning-pipeline', `Prompt 3 readiness fallback: ${error.message}`, { _traceId: planSpan.traceId });
    }

    const optimizationPayload = {
      dataset_profile_id: datasetProfileRow.id,
      planning_horizon_days: horizonDays,
      demand_forecast: {
        series: demandForecastSeries,
        granularity: forecastArtifact?.granularity || forecastMetricsArtifact?.granularity || 'unknown'
      },
      inventory: inventoryRowsForPlanning.map((row) => ({
        sku: row.sku,
        plant_id: row.plant_id,
        as_of_date: row.as_of_date,
        on_hand: row.on_hand,
        safety_stock: row.safety_stock,
        lead_time_days: row.lead_time_days
      })),
      open_pos: openPoResult.rows,
      constraints,
      objective,
      multi_echelon: {
        mode: multiEchelonMode,
        max_bom_depth: requestedMultiEchelonConfig.max_bom_depth,
        fg_to_components_scope: requestedMultiEchelonConfig.fg_to_components_scope,
        lot_sizing_mode: requestedMultiEchelonConfig.lot_sizing_mode,
        mapping_rules: requestedMultiEchelonConfig.mapping_rules,
        bom_explosion_used: Boolean(bomExplosionResult.used),
        bom_explosion_reused: Boolean(bomExplosionResult.reused)
      },
      settings: settings || {},
      bom_usage: Array.isArray(bomExplosionResult.usage_rows) ? bomExplosionResult.usage_rows : [],
      bom_explosion: bomExplosionResult.artifact || null
    };

    // ── What-If Scenario Overrides ──────────────────────────────────────────
    // Applied deterministically after full payload assembly. null = no-op.
    let scenarioEffectiveParams = null;
    if (scenarioOverrides && typeof scenarioOverrides === 'object') {
      const overrideResult = applyScenarioOverridesToPayload(
        optimizationPayload,
        scenarioOverrides,
        scenarioEngineFlags || {}
      );
      scenarioEffectiveParams = overrideResult.effectiveParams || null;
    }
    // ────────────────────────────────────────────────────────────────────────

    // Diagnostic: log solver input summary (expanded — console.warn avoids structured logger truncation)
    const demandSkus = new Set(demandForecastSeries.map((p) => p.sku));
    const invSkus = new Set(inventoryRowsForPlanning.map((r) => r.sku));
    const matchedSkus = [...demandSkus].filter((s) => invSkus.has(s));
    const totalP50 = demandForecastSeries.reduce((sum, p) => sum + (p.p50 || 0), 0);
    const forecastOnlyPoints = demandForecastSeries.filter((p) => p.p50 > 0);
    console.warn('[planning-pipeline] Solver input diagnostic:', JSON.stringify({
      demandPoints: demandForecastSeries.length,
      nonZeroDemandPoints: forecastOnlyPoints.length,
      totalP50,
      demandSkus: [...demandSkus],
      inventorySkus: [...invSkus],
      matchedSkus,
      horizonDays,
      sampleDemand: demandForecastSeries.slice(0, 5).map((p) => ({ sku: p.sku, date: p.date, p50: p.p50, p90: p.p90 })),
      sampleInventory: inventoryRowsForPlanning.slice(0, 5).map((r) => ({
        sku: r.sku, plant_id: r.plant_id, on_hand: r.on_hand,
        safety_stock: r.safety_stock, lead_time_days: r.lead_time_days
      })),
    }));
    logger.info('planning-pipeline', 'Solver input summary', {
      _traceId: planSpan.traceId,
      demandPoints: demandForecastSeries.length,
      nonZeroDemandPoints: forecastOnlyPoints.length,
      totalP50,
      demandSkus: demandSkus.size,
      inventoryRows: inventoryRowsForPlanning.length,
      inventorySkus: invSkus.size,
      matchedSkus: matchedSkus.length,
      horizonDays,
    });

    const solverSpan = createSpan('planning', 'solver', planSpan.traceId);
    const solverResult = await optimizationApiClient.createReplenishmentPlan(optimizationPayload, {
      timeoutMs: 25000,
      allowFallback: true
    });
    solverSpan.addMetric('status', solverResult?.status || 'unknown');
    solverSpan.addMetric('planRows', solverResult?.plan?.length || 0);
    solverSpan.end();
    logger.info('planning-pipeline', `Solver completed: ${solverResult?.status || 'unknown'}`, {
      _traceId: planSpan.traceId, planRows: solverResult?.plan?.length || 0, durationMs: solverSpan.durationMs,
      infeasibleReasons: solverResult?.infeasible_reasons?.slice(0, 5) || [],
      solverEngine: solverResult?.solver_meta?.solver || 'unknown',
    });

    const normalizedPlan = Array.isArray(solverResult?.plan)
      ? solverResult.plan
          .map((row) => {
            const base = {
              sku: normalizeText(row?.sku),
              plant_id: normalizeText(row?.plant_id) || null,
              order_date: toIsoDay(parseDateValue(row?.order_date)),
              arrival_date: toIsoDay(parseDateValue(row?.arrival_date)),
              order_qty: Math.max(0, toNumber(row?.order_qty, 0))
            };
            // Attach per-row lineage metadata
            const lineageKey = `${base.sku}|${base.plant_id || ''}`;
            const lineage = rowLineageMap.get(lineageKey);
            if (lineage) {
              base._meta = lineage;
            }
            return base;
          })
          .filter((row) => row.sku && row.order_date && row.arrival_date && Number.isFinite(row.order_qty))
          .sort((a, b) => {
            if (a.sku !== b.sku) return a.sku.localeCompare(b.sku);
            if ((a.plant_id || '') !== (b.plant_id || '')) return (a.plant_id || '').localeCompare(b.plant_id || '');
            if (a.order_date !== b.order_date) return a.order_date.localeCompare(b.order_date);
            return a.arrival_date.localeCompare(b.arrival_date);
          })
      : [];

    const directComponentPlan = normalizeComponentPlanRows(solverResult?.component_plan || []);
    const fallbackComponentContext = (
      multiEchelonMode === MULTI_ECHELON_MODES.BOM_V0
      && directComponentPlan.length === 0
      && Array.isArray(bomExplosionResult?.usage_rows)
      && bomExplosionResult.usage_rows.length > 0
    )
      ? deriveComponentPlanFallback({
          fgPlanRows: normalizedPlan,
          usageRows: bomExplosionResult.usage_rows,
          inventoryRows: optimizationPayload.inventory,
          openPoRows: optimizationPayload.open_pos,
          constraints,
          demandSeries: demandForecastSeries
        })
      : null;

    const normalizedComponentPlan = directComponentPlan.length > 0
      ? directComponentPlan
      : normalizeComponentPlanRows(fallbackComponentContext?.component_plan_rows || []);
    const componentPlanArtifact = {
      total_rows: normalizedComponentPlan.length,
      rows: normalizedComponentPlan.slice(0, MAX_COMPONENT_PLAN_ROWS_IN_ARTIFACT),
      truncated: normalizedComponentPlan.length > MAX_COMPONENT_PLAN_ROWS_IN_ARTIFACT
    };

    const normalizedComponentProjectionRows = normalizeComponentProjectionRows(
      Array.isArray(solverResult?.component_inventory_projection?.rows)
        ? solverResult.component_inventory_projection.rows
        : (solverResult?.component_inventory_projection
          || fallbackComponentContext?.component_projection_rows
          || [])
    );
    const componentProjectionArtifact = {
      total_rows: normalizedComponentProjectionRows.length,
      rows: normalizedComponentProjectionRows.slice(0, MAX_COMPONENT_PROJECTION_ROWS_IN_ARTIFACT),
      truncated: normalizedComponentProjectionRows.length > MAX_COMPONENT_PROJECTION_ROWS_IN_ARTIFACT
    };

    const normalizedBottlenecks = normalizeBottlenecks(
      solverResult?.bottlenecks || fallbackComponentContext?.bottlenecks || {}
    );

    const baseProof = solverResult?.proof || {};
    const proofObjectiveTerms = Array.isArray(baseProof?.objective_terms) ? baseProof.objective_terms : [];
    const proofConstraints = Array.isArray(baseProof?.constraints_checked) ? baseProof.constraints_checked : [];
    const mergedProof = {
      ...baseProof,
      objective_terms: proofObjectiveTerms,
      constraints_checked: [
        ...proofConstraints,
        {
          name: 'multi_echelon_mode',
          passed: true,
          details: `mode=${multiEchelonDiagnostics.mode}, requested=${multiEchelonDiagnostics.requested_mode}`
        },
        {
          name: 'bom_explosion',
          passed: multiEchelonDiagnostics.mode !== MULTI_ECHELON_MODES.BOM_V0 || multiEchelonDiagnostics.bom_explosion_used,
          details: multiEchelonDiagnostics.mode === MULTI_ECHELON_MODES.BOM_V0
            ? `rows=${bomExplosionResult?.artifact?.total_rows || 0}, reused=${multiEchelonDiagnostics.bom_explosion_reused}`
            : (multiEchelonDiagnostics.warnings[0] || 'BOM mode disabled or not available.')
        }
      ]
    };

    const constraintResult = constraintChecker({
      plan: normalizedPlan,
      constraints
    });

    // Collect fallback audit and build data quality metadata
    const audit = fallbackAudit.getAudit();
    const availableDatasets = ['demand_fg', 'inventory_snapshots'];
    const missingDatasets = [];
    if (openPoDataset) availableDatasets.push('po_open_lines');
    else missingDatasets.push('po_open_lines');
    if (financialsDataset) availableDatasets.push('fg_financials');
    else missingDatasets.push('fg_financials');
    if (bomDataset && bomRequiredMappingMissing.length === 0) availableDatasets.push('bom_edge');
    else missingDatasets.push('bom_edge');

    // Enrich row lineage map with optional dataset presence
    if (openPoDataset) {
      for (const [, lineage] of rowLineageMap) {
        lineage.datasets_used.push('po_open_lines');
      }
    }
    if (financialsDataset) {
      for (const [, lineage] of rowLineageMap) {
        lineage.datasets_used.push('fg_financials');
      }
    }
    if (bomDataset && bomRequiredMappingMissing.length === 0) {
      for (const [, lineage] of rowLineageMap) {
        lineage.datasets_used.push('bom_edge');
      }
    }

    // Evaluate capabilities based on available datasets
    const capDatasets = availableDatasets.map(t => ({ type: t, fields: [] }));
    const capabilities = evaluateCapabilities(capDatasets);

    const dataQuality = buildDataQualityReport({
      availableDatasets,
      missingDatasets,
      fallbackAudit: audit,
      capabilities,
      rowStats: {
        total: inventoryResult.rows.length,
        clean: inventoryResult.rows.length - (audit.summary.rowsWithFallbackCount || 0),
        with_fallback: audit.summary.rowsWithFallbackCount || 0,
        dropped: inventoryResult.dropped || 0,
      },
      importQuality: importQuality || undefined,
      quarantinedCount: importQuality?.totalRejected || 0,
    });

    // Record operational metrics for fallbacks and degraded capabilities
    recordFallbackUsed(audit.summary.totalFieldFallbacks + audit.summary.totalDatasetFallbacks);
    recordDegradedCapability(audit.summary.degradedCapabilities.length);

    logger.info('planning-pipeline', `Data quality: ${dataQuality.coverage_level}`, {
      _traceId: planSpan.traceId,
      coverageLevel: dataQuality.coverage_level,
      availableDatasets: dataQuality.available_datasets,
      missingDatasets: dataQuality.missing_datasets,
      fallbacksUsed: dataQuality.fallbacks_used,
    });

    const solverMetaArtifact = {
      _traceId: planSpan.traceId,
      status: solverResult?.status || 'unknown',
      kpis: solverResult?.kpis || {},
      solver_meta: {
        ...(solverResult?.solver_meta || {}),
        multi_echelon_mode: multiEchelonDiagnostics.mode,
        max_bom_depth: multiEchelonDiagnostics.max_bom_depth,
        bom_explosion_used: multiEchelonDiagnostics.bom_explosion_used,
        bom_explosion_reused: multiEchelonDiagnostics.bom_explosion_reused,
        bom_explosion_cache_key: multiEchelonDiagnostics.bom_explosion_cache_key,
        bom_edges_rows: multiEchelonDiagnostics.bom_edges_rows,
        bom_edges_dropped: multiEchelonDiagnostics.bom_edges_dropped,
        bom_required_mapping_missing: multiEchelonDiagnostics.bom_required_mapping_missing,
        warnings: multiEchelonDiagnostics.warnings,
        component_plan_fallback_used: Boolean(fallbackComponentContext && directComponentPlan.length === 0)
      },
      data_quality: dataQuality,
      proof: mergedProof,
      infeasible_reasons: Array.isArray(solverResult?.infeasible_reasons)
        ? solverResult.infeasible_reasons
        : [],
      // Scenario override audit trail (null for regular plan runs)
      scenario_overrides: scenarioOverrides || null,
      scenario_effective_params: scenarioEffectiveParams || null
    };

    const solverMetaSaved = await saveJsonArtifact(run.id, 'solver_meta', solverMetaArtifact, ARTIFACT_SIZE_THRESHOLD, {
      user_id: userId,
      filename: `solver_meta_run_${run.id}.json`
    });

    // Persist unified data quality report as a standalone artifact
    await saveJsonArtifact(run.id, 'data_quality_report', dataQuality, ARTIFACT_SIZE_THRESHOLD, {
      user_id: userId,
      filename: `data_quality_report_run_${run.id}.json`
    });

    const constraintSaved = await saveJsonArtifact(run.id, 'constraint_check', constraintResult, ARTIFACT_SIZE_THRESHOLD, {
      user_id: userId,
      filename: `constraint_check_run_${run.id}.json`
    });

    if (!constraintResult.passed) {
      // Save plan_table even on constraint failure so the user can inspect the plan
      await saveJsonArtifact(run.id, 'plan_table', {
        total_rows: normalizedPlan.length,
        rows: normalizedPlan.slice(0, MAX_PLAN_ROWS_IN_ARTIFACT),
        truncated: normalizedPlan.length > MAX_PLAN_ROWS_IN_ARTIFACT
      }, ARTIFACT_SIZE_THRESHOLD, {
        user_id: userId,
        filename: `plan_table_run_${run.id}.json`
      });

      // Also save replay_metrics and inventory_projection on constraint failure
      // so the Excel export can still produce KPI and projection data for diagnosis.
      try {
        const failReplayWithPlan = replaySimulator({
          forecast_series: demandForecastSeries,
          inventory: optimizationPayload.inventory,
          open_pos: optimizationPayload.open_pos,
          plan: normalizedPlan,
          use_p90: false
        });
        const failReplayWithout = replaySimulator({
          forecast_series: demandForecastSeries,
          inventory: optimizationPayload.inventory,
          open_pos: optimizationPayload.open_pos,
          plan: [],
          use_p90: false
        });
        const failReplayMetrics = {
          with_plan: failReplayWithPlan.metrics,
          without_plan: failReplayWithout.metrics,
          delta: {
            service_level_proxy: (
              Number.isFinite(failReplayWithPlan.metrics?.service_level_proxy)
              && Number.isFinite(failReplayWithout.metrics?.service_level_proxy)
            )
              ? Number((failReplayWithPlan.metrics.service_level_proxy - failReplayWithout.metrics.service_level_proxy).toFixed(6))
              : null,
            stockout_units: (
              Number.isFinite(failReplayWithPlan.metrics?.stockout_units)
              && Number.isFinite(failReplayWithout.metrics?.stockout_units)
            )
              ? Number((failReplayWithPlan.metrics.stockout_units - failReplayWithout.metrics.stockout_units).toFixed(6))
              : null
          },
          constraint_failure: true
        };
        await saveJsonArtifact(run.id, 'replay_metrics', failReplayMetrics, ARTIFACT_SIZE_THRESHOLD, {
          user_id: userId,
          filename: `replay_metrics_run_${run.id}.json`
        });

        const failProjection = mergeProjectionForChart(
          failReplayWithPlan.inventory_projection,
          failReplayWithout.inventory_projection
        );
        await saveJsonArtifact(run.id, 'inventory_projection', {
          total_rows: failProjection.length,
          rows: failProjection.slice(0, MAX_PROJECTION_ROWS_IN_ARTIFACT),
          truncated: failProjection.length > MAX_PROJECTION_ROWS_IN_ARTIFACT
        }, ARTIFACT_SIZE_THRESHOLD, {
          user_id: userId,
          filename: `inventory_projection_run_${run.id}.json`
        });
      } catch (replayErr) {
        logger.warn('planning-pipeline', `Failed to save replay metrics on constraint failure: ${replayErr.message}`, { _traceId: planSpan.traceId });
      }

      const failMessage = `Constraint check failed (${constraintResult.violations.length} violations).`;
      await diRunsService.updateRunStatus({
        run_id: run.id,
        status: 'failed',
        finished_at: new Date().toISOString(),
        error: failMessage
      });

      const err = new Error(failMessage);
      err.run_id = run.id;
      err.constraint_check = constraintResult;
      err.plan = normalizedPlan;
      throw err;
    }

    const replayWithPlan = replaySimulator({
      forecast_series: demandForecastSeries,
      inventory: optimizationPayload.inventory,
      open_pos: optimizationPayload.open_pos,
      plan: normalizedPlan,
      use_p90: false
    });

    const replayWithoutPlan = replaySimulator({
      forecast_series: demandForecastSeries,
      inventory: optimizationPayload.inventory,
      open_pos: optimizationPayload.open_pos,
      plan: [],
      use_p90: false
    });

    const mergedProjection = mergeProjectionForChart(
      replayWithPlan.inventory_projection,
      replayWithoutPlan.inventory_projection
    );

    const replayMetrics = {
      with_plan: replayWithPlan.metrics,
      without_plan: replayWithoutPlan.metrics,
      delta: {
        service_level_proxy: (
          Number.isFinite(replayWithPlan.metrics?.service_level_proxy)
          && Number.isFinite(replayWithoutPlan.metrics?.service_level_proxy)
        )
          ? Number((replayWithPlan.metrics.service_level_proxy - replayWithoutPlan.metrics.service_level_proxy).toFixed(6))
          : null,
        stockout_units: (
          Number.isFinite(replayWithPlan.metrics?.stockout_units)
          && Number.isFinite(replayWithoutPlan.metrics?.stockout_units)
        )
          ? Number((replayWithPlan.metrics.stockout_units - replayWithoutPlan.metrics.stockout_units).toFixed(6))
          : null
      },
      stockout_events_with_plan: replayWithPlan.stockout_events.slice(0, 200),
      stockout_events_without_plan: replayWithoutPlan.stockout_events.slice(0, 200)
    };

    // ── Risk-aware planning (opt-in) ─────────────────────────────────────────
    // Enabled when riskMode='on' OR env flag VITE_DI_RISK_AWARE=true.
    // The base plan above is always produced unchanged (backward compatibility).
    // A second risk-adjusted plan is produced alongside it, plus a comparison artifact.
    const isRiskAwareMode = riskMode === 'on' || ENV_RISK_AWARE;
    let riskAwareResult = null;  // null when risk mode is off

    if (isRiskAwareMode) {
      try {
        // 1. Load risk scores from Workflow B
        const { rows: riskScoreRows, runId: sourceRiskRunId } = await loadRiskScoresForProfile(
          userId, datasetProfileRow.id, riskRunId
        );

        if (riskScoreRows.length === 0) {
          logger.info('planning-pipeline', 'Risk-aware mode enabled but no risk scores found — skipping risk-adjusted plan', { _traceId: planSpan.traceId });
        }

        if (riskScoreRows.length > 0) {
        // 2. Compute deterministic risk adjustments
        const riskAdjustments = computeRiskAdjustments({
          riskScores: riskScoreRows,
          baseParams: { objective, constraints },
          configOverrides: riskConfigOverrides
        });

        // 3. Apply adjustments to inputs
        const adjustedInventory = applyRiskAdjustmentsToInventory(
          optimizationPayload.inventory,
          riskAdjustments.adjusted_params
        );
        const adjustedObjective = applyRiskAdjustmentsToObjective(
          objective,
          riskAdjustments.adjusted_params
        );
        const adjustedObjectiveWithSS = applyRiskAdjustmentsToSafetyStockPenalty(
          adjustedObjective,
          riskAdjustments.adjusted_params
        );
        const adjustedDemandSeries = applyDemandUplift(
          demandForecastSeries,
          riskAdjustments.adjusted_params.demand_uplift_alpha
        );

        // 4. Run solver with risk-adjusted inputs + risk_signals for MILP
        const riskOptimizationPayload = {
          ...optimizationPayload,
          inventory: adjustedInventory,
          objective: adjustedObjectiveWithSS,
          risk_signals: {
            ss_penalty_by_key: riskAdjustments.adjusted_params.safety_stock_penalty_multiplier || {},
            dual_source_keys: riskAdjustments.adjusted_params.dual_source_keys || [],
            dual_source_min_split_fraction: riskAdjustments.adjusted_params.dual_source_min_split_fraction || 0.2,
            expedite_keys: riskAdjustments.adjusted_params.expedite_keys || [],
            expedite_lead_time_reduction_days: riskAdjustments.adjusted_params.expedite_lead_time_reduction_days || 0,
            expedite_cost_multiplier: riskAdjustments.adjusted_params.expedite_cost_multiplier || 1.0,
          },
          demand_forecast: {
            ...optimizationPayload.demand_forecast,
            series: adjustedDemandSeries
          }
        };

        const riskSolverResult = await optimizationApiClient.createReplenishmentPlan(riskOptimizationPayload, {
          timeoutMs: 25000,
          allowFallback: true
        });

        // 5. Normalize risk-aware plan rows (same sort/filter as base plan)
        const riskNormalizedPlan = Array.isArray(riskSolverResult?.plan)
          ? riskSolverResult.plan
              .map((row) => ({
                sku: normalizeText(row?.sku),
                plant_id: normalizeText(row?.plant_id) || null,
                order_date: toIsoDay(parseDateValue(row?.order_date)),
                arrival_date: toIsoDay(parseDateValue(row?.arrival_date)),
                order_qty: Math.max(0, toNumber(row?.order_qty, 0))
              }))
              .filter((row) => row.sku && row.order_date && row.arrival_date && Number.isFinite(row.order_qty))
              .sort((a, b) => {
                if (a.sku !== b.sku) return a.sku.localeCompare(b.sku);
                if ((a.plant_id || '') !== (b.plant_id || '')) return (a.plant_id || '').localeCompare(b.plant_id || '');
                if (a.order_date !== b.order_date) return a.order_date.localeCompare(b.order_date);
                return a.arrival_date.localeCompare(b.arrival_date);
              })
          : [];

        // 6. Run replay with risk-aware plan
        const riskReplayWithPlan = replaySimulator({
          forecast_series: adjustedDemandSeries,
          inventory: adjustedInventory,
          open_pos: optimizationPayload.open_pos,
          plan: riskNormalizedPlan,
          use_p90: false
        });

        const riskReplayMetrics = {
          with_plan: riskReplayWithPlan.metrics,
          without_plan: replayWithoutPlan.metrics,  // baseline is the same
          delta: {
            service_level_proxy: (
              Number.isFinite(riskReplayWithPlan.metrics?.service_level_proxy)
              && Number.isFinite(replayWithoutPlan.metrics?.service_level_proxy)
            )
              ? Number((riskReplayWithPlan.metrics.service_level_proxy - replayWithoutPlan.metrics.service_level_proxy).toFixed(6))
              : null,
            stockout_units: (
              Number.isFinite(riskReplayWithPlan.metrics?.stockout_units)
              && Number.isFinite(replayWithoutPlan.metrics?.stockout_units)
            )
              ? Number((riskReplayWithPlan.metrics.stockout_units - replayWithoutPlan.metrics.stockout_units).toFixed(6))
              : null
          },
          stockout_events_with_plan: riskReplayWithPlan.stockout_events.slice(0, 200),
          stockout_events_without_plan: replayWithoutPlan.stockout_events.slice(0, 200)
        };

        // 7. Build risk-aware solver meta (includes which rules fired)
        const riskSolverMetaArtifact = {
          status: riskSolverResult?.status || 'unknown',
          kpis: riskSolverResult?.kpis || {},
          solver_meta: {
            ...(riskSolverResult?.solver_meta || {}),
            risk_mode: 'on',
            risk_source_run_id: sourceRiskRunId || null,
            risk_rules_fired: (riskAdjustments.rules || []).map((r) => r.rule_id),
            effective_params_summary: {
              num_impacted_skus: riskAdjustments.summary?.num_impacted_skus || 0,
              demand_uplift_alpha: riskAdjustments.adjusted_params.demand_uplift_alpha,
              safety_stock_alpha: riskAdjustments.adjusted_params.safety_stock_alpha
            }
          },
          proof: riskSolverResult?.proof || {},
          infeasible_reasons: Array.isArray(riskSolverResult?.infeasible_reasons)
            ? riskSolverResult.infeasible_reasons
            : []
        };

        // 8. Build comparison artifact
        const planComparison = buildPlanComparison({
          baseRunId: run.id,
          riskRunId: run.id,  // same run, different artifact namespace
          baseReplayMetrics: replayMetrics,
          riskReplayMetrics: riskReplayMetrics,
          baseKpis: solverResult?.kpis || {},
          riskKpis: riskSolverResult?.kpis || {},
          basePlanRows: normalizedPlan,
          riskPlanRows: riskNormalizedPlan,
          riskAdjustments
        });

        // 9. Save risk-aware artifacts
        const riskAdjSaved = await saveJsonArtifact(run.id, 'risk_adjustments', riskAdjustments, ARTIFACT_SIZE_THRESHOLD, {
          user_id: userId,
          filename: `risk_adjustments_run_${run.id}.json`
        });

        const riskSolverMetaSaved = await saveJsonArtifact(run.id, 'risk_solver_meta', riskSolverMetaArtifact, ARTIFACT_SIZE_THRESHOLD, {
          user_id: userId,
          filename: `risk_solver_meta_run_${run.id}.json`
        });

        const riskPlanTableArtifact = {
          total_rows: riskNormalizedPlan.length,
          rows: riskNormalizedPlan.slice(0, MAX_PLAN_ROWS_IN_ARTIFACT),
          truncated: riskNormalizedPlan.length > MAX_PLAN_ROWS_IN_ARTIFACT
        };
        const riskPlanSaved = await saveJsonArtifact(run.id, 'risk_plan_table', riskPlanTableArtifact, ARTIFACT_SIZE_THRESHOLD, {
          user_id: userId,
          filename: `risk_plan_table_run_${run.id}.json`
        });

        const riskReplaySaved = await saveJsonArtifact(run.id, 'risk_replay_metrics', riskReplayMetrics, ARTIFACT_SIZE_THRESHOLD, {
          user_id: userId,
          filename: `risk_replay_metrics_run_${run.id}.json`
        });

        const riskMergedProjection = mergeProjectionForChart(
          riskReplayWithPlan.inventory_projection,
          replayWithoutPlan.inventory_projection
        );
        const riskProjectionArtifact = {
          total_rows: riskMergedProjection.length,
          rows: riskMergedProjection.slice(0, MAX_PROJECTION_ROWS_IN_ARTIFACT),
          truncated: riskMergedProjection.length > MAX_PROJECTION_ROWS_IN_ARTIFACT
        };
        const riskProjectionSaved = await saveJsonArtifact(run.id, 'risk_inventory_projection', riskProjectionArtifact, ARTIFACT_SIZE_THRESHOLD, {
          user_id: userId,
          filename: `risk_inventory_projection_run_${run.id}.json`
        });

        const planComparisonSaved = await saveJsonArtifact(run.id, 'plan_comparison', planComparison, ARTIFACT_SIZE_THRESHOLD, {
          user_id: userId,
          filename: `plan_comparison_run_${run.id}.json`
        });

        const riskPlanCsv = toCsv(riskNormalizedPlan);
        let riskPlanCsvSaved = null;
        if (riskPlanCsv) {
          riskPlanCsvSaved = await saveCsvArtifact(run.id, 'risk_plan_csv', riskPlanCsv, `risk_plan_run_${run.id}.csv`, ARTIFACT_SIZE_THRESHOLD, {
            user_id: userId
          });
        }

        riskAwareResult = {
          risk_adjustments: riskAdjustments,
          risk_solver_meta: riskSolverMetaArtifact,
          risk_plan: riskNormalizedPlan,
          risk_plan_artifact: riskPlanTableArtifact,
          risk_replay_metrics: riskReplayMetrics,
          risk_inventory_projection: riskProjectionArtifact,
          plan_comparison: planComparison,
          risk_plan_csv: riskPlanCsv.length <= MAX_DOWNLOADABLE_CSV_BYTES ? riskPlanCsv : '',
          artifact_refs: {
            risk_adjustments: riskAdjSaved.ref,
            risk_solver_meta: riskSolverMetaSaved.ref,
            risk_plan_table: riskPlanSaved.ref,
            risk_replay_metrics: riskReplaySaved.ref,
            risk_inventory_projection: riskProjectionSaved.ref,
            plan_comparison: planComparisonSaved.ref,
            ...(riskPlanCsvSaved ? { risk_plan_csv: riskPlanCsvSaved.ref } : {})
          }
        };

        logger.info('planning-pipeline', `Risk-aware plan produced: ${riskNormalizedPlan.length} rows, ${riskAdjustments.summary.num_impacted_skus} impacted SKUs`, { _traceId: planSpan.traceId });
        } // end if (riskScoreRows.length > 0)
      } catch (riskErr) {
        // Risk-aware planning failure must NOT fail the base plan run.
        logger.warn('planning-pipeline', `Risk-aware planning failed (base plan unaffected): ${riskErr.message}`, { _traceId: planSpan.traceId });
      }
    }
    // ── End risk-aware block ─────────────────────────────────────────────────

    const planArtifact = {
      total_rows: normalizedPlan.length,
      rows: normalizedPlan.slice(0, MAX_PLAN_ROWS_IN_ARTIFACT),
      truncated: normalizedPlan.length > MAX_PLAN_ROWS_IN_ARTIFACT,
      lineage_summary: {
        rows_with_fallback: normalizedPlan.filter(r => r._meta?.fallback_fields?.length > 0).length,
        rows_with_full_data: normalizedPlan.filter(r => !r._meta || r._meta.fallback_fields?.length === 0).length,
        datasets_used: [...new Set(availableDatasets)],
        datasets_missing: [...new Set(missingDatasets)],
      }
    };

    const projectionArtifact = {
      total_rows: mergedProjection.length,
      rows: mergedProjection.slice(0, MAX_PROJECTION_ROWS_IN_ARTIFACT),
      truncated: mergedProjection.length > MAX_PROJECTION_ROWS_IN_ARTIFACT
    };

    const artifactRefs = {
      solver_meta: solverMetaSaved.ref,
      constraint_check: constraintSaved.ref
    };
    const componentPlanCsvFull = toComponentPlanCsv(normalizedComponentPlan);
    const inlineComponentPlanCsv = componentPlanCsvFull.length <= MAX_DOWNLOADABLE_CSV_BYTES
      ? componentPlanCsvFull
      : '';

    if (readinessPromptArtifact) {
      try {
        const readinessSaved = await saveJsonArtifact(
          run.id,
          'workflow_a_readiness',
          readinessPromptArtifact,
          ARTIFACT_SIZE_THRESHOLD,
          {
            user_id: userId,
            filename: `workflow_a_readiness_run_${run.id}.json`
          }
        );
        artifactRefs.workflow_a_readiness = readinessSaved.ref;
      } catch (error) {
        logger.warn('planning-pipeline', `Failed to persist readiness artifact: ${error.message}`, { _traceId: planSpan.traceId });
      }
    }

    const planSaved = await saveJsonArtifact(run.id, 'plan_table', planArtifact, ARTIFACT_SIZE_THRESHOLD, {
      user_id: userId,
      filename: `plan_table_run_${run.id}.json`
    });
    artifactRefs.plan_table = planSaved.ref;

    const replaySaved = await saveJsonArtifact(run.id, 'replay_metrics', replayMetrics, ARTIFACT_SIZE_THRESHOLD, {
      user_id: userId,
      filename: `replay_metrics_run_${run.id}.json`
    });
    artifactRefs.replay_metrics = replaySaved.ref;

    const projectionSaved = await saveJsonArtifact(run.id, 'inventory_projection', projectionArtifact, ARTIFACT_SIZE_THRESHOLD, {
      user_id: userId,
      filename: `inventory_projection_run_${run.id}.json`
    });
    artifactRefs.inventory_projection = projectionSaved.ref;

    if (bomExplosionResult?.artifact) {
      const bomExplosionSaved = await saveJsonArtifact(run.id, 'bom_explosion', bomExplosionResult.artifact, ARTIFACT_SIZE_THRESHOLD, {
        user_id: userId,
        filename: `bom_explosion_run_${run.id}.json`
      });
      artifactRefs.bom_explosion = bomExplosionSaved.ref;
    }

    if (componentPlanArtifact.total_rows > 0) {
      const componentPlanSaved = await saveJsonArtifact(
        run.id,
        'component_plan_table',
        componentPlanArtifact,
        ARTIFACT_SIZE_THRESHOLD,
        {
          user_id: userId,
          filename: `component_plan_table_run_${run.id}.json`
        }
      );
      artifactRefs.component_plan_table = componentPlanSaved.ref;

      if (componentPlanCsvFull) {
        const componentCsvSaved = await saveCsvArtifact(
          run.id,
          'component_plan_csv',
          componentPlanCsvFull,
          `component_plan_run_${run.id}.csv`,
          ARTIFACT_SIZE_THRESHOLD,
          { user_id: userId }
        );
        artifactRefs.component_plan_csv = componentCsvSaved.ref;
      }
    }

    if (componentProjectionArtifact.total_rows > 0) {
      const componentProjectionSaved = await saveJsonArtifact(
        run.id,
        'component_inventory_projection',
        componentProjectionArtifact,
        ARTIFACT_SIZE_THRESHOLD,
        {
          user_id: userId,
          filename: `component_inventory_projection_run_${run.id}.json`
        }
      );
      artifactRefs.component_inventory_projection = componentProjectionSaved.ref;
    }

    if (normalizedBottlenecks.total_rows > 0) {
      const bottlenecksSaved = await saveJsonArtifact(run.id, 'bottlenecks', normalizedBottlenecks, ARTIFACT_SIZE_THRESHOLD, {
        user_id: userId,
        filename: `bottlenecks_run_${run.id}.json`
      });
      artifactRefs.bottlenecks = bottlenecksSaved.ref;
    }

    const decisionNarrative = buildDecisionNarrativeFromPlanResult({
      solver_result: solverResult,
      replay_metrics: replayMetrics,
      risk_adjustments: riskAwareResult?.risk_adjustments || null,
      negotiation_options: null,
      run: { id: run.id }
    });
    const decisionNarrativeSaved = await saveJsonArtifact(
      run.id,
      'decision_narrative',
      decisionNarrative,
      ARTIFACT_SIZE_THRESHOLD,
      {
        user_id: userId,
        filename: `decision_narrative_run_${run.id}.json`
      }
    );
    artifactRefs.decision_narrative = decisionNarrativeSaved.ref;

    const evidencePack = buildEvidencePack({
      runId: run.id,
      datasetProfileId: datasetProfileRow.id,
      forecastRunId: forecastContext.run?.id || null,
      solverResult,
      constraintResult,
      replayMetrics,
      artifactRefs,
      readiness: readinessPromptArtifact?.output || null,
      decisionNarrative,
      multiEchelon: multiEchelonDiagnostics,
      componentPlan: componentPlanArtifact,
      bottlenecks: normalizedBottlenecks,
      traceId: planSpan.traceId
    });

    const evidenceSaved = await saveJsonArtifact(run.id, 'evidence_pack', evidencePack, ARTIFACT_SIZE_THRESHOLD, {
      user_id: userId,
      filename: `evidence_pack_run_${run.id}.json`
    });
    artifactRefs.evidence_pack = evidenceSaved.ref;

    const fallbackReport = buildRuleBasedFinalReport({
      solverResult,
      constraintResult,
      replayMetrics,
      forecastMetrics: forecastMetricsArtifact,
      componentPlanRows: normalizedComponentPlan,
      bottlenecks: normalizedBottlenecks,
      multiEchelon: multiEchelonDiagnostics
    });
    let finalReport = fallbackReport;

    try {
      const evidencePromptInput = buildEvidencePromptInput({
        solverResult,
        constraintResult,
        replayMetrics,
        forecastMetrics: forecastMetricsArtifact,
        runId: run.id,
        readiness: readinessPromptArtifact?.output || null,
        decisionNarrative
      });
      const reportPromptResult = await runDiPrompt({
        promptId: DI_PROMPT_IDS.REPORT_SUMMARY,
        input: evidencePromptInput,
        temperature: 0.1,
        maxOutputTokens: 1800
      });
      const promptReport = normalizeReportFromPrompt(reportPromptResult.parsed);
      if (promptReport) {
        finalReport = {
          ...fallbackReport,
          ...promptReport,
          bom_aware_feasibility: fallbackReport.bom_aware_feasibility,
          llm_provider: reportPromptResult.provider,
          llm_model: reportPromptResult.model
        };
      }
    } catch (error) {
      logger.warn('planning-pipeline', `Prompt 4 report fallback: ${error.message}`, { _traceId: planSpan.traceId });
    }

    const reportSaved = await saveJsonArtifact(run.id, 'report_json', finalReport, ARTIFACT_SIZE_THRESHOLD, {
      user_id: userId,
      filename: `plan_report_run_${run.id}.json`
    });
    artifactRefs.report_json = reportSaved.ref;

    recordPlanGenerated({
      userId,
      runId: run.id,
      kpiSnapshot: {
        service_level: replayMetrics?.with_plan?.service_level_proxy ?? null,
        total_cost: solverResult?.kpis?.estimated_total_cost ?? null,
        stockout_units: replayMetrics?.with_plan?.stockout_units ?? null
      },
      narrativeSummary: decisionNarrative?.summary_text || finalReport?.summary || '',
      metadata: {
        solver_status: solverResult?.status || 'unknown'
      }
    }).catch((error) => {
      logger.warn('planning-pipeline', `Audit trail write failed (non-fatal): ${error.message}`, { _traceId: planSpan.traceId });
    });

    const planCsv = toCsv(normalizedPlan);
    const inlinePlanCsv = planCsv.length <= MAX_DOWNLOADABLE_CSV_BYTES ? planCsv : '';
    if (planCsv) {
      const csvSaved = await saveCsvArtifact(run.id, 'plan_csv', planCsv, `plan_run_${run.id}.csv`, ARTIFACT_SIZE_THRESHOLD, {
        user_id: userId
      });
      artifactRefs.plan_csv = csvSaved.ref;
    }

    const updatedRun = await diRunsService.updateRunStatus({
      run_id: run.id,
      status: 'succeeded',
      finished_at: new Date().toISOString(),
      error: null
    });

    if (datasetProfileRow?.fingerprint) {
      const settingsPayload = {
        plan: {
          planning_horizon_days: horizonDays,
          objective,
          constraints: {
            budget_cap: constraints?.budget_cap ?? null,
            moq_count: Array.isArray(constraints?.moq) ? constraints.moq.length : 0,
            pack_size_count: Array.isArray(constraints?.pack_size) ? constraints.pack_size.length : 0,
            max_order_qty_count: Array.isArray(constraints?.max_order_qty) ? constraints.max_order_qty.length : 0
          },
          multi_echelon_mode: multiEchelonDiagnostics.mode,
          max_bom_depth: multiEchelonDiagnostics.max_bom_depth,
          bom_explosion_used: multiEchelonDiagnostics.bom_explosion_used,
          bom_explosion_reused: multiEchelonDiagnostics.bom_explosion_reused
        },
        allow_plan_defaults: ALLOW_PLAN_DEFAULTS,
        reuse_enabled: settings?.reuse_enabled !== false,
        force_retrain: Boolean(settings?.force_retrain)
      };

      reuseMemoryService.upsertRunSettingsTemplate({
        user_id: userId,
        fingerprint: datasetProfileRow.fingerprint,
        workflow,
        settings_json: settingsPayload,
        quality_delta: getPlanningTemplateQualityDelta({
          constraintResult,
          replayMetrics
        })
      }).catch((error) => {
        logger.warn('planning-pipeline', `Failed to update run settings template: ${error.message}`);
      });
    }

    const summaryText = decisionNarrative?.summary_text || finalReport.summary;

    // Observability: finalize planning span
    planSpan.addMetric('planRows', normalizedPlan.length);
    planSpan.addMetric('solver', solverResult?.status || 'unknown');
    planSpan.addMetric('coverageLevel', dataQuality.coverage_level);
    planSpan.end();
    recordPlanningSuccess(planSpan.durationMs);
    if (normalizedPlan.length === 0) recordZeroResultPlan();
    logger.info('planning-pipeline', 'Planning completed successfully', {
      _traceId: planSpan.traceId, durationMs: planSpan.durationMs, planRows: normalizedPlan.length,
    });

    return {
      run: updatedRun,
      forecast_run_id: forecastContext.run?.id || null,
      optimization_payload: optimizationPayload,
      solver_result: {
        ...solverResult,
        plan: normalizedPlan,
        component_plan: normalizedComponentPlan,
        bottlenecks: normalizedBottlenecks
      },
      plan_artifact: planArtifact,
      constraint_check: constraintResult,
      replay_metrics: replayMetrics,
      inventory_projection: projectionArtifact,
      component_plan_table: componentPlanArtifact,
      component_inventory_projection: componentProjectionArtifact,
      bom_explosion: bomExplosionResult.artifact || null,
      bottlenecks: normalizedBottlenecks,
      multi_echelon: multiEchelonDiagnostics,
      final_report: finalReport,
      decision_narrative: decisionNarrative,
      evidence_pack: evidencePack,
      forecast_metrics: forecastMetricsArtifact,
      plan_csv: inlinePlanCsv,
      component_plan_csv: inlineComponentPlanCsv,
      summary_text: summaryText,
      artifact_refs: {
        ...artifactRefs,
        ...(riskAwareResult ? riskAwareResult.artifact_refs : {})
      },
      minimal_questions: readinessPromptArtifact?.output?.minimal_questions || [],
      // Risk-aware results (null when risk_mode='off')
      risk_mode: isRiskAwareMode ? 'on' : 'off',
      risk_aware: riskAwareResult
    };
  } catch (error) {
    if (error?.isBlocking) {
      const enrichedQuestions = await enrichBlockingQuestionsWithPrompt({
        message: error.message || 'Planning blocked',
        existingQuestions: error.blockingQuestions || [],
        contextInput: {
          workflow,
          dataset_profile_id: datasetProfileRow?.id || null,
          readiness: readinessPromptArtifact?.output || null,
          allow_plan_defaults: ALLOW_PLAN_DEFAULTS
        }
      });
      error.blockingQuestions = enrichedQuestions;
    }

    planSpan.addMetric('error', error.message || 'unknown');
    planSpan.end();
    recordPlanningFailure();
    logger.error('planning-pipeline', `Planning failed: ${error.message}`, {
      _traceId: planSpan.traceId, durationMs: planSpan.durationMs, isBlocking: !!error.isBlocking,
    });

    await diRunsService.updateRunStatus({
      run_id: run.id,
      status: 'failed',
      finished_at: new Date().toISOString(),
      error: error.message || 'Planning failed'
    }).catch(() => {});

    error.run_id = error.run_id || run.id;
    throw error;
  }
}

export function buildPlanSummaryCardPayload(planResult, datasetProfileRow) {
  const solver = planResult?.solver_result || {};
  const kpis = solver.kpis || {};
  const replay = planResult?.replay_metrics || {};
  const solverMeta = solver.solver_meta || {};

  return {
    run_id: planResult?.run?.id || null,
    dataset_profile_id: datasetProfileRow?.id || null,
    forecast_run_id: planResult?.forecast_run_id || null,
    solver_status: solver.status || 'unknown',
    workflow: planResult?.run?.workflow || makeWorkflowLabel(datasetProfileRow),
    kpis,
    replay_metrics: replay,
    total_plan_rows: planResult?.plan_artifact?.total_rows || 0,
    multi_echelon_mode: solverMeta?.multi_echelon_mode || MULTI_ECHELON_MODES.OFF,
    component_plan_rows: planResult?.component_plan_table?.total_rows || 0,
    summary: planResult?.final_report?.summary || planResult?.summary_text || ''
  };
}

export function buildPlanTableCardPayload(planResult) {
  const rows = planResult?.solver_result?.plan || [];
  return {
    run_id: planResult?.run?.id || null,
    total_rows: rows.length,
    rows: rows.slice(0, MAX_PLAN_ROWS_IN_CARD),
    truncated: rows.length > MAX_PLAN_ROWS_IN_CARD
  };
}

export function buildInventoryProjectionCardPayload(planResult) {
  const projectionRows = planResult?.inventory_projection?.rows || [];
  const grouped = new Map();

  projectionRows.forEach((row) => {
    const key = `${row.sku}|${row.plant_id || ''}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        key,
        sku: row.sku,
        plant_id: row.plant_id || null,
        points: []
      });
    }
    grouped.get(key).points.push(row);
  });

  const groups = Array.from(grouped.values())
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((group) => ({
      ...group,
      points: group.points.sort((a, b) => a.date.localeCompare(b.date))
    }));

  return {
    run_id: planResult?.run?.id || null,
    total_rows: projectionRows.length,
    groups,
    truncated: Boolean(planResult?.inventory_projection?.truncated)
  };
}

export function buildPlanExceptionsCardPayload(planResult) {
  const solver = planResult?.solver_result || {};
  const constraintCheck = planResult?.constraint_check || {};
  const bottlenecks = Array.isArray(planResult?.bottlenecks?.rows) ? planResult.bottlenecks.rows : [];

  const constraintsChecked = getProofConstraints(solver);
  const roundingLine = constraintsChecked.find((item) => item?.name === 'rounding_adjustments');
  const bindingConstraints = extractBindingConstraints(constraintsChecked);
  const passingConstraints = constraintsChecked
    .filter((constraint) => (
      constraint
      && constraint.passed !== false
      && constraint.binding !== true
      && constraint.name !== 'rounding_adjustments'
    ))
    .slice(0, 10);
  const objectiveTerms = getProofObjectiveTerms(solver);
  const infeasibleReasonDetails = getInfeasibleReasonDetails(solver);
  const suggestedActions = extractSuggestedActions(solver, 6);
  const infeasibilityCategories = uniqueNonEmptyStrings(infeasibleReasonDetails.map((item) => item?.category));

  return {
    run_id: planResult?.run?.id || null,
    infeasible_reasons: Array.isArray(solver.infeasible_reasons) ? solver.infeasible_reasons : [],
    constraint_violations: Array.isArray(constraintCheck.violations) ? constraintCheck.violations : [],
    rounding_notes: roundingLine?.details ? String(roundingLine.details).split('; ').slice(0, 10) : [],
    bom_bottlenecks: bottlenecks.slice(0, 5),
    binding_constraints: bindingConstraints,
    passing_constraints: passingConstraints,
    objective_terms: objectiveTerms,
    suggested_actions: suggestedActions,
    infeasibility_categories: infeasibilityCategories,
    solver_gap: solver?.solver_meta?.gap ?? null,
    solver_engine: solver?.solver_meta?.engine || solver?.solver_meta?.solver || null,
    solve_time_ms: solver?.solver_meta?.solve_time_ms ?? null
  };
}

export function buildBomBottlenecksCardPayload(planResult) {
  const payload = normalizeBottlenecks(planResult?.bottlenecks || {});
  return {
    run_id: planResult?.run?.id || null,
    total_rows: payload.total_rows || 0,
    rows: (payload.rows || []).slice(0, 10),
    truncated: (payload.total_rows || 0) > 10
  };
}

export function buildPlanDownloadsPayload(planResult) {
  const runId = planResult?.run?.id || 'latest';
  const refs = planResult?.artifact_refs || {};
  const riskAware = planResult?.risk_aware || null;

  const files = [
    {
      label: 'plan.csv',
      fileName: `plan_run_${runId}.csv`,
      mimeType: 'text/csv;charset=utf-8',
      ref: refs.plan_csv || null,
      content: planResult?.plan_csv || ''
    },
    {
      label: 'proof.json',
      fileName: `proof_run_${runId}.json`,
      mimeType: 'application/json;charset=utf-8',
      ref: refs.solver_meta || null,
      content: planResult?.solver_result?.proof || {}
    },
    {
      label: 'replay_metrics.json',
      fileName: `replay_metrics_run_${runId}.json`,
      mimeType: 'application/json;charset=utf-8',
      ref: refs.replay_metrics || null,
      content: planResult?.replay_metrics || {}
    },
    {
      label: 'inventory_projection.json',
      fileName: `inventory_projection_run_${runId}.json`,
      mimeType: 'application/json;charset=utf-8',
      ref: refs.inventory_projection || null,
      content: planResult?.inventory_projection || {}
    },
    {
      label: 'report.json',
      fileName: `plan_report_run_${runId}.json`,
      mimeType: 'application/json;charset=utf-8',
      ref: refs.report_json || null,
      content: planResult?.final_report || {}
    },
    {
      label: 'decision_narrative.json',
      fileName: `decision_narrative_run_${runId}.json`,
      mimeType: 'application/json;charset=utf-8',
      ref: refs.decision_narrative || null,
      content: planResult?.decision_narrative || null,
      optional: true
    },
    {
      label: 'component_plan.csv',
      fileName: `component_plan_run_${runId}.csv`,
      mimeType: 'text/csv;charset=utf-8',
      ref: refs.component_plan_csv || null,
      content: planResult?.component_plan_csv || '',
      optional: true
    },
    {
      label: 'component_plan_table.json',
      fileName: `component_plan_table_run_${runId}.json`,
      mimeType: 'application/json;charset=utf-8',
      ref: refs.component_plan_table || null,
      content: (planResult?.component_plan_table?.total_rows || 0) > 0 ? planResult.component_plan_table : null,
      optional: true
    },
    {
      label: 'component_inventory_projection.json',
      fileName: `component_inventory_projection_run_${runId}.json`,
      mimeType: 'application/json;charset=utf-8',
      ref: refs.component_inventory_projection || null,
      content: (planResult?.component_inventory_projection?.total_rows || 0) > 0
        ? planResult.component_inventory_projection
        : null,
      optional: true
    },
    {
      label: 'bom_explosion.json',
      fileName: `bom_explosion_run_${runId}.json`,
      mimeType: 'application/json;charset=utf-8',
      ref: refs.bom_explosion || null,
      content: planResult?.bom_explosion || null,
      optional: true
    },
    {
      label: 'bottlenecks.json',
      fileName: `bottlenecks_run_${runId}.json`,
      mimeType: 'application/json;charset=utf-8',
      ref: refs.bottlenecks || null,
      content: (planResult?.bottlenecks?.total_rows || 0) > 0 ? planResult.bottlenecks : null,
      optional: true
    }
  ];

  // Append risk-aware plan downloads when available
  if (riskAware) {
    if (riskAware.risk_plan_csv) {
      files.push({
        label: 'risk_plan.csv',
        fileName: `risk_plan_run_${runId}.csv`,
        mimeType: 'text/csv;charset=utf-8',
        ref: refs.risk_plan_csv || null,
        content: riskAware.risk_plan_csv
      });
    }
    files.push({
      label: 'risk_adjustments.json',
      fileName: `risk_adjustments_run_${runId}.json`,
      mimeType: 'application/json;charset=utf-8',
      ref: refs.risk_adjustments || null,
      content: riskAware.risk_adjustments || {}
    });
    files.push({
      label: 'plan_comparison.json',
      fileName: `plan_comparison_run_${runId}.json`,
      mimeType: 'application/json;charset=utf-8',
      ref: refs.plan_comparison || null,
      content: riskAware.plan_comparison || {}
    });
  }

  return {
    run_id: planResult?.run?.id || null,
    files: files.filter((file) => {
      if (file.mimeType.startsWith('text/csv')) {
        return Boolean(file.content || file.ref);
      }
      if (file.optional) {
        const hasContent = file.content && (
          (typeof file.content === 'string' && file.content.trim().length > 0)
          || (typeof file.content === 'object' && Object.keys(file.content).length > 0)
        );
        return Boolean(file.ref || hasContent);
      }
      return true;
    })
  };
}

/**
 * buildRiskAwarePlanComparisonCardPayload
 *
 * Converts the risk-aware result into a payload for the chat-thread
 * risk_aware_plan_comparison_card. Returns null when risk_mode is off.
 */
export function buildRiskAwarePlanComparisonCardPayload(planResult) {
  if (!planResult?.risk_aware) return null;
  const ra = planResult.risk_aware;
  const comparison = ra.plan_comparison || {};
  const adjustments = ra.risk_adjustments || {};

  return {
    run_id: planResult?.run?.id || null,
    risk_mode: planResult?.risk_mode || 'on',
    num_impacted_skus: adjustments?.summary?.num_impacted_skus || 0,
    rules_fired: (adjustments?.rules || []).map((r) => ({
      rule_id: r.rule_id,
      description: r.description,
      applies_to: r.applies_to
    })),
    kpis: comparison?.kpis || { base: {}, risk: {}, delta: {} },
    key_changes: Array.isArray(comparison?.key_changes) ? comparison.key_changes.slice(0, 10) : []
  };
}

export default {
  runPlanFromDatasetProfile,
  buildPlanSummaryCardPayload,
  buildPlanTableCardPayload,
  buildInventoryProjectionCardPayload,
  buildPlanExceptionsCardPayload,
  buildBomBottlenecksCardPayload,
  buildPlanDownloadsPayload,
  buildRiskAwarePlanComparisonCardPayload
};
