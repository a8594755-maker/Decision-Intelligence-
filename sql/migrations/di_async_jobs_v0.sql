-- Async Run Execution Layer v0
-- Durable jobs + step observability + cancellation support

DO $$
BEGIN
  IF to_regclass('public.di_runs') IS NULL THEN
    RAISE EXCEPTION 'Missing dependency table public.di_runs. Run sql/migrations/di_runs_and_artifacts.sql first.';
  END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE public.di_runs
  ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.di_run_steps
  ADD COLUMN IF NOT EXISTS log_excerpt TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'di_runs'
      AND constraint_name = 'ck_di_runs_status'
  ) THEN
    ALTER TABLE public.di_runs DROP CONSTRAINT ck_di_runs_status;
  END IF;
END $$;

ALTER TABLE public.di_runs
  ADD CONSTRAINT ck_di_runs_status
  CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled'));

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'di_run_steps'
      AND constraint_name = 'ck_di_run_steps_status'
  ) THEN
    ALTER TABLE public.di_run_steps DROP CONSTRAINT ck_di_run_steps_status;
  END IF;
END $$;

ALTER TABLE public.di_run_steps
  ADD CONSTRAINT ck_di_run_steps_status
  CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'skipped', 'canceled'));

CREATE TABLE IF NOT EXISTS public.di_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id BIGINT NOT NULL REFERENCES public.di_runs(id) ON DELETE CASCADE,
  job_key TEXT NOT NULL,
  status TEXT NOT NULL,
  workflow TEXT NOT NULL,
  engine_flags JSONB NOT NULL DEFAULT '{}'::jsonb,
  request_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  progress_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
  last_heartbeat_at TIMESTAMPTZ,
  error_message TEXT,
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT uq_di_jobs_job_key UNIQUE (job_key),
  CONSTRAINT ck_di_jobs_status CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  CONSTRAINT ck_di_jobs_progress_pct CHECK (progress_pct >= 0 AND progress_pct <= 100)
);

CREATE INDEX IF NOT EXISTS idx_di_jobs_status_created_at
  ON public.di_jobs(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_di_jobs_created_at
  ON public.di_jobs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_di_jobs_run_id
  ON public.di_jobs(run_id);

ALTER TABLE public.di_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own di jobs" ON public.di_jobs;
CREATE POLICY "Users can view own di jobs"
  ON public.di_jobs FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.di_runs r
      WHERE r.id = di_jobs.run_id
        AND r.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can insert own di jobs" ON public.di_jobs;
CREATE POLICY "Users can insert own di jobs"
  ON public.di_jobs FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.di_runs r
      WHERE r.id = di_jobs.run_id
        AND r.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can update own di jobs" ON public.di_jobs;
CREATE POLICY "Users can update own di jobs"
  ON public.di_jobs FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM public.di_runs r
      WHERE r.id = di_jobs.run_id
        AND r.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.di_runs r
      WHERE r.id = di_jobs.run_id
        AND r.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can delete own di jobs" ON public.di_jobs;
CREATE POLICY "Users can delete own di jobs"
  ON public.di_jobs FOR DELETE
  USING (
    EXISTS (
      SELECT 1
      FROM public.di_runs r
      WHERE r.id = di_jobs.run_id
        AND r.user_id = auth.uid()
    )
  );

NOTIFY pgrst, 'reload schema';
