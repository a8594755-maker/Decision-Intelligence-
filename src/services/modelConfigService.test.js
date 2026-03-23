/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  consumeModelConfigNormalizationNotices,
  getActiveThinkingMode,
  getModelConfig,
  getModelConfigResolution,
  getSharedModelConfig,
  resetModelConfig,
  resolveProviderFromModel,
  setActiveThinkingMode,
  setModelConfig,
  setSharedModelConfig,
} from './modelConfigService.js';

describe('modelConfigService', () => {
  beforeEach(() => {
    localStorage.clear();
    resetModelConfig();
    setActiveThinkingMode('single');
  });

  it('uses shared primary config across all execution paths', () => {
    setSharedModelConfig('primary', 'anthropic', 'claude-opus-4-6');

    expect(getSharedModelConfig('primary')).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-6',
    });
    expect(getModelConfig('primary', 'single')).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-6',
    });
    expect(getModelConfig('primary', 'dual')).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-6',
    });
    expect(getModelConfig('primary', 'full')).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-6',
    });
  });

  it('defaults judge lookup to comparison config even when thinking mode is auto', () => {
    setModelConfig('judge', 'gemini', 'gemini-2.5-flash', 'dual');
    setActiveThinkingMode('single');

    expect(getActiveThinkingMode()).toBe('single');
    expect(getModelConfig('judge')).toEqual({
      provider: 'gemini',
      model: 'gemini-2.5-flash',
    });
  });

  it('falls back from full mode to legacy dual comparison config', () => {
    setModelConfig('secondary', 'deepseek', 'deepseek-reasoner', 'dual');

    expect(getModelConfig('secondary', 'full')).toEqual({
      provider: 'deepseek',
      model: 'deepseek-reasoner',
    });
  });

  it('reset clears both shared and legacy config overrides', () => {
    setSharedModelConfig('primary', 'anthropic', 'claude-opus-4-6');
    setModelConfig('judge', 'gemini', 'gemini-2.5-flash', 'dual');

    resetModelConfig();

    expect(getModelConfig('primary', 'single')).toEqual({
      provider: 'openai',
      model: 'gpt-5.4',
    });
    expect(getModelConfig('judge', 'dual')).toEqual({
      provider: 'gemini',
      model: 'gemini-3.1-pro-preview',
    });
  });

  it('repairs stale localStorage entries whose model does not belong to the configured provider', () => {
    localStorage.setItem('di_model_config', JSON.stringify({
      shared: {
        primary: {
          provider: 'deepseek',
          model: 'kimi-k2.5',
        },
      },
    }));

    expect(getModelConfig('primary', 'single')).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
    });
    expect(JSON.parse(localStorage.getItem('di_model_config'))).toEqual({
      shared: {
        primary: {
          provider: 'deepseek',
          model: 'deepseek-chat',
        },
      },
    });
    expect(consumeModelConfigNormalizationNotices()).toEqual([
      expect.objectContaining({
        role: 'primary',
        reason: 'invalid_model_for_provider',
      }),
    ]);
  });

  it('falls back to role defaults when provider is invalid', () => {
    localStorage.setItem('di_model_config', JSON.stringify({
      shared: {
        judge: {
          provider: 'not-a-provider',
          model: 'mystery-model',
        },
      },
    }));

    expect(getModelConfig('judge', 'dual')).toEqual({
      provider: 'gemini',
      model: 'gemini-3.1-pro-preview',
    });
    expect(consumeModelConfigNormalizationNotices()).toEqual([
      expect.objectContaining({
        role: 'judge',
        reason: 'invalid_provider',
      }),
    ]);
  });

  it('returns normalization metadata while keeping shared and legacy fallback behavior intact', () => {
    localStorage.setItem('di_model_config', JSON.stringify({
      dual: {
        secondary: {
          provider: 'openai',
          model: 'deepseek-reasoner',
        },
      },
    }));

    expect(getModelConfigResolution('secondary', 'full')).toEqual(expect.objectContaining({
      provider: 'openai',
      model: 'gpt-5.4',
      configNormalized: true,
      normalizationReason: 'invalid_model_for_provider',
      source: 'dual',
    }));
    expect(getSharedModelConfig('secondary')).toEqual({
      provider: 'openai',
      model: 'gpt-5.4',
    });
  });

  describe('resolveProviderFromModel', () => {
    it('corrects mismatched provider for a known model', () => {
      expect(resolveProviderFromModel('kimi-k2.5', 'deepseek')).toBe('kimi');
    });

    it('corrects deepseek model declared as openai', () => {
      expect(resolveProviderFromModel('deepseek-chat', 'openai')).toBe('deepseek');
    });

    it('returns declared provider when it matches the model', () => {
      expect(resolveProviderFromModel('gpt-5.4', 'openai')).toBe('openai');
      expect(resolveProviderFromModel('claude-opus-4-6', 'anthropic')).toBe('anthropic');
      expect(resolveProviderFromModel('gemini-3.1-pro-preview', 'gemini')).toBe('gemini');
      expect(resolveProviderFromModel('kimi-k2.5', 'kimi')).toBe('kimi');
    });

    it('trusts declared provider for unknown models', () => {
      expect(resolveProviderFromModel('my-custom-model-v3', 'openai')).toBe('openai');
      expect(resolveProviderFromModel('unknown-xyz', 'kimi')).toBe('kimi');
    });

    it('handles empty or null model gracefully', () => {
      expect(resolveProviderFromModel('', 'openai')).toBe('openai');
      expect(resolveProviderFromModel(null, 'gemini')).toBe('gemini');
      expect(resolveProviderFromModel(undefined, 'deepseek')).toBe('deepseek');
    });
  });
});
