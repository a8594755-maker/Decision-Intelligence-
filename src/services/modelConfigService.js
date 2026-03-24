/**
 * Model Configuration Service
 * Reads/writes chat agent model settings from localStorage.
 *
 * Legacy storage supported three execution modes with independent configs:
 *   - 'single'  — single agent only (no challenger, no judge)
 *   - 'dual'    — primary + challenger + judge (auto-triggered)
 *   - 'full'    — forced dual + judge on every message (thinking On)
 *
 * The current settings UI uses simplified shared role configs:
 *   - primary   — answer generation
 *   - secondary — challenger / comparison path
 *   - judge     — QA reviewer / candidate judge
 *
 * Falls back to env vars → hardcoded defaults.
 */

import {
  PROVIDER_MODELS as REGISTRY_PROVIDER_MODELS,
  normalizeProviderModelConfig,
} from './modelRegistryService.js';

const STORAGE_KEY = 'di_model_config';
const ACTIVE_MODE_KEY = 'di_active_thinking_mode';
const NORMALIZATION_NOTICES = [];

export const EXECUTION_MODES = Object.freeze({
  single: {
    key: 'single',
    label: 'Single Agent',
    desc: 'One agent answers directly — fast and token-efficient',
    roles: ['primary'],
  },
  dual: {
    key: 'dual',
    label: 'Dual Agent',
    desc: 'Primary + Challenger compete, Judge picks the winner',
    roles: ['primary', 'secondary', 'judge'],
  },
  full: {
    key: 'full',
    label: 'On (Full Thinking)',
    desc: 'Always run dual agent + judge on every message',
    roles: ['primary', 'secondary', 'judge'],
  },
});

// Kept for backward compat with imports that reference THINKING_MODES
export const THINKING_MODES = EXECUTION_MODES;

export const PROVIDER_MODELS = REGISTRY_PROVIDER_MODELS;

const MODEL_TO_PROVIDER = Object.freeze(
  Object.fromEntries(
    Object.entries(PROVIDER_MODELS).flatMap(([provider, models]) =>
      models.map((modelName) => [modelName, provider]),
    ),
  ),
);

/**
 * Resolve the correct provider for a model name.
 * If the declared provider doesn't own the model, return the inferred provider.
 * Unknown models (not in PROVIDER_MODELS) trust the declared provider.
 */
export function resolveProviderFromModel(model, declaredProvider) {
  const inferred = MODEL_TO_PROVIDER[String(model || '').trim()];
  if (!inferred) return declaredProvider;
  if (inferred === declaredProvider) return declaredProvider;
  console.warn(
    `[modelConfig] Provider mismatch: declared="${declaredProvider}" but model="${model}" belongs to "${inferred}". Using "${inferred}".`,
  );
  return inferred;
}

const HARD_DEFAULTS = {
  primary: {
    provider: 'openai',
    model: 'gpt-5.4',
  },
  secondary: {
    provider: 'anthropic',
    model: 'claude-opus-4-6',
  },
  judge: {
    provider: 'gemini',
    model: 'gemini-3.1-pro-preview',
  },
};

const ENV_DEFAULTS = {
  primary: {
    provider: import.meta.env.VITE_DI_CHAT_PROVIDER || HARD_DEFAULTS.primary.provider,
    model:    import.meta.env.VITE_DI_CHAT_MODEL || HARD_DEFAULTS.primary.model,
  },
  secondary: {
    provider: import.meta.env.VITE_DI_AGENT_SECONDARY_PROVIDER || HARD_DEFAULTS.secondary.provider,
    model:    import.meta.env.VITE_DI_AGENT_SECONDARY_MODEL || HARD_DEFAULTS.secondary.model,
  },
  judge: {
    provider: import.meta.env.VITE_DI_AGENT_QA_REVIEW_PROVIDER || HARD_DEFAULTS.judge.provider,
    model:    import.meta.env.VITE_DI_AGENT_QA_REVIEW_MODEL || HARD_DEFAULTS.judge.model,
  },
};

