/**
 * emailIntakeService.js — Email Intake Processor
 *
 * Parses raw email content (headers, body, attachments metadata) and feeds
 * normalized work orders into the taskIntakeService pipeline.
 *
 * Supports:
 *   - Header extraction (From, To, CC, Subject, Date, Reply-To)
 *   - Body parsing (plain text extraction, signature removal)
 *   - Action item detection from email body
 *   - Urgency detection from subject/body keywords
 *   - Attachment metadata extraction
 *   - Thread context (In-Reply-To, References)
 *
 * Usage:
 *   const result = await processEmailIntake({
 *     rawHeaders: { from, to, subject, date },
 *     body: 'Please run a forecast for next quarter...',
 *     employeeId, userId,
 *   });
 */

import { processIntake, INTAKE_SOURCES } from './taskIntakeService.js';

// ── Email Parsing ───────────────────────────────────────────────────────────

/**
 * Parse email headers from raw header object or RFC822 string.
 *
 * @param {Object|string} headers
 * @returns {Object} Normalized header fields
 */
export function parseEmailHeaders(headers) {
  if (typeof headers === 'string') {
    return parseRawHeaderString(headers);
  }

  return {
    from: headers.from || headers.From || '',
    to: normalizeRecipients(headers.to || headers.To || ''),
    cc: normalizeRecipients(headers.cc || headers.Cc || ''),
    subject: headers.subject || headers.Subject || '',
    date: headers.date || headers.Date || new Date().toISOString(),
    reply_to: headers['reply-to'] || headers['Reply-To'] || '',
    in_reply_to: headers['in-reply-to'] || headers['In-Reply-To'] || '',
    references: headers.references || headers.References || '',
    message_id: headers['message-id'] || headers['Message-ID'] || '',
  };
}

function parseRawHeaderString(raw) {
  const result = {};
  const lines = raw.split(/\r?\n/);
  let currentKey = '';

  for (const line of lines) {
    if (/^\s/.test(line) && currentKey) {
      result[currentKey] += ' ' + line.trim();
    } else {
      const match = line.match(/^([^:]+):\s*(.*)$/);
      if (match) {
        currentKey = match[1].toLowerCase();
        result[currentKey] = match[2].trim();
      }
    }
  }

  return {
    from: result.from || '',
    to: normalizeRecipients(result.to || ''),
    cc: normalizeRecipients(result.cc || ''),
    subject: result.subject || '',
    date: result.date || new Date().toISOString(),
    reply_to: result['reply-to'] || '',
    in_reply_to: result['in-reply-to'] || '',
    references: result.references || '',
    message_id: result['message-id'] || '',
  };
}

function normalizeRecipients(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  return value.split(',').map(r => r.trim()).filter(Boolean);
}

// ── Body Parsing ────────────────────────────────────────────────────────────

/**
 * Clean email body: remove signatures, quotes, and excessive whitespace.
 *
 * @param {string} body
 * @returns {{ cleanBody: string, hasQuotedContent: boolean }}
 */
export function parseEmailBody(body) {
  if (!body) return { cleanBody: '', hasQuotedContent: false };

  let text = body;

  // Detect quoted content
  const hasQuotedContent = /^>/m.test(text) || /On .+ wrote:/i.test(text) || /-----Original Message-----/i.test(text);

  // Remove quoted content (lines starting with >)
  text = text.replace(/^>.*$/gm, '').trim();

  // Remove "On ... wrote:" blocks
  text = text.replace(/On\s.+wrote:\s*$/gm, '').trim();

  // Remove common signatures
  const sigMarkers = [
    /^--\s*$/m,
    /^_{5,}$/m,
    /^-{5,}$/m,
    /^Sent from my /m,
    /^Get Outlook for /m,
    /^-----Original Message-----/m,
  ];

  for (const marker of sigMarkers) {
    const match = text.match(marker);
    if (match) {
      text = text.substring(0, match.index).trim();
    }
  }

  // Collapse excessive whitespace
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return { cleanBody: text, hasQuotedContent };
}

// ── Action Item Detection ───────────────────────────────────────────────────

