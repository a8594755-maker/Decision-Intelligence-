-- ============================================================
-- AI Employee: Add OpenAI models + update routing policies
-- @product: ai-employee
--
-- Now that Claude + OpenAI keys are in Supabase secrets,
-- register OpenAI models and optimize routing for 4 providers:
--   Tier A (high-reasoning): Claude Sonnet 4.6, GPT-4.1
--   Tier B (specialist):     DeepSeek Reasoner, Claude Sonnet 4.6
--   Tier C (low-cost):       DeepSeek Chat, GPT-4.1-mini, Claude Haiku
-- ============================================================

-- ── Add OpenAI models ───────────────────────────────────────

INSERT INTO public.model_registry (provider, model_name, capability_tier, cost_per_1k_input, cost_per_1k_output, max_context_tokens) VALUES
  ('openai', 'gpt-4.1',        'tier_a', 0.002,    0.008,   1048576),
  ('openai', 'gpt-4.1-mini',   'tier_c', 0.0004,   0.0016,  1048576),
  ('openai', 'gpt-4.1-nano',   'tier_c', 0.0001,   0.0004,  1048576),
  ('openai', 'o4-mini',        'tier_b', 0.00110,  0.00440, 200000)
ON CONFLICT (provider, model_name) DO NOTHING;

-- ── Update routing policies with refined escalation ─────────

UPDATE public.routing_policies SET
  preferred_tier = 'tier_c',
  fallback_tier = 'tier_b',
  escalation_rules = '{"on_failure": "tier_a", "on_low_confidence": "tier_b"}'::jsonb
WHERE task_type = 'forecast';

UPDATE public.routing_policies SET
  preferred_tier = 'tier_c',
  fallback_tier = 'tier_b',
  escalation_rules = '{"on_failure": "tier_a", "on_high_risk": "tier_a", "on_low_confidence": "tier_b"}'::jsonb
WHERE task_type = 'plan';

UPDATE public.routing_policies SET
  preferred_tier = 'tier_c',
  fallback_tier = 'tier_b',
  escalation_rules = '{"on_failure": "tier_a"}'::jsonb
WHERE task_type = 'risk';

-- Synthesize: stay cheap, no escalation needed (deterministic)
UPDATE public.routing_policies SET
  preferred_tier = 'tier_c',
  fallback_tier = null,
  escalation_rules = '{}'::jsonb
WHERE task_type = 'synthesize';

-- Task decomposition: always tier_a (needs strong reasoning)
UPDATE public.routing_policies SET
  preferred_tier = 'tier_a',
  fallback_tier = 'tier_b',
  escalation_rules = '{}'::jsonb
WHERE task_type = 'task_decomposition';

-- Review: tier_a with tier_b fallback
UPDATE public.routing_policies SET
  preferred_tier = 'tier_a',
  fallback_tier = 'tier_b',
  escalation_rules = '{}'::jsonb
WHERE task_type = 'review';

NOTIFY pgrst, 'reload schema';
