/**
 * stepPipeline.test.js — Tests for the composable gate pipeline.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock the real gate imports to avoid pulling in eventBus/supabase/etc.
vi.mock('./datasetGate.js', () => ({ datasetGate: vi.fn() }));
vi.mock('./budgetGate.js', () => ({ budgetGate: vi.fn() }));
vi.mock('./capabilityPolicyGate.js', () => ({ capabilityPolicyGate: vi.fn() }));
vi.mock('./toolPermissionGate.js', () => ({ toolPermissionGate: vi.fn() }));
vi.mock('./governanceRulesGate.js', () => ({ governanceRulesGate: vi.fn() }));
vi.mock('./approvalGate.js', () => ({ publishApprovalGate: vi.fn() }));
vi.mock('./contextResolvers.js', () => ({
  priorArtifactsResolver: vi.fn(),
  styleContextResolver: vi.fn(),
  memoryRecallResolver: vi.fn(),
  datasetProfileResolver: vi.fn(),
  lazyContextResolver: vi.fn(),
}));

import { runGatePipeline, buildStepContext } from './stepPipeline.js';

// ── Helpers ──

function makeTask(overrides = {}) {
  return {
    id: 'task-1',
    employee_id: 'emp-1',
    title: 'Test Task',
    description: 'desc',
    status: 'in_progress',
    version: 1,
    input_context: { inputData: { userId: 'u1' } },
    plan_snapshot: {
      steps: [
        { name: 'step_a', tool_type: 'python_tool', requires_dataset: false },
        { name: 'step_b', tool_type: 'builtin_tool', builtin_tool_id: 'forecast', requires_dataset: true },
      ],
      llmConfig: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    },
    ...overrides,
  };
}

function makeStep(overrides = {}) {
  return {
    id: 'step-1',
    step_index: 0,
    step_name: 'step_a',
    status: 'pending',
    retry_count: 0,
    ...overrides,
  };
}

// ── Tests ──

describe('buildStepContext', () => {
  it('builds a context object from task + step', () => {
    const task = makeTask();
    const step = makeStep();
    const ctx = buildStepContext(task, step);

    expect(ctx.task).toBe(task);
    expect(ctx.step).toBe(step);
    expect(ctx.stepDef).toEqual(task.plan_snapshot.steps[0]);
    expect(ctx.inputData).toEqual({ userId: 'u1' });
    expect(ctx.styleContext).toBeNull();
    expect(ctx.outputProfile).toBeNull();
    expect(ctx.memoryContext).toBeNull();
    expect(ctx.priorArtifacts).toEqual({});
    expect(ctx.priorStepResults).toEqual([]);
  });

  it('handles missing plan_snapshot gracefully', () => {
    const task = makeTask({ plan_snapshot: null });
    const step = makeStep();
    const ctx = buildStepContext(task, step);

    expect(ctx.stepDef).toEqual({});
    expect(ctx.planSnapshot).toEqual({});
  });
});

describe('runGatePipeline', () => {
  it('runs all gates when all pass', async () => {
    const gates = [
      { name: 'gate_a', fn: vi.fn(async () => ({ pass: true })), hard: true },
      { name: 'gate_b', fn: vi.fn(async () => ({ pass: true })), hard: false },
      { name: 'gate_c', fn: vi.fn(async () => ({ pass: true })), hard: false },
    ];

    const ctx = buildStepContext(makeTask(), makeStep());
    const result = await runGatePipeline(ctx, gates);

    expect(result.passed).toBe(true);
    expect(result.degraded).toEqual([]);
    expect(gates[0].fn).toHaveBeenCalledOnce();
    expect(gates[1].fn).toHaveBeenCalledOnce();
    expect(gates[2].fn).toHaveBeenCalledOnce();
  });

  it('stops at first blocking gate', async () => {
    const gates = [
      { name: 'gate_a', fn: vi.fn(async () => ({ pass: true })), hard: true },
      { name: 'gate_b', fn: vi.fn(async () => ({ pass: false, action: 'skipped', error: 'budget gone' })), hard: false },
      { name: 'gate_c', fn: vi.fn(async () => ({ pass: true })), hard: false },
    ];

    const ctx = buildStepContext(makeTask(), makeStep());
    const result = await runGatePipeline(ctx, gates);

    expect(result.passed).toBe(false);
    expect(result.gateName).toBe('gate_b');
    expect(result.result.action).toBe('skipped');
    expect(result.result.error).toBe('budget gone');
    // gate_c should NOT have run
    expect(gates[2].fn).not.toHaveBeenCalled();
  });

  it('treats soft gate errors as degraded (non-blocking)', async () => {
    const gates = [
      { name: 'gate_a', fn: vi.fn(async () => ({ pass: true })), hard: false },
      { name: 'gate_b', fn: vi.fn(async () => { throw new Error('service down'); }), hard: false },
      { name: 'gate_c', fn: vi.fn(async () => ({ pass: true })), hard: false },
    ];

    const ctx = buildStepContext(makeTask(), makeStep());
    const result = await runGatePipeline(ctx, gates);

    expect(result.passed).toBe(true);
    expect(result.degraded).toEqual(['gate_b']);
    // gate_c still runs
    expect(gates[2].fn).toHaveBeenCalledOnce();
  });

  it('treats hard gate errors as blocking', async () => {
    const gates = [
      { name: 'critical_gate', fn: vi.fn(async () => { throw new Error('fatal'); }), hard: true },
      { name: 'gate_b', fn: vi.fn(async () => ({ pass: true })), hard: false },
    ];

    const ctx = buildStepContext(makeTask(), makeStep());
    const result = await runGatePipeline(ctx, gates);

    expect(result.passed).toBe(false);
    expect(result.gateName).toBe('critical_gate');
    expect(result.result.action).toBe('skipped');
    expect(result.result.error).toContain('fatal');
    // gate_b should NOT run
    expect(gates[1].fn).not.toHaveBeenCalled();
  });

  it('gates can mutate context (enrichment)', async () => {
    const enrichGate = vi.fn(async (ctx) => {
      ctx.styleContext = { tone: 'formal' };
      ctx.memoryContext = 'Relevant past memory';
      return { pass: true };
    });

    const gates = [
      { name: 'enrich', fn: enrichGate, hard: false },
    ];

    const ctx = buildStepContext(makeTask(), makeStep());
    expect(ctx.styleContext).toBeNull();

    await runGatePipeline(ctx, gates);

    expect(ctx.styleContext).toEqual({ tone: 'formal' });
    expect(ctx.memoryContext).toBe('Relevant past memory');
  });

  it('handles empty pipeline', async () => {
    const ctx = buildStepContext(makeTask(), makeStep());
    const result = await runGatePipeline(ctx, []);

    expect(result.passed).toBe(true);
    expect(result.degraded).toEqual([]);
  });

  it('returns review_hold action from gate', async () => {
    const gates = [
      { name: 'cap', fn: vi.fn(async () => ({ pass: false, action: 'review_hold', error: 'needs manager' })), hard: false },
    ];

    const ctx = buildStepContext(makeTask(), makeStep());
    const result = await runGatePipeline(ctx, gates);

    expect(result.passed).toBe(false);
    expect(result.result.action).toBe('review_hold');
  });

  it('accumulates multiple degraded gates', async () => {
    const gates = [
      { name: 'a', fn: vi.fn(async () => { throw new Error('a down'); }), hard: false },
      { name: 'b', fn: vi.fn(async () => { throw new Error('b down'); }), hard: false },
      { name: 'c', fn: vi.fn(async () => ({ pass: true })), hard: false },
    ];

    const ctx = buildStepContext(makeTask(), makeStep());
    const result = await runGatePipeline(ctx, gates);

    expect(result.passed).toBe(true);
    expect(result.degraded).toEqual(['a', 'b']);
  });
});
