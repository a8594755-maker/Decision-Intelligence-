import { diRunsService } from '../planning/diRunsService';
import { datasetProfilesService } from '../data-prep/datasetProfilesService';
import { userFilesService } from '../infra/supabaseClient';
import { saveJsonArtifact, loadArtifact } from '../../utils/artifactStore';
import {
  buildTopologyGraph,
  createTopologySettingsHash
} from './buildTopologyGraph';

const TOPOLOGY_ARTIFACT_TYPE = 'topology_graph';
const TOPOLOGY_ARTIFACT_THRESHOLD = 1024 * 1024;
const WORKFLOW_B_NAME = 'workflow_B_risk_exceptions';

const nowIso = () => new Date().toISOString();

const toNumber = (value, fallback = NaN) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeText = (value) => String(value || '').trim();

const normalizeSheetName = (value) => normalizeText(value).toLowerCase();

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
  dateObj && !Number.isNaN(dateObj.getTime())
    ? dateObj.toISOString().slice(0, 10)
    : null
);

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
    'supplier_id',
    'supplier_code',
    'supplier_name',
    'supplier',
    'name',
    'material_code',
    'sku',
    'fg_sku',
    'component_sku',
    'parent_material',
    'child_material',
    'plant_id',
    'open_qty',
    'received_qty',
    'demand_qty',
    'onhand_qty',
    'on_hand',
    'qty',
    'qty_per',
    'usage_qty',
    'valid_from',
    'valid_to',
    'promised_date',
    'order_date',
    'actual_delivery_date',
    'receipt_date',
    'snapshot_date',
    'date',
    'time_bucket',
    'week_bucket',
    'customer_id'
  ]);

  const keys = Object.keys(mapping).map((item) => normalizeText(item));
  const values = Object.values(mapping).map((item) => normalizeText(item));
  const keysLookLikeTargets = keys.some((key) => knownTargets.has(key));
  if (keysLookLikeTargets) return mapping;

  const valuesLookLikeTargets = values.some((value) => knownTargets.has(value));
  if (!valuesLookLikeTargets) return mapping;

  const inverted = {};
  Object.entries(mapping).forEach(([source, target]) => {
    const normalizedTarget = normalizeText(target);
    if (!normalizedTarget) return;
    inverted[normalizedTarget] = source;
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

const mapSupplierMasterRows = ({ rows, sheetName, mapping }) => {
  const relevantRows = getRowsForSheet(rows, sheetName);
  const supplierIdField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['supplier_id', 'supplier_code'],
    headerHints: [/supplier[_\s-]?id/, /supplier[_\s-]?code/, /vendor[_\s-]?id/]
  });
  const supplierNameField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['supplier_name', 'name', 'supplier'],
    headerHints: [/supplier[_\s-]?name/, /vendor[_\s-]?name/, /^name$/]
  });

  const result = [];
  relevantRows.forEach((row) => {
    const supplierId = normalizeText(row[supplierIdField] || row[supplierNameField]);
    const supplierName = normalizeText(row[supplierNameField] || row[supplierIdField]);
    if (!supplierId && !supplierName) return;
    result.push({
      supplier_id: supplierId || supplierName,
      supplier_name: supplierName || supplierId
    });
  });

  result.sort((a, b) => {
    if (a.supplier_id !== b.supplier_id) return a.supplier_id.localeCompare(b.supplier_id);
    return a.supplier_name.localeCompare(b.supplier_name);
  });
  return result;
};

