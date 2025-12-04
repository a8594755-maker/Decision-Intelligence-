/**
 * Data Cleaning Utilities
 * 数据清洗工具 - 处理脏数据、格式转换、验证
 */

/**
 * 解析日期（支持多种格式）
 * @param {any} value - 日期值（可能是字符串、数字、Date对象）
 * @returns {string|null} ISO 日期字符串 (YYYY-MM-DD) 或 null
 */
export const parseDate = (value) => {
  if (!value) return null;

  // 如果已经是 Date 对象
  if (value instanceof Date) {
    return value.toISOString().split('T')[0];
  }

  // 如果是 Excel 序列号 (数字)
  if (typeof value === 'number') {
    // Excel 日期从 1900-01-01 开始，序列号 1 = 1900-01-01
    // 但 Excel 错误地认为 1900 是闰年，所以需要调整
    const excelEpoch = new Date(1899, 11, 30); // 1899-12-30
    const date = new Date(excelEpoch.getTime() + value * 86400000);

    if (isNaN(date.getTime())) return null;
    return date.toISOString().split('T')[0];
  }

  // 如果是字符串
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;

    // 尝试多种日期格式
    const formats = [
      // ISO 格式: 2024-01-15, 2024/01/15
      /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/,
      // 中文格式: 2024年1月15日
      /^(\d{4})年(\d{1,2})月(\d{1,2})日?$/,
      // 美式格式: 01/15/2024, 1/15/2024
      /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
      // 欧式格式: 15.01.2024, 15-01-2024
      /^(\d{1,2})[-.](\d{1,2})[-.](\d{4})$/,
    ];

    for (const regex of formats) {
      const match = trimmed.match(regex);
      if (match) {
        let year, month, day;

        if (regex === formats[0] || regex === formats[1]) {
          // YYYY-MM-DD 或 YYYY年MM月DD日
          [, year, month, day] = match;
        } else if (regex === formats[2]) {
          // MM/DD/YYYY (美式)
          [, month, day, year] = match;
        } else if (regex === formats[3]) {
          // DD-MM-YYYY (欧式)
          [, day, month, year] = match;
        }

        year = parseInt(year, 10);
        month = parseInt(month, 10);
        day = parseInt(day, 10);

        // 验证日期有效性
        if (year < 1900 || year > 2100) return null;
        if (month < 1 || month > 12) return null;
        if (day < 1 || day > 31) return null;

        // 构造日期
        const date = new Date(year, month - 1, day);
        if (isNaN(date.getTime())) return null;

        return date.toISOString().split('T')[0];
      }
    }

    // 尝试使用 Date.parse (最后的尝试)
    const parsed = Date.parse(trimmed);
    if (!isNaN(parsed)) {
      const date = new Date(parsed);
      return date.toISOString().split('T')[0];
    }
  }

  return null;
};

/**
 * 解析数字（支持多种格式）
 * @param {any} value - 数字值
 * @param {object} options - 选项 { allowNegative, decimals }
 * @returns {number|null} 数字或 null
 */
export const parseNumber = (value, options = {}) => {
  const { allowNegative = true, decimals = 2 } = options;

  if (value === null || value === undefined || value === '') {
    return null;
  }

  // 如果已经是数字
  if (typeof value === 'number') {
    if (isNaN(value) || !isFinite(value)) return null;
    if (!allowNegative && value < 0) return null;
    return parseFloat(value.toFixed(decimals));
  }

  // 如果是字符串
  if (typeof value === 'string') {
    let cleaned = value.trim();

    // 移除常见的非数字字符
    cleaned = cleaned
      .replace(/,/g, '')           // 移除千位分隔符逗号
      .replace(/\s+/g, '')         // 移除空格
      .replace(/[^\d.-]/g, '');    // 只保留数字、点、负号

    if (!cleaned) return null;

    const parsed = parseFloat(cleaned);
    if (isNaN(parsed) || !isFinite(parsed)) return null;
    if (!allowNegative && parsed < 0) return null;

    return parseFloat(parsed.toFixed(decimals));
  }

  return null;
};

/**
 * 解析布尔值
 * @param {any} value - 布尔值
 * @returns {boolean|null} true, false 或 null
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
 * 清理文本（去除多余空格、特殊字符）
 * @param {any} value - 文本值
 * @param {object} options - 选项 { maxLength, allowEmpty }
 * @returns {string|null} 清理后的文本或 null
 */
export const cleanText = (value, options = {}) => {
  const { maxLength = 500, allowEmpty = false } = options;

  if (value === null || value === undefined) {
    return allowEmpty ? null : null;
  }

  let text = String(value).trim();

  // 替换多个空格为单个空格
  text = text.replace(/\s+/g, ' ');

  // 移除不可见字符（保留常见的换行、制表符）
  text = text.replace(/[^\S\r\n\t]/g, ' ');

  if (!text && !allowEmpty) {
    return null;
  }

  // 限制长度
  if (text.length > maxLength) {
    text = text.substring(0, maxLength);
  }

  return text || null;
};

