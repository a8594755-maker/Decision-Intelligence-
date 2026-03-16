import { describe, it, expect } from 'vitest';
import {
  taskTransition, canTaskTransition, isTaskTerminal,
  TASK_STATES, TASK_EVENTS,
} from './taskStateMachine.js';
import {
  stepTransition, isStepTerminal, isStepFailed, isStepWaitingInput,
  STEP_STATES, STEP_EVENTS,
} from './stepStateMachine.js';
import {
  employeeTransition,
  EMPLOYEE_STATES, EMPLOYEE_EVENTS,
  EMPLOYEE_STATE_TO_DB, DB_TO_EMPLOYEE_STATE,
} from './employeeStateMachine.js';

// ── Task State Machine ──────────────────────────────────────────────────────

describe('taskStateMachine', () => {
  it('happy path: draft_plan → done', () => {
    let state = TASK_STATES.DRAFT_PLAN;
    state = taskTransition(state, TASK_EVENTS.PLAN_READY);
    expect(state).toBe(TASK_STATES.WAITING_APPROVAL);

    state = taskTransition(state, TASK_EVENTS.APPROVE);
    expect(state).toBe(TASK_STATES.QUEUED);

    state = taskTransition(state, TASK_EVENTS.START);
    expect(state).toBe(TASK_STATES.IN_PROGRESS);

    state = taskTransition(state, TASK_EVENTS.STEP_COMPLETED);
    expect(state).toBe(TASK_STATES.IN_PROGRESS);

    state = taskTransition(state, TASK_EVENTS.ALL_STEPS_DONE);
    expect(state).toBe(TASK_STATES.DONE);

    expect(isTaskTerminal(state)).toBe(true);
  });

  it('review flow: in_progress → review_hold → in_progress → done', () => {
    let state = TASK_STATES.IN_PROGRESS;
    state = taskTransition(state, TASK_EVENTS.REVIEW_NEEDED);
    expect(state).toBe(TASK_STATES.REVIEW_HOLD);

    state = taskTransition(state, TASK_EVENTS.REVIEW_APPROVED);
    expect(state).toBe(TASK_STATES.IN_PROGRESS);

    state = taskTransition(state, TASK_EVENTS.ALL_STEPS_DONE);
    expect(state).toBe(TASK_STATES.DONE);
  });

  it('failure + retry: in_progress → failed → queued', () => {
    let state = TASK_STATES.IN_PROGRESS;
    state = taskTransition(state, TASK_EVENTS.FAIL);
    expect(state).toBe(TASK_STATES.FAILED);

    state = taskTransition(state, TASK_EVENTS.RETRY);
    expect(state).toBe(TASK_STATES.QUEUED);
  });

  it('cancel from any non-terminal state', () => {
    const cancellable = [
      TASK_STATES.DRAFT_PLAN,
      TASK_STATES.WAITING_APPROVAL,
      TASK_STATES.QUEUED,
      TASK_STATES.IN_PROGRESS,
      TASK_STATES.REVIEW_HOLD,
      TASK_STATES.BLOCKED,
    ];
    for (const state of cancellable) {
      expect(taskTransition(state, TASK_EVENTS.CANCEL)).toBe(TASK_STATES.CANCELLED);
    }
  });

  it('throws on invalid transition', () => {
    expect(() => taskTransition(TASK_STATES.DONE, TASK_EVENTS.START)).toThrow(/Invalid transition/);
    expect(() => taskTransition(TASK_STATES.CANCELLED, TASK_EVENTS.RETRY)).toThrow(/Invalid transition/);
  });

  it('throws on unknown state', () => {
    expect(() => taskTransition('nonexistent', TASK_EVENTS.START)).toThrow(/Unknown state/);
  });

  it('canTaskTransition returns boolean', () => {
    expect(canTaskTransition(TASK_STATES.DRAFT_PLAN, TASK_EVENTS.PLAN_READY)).toBe(true);
    expect(canTaskTransition(TASK_STATES.DONE, TASK_EVENTS.START)).toBe(false);
  });

  it('terminal states', () => {
    expect(isTaskTerminal(TASK_STATES.DONE)).toBe(true);
    expect(isTaskTerminal(TASK_STATES.CANCELLED)).toBe(true);
    expect(isTaskTerminal(TASK_STATES.IN_PROGRESS)).toBe(false);
    expect(isTaskTerminal(TASK_STATES.FAILED)).toBe(false);
  });
});

// ── Step State Machine ──────────────────────────────────────────────────────

