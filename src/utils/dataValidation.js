/**
 * 資料驗證與清洗工具
 * 根據 schema 定義進行資料驗證、類型轉換和清洗
 */

import UPLOAD_SCHEMAS from './uploadSchemas';

/**
 * 嘗試解析日期的多種格式
 * 支援常見的日期格式：YYYY-MM-DD, YYYY/MM/DD, DD-MM-YYYY, MM/DD/YYYY 等
 */
const parseDate = (dateValue) => {
  if (!dateValue) return null;

  // 如果已經是 Date 物件
  if (dateValue instanceof Date) {
    return isNaN(dateValue.getTime()) ? null : dateValue.toISOString().split('T')[0];
  }

  const str = String(dateValue).trim();
  if (!str) return null;

  // 嘗試直接解析（適用於 ISO 格式）
  let date = new Date(str);
  if (!isNaN(date.getTime())) {
    return date.toISOString().split('T')[0];
  }

  // 常見日期格式的正則表達式
  const patterns = [
    // YYYY-MM-DD or YYYY/MM/DD
    {
      regex: /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/,
      parse: (match) => new Date(match[1], match[2] - 1, match[3])
    },
    // DD-MM-YYYY or DD/MM/YYYY
    {
      regex: /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/,
      parse: (match) => new Date(match[3], match[2] - 1, match[1])
    },
    // MM-DD-YYYY or MM/DD/YYYY (美式)
    {
      regex: /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/,
      parse: (match) => new Date(match[3], match[1] - 1, match[2])
    },
    // YYYYMMDD
    {
      regex: /^(\d{4})(\d{2})(\d{2})$/,
      parse: (match) => new Date(match[1], match[2] - 1, match[3])
    }
  ];

  // 嘗試每個格式
  for (const pattern of patterns) {
    const match = str.match(pattern.regex);
    if (match) {
      const parsedDate = pattern.parse(match);
      if (!isNaN(parsedDate.getTime())) {
        return parsedDate.toISOString().split('T')[0];
      }
    }
  }

  return null;
};

/**
 * 嘗試轉換為數字
 */
const parseNumber = (value) => {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  // 如果已經是數字
  if (typeof value === 'number') {
    return isNaN(value) ? null : value;
  }

  // 移除常見的非數字字符（逗號、貨幣符號等）
  const cleaned = String(value).replace(/[,\s$€£¥]/g, '');
  const num = Number(cleaned);

  return isNaN(num) ? null : num;
};

/**
 * 嘗試轉換為布林值
 */
const parseBoolean = (value) => {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined || value === '') return null;

  const str = String(value).toLowerCase().trim();
  if (['true', 'yes', '1', 'y', '是', 't'].includes(str)) return true;
  if (['false', 'no', '0', 'n', '否', 'f'].includes(str)) return false;

  return null;
};

/**
 * 檢查文字內容是否為異常資料
 * 檢測 "??", "???", 只有符號等情況
 */
const isAbnormalText = (value) => {
  if (!value || value === '') return false;
  
  const str = String(value).trim();
  
  // 檢查是否為問號序列
  if (/^\?+$/.test(str)) return true;
  
  // 檢查是否只包含符號（不含字母或數字）
  if (/^[^\w\u4e00-\u9fa5]+$/.test(str)) return true;
  
  // 檢查是否為常見的無效標記
  const invalidMarkers = ['n/a', 'na', 'null', 'none', '--', '---', '____'];
  if (invalidMarkers.includes(str.toLowerCase())) return true;
  
  return false;
};

/**
 * 清洗和驗證電話號碼
 * @param {*} value - 原始電話號碼
 * @returns {Object} { value, errors }
 */
const parsePhone = (value) => {
  if (value === null || value === undefined || value === '') {
    return { value: null, errors: [] };
  }

  // 移除空白、括號、dash、加號等
  let cleaned = String(value)
    .replace(/[\s\(\)\-\+]/g, '')
    .trim();

  // 檢查是否至少有 6 位數字
  const digitCount = (cleaned.match(/\d/g) || []).length;
  
  if (digitCount < 6) {
    return {
      value: cleaned,
      errors: [`電話號碼格式不正確：${value}（至少需要 6 位數字）`]
    };
  }

  return { value: cleaned, errors: [] };
};

/**
 * 驗證並清洗單一欄位的值
 * @param {*} value - 原始值
 * @param {Object} fieldDef - 欄位定義（來自 schema）
 * @param {string} uploadType - 上傳類型（用於特殊驗證邏輯）
 * @returns {Object} { value, errors: [] }
 */
