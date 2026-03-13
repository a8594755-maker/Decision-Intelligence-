-- ============================================================
-- AI Employee: core tables
-- @product: ai-employee
--
-- Sits on top of the DI core engine; does NOT replace it.
-- Artifacts are stored in di_artifacts; runs reference di_runs
-- when a DI workflow is invoked underneath.
-- ============================================================

-- ── Helpers ─────────────────────────────────────────────────

-- Auto-update updated_at on row change
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ── ai_employees ─────────────────────────────────────────────
-- One row per AI employee identity.
-- manager_user_id = the human who owns / reviews this employee.

CREATE TABLE IF NOT EXISTS public.ai_employees (
  id            uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  name          text        NOT NULL,
  role          text        NOT NULL DEFAULT 'supply_chain_reporting_employee'
                            CHECK (role IN (
                              'supply_chain_reporting_employee'
                              -- extend: 'inventory_analyst', 'procurement_assistant', 'risk_monitor'
                            )),
  status        text        NOT NULL DEFAULT 'idle'
                            CHECK (status IN ('idle', 'working', 'blocked', 'waiting_review')),
  manager_user_id uuid      REFERENCES auth.users(id) ON DELETE SET NULL,
  description   text,
  permissions   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_employees_manager
  ON public.ai_employees(manager_user_id);

CREATE TRIGGER trg_ai_employees_updated_at
  BEFORE UPDATE ON public.ai_employees
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.ai_employees ENABLE ROW LEVEL SECURITY;

-- Any authenticated user can read (org-level resource)
DROP POLICY IF EXISTS "Authenticated users can view ai_employees" ON public.ai_employees;
CREATE POLICY "Authenticated users can view ai_employees"
  ON public.ai_employees FOR SELECT
  USING (auth.role() = 'authenticated');

-- Only the manager can insert / update / delete
DROP POLICY IF EXISTS "Manager can manage ai_employees" ON public.ai_employees;
CREATE POLICY "Manager can manage ai_employees"
  ON public.ai_employees FOR ALL
  USING (auth.uid() = manager_user_id)
  WITH CHECK (auth.uid() = manager_user_id);


-- ── ai_employee_tasks ─────────────────────────────────────────
-- One row per task assigned to an AI employee.
--
-- State machine:
--   todo → in_progress → waiting_review → done
--   in_progress → blocked → todo          (unblock)
--   waiting_review → in_progress          (revision requested)
--   waiting_review → done                 (approved)
--
-- latest_run_id is a forward-ref to ai_employee_runs;
-- FK is added DEFERRABLE after runs table exists.

CREATE TABLE IF NOT EXISTS public.ai_employee_tasks (
  id                  uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id         uuid        NOT NULL REFERENCES public.ai_employees(id) ON DELETE CASCADE,
  title               text        NOT NULL,
  description         text,
  priority            text        NOT NULL DEFAULT 'medium'
                                  CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  status              text        NOT NULL DEFAULT 'todo'
                                  CHECK (status IN (
                                    'todo', 'in_progress', 'waiting_review', 'blocked', 'done'
                                  )),
  source_type         text        NOT NULL DEFAULT 'manual'
                                  CHECK (source_type IN ('manual', 'scheduled', 'question_to_task')),
  assigned_by_user_id uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  due_at              timestamptz,
  input_context       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  expected_output     jsonb,
  latest_run_id       uuid,       -- FK added below after ai_employee_runs is created
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_tasks_employee_status
  ON public.ai_employee_tasks(employee_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_tasks_assigned_by
  ON public.ai_employee_tasks(assigned_by_user_id);

CREATE TRIGGER trg_ai_tasks_updated_at
  BEFORE UPDATE ON public.ai_employee_tasks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.ai_employee_tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can view ai_employee_tasks" ON public.ai_employee_tasks;
CREATE POLICY "Authenticated users can view ai_employee_tasks"
  ON public.ai_employee_tasks FOR SELECT
  USING (auth.role() = 'authenticated');

-- Assign/update by manager (via employee's manager)
DROP POLICY IF EXISTS "Manager can manage ai_employee_tasks" ON public.ai_employee_tasks;
CREATE POLICY "Manager can manage ai_employee_tasks"
  ON public.ai_employee_tasks FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.ai_employees e
      WHERE e.id = employee_id AND e.manager_user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.ai_employees e
      WHERE e.id = employee_id AND e.manager_user_id = auth.uid()
    )
  );


-- ── ai_employee_runs ─────────────────────────────────────────
-- One row per execution attempt of a task.
-- Multiple runs can exist per task (retries, revisions).
--
-- artifact_refs: array of di_artifacts.id (uuid[])
--   → AI employee outputs are stored in di_artifacts, not here.
--
-- di_run_id: optional ref to di_runs bigint when a DI workflow
--   (forecast / plan / risk) was invoked underneath this run.

CREATE TABLE IF NOT EXISTS public.ai_employee_runs (
  id              uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  task_id         uuid        NOT NULL REFERENCES public.ai_employee_tasks(id) ON DELETE CASCADE,
  employee_id     uuid        NOT NULL REFERENCES public.ai_employees(id) ON DELETE CASCADE,
  status          text        NOT NULL DEFAULT 'running'
                              CHECK (status IN ('running', 'succeeded', 'failed', 'needs_review')),
  di_run_id       bigint,     -- nullable ref to di_runs.id (cross-product link, no FK to avoid hard coupling)
  artifact_refs   uuid[]      NOT NULL DEFAULT '{}',
  summary         text,
  error_message   text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz
);

CREATE INDEX IF NOT EXISTS idx_ai_runs_task
  ON public.ai_employee_runs(task_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_runs_employee
  ON public.ai_employee_runs(employee_id, started_at DESC);

ALTER TABLE public.ai_employee_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can view ai_employee_runs" ON public.ai_employee_runs;
CREATE POLICY "Authenticated users can view ai_employee_runs"
  ON public.ai_employee_runs FOR SELECT
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Manager can manage ai_employee_runs" ON public.ai_employee_runs;
CREATE POLICY "Manager can manage ai_employee_runs"
  ON public.ai_employee_runs FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.ai_employees e
      WHERE e.id = employee_id AND e.manager_user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.ai_employees e
      WHERE e.id = employee_id AND e.manager_user_id = auth.uid()
    )
  );


-- ── Forward FK: tasks.latest_run_id → runs.id ────────────────
-- Deferred so that task + run can be inserted in the same transaction.

ALTER TABLE public.ai_employee_tasks
  ADD CONSTRAINT fk_ai_task_latest_run
  FOREIGN KEY (latest_run_id)
  REFERENCES public.ai_employee_runs(id)
  ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;


-- ── ai_employee_reviews ──────────────────────────────────────
-- Manager approval / rejection / revision request per run.
-- reviewer_type = 'ai_reviewer' for automated pre-checks before
--   surfacing to human manager (Phase 2+).

CREATE TABLE IF NOT EXISTS public.ai_employee_reviews (
  id              uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  task_id         uuid        NOT NULL REFERENCES public.ai_employee_tasks(id) ON DELETE CASCADE,
  run_id          uuid        REFERENCES public.ai_employee_runs(id) ON DELETE SET NULL,
  reviewer_type   text        NOT NULL
                              CHECK (reviewer_type IN ('human_manager', 'ai_reviewer')),
  decision        text        NOT NULL
                              CHECK (decision IN ('approved', 'needs_revision', 'rejected')),
  comments        text,
  created_by      uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_reviews_task
  ON public.ai_employee_reviews(task_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_reviews_pending
  ON public.ai_employee_reviews(run_id)
  WHERE decision = 'needs_revision';

ALTER TABLE public.ai_employee_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can view ai_employee_reviews" ON public.ai_employee_reviews;
CREATE POLICY "Authenticated users can view ai_employee_reviews"
  ON public.ai_employee_reviews FOR SELECT
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Manager can create ai_employee_reviews" ON public.ai_employee_reviews;
CREATE POLICY "Manager can create ai_employee_reviews"
  ON public.ai_employee_reviews FOR INSERT
  WITH CHECK (auth.uid() = created_by);


-- ── ai_employee_worklogs ─────────────────────────────────────
-- Append-only structured log written by the AI employee.
-- content schema varies by log_type:
--   task_update     → { previous_status, new_status, note }
--   daily_summary   → { tasks_completed, tasks_blocked, highlights, next_priorities }
--   escalation      → { issue, severity, escalated_to_user_id }
--   retrospective   → { what_went_well, what_to_improve, datasets_used, artifacts_generated }

CREATE TABLE IF NOT EXISTS public.ai_employee_worklogs (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id uuid        NOT NULL REFERENCES public.ai_employees(id) ON DELETE CASCADE,
  task_id     uuid        REFERENCES public.ai_employee_tasks(id) ON DELETE SET NULL,
  run_id      uuid        REFERENCES public.ai_employee_runs(id) ON DELETE SET NULL,
  log_type    text        NOT NULL
              CHECK (log_type IN ('task_update', 'daily_summary', 'escalation', 'retrospective')),
  content     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_worklogs_employee_time
  ON public.ai_employee_worklogs(employee_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_worklogs_task
  ON public.ai_employee_worklogs(task_id)
  WHERE task_id IS NOT NULL;

ALTER TABLE public.ai_employee_worklogs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can view ai_employee_worklogs" ON public.ai_employee_worklogs;
CREATE POLICY "Authenticated users can view ai_employee_worklogs"
  ON public.ai_employee_worklogs FOR SELECT
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Service can insert ai_employee_worklogs" ON public.ai_employee_worklogs;
CREATE POLICY "Service can insert ai_employee_worklogs"
  ON public.ai_employee_worklogs FOR INSERT
  WITH CHECK (auth.role() = 'authenticated');


-- ── KPI view (no snapshot table for MVP) ─────────────────────
-- Computed on-the-fly from tasks + reviews.
-- Snapshot table added in Phase 3 when scheduling kicks in.

CREATE OR REPLACE VIEW public.ai_employee_kpis AS
SELECT
  e.id                                                          AS employee_id,
  e.name,
  COUNT(t.id) FILTER (WHERE t.status = 'done')                 AS tasks_completed,
  COUNT(t.id) FILTER (WHERE t.status != 'done')                AS tasks_open,
  COUNT(t.id) FILTER (WHERE t.due_at < now() AND t.status != 'done') AS tasks_overdue,
  ROUND(
    100.0 * COUNT(t.id) FILTER (WHERE t.status = 'done' AND (t.due_at IS NULL OR t.updated_at <= t.due_at))
    / NULLIF(COUNT(t.id) FILTER (WHERE t.status = 'done'), 0),
    1
  )                                                             AS on_time_rate_pct,
  COUNT(r.id) FILTER (WHERE r.decision = 'approved')           AS reviews_approved,
  COUNT(r.id) FILTER (WHERE r.decision = 'needs_revision')     AS reviews_revised,
  ROUND(
    100.0 * COUNT(r.id) FILTER (WHERE r.decision = 'approved')
    / NULLIF(COUNT(r.id), 0),
    1
  )                                                             AS review_pass_rate_pct
FROM public.ai_employees e
LEFT JOIN public.ai_employee_tasks t ON t.employee_id = e.id
LEFT JOIN public.ai_employee_reviews r ON r.task_id = t.id AND r.reviewer_type = 'human_manager'
GROUP BY e.id, e.name;


NOTIFY pgrst, 'reload schema';
