/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

const mockAcquireOrThrow = vi.fn();

vi.mock('../utils/rateLimiter', () => ({
  acquireOrThrow: (...args) => mockAcquireOrThrow(...args),
}));

function makeJsonResponse(status, payload, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => headers[String(name || '').toLowerCase()] ?? null,
    },
    json: vi.fn().mockResolvedValue(payload),
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function loadAiProxyService() {
  vi.resetModules();
  return import('./aiProxyService.js');
}

describe('aiProxyService Kimi backpressure', () => {
  beforeEach(() => {
    mockAcquireOrThrow.mockReset();
    mockAcquireOrThrow.mockImplementation(() => undefined);
    vi.stubEnv('VITE_SUPABASE_URL', 'https://unit-test.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-test-key');
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries overloaded Kimi requests with backoff and eventually succeeds', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    globalThis.fetch
      .mockResolvedValueOnce(makeJsonResponse(429, {
        error: 'The engine is currently overloaded, please try again later',
      }))
      .mockResolvedValueOnce(makeJsonResponse(200, {
        ok: true,
        text: 'Recovered after retry',
      }));

    const { invokeAiProxy, __resetAiProxyBackpressureForTests } = await loadAiProxyService();
    __resetAiProxyBackpressureForTests();

    const promise = invokeAiProxy('kimi_chat_tools', { messages: [{ role: 'user', content: 'hi' }] });
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      text: 'Recovered after retry',
    }));
  });

  it('queues excess concurrent Kimi requests instead of firing all of them at once', async () => {
    const deferreds = Array.from({ length: 5 }, () => createDeferred());
    let fetchIndex = 0;
    globalThis.fetch.mockImplementation(() => deferreds[fetchIndex++]?.promise);

    const { invokeAiProxy, __resetAiProxyBackpressureForTests } = await loadAiProxyService();
    __resetAiProxyBackpressureForTests();

    const requests = Array.from({ length: 5 }, (_, index) => invokeAiProxy('kimi_chat_tools', {
      messages: [{ role: 'user', content: `request-${index}` }],
    }));

    await Promise.resolve();
    expect(globalThis.fetch).toHaveBeenCalledTimes(4);

    deferreds[0].resolve(makeJsonResponse(200, { ok: true, text: 'released first' }));
    await requests[0];
    await Promise.resolve();

    expect(globalThis.fetch).toHaveBeenCalledTimes(5);

    deferreds.slice(1).forEach((deferred, index) => {
      deferred.resolve(makeJsonResponse(200, { ok: true, text: `done-${index + 1}` }));
    });

    await Promise.all(requests);
  });

  it('marks exhausted Kimi overload retries as provider_overloaded', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    globalThis.fetch.mockResolvedValue(makeJsonResponse(429, {
      error: 'The engine is currently overloaded, please try again later',
    }));

    const { invokeAiProxy, __resetAiProxyBackpressureForTests } = await loadAiProxyService();
    __resetAiProxyBackpressureForTests();

    const promise = invokeAiProxy('kimi_chat_tools', { messages: [{ role: 'user', content: 'hi' }] });
    const rejection = expect(promise).rejects.toMatchObject({
      failureCategory: 'provider_overloaded',
      provider: 'kimi',
      status: 429,
    });
    await vi.runAllTimersAsync();

    await rejection;
    expect(globalThis.fetch).toHaveBeenCalledTimes(5);
  });
});

describe('aiProxyService Circuit Breaker', () => {
  beforeEach(() => {
    mockAcquireOrThrow.mockReset();
    mockAcquireOrThrow.mockImplementation(() => undefined);
    vi.stubEnv('VITE_SUPABASE_URL', 'https://unit-test.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-test-key');
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('opens circuit breaker after consecutive 429 failures and rejects immediately', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    globalThis.fetch.mockResolvedValue(makeJsonResponse(429, {
      error: 'The engine is currently overloaded, please try again later',
    }));

    const { invokeAiProxy, isProviderCircuitOpen, __resetAiProxyBackpressureForTests } = await loadAiProxyService();
    __resetAiProxyBackpressureForTests();

    // First call: exhausts all retries (5 fetches) and trips the circuit breaker
    // Cooldown is 60s so it stays OPEN even after retries (~44s)
    const promise1 = invokeAiProxy('gemini_chat', { provider: 'gemini' });
    const rejection1 = expect(promise1).rejects.toMatchObject({ status: 429 });
    await vi.runAllTimersAsync();
    await rejection1;

    // Circuit should be open (not CLOSED) — cooldown is 60s, retries took ~44s
    expect(isProviderCircuitOpen('gemini')).toBe(true);

    // Second call: should be rejected immediately by circuit breaker
    const promise2 = invokeAiProxy('gemini_chat', { provider: 'gemini' });
    await expect(promise2).rejects.toMatchObject({
      failureCategory: 'provider_circuit_open',
    });
  });

  it('recovers after successful request following cooldown', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const { invokeAiProxy, isProviderCircuitOpen, __resetAiProxyBackpressureForTests } = await loadAiProxyService();
    __resetAiProxyBackpressureForTests();

    // First send 429s to trip the breaker
    globalThis.fetch.mockResolvedValue(makeJsonResponse(429, {
      error: 'The engine is currently overloaded, please try again later',
    }));

    const promise1 = invokeAiProxy('gemini_chat', { provider: 'gemini' });
    const rejection1 = expect(promise1).rejects.toThrow();
    await vi.runAllTimersAsync();
    await rejection1;

    expect(isProviderCircuitOpen('gemini')).toBe(true);

    // Advance past cooldown (60s from when breaker opened at ~7s into retry loop)
    await vi.advanceTimersByTimeAsync(61_000);

    // Now send a success — the breaker should recover via HALF_OPEN
    globalThis.fetch.mockResolvedValueOnce(makeJsonResponse(200, { ok: true, text: 'recovered' }));
    const promise2 = invokeAiProxy('gemini_chat', { provider: 'gemini' });
    const result = await promise2;

    expect(result).toEqual(expect.objectContaining({ ok: true, text: 'recovered' }));
    expect(isProviderCircuitOpen('gemini')).toBe(false);
  });

  it('isProviderCircuitOpen returns false for providers without circuit breaker', async () => {
    const { isProviderCircuitOpen, __resetAiProxyBackpressureForTests } = await loadAiProxyService();
    __resetAiProxyBackpressureForTests();
    expect(isProviderCircuitOpen('anthropic')).toBe(false);
    expect(isProviderCircuitOpen('gemini')).toBe(false);
  });
});
