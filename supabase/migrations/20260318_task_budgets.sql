-- ============================================================
-- AI Employee: Task Budgets
-- @product: ai-employee
--
-- Per-task spending limits. Before each model call the executor
-- checks remaining budget; if exceeded the step is blocked
-- instead of burning more tokens.
--
-- Budget is optional — tasks without a budget row run unlimited.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.task_budgets (
  id                  uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  task_id             uuid        NOT NULL REFERENCES public.ai_employee_tasks(id) ON DELETE CASCADE,
  employee_id         uuid        NOT NULL REFERENCES public.ai_employees(id) ON DELETE CASCADE,

  -- Limits (null = unlimited for that dimension)
  max_total_cost      numeric(10,4),      -- e.g. 0.50 ($)
  max_total_tokens    integer,            -- input + output combined
  max_premium_calls   smallint,           -- tier_a calls
  max_steps           smallint,           -- max loop steps (defense against infinite loops)

  -- Running totals (updated after each model call)
  current_cost        numeric(10,6) DEFAULT 0,
  current_tokens      integer       DEFAULT 0,
  premium_calls_used  smallint      DEFAULT 0,
  steps_used          smallint      DEFAULT 0,

  -- State
  exceeded            boolean       DEFAULT false,  -- true once any limit is hit
  exceeded_reason     text,                          -- which limit was exceeded
  exceeded_at         timestamptz,

  created_at          timestamptz   NOT NULL DEFAULT now(),
  updated_at          timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT uq_task_budget_task UNIQUE (task_id)
);

CREATE INDEX IF NOT EXISTS idx_task_budgets_employee
  ON public.task_budgets(employee_id);

-- ── RLS ─────────────────────────────────────────────────────

ALTER TABLE public.task_budgets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can view task_budgets"
  ON public.task_budgets FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated can insert task_budgets"
  ON public.task_budgets FOR INSERT
  WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Authenticated can update task_budgets"
  ON public.task_budgets FOR UPDATE
  USING (auth.role() = 'authenticated');

NOTIFY pgrst, 'reload schema';
