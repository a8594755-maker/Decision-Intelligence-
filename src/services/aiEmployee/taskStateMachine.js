/**
 * taskStateMachine.js — Pure state transition functions for AI Employee tasks.
 *
 * Task States (10):
 *   draft_plan → waiting_approval → queued → in_progress → review_hold → done
 *                                    │         │              │
 *                                    └→ failed  └→ blocked     └→ failed
 *                                    └→ cancelled
 *
 * Every transition is a pure function: (currentState, event) → newState | throw
 */

export const TASK_STATES = Object.freeze({
  DRAFT_PLAN:       'draft_plan',
  WAITING_APPROVAL: 'waiting_approval',
  QUEUED:           'queued',
  IN_PROGRESS:      'in_progress',
  REVIEW_HOLD:      'review_hold',
  BLOCKED:          'blocked',
  DONE:             'done',
  FAILED:           'failed',
  CANCELLED:        'cancelled',

  // ── v2 Decision Pipeline states ──
  NEEDS_CLARIFICATION:        'needs_clarification',
  AWAITING_APPROVAL:          'awaiting_approval',       // alias for review gate approval
  PUBLISH_FAILED:             'publish_failed',
  BLOCKED_EXTERNAL_DEPENDENCY:'blocked_external_dependency',
});

export const TASK_EVENTS = Object.freeze({
  PLAN_READY:       'plan_ready',
  APPROVE:          'approve',
  START:            'start',
  STEP_COMPLETED:   'step_completed',
  ALL_STEPS_DONE:   'all_steps_done',
  REVIEW_NEEDED:    'review_needed',
  REVIEW_APPROVED:  'review_approved',
  REVIEW_REJECTED:  'review_rejected',
  BLOCK:            'block',
  UNBLOCK:          'unblock',
  FAIL:             'fail',
  CANCEL:           'cancel',
  RETRY:            'retry',

  // ── v2 Decision Pipeline events ──
  NEED_CLARIFICATION: 'need_clarification',
  CLARIFICATION_RECEIVED: 'clarification_received',
  PUBLISH_FAIL:       'publish_fail',
  EXTERNAL_BLOCK:     'external_block',
  EXTERNAL_RESOLVED:  'external_resolved',
});

/**
 * Valid transitions: { [currentState]: { [event]: nextState } }
 */
