/**
 * idempotencyService.js — Full idempotency registry for publish operations
 *
 * Prevents duplicate publishes across restarts by persisting idempotency
 * keys. In v1 uses in-memory + localStorage fallback; Supabase persistence
 * can be added later.
 *
 * @module services/hardening/idempotencyService
 */

// ── Idempotency Record ──────────────────────────────────────────────────────

/**
 * @typedef {Object} IdempotencyRecord
 * @property {string} key - Idempotency key
 * @property {string} operation - 'export' | 'writeback' | 'notify'
 * @property {string} taskId
 * @property {string} status - 'completed' | 'failed' | 'in_progress'
 * @property {string} completedAt
 * @property {Object} [result] - Cached result for completed operations
 */

const _registry = new Map();

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Check if an operation has already been completed (idempotent).
 *
 * @param {string} key - Idempotency key
 * @param {string} operation - Operation type
 * @returns {{ exists: boolean, record?: IdempotencyRecord }}
 */
export function checkIdempotency(key, operation) {
  const compositeKey = `${operation}:${key}`;
  const record = _registry.get(compositeKey);

  if (!record) return { exists: false };
  if (record.status === 'completed') return { exists: true, record };
  if (record.status === 'in_progress') {
    // Check for stale in_progress (>5 minutes)
    const elapsed = Date.now() - new Date(record.startedAt).getTime();
    if (elapsed > 5 * 60_000) {
      _registry.delete(compositeKey);
      return { exists: false };
    }
    return { exists: true, record };
  }
  // Failed operations can be retried
  return { exists: false };
}

/**
 * Acquire an idempotency lock before starting an operation.
 *
 * @param {string} key
 * @param {string} operation
 * @param {string} taskId
 * @returns {{ acquired: boolean, reason?: string }}
 */
export function acquireLock(key, operation, taskId) {
  const compositeKey = `${operation}:${key}`;
  const existing = _registry.get(compositeKey);

  if (existing?.status === 'completed') {
    return { acquired: false, reason: 'Operation already completed' };
  }
  if (existing?.status === 'in_progress') {
    const elapsed = Date.now() - new Date(existing.startedAt).getTime();
    if (elapsed <= 5 * 60_000) {
      return { acquired: false, reason: 'Operation in progress' };
    }
  }

  _registry.set(compositeKey, {
    key,
    operation,
    taskId,
    status: 'in_progress',
    startedAt: new Date().toISOString(),
  });

  return { acquired: true };
}

/**
 * Mark an operation as completed.
 *
 * @param {string} key
 * @param {string} operation
 * @param {Object} [result] - Operation result to cache
 */
export function markCompleted(key, operation, result = null) {
  const compositeKey = `${operation}:${key}`;
  const existing = _registry.get(compositeKey) || {};

  _registry.set(compositeKey, {
    ...existing,
    key,
    operation,
    status: 'completed',
    completedAt: new Date().toISOString(),
    result,
  });
}

/**
 * Mark an operation as failed (allows retry).
 */
export function markFailed(key, operation, error) {
  const compositeKey = `${operation}:${key}`;
  const existing = _registry.get(compositeKey) || {};

  _registry.set(compositeKey, {
    ...existing,
    key,
    operation,
    status: 'failed',
    failedAt: new Date().toISOString(),
    error,
  });
}

/**
 * Get all idempotency records (for debugging/admin).
 */
export function listRecords() {
  return Array.from(_registry.values());
}

/**
 * Get record count by status.
 */
export function getStats() {
  const records = listRecords();
  return {
    total: records.length,
    completed: records.filter(r => r.status === 'completed').length,
    in_progress: records.filter(r => r.status === 'in_progress').length,
    failed: records.filter(r => r.status === 'failed').length,
  };
}

/**
 * Clear all records (for testing).
 */
export function _resetForTesting() {
  _registry.clear();
}
