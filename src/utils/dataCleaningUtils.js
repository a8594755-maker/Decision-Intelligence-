/**
 * Data Cleaning Utilities
 * Handles dirty data, format conversion, and validation
 */

/**
 * Parse date (supports multiple formats)
 * @param {any} value - Date value (may be string, number, or Date object)
 * @returns {string|null} ISO date string (YYYY-MM-DD) or null
 */
export const parseDate = (value) => {
  if (!value) return null;

  // If already a Date object
  if (value instanceof Date) {
    return value.toISOString().split('T')[0];
  }

  // If Excel serial number (numeric)
  if (typeof value === 'number') {
    // Excel dates start from 1900-01-01, serial 1 = 1900-01-01
    // But Excel incorrectly treats 1900 as a leap year, so adjustment needed
    const excelEpoch = new Date(1899, 11, 30); // 1899-12-30
    const date = new Date(excelEpoch.getTime() + value * 86400000);

    if (isNaN(date.getTime())) return null;
    return date.toISOString().split('T')[0];
  }

  // If string
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;

    // Try multiple date formats
    const formats = [
      // ISO format: 2024-01-15, 2024/01/15
      /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/,
      // Chinese format: 2024年1月15日
      /^(\d{4})年(\d{1,2})月(\d{1,2})日?$/,
      // US format: 01/15/2024, 1/15/2024
      /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
      // European format: 15.01.2024, 15-01-2024
      /^(\d{1,2})[-.](\d{1,2})[-.](\d{4})$/,
    ];

    for (const regex of formats) {
      const match = trimmed.match(regex);
      if (match) {
        let year, month, day;

        if (regex === formats[0] || regex === formats[1]) {
          // YYYY-MM-DD or YYYY年MM月DD日
          [, year, month, day] = match;
        } else if (regex === formats[2]) {
          // MM/DD/YYYY (US)
          [, month, day, year] = match;
        } else if (regex === formats[3]) {
          // DD-MM-YYYY (European)
          [, day, month, year] = match;
        }

        year = parseInt(year, 10);
        month = parseInt(month, 10);
        day = parseInt(day, 10);

        // Validate date validity
        if (year < 1900 || year > 2100) return null;
        if (month < 1 || month > 12) return null;
        if (day < 1 || day > 31) return null;

        // Construct date
        const date = new Date(year, month - 1, day);
        if (isNaN(date.getTime())) return null;

        return date.toISOString().split('T')[0];
      }
    }

    // Try using Date.parse (last resort)
    const parsed = Date.parse(trimmed);
    if (!isNaN(parsed)) {
      const date = new Date(parsed);
      return date.toISOString().split('T')[0];
    }
  }

  return null;
};

/**
 * Parse number (supports multiple formats)
 * @param {any} value - Numeric value
 * @param {object} options - Options { allowNegative, decimals }
 * @returns {number|null} Number or null
 */
export const parseNumber = (value, options = {}) => {
  const { allowNegative = true, decimals = 2 } = options;

  if (value === null || value === undefined || value === '') {
    return null;
  }

  // If already a number
  if (typeof value === 'number') {
    if (isNaN(value) || !isFinite(value)) return null;
    if (!allowNegative && value < 0) return null;
    return parseFloat(value.toFixed(decimals));
  }

  // If string
  if (typeof value === 'string') {
    let cleaned = value.trim();

    // Remove common non-numeric characters
    cleaned = cleaned
      .replace(/,/g, '')           // Remove thousands separator commas
      .replace(/\s+/g, '')         // Remove spaces
      .replace(/[^\d.-]/g, '');    // Keep only digits, dots, minus sign

    if (!cleaned) return null;

    const parsed = parseFloat(cleaned);
    if (isNaN(parsed) || !isFinite(parsed)) return null;
    if (!allowNegative && parsed < 0) return null;

    return parseFloat(parsed.toFixed(decimals));
  }

  return null;
};

/**
 * Parse boolean value
 * @param {any} value - Boolean value
 * @returns {boolean|null} true, false, or null
 */
export const parseBoolean = (value) => {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (['true', 'yes', 'y', '是', '1', 't'].includes(lower)) {
      return true;
    }
    if (['false', 'no', 'n', '否', '0', 'f'].includes(lower)) {
      return false;
    }
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  return null;
};

