-- ============================================================
-- AI Employee v2: Extended task states + optimistic concurrency
-- @product: ai-employee
--
-- Non-destructive: existing rows with old states remain valid.
-- Adds new task states, step states, version column, plan snapshot.
-- ============================================================

-- ── ai_employee_tasks: widen status CHECK to include v2 states ──
ALTER TABLE public.ai_employee_tasks
  DROP CONSTRAINT IF EXISTS ai_employee_tasks_status_check;

ALTER TABLE public.ai_employee_tasks
  ADD CONSTRAINT ai_employee_tasks_status_check
  CHECK (status IN (
    -- v1 states (backward compatible)
    'todo', 'in_progress', 'waiting_review', 'blocked', 'done',
    -- v2 states
    'draft_plan', 'waiting_approval', 'queued', 'review_hold', 'failed', 'cancelled'
  ));

-- ── Optimistic concurrency: version column ──
ALTER TABLE public.ai_employee_tasks
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN public.ai_employee_tasks.version
  IS 'Optimistic concurrency version. Incremented on every state change.';

-- ── Plan snapshot: stores the approved plan for audit ──
ALTER TABLE public.ai_employee_tasks
  ADD COLUMN IF NOT EXISTS plan_snapshot jsonb DEFAULT NULL;

COMMENT ON COLUMN public.ai_employee_tasks.plan_snapshot
  IS 'Frozen copy of the task plan at approval time. Contains steps[], llm_config, input summary.';

-- ── ai_employee_runs: widen status to include retrying + skipped ──
ALTER TABLE public.ai_employee_runs
  DROP CONSTRAINT IF EXISTS ai_employee_runs_status_check;

ALTER TABLE public.ai_employee_runs
  ADD CONSTRAINT ai_employee_runs_status_check
  CHECK (status IN (
    -- v1 states
    'running', 'succeeded', 'failed', 'needs_review',
    -- v2 states
    'pending', 'retrying', 'skipped'
  ));

-- ── ai_employee_runs: retry tracking ──
ALTER TABLE public.ai_employee_runs
  ADD COLUMN IF NOT EXISTS retry_count smallint NOT NULL DEFAULT 0;

ALTER TABLE public.ai_employee_runs
  ADD COLUMN IF NOT EXISTS max_retries smallint NOT NULL DEFAULT 3;

COMMENT ON COLUMN public.ai_employee_runs.retry_count IS 'Number of retries attempted for this step.';
COMMENT ON COLUMN public.ai_employee_runs.max_retries IS 'Maximum retries before marking step as failed.';

-- ── Index for finding next pending step quickly ──
CREATE INDEX IF NOT EXISTS idx_ai_runs_pending_steps
  ON public.ai_employee_runs(task_id, step_index ASC)
  WHERE status = 'pending';

NOTIFY pgrst, 'reload schema';
