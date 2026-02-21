import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We need to control import.meta.env at module level, so we use dynamic import
// with vi.stubEnv / vi.unstubAllEnvs (Vitest ≥0.26)

describe('sendAgentLog', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('does NOT call fetch when DEV is false', async () => {
    vi.stubEnv('DEV', '');
    vi.stubEnv('VITE_AGENT_LOG_ENDPOINT', 'http://127.0.0.1:7242/ingest/test');

    // Force re-import so import.meta.env picks up stubs
    const { sendAgentLog } = await import('./sendAgentLog.js');
    sendAgentLog({ location: 'test', message: 'hello' });

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('does NOT call fetch when DEV is true but VITE_AGENT_LOG_ENDPOINT is missing', async () => {
    vi.stubEnv('DEV', 'true');
    vi.stubEnv('VITE_AGENT_LOG_ENDPOINT', '');

    const { sendAgentLog } = await import('./sendAgentLog.js');
    sendAgentLog({ location: 'test', message: 'hello' });

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('calls fetch once when DEV is true and VITE_AGENT_LOG_ENDPOINT is set', async () => {
    vi.stubEnv('DEV', 'true');
    vi.stubEnv('VITE_AGENT_LOG_ENDPOINT', 'http://127.0.0.1:7242/ingest/test');

    const { sendAgentLog } = await import('./sendAgentLog.js');
    sendAgentLog({ location: 'test.js:1', message: 'hello', data: { foo: 1 } });

    // In dev mode with endpoint set, import.meta.env.DEV should be truthy
    // However, vi.stubEnv only sets import.meta.env for the *current* module context.
    // The imported module evaluates import.meta.env at call-time, so this should work.
    // If import.meta.env.DEV is truthy string 'true', the check `if (!import.meta.env.DEV)` passes.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    const [url, options] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:7242/ingest/test');
    expect(options.method).toBe('POST');
    expect(options.headers).toEqual({ 'Content-Type': 'application/json' });

    const body = JSON.parse(options.body);
    expect(body.location).toBe('test.js:1');
    expect(body.message).toBe('hello');
    expect(body.data).toEqual({ foo: 1 });
    expect(body.timestamp).toBeTypeOf('number');
  });

  it('never throws even if fetch rejects', async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('network error')));
    vi.stubEnv('DEV', 'true');
    vi.stubEnv('VITE_AGENT_LOG_ENDPOINT', 'http://127.0.0.1:7242/ingest/test');

    const { sendAgentLog } = await import('./sendAgentLog.js');

    // Should not throw
    expect(() => sendAgentLog({ location: 'x', message: 'y' })).not.toThrow();
  });
});
