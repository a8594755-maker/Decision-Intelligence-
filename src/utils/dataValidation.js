/**
 * 資料驗證與清洗工具
 * 根據 schema 定義進行資料驗證、類型轉換和清洗
 */

import UPLOAD_SCHEMAS from './uploadSchemas';
import { autoFillRows } from './dataAutoFill';

/**
 * 嘗試解析日期的多種格式
 * 支援常見的日期格式：YYYY-MM-DD, YYYY/MM/DD, DD-MM-YYYY, MM/DD/YYYY, Excel 數字格式等
 */
const parseDate = (dateValue) => {
  if (!dateValue) return null;

  // 如果已經是 Date 物件
  if (dateValue instanceof Date) {
    if (isNaN(dateValue.getTime())) return null;
    const isoDate = dateValue.toISOString().split('T')[0];
    // 驗證年份是否合理（1900-2100）
    const year = parseInt(isoDate.split('-')[0]);
    if (year < 1900 || year > 2100) return null;
    return isoDate;
  }

  // 如果是數字，可能是 Excel 日期格式（從 1900-01-01 開始的天數）
  if (typeof dateValue === 'number') {
    // Excel 日期範圍：1 到 50000（約 1900-01-01 到 2036-xx-xx）
    if (dateValue < 1 || dateValue > 50000) {
      return null;
    }
    
    try {
      // Excel 的日期基準是 1900-01-01，但有個 bug：把 1900 當成閏年
      // 所以需要特殊處理
      const excelEpoch = new Date(1900, 0, 1);
      const daysOffset = dateValue - 1; // Excel 從 1 開始計數
      const resultDate = new Date(excelEpoch.getTime() + daysOffset * 24 * 60 * 60 * 1000);
      
      if (isNaN(resultDate.getTime())) return null;
      
      const isoDate = resultDate.toISOString().split('T')[0];
      const year = parseInt(isoDate.split('-')[0]);
      if (year < 1900 || year > 2100) return null;
      
      return isoDate;
    } catch (e) {
      console.error('Error parsing Excel date number:', dateValue, e);
      return null;
    }
  }

  const str = String(dateValue).trim();
  if (!str) return null;

  // 檢查是否包含無效字符（如非ISO格式的+號）
  // 允許標準ISO日期格式，如：2022-03-02T13:55:13.263278+00:00 或 2022-03-02 13:55:13.263278+00:00
  if (str.includes('+') && !str.match(/^\d{4}-\d{2}-\d{2}[T\s]/)) {
    console.warn('Invalid date format detected:', str);
    return null;
  }

  // 嘗試直接解析（適用於 ISO 格式）
  try {
    let date = new Date(str);
    if (!isNaN(date.getTime())) {
      const isoDate = date.toISOString().split('T')[0];
      const year = parseInt(isoDate.split('-')[0]);
      // 驗證年份是否合理
      if (year < 1900 || year > 2100) {
        console.warn('Year out of reasonable range:', year, 'from', str);
        return null;
      }
      return isoDate;
    }
  } catch (e) {
    // 繼續嘗試其他格式
  }

  // 常見日期格式的正則表達式
  const patterns = [
    // YYYY-MM-DD or YYYY/MM/DD
    {
      regex: /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/,
      parse: (match) => {
        const year = parseInt(match[1]);
        const month = parseInt(match[2]) - 1;
        const day = parseInt(match[3]);
        if (year < 1900 || year > 2100) return null;
        return new Date(year, month, day);
      }
    },
    // DD-MM-YYYY or DD/MM/YYYY
    {
      regex: /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/,
      parse: (match) => {
        const day = parseInt(match[1]);
        const month = parseInt(match[2]) - 1;
        const year = parseInt(match[3]);
        if (year < 1900 || year > 2100) return null;
        return new Date(year, month, day);
      }
    },
    // YYYYMMDD
    {
      regex: /^(\d{4})(\d{2})(\d{2})$/,
      parse: (match) => {
        const year = parseInt(match[1]);
        const month = parseInt(match[2]) - 1;
        const day = parseInt(match[3]);
        if (year < 1900 || year > 2100) return null;
        return new Date(year, month, day);
      }
    }
  ];

  // 嘗試每個格式
  for (const pattern of patterns) {
    const match = str.match(pattern.regex);
    if (match) {
      try {
        const parsedDate = pattern.parse(match);
        if (parsedDate && !isNaN(parsedDate.getTime())) {
          return parsedDate.toISOString().split('T')[0];
        }
      } catch (e) {
        console.error('Error parsing date with pattern:', pattern.regex, e);
        continue;
      }
    }
  }

  console.warn('Unable to parse date:', dateValue);
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
 * @param {Object} row - 完整資料列（用於跨欄位驗證）
 * @returns {Object} { value, errors: [] }
 */
const validateAndCleanField = (value, fieldDef, uploadType, row = {}) => {
  const errors = [];
  let cleanedValue = value;

  // 檢查必填欄位
  if (fieldDef.required) {
    if (value === null || value === undefined || value === '' || 
        (typeof value === 'string' && value.trim().length === 0)) {
      
      // 特殊处理：inventory_snapshots 的 onhand_qty 可以为空，自动设为 0
      if (uploadType === 'inventory_snapshots' && fieldDef.key === 'onhand_qty') {
        cleanedValue = 0;
        return { value: cleanedValue, errors: [] };
      }
      
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
    
    case 'string':
      // Special handling for week_bucket format - 支援 Excel 日期數字自動轉換
      if (fieldDef.key === 'week_bucket' && cleanedValue) {
        const strValue = String(cleanedValue).trim();
        const weekBucketPattern = /^\d{4}-W\d{1,2}$/;
        
        // 首先檢查是否已經是標準格式
        if (weekBucketPattern.test(strValue)) {
          // 已是正確格式，無需處理
        }
        // 檢查是否為 Excel 日期數字（如 45935.833333333336）
        else if (typeof cleanedValue === 'number' || /^\d{5,6}(\.\d+)?$/.test(strValue)) {
          const numericValue = typeof cleanedValue === 'number' ? cleanedValue : parseFloat(strValue);
          // 嘗試解析為日期
          const parsedDate = parseDate(numericValue);
          if (parsedDate) {
            // 轉換為週桶格式 YYYY-W##
            const date = new Date(parsedDate + 'T00:00:00');
            const year = date.getFullYear();
            // 計算週數（ISO 週）
            const d = new Date(Date.UTC(year, date.getMonth(), date.getDate()));
            const dayNum = d.getUTCDay() || 7;
            d.setUTCDate(d.getUTCDate() + 4 - dayNum);
            const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
            const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
            cleanedValue = `${year}-W${weekNo.toString().padStart(2, '0')}`;
          } else {
            errors.push(`${fieldDef.label}格式不正確，Excel 日期數字轉換失敗：${strValue}`);
          }
        }
        // 嘗試解析為普通日期後轉換為週桶
        else {
          const parsedDate = parseDate(cleanedValue);
          if (parsedDate) {
            const date = new Date(parsedDate + 'T00:00:00');
            const year = date.getFullYear();
            // 計算週數（ISO 週）
            const d = new Date(Date.UTC(year, date.getMonth(), date.getDate()));
            const dayNum = d.getUTCDay() || 7;
            d.setUTCDate(d.getUTCDate() + 4 - dayNum);
            const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
            const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
            cleanedValue = `${year}-W${weekNo.toString().padStart(2, '0')}`;
          } else {
            errors.push(`${fieldDef.label}格式不正確，應為 YYYY-W## 格式（例如：2026-W02）或有效日期`);
          }
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
 * 合併重複的 supplier 資料，保留最完整的資訊
 * @param {Array} rows - 要合併的資料列
 * @returns {Array} 合併後的資料
 */
const mergeSupplierDuplicates = (rows) => {
  const codeMap = new Map(); // supplier_code -> row
  const nameMap = new Map(); // supplier_name -> row

  rows.forEach((row, originalIndex) => {
    const code = row.supplier_code;
    const name = row.supplier_name;
    
    // 優先使用 supplier_code 作為唯一鍵
    const key = code || name;
    if (!key) return; // 跳過無 code 也無 name 的行

    // 尋找現有記錄
    let existing = codeMap.get(code) || nameMap.get(name);

    if (existing) {
      // 合併資料：保留最完整的欄位值
      Object.keys(row).forEach(field => {
        const existingValue = existing.row[field];
        const newValue = row[field];
        
        // 如果現有值為空，用新值替換
        if (!existingValue || existingValue === '' || existingValue === '-' || existingValue === 'N/A') {
          if (newValue && newValue !== '' && newValue !== '-' && newValue !== 'N/A') {
            existing.row[field] = newValue;
          }
        }
        // 如果兩者都有值且不同，可以考慮合併（如 email）
        else if (newValue && newValue !== existingValue) {
          // 對於某些欄位（如 email），可以用逗號合併
          if (field === 'email' && !existingValue.includes(newValue)) {
            existing.row[field] = `${existingValue}, ${newValue}`;
          }
          // 對於其他欄位，保留原有值（第一筆通常最完整）
        }
      });
      
      // 記錄被合併的行號
      existing.mergedFromRows.push(originalIndex + 1);
    } else {
      // 新記錄
      const newRecord = {
        row: { ...row },
        originalRow: originalIndex + 1,
        mergedFromRows: []
      };
      
      if (code) codeMap.set(code, newRecord);
      if (name) nameMap.set(name, newRecord);
    }
  });

  // 收集合併後的資料
  const mergedRows = [];
  const seen = new Set();
  
  codeMap.forEach(record => {
    const key = JSON.stringify(record.row);
    if (!seen.has(key)) {
      mergedRows.push(record);
      seen.add(key);
    }
  });
  
  nameMap.forEach(record => {
    const key = JSON.stringify(record.row);
    if (!seen.has(key)) {
      mergedRows.push(record);
      seen.add(key);
    }
  });

  return mergedRows;
};

/**
 * 檢查重複資料
 * @param {Array} rows - 要檢查的資料列
 * @param {string} uploadType - 上傳類型
 * @returns {Object} { duplicateGroups, duplicateCount, mergedRows }
 */
const checkDuplicates = (rows, uploadType) => {
  const duplicateGroups = [];
  let duplicateCount = 0;

  // 根據不同類型定義檢查欄位
  const duplicateKeys = {
    supplier_master: ['supplier_code', 'supplier_name'],
    goods_receipt: ['supplier_name', 'material_code', 'receipt_date'],
    price_history: ['supplier_name', 'material_code', 'order_date'],
    quality_incident: ['supplier_name', 'material_code', 'incident_date']
  };

  const keysToCheck = duplicateKeys[uploadType];
  if (!keysToCheck || keysToCheck.length === 0) {
    return { duplicateGroups: [], duplicateCount: 0 };
  }

  // 針對 supplier_master，執行智能合併
  if (uploadType === 'supplier_master') {
    const mergedResult = mergeSupplierDuplicates(rows);
    
    // 找出有合併的記錄
    mergedResult.forEach(record => {
      if (record.mergedFromRows.length > 0) {
        duplicateGroups.push({
          type: 'merged',
          value: record.row.supplier_code || record.row.supplier_name,
          count: record.mergedFromRows.length + 1,
          originalRow: record.originalRow,
          mergedFromRows: record.mergedFromRows,
          mergedData: record.row
        });
        duplicateCount += record.mergedFromRows.length;
      }
    });

    return {
      duplicateGroups,
      duplicateCount,
      mergedRows: mergedResult.map(r => r.row) // 返回合併後的資料
    };
  } else {
    // 其他類型：使用組合 key 檢查
    const combinedKeyMap = new Map();
    rows.forEach((row, index) => {
      const keyParts = keysToCheck.map(key => row[key] || '').filter(v => v !== '');
      if (keyParts.length === keysToCheck.length) {
        const combinedKey = keyParts.join('|');
        if (!combinedKeyMap.has(combinedKey)) {
          combinedKeyMap.set(combinedKey, []);
        }
        combinedKeyMap.get(combinedKey).push({ index, row });
      }
    });

    combinedKeyMap.forEach((items, key) => {
      if (items.length > 1) {
        duplicateGroups.push({
          type: 'combined',
          keys: keysToCheck,
          value: key,
          count: items.length,
          rows: items.map(item => ({
            rowIndex: item.index + 1,
            ...item.row
          }))
        });
        duplicateCount += items.length - 1;
      }
    });
  }

  return { duplicateGroups, duplicateCount };
};

/**
 * 處理 demand_fg / po_open_lines 的時間欄位（time_bucket）
 * 從 week_bucket、date 或 time_bucket 自動填入 time_bucket
 * 支援 Excel 日期數字自動轉換為週桶格式
 * 
 * 欄位對應建議：
 * - 若內容是 2026-W05、2026-W06 等 → 對應到 week_bucket
 * - 若內容是 2026-02-10 等日期 → 對應到 date
 * - 若 CSV 欄位名為 time_bucket，對應到 week_bucket 或 date；或直接對應 time_bucket（本函數會嘗試解析）
 * 
 * @param {Object} row - 資料列
 * @returns {Object} { time_bucket, errors }
 */
const processTimeBucket = (row) => {
  const errors = [];
  let timeBucket = null;

  const weekBucket = row.week_bucket;
  const date = row.date;
  const timeBucketRaw = row.time_bucket;

  // 優先使用 date，其次 week_bucket
  if (date) {
    const parsedDate = parseDate(date);
    if (parsedDate) {
      timeBucket = parsedDate;
    } else {
      errors.push('日期格式不正確，應為 YYYY-MM-DD 格式');
    }
  } else if (weekBucket) {
    const trimmed = String(weekBucket).trim();
    const weekBucketPattern = /^\d{4}-W\d{1,2}$/;
    if (weekBucketPattern.test(trimmed)) {
      timeBucket = trimmed;
    } else {
      // 檢查是否為 Excel 日期數字，嘗試轉換
      const numericValue = parseFloat(trimmed);
      if (!isNaN(numericValue) && numericValue > 40000 && numericValue < 60000) {
        const parsedDate = parseDate(numericValue);
        if (parsedDate) {
          // 轉換為週桶格式 YYYY-W##
          const dateObj = new Date(parsedDate + 'T00:00:00');
          const year = dateObj.getFullYear();
          const d = new Date(Date.UTC(year, dateObj.getMonth(), dateObj.getDate()));
          const dayNum = d.getUTCDay() || 7;
          d.setUTCDate(d.getUTCDate() + 4 - dayNum);
          const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
          const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
          timeBucket = `${year}-W${weekNo.toString().padStart(2, '0')}`;
        } else {
          errors.push('週桶格式不正確，Excel 日期數字轉換失敗');
        }
      } else {
        errors.push('週桶格式不正確，應為 YYYY-W## 格式（例如：2026-W02）');
      }
    }
  } else if (timeBucketRaw) {
    // 支援 CSV 欄位對應到 time_bucket：嘗試解析為 week 或 date 格式
    const trimmed = String(timeBucketRaw).trim();
    const weekBucketPattern = /^\d{4}-W\d{1,2}$/;
    const parsedDate = parseDate(timeBucketRaw);
    
    if (weekBucketPattern.test(trimmed)) {
      timeBucket = trimmed;
    } else if (parsedDate) {
      timeBucket = parsedDate;
    } else {
      // 檢查是否為 Excel 日期數字（如 45935.833333333336）
      const numericValue = parseFloat(trimmed);
      if (!isNaN(numericValue) && numericValue > 40000 && numericValue < 60000) {
        const excelParsedDate = parseDate(numericValue);
        if (excelParsedDate) {
          // 轉換為週桶格式 YYYY-W##
          const dateObj = new Date(excelParsedDate + 'T00:00:00');
          const year = dateObj.getFullYear();
          const d = new Date(Date.UTC(year, dateObj.getMonth(), dateObj.getDate()));
          const dayNum = d.getUTCDay() || 7;
          d.setUTCDate(d.getUTCDate() + 4 - dayNum);
          const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
          const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
          timeBucket = `${year}-W${weekNo.toString().padStart(2, '0')}`;
        } else {
          errors.push('time_bucket 格式不正確，Excel 日期數字轉換失敗');
        }
      } else {
        errors.push('time_bucket 格式不正確，應為 YYYY-W##（如 2026-W05）或 YYYY-MM-DD（如 2026-02-10）');
      }
    }
  } else {
    errors.push('必須填寫 week_bucket、date 或 time_bucket 其中一個欄位');
  }

  return { time_bucket: timeBucket, errors };
};

/**
 * 驗證 bom_edge 的特殊規則
 * @param {Object} row - 資料列
 * @returns {Array} 錯誤列表
 */
const validateBomEdgeRules = (row) => {
  const errors = [];

  // 驗證 qty_per > 0
  if (row.qty_per !== null && row.qty_per !== undefined) {
    if (row.qty_per <= 0) {
      errors.push({ field: 'qty_per', fieldLabel: 'Quantity Per Unit', error: 'qty_per 必須大於 0', originalValue: row.qty_per });
    }
  }

  // 驗證 valid_from <= valid_to
  if (row.valid_from && row.valid_to) {
    const fromDate = new Date(row.valid_from);
    const toDate = new Date(row.valid_to);
    if (fromDate > toDate) {
      errors.push({ field: 'valid_from', fieldLabel: 'Valid From', error: 'valid_from 不能晚於 valid_to', originalValue: row.valid_from });
    }
  }

  // 驗證 scrap_rate 範圍（如果填寫）
  if (row.scrap_rate !== null && row.scrap_rate !== undefined && row.scrap_rate !== '') {
    const scrapRate = parseNumber(row.scrap_rate);
    if (scrapRate !== null) {
      if (scrapRate < 0 || scrapRate >= 1) {
        errors.push({ field: 'scrap_rate', fieldLabel: 'Scrap Rate', error: 'scrap_rate 必須在 0 <= scrap_rate < 1 範圍內', originalValue: row.scrap_rate });
      }
    }
  }

  // 驗證 yield_rate 範圍（如果填寫）
  if (row.yield_rate !== null && row.yield_rate !== undefined && row.yield_rate !== '') {
    const yieldRate = parseNumber(row.yield_rate);
    if (yieldRate !== null) {
      if (yieldRate <= 0 || yieldRate > 1) {
        errors.push({ field: 'yield_rate', fieldLabel: 'Yield Rate', error: 'yield_rate 必須在 0 < yield_rate <= 1 範圍內', originalValue: row.yield_rate });
      }
    }
  }

  return errors;
};

/**
 * 驗證 po_open_lines 的特殊規則
 * @param {Object} row - 資料列
 * @returns {Array} 錯誤與警告列表
 */
const validatePoOpenLinesRules = (row) => {
  const errors = [];
  const warnings = [];

  // 驗證 open_qty >= 0（額外檢查，雖然 schema 已經有 min 設定）
  if (row.open_qty !== null && row.open_qty !== undefined) {
    if (row.open_qty < 0) {
      errors.push({ 
        field: 'open_qty', 
        fieldLabel: 'Open Quantity', 
        error: 'open_qty 不能小於 0', 
        originalValue: row.open_qty 
      });
    }
  }

  // 驗證 status 欄位
  if (row.status !== null && row.status !== undefined && row.status !== '') {
    const validStatuses = ['open', 'closed', 'cancelled'];
    const normalizedStatus = String(row.status).toLowerCase().trim();
    
    if (!validStatuses.includes(normalizedStatus)) {
      // 自動修正為 'open' 並記錄警告
      row.status = 'open';
      warnings.push({ 
        field: 'status', 
        fieldLabel: 'Status', 
        error: `status 值「${row.status}」不在允許範圍內（open/closed/cancelled），已自動設為 'open'`, 
        originalValue: row.status,
        type: 'warning' 
      });
    } else {
      // 標準化為小寫
      row.status = normalizedStatus;
    }
  }

  // 驗證 time_bucket 必須存在（在 processTimeBucket 之後檢查）
  if (!row.time_bucket || row.time_bucket === '') {
    errors.push({ 
      field: 'time_bucket', 
      fieldLabel: 'Time Bucket', 
      error: 'time_bucket 欄位必須存在（需要 week_bucket 或 date）', 
      originalValue: null 
    });
  }

  return [...errors, ...warnings];
};

/**
 * 驗證 inventory_snapshots 的特殊規則
 * @param {Object} row - 資料列
 * @returns {Array} 錯誤列表
 */
const validateInventorySnapshotsRules = (row) => {
  const errors = [];

  // 驗證 snapshot_date 必須是有效日期
  if (!row.snapshot_date || row.snapshot_date === '') {
    errors.push({ 
      field: 'snapshot_date', 
      fieldLabel: 'Snapshot Date', 
      error: 'snapshot_date 為必填欄位', 
      originalValue: row.snapshot_date 
    });
  }

  // Compute shortage_qty for negative onhand_qty
  if (row.onhand_qty !== null && row.onhand_qty !== undefined) {
    if (row.onhand_qty < 0) {
      // Compute shortage as positive value
      row.shortage_qty = Math.abs(row.onhand_qty);
      // Keep onhand_qty negative for data integrity, but don't treat as error
    }
  }

  // 驗證 allocated_qty >= 0
  if (row.allocated_qty !== null && row.allocated_qty !== undefined) {
    if (row.allocated_qty < 0) {
      errors.push({ 
        field: 'allocated_qty', 
        fieldLabel: 'Allocated Quantity', 
        error: 'allocated_qty 不能小於 0', 
        originalValue: row.allocated_qty 
      });
    }
  }

  // 驗證 safety_stock >= 0
  if (row.safety_stock !== null && row.safety_stock !== undefined) {
    if (row.safety_stock < 0) {
      errors.push({ 
        field: 'safety_stock', 
        fieldLabel: 'Safety Stock', 
        error: 'safety_stock 不能小於 0', 
        originalValue: row.safety_stock 
      });
    }
  }

  // 確保預設值設定正確
  if (row.allocated_qty === null || row.allocated_qty === undefined || row.allocated_qty === '') {
    row.allocated_qty = 0;
  }
  if (row.safety_stock === null || row.safety_stock === undefined || row.safety_stock === '') {
    row.safety_stock = 0;
  }
  if (row.shortage_qty === null || row.shortage_qty === undefined || row.shortage_qty === '') {
    row.shortage_qty = 0;
  }
  if (!row.uom || row.uom === '') {
    row.uom = 'pcs';
  }

  return errors;
};

/**
 * 驗證 fg_financials 的特殊規則
 * @param {Object} row - 資料列
 * @returns {Array} 錯誤列表
 */
const validateFgFinancialsRules = (row) => {
  const errors = [];

  // 驗證 unit_margin >= 0（額外檢查）
  if (row.unit_margin !== null && row.unit_margin !== undefined) {
    if (row.unit_margin < 0) {
      errors.push({ 
        field: 'unit_margin', 
        fieldLabel: 'Unit Margin', 
        error: 'unit_margin 不能小於 0', 
        originalValue: row.unit_margin 
      });
    }
  }

  // 驗證 unit_price >= 0（如果有填寫）
  if (row.unit_price !== null && row.unit_price !== undefined && row.unit_price !== '') {
    if (row.unit_price < 0) {
      errors.push({ 
        field: 'unit_price', 
        fieldLabel: 'Unit Price', 
        error: 'unit_price 不能小於 0', 
        originalValue: row.unit_price 
      });
    }
  }

  // 驗證 valid_from <= valid_to（如果兩者都有填寫）
  if (row.valid_from && row.valid_to) {
    const fromDate = new Date(row.valid_from);
    const toDate = new Date(row.valid_to);
    
    // 檢查日期是否有效
    if (!isNaN(fromDate.getTime()) && !isNaN(toDate.getTime())) {
      if (fromDate > toDate) {
        errors.push({ 
          field: 'valid_from', 
          fieldLabel: 'Valid From', 
          error: 'valid_from 不能晚於 valid_to', 
          originalValue: row.valid_from 
        });
      }
    }
  }

  // 確保 currency 預設值
  if (!row.currency || row.currency === '') {
    row.currency = 'USD';
  }

  // plant_id 可以為空（代表全球通用定價），不需要額外驗證

  return errors;
};

/**
 * 驗證並清洗資料列
 * @param {Array} cleanRows - 已經過欄位映射轉換的資料
 * @param {string} uploadType - 上傳類型
 * @returns {Object} { validRows, errorRows, duplicateGroups, stats }
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

      // 將 uploadType 和完整 row 傳遞給驗證函數
      const { value, errors } = validateAndCleanField(originalValue, fieldDef, uploadType, row);

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

    // 特殊處理：demand_fg 和 po_open_lines 的時間欄位
    if (uploadType === 'demand_fg' || uploadType === 'po_open_lines') {
      const { time_bucket, errors: timeErrors } = processTimeBucket(cleanedRow);
      cleanedRow.time_bucket = time_bucket;
      if (timeErrors.length > 0) {
        timeErrors.forEach(error => {
          rowErrors.push({
            field: 'time_bucket',
            fieldLabel: 'Time Bucket',
            error,
            originalValue: cleanedRow.week_bucket || cleanedRow.date
          });
        });
      }
    }

    // 特殊處理：bom_edge 的業務規則驗證
    if (uploadType === 'bom_edge') {
      const bomErrors = validateBomEdgeRules(cleanedRow);
      rowErrors.push(...bomErrors);
    }

    // 特殊處理：po_open_lines 的業務規則驗證
    if (uploadType === 'po_open_lines') {
      const poErrors = validatePoOpenLinesRules(cleanedRow);
      rowErrors.push(...poErrors);
    }

    // 特殊處理：inventory_snapshots 的業務規則驗證
    if (uploadType === 'inventory_snapshots') {
      const inventoryErrors = validateInventorySnapshotsRules(cleanedRow);
      rowErrors.push(...inventoryErrors);
    }

    // 特殊處理：fg_financials 的業務規則驗證
    if (uploadType === 'fg_financials') {
      const fgErrors = validateFgFinancialsRules(cleanedRow);
      rowErrors.push(...fgErrors);
    }

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

  // 重複檢查與智能合併（針對特定上傳類型）
  const duplicateInfo = checkDuplicates(validRows, uploadType);
  
  // 對於 supplier_master，使用合併後的資料
  const finalValidRows = (uploadType === 'supplier_master' && duplicateInfo.mergedRows) 
    ? duplicateInfo.mergedRows 
    : validRows;
  
  // 統計資訊
  const stats = {
    total: cleanRows.length,
    valid: finalValidRows.length, // 使用合併後的數量
    invalid: errorRows.length,
    duplicates: duplicateInfo.duplicateCount,
    merged: duplicateInfo.duplicateCount, // 合併的數量
    successRate: cleanRows.length > 0 
      ? Math.round((finalValidRows.length / cleanRows.length) * 100) 
      : 0
  };

  return {
    validRows: finalValidRows, // 返回合併後的資料
    errorRows,
    duplicateGroups: duplicateInfo.duplicateGroups,
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

  // Step 2: 先自動補齊可填欄位，避免因缺值導致必填驗證直接失敗
  const { rows: preValidatedRows } = autoFillRows(transformedRows, uploadType);

  // Step 3: 驗證並清洗
  return validateAndCleanRows(preValidatedRows, uploadType);
};

export default validateAndCleanRows;

