/**
 * Model Configuration Service
 * Reads/writes chat agent model settings from localStorage.
 *
 * Three execution modes, each with independent model configs:
 *   - 'single'  — single agent only (no challenger, no judge)
 *   - 'dual'    — primary + challenger + judge (auto-triggered)
 *   - 'full'    — forced dual + judge on every message (thinking On)
 *
 * Falls back to env vars → hardcoded defaults.
 */

const STORAGE_KEY = 'di_model_config';
const ACTIVE_MODE_KEY = 'di_active_thinking_mode';

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

export const PROVIDER_MODELS = Object.freeze({
  openai:    ['gpt-5.4', 'gpt-5.4-thinking'],
  anthropic: ['claude-opus-4-6', 'claude-sonnet-4-6'],
  gemini:    ['gemini-3.1-pro-preview', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
  deepseek:  ['deepseek-chat', 'deepseek-reasoner'],
});

const ENV_DEFAULTS = {
  primary: {
    provider: import.meta.env.VITE_DI_CHAT_PROVIDER || 'openai',
    model:    import.meta.env.VITE_DI_CHAT_MODEL || 'gpt-5.4',
  },
  secondary: {
    provider: import.meta.env.VITE_DI_AGENT_SECONDARY_PROVIDER || 'anthropic',
    model:    import.meta.env.VITE_DI_AGENT_SECONDARY_MODEL || 'claude-opus-4-6',
  },
  judge: {
    provider: import.meta.env.VITE_DI_AGENT_QA_REVIEW_PROVIDER || 'gemini',
    model:    import.meta.env.VITE_DI_AGENT_QA_REVIEW_MODEL || 'gemini-3.1-pro-preview',
  },
};

const VALID_MODES = new Set(['single', 'dual', 'full']);

function loadConfig() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch { return {}; }
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

/**
 * Get effective provider+model for a role.
 * @param {'primary'|'secondary'|'judge'} role
 * @param {'single'|'dual'|'full'|'auto'} [mode]
 * @returns {{ provider: string, model: string }}
 */
export function getModelConfig(role, mode) {
  const effectiveMode = normalizeMode(mode || getActiveThinkingMode());
  const config = loadConfig();
  const modeConfig = config[effectiveMode] || {};
  const entry = modeConfig[role] || {};
  // Legacy flat format fallback (pre-mode migration)
  const legacyEntry = config[role] && typeof config[role].provider === 'string' ? config[role] : {};
  const defaults = ENV_DEFAULTS[role] || ENV_DEFAULTS.primary;
  return {
    provider: entry.provider || legacyEntry.provider || defaults.provider,
    model:    entry.model    || legacyEntry.model    || defaults.model,
  };
}

/**
 * Persist provider+model for a role within an execution mode.
 * @param {'primary'|'secondary'|'judge'} role
 * @param {string} provider
 * @param {string} model
 * @param {'single'|'dual'|'full'} [mode]
 */
export function setModelConfig(role, provider, model, mode) {
  const effectiveMode = normalizeMode(mode || getActiveThinkingMode());
  const config = loadConfig();
  if (!config[effectiveMode]) config[effectiveMode] = {};
  config[effectiveMode][role] = { provider, model };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

/**
 * Clear all custom model config (revert to env var defaults).
 */
export function resetModelConfig() {
  localStorage.removeItem(STORAGE_KEY);
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
