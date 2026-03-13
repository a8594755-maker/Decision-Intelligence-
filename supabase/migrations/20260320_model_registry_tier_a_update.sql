-- ============================================================
-- AI Employee: Update Tier A models
-- @product: ai-employee
--
-- Anthropic: claude-sonnet-4-6 → claude-opus-4-6 (task decomposition, high-risk, review)
-- OpenAI:    gpt-4.1           → gpt-5.4         (complex analysis, final review)
-- ============================================================

-- ── Anthropic Tier A ──────────────────────────────────────────
UPDATE public.model_registry SET
  model_name = 'claude-opus-4-6',
  cost_per_1k_input  = 0.015,
  cost_per_1k_output = 0.075
WHERE provider = 'anthropic' AND model_name = 'claude-sonnet-4-6';

-- If no row matched (fresh install), insert directly
INSERT INTO public.model_registry (provider, model_name, capability_tier, cost_per_1k_input, cost_per_1k_output, max_context_tokens)
VALUES ('anthropic', 'claude-opus-4-6', 'tier_a', 0.015, 0.075, 200000)
ON CONFLICT (provider, model_name) DO NOTHING;

-- ── OpenAI Tier A ─────────────────────────────────────────────
UPDATE public.model_registry SET
  model_name = 'gpt-5.4',
  cost_per_1k_input  = 0.003,
  cost_per_1k_output = 0.012
WHERE provider = 'openai' AND model_name = 'gpt-4.1';

-- If no row matched, insert directly
INSERT INTO public.model_registry (provider, model_name, capability_tier, cost_per_1k_input, cost_per_1k_output, max_context_tokens)
VALUES ('openai', 'gpt-5.4', 'tier_a', 0.003, 0.012, 1048576)
ON CONFLICT (provider, model_name) DO NOTHING;

NOTIFY pgrst, 'reload schema';
