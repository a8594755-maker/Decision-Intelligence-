/**
 * Field Pattern Inference (Mapping Layer 3)
 *
 * Value-based column inference — examines sample data to guess canonical field
 * names when header synonyms (Layer 1+2) fail to match.
 */

// ── Date detection ──────────────────────────────────────────────────────────
const DATE_PATTERNS = [
  /^\d{4}-\d{2}-\d{2}$/,             // 2024-01-15
  /^\d{2}\/\d{2}\/\d{4}$/,           // 15/01/2024 or 01/15/2024
  /^\d{2}-\d{2}-\d{4}$/,             // 15-01-2024
  /^\d{4}\/\d{2}\/\d{2}$/,           // 2024/01/15
  /^\d{4}-W\d{2}$/,                  // 2024-W03 (ISO week)
];

function looksLikeDate(value) {
  if (value === null || value === undefined || value === '') return false;
  // Excel serial date (1900-based: 1 to ~60000)
  if (typeof value === 'number' && value > 30 && value < 100000) return true;
  const s = String(value).trim();
  return DATE_PATTERNS.some(p => p.test(s));
}

// ── Code / ID detection ────────────────────────────────────────────────────
const PLANT_CODE_PATTERN = /^[A-Z]{1,4}\d{1,4}$/i;       // PL01, WH02, DC1
const MATERIAL_CODE_PATTERN = /^[A-Z]{2,5}[-_]?\d{3,}$/i; // MAT-001, SKU12345
const PO_PATTERN = /^(PO|SO|PR|RQ)[-_]?\d{3,}$/i;         // PO-12345, SO001

function looksLikePlantCode(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  return PLANT_CODE_PATTERN.test(String(value).trim());
}

function looksLikeMaterialCode(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  return MATERIAL_CODE_PATTERN.test(String(value).trim());
}

function looksLikePoNumber(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  return PO_PATTERN.test(String(value).trim());
}

// ── Numeric detection ───────────────────────────────────────────────────────
function looksLikeQuantity(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && Number.isInteger(n) || (n >= 0 && n < 1e9);
}

function looksLikePrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return false;
  const s = String(value);
  // Has exactly 2 decimal places or is a small-ish number
  return /\.\d{2}$/.test(s) || (n > 0 && n < 100000);
}

// ── Inference strategies ────────────────────────────────────────────────────

/**
 * Each strategy tests a set of sample values and returns a candidate canonical
 * field name plus a confidence score.
 */
const INFERENCE_STRATEGIES = [
  // Date fields
  {
    candidateFields: ['snapshot_date', 'date', 'order_date', 'actual_delivery_date', 'planned_delivery_date', 'cost_date'],
    test: looksLikeDate,
    confidence: 0.65,
    reason: 'Values match date patterns',
  },
  // Plant / site codes
  {
    candidateFields: ['plant_id'],
    test: looksLikePlantCode,
    confidence: 0.70,
    reason: 'Values match plant/site code pattern (e.g., PL01, WH02)',
  },
  // Material / SKU codes
  {
    candidateFields: ['material_code'],
    test: looksLikeMaterialCode,
    confidence: 0.65,
    reason: 'Values match material/SKU code pattern (e.g., MAT-001)',
  },
  // PO numbers
  {
    candidateFields: ['po_number'],
    test: looksLikePoNumber,
    confidence: 0.75,
    reason: 'Values match PO number pattern (e.g., PO-12345)',
  },
  // Price / cost / margin (decimal with 2dp)
  {
    candidateFields: ['unit_price', 'unit_margin'],
    test: looksLikePrice,
    confidence: 0.55,
    reason: 'Values look like prices/costs (positive decimals)',
  },
  // Generic quantity (non-negative integers)
  {
    candidateFields: ['demand_qty', 'open_qty', 'onhand_qty', 'received_qty', 'qty_per'],
    test: looksLikeQuantity,
    confidence: 0.50,
    reason: 'Values look like quantities (non-negative numbers)',
  },
];

// ── Main inference function ─────────────────────────────────────────────────

/**
 * Infer the canonical field name from a column's sample values.
 *
 * @param {any[]}    sampleValues     – Non-empty sample values from the column
 * @param {string[]} candidateFields  – Canonical fields still unmapped (narrows search)
 * @param {object}   [options]
 * @param {number}   [options.minMatchRate=0.6] – Fraction of values that must match
 * @returns {{ field: string, confidence: number, reason: string } | null}
 */
export function inferFieldFromValues(sampleValues, candidateFields = [], options = {}) {
  const { minMatchRate = 0.6 } = options;
  if (!sampleValues || sampleValues.length === 0) return null;

  // Filter out nulls/undefined/empty
  const clean = sampleValues.filter(v => v !== null && v !== undefined && v !== '');
  if (clean.length === 0) return null;

  let bestMatch = null;

  for (const strategy of INFERENCE_STRATEGIES) {
    // Skip strategies whose candidate fields are all already mapped
    const available = candidateFields.length > 0
      ? strategy.candidateFields.filter(f => candidateFields.includes(f))
      : strategy.candidateFields;
    if (available.length === 0) continue;

    // Test what fraction of sample values match
    const matchCount = clean.filter(v => strategy.test(v)).length;
    const matchRate = matchCount / clean.length;

    if (matchRate >= minMatchRate) {
      const adjustedConfidence = strategy.confidence * Math.min(matchRate, 1);

      if (!bestMatch || adjustedConfidence > bestMatch.confidence) {
        bestMatch = {
          field: available[0], // Prefer first available candidate
          confidence: Math.round(adjustedConfidence * 100) / 100,
          reason: `${strategy.reason} (${Math.round(matchRate * 100)}% match rate)`,
        };
      }
    }
  }

  return bestMatch;
}

/**
 * Infer fields for all unmapped columns in a sheet.
 *
 * @param {object}   params
 * @param {string[]} params.unmappedHeaders  – Raw headers with no synonym match
 * @param {object[]} params.sampleRows       – First N rows of the sheet
 * @param {string[]} params.alreadyMapped    – Canonical fields that are already mapped
 * @returns {Map<string, { field: string, confidence: number, reason: string }>}
 */
export function inferUnmappedColumns({ unmappedHeaders, sampleRows, alreadyMapped = [] }) {
  const results = new Map();
  const remaining = new Set(alreadyMapped);

  for (const header of unmappedHeaders) {
    const values = sampleRows.map(row => row[header]).filter(v => v !== undefined);
    // Candidate fields = everything NOT already mapped
    const candidates = INFERENCE_STRATEGIES
      .flatMap(s => s.candidateFields)
      .filter(f => !remaining.has(f));

    const inference = inferFieldFromValues(values, candidates);
    if (inference) {
      results.set(header, inference);
      remaining.add(inference.field); // Prevent double-mapping
    }
  }

  return results;
}

// Export individual testers for unit testing
export const _testers = { looksLikeDate, looksLikePlantCode, looksLikeMaterialCode, looksLikePoNumber, looksLikeQuantity, looksLikePrice };
