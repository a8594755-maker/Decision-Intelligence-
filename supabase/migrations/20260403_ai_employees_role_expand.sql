-- ============================================================
-- Expand ai_employees.role CHECK constraint to allow new worker types.
--
-- The original migration (20260313) only allowed
-- 'supply_chain_reporting_employee'. The JS employeeRepo
-- now creates workers with template-driven roles.
-- ============================================================

-- Drop the old CHECK constraint and re-add with expanded values
ALTER TABLE public.ai_employees
  DROP CONSTRAINT IF EXISTS ai_employees_role_check;

ALTER TABLE public.ai_employees
  ADD CONSTRAINT ai_employees_role_check CHECK (role IN (
    'supply_chain_reporting_employee',
    'data_analyst',
    'supply_chain_analyst',
    'procurement_specialist',
    'operations_coordinator'
  ));
