// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const sseClientMock = vi.fn();
const emitMock = vi.fn();

vi.mock('./useSSE', () => ({
  default: (...args) => sseClientMock(...args),
}));

vi.mock('../services/governance/eventBus', () => ({
  eventBus: {
    emit: (...args) => emitMock(...args),
  },
  EVENT_NAMES: {
    AGENT_LOOP_DONE: 'agent:loop_done',
    AGENT_LOOP_ERROR: 'agent:loop_error',
    AGENT_STEP_STARTED: 'agent:step_started',
    AGENT_STEP_COMPLETED: 'agent:step_completed',
    AGENT_STEP_FAILED: 'agent:step_failed',
    AGENT_STEP_REVIEW: 'agent:step_review',
    AGENT_STEP_REVISION: 'agent:step_revision',
  },
}));

import useAgentSSE from './useAgentSSE.js';

describe('useAgentSSE', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sseClientMock.mockImplementation((_url, _options) => ({
      connected: false,
      error: null,
      reconnectCount: 0,
    }));
    // Mock global fetch for SSE pre-flight reachability check
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'text/event-stream' },
    });
  });

  it('resets done state and reconnects when taskId changes', async () => {
    const { result, rerender } = renderHook(({ taskId }) => useAgentSSE(taskId), {
      initialProps: { taskId: 'task-1' },
    });

    const firstOptions = sseClientMock.mock.calls.at(-1)[1];

    act(() => {
      firstOptions.onEvent('step_started', { step_name: 'collect', step_index: 0 });
      firstOptions.onEvent('loop_done', {});
    });

    await waitFor(() => {
      expect(result.current.done).toBe(true);
      expect(sseClientMock.mock.calls.at(-1)[1].enabled).toBe(false);
      expect(result.current.events).toHaveLength(1);
    });

    rerender({ taskId: 'task-2' });

    await waitFor(() => {
      expect(result.current.done).toBe(false);
      expect(result.current.events).toEqual([]);
      expect(sseClientMock.mock.calls.at(-1)[1].enabled).toBe(true);
    });
  });
});
