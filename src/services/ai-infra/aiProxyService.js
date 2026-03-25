import { acquireOrThrow } from '../../utils/rateLimiter';

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
const KIMI_MAX_IN_FLIGHT = Math.max(1, Math.floor(Number(import.meta.env.VITE_DI_KIMI_MAX_INFLIGHT || 4)));
const KIMI_OVERLOAD_RETRY_DELAYS_MS = Object.freeze([2000, 5000, 12000, 25000]);

// --- Circuit Breaker ---
const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 3;
const CIRCUIT_BREAKER_FAILURE_WINDOW_MS = 30_000;
const CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;
const CIRCUIT_BREAKER_MAX_COOLDOWN_MS = 120_000;

class AsyncSemaphore {
  constructor(maxConcurrent) {
    this.maxConcurrent = Math.max(1, Math.floor(Number(maxConcurrent) || 1));
    this.active = 0;
    this.queue = [];
  }

  acquire({ signal } = {}) {
    if (signal?.aborted) {
      return Promise.reject(signal.reason || new Error('Request aborted before acquiring provider slot.'));
    }

    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve(this._buildRelease());
    }

    return new Promise((resolve, reject) => {
      const entry = {
        resolve: () => {
          cleanup();
          this.active += 1;
          resolve(this._buildRelease());
        },
        reject,
      };

      const onAbort = () => {
        cleanup();
        reject(signal.reason || new Error('Request aborted while waiting for provider slot.'));
      };

      const cleanup = () => {
        const idx = this.queue.indexOf(entry);
        if (idx >= 0) this.queue.splice(idx, 1);
        if (signal) signal.removeEventListener('abort', onAbort);
      };

      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      this.queue.push(entry);
    });
  }

  _buildRelease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this._drain();
    };
  }

  setMaxConcurrent(n) {
    this.maxConcurrent = Math.max(1, Math.floor(Number(n) || 1));
    this._drain();
  }

  _drain() {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift();
      next?.resolve?.();
    }
  }
}

const providerSemaphores = new Map();

function getProviderSemaphore(provider) {
  if (!providerSemaphores.has(provider)) {
    const maxConcurrent = (provider === 'kimi' || provider === 'gemini') ? KIMI_MAX_IN_FLIGHT : 1;
    providerSemaphores.set(provider, new AsyncSemaphore(maxConcurrent));
  }
  return providerSemaphores.get(provider);
}

// --- Circuit Breaker (per-provider) ---

class CircuitBreaker {
  constructor(provider, semaphore) {
    this.provider = provider;
    this.semaphore = semaphore;
    this.originalMaxConcurrent = semaphore.maxConcurrent;
    this.state = 'CLOSED';       // CLOSED | OPEN | HALF_OPEN
    this.failures = [];          // timestamps of recent failures
    this.cooldownMs = CIRCUIT_BREAKER_COOLDOWN_MS;
    this.openedAt = 0;
  }

  recordFailure() {
    const now = Date.now();
    this.failures.push(now);
    // prune failures outside the window
    const cutoff = now - CIRCUIT_BREAKER_FAILURE_WINDOW_MS;
    this.failures = this.failures.filter((t) => t > cutoff);

    if (this.state === 'HALF_OPEN') {
      // test request failed — re-open with doubled cooldown
      this.state = 'OPEN';
      this.openedAt = now;
      this.cooldownMs = Math.min(this.cooldownMs * 2, CIRCUIT_BREAKER_MAX_COOLDOWN_MS);
      this.semaphore.setMaxConcurrent(1);
      console.warn(`[CircuitBreaker] ${this.provider} HALF_OPEN→OPEN (cooldown ${this.cooldownMs}ms)`);
      return;
    }

    if (this.state === 'CLOSED' && this.failures.length >= CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
      this.state = 'OPEN';
      this.openedAt = now;
      this.semaphore.setMaxConcurrent(1);
      console.warn(`[CircuitBreaker] ${this.provider} CLOSED→OPEN (${this.failures.length} failures in ${CIRCUIT_BREAKER_FAILURE_WINDOW_MS}ms, cooldown ${this.cooldownMs}ms)`);
    }
  }

  recordSuccess() {
    if (this.state === 'HALF_OPEN' || this.state === 'OPEN') {
      console.info(`[CircuitBreaker] ${this.provider} ${this.state}→CLOSED`);
    }
    this.state = 'CLOSED';
    this.failures = [];
    this.cooldownMs = CIRCUIT_BREAKER_COOLDOWN_MS;
    this.semaphore.setMaxConcurrent(this.originalMaxConcurrent);
  }

  canRequest() {
    if (this.state === 'CLOSED') return true;
    if (this.state === 'OPEN') {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed >= this.cooldownMs) {
        this.state = 'HALF_OPEN';
        console.info(`[CircuitBreaker] ${this.provider} OPEN→HALF_OPEN (testing one request)`);
        return true;
      }
      return false;
    }
    // HALF_OPEN — allow (semaphore at 1 ensures only 1 in flight)
    return true;
  }

  getState() {
    const cooldownRemainingMs = this.state === 'OPEN'
      ? Math.max(0, this.cooldownMs - (Date.now() - this.openedAt))
      : 0;
    return { state: this.state, cooldownRemainingMs, cooldownMs: this.cooldownMs };
  }
}