/**
 * Clean text (remove extra spaces, special characters)
 * @param {any} value - Text value
 * @param {object} options - Options { maxLength, allowEmpty }
 * @returns {string|null} Cleaned text or null
 */
export const cleanText = (value, options = {}) => {
  const { maxLength = 500, allowEmpty = false } = options;

  if (value === null || value === undefined) {
    return allowEmpty ? null : null;
  }

  let text = String(value).trim();

  // Replace multiple spaces with single space
  text = text.replace(/\s+/g, ' ');

  // Remove invisible characters (keep common newlines, tabs)
  text = text.replace(/[^\S\r\n\t]/g, ' ');

  if (!text && !allowEmpty) {
    return null;
  }

  // Limit length
  if (text.length > maxLength) {
    text = text.substring(0, maxLength);
  }

  return text || null;
};

/**
 * Validate and clean single row data (goods receipt)
 * @param {object} row - Raw row data
 * @param {object} fieldMapping - Field mapping { systemField: excelColumn }
 * @returns {object} { isValid, cleanedData, errors }
 */
export const validateAndCleanGoodsReceipt = (row, fieldMapping) => {
  const errors = [];
  const cleanedData = {};

  // Required fields
  const requiredFields = [
    'supplier_name',
    'material_code',
    'actual_delivery_date',
    'received_qty'
  ];

  // Process each mapped field
  for (const [systemField, excelColumn] of Object.entries(fieldMapping)) {
    if (!excelColumn) continue; // Skip unmapped fields

    const rawValue = row[excelColumn];

    switch (systemField) {
      case 'supplier_name':
      case 'supplier_code':
        cleanedData[systemField] = cleanText(rawValue, { maxLength: 200 });
        if (!cleanedData[systemField] && requiredFields.includes(systemField)) {
          errors.push(`${systemField} cannot be empty`);
        }
        break;

      case 'material_code':
      case 'material_name':
      case 'po_number':
      case 'receipt_number':
        cleanedData[systemField] = cleanText(rawValue, { maxLength: 100 });
        if (!cleanedData[systemField] && requiredFields.includes(systemField)) {
          errors.push(`${systemField} cannot be empty`);
        }
        break;

      case 'planned_delivery_date':
      case 'actual_delivery_date':
      case 'receipt_date':
        cleanedData[systemField] = parseDate(rawValue);
        if (!cleanedData[systemField] && requiredFields.includes(systemField)) {
          errors.push(`${systemField} invalid date format: ${rawValue}`);
        }
        break;

      case 'received_qty':
      case 'rejected_qty':
        cleanedData[systemField] = parseNumber(rawValue, { allowNegative: false, decimals: 2 });
        if (cleanedData[systemField] === null && requiredFields.includes(systemField)) {
          errors.push(`${systemField} must be a valid number`);
        }
        // Ensure non-negative
        if (cleanedData[systemField] !== null && cleanedData[systemField] < 0) {
          errors.push(`${systemField} cannot be negative`);
          cleanedData[systemField] = 0;
        }
        break;

      case 'category':
      case 'uom':
        cleanedData[systemField] = cleanText(rawValue, { maxLength: 50 });
        break;

      default:
        cleanedData[systemField] = rawValue;
    }
  }

  // Business rule validation
  if (cleanedData.rejected_qty > cleanedData.received_qty) {
    errors.push('Rejected quantity cannot exceed received quantity');
  }

  // Date logic validation
  if (cleanedData.planned_delivery_date && cleanedData.actual_delivery_date) {
    const planned = new Date(cleanedData.planned_delivery_date);
    const actual = new Date(cleanedData.actual_delivery_date);

    // Warning (does not block import)
    if (actual < planned) {
      // Early delivery, may be normal
    } else if ((actual - planned) / (1000 * 60 * 60 * 24) > 30) {
      errors.push(`Warning: delivery delayed more than 30 days`);
    }
  }

  return {
    isValid: errors.length === 0,
    cleanedData,
    errors
  };
};

