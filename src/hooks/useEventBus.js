/**
 * useEventBus — React hook for subscribing to EventBus events.
 *
 * Auto-subscribes on mount, auto-unsubscribes on unmount.
 * Keeps callback reference stable via useRef to avoid re-subscriptions.
 *
 * Usage:
 *   useEventBus('agent:step_completed', (payload) => {
 *     setSteps(prev => [...prev, payload]);
 *   });
 *
 *   // Wildcard — catch all agent events:
 *   useEventBus('agent:*', (payload, eventName) => {
 *     console.log(eventName, payload);
 *   });
 */

import { useEffect, useRef } from 'react';
import { eventBus } from '../services/governance/eventBus';

export default function useEventBus(eventName, callback) {
  const callbackRef = useRef(callback);

  // Keep callback ref up to date without re-subscribing
  useEffect(() => {
    callbackRef.current = callback;
  });

  useEffect(() => {
    if (!eventName) return;

    const handler = (payload, name) => {
      callbackRef.current(payload, name);
    };

    const unsubscribe = eventBus.on(eventName, handler);
    return unsubscribe;
  }, [eventName]);
}

export { useEventBus };
