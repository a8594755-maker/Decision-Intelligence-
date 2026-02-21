import { userFilesService } from './supabaseClient';
import { computeRiskScores } from '../risk/riskScoring';
import { buildExceptions } from '../risk/exceptionBuilder';
import { buildSupplierStats } from '../domains/supply/supplyForecastEngine';
import { batchComputePODelayProbabilities } from '../domains/supply/poDelayProbability';

const MAX_BLOCKING_QUESTIONS = 2;
const MAX_CARD_ROWS = 12;

const normalizeText = (value) => String(value || '').trim();
const normalizeSheetName = (value) => normalizeText(value).toLowerCase();

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

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const toIsoDay = (dateObj) => (
  dateObj && !Number.isNaN(dateObj.getTime()) ? dateObj.toISOString().slice(0, 10) : null
);

const createBlockingError = (message, questions = []) => {
  const error = new Error(message);
  error.blockingQuestions = Array.isArray(questions)
    ? questions.slice(0, MAX_BLOCKING_QUESTIONS)
    : [];
  error.isBlocking = true;
  return error;
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

const normalizeTargetMapping = (mapping = {}) => {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return {};

  const knownTargets = new Set([
    'supplier',
    'supplier_name',
    'supplier_code',
    'supplier_id',
    'material_code',
    'plant_id',
    'order_date',
    'promised_date',
    'planned_delivery_date',
    'actual_delivery_date',
    'receipt_date',
    'date',
    'week_bucket',
    'time_bucket',
    'open_qty',
    'received_qty',
    'po_number'
  ]);

  const keys = Object.keys(mapping).map((key) => normalizeText(key));
  const values = Object.values(mapping).map((value) => normalizeText(value));

  const keysLookLikeTargets = keys.some((key) => knownTargets.has(key));
  if (keysLookLikeTargets) {
    return mapping;
  }

  const valuesLookLikeTargets = values.some((value) => knownTargets.has(value));
  if (!valuesLookLikeTargets) {
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

const resolveColumnByHints = (columns = [], hints = []) => {
  for (const column of columns) {
    const normalized = normalizeText(column).toLowerCase();
    if (!normalized) continue;
    if (hints.some((pattern) => pattern.test(normalized))) {
      return column;
    }
  }
  return null;
};

const resolveMappedColumn = ({
  mapping = {},
  rows = [],
  targetCandidates = [],
  headerHints = []
}) => {
  for (const target of targetCandidates) {
    if (mapping[target]) return mapping[target];
  }

  const columns = rows.length > 0
    ? Object.keys(rows[0] || {}).filter((key) => key !== '__sheet_name')
    : [];

  return resolveColumnByHints(columns, headerHints);
};

const dateFromRow = (row, sourceField) => {
  if (!sourceField) return null;
  return toIsoDay(parseDateValue(row[sourceField]));
};

const buildPromiseIndex = (poRows = []) => {
  const index = new Map();
  poRows.forEach((row) => {
    if (!row.promised_date) return;
    const key = `${row.supplier}|${row.material_code}|${row.plant_id || ''}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(row.promised_date);
  });

  index.forEach((dates, key) => {
    index.set(key, Array.from(new Set(dates)).sort((a, b) => a.localeCompare(b)));
  });

  return index;
};

const findClosestPromisedDate = (promisedDates = [], actualDate) => {
  if (!Array.isArray(promisedDates) || promisedDates.length === 0 || !actualDate) return null;
  const actual = parseDateValue(actualDate);
  if (!actual) return promisedDates[0] || null;

  let best = promisedDates[0];
  let bestDistance = Number.POSITIVE_INFINITY;

  promisedDates.forEach((candidate) => {
    const date = parseDateValue(candidate);
    if (!date) return;
    const distance = Math.abs(date.getTime() - actual.getTime());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  });

  return best;
};

const mapPoRows = ({ rows, sheetName, mapping }) => {
  const relevantRows = getRowsForSheet(rows, sheetName);
  const supplierField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['supplier', 'supplier_name', 'supplier_code', 'supplier_id'],
    headerHints: [/supplier/, /vendor/]
  });
  const materialField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['material_code'],
    headerHints: [/material/, /sku/, /item/, /part/]
  });
  const plantField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['plant_id'],
    headerHints: [/plant/, /site/, /warehouse/, /location/]
  });
  const orderDateField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['order_date'],
    headerHints: [/order.*date/, /po.*date/]
  });
  const promisedDateField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['promised_date', 'planned_delivery_date', 'date', 'time_bucket', 'week_bucket'],
    headerHints: [/promise/, /planned.*delivery/, /due.*date/, /eta/, /date/, /week/, /bucket/]
  });
  const openQtyField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['open_qty'],
    headerHints: [/open.*qty/, /remaining.*qty/, /balance.*qty/, /\bqty\b/]
  });

  const mapped = [];
  let dropped = 0;
  let missingSupplierRows = 0;

  relevantRows.forEach((row) => {
    const supplier = normalizeText(row[supplierField]);
    const materialCode = normalizeText(row[materialField]);
    const plantId = normalizeText(row[plantField]) || null;
    const openQty = Math.max(0, toNumber(row[openQtyField], NaN));

    if (!supplier) missingSupplierRows += 1;
    if (!materialCode || !Number.isFinite(openQty) || openQty <= 0) {
      dropped += 1;
      return;
    }

    const orderDate = dateFromRow(row, orderDateField);
    const promisedDate = dateFromRow(row, promisedDateField);
    mapped.push({
      supplier: supplier || 'unknown_supplier',
      material_code: materialCode,
      plant_id: plantId,
      order_date: orderDate,
      promised_date: promisedDate,
      open_qty: openQty
    });
  });

  mapped.sort((a, b) => {
    if (a.supplier !== b.supplier) return a.supplier.localeCompare(b.supplier);
    if (a.material_code !== b.material_code) return a.material_code.localeCompare(b.material_code);
    if ((a.plant_id || '') !== (b.plant_id || '')) return (a.plant_id || '').localeCompare(b.plant_id || '');
    return (a.promised_date || '').localeCompare(b.promised_date || '');
  });

  return {
    rows: mapped,
    dropped,
    missing_supplier_rows: missingSupplierRows,
    fields: {
      supplierField,
      materialField,
      plantField,
      orderDateField,
      promisedDateField,
      openQtyField
    }
  };
};

const mapReceiptRows = ({ rows, sheetName, mapping, poPromiseIndex }) => {
  const relevantRows = getRowsForSheet(rows, sheetName);
  const supplierField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['supplier', 'supplier_name', 'supplier_code', 'supplier_id'],
    headerHints: [/supplier/, /vendor/]
  });
  const materialField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['material_code'],
    headerHints: [/material/, /sku/, /item/, /part/]
  });
  const plantField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['plant_id'],
    headerHints: [/plant/, /site/, /warehouse/, /location/]
  });
  const actualDateField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['actual_delivery_date', 'receipt_date', 'date', 'time_bucket', 'week_bucket'],
    headerHints: [/actual.*delivery/, /receipt.*date/, /delivery.*date/, /date/, /week/, /bucket/]
  });
  const promisedDateField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['planned_delivery_date', 'promised_date'],
    headerHints: [/planned.*delivery/, /promis/, /due.*date/, /eta/]
  });
  const receivedQtyField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['received_qty'],
    headerHints: [/received.*qty/, /receipt.*qty/, /gr.*qty/, /\bqty\b/]
  });

  const mapped = [];
  let dropped = 0;
  let missingSupplierRows = 0;

  relevantRows.forEach((row) => {
    const supplier = normalizeText(row[supplierField]);
    const materialCode = normalizeText(row[materialField]);
    const plantId = normalizeText(row[plantField]) || null;
    const actualDate = dateFromRow(row, actualDateField);
    const receivedQty = Math.max(0, toNumber(row[receivedQtyField], NaN));

    if (!supplier) missingSupplierRows += 1;
    if (!materialCode || !actualDate || !Number.isFinite(receivedQty) || receivedQty <= 0) {
      dropped += 1;
      return;
    }

    const promisedDateRaw = dateFromRow(row, promisedDateField);
    const key = `${supplier || 'unknown_supplier'}|${materialCode}|${plantId || ''}`;
    const promisedDate = promisedDateRaw || findClosestPromisedDate(poPromiseIndex.get(key) || [], actualDate);

    mapped.push({
      supplier: supplier || 'unknown_supplier',
      material_code: materialCode,
      plant_id: plantId,
      actual_delivery_date: actualDate,
      promised_date: promisedDate,
      received_qty: receivedQty
    });
  });

  mapped.sort((a, b) => {
    if (a.supplier !== b.supplier) return a.supplier.localeCompare(b.supplier);
    if (a.material_code !== b.material_code) return a.material_code.localeCompare(b.material_code);
    if ((a.plant_id || '') !== (b.plant_id || '')) return (a.plant_id || '').localeCompare(b.plant_id || '');
    return (a.actual_delivery_date || '').localeCompare(b.actual_delivery_date || '');
  });

  return {
    rows: mapped,
    dropped,
    missing_supplier_rows: missingSupplierRows,
    fields: {
      supplierField,
      materialField,
      plantField,
      actualDateField,
      promisedDateField,
      receivedQtyField
    }
  };
};

const countRowsMissingField = (rows, field) => (
  rows.reduce((sum, row) => (normalizeText(row[field]) ? sum : sum + 1), 0)
);

export async function computeRiskArtifactsFromDatasetProfile({
  userId,
  datasetProfileRow
}) {
  if (!userId) throw new Error('userId is required');
  if (!datasetProfileRow?.id) throw new Error('datasetProfileRow is required');
  if (!datasetProfileRow.user_file_id) {
    throw createBlockingError('Dataset profile has no linked source file.', [
      'Re-upload PO and goods receipt data from chat.'
    ]);
  }

  const fileRecord = await userFilesService.getFileById(userId, datasetProfileRow.user_file_id);
  const sourceRows = normalizeRowsFromUserFile(fileRecord);
  if (sourceRows.length === 0) {
    throw createBlockingError('Source rows are unavailable for this dataset profile.', [
      'Re-upload source sheets and regenerate profile.'
    ]);
  }

  const contractJson = datasetProfileRow.contract_json || {};
  const poDataset = chooseDatasetByType(contractJson, 'po_open_lines');
  const receiptDataset = chooseDatasetByType(contractJson, 'goods_receipt');

  if (!poDataset || !receiptDataset) {
    throw createBlockingError('Workflow B requires both po_open_lines and goods_receipt datasets.', [
      'Upload/map one po_open_lines sheet.',
      'Upload/map one goods_receipt sheet.'
    ]);
  }

  const poMapping = normalizeTargetMapping(poDataset.mapping || {});
  const receiptMapping = normalizeTargetMapping(receiptDataset.mapping || {});

  const poMapped = mapPoRows({
    rows: sourceRows,
    sheetName: poDataset.sheet_name,
    mapping: poMapping
  });

  if (poMapped.rows.length === 0) {
    throw createBlockingError('No clean PO open-line rows after mapping validation.', [
      'Map material_code, open_qty, and promised/date field for po_open_lines.'
    ]);
  }

  const poPromiseIndex = buildPromiseIndex(poMapped.rows);
  const receiptMapped = mapReceiptRows({
    rows: sourceRows,
    sheetName: receiptDataset.sheet_name,
    mapping: receiptMapping,
    poPromiseIndex
  });

  if (receiptMapped.rows.length === 0) {
    throw createBlockingError('No clean goods receipt rows after mapping validation.', [
      'Map material_code, actual_delivery_date, and received_qty for goods_receipt.'
    ]);
  }

  const receiptRowsWithoutPromised = countRowsMissingField(receiptMapped.rows, 'promised_date');
  if (receiptRowsWithoutPromised === receiptMapped.rows.length && poPromiseIndex.size === 0) {
    throw createBlockingError('Unable to infer promised dates for delay computation.', [
      'Map promised/planned delivery date in po_open_lines or goods_receipt.'
    ]);
  }

  const riskResult = computeRiskScores({
    po_open_lines: poMapped.rows,
    goods_receipt: receiptMapped.rows
  });

  if (!Array.isArray(riskResult.risk_scores) || riskResult.risk_scores.length === 0) {
    throw new Error('Risk scoring produced no entities.');
  }

  const dataQuality = {
    po_rows_mapped: poMapped.rows.length,
    po_rows_dropped: poMapped.dropped,
    receipt_rows_mapped: receiptMapped.rows.length,
    receipt_rows_dropped: receiptMapped.dropped,
    po_missing_supplier_rows: poMapped.missing_supplier_rows,
    receipt_missing_supplier_rows: receiptMapped.missing_supplier_rows,
    receipt_missing_promised_rows: receiptRowsWithoutPromised
  };

  // PO Delay Probability computation (Module E)
  const supplierStatsResult = buildSupplierStats(receiptMapped.rows, {
    fallbackLeadTimeDays: 14,
    historyWindowDays: 90,
    minSampleSize: 3,
  });

  const poDelayResult = batchComputePODelayProbabilities({
    poOpenLines: poMapped.rows,
    supplierStats: supplierStatsResult.supplierStats,
    riskScores: riskResult.risk_scores,
    nowDate: new Date().toISOString().slice(0, 10),
  });

  return {
    po_rows: poMapped.rows,
    receipt_rows: receiptMapped.rows,
    risk_scores: riskResult.risk_scores,
    po_delay_result: poDelayResult,
    supplier_stats: supplierStatsResult.supplierStats,
    supporting_metrics: {
      ...(riskResult.supporting_metrics || {}),
      data_quality: dataQuality,
      contract_dataset_refs: {
        po_open_lines: poDataset.sheet_name,
        goods_receipt: receiptDataset.sheet_name
      }
    }
  };
}

const topByType = (riskScores, entityType, limit = 8) => {
  return riskScores
    .filter((row) => row.entity_type === entityType)
    .slice(0, limit);
};

export function buildRiskSummaryCardPayload({
  run,
  datasetProfileRow,
  risk_scores = [],
  supporting_metrics = {}
}) {
  const rows = Array.isArray(risk_scores) ? risk_scores : [];
  return {
    run_id: run?.id || null,
    dataset_profile_id: datasetProfileRow?.id || null,
    workflow: run?.workflow || 'workflow_B_risk_exceptions',
    totals: {
      entities: rows.length,
      high_risk: rows.filter((item) => Number(item.risk_score || 0) >= 70).length,
      medium_risk: rows.filter((item) => Number(item.risk_score || 0) >= 55 && Number(item.risk_score || 0) < 70).length
    },
    top_supplier_risks: topByType(rows, 'supplier', MAX_CARD_ROWS),
    top_material_risks: topByType(rows, 'material', MAX_CARD_ROWS),
    metrics_summary: supporting_metrics?.aggregates || {},
    data_quality: supporting_metrics?.data_quality || {}
  };
}

export function buildRiskDrilldownCardPayload({
  run,
  risk_scores = [],
  supporting_metrics = {}
}) {
  const rows = Array.isArray(risk_scores) ? risk_scores : [];
  return {
    run_id: run?.id || null,
    items: rows.slice(0, 40).map((item) => ({
      entity_type: item.entity_type,
      entity_id: item.entity_id,
      supplier: item.supplier,
      material_code: item.material_code,
      plant_id: item.plant_id,
      risk_score: item.risk_score,
      drivers: item.drivers || [],
      metrics: item.metrics || {},
      evidence_refs: item.evidence_refs || []
    })),
    data_quality: supporting_metrics?.data_quality || {}
  };
}

export function buildRiskExceptionsArtifacts({
  risk_scores = []
}) {
  const result = buildExceptions({
    risk_scores,
    max_exceptions: 150
  });
  return {
    exceptions: result.exceptions || [],
    aggregates: result.aggregates || {}
  };
}

export function buildRiskExceptionsCardPayload({ run, exceptionsArtifact }) {
  return {
    run_id: run?.id || null,
    exceptions: Array.isArray(exceptionsArtifact?.exceptions) ? exceptionsArtifact.exceptions : [],
    aggregates: exceptionsArtifact?.aggregates || {}
  };
}

export function buildRiskReportJson({
  risk_scores = [],
  exceptions = [],
  supporting_metrics = {}
}) {
  const topRisk = (Array.isArray(risk_scores) ? risk_scores : [])[0] || null;
  const aggregates = supporting_metrics?.aggregates || {};
  const exceptionRows = Array.isArray(exceptions) ? exceptions : [];

  const summary = [
    `Risk scan completed across ${risk_scores.length} entities.`,
    `${aggregates.high_risk_count || 0} high-risk entities and ${aggregates.medium_risk_count || 0} medium-risk entities were detected.`,
    `Generated ${exceptionRows.length} actionable exceptions.`
  ].join(' ');

  const keyResults = [];
  if (topRisk) {
    keyResults.push({
      claim: `Highest risk entity is ${topRisk.entity_type}:${topRisk.entity_id} with score ${Number(topRisk.risk_score || 0).toFixed(1)}.`,
      evidence_ids: topRisk.evidence_refs || []
    });
  }
  keyResults.push({
    claim: `Input coverage: ${supporting_metrics?.inputs?.po_rows || 0} PO rows and ${supporting_metrics?.inputs?.receipt_rows || 0} receipt rows.`,
    evidence_ids: ['metric:input_coverage']
  });

  const reportExceptions = exceptionRows.slice(0, 8).map((item) => ({
    issue: item.description,
    evidence_ids: item.evidence_refs || []
  }));

  const recommendedActions = Array.from(new Set(
    exceptionRows
      .slice(0, 12)
      .flatMap((item) => item.recommended_actions || [])
  )).slice(0, 8);

  return {
    summary,
    key_results: keyResults,
    exceptions: reportExceptions,
    recommended_actions: recommendedActions
  };
}

export function buildPODelayAlertCardPayload({
  run,
  poDelayResult = {},
  supplierStats = []
}) {
  const highRiskPos = Array.isArray(poDelayResult.high_risk_pos)
    ? poDelayResult.high_risk_pos.slice(0, 50)
    : [];
  const criticalRiskPos = Array.isArray(poDelayResult.critical_risk_pos)
    ? poDelayResult.critical_risk_pos.slice(0, 20)
    : [];

  return {
    run_id: run?.id || null,
    high_risk_pos: highRiskPos,
    critical_risk_pos: criticalRiskPos,
    po_delay_summary: poDelayResult.summary || {},
    supplier_stats: supplierStats.slice(0, 30).map((s) => ({
      supplier_id: s.supplier_id,
      plant_id: s.plant_id,
      on_time_rate: s.on_time_rate,
      lead_time_p50_days: s.lead_time_p50_days,
      lead_time_p90_days: s.lead_time_p90_days,
      sample_size: s.sample_size,
      fallback_used: s.metrics?.fallback_used || false,
    })),
  };
}

export function buildRiskDownloadsPayload({
  run,
  risk_scores = [],
  supporting_metrics = {},
  exceptionsArtifact = {},
  report_json = {},
  artifact_refs = {},
  risk_scores_csv = '',
  exceptions_csv = ''
}) {
  const runId = run?.id || 'latest';
  return {
    run_id: run?.id || null,
    files: [
      {
        label: 'risk_scores.json',
        fileName: `risk_scores_run_${runId}.json`,
        mimeType: 'application/json;charset=utf-8',
        ref: artifact_refs.risk_scores || null,
        content: { rows: risk_scores }
      },
      {
        label: 'exceptions.json',
        fileName: `exceptions_run_${runId}.json`,
        mimeType: 'application/json;charset=utf-8',
        ref: artifact_refs.exceptions || null,
        content: exceptionsArtifact
      },
      {
        label: 'supporting_metrics.json',
        fileName: `supporting_metrics_run_${runId}.json`,
        mimeType: 'application/json;charset=utf-8',
        ref: artifact_refs.supporting_metrics || null,
        content: supporting_metrics
      },
      {
        label: 'report.json',
        fileName: `risk_report_run_${runId}.json`,
        mimeType: 'application/json;charset=utf-8',
        ref: artifact_refs.report_json || null,
        content: report_json
      },
      {
        label: 'risk_scores.csv',
        fileName: `risk_scores_run_${runId}.csv`,
        mimeType: 'text/csv;charset=utf-8',
        ref: artifact_refs.risk_scores_csv || null,
        content: risk_scores_csv
      },
      {
        label: 'exceptions.csv',
        fileName: `exceptions_run_${runId}.csv`,
        mimeType: 'text/csv;charset=utf-8',
        ref: artifact_refs.exceptions_csv || null,
        content: exceptions_csv
      }
    ]
  };
}

export default {
  computeRiskArtifactsFromDatasetProfile,
  buildRiskSummaryCardPayload,
  buildRiskDrilldownCardPayload,
  buildRiskExceptionsArtifacts,
  buildRiskExceptionsCardPayload,
  buildPODelayAlertCardPayload,
  buildRiskReportJson,
  buildRiskDownloadsPayload
};
