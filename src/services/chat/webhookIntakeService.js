/**
 * webhookIntakeService.js — API Webhook Intake for external system alerts
 *
 * Accepts structured webhook payloads from SAP, Oracle, and generic ERP systems,
 * normalizes them into work orders, and feeds them into the task intake pipeline.
 *
 * Supported webhook types:
 *   - SAP MM: Material shortage alerts, PO change notifications, GR delays
 *   - Oracle SCM: Supply chain alerts, ASN notifications, inventory warnings
 *   - Generic REST: Any JSON payload with configurable field mapping
 *
 * Security:
 *   - HMAC-SHA256 signature verification
 *   - API key authentication
 *   - Rate limiting (per source)
 *   - Payload size limits
 *
 * @module services/webhookIntakeService
 */

import { processIntake, INTAKE_SOURCES } from './taskIntakeService.js';
import { supabase } from '../infra/supabaseClient';
import { eventBus, EVENT_NAMES } from '../governance/eventBus.js';
import { handleEmailIntakeRequest } from './emailIntakeEndpoint.js';

// ── Webhook Source Types ──────────────────────────────────────────────────────

export const WEBHOOK_SOURCES = Object.freeze({
  SAP_MM:       'sap_mm',
  SAP_PP:       'sap_pp',
  ORACLE_SCM:   'oracle_scm',
  GENERIC_REST: 'generic_rest',
  EMAIL:        'email',
});

// ── SAP Alert Type Mapping ───────────────────────────────────────────────────

const SAP_ALERT_MAP = {
  MATSHORT:     { priority: 'high',     title: 'Material Shortage',       workflow: 'risk_aware_plan' },
  PO_CHANGE:    { priority: 'medium',   title: 'PO Change Notification',  workflow: 'full_report' },
  GR_DELAY:     { priority: 'high',     title: 'Goods Receipt Delay',     workflow: 'risk_aware_plan' },
  INV_CRITICAL: { priority: 'critical', title: 'Inventory Critical Level', workflow: 'risk_aware_plan' },
  QM_REJECT:    { priority: 'high',     title: 'Quality Rejection',       workflow: 'full_report' },
  FORECAST_DEV: { priority: 'medium',   title: 'Forecast Deviation',      workflow: 'forecast_then_plan' },
};

// ── Oracle Alert Type Mapping ────────────────────────────────────────────────

const ORACLE_ALERT_MAP = {
  SUPPLY_ALERT:     { priority: 'high',   title: 'Supply Chain Alert',     workflow: 'risk_aware_plan' },
  ASN_DELAY:        { priority: 'medium', title: 'ASN Delivery Delay',     workflow: 'full_report' },
  INV_REORDER:      { priority: 'medium', title: 'Inventory Reorder Point', workflow: 'forecast_then_plan' },
  DEMAND_SPIKE:     { priority: 'high',   title: 'Demand Spike Detected',  workflow: 'risk_aware_plan' },
  SUPPLIER_RISK:    { priority: 'high',   title: 'Supplier Risk Alert',    workflow: 'risk_aware_plan' },
};

// ── Rate Limiting ────────────────────────────────────────────────────────────

const _rateLimits = new Map(); // sourceKey → { count, resetAt }
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 60; // max 60 webhooks per minute per source

function _pruneExpiredRateLimits() {
  const now = Date.now();
  for (const [key, entry] of _rateLimits) {
    if (now > entry.resetAt) {
      _rateLimits.delete(key);
    }
  }
}

function checkRateLimit(sourceKey) {
  _pruneExpiredRateLimits();
  const now = Date.now();
  const entry = _rateLimits.get(sourceKey);

  if (!entry || now > entry.resetAt) {
    _rateLimits.set(sourceKey, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true };
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return { allowed: false, reason: `Rate limit exceeded: ${RATE_LIMIT_MAX}/min for ${sourceKey}` };
  }

  entry.count++;
  return { allowed: true };
}

// ── HMAC Signature Verification ──────────────────────────────────────────────

/**
 * Verify HMAC-SHA256 signature for webhook payload.
 * @param {string} payload - Raw request body string
 * @param {string} signature - Signature from header (hex)
 * @param {string} secret - Shared secret
 * @returns {boolean}
 */
