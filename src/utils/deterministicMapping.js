import UPLOAD_SCHEMAS from './uploadSchemas';

export const normalizeMappingToken = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/[\s\-./]+/g, '_')
  .replace(/[^a-z0-9_]/g, '')
  .replace(/_+/g, '_')
  .replace(/^_+|_+$/g, '');

export const buildNormalizedColumnIndex = (columns = []) => {
  const index = new Map();
  (Array.isArray(columns) ? columns : []).forEach((column) => {
    const normalized = normalizeMappingToken(column);
    if (!normalized || index.has(normalized)) return;
    index.set(normalized, String(column));
  });
  return index;
};

export const resolveSourceColumn = (sourceCandidate, columns = [], prebuiltIndex = null) => {
  const candidate = String(sourceCandidate || '').trim();
  if (!candidate) return null;
  const list = Array.isArray(columns) ? columns : [];
  const exact = list.find((column) => String(column) === candidate);
  if (exact) return String(exact);

  const index = prebuiltIndex instanceof Map ? prebuiltIndex : buildNormalizedColumnIndex(columns);
  return index.get(normalizeMappingToken(candidate)) || null;
};

export const buildExactMatchSourceToTargetMapping = ({
  uploadType,
  columns = [],
  includeOptional = true,
  schemas = UPLOAD_SCHEMAS
} = {}) => {
  const schema = schemas?.[uploadType];
  if (!schema) return {};

  const index = buildNormalizedColumnIndex(columns);
  const fields = (schema.fields || [])
    .filter((field) => includeOptional || field.required);

  const mapping = {};
  const usedSources = new Set();
  const usedTargets = new Set();

  fields.forEach((field) => {
    const target = String(field?.key || '').trim();
    if (!target || usedTargets.has(target)) return;

    const source = index.get(normalizeMappingToken(target));
    if (!source || usedSources.has(source)) return;

    mapping[source] = target;
    usedSources.add(source);
    usedTargets.add(target);
  });

  return mapping;
};

const normalizeMappingObjectOrientation = ({
  uploadType,
  mapping = {},
  schemas = UPLOAD_SCHEMAS
}) => {
  const schema = schemas?.[uploadType];
  const validTargets = new Set((schema?.fields || []).map((field) => String(field.key)));
  const entries = Object.entries(mapping || {});
  if (entries.length === 0) return [];

  const keyHits = entries.filter(([key]) => validTargets.has(String(key))).length;
  const valueHits = entries.filter(([, value]) => validTargets.has(String(value))).length;
  const looksLikeTargetToSource = keyHits > valueHits;

  if (looksLikeTargetToSource) {
    return entries.map(([target, source]) => ({ source, target }));
  }

  return entries.map(([source, target]) => ({ source, target }));
};

export const normalizeToSourceToTargetMapping = ({
  uploadType,
  mapping = {},
  columns = [],
  schemas = UPLOAD_SCHEMAS
} = {}) => {
  const normalizedIndex = buildNormalizedColumnIndex(columns);
  const schema = schemas?.[uploadType];
  const validTargets = new Set((schema?.fields || []).map((field) => String(field.key)));
  const pairs = Array.isArray(mapping)
    ? mapping.map((item) => ({ source: item?.source, target: item?.target }))
    : normalizeMappingObjectOrientation({ uploadType, mapping, schemas });

  const normalized = {};
  const usedSources = new Set();
  const usedTargets = new Set();

  pairs.forEach((pair) => {
    const target = String(pair?.target || '').trim();
    if (!target) return;
    if (validTargets.size > 0 && !validTargets.has(target)) return;
    if (usedTargets.has(target)) return;

    const resolvedSource = resolveSourceColumn(pair?.source, columns, normalizedIndex);
    if (!resolvedSource) return;
    if (usedSources.has(resolvedSource)) return;

    normalized[resolvedSource] = target;
    usedSources.add(resolvedSource);
    usedTargets.add(target);
  });

  return normalized;
};

export const mergeAuthoritativeMapping = ({
  authoritativeMapping = {},
  fallbackMapping = {},
  uploadType,
  columns = [],
  schemas = UPLOAD_SCHEMAS
} = {}) => {
  const normalizedAuthoritative = normalizeToSourceToTargetMapping({
    uploadType,
    mapping: authoritativeMapping,
    columns,
    schemas
  });
  const normalizedFallback = normalizeToSourceToTargetMapping({
    uploadType,
    mapping: fallbackMapping,
    columns,
    schemas
  });

  const merged = { ...normalizedAuthoritative };
  const usedSources = new Set(Object.keys(merged));
  const usedTargets = new Set(Object.values(merged));

  Object.entries(normalizedFallback).forEach(([source, target]) => {
    if (!source || !target) return;
    if (usedSources.has(source) || usedTargets.has(target)) return;
    merged[source] = target;
    usedSources.add(source);
    usedTargets.add(target);
  });

  return merged;
};

export default {
  normalizeMappingToken,
  buildNormalizedColumnIndex,
  resolveSourceColumn,
  buildExactMatchSourceToTargetMapping,
  normalizeToSourceToTargetMapping,
  mergeAuthoritativeMapping
};
