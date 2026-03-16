// @product: ai-employee
//
// Tests for the deprecated agentLoopService stub.
// All public functions should throw deprecation errors directing callers
// to orchestrator.js.
import { describe, it, expect } from 'vitest';
import {
  initAgentLoop,
  tickAgentLoop,
  runAgentLoop,
  approveStepAndContinue,
  reviseStepAndRetry,
  STEP_STATUS,
  MAX_RETRIES,
} from './_archive/agentLoopService';

describe('agentLoopService (deprecated stub)', () => {
  it('still exports MAX_RETRIES constant', () => {
    expect(MAX_RETRIES).toBe(3);
  });

  it('still exports STEP_STATUS constants', () => {
    expect(STEP_STATUS.PENDING).toBe('pending');
    expect(STEP_STATUS.SUCCEEDED).toBe('succeeded');
    expect(STEP_STATUS.FAILED).toBe('failed');
    expect(STEP_STATUS.REVIEW_HOLD).toBe('review_hold');
  });

  it('initAgentLoop throws deprecation error', () => {
    expect(() => initAgentLoop('task-1', 'user-1')).toThrow(/Deprecated.*orchestrator/);
  });

  it('tickAgentLoop throws deprecation error', () => {
    expect(() => tickAgentLoop('task-1', 'user-1')).toThrow(/Deprecated.*orchestrator/);
  });

  it('runAgentLoop throws deprecation error', () => {
    expect(() => runAgentLoop('task-1', 'user-1', {})).toThrow(/Deprecated.*orchestrator/);
  });

  it('approveStepAndContinue throws deprecation error', () => {
    expect(() => approveStepAndContinue('task-1', 'step-1')).toThrow(/Deprecated.*orchestrator/);
  });

  it('reviseStepAndRetry throws deprecation error', () => {
    expect(() => reviseStepAndRetry('task-1', 'step-1')).toThrow(/Deprecated.*orchestrator/);
  });
});
