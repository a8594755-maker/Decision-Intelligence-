-- Pause/resume states v0
-- Adds waiting_user to di_runs and blocked to di_run_steps.
-- Safe to run multiple times (idempotent DROP + re-ADD pattern).
-- Must be applied BEFORE any code that writes these new statuses.

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
  CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled', 'waiting_user'));

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
  CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'skipped', 'canceled', 'blocked'));

-- di_jobs.status is not changed: the async job continues running while
-- the underlying run is waiting_user. The job worker handles resume.

NOTIFY pgrst, 'reload schema';