const VALID_MODES = new Set(['single', 'dual', 'full']);
const VALID_ROLES = new Set(['primary', 'secondary', 'judge']);
const SHARED_CONFIG_KEY = 'shared';

function loadConfig() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch { return {}; }
}

function saveConfig(config) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

function enqueueNormalizationNotice(notice) {
  if (!notice?.message) return;
  const key = notice.key || notice.message;
  if (NORMALIZATION_NOTICES.some((item) => item.key === key)) return;
  NORMALIZATION_NOTICES.push({ ...notice, key });
}

function buildRoleDefaults(role) {
  const envDefaults = ENV_DEFAULTS[role] || ENV_DEFAULTS.primary;
  const hardDefaults = HARD_DEFAULTS[role] || HARD_DEFAULTS.primary;
  return normalizeProviderModelConfig({
    provider: envDefaults.provider,
    model: envDefaults.model,
    fallbackProvider: hardDefaults.provider,
    fallbackModel: hardDefaults.model,
  });
}

function isValidConfigEntry(entry) {
  return Boolean(entry && typeof entry.provider === 'string' && typeof entry.model === 'string');
}

function normalizeStoredEntry(entry, role, sourceKey) {
  if (!isValidConfigEntry(entry)) {
    return { entry: null, normalized: false, reason: null };
  }

  const defaults = buildRoleDefaults(role);
  const normalized = normalizeProviderModelConfig({
    provider: entry.provider,
    model: entry.model,
    fallbackProvider: defaults.provider,
    fallbackModel: defaults.model,
  });

  if (normalized.normalized) {
    enqueueNormalizationNotice({
      key: `${sourceKey}:${role}:${normalized.reason}:${entry.provider}:${entry.model}`,
      role,
      sourceKey,
      reason: normalized.reason,
      message: `Model config repaired for ${role}: ${entry.provider || 'unknown'} · ${entry.model || 'unknown'} → ${normalized.provider} · ${normalized.model}.`,
    });
  }

  return {
    entry: {
      provider: normalized.provider,
      model: normalized.model,
    },
    normalized: normalized.normalized,
    reason: normalized.reason,
  };
}

function sanitizeConfig(config) {
  const rawConfig = config && typeof config === 'object' ? config : {};
  const nextConfig = { ...rawConfig };
  let changed = false;

  if (rawConfig?.[SHARED_CONFIG_KEY] && typeof rawConfig[SHARED_CONFIG_KEY] === 'object') {
    nextConfig[SHARED_CONFIG_KEY] = { ...rawConfig[SHARED_CONFIG_KEY] };
    for (const role of VALID_ROLES) {
      if (!rawConfig[SHARED_CONFIG_KEY]?.[role]) continue;
      const normalized = normalizeStoredEntry(rawConfig[SHARED_CONFIG_KEY][role], role, SHARED_CONFIG_KEY);
      if (normalized.entry) {
        nextConfig[SHARED_CONFIG_KEY][role] = normalized.entry;
        changed ||= normalized.normalized;
      }
    }
  }

  for (const mode of VALID_MODES) {
    if (!rawConfig?.[mode] || typeof rawConfig[mode] !== 'object') continue;
    nextConfig[mode] = { ...rawConfig[mode] };
    for (const role of VALID_ROLES) {
      if (!rawConfig[mode]?.[role]) continue;
      const normalized = normalizeStoredEntry(rawConfig[mode][role], role, mode);
      if (normalized.entry) {
        nextConfig[mode][role] = normalized.entry;
        changed ||= normalized.normalized;
      }
    }
  }

  for (const role of VALID_ROLES) {
    if (!rawConfig?.[role]) continue;
    const normalized = normalizeStoredEntry(rawConfig[role], role, 'legacy');
    if (normalized.entry) {
      nextConfig[role] = normalized.entry;
      changed ||= normalized.normalized;
    }
  }

  return {
    config: nextConfig,
    changed,
  };
}

function loadSanitizedConfig() {
  const rawConfig = loadConfig();
  const { config, changed } = sanitizeConfig(rawConfig);
  if (changed) {
    saveConfig(config);
  }
  return config;
}

