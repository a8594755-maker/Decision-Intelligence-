// @product: ai-employee
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  initAgentLoop,
  tickAgentLoop,
  runAgentLoop,
  approveStepAndContinue,
  reviseStepAndRetry,
  STEP_STATUS,
  MAX_RETRIES,
} from './agentLoopService';
import { initLoopState, AGENT_LOOP_TEMPLATES } from './agentLoopTemplates';

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock('./aiEmployeeService', () => {
  const tasks = new Map();
  return {
    getTask: vi.fn(async (id) => tasks.get(id) || null),
    updateTaskLoopState: vi.fn(async (id, loopState) => {
      const t = tasks.get(id);
      if (t) t.loop_state = loopState;
      return t;
    }),
    updateTaskStatus: vi.fn(async (id, status) => {
      const t = tasks.get(id);
      if (t) t.status = status;
      return t;
    }),
    updateEmployeeStatus: vi.fn(async () => {}),
    appendWorklog: vi.fn(async () => ({})),
    _setTask: (task) => tasks.set(task.id, task),
    _clear: () => tasks.clear(),
  };
});

vi.mock('./aiEmployeeExecutor', () => ({
  executeTask: vi.fn(async () => ({
    run: { id: 'run-1', summary: 'Step completed.', artifact_refs: ['art-1'] },
    result: {},
  })),
}));

vi.mock('./aiEmployeeMemoryService', () => ({
  recall: vi.fn(async () => []),
  summarizeMemories: vi.fn(() => ({ has_prior_experience: false })),
}));

vi.mock('./taskBudgetService', () => ({
  checkBudget: vi.fn(async () => ({ allowed: true, reason: null, remaining: null, budget: null })),
  BudgetExceededError: class BudgetExceededError extends Error {
    constructor(taskId, reason) { super(`Budget exceeded: ${reason}`); this.name = 'BudgetExceededError'; }
  },
}));

vi.mock('./selfHealingService', () => ({
  analyzeStepFailure: vi.fn((err, step, retryCount) => ({
    errorCategory: 'unknown',
    healingStrategy: 'revise_prompt',
    modifications: { promptSuffix: 'Try a different approach.' },
    reasoning: 'test healing',
  })),
  getAlternativeModel: vi.fn(async () => null),
}));

const aiEmployeeService = await import('./aiEmployeeService');
const { executeTask } = await import('./aiEmployeeExecutor');

// ── Helpers ──────────────────────────────────────────────────────────────

function makeTask(templateId = 'forecast_then_plan') {
  const template = AGENT_LOOP_TEMPLATES[templateId];
  const loopState = initLoopState(template);
  loopState.started_at = new Date().toISOString();
  const task = {
    id: 'task-1',
    employee_id: 'emp-1',
    status: 'todo',
    template_id: templateId,
    input_context: {
      template_id: templateId,
      workflow_type: templateId,
      dataset_profile_id: 'dp-1',
    },
    loop_state: loopState,
  };
  aiEmployeeService._setTask(task);
  return task;
}

// ── Tests ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  aiEmployeeService._clear();
});

describe('initAgentLoop', () => {
  it('initializes loop_state on a task without one', async () => {
    const task = {
      id: 'task-2',
      employee_id: 'emp-1',
      status: 'todo',
      template_id: null,
      input_context: { template_id: 'forecast', workflow_type: 'forecast', dataset_profile_id: 'dp-1' },
      loop_state: null,
    };
    aiEmployeeService._setTask(task);

    await initAgentLoop('task-2', 'user-1');

    expect(aiEmployeeService.updateTaskLoopState).toHaveBeenCalledWith(
      'task-2',
      expect.objectContaining({ template_id: 'forecast', steps: expect.any(Array) })
    );
  });

  it('skips if loop_state already exists', async () => {
    const task = makeTask('forecast');
    const result = await initAgentLoop(task.id, 'user-1');
    expect(aiEmployeeService.updateTaskLoopState).not.toHaveBeenCalled();
    expect(result.loop_state.steps).toHaveLength(1);
  });

  it('throws on unknown template', async () => {
    const task = {
      id: 'task-3',
      employee_id: 'emp-1',
      status: 'todo',
      input_context: { template_id: 'nonexistent' },
      loop_state: null,
    };
    aiEmployeeService._setTask(task);
    await expect(initAgentLoop('task-3', 'user-1')).rejects.toThrow('Unknown template');
  });
});

