/**
 * Error Report Utilities
 * Generate and download error report CSV
 */

/**
 * Convert error data to CSV format and trigger download
 * @param {Object} options
 * @param {Array} options.errorRows - Validation error data rows
 * @param {Array} options.rawRows - Raw data (optional, for complete data reference)
 * @param {Array} options.columns - Column names (optional)
 * @param {string} options.uploadType - Upload type
 * @param {string} options.fileName - Original file name
 */
export function downloadErrorReport({ errorRows, rawRows = [], columns = [], uploadType, fileName }) {
  if (!errorRows || errorRows.length === 0) {
    console.warn('No error rows to download');
    return;
  }

  // CSV header row
  const headers = [
    'Row Index',
    'Field',
    'Original Value',
    'Error Message',
    'Full Row Data (JSON)'
  ];

  // Assemble CSV data rows
  const csvRows = [];
  
  // Add header row
  csvRows.push(headers.join(','));

  // Process each error row
  errorRows.forEach((errorRow) => {
    const { rowIndex, errors, originalRow } = errorRow;

    // Get complete raw data (if rawRows provided)
    const fullRowData = rawRows[rowIndex - 1] || originalRow || {};
    const fullRowJson = JSON.stringify(fullRowData).replace(/"/g, '""'); // Escape double quotes

    // Generate one row per field error
    errors.forEach((error) => {
      const row = [
        rowIndex,
        escapeCsvValue(error.fieldLabel || error.field),
        escapeCsvValue(error.originalValue),
        escapeCsvValue(error.error),
        `"${fullRowJson}"` // JSON wrapped in double quotes
      ];
      csvRows.push(row.join(','));
    });
  });

  // Assemble complete CSV content
  const csvContent = csvRows.join('\n');

  // Add BOM (Byte Order Mark) for Excel to correctly recognize UTF-8
  const BOM = '\uFEFF';
  const csvWithBom = BOM + csvContent;

  // Create Blob
  const blob = new Blob([csvWithBom], { type: 'text/csv;charset=utf-8;' });

  // Generate filename
  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const baseFileName = fileName ? fileName.replace(/\.[^/.]+$/, '') : 'upload';
  const downloadFileName = `error-report_${uploadType}_${baseFileName}_${timestamp}.csv`;

  // Trigger download
  downloadBlob(blob, downloadFileName);

  console.log(`Error report downloaded: ${downloadFileName} (${errorRows.length} error rows)`);
}

/**
 * CSV value escaping (handles commas, double quotes, newlines)
 * @param {any} value - Value to escape
 * @returns {string} Escaped string
 */
function escapeCsvValue(value) {
  if (value === null || value === undefined) {
    return '';
  }

  const strValue = String(value);

  // If contains commas, double quotes, or newlines, wrap in double quotes
  if (strValue.includes(',') || strValue.includes('"') || strValue.includes('\n')) {
    // Double quotes need to be escaped as two double quotes
    const escapedValue = strValue.replace(/"/g, '""');
    return `"${escapedValue}"`;
  }

  return strValue;
}

/**
 * Trigger file download using Blob and URL.createObjectURL
 * @param {Blob} blob - Blob to download
 * @param {string} filename - File name
 */
function downloadBlob(blob, filename) {
  // Create Object URL
  const url = URL.createObjectURL(blob);

  // Create temporary <a> element
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';

  // Add to DOM, trigger click, remove
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  // Release Object URL (delayed to ensure download starts)
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 100);
}

/**
 * Generate error report summary (for UI display)
 * @param {Array} errorRows - Validation error data rows
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

  // Count total errors
  const totalErrors = errorRows.reduce((sum, row) => sum + row.errors.length, 0);

  // Affected row count
  const affectedRows = errorRows.length;

  // Count most common error messages (top 5)
  const errorCounts = {};
  errorRows.forEach((row) => {
    row.errors.forEach((error) => {
      const errorMsg = error.error || 'Unknown error';
      errorCounts[errorMsg] = (errorCounts[errorMsg] || 0) + 1;
    });
  });

  // Sort and take top 5
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
