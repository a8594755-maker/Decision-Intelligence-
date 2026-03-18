/**
 * emailIntakeEndpoint.js — API Endpoint Handler for Email Intake
 *
 * Provides the request/response handler for receiving emails from external
 * email-to-API bridges (e.g., SendGrid Inbound Parse, Mailgun Routes,
 * AWS SES → Lambda, or a custom IMAP poller).
 *
 * Can be wired as:
 *   - Supabase Edge Function handler
 *   - Express/Fastify route handler
 *   - Direct call from webhookIntakeService for email-type webhooks
 *
 * Expected payload format:
 *   POST /api/email-intake
 *   Headers: x-api-key: <webhook_api_key>
 *   Body: {
 *     from: "sender@example.com",
 *     to: "orders@company.com",
 *     subject: "Please run forecast for Q2",
 *     body: "Hi, we need a demand forecast for next quarter...",
 *     attachments: [{ filename: "data.xlsx", contentType: "...", size: 12345 }]
 *   }
 *
 * @module services/emailIntakeEndpoint
 */

import { processEmailIntake } from './emailIntakeService.js';
import { getWebhookByApiKey, logWebhookEvent } from './webhookIntakeService.js';
import { supabase } from './supabaseClient.js';
import { eventBus, EVENT_NAMES } from './eventBus.js';

// ── Rate Limiting ────────────────────────────────────────────────────────────

const _emailRateLimits = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30; // max 30 emails per minute per sender

function checkEmailRateLimit(senderKey) {
  const now = Date.now();
  const entry = _emailRateLimits.get(senderKey);

  if (!entry || now > entry.resetAt) {
    _emailRateLimits.set(senderKey, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true };
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return { allowed: false, reason: `Email rate limit exceeded: ${RATE_LIMIT_MAX}/min for ${senderKey}` };
  }

  entry.count++;
  return { allowed: true };
}

// ── Email Routing Config ────────────────────────────────────────────────────

/**
 * Lookup employee assignment for an email address.
 * Checks the email_routing table first, then falls back to webhook config.
 *
 * @param {string} toAddress - The destination email (e.g., orders@company.com)
 * @returns {Promise<{employeeId: string, userId: string}|null>}
 */
async function resolveEmailRouting(toAddress) {
  try {
    const { data, error } = await supabase
      .from('webhook_configs')
      .select('employee_id, user_id')
      .eq('source_type', 'email')
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();

    if (!error && data) return data;
  } catch {
    // Fall through
  }
  return null;
}

// ── Main Handler ────────────────────────────────────────────────────────────

/**
 * Handle an incoming email intake request.
 *
 * @param {Object} params
 * @param {string} [params.apiKey]       - API key for authentication
 * @param {Object} params.payload        - Email payload
 * @param {string} params.payload.from   - Sender email
 * @param {string|string[]} params.payload.to - Recipient email(s)
 * @param {string} params.payload.subject - Email subject
 * @param {string} params.payload.body   - Email body (plain text)
 * @param {Object[]} [params.payload.attachments] - Attachment metadata
 * @param {string} [params.employeeId]   - Override employee ID
 * @param {string} [params.userId]       - Override user ID
 * @returns {Promise<{ok: boolean, workOrders?: Object[], error?: string, httpStatus?: number}>}
 */
export async function handleEmailIntakeRequest({ apiKey, payload, employeeId, userId }) {
  // 1. Validate payload
  if (!payload || (!payload.body && !payload.subject)) {
    return { ok: false, error: 'Missing email body or subject', httpStatus: 400 };
  }

  // 2. Authenticate via API key if provided
  let resolvedEmployeeId = employeeId;
  let resolvedUserId = userId;

  if (apiKey) {
    const config = await getWebhookByApiKey(apiKey);
    if (!config) {
      return { ok: false, error: 'Invalid API key', httpStatus: 401 };
    }
    resolvedEmployeeId = resolvedEmployeeId || config.employee_id;
    resolvedUserId = resolvedUserId || config.user_id;
  }

  // 3. If no employee/user resolved yet, try email routing
  if (!resolvedEmployeeId || !resolvedUserId) {
    const toAddr = Array.isArray(payload.to) ? payload.to[0] : payload.to;
    const routing = await resolveEmailRouting(toAddr);
    if (routing) {
      resolvedEmployeeId = resolvedEmployeeId || routing.employeeId;
      resolvedUserId = resolvedUserId || routing.userId;
    }
  }

  if (!resolvedEmployeeId || !resolvedUserId) {
    return { ok: false, error: 'Cannot determine target employee for this email. Configure an email webhook first.', httpStatus: 422 };
  }

  // 4. Rate limit check
  const senderKey = payload.from || 'unknown';
  const rateCheck = checkEmailRateLimit(senderKey);
  if (!rateCheck.allowed) {
    return { ok: false, error: rateCheck.reason, httpStatus: 429 };
  }

  // 5. Process via email intake service
  try {
    const result = await processEmailIntake({
      rawHeaders: {
        from: payload.from,
        to: payload.to,
        cc: payload.cc,
        subject: payload.subject,
        date: payload.date || new Date().toISOString(),
        'message-id': payload.message_id,
        'in-reply-to': payload.in_reply_to,
        references: payload.references,
      },
      body: payload.body,
      attachments: payload.attachments || [],
      employeeId: resolvedEmployeeId,
      userId: resolvedUserId,
    });

    // 6. Emit event for UI updates
    eventBus.emit(EVENT_NAMES.TASK_CREATED || 'task:created', {
      source: 'email',
      workOrders: result.work_orders,
      statuses: result.statuses,
    });

    // 7. Log webhook event
    await logWebhookEvent({
      webhookId: null,
      sourceType: 'email',
      status: 'processed',
      workOrderId: result.work_orders?.[0]?.id,
    }).catch(() => {});

    return {
      ok: true,
      workOrders: result.work_orders,
      statuses: result.statuses,
      actionItems: result.action_items,
      httpStatus: 200,
    };
  } catch (err) {
    await logWebhookEvent({
      webhookId: null,
      sourceType: 'email',
      status: 'error',
      error: err.message,
    }).catch(() => {});

    return { ok: false, error: err.message, httpStatus: 500 };
  }
}

// ── Test Helpers ─────────────────────────────────────────────────────────────

export function _resetEmailRateLimitsForTesting() {
  _emailRateLimits.clear();
}
