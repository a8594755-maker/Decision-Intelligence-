/**
 * useAgentSSE — Specialized SSE hook for agent loop step events.
 *
 * Wraps useSSE with agent-specific event mapping and EventBus integration.
 * Translates SSE events into the stepEvent shape that AgentExecutionPanel expects.
 *
 * Usage:
 *   const { connected, events, loopState } = useAgentSSE(taskId, { enabled: true });
 *
 * @param {string} taskId - Task ID to subscribe to
 * @param {Object} options
 * @param {boolean} [options.enabled=true]
 * @param {Function} [options.onStepEvent] - Called with each step event
 * @param {Function} [options.onLoopDone] - Called when loop completes
 */

import { useCallback, useRef, useState } from 'react';
import useSSE from './useSSE';
import { eventBus, EVENT_NAMES } from '../services/eventBus';

const ML_API_BASE = import.meta.env?.VITE_ML_API_URL || 'http://localhost:8000';

export default function useAgentSSE(taskId, options = {}) {
  const { enabled = true, onStepEvent, onLoopDone } = options;
  const [events, setEvents] = useState([]);
  const [loopState, setLoopState] = useState(null);
  const [done, setDone] = useState(false);

  const onStepEventRef = useRef(onStepEvent);
  const onLoopDoneRef = useRef(onLoopDone);
  onStepEventRef.current = onStepEvent;
  onLoopDoneRef.current = onLoopDone;

  const url = taskId ? `${ML_API_BASE}/sse/agent/${taskId}/events` : null;

  const handleEvent = useCallback((eventType, data) => {
    // Map SSE event to the stepEvent shape used by AgentExecutionPanel
    const stepEvent = {
      step_name: data.step_name,
      step_index: data.step_index,
      status: data.status || _eventTypeToStatus(eventType),
      summary: data.summary || '',
      error: data.error || null,
      code: data.code || null,
      code_language: data.code_language || null,
      stdout: data.stdout || null,
      stderr: data.stderr || null,
      artifacts: data.artifacts || [],
      api_call: data.api_call || null,
      review: data.review || null,
      healing_strategy: data.healing_strategy || null,
      revision_instructions: data.revision_instructions || null,
      timestamp: data.timestamp || Date.now() / 1000,
    };

    if (data.loop_state) {
      setLoopState(data.loop_state);
    }

    if (eventType === 'loop_done' || eventType === 'end') {
      setDone(true);
      eventBus.emit(EVENT_NAMES.AGENT_LOOP_DONE, { taskId, ...data });
      onLoopDoneRef.current?.(data);
      return;
    }

    if (eventType === 'loop_error') {
      setDone(true);
      eventBus.emit(EVENT_NAMES.AGENT_LOOP_ERROR, { taskId, error: data.error });
      return;
    }

    // Accumulate events for the panel
    setEvents(prev => {
      // Update existing step event or append new one
      const idx = prev.findIndex(e => e.step_name === stepEvent.step_name && e.step_index === stepEvent.step_index);
      if (idx >= 0) {
        const updated = [...prev];
        updated[idx] = { ...updated[idx], ...stepEvent };
        return updated;
      }
      return [...prev, stepEvent];
    });

    // Emit to EventBus for other consumers
    const busEventName = _eventTypeToBusName(eventType);
    if (busEventName) {
      eventBus.emit(busEventName, stepEvent);
    }

    onStepEventRef.current?.(stepEvent);
  }, [taskId]);

  const { connected, error, reconnectCount } = useSSE(url, {
    onEvent: handleEvent,
    enabled: enabled && !!taskId && !done,
  });

  return {
    connected,
    events,
    loopState,
    done,
    error,
    reconnectCount,
    clearEvents: () => setEvents([]),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _eventTypeToStatus(eventType) {
  const map = {
    step_started: 'running',
    step_completed: 'succeeded',
    step_failed: 'blocked',
    step_review: 'review',
    step_revision: 'revision',
    step_event: 'running',
  };
  return map[eventType] || 'running';
}

function _eventTypeToBusName(eventType) {
  const map = {
    step_started:   EVENT_NAMES.AGENT_STEP_STARTED,
    step_completed: EVENT_NAMES.AGENT_STEP_COMPLETED,
    step_failed:    EVENT_NAMES.AGENT_STEP_FAILED,
    step_review:    EVENT_NAMES.AGENT_STEP_REVIEW,
    step_revision:  EVENT_NAMES.AGENT_STEP_REVISION,
  };
  return map[eventType] || null;
}

export { useAgentSSE };
