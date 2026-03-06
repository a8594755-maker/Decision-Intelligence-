/**
 * Web Worker for data validation.
 * Offloads heavy row validation and cleaning from the main thread.
 *
 * Usage:
 *   import { validateInWorker } from './dataValidationWorkerClient';
 *   const result = await validateInWorker(rawRows, uploadType, columnMapping);
 */
import { validateAndCleanData } from './dataValidation';

self.onmessage = (event) => {
  const { rawRows, uploadType, columnMapping, id } = event.data;
  try {
    const result = validateAndCleanData(rawRows, uploadType, columnMapping);
    self.postMessage({ id, result, error: null });
  } catch (error) {
    self.postMessage({ id, result: null, error: error.message || 'Validation failed' });
  }
};
