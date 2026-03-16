// @product: ai-employee
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock supabaseClient before importing the service
vi.mock('./supabaseClient', () => ({ supabase: null }));

import {
  CAPABILITY_TIERS,
  resolveModel,
  recordModelRun,
  getTaskCostSummary,
  listModels,
  getPolicy,
  invalidateModelCache,
} from './modelRoutingService';

beforeEach(() => {
  invalidateModelCache();
});

// ── CAPABILITY_TIERS ────────────────────────────────────────────────────────

describe('CAPABILITY_TIERS', () => {
  it('has three tiers', () => {
    expect(CAPABILITY_TIERS.TIER_A).toBe('tier_a');
    expect(CAPABILITY_TIERS.TIER_B).toBe('tier_b');
    expect(CAPABILITY_TIERS.TIER_C).toBe('tier_c');
  });
});

// ── listModels ──────────────────────────────────────────────────────────────

describe('listModels', () => {
  it('returns default models when Supabase is unavailable', async () => {
    const models = await listModels();
    expect(models.length).toBeGreaterThanOrEqual(9);
    expect(models.every((m) => m.provider && m.model_name && m.capability_tier)).toBe(true);
  });

  it('filters by tier', async () => {
    const tierA = await listModels({ tier: 'tier_a' });
    expect(tierA.length).toBeGreaterThan(0);
    expect(tierA.every((m) => m.capability_tier === 'tier_a')).toBe(true);
  });

  it('filters by provider', async () => {
    const deepseek = await listModels({ provider: 'deepseek' });
    expect(deepseek.length).toBeGreaterThan(0);
    expect(deepseek.every((m) => m.provider === 'deepseek')).toBe(true);
  });
});

// ── getPolicy ───────────────────────────────────────────────────────────────

describe('getPolicy', () => {
  it('returns policy for known task types', async () => {
    const policy = await getPolicy('forecast');
    expect(policy.preferred_tier).toBe('tier_c');
    expect(policy.fallback_tier).toBe('tier_b');
    expect(policy.escalation_rules.on_failure).toBe('tier_a');
  });

  it('returns default for unknown task type', async () => {
    const policy = await getPolicy('unknown_type');
    expect(policy.preferred_tier).toBe('tier_c');
    expect(policy.escalation_rules).toEqual({});
  });

  it('task_decomposition defaults to tier_a', async () => {
    const policy = await getPolicy('task_decomposition');
    expect(policy.preferred_tier).toBe('tier_a');
  });
});

// ── resolveModel ────────────────────────────────────────────────────────────

describe('resolveModel', () => {
  it('returns cheapest tier_c model for forecast by default', async () => {
    const { provider, model, tier, escalated } = await resolveModel('forecast');
    expect(tier).toBe('tier_c');
    expect(escalated).toBe(false);
    expect(provider).toBeTruthy();
    expect(model).toBeTruthy();
  });

  it('returns tier_a model for task_decomposition', async () => {
    const { tier } = await resolveModel('task_decomposition');
    expect(tier).toBe('tier_a');
  });

  it('escalates on retry (on_failure)', async () => {
    const { tier, escalated, escalatedFrom } = await resolveModel('forecast', { retryCount: 1 });
    expect(tier).toBe('tier_a');
    expect(escalated).toBe(true);
    expect(escalatedFrom).toBe('tier_c');
  });

  it('escalates on high risk', async () => {
    const { tier, escalated } = await resolveModel('plan', { highRisk: true });
    expect(tier).toBe('tier_a');
    expect(escalated).toBe(true);
  });

  it('escalates on low confidence', async () => {
    const { tier, escalated } = await resolveModel('forecast', { confidence: 0.3 });
    expect(tier).toBe('tier_b');
    expect(escalated).toBe(true);
  });

  it('does not escalate when confidence is adequate', async () => {
    const { tier, escalated } = await resolveModel('forecast', { confidence: 0.8 });
    expect(tier).toBe('tier_c');
    expect(escalated).toBe(false);
  });

  it('escalates based on memory context with low success rate', async () => {
    const { tier, escalated } = await resolveModel('forecast', {
      memoryContext: { has_prior_experience: true, success_rate: 30 },
    });
    expect(escalated).toBe(true);
    // Should escalate to at least tier_b or tier_a
    expect(['tier_a', 'tier_b']).toContain(tier);
  });

  it('does not escalate when memory shows good success rate', async () => {
    const { tier, escalated } = await resolveModel('forecast', {
      memoryContext: { has_prior_experience: true, success_rate: 90 },
    });
    expect(tier).toBe('tier_c');
    expect(escalated).toBe(false);
  });

  it('respects preferredProvider hint', async () => {
    // anthropic has claude-sonnet-4-6 in tier_b; 'report' resolves to tier_b with no pinned model
    const { provider } = await resolveModel('report', { preferredProvider: 'anthropic' });
    expect(provider).toBe('anthropic');
  });

  it('synthesize stays at tier_c with no escalation rules', async () => {
    const { tier, escalated } = await resolveModel('synthesize');
    expect(tier).toBe('tier_c');
    expect(escalated).toBe(false);
  });

  it('picks highest escalation when multiple triggers fire', async () => {
    // retryCount triggers on_failure→tier_a, confidence triggers on_low_confidence→tier_b
    // tier_a should win (lower rank = more capable)
    const { tier } = await resolveModel('forecast', { retryCount: 1, confidence: 0.3 });
    expect(tier).toBe('tier_a');
  });
});

