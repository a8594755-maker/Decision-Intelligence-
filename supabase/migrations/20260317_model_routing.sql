-- ============================================================
-- AI Employee: Model Registry & Routing
-- @product: ai-employee
--
-- Multi-model routing: model_registry stores available models
-- with capability tiers and cost info. routing_policies maps
-- task types to preferred/fallback models. task_model_runs
-- tracks per-call token usage and cost for budget enforcement.
-- ============================================================

-- ── Model Registry ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.model_registry (
  id              uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  provider        text        NOT NULL,  -- 'gemini' | 'deepseek' | 'openai' | 'anthropic'
  model_name      text        NOT NULL,  -- e.g. 'gemini-3.1-pro-preview', 'deepseek-chat'
  capability_tier text        NOT NULL,  -- 'tier_a' | 'tier_b' | 'tier_c'
  cost_per_1k_input   numeric(10,6) DEFAULT 0,
  cost_per_1k_output  numeric(10,6) DEFAULT 0,
  max_context_tokens  integer DEFAULT 128000,
  supports_json   boolean     DEFAULT true,
  active          boolean     DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_model_registry_provider_name UNIQUE (provider, model_name)
);

-- Seed default models
INSERT INTO public.model_registry (provider, model_name, capability_tier, cost_per_1k_input, cost_per_1k_output, max_context_tokens) VALUES
  ('gemini',    'gemini-3.1-pro-preview', 'tier_a', 0.00125, 0.005,   1048576),
  ('deepseek',  'deepseek-chat',          'tier_c', 0.00014, 0.00028, 65536),
  ('deepseek',  'deepseek-reasoner',      'tier_b', 0.00055, 0.00220, 65536),
  ('anthropic', 'claude-sonnet-4-6',      'tier_a', 0.003,   0.015,   200000),
  ('anthropic', 'claude-haiku-4-5',       'tier_c', 0.0008,  0.004,   200000)
ON CONFLICT (provider, model_name) DO NOTHING;

-- ── Routing Policies ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.routing_policies (
  id                uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  task_type         text        NOT NULL UNIQUE,  -- 'forecast' | 'plan' | 'risk' | 'synthesize' | 'task_decomposition' | 'review'
  preferred_tier    text        NOT NULL DEFAULT 'tier_c',
  fallback_tier     text,
  escalation_rules  jsonb       DEFAULT '{}'::jsonb,
  -- escalation_rules: { "on_failure": "tier_a", "on_low_confidence": "tier_b", "on_high_risk": "tier_a" }
  created_at        timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.routing_policies (task_type, preferred_tier, fallback_tier, escalation_rules) VALUES
  ('forecast',           'tier_c', 'tier_b', '{"on_failure": "tier_a", "on_low_confidence": "tier_b"}'::jsonb),
  ('plan',               'tier_c', 'tier_b', '{"on_failure": "tier_a", "on_high_risk": "tier_a"}'::jsonb),
  ('risk',               'tier_c', 'tier_b', '{"on_failure": "tier_a"}'::jsonb),
  ('synthesize',         'tier_c', null,     '{}'::jsonb),
  ('task_decomposition', 'tier_a', null,     '{}'::jsonb),
  ('review',             'tier_a', 'tier_b', '{}'::jsonb)
ON CONFLICT (task_type) DO NOTHING;

-- ── Task Model Runs (per-call tracking) ─────────────────────

CREATE TABLE IF NOT EXISTS public.task_model_runs (
  id              uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  task_id         uuid        REFERENCES public.ai_employee_tasks(id) ON DELETE CASCADE,
  run_id          uuid        REFERENCES public.ai_employee_runs(id) ON DELETE SET NULL,
  employee_id     uuid        NOT NULL REFERENCES public.ai_employees(id) ON DELETE CASCADE,

  agent_role      text,       -- 'executor' | 'reviewer' | 'decomposer' | 'summarizer'
  model_provider  text        NOT NULL,
  model_name      text        NOT NULL,
  capability_tier text        NOT NULL,

  input_tokens    integer     DEFAULT 0,
  output_tokens   integer     DEFAULT 0,
  estimated_cost  numeric(10,6) DEFAULT 0,
  latency_ms      integer,

  step_name       text,       -- from agent loop step
  escalated_from  text,       -- if this was an escalation, which tier did it come from

  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_model_runs_task
  ON public.task_model_runs(task_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_task_model_runs_employee
  ON public.task_model_runs(employee_id, created_at DESC);

-- ── RLS ─────────────────────────────────────────────────────

ALTER TABLE public.model_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.routing_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_model_runs ENABLE ROW LEVEL SECURITY;

-- model_registry: read-only for authenticated
CREATE POLICY "Authenticated can view model_registry"
  ON public.model_registry FOR SELECT
  USING (auth.role() = 'authenticated');

-- routing_policies: read-only for authenticated
CREATE POLICY "Authenticated can view routing_policies"
  ON public.routing_policies FOR SELECT
  USING (auth.role() = 'authenticated');

-- task_model_runs: authenticated can view + insert
CREATE POLICY "Authenticated can view task_model_runs"
  ON public.task_model_runs FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated can insert task_model_runs"
  ON public.task_model_runs FOR INSERT
  WITH CHECK (auth.role() = 'authenticated');

NOTIFY pgrst, 'reload schema';