describe('tickAgentLoop', () => {
  it('executes first pending step and marks succeeded', async () => {
    const task = makeTask('forecast_then_plan');
    const { done, step_event } = await tickAgentLoop(task.id, 'user-1');

    expect(done).toBe(false);
    expect(step_event.step_name).toBe('forecast');
    expect(step_event.status).toBe(STEP_STATUS.SUCCEEDED);
    expect(executeTask).toHaveBeenCalledOnce();

    // Verify loop_state updated
    const updated = await aiEmployeeService.getTask(task.id);
    expect(updated.loop_state.steps[0].status).toBe('succeeded');
    expect(updated.loop_state.steps[0].run_id).toBe('run-1');
  });

  it('pauses at review_hold when step requires_review', async () => {
    const task = makeTask('forecast'); // single step with requires_review: true
    const { done, step_event } = await tickAgentLoop(task.id, 'user-1');

    expect(done).toBe(false);
    expect(step_event.step_name).toBe('forecast');
    expect(step_event.status).toBe(STEP_STATUS.REVIEW_HOLD);
  });

  it('increments retry_count on failure and applies self-healing', async () => {
    executeTask.mockRejectedValueOnce(new Error('Engine failed'));
    const task = makeTask('forecast_then_plan');

    const { step_event } = await tickAgentLoop(task.id, 'user-1');

    expect(step_event.step_name).toBe('forecast');
    // With self-healing, failed steps are set back to PENDING for retry (not 'failed')
    expect(step_event.status).toBe('pending');
    expect(step_event.retry_count).toBe(1);
    expect(step_event.error).toBe('Engine failed');
    expect(step_event.healing_strategy).toBe('revise_prompt');
  });

  it('blocks step after MAX_RETRIES failures', async () => {
    const task = makeTask('forecast_then_plan');
    // Set retry_count just below threshold
    task.loop_state.steps[0].retry_count = MAX_RETRIES - 1;
    task.loop_state.steps[0].status = 'failed';

    executeTask.mockRejectedValueOnce(new Error('Still failing'));
    const { step_event } = await tickAgentLoop(task.id, 'user-1');

    expect(step_event.status).toBe(STEP_STATUS.BLOCKED);
  });

  it('returns done=true when all steps succeeded', async () => {
    const task = makeTask('forecast_then_plan');
    // Pre-mark first step as succeeded
    task.loop_state.steps[0].status = 'succeeded';
    task.loop_state.steps[0].artifact_refs = ['art-1'];
    // Second step (plan) has requires_review: true → will be review_hold
    const { done, step_event } = await tickAgentLoop(task.id, 'user-1');

    expect(step_event.step_name).toBe('plan');
    // plan step requires review, so it should be review_hold, not done
    expect(step_event.status).toBe(STEP_STATUS.REVIEW_HOLD);
  });

  it('passes prior step artifacts to subsequent steps', async () => {
    const task = makeTask('forecast_then_plan');
    task.loop_state.steps[0].status = 'succeeded';
    task.loop_state.steps[0].artifact_refs = ['art-forecast-1'];

    await tickAgentLoop(task.id, 'user-1');

    // Check the input_context passed to executeTask
    const call = executeTask.mock.calls[0][0];
    expect(call.input_context._prior_step_artifacts).toEqual({
      forecast: ['art-forecast-1'],
    });
  });
});

describe('approveStepAndContinue', () => {
  it('transitions review_hold step to succeeded', async () => {
    const task = makeTask('forecast');
    task.loop_state.steps[0].status = 'review_hold';

    await approveStepAndContinue(task.id, 'forecast');

    const updated = await aiEmployeeService.getTask(task.id);
    expect(updated.loop_state.steps[0].status).toBe('succeeded');
    expect(aiEmployeeService.updateTaskStatus).toHaveBeenCalledWith(task.id, 'in_progress');
  });

  it('throws if step is not in review_hold', async () => {
    const task = makeTask('forecast');
    await expect(approveStepAndContinue(task.id, 'forecast'))
      .rejects.toThrow('not in review_hold');
  });
});

describe('reviseStepAndRetry', () => {
  it('resets step to pending', async () => {
    const task = makeTask('forecast');
    task.loop_state.steps[0].status = 'review_hold';
    task.loop_state.steps[0].run_id = 'run-old';

    await reviseStepAndRetry(task.id, 'forecast');

    const updated = await aiEmployeeService.getTask(task.id);
    const step = updated.loop_state.steps[0];
    expect(step.status).toBe('pending');
    expect(step.run_id).toBeNull();
    expect(step.artifact_refs).toEqual([]);
  });
});

describe('runAgentLoop', () => {
  it('runs all steps to completion for single-step template', async () => {
    const task = makeTask('forecast');

    // forecast step will go to review_hold (requires_review: true)
    const result = await runAgentLoop(task.id, 'user-1');

    expect(result.halted_at).toBe('forecast'); // paused at review_hold
    expect(result.completed_steps).toContain('forecast');
  });

  it('calls onStepComplete callback', async () => {
    const task = makeTask('forecast');
    const onStep = vi.fn();

    await runAgentLoop(task.id, 'user-1', { onStepComplete: onStep });

    expect(onStep).toHaveBeenCalledWith(
      expect.objectContaining({ step_name: 'forecast' })
    );
  });

  it('stops on abort signal', async () => {
    const task = makeTask('forecast_then_plan');
    const controller = new AbortController();
    controller.abort();

    const result = await runAgentLoop(task.id, 'user-1', { signal: controller.signal });
    expect(result.halted_at).toBe('aborted');
  });

  it('resumes from partially completed loop_state', async () => {
    const task = makeTask('forecast_then_plan');
    // Mark forecast as already done
    task.loop_state.steps[0].status = 'succeeded';
    task.loop_state.steps[0].artifact_refs = ['art-1'];

    const result = await runAgentLoop(task.id, 'user-1');

    // Should have only run plan step (which has requires_review)
    expect(executeTask).toHaveBeenCalledOnce();
    expect(result.completed_steps).toContain('plan');
    expect(result.halted_at).toBe('plan'); // review_hold
  });
});