const mapPoRows = ({ rows, sheetName, mapping }) => {
  const relevantRows = getRowsForSheet(rows, sheetName);
  const supplierIdField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['supplier_id', 'supplier_code', 'supplier'],
    headerHints: [/supplier[_\s-]?id/, /supplier[_\s-]?code/, /vendor[_\s-]?id/, /^supplier$/, /^vendor$/]
  });
  const supplierNameField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['supplier_name', 'supplier'],
    headerHints: [/supplier[_\s-]?name/, /vendor[_\s-]?name/]
  });
  const materialField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['material_code', 'sku'],
    headerHints: [/material/, /\bsku\b/, /\bitem\b/, /\bpart/]
  });
  const plantField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['plant_id'],
    headerHints: [/plant/, /site/, /warehouse/, /location/]
  });
  const qtyField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['open_qty', 'qty'],
    headerHints: [/open[_\s-]?qty/, /remaining[_\s-]?qty/, /balance[_\s-]?qty/, /\bqty\b/]
  });
  const dueDateField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['promised_date', 'date', 'time_bucket', 'week_bucket'],
    headerHints: [/promised/, /planned[_\s-]?delivery/, /\bdue/, /\beta/, /date/, /week/, /bucket/]
  });

  const mapped = [];
  relevantRows.forEach((row) => {
    const supplierId = normalizeText(row[supplierIdField] || row[supplierNameField]);
    const supplierName = normalizeText(row[supplierNameField] || row[supplierIdField]);
    const materialCode = normalizeText(row[materialField]);
    const plantId = normalizeText(row[plantField]);
    const openQty = toNumber(row[qtyField], NaN);
    if (!supplierId || !materialCode || !plantId || !Number.isFinite(openQty) || openQty <= 0) return;
    mapped.push({
      supplier_id: supplierId,
      supplier_name: supplierName || supplierId,
      material_code: materialCode,
      plant_id: plantId,
      open_qty: openQty,
      due_date: toIsoDay(parseDateValue(row[dueDateField]))
    });
  });

  mapped.sort((a, b) => {
    if (a.supplier_id !== b.supplier_id) return a.supplier_id.localeCompare(b.supplier_id);
    if (a.plant_id !== b.plant_id) return a.plant_id.localeCompare(b.plant_id);
    if (a.material_code !== b.material_code) return a.material_code.localeCompare(b.material_code);
    return String(a.due_date || '').localeCompare(String(b.due_date || ''));
  });
  return mapped;
};

const mapGoodsReceiptRows = ({ rows, sheetName, mapping }) => {
  const relevantRows = getRowsForSheet(rows, sheetName);
  const supplierIdField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['supplier_id', 'supplier_code', 'supplier'],
    headerHints: [/supplier[_\s-]?id/, /supplier[_\s-]?code/, /vendor[_\s-]?id/, /^supplier$/, /^vendor$/]
  });
  const supplierNameField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['supplier_name', 'supplier'],
    headerHints: [/supplier[_\s-]?name/, /vendor[_\s-]?name/]
  });
  const materialField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['material_code', 'sku'],
    headerHints: [/material/, /\bsku\b/, /\bitem\b/, /\bpart/]
  });
  const plantField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['plant_id'],
    headerHints: [/plant/, /site/, /warehouse/, /location/]
  });
  const qtyField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['received_qty', 'qty'],
    headerHints: [/received[_\s-]?qty/, /receipt[_\s-]?qty/, /\bqty\b/]
  });
  const actualDateField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['actual_delivery_date', 'receipt_date', 'date', 'time_bucket', 'week_bucket'],
    headerHints: [/actual[_\s-]?delivery/, /receipt[_\s-]?date/, /delivery[_\s-]?date/, /date/, /week/, /bucket/]
  });
  const promisedDateField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['promised_date', 'planned_delivery_date'],
    headerHints: [/promised/, /planned[_\s-]?delivery/, /\bdue/, /\beta/]
  });

  const mapped = [];
  relevantRows.forEach((row) => {
    const supplierId = normalizeText(row[supplierIdField] || row[supplierNameField]);
    const supplierName = normalizeText(row[supplierNameField] || row[supplierIdField]);
    const materialCode = normalizeText(row[materialField]);
    const plantId = normalizeText(row[plantField]);
    const qty = toNumber(row[qtyField], NaN);
    const actualDate = toIsoDay(parseDateValue(row[actualDateField]));
    if (!supplierId || !materialCode || !plantId || !Number.isFinite(qty) || qty <= 0 || !actualDate) return;

    mapped.push({
      supplier_id: supplierId,
      supplier_name: supplierName || supplierId,
      material_code: materialCode,
      plant_id: plantId,
      received_qty: qty,
      actual_delivery_date: actualDate,
      promised_date: toIsoDay(parseDateValue(row[promisedDateField]))
    });
  });

  mapped.sort((a, b) => {
    if (a.supplier_id !== b.supplier_id) return a.supplier_id.localeCompare(b.supplier_id);
    if (a.material_code !== b.material_code) return a.material_code.localeCompare(b.material_code);
    if (a.plant_id !== b.plant_id) return a.plant_id.localeCompare(b.plant_id);
    return a.actual_delivery_date.localeCompare(b.actual_delivery_date);
  });
  return mapped;
};

