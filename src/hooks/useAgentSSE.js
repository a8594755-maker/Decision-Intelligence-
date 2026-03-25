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

import { useCallback, useEffect, useRef, useState } from 'react';
import useSSE from './useSSE';
import { eventBus, EVENT_NAMES } from '../services/governance/eventBus';

const ML_API_BASE = import.meta.env?.VITE_ML_API_URL || 'http://localhost:8000';

// Pre-flight check: verify SSE endpoint is reachable before opening EventSource.
// EventSource doesn't surface HTTP errors cleanly (just fires onerror), so we
// do a quick HEAD request first to avoid the "wrong MIME type" console error.
async function _isSSEEndpointReachable(url) {
  try {
    const resp = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
    const ct = resp.headers.get('content-type') || '';
    // SSE endpoints return text/event-stream; reject anything else
    return ct.includes('text/event-stream') || resp.ok;
  } catch {
    return false;
  }
}

const createStreamState = taskId => ({
  taskId,
  events: [],
  loopState: null,
  done: false,
});

export default function useAgentSSE(taskId, options = {}) {
  const { enabled = true, onStepEvent, onLoopDone } = options;
  const [streamState, setStreamState] = useState(() => createStreamState(taskId));
  const [sseReachable, setSSEReachable] = useState(false);

  const onStepEventRef = useRef(onStepEvent);
  const onLoopDoneRef = useRef(onLoopDone);

  useEffect(() => {
    onStepEventRef.current = onStepEvent;
  }, [onStepEvent]);

  useEffect(() => {
    onLoopDoneRef.current = onLoopDone;
  }, [onLoopDone]);

  const url = taskId ? `${ML_API_BASE}/sse/agent/${taskId}/events` : null;
  const currentState = streamState.taskId === taskId ? streamState : createStreamState(taskId);

  // Pre-flight: check SSE endpoint reachability before opening EventSource.
  // Prevents "wrong MIME type" console errors when ML API is unavailable.
  useEffect(() => {
    if (!url || !enabled || !taskId) {
      setSSEReachable(false);
      return;
    }
    let cancelled = false;
    _isSSEEndpointReachable(url).then(ok => {
      if (!cancelled) setSSEReachable(ok);
    });
    return () => { cancelled = true; };
  }, [url, enabled, taskId]);

  const handleEvent = useCallback((eventType, data) => {
    // Map SSE event to the stepEvent shape used by AgentExecutionPanel
    // Orchestrator _publishSSE uses camelCase (stepName, stepIndex);
    // normalize to snake_case for consistency with EventBus shape.
    const stepEvent = {
      step_name: data.step_name || data.stepName,
      step_index: data.step_index ?? data.stepIndex,
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
      setStreamState(prev => {
        const next = prev.taskId === taskId ? prev : createStreamState(taskId);
        return { ...next, loopState: data.loop_state };
      });
    }

    if (eventType === 'loop_done' || eventType === 'end') {
      setStreamState(prev => {
        const next = prev.taskId === taskId ? prev : createStreamState(taskId);
        return { ...next, done: true };
      });
      eventBus.emit(EVENT_NAMES.AGENT_LOOP_DONE, { taskId, ...data });
      onLoopDoneRef.current?.(data);
      return;
    }

    if (eventType === 'loop_error') {
      setStreamState(prev => {
        const next = prev.taskId === taskId ? prev : createStreamState(taskId);
        return { ...next, done: true };
      });
      eventBus.emit(EVENT_NAMES.AGENT_LOOP_ERROR, { taskId, error: data.error });
      return;
    }

    // Accumulate events for the panel
    setStreamState(prev => {
      const next = prev.taskId === taskId ? prev : createStreamState(taskId);
      // Update existing step event or append new one
      const idx = next.events.findIndex(e => e.step_name === stepEvent.step_name && e.step_index === stepEvent.step_index);
      if (idx >= 0) {
        const updated = [...next.events];
        updated[idx] = { ...updated[idx], ...stepEvent };
        return { ...next, events: updated };
      }
      return { ...next, events: [...next.events, stepEvent] };
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
    enabled: enabled && !!taskId && !currentState.done && sseReachable,
  });

  return {
    connected,
    events: currentState.events,
    loopState: currentState.loopState,
    done: currentState.done,
    error,
    reconnectCount,
    clearEvents: () => setStreamState(prev => ({ ...(prev.taskId === taskId ? prev : createStreamState(taskId)), events: [] })),
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
