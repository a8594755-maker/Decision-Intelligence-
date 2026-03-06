/**
 * Data Validation and Cleaning Utilities
 * Performs data validation, type conversion, and cleaning based on schema definitions
 */

import UPLOAD_SCHEMAS from './uploadSchemas';
import { autoFillRows } from './dataAutoFill';

/**
 * Try parsing dates in multiple formats
 * Supports common date formats: YYYY-MM-DD, YYYY/MM/DD, DD-MM-YYYY, MM/DD/YYYY, Excel numeric format, etc.
 */
const parseDate = (dateValue) => {
  if (!dateValue) return null;

  // If already a Date object
  if (dateValue instanceof Date) {
    if (isNaN(dateValue.getTime())) return null;
    const isoDate = dateValue.toISOString().split('T')[0];
    // Validate year is reasonable (1900-2100)
    const year = parseInt(isoDate.split('-')[0]);
    if (year < 1900 || year > 2100) return null;
    return isoDate;
  }

  // If numeric, may be Excel date format (days since 1900-01-01)
  if (typeof dateValue === 'number') {
    // Excel date range: 1 to 50000 (approx 1900-01-01 to 2036-xx-xx)
    if (dateValue < 1 || dateValue > 50000) {
      return null;
    }
    
    try {
      // Excel date epoch is 1900-01-01, but has a bug: treats 1900 as leap year
      // So special handling is needed
      const excelEpoch = new Date(1900, 0, 1);
      const daysOffset = dateValue - 1; // Excel counts from 1
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

  // Check for invalid characters (e.g. non-ISO format + sign)
  // Allow standard ISO date formats like: 2022-03-02T13:55:13.263278+00:00 or 2022-03-02 13:55:13.263278+00:00
  if (str.includes('+') && !str.match(/^\d{4}-\d{2}-\d{2}[T\s]/)) {
    console.warn('Invalid date format detected:', str);
    return null;
  }

  // Try direct parsing (for ISO format)
  try {
    let date = new Date(str);
    if (!isNaN(date.getTime())) {
      const isoDate = date.toISOString().split('T')[0];
      const year = parseInt(isoDate.split('-')[0]);
      // Validate year is reasonable
      if (year < 1900 || year > 2100) {
        console.warn('Year out of reasonable range:', year, 'from', str);
        return null;
      }
      return isoDate;
    }
  } catch (e) {
    // Continue trying other formats
  }

  // Common date format regex patterns
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

  // Try each format
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
 * Try converting to number
 */
const parseNumber = (value) => {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  // If already a number
  if (typeof value === 'number') {
    return isNaN(value) ? null : value;
  }

  // Remove common non-numeric characters (commas, currency symbols, etc.)
  const cleaned = String(value).replace(/[,\s$€£¥]/g, '');
  const num = Number(cleaned);

  return isNaN(num) ? null : num;
};

/**
 * Try converting to boolean
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
 * Check if text content is abnormal data
 * Detects "??", "???", symbol-only content, etc.
 */
const isAbnormalText = (value) => {
  if (!value || value === '') return false;
  
  const str = String(value).trim();
  
  // Check if question mark sequence
  if (/^\?+$/.test(str)) return true;
  
  // Check if contains only symbols (no letters or digits)
  if (/^[^\w\u4e00-\u9fa5]+$/.test(str)) return true;
  
  // Check if common invalid marker
  const invalidMarkers = ['n/a', 'na', 'null', 'none', '--', '---', '____'];
  if (invalidMarkers.includes(str.toLowerCase())) return true;
  
  return false;
};

/**
 * Clean and validate phone number
 * @param {*} value - Raw phone number
 * @returns {Object} { value, errors }
 */
const parsePhone = (value) => {
  if (value === null || value === undefined || value === '') {
    return { value: null, errors: [] };
  }

  // Remove whitespace, parentheses, dashes, plus signs, etc.
  let cleaned = String(value)
    .replace(/[\s()\-+]/g, '')
    .trim();

  // Check if at least 6 digits
  const digitCount = (cleaned.match(/\d/g) || []).length;
  
  if (digitCount < 6) {
    return {
      value: cleaned,
      errors: [`Invalid phone number format: ${value} (at least 6 digits required)`]
    };
  }

  return { value: cleaned, errors: [] };
};

/**
 * Validate and clean a single field value
 * @param {*} value - Raw value
 * @param {Object} fieldDef - Field definition (from schema)
 * @param {string} uploadType - Upload type (for special validation logic)
 * @param {Object} row - Complete data row (for cross-field validation)
 * @returns {Object} { value, errors: [] }
 */
const validateAndCleanField = (value, fieldDef, uploadType, row = {}) => {
  const errors = [];
  let cleanedValue = value;

  // Check required fields
  if (fieldDef.required) {
    if (value === null || value === undefined || value === '' || 
        (typeof value === 'string' && value.trim().length === 0)) {
      
      // Special handling: inventory_snapshots onhand_qty can be empty, auto-set to 0
      if (uploadType === 'inventory_snapshots' && fieldDef.key === 'onhand_qty') {
        cleanedValue = 0;
        return { value: cleanedValue, errors: [] };
      }
      
      errors.push(`${fieldDef.label} is required and cannot be empty`);
      return { value: null, errors };
    }
  }

  // If empty and not required, return default value or null
  if (value === null || value === undefined || value === '') {
    return { value: fieldDef.default !== undefined ? fieldDef.default : null, errors: [] };
  }

  // Convert and validate based on type
  switch (fieldDef.type) {
    case 'string':
      cleanedValue = String(value).trim();
      
      // Check abnormal text content (for supplier_master)
      if (uploadType === 'supplier_master' && isAbnormalText(cleanedValue)) {
        errors.push(`${fieldDef.label} contains abnormal content: ${cleanedValue} (e.g. '??', '---' invalid markers)`);
      }
      
      // Special handling: phone field
      if (fieldDef.key === 'phone' && cleanedValue) {
        const phoneResult = parsePhone(cleanedValue);
        cleanedValue = phoneResult.value;
        if (phoneResult.errors.length > 0) {
          errors.push(...phoneResult.errors);
        }
      }
      // Special handling for week_bucket format - supports Excel date number auto-conversion
      if (fieldDef.key === 'week_bucket' && cleanedValue) {
        const strValue = String(cleanedValue).trim();
        const weekBucketPattern = /^\d{4}-W\d{1,2}$/;
        
        // First check if already in standard format
        if (weekBucketPattern.test(strValue)) {
          // Already correct format, no processing needed
        }
        // Check if Excel date number (e.g. 45935.833333333336)
        else if (typeof cleanedValue === 'number' || /^\d{5,6}(\.\d+)?$/.test(strValue)) {
          const numericValue = typeof cleanedValue === 'number' ? cleanedValue : parseFloat(strValue);
          // Try parsing as date
          const parsedDate = parseDate(numericValue);
          if (parsedDate) {
            // Convert to week bucket format YYYY-W##
            const date = new Date(parsedDate + 'T00:00:00');
            const year = date.getFullYear();
            // Calculate week number (ISO week)
            const d = new Date(Date.UTC(year, date.getMonth(), date.getDate()));
            const dayNum = d.getUTCDay() || 7;
            d.setUTCDate(d.getUTCDate() + 4 - dayNum);
            const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
            const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
            cleanedValue = `${year}-W${weekNo.toString().padStart(2, '0')}`;
          } else {
            errors.push(`${fieldDef.label} format incorrect, Excel date number conversion failed: ${strValue}`);
          }
        }
        // Try parsing as regular date then convert to week bucket
        else {
          const parsedDate = parseDate(cleanedValue);
          if (parsedDate) {
            const date = new Date(parsedDate + 'T00:00:00');
            const year = date.getFullYear();
            // Calculate week number (ISO week)
            const d = new Date(Date.UTC(year, date.getMonth(), date.getDate()));
            const dayNum = d.getUTCDay() || 7;
            d.setUTCDate(d.getUTCDate() + 4 - dayNum);
            const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
            const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
            cleanedValue = `${year}-W${weekNo.toString().padStart(2, '0')}`;
          } else {
            errors.push(`${fieldDef.label} format incorrect, should be YYYY-W## format (e.g. 2026-W02) or valid date`);
          }
        }
      }
      break;

    case 'date':
      cleanedValue = parseDate(value);
      if (cleanedValue === null && value !== null && value !== '') {
        errors.push(`${fieldDef.label} date format incorrect: ${value} (supported formats: YYYY-MM-DD, DD/MM/YYYY, etc.)`);
      }
      break;

    case 'boolean':
      cleanedValue = parseBoolean(value);
      if (cleanedValue === null && value !== null && value !== '') {
        errors.push(`${fieldDef.label} must be a boolean (true/false, yes/no), but got: ${value}`);
      }
      break;

    default:
      cleanedValue = value;
  }

  return { value: cleanedValue, errors };
};

/**
 * Transform raw data to system field structure based on columnMapping
 * @param {Array} rawRows - Raw data
 * @param {Object} columnMapping - Field mapping { excelColumn: systemFieldKey }
 * @returns {Array} Transformed data
 */
export const transformRows = (rawRows, columnMapping) => {
  return rawRows.map((rawRow, rowIndex) => {
    const transformed = { _originalRowIndex: rowIndex + 1 };

    // Iterate through mapping relationships
    Object.entries(columnMapping).forEach(([excelColumn, systemFieldKey]) => {
      if (systemFieldKey && systemFieldKey !== '') {
        transformed[systemFieldKey] = rawRow[excelColumn];
      }
    });

    return transformed;
  });
};

/**
 * Merge duplicate supplier data, keeping the most complete information
 * @param {Array} rows - Data rows to merge
 * @returns {Array} Merged data
 */
const mergeSupplierDuplicates = (rows) => {
  const codeMap = new Map();
  const nameMap = new Map();

  rows.forEach((row, originalIndex) => {
    const code = row.supplier_code;
    const name = row.supplier_name;
    
    // Prefer supplier_code as unique key
    const key = code || name;
    if (!key) return; // Skip rows with no code and no name

    // Find existing record
    let existing = codeMap.get(code) || nameMap.get(name);

    if (existing) {
      // Merge data: keep the most complete field values
      Object.keys(row).forEach(field => {
        const existingValue = existing.row[field];
        const newValue = row[field];
        
        // If existing value is empty, replace with new value
        if (!existingValue || existingValue === '' || existingValue === '-' || existingValue === 'N/A') {
          if (newValue && newValue !== '' && newValue !== '-' && newValue !== 'N/A') {
            existing.row[field] = newValue;
          }
        }
        // If both have values and differ, consider merging (e.g. email)
        else if (newValue && newValue !== existingValue) {
          // For certain fields (e.g. email), merge with comma
          if (field === 'email' && !existingValue.includes(newValue)) {
            existing.row[field] = `${existingValue}, ${newValue}`;
          }
          // For other fields, keep original value (first entry is usually most complete)
        }
      });
      
      // Record merged row numbers
      existing.mergedFromRows.push(originalIndex + 1);
    } else {
      // New record
      const newRecord = {
        row: { ...row },
        originalRow: originalIndex + 1,
        mergedFromRows: []
      };
      
      if (code) codeMap.set(code, newRecord);
      if (name) nameMap.set(name, newRecord);
    }
  });

  // Collect merged data
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
 * Check for duplicate data
 * @param {Array} rows - Data rows to check
 * @param {string} uploadType - Upload type
 * @returns {Object} { duplicateGroups, duplicateCount, mergedRows }
 */
const checkDuplicates = (rows, uploadType) => {
  const duplicateGroups = [];
  let duplicateCount = 0;

  // Define check fields based on different types
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

  // For supplier_master, perform smart merge
  if (uploadType === 'supplier_master') {
    const mergedResult = mergeSupplierDuplicates(rows);
    
    // Find records that were merged
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
      mergedRows: mergedResult.map(r => r.row) // Return merged data
    };
  } else {
    // Other types: use combined key check
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
 * Process time field (time_bucket) for demand_fg / po_open_lines
 * Auto-fill time_bucket from week_bucket, date, or time_bucket
 * Supports Excel date number auto-conversion to week bucket format
 * 
 * Field mapping suggestions:
 * - If content is 2026-W05, 2026-W06, etc. → map to week_bucket
 * - If content is 2026-02-10, etc. (date) → map to date
 * - If CSV column name is time_bucket, map to week_bucket or date; or directly to time_bucket (this function will try to parse)
 * 
 * @param {Object} row - Data row
 * @returns {Object} { time_bucket, errors }
 */
const processTimeBucket = (row) => {
  const errors = [];
  let timeBucket = null;

  const weekBucket = row.week_bucket;
  const date = row.date;
  const timeBucketRaw = row.time_bucket;

  // Prefer date, then week_bucket
  if (date) {
    const parsedDate = parseDate(date);
    if (parsedDate) {
      timeBucket = parsedDate;
    } else {
      errors.push('Date format incorrect, should be YYYY-MM-DD format');
    }
  } else if (weekBucket) {
    const trimmed = String(weekBucket).trim();
    const weekBucketPattern = /^\d{4}-W\d{1,2}$/;
    if (weekBucketPattern.test(trimmed)) {
      timeBucket = trimmed;
    } else {
      // Check if Excel date number, try to convert
      const numericValue = parseFloat(trimmed);
      if (!isNaN(numericValue) && numericValue > 40000 && numericValue < 60000) {
        const parsedDate = parseDate(numericValue);
        if (parsedDate) {
          // Convert to week bucket format YYYY-W##
          const dateObj = new Date(parsedDate + 'T00:00:00');
          const year = dateObj.getFullYear();
          const d = new Date(Date.UTC(year, dateObj.getMonth(), dateObj.getDate()));
          const dayNum = d.getUTCDay() || 7;
          d.setUTCDate(d.getUTCDate() + 4 - dayNum);
          const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
          const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
          timeBucket = `${year}-W${weekNo.toString().padStart(2, '0')}`;
        } else {
          errors.push('Week bucket format incorrect, Excel date number conversion failed');
        }
      } else {
        errors.push('Week bucket format incorrect, should be YYYY-W## format (e.g. 2026-W02)');
      }
    }
  } else if (timeBucketRaw) {
    // Support CSV field mapped to time_bucket: try parsing as week or date format
    const trimmed = String(timeBucketRaw).trim();
    const weekBucketPattern = /^\d{4}-W\d{1,2}$/;
    const parsedDate = parseDate(timeBucketRaw);
    
    if (weekBucketPattern.test(trimmed)) {
      timeBucket = trimmed;
    } else if (parsedDate) {
      timeBucket = parsedDate;
    } else {
      // Check if Excel date number (e.g. 45935.833333333336)
      const numericValue = parseFloat(trimmed);
      if (!isNaN(numericValue) && numericValue > 40000 && numericValue < 60000) {
        const excelParsedDate = parseDate(numericValue);
        if (excelParsedDate) {
          // Convert to week bucket format YYYY-W##
          const dateObj = new Date(excelParsedDate + 'T00:00:00');
          const year = dateObj.getFullYear();
          const d = new Date(Date.UTC(year, dateObj.getMonth(), dateObj.getDate()));
          const dayNum = d.getUTCDay() || 7;
          d.setUTCDate(d.getUTCDate() + 4 - dayNum);
          const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
          const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
          timeBucket = `${year}-W${weekNo.toString().padStart(2, '0')}`;
        } else {
          errors.push('time_bucket format incorrect, Excel date number conversion failed');
        }
      } else {
        errors.push('time_bucket format incorrect, should be YYYY-W## (e.g. 2026-W05) or YYYY-MM-DD (e.g. 2026-02-10)');
      }
    }
  } else {
    errors.push('Must fill in one of week_bucket, date, or time_bucket');
  }

  return { time_bucket: timeBucket, errors };
};

/**
 * Validate bom_edge special rules
 * @param {Object} row - Data row
 * @returns {Array} Error list
 */
const validateBomEdgeRules = (row) => {
  const errors = [];

  // Validate qty_per > 0
  if (row.qty_per !== null && row.qty_per !== undefined) {
    if (row.qty_per <= 0) {
      errors.push({ field: 'qty_per', fieldLabel: 'Quantity Per Unit', error: 'qty_per must be greater than 0', originalValue: row.qty_per });
    }
  }

  // Validate valid_from <= valid_to
  if (row.valid_from && row.valid_to) {
    const fromDate = new Date(row.valid_from);
    const toDate = new Date(row.valid_to);
    if (fromDate > toDate) {
      errors.push({ field: 'valid_from', fieldLabel: 'Valid From', error: 'valid_from cannot be later than valid_to', originalValue: row.valid_from });
    }
  }

  // Validate scrap_rate range (if provided)
  if (row.scrap_rate !== null && row.scrap_rate !== undefined && row.scrap_rate !== '') {
    const scrapRate = parseNumber(row.scrap_rate);
    if (scrapRate !== null) {
      if (scrapRate < 0 || scrapRate >= 1) {
        errors.push({ field: 'scrap_rate', fieldLabel: 'Scrap Rate', error: 'scrap_rate must be in range 0 <= scrap_rate < 1', originalValue: row.scrap_rate });
      }
    }
  }

  // Validate yield_rate range (if provided)
  if (row.yield_rate !== null && row.yield_rate !== undefined && row.yield_rate !== '') {
    const yieldRate = parseNumber(row.yield_rate);
    if (yieldRate !== null) {
      if (yieldRate <= 0 || yieldRate > 1) {
        errors.push({ field: 'yield_rate', fieldLabel: 'Yield Rate', error: 'yield_rate must be in range 0 < yield_rate <= 1', originalValue: row.yield_rate });
      }
    }
  }

  return errors;
};

/**
 * Validate po_open_lines special rules
 * @param {Object} row - Data row
 * @returns {Array} Error and warning list
 */
const validatePoOpenLinesRules = (row) => {
  const errors = [];
  const warnings = [];

  // Validate open_qty >= 0 (extra check, although schema already has min setting)
  if (row.open_qty !== null && row.open_qty !== undefined) {
    if (row.open_qty < 0) {
      errors.push({ 
        field: 'open_qty', 
        fieldLabel: 'Open Quantity', 
        error: 'open_qty cannot be less than 0', 
        originalValue: row.open_qty 
      });
    }
  }

  // Validate status field
  if (row.status !== null && row.status !== undefined && row.status !== '') {
    const validStatuses = ['open', 'closed', 'cancelled'];
    const normalizedStatus = String(row.status).toLowerCase().trim();
    
    if (!validStatuses.includes(normalizedStatus)) {
      // Auto-correct to 'open' and log warning
      row.status = 'open';
      warnings.push({ 
        field: 'status', 
        fieldLabel: 'Status', 
        error: `status value "${row.status}" not in allowed range (open/closed/cancelled), auto-set to 'open'`, 
        originalValue: row.status,
        type: 'warning' 
      });
    } else {
      // Normalize to lowercase
      row.status = normalizedStatus;
    }
  }

  // Validate time_bucket must exist (checked after processTimeBucket)
  if (!row.time_bucket || row.time_bucket === '') {
    errors.push({ 
      field: 'time_bucket', 
      fieldLabel: 'Time Bucket', 
      error: 'time_bucket field must exist (requires week_bucket or date)', 
      originalValue: null 
    });
  }

  return [...errors, ...warnings];
};

/**
 * Validate inventory_snapshots special rules
 * @param {Object} row - Data row
 * @returns {Array} Error list
 */
const validateInventorySnapshotsRules = (row) => {
  const errors = [];

  // Validate snapshot_date must be a valid date
  if (!row.snapshot_date || row.snapshot_date === '') {
    errors.push({ 
      field: 'snapshot_date', 
      fieldLabel: 'Snapshot Date', 
      error: 'snapshot_date is required', 
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

  // Validate allocated_qty >= 0
  if (row.allocated_qty !== null && row.allocated_qty !== undefined) {
    if (row.allocated_qty < 0) {
      errors.push({ 
        field: 'allocated_qty', 
        fieldLabel: 'Allocated Quantity', 
        error: 'allocated_qty cannot be less than 0', 
        originalValue: row.allocated_qty 
      });
    }
  }

  // Validate safety_stock >= 0
  if (row.safety_stock !== null && row.safety_stock !== undefined) {
    if (row.safety_stock < 0) {
      errors.push({ 
        field: 'safety_stock', 
        fieldLabel: 'Safety Stock', 
        error: 'safety_stock cannot be less than 0', 
        originalValue: row.safety_stock 
      });
    }
  }

  // Ensure default values are set correctly
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
 * Validate fg_financials special rules
 * @param {Object} row - Data row
 * @returns {Array} Error list
 */
const validateFgFinancialsRules = (row) => {
  const errors = [];

  // Validate unit_margin >= 0 (extra check)
  if (row.unit_margin !== null && row.unit_margin !== undefined) {
    if (row.unit_margin < 0) {
      errors.push({ 
        field: 'unit_margin', 
        fieldLabel: 'Unit Margin', 
        error: 'unit_margin cannot be less than 0', 
        originalValue: row.unit_margin 
      });
    }
  }

  // Validate unit_price >= 0 (if provided)
  if (row.unit_price !== null && row.unit_price !== undefined && row.unit_price !== '') {
    if (row.unit_price < 0) {
      errors.push({ 
        field: 'unit_price', 
        fieldLabel: 'Unit Price', 
        error: 'unit_price cannot be less than 0', 
        originalValue: row.unit_price 
      });
    }
  }

  // Validate valid_from <= valid_to (if both are provided)
  if (row.valid_from && row.valid_to) {
    const fromDate = new Date(row.valid_from);
    const toDate = new Date(row.valid_to);
    
    // Check if dates are valid
    if (!isNaN(fromDate.getTime()) && !isNaN(toDate.getTime())) {
      if (fromDate > toDate) {
        errors.push({ 
          field: 'valid_from', 
          fieldLabel: 'Valid From', 
          error: 'valid_from cannot be later than valid_to', 
          originalValue: row.valid_from 
        });
      }
    }
  }

  // Ensure currency default value
  if (!row.currency || row.currency === '') {
    row.currency = 'USD';
  }

  // plant_id can be empty (represents global pricing), no extra validation needed

  return errors;
};

/**
 * Validate and clean data rows
 * @param {Array} cleanRows - Data already transformed through field mapping
 * @param {string} uploadType - Upload type
 * @returns {Object} { validRows, errorRows, duplicateGroups, stats }
 */
export const validateAndCleanRows = (cleanRows, uploadType) => {
  const schema = UPLOAD_SCHEMAS[uploadType];
  if (!schema) {
    throw new Error(`Unknown upload type: ${uploadType}`);
  }

  const validRows = [];
  const errorRows = [];

  cleanRows.forEach((row, index) => {
    const cleanedRow = {};
    const rowErrors = [];

    // Only process fields defined in schema (auto-ignore extra fields)
    schema.fields.forEach(fieldDef => {
      const fieldKey = fieldDef.key;
      const originalValue = row[fieldKey];

      // Pass uploadType and complete row to validation function
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

    // Special handling: time field for demand_fg and po_open_lines
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

    // Special handling: bom_edge business rule validation
    if (uploadType === 'bom_edge') {
      const bomErrors = validateBomEdgeRules(cleanedRow);
      rowErrors.push(...bomErrors);
    }

    // Special handling: po_open_lines business rule validation
    if (uploadType === 'po_open_lines') {
      const poErrors = validatePoOpenLinesRules(cleanedRow);
      rowErrors.push(...poErrors);
    }

    // Special handling: inventory_snapshots business rule validation
    if (uploadType === 'inventory_snapshots') {
      const inventoryErrors = validateInventorySnapshotsRules(cleanedRow);
      rowErrors.push(...inventoryErrors);
    }

    // Special handling: fg_financials business rule validation
    if (uploadType === 'fg_financials') {
      const fgErrors = validateFgFinancialsRules(cleanedRow);
      rowErrors.push(...fgErrors);
    }

    // Determine if this row is valid
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

  // Duplicate check and smart merge (for specific upload types)
  const duplicateInfo = checkDuplicates(validRows, uploadType);
  
  // For supplier_master, use merged data
  const finalValidRows = (uploadType === 'supplier_master' && duplicateInfo.mergedRows) 
    ? duplicateInfo.mergedRows 
    : validRows;
  
  // Statistics
  const stats = {
    total: cleanRows.length,
    valid: finalValidRows.length, // Use merged count
    invalid: errorRows.length,
    duplicates: duplicateInfo.duplicateCount,
    merged: duplicateInfo.duplicateCount, // Merged count
    successRate: cleanRows.length > 0 
      ? Math.round((finalValidRows.length / cleanRows.length) * 100) 
      : 0
  };

  return {
    validRows: finalValidRows, // Return merged data
    errorRows,
    duplicateGroups: duplicateInfo.duplicateGroups,
    stats
  };
};

/**
 * Complete validation flow: transform + validate + clean
 * @param {Array} rawRows - Raw data
 * @param {string} uploadType - Upload type
 * @param {Object} columnMapping - Field mapping
 * @returns {Object} { validRows, errorRows, stats }
 */
export const validateAndCleanData = (rawRows, uploadType, columnMapping) => {
  // Step 1: Transform data structure based on mapping
  const transformedRows = transformRows(rawRows, columnMapping);

  // Step 2: Auto-fill fillable fields first, to avoid required validation failing due to missing values
  const { rows: preValidatedRows } = autoFillRows(transformedRows, uploadType);

  // Step 3: Validate and clean
  return validateAndCleanRows(preValidatedRows, uploadType);
};

export default validateAndCleanRows;

