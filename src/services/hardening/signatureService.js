/**
 * signatureService.js — Signature, auth, and permission hardening for v1
 *
 * Provides:
 *   - HMAC signature generation/verification for payloads
 *   - Permission checking for publish/writeback operations
 *   - Action authorization with audit trail
 *   - Webhook signature validation
 *
 * @module services/hardening/signatureService
 */

// ── HMAC Signature ──────────────────────────────────────────────────────────

/**
 * Generate HMAC-SHA256 signature for a payload using Web Crypto API.
 *
 * @param {Object|string} payload - Payload to sign
 * @param {string} secret - Shared secret key
 * @returns {Promise<string>} Hex-encoded HMAC signature
 */
export async function generateSignature(payload, secret) {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);

  if (typeof globalThis.crypto?.subtle !== 'undefined') {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
    return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Fallback: simple hash for environments without Web Crypto
  return _simpleHash(data + secret);
}

/**
 * Verify an HMAC signature.
 *
 * @param {Object|string} payload
 * @param {string} signature - Expected signature
 * @param {string} secret
 * @returns {Promise<boolean>}
 */
export async function verifySignature(payload, signature, secret) {
  const computed = await generateSignature(payload, secret);
  return _timingSafeEqual(computed, signature);
}

// ── Permission Checks ───────────────────────────────────────────────────────

export const PERMISSIONS = Object.freeze({
  PUBLISH_EXPORT:    'publish:export',
  PUBLISH_WRITEBACK: 'publish:writeback',
  TASK_CREATE:       'task:create',
  TASK_CANCEL:       'task:cancel',
  WORKER_CONFIGURE:  'worker:configure',
  AUDIT_READ:        'audit:read',
  DELEGATION_CREATE: 'delegation:create',
});

const ROLE_PERMISSIONS = Object.freeze({
  admin:    Object.values(PERMISSIONS),
  manager:  [PERMISSIONS.PUBLISH_EXPORT, PERMISSIONS.PUBLISH_WRITEBACK, PERMISSIONS.TASK_CREATE, PERMISSIONS.TASK_CANCEL, PERMISSIONS.AUDIT_READ, PERMISSIONS.DELEGATION_CREATE],
  operator: [PERMISSIONS.PUBLISH_EXPORT, PERMISSIONS.TASK_CREATE, PERMISSIONS.AUDIT_READ],
  viewer:   [PERMISSIONS.AUDIT_READ],
});

/**
 * Check if a user role has a specific permission.
 *
 * @param {string} role - User role
 * @param {string} permission - Permission to check
 * @returns {{ allowed: boolean, role: string, permission: string }}
 */
export function checkPermission(role, permission) {
  const perms = ROLE_PERMISSIONS[role] || [];
  return {
    allowed: perms.includes(permission),
    role,
    permission,
  };
}

// ── Action Authorization ────────────────────────────────────────────────────

/**
 * Authorize a publish action — checks permission + generates signed receipt.
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} params.role
 * @param {string} params.action - PERMISSIONS value
 * @param {string} params.taskId
 * @param {string} params.idempotencyKey
 * @returns {{ authorized: boolean, receipt?: Object, reason?: string }}
 */
export function authorizeAction({ userId, role, action, taskId, idempotencyKey }) {
  const perm = checkPermission(role, action);
  if (!perm.allowed) {
    return {
      authorized: false,
      reason: `Role "${role}" does not have permission "${action}"`,
      audit: _buildAuthAudit({ userId, role, action, taskId, allowed: false }),
    };
  }

  const receipt = {
    authorized: true,
    user_id: userId,
    role,
    action,
    task_id: taskId,
    idempotency_key: idempotencyKey,
    authorized_at: new Date().toISOString(),
    receipt_id: _generateReceiptId(),
  };

  return {
    authorized: true,
    receipt,
    audit: _buildAuthAudit({ userId, role, action, taskId, allowed: true }),
  };
}

// ── Webhook Signature Validation ────────────────────────────────────────────

/**
 * Validate an incoming webhook request signature.
 *
 * @param {Object} params
 * @param {string} params.body - Raw request body
 * @param {string} params.signature - X-Signature header
 * @param {string} params.secret - Webhook secret
 * @param {number} [params.maxAgeMs=300000] - Max age (5 minutes)
 * @param {string} [params.timestamp] - X-Timestamp header
 * @returns {Promise<{ valid: boolean, reason?: string }>}
 */
export async function validateWebhookSignature({ body, signature, secret, maxAgeMs = 300_000, timestamp = null }) {
  if (!signature) return { valid: false, reason: 'Missing signature' };
  if (!body) return { valid: false, reason: 'Empty body' };

  // Check timestamp freshness
  if (timestamp) {
    const ts = new Date(timestamp).getTime();
    if (isNaN(ts)) return { valid: false, reason: 'Invalid timestamp' };
    if (Date.now() - ts > maxAgeMs) return { valid: false, reason: 'Signature expired' };
  }

  const valid = await verifySignature(body, signature, secret);
  return { valid, reason: valid ? undefined : 'Signature mismatch' };
}

// ── Internal Helpers ────────────────────────────────────────────────────────

function _timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function _simpleHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function _generateReceiptId() {
  return `rcpt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function _buildAuthAudit({ userId, role, action, taskId, allowed }) {
  return {
    audit_event: 'action_authorization',
    user_id: userId,
    role,
    action,
    task_id: taskId,
    allowed,
    timestamp: new Date().toISOString(),
  };
}
