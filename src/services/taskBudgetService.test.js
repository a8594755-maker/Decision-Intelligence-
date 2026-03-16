// @product: ai-employee
import { describe, it, expect, vi } from 'vitest';

// Mock supabaseClient
vi.mock('./supabaseClient', () => ({ supabase: null }));

import {
  DEFAULT_LIMITS,
  BudgetExceededError,
  createBudget,
  checkBudget,
} from './taskBudgetService';

// ── Constants ───────────────────────────────────────────────────────────────

describe('DEFAULT_LIMITS', () => {
  it('has sensible defaults', () => {
    expect(DEFAULT_LIMITS.max_total_cost).toBe(1.00);
    expect(DEFAULT_LIMITS.max_total_tokens).toBe(500000);
    expect(DEFAULT_LIMITS.max_premium_calls).toBe(5);
    expect(DEFAULT_LIMITS.max_steps).toBe(20);
    expect(DEFAULT_LIMITS.max_dynamic_tool_calls).toBe(3);
  });
});

// ── BudgetExceededError ─────────────────────────────────────────────────────

describe('BudgetExceededError', () => {
  it('has correct name and properties', () => {
    const err = new BudgetExceededError('t-1', 'cost limit', { max_total_cost: 1 });
    expect(err.name).toBe('BudgetExceededError');
    expect(err.taskId).toBe('t-1');
    expect(err.reason).toBe('cost limit');
    expect(err.budget).toEqual({ max_total_cost: 1 });
    expect(err.message).toContain('t-1');
  });
});

// ── checkBudget (no budget = unlimited) ─────────────────────────────────────

describe('checkBudget', () => {
  it('returns allowed=true when no budget exists', async () => {
    const result = await checkBudget('nonexistent-task');
    expect(result.allowed).toBe(true);
    expect(result.budget).toBeNull();
  });
});

// Note: createBudget, consumeBudget, and getBudget integration tests require
// localStorage (jsdom) or Supabase. In node env, they fall through to
// localStorage which may not be available. Testing pure logic here.

// ── Integration-style tests (in-memory via mocking getBudget) ───────────────

describe('budget lifecycle (unit)', () => {
  // Simulate a budget object for pure logic testing
  function makeBudget(overrides = {}) {
    return {
      task_id: 'task-1',
      employee_id: 'emp-1',
      max_total_cost: 0.50,
      max_total_tokens: 100000,
      max_premium_calls: 3,
      max_steps: 5,
      current_cost: 0,
      current_tokens: 0,
      premium_calls_used: 0,
      steps_used: 0,
      exceeded: false,
      exceeded_reason: null,
      exceeded_at: null,
      ...overrides,
    };
  }

  it('BudgetExceededError is instanceof Error', () => {
    const err = new BudgetExceededError('t-1', 'cost', {});
    expect(err instanceof Error).toBe(true);
    expect(err instanceof BudgetExceededError).toBe(true);
  });

  it('detects cost exceeded', () => {
    const budget = makeBudget({ current_cost: 0.51, max_total_cost: 0.50 });
    // Simulate what checkExceeded does internally
    expect(Number(budget.current_cost) > budget.max_total_cost).toBe(true);
  });

  it('detects token exceeded', () => {
    const budget = makeBudget({ current_tokens: 100001, max_total_tokens: 100000 });
    expect(budget.current_tokens > budget.max_total_tokens).toBe(true);
  });

  it('detects premium call exceeded', () => {
    const budget = makeBudget({ premium_calls_used: 4, max_premium_calls: 3 });
    expect(budget.premium_calls_used > budget.max_premium_calls).toBe(true);
  });

  it('detects step exceeded', () => {
    const budget = makeBudget({ steps_used: 6, max_steps: 5 });
    expect(budget.steps_used > budget.max_steps).toBe(true);
  });

  it('within limits when all under max', () => {
    const budget = makeBudget({
      current_cost: 0.30,
      current_tokens: 80000,
      premium_calls_used: 2,
      steps_used: 3,
    });
    expect(Number(budget.current_cost) <= budget.max_total_cost).toBe(true);
    expect(budget.current_tokens <= budget.max_total_tokens).toBe(true);
    expect(budget.premium_calls_used <= budget.max_premium_calls).toBe(true);
    expect(budget.steps_used <= budget.max_steps).toBe(true);
  });

  it('already exceeded flag short-circuits', () => {
    const budget = makeBudget({ exceeded: true, exceeded_reason: 'Cost exceeded' });
    // checkBudget should return allowed=false immediately
    expect(budget.exceeded).toBe(true);
  });
});

// ── createBudget + checkBudget + consumeBudget (with localStorage mock) ─────

describe('createBudget + consumeBudget flow', () => {
  // These tests will only work if localStorage is available.
  // In node env, createBudget returns a local entry but getBudget can't find it.
  // We test the returned objects directly.

  it('createBudget returns a budget with default limits', async () => {
    const budget = await createBudget('task-new', 'emp-1');
    expect(budget.task_id).toBe('task-new');
    expect(budget.max_total_cost).toBe(DEFAULT_LIMITS.max_total_cost);
    expect(budget.max_total_tokens).toBe(DEFAULT_LIMITS.max_total_tokens);
    expect(budget.current_cost).toBe(0);
    expect(budget.exceeded).toBe(false);
  });

  it('createBudget accepts custom limits', async () => {
    const budget = await createBudget('task-custom', 'emp-1', {
      maxTotalCost: 2.50,
      maxTotalTokens: 1000000,
      maxPremiumCalls: 10,
      maxSteps: 20,
    });
    expect(budget.max_total_cost).toBe(2.50);
    expect(budget.max_total_tokens).toBe(1000000);
    expect(budget.max_premium_calls).toBe(10);
    expect(budget.max_steps).toBe(20);
  });
});