export async function verifySignature(payload, signature, secret) {
  if (!signature || !secret) return false;

  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    );
    // Use crypto.subtle.verify for timing-safe comparison
    const signatureHex = signature.replace(/^sha256=/, '');
    const hexPairs = signatureHex.match(/.{2}/g);
    if (!hexPairs || hexPairs.length === 0) return false;
    const sigBytes = new Uint8Array(hexPairs.map(b => parseInt(b, 16)));
    return await crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(payload));
  } catch {
    return false;
  }
}

// ── Webhook Registration (DB) ────────────────────────────────────────────────

/**
 * @typedef {Object} WebhookConfig
 * @property {string} id
 * @property {string} source_type - WEBHOOK_SOURCES value
 * @property {string} name - Human-readable name
 * @property {string} api_key - API key for authentication
 * @property {string} [hmac_secret] - HMAC secret for signature verification
 * @property {string} employee_id - Target AI employee
 * @property {string} user_id - Owner user
 * @property {Object} [field_mapping] - Custom field mapping for generic webhooks
 * @property {boolean} is_active
 * @property {string} created_at
 */

/**
 * Register a new webhook endpoint.
 */
export async function registerWebhook({
  sourceType,
  name,
  employeeId,
  userId,
  fieldMapping = null,
}) {
  const apiKey = generateApiKey();
  const hmacSecret = generateApiKey(); // reuse generator for secret

  const row = {
    source_type: sourceType,
    name: name || `${sourceType} webhook`,
    api_key: apiKey,
    hmac_secret: hmacSecret,
    employee_id: employeeId,
    user_id: userId,
    field_mapping: fieldMapping,
    is_active: true,
    created_at: new Date().toISOString(),
    last_received_at: null,
    total_received: 0,
    total_processed: 0,
    total_errors: 0,
  };

  try {
    const { data, error } = await supabase
      .from('webhook_configs')
      .insert(row)
      .select()
      .single();
    if (error) throw error;
    return { ok: true, webhook: data };
  } catch (_err) {
    // Fallback: return in-memory config
    return {
      ok: true,
      webhook: { id: `wh_${Date.now().toString(36)}`, ...row },
      _source: 'memory',
    };
  }
}

/**
 * List all webhook configs for a user.
 */
export async function listWebhooks(userId) {
  try {
    const { data, error } = await supabase
      .from('webhook_configs')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  } catch {
    return [];
  }
}

/**
 * Get a webhook config by ID.
 */
export async function getWebhook(webhookId) {
  try {
    const { data, error } = await supabase
      .from('webhook_configs')
      .select('*')
      .eq('id', webhookId)
      .single();
    if (error) throw error;
    return data;
  } catch {
    return null;
  }
}

/**
 * Look up webhook config by API key.
 */
export async function getWebhookByApiKey(apiKey) {
  try {
    const { data, error } = await supabase
      .from('webhook_configs')
      .select('*')
      .eq('api_key', apiKey)
      .eq('is_active', true)
      .single();
    if (error) throw error;
    return data;
  } catch {
    return null;
  }
}

/**
 * Update webhook config.
 */
export async function updateWebhook(webhookId, updates) {
  const allowed = {};
  if (updates.name != null) allowed.name = updates.name;
  if (updates.is_active != null) allowed.is_active = updates.is_active;
  if (updates.field_mapping != null) allowed.field_mapping = updates.field_mapping;
  if (updates.employee_id != null) allowed.employee_id = updates.employee_id;

  try {
    const { data, error } = await supabase
      .from('webhook_configs')
      .update(allowed)
      .eq('id', webhookId)
      .select()
      .single();
    if (error) throw error;
    return data;
  } catch {
    return null;
  }
}

/**
 * Delete a webhook config.
 */
export async function deleteWebhook(webhookId) {
  try {
    const { error } = await supabase
      .from('webhook_configs')
      .delete()
      .eq('id', webhookId);
    if (error) throw error;
    return true;
  } catch {
    return false;
  }
}

// ── Payload Normalizers ──────────────────────────────────────────────────────

/**
 * Normalize a SAP MM webhook payload into intake params.
 */
