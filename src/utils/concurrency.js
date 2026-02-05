/**
 * Concurrency Control Utility
 * 簡單的併發控制，避免同時執行過多 Promise
 */

/**
 * 併發執行 tasks，限制同時執行數量
 * @param {Array<Function>} tasks - 回傳 Promise 的函式陣列
 * @param {number} concurrency - 最大併發數（預設 2）
 * @param {Function} onProgress - 進度回調 (completedCount, totalCount)
 * @returns {Promise<Array>} 所有 task 的結果陣列
 */
export async function runWithConcurrency(tasks, concurrency = 2, onProgress = null) {
  const results = [];
  const executing = [];
  let completed = 0;
  const total = tasks.length;

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

    results[index] = promise;
    executing.push(promise);

    // 當達到併發限制時，等待其中一個完成
    if (executing.length >= concurrency) {
      await Promise.race(executing);
      // 移除已完成的 promise
      executing.splice(0, executing.findIndex(p => p === promise) + 1);
    }
  }

  // 等待所有剩餘的 promise 完成
  const settled = await Promise.all(results);

  return settled;
}

/**
 * 創建可中止的併發執行器
 * @param {Array<Function>} tasks - 回傳 Promise 的函式陣列
 * @param {AbortSignal} signal - AbortController.signal
 * @param {number} concurrency - 最大併發數
 * @param {Function} onProgress - 進度回調
 * @returns {Promise<Array>} 所有 task 的結果陣列
 */
export async function runWithConcurrencyAbortable(tasks, signal, concurrency = 2, onProgress = null) {
  const results = [];
  const executing = [];
  let completed = 0;
  const total = tasks.length;

  // 檢查是否已中止
  if (signal?.aborted) {
    throw new Error('Aborted');
  }

  for (const [index, task] of tasks.entries()) {
    // 每次迴圈都檢查中止信號
    if (signal?.aborted) {
      console.log(`[Concurrency] Aborted at task ${index}/${total}`);
      throw new Error('Aborted');
    }

    const promise = Promise.resolve().then(() => {
      // 執行前再檢查一次
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

    results[index] = promise;
    executing.push(promise);

    // 當達到併發限制時，等待其中一個完成
    if (executing.length >= concurrency) {
      await Promise.race(executing);
      // 移除已完成的 promise
      executing.splice(0, executing.findIndex(p => p === promise) + 1);
    }
  }

  // 等待所有剩餘的 promise 完成
  const settled = await Promise.all(results);

  return settled;
}

export default {
  runWithConcurrency,
  runWithConcurrencyAbortable
};
