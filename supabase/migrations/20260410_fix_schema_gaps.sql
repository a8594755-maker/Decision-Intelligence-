-- ============================================================
-- Fix schema gaps identified during v1 demo (2026-03-19)
--
-- 1. ai_employee_runs: add missing step states (waiting_input, review_hold)
-- 2. ai_employee_runs: add _revision_instructions column for self-healing
-- 3. conversations: add workspace column for multi-workspace chat
-- ============================================================

-- ── 1. Widen ai_employee_runs status CHECK to include all step states ──
ALTER TABLE public.ai_employee_runs
  DROP CONSTRAINT IF EXISTS ai_employee_runs_status_check;

ALTER TABLE public.ai_employee_runs
  ADD CONSTRAINT ai_employee_runs_status_check
  CHECK (status IN (
    -- v1 states
    'running', 'succeeded', 'failed', 'needs_review',
    -- v2 states
    'pending', 'retrying', 'skipped',
    -- v2.1 states (orchestrator step gates)
    'waiting_input', 'review_hold'
  ));

-- ── 2. Add _revision_instructions for self-healing retry context ──
ALTER TABLE public.ai_employee_runs
  ADD COLUMN IF NOT EXISTS _revision_instructions jsonb DEFAULT NULL;

COMMENT ON COLUMN public.ai_employee_runs._revision_instructions
  IS 'Self-healing context: revision instructions from AI reviewer or error diagnostics.';

-- ── 3. Add workspace column to conversations for multi-workspace support ──
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS workspace text NOT NULL DEFAULT 'di';

CREATE INDEX IF NOT EXISTS idx_conversations_workspace
  ON public.conversations(user_id, workspace);

COMMENT ON COLUMN public.conversations.workspace
  IS 'Workspace tag: di (decision intelligence) or ai_employee (digital worker).';

NOTIFY pgrst, 'reload schema';
