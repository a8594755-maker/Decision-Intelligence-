/**
 * Required Field Mapping Status Checker
 * Shared between single-file upload and One-shot Import
 * Provides strict required fields mapping checks
 */

import UPLOAD_SCHEMAS from './uploadSchemas';
import { normalizeToSourceToTargetMapping } from './deterministicMapping';

/**
 * Check required fields mapping status
 * @param {object} params
 * @param {string} params.uploadType - Upload type
 * @param {Array<string>} params.columns - Original column names (Excel headers)
 * @param {object|Array} params.columnMapping - Column mapping
 *   Format 1: { [excelHeader]: targetField } - object
 *   Format 2: [{ source, target }] - array
 * @param {object} params.schemas - (Optional) UPLOAD_SCHEMAS, uses default import if not provided
 * @returns {object} { missingRequired: string[], isComplete: boolean, coverage: number }
 */
export function getRequiredMappingStatus({ 
  uploadType, 
  columns, 
  columnMapping, 
  schemas = UPLOAD_SCHEMAS 
}) {
  // Get schema
  const schema = schemas[uploadType];
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

  const normalizedMapping = normalizeToSourceToTargetMapping({
    uploadType,
    mapping: columnMapping || {},
    columns: Array.isArray(columns) ? columns : [],
    schemas
  });
  const mappedTargets = new Set(Object.values(normalizedMapping));

  // Check which required fields have been mapped
  const mappedRequired = requiredFields.filter(rf => mappedTargets.has(rf));
  const missingRequired = requiredFields.filter(rf => !mappedTargets.has(rf));

  const coverage = requiredFields.length > 0 
    ? mappedRequired.length / requiredFields.length 
    : 1.0;
  const isComplete = coverage >= 1.0;

  return {
    missingRequired,
    isComplete,
    coverage,
    mappedRequired,
    mappingPairs: Object.entries(normalizedMapping).map(([source, target]) => ({ source, target }))
  };
}

/**
 * Validate if columnMapping conforms to schema definition
 * @param {string} uploadType
 * @param {object|Array} columnMapping
 * @param {object} schemas - (Optional)
 * @returns {object} { valid: boolean, errors: string[] }
 */
export function validateColumnMapping(uploadType, columnMapping, schemas = UPLOAD_SCHEMAS) {
  const schema = schemas[uploadType];
  if (!schema) {
    return { valid: false, errors: [`Unknown uploadType: ${uploadType}`] };
  }

  const errors = [];
  const validTargets = new Set(schema.fields.map(f => f.key));

  // Parse columnMapping (supports two formats)
  let mappings = [];
  if (Array.isArray(columnMapping)) {
    mappings = columnMapping;
  } else if (columnMapping && typeof columnMapping === 'object') {
    mappings = Object.entries(columnMapping).map(([source, target]) => ({ source, target }));
  }

  // Check all targets are valid schema fields
  mappings.forEach(m => {
    if (m.target && !validTargets.has(m.target)) {
      errors.push(`Invalid target field "${m.target}" for source "${m.source}"`);
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

  return `Missing ${missingRequired.length} required fields: ${missingRequired.slice(0, 3).join(', ')}, and ${missingRequired.length - 3} more`;
}

export default {
  getRequiredMappingStatus,
  validateColumnMapping,
  formatMissingRequiredMessage
};
