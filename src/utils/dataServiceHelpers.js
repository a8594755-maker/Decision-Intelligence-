/**
 * Shared utility helpers used across chatPlanningService, chatForecastService, chatRiskService.
 * Extracted to eliminate ~600 lines of duplicated code across 3 service files.
 */

const MAX_BLOCKING_QUESTIONS = 5;

export const normalizeText = (value) => String(value || '').trim();

/**
 * Escape SQL LIKE/ILIKE wildcard characters in user input.
 * Prevents `%` and `_` in user strings from acting as wildcards.
 */
export const escapeIlike = (str) =>
  String(str ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');

export const normalizeSheetName = (value) => normalizeText(value).toLowerCase();

export const createBlockingError = (message, questions = []) => {
  const err = new Error(message);
  err.blockingQuestions = Array.isArray(questions) ? questions.slice(0, MAX_BLOCKING_QUESTIONS) : [];
  err.isBlocking = true;
  return err;
};

export const toNumber = (value, fallback = NaN) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Safe number coercion — returns fallback for non-finite values.
 * Alias used in many utility files (constraintChecker, replaySimulator, etc.)
 */
export const safeNum = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Parse date values from various formats:
 * - Date objects
 * - Excel serial numbers (1-100000)
 * - ISO week strings ("2026-W03", "2026 W3")
 * - Month strings ("2026-06")
 * - Standard date strings
 */
export const parseDateValue = (value) => {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  // Excel serial date (epoch: Dec 30, 1899)
  if (typeof value === 'number' && value > 1 && value < 100000) {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    const parsed = new Date(excelEpoch.getTime() + (value * 24 * 60 * 60 * 1000));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const raw = String(value).trim();
  if (!raw) return null;

  // ISO week: "2026-W03", "2026 W3", "2026-W3"
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

  // Month: "2026-06"
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

export const toIsoDay = (dateObj) => {
  if (!dateObj || Number.isNaN(dateObj.getTime())) return null;
  return dateObj.toISOString().slice(0, 10);
};

export const normalizeRowsFromUserFile = (fileRecord) => {
  if (!fileRecord) return [];
  const raw = fileRecord.data;
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.rows)) return raw.rows;
  return [];
};

export const getRowsForSheet = (rows, sheetName) => {
  const normalizedSheet = normalizeSheetName(sheetName);
  const hasSheetMarker = rows.some((row) => row && Object.prototype.hasOwnProperty.call(row, '__sheet_name'));
  if (!hasSheetMarker) return rows;
  return rows.filter((row) => normalizeSheetName(row.__sheet_name) === normalizedSheet);
};

/**
 * Normalize mapping direction: ensures keys are target fields and values are source columns.
 * @param {Object} mapping - Possibly inverted mapping
 * @param {Set} [knownTargetFields] - Optional set of known target field names
 * @returns {Object} Normalized target->source mapping
 */
export const normalizeTargetMapping = (mapping = {}, knownTargetFields = null) => {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return {};

  const defaultKnownFields = new Set([
    'material_code', 'plant_id', 'demand_qty', 'week_bucket', 'date',
    'time_bucket', 'snapshot_date', 'onhand_qty', 'safety_stock',
    'open_qty', 'lead_time_days', 'moq', 'pack_size', 'max_order_qty',
    'unit_cost', 'unit_price', 'cost'
  ]);

  const targets = knownTargetFields || defaultKnownFields;
  const keys = Object.keys(mapping);
  const values = Object.values(mapping).map((value) => normalizeText(value));

  const keysLookLikeTarget = keys.some((key) => targets.has(normalizeText(key)));
  if (keysLookLikeTarget) return mapping;

  const valuesLookLikeTarget = values.some((value) => targets.has(value));
  if (!valuesLookLikeTarget) return mapping;

  const inverted = {};
  Object.entries(mapping).forEach(([source, target]) => {
    const targetField = normalizeText(target);
    if (!targetField) return;
    inverted[targetField] = source;
  });
  return inverted;
};

/**
 * Choose datasets from a contract JSON matching a specific upload type.
 */
export const chooseDatasetByType = (contractJson = {}, uploadType) => {
  const datasets = Array.isArray(contractJson?.datasets) ? contractJson.datasets : [];
  const matches = datasets
    .filter((dataset) => normalizeText(dataset.upload_type).toLowerCase() === normalizeText(uploadType).toLowerCase())
    .sort((a, b) => {
      const ta = new Date(a.uploaded_at || 0).getTime();
      const tb = new Date(b.uploaded_at || 0).getTime();
      return tb - ta;
    });
  return matches[0] || null;
};
