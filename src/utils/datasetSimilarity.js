import { datasetFingerprintInternals } from './datasetFingerprint';

const { normalizeHeader } = datasetFingerprintInternals;

const normalizeText = (value) => String(value || '').trim().toLowerCase();

const toSortedUnique = (values = []) => {
  const unique = new Set();
  (Array.isArray(values) ? values : []).forEach((value) => {
    const normalized = normalizeText(value);
    if (normalized) unique.add(normalized);
  });
  return Array.from(unique).sort((a, b) => a.localeCompare(b));
};

const toJaccard = (left = [], right = []) => {
  const a = new Set(left);
  const b = new Set(right);
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;

  let intersection = 0;
  a.forEach((item) => {
    if (b.has(item)) intersection += 1;
  });
  const union = a.size + b.size - intersection;
  return union > 0 ? (intersection / union) : 0;
};

const getDominantValue = (values = [], fallback = 'unknown') => {
  const counts = new Map();
  values.forEach((value) => {
    const normalized = normalizeText(value);
    if (!normalized) return;
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
  });
  const ranked = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  return ranked.length > 0 ? ranked[0][0] : fallback;
};

const getContractBySheetName = (contract_json = {}) => {
  const map = new Map();
  const datasets = Array.isArray(contract_json?.datasets) ? contract_json.datasets : [];
  datasets.forEach((dataset) => {
    const key = normalizeText(dataset?.sheet_name);
    if (!key) return;
    map.set(key, dataset);
  });
  return map;
};

export function buildSignature(profile_json = {}, contract_json = {}) {
  const sheets = Array.isArray(profile_json?.sheets) ? profile_json.sheets : [];
  const contractBySheet = getContractBySheetName(contract_json);

  const headers = [];
  const uploadTypes = [];
  const granularities = [];
  const keyFields = [];

  sheets.forEach((sheet) => {
    const sheetName = normalizeText(sheet?.sheet_name);
    const contractSheet = contractBySheet.get(sheetName) || {};
    const normalizedHeaders = Array.isArray(sheet?.normalized_headers)
      ? sheet.normalized_headers
      : (Array.isArray(sheet?.original_headers) ? sheet.original_headers.map(normalizeHeader) : []);

    normalizedHeaders.forEach((header) => headers.push(normalizeHeader(header)));
    uploadTypes.push(contractSheet?.upload_type || sheet?.likely_role || 'unknown');
    granularities.push(sheet?.grain_guess?.granularity || 'unknown');

    const sheetKeys = Array.isArray(sheet?.grain_guess?.keys) ? sheet.grain_guess.keys : [];
    sheetKeys.forEach((key) => keyFields.push(normalizeHeader(key)));
  });

  const workflowLabel = normalizeText(profile_json?.global?.workflow_guess?.label || 'unknown') || 'unknown';
  const dominantGranularity = getDominantValue(granularities, 'unknown');

  return {
    workflow_label: workflowLabel,
    sheet_count: sheets.length,
    canonical_headers: toSortedUnique(headers),
    upload_types: toSortedUnique(uploadTypes),
    granularities: toSortedUnique(granularities),
    key_fields: toSortedUnique(keyFields),
    dominant_granularity: dominantGranularity
  };
}

export function similarity(sigA = {}, sigB = {}) {
  const headersScore = toJaccard(sigA.canonical_headers || [], sigB.canonical_headers || []);
  const uploadTypesScore = toJaccard(sigA.upload_types || [], sigB.upload_types || []);
  const granularitySetScore = toJaccard(sigA.granularities || [], sigB.granularities || []);
  const keysScore = toJaccard(sigA.key_fields || [], sigB.key_fields || []);

  const dominantGranularityMatch = normalizeText(sigA.dominant_granularity) === normalizeText(sigB.dominant_granularity)
    ? 1
    : 0;
  const granularityScore = (granularitySetScore * 0.6) + (dominantGranularityMatch * 0.4);

  const sheetCountA = Number(sigA.sheet_count || 0);
  const sheetCountB = Number(sigB.sheet_count || 0);
  const maxSheetCount = Math.max(1, sheetCountA, sheetCountB);
  const sheetCountScore = 1 - Math.min(1, Math.abs(sheetCountA - sheetCountB) / maxSheetCount);

  const workflowMatch = normalizeText(sigA.workflow_label) === normalizeText(sigB.workflow_label) ? 1 : 0;

  const score = Number(Math.max(0, Math.min(1,
    (headersScore * 0.5)
    + (uploadTypesScore * 0.2)
    + (granularityScore * 0.1)
    + (keysScore * 0.1)
    + (sheetCountScore * 0.05)
    + (workflowMatch * 0.05)
  )).toFixed(4));

  const reasons = [];
  reasons.push(`header_jaccard=${headersScore.toFixed(3)}`);
  reasons.push(`upload_type_match=${uploadTypesScore.toFixed(3)}`);
  reasons.push(`granularity_match=${granularityScore.toFixed(3)}`);
  reasons.push(`key_grain_match=${keysScore.toFixed(3)}`);
  reasons.push(`sheet_count_match=${sheetCountScore.toFixed(3)}`);

  if (workflowMatch === 1) {
    reasons.push(`workflow_match=${normalizeText(sigA.workflow_label) || 'unknown'}`);
  }

  return { score, reasons };
}

export default {
  buildSignature,
  similarity
};