const mapBomRows = ({ rows, sheetName, mapping }) => {
  const relevantRows = getRowsForSheet(rows, sheetName);
  const parentField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['parent_material', 'fg_sku', 'material_code'],
    headerHints: [/parent[_\s-]?material/, /\bparent\b/, /\bfg\b/, /finished[_\s-]?good/]
  });
  const childField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['child_material', 'component_sku'],
    headerHints: [/child[_\s-]?material/, /component/, /\bchild\b/, /\bsub\b/]
  });
  const qtyField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['qty_per', 'usage_qty', 'qty'],
    headerHints: [/qty[_\s-]?per/, /usage/, /\bqty\b/]
  });
  const plantField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['plant_id'],
    headerHints: [/plant/, /site/, /warehouse/, /location/]
  });
  const validFromField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['valid_from'],
    headerHints: [/valid[_\s-]?from/, /effective[_\s-]?from/]
  });
  const validToField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['valid_to'],
    headerHints: [/valid[_\s-]?to/, /effective[_\s-]?to/]
  });

  const mapped = [];
  relevantRows.forEach((row) => {
    const fgSku = normalizeText(row[parentField]);
    const componentSku = normalizeText(row[childField]);
    const usageQty = toNumber(row[qtyField], NaN);
    if (!fgSku || !componentSku || !Number.isFinite(usageQty) || usageQty <= 0) return;
    mapped.push({
      fg_sku: fgSku,
      component_sku: componentSku,
      usage_qty: usageQty,
      plant_id: normalizeText(row[plantField]) || null,
      valid_from: toIsoDay(parseDateValue(row[validFromField])),
      valid_to: toIsoDay(parseDateValue(row[validToField]))
    });
  });

  mapped.sort((a, b) => {
    if (a.fg_sku !== b.fg_sku) return a.fg_sku.localeCompare(b.fg_sku);
    if (a.component_sku !== b.component_sku) return a.component_sku.localeCompare(b.component_sku);
    return toNumber(a.usage_qty, 0) - toNumber(b.usage_qty, 0);
  });
  return mapped;
};

const mapDemandRows = ({ rows, sheetName, mapping }) => {
  const relevantRows = getRowsForSheet(rows, sheetName);
  const materialField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['material_code', 'sku', 'fg_sku'],
    headerHints: [/material/, /\bsku\b/, /\bitem\b/, /fg/]
  });
  const plantField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['plant_id'],
    headerHints: [/plant/, /site/, /warehouse/, /location/]
  });
  const qtyField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['demand_qty', 'qty'],
    headerHints: [/demand[_\s-]?qty/, /\bdemand\b/, /\bqty\b/]
  });
  const dateField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['date', 'time_bucket', 'week_bucket'],
    headerHints: [/date/, /week/, /bucket/, /time/]
  });
  const customerField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['customer_id'],
    headerHints: [/customer/]
  });

  const mapped = [];
  relevantRows.forEach((row) => {
    const fgSku = normalizeText(row[materialField]);
    const plantId = normalizeText(row[plantField]);
    const qty = toNumber(row[qtyField], NaN);
    if (!fgSku || !plantId || !Number.isFinite(qty) || qty < 0) return;

    mapped.push({
      fg_sku: fgSku,
      plant_id: plantId,
      demand_qty: qty,
      date: toIsoDay(parseDateValue(row[dateField])),
      customer_id: normalizeText(row[customerField]) || null
    });
  });

  mapped.sort((a, b) => {
    if (a.fg_sku !== b.fg_sku) return a.fg_sku.localeCompare(b.fg_sku);
    if (a.plant_id !== b.plant_id) return a.plant_id.localeCompare(b.plant_id);
    return String(a.date || '').localeCompare(String(b.date || ''));
  });
  return mapped;
};

