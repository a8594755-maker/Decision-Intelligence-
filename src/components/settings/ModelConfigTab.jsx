/**
 * ModelConfigTab.jsx
 *
 * Settings tab for configuring LLM provider & model per execution mode:
 *   Single Agent  — primary only
 *   Dual Agent    — primary + challenger + judge
 *   Full (On)     — forced dual + judge every message
 */

import { useState, useCallback } from 'react';
import { RotateCcw } from 'lucide-react';
import { Card } from '../ui';
import {
  EXECUTION_MODES,
  PROVIDER_MODELS,
  getModelConfig,
  setModelConfig,
  resetModelConfig,
  getActiveThinkingMode,
  setActiveThinkingMode,
} from '../../services/modelConfigService';

const ROLE_META = {
  single: [
    { key: 'primary', label: 'Agent', desc: 'The single agent that answers directly' },
  ],
  dual: [
    { key: 'primary', label: 'Primary Agent', desc: 'Main reasoning agent' },
    { key: 'secondary', label: 'Challenger Agent', desc: 'Runs in parallel with primary for comparison' },
    { key: 'judge', label: 'Judge / QA Review', desc: 'Evaluates both candidates and picks the winner' },
  ],
  full: [
    { key: 'primary', label: 'Primary Agent', desc: 'Main reasoning agent (always runs)' },
    { key: 'secondary', label: 'Challenger Agent', desc: 'Always runs in parallel with primary' },
    { key: 'judge', label: 'Judge / QA Review', desc: 'Always evaluates and picks the winner' },
  ],
};

const PROVIDER_OPTIONS = [
  { key: 'openai',    label: 'OpenAI' },
  { key: 'anthropic', label: 'Anthropic' },
  { key: 'gemini',    label: 'Gemini' },
  { key: 'deepseek',  label: 'DeepSeek' },
];

const PROVIDER_LABELS = Object.fromEntries(PROVIDER_OPTIONS.map((p) => [p.key, p.label]));
const providers = Object.keys(PROVIDER_MODELS);