// ── recordModelRun ──────────────────────────────────────────────────────────

describe('recordModelRun', () => {
  it('records a model run with estimated cost (localStorage fallback)', async () => {
    const entry = await recordModelRun({
      taskId: 'task-1',
      runId: 'run-1',
      employeeId: 'emp-1',
      agentRole: 'executor',
      provider: 'deepseek',
      modelName: 'deepseek-chat',
      tier: 'tier_c',
      inputTokens: 1000,
      outputTokens: 500,
      latencyMs: 1200,
      stepName: 'forecast',
    });

    expect(entry.id).toBeTruthy();
    expect(entry.model_provider).toBe('deepseek');
    expect(entry.model_name).toBe('deepseek-chat');
    expect(entry.input_tokens).toBe(1000);
    expect(entry.output_tokens).toBe(500);
    expect(entry.estimated_cost).toBeGreaterThan(0);
    expect(entry.estimated_cost).toBeLessThan(0.01); // deepseek-chat is cheap
  });

  it('handles unknown model gracefully (zero cost)', async () => {
    const entry = await recordModelRun({
      taskId: 'task-2',
      employeeId: 'emp-1',
      provider: 'unknown',
      modelName: 'unknown-model',
      tier: 'tier_c',
      inputTokens: 5000,
      outputTokens: 2000,
    });
    expect(entry.estimated_cost).toBe(0);
  });
});

// ── getTaskCostSummary ──────────────────────────────────────────────────────

describe('getTaskCostSummary', () => {
  it('returns zero summary for unknown task (no Supabase, no localStorage in node)', async () => {
    const summary = await getTaskCostSummary('nonexistent');
    expect(summary.total_cost).toBe(0);
    expect(summary.calls).toBe(0);
    expect(summary.by_tier).toEqual({});
  });
});

describe('recordModelRun', () => {
  it('computes estimated cost from model registry pricing', async () => {
    // deepseek-chat: input=0.00007/1k, output=0.0011/1k
    const entry = await recordModelRun({
      taskId: 'task-cost',
      employeeId: 'emp-1',
      provider: 'deepseek',
      modelName: 'deepseek-chat',
      tier: 'tier_c',
      inputTokens: 10000,  // 10 * 0.00007 = 0.0007
      outputTokens: 5000,  // 5 * 0.0011  = 0.0055
    });
    // Total should be ~0.0062
    expect(entry.estimated_cost).toBeCloseTo(0.0062, 4);
  });

  it('records escalation metadata', async () => {
    const entry = await recordModelRun({
      taskId: 'task-esc',
      employeeId: 'emp-1',
      agentRole: 'executor',
      provider: 'gemini',
      modelName: 'gemini-3.1-pro-preview',
      tier: 'tier_a',
      inputTokens: 1000,
      outputTokens: 500,
      escalatedFrom: 'tier_c',
      stepName: 'forecast',
    });
    expect(entry.escalated_from).toBe('tier_c');
    expect(entry.step_name).toBe('forecast');
    expect(entry.agent_role).toBe('executor');
  });
});
