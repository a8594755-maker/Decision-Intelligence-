/**
 * useSSE — Generic React hook for Server-Sent Events connections.
 *
 * Inspired by OpenCloud's SSEAdapter pattern:
 * - Auto-reconnect with exponential backoff + jitter
 * - Heartbeat detection for stale connections
 * - Clean unmount handling
 *
 * @param {string} url - SSE endpoint URL
 * @param {Object} options
 * @param {Function} options.onEvent - Called with (eventType, data) for each event
 * @param {Function} [options.onError] - Called on error
 * @param {Function} [options.onConnect] - Called when connection established
 * @param {boolean} [options.enabled=true] - Enable/disable connection
 * @param {number} [options.reconnectBaseMs=1000] - Base reconnect delay
 * @param {number} [options.reconnectMaxMs=30000] - Max reconnect delay
 *
 * @returns {{ connected: boolean, error: string|null, reconnectCount: number }}
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export default function useSSE(url, options = {}) {
  const {
    onEvent,
    onError,
    onConnect,
    enabled = true,
    reconnectBaseMs = 1000,
    reconnectMaxMs = 30000,
  } = options;

  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);
  const [reconnectCount, setReconnectCount] = useState(0);

  const eventSourceRef = useRef(null);
  const connectRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const attemptRef = useRef(0);
  const onEventRef = useRef(onEvent);
  const onErrorRef = useRef(onError);
  const onConnectRef = useRef(onConnect);

  // Keep callbacks up to date without re-connecting
  useEffect(() => { onEventRef.current = onEvent; });
  useEffect(() => { onErrorRef.current = onError; });
  useEffect(() => { onConnectRef.current = onConnect; });

  const close = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setConnected(false);
  }, []);

  const connect = useCallback(() => {
    if (!url || !enabled) return;

    close();

    const es = new EventSource(url);
    eventSourceRef.current = es;

    // Listen for all named events via onmessage fallback
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        onEventRef.current?.('message', data);
      } catch { /* ignore parse errors */ }
    };

    // Listen for specific named events
    const eventTypes = [
      'connected', 'step_started', 'step_completed', 'step_failed',
      'step_review', 'step_revision', 'step_event', 'loop_done',
      'loop_error', 'ping', 'end',
    ];

    for (const type of eventTypes) {
      es.addEventListener(type, (event) => {
        try {
          const data = JSON.parse(event.data);

          if (type === 'connected') {
            setConnected(true);
            setError(null);
            attemptRef.current = 0;
            setReconnectCount(0);
            onConnectRef.current?.(data);
            return;
          }

          if (type === 'end') {
            onEventRef.current?.(type, data);
            close();
            return;
          }

          if (type === 'ping') return; // Heartbeat — just keep alive

          onEventRef.current?.(type, data);
        } catch { /* ignore parse errors */ }
      });
    }

    es.onerror = () => {
      setConnected(false);
      const msg = 'SSE connection lost';
      setError(msg);
      onErrorRef.current?.(msg);

      // Close and schedule reconnect
      es.close();
      eventSourceRef.current = null;

      // Exponential backoff with jitter (OpenCloud pattern: 30s + random 15s)
      const attempt = attemptRef.current;
      const delay = Math.min(reconnectBaseMs * Math.pow(2, attempt), reconnectMaxMs);
      const jitter = Math.random() * delay * 0.3;
      const totalDelay = Math.round(delay + jitter);

      attemptRef.current = attempt + 1;
      setReconnectCount(attempt + 1);

      reconnectTimerRef.current = setTimeout(() => {
        connectRef.current?.();
      }, totalDelay);
    };
  }, [url, enabled, close, reconnectBaseMs, reconnectMaxMs]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  // Connect/disconnect on url or enabled change
  useEffect(() => {
    let active = true;

    queueMicrotask(() => {
      if (!active) return;
      if (enabled && url) {
        connectRef.current?.();
      } else {
        close();
      }
    });

    return () => {
      active = false;
      close();
    };
  }, [url, enabled, connect, close]);

  return { connected, error, reconnectCount };
}

export { useSSE };
