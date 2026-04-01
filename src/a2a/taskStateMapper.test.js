import { describe, it, expect } from 'vitest';
import { toA2AState, isTerminalState, buildStatusEvent } from './taskStateMapper.js';

describe('toA2AState', () => {
  it('maps draft_plan to submitted', () => {
    expect(toA2AState('draft_plan')).toBe('submitted');
  });

  it('maps waiting_approval to input-required', () => {
    expect(toA2AState('waiting_approval')).toBe('input-required');
  });

  it('maps review_hold to input-required', () => {
    expect(toA2AState('review_hold')).toBe('input-required');
  });

  it('maps needs_clarification to input-required', () => {
    expect(toA2AState('needs_clarification')).toBe('input-required');
  });

  it('maps blocked to input-required', () => {
    expect(toA2AState('blocked')).toBe('input-required');
  });

  it('maps queued to working', () => {
    expect(toA2AState('queued')).toBe('working');
  });

  it('maps in_progress to working', () => {
    expect(toA2AState('in_progress')).toBe('working');
  });

  it('maps done to completed', () => {
    expect(toA2AState('done')).toBe('completed');
  });

  it('maps failed to failed', () => {
    expect(toA2AState('failed')).toBe('failed');
  });

  it('maps cancelled to canceled', () => {
    expect(toA2AState('cancelled')).toBe('canceled');
  });

  it('defaults unknown states to working', () => {
    expect(toA2AState('some_unknown_state')).toBe('working');
  });
});

describe('isTerminalState', () => {
  it('returns true for completed', () => {
    expect(isTerminalState('completed')).toBe(true);
  });

  it('returns true for failed', () => {
    expect(isTerminalState('failed')).toBe(true);
  });

  it('returns true for canceled', () => {
    expect(isTerminalState('canceled')).toBe(true);
  });

  it('returns true for rejected', () => {
    expect(isTerminalState('rejected')).toBe(true);
  });

  it('returns false for working', () => {
    expect(isTerminalState('working')).toBe(false);
  });

  it('returns false for input-required', () => {
    expect(isTerminalState('input-required')).toBe(false);
  });

  it('returns false for submitted', () => {
    expect(isTerminalState('submitted')).toBe(false);
  });
});

describe('buildStatusEvent', () => {
  it('builds a valid status event', () => {
    const event = buildStatusEvent('task-1', 'ctx-1', 'working', 'Processing...');
    expect(event.kind).toBe('status-update');
    expect(event.taskId).toBe('task-1');
    expect(event.contextId).toBe('ctx-1');
    expect(event.status.state).toBe('working');
    expect(event.status.message.role).toBe('agent');
    expect(event.status.message.parts[0].text).toBe('Processing...');
    expect(event.final).toBe(false);
  });

  it('sets final=true for terminal states', () => {
    const event = buildStatusEvent('task-1', 'ctx-1', 'completed', 'Done');
    expect(event.final).toBe(true);
  });

  it('sets final=true when explicitly specified', () => {
    const event = buildStatusEvent('task-1', 'ctx-1', 'working', 'Stopping', true);
    expect(event.final).toBe(true);
  });

  it('omits message when messageText is not provided', () => {
    const event = buildStatusEvent('task-1', 'ctx-1', 'working');
    expect(event.status.message).toBeUndefined();
  });

  it('includes a timestamp', () => {
    const event = buildStatusEvent('task-1', 'ctx-1', 'working');
    expect(event.status.timestamp).toBeDefined();
    expect(new Date(event.status.timestamp).getTime()).toBeGreaterThan(0);
  });
});
