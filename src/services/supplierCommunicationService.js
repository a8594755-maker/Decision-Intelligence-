/**
 * Supplier Communication Service
 *
 * Handles outbound communication for negotiation drafts — email, Slack,
 * and event logging. Initially stubbed (console.log + event recording)
 * with clearly defined interfaces for real integration.
 *
 * Design:
 *   - All channel-send methods are async + return a result envelope
 *   - `logOutboundAction` persists every outbound action to Supabase
 *   - Graceful degradation: if Supabase or channel is unavailable, still succeeds locally
 */

// ── Configuration ────────────────────────────────────────────────────────────

export const COMMUNICATION_CONFIG = {
  /** Supported channels */
  channels: ['email', 'slack', 'manual'],

  /** SendGrid / SES config keys (read from env at call time) */
  email_from_env: 'VITE_DI_EMAIL_FROM',
  email_api_key_env: 'VITE_SENDGRID_API_KEY',

  /** Slack webhook URL env key */
  slack_webhook_env: 'VITE_SLACK_NEGOTIATION_WEBHOOK',

  /** Max draft body length for outbound */
  max_body_length: 10_000,

  /** Rate limit: min ms between sends to same supplier */
  min_send_interval_ms: 60 * 1000, // 1 minute
};

// ── Rate limiter state ───────────────────────────────────────────────────────

const _lastSentMap = new Map(); // supplier_id → timestamp

function isRateLimited(supplierId) {
  const now = Date.now();
  const last = _lastSentMap.get(supplierId);
  if (last && (now - last) < COMMUNICATION_CONFIG.min_send_interval_ms) {
    return true;
  }
  return false;
}

function recordSend(supplierId) {
  _lastSentMap.set(supplierId, Date.now());
}

// ── Channel Implementations (stubbed) ────────────────────────────────────────

/**
 * Send a negotiation draft via email via SendGrid v3 API.
 * Requires VITE_SENDGRID_API_KEY and optionally VITE_DI_EMAIL_FROM env vars.
 *
 * @param {Object} params
 * @param {Object} params.draft      - { subject, body, tone }
 * @param {string} params.recipient  - Email address
 * @param {Object} [params.options]  - { cc, bcc, replyTo }
 * @returns {Promise<{ sent: boolean, channel: string, messageId: string|null, error: string|null }>}
 */
export async function sendDraftViaEmail({ draft, recipient, options = {} }) {
  if (!draft?.body) {
    return { sent: false, channel: 'email', messageId: null, error: 'Draft body is required' };
  }
  if (!recipient) {
    return { sent: false, channel: 'email', messageId: null, error: 'Recipient email is required' };
  }

  // Truncate body if needed
  const body = draft.body.slice(0, COMMUNICATION_CONFIG.max_body_length);

  const apiKey = import.meta?.env?.VITE_SENDGRID_API_KEY;
  const fromEmail = import.meta?.env?.VITE_DI_EMAIL_FROM || 'noreply@decision-intelligence.app';
  const stubMessageId = `email_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  if (!apiKey) {
    console.warn('[supplierCommunication] VITE_SENDGRID_API_KEY not set — returning stub email send result');
    return { sent: true, channel: 'email', messageId: stubMessageId, error: null };
  }

  const subject = draft.subject || `Negotiation Update — ${draft.tone || 'standard'}`;
  const payload = {
    personalizations: [{
      to: [{ email: recipient }],
      ...(options.cc?.length ? { cc: options.cc.map(e => ({ email: e })) } : {}),
      ...(options.bcc?.length ? { bcc: options.bcc.map(e => ({ email: e })) } : {}),
    }],
    from: { email: fromEmail },
    ...(options.replyTo ? { reply_to: { email: options.replyTo } } : {}),
    subject,
    content: [{ type: 'text/plain', value: body }],
  };

  let response;
  try {
    response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (networkErr) {
    return { sent: false, channel: 'email', messageId: null, error: `Network error: ${networkErr.message}` };
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => 'unknown');
    return { sent: false, channel: 'email', messageId: null, error: `SendGrid ${response.status}: ${errText}` };
  }

  const messageId = response.headers.get('X-Message-Id') || stubMessageId;
  return { sent: true, channel: 'email', messageId, error: null };
}

/**
 * Send a negotiation draft via Slack incoming webhook.
 * Requires VITE_SLACK_NEGOTIATION_WEBHOOK env var.
 *
 * @param {Object} params
 * @param {Object} params.draft     - { body, tone }
 * @param {string} params.channelId - Slack channel ID or webhook identifier
 * @param {Object} [params.options] - { threadTs, username }
 * @returns {Promise<{ sent: boolean, channel: string, messageId: string|null, error: string|null }>}
 */
export async function sendDraftViaSlack({ draft, channelId, options = {} }) {
  if (!draft?.body) {
    return { sent: false, channel: 'slack', messageId: null, error: 'Draft body is required' };
  }
  if (!channelId) {
    return { sent: false, channel: 'slack', messageId: null, error: 'Channel ID is required' };
  }

  const webhookUrl = import.meta?.env?.VITE_SLACK_NEGOTIATION_WEBHOOK;
  const stubMessageId = `slack_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  if (!webhookUrl) {
    console.warn('[supplierCommunication] VITE_SLACK_NEGOTIATION_WEBHOOK not set — returning stub Slack send result');
    return { sent: true, channel: 'slack', messageId: stubMessageId, error: null };
  }

  const slackPayload = {
    text: draft.body.slice(0, 3000), // Slack text limit
    channel: channelId,
    ...(options.username ? { username: options.username } : {}),
    ...(options.threadTs ? { thread_ts: options.threadTs } : {}),
  };

  let response;
  try {
    response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(slackPayload),
    });
  } catch (networkErr) {
    return { sent: false, channel: 'slack', messageId: null, error: `Network error: ${networkErr.message}` };
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => 'unknown');
    return { sent: false, channel: 'slack', messageId: null, error: `Slack webhook ${response.status}: ${errText}` };
  }

  const messageId = stubMessageId;
  return { sent: true, channel: 'slack', messageId, error: null };
}

