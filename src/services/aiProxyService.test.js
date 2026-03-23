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
    await vi.advanceTimersByTimeAsync(1000);
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
    expect(globalThis.fetch).toHaveBeenCalledTimes(4);
  });
});
