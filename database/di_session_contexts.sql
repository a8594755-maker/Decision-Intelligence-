-- ============================================================
-- di_session_contexts: cross-device session state sync
-- ============================================================

CREATE TABLE IF NOT EXISTS public.di_session_contexts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  conversation_id text NOT NULL,
  context_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  version text NOT NULL DEFAULT 'v1',
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT di_session_contexts_user_conv_unique
    UNIQUE (user_id, conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_di_session_contexts_user_id
  ON public.di_session_contexts(user_id);
CREATE INDEX IF NOT EXISTS idx_di_session_contexts_updated_at
  ON public.di_session_contexts(updated_at DESC);

ALTER TABLE public.di_session_contexts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own session contexts" ON public.di_session_contexts;
CREATE POLICY "Users can view their own session contexts"
  ON public.di_session_contexts FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own session contexts" ON public.di_session_contexts;
CREATE POLICY "Users can insert their own session contexts"
  ON public.di_session_contexts FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own session contexts" ON public.di_session_contexts;
CREATE POLICY "Users can update their own session contexts"
  ON public.di_session_contexts FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own session contexts" ON public.di_session_contexts;
CREATE POLICY "Users can delete their own session contexts"
  ON public.di_session_contexts FOR DELETE
  USING (auth.uid() = user_id);

COMMENT ON TABLE public.di_session_contexts IS
  'Cross-device session context sync. Mirrors localStorage session state to Supabase for device portability.';
COMMENT ON COLUMN public.di_session_contexts.context_data IS
  'Full session context JSON (dataset, forecast, plan, overrides, intent_history, etc.)';
