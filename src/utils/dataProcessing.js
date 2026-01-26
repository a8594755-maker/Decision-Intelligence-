/**
 * Data Processing Utilities
 * 處理數據相關的工具函數
 */

/**
 * 標準化欄位名稱（移除空格並轉小寫）
 */
export const normalizeKey = (key) => {
  return key.replace(/\s+/g, '').toLowerCase();
};

/**
 * 從數據中提取供應商信息
 */
export const extractSuppliers = (rows) => {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const nameKeys = ['supplier_name', 'supplier', '供應商名稱', '供应商名称'];
  const contactKeys = ['contact_info', 'contact', '聯絡方式', '联系方式', 'phone', 'email'];
  const addressKeys = ['address', '地址'];
  const categoryKeys = ['product_category', 'category', '產品類別', '产品类别'];
  const paymentKeys = ['payment_terms', '付款條件', '付款条件'];
  const deliveryKeys = ['delivery_time', '交貨時間', '交货时间', 'lead_time'];

  const findVal = (row, keys) => {
    const lowerMap = {};
    Object.keys(row || {}).forEach(k => lowerMap[normalizeKey(k)] = row[k]);

    for (const k of keys) {
      const val = lowerMap[normalizeKey(k)];
      if (val !== undefined && val !== null && val !== '') return String(val);
    }
    return '';
  };

  const seen = new Set();
  const extracted = [];

  rows.forEach((row) => {
    const supplier_name = findVal(row, nameKeys);
    if (!supplier_name) return;

    const contact_info = findVal(row, contactKeys);
    const address = findVal(row, addressKeys);
    const product_category = findVal(row, categoryKeys);
    const payment_terms = findVal(row, paymentKeys);
    const delivery_time = findVal(row, deliveryKeys);

    const key = `${supplier_name}|${contact_info}|${address}`;
    if (seen.has(key)) return;
    seen.add(key);

    extracted.push({
      supplier_name,
      contact_info,
      address,
      product_category,
      payment_terms,
      delivery_time
    });
  });

  return extracted;
};

/**
 * 計算數據統計信息
 */
export const calculateDataStats = (data) => {
  if (!data || !Array.isArray(data) || data.length === 0) {
    return null;
  }

  const stats = {
    totalRows: data.length,
    totalColumns: Object.keys(data[0]).length,
    columns: Object.keys(data[0]),
    emptyFields: 0,
    uniqueValues: {}
  };

  // Count empty fields and collect unique values per column
  data.forEach(row => {
    Object.entries(row).forEach(([key, value]) => {
      if (!value || value === '' || value === null || value === undefined) {
        stats.emptyFields++;
      }
      if (!stats.uniqueValues[key]) {
        stats.uniqueValues[key] = new Set();
      }
      stats.uniqueValues[key].add(String(value));
    });
  });

  // Convert Sets to counts
  Object.keys(stats.uniqueValues).forEach(key => {
    stats.uniqueValues[key] = stats.uniqueValues[key].size;
  });

  // Calculate data quality percentage
  stats.dataQuality = Math.round(
    (1 - stats.emptyFields / (stats.totalRows * stats.totalColumns)) * 100
  );

  return stats;
};

/**
 * 驗證文件格式
 */
export const validateFile = (file) => {
  const errors = [];

  if (!file) {
    errors.push("No file selected");
    return { valid: false, errors };
  }

  const fileName = file.name.toLowerCase();
  const isExcel = fileName.endsWith('.xlsx') || fileName.endsWith('.xls');
  const isCsv = fileName.endsWith('.csv');

  if (!isExcel && !isCsv) {
    errors.push("Invalid file type. Please upload CSV or Excel files (.csv, .xlsx, .xls)");
  }

  // Max 10MB
  const maxSize = 10 * 1024 * 1024;
  if (file.size > maxSize) {
    errors.push("File too large. Maximum size is 10MB");
  }

  return {
    valid: errors.length === 0,
    errors,
    fileType: isExcel ? 'excel' : isCsv ? 'csv' : 'unknown',
    fileSize: file.size
  };
};

/**
 * 搜索和過濾數據
 */
export const filterData = (data, searchTerm) => {
  if (!searchTerm || !searchTerm.trim()) return data;

  const lowerSearch = searchTerm.toLowerCase();

  return data.filter(row =>
    Object.values(row).some(val =>
      String(val).toLowerCase().includes(lowerSearch)
    )
  );
};

/**
 * 排序數據
 */
export const sortData = (data, column, direction = 'asc') => {
  if (!column) return data;

  return [...data].sort((a, b) => {
    const aVal = a[column];
    const bVal = b[column];

    if (aVal === bVal) return 0;
    if (aVal === null || aVal === undefined) return 1;
    if (bVal === null || bVal === undefined) return -1;

    const comparison = aVal < bVal ? -1 : 1;
    return direction === 'asc' ? comparison : -comparison;
  });
};

/**
 * 分頁數據
 */
export const paginateData = (data, page, rowsPerPage) => {
  const startIndex = (page - 1) * rowsPerPage;
  const endIndex = startIndex + rowsPerPage;

  return {
    data: data.slice(startIndex, endIndex),
    totalPages: Math.ceil(data.length / rowsPerPage),
    currentPage: page,
    totalRows: data.length,
    startIndex: startIndex + 1,
    endIndex: Math.min(endIndex, data.length)
  };
};

/**
 * 檢測數據中的數值欄位
 */
export const detectNumericColumns = (data) => {
  if (!data || data.length === 0) return [];

  const columns = Object.keys(data[0]);

  return columns.filter(col =>
    data.some(row => typeof row[col] === 'number' && !Number.isNaN(row[col]))
  );
};

/**
 * 計算欄位類別分布
 */
export const getCategoryDistribution = (data, column) => {
  if (!data || !column) return {};

  return data.reduce((acc, row) => {
    const key = row[column] ? String(row[column]) : 'Unspecified';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
};

/**
 * 格式化時間戳記
 */
export const formatTimestamp = (timestamp) => {
  if (!timestamp) return '';

  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;

  return date.toLocaleDateString();
};

/**
 * 數據導出輔助函數
 */
export const prepareDataForExport = (data, columns = null) => {
  if (!data || data.length === 0) return [];

  if (columns) {
    return data.map(row => {
      const filteredRow = {};
      columns.forEach(col => {
        filteredRow[col] = row[col];
      });
      return filteredRow;
    });
  }

  return data;
};

export default {
  normalizeKey,
  extractSuppliers,
  calculateDataStats,
  validateFile,
  filterData,
  sortData,
  paginateData,
  detectNumericColumns,
  getCategoryDistribution,
  formatTimestamp,
  prepareDataForExport
};