/**
 * Validate and clean single row data (price history)
 * @param {object} row - Raw row data
 * @param {object} fieldMapping - Field mapping
 * @returns {object} { isValid, cleanedData, errors }
 */
export const validateAndCleanPriceHistory = (row, fieldMapping) => {
  const errors = [];
  const cleanedData = {};

  const requiredFields = [
    'supplier_name',
    'material_code',
    'order_date',
    'unit_price'
  ];

  for (const [systemField, excelColumn] of Object.entries(fieldMapping)) {
    if (!excelColumn) continue;

    const rawValue = row[excelColumn];

    switch (systemField) {
      case 'supplier_name':
      case 'supplier_code':
      case 'material_code':
      case 'material_name':
        cleanedData[systemField] = cleanText(rawValue, { maxLength: 200 });
        if (!cleanedData[systemField] && requiredFields.includes(systemField)) {
          errors.push(`${systemField} cannot be empty`);
        }
        break;

      case 'order_date':
        cleanedData[systemField] = parseDate(rawValue);
        if (!cleanedData[systemField] && requiredFields.includes(systemField)) {
          errors.push(`${systemField} invalid date format`);
        }
        break;

      case 'unit_price':
        cleanedData[systemField] = parseNumber(rawValue, { allowNegative: false, decimals: 4 });
        if (cleanedData[systemField] === null || cleanedData[systemField] <= 0) {
          errors.push(`${systemField} must be a positive number`);
        }
        break;

      case 'quantity':
        cleanedData[systemField] = parseNumber(rawValue, { allowNegative: false, decimals: 2 });
        break;

      case 'currency':
        cleanedData[systemField] = cleanText(rawValue, { maxLength: 10 });
        if (!cleanedData[systemField]) {
          cleanedData[systemField] = 'USD'; // Default currency
        }
        break;

      case 'is_contract_price':
        cleanedData[systemField] = parseBoolean(rawValue);
        break;

      default:
        cleanedData[systemField] = rawValue;
    }
  }

  return {
    isValid: errors.length === 0,
    cleanedData,
    errors
  };
};

/**
 * Validate and clean single row data (supplier master)
 * @param {object} row - Raw row data
 * @param {object} fieldMapping - Field mapping
 * @returns {object} { isValid, cleanedData, errors }
 */
export const validateAndCleanSupplier = (row, fieldMapping) => {
  const errors = [];
  const cleanedData = {};

  const requiredFields = ['supplier_name'];

  for (const [systemField, excelColumn] of Object.entries(fieldMapping)) {
    if (!excelColumn) continue;

    const rawValue = row[excelColumn];

    switch (systemField) {
      case 'supplier_name':
      case 'supplier_code':
        cleanedData[systemField] = cleanText(rawValue, { maxLength: 200 });
        if (!cleanedData[systemField] && requiredFields.includes(systemField)) {
          errors.push(`${systemField} cannot be empty`);
        }
        break;

      case 'contact_person':
      case 'phone':
      case 'email':
      case 'address':
      case 'product_category':
      case 'payment_terms':
        cleanedData[systemField] = cleanText(rawValue, { maxLength: 500 });
        break;

      case 'delivery_time':
        cleanedData[systemField] = parseNumber(rawValue, { allowNegative: false, decimals: 0 });
        break;

      case 'status':
        const status = cleanText(rawValue);
        if (status && ['active', 'inactive'].includes(status.toLowerCase())) {
          cleanedData[systemField] = status.toLowerCase();
        } else {
          cleanedData[systemField] = 'active'; // Default status
        }
        break;

      default:
        cleanedData[systemField] = rawValue;
    }
  }

  return {
    isValid: errors.length === 0,
    cleanedData,
    errors
  };
};

/**
 * Batch validate and clean data
 * @param {Array} rows - Raw data row array
 * @param {string} dataType - Data type (goods_receipt, price_history, supplier_master)
 * @param {object} fieldMapping - Field mapping
 * @returns {object} { validRows, invalidRows, stats }
 */