const mapInventoryRows = ({ rows, sheetName, mapping }) => {
  const relevantRows = getRowsForSheet(rows, sheetName);
  const materialField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['material_code', 'sku'],
    headerHints: [/material/, /\bsku\b/, /\bitem\b/, /\bpart\b/]
  });
  const plantField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['plant_id'],
    headerHints: [/plant/, /site/, /warehouse/, /location/]
  });
  const qtyField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['onhand_qty', 'on_hand', 'qty'],
    headerHints: [/on[_\s-]?hand/, /inventory/, /\bqty\b/]
  });
  const snapshotField = resolveMappedColumn({
    mapping,
    rows: relevantRows,
    targetCandidates: ['snapshot_date', 'date', 'time_bucket', 'week_bucket'],
    headerHints: [/snapshot/, /date/, /week/, /bucket/]
  });

  const mapped = [];
  relevantRows.forEach((row) => {
    const sku = normalizeText(row[materialField]);
    const plantId = normalizeText(row[plantField]);
    const onHand = toNumber(row[qtyField], NaN);
    if (!sku || !plantId || !Number.isFinite(onHand)) return;
    mapped.push({
      sku,
      plant_id: plantId,
      on_hand: onHand,
      snapshot_date: toIsoDay(parseDateValue(row[snapshotField]))
    });
  });

  mapped.sort((a, b) => {
    if (a.sku !== b.sku) return a.sku.localeCompare(b.sku);
    if (a.plant_id !== b.plant_id) return a.plant_id.localeCompare(b.plant_id);
    return String(a.snapshot_date || '').localeCompare(String(b.snapshot_date || ''));
  });
  return mapped;
};

const toArtifactRef = (record) => {
  if (!record) return null;
  return {
    artifact_id: record.id,
    ...(record.artifact_json || {})
  };
};

const loadArtifactPayloadByRecord = async (record) => {
  if (!record) return null;
  const ref = toArtifactRef(record);
  try {
    return await loadArtifact(ref);
  } catch {
    return record.artifact_json || null;
  }
};

const getLatestArtifactRecordsByType = (artifacts = []) => {
  const sorted = [...(Array.isArray(artifacts) ? artifacts : [])].sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
  const map = new Map();
  sorted.forEach((record) => {
    if (!record?.artifact_type || map.has(record.artifact_type)) return;
    map.set(record.artifact_type, record);
  });
  return map;
};

const loadLatestArtifactsForRun = async (runId) => {
  const artifacts = await diRunsService.getArtifactsForRun(runId);
  const latestByType = getLatestArtifactRecordsByType(artifacts);
  const payloadByType = {};
  const refsByType = {};

  const loadTasks = Array.from(latestByType.entries()).map(async ([type, record]) => {
    payloadByType[type] = await loadArtifactPayloadByRecord(record);
    refsByType[type] = toArtifactRef(record);
  });
  await Promise.all(loadTasks);

  return {
    artifacts,
    latestByType,
    payloadByType,
    refsByType
  };
};

const findTopologyPayloadInRun = async (runId, settingsHash = null) => {
  const artifacts = await diRunsService.getArtifactsForRun(runId);
  const candidates = artifacts
    .filter((record) => record?.artifact_type === TOPOLOGY_ARTIFACT_TYPE)
    .sort((a, b) => Number(b.id || 0) - Number(a.id || 0));

  for (const record of candidates) {
    const payload = await loadArtifactPayloadByRecord(record);
    if (!payload || typeof payload !== 'object') continue;
    if (settingsHash && String(payload.settings_hash || '') !== String(settingsHash)) continue;
    return {
      payload,
      record,
      ref: toArtifactRef(record)
    };
  }

  return null;
};

const findReusableTopologyPayload = async ({
  userId,
  runId,
  datasetFingerprint,
  settingsHash
}) => {
  if (!datasetFingerprint) return null;

  const profiles = await datasetProfilesService.listByFingerprint(userId, datasetFingerprint, 80);
  const profileIds = profiles
    .map((profile) => Number(profile.id))
    .filter((id) => Number.isFinite(id));
  if (profileIds.length === 0) return null;

  const runs = await diRunsService.getRecentRunsForDatasetProfiles(userId, {
    dataset_profile_ids: profileIds,
    status: 'succeeded',
    limit: 80
  });

  for (const run of runs) {
    if (!run?.id || Number(run.id) === Number(runId)) continue;
    const reused = await findTopologyPayloadInRun(run.id, settingsHash);
    if (reused) {
      return {
        ...reused,
        source_run_id: run.id
      };
    }
  }

  return null;
};

