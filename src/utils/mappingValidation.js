/**
 * Field Mapping Validation Utilities
 * Provides mapping completeness checks, shared between single-file and One-shot
 */

import UPLOAD_SCHEMAS from './uploadSchemas';

/**
 * Check required fields mapping status
 * @param {object} params
 * @param {string} params.uploadType - Upload type
 * @param {Array<string>} params.columns - Original column names
 * @param {object} params.columnMapping - Column mapping { source: target }
 * @returns {object} { missingRequired: string[], isComplete: boolean, coverage: number, mappedRequired: string[] }
 */
export function getRequiredMappingStatus({ uploadType, columns, columnMapping }) {
  // Get schema
  const schema = UPLOAD_SCHEMAS[uploadType];
  if (!schema) {
    console.error(`[getRequiredMappingStatus] Unknown uploadType: ${uploadType}`);
    return {
      missingRequired: [],
      isComplete: false,
      coverage: 0,
      mappedRequired: []
    };
  }

  // Get required fields
  const requiredFields = schema.fields
    .filter(f => f.required)
    .map(f => f.key);

  if (requiredFields.length === 0) {
    // No required fields, consider complete
    return {
      missingRequired: [],
      isComplete: true,
      coverage: 1.0,
      mappedRequired: []
    };
  }

  // Check which required fields have been mapped
  const mappedTargets = new Set(Object.values(columnMapping || {}));
  
  const mappedRequired = requiredFields.filter(rf => mappedTargets.has(rf));
  const missingRequired = requiredFields.filter(rf => !mappedTargets.has(rf));

  const coverage = mappedRequired.length / requiredFields.length;
  const isComplete = coverage >= 1.0;

  return {
    missingRequired,
    isComplete,
    coverage,
    mappedRequired
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
