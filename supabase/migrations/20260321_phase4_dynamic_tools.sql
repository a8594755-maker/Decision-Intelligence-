-- ============================================================
-- AI Employee Phase 4: Dynamic Tools & Quality Review
-- @product: ai-employee
-- ============================================================

-- ── Tool Registry ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tool_registry (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  description       text,
  category          text NOT NULL CHECK (category IN ('solver','ml_model','transform','report','analysis','custom')),
  code              text NOT NULL,
  code_hash         text NOT NULL,
  input_schema      jsonb DEFAULT '{}'::jsonb,
  output_schema     jsonb DEFAULT '{}'::jsonb,
  created_by_task_id uuid REFERENCES public.ai_employee_tasks(id) ON DELETE SET NULL,
  approved_by       uuid,
  approved_at       timestamptz,
  usage_count       integer NOT NULL DEFAULT 0,
  quality_score     numeric(3,2) DEFAULT 0.00,
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','deprecated')),
  tags              text[] DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_registry_hash
  ON public.tool_registry(code_hash) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_tool_registry_category
  ON public.tool_registry(category, status);
CREATE INDEX IF NOT EXISTS idx_tool_registry_quality
  ON public.tool_registry(quality_score DESC) WHERE status = 'active';

-- ── AI Review Results ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ai_review_results (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         uuid NOT NULL REFERENCES public.ai_employee_tasks(id) ON DELETE CASCADE,
  run_id          uuid REFERENCES public.ai_employee_runs(id) ON DELETE SET NULL,
  step_name       text NOT NULL,
  revision_round  smallint NOT NULL DEFAULT 1,
  score           smallint NOT NULL CHECK (score >= 0 AND score <= 100),
  passed          boolean NOT NULL,
  threshold       smallint NOT NULL,
  feedback        text,
  categories      jsonb DEFAULT '{}'::jsonb,
  suggestions     text[] DEFAULT '{}',
  reviewer_model  text,
  reviewer_tier   text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_reviews_task_step
  ON public.ai_review_results(task_id, step_name, revision_round);

-- ── RLS ─────────────────────────────────────────────────────
ALTER TABLE public.tool_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_review_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_read_tools"
  ON public.tool_registry FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "auth_manage_tools"
  ON public.tool_registry FOR ALL
  USING (true) WITH CHECK (true);

CREATE POLICY "auth_read_reviews"
  ON public.ai_review_results FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "auth_insert_reviews"
  ON public.ai_review_results FOR INSERT
  WITH CHECK (auth.role() = 'authenticated');

-- ── Extend task source_type ─────────────────────────────────
ALTER TABLE public.ai_employee_tasks
  DROP CONSTRAINT IF EXISTS ai_employee_tasks_source_type_check;

ALTER TABLE public.ai_employee_tasks
  ADD CONSTRAINT ai_employee_tasks_source_type_check
  CHECK (source_type IN ('manual','scheduled','question_to_task','chat_decomposed'));

NOTIFY pgrst, 'reload schema';