const validateAndCleanField = (value, fieldDef, uploadType) => {
  const errors = [];
  let cleanedValue = value;

  // 檢查必填欄位
  if (fieldDef.required) {
    if (value === null || value === undefined || value === '' || 
        (typeof value === 'string' && value.trim().length === 0)) {
      errors.push(`${fieldDef.label}為必填欄位，不可為空`);
      return { value: null, errors };
    }
  }

  // 如果是空值且非必填，直接返回預設值或 null
  if (value === null || value === undefined || value === '') {
    return { value: fieldDef.default !== undefined ? fieldDef.default : null, errors: [] };
  }

  // 根據類型進行轉換和驗證
  switch (fieldDef.type) {
    case 'string':
      cleanedValue = String(value).trim();
      
      // 檢查異常文字內容（針對 supplier_master）
      if (uploadType === 'supplier_master' && isAbnormalText(cleanedValue)) {
        errors.push(`${fieldDef.label}包含異常內容：${cleanedValue}（例如：'??', '---' 等無效標記）`);
      }
      
      // 特殊處理：電話欄位
      if (fieldDef.key === 'phone' && cleanedValue) {
        const phoneResult = parsePhone(cleanedValue);
        cleanedValue = phoneResult.value;
        if (phoneResult.errors.length > 0) {
          errors.push(...phoneResult.errors);
        }
      }
      break;

    case 'number':
      cleanedValue = parseNumber(value);
      if (cleanedValue === null && value !== null && value !== '') {
        errors.push(`${fieldDef.label}必須是數字，但得到：${value}`);
      }
      // 檢查數值範圍
      if (cleanedValue !== null) {
        if (fieldDef.min !== undefined && cleanedValue < fieldDef.min) {
          errors.push(`${fieldDef.label}不能小於 ${fieldDef.min}`);
        }
        if (fieldDef.max !== undefined && cleanedValue > fieldDef.max) {
          errors.push(`${fieldDef.label}不能大於 ${fieldDef.max}`);
        }
      }
      break;

    case 'date':
      cleanedValue = parseDate(value);
      if (cleanedValue === null && value !== null && value !== '') {
        errors.push(`${fieldDef.label}的日期格式不正確：${value}（支援格式：YYYY-MM-DD, DD/MM/YYYY 等）`);
      }
      break;

    case 'boolean':
      cleanedValue = parseBoolean(value);
      if (cleanedValue === null && value !== null && value !== '') {
        errors.push(`${fieldDef.label}必須是布林值（true/false, yes/no, 是/否），但得到：${value}`);
      }
      break;

    default:
      cleanedValue = value;
  }

  return { value: cleanedValue, errors };
};

/**
 * 將原始資料根據 columnMapping 轉換為系統欄位結構
 * @param {Array} rawRows - 原始資料
 * @param {Object} columnMapping - 欄位映射 { excelColumn: systemFieldKey }
 * @returns {Array} 轉換後的資料
 */
export const transformRows = (rawRows, columnMapping) => {
  return rawRows.map((rawRow, rowIndex) => {
    const transformed = { _originalRowIndex: rowIndex + 1 };

    // 遍歷映射關係
    Object.entries(columnMapping).forEach(([excelColumn, systemFieldKey]) => {
      if (systemFieldKey && systemFieldKey !== '') {
        transformed[systemFieldKey] = rawRow[excelColumn];
      }
    });

    return transformed;
  });
};

/**
 * 驗證並清洗資料列
 * @param {Array} cleanRows - 已經過欄位映射轉換的資料
 * @param {string} uploadType - 上傳類型
 * @returns {Object} { validRows, errorRows, stats }
 */
export const validateAndCleanRows = (cleanRows, uploadType) => {
  const schema = UPLOAD_SCHEMAS[uploadType];
  if (!schema) {
    throw new Error(`未知的上傳類型：${uploadType}`);
  }

  const validRows = [];
  const errorRows = [];

  cleanRows.forEach((row, index) => {
    const cleanedRow = {};
    const rowErrors = [];

    // 只處理 schema 中定義的欄位（自動忽略多餘欄位）
    schema.fields.forEach(fieldDef => {
      const fieldKey = fieldDef.key;
      const originalValue = row[fieldKey];

      // 將 uploadType 傳遞給驗證函數
      const { value, errors } = validateAndCleanField(originalValue, fieldDef, uploadType);

      cleanedRow[fieldKey] = value;

      if (errors.length > 0) {
        errors.forEach(error => {
          rowErrors.push({
            field: fieldKey,
            fieldLabel: fieldDef.label,
            error,
            originalValue
          });
        });
      }
    });

    // 判斷這一行是否有效
    if (rowErrors.length === 0) {
      validRows.push(cleanedRow);
    } else {
      errorRows.push({
        rowIndex: row._originalRowIndex || index + 1,
        originalData: row,
        cleanedData: cleanedRow,
        errors: rowErrors
      });
    }
  });

  // 統計資訊
  const stats = {
    total: cleanRows.length,
    valid: validRows.length,
    invalid: errorRows.length,
    successRate: cleanRows.length > 0 
      ? Math.round((validRows.length / cleanRows.length) * 100) 
      : 0
  };

  return {
    validRows,
    errorRows,
    stats
  };
};

/**
 * 完整的驗證流程：轉換 + 驗證 + 清洗
 * @param {Array} rawRows - 原始資料
 * @param {string} uploadType - 上傳類型
 * @param {Object} columnMapping - 欄位映射
 * @returns {Object} { validRows, errorRows, stats }
 */
export const validateAndCleanData = (rawRows, uploadType, columnMapping) => {
  // Step 1: 根據 mapping 轉換資料結構
  const transformedRows = transformRows(rawRows, columnMapping);

  // Step 2: 驗證並清洗
  return validateAndCleanRows(transformedRows, uploadType);
};

export default validateAndCleanRows;

