const ML_API_BASE = import.meta.env.VITE_ML_API_URL || '';
const INVALID_BASE_URL_VALUES = new Set(['null', 'undefined']);

function normalizeBaseUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (INVALID_BASE_URL_VALUES.has(raw.toLowerCase())) return '';
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

function withTimeout(promise, timeoutMs) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Plan governance API timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

async function requestJson(path, method = 'GET', payload = null, options = {}) {
  const baseUrl = normalizeBaseUrl(ML_API_BASE);
  if (!baseUrl) {
    throw new Error('VITE_ML_API_URL is not configured');
  }

  const headers = {
    'Content-Type': 'application/json',
    'x-actor-id': String(options.actorId || 'anonymous'),
    'x-role': String(options.role || 'approver')
  };

  const response = await withTimeout(
    fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: payload == null ? undefined : JSON.stringify(payload)
    }),
    options.timeoutMs || 15000
  );

  const text = await response.text().catch(() => '');
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }

  if (!response.ok) {
    const detail = parsed?.detail || parsed?.error || text || response.statusText;
    throw new Error(`Plan governance API ${response.status}: ${detail}`);
  }

  if (parsed?.error) {
    throw new Error(parsed.error);
  }

  return parsed;
}

export function isPlanGovernanceConfigured() {
  return Boolean(normalizeBaseUrl(ML_API_BASE));
}

export async function requestPlanApproval({
  runId,
  userId,
  payload = {},
  reason = 'Plan requires manual approval.',
  note = '',
  role = 'approver'
}) {
  if (!runId) throw new Error('runId is required');

  return requestJson('/governance/approvals/request', 'POST', {
    action_type: 'APPROVE_PLAN',
    entity_id: String(runId),
    payload,
    reason,
    note
  }, {
    actorId: userId,
    role
  });
}

export async function approvePlanApproval({
  approvalId,
  userId,
  note = '',
  role = 'approver'
}) {
  if (!approvalId) throw new Error('approvalId is required');

  return requestJson(`/governance/approvals/${approvalId}/approve`, 'POST', { note }, {
    actorId: userId,
    role
  });
}

export async function rejectPlanApproval({
  approvalId,
  userId,
  note = '',
  role = 'approver'
}) {
  if (!approvalId) throw new Error('approvalId is required');

  return requestJson(`/governance/approvals/${approvalId}/reject`, 'POST', { note }, {
    actorId: userId,
    role
  });
}