function normalizeSapPayload(payload) {
  const alertType = payload.ALERT_TYPE || payload.alert_type || payload.type || 'MATSHORT';
  const mapping = SAP_ALERT_MAP[alertType] || SAP_ALERT_MAP.MATSHORT;

  return {
    title: `[SAP] ${mapping.title}: ${payload.MATNR || payload.material_code || ''}`,
    message: payload.MESSAGE || payload.message || payload.DESCRIPTION || `SAP ${alertType} alert`,
    priority: payload.PRIORITY?.toLowerCase() || mapping.priority,
    alert_type: alertType,
    material_code: payload.MATNR || payload.material_code || null,
    plant_id: payload.WERKS || payload.plant_id || null,
    quantity: payload.MENGE || payload.quantity || null,
    po_number: payload.EBELN || payload.po_number || null,
    vendor_id: payload.LIFNR || payload.vendor_id || null,
    suggested_workflow: mapping.workflow,
    raw_sap: payload,
  };
}

/**
 * Normalize an Oracle SCM webhook payload into intake params.
 */
function normalizeOraclePayload(payload) {
  const alertType = payload.alertType || payload.alert_type || payload.type || 'SUPPLY_ALERT';
  const mapping = ORACLE_ALERT_MAP[alertType] || ORACLE_ALERT_MAP.SUPPLY_ALERT;

  return {
    title: `[Oracle] ${mapping.title}: ${payload.itemNumber || payload.item_number || ''}`,
    message: payload.message || payload.description || `Oracle ${alertType} alert`,
    priority: payload.priority?.toLowerCase() || mapping.priority,
    alert_type: alertType,
    material_code: payload.itemNumber || payload.item_number || null,
    plant_id: payload.organizationCode || payload.org_code || null,
    quantity: payload.quantity || null,
    po_number: payload.poNumber || payload.po_number || null,
    vendor_id: payload.supplierId || payload.supplier_id || null,
    suggested_workflow: mapping.workflow,
    raw_oracle: payload,
  };
}

/**
 * Normalize a generic REST webhook payload using custom field mapping.
 */
function normalizeGenericPayload(payload, fieldMapping = {}) {
  const fm = fieldMapping || {};

  const getValue = (key) => {
    const path = fm[key];
    if (!path) return null;
    return path.split('.').reduce((obj, k) => obj?.[k], payload) ?? null;
  };

  return {
    title: getValue('title') || payload.title || payload.subject || 'Webhook Alert',
    message: getValue('message') || payload.message || payload.body || payload.description || JSON.stringify(payload).slice(0, 200),
    priority: getValue('priority') || payload.priority || 'medium',
    alert_type: getValue('alert_type') || payload.type || payload.event || 'generic',
    material_code: getValue('material_code') || payload.material_code || null,
    plant_id: getValue('plant_id') || payload.plant_id || null,
    suggested_workflow: getValue('workflow') || 'full_report',
    raw_generic: payload,
  };
}

// ── Core Webhook Processing ──────────────────────────────────────────────────

/**
 * Process an incoming webhook payload.
 *
 * @param {Object} params
 * @param {string} params.sourceType - WEBHOOK_SOURCES value
 * @param {Object} params.payload - Raw webhook JSON body
 * @param {string} params.employeeId - Target AI employee
 * @param {string} params.userId - Owner user
 * @param {Object} [params.webhookConfig] - Webhook config (for field mapping)
 * @returns {Promise<{ok: boolean, workOrder?: Object, status?: string, error?: string}>}
 */
export async function processWebhook({
  sourceType,
  payload,
  employeeId,
  userId,
  webhookConfig = null,
}) {
  // 1. Rate limit check
  const rateKey = `${sourceType}:${employeeId}`;
  const rateCheck = checkRateLimit(rateKey);
  if (!rateCheck.allowed) {
    return { ok: false, error: rateCheck.reason };
  }

  // 2. Normalize payload based on source type
  let normalized;
  switch (sourceType) {
    case WEBHOOK_SOURCES.SAP_MM:
    case WEBHOOK_SOURCES.SAP_PP:
      normalized = normalizeSapPayload(payload);
      break;
    case WEBHOOK_SOURCES.ORACLE_SCM:
      normalized = normalizeOraclePayload(payload);
      break;
    case WEBHOOK_SOURCES.GENERIC_REST:
    default:
      normalized = normalizeGenericPayload(payload, webhookConfig?.field_mapping);
      break;
  }

  // 3. Feed into unified intake pipeline
  try {
    const intakeResult = await processIntake({
      source: INTAKE_SOURCES.API,
      message: normalized.message,
      employeeId,
      userId,
      metadata: {
        ...normalized,
        webhook_source: sourceType,
        webhook_id: webhookConfig?.id || null,
        source_ref: `webhook:${sourceType}:${Date.now()}`,
      },
    });

    // 4. Emit event for UI updates
    eventBus.emit(EVENT_NAMES.TASK_CREATED || 'task:created', {
      source: 'webhook',
      sourceType,
      workOrder: intakeResult.workOrder,
      status: intakeResult.status,
    });

    // 5. Update webhook stats
    if (webhookConfig?.id) {
      _updateWebhookStats(webhookConfig.id, intakeResult.status === 'created').catch(() => {});
    }

    return {
      ok: true,
      workOrder: intakeResult.workOrder,
      status: intakeResult.status,
    };
  } catch (err) {
    if (webhookConfig?.id) {
      _updateWebhookStats(webhookConfig.id, false).catch(() => {});
    }
    return { ok: false, error: err.message };
  }
}

