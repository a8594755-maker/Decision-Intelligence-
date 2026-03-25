import { describe, it, expect } from 'vitest';
import {
  transition, canTransition, isTerminal, isRunnable,
  computeBackoff, initStepState, serializeStep,
  STEP_STATE, STEP_EVENT, EFFECT,
} from './stepStateMachine';

describe('stepStateMachine', () => {
  const makeStep = (overrides = {}) => ({
    state: STEP_STATE.INIT,
    name: 'test_step',
    index: 0,
    workflow_type: 'python_tool',
    retry_count: 0,
    ...overrides,
  });

  describe('transition()', () => {
    it('INIT → START → PENDING', () => {
      const step = makeStep();
      const { step: next, effects } = transition(step, STEP_EVENT.START);
      expect(next.state).toBe(STEP_STATE.PENDING);
      expect(effects.some(e => e.type === EFFECT.PERSIST)).toBe(true);
    });

    it('PENDING → EXECUTE → RUNNING', () => {
      const step = makeStep({ state: STEP_STATE.PENDING });
      const { step: next, effects } = transition(step, STEP_EVENT.EXECUTE);
      expect(next.state).toBe(STEP_STATE.RUNNING);
      expect(effects.some(e => e.type === EFFECT.EXECUTE_STEP)).toBe(true);
    });

    it('RUNNING → COMPLETE → SUCCEEDED (no review)', () => {
      const step = makeStep({ state: STEP_STATE.RUNNING });
      const { step: next } = transition(step, STEP_EVENT.COMPLETE, { requires_review: false });
      expect(next.state).toBe(STEP_STATE.SUCCEEDED);
    });

    it('RUNNING → COMPLETE → REVIEW (with review)', () => {
      const step = makeStep({ state: STEP_STATE.RUNNING });
      const { step: next } = transition(step, STEP_EVENT.COMPLETE, { requires_review: true });
      expect(next.state).toBe(STEP_STATE.REVIEW);
    });

    it('RUNNING → FAIL → RETRY_WAIT (retries remaining)', () => {
      const step = makeStep({ state: STEP_STATE.RUNNING, retry_count: 0 });
      const { step: next, effects } = transition(step, STEP_EVENT.FAIL, { error: 'timeout', max_retries: 3 });
      expect(next.state).toBe(STEP_STATE.RETRY_WAIT);
      expect(next.retry_count).toBe(1);
      expect(next.backoff_ms).toBeGreaterThan(0);
      expect(next.last_error).toBe('timeout');
      expect(effects.some(e => e.type === EFFECT.WAIT_BACKOFF)).toBe(true);
    });

    it('RUNNING → FAIL → BLOCKED (max retries exceeded)', () => {
      const step = makeStep({ state: STEP_STATE.RUNNING, retry_count: 3 });
      const { step: next } = transition(step, STEP_EVENT.FAIL, { max_retries: 3 });
      expect(next.state).toBe(STEP_STATE.BLOCKED);
      expect(next.retry_count).toBe(4);
    });

    it('REVIEW → REVIEW_PASS → SUCCEEDED', () => {
      const step = makeStep({ state: STEP_STATE.REVIEW });
      const { step: next } = transition(step, STEP_EVENT.REVIEW_PASS);
      expect(next.state).toBe(STEP_STATE.SUCCEEDED);
    });

    it('REVIEW → REVIEW_FAIL → REVISION', () => {
      const step = makeStep({ state: STEP_STATE.REVIEW });
      const { step: next } = transition(step, STEP_EVENT.REVIEW_FAIL, {
        revision_instructions: ['fix column names'],
      });
      expect(next.state).toBe(STEP_STATE.REVISION);
      expect(next.revision_instructions).toEqual(['fix column names']);
    });

    it('REVISION → EXECUTE → RUNNING', () => {
      const step = makeStep({ state: STEP_STATE.REVISION });
      const { step: next } = transition(step, STEP_EVENT.EXECUTE);
      expect(next.state).toBe(STEP_STATE.RUNNING);
    });

    it('RETRY_WAIT → RETRY → RUNNING', () => {
      const step = makeStep({ state: STEP_STATE.RETRY_WAIT });
      const { step: next } = transition(step, STEP_EVENT.RETRY);
      expect(next.state).toBe(STEP_STATE.RUNNING);
    });

    it('invalid transition returns original step with LOG effect', () => {
      const step = makeStep({ state: STEP_STATE.SUCCEEDED });
      const { step: next, effects } = transition(step, STEP_EVENT.EXECUTE);
      expect(next.state).toBe(STEP_STATE.SUCCEEDED); // unchanged
      expect(effects[0].type).toBe(EFFECT.LOG);
    });

    it('INIT → SKIP → SKIPPED', () => {
      const step = makeStep();
      const { step: next } = transition(step, STEP_EVENT.SKIP);
      expect(next.state).toBe(STEP_STATE.SKIPPED);
    });

    it('sets updated_at on transition', () => {
      const step = makeStep({ updated_at: 1000 });
      const { step: next } = transition(step, STEP_EVENT.START);
      expect(next.updated_at).toBeGreaterThan(1000);
    });
  });

  describe('canTransition()', () => {
    it('returns true for valid transitions', () => {
      expect(canTransition(makeStep(), STEP_EVENT.START)).toBe(true);
      expect(canTransition(makeStep({ state: STEP_STATE.PENDING }), STEP_EVENT.EXECUTE)).toBe(true);
    });

    it('returns false for invalid transitions', () => {
      expect(canTransition(makeStep({ state: STEP_STATE.SUCCEEDED }), STEP_EVENT.EXECUTE)).toBe(false);
      expect(canTransition(makeStep({ state: STEP_STATE.BLOCKED }), STEP_EVENT.RETRY)).toBe(false);
    });
  });

  describe('isTerminal()', () => {
    it('terminal states', () => {
      expect(isTerminal({ state: STEP_STATE.SUCCEEDED })).toBe(true);
      expect(isTerminal({ state: STEP_STATE.BLOCKED })).toBe(true);
      expect(isTerminal({ state: STEP_STATE.SKIPPED })).toBe(true);
      expect(isTerminal({ state: STEP_STATE.FAILED })).toBe(true);
    });

    it('non-terminal states', () => {
      expect(isTerminal({ state: STEP_STATE.RUNNING })).toBe(false);
      expect(isTerminal({ state: STEP_STATE.PENDING })).toBe(false);
      expect(isTerminal({ state: STEP_STATE.REVIEW })).toBe(false);
    });
  });

  describe('isRunnable()', () => {
    it('runnable states', () => {
      expect(isRunnable({ state: STEP_STATE.PENDING })).toBe(true);
      expect(isRunnable({ state: STEP_STATE.REVISION })).toBe(true);
      expect(isRunnable({ state: STEP_STATE.RETRY_WAIT })).toBe(true);
    });

    it('non-runnable states', () => {
      expect(isRunnable({ state: STEP_STATE.RUNNING })).toBe(false);
      expect(isRunnable({ state: STEP_STATE.SUCCEEDED })).toBe(false);
    });
  });

  describe('computeBackoff()', () => {
    it('increases exponentially', () => {
      const b0 = computeBackoff(0, { baseMs: 1000, jitterFactor: 0 });
      const b1 = computeBackoff(1, { baseMs: 1000, jitterFactor: 0 });
      const b2 = computeBackoff(2, { baseMs: 1000, jitterFactor: 0 });
      expect(b0).toBe(1000);
      expect(b1).toBe(2000);
      expect(b2).toBe(4000);
    });

    it('caps at maxMs', () => {
      const b = computeBackoff(10, { baseMs: 1000, maxMs: 5000, jitterFactor: 0 });
      expect(b).toBe(5000);
    });

    it('adds jitter within bounds', () => {
      const results = [];
      for (let i = 0; i < 100; i++) {
        results.push(computeBackoff(0, { baseMs: 1000, jitterFactor: 0.3 }));
      }
      expect(Math.min(...results)).toBeGreaterThanOrEqual(1000);
      expect(Math.max(...results)).toBeLessThanOrEqual(1300);
    });
  });

  describe('initStepState()', () => {
    it('creates step from definition', () => {
      const step = initStepState({ name: 'clean_data', workflow_type: 'python_tool', tool_hint: 'clean' }, 0);
      expect(step.state).toBe(STEP_STATE.INIT);
      expect(step.name).toBe('clean_data');
      expect(step.index).toBe(0);
      expect(step.workflow_type).toBe('python_tool');
      expect(step.retry_count).toBe(0);
    });
  });

  describe('serializeStep()', () => {
    it('serializes to JSON-safe shape', () => {
      const step = initStepState({ name: 'kpi', workflow_type: 'python_tool' }, 1);
      step.healing_strategy = 'escalate_model';
      const serialized = serializeStep(step);
      expect(serialized).toHaveProperty('state', STEP_STATE.INIT);
      expect(serialized).toHaveProperty('name', 'kpi');
      expect(serialized).toHaveProperty('healing_strategy', 'escalate_model');
      // Ensure it's JSON-serializable
      expect(() => JSON.stringify(serialized)).not.toThrow();
    });
  });
});