function getSharedEntry(config, role) {
  const entry = config?.[SHARED_CONFIG_KEY]?.[role];
  return isValidConfigEntry(entry) ? entry : null;
}

function getModeEntry(config, mode, role) {
  const entry = config?.[mode]?.[role];
  return isValidConfigEntry(entry) ? entry : null;
}

function getLegacyEntry(config, role) {
  const entry = config?.[role];
  return isValidConfigEntry(entry) ? entry : null;
}

function getDefaultLookupMode(role) {
  if (role === 'primary') return getActiveThinkingMode();
  return 'dual';
}

function getModeFallbackOrder(role, mode) {
  if (role === 'primary') {
    if (mode === 'full') return ['full', 'dual', 'single'];
    if (mode === 'dual') return ['dual', 'single', 'full'];
    return ['single', 'dual', 'full'];
  }

  if (mode === 'full') return ['full', 'dual'];
  if (mode === 'single') return ['dual', 'full'];
  return ['dual', 'full'];
}

/**
 * Resolve execution mode from a thinking-mode string.
 * 'auto' maps to either 'single' or 'dual' depending on the dualGenerate flag;
 * callers that don't know yet should pass the specific mode.
 */
function normalizeMode(mode) {
  if (VALID_MODES.has(mode)) return mode;
  // Legacy 'auto' → fall back to 'single' (caller should pass 'dual' when dual is active)
  if (mode === 'auto') return 'single';
  return 'single';
}

function getResolvedEntry(config, role, mode) {
  const normalizedRole = VALID_ROLES.has(role) ? role : 'primary';
  const defaults = buildRoleDefaults(normalizedRole);
  const sharedEntry = getSharedEntry(config, normalizedRole);
  if (sharedEntry) {
    const normalized = normalizeStoredEntry(sharedEntry, normalizedRole, SHARED_CONFIG_KEY);
    return {
      provider: normalized.entry?.provider || defaults.provider,
      model: normalized.entry?.model || defaults.model,
      configNormalized: normalized.normalized,
      normalizationReason: normalized.reason,
      source: SHARED_CONFIG_KEY,
    };
  }

  const effectiveMode = normalizeMode(mode || getDefaultLookupMode(normalizedRole));
  const modeEntry = getModeFallbackOrder(normalizedRole, effectiveMode)
    .map((candidateMode) => {
      const entry = getModeEntry(config, candidateMode, normalizedRole);
      return entry ? { entry, source: candidateMode } : null;
    })
    .find(Boolean);
  if (modeEntry) {
    const normalized = normalizeStoredEntry(modeEntry.entry, normalizedRole, modeEntry.source);
    return {
      provider: normalized.entry?.provider || defaults.provider,
      model: normalized.entry?.model || defaults.model,
      configNormalized: normalized.normalized,
      normalizationReason: normalized.reason,
      source: modeEntry.source,
    };
  }

  const legacyEntry = getLegacyEntry(config, normalizedRole);
  if (legacyEntry) {
    const normalized = normalizeStoredEntry(legacyEntry, normalizedRole, 'legacy');
    return {
      provider: normalized.entry?.provider || defaults.provider,
      model: normalized.entry?.model || defaults.model,
      configNormalized: normalized.normalized,
      normalizationReason: normalized.reason,
      source: 'legacy',
    };
  }

  return {
    provider: defaults.provider,
    model: defaults.model,
    configNormalized: false,
    normalizationReason: null,
    source: 'default',
  };
}

export function getModelConfigResolution(role, mode) {
  const rawConfig = loadConfig();
  const resolution = getResolvedEntry(rawConfig, role, mode);
  const { config, changed } = sanitizeConfig(rawConfig);
  if (changed) {
    saveConfig(config);
  }
  return resolution;
}

/**
 * Get effective provider+model for a role.
 * @param {'primary'|'secondary'|'judge'} role
 * @param {'single'|'dual'|'full'|'auto'} [mode]
 * @returns {{ provider: string, model: string }}
 */
