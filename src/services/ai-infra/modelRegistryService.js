const MODEL_REGISTRY = Object.freeze([
  { provider: 'anthropic', model_name: 'claude-opus-4-6',        capability_tier: 'tier_a', cost_per_1k_input: 0.005,    cost_per_1k_output: 0.025,    max_context_tokens: 1000000, active: true },
  { provider: 'openai',    model_name: 'gpt-5.4',                capability_tier: 'tier_a', cost_per_1k_input: 0.0025,   cost_per_1k_output: 0.015,    max_context_tokens: 1048576, active: true },
  { provider: 'openai',    model_name: 'gpt-5.4-thinking',       capability_tier: 'tier_a', cost_per_1k_input: 0.0025,   cost_per_1k_output: 0.015,    max_context_tokens: 1048576, active: true },
  { provider: 'gemini',    model_name: 'gemini-3.1-pro-preview', capability_tier: 'tier_a', cost_per_1k_input: 0.002,    cost_per_1k_output: 0.012,    max_context_tokens: 1048576, active: true },
  { provider: 'kimi',      model_name: 'kimi-k2.5',              capability_tier: 'tier_a', cost_per_1k_input: 0.00045,  cost_per_1k_output: 0.0022,   max_context_tokens: 262144,  active: true },
  { provider: 'openai',    model_name: 'gpt-5.4-mini',           capability_tier: 'tier_b', cost_per_1k_input: 0.00075,  cost_per_1k_output: 0.0045,   max_context_tokens: 400000,  active: true },
  { provider: 'gemini',    model_name: 'gemini-2.5-flash',       capability_tier: 'tier_b', cost_per_1k_input: 0.0003,   cost_per_1k_output: 0.0025,   max_context_tokens: 1048576, active: true },
  { provider: 'anthropic', model_name: 'claude-sonnet-4-6',      capability_tier: 'tier_b', cost_per_1k_input: 0.003,    cost_per_1k_output: 0.015,    max_context_tokens: 1000000, active: true },
  { provider: 'kimi',      model_name: 'kimi-k2-0905-preview',   capability_tier: 'tier_b', cost_per_1k_input: 0.00045,  cost_per_1k_output: 0.0022,   max_context_tokens: 262144,  active: true },
  { provider: 'kimi',      model_name: 'kimi-k2-turbo-preview',  capability_tier: 'tier_b', cost_per_1k_input: 0.00045,  cost_per_1k_output: 0.0022,   max_context_tokens: 262144,  active: true },
  { provider: 'deepseek',  model_name: 'deepseek-chat',          capability_tier: 'tier_c', cost_per_1k_input: 0.00028,  cost_per_1k_output: 0.00042,  max_context_tokens: 128000,  active: true },
  { provider: 'deepseek',  model_name: 'deepseek-reasoner',      capability_tier: 'tier_b', cost_per_1k_input: 0.00028,  cost_per_1k_output: 0.00042,  max_context_tokens: 128000,  active: true },
  { provider: 'gemini',    model_name: 'gemini-2.5-flash-lite',  capability_tier: 'tier_c', cost_per_1k_input: 0.0001,   cost_per_1k_output: 0.0004,   max_context_tokens: 1048576, active: true },
]);

function uniquePush(list, value) {
  if (value && !list.includes(value)) list.push(value);
}

export const DEFAULT_MODEL_REGISTRY = MODEL_REGISTRY;

export const PROVIDER_MODELS = Object.freeze(
  MODEL_REGISTRY.reduce((acc, entry) => {
    if (!entry?.active) return acc;
    if (!acc[entry.provider]) acc[entry.provider] = [];
    uniquePush(acc[entry.provider], entry.model_name);
    return acc;
  }, {})
);

export const KNOWN_PROVIDERS = Object.freeze(Object.keys(PROVIDER_MODELS));

export function isKnownProvider(provider) {
  return KNOWN_PROVIDERS.includes(String(provider || '').trim());
}

export function getModelsForProvider(provider) {
  return PROVIDER_MODELS[String(provider || '').trim()] || [];
}

export function getDefaultModelForProvider(provider) {
  return getModelsForProvider(provider)[0] || '';
}

export function normalizeProviderModelConfig({
  provider,
  model,
  fallbackProvider,
  fallbackModel,
}) {
  const requestedProvider = String(provider || '').trim();
  const requestedModel = String(model || '').trim();
  const normalizedFallbackProvider = isKnownProvider(fallbackProvider)
    ? String(fallbackProvider).trim()
    : KNOWN_PROVIDERS[0];
  const normalizedFallbackModel = getModelsForProvider(normalizedFallbackProvider).includes(String(fallbackModel || '').trim())
    ? String(fallbackModel).trim()
    : getDefaultModelForProvider(normalizedFallbackProvider);

  let nextProvider = requestedProvider;
  let nextModel = requestedModel;
  let normalized = false;
  let reason = null;

  if (!isKnownProvider(nextProvider)) {
    nextProvider = normalizedFallbackProvider;
    nextModel = normalizedFallbackModel;
    normalized = true;
    reason = requestedProvider ? 'invalid_provider' : 'missing_provider';
  }

  const providerModels = getModelsForProvider(nextProvider);
  const providerDefaultModel = providerModels[0] || normalizedFallbackModel;

  if (!providerModels.includes(nextModel)) {
    nextModel = nextProvider === normalizedFallbackProvider && providerModels.includes(normalizedFallbackModel)
      ? normalizedFallbackModel
      : providerDefaultModel;
    if (!normalized) {
      normalized = true;
      reason = requestedModel ? 'invalid_model_for_provider' : 'missing_model';
    }
  }

  return {
    provider: nextProvider,
    model: nextModel,
    normalized,
    reason,
  };
}
