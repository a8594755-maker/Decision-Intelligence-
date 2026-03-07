/**
 * Client for the XLSX parser Web Worker.
 * Offloads Excel parsing to a background thread so the UI doesn't freeze.
 * Falls back to main-thread parsing if workers aren't available.
 */
import * as XLSX from 'xlsx';

let _worker = null;
let _idCounter = 0;
const _pending = new Map();

function getWorker() {
  if (_worker) return _worker;
  try {
    _worker = new Worker(
      new URL('./xlsxParser.worker.js', import.meta.url),
      { type: 'module' }
    );
    _worker.onmessage = (event) => {
      const { id, result, error } = event.data;
      const resolver = _pending.get(id);
      if (resolver) {
        _pending.delete(id);
        if (error) resolver.reject(new Error(error));
        else resolver.resolve(result);
      }
    };
    _worker.onerror = () => {
      _worker = null;
    };
    return _worker;
  } catch {
    return null;
  }
}

/**
 * Parse workbook in a Worker and return sheet metadata + sample rows.
 * The worker holds the parsed workbook for later extractSheet calls.
 * @param {ArrayBuffer} buffer - Raw file buffer
 * @returns {Promise<{ sheetNames: string[], sheets: Array<{ name, headers, sampleRows, rowCount }> }>}
 */
export function classifyWorkbookInWorker(buffer) {
  const worker = getWorker();
  if (!worker) {
    return classifyWorkbookMainThread(buffer);
  }

  const id = ++_idCounter;
  return new Promise((resolve, reject) => {
    _pending.set(id, { resolve, reject });
    // Transfer the buffer to avoid copying
    worker.postMessage({ type: 'classify', id, buffer }, [buffer]);
  });
}

/**
 * Extract full sheet data from the worker-held workbook.
 * @param {string} sheetName
 * @returns {Promise<object[]>}
 */
export function extractSheetInWorker(sheetName) {
  const worker = getWorker();
  if (!worker) {
    throw new Error('XLSX worker not available — workbook not loaded');
  }

  const id = ++_idCounter;
  return new Promise((resolve, reject) => {
    _pending.set(id, { resolve, reject });
    worker.postMessage({ type: 'extractSheet', id, sheetName });
  });
}

/**
 * Terminate the XLSX worker and release memory.
 */
export function terminateXlsxWorker() {
  if (_worker) {
    _worker.terminate();
    _worker = null;
    _pending.clear();
  }
}

/**
 * Main-thread fallback for classifyWorkbook when Worker is unavailable.
 */
function classifyWorkbookMainThread(buffer) {
  const wb = XLSX.read(new Uint8Array(buffer), { type: 'array' });
  const sheets = wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    const allRows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    const headers = allRows.length > 0 ? Object.keys(allRows[0]) : [];
    const sampleRows = allRows.slice(0, 50);
    return { name, headers, sampleRows, rowCount: allRows.length };
  });
  return Promise.resolve({
    sheetNames: wb.SheetNames,
    sheets,
    _workbook: wb, // Keep workbook ref for main-thread extractSheet
  });
}
