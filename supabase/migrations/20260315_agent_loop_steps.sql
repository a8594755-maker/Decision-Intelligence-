-- ============================================================
-- Agent Loop: step tracking columns for multi-step execution
-- @product: ai-employee
--
-- Adds agent loop fields to existing tables so the executor can
-- decompose a task into ordered steps, each backed by its own run.
-- ============================================================

-- ── ai_employee_runs: step tracking ─────────────────────────
ALTER TABLE public.ai_employee_runs
  ADD COLUMN IF NOT EXISTS step_index  smallint  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS step_name   text      DEFAULT NULL;

COMMENT ON COLUMN public.ai_employee_runs.step_index IS 'Step position within an agent loop (0-based). NULL for legacy single-step runs.';
COMMENT ON COLUMN public.ai_employee_runs.step_name  IS 'Step name within an agent loop (e.g. forecast, plan, risk, synthesize).';

CREATE INDEX IF NOT EXISTS idx_ai_runs_task_step
  ON public.ai_employee_runs(task_id, step_index ASC)
  WHERE step_index IS NOT NULL;

-- ── ai_employee_tasks: loop state ───────────────────────────
ALTER TABLE public.ai_employee_tasks
  ADD COLUMN IF NOT EXISTS template_id  text   DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS loop_state   jsonb  DEFAULT NULL;

COMMENT ON COLUMN public.ai_employee_tasks.template_id IS 'Agent loop template ID (e.g. full_report, forecast_then_plan). NULL for legacy single-step tasks.';
COMMENT ON COLUMN public.ai_employee_tasks.loop_state  IS 'Agent loop progress state: steps[], current_step_index, timestamps.';

-- ── ai_employee_worklogs: add step_progress log type ────────
ALTER TABLE public.ai_employee_worklogs
  DROP CONSTRAINT IF EXISTS ai_employee_worklogs_log_type_check;

ALTER TABLE public.ai_employee_worklogs
  ADD CONSTRAINT ai_employee_worklogs_log_type_check
  CHECK (log_type IN ('task_update', 'daily_summary', 'escalation', 'retrospective', 'step_progress'));

NOTIFY pgrst, 'reload schema';
