/**
 * useLlmUsage.js
 *
 * Custom hook for fetching LLM API usage data from Supabase.
 * Queries llm_usage_events, llm_usage_daily_summary, and provider billing APIs.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { supabase } from '../services/infra/supabaseClient';
import { fetchTodayUsage } from '../utils/llmUsageTracker';
import { invokeAiProxy } from '../services/ai-infra/aiProxyService';
import { useAuth } from '../contexts/AuthContext';

/**
 * @param {number} [initialDateRange=7] — lookback days for trend chart (7 or 30)
 */
export default function useLlmUsage(initialDateRange = 7) {
  const { user } = useAuth();
  const userId = user?.id;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [todayKpis, setTodayKpis] = useState({ call_count: 0, total_tokens: 0, total_cost_usd: 0 });
  const [dailyTrend, setDailyTrend] = useState([]);
  const [recentCalls, setRecentCalls] = useState([]);
  const [dateRange, setDateRange] = useState(initialDateRange);

  // Provider balances: { provider: { data, loading, error } }
  const [providerBilling, setProviderBilling] = useState({
    deepseek: { data: null, loading: false, error: null },
    anthropic: { data: null, loading: false, error: null },
    openai: { data: null, loading: false, error: null },
    kimi: { data: null, loading: false, error: null },
  });

  // ── Usage data (from local DB) ──

  const fetchAll = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);

    try {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - dateRange);
      const startStr = startDate.toISOString().slice(0, 10);

      const [kpis, trendRes, recentRes] = await Promise.all([
        fetchTodayUsage(userId),
        supabase
          .from('llm_usage_daily_summary')
          .select('usage_date, provider, call_count, total_tokens, total_cost_usd')
          .eq('user_id', userId)
          .gte('usage_date', startStr)
          .order('usage_date', { ascending: true }),
        supabase
          .from('llm_usage_events')
          .select('id, created_at, model, provider, source, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd, latency_ms, status')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(50),
      ]);

      setTodayKpis(kpis);
      setDailyTrend(trendRes.error ? [] : trendRes.data || []);
      setRecentCalls(recentRes.error ? [] : recentRes.data || []);

      if (trendRes.error) console.warn('[useLlmUsage] trend query failed:', trendRes.error.message);
      if (recentRes.error) console.warn('[useLlmUsage] recent query failed:', recentRes.error.message);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [userId, dateRange]);

  // ── Provider billing (from external APIs via Edge Function) ──

  const fetchProviderBilling = useCallback(async () => {
    const setBillingState = (provider, state) =>
      setProviderBilling((prev) => ({ ...prev, [provider]: { ...prev[provider], ...state } }));

    // DeepSeek — direct call (has local API key)
    const deepseekKey = import.meta.env.VITE_DEEPSEEK_API_KEY;
    if (deepseekKey) {
      setBillingState('deepseek', { loading: true });
      try {
        const res = await fetch('https://api.deepseek.com/user/balance', {
          headers: { Authorization: `Bearer ${deepseekKey}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const info = json.balance_infos?.[0];
        setBillingState('deepseek', {
          data: { balance_usd: info ? parseFloat(info.total_balance) : null },
          loading: false, error: null,
        });
      } catch {
        setBillingState('deepseek', { data: null, loading: false, error: 'Failed to fetch' });
      }
    }

    // Anthropic — via Edge Function (admin key in secrets)
    setBillingState('anthropic', { loading: true });
    try {
      const result = await invokeAiProxy('anthropic_billing', {}, { timeoutMs: 15_000 });
      setBillingState('anthropic', { data: result, loading: false, error: null });
    } catch {
      setBillingState('anthropic', { data: null, loading: false, error: 'Failed to fetch' });
    }

    // OpenAI — via Edge Function (key in secrets)
    setBillingState('openai', { loading: true });
    try {
      const result = await invokeAiProxy('openai_billing', {}, { timeoutMs: 15_000 });
      setBillingState('openai', { data: result, loading: false, error: null });
    } catch {
      setBillingState('openai', { data: null, loading: false, error: 'Failed to fetch' });
    }

    // Kimi (Moonshot) — via Edge Function (key in secrets)
    setBillingState('kimi', { loading: true });
    try {
      const result = await invokeAiProxy('kimi_billing', {}, { timeoutMs: 15_000 });
      setBillingState('kimi', { data: result, loading: false, error: null });
    } catch {
      setBillingState('kimi', { data: null, loading: false, error: 'Failed to fetch' });
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    fetchProviderBilling();
  }, [fetchProviderBilling]);

  // Client-side aggregation: provider breakdown from dailyTrend
  const providerBreakdown = useMemo(() => {
    const map = {};
    for (const row of dailyTrend) {
      const p = row.provider || 'unknown';
      if (!map[p]) map[p] = { provider: p, call_count: 0, total_tokens: 0, total_cost_usd: 0 };
      map[p].call_count += row.call_count || 0;
      map[p].total_tokens += row.total_tokens || 0;
      map[p].total_cost_usd += row.total_cost_usd || 0;
    }
    return Object.values(map).sort((a, b) => b.total_cost_usd - a.total_cost_usd);
  }, [dailyTrend]);

  const refresh = useCallback(() => {
    fetchAll();
    fetchProviderBilling();
  }, [fetchAll, fetchProviderBilling]);

  return {
    loading,
    error,
    todayKpis,
    dailyTrend,
    providerBreakdown,
    recentCalls,
    providerBilling,
    dateRange,
    setDateRange,
    refresh,
  };
}