/**
 * 验证和清洗单行数据（收货记录）
 * @param {object} row - 原始行数据
 * @param {object} fieldMapping - 字段映射 { systemField: excelColumn }
 * @returns {object} { isValid, cleanedData, errors }
 */
export const validateAndCleanGoodsReceipt = (row, fieldMapping) => {
  const errors = [];
  const cleanedData = {};

  // 必填字段
  const requiredFields = [
    'supplier_name',
    'material_code',
    'actual_delivery_date',
    'received_qty'
  ];

  // 处理每个映射的字段
  for (const [systemField, excelColumn] of Object.entries(fieldMapping)) {
    if (!excelColumn) continue; // 未映射的字段跳过

    const rawValue = row[excelColumn];

    switch (systemField) {
      case 'supplier_name':
      case 'supplier_code':
        cleanedData[systemField] = cleanText(rawValue, { maxLength: 200 });
        if (!cleanedData[systemField] && requiredFields.includes(systemField)) {
          errors.push(`${systemField} 不能为空`);
        }
        break;

      case 'material_code':
      case 'material_name':
      case 'po_number':
      case 'receipt_number':
        cleanedData[systemField] = cleanText(rawValue, { maxLength: 100 });
        if (!cleanedData[systemField] && requiredFields.includes(systemField)) {
          errors.push(`${systemField} 不能为空`);
        }
        break;

      case 'planned_delivery_date':
      case 'actual_delivery_date':
      case 'receipt_date':
        cleanedData[systemField] = parseDate(rawValue);
        if (!cleanedData[systemField] && requiredFields.includes(systemField)) {
          errors.push(`${systemField} 日期格式无效: ${rawValue}`);
        }
        break;

      case 'received_qty':
      case 'rejected_qty':
        cleanedData[systemField] = parseNumber(rawValue, { allowNegative: false, decimals: 2 });
        if (cleanedData[systemField] === null && requiredFields.includes(systemField)) {
          errors.push(`${systemField} 必须是有效数字`);
        }
        // 确保非负数
        if (cleanedData[systemField] !== null && cleanedData[systemField] < 0) {
          errors.push(`${systemField} 不能为负数`);
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

  // 业务规则验证
  if (cleanedData.rejected_qty > cleanedData.received_qty) {
    errors.push('不良数量不能大于收货数量');
  }

  // 日期逻辑验证
  if (cleanedData.planned_delivery_date && cleanedData.actual_delivery_date) {
    const planned = new Date(cleanedData.planned_delivery_date);
    const actual = new Date(cleanedData.actual_delivery_date);

    // 警告（不阻止导入）
    if (actual < planned) {
      // 提前交货，可能正常
    } else if ((actual - planned) / (1000 * 60 * 60 * 24) > 30) {
      errors.push(`警告: 延迟交货超过 30 天`);
    }
  }

  return {
    isValid: errors.length === 0,
    cleanedData,
    errors
  };
};

/**
 * 验证和清洗单行数据（价格历史）
 * @param {object} row - 原始行数据
 * @param {object} fieldMapping - 字段映射
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
          errors.push(`${systemField} 不能为空`);
        }
        break;

      case 'order_date':
        cleanedData[systemField] = parseDate(rawValue);
        if (!cleanedData[systemField] && requiredFields.includes(systemField)) {
          errors.push(`${systemField} 日期格式无效`);
        }
        break;

      case 'unit_price':
        cleanedData[systemField] = parseNumber(rawValue, { allowNegative: false, decimals: 4 });
        if (cleanedData[systemField] === null || cleanedData[systemField] <= 0) {
          errors.push(`${systemField} 必须是正数`);
        }
        break;

      case 'quantity':
        cleanedData[systemField] = parseNumber(rawValue, { allowNegative: false, decimals: 2 });
        break;

      case 'currency':
        cleanedData[systemField] = cleanText(rawValue, { maxLength: 10 });
        if (!cleanedData[systemField]) {
          cleanedData[systemField] = 'USD'; // 默认货币
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
 * 验证和清洗单行数据（供应商主档）
 * @param {object} row - 原始行数据
 * @param {object} fieldMapping - 字段映射
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
          errors.push(`${systemField} 不能为空`);
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
          cleanedData[systemField] = 'active'; // 默认状态
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
 * 批量验证和清洗数据
 * @param {Array} rows - 原始数据行数组
 * @param {string} dataType - 数据类型 (goods_receipt, price_history, supplier_master)
 * @param {object} fieldMapping - 字段映射
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
 * AI 辅助字段映射建议
 * @param {Array} excelColumns - Excel 列名数组
 * @param {Array} systemFields - 系统字段数组
 * @param {string} dataType - 数据类型
 * @returns {object} 建议的映射 { systemField: excelColumn }
 */
export const suggestFieldMapping = (excelColumns, systemFields, dataType) => {
  const suggestions = {};

  // 字段映射规则（基于关键词匹配）
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

    // 尝试匹配
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
