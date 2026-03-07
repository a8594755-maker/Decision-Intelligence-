/**
 * Field Mapping Validation Utilities
 * Provides mapping completeness checks, shared between single-file and One-shot
 */

import UPLOAD_SCHEMAS from './uploadSchemas';

/**
 * Confidence thresholds for field mapping decisions.
 */
export const CONFIDENCE_THRESHOLDS = {
  AUTO_ACCEPT: 0.85,   // Auto-accept mapping
  NEEDS_REVIEW: 0.60,  // Show in review UI, ask user to confirm
  UNMAPPED: 0.60,      // Below this → treat as unmapped
};

/**
 * Check required fields mapping status with per-field confidence scoring.
 *
 * @param {object} params
 * @param {string}        params.uploadType      - Upload type
 * @param {Array<string>} params.columns         - Original column names
 * @param {object}        params.columnMapping   - Column mapping { source: target }
 * @param {object}        [params.mappingMeta]   - Optional per-source confidence metadata
 *   { [sourceColumn]: { confidence: number, matchType: 'exact'|'synonym'|'inference' } }
 * @returns {object}
 */
export function getRequiredMappingStatus({ uploadType, columns, columnMapping, mappingMeta }) {
  // Get schema
  const schema = UPLOAD_SCHEMAS[uploadType];
  if (!schema) {
    console.error(`[getRequiredMappingStatus] Unknown uploadType: ${uploadType}`);
    return {
      missingRequired: [],
      isComplete: false,
      coverage: 0,
      mappedRequired: [],
      fieldConfidence: {},
      overallConfidence: 0,
      reviewRequired: false,
    };
  }

  // Get required fields
  const requiredFields = schema.fields
    .filter(f => f.required)
    .map(f => f.key);

  if (requiredFields.length === 0) {
    return {
      missingRequired: [],
      isComplete: true,
      coverage: 1.0,
      mappedRequired: [],
      fieldConfidence: {},
      overallConfidence: 1.0,
      reviewRequired: false,
    };
  }

  // Build reverse mapping: target → source
  const targetToSource = {};
  for (const [source, target] of Object.entries(columnMapping || {})) {
    if (target) targetToSource[target] = source;
  }

  // Check which required fields have been mapped
  const mappedTargets = new Set(Object.values(columnMapping || {}));
  const mappedRequired = requiredFields.filter(rf => mappedTargets.has(rf));
  const missingRequired = requiredFields.filter(rf => !mappedTargets.has(rf));

  const coverage = mappedRequired.length / requiredFields.length;
  const isComplete = coverage >= 1.0;

  // Build per-field confidence
  const fieldConfidence = {};
  let confidenceSum = 0;
  let confidenceCount = 0;
  let needsReview = false;

  for (const [source, target] of Object.entries(columnMapping || {})) {
    if (!target) continue;

    const meta = (mappingMeta || {})[source];
    const confidence = meta?.confidence ?? 1.0; // Default to 1.0 if no meta (legacy mappings)
    const matchType = meta?.matchType ?? 'exact';
    const fieldNeedsReview = confidence < CONFIDENCE_THRESHOLDS.AUTO_ACCEPT;

    fieldConfidence[target] = {
      source,
      confidence,
      matchType,
      needsReview: fieldNeedsReview,
    };

    confidenceSum += confidence;
    confidenceCount++;
    if (fieldNeedsReview) needsReview = true;
  }

  const overallConfidence = confidenceCount > 0
    ? Math.round((confidenceSum / confidenceCount) * 100) / 100
    : 0;

  return {
    missingRequired,
    isComplete,
    coverage,
    mappedRequired,
    fieldConfidence,
    overallConfidence,
    reviewRequired: needsReview,
  };
}

/**
 * Validate if columnMapping conforms to schema definition
 * @param {string} uploadType
 * @param {object} columnMapping
 * @returns {object} { valid: boolean, errors: string[] }
 */
export function validateColumnMapping(uploadType, columnMapping) {
  const schema = UPLOAD_SCHEMAS[uploadType];
  if (!schema) {
    return { valid: false, errors: [`Unknown uploadType: ${uploadType}`] };
  }

  const errors = [];
  const validTargets = new Set(schema.fields.map(f => f.key));

  // Check all targets are valid schema fields
  Object.entries(columnMapping || {}).forEach(([source, target]) => {
    if (target && !validTargets.has(target)) {
      errors.push(`Invalid target field "${target}" for source "${source}"`);
    }
  });

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Format missing required fields message
 * @param {Array<string>} missingRequired
 * @returns {string}
 */
export function formatMissingRequiredMessage(missingRequired) {
  if (!missingRequired || missingRequired.length === 0) {
    return '';
  }

  if (missingRequired.length === 1) {
    return `Missing required field: ${missingRequired[0]}`;
  }

  if (missingRequired.length <= 3) {
    return `Missing required fields: ${missingRequired.join(', ')}`;
  }

  return `Missing ${missingRequired.length} required fields: ${missingRequired.slice(0, 3).join(', ')}, ...`;
}

export default {
  getRequiredMappingStatus,
  validateColumnMapping,
  formatMissingRequiredMessage
};
