-- ============================================================
-- AI Employee Phase 3: Scheduled tasks + Notifications
-- @product: ai-employee
--
-- New tables:
--   ai_employee_schedules     — recurring task schedules per employee
--   ai_employee_notifications — in-app notifications for managers
-- ============================================================

-- ── Schedules ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ai_employee_schedules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     uuid NOT NULL REFERENCES public.ai_employees(id) ON DELETE CASCADE,
  schedule_type   text NOT NULL CHECK (schedule_type IN ('daily', 'weekly', 'monthly', 'cron')),
  cron_expression text,
  hour            smallint DEFAULT 8,
  day_of_week     smallint,          -- 0=Sun..6=Sat (for weekly)
  day_of_month    smallint,          -- 1-31 (for monthly)
  task_template   jsonb NOT NULL,    -- { title, template_id|workflow_type, input_context, priority }
  last_run_at     timestamptz,
  next_run_at     timestamptz,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  created_by      uuid,
  created_at      timestamptz DEFAULT now()
);

CREATE INDEX idx_schedules_next_run ON public.ai_employee_schedules (next_run_at, status)
  WHERE status = 'active';
CREATE INDEX idx_schedules_employee ON public.ai_employee_schedules (employee_id);

ALTER TABLE public.ai_employee_schedules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage schedules for their employees"
  ON public.ai_employee_schedules FOR ALL
  USING (
    employee_id IN (
      SELECT id FROM public.ai_employees WHERE manager_user_id = auth.uid()
    )
  );

-- ── Notifications ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ai_employee_notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL,
  employee_id uuid REFERENCES public.ai_employees(id) ON DELETE SET NULL,
  type        text NOT NULL,     -- task_completed, task_failed, budget_exceeded, daily_summary_ready, proactive_task_created, schedule_executed
  title       text NOT NULL,
  body        jsonb,
  read        boolean NOT NULL DEFAULT false,
  task_id     uuid REFERENCES public.ai_employee_tasks(id) ON DELETE SET NULL,
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX idx_notifications_user_unread
  ON public.ai_employee_notifications (user_id, read, created_at DESC);
CREATE INDEX idx_notifications_employee
  ON public.ai_employee_notifications (employee_id, created_at DESC);

ALTER TABLE public.ai_employee_notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own notifications"
  ON public.ai_employee_notifications FOR ALL
  USING (user_id = auth.uid());

NOTIFY pgrst, 'reload schema';
