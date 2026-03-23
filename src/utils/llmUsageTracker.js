/**
 * llmUsageTracker.js
 *
 * Per-tenant LLM usage tracking.
 * Fire-and-forget: 所有錯誤靜默處理，不阻塞主流程。
 *
 * Usage:
 *   import { trackLlmUsage } from '../utils/llmUsageTracker';
 *   await callLlm(...);
 *   trackLlmUsage({ userId, source: 'gemini_api', model: 'gemini-1.5-pro', ... });
 */

import { supabase } from '../services/supabaseClient';

// Pricing（USD per 1K tokens）— updated 2026-03-23 from official sources
const COST_PER_1K_TOKENS = {
  // OpenAI
  'gpt-5.4':                { input: 0.0025,   output: 0.015   },
  'gpt-5.4-thinking':       { input: 0.0025,   output: 0.015   },
  'gpt-5.4-mini':           { input: 0.00075,  output: 0.0045  },
  'gpt-4.1-mini':           { input: 0.0004,   output: 0.0016  },
  'gpt-4.1-nano':           { input: 0.0001,   output: 0.0004  },
  // Anthropic
  'claude-opus-4-6':        { input: 0.005,    output: 0.025   },
  'claude-sonnet-4-6':      { input: 0.003,    output: 0.015   },
  'claude-haiku-4-5-20251001': { input: 0.001, output: 0.005   },
  // Gemini (≤200K pricing; >200K is 2× input, 1.5× output)
  'gemini-3.1-pro-preview': { input: 0.002,    output: 0.012   },
  'gemini-2.5-flash':       { input: 0.0003,   output: 0.0025  },
  'gemini-2.5-flash-lite':  { input: 0.0001,   output: 0.0004  },
  // DeepSeek (cache-miss pricing; cache-hit input is ~10× cheaper)
  'deepseek-chat':          { input: 0.00028,  output: 0.00042 },
  'deepseek-reasoner':      { input: 0.00028,  output: 0.00042 },
  // Kimi / Moonshot (USD pricing from OpenRouter; cache-hit ~75% discount)
  'kimi-k2.5':              { input: 0.00045,  output: 0.0022  },
  'kimi-k2-0905-preview':   { input: 0.00045,  output: 0.0022  },
  'kimi-k2-turbo-preview':  { input: 0.00045,  output: 0.0022  },
  'default':                { input: 0.001,    output: 0.002   },
};

/**
 * 估算 LLM 成本（USD）
 */
function estimateCost(model, promptTokens, completionTokens) {
  const pricing = COST_PER_1K_TOKENS[model] || COST_PER_1K_TOKENS['default'];
  const inputCost = ((promptTokens || 0) / 1000) * pricing.input;
  const outputCost = ((completionTokens || 0) / 1000) * pricing.output;
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
}

/**
 * 取得當前登入用戶的 ID（快取版，不阻塞）
 */
let _cachedUserId = null;
async function getCurrentUserId() {
  if (_cachedUserId) return _cachedUserId;
  try {
    const { data } = await supabase.auth.getSession();
    _cachedUserId = data?.session?.user?.id || null;
    return _cachedUserId;
  } catch {
    return null;
  }
}

// 登出時清除快取
try {
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') _cachedUserId = null;
    if (event === 'SIGNED_IN') _cachedUserId = null; // 重新取得
  });
} catch {
  // supabase 未設定時靜默跳過
}

/**
 * 記錄一次 LLM 呼叫（fire-and-forget）
 *
 * @param {object} opts
 * @param {string} [opts.userId]        - Supabase auth user ID（不傳則自動取得）
 * @param {string} opts.source          - 'gemini_api' | 'deepseek_api' | 'ai_proxy'
 * @param {string} [opts.workflow]      - 'workflow_a' | 'workflow_b' | 'chat' | 'mapping'
 * @param {string} [opts.promptId]      - DI_PROMPT_IDS key
 * @param {string} [opts.model]         - model name
 * @param {string} [opts.provider]      - 'deepseek' | 'gemini'
 * @param {number} [opts.promptTokens]
 * @param {number} [opts.completionTokens]
 * @param {number} [opts.totalTokens]
 * @param {string} [opts.status]        - 'success' | 'error' | 'quota_exceeded'
 * @param {number} [opts.latencyMs]
 * @param {object} [opts.metadata]
 */
export function trackLlmUsage({
  userId = null,
  source,
  workflow = null,
  promptId = null,
  model = null,
  provider = null,
  promptTokens = null,
  completionTokens = null,
  totalTokens = null,
  status = 'success',
  latencyMs = null,
  metadata = {},
}) {
  if (!source) return;

  const doInsert = async (uid) => {
    if (!uid) return;

    const estimatedCostUsd =
      model && promptTokens != null && completionTokens != null
        ? estimateCost(model, promptTokens, completionTokens)
        : null;

    const record = {
      user_id: uid,
      source,
      workflow,
      prompt_id: promptId,
      model,
      provider:
        provider ||
        (model?.includes('gemini')
          ? 'gemini'
          : model?.includes('deepseek')
            ? 'deepseek'
            : model?.includes('kimi') || model?.includes('moonshot')
              ? 'kimi'
              : null),
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens:
        totalTokens ??
        (promptTokens != null && completionTokens != null
          ? promptTokens + completionTokens
          : null),
      estimated_cost_usd: estimatedCostUsd,
      status,
      latency_ms: latencyMs,
      metadata,
    };

    const { error } = await supabase.from('llm_usage_events').insert(record);
    if (error && import.meta.env.DEV) {
      console.warn('[llmUsageTracker] insert failed:', error.message);
    }
  };

  // Fire-and-forget
  if (userId) {
    doInsert(userId).catch(() => {});
  } else {
    getCurrentUserId()
      .then((uid) => doInsert(uid))
      .catch(() => {});
  }
}

/**
 * 查詢當前用戶今日的 LLM 用量摘要
 *
 * @param {string} userId
 * @returns {Promise<{call_count: number, total_tokens: number, total_cost_usd: number}>}
 */
export async function fetchTodayUsage(userId) {
  if (!userId) return { call_count: 0, total_tokens: 0, total_cost_usd: 0 };

  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('llm_usage_daily_summary')
    .select('call_count, total_tokens, total_cost_usd')
    .eq('user_id', userId)
    .eq('usage_date', today);

  if (error || !data?.length) {
    return { call_count: 0, total_tokens: 0, total_cost_usd: 0 };
  }

  return data.reduce(
    (acc, row) => ({
      call_count: acc.call_count + (row.call_count || 0),
      total_tokens: acc.total_tokens + (row.total_tokens || 0),
      total_cost_usd: acc.total_cost_usd + (row.total_cost_usd || 0),
    }),
    { call_count: 0, total_tokens: 0, total_cost_usd: 0 }
  );
}
