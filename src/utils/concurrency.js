/**
 * Concurrency Control Utility
 * Simple concurrency control to avoid executing too many Promises simultaneously
 */

/**
 * Execute tasks concurrently with limited simultaneous count
 * @param {Array<Function>} tasks - Array of functions returning Promises
 * @param {number} concurrency - Maximum concurrency (default 2)
 * @param {Function} onProgress - Progress callback (completedCount, totalCount)
 * @returns {Promise<Array>} Results array of all tasks
 */
export async function runWithConcurrency(tasks, concurrency = 2, onProgress = null) {
  const results = [];
  const executing = new Set();
  let completed = 0;
  const total = tasks.length;
  const limit = Math.max(1, Number(concurrency) || 1);

  for (const [index, task] of tasks.entries()) {
    const promise = Promise.resolve().then(() => task()).then(
      (result) => {
        completed++;
        if (onProgress) {
          onProgress(completed, total);
        }
        return { status: 'fulfilled', value: result, index };
      },
      (error) => {
        completed++;
        if (onProgress) {
          onProgress(completed, total);
        }
        return { status: 'rejected', reason: error, index };
      }
    );

    let trackedPromise = null;
    trackedPromise = promise.finally(() => {
      executing.delete(trackedPromise);
    });

    results[index] = trackedPromise;
    executing.add(trackedPromise);

    // When concurrency limit reached, wait for one to complete
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  // Wait for all remaining promises to complete
  const settled = await Promise.all(results);

  return settled;
}

/**
 * Create an abortable concurrent executor
 * @param {Array<Function>} tasks - Array of functions returning Promises
 * @param {AbortSignal} signal - AbortController.signal
 * @param {number} concurrency - Maximum concurrency
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<Array>} Results array of all tasks
 */
export async function runWithConcurrencyAbortable(tasks, signal, concurrency = 2, onProgress = null) {
  const results = [];
  const executing = new Set();
  let completed = 0;
  const total = tasks.length;
  const limit = Math.max(1, Number(concurrency) || 1);

  // Check if already aborted
  if (signal?.aborted) {
    throw new Error('Aborted');
  }

  for (const [index, task] of tasks.entries()) {
    // Check abort signal on each iteration
    if (signal?.aborted) {
      console.log(`[Concurrency] Aborted at task ${index}/${total}`);
      throw new Error('Aborted');
    }

    const promise = Promise.resolve().then(() => {
      // Check once more before execution
      if (signal?.aborted) {
        throw new Error('Aborted');
      }
      return task();
    }).then(
      (result) => {
        completed++;
        if (onProgress) {
          onProgress(completed, total);
        }
        return { status: 'fulfilled', value: result, index };
      },
      (error) => {
        completed++;
        if (onProgress) {
          onProgress(completed, total);
        }
        return { status: 'rejected', reason: error, index };
      }
    );

    let trackedPromise = null;
    trackedPromise = promise.finally(() => {
      executing.delete(trackedPromise);
    });

    results[index] = trackedPromise;
    executing.add(trackedPromise);

    // When concurrency limit reached, wait for one to complete
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  // Wait for all remaining promises to complete
  const settled = await Promise.all(results);

  return settled;
}

export default {
  runWithConcurrency,
  runWithConcurrencyAbortable
};