describe('stepStateMachine', () => {
  it('happy path: pending → running → succeeded', () => {
    let state = STEP_STATES.PENDING;
    state = stepTransition(state, STEP_EVENTS.START);
    expect(state).toBe(STEP_STATES.RUNNING);

    state = stepTransition(state, STEP_EVENTS.SUCCEED);
    expect(state).toBe(STEP_STATES.SUCCEEDED);
    expect(isStepTerminal(state)).toBe(true);
  });

  it('failure + retry: running → failed → retrying → succeeded', () => {
    let state = STEP_STATES.RUNNING;
    state = stepTransition(state, STEP_EVENTS.FAIL);
    expect(state).toBe(STEP_STATES.FAILED);
    expect(isStepFailed(state)).toBe(true);

    state = stepTransition(state, STEP_EVENTS.RETRY);
    expect(state).toBe(STEP_STATES.RETRYING);

    state = stepTransition(state, STEP_EVENTS.SUCCEED);
    expect(state).toBe(STEP_STATES.SUCCEEDED);
  });

  it('skip: pending → skipped', () => {
    const state = stepTransition(STEP_STATES.PENDING, STEP_EVENTS.SKIP);
    expect(state).toBe(STEP_STATES.SKIPPED);
    expect(isStepTerminal(state)).toBe(true);
  });

  it('retry can also fail again', () => {
    const state = stepTransition(STEP_STATES.RETRYING, STEP_EVENTS.FAIL);
    expect(state).toBe(STEP_STATES.FAILED);
  });

  it('waiting_input flow: pending → waiting_input → pending → running → succeeded', () => {
    let state = STEP_STATES.PENDING;
    state = stepTransition(state, STEP_EVENTS.NEED_INPUT);
    expect(state).toBe(STEP_STATES.WAITING_INPUT);
    expect(isStepWaitingInput(state)).toBe(true);
    expect(isStepTerminal(state)).toBe(false);

    state = stepTransition(state, STEP_EVENTS.INPUT_RECEIVED);
    expect(state).toBe(STEP_STATES.PENDING);

    state = stepTransition(state, STEP_EVENTS.START);
    expect(state).toBe(STEP_STATES.RUNNING);

    state = stepTransition(state, STEP_EVENTS.SUCCEED);
    expect(state).toBe(STEP_STATES.SUCCEEDED);
  });

  it('waiting_input can be skipped', () => {
    const state = stepTransition(STEP_STATES.WAITING_INPUT, STEP_EVENTS.SKIP);
    expect(state).toBe(STEP_STATES.SKIPPED);
  });

  it('throws on invalid', () => {
    expect(() => stepTransition(STEP_STATES.SUCCEEDED, STEP_EVENTS.START)).toThrow(/Invalid transition/);
  });
});

// ── Employee State Machine ──────────────────────────────────────────────────

describe('employeeStateMachine', () => {
  it('task lifecycle: idle → busy → idle', () => {
    let state = EMPLOYEE_STATES.IDLE;
    state = employeeTransition(state, EMPLOYEE_EVENTS.TASK_STARTED);
    expect(state).toBe(EMPLOYEE_STATES.BUSY);

    state = employeeTransition(state, EMPLOYEE_EVENTS.TASK_DONE);
    expect(state).toBe(EMPLOYEE_STATES.IDLE);
  });

  it('review flow: busy → review_needed → busy → idle', () => {
    let state = EMPLOYEE_STATES.BUSY;
    state = employeeTransition(state, EMPLOYEE_EVENTS.REVIEW_NEEDED);
    expect(state).toBe(EMPLOYEE_STATES.REVIEW_NEEDED);

    state = employeeTransition(state, EMPLOYEE_EVENTS.REVIEW_RESOLVED);
    expect(state).toBe(EMPLOYEE_STATES.BUSY);

    state = employeeTransition(state, EMPLOYEE_EVENTS.TASK_DONE);
    expect(state).toBe(EMPLOYEE_STATES.IDLE);
  });

  it('error recovery: busy → error → idle', () => {
    let state = EMPLOYEE_STATES.BUSY;
    state = employeeTransition(state, EMPLOYEE_EVENTS.ERROR);
    expect(state).toBe(EMPLOYEE_STATES.ERROR);

    state = employeeTransition(state, EMPLOYEE_EVENTS.RECOVER);
    expect(state).toBe(EMPLOYEE_STATES.IDLE);
  });

  it('DB mapping roundtrip', () => {
    expect(EMPLOYEE_STATE_TO_DB[EMPLOYEE_STATES.BUSY]).toBe('working');
    expect(EMPLOYEE_STATE_TO_DB[EMPLOYEE_STATES.REVIEW_NEEDED]).toBe('waiting_review');
    expect(DB_TO_EMPLOYEE_STATE['working']).toBe(EMPLOYEE_STATES.BUSY);
    expect(DB_TO_EMPLOYEE_STATE['blocked']).toBe(EMPLOYEE_STATES.ERROR);
  });

  it('throws on invalid', () => {
    expect(() => employeeTransition(EMPLOYEE_STATES.IDLE, EMPLOYEE_EVENTS.TASK_DONE)).toThrow(/Invalid transition/);
  });
});
