import { acquireOrThrow } from '../utils/rateLimiter';

const AI_PROXY_FUNCTION_NAME = 'ai-proxy';
const SUPABASE_URL = String(import.meta.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

const EDGE_FN_URL = SUPABASE_URL
  ? `${SUPABASE_URL}/functions/v1/${AI_PROXY_FUNCTION_NAME}`
  : '';

/**
 * Read the stored Supabase JWT from localStorage synchronously.
 * Supabase JS v2 stores it under `sb-<project-ref>-auth-token`.
 * This avoids calling supabase.auth.getSession() which can trigger
 * a slow token-refresh network round-trip that hangs in some browsers.
 */
const getStoredAccessToken = () => {
  try {
    if (typeof localStorage === 'undefined') return null;
    // Extract project ref from URL: https://<ref>.supabase.co
    const match = SUPABASE_URL.match(/\/\/([^.]+)\./);
    if (!match) return null;
    const storageKey = `sb-${match[1]}-auth-token`;
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.access_token || null;
  } catch {
    return null;
  }
};

/**
 * Fire-and-forget warmup: sends a lightweight ping to wake the Edge Function
 * so the first real request doesn't pay the cold-start penalty (~3-5s).
 */
let _warmedUp = false;
export const warmupEdgeFunction = () => {
  if (_warmedUp || !EDGE_FN_URL || !SUPABASE_ANON_KEY) return;
  _warmedUp = true;
  const t0 = performance.now();
  fetch(EDGE_FN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ mode: 'ping', payload: {} }),
  })
    .then((r) => console.info(`[aiProxy] warmup completed in ${Math.round(performance.now() - t0)}ms — status ${r.status}`))
    .catch((e) => console.warn(`[aiProxy] warmup failed in ${Math.round(performance.now() - t0)}ms:`, e.message));
};

/** Default timeout for AI proxy requests (180 seconds — long tasks are common). */
const AI_PROXY_TIMEOUT_MS = 180_000;

export const invokeAiProxy = async (mode, payload = {}, { signal, timeoutMs = AI_PROXY_TIMEOUT_MS } = {}) => {
  acquireOrThrow('ai_proxy');

  if (!EDGE_FN_URL) {
    throw new Error('Edge Function URL not configured. Check VITE_SUPABASE_URL.');
  }

  // Build a signal that respects both caller abort and timeout
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(new Error(`AI proxy timed out after ${timeoutMs}ms`)), timeoutMs);
  const effectiveSignal = signal
    ? (AbortSignal.any
        ? AbortSignal.any([signal, timeoutController.signal])
        : (() => { const c = new AbortController(); const onAbort = () => c.abort(); signal.addEventListener('abort', onAbort, { once: true }); timeoutController.signal.addEventListener('abort', onAbort, { once: true }); return c.signal; })())
    : timeoutController.signal;

  const accessToken = getStoredAccessToken();
  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_ANON_KEY,
  };
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  const t0 = performance.now();
  console.info(`[aiProxy] Calling Edge Function "${AI_PROXY_FUNCTION_NAME}" (mode=${mode}) via raw fetch...`);

  let res;
  try {
  res = await fetch(EDGE_FN_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ mode, payload }),
    signal: effectiveSignal,
  });
  } finally {
    clearTimeout(timeoutId);
  }

  const elapsed = Math.round(performance.now() - t0);
  console.info(`[aiProxy] Edge Function "${AI_PROXY_FUNCTION_NAME}" (mode=${mode}) responded in ${elapsed}ms — status ${res.status}`);

  if (!res.ok) {
    let message = `Edge Function failed (${res.status})`;
    try {
      const errPayload = await res.json();
      if (errPayload?.error) message = String(errPayload.error);
      else if (errPayload?.message) message = String(errPayload.message);
    } catch {
      // ignore parse errors
    }
    throw new Error(message);
  }

  const data = await res.json();
  if (!data) {
    throw new Error('AI proxy returned an empty response.');
  }
  if (data?.error) {
    throw new Error(String(data.error));
  }

  return data;
};

export const streamTextToChunks = (text, onChunk, chunkSize = 48) => {
  if (typeof onChunk !== 'function') return;
  const content = String(text || '');
  if (!content) return;
  const size = Number.isFinite(Number(chunkSize)) && Number(chunkSize) > 0 ? Number(chunkSize) : 48;
  for (let idx = 0; idx < content.length; idx += size) {
    onChunk(content.slice(idx, idx + size));
  }
};

export default {
  invokeAiProxy,
  streamTextToChunks,
};
