import { describe, it, expect, vi } from 'vitest';
import { diagnoseStepFailure } from './errorDiagnosticService.js';

// Mock aiProxyService to avoid real LLM calls
vi.mock('../aiProxyService.js', () => ({
  invokeAiProxy: vi.fn(),
}));

const { invokeAiProxy } = await import('../ai-infra/aiProxyService.js');

describe('errorDiagnosticService', () => {
  const baseStep = { step_name: 'run_forecast', tool_type: 'builtin_tool', tool_hint: 'Run demand forecast' };

  describe('LLM diagnosis path', () => {
    it('returns LLM-parsed diagnosis when ai-proxy succeeds', async () => {
      invokeAiProxy.mockResolvedValueOnce({
        text: JSON.stringify({
          root_cause: 'The uploaded file has no demand_qty column required by the forecast engine.',
          category: 'data_missing',
          severity: 'needs_user_action',
          suggestions: [{ action: 'upload_data', detail: 'Add a demand_qty column to your spreadsheet.' }],
          confidence: 0.92,
        }),
      });

      const result = await diagnoseStepFailure({
        step: baseStep,
        errorMessage: "KeyError: 'demand_qty'",
        retryHistory: ['Previous error: KeyError: demand_qty'],
      });

      expect(result.source).toBe('llm');
      expect(result.root_cause).toContain('demand_qty');
      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0].action).toBe('upload_data');
      expect(result.confidence).toBeGreaterThan(0.9);
      expect(result.step_name).toBe('run_forecast');
    });

    it('handles LLM returning markdown-fenced JSON', async () => {
      invokeAiProxy.mockResolvedValueOnce({
        text: '```json\n{"root_cause":"API key expired","category":"api_error","severity":"critical","suggestions":[{"action":"configure_key","detail":"Renew the API key"}],"confidence":0.95}\n```',
      });

      const result = await diagnoseStepFailure({
        step: baseStep,
        errorMessage: '401 Unauthorized',
      });

      expect(result.source).toBe('llm');
      expect(result.root_cause).toBe('API key expired');
      expect(result.severity).toBe('critical');
    });

    it('truncates long root_cause to 500 chars', async () => {
      invokeAiProxy.mockResolvedValueOnce({
        text: JSON.stringify({
          root_cause: 'A'.repeat(600),
          category: 'unknown',
          severity: 'recoverable',
          suggestions: [],
          confidence: 0.5,
        }),
      });

      const result = await diagnoseStepFailure({ step: baseStep, errorMessage: 'test' });
      expect(result.root_cause.length).toBeLessThanOrEqual(500);
    });
  });

  describe('template fallback path', () => {
    it('falls back to template when LLM fails', async () => {
      invokeAiProxy.mockRejectedValueOnce(new Error('Network error'));

      const result = await diagnoseStepFailure({
        step: baseStep,
        errorMessage: "KeyError: 'demand_qty'",
      });

      expect(result.source).toBe('template');
      expect(result.category).toBe('code_generation_failed');
      expect(result.suggestions.length).toBeGreaterThan(0);
      expect(result.confidence).toBe(0.5);
    });

    it('falls back when LLM returns unparseable text', async () => {
      invokeAiProxy.mockResolvedValueOnce({ text: 'This is not JSON at all.' });

      const result = await diagnoseStepFailure({
        step: baseStep,
        errorMessage: 'timeout exceeded',
      });

      expect(result.source).toBe('template');
      expect(result.category).toBe('timeout');
    });

    it('classifies permission errors correctly', async () => {
      invokeAiProxy.mockRejectedValueOnce(new Error('timeout'));

      const result = await diagnoseStepFailure({
        step: { step_name: 'export_plan', tool_type: 'export' },
        errorMessage: 'PermissionDenied: lacks can_export for workflow',
      });

      expect(result.category).toBe('permission_denied');
      expect(result.severity).toBe('critical');
      expect(result.root_cause).toContain('permissions');
    });

    it('classifies data dependency errors correctly', async () => {
      invokeAiProxy.mockRejectedValueOnce(new Error('timeout'));

      const result = await diagnoseStepFailure({
        step: { step_name: 'run_plan', tool_type: 'builtin_tool' },
        errorMessage: 'datasetProfileRow is required but was not provided',
      });

      expect(result.category).toBe('data_dependency_missing');
      expect(result.suggestions.some(s => s.action === 'upload_data')).toBe(true);
    });

    it('classifies rate limit errors correctly', async () => {
      invokeAiProxy.mockRejectedValueOnce(new Error('timeout'));

      const result = await diagnoseStepFailure({
        step: baseStep,
        errorMessage: '429 Too Many Requests',
      });

      expect(result.category).toBe('rate_limited');
      expect(result.suggestions.some(s => s.action === 'wait_retry')).toBe(true);
    });
  });

  describe('4-gate error categories', () => {
    // Gate 1: Planner/LLM failures
    it('classifies tool_not_found errors (Gate 1)', async () => {
      invokeAiProxy.mockRejectedValueOnce(new Error('timeout'));
      const result = await diagnoseStepFailure({
        step: { step_name: 'run_analysis', tool_type: 'builtin_tool' },
        errorMessage: 'no executor found for tool "predict_future_sales"',
      });
      expect(result.category).toBe('tool_not_found');
      expect(result.severity).toBe('critical');
      expect(result.suggestions.some(s => s.action === 'simplify_request')).toBe(true);
    });

    it('classifies context_overflow errors (Gate 1)', async () => {
      invokeAiProxy.mockRejectedValueOnce(new Error('timeout'));
      const result = await diagnoseStepFailure({
        step: { step_name: 'synthesize_report' },
        errorMessage: 'context window exceeded: 128000 tokens, max 32000 tokens',
      });
      expect(result.category).toBe('context_overflow');
      expect(result.suggestions.some(s => s.action === 'reduce_data')).toBe(true);
    });

    // Gate 2: Orchestrator/HITL failures
    it('classifies dependency_chain_broken errors (Gate 2)', async () => {
      invokeAiProxy.mockRejectedValueOnce(new Error('timeout'));
      const result = await diagnoseStepFailure({
        step: { step_name: 'run_plan' },
        errorMessage: 'artifact from prior step "run_forecast" is null',
      });
      expect(result.category).toBe('dependency_chain_broken');
      expect(result.severity).toBe('critical');
    });

    // Gate 4: Infrastructure failures
    it('classifies sse_disconnected errors (Gate 4)', async () => {
      invokeAiProxy.mockRejectedValueOnce(new Error('timeout'));
      const result = await diagnoseStepFailure({
        step: { step_name: 'run_forecast' },
        errorMessage: 'EventSource connection closed unexpectedly',
      });
      expect(result.category).toBe('sse_disconnected');
      expect(result.severity).toBe('recoverable');
      expect(result.suggestions.some(s => s.action === 'retry')).toBe(true);
    });

    it('classifies edge_function_timeout errors (Gate 4)', async () => {
      invokeAiProxy.mockRejectedValueOnce(new Error('timeout'));
      const result = await diagnoseStepFailure({
        step: { step_name: 'call_ai_proxy' },
        errorMessage: 'Supabase Edge Function timeout after 60s',
      });
      expect(result.category).toBe('edge_function_timeout');
      expect(result.severity).toBe('recoverable');
      expect(result.suggestions.some(s => s.action === 'reduce_data')).toBe(true);
    });
  });

  describe('metadata fields', () => {
    it('includes step_name and retry_count', async () => {
      invokeAiProxy.mockRejectedValueOnce(new Error('fail'));

      const result = await diagnoseStepFailure({
        step: { step_name: 'generate_report' },
        errorMessage: 'unknown error',
        retryHistory: ['err1', 'err2'],
      });

      expect(result.step_name).toBe('generate_report');
      expect(result.retry_count).toBe(2);
      expect(result.error_snippet).toBe('unknown error');
      expect(typeof result.diagnosis_ms).toBe('number');
    });
  });
});
