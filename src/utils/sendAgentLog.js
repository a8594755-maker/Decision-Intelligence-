/**
 * sendAgentLog – guarded debug/telemetry logger
 *
 * Sends a JSON payload to a local agent log endpoint.
 * The call is executed ONLY when BOTH conditions are true:
 *   1. import.meta.env.DEV === true   (Vite dev mode)
 *   2. import.meta.env.VITE_AGENT_LOG_ENDPOINT is a non-empty string
 *
 * In production builds this function is a no-op – no network request is made.
 * Errors are silently swallowed so the main business flow is never affected.
 *
 * @param {object} payload
 * @param {string} payload.location  – source file + line hint
 * @param {string} payload.message   – human-readable log message
 * @param {object} [payload.data]    – arbitrary structured data
 * @param {string} [payload.sessionId]    – debug session id
 * @param {string} [payload.hypothesisId] – hypothesis tag
 * @param {string} [payload.runId]        – run tag
 */
export function sendAgentLog(payload) {
  try {
    // Gate 1: only in Vite dev mode
    if (!import.meta.env.DEV) return;

    // Gate 2: explicit opt-in via env var
    const endpoint = import.meta.env.VITE_AGENT_LOG_ENDPOINT;
    if (!endpoint) return;

    const body = JSON.stringify({
      ...payload,
      timestamp: Date.now(),
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    })
      .catch(() => {})
      .finally(() => clearTimeout(timeoutId));
  } catch (_) {
    // Never throw – this is best-effort debug logging
  }
}

export default sendAgentLog;
