import { userFilesService } from './supabaseClient';
import { diRunsService } from './diRunsService';
import { reuseMemoryService } from './reuseMemoryService';
import optimizationApiClient from './optimizationApiClient';
import { constraintChecker } from '../utils/constraintChecker';
import { replaySimulator } from '../utils/replaySimulator';
import { saveJsonArtifact, saveCsvArtifact } from '../utils/artifactStore';
import { DI_PROMPT_IDS, runDiPrompt } from './diModelRouterService';

const MAX_PLAN_ROWS_IN_CARD = 50;
const MAX_PLAN_ROWS_IN_ARTIFACT = 2000;
const MAX_PROJECTION_ROWS_IN_ARTIFACT = 4000;
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
const DEFAULT_LEAD_TIME_DAYS = Math.max(0, Number(import.meta.env.VITE_DI_DEFAULT_LEAD_TIME_DAYS || 7));
const DEFAULT_SAFETY_STOCK = Math.max(0, Number(import.meta.env.VITE_DI_DEFAULT_SAFETY_STOCK || 0));

const normalizeText = (value) => String(value || '').trim();

const createBlockingError = (message, questions = []) => {
  const err = new Error(message);
  err.blockingQuestions = Array.isArray(questions) ? questions.slice(0, MAX_BLOCKING_QUESTIONS) : [];
  err.isBlocking = true;
  return err;
};

const toNumber = (value, fallback = NaN) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseDateValue = (value) => {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  if (typeof value === 'number' && value > 1 && value < 100000) {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    const parsed = new Date(excelEpoch.getTime() + (value * 24 * 60 * 60 * 1000));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const raw = String(value).trim();
  if (!raw) return null;

  const weekMatch = raw.match(/^(\d{4})[-/ ]?W(\d{1,2})$/i);
  if (weekMatch) {
    const year = Number(weekMatch[1]);
    const week = Number(weekMatch[2]);
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const jan4Day = jan4.getUTCDay() || 7;
    const week1Monday = new Date(jan4);
    week1Monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1);
    const target = new Date(week1Monday);
    target.setUTCDate(week1Monday.getUTCDate() + ((week - 1) * 7));
    return Number.isNaN(target.getTime()) ? null : target;
  }

  const monthMatch = raw.match(/^(\d{4})-(\d{1,2})$/);
  if (monthMatch) {
    const year = Number(monthMatch[1]);
    const month = Number(monthMatch[2]);
    if (month < 1 || month > 12) return null;
    return new Date(Date.UTC(year, month - 1, 1));
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const toIsoDay = (dateObj) => {
  if (!dateObj || Number.isNaN(dateObj.getTime())) return null;
  return dateObj.toISOString().slice(0, 10);
};

const normalizeSheetName = (value) => normalizeText(value).toLowerCase();

const normalizeRowsFromUserFile = (fileRecord) => {
  if (!fileRecord) return [];
  const raw = fileRecord.data;
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.rows)) return raw.rows;
  return [];
};

const getRowsForSheet = (rows, sheetName) => {
  const normalizedSheet = normalizeSheetName(sheetName);
  const hasSheetMarker = rows.some((row) => row && Object.prototype.hasOwnProperty.call(row, '__sheet_name'));

  if (!hasSheetMarker) return rows;
  return rows.filter((row) => normalizeSheetName(row.__sheet_name) === normalizedSheet);
};

const normalizeTargetMapping = (mapping = {}) => {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return {};

  const knownTargetFields = new Set([
    'material_code',
    'plant_id',
    'demand_qty',
    'week_bucket',
    'date',
    'time_bucket',
    'snapshot_date',
    'onhand_qty',
    'safety_stock',
    'open_qty',
    'lead_time_days',
    'moq',
    'pack_size',
    'max_order_qty',
    'unit_cost',
    'unit_price',
    'cost'
  ]);

  const keys = Object.keys(mapping);
  const values = Object.values(mapping).map((value) => normalizeText(value));

  const keysLookLikeTarget = keys.some((key) => knownTargetFields.has(normalizeText(key)));
  if (keysLookLikeTarget) {
    return mapping;
  }

  const valuesLookLikeTarget = values.some((value) => knownTargetFields.has(value));
  if (!valuesLookLikeTarget) {
    return mapping;
  }

  const inverted = {};
  Object.entries(mapping).forEach(([source, target]) => {
    const targetField = normalizeText(target);
    if (!targetField) return;
    inverted[targetField] = source;
  });
  return inverted;
};