export const batchValidateAndClean = (rows, dataType, fieldMapping) => {
  const validRows = [];
  const invalidRows = [];

  const validatorMap = {
    goods_receipt: validateAndCleanGoodsReceipt,
    price_history: validateAndCleanPriceHistory,
    supplier_master: validateAndCleanSupplier
  };

  const validator = validatorMap[dataType];
  if (!validator) {
    throw new Error(`Unknown data type: ${dataType}`);
  }

  rows.forEach((row, index) => {
    const result = validator(row, fieldMapping);

    if (result.isValid) {
      validRows.push({
        rowIndex: index + 1,
        ...result.cleanedData
      });
    } else {
      invalidRows.push({
        rowIndex: index + 1,
        originalData: row,
        errors: result.errors
      });
    }
  });

  return {
    validRows,
    invalidRows,
    stats: {
      total: rows.length,
      valid: validRows.length,
      invalid: invalidRows.length,
      successRate: ((validRows.length / rows.length) * 100).toFixed(2)
    }
  };
};

/**
 * AI-assisted field mapping suggestions
 * @param {Array} excelColumns - Excel column name array
 * @param {Array} systemFields - System field array
 * @param {string} dataType - Data type
 * @returns {object} Suggested mapping { systemField: excelColumn }
 */
export const suggestFieldMapping = (excelColumns, systemFields, dataType) => {
  const suggestions = {};

  // Field mapping rules (keyword-based matching)
  const mappingRules = {
    goods_receipt: {
      supplier_name: ['供应商', 'supplier', '厂商', 'vendor'],
      supplier_code: ['供应商编码', 'supplier_code', '厂商代码', 'vendor_code'],
      material_code: ['料号', '物料编码', 'material_code', 'part_number', '零件号'],
      material_name: ['物料名称', 'material_name', '品名', 'part_name'],
      po_number: ['采购单', 'po', 'purchase_order', '订单号'],
      receipt_number: ['收货单', 'receipt', 'grn', '入库单'],
      planned_delivery_date: ['计划交货', 'planned', '预计交货', 'expected_delivery'],
      actual_delivery_date: ['实际交货', 'actual', '到货日期', 'delivery_date'],
      receipt_date: ['收货日期', 'receipt_date', '入库日期'],
      received_qty: ['收货数量', 'received', '入库数量', 'qty'],
      rejected_qty: ['不良数量', 'rejected', '拒收', 'defect'],
      category: ['类别', 'category', '分类'],
      uom: ['单位', 'uom', 'unit']
    },
    price_history: {
      supplier_name: ['供应商', 'supplier', '厂商'],
      supplier_code: ['供应商编码', 'supplier_code'],
      material_code: ['料号', '物料编码', 'material_code'],
      material_name: ['物料名称', 'material_name'],
      order_date: ['订单日期', 'order_date', '下单日期'],
      unit_price: ['单价', 'price', 'unit_price', '价格'],
      currency: ['币别', 'currency', '货币'],
      quantity: ['数量', 'quantity', 'qty'],
      is_contract_price: ['合约价', 'contract', '协议价']
    },
    supplier_master: {
      supplier_name: ['供应商名称', 'supplier', '厂商'],
      supplier_code: ['供应商编码', 'code', '代码'],
      contact_person: ['联系人', 'contact'],
      phone: ['电话', 'phone', 'tel'],
      email: ['邮箱', 'email'],
      address: ['地址', 'address'],
      product_category: ['产品类别', 'category'],
      payment_terms: ['付款条件', 'payment'],
      delivery_time: ['交货时间', 'delivery'],
      status: ['状态', 'status']
    }
  };

  const rules = mappingRules[dataType] || {};

  systemFields.forEach(systemField => {
    const keywords = rules[systemField] || [];

    // Try matching
    for (const excelColumn of excelColumns) {
      const columnLower = excelColumn.toLowerCase();

      for (const keyword of keywords) {
        if (columnLower.includes(keyword.toLowerCase())) {
          suggestions[systemField] = excelColumn;
          break;
        }
      }

      if (suggestions[systemField]) break;
    }
  });

  return suggestions;
};

export default {
  parseDate,
  parseNumber,
  parseBoolean,
  cleanText,
  validateAndCleanGoodsReceipt,
  validateAndCleanPriceHistory,
  validateAndCleanSupplier,
  batchValidateAndClean,
  suggestFieldMapping
};