const providerCircuitBreakers = new Map();

function getProviderCircuitBreaker(provider) {
  if (!providerCircuitBreakers.has(provider)) {
    const semaphore = getProviderSemaphore(provider);
    providerCircuitBreakers.set(provider, new CircuitBreaker(provider, semaphore));
  }
  return providerCircuitBreakers.get(provider);
}

export function isProviderCircuitOpen(provider) {
  if (!providerCircuitBreakers.has(provider)) return false;
  const breaker = providerCircuitBreakers.get(provider);
  // Read-only check: true if OPEN or HALF_OPEN (provider under pressure)
  return breaker.state !== 'CLOSED';
}

function inferProxyProvider(mode, payload = {}) {
  const normalizedMode = String(mode || '').trim().toLowerCase();
  if (normalizedMode.startsWith('kimi_')) return 'kimi';
  if (normalizedMode.startsWith('gemini_')) return 'gemini';
  if (normalizedMode.startsWith('anthropic_')) return 'anthropic';
  if (normalizedMode.startsWith('openai_')) return 'openai';
  if (normalizedMode.startsWith('deepseek_')) return 'deepseek';
  if (normalizedMode === 'di_prompt') {
    return String(payload?.provider || '').trim().toLowerCase() || null;
  }
  return null;
}

function shouldApplyProviderBackpressure(mode, payload = {}) {
  const provider = inferProxyProvider(mode, payload);
  if (provider !== 'kimi' && provider !== 'gemini') return false;
  return !/billing$/i.test(String(mode || '').trim());
}

function isProviderOverloadedMessage(message) {
  return /engine.+overloaded|currently overloaded|provider.+overloaded|service.+overloaded|server.+busy|please try again later/i.test(String(message || ''));
}

function parseRetryAfterMs(response) {
  const header = response?.headers?.get?.('retry-after');
  if (!header) return null;
  const numericSeconds = Number(header);
  if (Number.isFinite(numericSeconds) && numericSeconds >= 0) {
    return Math.round(numericSeconds * 1000);
  }
  const dateValue = Date.parse(header);
  if (Number.isFinite(dateValue)) {
    return Math.max(0, dateValue - Date.now());
  }
  return null;
}

function createAiProxyError(message, { status = null, mode = null, payload = {}, retryAfterMs = null } = {}) {
  const provider = inferProxyProvider(mode, payload);
  const error = new Error(message);
  error.name = 'AiProxyError';
  error.status = status;
  error.mode = mode;
  error.provider = provider;
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    error.retryAfterMs = retryAfterMs;
  }
  if ((provider === 'kimi' || provider === 'gemini') && isProviderOverloadedMessage(message)) {
    error.failureCategory = 'provider_overloaded';
    error.failureMessage = message;
  }
  return error;
}

function isRetriableProviderOverload(error, { provider } = {}) {
  if (provider !== 'kimi' && provider !== 'gemini') return false;
  const status = Number(error?.status || 0);
  const message = String(error?.failureMessage || error?.message || '').trim();
  return (
    status === 429
    || status === 503
    || isProviderOverloadedMessage(message)
  );
}

