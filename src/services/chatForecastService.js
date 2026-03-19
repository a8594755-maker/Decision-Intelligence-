import { userFilesService } from './supabaseClient';
import { diRunsService } from './diRunsService';
import { reuseMemoryService } from './reuseMemoryService';
import forecastApiClient from './forecastApiClient';
import { validateFieldType } from '../utils/uploadSchemas';
import { saveJsonArtifact, saveCsvArtifact } from '../utils/artifactStore';
import {
  CALIBRATION_METHOD,
  DEFAULT_MIN_SERIES_SAMPLES,
  buildQuantileCalibration,
  applyCalibratedQuantiles,
  computeCalibrationMetrics
} from './forecasting/calibrateQuantiles';
import { toCanonicalForecastPoint } from './forecasting/forecastPointMapper';
import {
  normalizeSheetName, parseDateValue, toIsoDay
} from '../utils/dataServiceHelpers';

const MAX_GROUPS_IN_ARTIFACT = 25;
const MAX_HISTORY_POINTS = 24;
const MAX_BLOCKING_QUESTIONS = 2;
const MIN_SERIES_CALIBRATION_SAMPLES = DEFAULT_MIN_SERIES_SAMPLES;
const ARTIFACT_SIZE_THRESHOLD = 200 * 1024;
const ENABLE_API_MODEL = String(import.meta.env.VITE_ENABLE_FORECAST_API_AUTOML || '0') === '1';

/**
 * Race a promise against a timeout. Returns fallbackValue on timeout instead of throwing.
 */
function withTimeout(promise, ms, fallbackValue) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallbackValue), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Shared helpers imported from ../utils/dataServiceHelpers.js

const normalizeTimeBucket = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const weekMatch = raw.match(/^(\d{4})[-/ ]?W(\d{1,2})$/i);
  if (weekMatch) {
    const year = weekMatch[1];
    const week = weekMatch[2].padStart(2, '0');
    return `${year}-W${week}`;
  }

  const monthMatch = raw.match(/^(\d{4})-(\d{1,2})$/);
  if (monthMatch) {
    return `${monthMatch[1]}-${monthMatch[2].padStart(2, '0')}`;
  }

  const parsedDate = parseDateValue(value);
  if (parsedDate) {
    return toIsoDay(parsedDate);
  }

  return raw;
};

const weekPattern = /^\d{4}-W\d{2}$/i;
const monthPattern = /^\d{4}-\d{2}$/;

const bucketSortKey = (bucket) => {
  const value = String(bucket || '').trim();
  if (!value) return { rank: 9, val: '' };

  const weekMatch = value.match(/^(\d{4})-W(\d{2})$/i);
  if (weekMatch) {
    return { rank: 1, val: Number(weekMatch[1]) * 100 + Number(weekMatch[2]) };
  }

  const monthMatch = value.match(/^(\d{4})-(\d{2})$/);
  if (monthMatch) {
    return { rank: 2, val: Number(monthMatch[1]) * 100 + Number(monthMatch[2]) };
  }

  const parsed = parseDateValue(value);
  if (parsed) {
    return { rank: 3, val: parsed.getTime() };
  }

  return { rank: 4, val: value };
};

const compareBuckets = (a, b) => {
  const keyA = bucketSortKey(a);
  const keyB = bucketSortKey(b);
  if (keyA.rank !== keyB.rank) return keyA.rank - keyB.rank;
  if (typeof keyA.val === 'number' && typeof keyB.val === 'number') {
    return keyA.val - keyB.val;
  }
  return String(keyA.val).localeCompare(String(keyB.val));
};

const inferGranularity = (buckets = []) => {
  if (buckets.length === 0) return 'unknown';
  if (buckets.every((bucket) => weekPattern.test(bucket))) return 'weekly';
  if (buckets.every((bucket) => monthPattern.test(bucket))) return 'monthly';

  const parsedDates = buckets
    .map((bucket) => parseDateValue(bucket))
    .filter(Boolean)
    .sort((a, b) => a - b);

  if (parsedDates.length >= 3) {
    const diffs = [];
    for (let i = 1; i < parsedDates.length; i += 1) {
      const diffDays = Math.round((parsedDates[i].getTime() - parsedDates[i - 1].getTime()) / (24 * 60 * 60 * 1000));
      if (diffDays > 0) diffs.push(diffDays);
    }

    if (diffs.length > 0) {
      const avgDiff = diffs.reduce((sum, v) => sum + v, 0) / diffs.length;
      if (avgDiff <= 2) return 'daily';
      if (avgDiff <= 9) return 'weekly';
      if (avgDiff <= 35) return 'monthly';
    }
  }

  return 'unknown';
};

