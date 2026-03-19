-- ============================================================
-- AI Employees: Soft-delete (archive) support
-- @product: ai-employee
--
-- Adds archived_at column for audit-safe worker removal.
-- UI filters out archived workers; records remain for compliance.
-- ============================================================

ALTER TABLE public.ai_employees
  ADD COLUMN IF NOT EXISTS archived_at timestamptz DEFAULT NULL;

-- Only one active worker per (manager, role); archived ones are exempt
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_employees_active_role_per_manager
  ON public.ai_employees (manager_user_id, role)
  WHERE archived_at IS NULL;

NOTIFY pgrst, 'reload schema';