function RoleCard({ role, config, onChange }) {
  const handleProviderChange = (e) => {
    const newProvider = e.target.value;
    const firstModel = PROVIDER_MODELS[newProvider][0];
    onChange(role.key, newProvider, firstModel);
  };

  const handleModelChange = (e) => {
    onChange(role.key, config.provider, e.target.value);
  };

  const models = PROVIDER_MODELS[config.provider] || [];

  return (
    <Card>
      <h3 className="font-semibold mb-1">{role.label}</h3>
      <p className="text-xs mb-4" style={{ color: 'var(--text-secondary)' }}>{role.desc}</p>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
            Provider
          </label>
          <select
            value={config.provider}
            onChange={handleProviderChange}
            className="w-full rounded-md border px-3 py-2 text-sm"
            style={{
              borderColor: 'var(--border-default)',
              backgroundColor: 'var(--bg-primary)',
              color: 'var(--text-primary)',
            }}
          >
            {providers.map((p) => (
              <option key={p} value={p}>{PROVIDER_LABELS[p] || p}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
            Model
          </label>
          <select
            value={config.model}
            onChange={handleModelChange}
            className="w-full rounded-md border px-3 py-2 text-sm"
            style={{
              borderColor: 'var(--border-default)',
              backgroundColor: 'var(--bg-primary)',
              color: 'var(--text-primary)',
            }}
          >
            {models.map((m) => (
              <option key={m} value={m}>
                {m}{(m === 'deepseek-reasoner' || m === 'gpt-5.4-thinking') ? ' (thinking/CoT)' : ''}
              </option>
            ))}
          </select>
        </div>
      </div>
    </Card>
  );
}

function loadConfigsForMode(mode) {
  const roles = ROLE_META[mode] || ROLE_META.single;
  const result = {};
  for (const role of roles) {
    result[role.key] = getModelConfig(role.key, mode);
  }
  return result;
}

const MODE_KEYS = ['single', 'dual', 'full'];

export default function ModelConfigTab() {
  const [selectedMode, setSelectedMode] = useState(() => {
    const active = getActiveThinkingMode();
    return active === 'full' ? 'full' : 'single';
  });
  const [configs, setConfigs] = useState(() => loadConfigsForMode(selectedMode));

  const handleModeSwitch = useCallback((mode) => {
    setSelectedMode(mode);
    setConfigs(loadConfigsForMode(mode));
    // Only persist global thinking mode for single vs full
    if (mode === 'full') setActiveThinkingMode('full');
    if (mode === 'single') setActiveThinkingMode('single');
  }, []);

  const handleChange = useCallback((role, provider, model) => {
    setModelConfig(role, provider, model, selectedMode);
    setConfigs((prev) => ({ ...prev, [role]: { provider, model } }));
  }, [selectedMode]);

  const handlePresetProvider = useCallback((providerKey) => {
    const topModel = PROVIDER_MODELS[providerKey]?.[0];
    if (!topModel) return;
    const roles = ROLE_META[selectedMode] || ROLE_META.single;
    const next = {};
    for (const role of roles) {
      setModelConfig(role.key, providerKey, topModel, selectedMode);
      next[role.key] = { provider: providerKey, model: topModel };
    }
    setConfigs(next);
  }, [selectedMode]);

  const handleReset = useCallback(() => {
    resetModelConfig();
    setConfigs(loadConfigsForMode(selectedMode));
  }, [selectedMode]);

  const roles = ROLE_META[selectedMode] || ROLE_META.single;
  const modeInfo = EXECUTION_MODES[selectedMode] || EXECUTION_MODES.single;

  // Detect if all visible roles use the same provider
  const roleProviders = roles.map((r) => configs[r.key]?.provider);
  const allSameProvider = roleProviders.length > 0 && roleProviders.every((p) => p === roleProviders[0]);
  const activePresetProvider = allSameProvider ? roleProviders[0] : null;

  return (
    <div className="space-y-4">
      {/* Execution mode tabs */}
      <Card>
        <h3 className="font-semibold mb-2">Execution Mode</h3>
        <p className="text-xs mb-3" style={{ color: 'var(--text-secondary)' }}>
          Each mode has its own provider & model settings.
        </p>
        <div className="flex gap-2">
          {MODE_KEYS.map((key) => {
            const mode = EXECUTION_MODES[key];
            return (
              <button
                key={key}
                onClick={() => handleModeSwitch(key)}
                className={`flex-1 px-4 py-2.5 text-sm font-medium rounded-lg border-2 transition-all ${
                  selectedMode === key
                    ? 'border-indigo-600 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300'
                    : 'border-transparent hover:border-stone-300 dark:hover:border-stone-600'
                }`}
                style={selectedMode !== key ? {
                  backgroundColor: 'var(--bg-secondary)',
                  color: 'var(--text-secondary)',
                } : undefined}
              >
                <div className="font-semibold">{mode.label}</div>
                <div className="text-xs mt-0.5 opacity-75">{mode.desc}</div>
              </button>
            );
          })}
        </div>
        {selectedMode === 'full' && (
          <div className="mt-3 px-3 py-2 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-200">
            Full mode always runs dual agent + judge on every message. Higher quality, more tokens.
          </div>
        )}
        {selectedMode === 'single' && (
          <div className="mt-3 px-3 py-2 rounded-md bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 text-xs text-emerald-800 dark:text-emerald-200">
            In Auto mode, when the system decides not to trigger dual generation, this model is used.
          </div>
        )}
        {selectedMode === 'dual' && (
          <div className="mt-3 px-3 py-2 rounded-md bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 text-xs text-blue-800 dark:text-blue-200">
            In Auto mode, when the system detects data analysis / coding / numeric reasoning, these models are used.
          </div>
        )}
      </Card>

      {/* Quick provider preset */}
      <Card>
        <h3 className="font-semibold mb-1">Provider</h3>
        <p className="text-xs mb-3" style={{ color: 'var(--text-secondary)' }}>
          {roles.length === 1
            ? 'Pick the provider for this mode.'
            : 'Pick a provider for all roles at once, or fine-tune per role below.'}
        </p>
        <div className="flex gap-2">
          {PROVIDER_OPTIONS.map((p) => (
            <button
              key={p.key}
              onClick={() => handlePresetProvider(p.key)}
              className={`flex-1 px-3 py-2 text-sm font-medium rounded-lg border-2 transition-all ${
                activePresetProvider === p.key
                  ? 'border-indigo-600 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300'
                  : 'border-transparent hover:border-stone-300 dark:hover:border-stone-600'
              }`}
              style={activePresetProvider !== p.key ? {
                backgroundColor: 'var(--bg-secondary)',
                color: 'var(--text-secondary)',
              } : undefined}
            >
              <div className="font-semibold">{p.label}</div>
              <div className="text-xs mt-0.5 opacity-60">{PROVIDER_MODELS[p.key]?.[0]}</div>
            </button>
          ))}
        </div>
        {!allSameProvider && roles.length > 1 && (
          <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
            Mixed providers — see per-role config below.
          </p>
        )}
      </Card>

      {/* Per-role fine-tuning */}
      {roles.length > 1 && (
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300">
            {modeInfo.label}
          </span>
          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            Per-role fine-tuning
          </span>
        </div>
      )}

      {roles.map((role) => (
        <RoleCard
          key={role.key}
          role={role}
          config={configs[role.key] || getModelConfig(role.key, selectedMode)}
          onChange={handleChange}
        />
      ))}

      <div className="flex items-center justify-between">
        <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          Changes take effect on next message. Each mode stores configs independently.
        </p>
        <button
          onClick={handleReset}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors"
          style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Reset All
        </button>
      </div>
    </div>
  );
}