export function getModelConfig(role, mode) {
  const { provider, model } = getModelConfigResolution(role, mode);
  return { provider, model };
}

/**
 * Persist provider+model for a role within an execution mode.
 * @param {'primary'|'secondary'|'judge'} role
 * @param {string} provider
 * @param {string} model
 * @param {'single'|'dual'|'full'} [mode]
 */
export function setModelConfig(role, provider, model, mode) {
  const normalizedRole = VALID_ROLES.has(role) ? role : 'primary';
  const defaultMode = normalizedRole === 'primary' ? 'single' : 'dual';
  const effectiveMode = normalizeMode(mode || defaultMode);
  const config = loadSanitizedConfig();
  const defaults = buildRoleDefaults(normalizedRole);
  const normalized = normalizeProviderModelConfig({
    provider,
    model,
    fallbackProvider: defaults.provider,
    fallbackModel: defaults.model,
  });
  if (!config[effectiveMode]) config[effectiveMode] = {};
  config[effectiveMode][normalizedRole] = {
    provider: normalized.provider,
    model: normalized.model,
  };
  if (normalized.normalized) {
    enqueueNormalizationNotice({
      key: `${effectiveMode}:${normalizedRole}:${normalized.reason}:write`,
      role: normalizedRole,
      sourceKey: effectiveMode,
      reason: normalized.reason,
      message: `Model config repaired for ${normalizedRole}: ${provider || 'unknown'} · ${model || 'unknown'} → ${normalized.provider} · ${normalized.model}.`,
    });
  }
  saveConfig(config);
}

/**
 * Get the simplified shared config for a role.
 * Falls back to legacy mode-based configs if no shared entry exists yet.
 * @param {'primary'|'secondary'|'judge'} role
 * @returns {{ provider: string, model: string }}
 */
export function getSharedModelConfig(role) {
  return getModelConfig(role, role === 'primary' ? 'single' : 'dual');
}

/**
 * Persist provider+model for a role in the simplified shared settings model.
 * This becomes the canonical config used across execution modes.
 * @param {'primary'|'secondary'|'judge'} role
 * @param {string} provider
 * @param {string} model
 */
export function setSharedModelConfig(role, provider, model) {
  const normalizedRole = VALID_ROLES.has(role) ? role : 'primary';
  const config = loadSanitizedConfig();
  const defaults = buildRoleDefaults(normalizedRole);
  const normalized = normalizeProviderModelConfig({
    provider,
    model,
    fallbackProvider: defaults.provider,
    fallbackModel: defaults.model,
  });
  if (!config[SHARED_CONFIG_KEY]) config[SHARED_CONFIG_KEY] = {};
  config[SHARED_CONFIG_KEY][normalizedRole] = {
    provider: normalized.provider,
    model: normalized.model,
  };
  if (normalized.normalized) {
    enqueueNormalizationNotice({
      key: `${SHARED_CONFIG_KEY}:${normalizedRole}:${normalized.reason}:write`,
      role: normalizedRole,
      sourceKey: SHARED_CONFIG_KEY,
      reason: normalized.reason,
      message: `Model config repaired for ${normalizedRole}: ${provider || 'unknown'} · ${model || 'unknown'} → ${normalized.provider} · ${normalized.model}.`,
    });
  }
  saveConfig(config);
}

/**
 * Clear all custom model config (revert to env var defaults).
 */
export function resetModelConfig() {
  localStorage.removeItem(STORAGE_KEY);
  NORMALIZATION_NOTICES.splice(0, NORMALIZATION_NOTICES.length);
}

/**
 * Get the globally active thinking mode.
 * @returns {'single'|'full'}
 */
export function getActiveThinkingMode() {
  try {
    const stored = localStorage.getItem(ACTIVE_MODE_KEY);
    return stored === 'full' ? 'full' : 'single';
  } catch { return 'single'; }
}

/**
 * Set the globally active thinking mode.
 * @param {'single'|'full'} mode
 */
