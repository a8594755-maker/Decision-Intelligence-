-- Model registry pricing & context update (2026-03-23)
-- Sources: OpenAI, Anthropic, Google AI, DeepSeek official pricing pages

-- Anthropic: context 200K → 1M beta
UPDATE public.model_registry SET max_context_tokens = 1000000
WHERE provider = 'anthropic' AND model_name IN ('claude-opus-4-6', 'claude-sonnet-4-6');

-- Anthropic claude-opus-4-6: correct pricing (was 0.015/0.075 in earlier migration)
UPDATE public.model_registry
SET cost_per_1k_input = 0.005, cost_per_1k_output = 0.025
WHERE provider = 'anthropic' AND model_name = 'claude-opus-4-6';

-- Anthropic claude-haiku-4-5: update pricing
UPDATE public.model_registry
SET cost_per_1k_input = 0.001, cost_per_1k_output = 0.005
WHERE provider = 'anthropic' AND model_name = 'claude-haiku-4-5';

-- DeepSeek: context 65536 → 128000
UPDATE public.model_registry SET max_context_tokens = 128000
WHERE provider = 'deepseek' AND model_name IN ('deepseek-chat', 'deepseek-reasoner');

-- DeepSeek: correct pricing (cache-miss rates)
UPDATE public.model_registry
SET cost_per_1k_input = 0.00028, cost_per_1k_output = 0.00042
WHERE provider = 'deepseek' AND model_name IN ('deepseek-chat', 'deepseek-reasoner');

-- OpenAI gpt-5.4-mini (replaces gpt-5-mini if it existed)
INSERT INTO public.model_registry (provider, model_name, capability_tier, cost_per_1k_input, cost_per_1k_output, max_context_tokens)
VALUES ('openai', 'gpt-5.4-mini', 'tier_b', 0.00075, 0.0045, 400000)
ON CONFLICT (provider, model_name) DO UPDATE
SET cost_per_1k_input = EXCLUDED.cost_per_1k_input,
    cost_per_1k_output = EXCLUDED.cost_per_1k_output,
    max_context_tokens = EXCLUDED.max_context_tokens,
    capability_tier = EXCLUDED.capability_tier;

-- Gemini 3.1 Pro: pricing is correct (0.002/0.012 for ≤200K), no change needed
-- Gemini 2.5 Flash / Flash Lite: pricing is correct, no change needed