const findRelatedRiskArtifacts = async ({
  userId,
  runId,
  datasetFingerprint,
  existingPayloadByType = {},
  existingRefsByType = {}
}) => {
  if (existingPayloadByType?.risk_scores) {
    return {
      payload: {
        risk_scores: existingPayloadByType.risk_scores || null,
        supporting_metrics: existingPayloadByType.supporting_metrics || null,
        exceptions: existingPayloadByType.exceptions || null
      },
      refs: {
        risk_scores: existingRefsByType.risk_scores || null,
        supporting_metrics: existingRefsByType.supporting_metrics || null,
        exceptions: existingRefsByType.exceptions || null
      }
    };
  }

  if (!datasetFingerprint) {
    return { payload: {}, refs: {} };
  }

  const profiles = await datasetProfilesService.listByFingerprint(userId, datasetFingerprint, 80);
  const profileIds = profiles
    .map((profile) => Number(profile.id))
    .filter((id) => Number.isFinite(id));
  if (profileIds.length === 0) return { payload: {}, refs: {} };

  const runs = await diRunsService.getRecentRunsForDatasetProfiles(userId, {
    dataset_profile_ids: profileIds,
    status: 'succeeded',
    workflow: WORKFLOW_B_NAME,
    limit: 30
  });

  for (const candidateRun of runs) {
    if (!candidateRun?.id || Number(candidateRun.id) === Number(runId)) continue;
    const artifacts = await loadLatestArtifactsForRun(candidateRun.id);
    if (!artifacts.payloadByType?.risk_scores) continue;
    return {
      payload: {
        risk_scores: artifacts.payloadByType.risk_scores || null,
        supporting_metrics: artifacts.payloadByType.supporting_metrics || null,
        exceptions: artifacts.payloadByType.exceptions || null
      },
      refs: {
        risk_scores: artifacts.refsByType.risk_scores || null,
        supporting_metrics: artifacts.refsByType.supporting_metrics || null,
        exceptions: artifacts.refsByType.exceptions || null
      }
    };
  }

  return { payload: {}, refs: {} };
};

const loadDatasetsFromProfile = async ({
  userId,
  datasetProfileRow
}) => {
  const contractJson = datasetProfileRow?.contract_json || {};
  const userFileId = datasetProfileRow?.user_file_id || null;
  const fileRecord = userFileId
    ? await userFilesService.getFileById(userId, userFileId)
    : null;
  const rows = normalizeRowsFromUserFile(fileRecord);

  const supplierDataset = chooseDatasetByType(contractJson, 'supplier_master');
  const poDataset = chooseDatasetByType(contractJson, 'po_open_lines');
  const receiptDataset = chooseDatasetByType(contractJson, 'goods_receipt');
  const bomDataset = chooseDatasetByType(contractJson, 'bom_edge');
  const demandDataset = chooseDatasetByType(contractJson, 'demand_fg');
  const inventoryDataset = chooseDatasetByType(contractJson, 'inventory_snapshots');

  const datasets = {
    supplier_master: supplierDataset
      ? mapSupplierMasterRows({
          rows,
          sheetName: supplierDataset.sheet_name,
          mapping: normalizeTargetMapping(supplierDataset.mapping || {})
        })
      : [],
    po_open_lines: poDataset
      ? mapPoRows({
          rows,
          sheetName: poDataset.sheet_name,
          mapping: normalizeTargetMapping(poDataset.mapping || {})
        })
      : [],
    goods_receipt: receiptDataset
      ? mapGoodsReceiptRows({
          rows,
          sheetName: receiptDataset.sheet_name,
          mapping: normalizeTargetMapping(receiptDataset.mapping || {})
        })
      : [],
    bom_edge: bomDataset
      ? mapBomRows({
          rows,
          sheetName: bomDataset.sheet_name,
          mapping: normalizeTargetMapping(bomDataset.mapping || {})
        })
      : [],
    demand_fg: demandDataset
      ? mapDemandRows({
          rows,
          sheetName: demandDataset.sheet_name,
          mapping: normalizeTargetMapping(demandDataset.mapping || {})
        })
      : [],
    inventory_snapshots: inventoryDataset
      ? mapInventoryRows({
          rows,
          sheetName: inventoryDataset.sheet_name,
          mapping: normalizeTargetMapping(inventoryDataset.mapping || {})
        })
      : []
  };

  return {
    datasets,
    source_file_id: userFileId
  };
};

