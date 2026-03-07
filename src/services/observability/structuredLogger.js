/**
 * Structured Logger - Lightweight frontend-only JSON logging
 *
 * In-memory ring buffer with structured entries.
 * Levels: debug, info, warn, error
 */

const DEFAULT_BUFFER_SIZE = 500;
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

export function createStructuredLogger(options = {}) {
  const {
    bufferSize = DEFAULT_BUFFER_SIZE,
    minLevel = 'info',
    consolePassthrough = false,
    onEntry = null,
  } = options;

  const buffer = [];
  let entryId = 0;

  function log(level, source, message, data = {}) {
    if (LEVELS[level] < LEVELS[minLevel]) return;

    const entry = {
      id: ++entryId,
      ts: new Date().toISOString(),
      level,
      source,
      message,
      data,
      traceId: data._traceId || null,
    };

    buffer.push(entry);
    if (buffer.length > bufferSize) buffer.shift();

    if (consolePassthrough) {
      const consoleFn = level === 'error' ? console.error
        : level === 'warn' ? console.warn : console.log;
      consoleFn(`[${source}] ${message}`, data);
    }

    if (typeof onEntry === 'function') {
      try { onEntry(entry); } catch { /* never throw */ }
    }

    return entry;
  }

  return {
    debug: (source, message, data) => log('debug', source, message, data),
    info:  (source, message, data) => log('info', source, message, data),
    warn:  (source, message, data) => log('warn', source, message, data),
    error: (source, message, data) => log('error', source, message, data),

    getEntries({ level, source, since, traceId, limit = 100 } = {}) {
      let filtered = [...buffer];
      if (level) filtered = filtered.filter(e => e.level === level);
      if (source) filtered = filtered.filter(e => e.source === source);
      if (since) filtered = filtered.filter(e => e.ts >= since);
      if (traceId) filtered = filtered.filter(e => e.traceId === traceId);
      return filtered.slice(-limit);
    },

    getStats() {
      const counts = { debug: 0, info: 0, warn: 0, error: 0 };
      buffer.forEach(e => counts[e.level]++);
      return { total: buffer.length, byLevel: counts };
    },

    clear() { buffer.length = 0; },
    toJSON() { return [...buffer]; },
  };
}

// Singleton instance
let _devMode = false;
try { _devMode = typeof import.meta !== 'undefined' && !!import.meta.env?.DEV; } catch { /* ignore */ }

export const logger = createStructuredLogger({
  consolePassthrough: _devMode,
});
