-- Gemini provider asset persistence
-- Stores remote file handles and cached-content handles for reuse across runs.

DO $$
DECLARE
  user_files_id_type TEXT;
BEGIN
  SELECT data_type INTO user_files_id_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'user_files'
    AND column_name = 'id';

  IF user_files_id_type IS NULL THEN
    RAISE EXCEPTION 'public.user_files.id not found. Please run base schema migration first.';
  END IF;

  IF user_files_id_type = 'uuid' THEN
    EXECUTE $sql$
      CREATE TABLE IF NOT EXISTS public.di_llm_provider_files (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        source_file_id UUID NOT NULL REFERENCES public.user_files(id) ON DELETE CASCADE,
        source_fingerprint TEXT NOT NULL,
        provider_file_name TEXT,
        provider_file_uri TEXT,
        mime_type TEXT,
        size_bytes BIGINT,
        display_name TEXT,
        model_hint TEXT,
        expire_at TIMESTAMPTZ,
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    $sql$;
  ELSIF user_files_id_type = 'bigint' THEN
    EXECUTE $sql$
      CREATE TABLE IF NOT EXISTS public.di_llm_provider_files (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        source_file_id BIGINT NOT NULL REFERENCES public.user_files(id) ON DELETE CASCADE,
        source_fingerprint TEXT NOT NULL,
        provider_file_name TEXT,
        provider_file_uri TEXT,
        mime_type TEXT,
        size_bytes BIGINT,
        display_name TEXT,
        model_hint TEXT,
        expire_at TIMESTAMPTZ,
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    $sql$;
  ELSE
    RAISE EXCEPTION 'Unsupported public.user_files.id type: %', user_files_id_type;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.di_llm_provider_caches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model_name TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  provider_cache_name TEXT NOT NULL,
  expire_at TIMESTAMPTZ,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_di_llm_provider_files_unique
  ON public.di_llm_provider_files(user_id, provider, source_file_id, source_fingerprint);

CREATE INDEX IF NOT EXISTS idx_di_llm_provider_files_user_provider_updated
  ON public.di_llm_provider_files(user_id, provider, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_di_llm_provider_files_provider_name
  ON public.di_llm_provider_files(provider, provider_file_name);

CREATE UNIQUE INDEX IF NOT EXISTS idx_di_llm_provider_caches_unique
  ON public.di_llm_provider_caches(user_id, provider, model_name, cache_key);

CREATE INDEX IF NOT EXISTS idx_di_llm_provider_caches_user_provider_updated
  ON public.di_llm_provider_caches(user_id, provider, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_di_llm_provider_caches_expire
  ON public.di_llm_provider_caches(expire_at);

ALTER TABLE public.di_llm_provider_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.di_llm_provider_caches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own LLM provider files" ON public.di_llm_provider_files;
CREATE POLICY "Users can view own LLM provider files"
  ON public.di_llm_provider_files FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own LLM provider files" ON public.di_llm_provider_files;
CREATE POLICY "Users can insert own LLM provider files"
  ON public.di_llm_provider_files FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own LLM provider files" ON public.di_llm_provider_files;
CREATE POLICY "Users can update own LLM provider files"
  ON public.di_llm_provider_files FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own LLM provider files" ON public.di_llm_provider_files;
CREATE POLICY "Users can delete own LLM provider files"
  ON public.di_llm_provider_files FOR DELETE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can view own LLM provider caches" ON public.di_llm_provider_caches;
CREATE POLICY "Users can view own LLM provider caches"
  ON public.di_llm_provider_caches FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own LLM provider caches" ON public.di_llm_provider_caches;
CREATE POLICY "Users can insert own LLM provider caches"
  ON public.di_llm_provider_caches FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own LLM provider caches" ON public.di_llm_provider_caches;
CREATE POLICY "Users can update own LLM provider caches"
  ON public.di_llm_provider_caches FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own LLM provider caches" ON public.di_llm_provider_caches;
CREATE POLICY "Users can delete own LLM provider caches"
  ON public.di_llm_provider_caches FOR DELETE
  USING (auth.uid() = user_id);

NOTIFY pgrst, 'reload schema';
