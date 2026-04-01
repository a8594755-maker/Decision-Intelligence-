// @product: a2a-server
//
// taskStateMapper.js
// Maps between DI orchestrator task states and A2A protocol task states.

// A2A task states (protocol v0.3):
//   submitted, working, input-required, completed, canceled, failed, rejected, auth-required

/**
 * Map an orchestrator task status to an A2A task state.
 *
 * @param {string} orchestratorStatus
 * @returns {string} A2A task state
 */
export function toA2AState(orchestratorStatus) {
  switch (orchestratorStatus) {
    case 'draft_plan':
      return 'submitted';
    case 'waiting_approval':
    case 'review_hold':
    case 'needs_clarification':
    case 'blocked':
    case 'blocked_external_dependency':
    case 'awaiting_approval':
      return 'input-required';
    case 'queued':
    case 'in_progress':
      return 'working';
    case 'done':
      return 'completed';
    case 'failed':
    case 'publish_failed':
      return 'failed';
    case 'cancelled':
      return 'canceled';
    default:
      return 'working';
  }
}

/**
 * Whether the A2A state is terminal (no further transitions).
 *
 * @param {string} a2aState
 * @returns {boolean}
 */
export function isTerminalState(a2aState) {
  return ['completed', 'failed', 'canceled', 'rejected'].includes(a2aState);
}

/**
 * Build an A2A TaskStatusUpdateEvent.
 *
 * @param {string} taskId - A2A task ID
 * @param {string} contextId - A2A context ID
 * @param {string} state - A2A state string
 * @param {string} [messageText] - Optional status message
 * @param {boolean} [final] - Whether this is the final event
 * @returns {object} TaskStatusUpdateEvent
 */
export function buildStatusEvent(taskId, contextId, state, messageText, final = false) {
  const event = {
    kind: 'status-update',
    taskId,
    contextId,
    final: final || isTerminalState(state),
    status: {
      state,
      timestamp: new Date().toISOString(),
    },
  };

  if (messageText) {
    event.status.message = {
      role: 'agent',
      parts: [{ kind: 'text', text: messageText }],
    };
  }

  return event;
}
