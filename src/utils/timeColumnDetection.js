import { normalizeMappingToken } from './deterministicMapping';

const MIN_REASONABLE_DATE = Date.UTC(2010, 0, 1);
const MAX_REASONABLE_DATE = Date.UTC(2035, 11, 31, 23, 59, 59);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_WEEK_RE = /^(\d{4})-W(\d{1,2})$/i;
const ISO_MONTH_RE = /^(\d{4})-(\d{2})$/;

const toUtcDate = (year, monthIndex, day) => {
  const date = new Date(Date.UTC(year, monthIndex, day));
  return Number.isNaN(date.getTime()) ? null : date;
};

const isoWeekStart = (year, week) => {
  if (!Number.isFinite(year) || !Number.isFinite(week) || week < 1 || week > 53) return null;
  const jan4 = toUtcDate(year, 0, 4);
  if (!jan4) return null;
  const dayOfWeek = jan4.getUTCDay() || 7;
  const mondayWeek1 = new Date(jan4);
  mondayWeek1.setUTCDate(jan4.getUTCDate() - dayOfWeek + 1);
  const result = new Date(mondayWeek1);
  result.setUTCDate(mondayWeek1.getUTCDate() + ((week - 1) * 7));
  return result;
};

const isReasonableDate = (dateObj) => {
  if (!(dateObj instanceof Date)) return false;
  const time = dateObj.getTime();
  if (!Number.isFinite(time)) return false;
  return time >= MIN_REASONABLE_DATE && time <= MAX_REASONABLE_DATE;
};

const parseDateText = (value) => {
  const text = String(value || '').trim();
  if (!text) return null;

  if (ISO_DATE_RE.test(text)) {
    const parsed = new Date(`${text}T00:00:00Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const weekMatch = text.match(ISO_WEEK_RE);
  if (weekMatch) {
    return isoWeekStart(Number(weekMatch[1]), Number(weekMatch[2]));
  }

  const monthMatch = text.match(ISO_MONTH_RE);
  if (monthMatch) {
    return toUtcDate(Number(monthMatch[1]), Number(monthMatch[2]) - 1, 1);
  }

  if (/[/-]/.test(text)) {
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
};

const parseExcelSerialDate = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value <= 1 || value >= 100000) return null;
  const excelEpochUtc = Date.UTC(1899, 11, 30);
  const parsed = new Date(excelEpochUtc + (value * 24 * 60 * 60 * 1000));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const parseTemporalValue = (value, { allowExcelSerial = false } = {}) => {
  if (value === null || value === undefined || value === '') return null;

  if (typeof value === 'number') {
    return allowExcelSerial ? parseExcelSerialDate(value) : null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  return parseDateText(value);
};

const getHeaderPriority = (normalizedHeader) => {
  if (!normalizedHeader) return 0;
  if (normalizedHeader === 'snapshot_date') return 0.65;
  if (normalizedHeader === 'actual_delivery_date') return 0.65;
  if (normalizedHeader === 'planned_delivery_date') return 0.6;
  if (normalizedHeader === 'week_bucket') return 0.6;
  if (normalizedHeader === 'time_bucket') return 0.58;
  if (normalizedHeader === 'date') return 0.55;

  if (/week_bucket|week/.test(normalizedHeader)) return 0.5;
  if (/snapshot_date|delivery_date|promised_date|order_date|date/.test(normalizedHeader)) return 0.48;
  if (/time_bucket|bucket|period|time/.test(normalizedHeader)) return 0.42;
  return 0;
};

const inferGranularity = ({ normalizedHeader, samples = [] }) => {
  if (/week/.test(normalizedHeader)) return 'week';
  if (/month/.test(normalizedHeader)) return 'month';
  if (/date|snapshot|delivery|promised|order/.test(normalizedHeader)) return 'day';

  const textSamples = samples.map((value) => String(value || '').trim()).filter(Boolean);
  if (textSamples.some((value) => ISO_WEEK_RE.test(value))) return 'week';
  if (textSamples.some((value) => ISO_MONTH_RE.test(value) && !ISO_DATE_RE.test(value))) return 'month';
  if (textSamples.some((value) => ISO_DATE_RE.test(value))) return 'day';
  return 'unknown';
};

export const detectTimeColumn = ({
  columns = [],
  rows = [],
  maxRows = 500,
  minParseSuccessRate = 0.8
} = {}) => {
  const sampledRows = (Array.isArray(rows) ? rows : []).slice(0, maxRows);
  const headers = Array.isArray(columns) ? columns : [];

  let best = null;

  headers.forEach((column) => {
    const normalizedHeader = normalizeMappingToken(column);
    const headerPriority = getHeaderPriority(normalizedHeader);
    const nonEmptyValues = sampledRows
      .map((row) => row?.[column])
      .filter((value) => value !== null && value !== undefined && value !== '');

    if (nonEmptyValues.length === 0) return;

    const allowExcelSerial = headerPriority >= 0.4;
    const parsedValues = nonEmptyValues
      .map((value) => parseTemporalValue(value, { allowExcelSerial }))
      .filter((dateObj) => isReasonableDate(dateObj));

    const parseSuccessRate = parsedValues.length / nonEmptyValues.length;
    if (parseSuccessRate < minParseSuccessRate) return;

    const sortedTimes = parsedValues
      .map((dateObj) => dateObj.getTime())
      .sort((a, b) => a - b);
    if (sortedTimes.length === 0) return;

    const score = Number((parseSuccessRate + headerPriority).toFixed(4));
    const candidate = {
      name: column,
      score,
      parse_success_rate: Number(parseSuccessRate.toFixed(4)),
      granularity: inferGranularity({ normalizedHeader, samples: nonEmptyValues }),
      start: new Date(sortedTimes[0]),
      end: new Date(sortedTimes[sortedTimes.length - 1])
    };

    if (!best || candidate.score > best.score) {
      best = candidate;
    }
  });

  if (!best) {
    return {
      name: null,
      score: 0,
      parse_success_rate: 0,
      granularity: 'unknown',
      start: null,
      end: null
    };
  }

  return best;
};

export const timeColumnDetectionInternals = {
  parseDateText,
  parseExcelSerialDate,
  parseTemporalValue,
  isReasonableDate,
  getHeaderPriority
};

export default {
  detectTimeColumn
};
