-- ============================================================
-- LLM Usage Tracking
-- 記錄每次 LLM 呼叫的 token 用量，用於成本控制和 per-tenant 計量
-- @product: di-core
-- ============================================================

CREATE TABLE IF NOT EXISTS public.llm_usage_events (
    id              BIGSERIAL PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- 呼叫來源
    source          TEXT NOT NULL,          -- 'gemini_api', 'deepseek_api', 'ai_proxy'
    workflow        TEXT,                   -- 'workflow_a', 'workflow_b', 'chat', 'mapping'
    prompt_id       TEXT,                   -- diJsonContracts.js 的 DI_PROMPT_IDS key

    -- 模型資訊
    model           TEXT,                   -- 'deepseek-chat', 'gemini-1.5-pro', etc.
    provider        TEXT,                   -- 'deepseek', 'gemini', 'openai', 'anthropic'

    -- Token 計量（可選，有則填）
    prompt_tokens   INTEGER,
    completion_tokens INTEGER,
    total_tokens    INTEGER,

    -- 成本估算（USD，可選）
    estimated_cost_usd NUMERIC(10, 6),

    -- 狀態
    status          TEXT NOT NULL DEFAULT 'success',  -- 'success', 'error', 'quota_exceeded'
    latency_ms      INTEGER,

    -- 彈性 metadata
    metadata        JSONB DEFAULT '{}'::jsonb
);

-- Index for per-user queries
CREATE INDEX IF NOT EXISTS idx_llm_usage_user_created
    ON public.llm_usage_events(user_id, created_at DESC);

-- Index for cost aggregation by day (timezone-aware cast is not immutable, use UTC explicitly)
CREATE INDEX IF NOT EXISTS idx_llm_usage_created_day
    ON public.llm_usage_events(( (created_at AT TIME ZONE 'UTC')::date ));

-- RLS
ALTER TABLE public.llm_usage_events ENABLE ROW LEVEL SECURITY;

-- Users can only read their own usage
CREATE POLICY "Users can read own llm usage"
    ON public.llm_usage_events
    FOR SELECT
    USING (auth.uid() = user_id);

-- Authenticated users can insert own usage
CREATE POLICY "Authenticated users can insert own llm usage"
    ON public.llm_usage_events
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- ── Views ────────────────────────────────────────────────────

-- Daily usage summary per user
CREATE OR REPLACE VIEW public.llm_usage_daily_summary AS
SELECT
    user_id,
    DATE_TRUNC('day', created_at)::DATE AS usage_date,
    provider,
    COUNT(*)                             AS call_count,
    SUM(total_tokens)                    AS total_tokens,
    SUM(estimated_cost_usd)              AS total_cost_usd
FROM public.llm_usage_events
WHERE status = 'success'
GROUP BY user_id, DATE_TRUNC('day', created_at), provider;

NOTIFY pgrst, 'reload schema';
