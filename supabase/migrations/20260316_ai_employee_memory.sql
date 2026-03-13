-- ============================================================
-- AI Employee: Task Memory
-- @product: ai-employee
--
-- Structured outcome memory for cross-session recall.
-- After each task completes (or fails), the executor writes a
-- memory entry capturing what worked, what failed, and manager
-- feedback. Before executing a new task, the agent loop recalls
-- relevant memories by dataset fingerprint or workflow type.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.ai_employee_task_memory (
  id                    uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id           uuid        NOT NULL REFERENCES public.ai_employees(id) ON DELETE CASCADE,
  task_id               uuid        REFERENCES public.ai_employee_tasks(id) ON DELETE SET NULL,
  run_id                uuid        REFERENCES public.ai_employee_runs(id) ON DELETE SET NULL,

  -- Recall keys
  dataset_fingerprint   text,                 -- from di_dataset_profiles.fingerprint
  dataset_profile_id    text,                 -- original profile ID
  workflow_type         text        NOT NULL, -- 'forecast' | 'plan' | 'risk' | 'synthesize'
  template_id           text,                 -- agent loop template used (null for legacy single-step)

  -- Outcome
  success               boolean     NOT NULL,
  outcome_summary       text,                 -- human-readable summary
  outcome_kpis          jsonb       DEFAULT '{}'::jsonb,
                                              -- e.g. { mape: 12.3, service_level: 0.95, items_planned: 42 }
  error_message         text,                 -- if failed
  retry_count           smallint    DEFAULT 0,

  -- Execution metadata
  input_params          jsonb       DEFAULT '{}'::jsonb,
                                              -- key params used: { riskMode, horizonPeriods, ... }
  artifacts_generated   smallint    DEFAULT 0,
  execution_time_ms     integer,              -- wall-clock duration

  -- Manager feedback (populated after review)
  manager_decision      text,                 -- 'approved' | 'needs_revision' | 'rejected'
  manager_feedback      text,                 -- from review comments

  created_at            timestamptz NOT NULL DEFAULT now()
);

-- Fast recall by dataset fingerprint
CREATE INDEX IF NOT EXISTS idx_ai_memory_fingerprint
  ON public.ai_employee_task_memory(employee_id, dataset_fingerprint, created_at DESC)
  WHERE dataset_fingerprint IS NOT NULL;

-- Fast recall by workflow type
CREATE INDEX IF NOT EXISTS idx_ai_memory_workflow
  ON public.ai_employee_task_memory(employee_id, workflow_type, created_at DESC);

-- RLS
ALTER TABLE public.ai_employee_task_memory ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can view ai_employee_task_memory" ON public.ai_employee_task_memory;
CREATE POLICY "Authenticated users can view ai_employee_task_memory"
  ON public.ai_employee_task_memory FOR SELECT
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Service can insert ai_employee_task_memory" ON public.ai_employee_task_memory;
CREATE POLICY "Service can insert ai_employee_task_memory"
  ON public.ai_employee_task_memory FOR INSERT
  WITH CHECK (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Service can update ai_employee_task_memory" ON public.ai_employee_task_memory;
CREATE POLICY "Service can update ai_employee_task_memory"
  ON public.ai_employee_task_memory FOR UPDATE
  USING (auth.role() = 'authenticated');

NOTIFY pgrst, 'reload schema';