function delayWithAbort(ms, signal) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const tid = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(signal?.reason || new Error('Request aborted during retry backoff.'));
    };

    const cleanup = () => {
      clearTimeout(tid);
      signal?.removeEventListener?.('abort', onAbort);
    };

    if (signal) {
      if (signal.aborted) {
        cleanup();
        reject(signal.reason || new Error('Request aborted during retry backoff.'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

async function withProviderBackpressure(mode, payload, signal, task) {
  const provider = inferProxyProvider(mode, payload);
  const applyBackpressure = shouldApplyProviderBackpressure(mode, payload);

  // Circuit breaker check — reject immediately if provider is overloaded
  if (applyBackpressure) {
    const breaker = getProviderCircuitBreaker(provider);
    if (!breaker.canRequest()) {
      const { cooldownRemainingMs } = breaker.getState();
      const err = createAiProxyError(
        `${provider} circuit breaker is open — too many recent failures. Retry in ${Math.ceil(cooldownRemainingMs / 1000)}s.`,
        { status: 429, mode, payload }
      );
      err.failureCategory = 'provider_circuit_open';
      err.retryAfterMs = cooldownRemainingMs;
      throw err;
    }
  }

  const release = applyBackpressure
    ? await getProviderSemaphore(provider).acquire({ signal })
    : null;

  try {
    let attempt = 0;
    while (true) {
      try {
        const result = await task();
        if (applyBackpressure) getProviderCircuitBreaker(provider).recordSuccess();
        return result;
      } catch (error) {
        if (!applyBackpressure || !isRetriableProviderOverload(error, { provider }) || attempt >= KIMI_OVERLOAD_RETRY_DELAYS_MS.length) {
          if (applyBackpressure && isRetriableProviderOverload(error, { provider })) {
            getProviderCircuitBreaker(provider).recordFailure();
          }
          throw error;
        }
        if (applyBackpressure) getProviderCircuitBreaker(provider).recordFailure();
        const baseDelayMs = error?.retryAfterMs ?? KIMI_OVERLOAD_RETRY_DELAYS_MS[attempt];
        const jitterMs = Math.floor((Math.random?.() ?? 0.5) * 1000);
        const delayMs = baseDelayMs + jitterMs;
        console.warn(`[aiProxy] ${provider} overloaded for mode=${mode}; retrying in ${delayMs}ms (attempt ${attempt + 2}/${KIMI_OVERLOAD_RETRY_DELAYS_MS.length + 1})`);
        attempt += 1;
        await delayWithAbort(delayMs, signal);
      }
    }
  } finally {
    release?.();
  }
}

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
    res = await withProviderBackpressure(mode, payload, effectiveSignal, async () => {
      const response = await fetch(EDGE_FN_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ mode, payload }),
        signal: effectiveSignal,
      });

      if (!response.ok) {
        let message = `Edge Function failed (${response.status})`;
        const retryAfterMs = parseRetryAfterMs(response);
        try {
          const errPayload = await response.json();
          if (errPayload?.error) message = String(errPayload.error);
          else if (errPayload?.message) message = String(errPayload.message);
        } catch {
          // ignore parse errors
        }
        throw createAiProxyError(message, { status: response.status, mode, payload, retryAfterMs });
      }

      return response;
    });
  } finally {
    clearTimeout(timeoutId);
  }

  const elapsed = Math.round(performance.now() - t0);
  console.info(`[aiProxy] Edge Function "${AI_PROXY_FUNCTION_NAME}" (mode=${mode}) responded in ${elapsed}ms — status ${res.status}`);

  const data = await res.json();
  if (!data) {
    throw createAiProxyError('AI proxy returned an empty response.', { status: res.status, mode, payload });
  }
  if (data?.error) {
    throw createAiProxyError(String(data.error), { status: res.status, mode, payload });
  }

  return data;
};

/**
 * Invoke AI proxy in SSE streaming mode.
 * Reads the event stream and calls onDelta for each parsed chunk.
 *
 * @param {string} mode - ai-proxy mode (e.g. 'openai_chat_tools_stream')
 * @param {object} payload - Request payload
 * @param {object} options
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs]
 * @param {function} options.onDelta - Called with each parsed SSE data object
 */
export const invokeAiProxyStream = async (mode, payload = {}, { signal, timeoutMs = AI_PROXY_TIMEOUT_MS, onDelta } = {}) => {
  acquireOrThrow('ai_proxy');

  if (!EDGE_FN_URL) {
    throw new Error('Edge Function URL not configured. Check VITE_SUPABASE_URL.');
  }

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(new Error(`AI proxy stream timed out after ${timeoutMs}ms`)), timeoutMs);
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
  console.info(`[aiProxy] Calling Edge Function stream (mode=${mode})...`);

  let res;
  try {
    res = await withProviderBackpressure(mode, payload, effectiveSignal, async () => {
      const response = await fetch(EDGE_FN_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ mode, payload }),
        signal: effectiveSignal,
      });

      if (!response.ok) {
        let message = `Edge Function stream failed (${response.status})`;
        const retryAfterMs = parseRetryAfterMs(response);
        try {
          const errPayload = await response.json();
          if (errPayload?.error) message = String(errPayload.error);
        } catch { /* ignore */ }
        throw createAiProxyError(message, { status: response.status, mode, payload, retryAfterMs });
      }

      return response;
    });
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }

  const elapsed = Math.round(performance.now() - t0);

  console.info(`[aiProxy] Stream connected in ${elapsed}ms — reading SSE events...`);

  try {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by double newlines
      const events = buffer.split('\n\n');
      buffer = events.pop(); // Keep incomplete event in buffer

      for (const event of events) {
        const dataLine = event.split('\n').find((l) => l.startsWith('data: '));
        if (!dataLine) continue;
        const data = dataLine.slice(6); // Remove "data: " prefix
        if (data === '[DONE]') return;

        try {
          const parsed = JSON.parse(data);
          onDelta?.(parsed);
        } catch { /* skip malformed JSON */ }
      }
    }
  } finally {
    clearTimeout(timeoutId);
    console.info(`[aiProxy] Stream completed in ${Math.round(performance.now() - t0)}ms`);
  }
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

export const __resetAiProxyBackpressureForTests = () => {
  providerSemaphores.clear();
  providerCircuitBreakers.clear();
};

export default {
  invokeAiProxy,
  invokeAiProxyStream,
  streamTextToChunks,
  isProviderCircuitOpen,
  __resetAiProxyBackpressureForTests,
};
