/**
 * stepStateMachine.js — Formal state machine for agent loop steps
 *
 * Inspired by OpenCloud's postprocessing pipeline state machine.
 * Pure functions: transition(step, event, context) → { step, effects }
 *
 * States:
 *   INIT → PENDING → RUNNING → SUCCEEDED
 *                            → REVIEW → SUCCEEDED
 *                                     → REVISION → RUNNING
 *                            → RETRY_WAIT → RUNNING (after backoff)
 *                                         → BLOCKED (max retries)
 *                            → BLOCKED
 *                   → SKIPPED
 *
 * Effects are descriptive objects — the caller (agentLoopService) interprets them.
 */

// ---------------------------------------------------------------------------
// States & Events
// ---------------------------------------------------------------------------

export const STEP_STATE = Object.freeze({
  INIT:        'init',
  PENDING:     'pending',
  RUNNING:     'running',
  REVIEW:      'review',
  REVISION:    'revision',
  RETRY_WAIT:  'retry_wait',
  SUCCEEDED:   'succeeded',
  FAILED:      'failed',
  BLOCKED:     'blocked',
  SKIPPED:     'skipped',
});

export const STEP_EVENT = Object.freeze({
  START:        'START',
  EXECUTE:      'EXECUTE',
  COMPLETE:     'COMPLETE',
  FAIL:         'FAIL',
  REVIEW_PASS:  'REVIEW_PASS',
  REVIEW_FAIL:  'REVIEW_FAIL',
  RETRY:        'RETRY',
  SKIP:         'SKIP',
  INTERRUPT:    'INTERRUPT',
});

// Effect types — interpreted by the agent loop runner
export const EFFECT = Object.freeze({
  PERSIST:      'PERSIST_STATE',
  EMIT:         'EMIT_EVENT',
  WAIT_BACKOFF: 'WAIT_BACKOFF',
  EXECUTE_STEP: 'EXECUTE_STEP',
  LOG:          'LOG',
});

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

/**
 * Valid transitions: { [fromState]: { [event]: handler(step, ctx) → { state, ...extra } } }
 */
const TRANSITIONS = {
  [STEP_STATE.INIT]: {
    [STEP_EVENT.START]:   (step) => ({ state: STEP_STATE.PENDING }),
    [STEP_EVENT.SKIP]:    (step) => ({ state: STEP_STATE.SKIPPED }),
  },

  [STEP_STATE.PENDING]: {
    [STEP_EVENT.EXECUTE]: (step) => ({ state: STEP_STATE.RUNNING }),
    [STEP_EVENT.SKIP]:    (step) => ({ state: STEP_STATE.SKIPPED }),
  },

  [STEP_STATE.RUNNING]: {
    [STEP_EVENT.COMPLETE]: (step, ctx) => {
      // If step requires review, go to review state
      if (ctx?.requires_review) {
        return { state: STEP_STATE.REVIEW };
      }
      return { state: STEP_STATE.SUCCEEDED };
    },

    [STEP_EVENT.FAIL]: (step, ctx) => {
      const retryCount = (step.retry_count || 0) + 1;
      const maxRetries = ctx?.max_retries ?? 3;

      if (retryCount > maxRetries) {
        return { state: STEP_STATE.BLOCKED, retry_count: retryCount };
      }

      const backoffMs = computeBackoff(retryCount - 1, ctx?.backoff);
      return {
        state: STEP_STATE.RETRY_WAIT,
        retry_count: retryCount,
        backoff_ms: backoffMs,
        healing_strategy: ctx?.healing_strategy || null,
        last_error: ctx?.error || null,
      };
    },

    [STEP_EVENT.INTERRUPT]: (step, ctx) => {
      // Treat interruption as a retriable failure
      return TRANSITIONS[STEP_STATE.RUNNING][STEP_EVENT.FAIL](step, {
        ...ctx,
        error: ctx?.error || 'Step interrupted',
        healing_strategy: ctx?.healing_strategy || 'retry',
      });
    },
  },

  [STEP_STATE.REVIEW]: {
    [STEP_EVENT.REVIEW_PASS]: () => ({ state: STEP_STATE.SUCCEEDED }),
    [STEP_EVENT.REVIEW_FAIL]: (step, ctx) => ({
      state: STEP_STATE.REVISION,
      revision_instructions: ctx?.revision_instructions || [],
    }),
  },

  [STEP_STATE.REVISION]: {
    [STEP_EVENT.EXECUTE]: (step) => ({ state: STEP_STATE.RUNNING }),
  },

  [STEP_STATE.RETRY_WAIT]: {
    [STEP_EVENT.RETRY]:  (step) => ({ state: STEP_STATE.RUNNING }),
    [STEP_EVENT.SKIP]:   (step) => ({ state: STEP_STATE.SKIPPED }),
  },

  // Terminal states — no transitions out
  [STEP_STATE.SUCCEEDED]: {},
  [STEP_STATE.FAILED]:    {},
  [STEP_STATE.BLOCKED]:   {},
  [STEP_STATE.SKIPPED]:   {},
};

// ---------------------------------------------------------------------------
// Core: transition function
// ---------------------------------------------------------------------------

/**
 * Pure transition function.
 *
 * @param {Object} step - Current step state { state, name, index, retry_count, ... }
 * @param {string} event - STEP_EVENT value
 * @param {Object} [ctx] - Context (max_retries, requires_review, error, etc.)
 * @returns {{ step: Object, effects: Array<{ type: string, ... }> }}
 */