export function setActiveThinkingMode(mode) {
  localStorage.setItem(ACTIVE_MODE_KEY, mode === 'full' ? 'full' : 'single');
}

export function consumeModelConfigNormalizationNotices() {
  const notices = NORMALIZATION_NOTICES.slice();
  NORMALIZATION_NOTICES.splice(0, NORMALIZATION_NOTICES.length);
  return notices;
}

// ── Chart Artisan model config ──────────────────────────────────────────────
// Stored separately from role-based configs. Supports "use_primary" mode
// which mirrors the primary model, or an explicit provider+model override.

const ARTISAN_CONFIG_KEY = 'di_artisan_model_config';
const ARTISAN_DEFAULT = { mode: 'use_primary' }; // { mode: 'use_primary' } | { mode: 'custom', provider, model }

/**
 * Get the artisan chart model config.
 * @returns {{ mode: 'use_primary' } | { mode: 'custom', provider: string, model: string }}
 */
export function getArtisanModelConfig() {
  try {
    const stored = JSON.parse(localStorage.getItem(ARTISAN_CONFIG_KEY));
    if (stored?.mode === 'custom' && stored.provider && stored.model) return stored;
    if (stored?.mode === 'use_primary') return { mode: 'use_primary' };
  } catch { /* ignore */ }
  return ARTISAN_DEFAULT;
}

/**
 * Resolve the effective provider+model for artisan chart generation.
 * If mode is 'use_primary', returns the current primary model config.
 * @returns {{ provider: string, model: string }}
 */
export function getResolvedArtisanModel() {
  const artisan = getArtisanModelConfig();
  if (artisan.mode === 'custom') {
    return { provider: artisan.provider, model: artisan.model };
  }
  return getSharedModelConfig('primary');
}

/**
 * Set artisan chart model to "same as primary".
 */
export function setArtisanUsePrimary() {
  localStorage.setItem(ARTISAN_CONFIG_KEY, JSON.stringify({ mode: 'use_primary' }));
}

/**
 * Set artisan chart model to a specific provider+model.
 */
export function setArtisanCustomModel(provider, model) {
  localStorage.setItem(ARTISAN_CONFIG_KEY, JSON.stringify({ mode: 'custom', provider, model }));
}

// ── Insights Hub Agent Model ──────────────────────────────────────────────────

const INSIGHTS_CONFIG_KEY = 'di_insights_hub_model_config';
const INSIGHTS_DEFAULT = { mode: 'auto', provider: 'gemini', model: 'gemini-2.0-flash' };

/**
 * Get the Insights Hub summary agent model config.
 * @returns {{ mode: 'auto', provider: string, model: string } | { mode: 'custom', provider: string, model: string }}
 */
export function getInsightsHubModelConfig() {
  try {
    const stored = JSON.parse(localStorage.getItem(INSIGHTS_CONFIG_KEY));
    if (stored?.mode === 'custom' && stored.provider && stored.model) return stored;
    if (stored?.mode === 'auto') return INSIGHTS_DEFAULT;
  } catch { /* ignore */ }
  return INSIGHTS_DEFAULT;
}

/**
 * Resolve the effective provider+model for Insights Hub summary agent.
 * @returns {{ provider: string, model: string }}
 */
export function getResolvedInsightsHubModel() {
  const config = getInsightsHubModelConfig();
  if (config.mode === 'custom') {
    return { provider: config.provider, model: config.model };
  }
  return { provider: INSIGHTS_DEFAULT.provider, model: INSIGHTS_DEFAULT.model };
}

/**
 * Set Insights Hub model to auto (Gemini Flash default).
 */
export function setInsightsHubAuto() {
  localStorage.setItem(INSIGHTS_CONFIG_KEY, JSON.stringify({ mode: 'auto' }));
}

/**
 * Set Insights Hub model to a specific provider+model.
 */
export function setInsightsHubCustomModel(provider, model) {
  localStorage.setItem(INSIGHTS_CONFIG_KEY, JSON.stringify({ mode: 'custom', provider, model }));
}
