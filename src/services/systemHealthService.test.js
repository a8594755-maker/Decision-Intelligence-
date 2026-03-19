/**
 * systemHealthService.test.js — Tests for real dependency health checks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  checkSupabase,
  checkMlApi,
  checkAiProxy,
  checkDatabase,
  runFullHealthCheck,
} from './systemHealthService.js';

// ── Mock fetch globally ─────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── checkSupabase ───────────────────────────────────────────────────────────

describe('checkSupabase', () => {
  it('returns online when auth health endpoint returns 200', async () => {
    globalThis.fetch.mockResolvedValueOnce({ ok: true, status: 200 });
    const result = await checkSupabase();
    expect(result.status).toBe('online');
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('returns degraded when auth health returns non-200', async () => {
    globalThis.fetch.mockResolvedValueOnce({ ok: false, status: 503 });
    const result = await checkSupabase();
    expect(result.status).toBe('degraded');
  });

  it('returns offline on network error', async () => {
    globalThis.fetch.mockRejectedValueOnce(new Error('Network error'));
    const result = await checkSupabase();
    expect(result.status).toBe('offline');
    expect(result.detail).toContain('Network error');
  });
});

// ── checkMlApi ──────────────────────────────────────────────────────────────

describe('checkMlApi', () => {
  it('returns online with readyz body when ML API is healthy', async () => {
    globalThis.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok', checks: { api: true, supabase: true } }),
    });
    const result = await checkMlApi();
    expect(result.status).toBe('online');
    expect(result.detail).toBeDefined();
    expect(result.detail.checks.api).toBe(true);
  });

  it('returns offline on connection refused', async () => {
    globalThis.fetch.mockRejectedValueOnce(new Error('Connection refused'));
    const result = await checkMlApi();
    expect(result.status).toBe('offline');
  });
});

// ── checkAiProxy ────────────────────────────────────────────────────────────

describe('checkAiProxy', () => {
  it('returns online when Edge Function responds to OPTIONS', async () => {
    globalThis.fetch.mockResolvedValueOnce({ ok: true, status: 204 });
    const result = await checkAiProxy();
    expect(result.status).toBe('online');
  });

  it('returns degraded on 401', async () => {
    globalThis.fetch.mockResolvedValueOnce({ ok: false, status: 401 });
    const result = await checkAiProxy();
    expect(result.status).toBe('degraded');
  });
});

// ── checkDatabase ───────────────────────────────────────────────────────────

describe('checkDatabase', () => {
  it('returns online when PostgREST is reachable', async () => {
    globalThis.fetch.mockResolvedValueOnce({ ok: true, status: 200 });
    const result = await checkDatabase();
    expect(result.status).toBe('online');
  });

  it('returns offline on timeout', async () => {
    globalThis.fetch.mockRejectedValueOnce(new Error('Aborted'));
    const result = await checkDatabase();
    expect(result.status).toBe('offline');
  });
});

// ── runFullHealthCheck ──────────────────────────────────────────────────────

describe('runFullHealthCheck', () => {
  it('returns healthy when all services respond OK', async () => {
    globalThis.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    const report = await runFullHealthCheck();
    expect(report.status).toBe('healthy');
    expect(report.checks.supabase.status).toBe('online');
    expect(report.checks.mlApi.status).toBe('online');
    expect(report.checks.aiProxy.status).toBe('online');
    expect(report.checks.database.status).toBe('online');
    expect(report.timestamp).toBeDefined();
  });

  it('returns offline when any service is down', async () => {
    let callCount = 0;
    globalThis.fetch.mockImplementation(async () => {
      callCount++;
      if (callCount === 2) throw new Error('ML API down');
      return { ok: true, status: 200, json: async () => ({}) };
    });
    const report = await runFullHealthCheck();
    expect(report.status).toBe('offline');
    expect(report.checks.mlApi.status).toBe('offline');
  });

  it('includes latency measurements', async () => {
    globalThis.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    const report = await runFullHealthCheck();
    for (const check of Object.values(report.checks)) {
      expect(check.latency_ms).toBeGreaterThanOrEqual(0);
    }
  });
});
