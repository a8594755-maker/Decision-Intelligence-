/**
 * Required Field Mapping Status Checker
 * 共用於單檔上傳與 One-shot Import
 * 提供嚴格的 required fields mapping 檢查
 */

import UPLOAD_SCHEMAS from './uploadSchemas';

/**
 * 檢查 required fields mapping 狀態
 * @param {object} params
 * @param {string} params.uploadType - 上傳類型
 * @param {Array<string>} params.columns - 原始欄位名稱（Excel headers）
 * @param {object|Array} params.columnMapping - 欄位映射
 *   格式 1: { [excelHeader]: targetField } - object
 *   格式 2: [{ source, target }] - array
 * @param {object} params.schemas - （可選）UPLOAD_SCHEMAS，若未提供則使用 default import
 * @returns {object} { missingRequired: string[], isComplete: boolean, coverage: number }
 */
export function getRequiredMappingStatus({ 
  uploadType, 
  columns, 
  columnMapping, 
  schemas = UPLOAD_SCHEMAS 
}) {
  // 取得 schema
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

  // 解析 columnMapping（支援兩種格式）
  let mappedTargets = new Set();
  
  if (Array.isArray(columnMapping)) {
    // 格式 2: array of { source, target }
    columnMapping.forEach(m => {
      if (m.target) {
        mappedTargets.add(m.target);
      }
    });
  } else if (columnMapping && typeof columnMapping === 'object') {
    // 格式 1: { [source]: target }
    Object.values(columnMapping).forEach(target => {
      if (target && target !== '' && target !== null && target !== undefined) {
        mappedTargets.add(target);
      }
    });
  }

  // 檢查哪些 required fields 已被 mapping
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
    mappedRequired
  };
}

/**
 * 驗證 columnMapping 是否符合 schema 定義
 * @param {string} uploadType
 * @param {object|Array} columnMapping
 * @param {object} schemas - （可選）
 * @returns {object} { valid: boolean, errors: string[] }
 */
export function validateColumnMapping(uploadType, columnMapping, schemas = UPLOAD_SCHEMAS) {
  const schema = schemas[uploadType];
  if (!schema) {
    return { valid: false, errors: [`Unknown uploadType: ${uploadType}`] };
  }

  const errors = [];
  const validTargets = new Set(schema.fields.map(f => f.key));

  // 解析 columnMapping（支援兩種格式）
  let mappings = [];
  if (Array.isArray(columnMapping)) {
    mappings = columnMapping;
  } else if (columnMapping && typeof columnMapping === 'object') {
    mappings = Object.entries(columnMapping).map(([source, target]) => ({ source, target }));
  }

  // 檢查所有 target 是否為合法的 schema field
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

  return `Missing ${missingRequired.length} required fields: ${missingRequired.slice(0, 3).join(', ')}, and ${missingRequired.length - 3} more`;
}

export default {
  getRequiredMappingStatus,
  validateColumnMapping,
  formatMissingRequiredMessage
};
