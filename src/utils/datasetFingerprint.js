/**
 * Deterministic dataset fingerprint utility.
 * Uses stable JSON + FNV-1a hash to identify similar dataset shapes.
 */

const MAX_SAMPLE_ROWS = 25;

const normalizeHeader = (header) => String(header || '')
  .trim()
  .toLowerCase()
  .replace(/[\s\-./]+/g, '_')
  .replace(/[^a-z0-9_]/g, '')
  .replace(/_+/g, '_')
  .replace(/^_+|_+$/g, '');

const stableSortObject = (value) => {
  if (Array.isArray(value)) {
    return value.map(stableSortObject);
  }

  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = stableSortObject(value[key]);
        return acc;
      }, {});
  }

  return value;
};

const stableStringify = (value) => JSON.stringify(stableSortObject(value));

const fnv1a32 = (text) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

const normalizeSheetName = (sheetName) => String(sheetName || '').trim().toLowerCase();

const toRowObject = (row, columns) => {
  if (row && typeof row === 'object' && !Array.isArray(row)) {
    return row;
  }

  if (!Array.isArray(row)) {
    return {};
  }

  const mapped = {};
  columns.forEach((column, index) => {
    mapped[column] = row[index] ?? '';
  });
  return mapped;
};

const deriveColumns = (sheet) => {
  if (Array.isArray(sheet.columns) && sheet.columns.length > 0) {
    return sheet.columns.map(String);
  }

  const firstRow = Array.isArray(sheet.rows) ? sheet.rows.find(Boolean) : null;
  if (firstRow && typeof firstRow === 'object' && !Array.isArray(firstRow)) {
    return Object.keys(firstRow);
  }

  return [];
};

/**
 * Build a compact payload from raw sheet objects.
 * @param {Array} sheetsRaw
 * @returns {Array<{sheet_name: string, columns: string[], sample_rows: object[], row_count_estimate: number}>}
 */
export const buildSheetsPayload = (sheetsRaw = []) => {
  return (Array.isArray(sheetsRaw) ? sheetsRaw : [])
    .map((sheet, index) => {
      const sheetName = sheet.sheet_name || sheet.sheetName || `Sheet${index + 1}`;
      const columns = deriveColumns(sheet);
      const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
      const sampleRows = rows
        .slice(0, MAX_SAMPLE_ROWS)
        .map((row) => toRowObject(row, columns));

      return {
        sheet_name: sheetName,
        columns,
        sample_rows: sampleRows,
        row_count_estimate: Number.isFinite(sheet.row_count_estimate)
          ? sheet.row_count_estimate
          : rows.length
      };
    });
};

/**
 * Build deterministic fingerprint from normalized headers + inferred types + sheet stats.
 * @param {object} params
 * @param {Array} params.sheets - [{ sheet_name, columns, inferred_type, time_column_guess, time_granularity_guess }]
 * @returns {string}
 */
export const buildDatasetFingerprint = ({ sheets = [] } = {}) => {
  const normalizedSheets = (Array.isArray(sheets) ? sheets : [])
    .map((sheet) => {
      const columns = Array.isArray(sheet.columns) ? sheet.columns : [];
      const normalizedHeaders = columns.map(normalizeHeader).filter(Boolean).sort();

      return {
        sheet_name: normalizeSheetName(sheet.sheet_name),
        normalized_headers: normalizedHeaders,
        inferred_type: String(sheet.inferred_type || 'unknown'),
        time_column_guess: normalizeHeader(sheet.time_column_guess || ''),
        time_granularity_guess: String(sheet.time_granularity_guess || 'unknown')
      };
    })
    .sort((a, b) => a.sheet_name.localeCompare(b.sheet_name));

  const serialized = stableStringify({ sheets: normalizedSheets });
  return `dsfp_${fnv1a32(serialized)}`;
};

export const datasetFingerprintInternals = {
  normalizeHeader,
  stableStringify,
  fnv1a32
};

