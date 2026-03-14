import { describe, it, expect } from 'vitest';
import { classifyError, chooseHealingStrategy, analyzeStepFailure } from './selfHealingService';

// ── classifyError ────────────────────────────────────────────────────────────

describe('classifyError', () => {
  it('returns llm_unavailable for 503 / ECONNREFUSED', () => {
    expect(classifyError('Service unavailable (503)')).toBe('llm_unavailable');
    expect(classifyError('connect ECONNREFUSED 127.0.0.1')).toBe('llm_unavailable');
    expect(classifyError('Network error')).toBe('llm_unavailable');
  });

  it('returns rate_limited for 429 / rate limit', () => {
    expect(classifyError('429 Too Many Requests')).toBe('rate_limited');
    expect(classifyError('Rate limit exceeded')).toBe('rate_limited');
  });

  it('returns api_key_missing for auth errors', () => {
    expect(classifyError('API key invalid')).toBe('api_key_missing');
    expect(classifyError('Unauthorized (401)')).toBe('api_key_missing');
    expect(classifyError('403 Forbidden')).toBe('api_key_missing');
  });

  it('returns code_generation_failed for syntax/code errors', () => {
    expect(classifyError('SyntaxError: Unexpected token')).toBe('code_generation_failed');
    expect(classifyError('ReferenceError: foo is not defined')).toBe('code_generation_failed');
    expect(classifyError('TypeError: cannot read property x')).toBe('code_generation_failed');
    expect(classifyError('LLM code generation failed')).toBe('code_generation_failed');
  });

  it('returns timeout for timed out', () => {
    expect(classifyError('Execution timed out')).toBe('timeout');
    expect(classifyError('Script timeout after 30s')).toBe('timeout');
  });

  it('returns output_too_large for large output', () => {
    expect(classifyError('Output too large: 15000000 bytes')).toBe('output_too_large');
  });

  it('returns sandbox_error for worker errors', () => {
    expect(classifyError('Worker error: script failed')).toBe('sandbox_error');
  });

  it('returns unknown for unrecognized errors', () => {
    expect(classifyError('Something weird happened')).toBe('unknown');
    expect(classifyError('')).toBe('unknown');
    expect(classifyError(null)).toBe('unknown');
  });
});

// ── chooseHealingStrategy ────────────────────────────────────────────────────

describe('chooseHealingStrategy', () => {
  const baseStep = {
    name: 'analyze_data',
    workflow_type: 'dynamic_tool',
    tool_hint: 'Analyze the data',
    _revision_log: [],
    _revision_instructions: [],
    retry_count: 0,
  };

  it('returns escalate_model for provider unavailability', () => {
    const result = chooseHealingStrategy('503 Service Unavailable', baseStep, 0);
    expect(result.healingStrategy).toBe('escalate_model');
    expect(result.errorCategory).toBe('llm_unavailable');
  });

  it('returns escalate_model for rate limiting', () => {
    const result = chooseHealingStrategy('429 Too Many Requests', baseStep, 0);
    expect(result.healingStrategy).toBe('escalate_model');
    expect(result.errorCategory).toBe('rate_limited');
  });

  it('returns escalate_model for API key issues', () => {
    const result = chooseHealingStrategy('API key invalid or missing', baseStep, 0);
    expect(result.healingStrategy).toBe('escalate_model');
    expect(result.errorCategory).toBe('api_key_missing');
  });

  it('returns revise_prompt for code generation failures', () => {
    const result = chooseHealingStrategy('SyntaxError: Unexpected token', baseStep, 0);
    expect(result.healingStrategy).toBe('revise_prompt');
    expect(result.modifications.promptSuffix).toBeTruthy();
  });

  it('incorporates revision suggestions when available', () => {
    const stepWithReview = {
      ...baseStep,
      _revision_log: [{ suggestions: ['Use simpler array methods', 'Add null checks'] }],
    };
    const result = chooseHealingStrategy('TypeError: cannot read', stepWithReview, 0);
    expect(result.healingStrategy).toBe('revise_prompt');
    expect(result.modifications.promptSuffix).toContain('Use simpler array methods');
  });

  it('returns simplify_task for timeout', () => {
    const result = chooseHealingStrategy('Execution timed out', baseStep, 0);
    expect(result.healingStrategy).toBe('simplify_task');
    expect(result.modifications.simplifiedHint).toBeTruthy();
  });

  it('returns simplify_task for output too large', () => {
    const result = chooseHealingStrategy('Output too large: 20MB', baseStep, 0);
    expect(result.healingStrategy).toBe('simplify_task');
  });

  it('returns skip_with_fallback on last retry (retryCount >= 2)', () => {
    const result = chooseHealingStrategy('Any error', baseStep, 2);
    expect(result.healingStrategy).toBe('skip_with_fallback');
  });

  it('returns revise_prompt for unknown errors on first retry', () => {
    const result = chooseHealingStrategy('Something weird', baseStep, 0);
    expect(result.healingStrategy).toBe('revise_prompt');
  });

  it('returns escalate_model for unknown errors on second retry', () => {
    const result = chooseHealingStrategy('Something weird', baseStep, 1);
    expect(result.healingStrategy).toBe('escalate_model');
  });
});

// ── analyzeStepFailure (integration) ────────────────────────────────────────

describe('analyzeStepFailure', () => {
  it('accepts Error objects', () => {
    const step = { name: 'test', _revision_log: [], retry_count: 0 };
    const result = analyzeStepFailure(new Error('connect ECONNREFUSED'), step, 0);
    expect(result.errorCategory).toBe('llm_unavailable');
    expect(result.healingStrategy).toBe('escalate_model');
  });

  it('accepts string errors', () => {
    const step = { name: 'test', _revision_log: [], retry_count: 0 };
    const result = analyzeStepFailure('Rate limit exceeded', step, 0);
    expect(result.errorCategory).toBe('rate_limited');
  });

  it('includes reasoning string', () => {
    const step = { name: 'test', _revision_log: [], retry_count: 0 };
    const result = analyzeStepFailure('timeout', step, 0);
    expect(result.reasoning).toBeTruthy();
    expect(typeof result.reasoning).toBe('string');
  });
});
