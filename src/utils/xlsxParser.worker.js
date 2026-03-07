/**
 * Web Worker for XLSX parsing.
 * Offloads heavy Excel file parsing from the main thread to prevent UI freezing.
 *
 * Message types:
 *   - classify: Parse workbook, return sheet metadata + sample rows (lightweight)
 *   - extractSheet: Return full sheet data for a specific sheet (on-demand)
 *   - terminate: Clean up workbook reference
 */
import * as XLSX from 'xlsx';

let _workbook = null;

self.onmessage = (event) => {
  const { type, id } = event.data;

  try {
    if (type === 'classify') {
      const { buffer } = event.data;
      _workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' });

      const sheets = _workbook.SheetNames.map((name) => {
        const ws = _workbook.Sheets[name];
        const allRows = XLSX.utils.sheet_to_json(ws, { defval: '' });
        const headers = allRows.length > 0 ? Object.keys(allRows[0]) : [];
        const sampleRows = allRows.slice(0, 50);
        return { name, headers, sampleRows, rowCount: allRows.length };
      });

      self.postMessage({
        id,
        type: 'classify',
        result: { sheetNames: _workbook.SheetNames, sheets },
        error: null,
      });

    } else if (type === 'extractSheet') {
      const { sheetName } = event.data;
      if (!_workbook) {
        self.postMessage({ id, type: 'extractSheet', result: null, error: 'No workbook loaded' });
        return;
      }
      const ws = _workbook.Sheets[sheetName];
      if (!ws) {
        self.postMessage({ id, type: 'extractSheet', result: null, error: `Sheet "${sheetName}" not found` });
        return;
      }
      const sheetData = XLSX.utils.sheet_to_json(ws, { defval: '' });
      self.postMessage({ id, type: 'extractSheet', result: sheetData, error: null });

    } else if (type === 'terminate') {
      _workbook = null;
      self.postMessage({ id, type: 'terminate', result: true, error: null });
    }
  } catch (error) {
    self.postMessage({ id, type, result: null, error: error.message || 'Worker error' });
  }
};