const TRANSITIONS = {
  [TASK_STATES.DRAFT_PLAN]: {
    [TASK_EVENTS.PLAN_READY]:  TASK_STATES.WAITING_APPROVAL,
    [TASK_EVENTS.CANCEL]:      TASK_STATES.CANCELLED,
  },
  [TASK_STATES.WAITING_APPROVAL]: {
    [TASK_EVENTS.APPROVE]:     TASK_STATES.QUEUED,
    [TASK_EVENTS.CANCEL]:      TASK_STATES.CANCELLED,
  },
  [TASK_STATES.QUEUED]: {
    [TASK_EVENTS.START]:       TASK_STATES.IN_PROGRESS,
    [TASK_EVENTS.FAIL]:        TASK_STATES.FAILED,
    [TASK_EVENTS.CANCEL]:      TASK_STATES.CANCELLED,
  },
  [TASK_STATES.IN_PROGRESS]: {
    [TASK_EVENTS.STEP_COMPLETED]:      TASK_STATES.IN_PROGRESS,
    [TASK_EVENTS.ALL_STEPS_DONE]:      TASK_STATES.DONE,
    [TASK_EVENTS.REVIEW_NEEDED]:       TASK_STATES.REVIEW_HOLD,
    [TASK_EVENTS.BLOCK]:               TASK_STATES.BLOCKED,
    [TASK_EVENTS.FAIL]:                TASK_STATES.FAILED,
    [TASK_EVENTS.CANCEL]:              TASK_STATES.CANCELLED,
    // v2 Decision Pipeline transitions from in_progress
    [TASK_EVENTS.NEED_CLARIFICATION]:  TASK_STATES.NEEDS_CLARIFICATION,
    [TASK_EVENTS.PUBLISH_FAIL]:        TASK_STATES.PUBLISH_FAILED,
    [TASK_EVENTS.EXTERNAL_BLOCK]:      TASK_STATES.BLOCKED_EXTERNAL_DEPENDENCY,
  },
  [TASK_STATES.REVIEW_HOLD]: {
    [TASK_EVENTS.REVIEW_APPROVED]:  TASK_STATES.IN_PROGRESS,
    [TASK_EVENTS.REVIEW_REJECTED]:  TASK_STATES.FAILED,
    [TASK_EVENTS.CANCEL]:           TASK_STATES.CANCELLED,
  },
  [TASK_STATES.BLOCKED]: {
    [TASK_EVENTS.UNBLOCK]: TASK_STATES.IN_PROGRESS,
    [TASK_EVENTS.FAIL]:    TASK_STATES.FAILED,
    [TASK_EVENTS.CANCEL]:  TASK_STATES.CANCELLED,
  },
  [TASK_STATES.FAILED]: {
    [TASK_EVENTS.RETRY]: TASK_STATES.QUEUED,
  },
  // Terminal states — no transitions out
  [TASK_STATES.DONE]:      {},
  [TASK_STATES.CANCELLED]: {},

  // ── v2 Decision Pipeline transitions ──
  [TASK_STATES.NEEDS_CLARIFICATION]: {
    [TASK_EVENTS.CLARIFICATION_RECEIVED]: TASK_STATES.IN_PROGRESS,
    [TASK_EVENTS.CANCEL]:                 TASK_STATES.CANCELLED,
  },
  [TASK_STATES.AWAITING_APPROVAL]: {
    [TASK_EVENTS.APPROVE]:          TASK_STATES.IN_PROGRESS,  // continues to publish phase
    [TASK_EVENTS.REVIEW_REJECTED]:  TASK_STATES.FAILED,
    [TASK_EVENTS.CANCEL]:           TASK_STATES.CANCELLED,
  },
  [TASK_STATES.PUBLISH_FAILED]: {
    [TASK_EVENTS.RETRY]:  TASK_STATES.IN_PROGRESS,
    [TASK_EVENTS.CANCEL]: TASK_STATES.CANCELLED,
  },
  [TASK_STATES.BLOCKED_EXTERNAL_DEPENDENCY]: {
    [TASK_EVENTS.EXTERNAL_RESOLVED]: TASK_STATES.IN_PROGRESS,
    [TASK_EVENTS.FAIL]:              TASK_STATES.FAILED,
    [TASK_EVENTS.CANCEL]:            TASK_STATES.CANCELLED,
  },
};

/**
 * Transition a task from currentState via event → newState.
 * @param {string} currentState
 * @param {string} event
 * @returns {string} newState
 * @throws {Error} if the transition is invalid
 */
export function taskTransition(currentState, event) {
  const stateTransitions = TRANSITIONS[currentState];
  if (!stateTransitions) {
    throw new Error(`[TaskSM] Unknown state: '${currentState}'`);
  }
  const nextState = stateTransitions[event];
  if (!nextState) {
    throw new Error(
      `[TaskSM] Invalid transition: '${currentState}' + '${event}'. ` +
      `Valid events: [${Object.keys(stateTransitions).join(', ')}]`
    );
  }
  return nextState;
}

/**
 * Check if a transition is valid without throwing.
 */
export function canTaskTransition(currentState, event) {
  try {
    taskTransition(currentState, event);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if task is in a terminal state.
 */
export function isTaskTerminal(state) {
  return state === TASK_STATES.DONE || state === TASK_STATES.CANCELLED;
}

/**
 * Check if task is in a "waiting" state that blocks further execution
 * until external input/resolution.
 */
export function isTaskWaiting(state) {
  return [
    TASK_STATES.WAITING_APPROVAL,
    TASK_STATES.REVIEW_HOLD,
    TASK_STATES.BLOCKED,
    TASK_STATES.NEEDS_CLARIFICATION,
    TASK_STATES.AWAITING_APPROVAL,
    TASK_STATES.PUBLISH_FAILED,
    TASK_STATES.BLOCKED_EXTERNAL_DEPENDENCY,
  ].includes(state);
}
