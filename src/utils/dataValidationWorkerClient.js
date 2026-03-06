/**
 * Client for the data validation Web Worker.
 * Falls back to main-thread execution if workers aren't available.
 */
import { validateAndCleanData } from './dataValidation';

let _worker = null;
let _idCounter = 0;
const _pending = new Map();

const WORKER_ROW_THRESHOLD = 500;

function getWorker() {
  if (_worker) return _worker;
  try {
    _worker = new Worker(
      new URL('./dataValidation.worker.js', import.meta.url),
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
 * Validate and clean data rows, offloading to a Web Worker for large datasets.
 * Falls back to synchronous main-thread execution for small datasets or when workers aren't available.
 */
export function validateInWorker(rawRows, uploadType, columnMapping) {
  if (!Array.isArray(rawRows) || rawRows.length < WORKER_ROW_THRESHOLD) {
    return Promise.resolve(validateAndCleanData(rawRows, uploadType, columnMapping));
  }

  const worker = getWorker();
  if (!worker) {
    return Promise.resolve(validateAndCleanData(rawRows, uploadType, columnMapping));
  }

  const id = ++_idCounter;
  return new Promise((resolve, reject) => {
    _pending.set(id, { resolve, reject });
    worker.postMessage({ rawRows, uploadType, columnMapping, id });
  });
}

export function terminateValidationWorker() {
  if (_worker) {
    _worker.terminate();
    _worker = null;
    _pending.clear();
  }
}
