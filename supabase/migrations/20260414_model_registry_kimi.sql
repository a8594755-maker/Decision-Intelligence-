-- Add Kimi (Moonshot) models to model_registry
-- Pricing source: OpenRouter (USD), official platform.moonshot.ai (CNY)
-- API: OpenAI-compatible at https://api.moonshot.ai/v1

INSERT INTO public.model_registry (provider, model_name, capability_tier, cost_per_1k_input, cost_per_1k_output, max_context_tokens)
VALUES
  ('kimi', 'kimi-k2.5',             'tier_a', 0.00045, 0.0022,  262144),
  ('kimi', 'kimi-k2-0905-preview',  'tier_b', 0.00045, 0.0022,  262144),
  ('kimi', 'kimi-k2-turbo-preview', 'tier_b', 0.00045, 0.0022,  262144)
ON CONFLICT (provider, model_name) DO UPDATE
SET cost_per_1k_input = EXCLUDED.cost_per_1k_input,
    cost_per_1k_output = EXCLUDED.cost_per_1k_output,
    max_context_tokens = EXCLUDED.max_context_tokens,
    capability_tier = EXCLUDED.capability_tier;
