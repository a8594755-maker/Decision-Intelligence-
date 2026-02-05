/**
 * Error Report Utilities
 * 生成與下載錯誤報告 CSV
 */

/**
 * 將錯誤資料轉換為 CSV 格式並觸發下載
 * @param {Object} options
 * @param {Array} options.errorRows - 驗證錯誤的資料行
 * @param {Array} options.rawRows - 原始資料（可選，用於完整資料參考）
 * @param {Array} options.columns - 欄位名稱（可選）
 * @param {string} options.uploadType - 上傳類型
 * @param {string} options.fileName - 原始檔案名稱
 */
export function downloadErrorReport({ errorRows, rawRows = [], columns = [], uploadType, fileName }) {
  if (!errorRows || errorRows.length === 0) {
    console.warn('No error rows to download');
    return;
  }

  // CSV 標題列
  const headers = [
    'Row Index',
    'Field',
    'Original Value',
    'Error Message',
    'Full Row Data (JSON)'
  ];

  // 組裝 CSV 資料行
  const csvRows = [];
  
  // 加入標題列
  csvRows.push(headers.join(','));

  // 處理每個錯誤行
  errorRows.forEach((errorRow) => {
    const { rowIndex, errors, originalRow } = errorRow;

    // 取得完整的原始資料（如果有提供 rawRows）
    const fullRowData = rawRows[rowIndex - 1] || originalRow || {};
    const fullRowJson = JSON.stringify(fullRowData).replace(/"/g, '""'); // 轉義雙引號

    // 每個欄位錯誤都生成一行
    errors.forEach((error) => {
      const row = [
        rowIndex,
        escapeCsvValue(error.fieldLabel || error.field),
        escapeCsvValue(error.originalValue),
        escapeCsvValue(error.error),
        `"${fullRowJson}"` // JSON 用雙引號包裹
      ];
      csvRows.push(row.join(','));
    });
  });

  // 組裝完整 CSV 內容
  const csvContent = csvRows.join('\n');

  // 加上 BOM (Byte Order Mark) 讓 Excel 正確識別 UTF-8
  const BOM = '\uFEFF';
  const csvWithBom = BOM + csvContent;

  // 建立 Blob
  const blob = new Blob([csvWithBom], { type: 'text/csv;charset=utf-8;' });

  // 產生檔名
  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const baseFileName = fileName ? fileName.replace(/\.[^/.]+$/, '') : 'upload';
  const downloadFileName = `error-report_${uploadType}_${baseFileName}_${timestamp}.csv`;

  // 觸發下載
  downloadBlob(blob, downloadFileName);

  console.log(`Error report downloaded: ${downloadFileName} (${errorRows.length} error rows)`);
}

/**
 * CSV 值轉義（處理逗號、雙引號、換行）
 * @param {any} value - 要轉義的值
 * @returns {string} 轉義後的字串
 */
function escapeCsvValue(value) {
  if (value === null || value === undefined) {
    return '';
  }

  const strValue = String(value);

  // 如果包含逗號、雙引號或換行，需要用雙引號包裹
  if (strValue.includes(',') || strValue.includes('"') || strValue.includes('\n')) {
    // 雙引號需要轉義為兩個雙引號
    const escapedValue = strValue.replace(/"/g, '""');
    return `"${escapedValue}"`;
  }

  return strValue;
}

/**
 * 使用 Blob 和 URL.createObjectURL 觸發檔案下載
 * @param {Blob} blob - 要下載的 Blob
 * @param {string} filename - 檔案名稱
 */
function downloadBlob(blob, filename) {
  // 建立 Object URL
  const url = URL.createObjectURL(blob);

  // 建立臨時 <a> 元素
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';

  // 加入 DOM、觸發點擊、移除
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  // 釋放 Object URL（延遲釋放，確保下載開始）
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 100);
}

/**
 * 生成錯誤報告摘要（用於 UI 顯示）
 * @param {Array} errorRows - 驗證錯誤的資料行
 * @returns {Object} { totalErrors, affectedRows, topErrors }
 */
export function generateErrorSummary(errorRows) {
  if (!errorRows || errorRows.length === 0) {
    return {
      totalErrors: 0,
      affectedRows: 0,
      topErrors: []
    };
  }

  // 統計總錯誤數
  const totalErrors = errorRows.reduce((sum, row) => sum + row.errors.length, 0);

  // 受影響的行數
  const affectedRows = errorRows.length;

  // 統計最常見的錯誤訊息（前 5 個）
  const errorCounts = {};
  errorRows.forEach((row) => {
    row.errors.forEach((error) => {
      const errorMsg = error.error || 'Unknown error';
      errorCounts[errorMsg] = (errorCounts[errorMsg] || 0) + 1;
    });
  });

  // 排序並取前 5 個
  const topErrors = Object.entries(errorCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([error, count]) => ({ error, count }));

  return {
    totalErrors,
    affectedRows,
    topErrors
  };
}
