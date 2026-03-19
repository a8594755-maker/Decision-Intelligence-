import { useState, useEffect, useCallback } from 'react';
import { isSupabaseConfigured } from '../services/supabaseClient';

const ML_API_BASE = import.meta.env.VITE_ML_API_URL || '';
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
const HEALTH_RETRY_DELAY_MS = 400;

const wait = (ms) => new Promise(resolve => window.setTimeout(resolve, ms));

async function runHealthCheckWithRetry(checkFn, { retries = 1 } = {}) {
  let lastStatus = 'offline';
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      lastStatus = await checkFn();
      if (lastStatus === 'online') return lastStatus;
    } catch {
      lastStatus = 'offline';
    }
    if (attempt < retries) {
      await wait(HEALTH_RETRY_DELAY_MS);
    }
  }
  return lastStatus;
}

/**
 * Check Supabase connectivity via GoTrue health endpoint.
 */
async function checkSupabase() {
  if (!isSupabaseConfigured) return 'offline';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const url = `${SUPABASE_URL.replace(/\/+$/, '')}/auth/v1/health`;
    const res = await fetch(url, {
      headers: { apikey: SUPABASE_ANON_KEY },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res.ok ? 'online' : 'offline';
  } catch {
    return 'offline';
  }
}

/**
 * Check ML API via GET /health endpoint.
 */
async function checkMlApi() {
  if (!ML_API_BASE) return 'offline';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${ML_API_BASE.replace(/\/+$/, '')}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res.ok ? 'online' : 'offline';
  } catch {
    return 'offline';
  }
}

/**
 * Check AI Proxy reachability via Supabase Edge Function.
 * Use OPTIONS to avoid auth noise while still proving endpoint reachability.
 */
async function checkAiProxy() {
  if (!SUPABASE_URL || !isSupabaseConfigured) return 'offline';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    const url = `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/ai-proxy`;
    const res = await fetch(url, {
      method: 'OPTIONS',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res.ok ? 'online' : 'offline';
  } catch {
    return 'offline';
  }
}

/**
 * Hook that checks the health of three system services on mount.
 * Returns { health: { supabase, mlApi, aiProxy }, refresh }.
 * Each value is 'checking' | 'online' | 'offline'.
 */
export function useSystemHealth() {
  const [health, setHealth] = useState({
    supabase: 'checking',
    mlApi: 'checking',
    aiProxy: 'checking',
  });

  const refresh = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setHealth({ supabase: 'checking', mlApi: 'checking', aiProxy: 'checking' });
    }
    const [sb, ml, ai] = await Promise.allSettled([
      runHealthCheckWithRetry(checkSupabase),
      runHealthCheckWithRetry(checkMlApi),
      runHealthCheckWithRetry(checkAiProxy),
    ]);
    setHealth({
      supabase: sb.status === 'fulfilled' ? sb.value : 'offline',
      mlApi: ml.status === 'fulfilled' ? ml.value : 'offline',
      aiProxy: ai.status === 'fulfilled' ? ai.value : 'offline',
    });
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional mount-time health probe
    refresh({ silent: true });

    const refreshSilently = () => {
      refresh({ silent: true });
    };

    window.addEventListener('focus', refreshSilently);
    window.addEventListener('online', refreshSilently);

    const intervalId = window.setInterval(() => {
      refresh({ silent: true });
    }, 30000);

    return () => {
      window.removeEventListener('focus', refreshSilently);
      window.removeEventListener('online', refreshSilently);
      window.clearInterval(intervalId);
    };
  }, [refresh]);

  return { health, refresh };
}
