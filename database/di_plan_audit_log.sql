-- ============================================================
-- di_plan_audit_log: plan decision audit trail
-- ============================================================

CREATE TABLE IF NOT EXISTS public.di_plan_audit_log (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  run_id bigint,
  action text NOT NULL
    CHECK (action IN (
      'plan_generated',
      'plan_approved',
      'plan_rejected',
      'scenario_run',
      'constraint_relaxed',
      'risk_triggered'
    )),
  actor text,
  kpi_snapshot jsonb DEFAULT '{}'::jsonb,
  narrative_summary text,
  approval_id text,
  note text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_di_plan_audit_log_user_id
  ON public.di_plan_audit_log(user_id);

CREATE INDEX IF NOT EXISTS idx_di_plan_audit_log_run_id
  ON public.di_plan_audit_log(run_id);

CREATE INDEX IF NOT EXISTS idx_di_plan_audit_log_created_at
  ON public.di_plan_audit_log(created_at DESC);

ALTER TABLE public.di_plan_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own audit logs" ON public.di_plan_audit_log;
CREATE POLICY "Users can view their own audit logs"
  ON public.di_plan_audit_log FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own audit logs" ON public.di_plan_audit_log;
CREATE POLICY "Users can insert their own audit logs"
  ON public.di_plan_audit_log FOR INSERT
  WITH CHECK (auth.uid() = user_id);

COMMENT ON TABLE public.di_plan_audit_log IS
  'Plan decision audit trail: records every plan generation, approval, rejection, and scenario run.';
COMMENT ON COLUMN public.di_plan_audit_log.kpi_snapshot IS
  'KPI snapshot at decision time: { service_level, total_cost, stockout_units }';
COMMENT ON COLUMN public.di_plan_audit_log.narrative_summary IS
  'First 500 chars of the decision_narrative.summary_text';
COMMENT ON COLUMN public.di_plan_audit_log.approval_id IS
  'Links to GovernanceStore approval record (Python)';
