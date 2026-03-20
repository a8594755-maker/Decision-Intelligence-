/**
 * eventBus.js — Client-side pub/sub event bus
 *
 * Provides decoupled communication between React components, hooks, and services.
 *
 * Features:
 * - Typed event names (EVENT_NAMES constants)
 * - Wildcard subscriptions (e.g. 'agent:*' catches all agent events)
 * - on() returns unsubscribe function for easy useEffect cleanup
 * - once() for one-shot listeners
 * - Debug mode logs all emissions
 */

// ---------------------------------------------------------------------------
// Event name constants
// ---------------------------------------------------------------------------

export const EVENT_NAMES = Object.freeze({
  // Agent loop lifecycle
  AGENT_STEP_STARTED:    'agent:step_started',
  AGENT_STEP_COMPLETED:  'agent:step_completed',
  AGENT_STEP_FAILED:     'agent:step_failed',
  AGENT_STEP_REVIEW:     'agent:step_review',
  AGENT_STEP_REVISION:   'agent:step_revision',
  AGENT_STEP_DIAGNOSED:  'agent:step_diagnosed',
  AGENT_STEP_BLOCKED:    'agent:step_blocked',
  AGENT_LOOP_DONE:       'agent:loop_done',
  AGENT_LOOP_ERROR:      'agent:loop_error',

  // Artifact lifecycle
  ARTIFACT_CREATED:  'artifact:created',
  ARTIFACT_UPDATED:  'artifact:updated',
  ARTIFACT_DELETED:  'artifact:deleted',

  // Human review
  REVIEW_REQUESTED:  'review:requested',
  REVIEW_APPROVED:   'review:approved',
  REVIEW_REJECTED:   'review:rejected',

  // Task lifecycle
  TASK_CREATED:    'task:created',
  TASK_STARTED:    'task:started',
  TASK_COMPLETED:  'task:completed',
  TASK_FAILED:     'task:failed',

  // SSE connection
  SSE_CONNECTED:     'sse:connected',
  SSE_DISCONNECTED:  'sse:disconnected',
  SSE_ERROR:         'sse:error',

  // File/event-based triggers
  FILE_DETECTED:       'file:detected',
  FILE_UPLOADED:       'file:uploaded',
  FILE_MODIFIED:       'file:modified',
  FILE_TRASHED:        'file:trashed',
  SHARE_CREATED:       'share:created',
  REPORT_DISTRIBUTED:  'report:distributed',

  // Event-based triggers
  TRIGGER_FIRED:              'trigger:fired',
});

// ---------------------------------------------------------------------------
// EventBus class
// ---------------------------------------------------------------------------

class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
    /** @type {boolean} */
    this.debug = false;
  }

  /**
   * Subscribe to an event.
   * Supports wildcards: 'agent:*' matches 'agent:step_started', etc.
   * @param {string} eventName - Event name or wildcard pattern
   * @param {Function} callback - Handler receiving (payload, eventName)
   * @returns {Function} Unsubscribe function
   */
  on(eventName, callback) {
    if (!this._listeners.has(eventName)) {
      this._listeners.set(eventName, new Set());
    }
    this._listeners.get(eventName).add(callback);

    // Return unsubscribe function
    return () => {
      this.off(eventName, callback);
    };
  }

  /**
   * Subscribe to an event once (auto-unsubscribes after first call).
   * @param {string} eventName
   * @param {Function} callback
   * @returns {Function} Unsubscribe function
   */
  once(eventName, callback) {
    const wrapper = (payload, name) => {
      this.off(eventName, wrapper);
      callback(payload, name);
    };
    return this.on(eventName, wrapper);
  }

  /**
   * Unsubscribe a specific callback from an event.
   * @param {string} eventName
   * @param {Function} callback
   */
  off(eventName, callback) {
    const set = this._listeners.get(eventName);
    if (set) {
      set.delete(callback);
      if (set.size === 0) this._listeners.delete(eventName);
    }
  }

  /**
   * Emit an event to all matching listeners.
   * Matches exact name + wildcard patterns (e.g. 'agent:*').
   * @param {string} eventName
   * @param {*} payload
   */
  emit(eventName, payload) {
    if (this.debug) {
      console.log(`[EventBus] ${eventName}`, payload);
    }

    // Exact match listeners
    const exact = this._listeners.get(eventName);
    if (exact) {
      for (const cb of exact) {
        try { cb(payload, eventName); } catch (e) {
          console.error(`[EventBus] Error in listener for '${eventName}':`, e);
        }
      }
    }

    // Wildcard listeners — check all registered patterns
    for (const [pattern, callbacks] of this._listeners) {
      if (!pattern.endsWith(':*')) continue;
      const prefix = pattern.slice(0, -1); // 'agent:*' → 'agent:'
      if (eventName.startsWith(prefix) && eventName !== pattern) {
        for (const cb of callbacks) {
          try { cb(payload, eventName); } catch (e) {
            console.error(`[EventBus] Error in wildcard listener '${pattern}' for '${eventName}':`, e);
          }
        }
      }
    }
  }

  /**
   * Remove all listeners (useful for testing).
   */
  clear() {
    this._listeners.clear();
  }

  /**
   * Get listener count for debugging.
   * @param {string} [eventName] - If omitted, returns total count
   * @returns {number}
   */
  listenerCount(eventName) {
    if (eventName) {
      return this._listeners.get(eventName)?.size || 0;
    }
    let total = 0;
    for (const set of this._listeners.values()) total += set.size;
    return total;
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const eventBus = new EventBus();
export default eventBus;
