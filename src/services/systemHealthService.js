/**
 * systemHealthService.js — Real dependency health checks.
 *
 * Checks: Supabase (DB + auth), ML API (readyz), AI Proxy (Edge Function).
 * Not a mock or stub — each check hits the real service endpoint.
 *
 * Usage:
 *   import { runFullHealthCheck } from './systemHealthService.js';
 *   const report = await runFullHealthCheck();
 *   // { status: 'healthy'|'degraded', checks: { supabase, mlApi, aiProxy }, timestamp }
 */

const SUPABASE_URL = typeof import.meta !== 'undefined'
  ? (import.meta.env?.VITE_SUPABASE_URL || '')
  : (process.env?.VITE_SUPABASE_URL || '');

const SUPABASE_KEY = typeof import.meta !== 'undefined'
  ? (import.meta.env?.VITE_SUPABASE_ANON_KEY || '')
  : (process.env?.VITE_SUPABASE_ANON_KEY || '');

const ML_API_URL = typeof import.meta !== 'undefined'
  ? (import.meta.env?.VITE_ML_API_URL || '')
  : (process.env?.VITE_ML_API_URL || '');

const TIMEOUT_MS = 8000;

// ── Individual checks ────────────────────────────────────────────────────────

async function fetchWithTimeout(url, options = {}, timeout = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Check Supabase (DB + Auth layer) via GoTrue health endpoint.
 * @returns {Promise<{status: string, latency_ms: number, detail?: string}>}
 */
export async function checkSupabase() {
  if (!SUPABASE_URL) return { status: 'not_configured', latency_ms: 0 };
  const start = Date.now();
  try {
    const url = `${SUPABASE_URL.replace(/\/+$/, '')}/auth/v1/health`;
    const res = await fetchWithTimeout(url, { headers: { apikey: SUPABASE_KEY } });
    const latency = Date.now() - start;
    if (res.ok) return { status: 'online', latency_ms: latency };
    return { status: 'degraded', latency_ms: latency, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { status: 'offline', latency_ms: Date.now() - start, detail: err?.message };
  }
}

/**
 * Check ML API via /readyz (readiness probe with dependency checks).
 * @returns {Promise<{status: string, latency_ms: number, detail?: object}>}
 */
export async function checkMlApi() {
  if (!ML_API_URL) return { status: 'not_configured', latency_ms: 0 };
  const start = Date.now();
  try {
    const url = `${ML_API_URL.replace(/\/+$/, '')}/readyz`;
    const res = await fetchWithTimeout(url);
    const latency = Date.now() - start;
    if (res.ok) {
      try {
        const body = await res.json();
        return { status: 'online', latency_ms: latency, detail: body };
      } catch {
        return { status: 'online', latency_ms: latency };
      }
    }
    return { status: 'degraded', latency_ms: latency, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { status: 'offline', latency_ms: Date.now() - start, detail: err?.message };
  }
}

/**
 * Check AI Proxy (Supabase Edge Function for LLM routing).
 * @returns {Promise<{status: string, latency_ms: number, detail?: string}>}
 */
export async function checkAiProxy() {
  if (!SUPABASE_URL) return { status: 'not_configured', latency_ms: 0 };
  const start = Date.now();
  try {
    const url = `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/ai-proxy`;
    const res = await fetchWithTimeout(url, { method: 'OPTIONS' });
    const latency = Date.now() - start;
    if (res.ok) return { status: 'online', latency_ms: latency };
    return { status: 'degraded', latency_ms: latency, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { status: 'offline', latency_ms: Date.now() - start, detail: err?.message };
  }
}

/**
 * Check Supabase DB connectivity by querying the REST API.
 * This validates that PostgREST is up and the DB is reachable.
 * @returns {Promise<{status: string, latency_ms: number, detail?: string}>}
 */
export async function checkDatabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return { status: 'not_configured', latency_ms: 0 };
  const start = Date.now();
  try {
    const url = `${SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/`;
    const res = await fetchWithTimeout(url, {
      method: 'HEAD',
      headers: { apikey: SUPABASE_KEY },
    });
    const latency = Date.now() - start;
    if (res.ok) return { status: 'online', latency_ms: latency };
    return { status: 'degraded', latency_ms: latency, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { status: 'offline', latency_ms: Date.now() - start, detail: err?.message };
  }
}

// ── Full Health Check ────────────────────────────────────────────────────────

/**
 * Run all health checks in parallel and return a consolidated report.
 *
 * @returns {Promise<{
 *   status: 'healthy'|'degraded'|'offline',
 *   checks: { supabase, mlApi, aiProxy, database },
 *   timestamp: string
 * }>}
 */
export async function runFullHealthCheck() {
  const [supabase, mlApi, aiProxy, database] = await Promise.allSettled([
    checkSupabase(),
    checkMlApi(),
    checkAiProxy(),
    checkDatabase(),
  ]);

  const checks = {
    supabase: supabase.status === 'fulfilled' ? supabase.value : { status: 'error' },
    mlApi: mlApi.status === 'fulfilled' ? mlApi.value : { status: 'error' },
    aiProxy: aiProxy.status === 'fulfilled' ? aiProxy.value : { status: 'error' },
    database: database.status === 'fulfilled' ? database.value : { status: 'error' },
  };

  const statuses = Object.values(checks).map(c => c.status);
  const allOnline = statuses.every(s => s === 'online' || s === 'not_configured');
  const anyOffline = statuses.some(s => s === 'offline' || s === 'error');

  return {
    status: allOnline ? 'healthy' : anyOffline ? 'offline' : 'degraded',
    checks,
    timestamp: new Date().toISOString(),
  };
}
