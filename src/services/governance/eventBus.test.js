import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eventBus, EVENT_NAMES } from './eventBus';

describe('EventBus', () => {
  beforeEach(() => {
    eventBus.clear();
  });

  it('subscribes and emits events', () => {
    const handler = vi.fn();
    eventBus.on('test:event', handler);
    eventBus.emit('test:event', { data: 42 });
    expect(handler).toHaveBeenCalledWith({ data: 42 }, 'test:event');
  });

  it('returns unsubscribe function from on()', () => {
    const handler = vi.fn();
    const unsub = eventBus.on('test:event', handler);
    unsub();
    eventBus.emit('test:event', {});
    expect(handler).not.toHaveBeenCalled();
  });

  it('once() fires only once', () => {
    const handler = vi.fn();
    eventBus.once('test:once', handler);
    eventBus.emit('test:once', { a: 1 });
    eventBus.emit('test:once', { a: 2 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ a: 1 }, 'test:once');
  });

  it('supports wildcard subscriptions', () => {
    const handler = vi.fn();
    eventBus.on('agent:*', handler);
    eventBus.emit('agent:step_started', { step: 1 });
    eventBus.emit('agent:step_completed', { step: 2 });
    eventBus.emit('other:event', { nope: true });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledWith({ step: 1 }, 'agent:step_started');
    expect(handler).toHaveBeenCalledWith({ step: 2 }, 'agent:step_completed');
  });

  it('off() removes specific callback', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    eventBus.on('test:off', h1);
    eventBus.on('test:off', h2);
    eventBus.off('test:off', h1);
    eventBus.emit('test:off', {});
    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it('isolates errors in listeners', () => {
    const bad = vi.fn(() => { throw new Error('boom'); });
    const good = vi.fn();
    eventBus.on('test:err', bad);
    eventBus.on('test:err', good);
    eventBus.emit('test:err', {});
    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled(); // should still fire despite prior error
  });

  it('listenerCount returns correct counts', () => {
    eventBus.on('a', () => {});
    eventBus.on('a', () => {});
    eventBus.on('b', () => {});
    expect(eventBus.listenerCount('a')).toBe(2);
    expect(eventBus.listenerCount('b')).toBe(1);
    expect(eventBus.listenerCount('c')).toBe(0);
    expect(eventBus.listenerCount()).toBe(3);
  });

  it('clear() removes all listeners', () => {
    eventBus.on('x', () => {});
    eventBus.on('y', () => {});
    eventBus.clear();
    expect(eventBus.listenerCount()).toBe(0);
  });

  it('EVENT_NAMES constants are defined', () => {
    expect(EVENT_NAMES.AGENT_STEP_STARTED).toBe('agent:step_started');
    expect(EVENT_NAMES.AGENT_LOOP_DONE).toBe('agent:loop_done');
    expect(EVENT_NAMES.ARTIFACT_CREATED).toBe('artifact:created');
    expect(EVENT_NAMES.SSE_CONNECTED).toBe('sse:connected');
  });
});
