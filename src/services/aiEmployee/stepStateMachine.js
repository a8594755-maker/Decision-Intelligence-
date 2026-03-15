/**
 * stepStateMachine.js — Pure state transition functions for agent loop steps.
 *
 * Step States (7):
 *   pending → running → succeeded
 *                    → failed → retrying → succeeded | failed
 *                    → skipped
 *   pending → waiting_input → pending (when input received)
 */

export const STEP_STATES = Object.freeze({
  PENDING:       'pending',
  WAITING_INPUT: 'waiting_input',
  RUNNING:       'running',
  SUCCEEDED:     'succeeded',
  FAILED:        'failed',
  RETRYING:      'retrying',
  SKIPPED:       'skipped',
});

export const STEP_EVENTS = Object.freeze({
  START:          'start',
  SUCCEED:        'succeed',
  FAIL:           'fail',
  RETRY:          'retry',
  SKIP:           'skip',
  NEED_INPUT:     'need_input',
  INPUT_RECEIVED: 'input_received',
});

const TRANSITIONS = {
  [STEP_STATES.PENDING]: {
    [STEP_EVENTS.START]:      STEP_STATES.RUNNING,
    [STEP_EVENTS.SKIP]:       STEP_STATES.SKIPPED,
    [STEP_EVENTS.NEED_INPUT]: STEP_STATES.WAITING_INPUT,
  },
  [STEP_STATES.WAITING_INPUT]: {
    [STEP_EVENTS.INPUT_RECEIVED]: STEP_STATES.PENDING,
    [STEP_EVENTS.SKIP]:           STEP_STATES.SKIPPED,
  },
  [STEP_STATES.RUNNING]: {
    [STEP_EVENTS.SUCCEED]: STEP_STATES.SUCCEEDED,
    [STEP_EVENTS.FAIL]:    STEP_STATES.FAILED,
  },
  [STEP_STATES.FAILED]: {
    [STEP_EVENTS.RETRY]: STEP_STATES.RETRYING,
  },
  [STEP_STATES.RETRYING]: {
    [STEP_EVENTS.START]:   STEP_STATES.RUNNING,
    [STEP_EVENTS.SUCCEED]: STEP_STATES.SUCCEEDED,
    [STEP_EVENTS.FAIL]:    STEP_STATES.FAILED,
  },
  // Terminal states
  [STEP_STATES.SUCCEEDED]: {},
  [STEP_STATES.SKIPPED]:   {},
};

/**
 * Transition a step from currentState via event → newState.
 * @throws {Error} if transition is invalid
 */
export function stepTransition(currentState, event) {
  const stateTransitions = TRANSITIONS[currentState];
  if (!stateTransitions) {
    throw new Error(`[StepSM] Unknown state: '${currentState}'`);
  }
  const nextState = stateTransitions[event];
  if (!nextState) {
    throw new Error(
      `[StepSM] Invalid transition: '${currentState}' + '${event}'. ` +
      `Valid events: [${Object.keys(stateTransitions).join(', ')}]`
    );
  }
  return nextState;
}

export function canStepTransition(currentState, event) {
  try {
    stepTransition(currentState, event);
    return true;
  } catch {
    return false;
  }
}

export function isStepTerminal(state) {
  return state === STEP_STATES.SUCCEEDED || state === STEP_STATES.SKIPPED;
}

export function isStepFailed(state) {
  return state === STEP_STATES.FAILED;
}

export function isStepWaitingInput(state) {
  return state === STEP_STATES.WAITING_INPUT;
}