export function transition(step, event, ctx = {}) {
  const fromState = step.state || STEP_STATE.INIT;
  const handlers = TRANSITIONS[fromState];

  if (!handlers || !handlers[event]) {
    return {
      step,
      effects: [{
        type: EFFECT.LOG,
        level: 'warn',
        message: `Invalid transition: ${fromState} + ${event}`,
      }],
    };
  }

  const updates = handlers[event](step, ctx);
  const nextState = updates.state;

  const updatedStep = {
    ...step,
    state: nextState,
    updated_at: Date.now(),
    ...(updates.retry_count != null && { retry_count: updates.retry_count }),
    ...(updates.backoff_ms != null && { backoff_ms: updates.backoff_ms }),
    ...(updates.healing_strategy !== undefined && { healing_strategy: updates.healing_strategy }),
    ...(updates.last_error !== undefined && { last_error: updates.last_error }),
    ...(updates.revision_instructions && { revision_instructions: updates.revision_instructions }),
  };

  // Build effects based on the transition
  const effects = [];

  // Always persist on state change
  effects.push({ type: EFFECT.PERSIST });

  // Emit event bus notification
  effects.push({
    type: EFFECT.EMIT,
    eventName: _stateToEventName(nextState),
    payload: { stepName: step.name, stepIndex: step.index, state: nextState, ...updates },
  });

  // State-specific effects
  if (nextState === STEP_STATE.RUNNING) {
    effects.push({ type: EFFECT.EXECUTE_STEP });
  }

  if (nextState === STEP_STATE.RETRY_WAIT && updates.backoff_ms) {
    effects.push({ type: EFFECT.WAIT_BACKOFF, ms: updates.backoff_ms });
  }

  return { step: updatedStep, effects };
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * Check whether a transition is valid.
 * @param {Object} step
 * @param {string} event
 * @returns {boolean}
 */
export function canTransition(step, event) {
  const fromState = step.state || STEP_STATE.INIT;
  const handlers = TRANSITIONS[fromState];
  return !!(handlers && handlers[event]);
}

/**
 * Check if a step is in a terminal state.
 * @param {Object} step
 * @returns {boolean}
 */
export function isTerminal(step) {
  const state = step.state || STEP_STATE.INIT;
  return [STEP_STATE.SUCCEEDED, STEP_STATE.FAILED, STEP_STATE.BLOCKED, STEP_STATE.SKIPPED].includes(state);
}

/**
 * Check if a step can be executed (is in a runnable state).
 * @param {Object} step
 * @returns {boolean}
 */
export function isRunnable(step) {
  const state = step.state || STEP_STATE.INIT;
  return [STEP_STATE.PENDING, STEP_STATE.REVISION, STEP_STATE.RETRY_WAIT].includes(state);
}

// ---------------------------------------------------------------------------
// Backoff computation
// ---------------------------------------------------------------------------

/**
 * Compute exponential backoff with jitter.
 * Formula: min(baseMs * 2^attempt, maxMs) * (1 + random * jitterFactor)
 *
 * @param {number} attempt - Zero-based attempt number
 * @param {Object} [opts]
 * @param {number} [opts.baseMs=1000] - Base delay
 * @param {number} [opts.maxMs=30000] - Max delay cap
 * @param {number} [opts.jitterFactor=0.3] - Random jitter 0..jitterFactor
 * @returns {number} Delay in milliseconds
 */
export function computeBackoff(attempt, opts = {}) {
  const { baseMs = 1000, maxMs = 30000, jitterFactor = 0.3 } = opts || {};
  const exponential = Math.min(baseMs * Math.pow(2, attempt), maxMs);
  const jitter = 1 + Math.random() * jitterFactor;
  return Math.round(exponential * jitter);
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

/**
 * Create initial step state for a template step definition.
 * @param {Object} def - { name, workflow_type, tool_hint, ... }
 * @param {number} index
 * @returns {Object} Step state object
 */
export function initStepState(def, index) {
  return {
    state: STEP_STATE.INIT,
    name: def.name || def.step_name || `step_${index}`,
    index,
    workflow_type: def.workflow_type || 'dynamic_tool',
    tool_hint: def.tool_hint || def.description || '',
    retry_count: 0,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
}

/**
 * Serialize step state for persistence (strip non-serializable fields).
 * @param {Object} step
 * @returns {Object}
 */
export function serializeStep(step) {
  const { state, name, index, workflow_type, retry_count,
    healing_strategy, last_error, revision_instructions,
    created_at, updated_at, backoff_ms } = step;
  return {
    state, name, index, workflow_type, retry_count,
    healing_strategy, last_error, revision_instructions,
    created_at, updated_at, backoff_ms,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _stateToEventName(state) {
  const map = {
    [STEP_STATE.RUNNING]:    'agent:step_started',
    [STEP_STATE.SUCCEEDED]:  'agent:step_completed',
    [STEP_STATE.BLOCKED]:    'agent:step_failed',
    [STEP_STATE.FAILED]:     'agent:step_failed',
    [STEP_STATE.REVIEW]:     'agent:step_review',
    [STEP_STATE.REVISION]:   'agent:step_revision',
    [STEP_STATE.RETRY_WAIT]: 'agent:step_retry',
    [STEP_STATE.SKIPPED]:    'agent:step_completed',
  };
  return map[state] || 'agent:step_started';
}
