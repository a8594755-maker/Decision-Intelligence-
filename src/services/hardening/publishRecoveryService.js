/**
 * publishRecoveryService.js — Retry and failure recovery for publish operations
 *
 * Wraps publish operations with:
 *   - Retry with exponential backoff
 *   - Idempotency checking before retry
 *   - Failure state management (publish_failed → retry → in_progress)
 *   - Audit trail for each attempt
 *
 * @module services/hardening/publishRecoveryService
 */

import { checkIdempotency, acquireLock, markCompleted, markFailed } from './idempotencyService.js';

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const INITIAL_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
const BACKOFF_FACTOR = 2;

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Execute a publish operation with retry and idempotency protection.
 *
 * @param {Object} params
 * @param {string} params.idempotencyKey
 * @param {string} params.operation - 'export' | 'writeback' | 'notify'
 * @param {string} params.taskId
 * @param {Function} params.executeFn - async () => { ok, ...result }
 * @param {number} [params.maxRetries]
 * @returns {Promise<{ ok: boolean, result?: Object, attempts: number, deduplicated?: boolean }>}
 */
export async function executeWithRecovery({
  idempotencyKey,
  operation,
  taskId,
  executeFn,
  maxRetries = MAX_RETRIES,
}) {
  // 1. Check idempotency — return cached result if already completed
  const idemCheck = checkIdempotency(idempotencyKey, operation);
  if (idemCheck.exists && idemCheck.record?.status === 'completed') {
    return {
      ok: true,
      result: idemCheck.record.result,
      attempts: 0,
      deduplicated: true,
    };
  }

  // 2. Acquire lock
  const lock = acquireLock(idempotencyKey, operation, taskId);
  if (!lock.acquired) {
    return { ok: false, error: lock.reason, attempts: 0 };
  }

  // 3. Execute with retry
  let lastError = null;
  let attempts = 0;

  for (let i = 0; i <= maxRetries; i++) {
    attempts = i + 1;

    try {
      const result = await executeFn();

      if (result.ok) {
        markCompleted(idempotencyKey, operation, result);
        return { ok: true, result, attempts };
      }

      // Explicit failure (not an exception)
      lastError = result.error || 'Operation returned ok=false';

      // Don't retry if it's an authorization/validation error
      if (result.needs_approval || result.error?.includes('idempotency') || result.error?.includes('blocked')) {
        markFailed(idempotencyKey, operation, lastError);
        return { ok: false, error: lastError, attempts, retryable: false };
      }

    } catch (err) {
      lastError = err.message;
    }

    // Wait before retry (except on last attempt)
    if (i < maxRetries) {
      const delay = Math.min(INITIAL_DELAY_MS * Math.pow(BACKOFF_FACTOR, i), MAX_DELAY_MS);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  // All retries exhausted
  markFailed(idempotencyKey, operation, lastError);
  return { ok: false, error: lastError, attempts, retryable: true };
}

/**
 * Calculate retry delay with exponential backoff.
 * Exported for testing.
 */
export function calculateRetryDelay(attempt, initialDelay = INITIAL_DELAY_MS) {
  return Math.min(initialDelay * Math.pow(BACKOFF_FACTOR, attempt), MAX_DELAY_MS);
}

/**
 * Build an audit entry for a publish attempt.
 */
export function buildPublishAuditEntry({
  taskId,
  operation,
  idempotencyKey,
  attempt,
  ok,
  error = null,
  deduplicated = false,
}) {
  return {
    event_type: 'publish_attempt',
    task_id: taskId,
    operation,
    idempotency_key: idempotencyKey,
    attempt,
    ok,
    error,
    deduplicated,
    timestamp: new Date().toISOString(),
  };
}
