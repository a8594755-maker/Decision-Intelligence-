/**
 * ModelConfigTab.jsx
 *
 * Simplified settings for model selection:
 *   - Thinking mode default (Auto / On)
 *   - Primary model
 *   - Advanced comparison path models (challenger + judge)
 */

import { useMemo, useState, useCallback } from 'react';
import { ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import { Card } from '../ui';
import {
  PROVIDER_MODELS,
  getSharedModelConfig,
  setSharedModelConfig,
  resetModelConfig,
  getActiveThinkingMode,
  setActiveThinkingMode,
} from '../../services/modelConfigService';

const ROLE_META = [
  {
    key: 'primary',
    label: 'Primary Model',
    desc: 'Used for the main answer. This is the default model for normal chat and analysis.',
  },
  {
    key: 'secondary',
    label: 'Challenger Model',
    desc: 'Used only when the system runs a second competing answer for comparison.',
  },
  {
    key: 'judge',
    label: 'Judge Model',
    desc: 'Used to review candidates and cross-check quality when comparison is active.',
  },
];

const PRIMARY_ROLE = ROLE_META[0];
const ADVANCED_ROLES = ROLE_META.slice(1);

const PROVIDER_OPTIONS = [
  { key: 'openai', label: 'OpenAI' },
  { key: 'anthropic', label: 'Anthropic' },
  { key: 'gemini', label: 'Gemini' },
  { key: 'deepseek', label: 'DeepSeek' },
  { key: 'kimi', label: 'Kimi (Moonshot)' },
];

const PROVIDER_LABELS = Object.fromEntries(PROVIDER_OPTIONS.map((provider) => [provider.key, provider.label]));
const providers = Object.keys(PROVIDER_MODELS);

function loadSharedConfigs() {
  return Object.fromEntries(ROLE_META.map((role) => [role.key, getSharedModelConfig(role.key)]));
}

function ThinkingModeButton({ active, title, description, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded-xl border px-4 py-3 text-left transition-all ${
        active
          ? 'border-indigo-600 bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300'
          : 'border-transparent hover:border-stone-300 dark:hover:border-stone-600'
      }`}
      style={active ? undefined : {
        backgroundColor: 'var(--bg-secondary)',
        color: 'var(--text-secondary)',
      }}
    >
      <div className="text-sm font-semibold">{title}</div>
      <div className="mt-1 text-xs opacity-80">{description}</div>
    </button>
  );
}

function RoleCard({ role, config, onChange }) {
  const handleProviderChange = (event) => {
    const nextProvider = event.target.value;
    const nextModel = PROVIDER_MODELS[nextProvider]?.[0] || '';
    onChange(role.key, nextProvider, nextModel);
  };

  const handleModelChange = (event) => {
    onChange(role.key, config.provider, event.target.value);
  };

  const models = PROVIDER_MODELS[config.provider] || [];

  return (
    <Card>
      <h3 className="font-semibold mb-1">{role.label}</h3>
      <p className="text-xs mb-4" style={{ color: 'var(--text-secondary)' }}>
        {role.desc}
      </p>

      <div className="grid gap-4 md:grid-cols-2">
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
            {providers.map((providerKey) => (
              <option key={providerKey} value={providerKey}>
                {PROVIDER_LABELS[providerKey] || providerKey}
              </option>
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
            {models.map((model) => (
              <option key={model} value={model}>
                {model}{(model === 'deepseek-reasoner' || model === 'gpt-5.4-thinking') ? ' (thinking/CoT)' : ''}
              </option>
            ))}
          </select>
        </div>
      </div>
    </Card>
  );
}

export default function ModelConfigTab() {
  const [thinkingMode, setThinkingMode] = useState(() => getActiveThinkingMode());
  const [configs, setConfigs] = useState(() => loadSharedConfigs());
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const handleThinkingModeChange = useCallback((mode) => {
    setActiveThinkingMode(mode);
    setThinkingMode(mode);
  }, []);

  const handleChange = useCallback((role, provider, model) => {
    setSharedModelConfig(role, provider, model);
    setConfigs((prev) => ({
      ...prev,
      [role]: { provider, model },
    }));
  }, []);

  const handleReset = useCallback(() => {
    resetModelConfig();
    setThinkingMode(getActiveThinkingMode());
    setConfigs(loadSharedConfigs());
  }, []);

  const advancedSummary = useMemo(() => {
    return ADVANCED_ROLES.map((role) => {
      const config = configs[role.key] || getSharedModelConfig(role.key);
      return `${role.label}: ${PROVIDER_LABELS[config.provider] || config.provider} · ${config.model}`;
    });
  }, [configs]);

  return (
    <div className="space-y-4">
      <Card>
        <h3 className="font-semibold mb-2">Thinking Mode Default</h3>
        <p className="text-xs mb-3" style={{ color: 'var(--text-secondary)' }}>
          Auto is the normal default. Turn Thinking On only if you want every message to force challenger + judge.
        </p>
        <div className="flex gap-2">
          <ThinkingModeButton
            active={thinkingMode !== 'full'}
            title="Auto"
            description="Recommended. The system decides when comparison and judging are worth the extra cost."
            onClick={() => handleThinkingModeChange('single')}
          />
          <ThinkingModeButton
            active={thinkingMode === 'full'}
            title="On"
            description="Always run challenger + judge. Higher quality, slower, and uses more tokens."
            onClick={() => handleThinkingModeChange('full')}
          />
        </div>
      </Card>

      <RoleCard
        role={PRIMARY_ROLE}
        config={configs.primary || getSharedModelConfig('primary')}
        onChange={handleChange}
      />

      <Card>
        <button
          type="button"
          onClick={() => setAdvancedOpen((value) => !value)}
          className="flex w-full items-start gap-3 text-left"
        >
          <div className="pt-0.5 text-slate-400">
            {advancedOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-semibold">Advanced Comparison Models</div>
            <p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
              Challenger and judge are only used when the system escalates to multi-agent comparison, or when Thinking On is enabled.
            </p>
          </div>
        </button>

        {!advancedOpen ? (
          <div className="mt-4 space-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
            {advancedSummary.map((line) => (
              <div key={line}>{line}</div>
            ))}
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            {ADVANCED_ROLES.map((role) => (
              <RoleCard
                key={role.key}
                role={role}
                config={configs[role.key] || getSharedModelConfig(role.key)}
                onChange={handleChange}
              />
            ))}
          </div>
        )}
      </Card>

      <div className="flex items-center justify-between">
        <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          Changes take effect on the next message.
        </p>
        <button
          type="button"
          onClick={handleReset}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors"
          style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Reset
        </button>
      </div>
    </div>
  );
}
