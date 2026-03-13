-- ============================================================
-- AI Employee seed: Aiden
-- @product: ai-employee
--
-- manager_user_id is intentionally NULL here.
-- getOrCreateAiden(userId) will INSERT with the caller's uid,
-- so this seed only runs if you want a pre-seeded row before
-- any user has logged in (e.g. in staging / CI).
--
-- To seed with a specific manager:
--   INSERT INTO public.ai_employees (name, role, status, description, manager_user_id)
--   VALUES ('Aiden', ..., '<your-user-uuid>');
-- ============================================================

INSERT INTO public.ai_employees (
  name,
  role,
  status,
  description,
  permissions
)
VALUES (
  'Aiden',
  'supply_chain_reporting_employee',
  'idle',
  'AI supply chain analyst. Runs forecasts, replenishment plans, and risk assessments on demand.',
  '{"can_run_forecast":true,"can_run_plan":true,"can_run_risk":true,"can_write_worklog":true,"can_submit_review":true}'::jsonb
)
ON CONFLICT DO NOTHING;
