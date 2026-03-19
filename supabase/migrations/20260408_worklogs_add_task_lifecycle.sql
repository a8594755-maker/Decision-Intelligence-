-- ── ai_employee_worklogs: add task_lifecycle log type ────────
-- The orchestrator writes 'task_lifecycle' entries for task_created,
-- review_resolved, and task_completed events.

ALTER TABLE public.ai_employee_worklogs
  DROP CONSTRAINT IF EXISTS ai_employee_worklogs_log_type_check;

ALTER TABLE public.ai_employee_worklogs
  ADD CONSTRAINT ai_employee_worklogs_log_type_check
  CHECK (log_type IN ('task_update', 'daily_summary', 'escalation', 'retrospective', 'step_progress', 'task_lifecycle'));

NOTIFY pgrst, 'reload schema';
