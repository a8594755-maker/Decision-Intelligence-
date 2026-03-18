/**
 * ralphLoopAdapter.test.js — Tests for the ralph-loop-agent ↔ orchestrator bridge.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock ralph-loop-agent before importing adapter ────────────────────────────

const { mockLoop, mockRalphLoopAgent } = vi.hoisted(() => {
  const mockLoop = vi.fn();
  // Must be a class-like constructor since adapter uses `new RalphLoopAgent()`
  const mockRalphLoopAgent = vi.fn().mockImplementation(function (config) {
    this._config = config;
    this.loop = mockLoop;
  });
  return { mockLoop, mockRalphLoopAgent };
});

vi.mock('ralph-loop-agent', () => ({
  RalphLoopAgent: mockRalphLoopAgent,
  iterationCountIs: vi.fn((n) => ({ type: 'iterationCount', value: n })),
  costIs: vi.fn((n) => ({ type: 'cost', value: n })),
}));

vi.mock('ai', () => ({
  tool: vi.fn((def) => ({ ...def, _isTool: true })),
}));

// ── Import after mocks ───────────────────────────────────────────────────────

import { isRalphLoopEnabled, runRalphLoop } from './ralphLoopAdapter.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMockTickFn(tickResults = []) {
  let callIndex = 0;
  return vi.fn(async () => {
    const result = tickResults[callIndex] || { done: true };
    callIndex++;
    return result;
  });
}

function makeMockGetStatusFn(status = {}) {
  return vi.fn(async () => ({
    task: { status: status.taskStatus || 'in_progress' },
    stepsCompleted: status.stepsCompleted ?? 2,
    stepsTotal: status.stepsTotal ?? 5,
    isComplete: status.isComplete ?? false,
    steps: status.steps || [],
  }));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ralphLoopAdapter', () => {
  const originalEnv = { ...import.meta.env };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset env to defaults
    import.meta.env.VITE_RALPH_LOOP_ENABLED = 'false';
    import.meta.env.VITE_RALPH_MAX_ITERATIONS = '';
    import.meta.env.VITE_RALPH_MAX_COST = '';
    import.meta.env.VITE_RALPH_LLM_MODEL = '';
  });

  afterEach(() => {
    // Restore original env
    Object.assign(import.meta.env, originalEnv);
  });

  // ── isRalphLoopEnabled ──

  describe('isRalphLoopEnabled', () => {
    it('returns false by default', () => {
      expect(isRalphLoopEnabled()).toBe(false);
    });

    it('returns true when VITE_RALPH_LOOP_ENABLED=true', () => {
      import.meta.env.VITE_RALPH_LOOP_ENABLED = 'true';
      expect(isRalphLoopEnabled()).toBe(true);
    });
  });

  // ── runRalphLoop ──

  describe('runRalphLoop', () => {
    const defaultLoopResult = {
      completionReason: 'verified',
      iterations: 3,
      reason: 'All steps completed',
      totalUsage: { totalTokens: 1500, promptTokens: 1000, completionTokens: 500 },
      text: 'Task completed successfully.',
    };

    beforeEach(() => {
      mockLoop.mockResolvedValue(defaultLoopResult);
    });

    it('creates agent and calls loop with correct prompt', async () => {
      const tickFn = makeMockTickFn();
      const getStatusFn = makeMockGetStatusFn();

      const result = await runRalphLoop('task-123', tickFn, getStatusFn);

      expect(mockRalphLoopAgent).toHaveBeenCalledTimes(1);
      expect(mockLoop).toHaveBeenCalledTimes(1);

      const loopCall = mockLoop.mock.calls[0][0];
      expect(loopCall.prompt).toContain('task-123');

      expect(result.completionReason).toBe('verified');
      expect(result.iterations).toBe(3);
    });

    it('passes taskTitle to agent instructions', async () => {
      const tickFn = makeMockTickFn();
      const getStatusFn = makeMockGetStatusFn();

      await runRalphLoop('task-123', tickFn, getStatusFn, {
        taskTitle: 'Monthly Replenishment Plan',
      });

      const agentConfig = mockRalphLoopAgent.mock.calls[0][0];
      expect(agentConfig.instructions).toContain('Monthly Replenishment Plan');
    });

    it('passes abortSignal to loop call', async () => {
      const tickFn = makeMockTickFn();
      const getStatusFn = makeMockGetStatusFn();
      const controller = new AbortController();

      await runRalphLoop('task-123', tickFn, getStatusFn, {
        abortSignal: controller.signal,
      });

      const loopCall = mockLoop.mock.calls[0][0];
      expect(loopCall.abortSignal).toBe(controller.signal);
    });

    it('returns structured result with usage data', async () => {
      const tickFn = makeMockTickFn();
      const getStatusFn = makeMockGetStatusFn();

      const result = await runRalphLoop('task-123', tickFn, getStatusFn);

      expect(result).toEqual({
        completionReason: 'verified',
        iterations: 3,
        reason: 'All steps completed',
        totalUsage: { totalTokens: 1500, promptTokens: 1000, completionTokens: 500 },
        text: 'Task completed successfully.',
      });
    });

    it('configures stop conditions from defaults', async () => {
      const tickFn = makeMockTickFn();
      const getStatusFn = makeMockGetStatusFn();

      await runRalphLoop('task-123', tickFn, getStatusFn);

      const agentConfig = mockRalphLoopAgent.mock.calls[0][0];
      expect(agentConfig.stopWhen).toHaveLength(2);
      expect(agentConfig.model).toBe('anthropic/claude-sonnet-4.5');
    });

    it('enables context management with summarization', async () => {
      const tickFn = makeMockTickFn();
      const getStatusFn = makeMockGetStatusFn();

      await runRalphLoop('task-123', tickFn, getStatusFn);

      const agentConfig = mockRalphLoopAgent.mock.calls[0][0];
      expect(agentConfig.contextManagement).toBeDefined();
      expect(agentConfig.contextManagement.enableSummarization).toBe(true);
      expect(agentConfig.contextManagement.recentIterationsToKeep).toBe(3);
    });

    it('handles max-iterations completion reason', async () => {
      mockLoop.mockResolvedValue({
        ...defaultLoopResult,
        completionReason: 'max-iterations',
        reason: 'Reached max iterations',
      });

      const tickFn = makeMockTickFn();
      const getStatusFn = makeMockGetStatusFn();

      const result = await runRalphLoop('task-123', tickFn, getStatusFn);
      expect(result.completionReason).toBe('max-iterations');
    });

    it('propagates errors from ralph loop', async () => {
      mockLoop.mockRejectedValue(new Error('LLM quota exceeded'));

      const tickFn = makeMockTickFn();
      const getStatusFn = makeMockGetStatusFn();

      await expect(
        runRalphLoop('task-123', tickFn, getStatusFn)
      ).rejects.toThrow('LLM quota exceeded');
    });
  });

  // ── Tool Definitions ──

  describe('tool definitions', () => {
    it('registers executeTick, getTaskStatus, and markComplete tools', async () => {
      mockLoop.mockResolvedValue({
        completionReason: 'verified',
        iterations: 1,
        reason: 'done',
        totalUsage: { totalTokens: 100 },
        text: 'ok',
      });

      const tickFn = makeMockTickFn();
      const getStatusFn = makeMockGetStatusFn();

      await runRalphLoop('task-123', tickFn, getStatusFn);

      const agentConfig = mockRalphLoopAgent.mock.calls[0][0];
      const toolNames = Object.keys(agentConfig.tools);

      expect(toolNames).toContain('executeTick');
      expect(toolNames).toContain('getTaskStatus');
      expect(toolNames).toContain('markComplete');
    });

    it('executeTick tool calls the tickFn', async () => {
      const tickFn = makeMockTickFn([{ done: false, stepResult: { ok: true } }]);
      const getStatusFn = makeMockGetStatusFn();

      mockLoop.mockImplementation(async () => {
        // Simulate ralph calling the executeTick tool
        const tools = mockRalphLoopAgent.mock.calls[0][0].tools;
        const result = await tools.executeTick.execute({ taskId: 'task-123' });
        expect(result.ok).toBe(true);
        expect(result.done).toBe(false);
        expect(tickFn).toHaveBeenCalledWith('task-123');

        return {
          completionReason: 'verified',
          iterations: 1,
          reason: 'done',
          totalUsage: { totalTokens: 100 },
          text: 'ok',
        };
      });

      await runRalphLoop('task-123', tickFn, getStatusFn);
    });

    it('executeTick tool catches errors gracefully', async () => {
      const tickFn = vi.fn().mockRejectedValue(new Error('DB connection lost'));
      const getStatusFn = makeMockGetStatusFn();

      mockLoop.mockImplementation(async () => {
        const tools = mockRalphLoopAgent.mock.calls[0][0].tools;
        const result = await tools.executeTick.execute({ taskId: 'task-123' });
        expect(result.ok).toBe(false);
        expect(result.error).toBe('DB connection lost');

        return {
          completionReason: 'verified',
          iterations: 1,
          reason: 'done',
          totalUsage: { totalTokens: 100 },
          text: 'ok',
        };
      });

      await runRalphLoop('task-123', tickFn, getStatusFn);
    });

    it('getTaskStatus tool returns formatted status', async () => {
      const tickFn = makeMockTickFn();
      const getStatusFn = makeMockGetStatusFn({
        taskStatus: 'in_progress',
        stepsCompleted: 3,
        stepsTotal: 5,
        isComplete: false,
        steps: [
          { step_index: 0, step_name: 'forecast', status: 'succeeded', error_message: null },
          { step_index: 1, step_name: 'plan', status: 'running', error_message: null },
        ],
      });

      mockLoop.mockImplementation(async () => {
        const tools = mockRalphLoopAgent.mock.calls[0][0].tools;
        const result = await tools.getTaskStatus.execute({ taskId: 'task-123' });

        expect(result.ok).toBe(true);
        expect(result.status).toBe('in_progress');
        expect(result.stepsCompleted).toBe(3);
        expect(result.stepsTotal).toBe(5);
        expect(result.steps).toHaveLength(2);
        expect(result.steps[0].name).toBe('forecast');

        return {
          completionReason: 'verified',
          iterations: 1,
          reason: 'done',
          totalUsage: { totalTokens: 100 },
          text: 'ok',
        };
      });

      await runRalphLoop('task-123', tickFn, getStatusFn);
    });

    it('markComplete tool returns completion signal', async () => {
      const tickFn = makeMockTickFn();
      const getStatusFn = makeMockGetStatusFn();

      mockLoop.mockImplementation(async () => {
        const tools = mockRalphLoopAgent.mock.calls[0][0].tools;
        const result = await tools.markComplete.execute({ reason: 'All 5 steps done' });

        expect(result.complete).toBe(true);
        expect(result.reason).toBe('All 5 steps done');

        return {
          completionReason: 'verified',
          iterations: 1,
          reason: 'done',
          totalUsage: { totalTokens: 100 },
          text: 'ok',
        };
      });

      await runRalphLoop('task-123', tickFn, getStatusFn);
    });
  });

  // ── Verification Function ──

  describe('verifyCompletion', () => {
    it('detects markComplete tool call as complete', async () => {
      const tickFn = makeMockTickFn();
      const getStatusFn = makeMockGetStatusFn();

      mockLoop.mockImplementation(async () => {
        const agentConfig = mockRalphLoopAgent.mock.calls[0][0];
        const verifyResult = await agentConfig.verifyCompletion({
          result: {
            steps: [{
              toolResults: [{
                toolName: 'markComplete',
                result: { complete: true, reason: 'Task finished' },
              }],
            }],
          },
          iteration: 3,
          allResults: [],
          originalPrompt: '',
        });

        expect(verifyResult.complete).toBe(true);
        expect(verifyResult.reason).toBe('Task finished');

        return {
          completionReason: 'verified',
          iterations: 3,
          reason: 'done',
          totalUsage: { totalTokens: 100 },
          text: 'ok',
        };
      });

      await runRalphLoop('task-123', tickFn, getStatusFn);
    });

    it('detects isComplete from getTaskStatus as complete', async () => {
      const tickFn = makeMockTickFn();
      const getStatusFn = makeMockGetStatusFn();

      mockLoop.mockImplementation(async () => {
        const agentConfig = mockRalphLoopAgent.mock.calls[0][0];
        const verifyResult = await agentConfig.verifyCompletion({
          result: {
            steps: [{
              toolResults: [{
                toolName: 'getTaskStatus',
                result: { ok: true, isComplete: true },
              }],
            }],
          },
          iteration: 5,
          allResults: [],
          originalPrompt: '',
        });

        expect(verifyResult.complete).toBe(true);
        expect(verifyResult.reason).toBe('All steps completed');

        return {
          completionReason: 'verified',
          iterations: 5,
          reason: 'done',
          totalUsage: { totalTokens: 100 },
          text: 'ok',
        };
      });

      await runRalphLoop('task-123', tickFn, getStatusFn);
    });

    it('detects waiting_input from executeTick as complete (pause)', async () => {
      const tickFn = makeMockTickFn();
      const getStatusFn = makeMockGetStatusFn();

      mockLoop.mockImplementation(async () => {
        const agentConfig = mockRalphLoopAgent.mock.calls[0][0];
        const verifyResult = await agentConfig.verifyCompletion({
          result: {
            steps: [{
              toolResults: [{
                toolName: 'executeTick',
                result: { ok: true, done: true, waiting_input: true },
              }],
            }],
          },
          iteration: 2,
          allResults: [],
          originalPrompt: '',
        });

        expect(verifyResult.complete).toBe(true);
        expect(verifyResult.reason).toBe('Waiting for user input');

        return {
          completionReason: 'verified',
          iterations: 2,
          reason: 'Waiting for user input',
          totalUsage: { totalTokens: 100 },
          text: 'ok',
        };
      });

      await runRalphLoop('task-123', tickFn, getStatusFn);
    });

    it('returns incomplete when no termination signals found', async () => {
      const tickFn = makeMockTickFn();
      const getStatusFn = makeMockGetStatusFn();

      mockLoop.mockImplementation(async () => {
        const agentConfig = mockRalphLoopAgent.mock.calls[0][0];
        const verifyResult = await agentConfig.verifyCompletion({
          result: {
            steps: [{
              toolResults: [{
                toolName: 'executeTick',
                result: { ok: true, done: false },
              }],
            }],
          },
          iteration: 2,
          allResults: [],
          originalPrompt: '',
        });

        expect(verifyResult.complete).toBe(false);
        expect(verifyResult.reason).toContain('Iteration 2');

        return {
          completionReason: 'verified',
          iterations: 2,
          reason: 'done',
          totalUsage: { totalTokens: 100 },
          text: 'ok',
        };
      });

      await runRalphLoop('task-123', tickFn, getStatusFn);
    });
  });

  // ── Callbacks ──

  describe('callbacks', () => {
    it('registers onIterationStart and onIterationEnd callbacks', async () => {
      const tickFn = makeMockTickFn();
      const getStatusFn = makeMockGetStatusFn();

      mockLoop.mockResolvedValue({
        completionReason: 'verified',
        iterations: 1,
        reason: 'done',
        totalUsage: { totalTokens: 100 },
        text: 'ok',
      });

      await runRalphLoop('task-123', tickFn, getStatusFn);

      const agentConfig = mockRalphLoopAgent.mock.calls[0][0];
      expect(typeof agentConfig.onIterationStart).toBe('function');
      expect(typeof agentConfig.onIterationEnd).toBe('function');
    });
  });
});