const defaultHorizonByGranularity = (granularity) => {
  if (granularity === 'daily') return 14;
  if (granularity === 'weekly') return 8;
  if (granularity === 'monthly') return 6;
  return 6;
};

const computeHoldoutSize = (n) => {
  if (n <= 4) return 1;
  if (n <= 8) return 2;
  if (n <= 12) return 3;
  if (n <= 20) return 4;
  return 6;
};

const mean = (values) => values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;

const toNumber = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const round4 = (value) => (Number.isFinite(Number(value)) ? Number(Number(value).toFixed(4)) : null);

const normalizeTargetMapping = (mapping = {}) => {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return {};

  const requiredTargets = new Set(['material_code', 'plant_id', 'demand_qty', 'time_bucket', 'week_bucket', 'date']);
  const keys = Object.keys(mapping);
  const values = Object.values(mapping).map((v) => String(v || ''));

  const keysLookLikeTarget = keys.some((key) => requiredTargets.has(key));
  if (keysLookLikeTarget) {
    return mapping;
  }

  const valuesLookLikeTarget = values.some((value) => requiredTargets.has(value));
  if (!valuesLookLikeTarget) {
    return mapping;
  }

  const inverted = {};
  Object.entries(mapping).forEach(([source, target]) => {
    if (!target) return;
    inverted[String(target)] = source;
  });
  return inverted;
};

const createBlockingError = (message, questions = []) => {
  const err = new Error(message);
  err.blockingQuestions = Array.isArray(questions) ? questions.slice(0, MAX_BLOCKING_QUESTIONS) : [];
  err.isBlocking = true;
  return err;
};

const chooseDemandDataset = (contractJson = {}) => {
  const datasets = Array.isArray(contractJson.datasets) ? contractJson.datasets : [];
  const demandCandidates = datasets
    .filter((dataset) => String(dataset.upload_type || '').toLowerCase() === 'demand_fg')
    .sort((a, b) => {
      const aPass = a?.validation?.status === 'pass' ? 1 : 0;
      const bPass = b?.validation?.status === 'pass' ? 1 : 0;
      if (aPass !== bPass) return bPass - aPass;
      return Number(b.requiredCoverage || 0) - Number(a.requiredCoverage || 0);
    });

  return demandCandidates[0] || null;
};

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

const normalizeDemandQuantity = (value) => {
  const parsed = toNumber(value);
  if (parsed === null) return null;
  if (parsed < 0) return null;
  return parsed;
};

const mapDemandRows = ({ rows, sheetName, targetMapping }) => {
  const relevantRows = getRowsForSheet(rows, sheetName);
  const mappedRows = [];
  let droppedRows = 0;

  relevantRows.forEach((row) => {
    const material = row[targetMapping.material_code];
    const plant = row[targetMapping.plant_id];
    const demandQty = normalizeDemandQuantity(row[targetMapping.demand_qty]);

    const rawTimeValue = targetMapping.time_bucket
      ? row[targetMapping.time_bucket]
      : targetMapping.week_bucket
        ? row[targetMapping.week_bucket]
        : row[targetMapping.date];
    const timeBucket = normalizeTimeBucket(rawTimeValue);

    const materialValid = validateFieldType(material, 'string').valid;
    const plantValid = validateFieldType(plant, 'string').valid;

    if (!materialValid || !plantValid || demandQty === null || !timeBucket) {
      droppedRows += 1;
      return;
    }

    mappedRows.push({
      material_code: String(material).trim(),
      plant_id: String(plant).trim(),
      demand_qty: demandQty,
      time_bucket: timeBucket
    });
  });

  return { mappedRows, droppedRows };
};