const buildGraphPayloadForRun = async ({
  userId,
  runRow,
  datasetProfileRow,
  scope
}) => {
  const { datasets } = await loadDatasetsFromProfile({
    userId,
    datasetProfileRow
  });
  const artifacts = await loadLatestArtifactsForRun(runRow.id);

  const relatedRisk = await findRelatedRiskArtifacts({
    userId,
    runId: runRow.id,
    datasetFingerprint: datasetProfileRow?.fingerprint || '',
    existingPayloadByType: artifacts.payloadByType,
    existingRefsByType: artifacts.refsByType
  });

  const artifactPayload = {
    plan_table: artifacts.payloadByType?.plan_table || null,
    inventory_projection: artifacts.payloadByType?.inventory_projection || null,
    risk_scores: artifacts.payloadByType?.risk_scores || relatedRisk.payload?.risk_scores || null,
    supporting_metrics: artifacts.payloadByType?.supporting_metrics || relatedRisk.payload?.supporting_metrics || null,
    exceptions: artifacts.payloadByType?.exceptions || relatedRisk.payload?.exceptions || null,
    bottlenecks: artifacts.payloadByType?.bottlenecks || artifacts.payloadByType?.bottlenecks_json || null,
    bottlenecks_json: artifacts.payloadByType?.bottlenecks_json || artifacts.payloadByType?.bottlenecks || null,
    bom_explosion: artifacts.payloadByType?.bom_explosion || artifacts.payloadByType?.bom_explosion_json || null,
    bom_explosion_json: artifacts.payloadByType?.bom_explosion_json || artifacts.payloadByType?.bom_explosion || null
  };

  const artifactRefs = {
    plan_table: artifacts.refsByType?.plan_table || null,
    inventory_projection: artifacts.refsByType?.inventory_projection || null,
    risk_scores: artifacts.refsByType?.risk_scores || relatedRisk.refs?.risk_scores || null,
    supporting_metrics: artifacts.refsByType?.supporting_metrics || relatedRisk.refs?.supporting_metrics || null,
    exceptions: artifacts.refsByType?.exceptions || relatedRisk.refs?.exceptions || null,
    bottlenecks: artifacts.refsByType?.bottlenecks || artifacts.refsByType?.bottlenecks_json || null,
    bottlenecks_json: artifacts.refsByType?.bottlenecks_json || artifacts.refsByType?.bottlenecks || null,
    bom_explosion: artifacts.refsByType?.bom_explosion || artifacts.refsByType?.bom_explosion_json || null,
    bom_explosion_json: artifacts.refsByType?.bom_explosion_json || artifacts.refsByType?.bom_explosion || null
  };

  return buildTopologyGraph({
    run_id: runRow.id,
    dataset_profile_id: datasetProfileRow.id,
    dataset_fingerprint: datasetProfileRow?.fingerprint || '',
    scope,
    datasets,
    artifacts: artifactPayload,
    refs: artifactRefs
  });
};

const saveTopologyGraph = async ({ runId, userId, graphPayload }) => {
  const saved = await saveJsonArtifact(
    runId,
    TOPOLOGY_ARTIFACT_TYPE,
    graphPayload,
    TOPOLOGY_ARTIFACT_THRESHOLD,
    {
      user_id: userId,
      filename: `topology_graph_run_${runId}.json`
    }
  );
  return saved;
};

export async function loadTopologyGraphForRun({
  runId,
  settingsHash = null
} = {}) {
  const numericRunId = Number(runId);
  if (!Number.isFinite(numericRunId)) throw new Error('runId must be numeric');

  const found = await findTopologyPayloadInRun(numericRunId, settingsHash || null);
  if (!found) return null;

  return {
    graph: found.payload,
    ref: found.ref,
    artifact_id: found.record?.id || null
  };
}

