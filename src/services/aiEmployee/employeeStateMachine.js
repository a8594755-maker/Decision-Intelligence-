/**
 * employeeStateMachine.js — Pure state transitions for AI Employee status.
 *
 * Employee States (4):
 *   idle → busy → review_needed → idle
 *              → error → idle
 *
 * Maps to DB column: ai_employees.status
 * Legacy DB values: 'idle', 'working', 'blocked', 'waiting_review'
 * We map: busy→working, review_needed→waiting_review, error→blocked
 */

export const EMPLOYEE_STATES = Object.freeze({
  IDLE:           'idle',
  BUSY:           'busy',
  REVIEW_NEEDED:  'review_needed',
  ERROR:          'error',
});

/** Map logical states to DB column values for backward compatibility */
export const EMPLOYEE_STATE_TO_DB = Object.freeze({
  [EMPLOYEE_STATES.IDLE]:          'idle',
  [EMPLOYEE_STATES.BUSY]:          'working',
  [EMPLOYEE_STATES.REVIEW_NEEDED]: 'waiting_review',
  [EMPLOYEE_STATES.ERROR]:         'blocked',
});

/** Map DB values back to logical states */
export const DB_TO_EMPLOYEE_STATE = Object.freeze({
  'idle':           EMPLOYEE_STATES.IDLE,
  'working':        EMPLOYEE_STATES.BUSY,
  'waiting_review': EMPLOYEE_STATES.REVIEW_NEEDED,
  'blocked':        EMPLOYEE_STATES.ERROR,
});

export const EMPLOYEE_EVENTS = Object.freeze({
  TASK_STARTED:    'task_started',
  REVIEW_NEEDED:   'review_needed',
  REVIEW_RESOLVED: 'review_resolved',
  TASK_DONE:       'task_done',
  ERROR:           'error',
  RECOVER:         'recover',
});

const TRANSITIONS = {
  [EMPLOYEE_STATES.IDLE]: {
    [EMPLOYEE_EVENTS.TASK_STARTED]: EMPLOYEE_STATES.BUSY,
  },
  [EMPLOYEE_STATES.BUSY]: {
    [EMPLOYEE_EVENTS.REVIEW_NEEDED]:  EMPLOYEE_STATES.REVIEW_NEEDED,
    [EMPLOYEE_EVENTS.TASK_DONE]:      EMPLOYEE_STATES.IDLE,
    [EMPLOYEE_EVENTS.ERROR]:          EMPLOYEE_STATES.ERROR,
  },
  [EMPLOYEE_STATES.REVIEW_NEEDED]: {
    [EMPLOYEE_EVENTS.REVIEW_RESOLVED]: EMPLOYEE_STATES.BUSY,
    [EMPLOYEE_EVENTS.TASK_DONE]:       EMPLOYEE_STATES.IDLE,
    [EMPLOYEE_EVENTS.ERROR]:           EMPLOYEE_STATES.ERROR,
  },
  [EMPLOYEE_STATES.ERROR]: {
    [EMPLOYEE_EVENTS.RECOVER]:      EMPLOYEE_STATES.IDLE,
    [EMPLOYEE_EVENTS.TASK_STARTED]: EMPLOYEE_STATES.BUSY,
  },
};

/**
 * Transition an employee from currentState via event → newState.
 * @throws {Error} if transition is invalid
 */
export function employeeTransition(currentState, event) {
  const stateTransitions = TRANSITIONS[currentState];
  if (!stateTransitions) {
    throw new Error(`[EmployeeSM] Unknown state: '${currentState}'`);
  }
  const nextState = stateTransitions[event];
  if (!nextState) {
    throw new Error(
      `[EmployeeSM] Invalid transition: '${currentState}' + '${event}'. ` +
      `Valid events: [${Object.keys(stateTransitions).join(', ')}]`
    );
  }
  return nextState;
}

export function canEmployeeTransition(currentState, event) {
  try {
    employeeTransition(currentState, event);
    return true;
  } catch {
    return false;
  }
}
