-- ============================================================
-- di_artifacts: general-purpose artifact storage
-- Used by useDecisionOverview to fetch data_quality_report etc.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.di_artifacts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  artifact_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_di_artifacts_user_type
  ON public.di_artifacts(user_id, artifact_type, created_at DESC);

ALTER TABLE public.di_artifacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own artifacts" ON public.di_artifacts;
CREATE POLICY "Users can view own artifacts"
  ON public.di_artifacts FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own artifacts" ON public.di_artifacts;
CREATE POLICY "Users can insert own artifacts"
  ON public.di_artifacts FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own artifacts" ON public.di_artifacts;
CREATE POLICY "Users can update own artifacts"
  ON public.di_artifacts FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own artifacts" ON public.di_artifacts;
CREATE POLICY "Users can delete own artifacts"
  ON public.di_artifacts FOR DELETE
  USING (auth.uid() = user_id);

NOTIFY pgrst, 'reload schema';