const chooseDatasetByType = (contractJson = {}, uploadType) => {
  const datasets = Array.isArray(contractJson?.datasets) ? contractJson.datasets : [];
  return datasets
    .filter((dataset) => normalizeText(dataset.upload_type).toLowerCase() === normalizeText(uploadType).toLowerCase())
    .sort((a, b) => {
      const aPass = a?.validation?.status === 'pass' ? 1 : 0;
      const bPass = b?.validation?.status === 'pass' ? 1 : 0;
      if (aPass !== bPass) return bPass - aPass;
      return toNumber(b.requiredCoverage, 0) - toNumber(a.requiredCoverage, 0);
    })[0] || null;
};

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
      const isForecastPoint = point.is_forecast === true || (point.forecast !== null && point.forecast !== undefined);
      if (!isForecastPoint) return;

      const bucket = point.time_bucket || point.date;
      const dateObj = parseDateValue(bucket);
      const date = dateObj ? toIsoDay(dateObj) : null;
      if (!date) return;

      const p50 = toNumber(point.forecast, NaN);
      if (!Number.isFinite(p50)) return;

      const p90Candidate = toNumber(point.upper, NaN);
      rows.push({
        sku,
        plant_id: plant || null,
        date,
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
    : null
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

const buildEvidencePack = ({ runId, datasetProfileId, forecastRunId, solverResult, constraintResult, replayMetrics, artifactRefs, readiness }) => ({
  generated_at: new Date().toISOString(),
  run_id: runId,
  dataset_profile_id: datasetProfileId,
  forecast_run_id: forecastRunId,
  solver_status: solverResult?.status || 'unknown',
  refs: artifactRefs || {},
  evidence: {
    readiness_check: readiness || null,
    solver_meta: solverResult?.solver_meta || {},
    kpis: solverResult?.kpis || {},
    constraint_check: constraintResult || {},
    replay_metrics: replayMetrics || {}
  }
});

const buildRuleBasedFinalReport = ({ solverResult, constraintResult, replayMetrics, forecastMetrics }) => {
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
    recommended_actions: recommendedActions
  };
};

const normalizeBlockingQuestions = (questions = []) => (
  (Array.isArray(questions) ? questions : [])
    .map((item) => (typeof item === 'string' ? item : item?.question))
    .map((value) => String(value || '').trim())
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

const buildEvidencePromptInput = ({ solverResult, constraintResult, replayMetrics, forecastMetrics, runId, readiness }) => {
  const evidence = [];
  const pushEvidence = (type, payload) => {
    evidence.push({
      evidence_id: `E${evidence.length + 1}`,
      type,
      payload
    });
  };

  pushEvidence('solver_result', {
    run_id: runId,
    status: solverResult?.status || 'unknown',
    kpis: solverResult?.kpis || {},
    solver_meta: solverResult?.solver_meta || {}
  });
  pushEvidence('constraint_check', constraintResult || {});
  pushEvidence('replay', replayMetrics || {});
  pushEvidence('forecast_metrics', forecastMetrics || {});
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
  const fallback = normalizeBlockingQuestions(existingQuestions);
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
    const promptQuestions = normalizeBlockingQuestions(result?.parsed?.questions || []);
    return promptQuestions.length > 0 ? promptQuestions : fallback;
  } catch (error) {
    console.warn('[chatPlanningService] Prompt 5 blocking question fallback:', error.message);
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

export async function runPlanFromDatasetProfile({
  userId,
  datasetProfileRow,
  forecastRunId = null,
  forecastCardPayload = null,
  planningHorizonDays = null,
  constraintsOverride = null,
  objectiveOverride = null,
  settings = {}
}) {
  if (!userId) throw new Error('userId is required');
  if (!datasetProfileRow?.id) throw new Error('datasetProfileRow is required');

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

    if (!datasetProfileRow.user_file_id) {
      throw createBlockingError('Dataset profile has no linked source file.', [
        'Re-upload the dataset from chat and rerun forecast + plan.'
      ]);
    }

    const fileRecord = await userFilesService.getFileById(userId, datasetProfileRow.user_file_id);
    const rawRows = normalizeRowsFromUserFile(fileRecord);
    if (rawRows.length === 0) {
      throw createBlockingError('Source rows are unavailable for this dataset profile.', [
        'Re-upload source data and regenerate profile.'
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

    const openPoDataset = chooseDatasetByType(contractJson, 'po_open_lines');
    const openPoResult = openPoDataset
      ? mapOpenPoRows({
          rows: rawRows,
          sheetName: openPoDataset.sheet_name,
          mapping: normalizeTargetMapping(openPoDataset.mapping || {})
        })
      : { rows: [], dropped: 0 };

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

    const inventoryRowsForPlanning = inventoryResult.rows.map((row) => ({
      ...row,
      lead_time_days: row.lead_time_days === null || row.lead_time_days === undefined
        ? DEFAULT_LEAD_TIME_DAYS
        : row.lead_time_days,
      safety_stock: row.safety_stock === null || row.safety_stock === undefined
        ? DEFAULT_SAFETY_STOCK
        : row.safety_stock
    }));

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
        maxOutputTokens: 1400
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
      console.warn('[chatPlanningService] Prompt 3 readiness fallback:', error.message);
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
      objective
    };

    const solverResult = await optimizationApiClient.createReplenishmentPlan(optimizationPayload, {
      timeoutMs: 25000,
      allowFallback: true
    });

    const normalizedPlan = Array.isArray(solverResult?.plan)
      ? solverResult.plan
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

    const constraintResult = constraintChecker({
      plan: normalizedPlan,
      constraints
    });

    const solverMetaArtifact = {
      status: solverResult?.status || 'unknown',
      kpis: solverResult?.kpis || {},
      solver_meta: solverResult?.solver_meta || {},
      proof: solverResult?.proof || {},
      infeasible_reasons: Array.isArray(solverResult?.infeasible_reasons)
        ? solverResult.infeasible_reasons
        : []
    };

    const solverMetaSaved = await saveJsonArtifact(run.id, 'solver_meta', solverMetaArtifact, ARTIFACT_SIZE_THRESHOLD, {
      user_id: userId,
      filename: `solver_meta_run_${run.id}.json`
    });

    const constraintSaved = await saveJsonArtifact(run.id, 'constraint_check', constraintResult, ARTIFACT_SIZE_THRESHOLD, {
      user_id: userId,
      filename: `constraint_check_run_${run.id}.json`
    });

    if (!constraintResult.passed) {
      await saveJsonArtifact(run.id, 'plan_table', {
        total_rows: normalizedPlan.length,
        rows: normalizedPlan.slice(0, MAX_PLAN_ROWS_IN_ARTIFACT),
        truncated: normalizedPlan.length > MAX_PLAN_ROWS_IN_ARTIFACT
      }, ARTIFACT_SIZE_THRESHOLD, {
        user_id: userId,
        filename: `plan_table_run_${run.id}.json`
      });

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

    const planArtifact = {
      total_rows: normalizedPlan.length,
      rows: normalizedPlan.slice(0, MAX_PLAN_ROWS_IN_ARTIFACT),
      truncated: normalizedPlan.length > MAX_PLAN_ROWS_IN_ARTIFACT
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
        console.warn('[chatPlanningService] Failed to persist readiness artifact:', error.message);
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

    const evidencePack = buildEvidencePack({
      runId: run.id,
      datasetProfileId: datasetProfileRow.id,
      forecastRunId: forecastContext.run?.id || null,
      solverResult,
      constraintResult,
      replayMetrics,
      artifactRefs,
      readiness: readinessPromptArtifact?.output || null
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
      forecastMetrics: forecastMetricsArtifact
    });
    let finalReport = fallbackReport;

    try {
      const evidencePromptInput = buildEvidencePromptInput({
        solverResult,
        constraintResult,
        replayMetrics,
        forecastMetrics: forecastMetricsArtifact,
        runId: run.id,
        readiness: readinessPromptArtifact?.output || null
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
          ...promptReport,
          llm_provider: reportPromptResult.provider,
          llm_model: reportPromptResult.model
        };
      }
    } catch (error) {
      console.warn('[chatPlanningService] Prompt 4 report fallback:', error.message);
    }

    const reportSaved = await saveJsonArtifact(run.id, 'report_json', finalReport, ARTIFACT_SIZE_THRESHOLD, {
      user_id: userId,
      filename: `plan_report_run_${run.id}.json`
    });
    artifactRefs.report_json = reportSaved.ref;

    const planCsv = toCsv(normalizedPlan);
    const inlinePlanCsv = planCsv.length <= MAX_DOWNLOADABLE_CSV_BYTES ? planCsv : '';
    if (planCsv) {
      const csvSaved = await saveCsvArtifact(run.id, 'csv', planCsv, `plan_run_${run.id}.csv`, ARTIFACT_SIZE_THRESHOLD, {
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
          }
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
        console.warn('[chatPlanningService] Failed to update run settings template:', error.message);
      });
    }

    const summaryText = finalReport.summary;

    return {
      run: updatedRun,
      forecast_run_id: forecastContext.run?.id || null,
      optimization_payload: optimizationPayload,
      solver_result: {
        ...solverResult,
        plan: normalizedPlan
      },
      plan_artifact: planArtifact,
      constraint_check: constraintResult,
      replay_metrics: replayMetrics,
      inventory_projection: projectionArtifact,
      final_report: finalReport,
      evidence_pack: evidencePack,
      forecast_metrics: forecastMetricsArtifact,
      plan_csv: inlinePlanCsv,
      summary_text: summaryText,
      artifact_refs: artifactRefs,
      minimal_questions: readinessPromptArtifact?.output?.minimal_questions || []
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

  return {
    run_id: planResult?.run?.id || null,
    dataset_profile_id: datasetProfileRow?.id || null,
    forecast_run_id: planResult?.forecast_run_id || null,
    solver_status: solver.status || 'unknown',
    workflow: planResult?.run?.workflow || makeWorkflowLabel(datasetProfileRow),
    kpis,
    replay_metrics: replay,
    total_plan_rows: planResult?.plan_artifact?.total_rows || 0,
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
  const proof = solver.proof || {};

  const roundingLine = (Array.isArray(proof.constraints_checked) ? proof.constraints_checked : [])
    .find((item) => item.name === 'rounding_adjustments');

  return {
    run_id: planResult?.run?.id || null,
    infeasible_reasons: Array.isArray(solver.infeasible_reasons) ? solver.infeasible_reasons : [],
    constraint_violations: Array.isArray(constraintCheck.violations) ? constraintCheck.violations : [],
    rounding_notes: roundingLine?.details ? String(roundingLine.details).split('; ').slice(0, 10) : []
  };
}

export function buildPlanDownloadsPayload(planResult) {
  const runId = planResult?.run?.id || 'latest';
  const refs = planResult?.artifact_refs || {};
  return {
    run_id: planResult?.run?.id || null,
    files: [
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
      }
    ].filter((file) => {
      if (file.mimeType.startsWith('text/csv')) {
        return Boolean(file.content || file.ref);
      }
      return true;
    })
  };
}

export default {
  runPlanFromDatasetProfile,
  buildPlanSummaryCardPayload,
  buildPlanTableCardPayload,
  buildInventoryProjectionCardPayload,
  buildPlanExceptionsCardPayload,
  buildPlanDownloadsPayload
};