const ACTION_PATTERNS = [
  /please\s+(?:help|run|generate|create|prepare|analyze|check|review|update)\s+(.+)/gi,
  /(?:can you|could you|would you)\s+(.+?)(?:\?|$)/gi,
  /(?:need|require|want)\s+(?:a|an|to)\s+(.+?)(?:\.|$)/gi,
  /(?:action item|todo|task):\s*(.+)/gi,
  /(?:請|麻煩|幫我)\s*(.+?)(?:。|$)/gi,
  /(?:需要|要求)\s*(.+?)(?:。|$)/gi,
];

/**
 * Extract action items from email body.
 *
 * @param {string} body
 * @returns {string[]} Detected action items
 */
export function extractActionItems(body) {
  if (!body) return [];

  const items = [];
  for (const pattern of ACTION_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(body)) !== null) {
      const item = match[1].trim();
      if (item.length > 5 && item.length < 200) {
        items.push(item);
      }
    }
  }

  // Deduplicate
  return [...new Set(items)];
}

// ── Attachment Metadata ─────────────────────────────────────────────────────

/**
 * Extract attachment metadata (does not process file content).
 *
 * @param {Object[]} attachments - Array of { filename, contentType, size }
 * @returns {Object[]} Normalized attachment metadata
 */
export function parseAttachments(attachments = []) {
  return attachments.map(att => ({
    filename: att.filename || att.name || 'unknown',
    content_type: att.contentType || att.content_type || att.type || 'application/octet-stream',
    size_bytes: att.size || att.size_bytes || 0,
    is_spreadsheet: /\.(xlsx?|csv|tsv)$/i.test(att.filename || ''),
    is_document: /\.(docx?|pdf|txt|md)$/i.test(att.filename || ''),
  }));
}

// ── Full Email Intake Pipeline ──────────────────────────────────────────────

/**
 * Process a raw email into one or more work orders.
 *
 * @param {Object} params
 * @param {Object|string} params.rawHeaders   - Email headers
 * @param {string}        params.body         - Email body (plain text)
 * @param {Object[]}      [params.attachments] - Attachment metadata
 * @param {string}        params.employeeId   - Target AI employee
 * @param {string}        params.userId       - Requesting user
 * @returns {Promise<Object>} Intake result with work order(s)
 */
export async function processEmailIntake({ rawHeaders, body, attachments = [], employeeId, userId }) {
  // 1. Parse headers
  const headers = parseEmailHeaders(rawHeaders);

  // 2. Parse body
  const { cleanBody, hasQuotedContent } = parseEmailBody(body);

  // 3. Extract action items
  const actionItems = extractActionItems(cleanBody);

  // 4. Parse attachments
  const parsedAttachments = parseAttachments(attachments);

  // 5. Build metadata
  const metadata = {
    source_ref: headers.message_id || `email_${Date.now()}`,
    subject: headers.subject,
    from: headers.from,
    to: headers.to,
    cc: headers.cc,
    date: headers.date,
    has_quoted_content: hasQuotedContent,
    in_reply_to: headers.in_reply_to,
    references: headers.references,
    attachments: parsedAttachments,
    action_items: actionItems,
    has_spreadsheet: parsedAttachments.some(a => a.is_spreadsheet),
  };

  // 6. If multiple distinct action items found, create work orders for each
  if (actionItems.length > 1) {
    const results = [];
    for (const item of actionItems) {
      const result = await processIntake({
        source: INTAKE_SOURCES.EMAIL,
        message: item,
        employeeId,
        userId,
        metadata: { ...metadata, title: `[Email] ${item.slice(0, 60)}` },
      });
      results.push(result);
    }
    return {
      work_orders: results.map(r => r.workOrder),
      statuses: results.map(r => r.status),
      action_items: actionItems,
      headers,
    };
  }

  // 7. Single work order from the email
  const result = await processIntake({
    source: INTAKE_SOURCES.EMAIL,
    message: cleanBody,
    employeeId,
    userId,
    metadata,
  });

  return {
    work_orders: [result.workOrder],
    statuses: [result.status],
    action_items: actionItems,
    headers,
  };
}