const aggregateDemandRows = (rows) => {
  const grouped = new Map();

  rows.forEach((row) => {
    const key = `${row.material_code}|${row.plant_id}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        key,
        material_code: row.material_code,
        plant_id: row.plant_id,
        buckets: new Map()
      });
    }
    const group = grouped.get(key);
    const prev = group.buckets.get(row.time_bucket) || 0;
    group.buckets.set(row.time_bucket, prev + row.demand_qty);
  });

  return Array.from(grouped.values()).map((group) => {
    const sortedBuckets = Array.from(group.buckets.keys()).sort(compareBuckets);
    const series = sortedBuckets.map((bucket) => ({
      time_bucket: bucket,
      value: Number(group.buckets.get(bucket))
    }));

    return {
      key: group.key,
      material_code: group.material_code,
      plant_id: group.plant_id,
      series
    };
  });
};

const predictNaiveLast = (history, horizon) => {
  const last = history.length ? history[history.length - 1] : 0;
  return Array.from({ length: horizon }, () => last);
};

const predictMovingAverage = (history, horizon, window = 4) => {
  if (!history.length) return Array.from({ length: horizon }, () => 0);
  const size = Math.max(1, Math.min(window, history.length));
  const avg = mean(history.slice(-size));
  return Array.from({ length: horizon }, () => avg);
};

const predictSeasonalNaive = (history, horizon, seasonLength) => {
  if (!history.length || history.length < seasonLength + 1) return null;
  const base = history.slice(-seasonLength);
  const output = [];
  for (let i = 0; i < horizon; i += 1) {
    output.push(base[i % seasonLength]);
  }
  return output;
};

const getSeasonLength = (granularity) => {
  if (granularity === 'daily') return 7;
  if (granularity === 'weekly') return 4;
  if (granularity === 'monthly') return 12;
  return 4;
};

const calcMetrics = (actual, predicted, metricName) => {
  const paired = actual
    .map((a, idx) => ({ actual: Number(a), pred: Number(predicted[idx]) }))
    .filter((item) => Number.isFinite(item.actual) && Number.isFinite(item.pred));

  if (!paired.length) {
    return { mae: null, mape: null, primary: null };
  }

  const mae = mean(paired.map((item) => Math.abs(item.actual - item.pred)));
  let mape = null;
  const nonZeroActual = paired.filter((item) => item.actual !== 0);
  if (nonZeroActual.length > 0) {
    mape = mean(nonZeroActual.map((item) => Math.abs((item.actual - item.pred) / item.actual) * 100));
  }

  const primary = metricName === 'mape' ? mape : mae;
  return { mae, mape, primary };
};

const addPeriods = (lastBucket, index, granularity) => {
  const base = String(lastBucket || '');
  if (!base) return `F+${index + 1}`;

  const weekMatch = base.match(/^(\d{4})-W(\d{2})$/i);
  if (weekMatch) {
    let year = Number(weekMatch[1]);
    let week = Number(weekMatch[2]) + index;
    while (week > 52) {
      week -= 52;
      year += 1;
    }
    return `${year}-W${String(week).padStart(2, '0')}`;
  }

  const monthMatch = base.match(/^(\d{4})-(\d{2})$/);
  if (monthMatch) {
    let year = Number(monthMatch[1]);
    let month = Number(monthMatch[2]) + index;
    while (month > 12) {
      month -= 12;
      year += 1;
    }
    return `${year}-${String(month).padStart(2, '0')}`;
  }

  const parsedDate = parseDateValue(base);
  if (parsedDate) {
    const next = new Date(parsedDate);
    if (granularity === 'monthly') {
      next.setMonth(next.getMonth() + index);
    } else if (granularity === 'weekly') {
      next.setDate(next.getDate() + (7 * index));
    } else {
      next.setDate(next.getDate() + index);
    }
    return toIsoDay(next);
  }

  return `F+${index + 1}`;
};

const toCsv = (groups = []) => {
  const header = 'sku,plant_id,date,p50,p90,actual,forecast,upper,is_forecast';
  const lines = [header];
  groups.forEach((group) => {
    group.points.forEach((point) => {
      const p50 = point.p50 ?? point.forecast ?? '';
      const p90 = point.p90 ?? point.upper ?? '';
      lines.push([
        group.material_code || group.sku || '',
        group.plant_id,
        point.time_bucket || point.date || '',
        p50,
        p90,
        point.actual ?? '',
        point.forecast ?? p50,
        point.upper ?? p90,
        point.is_forecast ? '1' : '0'
      ].join(','));
    });
  });
  return lines.join('\n');
};

const summarizeModels = (groups = []) => {
  const usage = {};
  groups.forEach((group) => {
    const model = group.selected_model || 'unknown';
    usage[model] = (usage[model] || 0) + 1;
  });
  return usage;
};

const buildRuleBasedSummary = (metrics, series) => {
  const model = metrics?.selected_model_global || 'naive_last';
  const mape = Number.isFinite(metrics?.mape) ? `${metrics.mape.toFixed(2)}%` : 'N/A';
  const mae = Number.isFinite(metrics?.mae) ? metrics.mae.toFixed(2) : 'N/A';
  const p90Coverage = Number.isFinite(metrics?.p90_coverage) ? metrics.p90_coverage.toFixed(3) : 'N/A';
  const groups = series?.total_groups || 0;
  const horizon = metrics?.horizon_periods || 0;

  return `Forecast completed: ${groups} SKU/plant series, ${horizon}-period horizon, model=${model}, MAPE=${mape}, MAE=${mae}, P90 coverage=${p90Coverage}.`;
};

const getForecastTemplateQualityDelta = (metrics = {}) => {
  const mape = Number(metrics?.mape);
  if (Number.isFinite(mape)) {
    if (mape <= 20) return 0.1;
    if (mape <= 35) return 0.07;
    if (mape <= 50) return 0.04;
    return 0.02;
  }

  const mae = Number(metrics?.mae);
  if (Number.isFinite(mae)) {
    return mae <= 10 ? 0.06 : 0.03;
  }

  return 0.02;
};

async function predictWithModel({ modelName, history, horizon, granularity, materialCode }) {
  if (modelName === 'naive_last') return predictNaiveLast(history, horizon);
  if (modelName === 'moving_average') return predictMovingAverage(history, horizon, 4);
  if (modelName === 'seasonal_naive') {
    return predictSeasonalNaive(history, horizon, getSeasonLength(granularity));
  }

  if (modelName === 'lightgbm_api') {
    const response = await forecastApiClient.demandForecast({
      materialCode,
      history,
      horizonDays: horizon,
      modelType: 'lightgbm',
      includeComparison: false
    }, { timeoutMs: 10000 });

    const predictions = response?.forecast?.predictions;
    if (Array.isArray(predictions) && predictions.length >= horizon) {
      return predictions.slice(0, horizon).map((v) => Number(v) || 0);
    }
    return null;
  }

  return null;
}

async function evaluateCandidates({ history, holdout, granularity, materialCode, metricName }) {
  const train = history.slice(0, history.length - holdout);
  const test = history.slice(history.length - holdout);
  const candidates = ['naive_last', 'moving_average', 'seasonal_naive'];
  if (ENABLE_API_MODEL && forecastApiClient.isConfigured() && train.length >= 10) {
    candidates.push('lightgbm_api');
  }

  const evaluations = [];
  for (const modelName of candidates) {
    try {
      const preds = await predictWithModel({
        modelName,
        history: train,
        horizon: holdout,
        granularity,
        materialCode
      });
      if (!Array.isArray(preds) || preds.length < holdout) {
        continue;
      }

      const metrics = calcMetrics(test, preds, metricName);
      if (!Number.isFinite(metrics.primary)) continue;

      evaluations.push({
        model: modelName,
        metric_name: metricName,
        metric_value: metrics.primary,
        mae: metrics.mae,
        mape: metrics.mape,
        predictions: preds
      });
    } catch (error) {
      // Ignore unavailable model candidates and continue deterministic fallback.
      if (modelName !== 'lightgbm_api') {
        // Local candidates should not fail, but keep resilient.
        console.warn(`[chatForecastService] Candidate ${modelName} failed:`, error.message);
      }
    }
  }

  return evaluations.sort((a, b) => a.metric_value - b.metric_value);
}

export async function runForecastFromDatasetProfile({
  userId,
  datasetProfileRow,
  horizonPeriods = null,
  settings = {}
}) {
  if (!userId) throw new Error('userId is required');
  if (!datasetProfileRow?.id) throw new Error('datasetProfileRow is required');

  const profileJson = datasetProfileRow.profile_json || {};
  const contractJson = datasetProfileRow.contract_json || {};
  const workflowLabel = profileJson?.global?.workflow_guess?.label;
  const workflow = workflowLabel === 'A' ? 'workflow_A_replenishment' : `workflow_${workflowLabel || 'unknown'}`;

  const localRunFallback = {
    id: `local-run-${Date.now()}`,
    user_id: userId,
    dataset_profile_id: datasetProfileRow.id,
    workflow,
    stage: 'forecast',
    status: 'running',
    started_at: new Date().toISOString(),
    _local: true,
  };
  console.log('[chatForecastService] Starting forecast, creating run...');
  const run = await withTimeout(
    diRunsService.createRun({
      user_id: userId,
      dataset_profile_id: datasetProfileRow.id,
      workflow,
      stage: 'forecast'
    }).catch(() => localRunFallback),
    8000,
    localRunFallback
  );
  console.log('[chatForecastService] Run created:', run.id, run._local ? '(local)' : '(remote)');

  await withTimeout(
    diRunsService.updateRunStatus({
      run_id: run.id,
      status: 'running',
      started_at: new Date().toISOString()
    }).catch(() => null),
    5000,
    null
  );
  console.log('[chatForecastService] Run status updated to running');

  try {
    const demandDataset = chooseDemandDataset(contractJson);
    console.log('[chatForecastService] demandDataset:', demandDataset ? demandDataset.sheet_name : 'null',
      'validation:', demandDataset?.validation?.status);
    if (!demandDataset) {
      throw createBlockingError('No demand_fg dataset was found in schema contract.', [
        'Please upload or map at least one sheet as demand_fg.',
        'Then re-run forecast from the Data Summary Card.'
      ]);
    }

    if (demandDataset.validation?.status === 'fail') {
      const missing = Array.isArray(demandDataset.missing_required_fields)
        ? demandDataset.missing_required_fields.join(', ')
        : 'required fields';
      throw createBlockingError(`Demand mapping is incomplete: ${missing}.`, [
        `Please map missing fields: ${missing}.`,
        'After mapping, run forecast again.'
      ]);
    }

    let rawRows = [];
    if (Array.isArray(datasetProfileRow._inlineRawRows) && datasetProfileRow._inlineRawRows.length > 0) {
      rawRows = datasetProfileRow._inlineRawRows;
      console.log('[chatForecastService] Using inline raw rows:', rawRows.length);
    } else if (datasetProfileRow.user_file_id) {
      console.log('[chatForecastService] Fetching file:', datasetProfileRow.user_file_id);
      const fileRecord = await withTimeout(
        userFilesService.getFileById(userId, datasetProfileRow.user_file_id),
        10000,
        null
      );
      rawRows = fileRecord ? normalizeRowsFromUserFile(fileRecord) : [];
    } else {
      console.log('[chatForecastService] No inline rows and no user_file_id');
    }
    if (rawRows.length === 0) {
      throw createBlockingError('No source rows were found for this dataset profile.', [
        'Please re-upload the source file and retry forecast.'
      ]);
    }

    const mapping = normalizeTargetMapping(demandDataset.mapping || {});
    console.log('[chatForecastService] Mapping:', JSON.stringify(mapping).slice(0, 200));
    const missingMappingFields = ['material_code', 'plant_id', 'demand_qty']
      .filter((field) => !mapping[field]);
    const hasTimeMapping = Boolean(mapping.time_bucket || mapping.week_bucket || mapping.date);
    if (missingMappingFields.length > 0 || !hasTimeMapping) {
      const timeNote = hasTimeMapping ? null : 'time_bucket/date/week_bucket';
      throw createBlockingError('Demand mapping does not contain all required forecasting columns.', [
        `Please map required fields: ${[...missingMappingFields, timeNote].filter(Boolean).join(', ')}.`,
        'Then run forecast again.'
      ]);
    }

    console.log('[chatForecastService] Mapping demand rows from', rawRows.length, 'raw rows, sheet:', demandDataset.sheet_name);
    const { mappedRows, droppedRows } = mapDemandRows({
      rows: rawRows,
      sheetName: demandDataset.sheet_name,
      targetMapping: mapping
    });

    if (mappedRows.length < 8) {
      throw createBlockingError(`Insufficient clean demand rows for forecasting (usable rows: ${mappedRows.length}).`, [
        'Please verify demand_qty and time bucket columns are mapped correctly.',
        'Need at least 8 clean rows for stable forecasting.'
      ]);
    }

    console.log('[chatForecastService] mappedRows:', mappedRows.length, 'droppedRows:', droppedRows);

    let groupedSeries = aggregateDemandRows(mappedRows);
    groupedSeries = groupedSeries
      .filter((group) => group.series.length >= 3)
      .map((group) => ({
        ...group,
        total_demand: group.series.reduce((sum, point) => sum + (Number(point.value) || 0), 0)
      }))
      .sort((a, b) => b.total_demand - a.total_demand);

    console.log('[chatForecastService] groupedSeries:', groupedSeries.length, 'groups (≥3 points each)');
    if (groupedSeries.length === 0) {
      throw createBlockingError('No valid SKU/plant demand series were available after validation.', [
        'Check that material_code, plant_id, time bucket, and demand_qty contain valid values.'
      ]);
    }

    const truncated = groupedSeries.length > MAX_GROUPS_IN_ARTIFACT;
    const selectedGroups = groupedSeries.slice(0, MAX_GROUPS_IN_ARTIFACT);

    const allBuckets = selectedGroups.flatMap((group) => group.series.map((point) => point.time_bucket));
    const inferredGranularity = inferGranularity(allBuckets);
    const horizon = Number.isFinite(horizonPeriods) && horizonPeriods > 0
      ? Math.floor(horizonPeriods)
      : defaultHorizonByGranularity(inferredGranularity);

    console.log('[chatForecastService] Starting forecast computation, granularity:', inferredGranularity, 'horizon:', horizon, 'groups:', selectedGroups.length);
    const forecastGroups = [];
    const backtestRowsForCalibration = [];
    for (const group of selectedGroups) {
      const buckets = group.series.map((point) => point.time_bucket).sort(compareBuckets);
      const valuesByBucket = new Map(group.series.map((point) => [point.time_bucket, Number(point.value) || 0]));
      const historyValues = buckets.map((bucket) => valuesByBucket.get(bucket) || 0);
      const holdout = Math.min(computeHoldoutSize(historyValues.length), Math.max(1, historyValues.length - 2));
      const metricName = historyValues.slice(-holdout).some((v) => v !== 0) ? 'mape' : 'mae';

      const evaluations = historyValues.length >= 4
        ? await evaluateCandidates({
            history: historyValues,
            holdout,
            granularity: inferredGranularity,
            materialCode: group.material_code,
            metricName
          })
        : [];

      const bestEval = evaluations[0] || null;
      const selectedModel = bestEval?.model || 'naive_last';
      let futurePredictions = await predictWithModel({
        modelName: selectedModel,
        history: historyValues,
        horizon,
        granularity: inferredGranularity,
        materialCode: group.material_code
      });
      if (!Array.isArray(futurePredictions) || futurePredictions.length < horizon) {
        futurePredictions = predictNaiveLast(historyValues, horizon);
      }

      const holdoutStartIndex = historyValues.length - holdout;
      const p50BacktestByBucket = new Map();
      if (Array.isArray(bestEval?.predictions)) {
        bestEval.predictions.slice(0, holdout).forEach((prediction, idx) => {
          const p50Pred = toNumber(prediction);
          const bucketIndex = holdoutStartIndex + idx;
          const bucket = buckets[bucketIndex];
          if (p50Pred === null || !bucket) return;

          const safeP50Pred = Math.max(0, p50Pred);
          p50BacktestByBucket.set(bucket, safeP50Pred);

          const actual = toNumber(valuesByBucket.get(bucket));
          if (actual === null) return;
          backtestRowsForCalibration.push({
            series_key: group.key,
            actual,
            p50_pred: safeP50Pred
          });
        });
      }

      const historyTail = buckets.slice(-MAX_HISTORY_POINTS);
      const historyPoints = historyTail.map((bucket) => toCanonicalForecastPoint({
        time_bucket: bucket,
        actual: Number(valuesByBucket.get(bucket) || 0),
        p50: p50BacktestByBucket.has(bucket) ? p50BacktestByBucket.get(bucket) : null,
        p90: null,
        p10: null,
        is_forecast: p50BacktestByBucket.has(bucket)
      }));

      const lastBucket = buckets[buckets.length - 1];
      const futurePoints = futurePredictions.map((prediction, idx) => toCanonicalForecastPoint({
        time_bucket: addPeriods(lastBucket, idx + 1, inferredGranularity),
        actual: null,
        p50: Math.max(0, Number(prediction) || 0),
        p90: null,
        p10: null,
        is_forecast: true
      }));

      forecastGroups.push({
        key: group.key,
        material_code: group.material_code,
        plant_id: group.plant_id,
        selected_model: selectedModel,
        backtest_metric_name: bestEval?.metric_name || metricName,
        backtest_metric_value: Number.isFinite(bestEval?.metric_value) ? Number(bestEval.metric_value.toFixed(4)) : null,
        mape: Number.isFinite(bestEval?.mape) ? Number(bestEval.mape.toFixed(4)) : null,
        mae: Number.isFinite(bestEval?.mae) ? Number(bestEval.mae.toFixed(4)) : null,
        candidate_scores: evaluations.map((item) => ({
          model: item.model,
          metric_name: item.metric_name,
          metric_value: Number(item.metric_value.toFixed(4))
        })),
        points: [...historyPoints, ...futurePoints]
      });
    }

    const calibration = buildQuantileCalibration({
      backtestRows: backtestRowsForCalibration,
      minSeriesSamples: MIN_SERIES_CALIBRATION_SAMPLES
    });
    const coverageMetrics = computeCalibrationMetrics({
      backtestRows: backtestRowsForCalibration,
      calibration
    });

    const calibratedForecastGroups = forecastGroups.map((group) => ({
      ...group,
      points: (Array.isArray(group.points) ? group.points : []).map((point) => {
        const pointP50 = toNumber(point?.p50 ?? point?.forecast);
        if (pointP50 === null) {
          return {
            ...point,
            p50: null,
            p90: null,
            forecast: null,
            upper: null,
            p10: null,
            lower: null
          };
        }

        const calibratedPoint = applyCalibratedQuantiles({
          p50: pointP50,
          seriesKey: group.key,
          calibration
        });

        return {
          ...point,
          p50: round4(calibratedPoint.p50),
          p90: round4(calibratedPoint.p90),
          forecast: round4(calibratedPoint.forecast),
          upper: round4(calibratedPoint.upper),
          p10: round4(calibratedPoint.p10),
          lower: round4(calibratedPoint.lower)
        };
      })
    }));

    const usage = summarizeModels(calibratedForecastGroups);
    const selectedModelGlobal = Object.entries(usage).sort((a, b) => b[1] - a[1])[0]?.[0] || 'naive_last';
    const mapeValues = calibratedForecastGroups.map((group) => group.mape).filter((v) => Number.isFinite(v));
    const maeValues = calibratedForecastGroups.map((group) => group.mae).filter((v) => Number.isFinite(v));
    const metricName = mapeValues.length > 0 ? 'mape' : 'mae';

    const forecastSeriesArtifact = {
      generated_at: new Date().toISOString(),
      horizon_periods: horizon,
      granularity: inferredGranularity,
      total_groups: groupedSeries.length,
      groups: calibratedForecastGroups,
      truncated_groups: truncated
    };

    const metricsArtifact = {
      metric_name: metricName,
      mape: mapeValues.length > 0 ? Number(mean(mapeValues).toFixed(4)) : null,
      mae: maeValues.length > 0 ? Number(mean(maeValues).toFixed(4)) : null,
      p50_mape: mapeValues.length > 0 ? Number(mean(mapeValues).toFixed(4)) : null,
      p50_mae: maeValues.length > 0 ? Number(mean(maeValues).toFixed(4)) : null,
      p90_coverage: coverageMetrics.p90_coverage,
      p90_pinball_loss: coverageMetrics.p90_pinball_loss,
      calibration_method: CALIBRATION_METHOD,
      calibration_scope: calibration.calibration_scope,
      calibration_sample_size: coverageMetrics.coverage_samples,
      calibration_min_series_samples: MIN_SERIES_CALIBRATION_SAMPLES,
      selected_model_global: selectedModelGlobal,
      model_usage: usage,
      groups_processed: calibratedForecastGroups.length,
      rows_used: mappedRows.length,
      dropped_rows: droppedRows,
      horizon_periods: horizon,
      granularity: inferredGranularity
    };

    const reportArtifact = {
      dataset_profile_id: datasetProfileRow.id,
      workflow,
      stage: 'forecast',
      demand_sheet_name: demandDataset.sheet_name,
      probabilistic_forecasting: {
        p50_field: 'p50',
        p90_field: 'p90',
        forecast_alias: 'forecast=p50',
        calibration_method: metricsArtifact.calibration_method,
        calibration_scope: metricsArtifact.calibration_scope,
        min_series_samples: MIN_SERIES_CALIBRATION_SAMPLES,
        p90_coverage: metricsArtifact.p90_coverage,
        coverage_samples: metricsArtifact.calibration_sample_size
      },
      evidence: {
        groups_processed: calibratedForecastGroups.length,
        rows_used: mappedRows.length,
        dropped_rows: droppedRows,
        horizon_periods: horizon,
        metric_name: metricsArtifact.metric_name,
        mape: metricsArtifact.mape,
        mae: metricsArtifact.mae,
        p90_coverage: metricsArtifact.p90_coverage,
        calibration_method: metricsArtifact.calibration_method,
        calibration_scope: metricsArtifact.calibration_scope,
        selected_model_global: metricsArtifact.selected_model_global,
        model_usage: metricsArtifact.model_usage
      }
    };

    console.log('[chatForecastService] Forecast computation done, saving artifacts...');
    const localArtifactRef = (artifactType) => ({
      storage: 'local',
      artifact_id: null,
      run_id: run.id,
      artifact_type: artifactType,
      size_bytes: 0,
      content_type: 'application/json'
    });

    const artifactRefs = {};
    const forecastSaved = await withTimeout(
      saveJsonArtifact(run.id, 'forecast_series', forecastSeriesArtifact, ARTIFACT_SIZE_THRESHOLD, {
        user_id: userId,
        filename: `forecast_series_run_${run.id}.json`
      }).catch(() => ({ artifact: null, ref: localArtifactRef('forecast_series') })),
      10000,
      { artifact: null, ref: localArtifactRef('forecast_series') }
    );
    artifactRefs.forecast_series = forecastSaved.ref;

    const metricsSaved = await withTimeout(
      saveJsonArtifact(run.id, 'metrics', metricsArtifact, ARTIFACT_SIZE_THRESHOLD, {
        user_id: userId,
        filename: `forecast_metrics_run_${run.id}.json`
      }).catch(() => ({ artifact: null, ref: localArtifactRef('metrics') })),
      10000,
      { artifact: null, ref: localArtifactRef('metrics') }
    );
    artifactRefs.metrics = metricsSaved.ref;

    const reportSaved = await withTimeout(
      saveJsonArtifact(run.id, 'report_json', reportArtifact, ARTIFACT_SIZE_THRESHOLD, {
        user_id: userId,
        filename: `forecast_report_run_${run.id}.json`
      }).catch(() => ({ artifact: null, ref: localArtifactRef('report_json') })),
      10000,
      { artifact: null, ref: localArtifactRef('report_json') }
    );
    artifactRefs.report_json = reportSaved.ref;

    const csvContent = toCsv(calibratedForecastGroups);
    const inlineCsv = csvContent.length <= 100000 ? csvContent : '';
    if (csvContent) {
      const csvSaved = await withTimeout(
        saveCsvArtifact(run.id, 'forecast_csv', csvContent, `forecast_run_${run.id}.csv`, ARTIFACT_SIZE_THRESHOLD, {
          user_id: userId
        }).catch(() => ({ artifact: null, ref: localArtifactRef('forecast_csv') })),
        10000,
        { artifact: null, ref: localArtifactRef('forecast_csv') }
      );
      artifactRefs.forecast_csv = csvSaved.ref;
    }

    const succeededRun = { ...run, status: 'succeeded', finished_at: new Date().toISOString() };
    const updatedRun = await withTimeout(
      diRunsService.updateRunStatus({
        run_id: run.id,
        status: 'succeeded',
        finished_at: new Date().toISOString(),
        error: null
      }).catch(() => succeededRun),
      5000,
      succeededRun
    );

    if (datasetProfileRow?.fingerprint) {
      const settingsPayload = {
        forecast: {
          horizon_periods: horizon,
          granularity: inferredGranularity,
          metric_name: metricsArtifact.metric_name,
          selected_model_global: metricsArtifact.selected_model_global || null
        },
        reuse_enabled: settings?.reuse_enabled !== false,
        force_retrain: Boolean(settings?.force_retrain)
      };
      reuseMemoryService.upsertRunSettingsTemplate({
        user_id: userId,
        fingerprint: datasetProfileRow.fingerprint,
        workflow,
        settings_json: settingsPayload,
        quality_delta: getForecastTemplateQualityDelta(metricsArtifact)
      }).catch((error) => {
        console.warn('[chatForecastService] Failed to update run settings template:', error.message);
      });
    }

    console.log('[chatForecastService] Forecast complete! Returning result.');
    return {
      run: updatedRun,
      forecast_series: forecastSeriesArtifact,
      metrics: metricsArtifact,
      report_json: reportArtifact,
      csv: inlineCsv,
      artifact_refs: artifactRefs,
      summary_text: buildRuleBasedSummary(metricsArtifact, forecastSeriesArtifact)
    };
  } catch (error) {
    await withTimeout(
      diRunsService.updateRunStatus({
        run_id: run.id,
        status: 'failed',
        finished_at: new Date().toISOString(),
        error: error.message || 'Forecast failed'
      }).catch(() => {}),
      5000,
      null
    );
    // Preserve run id for UI error card rendering.
    error.run_id = run.id;
    throw error;
  }
}

export function buildForecastCardPayload(forecastResult, datasetProfileRow) {
  const artifactRefs = forecastResult?.artifact_refs || {};
  return {
    run_id: forecastResult?.run?.id || null,
    dataset_profile_id: datasetProfileRow?.id || null,
    workflow: forecastResult?.run?.workflow || 'workflow_unknown',
    stage: 'forecast',
    status: forecastResult?.run?.status || 'succeeded',
    time_range_guess: datasetProfileRow?.profile_json?.global?.time_range_guess || null,
    metrics: forecastResult?.metrics || {},
    series_groups: forecastResult?.forecast_series?.groups || [],
    total_groups: forecastResult?.forecast_series?.total_groups || 0,
    truncated_groups: Boolean(forecastResult?.forecast_series?.truncated_groups),
    forecast_series_json: forecastResult?.forecast_series || {},
    metrics_json: forecastResult?.metrics || {},
    report_json: forecastResult?.report_json || {},
    forecast_csv: forecastResult?.csv || '',
    forecast_series_ref: artifactRefs.forecast_series || null,
    metrics_ref: artifactRefs.metrics || null,
    report_ref: artifactRefs.report_json || null,
    forecast_csv_ref: artifactRefs.forecast_csv || null
  };
}

export default {
  runForecastFromDatasetProfile,
  buildForecastCardPayload
};
