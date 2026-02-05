/**
 * Field Mapping Validation Utilities
 * 提供 mapping 完整度檢查，供單檔與 One-shot 共用
 */

import UPLOAD_SCHEMAS from './uploadSchemas';

/**
 * 檢查 required fields mapping 狀態
 * @param {object} params
 * @param {string} params.uploadType - 上傳類型
 * @param {Array<string>} params.columns - 原始欄位名稱
 * @param {object} params.columnMapping - 欄位映射 { source: target }
 * @returns {object} { missingRequired: string[], isComplete: boolean, coverage: number, mappedRequired: string[] }
 */
export function getRequiredMappingStatus({ uploadType, columns, columnMapping }) {
  // 取得 schema
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

  // 取得 required fields
  const requiredFields = schema.fields
    .filter(f => f.required)
    .map(f => f.key);

  if (requiredFields.length === 0) {
    // 沒有 required fields，視為完整
    return {
      missingRequired: [],
      isComplete: true,
      coverage: 1.0,
      mappedRequired: []
    };
  }

  // 檢查哪些 required fields 已被 mapping
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
 * 驗證 columnMapping 是否符合 schema 定義
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

  // 檢查所有 target 是否為合法的 schema field
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
 * 格式化 missing required fields 訊息
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