/**
 * Authenticate and process a webhook request.
 * This is the main entry point called by the API endpoint handler.
 *
 * @param {Object} params
 * @param {string} params.apiKey - API key from request header
 * @param {string} [params.signature] - HMAC signature from header
 * @param {string} [params.rawBody] - Raw request body for signature verification
 * @param {Object} params.payload - Parsed JSON body
 * @returns {Promise<{ok: boolean, workOrder?: Object, status?: string, error?: string, httpStatus?: number}>}
 */
export async function handleWebhookRequest({ apiKey, signature, rawBody, payload }) {
  // 1. Authenticate
  if (!apiKey) {
    return { ok: false, error: 'Missing API key', httpStatus: 401 };
  }

  const config = await getWebhookByApiKey(apiKey);
  if (!config) {
    return { ok: false, error: 'Invalid API key', httpStatus: 401 };
  }

  // 2. Verify signature if HMAC secret is configured — require signature when secret is set
  if (config.hmac_secret) {
    if (!signature) {
      return { ok: false, error: 'Missing signature (HMAC required)', httpStatus: 401 };
    }
    const valid = await verifySignature(rawBody || JSON.stringify(payload), signature, config.hmac_secret);
    if (!valid) {
      return { ok: false, error: 'Invalid signature', httpStatus: 403 };
    }
  }

  // 3. Dispatch: route email payloads to emailIntakeEndpoint
  if (config.source_type === WEBHOOK_SOURCES.EMAIL) {
    const emailResult = await handleEmailIntakeRequest({
      apiKey,
      payload,
      employeeId: config.employee_id,
      userId: config.user_id,
    });
    return emailResult;
  }

  // 4. Process (non-email webhooks)
  const result = await processWebhook({
    sourceType: config.source_type,
    payload,
    employeeId: config.employee_id,
    userId: config.user_id,
    webhookConfig: config,
  });

  return {
    ...result,
    httpStatus: result.ok ? 200 : 422,
  };
}

// ── Webhook Event Log ────────────────────────────────────────────────────────

/**
 * Log a webhook event for audit trail.
 */
export async function logWebhookEvent({ webhookId, sourceType, status, workOrderId, error }) {
  try {
    await supabase.from('webhook_events').insert({
      webhook_id: webhookId,
      source_type: sourceType,
      status,
      work_order_id: workOrderId,
      error,
      created_at: new Date().toISOString(),
    });
  } catch {
    // Best-effort logging
  }
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

async function _updateWebhookStats(webhookId, success) {
  try {
    // Use RPC for atomic increment to avoid TOCTOU race under concurrency.
    // Falls back to read-increment-write if RPC is unavailable.
    const { error: rpcError } = await supabase.rpc('increment_webhook_stats', {
      p_webhook_id: webhookId,
      p_success: success,
    });

    if (rpcError) {
      // Fallback: non-atomic update (acceptable for best-effort stats)
      const { data } = await supabase
        .from('webhook_configs')
        .select('total_received, total_processed, total_errors')
        .eq('id', webhookId)
        .single();
      if (!data) return;

      await supabase.from('webhook_configs').update({
        last_received_at: new Date().toISOString(),
        total_received: (data.total_received || 0) + 1,
        total_processed: (data.total_processed || 0) + (success ? 1 : 0),
        total_errors: (data.total_errors || 0) + (success ? 0 : 1),
      }).eq('id', webhookId);
    }
  } catch {
    // Best-effort
  }
}

function generateApiKey() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Test Helpers ─────────────────────────────────────────────────────────────

export function _resetRateLimitsForTesting() {
  _rateLimits.clear();
}

export { SAP_ALERT_MAP, ORACLE_ALERT_MAP };