// ── Event Logging ────────────────────────────────────────────────────────────

/**
 * Log an outbound negotiation action — persists to Supabase `di_negotiation_events`
 * and records in the in-memory state tracker.
 *
 * @param {Object} params
 * @param {string}  params.caseId          - Negotiation case ID
 * @param {string}  params.channel         - 'email' | 'slack' | 'manual'
 * @param {Object}  params.draft           - Draft that was sent/copied/skipped
 * @param {string}  params.action          - 'sent' | 'copy' | 'skip'
 * @param {Object}  [params.sendResult]    - Result from channel send (if any)
 * @param {string}  [params.userId]        - User who took the action
 * @param {string}  [params.supplierId]    - Supplier the communication targets
 * @param {Object}  [params.metadata]      - Additional metadata
 * @returns {Promise<{ logged: boolean, eventId: string|null, error: string|null }>}
 */
export async function logOutboundAction({
  caseId,
  channel = 'manual',
  draft,
  action,
  sendResult = null,
  userId: _userId = null,
  supplierId = null,
  metadata = {},
}) {
  const eventId = `outbound_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const _eventRecord = {
    event_id: eventId,
    case_id: caseId,
    action,
    channel,
    draft_tone: draft?.tone || null,
    draft_body: draft?.body || null,
    draft_subject: draft?.subject || null,
    was_edited: metadata.wasEdited || false,
    send_result: sendResult,
    supplier_id: supplierId,
    timestamp: new Date().toISOString(),
  };

  // 1. Try Supabase persistence
  let persisted = false;
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const supabaseUrl = import.meta?.env?.VITE_SUPABASE_URL;
    const supabaseKey = import.meta?.env?.VITE_SUPABASE_ANON_KEY;
    if (supabaseUrl && supabaseKey && caseId) {
      const sb = createClient(supabaseUrl, supabaseKey);
      await sb.from('di_negotiation_events').insert({
        case_id: caseId,
        round: metadata.round || 0,
        round_name: metadata.roundName || 'UNKNOWN',
        player: 'buyer',
        action: action === 'sent' ? 'accept' : action === 'skip' ? 'reject' : action,
        details: {
          channel,
          draft_tone: draft?.tone,
          was_edited: metadata.wasEdited || false,
          send_message_id: sendResult?.messageId || null,
        },
        draft_tone: draft?.tone || null,
        draft_body: draft?.body || null,
      });
      persisted = true;
    }
  } catch (e) {
    console.warn('[supplierCommunication] Supabase persist failed:', e?.message);
  }

  // 2. Always log locally
  console.log('[supplierCommunication] OUTBOUND ACTION:', {
    action,
    channel,
    caseId,
    tone: draft?.tone,
    persisted,
    eventId,
  });

  return { logged: true, eventId, error: null };
}

// ── High-Level Send + Log ────────────────────────────────────────────────────

/**
 * Send a negotiation draft through a channel and log the action.
 * Combines channel send + event logging in one call.
 *
 * @param {Object} params
 * @param {string}  params.channel    - 'email' | 'slack' | 'manual'
 * @param {Object}  params.draft      - { body, tone, subject }
 * @param {string}  params.caseId     - Negotiation case ID
 * @param {string}  [params.recipient]  - Email or channel ID
 * @param {string}  [params.supplierId]
 * @param {string}  [params.userId]
 * @param {Object}  [params.metadata]
 * @returns {Promise<{ sent: boolean, logged: boolean, eventId: string|null, error: string|null }>}
 */
export async function sendAndLog({
  channel = 'manual',
  draft,
  caseId,
  recipient,
  supplierId = null,
  userId = null,
  metadata = {},
}) {
  // Rate limit check
  if (supplierId && isRateLimited(supplierId)) {
    return {
      sent: false,
      logged: false,
      eventId: null,
      error: `Rate limited: last send to supplier ${supplierId} was within ${COMMUNICATION_CONFIG.min_send_interval_ms}ms`,
    };
  }

  let sendResult = null;

  // Channel dispatch
  if (channel === 'email') {
    sendResult = await sendDraftViaEmail({ draft, recipient });
  } else if (channel === 'slack') {
    sendResult = await sendDraftViaSlack({ draft, channelId: recipient });
  } else {
    // Manual / copy — no actual send, just log
    sendResult = { sent: true, channel: 'manual', messageId: null, error: null };
  }

  if (!sendResult.sent) {
    return { sent: false, logged: false, eventId: null, error: sendResult.error };
  }

  // Record rate limit
  if (supplierId) recordSend(supplierId);

  // Log the action
  const logResult = await logOutboundAction({
    caseId,
    channel,
    draft,
    action: 'sent',
    sendResult,
    userId,
    supplierId,
    metadata,
  });

  return {
    sent: true,
    logged: logResult.logged,
    eventId: logResult.eventId,
    error: null,
  };
}

// ── Test helpers ─────────────────────────────────────────────────────────────

/** Clear rate limiter state (for tests) */
export function clearRateLimiter() {
  _lastSentMap.clear();
}

export default {
  COMMUNICATION_CONFIG,
  sendDraftViaEmail,
  sendDraftViaSlack,
  logOutboundAction,
  sendAndLog,
  clearRateLimiter,
};