export async function generateTopologyGraphForRun({
  userId,
  runId,
  scope = {},
  forceRebuild = false,
  reuse = true,
  manageRunStep = false
} = {}) {
  const numericRunId = Number(runId);
  if (!Number.isFinite(numericRunId)) throw new Error('runId must be numeric');

  const runRow = await diRunsService.getRun(numericRunId);
  if (!runRow) throw new Error(`Run ${runId} not found`);
  if (userId && String(runRow.user_id) !== String(userId)) {
    throw new Error(`Run ${runId} does not belong to user ${userId}`);
  }

  const ownerId = runRow.user_id;
  const profileRow = await datasetProfilesService.getDatasetProfileById(ownerId, runRow.dataset_profile_id);
  if (!profileRow) {
    throw new Error(`Dataset profile ${runRow.dataset_profile_id} not found for run ${runRow.id}`);
  }

  const settingsHash = createTopologySettingsHash({
    dataset_fingerprint: profileRow?.fingerprint || '',
    scope
  });

  if (manageRunStep) {
    await diRunsService.upsertRunStep({
      run_id: runRow.id,
      step: 'topology',
      status: 'running',
      started_at: nowIso(),
      finished_at: null,
      error_code: null,
      error_message: null
    });
  }

  try {
    if (!forceRebuild) {
      const existing = await findTopologyPayloadInRun(runRow.id, settingsHash);
      if (existing) {
        if (manageRunStep) {
          await diRunsService.updateRunStep({
            run_id: runRow.id,
            step: 'topology',
            status: 'succeeded',
            finished_at: nowIso(),
            output_ref: {
              topology_graph_ref: existing.ref,
              settings_hash: settingsHash,
              reused: true,
              reused_from_run_id: runRow.id
            }
          });
        }
        return {
          graph: existing.payload,
          ref: existing.ref,
          settings_hash: settingsHash,
          reused: true,
          reused_from_run_id: runRow.id,
          run: runRow
        };
      }
    }

    if (!forceRebuild && reuse) {
      const reusable = await findReusableTopologyPayload({
        userId: ownerId,
        runId: runRow.id,
        datasetFingerprint: profileRow?.fingerprint || '',
        settingsHash
      });
      if (reusable?.payload) {
        const reusedPayload = {
          ...reusable.payload,
          generated_at: nowIso(),
          run_id: runRow.id,
          dataset_profile_id: profileRow.id,
          settings_hash: settingsHash,
          reused_from_run_id: reusable.source_run_id
        };

        const saved = await saveTopologyGraph({
          runId: runRow.id,
          userId: ownerId,
          graphPayload: reusedPayload
        });

        if (manageRunStep) {
          await diRunsService.updateRunStep({
            run_id: runRow.id,
            step: 'topology',
            status: 'succeeded',
            finished_at: nowIso(),
            output_ref: {
              topology_graph_ref: saved.ref,
              settings_hash: settingsHash,
              reused: true,
              reused_from_run_id: reusable.source_run_id
            }
          });
        }

        return {
          graph: reusedPayload,
          ref: saved.ref,
          settings_hash: settingsHash,
          reused: true,
          reused_from_run_id: reusable.source_run_id,
          run: runRow
        };
      }
    }

    const graphPayload = await buildGraphPayloadForRun({
      userId: ownerId,
      runRow,
      datasetProfileRow: profileRow,
      scope
    });
    const payloadWithMeta = {
      ...graphPayload,
      settings_hash: settingsHash
    };

    const saved = await saveTopologyGraph({
      runId: runRow.id,
      userId: ownerId,
      graphPayload: payloadWithMeta
    });

    if (manageRunStep) {
      await diRunsService.updateRunStep({
        run_id: runRow.id,
        step: 'topology',
        status: 'succeeded',
        finished_at: nowIso(),
        output_ref: {
          topology_graph_ref: saved.ref,
          settings_hash: settingsHash,
          reused: false,
          reused_from_run_id: null
        }
      });
    }

    return {
      graph: payloadWithMeta,
      ref: saved.ref,
      settings_hash: settingsHash,
      reused: false,
      reused_from_run_id: null,
      run: runRow
    };
  } catch (error) {
    if (manageRunStep) {
      await diRunsService.updateRunStep({
        run_id: runRow.id,
        step: 'topology',
        status: 'failed',
        finished_at: nowIso(),
        error_code: 'TOPOLOGY_BUILD_FAILED',
        error_message: error.message || 'Topology graph generation failed'
      }).catch(() => {});
    }
    throw error;
  }
}

export default {
  loadTopologyGraphForRun,
  generateTopologyGraphForRun
};
